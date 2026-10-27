import { BUCKETS, bucketOf, daysSince, relTime, toCSV, pruneRank, tierOf, reasonFor } from './lib/parse.js';
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
  view: 'swipe',         // 'swipe' | 'list'
  skipped: [],           // ids pushed to the back of the deck this session
  history: [],           // swipe decisions, for undo
};

// ---------- boot ----------

init();

async function init() {
  S.settings = await store.settings();
  S.accounts = await store.accounts();
  S.meta = await store.meta();
  for (const id of await store.queue()) if (S.accounts[id]) S.selected.add(id);
  try { S.view = localStorage.getItem('prune.view') || 'swipe'; } catch {}
  bind();
  bindSwipe();
  $('protectMutuals').checked = S.settings.protectMutuals;
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
  $('protectMutuals').onchange = async (e) => {
    S.settings = { ...S.settings, protectMutuals: e.target.checked };
    await store.saveSettings(S.settings);
    if (S.settings.protectMutuals) for (const id of [...S.selected]) if (S.accounts[id]?.followsYou) S.selected.delete(id);
    renderRows();
  };
  $('selectAll').onchange = (e) => {
    const list = visible().filter(selectable);
    if (e.target.checked) list.forEach((r) => S.selected.add(r.id));
    else list.forEach((r) => S.selected.delete(r.id));
    renderRows();
  };
  $('pasteBtn').onclick = () => { $('pasteResult').textContent = ''; $('pasteDlg').showModal(); };
  $('pasteOk').onclick = (e) => { e.preventDefault(); selectFromText($('pasteText').value); };
  $('moreBtn').onclick = () => { S.shown += PAGE; renderRows(); };
  $('clearSel').onclick = () => { S.selected.clear(); renderRows(); if (S.view === 'swipe') renderDeck(); };
  $('reviewSel').onclick = () => { if (S.view === 'swipe') { S.view = 'list'; S.onlySelected = false; render(); } S.filter.clear(); S.shown = PAGE; $('search').value = ''; S.onlySelected = !S.onlySelected; $('reviewSel').textContent = S.onlySelected ? 'Show all' : 'Review'; renderRows(); };
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

/** Kept accounts, and mutuals while "Protect mutuals" is on, can never be queued. */
function isProtected(r) { return Boolean(r.keep || (S.settings.protectMutuals && r.followsYou)); }
function selectable(r) { return !isProtected(r); }

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
  const swipe = has && S.view === 'swipe';
  document.body.classList.toggle('swiping', swipe);
  $('viewSeg').hidden = !has;
  for (const b of $('viewSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.view === S.view);
  $('swipe').hidden = !swipe;
  $('buckets').hidden = !has || swipe;
  $('toolbar').hidden = !has || swipe;
  $('tableWrap').hidden = !has || swipe;
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
  if (swipe) renderDeck();
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
    if (S.onlySelected && !S.selected.has(r.id)) return false;
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
    const locked = isProtected(r);
    li.className = 'row' + (S.selected.has(r.id) ? ' sel' : '') + (locked ? ' locked' : '');
    li.dataset.id = r.id;
    const tags = [
      r.followsYou ? `<span class="tag${S.settings.protectMutuals ? ' shield' : ''}">${S.settings.protectMutuals ? 'Mutual · protected' : 'Follows you'}</span>` : '',
      r.protected ? '<span class="tag">Private</span>' : '',
    ].join('');
    li.innerHTML = `
      <input type="checkbox" data-act="sel" ${S.selected.has(r.id) ? 'checked' : ''} ${locked ? 'disabled' : ''} aria-label="Select @${esc(r.handle)}" />
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
  const pickable = rows.filter(selectable);
  $('selectAll').checked = pickable.length > 0 && pickable.every((r) => S.selected.has(r.id));
  $('selectAll').disabled = pickable.length === 0;
  const skipped = rows.length - pickable.length;
  $('selectAllLabel').textContent = `Select all ${pickable.length.toLocaleString()} shown${skipped ? ` (${skipped.toLocaleString()} protected)` : ''}`;
  renderActionbar();
}

function renderActionbar() {
  // Drop selections that no longer exist (unfollowed, filtered by rescan).
  for (const id of S.selected) if (!S.accounts[id] || isProtected(S.accounts[id])) S.selected.delete(id);
  const n = S.selected.size;
  saveQueueSoon();
  $('actionbar').hidden = n === 0 || S.job === 'unfollow' || S.view === 'swipe';
  $('selCount').textContent = n.toLocaleString();
  $('selEta').textContent = n ? `· ${eta(n)}` : '';
}

let queueTimer = null;
function saveQueueSoon() {
  clearTimeout(queueTimer);
  queueTimer = setTimeout(() => store.saveQueue([...S.selected]), 300);
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
    if (cb.disabled) return;
    cb.checked = !cb.checked;
    cb.checked ? S.selected.add(id) : S.selected.delete(id);
    li.classList.toggle('sel', cb.checked);
    renderActionbar();
  }
}

// ---------- swipe ----------

function deckList() {
  const now = Date.now();
  const total = list().length;
  const skipped = new Set(S.skipped);
  const main = list()
    .filter((r) => !r.keep && !S.selected.has(r.id) && !isProtected(r) && !skipped.has(r.id))
    .map((r) => [r, pruneRank(r, { total, now })])
    .sort((a, b) => b[1] - a[1])
    .map(([r]) => r);
  const later = S.skipped.map((id) => S.accounts[id]).filter((r) => r && !r.keep && !S.selected.has(r.id) && !isProtected(r));
  const out = main.concat(later);
  if (S.front) {
    const i = out.findIndex((r) => r.id === S.front);
    if (i > 0) out.unshift(out.splice(i, 1)[0]);
  }
  return out;
}

const TIER_LABEL = { 1: 'Tier 1 · Dead', 2: 'Tier 2 · Fading', 3: 'Tier 3 · Active' };

function cardHTML(r, now) {
  const b = bucketOf(r, now);
  const last = r.unavailable ? 'Gone' : r.never ? 'Never' : r.lastPostAt ? relTime(r.lastPostAt, now) : '—';
  const post = r.lastPostText
    ? `<div class="card-post"><small>${r.lastPostIsRepost ? 'Latest repost' : 'Latest post'}</small>${esc(r.lastPostText)}</div>`
    : '<div class="card-post"><small>Latest post</small>Nothing to show.</div>';
  return `
    <div class="stamp keep">KEEP</div><div class="stamp nope">UNFOLLOW</div>
    <div class="card-head">
      ${r.avatar ? `<img class="card-avatar" src="${esc(r.avatar.replace('_normal.', '_200x200.'))}" alt="" draggable="false" referrerpolicy="no-referrer" />` : '<span class="card-avatar"></span>'}
      <div style="min-width:0">
        <div class="card-name">${esc(r.name)}</div>
        <div class="card-handle">@${esc(r.handle)}${r.verified ? ' · verified' : ''}${r.protected ? ' · private' : ''}</div>
      </div>
    </div>
    <div class="card-stats">
      <div><b>${last}</b><span>Last post</span></div>
      <div><b>${fmtNum(r.followers) || '—'}</b><span>Followers</span></div>
      <div><b>${fmtNum(r.statuses) || '—'}</b><span>Posts</span></div>
    </div>
    <div class="card-reason"><i class="dot" style="background:var(--b-${b})"></i>${esc(reasonFor(r, now))}</div>
    ${r.bio ? `<p class="card-bio">${esc(r.bio)}</p>` : ''}
    ${post}
    <div class="card-foot">
      <span class="muted">${r.followsYou ? 'Follows you' : 'Doesn’t follow you'}</span>
      <a href="https://x.com/${encodeURIComponent(r.handle)}" target="_blank" rel="noopener">Open on X ↗</a>
    </div>`;
}

function renderDeck() {
  const now = Date.now();
  const deck = deckList();
  const el = $('deck');
  const top = deck[0];
  const q = S.selected.size;
  $('swipeCount').textContent = `${deck.length.toLocaleString()} left`;
  $('swipeGo').hidden = $('swipeReview').hidden = q === 0 || Boolean(S.job);
  $('swipeGo').textContent = `Unfollow ${q.toLocaleString()}`;
  document.body.classList.toggle('swiping', true);
  if (top) {
    const t = tierOf(top, now);
    $('swipeTier').innerHTML = `<i class="dot" style="background:var(--b-${bucketOf(top, now)})"></i>${TIER_LABEL[t]}`;
  } else {
    $('swipeTier').textContent = '';
  }
  el.replaceChildren();
  if (!top) {
    const n = S.selected.size;
    el.innerHTML = `<div class="deck-empty"><div><b>You've been through everyone.</b>${n ? `${n.toLocaleString()} queued to unfollow.<br><br><button class="primary danger-fill" id="deckGo">Unfollow ${n.toLocaleString()}</button>` : 'Nothing queued.'}</div></div>`;
    const go = document.getElementById('deckGo');
    if (go) go.onclick = () => confirmUnfollow();
    return;
  }
  deck.slice(0, 3).reverse().forEach((r, i, arr) => {
    const depth = arr.length - 1 - i; // 0 = top
    const card = document.createElement('article');
    card.className = 'card' + (depth ? ` under-${depth}` : '');
    card.dataset.id = r.id;
    card.innerHTML = cardHTML(r, now);
    el.appendChild(card);
    if (!depth) attachDrag(card);
  });
}

function attachDrag(card) {
  let sx = 0, sy = 0, dx = 0, dy = 0, dragging = false, pid = null;
  const keep = card.querySelector('.stamp.keep');
  const nope = card.querySelector('.stamp.nope');
  const paint = () => {
    card.style.transform = `translate(${dx}px, ${dy * 0.4}px) rotate(${dx / 18}deg)`;
    keep.style.opacity = Math.max(0, Math.min(1, dx / 110));
    nope.style.opacity = Math.max(0, Math.min(1, -dx / 110));
  };
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('a') || e.button !== 0) return;
    dragging = true; pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = dy = 0;
    card.setPointerCapture(pid);
    card.classList.add('dragging');
  });
  card.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dx = e.clientX - sx; dy = e.clientY - sy;
    paint();
  });
  const end = (e) => {
    if (!dragging || e.pointerId !== pid) return;
    dragging = false;
    card.classList.remove('dragging');
    if (dx > 110) decide('keep');
    else if (dx < -110) decide('unfollow');
    else if (dy > 140) decide('later');
    else { dx = dy = 0; card.style.transform = ''; keep.style.opacity = nope.style.opacity = 0; }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

let deciding = false;
async function decide(dir) {
  if (deciding || S.job) return;
  const card = $('deck').querySelector('.card:not([class*="under"])');
  if (!card) return;
  const r = S.accounts[card.dataset.id];
  if (!r) return;
  deciding = true;
  // fly out
  const x = dir === 'keep' ? 1 : dir === 'unfollow' ? -1 : 0;
  card.style.transform = x ? `translate(${x * 700}px, -40px) rotate(${x * 28}deg)` : 'translate(0, 600px)';
  card.style.opacity = '0';
  const stamp = card.querySelector(dir === 'keep' ? '.stamp.keep' : '.stamp.nope');
  if (x && stamp) stamp.style.opacity = 1;
  if (S.front === r.id) S.front = null;
  S.history.push({ id: r.id, dir, prevKeep: r.keep });
  if (S.history.length > 200) S.history.shift();
  if (dir === 'keep') { r.keep = true; await store.saveAccounts(S.accounts); }
  else if (dir === 'unfollow') S.selected.add(r.id);
  else S.skipped.push(r.id);
  saveQueueSoon();
  setTimeout(() => { deciding = false; renderDeck(); }, 230);
}

async function undo() {
  const h = S.history.pop();
  if (!h) return;
  const r = S.accounts[h.id];
  if (!r) return;
  if (h.dir === 'keep') { r.keep = h.prevKeep; await store.saveAccounts(S.accounts); }
  else if (h.dir === 'unfollow') S.selected.delete(h.id);
  else S.skipped = S.skipped.filter((id) => id !== h.id);
  // bring it back to the front
  S.skipped = S.skipped.filter((id) => id !== h.id);
  S.front = h.id;
  saveQueueSoon();
  renderDeck();
}

function bindSwipe() {
  for (const b of $('viewSeg').querySelectorAll('button')) {
    b.onclick = () => {
      S.view = b.dataset.view;
      try { localStorage.setItem('prune.view', S.view); } catch {}
      S.onlySelected = false;
      $('reviewSel').textContent = 'Review';
      render();
    };
  }
  $('nopeBtn').onclick = () => decide('unfollow');
  $('likeBtn').onclick = () => decide('keep');
  $('skipBtn').onclick = () => decide('later');
  $('undoBtn').onclick = undo;
  $('swipeGo').onclick = () => confirmUnfollow();
  $('swipeReview').onclick = () => { S.view = 'list'; S.onlySelected = true; $('reviewSel').textContent = 'Show all'; S.filter.clear(); S.shown = PAGE; render(); };
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'swipe' || $('swipe').hidden) return;
    if (document.querySelector('dialog[open]') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); decide('unfollow'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); decide('keep'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); decide('later'); }
    else if (e.key === 'z' || e.key === 'Z' || (e.key === 'Backspace')) { e.preventDefault(); undo(); }
  });
}

