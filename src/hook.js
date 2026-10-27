// Runs in the page's MAIN world on x.com. Two jobs:
// 1. Watch X's own API traffic to learn current GraphQL query ids, feature flags and
//    the bearer token, so Prune keeps working when X ships a new bundle.
// 2. Execute API requests on Prune's behalf using the page's own session (same origin,
//    same cookies). Nothing leaves your browser except requests to x.com itself.
(() => {
  if (window.__pruneHook) return;
  window.__pruneHook = true;

  const FALLBACK_BEARER =
    'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

  const state = {
    bearer: null,
    ops: {}, // operationName -> { queryId, features, fieldToggles, variables }
    sawTransactionId: false,
  };

  const origFetch = window.fetch.bind(window);

  function learn(url, headers) {
    try {
      const u = new URL(url, location.href);
      const m = /\/graphql\/([\w-]+)\/(\w+)/.exec(u.pathname);
      if (m) {
        const op = (state.ops[m[2]] = state.ops[m[2]] || {});
        op.queryId = m[1];
        for (const k of ['features', 'fieldToggles', 'variables']) {
          const v = u.searchParams.get(k);
          if (v) {
            try { op[k] = JSON.parse(v); } catch {}
          }
        }
      }
      if (headers) {
        const get = (n) =>
          headers instanceof Headers ? headers.get(n) : headers[n] || headers[n.toLowerCase()];
        const auth = get('authorization') || get('Authorization');
        if (auth && auth.startsWith('Bearer ')) state.bearer = auth;
        if (get('x-client-transaction-id')) state.sawTransactionId = true;
      }
    } catch {}
  }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input?.url;
      const headers = init?.headers || (input instanceof Request ? input.headers : null);
      if (url && /\/i\/api\//.test(url)) learn(url, headers);
    } catch {}
    return origFetch(input, init);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__pruneUrl = url;
    this.__pruneHeaders = {};
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    try {
      if (this.__pruneHeaders) {
        this.__pruneHeaders[k.toLowerCase()] = v;
        if (this.__pruneUrl && /\/i\/api\//.test(this.__pruneUrl)) learn(this.__pruneUrl, this.__pruneHeaders);
      }
    } catch {}
    return origSetHeader.call(this, k, v);
  };

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function viewerId() {
    const twid = cookie('twid'); // "u=123456"
    const m = twid && /u=(\d+)/.exec(twid);
    return m ? m[1] : null;
  }

  async function xfetch({ method = 'GET', path, body, form }) {
    const headers = {
      authorization: state.bearer || FALLBACK_BEARER,
      'x-csrf-token': cookie('ct0') || '',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': document.documentElement.lang || 'en',
    };
    let payload;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(form).toString();
    } else if (body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await origFetch(new URL(path, location.origin).toString(), {
      method,
      headers,
      body: payload,
      credentials: 'include',
    });
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = null; }
    return {
      status: res.status,
      ok: res.ok,
      json,
      text: json ? null : text.slice(0, 300),
      limit: {
        remaining: Number(res.headers.get('x-rate-limit-remaining') ?? NaN),
        reset: Number(res.headers.get('x-rate-limit-reset') ?? NaN),
      },
    };
  }

  window.addEventListener('message', async (ev) => {
    if (ev.source !== window || !ev.data || ev.data.__prune !== 'req') return;
    const { id, cmd, args } = ev.data;
    let result;
    try {
      if (cmd === 'state') {
        result = {
          viewerId: viewerId(),
          hasCsrf: Boolean(cookie('ct0')),
          ops: state.ops,
          learnedBearer: Boolean(state.bearer),
          sawTransactionId: state.sawTransactionId,
        };
      } else if (cmd === 'fetch') {
        result = await xfetch(args);
      } else {
        throw new Error('unknown command ' + cmd);
      }
      window.postMessage({ __prune: 'res', id, ok: true, result }, location.origin);
    } catch (e) {
      window.postMessage({ __prune: 'res', id, ok: false, error: String(e?.message || e) }, location.origin);
    }
  });
})();
