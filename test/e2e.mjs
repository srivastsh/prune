// End-to-end test: loads the real extension in Chromium against a mocked x.com.
// Exercises: hook/bridge plumbing, query-id scraping from the JS bundle, v1 fast-path
// failure -> GraphQL fallback, batch lookup, per-user fallback, unfollow queue.
// Run: node test/e2e.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const EXT = path.resolve(new URL('..', import.meta.url).pathname);
const DAY = 86400000;
const now = Date.now();
const tdate = (daysAgo) => new Date(now - daysAgo * DAY).toUTCString().replace('GMT', '+0000');

// 250 fake follows. id i: quiet for (i % 200) days. Every 25th never posted, every 40th suspended,
// every 30th has no status in lookup (forces per-user UserTweets).
const N = 250;
const users = Array.from({ length: N }, (_, k) => {
  const i = k + 1;
  return { id: String(1000 + i), handle: `user${i}`, quiet: i % 200, never: i % 25 === 0, gone: i % 40 === 0, noStatus: i % 30 === 0 };
});
const unfollowed = [];
const FAST = process.env.FAST === '1'; // friends/list fast path works (true on real X, Oct 2026)
const listed = FAST ? users.filter((u) => !u.gone) : users; // v1 omits suspended accounts
const counters = { following: 0, lookup: 0, userTweets: 0, friendsList: 0 };

