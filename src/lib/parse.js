// Pure parsing helpers. No browser APIs here so they can be unit tested in Node.
// X's internal JSON shapes drift often, so everything walks the tree defensively
// instead of trusting fixed paths.

const DAY = 86400000;

/** Depth-first walk over any JSON value. Calls visit(node, key) for every object. */
export function walk(value, visit, key = null, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  visit(value, key);
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, null, seen);
  } else {
    for (const k of Object.keys(value)) walk(value[k], visit, k, seen);
  }
}

/** Twitter date strings ("Wed Oct 10 20:19:24 +0000 2018") or ISO → epoch ms, or null. */
export function toMs(d) {
  if (d == null) return null;
  if (typeof d === 'number') return d > 1e12 ? d : d * 1000;
  const t = Date.parse(d);
  return Number.isFinite(t) ? t : null;
}

/** Tweet ids are snowflakes; the timestamp is recoverable even when created_at is missing. */
export function snowflakeToMs(id) {
  try {
    return Number((BigInt(id) >> 22n) + 1288834974657n);
  } catch {
    return null;
  }
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

/** Normalize a GraphQL User result into our flat record. Returns null if it isn't a usable user. */
export function normalizeGqlUser(r) {
  if (!r) return null;
  if (r.__typename === 'UserUnavailable') {
    return r.rest_id ? { id: String(r.rest_id), unavailable: true, reason: r.reason || 'unavailable' } : null;
  }
  if (r.result) return normalizeGqlUser(r.result);
  const L = r.legacy || {};
  const C = r.core || {};
  const id = pick(r.rest_id, L.id_str);
  const handle = pick(C.screen_name, L.screen_name);
  if (!id || !handle) return null;
  const rel = r.relationship_perspectives || {};
  return {
    id: String(id),
    handle,
    name: pick(C.name, L.name, handle),
    avatar: pick(r.avatar?.image_url, L.profile_image_url_https),
    bio: pick(r.profile_bio?.description, L.description) || '',
    // Late-2026 shape: counts live in relationship_counts / tweet_counts and `legacy` is gone.
    followers: pick(r.relationship_counts?.followers, L.followers_count, r.followers_count) ?? null,
    statuses: pick(r.tweet_counts?.tweets, L.statuses_count) ?? null,
    protected: Boolean(pick(r.privacy?.protected, L.protected)),
    verified: Boolean(r.is_blue_verified || r.verification?.verified || L.verified),
    followsYou: Boolean(pick(rel.followed_by, L.followed_by)),
    createdAt: toMs(pick(C.created_at, L.created_at)),
  };
}

/** Normalize a v1.1 user object. Includes last post when `status` is present. */
export function normalizeV1User(u) {
  if (!u || !u.id_str) return null;
  const rec = {
    id: u.id_str,
    handle: u.screen_name,
    name: u.name || u.screen_name,
    avatar: u.profile_image_url_https || null,
    bio: u.description || '',
    followers: u.followers_count ?? null,
    statuses: u.statuses_count ?? null,
    protected: Boolean(u.protected),
    verified: Boolean(u.verified || u.is_blue_verified),
    followsYou: Boolean(u.followed_by),
    createdAt: toMs(u.created_at),
  };
  if (u.status) {
    rec.lastPostAt = toMs(u.status.created_at) ?? snowflakeToMs(u.status.id_str);
    rec.lastPostId = u.status.id_str || null;
    rec.lastPostText = (u.status.full_text || u.status.text || '').slice(0, 280);
    rec.lastPostIsRepost = Boolean(u.status.retweeted_status);
    rec.source = 'v1';
  } else if (u.statuses_count === 0) {
    rec.lastPostAt = null;
    rec.never = true;
    rec.source = 'v1';
  }
  return rec;
}

/** GraphQL Following page → { users, nextCursor }. */
export function parseFollowingPage(json) {
  const users = [];
  const ids = new Set();
  let nextCursor = null;
  walk(json, (node) => {
    if (node.user_results && node.user_results.result) {
      const u = normalizeGqlUser(node.user_results.result);
      if (u && !ids.has(u.id)) {
        ids.add(u.id);
        users.push(u);
      }
    }
    // Cursor entries: { entryId: "cursor-bottom-…", content: { value, cursorType: "Bottom" } }
    if (typeof node.entryId === 'string' && node.entryId.startsWith('cursor-bottom')) {
      nextCursor = pick(node.content?.value, node.content?.itemContent?.value, nextCursor);
    }
    if (node.cursorType === 'Bottom' && node.value) nextCursor = node.value;
  });
  // X returns a bottom cursor even on the last page; an empty page means we are done.
  if (users.length === 0) nextCursor = null;
  return { users, nextCursor };
}

/** v1.1 friends/list → { users, nextCursor }. */
export function parseV1FriendsList(json) {
  const users = (json?.users || []).map(normalizeV1User).filter(Boolean);
  const nc = json?.next_cursor_str;
  return { users, nextCursor: nc && nc !== '0' ? nc : null };
}

/** v1.1 users/lookup → array of records with last post info. */
export function parseV1Lookup(json) {
  return (Array.isArray(json) ? json : []).map(normalizeV1User).filter(Boolean);
}

/**
 * GraphQL UserTweets → newest post timestamp by this user.
 * Pinned posts count (they are real posts), reposts count unless countReposts=false.
 * Returns { lastPostAt, lastPostId, sawAny }.
 */
export function parseUserTweets(json, userId, { countReposts = true } = {}) {
  let best = null;
  let bestId = null;
  let bestText = '';
  let sawAny = false;
  walk(json, (node) => {
    const t = node.tweet_results?.result;
    if (!t) return;
    const tw = t.tweet || t; // TweetWithVisibilityResults wraps in .tweet
    const L = tw.legacy;
    if (!L) return;
    const author = tw.core?.user_results?.result?.rest_id ?? L.user_id_str;
    if (userId && author && String(author) !== String(userId)) return; // quoted/other authors
    const isRepost = Boolean(L.retweeted_status_result);
    if (isRepost && !countReposts) return;
    sawAny = true;
    const ms = toMs(L.created_at) ?? snowflakeToMs(pick(tw.rest_id, L.id_str));
    if (ms && (best === null || ms > best)) {
      best = ms;
      bestId = pick(tw.rest_id, L.id_str);
      bestText = (L.full_text || L.text || '').slice(0, 280);
    }
  });
  return { lastPostAt: best, lastPostId: bestId, lastPostText: bestText, sawAny };
}

/** Pull "The following features cannot be null: a, b" style errors into a list. */
export function missingFeaturesFromError(json) {
  const out = new Set();
  for (const e of json?.errors || []) {
    const m = /features cannot be null:\s*(.+)$/i.exec(e.message || '');
    if (m) m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((f) => out.add(f));
  }
  return [...out];
}

/** Scrape `queryId:"…",operationName:"Following"` + featureSwitches out of X's JS bundle. */
export function scrapeOperations(js, names) {
  const out = {};
  for (const name of names) {
    const re = new RegExp(
      `queryId:"([\\w-]+)",operationName:"${name}",operationType:"\\w+",metadata:\\{featureSwitches:\\[([^\\]]*)\\]`
    );
    const m = re.exec(js);
    if (m) {
      out[name] = {
        queryId: m[1],
        features: m[2].split(',').map((s) => s.replace(/"/g, '').trim()).filter(Boolean),
      };
      continue;
    }
    const simple = new RegExp(`queryId:"([\\w-]+)",operationName:"${name}"`).exec(js);
    if (simple) out[name] = { queryId: simple[1], features: [] };
  }
  return out;
}

export const BUCKETS = [
  { key: 'active', label: 'Posted in 30 days', short: '≤ 30d' },
  { key: 'd60', label: 'Quiet 31–60 days', short: '31–60d' },
  { key: 'd90', label: 'Quiet 61–90 days', short: '61–90d' },
  { key: 'dead', label: 'Quiet 90+ days', short: '90d+' },
  { key: 'never', label: 'Never posted', short: 'Never' },
  { key: 'gone', label: 'Suspended or gone', short: 'Gone' },
  { key: 'unknown', label: 'Not checked yet', short: 'Unknown' },
];

export function daysSince(ms, now = Date.now()) {
  return ms == null ? null : Math.floor((now - ms) / DAY);
}

export function bucketOf(rec, now = Date.now()) {
  if (rec.unavailable) return 'gone';
  if (rec.never) return 'never';
  if (rec.lastPostAt == null) return 'unknown';
  const d = daysSince(rec.lastPostAt, now);
  if (d <= 30) return 'active';
  if (d <= 60) return 'd60';
  if (d <= 90) return 'd90';
  return 'dead';
}

export function relTime(ms, now = Date.now()) {
  if (ms == null) return '';
  const d = daysSince(ms, now);
  if (d < 1) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 60) return `${d} days ago`;
  const mo = Math.round(d / 30.44);
  if (mo < 24) return `${mo} months ago`;
  return `${(d / 365.25).toFixed(1).replace(/\.0$/, '')} years ago`;
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(records, now = Date.now()) {
  const head = ['handle', 'name', 'id', 'bucket', 'days_since_last_post', 'last_post_date', 'followers', 'posts', 'follows_you', 'protected', 'kept', 'profile_url'];
  const rows = records.map((r) => [
    r.handle, r.name, r.id, bucketOf(r, now), daysSince(r.lastPostAt, now),
    r.lastPostAt ? new Date(r.lastPostAt).toISOString().slice(0, 10) : '',
    r.followers, r.statuses, r.followsYou ? 'yes' : 'no', r.protected ? 'yes' : 'no', r.keep ? 'yes' : 'no',
    `https://x.com/${r.handle}`,
  ]);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

// ---------- ranking for the swipe deck ----------
// Order: suspended/gone, never posted, no visible posts, silent 90+ days (longest first),
// silent 31–90 days, then active accounts from least to most useful.

const CATEGORY_RULES = [
  ['brand', 25, /(official (x|twitter)? ?(account|page|channel|home)|customer|support|shop now|our app|we're|we are|follow us|deals|store\b|brand\b|®|™)/i],
  ['news', 20, /(breaking|news\b|newspaper|magazine|journalism|headlines|the latest|coverage|reporting|current events)/i],
  ['meme', 20, /(meme|shitpost|funny|parody|cringe|dm for promo|submissions|viral|no ?context|poorly aged|hourly)/i],
  ['media', 15, /(hip.?hop|charts|pop culture|music news|culture news|entertainment|celebrity news)/i],
  ['sports', 15, /(\bnba\b|\bnfl\b|\bmlb\b|\bnhl\b|soccer|football|\bfc\b|\bufc\b|\bmma\b|\bf1\b|espn|athlete|olympi)/i],
];
const USEFUL = /(\bai\b|\bml\b|llm|engineer|founder|ceo|startup|product|\bpm\b|security|infosec|research|developer|design|investor|\bvc\b|writer|author|professor|scientist|building|builder)/i;

/** What kind of account this is, by bio. Returns { key, weight } or null. */
export function categorize(rec) {
  const s = `${rec.name || ''} ${rec.bio || ''}`;
  for (const [key, weight, re] of CATEGORY_RULES) if (re.test(s)) return { key, weight };
  return null;
}

/** 0–100, higher = less useful. Only meaningful for accounts active in the last 30 days. */
export function lowSignalScore(rec, { total = 1, now = Date.now() } = {}) {
  let s = 0;
  // Oldest follows are the most likely to be stale interests.
  if (rec.followIdx != null && total > 1) s += (rec.followIdx / (total - 1)) * 35;
  const cat = categorize(rec);
  if (cat) s += cat.weight;
  const ageDays = rec.createdAt ? Math.max(1, (now - rec.createdAt) / DAY) : null;
  const rate = ageDays && rec.statuses ? rec.statuses / ageDays : 0;
  s += Math.min(rate, 100) / 10; // firehose accounts: up to +10
  const f = rec.followers || 0;
  if (f >= 1e6) s += 12; else if (f >= 1e5) s += 6;
  if (f < 5000) s -= 25; // probably a real person you know
  if (USEFUL.test(`${rec.name || ''} ${rec.bio || ''}`)) s -= 15;
  return Math.max(0, Math.min(100, s));
}

/** Sort key for the deck: larger = show earlier (more likely an unfollow). */
export function pruneRank(rec, ctx = {}) {
  const now = ctx.now ?? Date.now();
  if (rec.unavailable) return 3000;
  if (rec.never) return 2900;
  if (rec.lastPostAt == null) return 2800;
  const d = daysSince(rec.lastPostAt, now);
  if (d > 90) return 1000 + Math.min(d, 15000) / 10;   // tier 1, longest silence first
  if (d > 30) return 500 + d;                           // tier 2
  return lowSignalScore(rec, { ...ctx, now });          // tier 3 → most useful last
}

export function tierOf(rec, now = Date.now()) {
  const b = bucketOf(rec, now);
  if (b === 'active') return 3;
  if (b === 'd60' || b === 'd90') return 2;
  return 1;
}

export function reasonFor(rec, now = Date.now()) {
  if (rec.unavailable) return 'Suspended or deleted';
  if (rec.never) return 'Never posted';
  if (rec.lastPostAt == null) return 'No visible posts';
  const d = daysSince(rec.lastPostAt, now);
  if (d > 30) return `Silent ${relTime(rec.lastPostAt, now).replace(' ago', '')}`;
  const cat = categorize(rec);
  const names = { brand: 'Brand account', news: 'News feed', meme: 'Meme account', media: 'Pop-culture feed', sports: 'Sports' };
  const bits = [];
  if (cat) bits.push(names[cat.key]);
  if ((rec.followers || 0) >= 1e6) bits.push('mega account');
  return bits.length ? bits.join(', ') : 'Active';
}
