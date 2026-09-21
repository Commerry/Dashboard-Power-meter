/* =====================================================================
   ui.js - small helpers shared by every view (no framework, no build step)
   ===================================================================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = '') => `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;

const fmtNum = (v, d = 1) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
const fmtAgo = (ms) => {
  if (!ms) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 60) return sec + 's ago';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
  return Math.floor(sec / 86400) + 'd ago';
};
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { hour12: false }) : '-');
const fmtTimeShort = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour12: false }) : '-');
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB') : '-');
const fmtDur = (sec) => {
  if (!Number.isFinite(sec)) return '-';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd ' + Math.floor((sec % 86400) / 3600) + 'h';
};
const fmtBytes = (b) => {
  if (!Number.isFinite(b)) return '-';
  if (b < 1024) return Math.round(b) + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
};
const fmtRate = (bps) => (Number.isFinite(bps) ? fmtBytes(bps) + '/s' : '-');

// datetime-local <-> ms
const toLocalInput = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null; };

// ---- in-place DOM patching (never rebuild what only needs a new number) ----
const setText = (el, text) => {
  if (!el) return;
  const s = String(text);
  const t = el.firstChild;
  if (t && t.nodeType === 3 && !t.nextSibling) { if (t.nodeValue !== s) t.nodeValue = s; return; }
  if (el.textContent !== s) el.textContent = s;
};
const setHtml = (el, html) => { if (el && el.innerHTML !== html) el.innerHTML = html; };
const setCls = (el, cls) => {
  if (!el) return;
  if (el instanceof SVGElement) { if (el.getAttribute('class') !== cls) el.setAttribute('class', cls); return; }
  if (el.className !== cls) el.className = cls;
};
const setStyle = (el, prop, value) => { if (el && el.style[prop] !== value) el.style[prop] = value; };
// value + unit inside one node: <b>12.3</b><small>kW</small> -> patches both without recreating them
const setVal = (el, text, unit) => {
  if (!el) return;
  const t = el.firstChild;
  if (!t || t.nodeType !== 3) { el.innerHTML = `${esc(text)}${unit !== undefined ? `<small>${esc(unit)}</small>` : ''}`; return; }
  if (t.nodeValue !== String(text)) t.nodeValue = String(text);
  if (unit !== undefined) { const u = el.querySelector('small'); if (u) setText(u, unit); else el.insertAdjacentHTML('beforeend', `<small>${esc(unit)}</small>`); }
};

// ---- smooth numeric updates ----
// A number rolls from the value it showed to the new one (~450 ms, ease-out)
// instead of jumping. Only the text changes - the node itself is never rebuilt,
// so the frame stays still. First paint, non-numbers, hidden tabs and users who
// prefer reduced motion get the value immediately.
const TWEEN_MS = 450;
const tweens = new Map();
let tweenRaf = 0;
const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const tweenStep = (now) => {
  tweenRaf = 0;
  for (const [el, t] of tweens) {
    const p = Math.min(1, (now - t.t0) / t.dur);
    const e = 1 - (1 - p) ** 3;
    t.cur = p >= 1 ? t.to : t.from + (t.to - t.from) * e;
    t.apply(t.cur);
    if (p >= 1 || !el.isConnected) tweens.delete(el);
  }
  if (tweens.size) tweenRaf = requestAnimationFrame(tweenStep);
};
/** Animate the number rendered by apply(v) on `el` from what it last showed to `value`. */
function tweenNum(el, value, apply, ms = TWEEN_MS) {
  if (!el) return;
  const running = tweens.get(el);
  const from = running ? running.cur : el._tv;
  el._tv = value;
  if (!Number.isFinite(value) || !Number.isFinite(from) || from === value || reduceMotion() || document.hidden) { tweens.delete(el); apply(value); return; }
  tweens.set(el, { from, to: value, cur: from, t0: performance.now(), dur: ms, apply });
  if (!tweenRaf) tweenRaf = requestAnimationFrame(tweenStep);
}
// text only:  <span>12.3</span>          fmt(v) -> string
const setNum = (el, value, fmt) => tweenNum(el, value, (v) => setText(el, fmt(v)));
// value + unit: <b>12.3<small>kW</small></b>
const setValNum = (el, value, fmt, unit) => tweenNum(el, value, (v) => setVal(el, fmt(v), unit));

// ---- fetch wrapper ----
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) { window.location.href = '/login'; throw new Error('unauthorized'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.success === false && !opts.allowFail) throw new Error(data.error || 'request failed');
  return data;
}

