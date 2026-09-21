/* =====================================================================
   app.js - state, hash router, websocket, sidebar navigation, topbar

   Live data never rebuilds DOM: the topbar chips and the sidebar counters
   are patched in place (setText/setCls), the navigation tree is only
   re-rendered when its structure (plants / lines) actually changes.
   ===================================================================== */
const S = {
  me: null, meta: null, tree: null,
  meters: new Map(),      // id -> meter view (from /api/meters), values patched live
  summary: null,
  ws: null, wsOpen: false, scope: null,
  view: null, route: null,
  openPlants: new Set((() => { try { return JSON.parse(localStorage.getItem('pc-open-plants') || '[]'); } catch (e) { return []; } })()),
  history: new Map(),     // meterId -> last 40 p_total values (sparklines)
  navSig: '',             // structural signature of the rendered sidebar
};

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const [me, meta] = await Promise.all([api('/api/me'), api('/api/meta')]);
    S.me = me; S.meta = meta;
    document.title = me.site.name;
    $('#siteName').textContent = me.site.name;
    $('#siteSubtitle').textContent = me.site.subtitle;
    $('#whoName').textContent = me.user.displayName || me.user.username;
    $('#whoRole').textContent = me.user.role;
    $('#avatar').textContent = (me.user.displayName || me.user.username).slice(0, 2).toUpperCase();
    await refreshAll();
    connectWs();
    window.addEventListener('hashchange', navigate);
    navigate();
    setInterval(() => refreshAll().catch(() => {}), 30000);
    setInterval(tickClock, 1000);
    tickClock();
  } catch (e) {
    $('#view').innerHTML = `<div class="content"><div class="empty">Failed to load: ${esc(e.message)}</div></div>`;
  }
}

async function refreshAll() {
  const [tree, meters] = await Promise.all([api('/api/tree'), api('/api/meters')]);
  S.tree = tree;
  for (const m of meters.meters) {
    const cur = S.meters.get(m.id);
    // keep the live object identity (views hold references); refresh static fields
    if (cur) {
      const live = { values: cur.values, at: cur.at, status: cur.status, alarm: cur.alarm, alarms: cur.alarms, lastError: cur.lastError, latencyMs: cur.latencyMs, lastOk: cur.lastOk };
      Object.assign(cur, m, cur.at && cur.at > (m.at || 0) ? live : {});
    } else S.meters.set(m.id, m);
  }
  for (const id of [...S.meters.keys()]) if (!meters.meters.some((m) => m.id === id)) S.meters.delete(id);
  renderNav();
}

async function refreshTree() {
  try { S.tree = await api('/api/tree'); renderNav(); } catch (e) { /* keep old */ }
}

function tickClock() {
  setText($('#clock'), new Date().toLocaleTimeString('en-GB', { hour12: false }));
}

/* ---------------- websocket ---------------- */
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { S.wsOpen = true; setCls($('#liveDot'), 'live-dot on'); if (S.scope) sendSub(S.scope); };
  ws.onclose = () => { S.wsOpen = false; setCls($('#liveDot'), 'live-dot off'); setTimeout(connectWs, 3000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handleWs(msg);
  };
}

function sendSub(scope) {
  S.scope = scope;
  if (S.wsOpen) S.ws.send(JSON.stringify({ type: 'sub', scope }));
}

function handleWs(msg) {
  if (msg.type === 'reading') {
    const m = S.meters.get(msg.meterId);
    if (m) {
      m.values = msg.values; m.at = msg.at; m.status = msg.status; m.alarm = msg.alarm; m.alarms = msg.alarms; m.lastError = msg.lastError; m.latencyMs = msg.latencyMs;
      if (msg.status === 'ok') m.lastOk = msg.at;
      if (msg.status === 'ok' && Number.isFinite(msg.values.p_total)) {
        const h = S.history.get(msg.meterId) || [];
        h.push(msg.values.p_total); if (h.length > 40) h.shift();
        S.history.set(msg.meterId, h);
      }
    }
    if (S.view && S.view.onReading) S.view.onReading(msg, m);
  } else if (msg.type === 'summary') {
    S.summary = msg;
    renderChips();
    patchNavCounts();
    if (S.view && S.view.onSummary) S.view.onSummary(msg);
  } else if (msg.type === 'event') {
    onEventMsg(msg);
    if (S.view && S.view.onEvent) S.view.onEvent(msg);
  } else if (msg.type === 'gateway' || msg.type === 'gateways') {
    if (S.view && S.view.onGateways) S.view.onGateways(msg);
  } else if (msg.type === 'demand') {
    if (S.view && S.view.onDemand) S.view.onDemand(msg.groups);
  }
}

