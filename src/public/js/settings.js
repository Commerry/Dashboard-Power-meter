/* =====================================================================
   settings.js - admin pages (structure, gateways, meters, users, API keys, system)
   ===================================================================== */
const Settings = (() => {
  const TABS = [
    { id: 'structure', label: 'Plants / lines', icon: 'factory' },
    { id: 'gateways', label: 'Gateways', icon: 'router' },
    { id: 'plc', label: 'PLC (Siemens S7)', icon: 'cpu' },
    { id: 'meters', label: 'Meters & devices', icon: 'gauge' },
    { id: 'demand', label: 'Peak demand', icon: 'trend' },
    { id: 'users', label: 'Users', icon: 'users' },
    { id: 'api-keys', label: 'API keys', icon: 'key' },
    { id: 'system', label: 'System', icon: 'settings' },
  ];
  const adm = (path, opts) => api('/api/admin' + path, opts);
  const sel = (id, options, value, { blank = '' } = {}) => `<select id="${id}">${blank !== null ? `<option value="">${esc(blank)}</option>` : ''}${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  const val = (id, root) => { const e = $('#' + id, root); return e ? (e.type === 'checkbox' ? e.checked : e.value) : undefined; };
  const numOrUndef = (v) => (v === '' || v === undefined ? null : Number(v));

  /* ------------------------------------------------------------------ page */
  function page(tab) {
    let el;
    const render = async () => {
      setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'Settings' }, { label: TABS.find((t) => t.id === tab)?.label || tab }]);
      el.innerHTML = `<div class="page-head"><div><div class="page-title">Settings</div><div class="page-sub">admin only · changes apply immediately (acquisition engine reloads automatically)</div></div></div>
        <div class="tabs">${TABS.map((t) => `<a class="tab ${t.id === tab ? 'active' : ''}" href="#/settings/${t.id}">${icon(t.icon)} ${t.label}</a>`).join('')}</div>
        <div id="tabBody"><div class="empty">loading...</div></div>`;
      const body = $('#tabBody', el);
      const fn = { structure: structureTab, gateways: gatewaysTab, plc: plcTab, meters: metersTab, demand: demandTab, users: usersTab, 'api-keys': apiKeysTab, system: systemTab }[tab] || structureTab;
      await fn(body);
    };
    return { scope: { all: true }, mount(root) { el = root; return render(); } };
  }

  /* ------------------------------------------------------------------ structure */
  async function structureTab(body) {
    const t = await api('/api/tree');
    S.tree = t;
    const draw = () => {
      body.innerHTML = `<div class="row" style="margin-bottom:.8rem"><button class="btn primary" id="addPlant">${icon('plus')} Add plant</button><span class="muted" style="font-size:.7rem">plant → production line → section (a part of a line) · meters are attached to a line / section in the "Meters" tab</span></div>
        <div class="tree">${t.plants.map((p, pi) => `
          <div class="tree-plant">
            <div class="th">${icon('factory')} ${esc(p.name)} <span class="muted mono" style="font-size:.66rem">${esc(p.code || '')}${p.province ? ' · ' + esc(p.province) : ''} · ${p.lines.length} lines · ${p.meters} meters</span>
              <div class="tree-actions">
                <button class="gbtn" title="Move up" ${pi === 0 ? 'disabled' : ''} data-act="plant-up" data-id="${p.id}">${icon('chevd', '')}</button>
                <button class="gbtn" title="Add line" data-act="line-add" data-id="${p.id}">${icon('plus')}</button>
                <button class="gbtn" title="Edit" data-act="plant-edit" data-id="${p.id}">${icon('edit')}</button>
                <button class="gbtn" title="Delete" data-act="plant-del" data-id="${p.id}">${icon('trash')}</button></div></div>
            ${p.lines.map((l, li) => `<div class="tree-line">${icon('line')} <b>${esc(l.name)}</b><span class="muted mono" style="font-size:.64rem">${esc(l.code || '')} · ${l.meters} meters</span>
              <div class="tree-sections">${l.sections.map((s) => `<span class="chip click" title="Click to rename / delete" data-act="sec-menu" data-id="${s.id}" data-line="${l.id}">${esc(s.name)} <span class="muted">${s.meters}</span></span>`).join('')}<span class="chip click" data-act="sec-add" data-id="${l.id}">${icon('plus')} section</span></div>
              <div class="tree-actions">
                <button class="gbtn" ${li === 0 ? 'disabled' : ''} data-act="line-up" data-id="${l.id}" data-plant="${p.id}" title="Move up">${icon('chevd')}</button>
                <a class="gbtn" href="#/line/${l.id}" title="Open line dashboard">${icon('external')}</a>
                <button class="gbtn" data-act="line-edit" data-id="${l.id}" title="Edit">${icon('edit')}</button>
                <button class="gbtn" data-act="line-del" data-id="${l.id}" title="Delete">${icon('trash')}</button></div></div>`).join('') || '<div class="tree-line muted">No production lines yet</div>'}
          </div>`).join('') || '<div class="empty">No plants yet</div>'}</div>`;
      $('#addPlant', body).onclick = () => plantForm(null, reload);
      $$('[data-act]', body).forEach((b) => { b.onclick = (ev) => act(b.dataset.act, b, ev); });
      $$('.gbtn[data-act$="-up"] .icon', body).forEach((i) => { i.style.transform = 'rotate(180deg)'; });
    };
    const reload = async () => { const nt = await api('/api/tree'); t.plants = nt.plants; t.unassigned = nt.unassigned; S.tree = nt; S.navSig = ''; renderNav(); draw(); };
    const act = async (a, b, ev) => {
      const id = Number(b.dataset.id);
      const plant = t.plants.find((p) => p.id === id) || t.plants.find((p) => p.lines.some((l) => l.id === id)) || t.plants.find((p) => p.id === Number(b.dataset.plant));
      const line = plant ? plant.lines.find((l) => l.id === id) || plant.lines.find((l) => l.id === Number(b.dataset.line)) : null;
      if (a === 'plant-edit') return plantForm(t.plants.find((p) => p.id === id), reload);
      if (a === 'plant-del') { const p = t.plants.find((x) => x.id === id); if (!await confirmDlg(`Delete plant "${p.name}"?\n${p.lines.length} lines and their sections will be removed. ${p.meters} meters become "unassigned" (history is kept).`, { danger: true, ok: 'Delete plant' })) return; await adm(`/plants/${id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); return reload(); }
      if (a === 'plant-up') { const ids = t.plants.map((p) => p.id); const i = ids.indexOf(id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await adm('/plants/reorder', { body: { ids } }); return reload(); }
      if (a === 'line-add') return lineForm(null, id, reload);
      if (a === 'line-edit') return lineForm(line, plant.id, reload);
      if (a === 'line-del') { if (!await confirmDlg(`Delete line "${line.name}"?\n${line.meters} meters become "unassigned".`, { danger: true, ok: 'Delete line' })) return; await adm(`/lines/${id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); return reload(); }
      if (a === 'line-up') { const ids = plant.lines.map((l) => l.id); const i = ids.indexOf(id); [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; await adm('/lines/reorder', { body: { ids } }); return reload(); }
      if (a === 'sec-add') { const name = await promptDlg('Add section', { label: 'Section name (e.g. Extruder, Packing)' }); if (!name || !name.trim()) return; await adm('/sections', { body: { lineId: id, name: name.trim() } }); return reload(); }
      if (a === 'sec-menu') {
        const s = line.sections.find((x) => x.id === id);
        return openMenu(ev, [
          { label: 'Rename', icon: 'edit', onClick: async () => { const name = await promptDlg('Section name', { value: s.name }); if (!name || !name.trim()) return; await adm(`/sections/${id}`, { method: 'PATCH', body: { name: name.trim() } }); reload(); } },
          { label: 'Delete section', icon: 'trash', danger: true, onClick: async () => { if (!await confirmDlg(`Delete section "${s.name}"? Its meters stay in the line.`, { danger: true, ok: 'Delete' })) return; await adm(`/sections/${id}`, { method: 'DELETE' }); reload(); } },
        ], s.name);
      }
      return null;
    };
    draw();
  }

  function plantForm(p, onDone) {
    const root = modal.open(`${modal.head(p ? 'Edit plant' : 'Add plant', '', 'factory')}
      <div class="form-grid">
        <div class="field span2"><label>Plant / site name *</label><input id="pName" value="${esc(p?.name || '')}" placeholder="e.g. Samut Prakan Plant"></div>
        <div class="field"><label>Code</label><input id="pCode" value="${esc(p?.code || '')}" placeholder="SPK"></div>
        <div class="field"><label>Province</label><input id="pProv" value="${esc(p?.province || '')}"></div>
        <div class="field span2"><label>Address / notes</label><input id="pAddr" value="${esc(p?.address || '')}"></div>
      </div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="pSave">Save</button></div>`, { narrow: true });
    $('#pName', root).focus();
    $('#pSave', root).onclick = async () => {
      const body = { name: val('pName', root), code: val('pCode', root), province: val('pProv', root), address: val('pAddr', root) };
      if (!body.name.trim()) return toast('Plant name is required', 'err');
      try { await (p ? adm(`/plants/${p.id}`, { method: 'PATCH', body }) : adm('/plants', { body })); modal.close(); toast('Saved', 'ok'); onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  function lineForm(l, plantId, onDone) {
    const root = modal.open(`${modal.head(l ? 'Edit production line' : 'Add production line', '', 'line')}
      <div class="form-grid">
        <div class="field span2"><label>Line name *</label><input id="lName" value="${esc(l?.name || '')}" placeholder="e.g. Line 1 - Extrusion"></div>
        <div class="field"><label>Code</label><input id="lCode" value="${esc(l?.code || '')}" placeholder="L1"></div>
        <div class="field"><label>Plant</label>${sel('lPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), plantId, { blank: null })}</div>
      </div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="lSave">Save</button></div>`, { narrow: true });
    $('#lName', root).focus();
    $('#lSave', root).onclick = async () => {
      const body = { name: val('lName', root), code: val('lCode', root), plantId: Number(val('lPlant', root)) };
      if (!body.name.trim()) return toast('Line name is required', 'err');
      try { await (l ? adm(`/lines/${l.id}`, { method: 'PATCH', body }) : adm('/lines', { body })); modal.close(); toast('Saved', 'ok'); onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ gateways */
  async function gatewaysTab(body) {
    const d = await api('/api/gateways');
    d.gateways = d.gateways.filter((g) => g.protocol !== 'siemens-s7');
    body.innerHTML = `<div class="row" style="margin-bottom:.8rem;flex-wrap:wrap"><button class="btn primary" id="gwAdd">${icon('plus')} Add gateway</button><span class="muted" style="font-size:.7rem">meters are read through a gateway (Link150 / EGX / serial server / MQTT broker / HTTP / push) · protocols: ${S.meta.protocols.filter((p) => p.id !== 'siemens-s7').map((p) => p.id).join(', ')} · Siemens PLCs are configured on the <a href="#/settings/plc">PLC page</a></span></div>
      <div class="table-wrap" style="max-height:none"><table><thead><tr><th>Gateway</th><th>Plant</th><th>Protocol</th><th>Host</th><th>Meters</th><th>Status</th><th>Config</th><th></th></tr></thead><tbody>
        ${d.gateways.map((g) => `<tr><td class="val-strong">${esc(g.name)}${g.notes ? `<div class="muted" style="font-size:.6rem">${esc(g.notes)}</div>` : ''}</td><td>${esc(g.plantName || '-')}</td><td><span class="proto">${esc(g.protocol)}</span></td><td class="mono">${esc(g.host || '-')}${g.port ? ':' + g.port : ''}</td><td class="mono">${g.metersTotal}</td>
          <td>${!g.enabled ? '<span class="badge neutral">disabled</span>' : g.live && g.live.connected ? '<span class="badge ok">online</span>' : '<span class="badge critical">down</span>'}</td>
          <td class="mono muted" style="font-size:.62rem">${esc(JSON.stringify(g.config || {}).slice(0, 60))}</td>
          <td class="nowrap"><button class="gbtn" data-edit="${g.id}" title="Edit">${icon('edit')}</button><button class="gbtn" data-del="${g.id}" title="Delete">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No gateways yet</td></tr>'}
      </tbody></table></div>`;
    const reload = () => gatewaysTab(body);
    $('#gwAdd', body).onclick = () => gatewayForm(null, reload);
    $$('[data-edit]', body).forEach((b) => { b.onclick = () => gatewayForm(Number(b.dataset.edit), reload); });
    $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const g = d.gateways.find((x) => x.id === Number(b.dataset.del)); if (!await confirmDlg(`Delete gateway "${g.name}"?\n${g.metersTotal} meters will be detached and stop polling.`, { danger: true, ok: 'Delete' })) return; await adm(`/gateways/${g.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); reload(); }; });
  }

  async function gatewayForm(id, onDone) {
    const g = id ? (await api(`/api/gateways/${id}`)).gateway : { protocol: 'modbus-tcp', port: 502, enabled: true, config: {} };
    if (g.protocol === 'siemens-s7') return plcForm(id, null, onDone);
    const protos = S.meta.protocols.filter((p) => p.id !== 'siemens-s7');
    const root = modal.open(`${modal.head(id ? 'Edit gateway' : 'Add gateway', id ? g.name : '', 'router')}
      <div class="form-grid c3">
        <div class="field span2"><label>Name *</label><input id="gName" value="${esc(g.name || '')}" placeholder="e.g. GW-SPK-01 (Link150)"></div>
        <div class="field"><label>Plant</label>${sel('gPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), g.plantId, { blank: 'not set' })}</div>
        <div class="field"><label>Protocol</label>${sel('gProto', protos.map((p) => ({ value: p.id, label: p.name + (p.available ? '' : ' (module missing)') })), g.protocol, { blank: null })}</div>
        <div class="field"><label>Host / IP <span class="muted" id="gHostHint"></span></label><input id="gHost" value="${esc(g.host || '')}" placeholder="10.10.1.21"></div>
        <div class="field"><label>Port</label><input id="gPort" type="number" value="${g.port ?? ''}"></div>
        <div class="field"><label>Timeout (ms)</label><input id="gTimeout" type="number" value="${g.config.timeoutMs ?? 2000}"></div>
        <div class="field"><label>Delay between requests (ms)</label><input id="gInter" type="number" value="${g.config.interRequestMs ?? 0}"><div class="hint">some RS-485 gateways need 10-50 ms</div></div>
        <div class="field"><label>Max words per read</label><input id="gMaxWords" type="number" value="${g.config.maxWordsPerRead ?? 120}"></div>
        <div id="gExtra" class="span3 form-grid c3" style="gap:.8rem"></div>
        <div class="field span2"><label>Notes</label><input id="gNotes" value="${esc(g.notes || '')}"></div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="gEnabled" ${g.enabled ? 'checked' : ''}><label for="gEnabled">Enabled</label></div>
      </div>
      <div class="test-result" id="gTest"></div>
      <div class="panel-foot"><button class="btn" id="gTestBtn">${icon('play')} Test connection</button><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="gSave">Save</button></div>`, { wide: true });
    const extra = () => {
      const p = val('gProto', root);
      const c = g.config || {};
      $('#gHostHint', root).textContent = p === 'modbus-rtu' ? '(serial port, e.g. COM3 or /dev/ttyUSB0)' : p === 'push' || p === 'simulator' ? '(not needed)' : '';
      let html = '';
      if (p === 'modbus-rtu') html = `<div class="field"><label>Baud rate</label>${sel('gBaud', [9600, 19200, 38400, 57600, 115200].map((b) => ({ value: b, label: b })), c.serial?.baudRate || 9600, { blank: null })}</div><div class="field"><label>Parity</label>${sel('gParity', ['none', 'even', 'odd'].map((x) => ({ value: x, label: x })), c.serial?.parity || 'none', { blank: null })}</div><div class="field"><label>Stop bits</label>${sel('gStop', [1, 2].map((x) => ({ value: x, label: x })), c.serial?.stopBits || 1, { blank: null })}</div>`;
      if (p === 'mqtt') html = `<div class="field"><label>Username</label><input id="gUser" value="${esc(c.username || '')}"></div><div class="field"><label>Password</label><input id="gPass" type="password" value="${esc(c.password || '')}"></div><div class="field check" style="align-self:end"><input type="checkbox" id="gTls" ${c.tls ? 'checked' : ''}><label for="gTls">TLS (mqtts)</label></div><div class="hint span3 muted" style="font-size:.64rem">each meter defines its topic in the meter settings (+ and # wildcards supported) · payloads are JSON, fields are mapped to metrics</div>`;
      if (p === 'http') html = `<div class="field span3"><label>Headers (JSON)</label><input id="gHeaders" value="${esc(JSON.stringify(c.headers || {}))}" placeholder='{"Authorization":"Bearer ..."}'></div>`;
      if (p === 'simulator') html = `<div class="field"><label>Latency (ms)</label><input id="gSimLat" type="number" value="${c.latencyMs ?? 40}"></div><div class="field"><label>Fail rate (0-1)</label><input id="gSimFail" type="number" step="0.01" value="${c.failRate ?? 0.01}"></div><div class="field"><label>Event rate (0-1)</label><input id="gSimEvt" type="number" step="0.001" value="${c.eventRate ?? 0.002}"></div>`;
      if (p === 'push') html = `<div class="hint span3 muted" style="font-size:.66rem;line-height:1.6">devices POST readings to <code class="mono">/api/v1/ingest</code> with an API key of scope "ingest" · meters attached to this gateway count their traffic here</div>`;
      $('#gExtra', root).innerHTML = html;
      // inter-request delay / words per read only mean something for Modbus
      ['gInter', 'gMaxWords'].forEach((k) => { const f = $('#' + k, root); if (f) f.closest('.field').classList.toggle('hide', !p.startsWith('modbus')); });
      const proto = protos.find((x) => x.id === p);
      if (proto && !id && !$('#gPort', root).value) $('#gPort', root).value = proto.defaultPort || '';
      $('#gTestBtn', root).style.display = proto && proto.kind === 'poll' ? '' : 'none';
    };
    $('#gProto', root).onchange = () => { $('#gPort', root).value = (protos.find((x) => x.id === val('gProto', root)) || {}).defaultPort || ''; extra(); };
    extra();
    const collect = () => {
      const p = val('gProto', root);
      const config = { timeoutMs: numOrUndef(val('gTimeout', root)), interRequestMs: numOrUndef(val('gInter', root)), maxWordsPerRead: numOrUndef(val('gMaxWords', root)) };
      if (p === 'modbus-rtu') config.serial = { path: val('gHost', root), baudRate: Number(val('gBaud', root)), parity: val('gParity', root), stopBits: Number(val('gStop', root)), dataBits: 8 };
      if (p === 'mqtt') Object.assign(config, { username: val('gUser', root), password: val('gPass', root), tls: val('gTls', root) });
      if (p === 'http') { try { config.headers = JSON.parse(val('gHeaders', root) || '{}'); } catch (e) { config.headers = {}; } }
      if (p === 'simulator') Object.assign(config, { latencyMs: numOrUndef(val('gSimLat', root)), failRate: numOrUndef(val('gSimFail', root)), eventRate: numOrUndef(val('gSimEvt', root)) });
      return { name: val('gName', root), plantId: val('gPlant', root) || null, protocol: p, host: val('gHost', root), port: numOrUndef(val('gPort', root)), config, notes: val('gNotes', root), enabled: val('gEnabled', root) };
    };
    $('#gTestBtn', root).onclick = async () => {
      const b = $('#gTestBtn', root); b.disabled = true; b.innerHTML = `${icon('refresh', 'spin')} Testing`;
      const out = $('#gTest', root);
      try {
        const r = await adm('/gateways/test', { body: { ...collect(), meter: { template: 'schneider-pm5xxx', unitId: 1 } }, allowFail: true });
        out.innerHTML = r.success ? `<div class="badge ok">Connected · connect ${r.connectMs} ms · read unit 1 ${r.errors ? 'with errors: ' + esc(r.lastError) : 'OK in ' + r.latencyMs + ' ms'}</div>${Object.keys(r.values).length ? `<div class="test-values">${Object.entries(r.values).slice(0, 12).map(([k, v]) => `<div class="fv"><div class="fv-label">${k}</div><div class="fv-val">${fmtMetric(k, v)}<small>${unitOf(k)}</small></div></div>`).join('')}</div>` : ''}` : `<div class="badge critical">${esc(r.error || 'failed')}</div>`;
      } catch (e) { out.innerHTML = `<div class="badge critical">${esc(e.message)}</div>`; }
      b.disabled = false; b.innerHTML = `${icon('play')} Test connection`;
    };
    $('#gSave', root).onclick = async () => {
      const b = collect();
      if (!b.name.trim()) return toast('Gateway name is required', 'err');
      try { await (id ? adm(`/gateways/${id}`, { method: 'PATCH', body: b }) : adm('/gateways', { body: b })); modal.close(); toast('Saved', 'ok'); onDone && onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ meters */
  async function metersTab(body) {
    const q = new URLSearchParams((location.hash.split('?')[1] || ''));
    const f = { plant: '', line: q.get('line') || '', gateway: '', search: '' };
    const draw = async () => {
      const [ms, gws] = await Promise.all([api('/api/meters'), api('/api/gateways')]);
      const plcIds = new Set(gws.gateways.filter((g) => g.protocol === 'siemens-s7').map((g) => g.id));
      gws.gateways = gws.gateways.filter((g) => !plcIds.has(g.id));
      ms.meters = ms.meters.filter((m) => !plcIds.has(m.gatewayId));
      const rows = ms.meters.filter((m) => (!f.plant || m.plantId === Number(f.plant)) && (!f.line || m.lineId === Number(f.line)) && (!f.gateway || m.gatewayId === Number(f.gateway)) && (!f.search || (m.name + ' ' + (m.code || '')).toLowerCase().includes(f.search.toLowerCase())));
      body.innerHTML = `<div class="filters">
          <button class="btn primary" id="mAdd">${icon('plus')} Add device</button><button class="btn" id="mBulk">${icon('layers')} Bulk add</button>
          <div class="field"><label>Plant</label>${sel('mfPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), f.plant, { blank: 'All' })}</div>
          <div class="field"><label>Line</label>${sel('mfLine', S.tree.plants.flatMap((p) => p.lines.map((l) => ({ value: l.id, label: p.code ? p.code + ' · ' + l.name : l.name }))), f.line, { blank: 'All' })}</div>
          <div class="field"><label>Gateway</label>${sel('mfGw', gws.gateways.map((g) => ({ value: g.id, label: g.name })), f.gateway, { blank: 'All' })}</div>
          <div class="field"><label>Search</label><input id="mfSearch" value="${esc(f.search)}" placeholder="name / code"></div>
          <span class="muted right" style="font-size:.7rem">${rows.length} / ${ms.meters.length} meters${plcIds.size ? ` · PLC variable sets are on the <a href="#/settings/plc">PLC page</a>` : ''}</span></div>
        <div class="table-wrap" style="max-height:none"><table><thead><tr><th>Device</th><th>Plant / line / section</th><th>Gateway / PLC</th><th>Unit</th><th>Template</th><th>Tags</th><th>Poll</th><th>Rated</th><th>Status</th><th></th></tr></thead><tbody>
          ${rows.map((m) => `<tr class="${m.enabled ? '' : 'acked'}"><td><a href="#/meter/${m.id}" class="val-strong" style="text-decoration:none;color:var(--text-1)">${esc(m.name)}</a><div class="muted mono" style="font-size:.6rem">${esc(m.code || '')}</div></td>
            <td style="font-size:.7rem">${esc(m.plantName || '-')}<div class="muted">${esc(m.lineName || 'unassigned')}${m.sectionName ? ' / ' + esc(m.sectionName) : ''}</div></td>
            <td style="font-size:.7rem">${esc(m.gatewayName || '<span class="muted">-</span>')}</td><td class="mono">${m.unitId}</td><td class="mono" style="font-size:.64rem">${esc(m.template)}</td><td class="mono">${(m.tags || []).length}${(m.tags || []).some((t) => t.custom) ? ' <span class="evt-type">custom</span>' : ''}</td><td class="mono">${m.pollMs || S.meta.config.defaultPollMs}</td>
            <td class="mono" style="font-size:.64rem">${m.ratedKw ? m.ratedKw + ' kW' : ''}${m.ratedA ? ' / ' + m.ratedA + ' A' : ''}<div class="muted">${m.nominalV} V · ${m.phases}ph</div></td>
            <td>${!m.enabled ? '<span class="badge neutral">disabled</span>' : m.status === 'ok' ? '<span class="badge ok">ok</span>' : m.status === 'offline' ? '<span class="badge critical">offline</span>' : `<span class="badge warn">${esc(m.status)}</span>`}</td>
            <td class="nowrap"><button class="gbtn" data-edit="${m.id}" title="Edit">${icon('edit')}</button><button class="gbtn" data-copy="${m.id}" title="Duplicate">${icon('copy')}</button><button class="gbtn" data-del="${m.id}" title="Delete">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="10" class="muted">No devices</td></tr>'}
        </tbody></table></div>`;
      $('#mAdd', body).onclick = () => meterForm(null, draw, { lineId: f.line ? Number(f.line) : null, plantId: f.plant ? Number(f.plant) : null });
      $('#mBulk', body).onclick = () => bulkForm(draw);
      $('#mfPlant', body).onchange = (e) => { f.plant = e.target.value; draw(); };
      $('#mfLine', body).onchange = (e) => { f.line = e.target.value; draw(); };
      $('#mfGw', body).onchange = (e) => { f.gateway = e.target.value; draw(); };
      let st; $('#mfSearch', body).oninput = (e) => { clearTimeout(st); st = setTimeout(() => { f.search = e.target.value; draw(); }, 250); };
      $$('[data-edit]', body).forEach((b) => { b.onclick = () => meterForm(Number(b.dataset.edit), draw); });
      $$('[data-copy]', body).forEach((b) => { b.onclick = () => meterForm(Number(b.dataset.copy), draw, { copy: true }); });
      $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const m = ms.meters.find((x) => x.id === Number(b.dataset.del)); if (!await confirmDlg(`Delete meter "${m.name}"?\nAll of its history and alarm log will be deleted.`, { danger: true, ok: 'Delete meter' })) return; await adm(`/meters/${m.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); S.meters.delete(m.id); draw(); refreshAll(); }; });
    };
    await draw();
  }

  const MB_TYPES = ['float32', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64', 'float64'];
  const S7_TYPES = ['REAL', 'INT', 'DINT', 'WORD', 'DWORD', 'BYTE', 'BOOL', 'LREAL'];
  // address family of a device: how its tags are addressed
  const familyOf = (proto, tpl) => (proto === 'siemens-s7' || (tpl && tpl.protocolHint === 's7') ? 's7' : (proto === 'mqtt' || proto === 'http' || proto === 'push' || (!proto && tpl && tpl.protocolHint === 'json')) ? 'json' : 'modbus');
  const canonKeys = () => S.meta.metrics.map((m) => m.key);
  const canonGroups = () => Object.entries(S.meta.groups).map(([id, g]) => ({ id, label: g.label }));

  async function meterForm(id, onDone, preset = {}) {
    const m = id ? (await api(`/api/meters/${id}`)).meter : { template: 'schneider-pm5xxx', unitId: 1, phases: 3, nominalV: 230, nominalHz: 50, enabled: true, conn: {}, alarmConfig: {}, registerMap: null, plantId: preset.plantId, lineId: preset.lineId };
    if (preset.copy) { delete m.id; m.name = m.name + ' (copy)'; m.code = ''; m.unitId = (m.unitId || 0) + 1; }
    const gws = (await api('/api/gateways')).gateways.filter((g) => g.protocol !== 'siemens-s7');
    const tpls = S.meta.templates.filter((t) => t.protocolHint !== 's7');
    const ad = S.meta.alarmDefaults;
    const ac = { ...ad, ...(m.alarmConfig || {}) };
    // tags = the device's own list (null = follow the template)
    let regs = m.registerMap && m.registerMap.registers ? m.registerMap.registers.map((r) => ({ ...r })) : null;
    let tab = 'basic';
    const lineOpts = () => S.tree.plants.filter((p) => !val('mPlant', root) || p.id === Number(val('mPlant', root))).flatMap((p) => p.lines.map((l) => ({ value: l.id, label: l.name })));
    const secOpts = () => { const l = S.tree.plants.flatMap((p) => p.lines).find((x) => x.id === Number(val('mLine', root))); return l ? l.sections.map((s) => ({ value: s.id, label: s.name })) : []; };
    const root = modal.open(`${modal.head(id && !preset.copy ? 'Edit device' : 'Add device', m.name || '', 'gauge')}
      <div class="tabs" id="mTabs">${[['basic', 'General'], ['conn', 'Connection'], ['device', 'Device / template'], ['regs', 'Tags / values'], ['alarm', 'Electrical alarms']].map(([k, l]) => `<span class="tab ${k === tab ? 'active' : ''}" data-t="${k}">${l}</span>`).join('')}</div>
      <div id="mBody"></div>
      <div class="test-result" id="mTest"></div>
      <div class="panel-foot"><button class="btn" id="mTestBtn">${icon('play')} Test read</button><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="mSave">Save</button></div>`, { wide: true });
    const state = { ...m, alarm: ac, faceKey: (m.conn && m.conn.faceKey) || '' };
    const curFamily = () => { const gw = gws.find((x) => x.id === Number(state.gatewayId)); return familyOf(gw ? gw.protocol : null, tpls.find((t) => t.id === state.template)); };
    // keep values typed so far when switching tabs
    const capture = () => {
      const g = (k) => val(k, root);
      if ($('#mName', root)) Object.assign(state, { name: g('mName'), code: g('mCode'), plantId: g('mPlant'), lineId: g('mLine'), sectionId: g('mSection'), enabled: g('mEnabled'), sortOrder: g('mSort'), notes: g('mNotes') });
      if ($('#mGw', root)) { Object.assign(state, { gatewayId: g('mGw'), unitId: g('mUnit'), pollMs: g('mPoll') }); state.conn = { ...(state.conn || {}), topic: g('mTopic'), url: g('mUrl'), method: g('mMethod') }; }
      if ($('#mTemplate', root)) Object.assign(state, { template: g('mTemplate'), phases: g('mPhases'), nominalV: g('mNomV'), nominalHz: g('mNomHz'), ctPrimary: g('mCt'), ratedKw: g('mRatedKw'), ratedA: g('mRatedA') });
      if ($('#regRows', root)) {
        if ($('#rFn', root)) { state.regFn = g('rFn'); state.regBase = g('rBase'); state.regOrder = g('rOrder'); }
        if ($('#mFaceKey', root)) state.faceKey = g('mFaceKey');
        if (!$('#regRows', root).dataset.template) {
          const fam = $('#regRows', root).dataset.family;
          regs = $$('#regRows tr', root).map((tr) => {
            const rv = (c) => { const e = $(c, tr); return e ? e.value.trim() : ''; };
            const n = (c) => { const x = rv(c); return x === '' ? '' : Number(x); };
            const t = { key: rv('.rk'), label: rv('.rl'), group: rv('.rg'), unit: rv('.ru'), decimals: n('.rd'), scale: n('.rs'), hi: n('.rhi'), hiCrit: n('.rhic'), lo: n('.rlo'), loCrit: n('.rloc'), row: rv('.rrow'), col: rv('.rcol') };
            if (fam === 'modbus') Object.assign(t, { addr: Number(rv('.ra')), type: rv('.rt'), transform: rv('.rx') });
            if (fam === 's7') Object.assign(t, { area: rv('.rarea'), db: Number(rv('.rdb')), start: Number(rv('.ra')), bit: Number(rv('.rbit')) || 0, type: rv('.rt') });
            if (fam === 'json') Object.assign(t, { path: rv('.rp') });
            Object.keys(t).forEach((k) => { if (t[k] === '' || t[k] === undefined || Number.isNaN(t[k])) delete t[k]; });
            return t;
          }).filter((t) => t.key);
        }
      }
      if ($('#aEnabled', root)) { state.alarm = { enabled: g('aEnabled') }; for (const k of Object.keys(ad)) if (k !== 'enabled') state.alarm[k] = Number(g('a_' + k)); }
    };
    const draw = () => {
      const b = $('#mBody', root);
      const gw = gws.find((x) => x.id === Number(state.gatewayId));
      const proto = gw ? gw.protocol : null;
      const tpl = tpls.find((t) => t.id === state.template) || tpls[0];
      if (tab === 'basic') b.innerHTML = `<div class="form-grid c3">
        <div class="field span2"><label>Device name *</label><input id="mName" value="${esc(state.name || '')}" placeholder="e.g. L1-PM01 Extruder, PLC-Line1"></div>
        <div class="field"><label>Code (used by API / ingest)</label><input id="mCode" value="${esc(state.code || '')}" placeholder="L1-PM01"></div>
        <div class="field"><label>Plant</label>${sel('mPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), state.plantId, { blank: 'not set' })}</div>
        <div class="field"><label>Production line</label>${sel('mLine', lineOpts(), state.lineId, { blank: 'unassigned' })}</div>
        <div class="field"><label>Section</label>${sel('mSection', secOpts(), state.sectionId, { blank: 'not set' })}</div>
        <div class="field"><label>Display order</label><input id="mSort" type="number" value="${state.sortOrder ?? 0}"></div>
        <div class="field span2"><label>Notes</label><input id="mNotes" value="${esc(state.notes || '')}"></div>
        <div class="field check"><input type="checkbox" id="mEnabled" ${state.enabled ? 'checked' : ''}><label for="mEnabled">Enabled (poll + alarms)</label></div></div>`;
      if (tab === 'conn') b.innerHTML = `<div class="form-grid c3">
        <div class="field span2"><label>Gateway *</label>${sel('mGw', gws.map((g) => ({ value: g.id, label: `${g.name} · ${g.protocol}${g.host ? ' · ' + g.host : ''}` })), state.gatewayId, { blank: 'no gateway (readings via push API only)' })}<div class="hint">Modbus gateway, MQTT broker, HTTP device or push — the tag editor adapts to the protocol · Siemens PLCs are configured on the PLC page</div></div>
        <div class="field"><label>Poll interval (ms)</label><input id="mPoll" type="number" value="${state.pollMs ?? ''}" placeholder="${S.meta.config.defaultPollMs}"></div>
        ${!proto || proto.startsWith('modbus') || proto === 'simulator' ? `<div class="field"><label>Unit ID (Modbus slave)</label><input id="mUnit" type="number" value="${state.unitId ?? 1}"></div>` : `<input type="hidden" id="mUnit" value="${state.unitId ?? 1}">`}
        ${proto === 'mqtt' ? `<div class="field span2"><label>MQTT topic</label><input id="mTopic" value="${esc(state.conn?.topic || '')}" placeholder="plant/line1/pm01"></div>` : ''}
        ${proto === 'http' ? `<div class="field span2"><label>URL (absolute, or path appended to the gateway host)</label><input id="mUrl" value="${esc(state.conn?.url || '')}" placeholder="/api/meter/1"></div><div class="field"><label>Method</label>${sel('mMethod', ['GET', 'POST'].map((x) => ({ value: x, label: x })), state.conn?.method || 'GET', { blank: null })}</div>` : ''}
        ${!proto ? `<div class="hint span3 muted" style="font-size:.66rem">No gateway: the device must POST readings to /api/v1/ingest using the code "${esc(state.code || '')}"; JSON paths are defined in the Tags tab</div>` : ''}</div>`;
      if (tab === 'device') b.innerHTML = `<div class="form-grid c3">
        <div class="field span3"><label>Brand / model (template = starting tag list)</label><select id="mTemplate">${[...new Set(tpls.map((t) => t.brand))].map((br) => `<optgroup label="${br}">${tpls.filter((t) => t.brand === br).map((t) => `<option value="${t.id}" ${t.id === state.template ? 'selected' : ''}>${esc(t.name)} (${t.registerCount} tags)</option>`).join('')}</optgroup>`).join('')}</select>
          <div class="hint" id="tplHint"></div></div>
        <div class="field"><label>Phases</label>${sel('mPhases', [{ value: 3, label: '3-phase' }, { value: 1, label: 'single phase' }], state.phases ?? 3, { blank: null })}</div>
        <div class="field"><label>Nominal voltage L-N (V)</label><input id="mNomV" type="number" value="${state.nominalV ?? 230}"></div>
        <div class="field"><label>Nominal frequency (Hz)</label><input id="mNomHz" type="number" value="${state.nominalHz ?? 50}"></div>
        <div class="field"><label>CT primary (A)</label><input id="mCt" type="number" value="${state.ctPrimary ?? ''}" placeholder="e.g. 200"></div>
        <div class="field"><label>Rated load (kW) — for % and overload alarm</label><input id="mRatedKw" type="number" value="${state.ratedKw ?? ''}"></div>
        <div class="field"><label>Rated current (A) — overcurrent alarm</label><input id="mRatedA" type="number" value="${state.ratedA ?? ''}"></div></div>`;
      $('#modalPanel').classList.toggle('xwide', tab === 'regs');
      if (tab === 'regs') drawTags(b, tpl, proto);
      if (tab === 'alarm') {
        const a = state.alarm;
        const f = (k, label, hint = '') => `<div class="field"><label>${label}</label><input id="a_${k}" type="number" step="any" value="${a[k] ?? ad[k]}">${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
        b.innerHTML = `<div class="field check" style="margin-bottom:.8rem"><input type="checkbox" id="aEnabled" ${a.enabled !== false ? 'checked' : ''}><label for="aEnabled">Evaluate electrical alarms for this device (voltage / load / PF / frequency / THD — custom tag limits are set per tag)</label></div>
          <div class="sec-title" style="margin-top:0">Voltage (% of nominal ${state.nominalV || 230} V)</div><div class="form-grid c4">${f('underVoltagePct', 'Sag (warn) below -%')}${f('criticalUnderVoltagePct', 'Severe sag (error) below -%')}${f('outagePct', 'Outage (critical) below %')}${f('overVoltagePct', 'Swell (warn) above +%')}${f('criticalOverVoltagePct', 'Severe swell (error) above +%')}</div>
          <div class="sec-title">Load / current (% of rating)</div><div class="form-grid c4">${f('overloadPct', 'High load (warn) %')}${f('criticalOverloadPct', 'Overload (error) %')}${f('overcurrentPct', 'High current (warn) %')}${f('criticalOvercurrentPct', 'Overcurrent (error) %')}</div>
          <div class="sec-title">Power quality</div><div class="form-grid c4">${f('lowPf', 'PF below')}${f('freqDev', 'Frequency deviation (Hz) warn')}${f('criticalFreqDev', 'Frequency deviation (Hz) error')}${f('vUnbalPct', 'Voltage unbalance %')}${f('iUnbalPct', 'Current unbalance %')}${f('thdVPct', 'Voltage THD %')}${f('thdIPct', 'Current THD %')}</div>`;
      }
      if ($('#mPlant', b)) { $('#mPlant', b).onchange = () => { capture(); state.lineId = ''; state.sectionId = ''; draw(); }; $('#mLine', b).onchange = () => { capture(); state.sectionId = ''; const l = S.tree.plants.flatMap((p) => p.lines).find((x) => x.id === Number(state.lineId)); if (l) state.plantId = l.plantId; draw(); }; }
      if ($('#mGw', b)) $('#mGw', b).onchange = () => { capture(); draw(); };
      if ($('#mTemplate', b)) { const hint = () => { const t = tpls.find((x) => x.id === val('mTemplate', root)); $('#tplHint', b).textContent = t ? `${t.brand} ${t.model} · ${t.protocolHint} · ${t.registers.length} tags: ${t.registers.slice(0, 8).map((r) => r.key).join(', ')}${t.registers.length > 8 ? '…' : ''}` : ''; }; $('#mTemplate', b).onchange = () => { capture(); regs = null; hint(); }; hint(); }
    };

    // ---- unified tag editor ----
    const drawTags = (b, tpl, proto) => {
      const fam = familyOf(proto, tpl);
      const useTpl = !regs;
      const cur = regs || tpl.registers;
      const dis = useTpl ? 'disabled' : '';
      const keyList = `<datalist id="dlKeys">${canonKeys().map((k) => `<option value="${k}">${esc(metricOf(k).label)}</option>`).join('')}</datalist>`;
      const groupList = `<datalist id="dlGroups">${canonGroups().map((g) => `<option value="${g.id}">${esc(g.label)}</option>`).join('')}</datalist>`;
      const addrCols = fam === 'modbus' ? '<th>Address</th><th>Type</th><th>Transform</th>' : fam === 's7' ? '<th>Area</th><th>DB</th><th>Byte</th><th>Bit</th><th>Type</th>' : '<th>JSON path</th>';
      const showMatrix = fam === 's7' || cur.some((r) => r.row || r.col);
      const row = (r) => {
        const canon = metricOf(r.key);
        const ph = (k, def) => esc(canon ? (canon[k] ?? def ?? '') : (def ?? ''));
        let addr = '';
        if (fam === 'modbus') addr = `<td><input class="ra" type="number" value="${r.addr ?? ''}" ${dis} style="width:80px"></td><td><select class="rt" ${dis}>${MB_TYPES.map((t) => `<option ${t === (r.type || 'float32') ? 'selected' : ''}>${t}</option>`).join('')}</select></td><td><select class="rx" ${dis}><option value="">-</option><option value="schneider_pf" ${r.transform === 'schneider_pf' ? 'selected' : ''}>schneider_pf</option></select></td>`;
        else if (fam === 's7') addr = `<td><select class="rarea" ${dis}>${['DB', 'M', 'I', 'Q'].map((x) => `<option ${x === (r.area || 'DB') ? 'selected' : ''}>${x}</option>`).join('')}</select></td><td><input class="rdb" type="number" value="${r.db ?? 1}" ${dis} style="width:54px"></td><td><input class="ra" type="number" value="${r.start ?? r.addr ?? 0}" ${dis} style="width:62px"></td><td><input class="rbit" type="number" min="0" max="7" value="${r.bit ?? 0}" ${dis} style="width:42px"></td><td><select class="rt" ${dis}>${S7_TYPES.map((t) => `<option ${t === (r.type || 'REAL').toUpperCase() ? 'selected' : ''}>${t}</option>`).join('')}</select></td>`;
        else addr = `<td><input class="rp" value="${esc(r.path || (S.meta.templates.find((t) => t.id === state.template)?.jsonMap || {})[r.key] || '')}" placeholder="data.voltage.l1" ${dis} style="min-width:160px"></td>`;
        return `<tr>
          <td><input class="rl" value="${esc(r.label || '')}" placeholder="${ph('label', r.key)}" ${dis} style="min-width:120px" title="display name"></td>
          <td><input class="rk" list="dlKeys" value="${esc(r.key || '')}" placeholder="key" ${dis} style="width:104px" title="canonical metric key or your own key"></td>
          <td><input class="rg" list="dlGroups" value="${esc(r.group || '')}" placeholder="${ph('group', 'device')}" ${dis} style="width:96px" title="card on the detail page"></td>
          ${showMatrix ? `<td><div class="col" style="gap:.15rem"><input class="rrow" value="${esc(r.row || '')}" placeholder="row" ${dis} style="width:74px" title="matrix row (e.g. Shift A, Today)"><input class="rcol" value="${esc(r.col || '')}" placeholder="column" ${dis} style="width:74px" title="matrix column (e.g. kW, kWh-RT)"></div></td>` : ''}
          ${addr}
          <td><input class="rs" type="number" step="any" value="${r.scale ?? ''}" placeholder="1" ${dis} style="width:54px"></td>
          <td><input class="ru" value="${esc(r.unit ?? '')}" placeholder="${ph('unit', '')}" ${dis} style="width:50px"></td>
          <td><input class="rd" type="number" min="0" max="6" value="${r.decimals ?? ''}" placeholder="${ph('decimals', 2)}" ${dis} style="width:42px"></td>
          <td><div class="col" style="gap:.15rem"><input class="rhi" type="number" step="any" value="${r.hi ?? ''}" placeholder="warn" ${dis} style="width:64px" title="warn above"><input class="rhic" type="number" step="any" value="${r.hiCrit ?? ''}" placeholder="error" ${dis} style="width:64px" title="error above"></div></td>
          <td><div class="col" style="gap:.15rem"><input class="rlo" type="number" step="any" value="${r.lo ?? ''}" placeholder="warn" ${dis} style="width:64px" title="warn below"><input class="rloc" type="number" step="any" value="${r.loCrit ?? ''}" placeholder="error" ${dis} style="width:64px" title="error below"></div></td>
          <td>${useTpl ? '' : `<button class="gbtn rdel">${icon('x')}</button>`}</td></tr>`;
      };
      const faceOpts = [...new Map(cur.filter((r) => r.key).map((r) => [r.key, { value: r.key, label: `${r.label || (metricOf(r.key) ? metricOf(r.key).label : r.key)} (${r.key})` }])).values()];
      b.innerHTML = `${keyList}${groupList}
        <div class="row" style="margin-bottom:.6rem;flex-wrap:wrap;gap:.4rem">
          <span class="chip ${useTpl ? 'sel' : ''}">${useTpl ? 'Following the template tag list' : 'Custom tag list for this device'}</span>
          <button class="btn sm" id="rEdit">${useTpl ? 'Customise tags' : 'Reset to template'}</button>
          <button class="btn sm" id="rAdd" ${dis}>${icon('plus')} Add tag</button>
          <button class="btn sm" id="rClear" ${dis}>Clear all</button>
          <span class="muted" style="font-size:.64rem">${fam === 'modbus' ? 'Modbus: register address as printed in the manual (base below), data type, optional scale' : fam === 's7' ? 'Siemens S7: area, DB number, byte offset, bit (BOOL) and type — PUT/GET enabled, non-optimized DB' : 'JSON: dotted path inside the device payload (MQTT / HTTP / push)'}</span>
          <div class="field right" style="flex-direction:row;align-items:center;gap:.4rem"><label style="margin:0">Face value</label>${sel('mFaceKey', faceOpts, state.faceKey, { blank: 'dashboard default' })}</div>
        </div>
        ${fam === 'modbus' ? `<div class="form-grid c3" style="margin-bottom:.6rem">
          <div class="field"><label>Function</label>${sel('rFn', [{ value: 'holding', label: 'Holding registers (FC03)' }, { value: 'input', label: 'Input registers (FC04)' }], state.regFn || (m.registerMap && m.registerMap.fn) || tpl.fn, { blank: null })}</div>
          <div class="field"><label>Address base</label>${sel('rBase', [{ value: 0, label: '0 (address sent as-is)' }, { value: 1, label: '1 (manual counts from 1, e.g. Schneider)' }], state.regBase ?? (m.registerMap && m.registerMap.base) ?? tpl.base, { blank: null })}</div>
          <div class="field"><label>Word order (32/64-bit)</label>${sel('rOrder', ['ABCD', 'CDAB', 'BADC', 'DCBA'].map((x) => ({ value: x, label: x + (x === 'ABCD' ? ' (big-endian, Schneider)' : x === 'CDAB' ? ' (word swap)' : '') })), state.regOrder || (m.registerMap && m.registerMap.wordOrder) || tpl.wordOrder, { blank: null })}</div></div>` : ''}
        <div class="table-wrap" style="max-height:380px"><table class="regmap"><thead><tr><th>Name</th><th>Key</th><th>Group</th>${showMatrix ? '<th>Matrix row / col</th>' : ''}${addrCols}<th>Scale</th><th>Unit</th><th>Dec</th><th>High alarm</th><th>Low alarm</th><th></th></tr></thead><tbody id="regRows" data-family="${fam}" ${useTpl ? 'data-template="1"' : ''}>
          ${cur.map(row).join('') || '<tr><td colspan="14" class="muted">No tags — click "Add tag"</td></tr>'}
        </tbody></table></div>
        <div class="muted" style="font-size:.64rem;margin-top:.5rem;line-height:1.6">Key: pick a canonical metric (va, ia, p_total, kwh_import …) so the value feeds the standard dashboards and alarms, or type any key of your own (tank_temp, pressure_1 …) — custom tags get their own group card, chart, export column and hi / lo alarm.</div>`;
      $('#rEdit', b).onclick = () => { capture(); regs = regs ? null : tpl.registers.map((r) => ({ ...r })); draw(); };
      $('#rAdd', b).onclick = () => { capture(); regs = regs || []; regs.push(fam === 's7' ? { key: '', area: 'DB', db: 1, start: 0, type: 'REAL' } : fam === 'json' ? { key: '', path: '' } : { key: '', addr: 0, type: 'float32' }); draw(); };
      $('#rClear', b).onclick = async () => { if (!await confirmDlg('Remove every tag of this device?', { danger: true, ok: 'Clear' })) return; regs = []; draw(); };
      $$('.rdel', b).forEach((x) => { x.onclick = () => { capture(); regs.splice($$('#regRows tr', b).indexOf(x.closest('tr')), 1); draw(); }; });
      // key -> auto-fill placeholders from the registry
      $$('#regRows .rk', b).forEach((inp) => { inp.onchange = () => { const canon = metricOf(inp.value.trim()); const tr = inp.closest('tr'); if (canon) { $('.rl', tr).placeholder = canon.label; $('.rg', tr).placeholder = canon.group; $('.ru', tr).placeholder = canon.unit; $('.rd', tr).placeholder = canon.decimals; } }; });
    };

    $$('#mTabs .tab', root).forEach((t) => { t.onclick = () => { capture(); tab = t.dataset.t; $$('#mTabs .tab', root).forEach((x) => x.classList.toggle('active', x === t)); draw(); }; });
    draw();
    const collect = () => {
      capture();
      const tplNow = tpls.find((t) => t.id === state.template) || {};
      const registerMap = regs ? { fn: state.regFn || tplNow.fn, base: Number(state.regBase ?? tplNow.base ?? 0), wordOrder: state.regOrder || tplNow.wordOrder, registers: regs }
        : (state.regFn && (state.regFn !== tplNow.fn || state.regOrder !== tplNow.wordOrder || Number(state.regBase) !== Number(tplNow.base)) ? { fn: state.regFn, base: Number(state.regBase), wordOrder: state.regOrder } : null);
      const conn = { ...(state.conn || {}), faceKey: state.faceKey || undefined };
      Object.keys(conn).forEach((k) => { if (conn[k] === undefined || conn[k] === '') delete conn[k]; });
      return {
        name: state.name, code: state.code || null, plantId: state.plantId || null, lineId: state.lineId || null, sectionId: state.sectionId || null, gatewayId: state.gatewayId || null,
        template: state.template, unitId: numOrUndef(state.unitId) ?? 1, pollMs: numOrUndef(state.pollMs), conn: Object.keys(conn).length ? conn : null, registerMap,
        nominalV: numOrUndef(state.nominalV), nominalHz: numOrUndef(state.nominalHz), ctPrimary: numOrUndef(state.ctPrimary), ratedKw: numOrUndef(state.ratedKw), ratedA: numOrUndef(state.ratedA), phases: numOrUndef(state.phases) ?? 3,
        alarmConfig: state.alarm, enabled: state.enabled !== false, sortOrder: numOrUndef(state.sortOrder) ?? 0, notes: state.notes || null,
      };
    };
    $('#mTestBtn', root).onclick = async () => {
      const body = collect();
      const gw = gws.find((x) => x.id === Number(body.gatewayId));
      if (!gw) return toast('Select a gateway first', 'err');
      const btn = $('#mTestBtn', root); btn.disabled = true; btn.innerHTML = `${icon('refresh', 'spin')} Reading`;
      const out = $('#mTest', root);
      try {
        const r = await adm('/gateways/test', { body: { protocol: gw.protocol, host: gw.host, port: gw.port, config: gw.config, meter: { template: body.template, unitId: body.unitId, registerMap: body.registerMap, conn: body.conn } }, allowFail: true });
        const label = (k) => { const t = (regs || (tpls.find((x) => x.id === state.template) || {}).registers || []).find((x) => x.key === k); return t && t.label ? t.label : (metricOf(k) ? metricOf(k).label : k); };
        const unit = (k) => { const t = (regs || []).find((x) => x.key === k); return t && t.unit ? t.unit : unitOf(k); };
        out.innerHTML = r.success ? `<div class="badge ${r.errors ? 'warn' : 'ok'}">${r.errors ? 'Partial read: ' + esc(r.lastError) : 'Read OK'} · ${r.requests} requests · ${r.latencyMs} ms</div><div class="test-values">${Object.entries(r.values).map(([k, v]) => `<div class="fv"><div class="fv-label">${esc(label(k))}</div><div class="fv-val">${Number.isFinite(v) ? fmtNum(v, metricOf(k) ? metricOf(k).decimals : 2) : '-'}<small>${esc(unit(k))}</small></div></div>`).join('') || '<span class="muted">no values</span>'}</div>` : `<div class="badge critical">${esc(r.error || 'failed')}</div>`;
      } catch (e) { out.innerHTML = `<div class="badge critical">${esc(e.message)}</div>`; }
      btn.disabled = false; btn.innerHTML = `${icon('play')} Test read`;
      return null;
    };
    $('#mSave', root).onclick = async () => {
      const body = collect();
      if (!body.name || !body.name.trim()) return toast('Device name is required', 'err');
      if (body.registerMap && body.registerMap.registers && body.registerMap.registers.some((r) => !r.key)) return toast('Every tag needs a key', 'err');
      try {
        await (id && !preset.copy ? adm(`/meters/${id}`, { method: 'PATCH', body }) : adm('/meters', { body }));
        modal.close(); toast('Saved', 'ok');
        await refreshAll();
        onDone && onDone();
      } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  async function bulkForm(onDone) {
    const gws = (await api('/api/gateways')).gateways.filter((g) => g.protocol !== 'siemens-s7');
    const root = modal.open(`${modal.head('Bulk add meters', 'create meters on one gateway with consecutive unit ids', 'layers')}
      <div class="form-grid c3">
        <div class="field"><label>Gateway *</label>${sel('bGw', gws.map((g) => ({ value: g.id, label: g.name })), '', { blank: 'select' })}</div>
        <div class="field"><label>Production line</label>${sel('bLine', S.tree.plants.flatMap((p) => p.lines.map((l) => ({ value: l.id, label: (p.code || p.name) + ' · ' + l.name }))), '', { blank: 'unassigned' })}</div>
        <div class="field"><label>Template</label>${sel('bTpl', S.meta.templates.filter((t) => t.protocolHint !== 's7').map((t) => ({ value: t.id, label: t.name })), 'schneider-pm5xxx', { blank: null })}</div>
        <div class="field"><label>Count</label><input id="bCount" type="number" value="10" min="1" max="250"></div>
        <div class="field"><label>First unit ID</label><input id="bStart" type="number" value="1"></div>
        <div class="field"><label>Poll (ms)</label><input id="bPoll" type="number" value="${S.meta.config.defaultPollMs}"></div>
        <div class="field"><label>Name prefix</label><input id="bPrefix" value="PM"></div>
        <div class="field"><label>Code prefix</label><input id="bCode" value="" placeholder="L1-PM"></div>
        <div class="field"><label>Rated kW</label><input id="bKw" type="number" value=""></div>
      </div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="bGo">Create</button></div>`);
    $('#bGo', root).onclick = async () => {
      if (!val('bGw', root)) return toast('Select a gateway', 'err');
      const line = S.tree.plants.flatMap((p) => p.lines).find((l) => l.id === Number(val('bLine', root)));
      try {
        const r = await adm('/meters/bulk', { body: { gatewayId: Number(val('bGw', root)), lineId: line ? line.id : null, plantId: line ? line.plantId : null, template: val('bTpl', root), count: Number(val('bCount', root)), startUnitId: Number(val('bStart', root)), pollMs: Number(val('bPoll', root)), namePrefix: val('bPrefix', root), codePrefix: val('bCode', root) || undefined, ratedKw: numOrUndef(val('bKw', root)) } });
        modal.close(); toast(`${r.ids.length} meters created`, 'ok'); await refreshAll(); onDone();
      } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ PLC (Siemens S7)
     A PLC is configured the way Node-RED does it: one connection (address, rack,
     slot, cycle time) + a list of variables addressed as DB1004,REAL20 / DB1,X0.3 /
     MW10. Under the hood it is a siemens-s7 gateway plus one device (variable set). */
  const isPlc = (g) => g.protocol === 'siemens-s7';
  const s7Templates = () => S.meta.templates.filter((t) => t.protocolHint === 's7');
  const toVar = (t) => ({ ...t, addr: S7Addr.format(t) });
  const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

  async function plcTab(body) {
    const [gd, md] = await Promise.all([api('/api/gateways'), api('/api/meters')]);
    const plcs = gd.gateways.filter(isPlc);
    const devs = (g) => md.meters.filter((m) => m.gatewayId === g.id);
    const backend = (S.meta.protocols.find((x) => x.id === 'siemens-s7') || {}).backend || 'none';
    const card = (g) => {
      const live = g.live || null;
      const plc = live && live.plc;
      return `<div class="card plc-card" data-plc="${g.id}"><div class="card-head" style="flex-wrap:wrap;gap:.4rem">
          ${icon('cpu')}<div class="card-title">${esc(g.name)}</div>
          <span class="muted mono" style="font-size:.64rem">${esc(g.host || '-')}:${g.port || 102} · rack ${g.config.rack ?? 0} · slot ${g.config.slot ?? 1} · timeout ${g.config.timeoutMs ?? 3000} ms · ${esc(g.config.lib || 'auto')}${g.plantName ? ' · ' + esc(g.plantName) : ''}</span>
          ${!g.enabled ? '<span class="badge neutral">disabled</span>' : live && live.connected ? '<span class="badge ok">online</span>' : `<span class="badge critical" title="${esc(live && live.lastError || '')}">down</span>`}
          ${plc ? `<span class="badge ${plc.status === 'RUN' ? 'ok' : plc.status === 'STOP' ? 'critical' : 'neutral'}">PLC ${esc(plc.status)}</span>` : ''}
          ${live && !live.connected && live.lastError ? `<span class="muted" style="font-size:.62rem">${esc(live.lastError)}</span>` : ''}
          <div class="right row" style="gap:.2rem"><a class="gbtn" href="#/gateways/${g.id}" title="Monitor">${icon('external')}</a><button class="gbtn" data-edit="${g.id}" title="Edit connection + variables">${icon('edit')}</button><button class="gbtn" data-del="${g.id}" title="Delete PLC">${icon('trash')}</button></div></div>
        <div class="table-wrap" style="max-height:none;border:none;border-radius:0"><table><thead><tr><th>Variable set (device)</th><th>Code</th><th>Line / section</th><th class="num">Variables</th><th>Face value</th><th class="num">Cycle</th><th>Status</th><th></th></tr></thead><tbody>
          ${devs(g).map((m) => `<tr class="${m.enabled ? '' : 'acked'}"><td><a href="#/meter/${m.id}" class="val-strong" style="text-decoration:none;color:var(--text-1)">${esc(m.name)}</a></td><td class="mono">${esc(m.code || '')}</td><td style="font-size:.7rem">${esc(m.lineName || 'unassigned')}${m.sectionName ? ' / ' + esc(m.sectionName) : ''}</td><td class="num mono">${(m.tags || []).length}</td><td class="mono" style="font-size:.66rem">${esc(m.faceKey || '-')}</td><td class="num mono">${m.pollMs || S.meta.config.defaultPollMs} ms</td>
            <td>${!m.enabled ? '<span class="badge neutral">disabled</span>' : m.status === 'ok' ? '<span class="badge ok">ok</span>' : m.status === 'offline' ? '<span class="badge critical">offline</span>' : `<span class="badge warn">${esc(m.status)}</span>`}</td>
            <td class="nowrap"><button class="gbtn" data-vars="${m.id}" data-gw="${g.id}" title="Edit variables">${icon('edit')}</button><button class="gbtn" data-dev-del="${m.id}" title="Delete variable set">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No variables yet</td></tr>'}
        </tbody></table></div>
        <div class="row" style="padding:.4rem .8rem;border-top:1px solid var(--line-soft)"><button class="btn xs" data-dev-add="${g.id}">${icon('plus')} Add variable set</button><span class="muted" style="font-size:.62rem">a PLC can expose several variable sets (e.g. one per line); each becomes a device on the dashboard</span></div></div>`;
    };
    body.innerHTML = `<div class="row" style="margin-bottom:.8rem;flex-wrap:wrap"><button class="btn primary" id="plcAdd">${icon('plus')} Add PLC</button>
        <span class="muted" style="font-size:.7rem;line-height:1.6">Siemens S7-300 / 400 / 1200 / 1500 over ISO-on-TCP (port 102) · variables in Node-RED syntax: <code class="mono">DB1004,REAL20</code> <code class="mono">DB1,X0.3</code> <code class="mono">MW10</code> <code class="mono">I0.0</code> · S7 backend: <b>${esc(backend)}</b></span></div>
      <div class="col" style="gap:.8rem">${plcs.map(card).join('') || '<div class="empty">No PLC yet — click "Add PLC" (Modbus gateways, MQTT and HTTP devices live under "Gateways")</div>'}</div>`;
    const reload = () => plcTab(body);
    $('#plcAdd', body).onclick = () => plcForm(null, null, reload);
    $$('[data-edit]', body).forEach((b) => { b.onclick = () => { const g = Number(b.dataset.edit); const first = devs({ id: g })[0]; plcForm(g, first ? first.id : null, reload); }; });
    $$('[data-vars]', body).forEach((b) => { b.onclick = () => plcForm(Number(b.dataset.gw), Number(b.dataset.vars), reload); });
    $$('[data-dev-add]', body).forEach((b) => { b.onclick = () => plcForm(Number(b.dataset.devAdd), null, reload); });
    $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const g = plcs.find((x) => x.id === Number(b.dataset.del)); const n = devs(g).length; if (!await confirmDlg(`Delete PLC "${g.name}"?\n${n} variable set${n === 1 ? '' : 's'} and their history will be deleted.`, { danger: true, ok: 'Delete PLC' })) return; await adm(`/plc/${g.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); await refreshAll(); reload(); }; });
    $$('[data-dev-del]', body).forEach((b) => { b.onclick = async () => { const m = md.meters.find((x) => x.id === Number(b.dataset.devDel)); if (!await confirmDlg(`Delete variable set "${m.name}"?\nIts history and alarm log will be deleted.`, { danger: true, ok: 'Delete' })) return; await adm(`/meters/${m.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); S.meters.delete(m.id); await refreshAll(); reload(); }; });
  }

  async function plcForm(gatewayId, deviceId, onDone) {
    const g = gatewayId ? (await api(`/api/gateways/${gatewayId}`)).gateway : { name: '', host: '', port: 102, enabled: true, config: {} };
    const m = deviceId ? (await api(`/api/meters/${deviceId}`)).meter : null;
    const tpls = s7Templates();
    const c = g.config || {};
    const st = {
      name: g.name || '', plantId: g.plantId || '', host: g.host || '', port: g.port ?? 102, rack: c.rack ?? 0, slot: c.slot ?? 1, timeoutMs: c.timeoutMs ?? 3000, lib: c.lib || 'auto', enabled: g.enabled !== false, notes: g.notes || '',
      dName: m ? m.name : '', dCode: m ? (m.code || '') : '', lineId: m ? (m.lineId || '') : '', sectionId: m ? (m.sectionId || '') : '', pollMs: m ? (m.pollMs || 5000) : 5000,
      template: m ? m.template : 'siemens-s7-energy-db1004', faceKey: m && m.conn && m.conn.faceKey ? m.conn.faceKey : '', dEnabled: m ? m.enabled !== false : true,
    };
    const tplRegs = (id) => ((tpls.find((t) => t.id === id) || tpls[0] || { registers: [] }).registers || []).map(toVar);
    let vars = m && m.registerMap && m.registerMap.registers && m.registerMap.registers.length ? m.registerMap.registers.map(toVar) : tplRegs(st.template);
    const values = {};
    const root = modal.open(`${modal.head(gatewayId ? 'Edit PLC' : 'Add PLC', gatewayId ? `${g.name} · ${g.host || ''}` : 'Siemens S7 connection + variables', 'cpu')}
      <div class="sec-title" style="margin-top:0">Connection</div>
      <div class="form-grid c4">
        <div class="field span2"><label>Name *</label><input id="pName" value="${esc(st.name)}" placeholder="e.g. PLC-01 Line 1"></div>
        <div class="field"><label>Plant</label>${sel('pPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), st.plantId, { blank: 'not set' })}</div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="pEnabled" ${st.enabled ? 'checked' : ''}><label for="pEnabled">Enabled</label></div>
        <div class="field span2"><label>Address (PLC IP) *</label><input id="pHost" value="${esc(st.host)}" placeholder="10.22.181.12" class="mono"></div>
        <div class="field"><label>Port</label><input id="pPort" type="number" value="${st.port}"></div>
        <div class="field"><label>Library</label>${sel('pLib', [{ value: 'auto', label: 'auto (node-snap7 → nodes7)' }, { value: 'snap7', label: 'node-snap7 (native)' }, { value: 'nodes7', label: 'nodes7 (pure JS)' }], st.lib, { blank: null })}</div>
        <div class="field"><label>Rack</label><input id="pRack" type="number" value="${st.rack}"></div>
        <div class="field"><label>Slot</label><input id="pSlot" type="number" value="${st.slot}"><div class="hint">S7-1200/1500: 0 / 1 · S7-300/400: 0 / 2</div></div>
        <div class="field"><label>Cycle time (ms)</label><input id="pCycle" type="number" value="${st.pollMs}"><div class="hint">how often the variables are read</div></div>
        <div class="field"><label>Timeout (ms)</label><input id="pTimeout" type="number" value="${st.timeoutMs}"></div>
        <div class="field span3"><label>Notes</label><input id="pNotes" value="${esc(st.notes)}"></div>
      </div>
      <div class="hint muted" style="font-size:.64rem;line-height:1.6;margin-top:.3rem">S7-1200/1500: enable <b>PUT/GET communication</b> (CPU properties › Protection & Security › Connection mechanisms) and turn off <b>optimized block access</b> on every DB used here.</div>
      <div class="sec-title">Device on the dashboard</div>
      <div class="form-grid c4">
        <div class="field"><label>Device name</label><input id="pDName" value="${esc(st.dName)}" placeholder="defaults to the PLC name"></div>
        <div class="field"><label>Code (API / ingest)</label><input id="pDCode" value="${esc(st.dCode)}" placeholder="PLC-01"></div>
        <div class="field"><label>Production line</label>${sel('pLine', S.tree.plants.flatMap((p) => p.lines.map((l) => ({ value: l.id, label: (p.code || p.name) + ' · ' + l.name }))), st.lineId, { blank: 'unassigned' })}</div>
        <div class="field"><label>Section</label>${sel('pSection', [], st.sectionId, { blank: 'not set' })}</div>
        <div class="field"><label>Face value (big digits on the line dashboard)</label>${sel('pFace', [], st.faceKey, { blank: 'template default' })}</div>
        <div class="field"><label>Layout preset</label>${sel('pTemplate', tpls.map((t) => ({ value: t.id, label: t.name })), st.template, { blank: null })}<div class="hint">defines the face / matrix layout; the variable list below is what is actually read</div></div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="pDEnabled" ${st.dEnabled ? 'checked' : ''}><label for="pDEnabled">Read this variable set</label></div>
      </div>
      <div class="sec-title">Variables <span class="muted" style="font-weight:400;text-transform:none;letter-spacing:0">(<span id="pCount">${vars.length}</span>)</span></div>
      <div class="row" style="flex-wrap:wrap;gap:.4rem;margin-bottom:.5rem">
        <button class="btn sm" id="pvAdd">${icon('plus')} Add variable</button>
        <button class="btn sm" id="pvPreset">${icon('layers')} Load preset list</button>
        <button class="btn sm" id="pvImport">${icon('download')} Import (Node-RED)</button>
        <button class="btn sm" id="pvExport">${icon('copy')} Copy as Node-RED JSON</button>
        <button class="btn sm" id="pvRead">${icon('play')} Read all now</button>
        <button class="btn sm" id="pvClear">Clear</button>
        <span class="muted" style="font-size:.64rem">address syntax: <code class="mono">DB1004,REAL20</code> <code class="mono">DB1,INT4</code> <code class="mono">DB1,X0.3</code> <code class="mono">MW10</code> <code class="mono">MR20</code> <code class="mono">I0.0</code> <code class="mono">QB2</code></span>
      </div>
      <div id="pvImportBox" class="card hide" style="margin-bottom:.6rem"><div class="card-body">
        <label style="font-size:.66rem;color:var(--text-3);text-transform:uppercase;letter-spacing:.08em;font-weight:600">Node-RED S7 variables — JSON export or one "address name" per line</label>
        <textarea id="impTxt" rows="6" style="width:100%;margin-top:.3rem;font-family:var(--font-mono);font-size:.72rem;background:var(--surface-3);color:var(--text-1);border:1px solid var(--line);border-radius:var(--radius-sm);padding:.5rem" placeholder='[{"addr":"DB1004,REAL20","name":"kw_shift_a"}, ...]   or   DB1004,REAL20 kw_shift_a'></textarea>
        <div class="row" style="margin-top:.4rem"><label class="chip click"><input type="checkbox" id="impReplace" style="accent-color:var(--accent)"> replace current list</label><span class="right"></span><button class="btn sm" id="impCancel">Cancel</button><button class="btn sm primary" id="impGo">Import</button></div></div></div>
      <div class="table-wrap" style="max-height:420px"><table class="regmap vars"><thead><tr><th>#</th><th>Address</th><th>Name</th><th>Key</th><th>Group</th><th>Matrix row / col</th><th>Scale</th><th>Unit</th><th>Dec</th><th>High alarm</th><th>Low alarm</th><th class="num">Value</th><th></th></tr></thead><tbody id="pvRows"></tbody></table></div>
      <div class="muted" style="font-size:.64rem;margin-top:.5rem;line-height:1.6">Key: a canonical metric (p_total, kwh_import …) feeds the standard dashboards and alarms; any other key (kw_day, tank_temp …) gets its own group card, chart, export column and hi / lo alarm. Row / column place the value in a period matrix (e.g. row "Shift A", column "kW").</div>
      <div class="test-result" id="pTest"></div>
      <div class="panel-foot"><button class="btn" id="pTestBtn">${icon('play')} Test connection</button><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="pSave">Save</button></div>`, { wide: true });
    $('#modalPanel').classList.add('xwide');
    const keyList = `<datalist id="dlKeys">${canonKeys().map((k) => `<option value="${k}">${esc(metricOf(k).label)}</option>`).join('')}</datalist><datalist id="dlGroups">${canonGroups().map((x) => `<option value="${x.id}">${esc(x.label)}</option>`).join('')}</datalist>`;
    root.insertAdjacentHTML('beforeend', keyList);

    const sections = () => { const l = S.tree.plants.flatMap((p) => p.lines).find((x) => x.id === Number(val('pLine', root))); const s = $('#pSection', root); const cur = s.value || st.sectionId; s.innerHTML = `<option value="">not set</option>${(l ? l.sections : []).map((x) => `<option value="${x.id}" ${String(x.id) === String(cur) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}`; };
    const faceOpts = () => { const s = $('#pFace', root); const cur = s.value || st.faceKey; s.innerHTML = `<option value="">template default</option>${[...new Map(vars.filter((v) => v.key).map((v) => [v.key, v])).values()].map((v) => `<option value="${esc(v.key)}" ${v.key === cur ? 'selected' : ''}>${esc(v.label || (metricOf(v.key) ? metricOf(v.key).label : v.key))} (${esc(v.key)})</option>`).join('')}`; };
    $('#pLine', root).onchange = () => { $('#pSection', root).value = ''; sections(); };
    sections();

    // ---- variables table (captured back into `vars` before every redraw) ----
    const capture = () => {
      vars = $$('#pvRows tr', root).map((tr) => {
        const rv = (cl) => { const e = $(cl, tr); return e ? e.value.trim() : ''; };
        const n = (cl) => { const x = rv(cl); return x === '' ? '' : Number(x); };
        const v = { addr: rv('.va'), label: rv('.vl'), key: rv('.vk'), group: rv('.vg'), row: rv('.vrow'), col: rv('.vcol'), scale: n('.vs'), unit: rv('.vu'), decimals: n('.vd'), hi: n('.vhi'), hiCrit: n('.vhic'), lo: n('.vlo'), loCrit: n('.vloc') };
        Object.keys(v).forEach((k) => { if (v[k] === '' || Number.isNaN(v[k])) delete v[k]; });
        return v;
      });
    };
    const row = (v, i) => {
      const canon = metricOf(v.key);
      const ph = (k, def) => esc(canon ? (canon[k] ?? def ?? '') : (def ?? ''));
      const err = v.addr ? S7Addr.explain(v.addr) : '';
      const value = v.key && values[v.key] !== undefined ? values[v.key] : null;
      return `<tr>
        <td class="mono muted" style="font-size:.62rem">${i + 1}</td>
        <td><input class="va mono ${err ? 'bad' : ''}" value="${esc(v.addr || '')}" placeholder="DB1004,REAL20" title="${esc(err)}" style="width:128px"></td>
        <td><input class="vl" value="${esc(v.label || '')}" placeholder="${ph('label', v.key || 'name')}" style="min-width:120px"></td>
        <td><input class="vk mono" list="dlKeys" value="${esc(v.key || '')}" placeholder="key" style="width:104px"></td>
        <td><input class="vg" list="dlGroups" value="${esc(v.group || '')}" placeholder="${ph('group', 'device')}" style="width:104px"></td>
        <td><div class="col" style="gap:.15rem"><input class="vrow" value="${esc(v.row || '')}" placeholder="row" style="width:74px"><input class="vcol" value="${esc(v.col || '')}" placeholder="column" style="width:74px"></div></td>
        <td><input class="vs" type="number" step="any" value="${v.scale ?? ''}" placeholder="1" style="width:54px"></td>
        <td><input class="vu" value="${esc(v.unit ?? '')}" placeholder="${ph('unit', '')}" style="width:50px"></td>
        <td><input class="vd" type="number" min="0" max="6" value="${v.decimals ?? ''}" placeholder="${ph('decimals', 2)}" style="width:42px"></td>
        <td><div class="col" style="gap:.15rem"><input class="vhi" type="number" step="any" value="${v.hi ?? ''}" placeholder="warn" style="width:64px"><input class="vhic" type="number" step="any" value="${v.hiCrit ?? ''}" placeholder="error" style="width:64px"></div></td>
        <td><div class="col" style="gap:.15rem"><input class="vlo" type="number" step="any" value="${v.lo ?? ''}" placeholder="warn" style="width:64px"><input class="vloc" type="number" step="any" value="${v.loCrit ?? ''}" placeholder="error" style="width:64px"></div></td>
        <td class="num mono vval" style="font-size:.7rem;min-width:64px">${value === null ? '<span class="muted">-</span>' : Number.isFinite(value) ? fmtNum(value, Number.isFinite(v.decimals) ? v.decimals : 2) : esc(String(value))}</td>
        <td><button class="gbtn vdel" title="Remove">${icon('x')}</button></td></tr>`;
    };
    const draw = () => {
      $('#pvRows', root).innerHTML = vars.map(row).join('') || '<tr><td colspan="13" class="muted">No variables — click "Add variable" or load a preset list</td></tr>';
      setText($('#pCount', root), vars.length);
      faceOpts();
      $$('.vdel', root).forEach((b) => { b.onclick = () => { capture(); vars.splice($$('#pvRows tr', root).indexOf(b.closest('tr')), 1); draw(); }; });
      $$('.va', root).forEach((inp) => { inp.oninput = () => { const e = S7Addr.explain(inp.value); inp.classList.toggle('bad', !!e && !!inp.value.trim()); inp.title = e; }; });
      $$('.vk', root).forEach((inp) => { inp.onchange = () => { const canon = metricOf(inp.value.trim()); const tr = inp.closest('tr'); if (canon) { $('.vl', tr).placeholder = canon.label; $('.vg', tr).placeholder = canon.group; $('.vu', tr).placeholder = canon.unit; $('.vd', tr).placeholder = canon.decimals; } capture(); faceOpts(); }; });
      // name typed, key empty -> suggest a key from the name
      $$('.vl', root).forEach((inp) => { inp.onchange = () => { const tr = inp.closest('tr'); const k = $('.vk', tr); if (!k.value.trim() && inp.value.trim()) { k.value = slug(inp.value); capture(); faceOpts(); } }; });
    };
    draw();
    $('#pvAdd', root).onclick = () => { capture(); const last = vars[vars.length - 1]; const next = last && S7Addr.parse(last.addr) ? (() => { const t = S7Addr.parse(last.addr); return S7Addr.format({ ...t, start: t.start + S7Addr.sizeOf(t.type), bit: 0 }); })() : 'DB1,REAL0'; vars.push({ addr: next, key: '', group: last ? last.group : '' }); draw(); const rows = $$('#pvRows tr', root); const inp = $('.vl', rows[rows.length - 1]); if (inp) inp.focus(); };
    $('#pvClear', root).onclick = async () => { if (!await confirmDlg('Remove every variable?', { danger: true, ok: 'Clear' })) return; vars = []; draw(); };
    $('#pvPreset', root).onclick = async () => {
      const id = val('pTemplate', root);
      const t = tpls.find((x) => x.id === id);
      if (!t) return;
      if (vars.length && !await confirmDlg(`Replace the ${vars.length} variables with the "${t.name}" list (${t.registers.length} variables)?`, { ok: 'Replace' })) return;
      vars = tplRegs(id); draw(); toast(`${vars.length} variables loaded`, 'ok');
    };
    $('#pTemplate', root).onchange = () => { if (!vars.length) { vars = tplRegs(val('pTemplate', root)); draw(); } };
    $('#pvExport', root).onclick = () => { capture(); const out = vars.map((v) => ({ addr: v.addr, name: v.key || v.label })); copyText(JSON.stringify(out, null, 2)); toast('Copied — paste into the Node-RED S7 endpoint "Variables" (import)', 'ok'); };
    $('#pvImport', root).onclick = () => { const box = $('#pvImportBox', root); box.classList.toggle('hide'); if (!box.classList.contains('hide')) $('#impTxt', root).focus(); };
    $('#impCancel', root).onclick = () => $('#pvImportBox', root).classList.add('hide');
    $('#impGo', root).onclick = () => {
      capture();
      const txt = val('impTxt', root).trim();
      let list = [];
      try {
        if (txt.startsWith('[') || txt.startsWith('{')) {
          const j = JSON.parse(txt);
          const arr = Array.isArray(j) ? j : (j.vars || j.variables || []);
          list = arr.map((x) => ({ addr: x.addr || x.address || '', key: slug(x.name || x.key || ''), label: x.name || '' }));
        } else list = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [a, ...rest] = l.split(/[\s=;]+/); return { addr: a, key: slug(rest.join(' ')), label: rest.join(' ') }; });
      } catch (e) { return toast('Cannot parse: ' + e.message, 'err'); }
      if (!list.length) return toast('Nothing to import', 'err');
      const bad = list.filter((x) => !S7Addr.parse(x.addr));
      if (bad.length) return toast(`${bad.length} address${bad.length === 1 ? '' : 'es'} not understood, e.g. "${bad[0].addr}": ${S7Addr.explain(bad[0].addr)}`, 'err');
      vars = val('impReplace', root) ? list : vars.concat(list);
      $('#pvImportBox', root).classList.add('hide');
      draw();
      toast(`${list.length} variables imported`, 'ok');
      return null;
    };

    const tags = () => { capture(); return vars.map((v) => { const t = S7Addr.parse(v.addr); return t ? { ...v, ...t, addr: undefined } : null; }).filter(Boolean); };
    const gatewayBody = () => ({ protocol: 'siemens-s7', host: val('pHost', root), port: Number(val('pPort', root)) || 102, config: { rack: Number(val('pRack', root)) || 0, slot: Number(val('pSlot', root)) || 0, timeoutMs: Number(val('pTimeout', root)) || 3000, lib: val('pLib', root) } });
    $('#pTestBtn', root).onclick = async () => {
      const b = $('#pTestBtn', root); b.disabled = true; b.innerHTML = `${icon('refresh', 'spin')} Testing`;
      const out = $('#pTest', root);
      try {
        const r = await adm('/gateways/test', { body: { ...gatewayBody(), meter: {} }, allowFail: true });
        if (r.success && r.plc) { const plc = r.plc; out.innerHTML = `<div class="badge ok">Connected in ${r.connectMs} ms</div> <span class="badge ${plc.status === 'RUN' ? 'ok' : plc.status === 'STOP' ? 'critical' : 'neutral'}">PLC ${esc(plc.status)}</span><div class="muted" style="font-size:.68rem;margin-top:.4rem">${esc([plc.cpu && plc.cpu.moduleType, plc.orderCode, plc.firmware, plc.cpu && plc.cpu.serial ? 'S/N ' + plc.cpu.serial : null, plc.pduLength ? 'PDU ' + plc.pduLength : null, plc.plcTime ? 'PLC clock ' + fmtTime(plc.plcTime) : null].filter(Boolean).join(' · ') || 'CPU answered no diagnostics')}</div>${plc.errors && plc.errors.length ? `<div class="muted" style="font-size:.62rem">${esc(plc.errors.join(' · '))}</div>` : ''}`; } else out.innerHTML = `<div class="badge critical">${esc(r.error || 'failed')}</div>`;
      } catch (e) { out.innerHTML = `<div class="badge critical">${esc(e.message)}</div>`; }
      b.disabled = false; b.innerHTML = `${icon('play')} Test connection`;
    };
    $('#pvRead', root).onclick = async () => {
      const list = tags();
      if (!list.length) return toast('No valid variables to read', 'err');
      const b = $('#pvRead', root); b.disabled = true; b.innerHTML = `${icon('refresh', 'spin')} Reading`;
      const out = $('#pTest', root);
      try {
        const r = await adm('/gateways/test', { body: { ...gatewayBody(), meter: { template: val('pTemplate', root) || 'siemens-s7-tags', unitId: 1, registerMap: { registers: list } } }, allowFail: true });
        if (r.success) { Object.assign(values, r.values || {}); out.innerHTML = `<div class="badge ${r.errors ? 'warn' : 'ok'}">${r.errors ? 'Partial read: ' + esc(r.lastError) : 'Read OK'} · ${r.requests} request${r.requests === 1 ? '' : 's'} · ${r.latencyMs} ms</div>`; draw(); } else out.innerHTML = `<div class="badge critical">${esc(r.error || 'failed')}</div>`;
      } catch (e) { out.innerHTML = `<div class="badge critical">${esc(e.message)}</div>`; }
      b.disabled = false; b.innerHTML = `${icon('play')} Read all now`;
      return null;
    };
    $('#pSave', root).onclick = async () => {
      capture();
      const name = val('pName', root).trim();
      if (!name) return toast('PLC name is required', 'err');
      if (!val('pHost', root).trim()) return toast('PLC address is required', 'err');
      for (const [i, v] of vars.entries()) {
        if (!S7Addr.parse(v.addr)) return toast(`Variable ${i + 1}: ${S7Addr.explain(v.addr)}`, 'err');
        if (!v.key && v.label) v.key = slug(v.label);
        if (!v.key) return toast(`Variable ${i + 1} (${v.addr}) needs a key or a name`, 'err');
      }
      const dup = vars.map((v) => v.key).find((k, i, a) => a.indexOf(k) !== i);
      if (dup) return toast(`Duplicate key "${dup}"`, 'err');
      const body = {
        gateway: { id: gatewayId || undefined, name, plantId: val('pPlant', root) || null, host: val('pHost', root).trim(), port: Number(val('pPort', root)) || 102, rack: Number(val('pRack', root)) || 0, slot: Number(val('pSlot', root)) || 0, timeoutMs: Number(val('pTimeout', root)) || 3000, lib: val('pLib', root), enabled: val('pEnabled', root), notes: val('pNotes', root) },
        device: { id: deviceId || undefined, name: val('pDName', root).trim() || name, code: val('pDCode', root).trim() || null, lineId: val('pLine', root) || null, sectionId: val('pSection', root) || null, template: val('pTemplate', root), pollMs: Number(val('pCycle', root)) || null, faceKey: val('pFace', root) || '', enabled: val('pDEnabled', root), variables: vars },
      };
      try { await adm('/plc', { body }); modal.close(); toast('Saved', 'ok'); await refreshAll(); onDone && onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ peak demand */
  const tagLabel = (t) => (t ? S7Addr.format(t) : '');

  async function demandTab(body) {
    const [d, gws] = await Promise.all([api('/api/demand'), api('/api/gateways')]);
    const s7 = gws.gateways.filter((g) => g.protocol === 'siemens-s7');
    body.innerHTML = `<div class="row" style="margin-bottom:.8rem"><button class="btn primary" id="dgAdd">${icon('plus')} Add demand group</button><a class="btn" href="#/demand">${icon('trend')} Open monitor</a>
        <span class="muted" style="font-size:.7rem">a group = incoming meters to sum + contract target · stages = loads to shed through a Siemens S7 tag (or dry-run) · ${s7.length} S7 gateway${s7.length === 1 ? '' : 's'} configured</span></div>
      <div class="col" style="gap:.8rem">${d.groups.map((g) => `
        <div class="card"><div class="card-head"><div class="card-title">${esc(g.name)}</div><span class="muted mono" style="font-size:.64rem;margin-left:.5rem">${esc(g.plantName || '')} · target ${fmtNum(g.targetKw, 0)} kW · margin ${fmtNum(g.marginKw, 0)} · ${g.blockMin}-min block · release ${Math.round((g.releaseKw / g.thresholdKw) * 100)}% · ${g.meterIds.length} meters</span>
            <span class="badge ${g.auto ? 'ok' : 'neutral'}" style="margin-left:.6rem">${g.auto ? 'AUTO' : 'MANUAL'}</span>${g.enabled ? '' : '<span class="badge neutral">disabled</span>'}
            <div class="right row" style="gap:.2rem"><button class="btn sm" data-stage-add="${g.id}">${icon('plus')} Stage</button><button class="gbtn" data-edit="${g.id}" title="Edit">${icon('edit')}</button><button class="gbtn" data-del="${g.id}" title="Delete">${icon('trash')}</button></div></div>
          <div class="table-wrap" style="max-height:none;border:none;border-radius:0"><table><thead><tr><th>#</th><th>Stage</th><th>Gateway / tag</th><th class="num">Shed → restore</th><th class="num">~kW</th><th class="num">Min / max off</th><th>Status</th><th></th></tr></thead><tbody>
            ${g.stages.map((st) => `<tr class="${st.enabled ? '' : 'acked'}"><td class="mono">${st.priority}</td><td class="val-strong">${esc(st.name)}</td><td class="mono" style="font-size:.66rem">${st.gatewayId ? esc((gws.gateways.find((x) => x.id === st.gatewayId) || {}).name || '#' + st.gatewayId) + ' · ' + esc(tagLabel(st.tag)) : '<span class="muted">dry run (no PLC)</span>'}</td><td class="num">${st.shedValue} → ${st.restoreValue}</td><td class="num">${st.kwEstimate ?? '-'}</td><td class="num">${st.minOffSec}s / ${st.maxOffSec}s</td><td>${st.shed ? '<span class="badge warn">shed</span>' : '<span class="badge ok">running</span>'}</td>
              <td class="nowrap"><button class="gbtn" data-stage-test="${st.id}" title="Write shed value once">${icon('play')}</button><button class="gbtn" data-stage-edit="${st.id}" title="Edit">${icon('edit')}</button><button class="gbtn" data-stage-del="${st.id}" title="Delete">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="8" class="muted">No stages — add loads that can be shed, highest priority first</td></tr>'}
          </tbody></table></div></div>`).join('') || '<div class="empty">No demand groups yet</div>'}</div>`;
    const reload = () => demandTab(body);
    $('#dgAdd', body).onclick = () => demandGroupForm(null, reload);
    $$('[data-edit]', body).forEach((b) => { b.onclick = () => demandGroupForm(d.groups.find((g) => g.id === Number(b.dataset.edit)), reload); });
    $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const g = d.groups.find((x) => x.id === Number(b.dataset.del)); if (!await confirmDlg(`Delete demand group "${g.name}" with its stages, block history and log?`, { danger: true, ok: 'Delete' })) return; await adm(`/demand/groups/${g.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); reload(); }; });
    $$('[data-stage-add]', body).forEach((b) => { b.onclick = () => stageForm(null, Number(b.dataset.stageAdd), gws.gateways, reload); });
    $$('[data-stage-edit]', body).forEach((b) => { b.onclick = () => { const st = d.groups.flatMap((g) => g.stages.map((x) => ({ ...x, groupId: g.id }))).find((x) => x.id === Number(b.dataset.stageEdit)); stageForm(st, st.groupId, gws.gateways, reload); }; });
    $$('[data-stage-del]', body).forEach((b) => { b.onclick = async () => { if (!await confirmDlg('Delete this stage?', { danger: true, ok: 'Delete' })) return; await adm(`/demand/stages/${b.dataset.stageDel}`, { method: 'DELETE' }); reload(); }; });
    $$('[data-stage-test]', body).forEach((b) => { b.onclick = async () => { const st = d.groups.flatMap((g) => g.stages).find((x) => x.id === Number(b.dataset.stageTest)); if (!await confirmDlg(`Write the shed value (${st.shedValue}) to "${st.name}" now?${st.dryRun ? '\n(dry run: nothing is written)' : ' The PLC will act on it.'}`, { danger: !st.dryRun, ok: 'Write' })) return; const r = await adm(`/demand/stages/${st.id}/test`, { body: { value: st.shedValue }, allowFail: true }); toast(r.success ? (r.dryRun ? 'Dry run - no PLC tag bound' : 'Written') : r.error, r.success ? 'ok' : 'err'); }; });
  }

  function demandGroupForm(g, onDone) {
    const meters = [...S.meters.values()];
    const selected = new Set(g ? g.meterIds : []);
    const root = modal.open(`${modal.head(g ? 'Edit demand group' : 'Add demand group', g ? g.name : '', 'trend')}
      <div class="form-grid c3">
        <div class="field span2"><label>Name *</label><input id="dgName" value="${esc(g?.name || '')}" placeholder="e.g. SPK main incoming"></div>
        <div class="field"><label>Plant</label>${sel('dgPlant', S.tree.plants.map((p) => ({ value: p.id, label: p.name })), g?.plantId, { blank: 'not set' })}</div>
        <div class="field"><label>Target demand (kW) *</label><input id="dgTarget" type="number" value="${g?.targetKw ?? 1000}"><div class="hint">contract / billed peak you must stay under</div></div>
        <div class="field"><label>Margin (kW)</label><input id="dgMargin" type="number" value="${g?.marginKw ?? 50}"><div class="hint">shedding starts when projected > target − margin</div></div>
        <div class="field"><label>Block length (min)</label><input id="dgBlock" type="number" value="${g?.blockMin ?? 15}"><div class="hint">15 for MEA / PEA demand billing</div></div>
        <div class="field"><label>Release level (% of threshold)</label><input id="dgRelease" type="number" step="1" value="${Math.round((g?.releaseKw && g?.thresholdKw ? g.releaseKw / g.thresholdKw : 0.9) * 100)}"><div class="hint">stages come back when projected drops below this</div></div>
        <div class="field"><label>Gap between actions (s)</label><input id="dgGap" type="number" value="${g?.actionGapSec ?? 30}"></div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="dgAuto" ${g ? (g.auto ? 'checked' : '') : ''}><label for="dgAuto">Automatic shedding</label></div>
        <div class="field span2"><label>Notes</label><input id="dgNotes" value="${esc(g?.notes || '')}"></div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="dgEnabled" ${!g || g.enabled ? 'checked' : ''}><label for="dgEnabled">Enabled</label></div>
      </div>
      <div class="field" style="margin-top:.8rem"><label>Meters to sum (main incoming / transformer meters) — <span id="dgCount">${selected.size}</span> selected</label>
        <div class="row" style="margin:.3rem 0"><input id="dgFilter" placeholder="filter by name / line" style="max-width:260px;background:var(--surface-3);border:1px solid var(--line);color:var(--text-1);border-radius:var(--radius-sm);padding:.35rem .6rem;font-size:.74rem"><button class="btn xs" id="dgAll">select filtered</button><button class="btn xs" id="dgNone">clear</button></div>
        <div class="table-wrap" style="max-height:220px;padding:.3rem .5rem;font-size:.72rem" id="dgMeters"></div></div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="dgSave">Save</button></div>`, { wide: true });
    const draw = () => {
      const q = (val('dgFilter', root) || '').toLowerCase();
      const pid = Number(val('dgPlant', root));
      const list = meters.filter((m) => (!pid || m.plantId === pid) && (!q || `${m.name} ${m.lineName || ''} ${m.code || ''}`.toLowerCase().includes(q)));
      $('#dgMeters', root).innerHTML = list.map((m) => `<label style="display:flex;gap:.4rem;align-items:center;padding:.1rem 0"><input type="checkbox" value="${m.id}" ${selected.has(m.id) ? 'checked' : ''} style="accent-color:var(--accent)"> ${esc(m.name)} <span class="muted">${esc(m.plantName || '')} · ${esc(m.lineName || '')} · ${fmtNum(m.values.p_total, 0)} kW</span></label>`).join('') || '<span class="muted">No meters</span>';
      $$('input[type=checkbox]', $('#dgMeters', root)).forEach((c) => { c.onchange = () => { if (c.checked) selected.add(Number(c.value)); else selected.delete(Number(c.value)); setText($('#dgCount', root), selected.size); }; });
    };
    $('#dgFilter', root).oninput = draw; $('#dgPlant', root).onchange = draw;
    $('#dgAll', root).onclick = () => { $$('#dgMeters input', root).forEach((c) => { selected.add(Number(c.value)); }); draw(); setText($('#dgCount', root), selected.size); };
    $('#dgNone', root).onclick = () => { selected.clear(); draw(); setText($('#dgCount', root), 0); };
    draw();
    $('#dgSave', root).onclick = async () => {
      const body = { name: val('dgName', root), plantId: val('dgPlant', root) || null, targetKw: Number(val('dgTarget', root)), marginKw: Number(val('dgMargin', root)), blockMin: Number(val('dgBlock', root)), releasePct: Number(val('dgRelease', root)) / 100, actionGapSec: Number(val('dgGap', root)), auto: val('dgAuto', root), enabled: val('dgEnabled', root), notes: val('dgNotes', root), meterIds: [...selected] };
      if (!body.name.trim() || !(body.targetKw > 0)) return toast('Name and target kW are required', 'err');
      if (!body.meterIds.length) return toast('Select at least one meter', 'err');
      try { await (g ? adm(`/demand/groups/${g.id}`, { method: 'PATCH', body }) : adm('/demand/groups', { body })); modal.close(); toast('Saved', 'ok'); onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  function stageForm(st, groupId, gateways, onDone) {
    const s7 = gateways.filter((g) => g.protocol === 'siemens-s7');
    const root = modal.open(`${modal.head(st ? 'Edit stage' : 'Add load-shedding stage', st ? st.name : '', 'layers')}
      <div class="form-grid c3">
        <div class="field span2"><label>Stage name *</label><input id="stName" value="${esc(st?.name || '')}" placeholder="e.g. Chiller 2 setpoint +2°C"></div>
        <div class="field"><label>Priority (1 = shed first)</label><input id="stPrio" type="number" value="${st?.priority ?? 1}"></div>
        <div class="field"><label>Estimated relief (kW)</label><input id="stKw" type="number" value="${st?.kwEstimate ?? ''}"></div>
        <div class="field"><label>Min off time (s)</label><input id="stMin" type="number" value="${st?.minOffSec ?? 120}"><div class="hint">stays shed at least this long</div></div>
        <div class="field"><label>Max off time (s)</label><input id="stMax" type="number" value="${st?.maxOffSec ?? 900}"><div class="hint">forced restore after this (equipment protection)</div></div>
        <div class="field span2"><label>PLC (Siemens S7)</label>${sel('stGw', s7.map((g) => ({ value: g.id, label: `${g.name} · ${g.host || ''}` })), st?.gatewayId, { blank: 'none — dry run (log only)' })}${s7.length ? '' : '<div class="hint">no PLC yet — add one on the <a href="#/settings/plc">PLC page</a></div>'}</div>
        <div class="field"><label>PLC tag to write (Node-RED address)</label><input id="stAddr" class="mono" value="${esc(st && st.tag ? S7Addr.format(st.tag) : 'DB1,X0.0')}" placeholder="DB1,X0.0 · DB10,INT4 · Q0.2"><div class="hint">BOOL bit or a numeric tag the PLC program reads</div></div>
        <div class="field"><label>Shed value → restore value</label><div class="row"><input id="stShed" type="number" step="any" value="${st?.shedValue ?? 1}"><span class="muted">→</span><input id="stRestore" type="number" step="any" value="${st?.restoreValue ?? 0}"></div></div>
        <div class="field span2"><label>Notes</label><input id="stNotes" value="${esc(st?.notes || '')}"></div>
        <div class="field check" style="align-self:end"><input type="checkbox" id="stEnabled" ${!st || st.enabled ? 'checked' : ''}><label for="stEnabled">Enabled</label></div>
      </div>
      <div class="muted" style="font-size:.66rem;margin-top:.6rem;line-height:1.6">The PLC program should read this tag and act on it (e.g. raise a chiller setpoint, unload a compressor, hold heaters). Write the shed value with the ▶ button in the stage list to verify the PLC reacts before enabling automatic control.</div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="stSave">Save</button></div>`, { wide: true });
    $('#stSave', root).onclick = async () => {
      const gw = val('stGw', root);
      const addr = val('stAddr', root);
      if (gw && !S7Addr.parse(addr)) return toast(`PLC tag: ${S7Addr.explain(addr)}`, 'err');
      const body = { groupId, name: val('stName', root), priority: Number(val('stPrio', root)), kwEstimate: val('stKw', root) === '' ? null : Number(val('stKw', root)), minOffSec: Number(val('stMin', root)), maxOffSec: Number(val('stMax', root)), gatewayId: gw || null,
        tag: gw ? S7Addr.parse(addr) : null,
        shedValue: Number(val('stShed', root)), restoreValue: Number(val('stRestore', root)), enabled: val('stEnabled', root), notes: val('stNotes', root) };
      if (!body.name.trim()) return toast('Stage name is required', 'err');
      try { await (st ? adm(`/demand/stages/${st.id}`, { method: 'PATCH', body }) : adm('/demand/stages', { body })); modal.close(); toast('Saved', 'ok'); onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ users */
  async function usersTab(body) {
    const d = await adm('/users');
    body.innerHTML = `<div class="row" style="margin-bottom:.8rem"><button class="btn primary" id="uAdd">${icon('plus')} Add user</button>
        <span class="muted" style="font-size:.7rem"><b>admin</b> configures everything · <b>operator</b> views + acknowledges alarms · <b>viewer</b> read-only (settings hidden)</span></div>
      <div class="table-wrap" style="max-height:none"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th>Created</th><th></th></tr></thead><tbody>
        ${d.users.map((u) => `<tr><td class="val-strong mono">${esc(u.username)}</td><td>${esc(u.display_name || '')}</td><td><span class="badge role ${u.role === 'admin' ? 'warn' : u.role === 'operator' ? 'info' : 'neutral'}">${u.role}</span></td><td>${u.enabled ? '<span class="badge ok">active</span>' : '<span class="badge critical">disabled</span>'}</td><td class="mono">${u.last_login ? fmtTime(Date.parse(u.last_login)) : '-'}</td><td class="mono">${fmtDate(Date.parse(u.created_at))}</td>
          <td class="nowrap"><button class="gbtn" data-edit="${u.id}" title="Edit">${icon('edit')}</button>${u.id !== S.me.user.id ? `<button class="gbtn" data-del="${u.id}" title="Delete">${icon('trash')}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    const reload = () => usersTab(body);
    $('#uAdd', body).onclick = () => userForm(null, reload);
    $$('[data-edit]', body).forEach((b) => { b.onclick = () => userForm(d.users.find((u) => u.id === Number(b.dataset.edit)), reload); });
    $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const u = d.users.find((x) => x.id === Number(b.dataset.del)); if (!await confirmDlg(`Delete user "${u.username}"?`, { danger: true, ok: 'Delete' })) return; await adm(`/users/${u.id}`, { method: 'DELETE' }); toast('Deleted', 'ok'); reload(); }; });
  }

  function userForm(u, onDone) {
    const root = modal.open(`${modal.head(u ? 'Edit user' : 'Add user', u ? u.username : '', 'users')}
      <div class="form-grid">
        <div class="field"><label>Username *</label><input id="uName" value="${esc(u?.username || '')}" ${u ? 'disabled' : ''}></div>
        <div class="field"><label>Display name</label><input id="uDisplay" value="${esc(u?.display_name || '')}"></div>
        <div class="field"><label>Role</label>${sel('uRole', [{ value: 'viewer', label: 'viewer — read-only' }, { value: 'operator', label: 'operator — view + acknowledge alarms' }, { value: 'admin', label: 'admin — full configuration' }], u?.role || 'viewer', { blank: null })}</div>
        <div class="field"><label>${u ? 'New password (blank = unchanged)' : 'Password *'}</label><input id="uPass" type="password" autocomplete="new-password"></div>
        <div class="field check"><input type="checkbox" id="uEnabled" ${!u || u.enabled ? 'checked' : ''}><label for="uEnabled">Enabled</label></div>
      </div>
      <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="uSave">Save</button></div>`, { narrow: true });
    $('#uSave', root).onclick = async () => {
      const body = { username: val('uName', root), displayName: val('uDisplay', root), role: val('uRole', root), password: val('uPass', root) || undefined, enabled: val('uEnabled', root) };
      if (!u && (!body.username.trim() || !body.password)) return toast('Username and password are required', 'err');
      try { await (u ? adm(`/users/${u.id}`, { method: 'PATCH', body }) : adm('/users', { body })); modal.close(); toast('Saved', 'ok'); onDone(); } catch (e) { toast(e.message, 'err'); }
      return null;
    };
  }

  /* ------------------------------------------------------------------ api keys */
  async function apiKeysTab(body) {
    const d = await adm('/api-keys');
    body.innerHTML = `<div class="row" style="margin-bottom:.8rem"><button class="btn primary" id="kAdd">${icon('plus')} Create API key</button><a class="btn" href="#/api">${icon('book')} API reference</a>
        <span class="muted" style="font-size:.7rem">the key is shown once, at creation · scopes: read / write / ingest / all</span></div>
      <div class="table-wrap" style="max-height:none"><table><thead><tr><th>Name</th><th>Key</th><th>Scopes</th><th>Created by</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.keys.map((k) => `<tr><td class="val-strong">${esc(k.name)}</td><td class="mono">${esc(k.prefix)}…</td><td>${k.scopes.split(',').map((s) => `<span class="evt-type">${esc(s)}</span>`).join(' ')}</td><td>${esc(k.created_by || '')}</td><td class="mono">${k.last_used_at ? fmtTime(Date.parse(k.last_used_at)) : 'never'}</td><td>${k.enabled ? '<span class="badge ok">active</span>' : '<span class="badge neutral">disabled</span>'}</td>
          <td class="nowrap"><button class="gbtn" data-toggle="${k.id}" title="${k.enabled ? 'Disable' : 'Enable'}">${icon(k.enabled ? 'x' : 'check')}</button><button class="gbtn" data-del="${k.id}" title="Delete">${icon('trash')}</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">No API keys yet</td></tr>'}
      </tbody></table></div>`;
    const reload = () => apiKeysTab(body);
    $('#kAdd', body).onclick = () => {
      const root = modal.open(`${modal.head('Create API key', '', 'key')}
        <div class="form-grid"><div class="field span2"><label>Name (consuming system) *</label><input id="kName" placeholder="e.g. MES integration, Node-RED, ESP32 pulse"></div>
        <div class="field span2"><label>Scopes</label><div class="row wrap">${['read', 'write', 'ingest', 'all'].map((s) => `<label class="chip click"><input type="checkbox" value="${s}" ${s === 'read' ? 'checked' : ''} style="accent-color:var(--accent)"> ${s}</label>`).join('')}</div></div></div>
        <div class="panel-foot"><button class="btn" onclick="modal.close()">Cancel</button><button class="btn primary right" id="kGo">Create</button></div>`, { narrow: true });
      $('#kGo', root).onclick = async () => {
        const scopes = $$('input:checked', root).map((c) => c.value);
        if (!val('kName', root).trim()) return toast('Name is required', 'err');
        const r = await adm('/api-keys', { body: { name: val('kName', root), scopes } });
        modal.open(`${modal.head('New API key', 'copy it now — it will not be shown again', 'key')}
          <div class="code" style="font-size:.85rem;color:var(--accent)">${esc(r.key)}</div>
          <div class="row" style="margin-top:.8rem"><button class="btn" onclick="copyText('${r.key}')">${icon('copy')} Copy</button></div>
          <div class="code" style="margin-top:.8rem">curl -H "X-Api-Key: ${esc(r.key)}" ${location.origin}/api/v1/meters</div>
          <div class="panel-foot"><button class="btn primary right" onclick="modal.close()">Done</button></div>`, { narrow: false });
        reload();
        return null;
      };
    };
    $$('[data-toggle]', body).forEach((b) => { b.onclick = async () => { const k = d.keys.find((x) => x.id === Number(b.dataset.toggle)); await adm(`/api-keys/${k.id}`, { method: 'PATCH', body: { enabled: !k.enabled } }); reload(); }; });
    $$('[data-del]', body).forEach((b) => { b.onclick = async () => { const k = d.keys.find((x) => x.id === Number(b.dataset.del)); if (!await confirmDlg(`Delete API key "${k.name}"? Systems using it will be rejected immediately.`, { danger: true, ok: 'Delete' })) return; await adm(`/api-keys/${k.id}`, { method: 'DELETE' }); reload(); }; });
  }

  /* ------------------------------------------------------------------ system */
  async function systemTab(body) {
    const [sys, audit] = await Promise.all([adm('/system'), adm('/audit?limit=100')]);
    const k = Views.kpi;
    body.innerHTML = `<div class="kpis">${k('s1', 'Uptime', fmtDur(sys.uptimeSec), { iconName: 'clock' })}${k('s2', 'Samples stored', sys.samples.toLocaleString(), { iconName: 'energy', sub: `store interval ${S.meta.config.storeIntervalSec} s` })}${k('s3', 'Memory', sys.memoryMb, { unit: 'MB', iconName: 'gauge', sub: sys.node })}${k('s4', 'WebSocket clients', sys.wsClients, { iconName: 'wave' })}</div>
      <div class="form-grid">
        <div class="card"><div class="card-head"><div class="card-title">Engine</div></div><div class="card-body">
          <p class="muted" style="font-size:.72rem;line-height:1.7"><code class="mono">.env</code>: STORE_INTERVAL_SEC=${S.meta.config.storeIntervalSec} · OFFLINE_AFTER_SEC=${S.meta.config.offlineAfterSec} · DEFAULT_POLL_MS=${S.meta.config.defaultPollMs} · after editing run <code class="mono">pm2 restart power-center</code></p>
          <div class="row" style="margin-top:.6rem"><button class="btn" id="sysReload">${icon('refresh')} Reload acquisition engine</button></div>
          <div class="sec-title">Protocol modules</div>
          <div class="row wrap">${sys.protocols.map((p) => `<span class="chip ${p.available ? 'ok' : 'err'}"><b>${p.available ? '●' : '○'}</b> ${esc(p.id)}</span>`).join('')}</div></div></div>
        <div class="card"><div class="card-head"><div class="card-title">Audit log</div><span class="muted right" style="font-size:.66rem">last 100 entries</span></div>
          <div class="table-wrap" style="max-height:360px;border:none;border-radius:0"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th></tr></thead><tbody>
            ${audit.rows.map((r) => `<tr><td class="mono nowrap">${fmtTime(Date.parse(r.at))}</td><td class="mono">${esc(r.username || '')}</td><td>${esc(r.action)}</td><td class="muted" style="font-size:.64rem">${esc(r.target || '')} ${esc((r.detail || '').slice(0, 60))}</td></tr>`).join('')}
          </tbody></table></div></div>
      </div>`;
    $('#sysReload', body).onclick = async () => { await adm('/reload', { method: 'POST' }); toast('Engine reloaded', 'ok'); };
  }

  return { page, gatewayForm, meterForm, plcForm, plantForm, lineForm };
})();
