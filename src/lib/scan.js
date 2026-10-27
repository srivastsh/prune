// Scan orchestration: fetch who you follow, then find each account's latest post.
// Tries the fastest method first and falls back automatically:
//   list:     v1.1 friends/list (includes last post)  ->  GraphQL Following
//   activity: v1.1 users/lookup (100 per call)        ->  GraphQL UserTweets (1 per call)  ->  reading the profile page
import { Cancelled } from './x.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

export async function runScan(client, store, { onProgress, log, settings, rescanAll = false }) {
  const st = await client.init();
  const me = await client.viewerProfile();
  const meta = { ...(await store.meta()), viewerId: client.viewerId, handle: me.handle, avatar: me.avatar, expected: me.following };
  if (meta.lastViewerId && meta.lastViewerId !== client.viewerId) {
    log('Different X account than the last scan. Starting fresh.', 'warn');
    await store.saveAccounts({});
  }
  meta.lastViewerId = client.viewerId;
  await store.saveMeta(meta);
  log(`Signed in as @${me.handle ?? client.viewerId}${me.following ? `, following ${me.following.toLocaleString()}` : ''}.`);
  if (st.sawTransactionId) log('X is using request signing in this session. If API calls fail, Prune falls back to reading pages.', 'info');

  const prev = await store.accounts();
  const next = {};
  const now = Date.now();
  const forceDom = settings.method === 'dom';

  // ---------- phase 1: the list ----------
  let listSource = null;
  let followIdx = 0; // X lists follows newest first
  const merge = (users, source) => {
    for (const u of users) {
      const old = prev[u.id] || {};
      const rec = { ...old, ...u, verifiedType: u.verifiedType ?? old.verifiedType, proType: u.proType ?? old.proType, proCategory: u.proCategory ?? old.proCategory, keep: old.keep || false, queued: old.queued || false, listedAt: now, followIdx: followIdx++ };
      // v1 records carry fresh activity; GraphQL records don't, so keep old activity if still fresh.
      if (source !== 'v1' || u.lastPostAt === undefined) {
        if (old.lastPostAt !== undefined && u.lastPostAt === undefined) {
          rec.lastPostAt = old.lastPostAt;
          rec.lastPostText = old.lastPostText;
          rec.checkedAt = old.checkedAt;
          rec.source = old.source;
        }
      } else {
        rec.checkedAt = now;
      }
      if (u.never) rec.checkedAt = now;
      next[u.id] = rec;
    }
    onProgress({ phase: 'list', done: Object.keys(next).length, total: me.following || null });
  };

  const tryList = async (gen, source) => {
    for await (const users of gen) {
      merge(users, source);
      await store.saveAccounts({ ...prev, ...next });
    }
    listSource = source;
  };

  if (!forceDom) {
    try {
      await tryList(client.followingV1(), 'v1');
      log(`Loaded ${Object.keys(next).length.toLocaleString()} accounts with their latest posts (fast path).`);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      log(`Fast path unavailable (${short(e)}). Using GraphQL.`, 'info');
    }
  }
  if (!listSource) {
    try {
      await tryList(client.followingGql(), 'gql');
      log(`Loaded ${Object.keys(next).length.toLocaleString()} accounts you follow.`);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      throw new Error(`Couldn't load your following list: ${short(e)}`);
    }
  }

  // v1 lacks X's business labels; one pass over GraphQL Following (100 per call) adds them.
  if (listSource === 'v1' && !forceDom) {
    try {
      let seen = 0;
      onProgress({ phase: 'enrich', done: 0, total: Object.keys(next).length });
      for await (const users of client.followingGql()) {
        for (const u of users) {
          const r = next[u.id];
          if (!r) continue;
          r.verifiedType = u.verifiedType;
          r.proType = u.proType;
          r.proCategory = u.proCategory;
          seen++;
        }
        onProgress({ phase: 'enrich', done: seen, total: Object.keys(next).length });
      }
      log(`Labeled account types for ${seen.toLocaleString()} accounts.`);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      log(`Couldn't load account labels (${short(e)}). Brand detection will use bios only.`, 'info');
    }
  }

  // Anything not in the fresh list is no longer followed.
  const removed = Object.keys(prev).filter((id) => !next[id]).length;
  if (removed && Object.keys(next).length > 0) log(`${removed} accounts from the last scan are no longer followed.`);
  await store.saveAccounts(next);

  // ---------- phase 2: activity ----------
  const fresh = (r) =>
    !rescanAll && r.checkedAt && now - r.checkedAt < settings.recheckDays * 86400000 &&
    (r.lastPostAt != null || r.never || r.unavailable);
  // v1 data includes reposts, so when reposts shouldn't count, only GraphQL/page results are trusted.
  const trusted = (r) => settings.countReposts || r.source === 'gql' || r.source === 'dom';
  let todo = Object.values(next).filter((r) => {
    if (r.statuses === 0) { r.never = true; r.lastPostAt = null; r.checkedAt = now; return false; }
    if (r.unavailable) return false;
    return !(fresh(r) && trusted(r));
  });

  const total = todo.length;
  let done = 0;
  const report = () => onProgress({ phase: 'activity', done, total });
  report();
  if (!total) {
    log('Activity already up to date.');
    return finish();
  }
  log(`Checking latest post for ${total.toLocaleString()} accounts…`);

  let method = forceDom ? 'dom' : settings.countReposts ? 'v1' : 'gql';
  const save = async () => store.saveAccounts(next);

  // v1 batch lookup
  if (method === 'v1') {
    try {
      for (let i = 0; i < todo.length; i += 100) {
        client.checkpoint();
        const batch = todo.slice(i, i + 100);
        const found = await client.lookupV1(batch.map((r) => r.id));
        const byId = Object.fromEntries(found.map((u) => [u.id, u]));
        for (const r of batch) {
          const u = byId[r.id];
          if (!u) { r.unavailable = true; r.checkedAt = Date.now(); continue; } // suspended / deactivated
          if (u.lastPostAt !== undefined || u.never) {
            Object.assign(r, { lastPostAt: u.lastPostAt ?? null, lastPostId: u.lastPostId, lastPostText: u.lastPostText, never: Boolean(u.never), source: 'v1', checkedAt: Date.now() });
          }
        }
        done = Math.min(total, i + batch.length);
        report();
        await save();
        await client.flushDeferredWait();
        await sleep(jitter(400, 900));
      }
      todo = todo.filter((r) => r.lastPostAt == null && !r.never && !r.unavailable);
      if (todo.length) log(`${todo.length} accounts need a closer look.`);
    } catch (e) {
      if (e instanceof Cancelled) { await save(); throw e; }
      log(`Batch lookup unavailable (${short(e)}). Checking accounts one by one.`, 'info');
      todo = todo.filter((r) => !(r.source === 'v1' && r.checkedAt >= now) && !r.unavailable);
    }
    method = 'gql';
  }

  // per-account GraphQL, then DOM fallback
  const remaining = todo.length;
  let i = 0;
  let consecutiveFail = 0;
  for (const r of todo) {
    client.checkpoint();
    i++;
    try {
      if (method === 'gql') {
        const res = await client.lastPostGql(r.id, { countReposts: settings.countReposts });
        if (res.unavailable) r.unavailable = true;
        else if (res.lastPostAt) Object.assign(r, { lastPostAt: res.lastPostAt, lastPostId: res.lastPostId, lastPostText: res.lastPostText, never: false });
        else if (!res.sawAny) Object.assign(r, { never: r.statuses === 0, lastPostAt: null });
        r.source = 'gql';
        consecutiveFail = 0;
        await client.flushDeferredWait();
        await sleep(jitter(250, 650));
      } else {
        const res = await client.lastPostDom(r.handle);
        if (res.outcome === 'gone') r.unavailable = true;
        else if (res.outcome === 'empty') r.never = true;
        else if (res.lastPostAt) Object.assign(r, { lastPostAt: res.lastPostAt, never: false });
        r.source = 'dom';
        consecutiveFail = 0;
        await sleep(jitter(1200, 2200));
      }
      r.checkedAt = Date.now();
    } catch (e) {
      if (e instanceof Cancelled) { await save(); throw e; }
      consecutiveFail++;
      if (method === 'gql' && consecutiveFail >= 3 && settings.method !== 'api') {
        log(`API lookups failing (${short(e)}). Switching to reading profile pages (slower).`, 'warn');
        method = 'dom';
        consecutiveFail = 0;
      } else if (consecutiveFail >= 8) {
        await save();
        throw new Error(`Too many failures in a row: ${short(e)}`);
      }
    }
    done = total - remaining + i;
    report();
    if (i % 10 === 0) await save();
  }
  await save();
  return finish();

  async function finish() {
    const m = await store.meta();
    m.lastScan = Date.now();
    m.listSource = listSource;
    await store.saveMeta(m);
    log('Scan complete.', 'ok');
    if (client.ownTab) {
      try { await chrome.tabs.update(client.tabId, { url: 'https://x.com/home' }); } catch {}
    }
    return next;
  }
}

function short(e) {
  return String(e?.message || e).slice(0, 140);
}