function onEventMsg(msg) {
  const e = msg.event;
  if (msg.action === 'open' && (e.severity === 'critical' || e.severity === 'error')) {
    toast(`${e.meterName || e.gatewayName || ''}: ${e.message}`, e.severity === 'critical' ? 'err' : 'warn', SEV_LABEL[e.severity] + ' - ' + typeLabel(e.type));
  }
  if (msg.action === 'close' && e.type === 'outage') toast(`${e.meterName}: power restored`, 'ok', 'Outage ended');
  if (msg.action !== 'update') refreshTree();
}

/* ---------------- topbar ---------------- */
function renderChips() {
  const s = S.summary;
  if (!s) return;
  const al = s.alarms;
  const box = $('#sumChips');
  if (!box.firstElementChild) {
    box.innerHTML = `
      <span class="chip accent" id="chipKw" title="Total active power of online meters">${icon('bolt')} <b>-</b><span>kW</span></span>
      <span class="chip click" id="chipMeters" onclick="location.hash='#/gateways'" title="Meters online / total"><span>Meters</span> <b>-</b></span>
      <span class="chip click" id="chipAlarms" onclick="location.hash='#/alarms'" title="Open alarms">${icon('bell')} <b>-</b><span class="muted"></span></span>
      <span class="chip click" id="chipGw" onclick="location.hash='#/gateways'" title="Gateways connected"><span>GW</span> <b>-</b></span>`;
  }
  setNum($('#chipKw b'), s.kwTotal, (x) => fmtNum(x, 1));
  setCls($('#chipMeters'), `chip click ${s.meters.offline ? 'warn' : 'ok'}`);
  setText($('#chipMeters b'), `${s.meters.online}/${s.meters.total}`);
  setCls($('#chipAlarms'), `chip click ${al.critical ? 'crit' : al.error ? 'err' : al.warn ? 'warn' : ''}`);
  setText($('#chipAlarms b'), al.total);
  setText($('#chipAlarms .muted'), al.unacked ? `(${al.unacked} new)` : '');
  const gwOk = s.gateways.filter((g) => g.connected).length;
  setCls($('#chipGw'), `chip click ${gwOk < s.gateways.length ? 'err' : 'ok'}`);
  setText($('#chipGw b'), `${gwOk}/${s.gateways.length}`);
}

function setCrumbs(parts) {
  $('#crumbs').innerHTML = parts.map((p, i) => (i === parts.length - 1
    ? `<span class="cur">${esc(p.label)}</span>`
    : `<a href="${p.href}">${esc(p.label)}</a><span class="sep">/</span>`)).join('');
}

/* ---------------- sidebar ---------------- */
const lineState = (l) => (l.alarms ? (l.online < l.meters ? 'bad' : 'warn') : l.meters && l.online === l.meters ? 'ok' : l.meters ? 'bad' : '');