// ---- toasts ----
function toast(text, kind = '', title = '') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = (title ? `<b>${esc(title)}</b>` : '') + esc(text);
  box.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, kind === 'err' ? 6000 : 3500);
}

// ---- modal ----
const modal = {
  open(html, { wide = false, narrow = false, onClose = null } = {}) {
    const ov = $('#modal');
    const p = $('#modalPanel');
    p.className = 'panel' + (wide ? ' wide' : '') + (narrow ? ' narrow' : '');
    p.innerHTML = html;
    ov.classList.add('show');
    modal._onClose = onClose;
    return p;
  },
  close() {
    const ov = $('#modal');
    if (!ov.classList.contains('show')) return;
    ov.classList.remove('show');
    $('#modalPanel').innerHTML = '';
    if (modal._onClose) { const f = modal._onClose; modal._onClose = null; f(); }
  },
  head(title, sub = '', iconName = 'info') {
    return `<div class="panel-head">${icon(iconName, '')}<div><div class="panel-title">${esc(title)}</div>${sub ? `<div class="panel-sub">${esc(sub)}</div>` : ''}</div><button class="x-btn" onclick="modal.close()">${icon('x')}</button></div>`;
  },
};
document.addEventListener('DOMContentLoaded', () => {
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') modal.close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { modal.close(); closeMenu(); } });
});

function confirmDlg(text, { title = 'Confirm', ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    modal.open(`${modal.head(title, '', danger ? 'alert' : 'info')}
      <div style="font-size:.84rem;color:var(--text-2);line-height:1.7;white-space:pre-line">${esc(text)}</div>
      <div class="panel-foot"><button class="btn" id="cfNo">Cancel</button><button class="btn ${danger ? 'danger' : 'primary'} right" id="cfYes">${esc(ok)}</button></div>`, { narrow: true, onClose: () => resolve(false) });
    $('#cfNo').onclick = () => modal.close();
    $('#cfYes').onclick = () => { modal._onClose = null; modal.close(); resolve(true); };
  });
}

function promptDlg(title, { label = '', value = '', placeholder = '', ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    modal.open(`${modal.head(title, '', 'edit')}
      <div class="field"><label>${esc(label)}</label><input id="pdInput" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>
      <div class="panel-foot"><button class="btn" id="pdNo">Cancel</button><button class="btn primary right" id="pdYes">${esc(ok)}</button></div>`, { narrow: true, onClose: () => resolve(null) });
    const inp = $('#pdInput');
    inp.focus(); inp.select();
    const done = () => { const v = inp.value; modal._onClose = null; modal.close(); resolve(v); };
    $('#pdNo').onclick = () => modal.close();
    $('#pdYes').onclick = done;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
  });
}

// ---- context menu ----
function closeMenu() { const m = $('#ctxMenu'); if (m) m.remove(); }
function openMenu(ev, items, head = '') {
  closeMenu();
  ev.stopPropagation();
  const menu = document.createElement('div');
  menu.id = 'ctxMenu';
  menu.className = 'menu';
  menu.innerHTML = (head ? `<div class="mi-head">${esc(head)}</div>` : '') + items.map((it, i) => `<div class="mi ${it.danger ? 'danger' : ''}" data-i="${i}">${it.icon ? icon(it.icon) : ''} ${esc(it.label)}</div>`).join('');
  document.body.appendChild(menu);
  menu.addEventListener('click', (e) => {
    const mi = e.target.closest('.mi');
    if (!mi) return;
    closeMenu();
    items[Number(mi.dataset.i)].onClick();
  });
  const pad = 8;
  const rect = menu.getBoundingClientRect();
  let x = ev.clientX; let y = ev.clientY;
  if (x + rect.width > innerWidth - pad) x = innerWidth - rect.width - pad;
  if (y + rect.height > innerHeight - pad) y = innerHeight - rect.height - pad;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}

// ---- domain formatting ----
const SEV_LABEL = { info: 'INFO', warn: 'WARN', error: 'ERROR', critical: 'CRITICAL' };
const TYPE_LABEL = {
  outage: 'Outage', sag: 'Sag', swell: 'Swell', overload: 'Overload', overcurrent: 'Overcurrent', low_pf: 'Low PF',
  freq: 'Frequency', unbalance: 'Unbalance', thd: 'THD', offline: 'Offline', gateway: 'Gateway',
};
const typeLabel = (t) => (TYPE_LABEL[t] || (String(t).startsWith('tag:') ? 'Tag ' + String(t).slice(4) : String(t).startsWith('demand') ? { demand: 'Demand', demand_exceeded: 'Demand exceeded', demand_write: 'PLC write' }[t] || t : t));
const sevBadge = (sev, text) => (sev ? `<span class="badge ${sev}">${esc(text || SEV_LABEL[sev] || sev)}</span>` : '');
const sevCls = (sev) => (sev === 'critical' ? 'bad' : sev === 'error' ? 'bad' : sev === 'warn' ? 'warn' : '');

