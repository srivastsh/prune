import { BUCKETS, bucketOf, daysSince, relTime, toCSV } from './lib/parse.js';
import { XClient, Cancelled } from './lib/x.js';
import { store, unfollowsInLastDay } from './lib/store.js';
import { runScan } from './lib/scan.js';
import { runUnfollow } from './lib/unfollow.js';

const $ = (id) => document.getElementById(id);
const PAGE = 200;

const S = {
  accounts: {},
  meta: {},
  settings: null,
  filter: new Set(),     // empty = all buckets
  selected: new Set(),
  shown: PAGE,
  client: null,          // set while a job runs
  job: null,             // 'scan' | 'unfollow'
};

// ---------- boot ----------

init();

async function init() {
  S.settings = await store.settings();
  S.accounts = await store.accounts();
  S.meta = await store.meta();
  bind();
  render();
  // Keep in sync if another Prune tab changes data.
  chrome.storage.onChanged.addListener(async (changes) => {
    if (S.job) return;
    if (changes.accounts) S.accounts = changes.accounts.newValue || {};
    if (changes.meta) S.meta = changes.meta.newValue || {};
    if (changes.accounts || changes.meta) render();
  });
}

function bind() {
  $('scanBtn').onclick = () => startScan();
  $('pauseBtn').onclick = () => {
    if (!S.client) return;
    S.client.paused = !S.client.paused;
    $('pauseBtn').textContent = S.client.paused ? 'Resume' : 'Pause';
    log(S.client.paused ? 'Paused.' : 'Resumed.');
  };
  $('stopBtn').onclick = () => { if (S.client) S.client.cancelled = true; };
  $('search').oninput = () => { S.shown = PAGE; renderRows(); };
  for (const id of ['hideMutuals', 'hideKept', 'sort']) $(id).onchange = () => { S.shown = PAGE; renderRows(); };
  $('selectAll').onchange = (e) => {
    const list = visible();
    if (e.target.checked) list.forEach((r) => S.selected.add(r.id));
    else list.forEach((r) => S.selected.delete(r.id));
    renderRows();
  };
  $('moreBtn').onclick = () => { S.shown += PAGE; renderRows(); };
  $('clearSel').onclick = () => { S.selected.clear(); renderRows(); };
  $('keepSel').onclick = async () => {
    for (const id of S.selected) if (S.accounts[id]) S.accounts[id].keep = true;
    S.selected.clear();
    await store.saveAccounts(S.accounts);
    render();
  };
  $('unfollowBtn').onclick = () => confirmUnfollow();
  $('exportBtn').onclick = exportCSV;
  $('settingsBtn').onclick = openSettings;
  $('resetBtn').onclick = async () => {
    if (S.job) return;
    if (!confirm('Erase every scan result, kept star and log entry stored by Prune?')) return;
    await store.clearAll();
    S.accounts = {}; S.meta = {}; S.selected.clear(); S.filter.clear();
    S.settings = await store.settings();
    $('settingsDlg').close();
    render();
  };
  $('rows').addEventListener('click', onRowClick);
  window.addEventListener('beforeunload', (e) => {
    if (S.job) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------- rendering ----------

function list() { return Object.values(S.accounts); }

function counts() {
  const c = Object.fromEntries(BUCKETS.map((b) => [b.key, 0]));
  const now = Date.now();
  for (const r of list()) if (!r.keep || !$('hideKept').checked) c[bucketOf(r, now)]++;
  return c;
}

function render() {
  const all = list();
  const has = all.length > 0;
  $('empty').hidden = has || S.job === 'scan';
  $('buckets').hidden = !has;
  $('toolbar').hidden = !has;
  $('tableWrap').hidden = !has;
  $('exportBtn').disabled = !has;
  $('scanBtn').disabled = Boolean(S.job);
  $('scanBtn').textContent = S.meta.lastScan ? 'Rescan' : 'Scan my following';

  if (S.meta.handle) {
    $('account').hidden = false;
    $('accountHandle').textContent = '@' + S.meta.handle;
    if (S.meta.avatar) $('accountAvatar').src = S.meta.avatar;
  }

  if (has) {
    const c = counts();
    const quiet = c.d60 + c.d90 + c.dead + c.never + c.gone;
    $('heroCount').textContent = `${quiet.toLocaleString()} of the ${all.length.toLocaleString()} accounts you follow haven't posted in 30+ days.`;
    $('heroSub').textContent = S.meta.lastScan
      ? `Last scanned ${new Date(S.meta.lastScan).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. ${c.unknown ? `${c.unknown} not checked yet.` : ''}`
      : 'Scan in progress.';
  }
  renderBuckets();
  renderRows();
}

function renderBuckets() {
  const c = counts();
  const el = $('buckets');
  el.innerHTML = '';
  for (const b of BUCKETS) {
    if ((b.key === 'unknown' || b.key === 'gone') && !c[b.key]) continue;
    const btn = document.createElement('button');
    btn.className = 'bucket' + (S.filter.has(b.key) ? ' on' : '');
    btn.title = b.label;
    btn.innerHTML = `<span class="n">${c[b.key].toLocaleString()}</span><span class="l"><i class="dot" style="background:var(--b-${b.key})"></i>${b.label}</span>`;
    btn.onclick = (e) => {
      if (!(e.metaKey || e.ctrlKey || e.shiftKey)) {
        const only = S.filter.size === 1 && S.filter.has(b.key);
        S.filter.clear();
        if (!only) S.filter.add(b.key);
      } else {
        S.filter.has(b.key) ? S.filter.delete(b.key) : S.filter.add(b.key);
      }
      S.shown = PAGE;
      renderBuckets();
      renderRows();
    };
    el.appendChild(btn);
  }
}

function visible() {
  const q = $('search').value.trim().toLowerCase();
  const hideMutuals = $('hideMutuals').checked;
  const hideKept = $('hideKept').checked;
  const now = Date.now();
  let rows = list().filter((r) => {
    if (S.filter.size && !S.filter.has(bucketOf(r, now))) return false;
    if (hideMutuals && r.followsYou) return false;
    if (hideKept && r.keep) return false;
    if (q && !(`${r.handle} ${r.name} ${r.bio}`.toLowerCase().includes(q))) return false;
    return true;
  });
  const quietKey = (r) => (r.unavailable ? -3 : r.never ? -2 : r.lastPostAt == null ? Infinity : r.lastPostAt);
  const sorters = {
    oldest: (a, b) => quietKey(a) - quietKey(b),
    newest: (a, b) => quietKey(b) - quietKey(a),
    followers: (a, b) => (b.followers ?? 0) - (a.followers ?? 0),
    fewest: (a, b) => (a.followers ?? 0) - (b.followers ?? 0),
    handle: (a, b) => a.handle.localeCompare(b.handle),
  };
  rows.sort(sorters[$('sort').value] || sorters.oldest);
  return rows;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtNum(n) {
  if (n == null) return '';
  return n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n.toLocaleString();
}

function lastCell(r, now) {
  const b = bucketOf(r, now);
  const dot = `<i class="dot" style="background:var(--b-${b})"></i>`;
  if (r.unavailable) return `${dot}<span>Suspended or deleted</span>`;
  if (r.never) return `${dot}<span>Never posted</span>`;
  if (r.lastPostAt == null) return `${dot}<span class="muted">Not checked</span>`;
  const date = new Date(r.lastPostAt).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  const link = r.lastPostId ? `https://x.com/${encodeURIComponent(r.handle)}/status/${r.lastPostId}` : null;
  const inner = `${relTime(r.lastPostAt, now)}<small>${date}</small>`;
  return `${dot}<span>${link ? `<a href="${link}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none">${inner}</a>` : inner}</span>`;
}

function renderRows() {
  if ($('tableWrap').hidden) { renderActionbar(); return; }
  const now = Date.now();
  const rows = visible();
  const slice = rows.slice(0, S.shown);
  const frag = document.createDocumentFragment();
  for (const r of slice) {
    const li = document.createElement('li');
    li.className = 'row' + (S.selected.has(r.id) ? ' sel' : '');
    li.dataset.id = r.id;
    const tags = [
      r.followsYou ? '<span class="tag">Follows you</span>' : '',
      r.protected ? '<span class="tag">Private</span>' : '',
    ].join('');
    li.innerHTML = `
      <input type="checkbox" data-act="sel" ${S.selected.has(r.id) ? 'checked' : ''} aria-label="Select @${esc(r.handle)}" />
      ${r.avatar ? `<img class="avatar" loading="lazy" src="${esc(r.avatar)}" alt="" referrerpolicy="no-referrer" />` : '<span class="avatar"></span>'}
      <div class="who">
        <div class="name"><a href="https://x.com/${encodeURIComponent(r.handle)}" target="_blank" rel="noopener">${esc(r.name)}</a>${tags}</div>
        <div class="meta">@${esc(r.handle)}${r.bio ? ' · ' + esc(r.bio) : ''}</div>
      </div>
      <div class="last">${lastCell(r, now)}</div>
      <div class="num" title="Followers">${fmtNum(r.followers)}</div>
      <button class="star ${r.keep ? 'on' : ''}" data-act="keep" title="${r.keep ? 'Kept. Click to un-keep' : 'Keep (never unfollow)'}" aria-label="Keep">${r.keep ? '★' : '☆'}</button>`;
    frag.appendChild(li);
  }
  const ol = $('rows');
  ol.replaceChildren(frag);
  $('moreBtn').hidden = rows.length <= S.shown;
  $('shownCount').textContent = `${rows.length.toLocaleString()} shown`;
  const allSel = rows.length > 0 && rows.every((r) => S.selected.has(r.id));
  $('selectAll').checked = allSel;
  $('selectAllLabel').textContent = `Select all ${rows.length.toLocaleString()} shown`;
  renderActionbar();
}

function renderActionbar() {
  // Drop selections that no longer exist (unfollowed, filtered by rescan).
  for (const id of S.selected) if (!S.accounts[id]) S.selected.delete(id);
  const n = S.selected.size;
  $('actionbar').hidden = n === 0 || S.job === 'unfollow';
  $('selCount').textContent = n.toLocaleString();
  $('selEta').textContent = n ? `· ${eta(n)}` : '';
}

function eta(n) {
  const avg = (S.settings.minDelaySec + S.settings.maxDelaySec) / 2 + 1.5;
  const cap = S.settings.dailyCap;
  if (n <= cap) {
    const min = Math.ceil((n * avg) / 60);
    return min < 60 ? `about ${min} min` : `about ${(min / 60).toFixed(1)} h`;
  }
  return `${Math.ceil(n / cap)} days at ${cap}/day`;
}

async function onRowClick(e) {
  const li = e.target.closest('.row');
  if (!li) return;
  const id = li.dataset.id;
  const act = e.target.dataset.act;
  if (act === 'keep') {
    const r = S.accounts[id];
    r.keep = !r.keep;
    if (r.keep) S.selected.delete(id);
    await store.saveAccounts(S.accounts);
    renderBuckets();
    renderRows();
  } else if (act === 'sel') {
    e.target.checked ? S.selected.add(id) : S.selected.delete(id);
    li.classList.toggle('sel', e.target.checked);
    renderActionbar();
  } else if (!e.target.closest('a')) {
    // click anywhere on the row toggles selection
    const cb = li.querySelector('input[data-act=sel]');
    cb.checked = !cb.checked;
    cb.checked ? S.selected.add(id) : S.selected.delete(id);
    li.classList.toggle('sel', cb.checked);
    renderActionbar();
  }
}

// ---------- progress + log ----------

function log(msg, level = 'info') {
  const li = document.createElement('li');
  li.className = level;
  li.textContent = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}  ${msg}`;
  $('log').prepend(li);
  if (level === 'error' || level === 'warn') $('logBox').open = true;
}

function showProgress(label, done, total) {
  $('progress').hidden = false;
  $('progressLabel').textContent = label;
  const bar = $('progressFill').parentElement;
  if (total) {
    bar.classList.remove('indeterminate');
    $('progressFill').style.width = `${Math.min(100, (done / total) * 100)}%`;
    $('progressCount').textContent = `${done.toLocaleString()} / ${total.toLocaleString()}`;
  } else {
    bar.classList.add('indeterminate');
    $('progressFill').style.width = '';
    $('progressCount').textContent = done ? done.toLocaleString() : '';
  }
}

function onWait(sec, reason) {
  if (!sec) { $('progressWait').textContent = ''; return; }
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  $('progressWait').textContent = reason === 'pacing' ? `Next in ${sec}s` : `${reason}: resuming in ${m}:${s}`;
}

function newClient() {
  return new XClient({ log, onWait });
}

function endJob() {
  S.job = null;
  S.client = null;
  $('progress').hidden = true;
  $('pauseBtn').textContent = 'Pause';
  render();
}

// ---------- jobs ----------

async function startScan() {
  if (S.job) return;
  S.job = 'scan';
  S.client = newClient();
  render();
  showProgress('Connecting to x.com…', 0, 0);
  let lastRender = 0;
  try {
    await runScan(S.client, store, {
      settings: S.settings,
      log,
      onProgress: async ({ phase, done, total }) => {
        showProgress(phase === 'list' ? 'Loading who you follow…' : 'Checking latest posts…', done, phase === 'list' ? total : total);
        if (Date.now() - lastRender > 1500) {
          lastRender = Date.now();
          S.accounts = await store.accounts();
          S.meta = await store.meta();
          render();
        }
      },
    });
  } catch (e) {
    if (e instanceof Cancelled) log('Scan stopped. Progress so far is saved; rescan picks up where it left off.', 'warn');
    else log(e.message || String(e), 'error');
  }
  S.accounts = await store.accounts();
  S.meta = await store.meta();
  endJob();
}

async function confirmUnfollow() {
  const recs = [...S.selected].map((id) => S.accounts[id]).filter((r) => r && !r.keep);
  if (!recs.length) return;
  const history = await store.log();
  const left = Math.max(0, S.settings.dailyCap - unfollowsInLastDay(history));
  const today = Math.min(left, recs.length);
  const mutuals = recs.filter((r) => r.followsYou).length;
  $('confirmTitle').textContent = `Unfollow ${recs.length.toLocaleString()} account${recs.length === 1 ? '' : 's'}?`;
  $('confirmBody').textContent =
    `${today.toLocaleString()} will go now (${eta(today)}), ${left < recs.length ? `the rest after your ${S.settings.dailyCap}/day cap resets. Run the queue again tomorrow for those. ` : ''}` +
    `${mutuals ? `${mutuals} of them follow you. ` : ''}Keep this tab open while it runs. This can't be undone in bulk.`;
  const ul = $('confirmList');
  ul.innerHTML = recs.slice(0, 60).map((r) => `<li>@${esc(r.handle)}</li>`).join('') + (recs.length > 60 ? `<li>+${recs.length - 60} more</li>` : '');
  $('confirmOk').disabled = left === 0;
  if (left === 0) $('confirmBody').textContent = `You've hit today's cap of ${S.settings.dailyCap}. Try again later, or raise the cap in Settings.`;
  const dlg = $('confirmDlg');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', () => { if (dlg.returnValue === 'ok') startUnfollow(recs); }, { once: true });
}

async function startUnfollow(recs) {
  if (S.job) return;
  // Unfollow the quietest first so a capped run removes the deadest accounts.
  const quiet = (r) => (r.unavailable ? -3 : r.never ? -2 : r.lastPostAt ?? Infinity);
  recs.sort((a, b) => quiet(a) - quiet(b));
  S.job = 'unfollow';
  S.client = newClient();
  render();
  showProgress('Unfollowing…', 0, recs.length);
  log(`Unfollow queue started: ${recs.length} accounts.`);
  try {
    const { done, failed } = await runUnfollow(S.client, store, recs, {
      settings: S.settings,
      log,
      onProgress: ({ done, failed, total, last, ok }) => {
        showProgress(`Unfollowing… ${failed ? `(${failed} failed)` : ''}`, done + failed, total);
        if (last && ok) {
          S.selected.delete(last.id);
          delete S.accounts[last.id];
          log(`Unfollowed @${last.handle}`, 'ok');
        }
      },
    });
    log(`Done: ${done} unfollowed${failed ? `, ${failed} failed` : ''}.`, 'ok');
  } catch (e) {
    if (e instanceof Cancelled) log('Unfollow queue stopped.', 'warn');
    else log(e.message || String(e), 'error');
  }
  S.accounts = await store.accounts();
  endJob();
}

// ---------- export + settings ----------

function exportCSV() {
  const rows = visible();
  const blob = new Blob([toCSV(rows.length ? rows : list())], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `prune-${S.meta.handle || 'following'}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function openSettings() {
  const f = $('settingsForm');
  for (const [k, v] of Object.entries(S.settings)) {
    const el = f.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
  }
  const dlg = $('settingsDlg');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    if (dlg.returnValue !== 'save') return;
    const next = { ...S.settings };
    for (const k of Object.keys(S.settings)) {
      const el = f.elements[k];
      if (!el) continue;
      next[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    if (next.maxDelaySec < next.minDelaySec) next.maxDelaySec = next.minDelaySec;
    if (next.countReposts !== S.settings.countReposts) log('Repost setting changed. Rescan to re-sort accounts.', 'warn');
    S.settings = next;
    await store.saveSettings(next);
    renderActionbar();
  }, { once: true });
}

// Exposed for debugging from DevTools.
window.prune = { S, daysSince };