// Structure changes (plants / lines / search / route / open state) rebuild the
// tree; counters are patched in place by patchNavCounts().
function renderNav() {
  const t = S.tree;
  if (!t) return;
  const q = ($('#navSearch').value || '').trim().toLowerCase();
  const r = S.route || {};
  const sig = JSON.stringify([q, r.name, r.id, [...S.openPlants], S.me.can.admin, t.unassigned.meters > 0,
    t.plants.map((p) => [p.id, p.name, p.lines.map((l) => [l.id, l.name])])]);
  if (sig === S.navSig) { patchNavCounts(); return; }
  S.navSig = sig;
  const plants = t.plants.map((p) => {
    const lines = p.lines.filter((l) => !q || l.name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
    if (q && !lines.length && !p.name.toLowerCase().includes(q)) return '';
    const open = q ? true : S.openPlants.has(String(p.id));
    return `<div class="nav-plant ${open ? 'open' : ''}" data-plant="${p.id}">
      <div class="nav-item ${r.name === 'plant' && r.id === p.id ? 'active' : ''}" onclick="togglePlant(${p.id}, event)">
        ${icon('chev', 'chev')}${icon('factory')}<span>${esc(p.name)}</span>
        <span class="cnt" data-plant-cnt="${p.id}"></span>
      </div>
      <div class="nav-lines">
        ${lines.map((l) => `<div class="nav-item nav-line ${r.name === 'line' && r.id === l.id ? 'active' : ''}" data-line="${l.id}" onclick="location.hash='#/line/${l.id}'">
          <i class="st"></i><span>${esc(l.name)}</span><span class="cnt"></span></div>`).join('')}
        ${!lines.length ? '<div class="nav-item nav-line muted"><span>no lines yet</span></div>' : ''}
      </div></div>`;
  }).join('');
  const isAdmin = S.me.can.admin;
  $('#nav').innerHTML = `
    <div class="nav-sec">Plants</div>${plants || '<div class="nav-item muted"><span>no match</span></div>'}
    ${t.unassigned.meters ? `<div class="nav-item ${r.name === 'unassigned' ? 'active' : ''}" onclick="location.hash='#/unassigned'">${icon('layers')}<span>Unassigned meters</span><span class="cnt" id="navUnassigned"></span></div>` : ''}
    <div class="nav-sec">Monitor</div>
    <div class="nav-item ${r.name === 'overview' ? 'active' : ''}" onclick="location.hash='#/'">${icon('grid')}<span>Overview</span></div>
    <div class="nav-item ${r.name === 'gateways' ? 'active' : ''}" onclick="location.hash='#/gateways'">${icon('router')}<span>Gateways</span><span class="cnt" id="navGw"></span></div>
    <div class="nav-item ${r.name === 'alarms' ? 'active' : ''}" onclick="location.hash='#/alarms'">${icon('bell')}<span>Alarms</span><span class="cnt" id="navAlarms"></span></div>
    <div class="nav-item ${r.name === 'demand' ? 'active' : ''}" onclick="location.hash='#/demand'">${icon('trend')}<span>Peak demand</span><span class="cnt" id="navDemand"></span></div>
    <div class="nav-item ${r.name === 'export' ? 'active' : ''}" onclick="location.hash='#/export'">${icon('download')}<span>Export</span></div>
    ${isAdmin ? `<div class="nav-sec">Admin</div>
    <div class="nav-item ${r.name === 'settings' ? 'active' : ''}" onclick="location.hash='#/settings/structure'">${icon('settings')}<span>Settings</span></div>
    <div class="nav-item ${r.name === 'api' ? 'active' : ''}" onclick="location.hash='#/api'">${icon('book')}<span>API</span></div>` : ''}`;
  patchNavCounts();
}

function patchNavCounts() {
  const t = S.tree;
  if (!t) return;
  for (const p of t.plants) {
    const c = $(`[data-plant-cnt="${p.id}"]`);
    if (c) { setText(c, `${p.online}/${p.meters}${p.alarms ? ' !' + p.alarms : ''}`); setCls(c, `cnt ${p.alarms ? 'al' : ''}`); }
    for (const l of p.lines) {
      const row = $(`.nav-line[data-line="${l.id}"]`);
      if (!row) continue;
      setCls($('.st', row), `st ${lineState(l)}`);
      setText($('.cnt', row), `${l.online}/${l.meters}`);
      setCls($('.cnt', row), `cnt ${l.alarms ? 'al' : ''}`);
    }
  }
  setText($('#navUnassigned'), `${t.unassigned.online}/${t.unassigned.meters}`);
  if (S.summary) {
    const gwOk = S.summary.gateways.filter((g) => g.connected).length;
    setText($('#navGw'), `${gwOk}/${S.summary.gateways.length}`);
    setCls($('#navGw'), `cnt ${gwOk < S.summary.gateways.length ? 'bad' : ''}`);
    setText($('#navAlarms'), S.summary.alarms.total || '');
    setCls($('#navAlarms'), `cnt ${S.summary.alarms.total ? 'al' : ''}`);
    const dm = S.summary.demand;
    if (dm) {
      setText($('#navDemand'), dm.groups ? (dm.shedding ? `${dm.shedding} shed` : dm.worst === 'ok' ? 'ok' : dm.worst) : '');
      setCls($('#navDemand'), `cnt ${['critical', 'exceeded'].includes(dm.worst) ? 'bad' : dm.worst === 'warn' || dm.shedding ? 'al' : ''}`);
    }
  }
}

function togglePlant(id, ev) {
  const key = String(id);
  const el = ev.target.closest('.nav-plant');
  const wasOpen = el.classList.contains('open');
  // click on an already-open plant collapses it; otherwise open it and navigate
  if (wasOpen && S.route && S.route.name === 'plant' && S.route.id === id) {
    S.openPlants.delete(key); el.classList.remove('open');
  } else {
    S.openPlants.add(key); el.classList.add('open');
    location.hash = '#/plant/' + id;
  }
  try { localStorage.setItem('pc-open-plants', JSON.stringify([...S.openPlants])); } catch (e) { /* private mode */ }
  S.navSig = '';
}

/* ---------------- router ---------------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  const parts = h.split('/').filter(Boolean);
  if (!parts.length) return { name: 'overview' };
  const id = parts[1] ? Number(parts[1]) : null;
  switch (parts[0]) {
    case 'plant': return { name: 'plant', id };
    case 'line': return { name: 'line', id };
    case 'meter': return { name: 'meter', id, tab: parts[2] || null };
    case 'gateways': return { name: 'gateways', id };
    case 'alarms': return { name: 'alarms' };
    case 'demand': return { name: 'demand', id };
    case 'export': return { name: 'export' };
    case 'unassigned': return { name: 'unassigned' };
    case 'settings': return { name: 'settings', tab: parts[1] || 'structure' };
    case 'api': return { name: 'api' };
    default: return { name: 'overview' };
  }
}

function navigate() {
  const r = parseRoute();
  if (S.view && S.view.destroy) S.view.destroy();
  S.view = null;
  S.route = r;
  closeMenu();
  modal.close();
  const el = $('#view');
  el.scrollTop = 0;
  window.scrollTo(0, 0);
  const factory = {
    overview: () => Views.overview(),
    plant: () => Views.plant(r.id),
    line: () => Views.line(r.id),
    unassigned: () => Views.line(null),
    meter: () => Views.meter(r.id, r.tab),
    gateways: () => Views.gateways(r.id),
    alarms: () => Views.alarms(),
    demand: () => Views.demand(r.id),
    export: () => Views.exporter(),
    settings: () => (S.me.can.admin ? Settings.page(r.tab) : Views.overview()),
    api: () => Views.apiDocs(),
  }[r.name];
  const view = factory();
  S.view = view;
  el.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'content';
  el.appendChild(wrap);
  Promise.resolve(view.mount(wrap)).catch((e) => { wrap.innerHTML = `<div class="empty">Failed to load: ${esc(e.message)}</div>`; console.error(e); });
  sendSub(view.scope || { all: true });
  renderNav();
  if ($('#app').classList.contains('expanded') && innerWidth <= 720) $('#app').classList.remove('expanded');
}

/* ---------------- theme ---------------- */
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'; }
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('pc-theme', t); } catch (e) { /* private mode */ }
  const b = $('#themeBtn');
  if (b) b.innerHTML = icon(t === 'light' ? 'moon' : 'sun');
  if (window.Charts && Charts.refresh) Charts.refresh();
}
function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  // charts and sparklines carry theme colours in their canvases: rebuild the page
  navigate();
}

/* ---------------- shell events ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  $('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; };
  $('#menuBtn').onclick = () => {
    const app = $('#app');
    if (innerWidth <= 1100) app.classList.toggle('expanded'); else app.classList.toggle('collapsed');
  };
  $('#navSearch').addEventListener('input', renderNav);
  $('#themeBtn').onclick = toggleTheme;
  applyTheme(currentTheme());
  boot();
});
