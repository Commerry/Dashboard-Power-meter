/* =====================================================================
   views.js - monitoring pages
   Each view returns { scope, mount(el), onReading?, onSummary?, onEvent?, onGateways?, destroy? }

   Rule for live data: the DOM is built once per page, then only text /
   class / style of the nodes that changed are patched (setText, setCls,
   setVal, setStyle). Nothing is re-created on a reading, so frames never
   flash and CSS animations never restart.
   ===================================================================== */
const Views = (() => {
  const plantOf = (id) => (S.tree ? S.tree.plants.find((p) => p.id === id) : null);
  const lineOf = (id) => { for (const p of (S.tree ? S.tree.plants : [])) { const l = p.lines.find((x) => x.id === id); if (l) return { ...l, plant: p }; } return null; };
  // metric metadata: canonical registry first, then the device's own tag list (custom keys, overrides)
  const metaOf = (m, k) => { const t = m && m.tags ? m.tags.find((x) => x.key === k) : null; if (t && (t.custom || t.label)) return { ...(metricOf(k) || {}), ...t }; return metricOf(k) || t || null; };
  const fmtV = (m, k, v) => { const mt = metaOf(m, k); return Number.isFinite(v) ? fmtNum(v, mt ? mt.decimals : 2) : '-'; };
  const unitV = (m, k) => { const mt = metaOf(m, k); return mt ? (mt.unit || '') : ''; };
  const customTags = (m) => (m.tags || []).filter((t) => t.custom);
  // tags carrying row/col form a matrix per group (e.g. shift / day / week x kW / kWh-RT)
  const matrixGroups = (m) => {
    const groups = new Map();
    for (const t of (m.tags || [])) {
      if (!t.row || !t.col) continue;
      if (!groups.has(t.group)) groups.set(t.group, { rows: [], cols: [], cells: {} });
      const g = groups.get(t.group);
      if (!g.rows.includes(t.row)) g.rows.push(t.row);
      if (!g.cols.includes(t.col)) g.cols.push(t.col);
      g.cells[t.row + '|' + t.col] = t;
    }
    return groups;
  };
  const matrixKeys = (m) => new Set((m.tags || []).filter((t) => t.row && t.col).map((t) => t.key));
  const matrixHtml = (m) => [...matrixGroups(m).entries()].map(([g, x]) => `<div class="vgroup matrix" style="grid-column:1/-1"><div class="vgroup-head">${icon('layers')} ${esc((S.meta.groups[g] || {}).label || g)}</div>
      <table class="matrix-table"><thead><tr><th></th>${x.cols.map((c) => `<th class="num">${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${x.rows.map((r) => `<tr><td class="rowlabel">${esc(r)}</td>${x.cols.map((c) => { const t = x.cells[r + '|' + c]; return t ? `<td class="num"><span class="mval" data-k="${t.key}">-</span><small>${esc(t.unit || '')}</small></td>` : '<td class="num muted">-</td>'; }).join('')}</tr>`).join('')}
      </tbody></table></div>`).join('');
  const plcStatusChip = (plc) => (!plc ? '' : `<span class="badge ${plc.status === 'RUN' ? 'ok' : plc.status === 'STOP' ? 'critical' : 'neutral'}">PLC ${esc(plc.status)}</span>`);
  const plcLine = (plc) => (!plc ? '' : [plc.cpu && plc.cpu.moduleType, plc.orderCode, plc.firmware, plc.cpu && plc.cpu.serial ? 'S/N ' + plc.cpu.serial : null, plc.pduLength ? 'PDU ' + plc.pduLength : null, plc.clockDriftSec !== null && plc.clockDriftSec !== undefined ? 'clock ' + (plc.clockDriftSec >= 0 ? '+' : '') + plc.clockDriftSec + ' s' : null, plc.blocks ? `OB ${plc.blocks.OB} · FB ${plc.blocks.FB} · FC ${plc.blocks.FC} · DB ${plc.blocks.DB}` : null].filter(Boolean).join(' · '));
  const metersOfLine = (lineId) => [...S.meters.values()].filter((m) => (lineId ? m.lineId === lineId : !m.lineId)).sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name));

  // KPI tile: markup once, values patched through data-kpi
  const kpi = (key, label, value, { unit = '', cls = '', sub = '', iconName = '', tone = '' } = {}) => `
    <div class="kpi ${tone}" data-kpi="${key}"><div class="kpi-label">${iconName ? icon(iconName) : ''}${esc(label)}</div>
    <div class="kpi-val ${cls}">${value}${unit ? `<small>${esc(unit)}</small>` : ''}</div><div class="kpi-sub">${sub}</div></div>`;
  // value: preformatted string (set at once) - or num + fmt: the digits roll to the new number
  const patchKpi = (root, key, { value, num, fmt, unit, cls, sub, tone } = {}) => {
    const box = $(`[data-kpi="${key}"]`, root);
    if (!box) return;
    const v = $('.kpi-val', box);
    if (num !== undefined) setValNum(v, num, fmt || ((x) => fmtNum(x, 1)), unit);
    else if (value !== undefined) setVal(v, value, unit);
    if (cls !== undefined) setCls(v, `kpi-val ${cls}`);
    if (sub !== undefined) (/[<&]/.test(sub) ? setHtml : setText)($('.kpi-sub', box), sub);
    if (tone !== undefined) setCls(box, `kpi ${tone}`);
  };

  const statusBadge = (m) => {
    if (m.status === 'disabled') return '<span class="badge neutral">DISABLED</span>';
    if (m.status === 'offline') return '<span class="badge critical">OFFLINE</span>';
    if (m.status === 'error') return '<span class="badge warn">COMM ERROR</span>';
    if (m.status === 'unknown') return '<span class="badge neutral">WAITING</span>';
    return '';
  };
  const alarmLabel = (m, a) => { if (String(a.type).startsWith('tag:')) { const t = (m.tags || []).find((x) => x.key === a.type.slice(4)); if (t) return `${t.label} ${Number.isFinite(a.value) ? fmtNum(a.value, t.decimals) + (t.unit ? ' ' + t.unit : '') : ''}`; } return `${typeLabel(a.type)}${Number.isFinite(a.value) ? ' ' + fmtNum(a.value, a.type === 'low_pf' ? 2 : 1) : ''}`; };
  const alarmBadges = (m) => (m.alarms || []).filter((a) => a.type !== 'offline').map((a) => `<span class="badge ${a.severity}" title="${esc(a.type)}">${esc(alarmLabel(m, a))}</span>`).join('');
  const footHtml = (m) => `${statusBadge(m)}${alarmBadges(m)}<span class="seen">${m.lastError && m.status !== 'ok' ? esc(m.lastError.slice(0, 40)) : ''}</span>`;

  /* ------------------------------------------------------------------
     Meter face
     ------------------------------------------------------------------ */
  const FACE_METRICS = [
    { key: 'p_total', label: 'Active Power Total', unit: 'kW', d: 2, w: 4 },
    { key: 'v_ln_avg', label: 'Voltage L-N Avg', unit: 'V', d: 1, w: 4 },
    { key: 'v_ll_avg', label: 'Voltage L-L Avg', unit: 'V', d: 1, w: 4 },
    { key: 'i_avg', label: 'Current Avg', unit: 'A', d: 1, w: 4 },
    { key: 's_total', label: 'Apparent Power', unit: 'kVA', d: 2, w: 4 },
    { key: 'pf', label: 'Power Factor', unit: '', d: 3, w: 2 },
    { key: 'kwh_import', label: 'Energy Import', unit: 'kWh', d: 1, w: 8 },
    { key: 'demand_kw', label: 'Demand', unit: 'kW', d: 2, w: 4 },
  ];
  const faceMetric = () => FACE_METRICS.find((f) => f.key === (localStorage.getItem('pc-face-metric') || 'p_total')) || FACE_METRICS[0];
  // a device may pin its own face value (conn.faceKey); otherwise the dashboard-wide choice applies
  const faceMetricFor = (m) => {
    if (m.faceKey) { const mt = metaOf(m, m.faceKey); if (mt) return { key: m.faceKey, label: mt.label, unit: mt.unit || '', d: Math.min(3, mt.decimals ?? 1), w: 5 }; }
    const fm = faceMetric();
    if (!(m.tags || []).length || (m.tags || []).some((t) => t.key === fm.key)) return fm;
    // device without that metric: first canonical tag it has, else its first custom tag
    const t = (m.tags || []).find((x) => !x.custom) || (m.tags || [])[0];
    return t ? { key: t.key, label: t.label, unit: t.unit || '', d: Math.min(3, t.decimals ?? 1), w: 5 } : fm;
  };
  // the four small readouts: standard electrical keys the device has, then its custom tags
  const faceSlotKeys = (m) => {
    if (m.faceSlots && m.faceSlots.length) return m.faceSlots.filter((k) => (m.tags || []).some((t) => t.key === k)).slice(0, 4);
    const has = (k) => !(m.tags || []).length || (m.tags || []).some((t) => t.key === k);
    const pref = ['v_ln_avg', 'i_avg', 'kwh_import', Number.isFinite((m.values || {}).demand_kw) || has('demand_kw') ? 'demand_kw' : 's_total'].filter(has);
    const extra = customTags(m).map((t) => t.key).filter((k) => !pref.includes(k));
    return [...pref, ...extra].slice(0, 4);
  };

  const phaseState = (m, k) => {
    const v = m.values[k];
    if (m.status !== 'ok' || !Number.isFinite(v)) return '';
    return v < (m.nominalV || 230) * 0.5 ? 'dead' : 'on';
  };
  const fvCls = (k, val, m) => {
    if (!Number.isFinite(val)) return '';
    if (k === 'v_ln_avg') { const p = val / (m.nominalV || 230); return p < 0.9 || p > 1.1 ? 'bad' : p < 0.95 || p > 1.05 ? 'warn' : ''; }
    if (k === 'i_avg' && m.ratedA) return val > m.ratedA * 1.2 ? 'bad' : val > m.ratedA ? 'warn' : '';
    return '';
  };
  const FACE_DEC = { v_ln_avg: 1, i_avg: 1, kwh_import: 0, demand_kw: 1, s_total: 1 };
  // energy counters get long: 194,254 kWh -> 194.3 MWh on the small tiles
  const faceVal = (k, val) => {
    if (!Number.isFinite(val)) return { text: '-', unit: unitOf(k) };
    if (k === 'kwh_import' && Math.abs(val) >= 100000) return { text: fmtNum(val / 1000, 1), unit: 'MWh' };
    return { text: fmtNum(val, FACE_DEC[k] ?? (metricOf(k) ? metricOf(k).decimals : 1)), unit: unitOf(k) };
  };
  const faceValM = (m, k, val) => (metricOf(k) ? faceVal(k, val) : { text: Number.isFinite(val) ? fmtNum(val, Math.min(1, (metaOf(m, k) || {}).decimals ?? 1)) : '-', unit: unitV(m, k) });
  const FACE_LABEL = { v_ln_avg: 'Volt L-N', i_avg: 'Current', kwh_import: 'Energy', demand_kw: 'Demand', s_total: 'Apparent' };
  const fv = (k, label, v, m) => { const x = faceValM(m, k, v[k]); return `<div class="fv"><div class="fv-label">${esc(label || FACE_LABEL[k] || (metaOf(m, k) || {}).label || k)}</div><div class="fv-val ${fvCls(k, v[k], m)}" data-k="${k}">${x.text}<small>${esc(x.unit)}</small></div></div>`; };
  const faceCls = (m) => `face ${m.status === 'offline' ? 'offline' : ''} ${m.alarm ? 'alarm-' + m.alarm : ''}`;
  const fourthKey = (v) => (Number.isFinite(v.demand_kw) ? 'demand_kw' : 's_total');

  function faceHtml(m) {
    const fm = faceMetricFor(m);
    const v = m.values || {};
    const single = (m.phases || 3) === 1;
    const model = (m.model || m.template || '').replace('PowerLogic ', '').split('/')[0].trim();
    return `<div class="${faceCls(m)}" data-meter="${m.id}" onclick="location.hash='#/meter/${m.id}'">
      <div class="face-head">
        <i class="led ${m.status}"></i>
        <div style="min-width:0"><div class="face-title">${esc(m.name)}</div><div class="face-sub">${esc(m.code || '')}${m.sectionName ? ' · ' + esc(m.sectionName) : ''}</div></div>
        <div class="face-model" title="${esc(m.brand || '')} ${esc(m.model || '')} · unit ${m.unitId}">${esc(model)}</div>
      </div>
      <div class="lcd-wrap">
        <div class="lcd-row">${lcdHtml(v[fm.key], { decimals: fm.d, width: fm.w })}<span class="lcd-unit">${fm.unit}</span><canvas class="lcd-spark"></canvas></div>
        <div class="lcd-label">${fm.label}<span class="ago">${m.at ? fmtAgo(m.at) : '--'}</span></div>
      </div>
      ${m.layout === 'plc-summary' ? `<div class="face-phases"><span class="kv">${icon('layers')} PLC ${esc(m.gatewayName || '')}</span><span class="spacer"></span><span class="kv">${esc((m.tags || []).find((t) => t.key === 'wh_l') ? 'DB1004' : 'S7')}</span></div>` : `<div class="face-phases">
        ${single ? `<span class="ph a ${phaseState(m, 'va')}"><i></i>L1</span>` : `<span class="ph a ${phaseState(m, 'va')}"><i></i>A</span><span class="ph b ${phaseState(m, 'vb')}"><i></i>B</span><span class="ph c ${phaseState(m, 'vc')}"><i></i>C</span>`}
        <span class="spacer"></span>
        <span class="kv">PF <b data-k="pf">${fmtMetric('pf', v.pf)}</b></span>
        <span class="kv"><b data-k="freq">${fmtMetric('freq', v.freq)}</b> Hz</span>
      </div>`}
      <div class="face-vals">
        ${faceSlotKeys(m).map((k) => fv(k, null, v, m)).join('')}
      </div>
      <div class="face-foot">${footHtml(m)}</div>
    </div>`;
  }

  // Patch one face in place - only nodes whose value changed are touched.
  function patchFace(el, m) {
    const fm = faceMetricFor(m);
    const v = m.values || {};
    setCls(el, faceCls(m));
    setCls($('.led', el), 'led ' + m.status);
    setNum($('.lcd .num', el), v[fm.key], (x) => lcdText(x, fm.d, fm.w));
    setText($('.ago', el), m.at ? fmtAgo(m.at) : '--');
    $$('.ph', el).forEach((p, i) => setCls(p, `ph ${['a', 'b', 'c'][i]} ${phaseState(m, ['va', 'vb', 'vc'][i])}`));
    $$('[data-k]', el).forEach((n) => {
      const k = n.dataset.k;
      if (n.classList.contains('fv-val')) {
        const x = faceValM(m, k, v[k]);
        setValNum(n, v[k], (y) => faceValM(m, k, y).text, x.unit);
        setCls(n, 'fv-val ' + fvCls(k, v[k], m));
      } else setNum(n, v[k], (y) => fmtMetric(k, y));
    });
    setHtml($('.face-foot', el), footHtml(m));
    drawSpark($('.lcd-spark', el), S.history.get(m.id) || [], { color: '#ffb547', width: 1.5 });
  }

  function refreshAgo(root) {
    $$('.face', root).forEach((el) => { const m = S.meters.get(Number(el.dataset.meter)); if (m) setText($('.ago', el), m.at ? fmtAgo(m.at) : '--'); });
  }

  /* ------------------------------------------------------------------
     Overview
     ------------------------------------------------------------------ */
  function overview() {
    let el; let timer; let sig = '';
    const tone = (a, ok) => (a.critical ? 'bad' : a.total ? 'warn' : ok);
    const build = () => {
      const t = S.tree; const s = S.summary;
      const al = s ? s.alarms : { total: 0, critical: 0, error: 0, warn: 0, unacked: 0 };
      el.innerHTML = `
        <div class="page-head"><div><div class="page-title">All plants</div><div class="page-sub" id="ovSub"></div></div>
          <div class="page-actions"><a class="btn" href="#/export">${icon('download')} Export</a><a class="btn" href="#/alarms">${icon('bell')} Alarms</a></div></div>
        <div class="kpis stagger">
          ${kpi('kw', 'Total active power', '-', { unit: 'kW', cls: 'accent', iconName: 'bolt', sub: 'sum of online meters' })}
          ${kpi('online', 'Meters online', '-', { iconName: 'gauge' })}
          ${kpi('alarms', 'Alarms', al.total, { cls: tone(al, 'ok'), iconName: 'bell', tone: tone(al, 'ok') })}
          ${kpi('gw', 'Gateways', '-', { iconName: 'router', tone: 'teal', sub: 'connected' })}
        </div>
        <div class="sec-title">Plants <span class="line"></span></div>
        <div class="grid stagger" id="ovPlants">${t.plants.map((p) => `
          <div class="tile" data-plant="${p.id}" onclick="location.hash='#/plant/${p.id}'">
            <div class="tile-head"><i class="dot"></i>
              <div style="min-width:0"><div class="tile-title">${esc(p.name)}</div><div class="tile-sub">${esc(p.code || '')}${p.province ? ' · ' + esc(p.province) : ''} · ${p.lines.length} lines</div></div>
              <span class="right chip accent"><b data-p="kw">-</b> kW</span></div>
            <div class="tile-body">
              <div class="stat-row">
                <div class="stat"><div class="stat-label">Meters</div><div class="stat-val" data-p="on">-</div></div>
                <div class="stat"><div class="stat-label">Alarms</div><div class="stat-val" data-p="al">-</div></div>
                <div class="stat"><div class="stat-label">Gateways</div><div class="stat-val" data-p="gw">-</div></div>
              </div>
              <div class="line-list">${p.lines.slice(0, 6).map((l) => `<div class="line-row" data-line="${l.id}" onclick="event.stopPropagation();location.hash='#/line/${l.id}'"><i class="dot" style="width:7px;height:7px"></i>${esc(l.name)}<span class="muted mono cnt" style="font-size:.62rem"></span><span class="kw"></span></div>`).join('')}
              ${p.lines.length > 6 ? `<div class="line-row muted">+ ${p.lines.length - 6} more lines</div>` : ''}</div>
            </div></div>`).join('')}
          ${!t.plants.length ? `<div class="empty" style="grid-column:1/-1">No plants yet${S.me.can.admin ? ' — open <a href="#/settings/structure">Settings</a> to add plants and production lines' : ''}</div>` : ''}
        </div>
        <div class="sec-title">Recent alarms <span class="line"></span><a class="btn xs" href="#/alarms">View all</a></div>
        <div class="table-wrap" id="ovEvents"><div class="empty">loading...</div></div>`;
      loadEvents();
    };
    const patch = () => {
      const t = S.tree; const s = S.summary;
      if (!t || !el) return;
      const kw = t.plants.reduce((a, p) => a + p.kw, 0);
      const online = t.plants.reduce((a, p) => a + p.online, 0) + t.unassigned.online;
      const total = t.plants.reduce((a, p) => a + p.meters, 0) + t.unassigned.meters;
      const al = s ? s.alarms : { total: 0, critical: 0, error: 0, warn: 0 };
      setText($('#ovSub', el), `${t.plants.length} plants · ${t.plants.reduce((a, p) => a + p.lines.length, 0)} lines · ${total} meters`);
      patchKpi(el, 'kw', { num: kw, unit: `kW` });
      patchKpi(el, 'online', { value: online, unit: `/ ${total}`, cls: online === total ? 'ok' : 'warn', tone: online === total ? 'ok' : 'warn', sub: total - online ? `${total - online} offline` : 'all meters reporting' });
      patchKpi(el, 'alarms', { value: String(al.total), cls: tone(al, 'ok'), tone: tone(al, 'ok'), sub: `${al.critical} critical · ${al.error} error · ${al.warn} warn` });
      if (s) patchKpi(el, 'gw', { value: s.gateways.filter((g) => g.connected).length, unit: `/ ${s.gateways.length}`, cls: s.gateways.every((g) => g.connected) ? 'ok' : 'bad' });
      for (const p of t.plants) {
        const tile = $(`[data-plant="${p.id}"]`, el);
        if (!tile) continue;
        setCls($('.tile-head .dot', tile), `dot ${p.alarms ? (p.online < p.meters ? 'crit' : 'warn') : p.meters ? 'ok' : ''}`);
        setNum($('[data-p="kw"]', tile), p.kw, (x) => fmtNum(x, 1));
        setVal($('[data-p="on"]', tile), p.online, `/ ${p.meters}`); setCls($('[data-p="on"]', tile), `stat-val ${p.online === p.meters ? 'ok' : 'warn'}`);
        setText($('[data-p="al"]', tile), p.alarms); setCls($('[data-p="al"]', tile), `stat-val ${p.alarms ? 'warn' : ''}`);
        if (s) setVal($('[data-p="gw"]', tile), s.gateways.filter((g) => g.plantId === p.id && g.connected).length, `/ ${s.gateways.filter((g) => g.plantId === p.id).length}`);
        for (const l of p.lines) {
          const row = $(`[data-line="${l.id}"]`, tile);
          if (!row) continue;
          setCls($('.dot', row), `dot ${l.alarms ? 'warn' : l.meters && l.online === l.meters ? 'ok' : l.meters ? 'crit' : ''}`);
          setText($('.cnt', row), `${l.online}/${l.meters}`);
          setNum($('.kw', row), l.kw, (x) => `${fmtNum(x, 1)} kW`);
        }
      }
    };
    const structureSig = () => JSON.stringify(S.tree.plants.map((p) => [p.id, p.name, p.lines.map((l) => [l.id, l.name])]));
    const loadEvents = async () => {
      const d = await api('/api/events?limit=12&from=' + (Date.now() - 7 * 86400000));
      const box = $('#ovEvents', el);
      if (box) setHtml(box, eventsTable(d.events, { compact: true }));
    };
    const tick = () => { if (!S.tree || !el) return; const s2 = structureSig(); if (s2 !== sig) { sig = s2; build(); } patch(); };
    return {
      scope: { all: true },
      async mount(root) {
        el = root; setCrumbs([{ label: 'Overview' }]);
        if (!S.summary) { try { S.summary = await api('/api/summary'); renderChips(); } catch (e) { /* ws will fill it */ } }
        sig = structureSig(); build(); patch();
        timer = setInterval(tick, 5000);
      },
      onSummary() { patch(); },
      onEvent(msg) { if (msg.action !== 'update') loadEvents(); },
      destroy() { clearInterval(timer); },
    };
  }

  /* ------------------------------------------------------------------
     Plant
     ------------------------------------------------------------------ */
  function plant(id) {
    let el; let timer; let gws = [];
    const build = async () => {
      const p = plantOf(id);
      if (!p) { el.innerHTML = '<div class="empty">Plant not found</div>'; return; }
      setCrumbs([{ label: 'Overview', href: '#/' }, { label: p.name }]);
      const [energy, gwRes] = await Promise.all([api(`/api/energy?plantId=${id}`).catch(() => null), api(`/api/gateways?plantId=${id}`).catch(() => ({ gateways: [] }))]);
      gws = gwRes.gateways;
      el.innerHTML = `
        <div class="page-head"><div><div class="page-title">${esc(p.name)}</div><div class="page-sub">${esc(p.code || '')}${p.province ? ' · ' + esc(p.province) : ''}${p.address ? ' · ' + esc(p.address) : ''}</div></div>
          <div class="page-actions"><a class="btn" href="#/export">${icon('download')} Export</a><a class="btn" href="#/alarms">${icon('bell')} Alarms</a>${S.me.can.admin ? `<a class="btn" href="#/settings/structure">${icon('settings')} Manage</a>` : ''}</div></div>
        <div class="kpis stagger">
          ${kpi('kw', 'Total active power', '-', { unit: 'kW', cls: 'accent', iconName: 'bolt' })}
          ${kpi('energy', 'Energy today', energy ? fmtNum(energy.today, 0) : '-', { unit: 'kWh', iconName: 'energy', tone: 'teal', sub: energy ? `yesterday ${fmtNum(energy.yesterday, 0)} · this month ${fmtNum(energy.month, 0)} kWh` : '' })}
          ${kpi('online', 'Meters online', '-', { iconName: 'gauge' })}
          ${kpi('alarms', 'Alarms', '-', { iconName: 'bell' })}
          ${kpi('gw', 'Gateways', '-', { iconName: 'router', tone: 'teal' })}
        </div>
        <div class="sec-title">Production lines <span class="line"></span><span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">${p.lines.length} lines</span></div>
        <div class="grid stagger">${p.lines.map((l) => `
          <div class="tile" data-line="${l.id}" onclick="location.hash='#/line/${l.id}'">
            <div class="tile-head"><i class="dot"></i>
              <div style="min-width:0"><div class="tile-title">${esc(l.name)}</div><div class="tile-sub">${esc(l.code || '')} · ${l.sections.length} sections</div></div>
              <span class="right chip accent"><b data-l="kw">-</b> kW</span></div>
            <div class="tile-body">
              <div class="stat-row">
                <div class="stat"><div class="stat-label">Meters</div><div class="stat-val" data-l="on">-</div></div>
                <div class="stat"><div class="stat-label">Alarms</div><div class="stat-val" data-l="al">-</div></div>
                <div class="stat"><div class="stat-label">Sections</div><div class="stat-val">${l.sections.map((x) => esc(x.name)).join(', ') || '-'}</div></div>
              </div>
              <canvas class="tile-spark" data-line-spark="${l.id}"></canvas>
            </div></div>`).join('')}
          ${!p.lines.length ? '<div class="empty" style="grid-column:1/-1">No production lines in this plant yet</div>' : ''}
        </div>
        <div class="sec-title">Gateways <span class="line"></span></div>
        <div class="grid gws" id="plantGws">${gws.map(gatewayCard).join('') || '<div class="empty" style="grid-column:1/-1">No gateways yet</div>'}</div>`;
      for (const g of gws) { const card = $(`[data-gw="${g.id}"]`, el); if (card) patchGatewayCard(card, g); }
      patch();
      for (const l of p.lines) loadLineSpark(l.id);
    };
    const loadLineSpark = async (lineId) => {
      try {
        const d = await api(`/api/lines/${lineId}/history?from=${Date.now() - 6 * 3600000}&interval=300`);
        const c = $(`[data-line-spark="${lineId}"]`, el);
        if (c) drawSpark(c, d.rows.map((r) => r.kw), { color: '#3dd6c0', width: 1.5 });
      } catch (e) { /* ignore */ }
    };
    const patch = () => {
      const p = plantOf(id); const s = S.summary;
      if (!p || !el) return;
      const ps = s && s.plants[id] ? s.plants[id] : { online: p.online, offline: p.meters - p.online, kw: p.kw, alarms: p.alarms };
      const total = ps.online + ps.offline;
      patchKpi(el, 'kw', { num: ps.kw, unit: `kW` });
      patchKpi(el, 'online', { value: ps.online, unit: `/ ${total}`, cls: ps.offline ? 'warn' : 'ok', tone: ps.offline ? 'warn' : 'ok' });
      patchKpi(el, 'alarms', { value: String(ps.alarms), cls: ps.alarms ? 'warn' : 'ok', tone: ps.alarms ? 'warn' : 'ok' });
      const gwOn = gws.filter((g) => g.live && g.live.connected).length;
      patchKpi(el, 'gw', { value: gwOn, unit: `/ ${gws.length}`, cls: gws.every((g) => !g.enabled || (g.live && g.live.connected)) ? 'ok' : 'bad' });
      for (const l of p.lines) {
        const tile = $(`[data-line="${l.id}"]`, el);
        if (!tile) continue;
        setCls($('.tile-head .dot', tile), `dot ${l.alarms ? (l.online < l.meters ? 'crit' : 'warn') : l.meters && l.online === l.meters ? 'ok' : l.meters ? 'crit' : ''}`);
        setNum($('[data-l="kw"]', tile), l.kw, (x) => fmtNum(x, 1));
        setVal($('[data-l="on"]', tile), l.online, `/ ${l.meters}`); setCls($('[data-l="on"]', tile), `stat-val ${l.online === l.meters ? 'ok' : 'warn'}`);
        setText($('[data-l="al"]', tile), l.alarms); setCls($('[data-l="al"]', tile), `stat-val ${l.alarms ? 'warn' : ''}`);
      }
    };
    return {
      scope: { plantId: id },
      mount(root) { el = root; build(); timer = setInterval(patch, 5000); },
      onSummary() { patch(); },
      onGateways(msg) {
        if (msg.type !== 'gateway') return;
        const g = gws.find((x) => x.id === msg.gateway.id);
        if (!g) return;
        g.live = { ...(g.live || {}), ...msg.gateway };
        const card = $(`[data-gw="${g.id}"]`, el);
        if (card) patchGatewayCard(card, g);
      },
      destroy() { clearInterval(timer); },
    };
  }

  /* ------------------------------------------------------------------
     Line (meter faces)
     ------------------------------------------------------------------ */
  function line(lineId) {
    let el; let timer; let kpiTimer; let energyTimer; let section = 'all'; let energy = null;
    const mode = () => localStorage.getItem('pc-face-mode') || 'grid';
    const build = async () => {
      const l = lineId ? lineOf(lineId) : null;
      if (lineId && !l) { el.innerHTML = '<div class="empty">Production line not found</div>'; return; }
      const meters = metersOfLine(lineId);
      const sections = l ? l.sections : [];
      setCrumbs(l ? [{ label: 'Overview', href: '#/' }, { label: l.plant.name, href: '#/plant/' + l.plant.id }, { label: l.name }] : [{ label: 'Overview', href: '#/' }, { label: 'Unassigned meters' }]);
      energy = lineId ? await api(`/api/energy?lineId=${lineId}`).catch(() => null) : null;
      const fm = faceMetric();
      el.innerHTML = `
        <div class="page-head"><div><div class="page-title">${l ? esc(l.name) : 'Meters not assigned to a line'}</div><div class="page-sub">${l ? esc(l.plant.name) + ' · ' + esc(l.code || '') + ' · ' : ''}${meters.length} meters</div></div>
          <div class="page-actions">
            <select class="btn" id="faceMetricSel" title="Primary value on the meter face">${FACE_METRICS.map((f) => `<option value="${f.key}" ${f.key === fm.key ? 'selected' : ''}>${f.label}${f.unit ? ' (' + f.unit + ')' : ''}</option>`).join('')}</select>
            <button class="btn" id="modeBtn" title="Toggle grid / list">${icon(mode() === 'grid' ? 'list' : 'grid')}</button>
            ${lineId ? `<button class="btn" id="expBtn">${icon('download')} Export</button>` : ''}
            ${S.me.can.admin ? (meters.length && meters.every((m) => m.gatewayProtocol === 'siemens-s7') ? `<a class="btn" href="#/settings/plc">${icon('cpu')} Manage PLCs</a>` : `<a class="btn" href="#/settings/meters${lineId ? '?line=' + lineId : ''}">${icon('settings')} Manage meters</a>`) : ''}
          </div></div>
        <div class="kpis six stagger" id="lineKpis">
          ${kpi('kw', 'Total active power', '-', { unit: 'kW', cls: 'accent', iconName: 'bolt' })}
          ${kpi('energy', 'Energy today', '-', { unit: 'kWh', iconName: 'energy', tone: 'teal' })}
          ${kpi('online', 'Meters online', '-', { iconName: 'gauge' })}
          ${kpi('alarms', 'Alarms', '-', { iconName: 'bell' })}
          ${kpi('volt', 'Avg voltage', '-', { unit: 'V', iconName: 'wave' })}
          ${kpi('pf', 'Avg power factor', '-', { iconName: 'gauge' })}
        </div>
        ${sections.length ? `<div class="filters"><span class="preset ${section === 'all' ? 'sel' : ''}" data-sec="all">All</span>${sections.map((s) => `<span class="preset ${section === String(s.id) ? 'sel' : ''}" data-sec="${s.id}">${esc(s.name)} <span class="muted">${s.meters}</span></span>`).join('')}<span class="preset ${section === 'none' ? 'sel' : ''}" data-sec="none">No section</span></div>` : ''}
        <div id="faces">${facesHtml(meters, sections)}</div>`;
      $$('.filters .preset', el).forEach((p) => { p.onclick = () => { section = p.dataset.sec; build(); }; });
      $('#faceMetricSel', el).onchange = (e) => { localStorage.setItem('pc-face-metric', e.target.value); build(); };
      $('#modeBtn', el).onclick = () => { localStorage.setItem('pc-face-mode', mode() === 'grid' ? 'list' : 'grid'); build(); };
      const eb = $('#expBtn', el); if (eb) eb.onclick = () => exportModal({ lineId, title: l.name });
      $$('.face', el).forEach((f) => { const m = S.meters.get(Number(f.dataset.meter)); if (m) drawSpark($('.lcd-spark', f), S.history.get(m.id) || [], { color: '#ffb547', width: 1.5 }); });
      patchKpis();
    };
    const facesHtml = (meters, sections) => {
      const cls = `grid faces ${mode() === 'list' ? 'list' : ''} stagger`;
      const show = (m) => section === 'all' || (section === 'none' ? !m.sectionId : m.sectionId === Number(section));
      if (!meters.length) return `<div class="empty">No meters in this line yet${S.me.can.admin ? ' — add them under <a href="#/settings/meters">Settings › Meters</a>' : ''}</div>`;
      if (!sections.length || section !== 'all') return `<div class="${cls}">${meters.filter(show).map(faceHtml).join('')}</div>`;
      const groups = [...sections.map((s) => ({ s, ms: meters.filter((m) => m.sectionId === s.id) })), { s: null, ms: meters.filter((m) => !sections.some((s) => s.id === m.sectionId)) }].filter((g) => g.ms.length);
      return groups.map((g) => `<div class="section-head" data-section="${g.s ? g.s.id : 'none'}"><span class="name">${g.s ? esc(g.s.name) : 'No section'}</span><span class="meta">${sectionMeta(g.ms)}</span><span class="line"></span></div><div class="${cls}">${g.ms.map(faceHtml).join('')}</div>`).join('');
    };
    const sectionMeta = (ms) => `${ms.filter((m) => m.status === 'ok').length}/${ms.length} online · ${fmtNum(ms.reduce((a, m) => a + (m.status === 'ok' && Number.isFinite(m.values.p_total) ? m.values.p_total : 0), 0), 1)} kW`;
    const patchKpis = () => {
      if (!el || !$('#lineKpis', el)) return;
      const meters = metersOfLine(lineId);
      const on = meters.filter((m) => m.status === 'ok');
      const kw = on.reduce((a, m) => a + (Number.isFinite(m.values.p_total) ? m.values.p_total : 0), 0);
      const alarms = meters.reduce((a, m) => a + (m.alarms || []).length, 0);
      const rank = { warn: 1, error: 2, critical: 3 };
      const worst = meters.reduce((w, m) => ((rank[m.alarm] || 0) > (rank[w] || 0) ? m.alarm : w), null);
      const vs = on.map((m) => m.values.v_ln_avg).filter(Number.isFinite);
      const pfs = on.filter((m) => Number.isFinite(m.values.pf) && (m.values.p_total || 0) > 0.5).map((m) => m.values.pf);
      patchKpi(el, 'kw', { num: kw, unit: `kW` });
      patchKpi(el, 'energy', { num: energy ? energy.today : NaN, fmt: (x) => fmtNum(x, 0), unit: `kWh`, sub: energy ? `yesterday ${fmtNum(energy.yesterday, 0)} · this month ${fmtNum(energy.month, 0)}` : '' });
      patchKpi(el, 'online', { value: on.length, unit: `/ ${meters.length}`, cls: on.length === meters.length ? 'ok' : 'warn', tone: on.length === meters.length ? 'ok' : 'warn' });
      patchKpi(el, 'alarms', { value: String(alarms), cls: worst ? sevCls(worst) : 'ok', tone: worst === 'critical' || worst === 'error' ? 'bad' : worst ? 'warn' : 'ok' });
      patchKpi(el, 'volt', { num: vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : NaN, unit: `V`, sub: vs.length ? `min ${fmtNum(Math.min(...vs), 1)} · max ${fmtNum(Math.max(...vs), 1)}` : '' });
      patchKpi(el, 'pf', { num: pfs.length ? pfs.reduce((a, b) => a + b, 0) / pfs.length : NaN, fmt: (x) => fmtNum(x, 3), cls: pfs.length && Math.min(...pfs) < 0.85 ? 'warn' : '' });
      const secs = (lineOf(lineId) || {}).sections || [];
      $$('.section-head', el).forEach((h) => {
        const sid = h.dataset.section;
        const ms = meters.filter((m) => (sid === 'none' ? !secs.some((s) => s.id === m.sectionId) : m.sectionId === Number(sid)));
        setText($('.meta', h), sectionMeta(ms));
      });
    };
    return {
      scope: lineId ? { lineId } : { meterIds: metersOfLine(null).map((m) => m.id) },
      mount(root) {
        el = root; build();
        timer = setInterval(() => refreshAgo(el), 1000);
        kpiTimer = setInterval(patchKpis, 3000);
        energyTimer = setInterval(async () => { if (lineId) energy = await api(`/api/energy?lineId=${lineId}`).catch(() => energy); }, 60000);
      },
      onReading(msg, m) {
        if (!m || !el) return;
        const f = $(`.face[data-meter="${m.id}"]`, el);
        if (f) patchFace(f, m);
      },
      destroy() { clearInterval(timer); clearInterval(kpiTimer); clearInterval(energyTimer); },
    };
  }

  /* ------------------------------------------------------------------
     Meter detail
     ------------------------------------------------------------------ */
  const CHART_GROUPS = [
    { id: 'power', label: 'Power (kW)', keys: ['p_total', 'pa', 'pb', 'pc'], unit: 'kW' },
    { id: 'vln', label: 'Voltage L-N', keys: ['va', 'vb', 'vc'], unit: 'V' },
    { id: 'vll', label: 'Voltage L-L', keys: ['vab', 'vbc', 'vca'], unit: 'V' },
    { id: 'current', label: 'Current', keys: ['ia', 'ib', 'ic', 'in'], unit: 'A' },
    { id: 'pf', label: 'Power Factor', keys: ['pf'], unit: '', yMin: 0, yMax: 1 },
    { id: 'freq', label: 'Frequency', keys: ['freq'], unit: 'Hz' },
    { id: 'qs', label: 'kVAR / kVA', keys: ['q_total', 's_total'], unit: '' },
    { id: 'energy', label: 'Energy (kWh/h)', keys: ['kwh'], unit: 'kWh', hourly: true },
    { id: 'thdv', label: 'THD V', keys: ['thd_va', 'thd_vb', 'thd_vc'], unit: '%' },
    { id: 'thdi', label: 'THD I', keys: ['thd_ia', 'thd_ib', 'thd_ic'], unit: '%' },
    { id: 'demand', label: 'Demand', keys: ['demand_kw', 'demand_peak_kw'], unit: 'kW' },
    { id: 'unbal', label: 'Unbalance', keys: ['v_unbal', 'i_unbal'], unit: '%' },
  ];

  // gauge card: arc + value + sub, patched in place
  const ARC = Math.PI * 40;
  const gaugeCard = (key, label, unit) => `<div class="gauge-card" data-gauge="${key}"><svg class="gauge" viewBox="0 0 100 60"><path class="track" d="M10 55 A40 40 0 0 1 90 55" fill="none" stroke-width="9" stroke-linecap="round"/><path class="arc" d="M10 55 A40 40 0 0 1 90 55" fill="none" stroke-width="9" stroke-linecap="round" stroke-dasharray="${ARC.toFixed(1)}" stroke-dashoffset="${ARC.toFixed(1)}"/></svg><div style="min-width:0"><div class="gauge-label">${label}</div><div class="gauge-val">-<small>${unit}</small></div><div class="gauge-sub"></div></div></div>`;
  const patchGauge = (root, key, { val, d = 1, pct, cls, sub }) => {
    const box = $(`[data-gauge="${key}"]`, root);
    if (!box) return;
    const p = Math.max(0, Math.min(1, Number.isFinite(pct) ? pct : 0));
    const arc = $('.arc', box);
    const off = (ARC * (1 - p)).toFixed(1);
    if (arc.getAttribute('stroke-dashoffset') !== off) arc.setAttribute('stroke-dashoffset', off);
    setCls(arc, `arc ${cls || ''}`);
    // val: number -> digits roll to it (d decimals); null -> '-'
    setValNum($('.gauge-val', box), Number.isFinite(val) ? val : NaN, (x) => (Number.isFinite(x) ? x.toFixed(d) : '-'));
    setText($('.gauge-sub', box), sub || '');
  };

  const chartGroupsFor = (m) => {
    // one chart per custom group and unit (kW and kWh never share an axis)
    const groups = new Map();
    for (const t of customTags(m)) {
      const g = (S.meta.groups[t.group] || {}).label || t.group;
      const units = [...new Set(customTags(m).filter((x) => x.group === t.group).map((x) => x.unit || ''))];
      const label = units.length > 1 ? `${g} · ${t.unit || '-'}` : g;
      if (!groups.has(label)) groups.set(label, { keys: [], unit: t.unit || '' });
      groups.get(label).keys.push(t.key);
    }
    const custom = [...groups.entries()].map(([g, x]) => ({ id: 'tag:' + g, label: g, keys: x.keys, unit: x.unit, custom: true }));
    return m.layout === 'plc-summary' && custom.length ? custom : [...CHART_GROUPS, ...custom];
  };

  function meter(id) {
    let el; let chart; let timer; let full = null;
    let range = { preset: '6h', from: null, to: null };
    let group = localStorage.getItem('pc-chart-group') || 'power';
    let groupInit = false;
    let events = [];
    let evFilter = { severity: '', type: '', active: false };
    let groupSig = '';

    const rangeMs = () => {
      if (range.preset === 'custom') return { from: range.from, to: range.to };
      const p = RANGE_PRESETS.find((r) => r.id === range.preset) || RANGE_PRESETS[1];
      return { from: Date.now() - p.ms, to: Date.now() };
    };

    const build = async () => {
      const res = await api(`/api/meters/${id}`);
      full = res.meter;
      const m = S.meters.get(id) || full;
      Object.assign(m, { conn: full.conn, registerMap: full.registerMap, alarmConfig: full.alarmConfig });
      S.meters.set(id, m);
      groupSig = '';
      if (!groupInit) { groupInit = true; const cg = chartGroupsFor(m); if (m.layout === 'plc-summary' && !cg.find((x) => x.id === group && x.custom)) { const first = cg.find((x) => x.custom); if (first) group = first.id; } }
      setCrumbs([{ label: 'Overview', href: '#/' }, ...(m.plantId ? [{ label: m.plantName, href: '#/plant/' + m.plantId }] : []), ...(m.lineId ? [{ label: m.lineName, href: '#/line/' + m.lineId }] : []), { label: m.name }]);
      el.innerHTML = `
        <div class="detail-head">
          <i class="led ${m.status}" id="dLed"></i>
          <div style="min-width:0"><div class="detail-title">${esc(m.name)}</div>
            <div class="detail-meta"><span class="mono">${esc(m.code || '')}</span><span>${icon('factory')}${esc(m.plantName || '-')}</span><span>${icon('line')}${esc(m.lineName || '-')}${m.sectionName ? ' / ' + esc(m.sectionName) : ''}</span><span>${icon('router')}${esc(m.gatewayName || 'no gateway')}${m.gatewayId ? ' · unit ' + m.unitId : ''}</span><span>${esc(m.brand || '')} ${esc(m.model || '')}</span><span>${icon('clock')}<b id="dAgo">${m.at ? fmtAgo(m.at) : '--'}</b></span></div></div>
          <div class="detail-alarms" id="dAlarms">${statusBadge(m)}${alarmBadges(m)}</div>
          <div class="page-actions">
            <button class="btn" id="dExport">${icon('download')} Export</button>
            ${S.me.can.operator ? `<button class="btn" id="dAck">${icon('check')} Acknowledge alarms</button>` : ''}
            ${S.me.can.admin ? `<button class="btn" id="dConfig">${icon('settings')} Configure</button>` : ''}
          </div></div>
        ${m.layout === 'plc-summary' ? `<div class="kpis plc-kpis stagger" id="dGauges">${plcKpis(m)}</div><div class="card plc-diag" id="dPlc"><div class="card-body row wrap" style="gap:.6rem"><span class="muted" style="font-size:.7rem">PLC diagnostics: waiting for gateway...</span></div></div>` : `<div class="gauges stagger" id="dGauges">${gaugeCard('p', 'Active Power', 'kW')}${gaugeCard('v', 'Voltage L-N', 'V')}${gaugeCard('i', 'Current', 'A')}${gaugeCard('pf', 'Power Factor', '')}</div>
        <div class="kpis" id="dEnergy"></div>`}
        <div class="chart-card">
          <div class="chart-toolbar">
            <div class="grp" id="chartGroups">${chartGroupsFor(m).map((g) => `<span class="preset ${g.id === group ? 'sel' : ''} ${g.custom ? 'custom' : ''}" data-g="${g.id}">${esc(g.label)}</span>`).join('')}</div>
            <span class="right"></span>
            <div class="grp" id="chartRanges">${RANGE_PRESETS.map((r) => `<span class="preset ${r.id === range.preset ? 'sel' : ''}" data-r="${r.id}">${r.label}</span>`).join('')}<span class="preset ${range.preset === 'custom' ? 'sel' : ''}" data-r="custom">Custom</span></div>
          </div>
          <div class="filters hide" id="customRange" style="margin:.2rem 0 .6rem">
            <div class="field"><label>From</label><input type="datetime-local" id="crFrom"></div>
            <div class="field"><label>To</label><input type="datetime-local" id="crTo"></div>
            <button class="btn sm" id="crApply" style="align-self:flex-end">Apply</button>
          </div>
          <div class="chart-box" id="chartBox"></div>
          <div class="chart-events" id="chartMeta"></div>
        </div>
        <div class="sec-title">All values <span class="line"></span></div>
        <div class="vgroups stagger" id="dGroups"></div>
        <div class="sec-title">Alarm / event log <span class="line"></span><a class="btn xs" id="evCsv">${icon('download')} CSV</a></div>
        <div class="evt-filters">
          <select class="btn sm" id="evSev"><option value="">All severities</option><option value="critical">Critical</option><option value="error">Error</option><option value="warn">Warn</option></select>
          <select class="btn sm" id="evType"><option value="">All types</option>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
          <label class="chip click"><input type="checkbox" id="evActive" style="accent-color:var(--accent)"> Active only</label>
          <span class="muted" style="font-size:.66rem" id="evCount"></span>
        </div>
        <div class="table-wrap" id="evTable"><div class="empty">loading...</div></div>`;
      $$('#chartGroups .preset', el).forEach((p) => { p.onclick = () => { group = p.dataset.g; localStorage.setItem('pc-chart-group', group); $$('#chartGroups .preset', el).forEach((x) => x.classList.toggle('sel', x === p)); loadChart(); }; });
      $$('#chartRanges .preset', el).forEach((p) => {
        p.onclick = () => {
          $$('#chartRanges .preset', el).forEach((x) => x.classList.toggle('sel', x === p));
          if (p.dataset.r === 'custom') {
            $('#customRange', el).classList.remove('hide');
            $('#crFrom', el).value = toLocalInput(Date.now() - 86400000); $('#crTo', el).value = toLocalInput(Date.now());
          } else { $('#customRange', el).classList.add('hide'); range = { preset: p.dataset.r }; loadChart(); }
        };
      });
      $('#crApply', el).onclick = () => { range = { preset: 'custom', from: fromLocalInput($('#crFrom', el).value), to: fromLocalInput($('#crTo', el).value) }; if (range.from && range.to) loadChart(); };
      $('#dExport', el).onclick = () => exportModal({ meterIds: [id], title: m.name });
      const ack = $('#dAck', el); if (ack) ack.onclick = async () => { for (const a of (m.alarms || [])) await api(`/api/events/${a.id}/ack`, { body: {} }).catch(() => {}); toast('Acknowledged', 'ok'); loadEvents(); };
      const cfg = $('#dConfig', el); if (cfg) cfg.onclick = () => (m.gatewayProtocol === 'siemens-s7' ? Settings.plcForm(m.gatewayId, id, () => build()) : Settings.meterForm(id, () => build()));
      ['evSev', 'evType', 'evActive'].forEach((k) => { $('#' + k, el).onchange = () => { evFilter = { severity: $('#evSev', el).value, type: $('#evType', el).value, active: $('#evActive', el).checked }; loadEvents(); }; });
      $('#evCsv', el).onclick = () => { window.open(`/api/events.csv?meterId=${id}&from=${Date.now() - 30 * 86400000}`, '_blank'); };
      patchLive(m);
      if (m.layout === 'plc-summary') { loadPlc(m); plcTimer = setInterval(() => loadPlc(m), 30000); } else loadEnergy();
      loadChart(); loadEvents();
    };

    // PLC summary devices: the four headline numbers are the PLC's own totals
    const PLC_KPIS = [['kw_day', 'kW today', 'bolt', 'accent'], ['kwhrt_day', 'kWh-RT today', 'energy', 'teal'], ['kwh_total', 'kWh (PLC counter)', 'energy', ''], ['wh_l', 'Wh_L', 'gauge', '']];
    const plcKpis = (m) => PLC_KPIS.map(([k, label, ic, tone]) => { const mt = metaOf(m, k); return kpi('plc_' + k, mt ? mt.label : label, '-', { unit: mt ? mt.unit : '', iconName: ic, tone, cls: tone === 'accent' ? 'accent' : '' }); }).join('');
    const patchPlcKpis = (m) => { const v = m.values || {}; for (const [k] of PLC_KPIS) { const mt = metaOf(m, k) || { decimals: 1, unit: '' }; Views.patchKpi(el, 'plc_' + k, { num: v[k], fmt: (x) => fmtNum(x, mt.decimals), unit: mt.unit || '' }); } };
    let plcTimer = null;
    const loadPlc = async (m) => {
      if (!m.gatewayId || !$('#dPlc', el)) return;
      try {
        const g = (await api(`/api/gateways/${m.gatewayId}`)).gateway;
        const live = g.live || {}; const plc = live.plc;
        setHtml($('#dPlc .card-body', el), `<span class="badge ${live.connected ? 'ok' : 'critical'}">${live.connected ? 'CONNECTED' : 'DOWN'}</span>${plcStatusChip(plc)}<span class="mono" style="font-size:.7rem">${esc(g.host || '')}:${g.port || 102} · rack ${g.config?.rack ?? 0} slot ${g.config?.slot ?? 1}</span>${live.latencyMs !== null && live.latencyMs !== undefined ? `<span class="mono muted" style="font-size:.66rem">${live.latencyMs} ms</span>` : ''}<span class="muted" style="font-size:.66rem">${esc(plcLine(plc) || (live.lastError ? live.lastError : 'no diagnostics yet'))}</span><a class="btn xs right" href="#/gateways/${g.id}">Gateway</a>`);
      } catch (e) { /* ignore */ }
    };

    const patchGauges = (m) => {
      if (m.layout === 'plc-summary') { patchPlcKpis(m); return; }
      const v = m.values || {};
      const nomV = m.nominalV || 230;
      const pKw = v.p_total; const pPct = m.ratedKw ? pKw / m.ratedKw : null;
      const vAvg = v.v_ln_avg; const vDev = Number.isFinite(vAvg) ? (vAvg / nomV - 1) * 100 : null;
      const pf = Math.abs(v.pf); const iAvg = v.i_avg; const iPct = m.ratedA ? iAvg / m.ratedA : null;
      patchGauge(el, 'p', { val: pKw, d: 2, pct: pPct ?? (Number.isFinite(pKw) ? 0.5 : 0), cls: pPct === null ? '' : pPct > 1.2 ? 'bad' : pPct > 1 ? 'warn' : '', sub: m.ratedKw ? `${fmtNum((pPct || 0) * 100, 0)}% of ${m.ratedKw} kW rated` : 'rated kW not set' });
      patchGauge(el, 'v', { val: vAvg, d: 1, pct: Number.isFinite(vAvg) ? Math.min(1, vAvg / (nomV * 1.2)) : 0, cls: vDev === null ? '' : Math.abs(vDev) > 10 ? 'bad' : Math.abs(vDev) > 5 ? 'warn' : 'ok', sub: vDev === null ? '' : `${vDev >= 0 ? '+' : ''}${vDev.toFixed(1)}% vs ${nomV} V` });
      patchGauge(el, 'i', { val: iAvg, d: 1, pct: iPct ?? (Number.isFinite(iAvg) ? 0.4 : 0), cls: iPct === null ? 'teal' : iPct > 1.2 ? 'bad' : iPct > 1 ? 'warn' : 'teal', sub: m.ratedA ? `${fmtNum((iPct || 0) * 100, 0)}% of ${m.ratedA} A` : `max ${fmtNum(Math.max(v.ia || 0, v.ib || 0, v.ic || 0), 1)} A` });
      patchGauge(el, 'pf', { val: pf, d: 3, pct: pf || 0, cls: pf < 0.85 ? 'warn' : 'ok', sub: `${Number.isFinite(v.freq) ? v.freq.toFixed(2) + ' Hz' : ''}${Number.isFinite(v.q_total) ? ' · ' + fmtNum(v.q_total, 1) + ' kVAR' : ''}` });
    };

    // value groups: rebuilt only when the set of available keys changes, otherwise patched
    const has = (v, k) => Number.isFinite(v[k]);
    const groupsHtml = (m) => {
      const v = m.values || {};
      const rows = (keys) => keys.map((k) => { const mt = metaOf(m, k) || { label: k, unit: '' }; return `<div class="vrow"><i class="pd ${mt.phase || 'none'}"></i>${esc(mt.label)}<span class="v" data-k="${k}">-<small>${esc(mt.unit || '')}</small></span></div>`; }).join('');
      const phase = (m.phases || 3) === 3 && has(v, 'va') ? phaseTable(v) : '';
      const std = Object.entries(S.meta.groups).map(([gid, g]) => {
        const keys = S.meta.metrics.filter((mt) => mt.group === gid && has(v, mt.key)).map((mt) => mt.key);
        if (!keys.length) return '';
        return `<div class="vgroup"><div class="vgroup-head">${esc(g.label)}</div>${rows(keys)}</div>`;
      }).join('');
      // custom tags of the device, one card per configured group (matrix tags get their own table)
      const mk = matrixKeys(m);
      const groups = new Map();
      for (const t of customTags(m)) { if (mk.has(t.key)) continue; if (!groups.has(t.group)) groups.set(t.group, []); groups.get(t.group).push(t.key); }
      const custom = [...groups.entries()].map(([g, keys]) => `<div class="vgroup custom"><div class="vgroup-head">${icon('layers')} ${esc((S.meta.groups[g] || {}).label || g)}</div>${rows(keys)}</div>`).join('');
      return matrixHtml(m) + phase + custom + std;
    };
    const phaseTable = (v) => {
      const row = (label, ks, d) => (has(v, ks[0]) ? `<tr><td>${label}</td>${ks.map((k, i) => `<td class="num ph-${'abc'[i]}" data-k="${k}" data-d="${d}">-</td>`).join('')}</tr>` : '');
      return `<div class="vgroup" style="grid-column:span 2"><div class="vgroup-head">Per phase</div>
        <div style="padding:.6rem .9rem .2rem"><div class="phase-bars">${['A', 'B', 'C'].map((p, i) => `<div class="pbar ${p}"><i style="height:4%" data-pbar="${'abc'[i]}"></i><span>${p}</span></div>`).join('')}</div></div>
        <table class="phase-table"><thead><tr><th></th><th class="num" style="color:var(--ph-a)">Phase A</th><th class="num" style="color:var(--ph-b)">Phase B</th><th class="num" style="color:var(--ph-c)">Phase C</th></tr></thead><tbody>
        ${row('Voltage L-N (V)', ['va', 'vb', 'vc'], 1)}${row('Current (A)', ['ia', 'ib', 'ic'], 2)}${row('Active power (kW)', ['pa', 'pb', 'pc'], 2)}
        ${row('Reactive (kVAR)', ['qa', 'qb', 'qc'], 2)}${row('Apparent (kVA)', ['sa', 'sb', 'sc'], 2)}${row('Power factor', ['pfa', 'pfb', 'pfc'], 3)}
        ${row('THD V (%)', ['thd_va', 'thd_vb', 'thd_vc'], 1)}${row('THD I (%)', ['thd_ia', 'thd_ib', 'thd_ic'], 1)}</tbody></table></div>`;
    };
    const patchGroups = (m) => {
      const v = m.values || {};
      const sig = Object.keys(v).filter((k) => has(v, k)).sort().join(',') + '|' + m.phases + '|' + (m.tags || []).map((t) => t.key + t.group + t.label + (t.row || '') + (t.col || '')).join(',');
      const box = $('#dGroups', el);
      if (!box) return;
      if (sig !== groupSig) { groupSig = sig; box.innerHTML = groupsHtml(m); }
      $$('[data-k]', box).forEach((n) => {
        const k = n.dataset.k; const mt = metaOf(m, k) || { decimals: 2, unit: '' };
        if (n.classList.contains('mval')) { setNum(n, v[k], (x) => fmtNum(x, mt.decimals)); const al = (m.alarms || []).find((a) => a.type === 'tag:' + k); setCls(n, `mval ${al ? sevCls(al.severity) : ''}`); return; }
        if (n.classList.contains('v')) {
          setValNum(n, v[k], (x) => fmtNum(x, mt.decimals), mt.unit || '');
          const al = (m.alarms || []).find((a) => a.type === 'tag:' + k);
          setCls(n, `v ${al ? sevCls(al.severity) : fvCls(k === 'va' || k === 'vb' || k === 'vc' ? 'v_ln_avg' : k, v[k], m)}`);
        } else setNum(n, v[k], (x) => fmtNum(x, Number(n.dataset.d)));
      });
      const maxP = Math.max(v.pa || 0, v.pb || 0, v.pc || 0, 0.01);
      $$('[data-pbar]', box).forEach((b) => {
        setStyle(b, 'height', Math.max(4, ((v['p' + b.dataset.pbar] || 0) / maxP) * 100) + '%');
        setNum(b.parentElement.querySelector('span'), v['p' + b.dataset.pbar], (x) => `${b.dataset.pbar.toUpperCase()} ${fmtNum(x, 1)} kW`);
      });
    };
    const patchLive = (m) => {
      setCls($('#dLed', el), 'led ' + m.status);
      setHtml($('#dAlarms', el), statusBadge(m) + alarmBadges(m));
      patchGauges(m);
      patchGroups(m);
    };

    const loadEnergy = async () => {
      try {
        const e = await api(`/api/meters/${id}/energy`);
        const s = await api(`/api/meters/${id}/summary?from=${Date.now() - 86400000}`);
        setHtml($('#dEnergy', el), `${kpi('e1', 'Energy today', fmtNum(e.today, 1), { unit: 'kWh', iconName: 'energy', tone: 'teal', sub: `yesterday ${fmtNum(e.yesterday, 1)} kWh` })}
          ${kpi('e2', 'This month', fmtNum(e.month, 0), { unit: 'kWh', iconName: 'energy', sub: `last 24 h ${fmtNum(e.last24h, 1)} kWh` })}
          ${kpi('e3', 'Load 24 h', fmtNum(s.kwAvg, 1), { unit: 'kW avg', iconName: 'trend', sub: `max ${fmtNum(s.kwMax, 1)} · min ${fmtNum(s.kwMin, 1)} kW` })}
          ${kpi('e4', 'Voltage 24 h', fmtNum(s.vAvg, 1), { unit: 'V avg', iconName: 'wave', cls: s.vMin && s.vMin < (full.nominalV || 230) * 0.9 ? 'warn' : '', sub: `min ${fmtNum(s.vMin, 1)} · max ${fmtNum(s.vMax, 1)} V` })}
          ${kpi('e5', 'Alarms 24 h', s.eventCount, { iconName: 'bell', cls: s.eventCount ? 'warn' : 'ok', sub: s.events.map((x) => `${typeLabel(x.type)} ${x.count}`).join(' · ') || 'none' })}`);
      } catch (e) { /* ignore */ }
    };

    const loadChart = async () => {
      const mm = S.meters.get(id) || full;
      const g = chartGroupsFor(mm).find((x) => x.id === group) || CHART_GROUPS[0];
      const { from, to } = rangeMs();
      const box = $('#chartBox', el);
      box.classList.add('loading');
      try {
        const evRes = await api(`/api/events?meterId=${id}&from=${from}&to=${to}&limit=500`);
        events = evRes.events;
        let series; let data; let bars = false; let interval = autoInterval(from, to); let meta = '';
        if (g.hourly) {
          const h = await api(`/api/meters/${id}/hourly?from=${from}&to=${to}`);
          series = [{ key: 'kwh', label: 'kWh per hour', color: Charts.C.accent, decimals: 1, unit: 'kWh' }];
          data = [h.rows.map((r) => r.hour_start / 1000 + 1800), h.rows.map((r) => (Number.isFinite(r.kwh) ? r.kwh : null))];
          bars = true; interval = 'hourly';
          meta = `<span>${h.rows.length} hours</span>`;
        } else {
          const d = await api(`/api/meters/${id}/history?from=${from}&to=${to}&interval=${interval}&keys=${g.keys.join(',')}&limit=4000`);
          const keys = d.keys.filter((k) => d.rows.some((r) => Number.isFinite(r[k])));
          series = keys.map((k, i) => { const mt = metaOf(mm, k) || { label: k, decimals: 2, unit: '' }; return { key: k, label: mt.label, color: mt.phase ? Charts.C[mt.phase] : (k.endsWith('_total') || k === 'pf' || k === 'freq' || k === 'v_unbal' || k === 'demand_kw' ? Charts.C.accent : Charts.C['s' + ((i % 6) + 1)]), decimals: mt.decimals, unit: mt.unit }; });
          data = Charts.toData(d.rows, keys);
          meta = `<span>${d.rows.length} points · ${intervalLabel(interval)}${d.stride > 1 ? ' · decimated ×' + d.stride : ''}</span>`;
        }
        if (chart) chart.destroy();
        if (!series.length || !data[0].length) { box.innerHTML = '<div class="empty">No data in this range</div>'; chart = null; }
        else chart = Charts.timeSeries(box, { series, data, events, unit: g.unit, yMin: g.yMin ?? null, yMax: g.yMax ?? null, bars });
        const evTypes = [...new Set(events.map((e) => e.type))];
        $('#chartMeta', el).innerHTML = meta + evTypes.map((t) => `<span><i class="sw" style="background:${Charts.C.band[t] || Charts.C.band.default}"></i> ${typeLabel(t)} (${events.filter((e) => e.type === t).length})</span>`).join('');
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
      box.classList.remove('loading');
    };

    const loadEvents = async () => {
      const q = new URLSearchParams({ meterId: id, from: Date.now() - 30 * 86400000, limit: 300 });
      if (evFilter.severity) q.set('severity', evFilter.severity);
      if (evFilter.type) q.set('type', evFilter.type);
      if (evFilter.active) q.set('active', '1');
      const d = await api('/api/events?' + q.toString());
      setHtml($('#evTable', el), eventsTable(d.events, { hideMeter: true }));
      setText($('#evCount', el), `${d.events.length} events (last 30 days)`);
      bindAck(el, loadEvents);
    };

    return {
      scope: { meterIds: [id] },
      mount(root) { el = root; build(); timer = setInterval(() => { const m = S.meters.get(id); if (m) setText($('#dAgo', el), m.at ? fmtAgo(m.at) : '--'); }, 1000); },
      onReading(msg, m) {
        if (!m || m.id !== id || !el || !$('#dGauges', el)) return;
        patchLive(m);
        // live append on the raw chart when the window ends "now"
        if (chart && range.preset !== 'custom' && msg.status === 'ok') {
          const g = chartGroupsFor(m).find((x) => x.id === group) || CHART_GROUPS[0];
          if (!g.hourly && autoInterval(...Object.values(rangeMs())) === 'raw') {
            const v = m.values || {};
            const d = chart.u.data.map((arr) => arr.slice());
            d[0].push(msg.at / 1000);
            chart.u.series.slice(1).forEach((s, i) => { const key = s.label && g.keys.find((k) => (metaOf(m, k) || {}).label === s.label || k === s.label); d[i + 1].push(key && Number.isFinite(v[key]) ? v[key] : null); });
            const cutoff = rangeMs().from / 1000;
            while (d[0].length && d[0][0] < cutoff) d.forEach((arr) => arr.shift());
            chart.setData(d);
          }
        }
      },
      onEvent(msg) { if (msg.event.meterId === id && msg.action !== 'update') { loadEvents(); if (chart) loadChart(); } },
      destroy() { clearInterval(timer); clearInterval(plcTimer); if (chart) chart.destroy(); },
    };
  }

  /* ------------------------------------------------------------------
     Events table (shared)
     ------------------------------------------------------------------ */
  function eventsTable(events, { compact = false, hideMeter = false } = {}) {
    if (!events.length) return '<div class="empty" style="padding:1.5rem">No alarms in this range</div>';
    return `<table><thead><tr><th>Start</th><th>Duration</th>${hideMeter ? '' : '<th>Meter / gateway</th>'}<th>Type</th><th>Severity</th><th>Details</th>${compact ? '' : '<th>Acknowledged</th>'}</tr></thead><tbody>
      ${events.map((e) => `<tr class="${e.active ? 'active-evt' : ''} ${e.ackedAt ? 'acked' : ''}">
        <td class="mono nowrap">${fmtTime(e.startedAt)}</td>
        <td class="mono nowrap">${e.active ? `<span style="color:var(--crit)">● ${fmtDur(e.durationSec)}</span>` : fmtDur(e.durationSec)}</td>
        ${hideMeter ? '' : `<td>${e.meterId ? `<a href="#/meter/${e.meterId}" style="color:var(--text-1);text-decoration:none;font-weight:600">${esc(e.meterName)}</a><div class="muted" style="font-size:.6rem">${esc(e.plantName || '')}${e.lineName ? ' · ' + esc(e.lineName) : ''}</div>` : `<span class="proto">GW</span> ${esc(e.gatewayName || '')}`}</td>`}
        <td><span class="evt-type">${esc(typeLabel(e.type))}</span></td>
        <td><span class="evt-sev ${e.severity}"><i></i>${SEV_LABEL[e.severity]}</span></td>
        <td class="val-strong" style="font-weight:500">${esc(e.message || '')}</td>
        ${compact ? '' : `<td class="nowrap">${e.ackedAt ? `<span class="muted" title="${esc(e.ackNote || '')}">${icon('check')} ${esc(e.ackedBy)}<div style="font-size:.6rem">${fmtTime(e.ackedAt)}</div></span>` : (S.me.can.operator ? `<button class="btn xs" data-ack="${e.id}">${icon('check')} Ack</button>` : '<span class="muted">-</span>')}</td>`}
      </tr>`).join('')}</tbody></table>`;
  }
  function bindAck(root, reload) {
    $$('[data-ack]', root).forEach((b) => {
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const note = await promptDlg('Acknowledge alarm', { label: 'Note (optional)', ok: 'Acknowledge' });
        if (note === null) return;
        await api(`/api/events/${b.dataset.ack}/ack`, { body: { note } });
        toast('Acknowledged', 'ok');
        reload();
      };
    });
  }

  /* ------------------------------------------------------------------
     Gateways
     ------------------------------------------------------------------ */
  const BARS = 60;
  const gwStatus = (g) => (!g.enabled ? '' : g.live && g.live.connected ? 'ok' : 'crit');
  function gatewayCard(g) {
    return `<div class="gw ${gwStatus(g) === 'crit' ? 'down' : ''}" data-gw="${g.id}" onclick="location.hash='#/gateways/${g.id}'">
      <div class="tile-head"><i class="dot"></i>
        <div style="min-width:0"><div class="tile-title">${esc(g.name)}</div><div class="tile-sub">${esc(g.host || '')}${g.port ? ':' + g.port : ''} · ${esc(g.plantName || 'no plant')}</div></div>
        <span class="right proto">${esc(g.protocol)}</span></div>
      <div class="gw-body">
        <div class="stat-row" style="grid-template-columns:repeat(4,1fr)">
          <div class="stat"><div class="stat-label">Status</div><div class="stat-val" data-g="status">-</div></div>
          <div class="stat"><div class="stat-label">Latency</div><div class="stat-val" data-g="lat">-</div></div>
          <div class="stat"><div class="stat-label">Req/s</div><div class="stat-val" data-g="req">-</div></div>
          <div class="stat"><div class="stat-label">Meters</div><div class="stat-val" data-g="meters">-</div></div>
        </div>
        <div class="traffic"><span class="lbl">rx / tx</span><span class="rate" data-g="rate"></span>${Array.from({ length: BARS }, () => '<i style="height:2px"></i>').join('')}</div>
        <div class="gw-foot"><span data-g="up">-</span><span>·</span><span data-g="rc">-</span><span>·</span><span data-g="rx">-</span></div>
        <div class="gw-meters" data-g="squares"></div>
        <div class="row wrap" data-g="plc" style="gap:.4rem"></div>
        <div class="badge critical hide" data-g="err" style="align-self:flex-start"></div>
      </div></div>`;
  }
  // patch an existing card; called on every gateway snapshot (1/s on the gateways page)
  function patchGatewayCard(card, g) {
    const live = g.live;
    const st = gwStatus(g);
    setCls(card, `gw ${st === 'crit' ? 'down' : ''}`);
    setCls($('.tile-head .dot', card), `dot ${st}`);
    const sv = (k) => $(`[data-g="${k}"]`, card);
    setText(sv('status'), !g.enabled ? 'DISABLED' : live && live.connected ? 'ONLINE' : 'DOWN');
    setCls(sv('status'), `stat-val ${!g.enabled ? '' : live && live.connected ? 'ok' : 'bad'}`);
    setValNum(sv('lat'), live && live.latencyMs !== null && live.latencyMs !== undefined ? live.latencyMs : NaN, (x) => fmtNum(x, 0), 'ms');
    setValNum(sv('req'), live ? live.rate.reqPerSec : NaN, (x) => fmtNum(x, 1), live && live.rate.errPerSec ? `${fmtNum(live.rate.errPerSec, 1)} err` : '');
    setVal(sv('meters'), live ? live.metersOnline : g.metersTotal, `/ ${g.metersTotal}`);
    setCls(sv('meters'), `stat-val ${live && live.metersOnline === live.metersTotal ? 'ok' : 'warn'}`);
    setText(sv('rate'), live ? `↓ ${fmtRate(live.rate.rxBps)} ↑ ${fmtRate(live.rate.txBps)}` : '');
    const pc = sv('plc'); if (pc) { const plc = live && live.plc; setHtml(pc, plc ? `${plcStatusChip(plc)}<span class="muted" style="font-size:.62rem">${esc([plc.cpu && plc.cpu.moduleType, plc.orderCode, plc.firmware].filter(Boolean).join(' · '))}</span>` : ''); }
    const ring = live ? live.ring.slice(-BARS) : [];
    const maxRx = Math.max(1, ...ring.map((b) => b[0] + b[1]));
    $$('.traffic i', card).forEach((bar, i) => {
      const b = ring[i];
      setStyle(bar, 'height', b ? Math.max(2, ((b[0] + b[1]) / maxRx) * 100) + '%' : '2px');
      setCls(bar, b && b[3] ? 'err' : '');
    });
    setText(sv('up'), `up ${live && live.connectedSince ? fmtDur(live.uptimeSec) : '-'}`);
    setText(sv('rc'), `${live ? live.reconnects : 0} reconnects`);
    setText(sv('rx'), `${live ? fmtBytes(live.totals.bytesRx) : '-'} rx`);
    const sq = sv('squares');
    if (sq.children.length !== g.meters.length) sq.innerHTML = g.meters.map(() => '<i></i>').join('');
    g.meters.forEach((m, i) => { const n = sq.children[i]; setCls(n, m.status); if (n.title !== `${m.name} (unit ${m.unitId}) ${m.status}`) n.title = `${m.name} (unit ${m.unitId}) ${m.status}`; });
    const err = sv('err');
    if (st === 'crit' && live && live.lastError) { setText(err, live.lastError.slice(0, 80)); setCls(err, 'badge critical'); } else setCls(err, 'badge critical hide');
  }

  function gateways(openId) {
    let el; let list = []; let detail = null; let statChart = []; let logSig = '';
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
    const build = async () => {
      const d = await api('/api/gateways');
      list = d.gateways;
      setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'Gateways' }]);
      el.innerHTML = `
        <div class="page-head"><div><div class="page-title">Gateway monitor</div><div class="page-sub" id="gwSub"></div></div>
          <div class="page-actions">${S.me.can.admin ? `<button class="btn primary" id="gwAdd">${icon('plus')} Add gateway</button>` : ''}</div></div>
        <div class="kpis stagger">
          ${kpi('conn', 'Connected', '-', { iconName: 'router' })}
          ${kpi('req', 'Requests / s', '-', { iconName: 'trend', tone: 'teal' })}
          ${kpi('traffic', 'Traffic', '-', { iconName: 'wave', sub: 'rx + tx, last 10 s' })}
          ${kpi('lat', 'Avg latency', '-', { unit: 'ms', iconName: 'clock' })}
        </div>
        <div class="grid gws stagger" id="gwGrid">${list.map(gatewayCard).join('') || '<div class="empty" style="grid-column:1/-1">No gateways yet</div>'}</div>`;
      const add = $('#gwAdd', el); if (add) add.onclick = () => Settings.gatewayForm(null, build);
      patchAll();
      if (openId) openDetail(openId);
    };
    const patchAll = () => {
      const on = list.filter((g) => g.live && g.live.connected).length;
      const enabled = list.filter((g) => g.enabled).length;
      setText($('#gwSub', el), `${list.length} gateways · ${on} connected · ${list.reduce((a, g) => a + g.metersTotal, 0)} meters attached`);
      patchKpi(el, 'conn', { value: on, unit: `/ ${list.length}`, cls: on === enabled ? 'ok' : 'bad', tone: on === enabled ? 'ok' : 'bad' });
      patchKpi(el, 'req', { num: list.reduce((a, g) => a + (g.live ? g.live.rate.reqPerSec : 0), 0), sub: `${fmtNum(list.reduce((a, g) => a + (g.live ? g.live.rate.errPerSec : 0), 0), 2)} errors / s` });
      patchKpi(el, 'traffic', { value: fmtRate(list.reduce((a, g) => a + (g.live ? g.live.rate.rxBps + g.live.rate.txBps : 0), 0)) });
      patchKpi(el, 'lat', { num: avg(list.map((g) => g.live && g.live.latencyMs).filter(Number.isFinite)), fmt: (x) => fmtNum(x, 0), unit: `ms` });
      for (const g of list) { const card = $(`[data-gw="${g.id}"]`, el); if (card) patchGatewayCard(card, g); }
    };

    const openDetail = async (gid) => {
      const g = list.find((x) => x.id === gid) || (await api(`/api/gateways/${gid}`)).gateway;
      detail = gid; logSig = '';
      const p = modal.open(`${modal.head(g.name, `${g.protocol} · ${g.host || ''}${g.port ? ':' + g.port : ''} · ${g.plantName || ''}`, 'router')}
        <div class="kpis" id="gwKpis">
          ${kpi('status', 'Status', '-', {})}${kpi('lat', 'Latency', '-', { unit: 'ms' })}${kpi('req', 'Requests', '-', { unit: '/s' })}${kpi('traffic', 'Traffic', '-', { tone: 'teal' })}${kpi('meters', 'Meters', '-', {})}
        </div>
        <div id="gwPlc"></div>
        <div class="sec-title">Traffic (last 120 s) <span class="line"></span><span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">bytes/s · teal rx · amber tx · red = error</span></div>
        <div class="traffic" style="height:70px" id="gwTraffic">${Array.from({ length: 120 }, () => '<i style="height:2px"></i>').join('')}</div>
        <div class="sec-title">History (24 h) <span class="line"></span></div>
        <div class="form-grid" style="gap:.6rem"><div id="gwChartLat" style="min-height:160px"></div><div id="gwChartReq" style="min-height:160px"></div></div>
        <div class="sec-title">Meters on this gateway <span class="line"></span></div>
        <div class="table-wrap" style="max-height:260px"><table><thead><tr><th>Meter</th><th>Unit ID</th><th>Template</th><th>Poll</th><th>Status</th><th>Last OK</th><th>Latency</th><th>Error</th></tr></thead><tbody id="gwMeters"></tbody></table></div>
        <div class="sec-title">Connection log <span class="line"></span></div>
        <div class="gw-log" id="gwLog"></div>
        <div class="panel-foot">${S.me.can.admin ? `<button class="btn" id="gwEdit">${icon('edit')} Edit</button><button class="btn danger" id="gwDel">${icon('trash')} Delete</button>` : ''}<button class="btn right" onclick="modal.close()">Close</button></div>`,
      { wide: true, onClose: () => { detail = null; statChart.forEach((c) => c.destroy()); statChart = []; if (location.hash.startsWith('#/gateways/')) history.replaceState(null, '', '#/gateways'); } });
      patchDetail(g);
      const ed = $('#gwEdit', p); if (ed) ed.onclick = () => { modal.close(); Settings.gatewayForm(g.id, build); };
      const del = $('#gwDel', p); if (del) del.onclick = async () => { if (!await confirmDlg(`Delete gateway "${g.name}"?\nMeters attached to it will be detached and stop polling.`, { danger: true, ok: 'Delete' })) return; await api(`/api/admin/gateways/${g.id}`, { method: 'DELETE' }); modal.close(); toast('Deleted', 'ok'); build(); };
      try {
        const st = await api(`/api/gateways/${gid}/stats?hours=24`);
        const rows = st.rows;
        if (rows.length > 1) {
          statChart.push(Charts.timeSeries($('#gwChartLat', p), { series: [{ key: 'lat', label: 'Latency', color: Charts.C.teal, decimals: 0, unit: 'ms' }], data: [rows.map((r) => r.at / 1000), rows.map((r) => r.latency_ms)], height: 160, unit: 'ms' }));
          statChart.push(Charts.timeSeries($('#gwChartReq', p), { series: [{ key: 'ok', label: 'Requests OK', color: Charts.C.s1, decimals: 0, unit: '/min' }, { key: 'err', label: 'Errors', color: Charts.C.s2, decimals: 0, unit: '/min' }], data: [rows.map((r) => r.at / 1000), rows.map((r) => r.req_ok), rows.map((r) => r.req_err)], height: 160, unit: '/min' }));
        } else { $('#gwChartLat', p).innerHTML = '<div class="empty" style="padding:1rem">No statistics yet (sampled every minute)</div>'; }
      } catch (e) { /* ignore */ }
    };

    const patchDetail = (g) => {
      const live = g.live; const p = $('#modalPanel');
      if (!p || !$('#gwKpis', p)) return;
      const up = live && live.connected;
      patchKpi(p, 'status', { value: !g.enabled ? 'DISABLED' : up ? 'ONLINE' : 'DOWN', cls: up ? 'ok' : 'bad', tone: up ? 'ok' : 'bad', sub: live && live.connectedSince ? 'up ' + fmtDur(live.uptimeSec) : esc((live && live.lastError) || '') });
      patchKpi(p, 'lat', { num: live && live.latencyMs !== null ? live.latencyMs : NaN, fmt: (x) => fmtNum(x, 0), unit: `ms`, sub: live && live.avgLatencyMs !== null ? 'avg ' + live.avgLatencyMs + ' ms' : '' });
      patchKpi(p, 'req', { num: live ? live.rate.reqPerSec : NaN, unit: `/s`, sub: live ? `${live.totals.reqOk.toLocaleString()} ok · ${live.totals.reqErr.toLocaleString()} err total` : '' });
      patchKpi(p, 'traffic', { value: live ? fmtRate(live.rate.rxBps + live.rate.txBps) : '-', sub: live ? `${fmtBytes(live.totals.bytesRx)} rx · ${fmtBytes(live.totals.bytesTx)} tx` : '' });
      patchKpi(p, 'meters', { value: live ? String(live.metersOnline) : String(g.metersTotal), unit: live ? `/ ${live.metersTotal}` : '', cls: live && live.metersOnline === live.metersTotal ? 'ok' : 'warn', sub: `${live ? live.reconnects : 0} reconnects` });
      const plcBox = $('#gwPlc', p);
      if (plcBox && g.protocol === 'siemens-s7') {
        const plc = live && live.plc;
        const cell = (l, v) => `<div class="stat"><div class="stat-label">${l}</div><div class="stat-val" style="font-size:.78rem">${v === null || v === undefined || v === '' ? '-' : esc(String(v))}</div></div>`;
        setHtml(plcBox, `<div class="sec-title">PLC diagnostics <span class="line"></span>${plcStatusChip(plc)}</div>
          ${plc ? `<div class="stat-row" style="grid-template-columns:repeat(4,1fr);margin-bottom:.5rem">
            ${cell('CPU', plc.cpu ? plc.cpu.moduleType : null)}${cell('Order code', plc.orderCode)}${cell('Firmware', plc.firmware)}${cell('Serial', plc.cpu ? plc.cpu.serial : null)}
            ${cell('Station / AS name', plc.cpu ? [plc.cpu.asName, plc.cpu.moduleName].filter(Boolean).join(' / ') : null)}${cell('PLC clock', plc.plcTime ? fmtTime(plc.plcTime) + (plc.clockDriftSec !== null ? ' (' + (plc.clockDriftSec >= 0 ? '+' : '') + plc.clockDriftSec + ' s)' : '') : null)}
            ${cell('PDU', plc.pduLength ? plc.pduLength + ' B' : null)}${cell('Protection', plc.protection ? 'level ' + plc.protection.level + (plc.protection.mode ? ' · mode ' + plc.protection.mode : '') : null)}
            ${cell('Blocks', plc.blocks ? `OB ${plc.blocks.OB} · FB ${plc.blocks.FB} · FC ${plc.blocks.FC} · DB ${plc.blocks.DB}` : null)}${cell('Max connections', plc.cp ? plc.cp.maxConnections : null)}${cell('Diagnostics read', plc.at ? fmtAgo(plc.at) + ' · ' + plc.latencyMs + ' ms' : null)}${cell('Backend', plc.backend)}
          </div>${plc.errors && plc.errors.length ? `<div class="muted" style="font-size:.62rem">not answered by this CPU: ${esc(plc.errors.join(' · '))}</div>` : ''}` : '<div class="muted" style="font-size:.7rem">No diagnostics yet - read once the PLC connects (node-snap7 backend required)</div>'}`);
      }
      const ring = live ? live.ring : [];
      const maxV = Math.max(1, ...ring.map((b) => b[0] + b[1]));
      $$('#gwTraffic i', p).forEach((bar, i) => {
        const b = ring[i];
        setStyle(bar, 'height', b ? Math.max(2, ((b[0] + b[1]) / maxV) * 100) + '%' : '2px');
        setCls(bar, b && b[3] ? 'err' : b && b[1] > b[0] ? 'tx' : '');
      });
      // meters table: rows keyed by meter id, cells patched
      const tb = $('#gwMeters', p);
      if (!g.meters.length) { setHtml(tb, '<tr><td colspan="8" class="muted">No meters</td></tr>'); } else {
        if (tb.children.length !== g.meters.length || [...tb.children].some((tr, i) => Number(tr.dataset.m) !== g.meters[i].id)) {
          tb.innerHTML = g.meters.map((m) => `<tr class="click" data-m="${m.id}" onclick="modal.close();location.hash='#/meter/${m.id}'"><td class="val-strong">${esc(m.name)}</td><td class="mono">${m.unitId}</td><td class="mono">${esc(m.template)}</td><td class="mono">${m.pollMs || '-'} ms</td><td><span class="badge"></span></td><td class="mono"></td><td class="mono"></td><td class="muted" style="font-size:.64rem"></td></tr>`).join('');
        }
        g.meters.forEach((m, i) => {
          const tr = tb.children[i]; const td = tr.children;
          setText($('.badge', td[4]), m.status); setCls($('.badge', td[4]), `badge ${m.status === 'ok' ? 'ok' : m.status === 'offline' ? 'critical' : 'warn'}`);
          setText(td[5], m.lastOk ? fmtAgo(m.lastOk) : '-');
          setText(td[6], `${m.latencyMs ?? '-'} ms`);
          setText(td[7], m.lastError || '');
        });
      }
      const log = live ? live.log : [];
      const sig = log.length ? `${log.length}|${log[0].at}` : '0';
      if (sig !== logSig) { logSig = sig; setHtml($('#gwLog', p), log.map((l) => `<div class="l"><span class="t">${fmtTime(l.at)}</span><span class="${l.level}">${esc(l.text)}</span></div>`).join('') || '<span class="muted">no log</span>'); }
    };

    return {
      scope: { gateways: true },
      mount(root) { el = root; build(); },
      onGateways(msg) {
        if (!el) return;
        const snaps = msg.type === 'gateways' ? msg.gateways : [msg.gateway];
        for (const s of snaps) {
          const g = list.find((x) => x.id === s.id);
          if (!g) continue;
          g.live = { ...(g.live || {}), ...s, log: s.log || (g.live ? g.live.log : []) };
          for (const m of g.meters) { const lm = S.meters.get(m.id); if (lm) { m.status = lm.status; m.lastOk = lm.lastOk; m.latencyMs = lm.latencyMs; m.lastError = lm.lastError; } }
          if (detail === g.id && msg.type === 'gateway') api(`/api/gateways/${g.id}`).then((r) => { g.live = r.gateway.live; g.meters = r.gateway.meters; patchDetail(g); }).catch(() => {});
        }
        patchAll();
        if (detail !== null) { const g = list.find((x) => x.id === detail); if (g) patchDetail(g); }
      },
      destroy() { statChart.forEach((c) => c.destroy()); },
    };
  }

  /* ------------------------------------------------------------------
     Alarms
     ------------------------------------------------------------------ */
  function alarms() {
    let el; let f = { plantId: '', severity: '', type: '', state: 'active', preset: '7d' }; let reloadT;
    const load = async () => {
      const q = new URLSearchParams({ limit: 1000 });
      const p = RANGE_PRESETS.find((r) => r.id === f.preset);
      q.set('from', Date.now() - (p ? p.ms : 7 * 86400000));
      if (f.plantId) q.set('plantId', f.plantId);
      if (f.severity) q.set('severity', f.severity);
      if (f.type) q.set('type', f.type);
      if (f.state === 'active') q.set('active', '1');
      if (f.state === 'unacked') q.set('unacked', '1');
      const d = await api('/api/events?' + q.toString());
      const box = $('#alTable', el);
      if (!box) return;
      setHtml(box, eventsTable(d.events));
      setText($('#alCount', el), `${d.events.length} events`);
      const active = d.events.filter((e) => e.active);
      patchKpi(el, 'crit', { value: String(active.filter((e) => e.severity === 'critical').length) });
      patchKpi(el, 'err', { value: String(active.filter((e) => e.severity === 'error').length) });
      patchKpi(el, 'warn', { value: String(active.filter((e) => e.severity === 'warn').length) });
      patchKpi(el, 'unacked', { value: String(d.events.filter((e) => !e.ackedAt).length) });
      bindAck(el, load);
    };
    const build = () => {
      setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'Alarms' }]);
      el.innerHTML = `
        <div class="page-head"><div><div class="page-title">Alarms & events</div><div class="page-sub" id="alCount"></div></div>
          <div class="page-actions">${S.me.can.operator ? `<button class="btn" id="alAckAll">${icon('check')} Acknowledge all</button>` : ''}<button class="btn" id="alCsv">${icon('download')} CSV</button></div></div>
        <div class="kpis">${kpi('crit', 'Critical', '-', { cls: 'bad', tone: 'bad', iconName: 'alert' })}${kpi('err', 'Error', '-', { cls: 'bad', iconName: 'alert' })}${kpi('warn', 'Warning', '-', { cls: 'warn', tone: 'warn', iconName: 'bell' })}${kpi('unacked', 'Unacknowledged', '-', { iconName: 'bell', tone: 'teal' })}</div>
        <div class="filters">
          <div class="field"><label>Plant</label><select id="fPlant"><option value="">All plants</option>${S.tree.plants.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div>
          <div class="field"><label>Severity</label><select id="fSev"><option value="">All</option><option value="critical">Critical</option><option value="error">Error</option><option value="warn">Warn</option></select></div>
          <div class="field"><label>Type</label><select id="fType"><option value="">All</option>${Object.entries(TYPE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
          <div class="field"><label>State</label><select id="fState"><option value="active">Active</option><option value="unacked">Unacknowledged</option><option value="all">All</option></select></div>
          <div class="field"><label>Range</label><div class="presets">${RANGE_PRESETS.map((r) => `<span class="preset ${r.id === f.preset ? 'sel' : ''}" data-r="${r.id}">${r.label}</span>`).join('')}</div></div>
        </div>
        <div class="table-wrap" id="alTable" style="max-height:none"><div class="empty">loading...</div></div>`;
      $('#fPlant', el).onchange = (e) => { f.plantId = e.target.value; load(); };
      $('#fSev', el).onchange = (e) => { f.severity = e.target.value; load(); };
      $('#fType', el).onchange = (e) => { f.type = e.target.value; load(); };
      $('#fState', el).onchange = (e) => { f.state = e.target.value; load(); };
      $$('.presets .preset', el).forEach((p) => { p.onclick = () => { f.preset = p.dataset.r; $$('.presets .preset', el).forEach((x) => x.classList.toggle('sel', x === p)); load(); }; });
      $('#alCsv', el).onclick = () => window.open(`/api/events.csv?from=${Date.now() - (RANGE_PRESETS.find((r) => r.id === f.preset) || RANGE_PRESETS[3]).ms}`, '_blank');
      const aa = $('#alAckAll', el); if (aa) aa.onclick = async () => { if (!await confirmDlg('Acknowledge every active alarm' + (f.plantId ? ' of the selected plant' : '') + '?')) return; const r = await api('/api/events/ack-all', { body: { plantId: f.plantId || undefined } }); toast(`${r.acked} alarms acknowledged`, 'ok'); load(); };
      load();
    };
    return {
      scope: { all: true },
      mount(root) { el = root; build(); },
      onEvent(msg) { if (msg.action === 'update') return; clearTimeout(reloadT); reloadT = setTimeout(load, 500); },
      destroy() { clearTimeout(reloadT); },
    };
  }

  /* ------------------------------------------------------------------
     Export (page + modal)
     ------------------------------------------------------------------ */
  const exportFormHtml = (pre = {}) => {
    const groups = Object.entries(S.meta.groups);
    return `
      <div class="form-grid c3">
        <div class="field"><label>Plant</label><select id="exPlant"><option value="">All plants</option>${S.tree.plants.map((p) => `<option value="${p.id}" ${pre.plantId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
        <div class="field"><label>Production line</label><select id="exLine"><option value="">All lines</option></select></div>
        <div class="field"><label>Meters (optional selection)</label><div class="table-wrap" style="max-height:120px;padding:.3rem .5rem;font-size:.72rem" id="exMeters"></div></div>
      </div>
      <div class="form-grid c3" style="margin-top:.8rem">
        <div class="field"><label>From</label><input type="datetime-local" id="exFrom" value="${toLocalInput(pre.from || Date.now() - 86400000)}"></div>
        <div class="field"><label>To</label><input type="datetime-local" id="exTo" value="${toLocalInput(pre.to || Date.now())}"></div>
        <div class="field"><label>Resolution</label><select id="exInterval"><option value="raw">Every stored sample (raw)</option><option value="60">1-minute average</option><option value="300">5-minute average</option><option value="900" selected>15-minute average</option><option value="3600">Hourly average</option><option value="86400">Daily</option></select></div>
      </div>
      <div class="presets" style="margin:.5rem 0 .8rem;display:flex;gap:.3rem;flex-wrap:wrap"><span class="preset" data-days="0">Today</span><span class="preset" data-days="1">Yesterday</span><span class="preset" data-days="7">7 days</span><span class="preset" data-days="30">30 days</span><span class="preset" data-days="month">This month</span></div>
      <div class="field"><label>Values to include</label><div class="row wrap" id="exGroups">${groups.map(([id, g]) => `<label class="chip click sel" data-g="${id}"><input type="checkbox" checked style="accent-color:var(--accent)"> ${esc(g.label)}</label>`).join('')}</div></div>
      <div class="row wrap" style="margin-top:.8rem;gap:1.2rem">
        <div class="field check"><input type="checkbox" id="exEvents" checked><label for="exEvents">Include events.csv (alarm log)</label></div>
        <div class="field check"><input type="checkbox" id="exSummary" checked><label for="exSummary">Include summary.csv (per-meter statistics)</label></div>
      </div>
      <div class="sec-title">Data in the selected range <span class="line"></span></div>
      <div class="kpis" id="exStats" style="margin-bottom:.5rem"></div>
      <div class="muted" style="font-size:.66rem;line-height:1.6">CSV files carry a UTF-8 BOM (open directly in Excel) · timestamps in the server timezone · ZIP layout: meters/&lt;plant&gt;/&lt;line&gt;/&lt;meter&gt;.csv + summary.csv + events.csv</div>`;
  };

  function bindExportForm(root, pre = {}) {
    const lineSel = $('#exLine', root); const meterBox = $('#exMeters', root);
    const fillLines = () => {
      const pid = Number($('#exPlant', root).value);
      const p = S.tree.plants.find((x) => x.id === pid);
      lineSel.innerHTML = '<option value="">All lines</option>' + (p ? p.lines.map((l) => `<option value="${l.id}" ${pre.lineId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('') : '');
      fillMeters();
    };
    const fillMeters = () => {
      const pid = Number($('#exPlant', root).value); const lid = Number(lineSel.value);
      const ms = [...S.meters.values()].filter((m) => (!pid || m.plantId === pid) && (!lid || m.lineId === lid));
      meterBox.innerHTML = ms.map((m) => `<label style="display:flex;gap:.4rem;align-items:center;padding:.1rem 0"><input type="checkbox" value="${m.id}" style="accent-color:var(--accent)" ${pre.meterIds && pre.meterIds.includes(m.id) ? 'checked' : ''}> ${esc(m.name)} <span class="muted">${esc(m.lineName || '')}</span></label>`).join('') || '<span class="muted">No meters</span>';
      $$('input', meterBox).forEach((c) => { c.onchange = preview; });
      preview();
    };
    $('#exPlant', root).onchange = fillLines;
    lineSel.onchange = fillMeters;
    $$('.presets .preset', root).forEach((p) => {
      p.onclick = () => {
        const d = p.dataset.days; const now = new Date(); const start = new Date(now); start.setHours(0, 0, 0, 0);
        let from; let to = now.getTime();
        if (d === 'month') { start.setDate(1); from = start.getTime(); } else if (d === '0') from = start.getTime(); else if (d === '1') { from = start.getTime() - 86400000; to = start.getTime(); } else from = to - Number(d) * 86400000;
        $('#exFrom', root).value = toLocalInput(from); $('#exTo', root).value = toLocalInput(to); preview();
      };
    });
    $$('#exGroups .chip', root).forEach((c) => { c.querySelector('input').onchange = (e) => { c.classList.toggle('sel', e.target.checked); }; });
    ['exFrom', 'exTo', 'exInterval'].forEach((id) => { $('#' + id, root).onchange = preview; });
    const params = () => {
      const groups = $$('#exGroups .chip', root).filter((c) => c.querySelector('input').checked).map((c) => c.dataset.g);
      const keys = S.meta.metrics.filter((m) => m.stored && groups.includes(m.group)).map((m) => m.key);
      const meterIds = $$('input:checked', meterBox).map((c) => Number(c.value));
      return {
        plantId: $('#exPlant', root).value || undefined, lineId: lineSel.value || undefined, meterIds: meterIds.length ? meterIds : undefined,
        from: fromLocalInput($('#exFrom', root).value), to: fromLocalInput($('#exTo', root).value), interval: $('#exInterval', root).value, keys,
        includeEvents: $('#exEvents', root).checked, includeSummary: $('#exSummary', root).checked,
      };
    };
    let previewT;
    async function preview() {
      clearTimeout(previewT);
      previewT = setTimeout(async () => {
        try {
          const d = await api('/api/export/preview', { body: params() });
          $('#exStats', root).innerHTML = `${kpi('x1', 'Meters', d.meters, { iconName: 'gauge' })}${kpi('x2', 'Stored samples', d.samples.toLocaleString(), { iconName: 'energy', sub: `~${d.rowsOut.toLocaleString()} rows in CSV` })}${kpi('x3', 'Alarm events', d.events, { iconName: 'bell' })}${kpi('x4', 'Total energy', fmtNum(d.kwh, 1), { unit: 'kWh', cls: 'accent', iconName: 'bolt' })}`;
        } catch (e) { $('#exStats', root).innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
      }, 250);
    }
    fillLines();
    return { params };
  }

  function exportModal(pre = {}) {
    const p = modal.open(`${modal.head('Export history', pre.title || '', 'download')}${exportFormHtml(pre)}
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn grad right" id="exGo">${icon('download')} Download</button></div>`, { wide: true });
    const form = bindExportForm(p, pre);
    $('#exGo', p).onclick = () => runExport(form, $('#exGo', p));
  }

  async function runExport(form, btn) {
    const params = form.params();
    if (!params.from || !params.to || params.from >= params.to) { toast('Invalid time range', 'err'); return; }
    btn.disabled = true; btn.innerHTML = `${icon('refresh', 'spin')} Building file...`;
    try {
      const name = await downloadPost('/api/export', params, 'export.zip');
      toast(name, 'ok', 'Downloaded');
    } catch (e) { toast(e.message, 'err', 'Export failed'); }
    btn.disabled = false; btn.innerHTML = `${icon('download')} Download`;
  }

  function exporter() {
    let el;
    return {
      scope: { all: true },
      mount(root) {
        el = root;
        setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'Export' }]);
        el.innerHTML = `<div class="page-head"><div><div class="page-title">Export history</div><div class="page-sub">CSV / ZIP · pick plant, line or meters · choose time range and resolution</div></div></div>
          <div class="card"><div class="card-body">${exportFormHtml()}<div class="panel-foot"><button class="btn grad right" id="exGo">${icon('download')} Download</button></div></div></div>`;
        const form = bindExportForm(el);
        $('#exGo', el).onclick = () => runExport(form, $('#exGo', el));
      },
    };
  }

  /* ------------------------------------------------------------------
     API docs (in-app quick reference)
     ------------------------------------------------------------------ */
  function apiDocs() {
    return {
      scope: { all: true },
      mount(el) {
        setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'API' }]);
        const base = location.origin;
        el.innerHTML = `<div class="page-head"><div><div class="page-title">Public API</div><div class="page-sub">Expose readings to other systems (MES / ERP / BI / Node-RED) and accept readings pushed by devices</div></div>
          <div class="page-actions">${S.me.can.admin ? `<a class="btn primary" href="#/settings/api-keys">${icon('key')} Manage API keys</a>` : ''}</div></div>
          <div class="form-grid">
            <div class="card"><div class="card-head"><div class="card-title">Authentication</div></div><div class="card-body">
              <p style="font-size:.78rem;color:var(--text-2);line-height:1.7">Send the header <code class="mono">X-Api-Key: pc_xxxx</code> on every request (or <code class="mono">?api_key=</code> / <code class="mono">Authorization: Bearer</code>). Keys are created under Settings › API keys with scopes: <b>read</b> values, <b>write</b> acknowledge alarms, <b>ingest</b> push readings.</p>
              <div class="code">curl -H "X-Api-Key: pc_xxxx" ${base}/api/v1/meters/1/latest</div></div></div>
            <div class="card"><div class="card-head"><div class="card-title">Realtime WebSocket</div></div><div class="card-body">
              <p style="font-size:.78rem;color:var(--text-2);line-height:1.7">Connect to <code class="mono">ws://host/ws?api_key=pc_xxxx</code>, send <code class="mono">{"type":"sub","scope":{"lineId":3}}</code> and receive a <code class="mono">reading</code> message on every poll plus <code class="mono">event</code> messages when alarms start or end.</p>
              <div class="code">{"type":"reading","meterId":7,"at":1726900000000,"status":"ok",
 "alarm":null,"values":{"va":230.1,"p_total":42.5,"pf":0.93,...}}</div></div></div>
          </div>
          <div class="sec-title">Endpoints <span class="line"></span></div>
          <div class="table-wrap"><table><thead><tr><th>Method</th><th>Path</th><th>Scope</th><th>Description</th></tr></thead><tbody>
            ${[['GET', '/api/v1/ping', '-', 'Liveness check'], ['GET', '/api/v1/plants', 'read', 'Plant → line → section tree with live counters'], ['GET', '/api/v1/meters?plantId=&lineId=', 'read', 'All meters with latest values'], ['GET', '/api/v1/meters/:id', 'read', 'One meter (numeric id or code)'], ['GET', '/api/v1/meters/:id/latest', 'read', 'Latest values only (cheapest call)'], ['GET', '/api/v1/meters/:id/history?from=&to=&interval=&keys=', 'read', 'History, raw or averaged per interval (seconds)'], ['GET', '/api/v1/meters/:id/summary?from=&to=', 'read', 'kWh / load / voltage / alarm summary for a range'], ['GET', '/api/v1/meters/:id/hourly?from=&to=', 'read', 'Hourly rollups (kWh, kW avg/max, V min/max)'], ['GET', '/api/v1/events?from=&to=&active=1&severity=', 'read', 'Alarm log'], ['GET', '/api/v1/events/active', 'read', 'Open alarms'], ['POST', '/api/v1/events/:id/ack', 'write', 'Acknowledge an alarm'], ['POST', '/api/v1/ingest', 'ingest', 'Push readings from a device (ESP32, PLC, script)'], ['GET', '/api/v1/gateways', 'read', 'Gateway status + traffic'], ['GET', '/api/v1/demand', 'read', 'Peak-demand groups: projection, block state, stages'], ['POST', '/api/v1/demand/:id/auto', 'write', 'Enable / disable automatic load shedding'], ['POST', '/api/v1/demand/:id/stages/:sid/shed | restore', 'write', 'Manual shed / restore of a PLC stage'], ['GET', '/api/v1/metrics', 'read', 'List of metric keys']].map((r) => `<tr><td><span class="proto">${r[0]}</span></td><td class="mono" style="user-select:text">${esc(r[1])}</td><td class="mono">${r[2]}</td><td>${esc(r[3])}</td></tr>`).join('')}
          </tbody></table></div>
          <div class="sec-title">Ingest (devices pushing readings) <span class="line"></span></div>
          <div class="form-grid"><div class="code">POST ${base}/api/v1/ingest
X-Api-Key: pc_xxxx
Content-Type: application/json

{ "meter": "L1-PM01",
  "values": { "va": 230.5, "vb": 229.8, "vc": 231.0,
              "ia": 12.3, "p_total": 8.2, "pf": 0.95,
              "freq": 50.01, "kwh_import": 123456.7 } }</div>
          <div class="code"># batch
{ "readings": [
  { "meter": "PULSE-01", "values": { "kwh_import": 1200.5, "p_total": 3.1 } },
  { "meter": 12, "at": 1726900000000, "values": { "p_total": 5.0 } }
] }</div></div>
          <div class="muted" style="font-size:.66rem;margin-top:.6rem">Create push meters under Settings › Meters with a gateway of type "Push API" (or no gateway) and a code matching what the device sends · full reference: docs/API.md and sdk/</div>`;
      },
    };
  }

  return { overview, plant, line, meter, gateways, alarms, exporter, apiDocs, faceHtml, patchFace, eventsTable, bindAck, exportModal, gatewayCard, patchGatewayCard, kpi, patchKpi };
})();
