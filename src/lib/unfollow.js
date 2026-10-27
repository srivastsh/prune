// Throttled unfollow queue. Slow on purpose: random delays and a rolling 24h cap keep the
// pattern well away from what X flags as automated churn.
import { Cancelled } from './x.js';
import { unfollowsInLastDay } from './store.js';

const STOP_CODES = new Set([326, 344, 64, 32]); // locked, daily limit, suspended, auth

export async function runUnfollow(client, store, queue, { settings, onProgress, log }) {
  await client.init();
  let method = settings.method === 'dom' ? 'dom' : 'api';
  let done = 0;
  let failed = 0;
  const total = queue.length;
  onProgress({ done, failed, total });

  for (const rec of queue) {
    client.checkpoint();
    // Belt and braces: the dashboard already filters these out.
    if (rec.keep || (settings.protectMutuals && rec.followsYou)) {
      log(`Skipped @${rec.handle} (${rec.keep ? 'kept' : 'follows you back'}).`);
      continue;
    }
    await client.waitWhilePaused();

    const history = await store.log();
    const used = unfollowsInLastDay(history);
    if (used >= settings.dailyCap) {
      const oldest = history.filter((e) => e.ok && Date.now() - e.at < 86400000).sort((a, b) => a.at - b.at)[0];
      const hrs = oldest ? Math.ceil((oldest.at + 86400000 - Date.now()) / 3600000) : 24;
      log(`Daily cap of ${settings.dailyCap} reached. Next slot opens in about ${hrs} h. Queue stopped; your selection is kept.`, 'warn');
      break;
    }

    let res;
    try {
      res = method === 'api' ? await client.unfollowApi(rec.id) : await client.unfollowDom(rec.handle);
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      res = { ok: false, error: String(e?.message || e) };
    }

    if (!res.ok && method === 'api') {
      const code = Number(/^(\d+)/.exec(res.error || '')?.[1]);
      if (STOP_CODES.has(code)) {
        log(`X returned "${res.error}". Stopping to protect your account.`, 'error');
        await store.appendLog({ id: rec.id, handle: rec.handle, at: Date.now(), ok: false, error: res.error });
        break;
      }
      if (settings.method !== 'api') {
        log(`API unfollow failed (${res.error}). Switching to clicking Unfollow on the profile page.`, 'warn');
        method = 'dom';
        try { res = await client.unfollowDom(rec.handle); } catch (e) {
          if (e instanceof Cancelled) throw e;
          res = { ok: false, error: String(e?.message || e) };
        }
      }
    }

    await store.appendLog({ id: rec.id, handle: rec.handle, at: Date.now(), ok: res.ok, method, error: res.ok ? undefined : res.error });
    if (res.ok) {
      done++;
      const accounts = await store.accounts();
      delete accounts[rec.id];
      await store.saveAccounts(accounts);
    } else {
      failed++;
      log(`Couldn't unfollow @${rec.handle}: ${res.error}`, 'warn');
      if (failed >= 5 && done === 0) {
        log('Five failures with no successes. Stopping.', 'error');
        break;
      }
    }
    onProgress({ done, failed, total, last: rec, ok: res.ok });

    if (done + failed < total) {
      const sec = settings.minDelaySec + Math.random() * Math.max(0, settings.maxDelaySec - settings.minDelaySec);
      await client.wait(sec * 1000, 'pacing');
    }
  }
  if (client.ownTab) {
    try { await chrome.tabs.update(client.tabId, { url: 'https://x.com/home' }); } catch {}
  }
  return { done, failed };
}
