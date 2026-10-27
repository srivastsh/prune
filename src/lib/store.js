// Thin wrapper over chrome.storage.local. Everything Prune knows lives here, on your machine.

export const DEFAULT_SETTINGS = {
  countReposts: true,      // a repost counts as activity
  protectMutuals: true,    // never unfollow accounts that follow you back
  dailyCap: 350,           // max unfollows per rolling 24h
  minDelaySec: 6,          // random delay between unfollows
  maxDelaySec: 14,
  recheckDays: 3,          // reuse activity data newer than this on rescans
  method: 'auto',          // auto | api | dom
};

async function get(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export const store = {
  async accounts() { return get('accounts', {}); },
  async saveAccounts(map) { return set('accounts', map); },
  async meta() { return get('meta', {}); },
  async saveMeta(m) { return set('meta', m); },
  async settings() { return { ...DEFAULT_SETTINGS, ...(await get('settings', {})) }; },
  async saveSettings(s) { return set('settings', s); },
  async log() { return get('unfollowLog', []); },
  async appendLog(entry) {
    const log = await get('unfollowLog', []);
    log.push(entry);
    // keep the last 5000 entries
    await set('unfollowLog', log.slice(-5000));
    return log;
  },
  async clearAll() { await chrome.storage.local.clear(); },
};

/** Unfollows done in the last 24h, for the daily cap. */
export function unfollowsInLastDay(log, now = Date.now()) {
  return log.filter((e) => e.ok && now - e.at < 86400000).length;
}