/** Select accounts named in pasted text: @handles, x.com links, or a CSV with a handle column. */
function selectFromText(text) {
  const byHandle = new Map(list().map((r) => [r.handle.toLowerCase(), r]));
  const wanted = new Set();
  for (const m of text.matchAll(/(?:(?:x|twitter)\.com\/|@|^|[\s,;"'\t])([A-Za-z0-9_]{1,15})(?=$|[\s,;"'\t/?])/gm)) wanted.add(m[1].toLowerCase());
  let picked = 0, guarded = 0;
  for (const h of wanted) {
    const r = byHandle.get(h);
    if (!r) continue;
    if (isProtected(r)) { guarded++; continue; }
    if (!S.selected.has(r.id)) { S.selected.add(r.id); picked++; }
  }
  const matched = picked + guarded;
  $('pasteResult').textContent = matched
    ? `Selected ${picked.toLocaleString()}${guarded ? `, skipped ${guarded} kept or mutual` : ''}. ${S.selected.size.toLocaleString()} selected in total.`
    : 'No accounts you follow matched.';
  if (picked) { S.filter.clear(); S.shown = PAGE; renderBuckets(); renderRows(); }
  if (picked) log(`Selected ${picked} accounts from a pasted list.`);
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
  const recs = [...S.selected].map((id) => S.accounts[id]).filter((r) => r && selectable(r));
  if (!recs.length) return;
  const history = await store.log();
  const left = Math.max(0, S.settings.dailyCap - unfollowsInLastDay(history));
  const today = Math.min(left, recs.length);
  const mutuals = recs.filter((r) => r.followsYou).length;
  $('confirmTitle').textContent = `Unfollow ${recs.length.toLocaleString()} account${recs.length === 1 ? '' : 's'}?`;
  $('confirmBody').textContent =
    `${today.toLocaleString()} will go now (${eta(today)}), ${left < recs.length ? `the rest after your ${S.settings.dailyCap}/day cap resets. Run the queue again tomorrow for those. ` : ''}` +
    `${mutuals ? `${mutuals} of them follow you back. ` : S.settings.protectMutuals ? 'Mutuals are protected and skipped. ' : ''}Keep this tab open while it runs. This can't be undone in bulk.`;
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
    $('protectMutuals').checked = next.protectMutuals;
    if (next.countReposts !== S.settings.countReposts) log('Repost setting changed. Rescan to re-sort accounts.', 'warn');
    S.settings = next;
    await store.saveSettings(next);
    renderRows();
  }, { once: true });
}

// Exposed for debugging from DevTools.
window.prune = { S, daysSince };
