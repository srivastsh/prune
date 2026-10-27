// Isolated-world content script on x.com. Relays commands from the Prune dashboard to
// the MAIN-world hook (API calls) and handles DOM-based fallbacks (reading a profile
// page, clicking Unfollow) when X's API path is unavailable.
(() => {
  if (window.__pruneBridge) return;
  window.__pruneBridge = true;

  let seq = 0;
  const pending = new Map();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__prune !== 'res') return;
    const p = pending.get(ev.data.id);
    if (!p) return;
    pending.delete(ev.data.id);
    ev.data.ok ? p.resolve(ev.data.result) : p.reject(new Error(ev.data.error));
  });

  function toPage(cmd, args, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = `${Date.now()}-${++seq}`;
      pending.set(id, { resolve, reject });
      window.postMessage({ __prune: 'req', id, cmd, args }, location.origin);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('page hook timed out (reload the x.com tab)'));
        }
      }, timeout);
    });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 12000, every = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(every);
    }
    return null;
  }

  function currentHandle() {
    return location.pathname.split('/').filter(Boolean)[0] || '';
  }

  // Read the newest visible post date from a profile page.
  async function scrapeProfile(handle) {
    const outcome = await waitFor(() => {
      if (document.querySelector('article[data-testid="tweet"] time')) return 'posts';
      const empty = document.querySelector('[data-testid="emptyState"]');
      const text = document.body.innerText || '';
      if (/account (doesn.t|does not) exist|Account suspended|This account has been suspended/i.test(text)) return 'gone';
      if (/These posts are protected|posts are protected/i.test(text)) return 'protected';
      if (empty) return 'empty';
      return null;
    });
    if (!outcome) return { ok: false, error: 'profile did not load' };
    if (outcome !== 'posts') return { ok: true, outcome };
    await sleep(600); // let the first screen of posts settle
    let best = null;
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')].slice(0, 8);
    for (const a of articles) {
      const t = a.querySelector('time');
      const ms = t && Date.parse(t.getAttribute('datetime'));
      if (ms && (best === null || ms > best)) best = ms;
    }
    return { ok: true, outcome: best ? 'posts' : 'empty', lastPostAt: best, handle: currentHandle() || handle };
  }

  async function domUnfollow() {
    const btn = await waitFor(() => document.querySelector('[data-testid$="-unfollow"]'), 10000);
    if (!btn) {
      const following = document.querySelector('[data-testid$="-follow"]');
      return following ? { ok: true, already: true } : { ok: false, error: 'no Following button found' };
    }
    btn.click();
    const confirm = await waitFor(() => document.querySelector('[data-testid="confirmationSheetConfirm"]'), 5000);
    if (confirm) confirm.click();
    const done = await waitFor(() => document.querySelector('[data-testid$="-follow"]'), 6000);
    return done ? { ok: true } : { ok: false, error: 'unfollow did not confirm' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.to !== 'prune-bridge') return;
    (async () => {
      try {
        switch (msg.cmd) {
          case 'ping':
            return { ok: true, href: location.href };
          case 'state':
            return { ok: true, result: await toPage('state') };
          case 'fetch':
            return { ok: true, result: await toPage('fetch', msg.args, 45000) };
          case 'scriptUrls':
            return {
              ok: true,
              result: [...document.scripts].map((s) => s.src).filter((s) => /twimg\.com\/.*\.js/.test(s)),
            };
          case 'scrapeProfile':
            return await scrapeProfile(msg.args?.handle);
          case 'domUnfollow':
            return await domUnfollow();
          default:
            return { ok: false, error: 'unknown command' };
        }
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    })().then(sendResponse);
    return true; // async response
  });
})();