function metricOf(key) { return (typeof S !== 'undefined' && S.meta) ? S.meta.metrics.find((m) => m.key === key) || null : null; }
function fmtMetric(key, v) {
  const m = metricOf(key);
  if (!Number.isFinite(v)) return '-';
  return fmtNum(v, m ? m.decimals : 2);
}
function unitOf(key) { const m = metricOf(key); return m ? m.unit : ''; }

// LCD digits: ghost "888.88" (all segments, faint) sets the width, the real
// number sits right-aligned on top - the classic seven-segment look.
function lcdText(value, decimals, width) {
  if (!Number.isFinite(value)) return '-';
  let d = decimals;
  let txt = value.toFixed(d);
  const total = width + (decimals ? decimals + 1 : 0);
  while (txt.length > total && d > 0) { d -= 1; txt = value.toFixed(d); }
  return txt;
}
function lcdHtml(value, { decimals = 2, width = 4 } = {}) {
  const ghost = '8'.repeat(width) + (decimals ? '.' + '8'.repeat(decimals) : '');
  return `<span class="lcd" data-w="${width}" data-d="${decimals}"><span class="ghost">${ghost}</span><span class="num">${esc(lcdText(value, decimals, width))}</span></span>`;
}

// sparkline on a canvas (values: number[]; null gaps allowed)
function drawSpark(canvas, values, { color = '#ffb547', fill = true, min = null, max = null, width = 2 } = {}) {
  if (color === '#ffb547') color = (getComputedStyle(document.documentElement).getPropertyValue('--lcd-fg') || '#ffb547').trim() || '#ffb547';
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width; const h = canvas.clientHeight || canvas.height;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const xs = values.filter((v) => Number.isFinite(v));
  if (xs.length < 2) return;
  const lo = min !== null ? min : Math.min(...xs);
  const hi = max !== null ? max : Math.max(...xs);
  const span = hi - lo || 1;
  const n = values.length;
  const px = (i) => (i / (n - 1)) * (w - 2) + 1;
  const py = (v) => h - 2 - ((v - lo) / span) * (h - 4);
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) { started = false; return; }
    if (!started) { ctx.moveTo(px(i), py(v)); started = true; } else ctx.lineTo(px(i), py(v));
  });
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke();
  if (fill) {
    ctx.lineTo(px(n - 1), h); ctx.lineTo(px(0), h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
    ctx.fillStyle = g; ctx.fill();
  }
}

// arc gauge (semicircle) - pct 0..1
function gaugeSvg(pct, cls = '') {
  const r = 40; const c = Math.PI * r; // half circumference
  const p = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
  return `<svg class="gauge" viewBox="0 0 100 60"><path class="track" d="M10 55 A40 40 0 0 1 90 55" fill="none" stroke-width="9" stroke-linecap="round"/>
    <path class="arc ${cls}" d="M10 55 A40 40 0 0 1 90 55" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}"/></svg>`;
}

// range presets used by charts / exports / alarms
const RANGE_PRESETS = [
  { id: '1h', label: '1 h', ms: 3600000 }, { id: '6h', label: '6 h', ms: 6 * 3600000 }, { id: '24h', label: '24 h', ms: 86400000 },
  { id: '7d', label: '7 d', ms: 7 * 86400000 }, { id: '30d', label: '30 d', ms: 30 * 86400000 },
];
const autoInterval = (from, to) => {
  const span = to - from;
  if (span <= 3 * 3600000) return 'raw';
  if (span <= 12 * 3600000) return '60';
  if (span <= 2 * 86400000) return '300';
  if (span <= 10 * 86400000) return '900';
  if (span <= 60 * 86400000) return '3600';
  return '86400';
};
const intervalLabel = (i) => ({ raw: 'raw', 60: '1 min', 300: '5 min', 900: '15 min', 3600: '1 hour', 86400: '1 day' }[i] || i + 's');

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function downloadPost(url, body, fallbackName) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) { const d = await res.json(); throw new Error(d.error || 'export failed'); }
  const cd = res.headers.get('content-disposition') || '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/) || cd.match(/filename="([^"]+)"/);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  downloadBlob(await res.blob(), name);
  return name;
}

function copyText(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok')).catch(() => toast('Copy failed', 'err'));
}