function gqlUser(u) {
  return { __typename: 'User', rest_id: u.id, core: { screen_name: u.handle, name: `User ${u.id}` },
    // Oct 2026 shape: no legacy; counts in relationship_counts / tweet_counts.
    relationship_counts: { followers: 100 + Number(u.id), following: 5 }, tweet_counts: { tweets: u.never ? 0 : 10 },
    relationship_perspectives: { followed_by: Number(u.id) % 7 === 0 } };
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--headless=new'],
  });
  await ctx.addCookies([
    { name: 'twid', value: 'u%3D999', domain: '.x.com', path: '/', secure: true, sameSite: 'None' },
    { name: 'ct0', value: 'csrf123', domain: '.x.com', path: '/', secure: true, sameSite: 'Lax' },
  ]);

  await ctx.route('https://abs.twimg.com/**', (route) => route.fulfill({
    contentType: 'application/javascript',
    body: 'var e={};e.exports={queryId:"FOLLOWQ",operationName:"Following",operationType:"query",metadata:{featureSwitches:["f_one","f_two"],fieldToggles:[]}};' +
      'e.exports={queryId:"MEQ",operationName:"UserByRestId",operationType:"query",metadata:{featureSwitches:["f_one"]}};' +
      'e.exports={queryId:"TWEETSQ",operationName:"UserTweets",operationType:"query",metadata:{featureSwitches:["f_one"]}};',
  }));

  await ctx.route('https://x.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });

    if (p.startsWith('/i/api/')) {
      if (req.headers()['x-csrf-token'] !== 'csrf123') return json({ errors: [{ code: 353, message: 'csrf' }] }, 403);
      if (p.endsWith('/users/show.json')) return json({ errors: [{ code: 34, message: 'Sorry, that page does not exist' }] }, 404);
      if (p.includes('/graphql/MEQ/UserByRestId')) return json({ data: { user: { result: { __typename: 'User', rest_id: '999', core: { screen_name: 'shag', name: 'Shag' }, relationship_counts: { following: listed.length } } } } });
      if (p.endsWith('/friends/list.json')) {
        counters.friendsList++;
        if (!FAST) return json({ errors: [{ code: 34, message: 'Sorry, that page does not exist.' }] }, 404);
        const cur = url.searchParams.get('cursor');
        const start = cur === '-1' ? 0 : Number(cur);
        const page = listed.slice(start, start + 200).map((u) => {
          const o = { id_str: u.id, screen_name: u.handle, name: u.handle, statuses_count: u.never ? 0 : 10, followers_count: 5, followed_by: false };
          if (!u.never && !u.noStatus) o.status = { created_at: tdate(u.quiet), id_str: String(5000 + Number(u.id)) };
          return o;
        });
        const nextStart = start + 200;
        return json({ users: page, next_cursor_str: nextStart < listed.length ? String(nextStart) : '0' });
      }
      if (p.includes('/graphql/FOLLOWQ/Following')) {
        counters.following++;
        const feats = JSON.parse(url.searchParams.get('features'));
        if (!('f_three' in feats)) return json({ errors: [{ message: 'The following features cannot be null: f_three' }] }, 400);
        const vars = JSON.parse(url.searchParams.get('variables'));
        const start = vars.cursor ? Number(vars.cursor) : 0;
        const page = listed.slice(start, start + 100);
        const entries = page.map((u) => ({ entryId: `user-${u.id}`, content: { itemContent: { user_results: { result: gqlUser(u) } } } }));
        entries.push({ entryId: 'cursor-bottom-x', content: { value: String(start + 100), cursorType: 'Bottom' } });
        return json({ data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } } });
      }
      if (p.endsWith('/users/lookup.json')) {
        counters.lookup++;
        const ids = url.searchParams.get('user_id').split(',');
        const out = [];
        for (const id of ids) {
          const u = users.find((x) => x.id === id);
          if (!u || u.gone) continue;
          const o = { id_str: u.id, screen_name: u.handle, name: u.handle, statuses_count: u.never ? 0 : 10 };
          if (!u.never && !u.noStatus) o.status = { created_at: tdate(u.quiet), id_str: String(5000 + Number(u.id)) };
          out.push(o);
        }
        return json(out);
      }
      if (p.includes('/graphql/TWEETSQ/UserTweets')) {
        counters.userTweets++;
        const { userId } = JSON.parse(url.searchParams.get('variables'));
        const u = users.find((x) => x.id === userId);
        return json({ data: { user: { result: { timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
          { content: { itemContent: { tweet_results: { result: { rest_id: '77' + userId, core: { user_results: { result: { rest_id: userId } } }, legacy: { created_at: tdate(u.quiet), user_id_str: userId } } } } } },
        ] }] } } } } } });
      }
      if (p.endsWith('/friendships/destroy.json') && req.method() === 'POST') {
        const id = new URLSearchParams(req.postData()).get('user_id');
        unfollowed.push(id);
        return json({ id_str: id });
      }
      return json({ errors: [{ message: 'unmocked ' + p }] }, 404);
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script></head><body>home</body></html>' });
  });

  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;

  // Playwright can't intercept tabs the extension creates itself, so open the x.com tab
  // up front; Prune reuses an existing x.com tab when there is one.
  const xtab = await ctx.newPage();
  await xtab.goto('https://x.com/home');

  // Speed up pacing for the test.
  const dash = await ctx.newPage();
  dash.on('pageerror', (e) => console.error('PAGE ERROR', e));
  await dash.goto(`chrome-extension://${extId}/src/dashboard.html`);
  await dash.evaluate(() => chrome.storage.local.set({ settings: { minDelaySec: 0.05, maxDelaySec: 0.1, dailyCap: 30 } }));
  await dash.reload();

  await dash.click('#scanBtn');
  try {
    await dash.waitForFunction(() => [...document.querySelectorAll('#log li')].some((li) => /Scan complete|rror|Could/.test(li.textContent)), null, { timeout: 90000 });
  } catch (e) {
    for (const pg of ctx.pages()) console.error('PAGE', pg.url(), await pg.evaluate(() => ({ hook: !!window.__pruneHook, cookie: document.cookie })).catch((e) => String(e)));
    console.error('TIMEOUT. progress:', await dash.textContent('#progress'), '\nlog:', await dash.$$eval('#log li', (l) => l.map((x) => x.textContent).join('\n')), counters);
    throw e;
  }
  const logText = await dash.$$eval('#log li', (l) => l.map((x) => x.textContent).reverse().join('\n'));
  console.log(logText);

  const stored = await dash.evaluate(() => chrome.storage.local.get('accounts').then((r) => r.accounts || {}));
  const recs = Object.values(stored);
  const expect = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

  const L = listed.length;
  expect(recs.length === L, `all ${L} accounts loaded (got ${recs.length})`);
  const noStatus = users.filter((u) => u.noStatus && !u.never && !u.gone).length;
  if (FAST) {
    expect(counters.friendsList === 2 && counters.following === 0, `fast path: 2 friends/list pages, no GraphQL list (${counters.friendsList}/${counters.following})`);
    expect(counters.lookup === 1, `lookup only for the ${noStatus} accounts missing a status (calls=${counters.lookup})`);
    expect(counters.userTweets === noStatus, `per-user calls only for the ${noStatus} with no status anywhere (got ${counters.userTweets})`);
  } else {
    expect(counters.friendsList >= 1 && counters.following === 5, `fast path failed over to GraphQL; Following calls=${counters.following} (1 feature retry + 3 pages + empty end page)`);
    expect(counters.lookup === 3, `batch lookup used 3 calls (got ${counters.lookup})`);
    expect(counters.userTweets === noStatus, `per-user fallback only for ${noStatus} accounts (got ${counters.userTweets})`);
    const gone = recs.filter((r) => r.unavailable).length;
    expect(gone === users.filter((u) => u.gone && !u.never).length, `suspended accounts flagged (${gone})`);
  }
  const never = recs.filter((r) => r.never).length;
  expect(never === users.filter((u) => u.never && (FAST ? !u.gone : true)).length, `never-posted accounts flagged (${never})`);
  const unchecked = recs.filter((r) => r.lastPostAt == null && !r.never && !r.unavailable).length;
  expect(unchecked === 0, `every account has activity data (${unchecked} missing)`);
  const u151 = stored['1151'];
  expect(Math.round((now - u151.lastPostAt) / DAY) === 151, 'user151 last post ≈151 days ago');
  const u60 = stored['1060']; // no status in v1 -> resolved via UserTweets
  expect(Math.round((now - u60.lastPostAt) / DAY) === 60, 'user60 (per-user fallback) last post ≈60 days ago');

  // UI: buckets rendered, filter to 90+ and unfollow with cap 30.
  const bucketText = await dash.$$eval('.bucket', (b) => b.map((x) => x.textContent));
  console.log('buckets:', bucketText.join(' | '));
  await dash.click('.bucket:nth-child(4)'); // 90d+
  await dash.check('#selectAll');
  const sel = Number(await dash.textContent('#selCount'));
  expect(sel > 30, `selected ${sel} in 90d+`);
  await dash.click('#unfollowBtn');
  await dash.click('#confirmOk');
  await dash.waitForFunction(() => [...document.querySelectorAll('#log li')].some((li) => /Done:|Daily cap/.test(li.textContent)), null, { timeout: 120000 });
  await dash.waitForTimeout(500);
  expect(unfollowed.length === 30, `daily cap stopped queue at 30 (got ${unfollowed.length})`);
  const after = await dash.evaluate(() => chrome.storage.local.get('accounts').then((r) => Object.keys(r.accounts).length));
  expect(after === L - 30, `unfollowed accounts removed from store (${after})`);
  const quietest = unfollowed.map((id) => users.find((u) => u.id === id).quiet);
  expect(Math.min(...quietest) >= 91, 'only 90d+ accounts unfollowed');
  await dash.screenshot({ path: process.env.SHOT || 'e2e.png', fullPage: false });

  await ctx.close();
  console.log(process.exitCode ? 'E2E FAILED' : 'E2E PASSED');
}

main().catch((e) => { console.error(e); process.exit(1); });
