// Client used by the dashboard. Every request is executed inside an x.com tab with your
// own logged-in session; Prune has no server and no API keys.
import {
  parseFollowingPage, parseV1FriendsList, parseV1Lookup, parseUserTweets,
  missingFeaturesFromError, scrapeOperations,
} from './parse.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Cancelled extends Error {
  constructor() { super('cancelled'); }
}

export class XClient {
  constructor({ log = () => {}, onWait = () => {} } = {}) {
    this.log = log;
    this.onWait = onWait;
    this.tabId = null;
    this.ops = {};
    this.extraFeatures = {}; // opName -> { feature: false } learned from 400 errors
    this.viewerId = null;
    this.cancelled = false;
    this.paused = false;
  }

  // ---------- tab plumbing ----------

  async ensureTab() {
    if (this.tabId != null) {
      try {
        const t = await chrome.tabs.get(this.tabId);
        if (t && /^https:\/\/(x|twitter)\.com\//.test(t.url || t.pendingUrl || '')) {
          if (await this.ping()) return this.tabId;
        }
      } catch {}
      this.tabId = null;
    }
    const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
    for (const t of tabs) {
      this.tabId = t.id;
      if (await this.ping()) return t.id;
    }
    // Open a background worker tab. Pinned so it's out of the way.
    const tab = await chrome.tabs.create({ url: 'https://x.com/home', active: false, pinned: true });
    this.tabId = tab.id;
    this.ownTab = true;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await this.ping()) {
        await sleep(2500); // let X fire its own requests so the hook learns query ids
        return tab.id;
      }
    }
    throw new Error('Could not reach an x.com tab. Open x.com, sign in, and try again.');
  }

  async ping() {
    try {
      const r = await chrome.tabs.sendMessage(this.tabId, { to: 'prune-bridge', cmd: 'ping' });
      return Boolean(r?.ok);
    } catch {
      return false;
    }
  }

  async send(cmd, args) {
    await this.ensureTab();
    const r = await chrome.tabs.sendMessage(this.tabId, { to: 'prune-bridge', cmd, args });
    if (!r) throw new Error('No response from x.com tab');
    return r;
  }

  async navigate(url) {
    await this.ensureTab();
    await chrome.tabs.update(this.tabId, { url });
    // Wait for the navigation to finish and the bridge to be re-injected.
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try {
        const t = await chrome.tabs.get(this.tabId);
        if (t.status === 'complete' && (await this.ping())) return;
      } catch {}
    }
    throw new Error('page load timed out');
  }

  checkpoint() {
    if (this.cancelled) throw new Cancelled();
  }

  async waitWhilePaused() {
    while (this.paused && !this.cancelled) await sleep(300);
    this.checkpoint();
  }

  async wait(ms, reason) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      this.checkpoint();
      this.onWait(Math.ceil((end - Date.now()) / 1000), reason);
      await sleep(Math.min(1000, end - Date.now()));
    }
    this.onWait(0, null);
  }

  // ---------- requests ----------

  /** Raw request with rate-limit handling. Returns the hook's response object. */
  async request(args, { label = 'request', retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await this.waitWhilePaused();
      const r = await this.send('fetch', args);
      if (!r.ok) throw new Error(r.error);
      const res = r.result;
      if (res.status === 429) {
        const resetMs = Number.isFinite(res.limit.reset) ? res.limit.reset * 1000 - Date.now() : 15 * 60e3;
        const waitMs = Math.max(30e3, Math.min(resetMs + 5e3, 16 * 60e3));
        this.log(`Rate limited on ${label}. Waiting ${Math.round(waitMs / 60e3)} min.`, 'warn');
        await this.wait(waitMs, 'X rate limit');
        continue;
      }
      if (res.status >= 500 && attempt < retries) {
        await this.wait(3000 * (attempt + 1), 'retrying');
        continue;
      }
      // Pre-emptively slow down when we are about to hit the limit.
      if (Number.isFinite(res.limit.remaining) && res.limit.remaining <= 1 && Number.isFinite(res.limit.reset)) {
        const waitMs = Math.max(0, res.limit.reset * 1000 - Date.now()) + 3e3;
        if (waitMs > 0 && waitMs < 16 * 60e3) {
          this.log(`Hit X's limit for ${label}. Pausing ${Math.ceil(waitMs / 60e3)} min until it resets.`, 'warn');
          this._deferredWait = waitMs;
        }
      }
      return res;
    }
  }

  async flushDeferredWait() {
    if (this._deferredWait) {
      const ms = this._deferredWait;
      this._deferredWait = 0;
      await this.wait(ms, 'X rate limit');
    }
  }

  async init() {
    const r = await this.send('state');
    const st = r.result;
    this.viewerId = st.viewerId;
    this.ops = { ...st.ops, ...this.ops };
    if (!st.viewerId || !st.hasCsrf) {
      throw new Error('You are not signed in to X in this browser. Sign in at x.com, then scan again.');
    }
    return st;
  }

  async viewerProfile() {
    // v1.1 users/show and verify_credentials 404 for web sessions as of Oct 2026; GraphQL works.
    try {
      const j = await this.gql('UserByRestId', { userId: this.viewerId, withSafetyModeUserFields: true });
      const u = j?.data?.user?.result;
      const handle = u?.core?.screen_name || u?.legacy?.screen_name;
      if (handle) {
        return {
          handle,
          name: u.core?.name || u.legacy?.name,
          following: u.relationship_counts?.following ?? u.legacy?.friends_count ?? null,
          avatar: u.avatar?.image_url || u.legacy?.profile_image_url_https,
        };
      }
    } catch (e) {
      if (e instanceof Cancelled) throw e;
    }
    return { handle: null, following: null };
  }

  // ---------- GraphQL ----------

  async resolveOps(names) {
    const missing = names.filter((n) => !this.ops[n]?.queryId);
    if (!missing.length) return;
    this.log(`Looking up X's current query ids for ${missing.join(', ')}…`);
    const st = await this.send('state');
    Object.assign(this.ops, st.result.ops);
    const still = names.filter((n) => !this.ops[n]?.queryId);
    if (!still.length) return;
    const urls = (await this.send('scriptUrls')).result || [];
    // main.*.js holds most operations; check it first, then the rest.
    urls.sort((a, b) => (/\/main\./.test(b) ? 1 : 0) - (/\/main\./.test(a) ? 1 : 0));
    for (const url of urls.slice(0, 40)) {
      const left = names.filter((n) => !this.ops[n]?.queryId);
      if (!left.length) break;
      try {
        const js = await (await fetch(url)).text();
        const found = scrapeOperations(js, left);
        for (const [name, v] of Object.entries(found)) {
          this.ops[name] = {
            ...this.ops[name],
            queryId: v.queryId,
            features: this.ops[name]?.features || Object.fromEntries(v.features.map((f) => [f, true])),
          };
        }
      } catch {}
    }
  }

  async gql(opName, variables, { label } = {}) {
    await this.resolveOps([opName]);
    const op = this.ops[opName];
    if (!op?.queryId) throw new Error(`Could not find X's query id for ${opName}`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const features = { ...(op.features || {}), ...(this.extraFeatures[opName] || {}) };
      const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(features) });
      if (op.fieldToggles) params.set('fieldToggles', JSON.stringify(op.fieldToggles));
      const res = await this.request({ path: `/i/api/graphql/${op.queryId}/${opName}?${params}` }, { label: label || opName });
      if (res.status === 400) {
        const miss = missingFeaturesFromError(res.json);
        if (miss.length) {
          this.extraFeatures[opName] = { ...(this.extraFeatures[opName] || {}), ...Object.fromEntries(miss.map((f) => [f, false])) };
          continue;
        }
      }
      if (res.status === 404 && attempt === 0) {
        // Stale query id. Forget it and re-scrape once.
        delete this.ops[opName];
        await this.resolveOps([opName]);
        if (!this.ops[opName]?.queryId) break;
        Object.assign(op, this.ops[opName]);
        continue;
      }
      if (!res.ok) throw httpError(res, opName);
      return res.json;
    }
    throw new Error(`${opName} kept failing`);
  }

  // ---------- strategies ----------

  /** Fastest path: v1.1 friends/list returns 200 accounts with their latest post. */
  async *followingV1() {
    let cursor = '-1';
    while (cursor) {
      this.checkpoint();
      const res = await this.request({
        path: `/i/api/1.1/friends/list.json?user_id=${this.viewerId}&count=200&cursor=${cursor}&skip_status=false&include_user_entities=false`,
      }, { label: 'following list' });
      if (!res.ok) throw httpError(res, 'friends/list');
      const { users, nextCursor } = parseV1FriendsList(res.json);
      yield users;
      cursor = nextCursor;
      await this.flushDeferredWait();
    }
  }

  async *followingGql() {
    let cursor = null;
    let guard = 0;
    while (guard++ < 200) {
      this.checkpoint();
      const vars = { userId: this.viewerId, count: 100, includePromotedContent: false };
      if (cursor) vars.cursor = cursor;
      const json = await this.gql('Following', vars, { label: 'following list' });
      const { users, nextCursor } = parseFollowingPage(json);
      if (!users.length) return;
      yield users;
      if (!nextCursor || nextCursor === cursor) return;
      cursor = nextCursor;
      await this.flushDeferredWait();
    }
  }

  /** Batch lookup: 100 accounts per call, includes each account's latest post. */
  async lookupV1(ids) {
    const res = await this.request({
      path: `/i/api/1.1/users/lookup.json?user_id=${ids.join(',')}&include_entities=false&skip_status=false`,
    }, { label: 'activity lookup' });
    if (res.status === 404 && res.json?.errors?.[0]?.code === 17) return []; // none found
    if (!res.ok) throw httpError(res, 'users/lookup');
    return parseV1Lookup(res.json);
  }

  async lastPostGql(userId, { countReposts = true } = {}) {
    const json = await this.gql('UserTweets', {
      userId, count: 20, includePromotedContent: false, withQuickPromoteEligibilityTweetFields: false,
      withVoice: false, withV2Timeline: true,
    }, { label: 'activity lookup' });
    const unavailable = /UserUnavailable|Suspended/.test(JSON.stringify(json?.data?.user?.result?.__typename || ''));
    const r = parseUserTweets(json, userId, { countReposts });
    return { ...r, unavailable };
  }

  async lastPostDom(handle) {
    await this.navigate(`https://x.com/${encodeURIComponent(handle)}`);
    const r = await this.send('scrapeProfile', { handle });
    if (!r.ok) throw new Error(r.error || 'scrape failed');
    return r;
  }

  async unfollowApi(userId) {
    const res = await this.request({
      method: 'POST', path: '/i/api/1.1/friendships/destroy.json', form: { user_id: userId },
    }, { label: 'unfollow', retries: 0 });
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, error: errText(res) };
  }

  async unfollowDom(handle) {
    await this.navigate(`https://x.com/${encodeURIComponent(handle)}`);
    return this.send('domUnfollow');
  }
}

function errText(res) {
  const e = res.json?.errors?.[0];
  return e ? `${e.code ?? ''} ${e.message ?? ''}`.trim() : res.text || `HTTP ${res.status}`;
}

export function httpError(res, what) {
  const err = new Error(`${what}: HTTP ${res.status} ${errText(res)}`);
  err.status = res.status;
  err.code = res.json?.errors?.[0]?.code;
  return err;
}
