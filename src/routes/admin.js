const express = require('express');
const { db, statements, now, audit, deleteMeter, deleteLine, deletePlant, deleteGateway, deleteSection, deleteDemandGroup, reorder, getSetting, setSetting, parseJson } = require('../db');
const S7Addr = require('../s7addr');
const auth = require('../auth');
const drivers = require('../drivers');
const templates = require('../templates');
const views = require('../views');
const { deriveMissing } = require('../metrics');

/*
 * Admin API - configuration of the whole system. Mounted at /api/admin,
 * every route requires the admin role. Config changes call poller.reload()
 * so the acquisition engine picks them up without a restart.
 */
const router = express.Router();
router.use(auth.requireRole('admin'));

const reload = (req) => {
  const p = req.app.locals.poller;
  if (p) p.reload().catch((e) => console.error('reload failed:', e.message));
};

const str = (v, max = 120) => (v === undefined || v === null ? null : String(v).trim().slice(0, max) || null);
const numOrNull = (v) => (v === undefined || v === null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const jsonOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') { try { JSON.parse(v); return v; } catch (e) { return null; } }
  return JSON.stringify(v);
};

const fail = (res, msg, code = 400) => res.status(code).json({ success: false, error: msg });

// ---------------- plants ----------------
router.post('/plants', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  if (!name) return fail(res, 'name required');
  try {
    const info = statements.createPlant.run(name, str(b.code, 20), str(b.province, 60), str(b.address, 200), Date.now(), now());
    audit(req.user, 'create_plant', String(info.lastInsertRowid), name);
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    return fail(res, 'plant name already exists');
  }
});

router.patch('/plants/:id', (req, res) => {
  const b = req.body || {};
  const cur = statements.getPlant.get(req.params.id);
  if (!cur) return fail(res, 'plant not found', 404);
  try {
    statements.updatePlant.run(str(b.name, 80) || cur.name, b.code === undefined ? cur.code : str(b.code, 20),
      b.province === undefined ? cur.province : str(b.province, 60), b.address === undefined ? cur.address : str(b.address, 200), cur.id);
    audit(req.user, 'update_plant', String(cur.id), b);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, 'plant name already exists');
  }
});

router.delete('/plants/:id', (req, res) => {
  deletePlant(Number(req.params.id));
  audit(req.user, 'delete_plant', req.params.id);
  reload(req);
  res.json({ success: true });
});

router.post('/plants/reorder', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return fail(res, 'ids required');
  reorder(statements.setPlantOrder, ids.map(Number));
  res.json({ success: true });
});

// ---------------- lines ----------------
router.post('/lines', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  const plantId = numOrNull(b.plantId);
  if (!name || !plantId) return fail(res, 'name and plantId required');
  try {
    const info = statements.createLine.run(plantId, name, str(b.code, 20), Date.now(), now());
    audit(req.user, 'create_line', String(info.lastInsertRowid), name);
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    return fail(res, 'line name already exists in this plant');
  }
});

router.patch('/lines/:id', (req, res) => {
  const b = req.body || {};
  const cur = statements.getLine.get(req.params.id);
  if (!cur) return fail(res, 'line not found', 404);
  const plantId = numOrNull(b.plantId) || cur.plant_id;
  try {
    statements.updateLine.run(str(b.name, 80) || cur.name, b.code === undefined ? cur.code : str(b.code, 20), plantId, cur.id);
    if (plantId !== cur.plant_id) {
      // meters follow their line to the new plant
      for (const m of statements.metersOfLine.all(cur.id)) statements.updateMeter.run({ ...m, plant_id: plantId });
      reload(req);
    }
    audit(req.user, 'update_line', String(cur.id), b);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, 'line name already exists in this plant');
  }
});

router.delete('/lines/:id', (req, res) => {
  deleteLine(Number(req.params.id));
  audit(req.user, 'delete_line', req.params.id);
  reload(req);
  res.json({ success: true });
});

router.post('/lines/reorder', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return fail(res, 'ids required');
  reorder(statements.setLineOrder, ids.map(Number));
  res.json({ success: true });
});

// ---------------- sections ----------------
router.post('/sections', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  const lineId = numOrNull(b.lineId);
  if (!name || !lineId) return fail(res, 'name and lineId required');
  try {
    const info = statements.createSection.run(lineId, name, Date.now());
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    return fail(res, 'section already exists in this line');
  }
});

router.patch('/sections/:id', (req, res) => {
  const name = str((req.body || {}).name, 80);
  if (!name) return fail(res, 'name required');
  try {
    statements.updateSection.run(name, req.params.id);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, 'section already exists in this line');
  }
});

router.delete('/sections/:id', (req, res) => {
  deleteSection(Number(req.params.id));
  res.json({ success: true });
});

// ---------------- gateways ----------------
const gatewayBody = (b, cur = {}) => {
  const protocol = drivers.get(b.protocol || cur.protocol) ? (b.protocol || cur.protocol) : 'modbus-tcp';
  return {
    plant_id: b.plantId === undefined ? (cur.plant_id ?? null) : numOrNull(b.plantId),
    name: str(b.name, 80) || cur.name,
    protocol,
    host: b.host === undefined ? (cur.host ?? null) : str(b.host, 120),
    port: b.port === undefined ? (cur.port ?? drivers.get(protocol).defaultPort) : numOrNull(b.port),
    config_json: b.config === undefined ? (cur.config_json ?? null) : jsonOrNull(b.config),
    enabled: b.enabled === undefined ? (cur.enabled ?? 1) : (b.enabled ? 1 : 0),
    notes: b.notes === undefined ? (cur.notes ?? null) : str(b.notes, 500),
  };
};

router.post('/gateways', (req, res) => {
  const g = gatewayBody(req.body || {});
  if (!g.name) return fail(res, 'name required');
  const info = statements.createGateway.run(g.plant_id, g.name, g.protocol, g.host, g.port, g.config_json, g.enabled, g.notes, now());
  audit(req.user, 'create_gateway', String(info.lastInsertRowid), g.name);
  reload(req);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.patch('/gateways/:id', (req, res) => {
  const cur = statements.getGateway.get(req.params.id);
  if (!cur) return fail(res, 'gateway not found', 404);
  const g = gatewayBody(req.body || {}, cur);
  statements.updateGateway.run(g.plant_id, g.name, g.protocol, g.host, g.port, g.config_json, g.enabled, g.notes, cur.id);
  audit(req.user, 'update_gateway', String(cur.id), req.body);
  reload(req);
  res.json({ success: true });
});

router.delete('/gateways/:id', (req, res) => {
  deleteGateway(Number(req.params.id));
  if (req.app.locals.alarms) req.app.locals.alarms.forgetGateway(Number(req.params.id));
  audit(req.user, 'delete_gateway', req.params.id);
  reload(req);
  res.json({ success: true });
});

/**
 * Commissioning helper: connect to a gateway with the given settings and read
 * one meter once, without saving anything. Body:
 *   { protocol, host, port, config, meter: { template, unitId, registerMap, conn } }
 */
router.post('/gateways/test', async (req, res) => {
  const b = req.body || {};
  const g = { id: 0, ...gatewayBody(b), config: b.config || {} };
  const proto = drivers.get(g.protocol);
  if (!proto) return fail(res, 'unknown protocol');
  if (proto.kind !== 'poll') return fail(res, `protocol "${g.protocol}" is ${proto.kind}-driven; nothing to poll`);
  const driver = drivers.create(g);
  if (!driver) return fail(res, 'driver unavailable');
  const mb = b.meter || {};
  const meter = {
    id: -1, template: mb.template || 'schneider-pm5xxx', unit_id: numOrNull(mb.unitId) || 1,
    register_map_json: jsonOrNull(mb.registerMap), conn: mb.conn || {}, nominal_v: 230, nominal_hz: 50, rated_kw: 100, phases: 3,
  };
  const t0 = Date.now();
  try {
    await driver.connect();
    if (g.protocol === 'siemens-s7' && !mb.template) {
      // no meter given: report the CPU diagnostics instead of a register read
      const plc = await driver.plcInfo();
      await driver.close();
      return res.json({ success: true, connectMs: Date.now() - t0, latencyMs: plc.latencyMs, requests: 1, errors: 0, lastError: null, values: {}, plc });
    }
    const stat = await driver.readMeter(meter);
    await driver.close();
    return res.json({
      success: true,
      connectMs: Date.now() - t0,
      latencyMs: stat.latencyMs,
      requests: stat.requests,
      errors: stat.errors,
      lastError: stat.lastError,
      values: deriveMissing(stat.values || {}),
    });
  } catch (e) {
    await driver.close().catch(() => {});
    return res.json({ success: false, error: e.message, connectMs: Date.now() - t0 });
  }
});

// ---------------- meters ----------------
const meterBody = (b, cur = {}) => {
  const templateId = templates.get(b.template || cur.template) ? (b.template || cur.template) : 'schneider-pm5xxx';
  const t = templates.get(templateId);
  const pick = (key, curKey, conv = (x) => x) => (b[key] === undefined ? (cur[curKey] ?? null) : conv(b[key]));
  return {
    id: cur.id,
    plant_id: pick('plantId', 'plant_id', numOrNull),
    line_id: pick('lineId', 'line_id', numOrNull),
    section_id: pick('sectionId', 'section_id', numOrNull),
    gateway_id: pick('gatewayId', 'gateway_id', numOrNull),
    name: str(b.name, 80) || cur.name,
    code: pick('code', 'code', (v) => str(v, 40)),
    template: templateId,
    unit_id: pick('unitId', 'unit_id', (v) => numOrNull(v) ?? 1),
    conn_json: pick('conn', 'conn_json', jsonOrNull),
    register_map_json: pick('registerMap', 'register_map_json', jsonOrNull),
    poll_ms: pick('pollMs', 'poll_ms', numOrNull),
    nominal_v: pick('nominalV', 'nominal_v', (v) => numOrNull(v) ?? (t.defaults.nominalV || 230)),
    nominal_hz: pick('nominalHz', 'nominal_hz', (v) => numOrNull(v) ?? (t.defaults.nominalHz || 50)),
    ct_primary: pick('ctPrimary', 'ct_primary', numOrNull),
    rated_kw: pick('ratedKw', 'rated_kw', numOrNull),
    rated_a: pick('ratedA', 'rated_a', numOrNull),
    phases: pick('phases', 'phases', (v) => numOrNull(v) ?? 3),
    alarm_json: pick('alarmConfig', 'alarm_json', jsonOrNull),
    enabled: b.enabled === undefined ? (cur.enabled ?? 1) : (b.enabled ? 1 : 0),
    sort_order: pick('sortOrder', 'sort_order', (v) => numOrNull(v) ?? 0),
    notes: pick('notes', 'notes', (v) => str(v, 500)),
  };
};

router.post('/meters', (req, res) => {
  const m = meterBody(req.body || {});
  if (!m.name) return fail(res, 'name required');
  if (m.line_id && !m.plant_id) m.plant_id = statements.getLine.get(m.line_id)?.plant_id || null;
  try {
    const info = statements.createMeter.run({ ...m, created_at: now() });
    audit(req.user, 'create_meter', String(info.lastInsertRowid), m.name);
    reload(req);
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    return fail(res, /UNIQUE/.test(e.message) ? 'meter code already exists' : e.message);
  }
});

router.patch('/meters/:id', (req, res) => {
  const cur = statements.getMeter.get(req.params.id);
  if (!cur) return fail(res, 'meter not found', 404);
  const m = meterBody(req.body || {}, cur);
  if (m.line_id && (req.body || {}).plantId === undefined) m.plant_id = statements.getLine.get(m.line_id)?.plant_id || m.plant_id;
  try {
    statements.updateMeter.run(m);
    audit(req.user, 'update_meter', String(cur.id), req.body);
    reload(req);
    return res.json({ success: true });
  } catch (e) {
    return fail(res, /UNIQUE/.test(e.message) ? 'meter code already exists' : e.message);
  }
});

router.delete('/meters/:id', (req, res) => {
  const id = Number(req.params.id);
  deleteMeter(id);
  const a = req.app.locals.alarms;
  if (a) a.forgetMeter(id);
  audit(req.user, 'delete_meter', req.params.id);
  reload(req);
  res.json({ success: true });
});

router.post('/meters/reorder', (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) return fail(res, 'ids required');
  reorder(statements.setMeterOrder, ids.map(Number));
  res.json({ success: true });
});

// bulk: create N meters on one gateway with consecutive unit ids (commissioning a whole line)
router.post('/meters/bulk', (req, res) => {
  const b = req.body || {};
  const count = Math.min(Math.max(parseInt(b.count, 10) || 0, 1), 250);
  const startUnit = parseInt(b.startUnitId, 10) || 1;
  const prefix = str(b.namePrefix, 40) || 'Meter';
  const ids = [];
  for (let i = 0; i < count; i += 1) {
    const m = meterBody({ ...b, name: `${prefix} ${String(startUnit + i).padStart(2, '0')}`, unitId: startUnit + i, code: b.codePrefix ? `${b.codePrefix}-${startUnit + i}` : undefined });
    if (m.line_id && !m.plant_id) m.plant_id = statements.getLine.get(m.line_id)?.plant_id || null;
    try { ids.push(statements.createMeter.run({ ...m, created_at: now() }).lastInsertRowid); } catch (e) { /* skip dup */ }
  }
  audit(req.user, 'bulk_create_meters', null, `${ids.length} meters`);
  reload(req);
  res.json({ success: true, ids });
});

// ---------------- peak demand ----------------
const demandReload = (req) => { const d = req.app.locals.demand; if (d) d.reload(); };
const groupBody = (b, cur = {}) => ({
  id: cur.id,
  plant_id: b.plantId === undefined ? (cur.plant_id ?? null) : numOrNull(b.plantId),
  name: str(b.name, 80) || cur.name,
  target_kw: b.targetKw === undefined ? (cur.target_kw ?? 1000) : Number(b.targetKw),
  margin_kw: b.marginKw === undefined ? (cur.margin_kw ?? 50) : Number(b.marginKw),
  block_min: b.blockMin === undefined ? (cur.block_min ?? 15) : Math.max(1, parseInt(b.blockMin, 10) || 15),
  release_pct: b.releasePct === undefined ? (cur.release_pct ?? 0.9) : Math.min(1, Math.max(0.1, Number(b.releasePct) || 0.9)),
  action_gap_sec: b.actionGapSec === undefined ? (cur.action_gap_sec ?? 30) : Math.max(5, parseInt(b.actionGapSec, 10) || 30),
  meter_ids: b.meterIds === undefined ? (cur.meter_ids ?? '[]') : JSON.stringify((Array.isArray(b.meterIds) ? b.meterIds : []).map(Number).filter(Number.isFinite)),
  auto: b.auto === undefined ? (cur.auto ?? 0) : (b.auto ? 1 : 0),
  enabled: b.enabled === undefined ? (cur.enabled ?? 1) : (b.enabled ? 1 : 0),
  notes: b.notes === undefined ? (cur.notes ?? null) : str(b.notes, 500),
});
const stageBody = (b, cur = {}) => ({
  id: cur.id,
  group_id: b.groupId === undefined ? cur.group_id : Number(b.groupId),
  name: str(b.name, 80) || cur.name,
  priority: b.priority === undefined ? (cur.priority ?? 1) : (parseInt(b.priority, 10) || 1),
  gateway_id: b.gatewayId === undefined ? (cur.gateway_id ?? null) : numOrNull(b.gatewayId),
  tag_json: b.tag === undefined ? (cur.tag_json ?? null) : jsonOrNull(b.tag),
  shed_value: b.shedValue === undefined ? (cur.shed_value ?? 1) : Number(b.shedValue),
  restore_value: b.restoreValue === undefined ? (cur.restore_value ?? 0) : Number(b.restoreValue),
  kw_estimate: b.kwEstimate === undefined ? (cur.kw_estimate ?? null) : numOrNull(b.kwEstimate),
  min_off_sec: b.minOffSec === undefined ? (cur.min_off_sec ?? 120) : Math.max(0, parseInt(b.minOffSec, 10) || 0),
  max_off_sec: b.maxOffSec === undefined ? (cur.max_off_sec ?? 900) : Math.max(30, parseInt(b.maxOffSec, 10) || 900),
  enabled: b.enabled === undefined ? (cur.enabled ?? 1) : (b.enabled ? 1 : 0),
  notes: b.notes === undefined ? (cur.notes ?? null) : str(b.notes, 500),
});

router.post('/demand/groups', (req, res) => {
  const g = groupBody(req.body || {});
  if (!g.name) return fail(res, 'name required');
  const info = statements.createDemandGroup.run({ ...g, created_at: now() });
  audit(req.user, 'create_demand_group', String(info.lastInsertRowid), g.name);
  demandReload(req);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.patch('/demand/groups/:id', (req, res) => {
  const cur = statements.getDemandGroup.get(req.params.id);
  if (!cur) return fail(res, 'group not found', 404);
  statements.updateDemandGroup.run(groupBody(req.body || {}, cur));
  audit(req.user, 'update_demand_group', String(cur.id), req.body);
  demandReload(req);
  return res.json({ success: true });
});

router.delete('/demand/groups/:id', (req, res) => {
  deleteDemandGroup(Number(req.params.id));
  audit(req.user, 'delete_demand_group', req.params.id);
  demandReload(req);
  res.json({ success: true });
});

router.post('/demand/stages', (req, res) => {
  const s = stageBody(req.body || {});
  if (!s.name || !s.group_id) return fail(res, 'name and groupId required');
  const info = statements.createDemandStage.run(s);
  audit(req.user, 'create_demand_stage', String(info.lastInsertRowid), s.name);
  demandReload(req);
  res.json({ success: true, id: info.lastInsertRowid });
});

router.patch('/demand/stages/:id', (req, res) => {
  const cur = statements.getDemandStage.get(req.params.id);
  if (!cur) return fail(res, 'stage not found', 404);
  statements.updateDemandStage.run(stageBody(req.body || {}, cur));
  audit(req.user, 'update_demand_stage', String(cur.id), req.body);
  demandReload(req);
  return res.json({ success: true });
});

router.delete('/demand/stages/:id', (req, res) => {
  statements.deleteDemandStage.run(req.params.id);
  audit(req.user, 'delete_demand_stage', req.params.id);
  demandReload(req);
  res.json({ success: true });
});

// write the stage tag once (commissioning): body { value } - defaults to the shed value
router.post('/demand/stages/:id/test', async (req, res) => {
  try {
    const row = statements.getDemandStage.get(req.params.id);
    if (!row) return fail(res, 'stage not found', 404);
    const value = (req.body || {}).value === undefined ? row.shed_value : Number((req.body || {}).value);
    const r = await req.app.locals.demand.testStage(row.id, value);
    audit(req.user, 'test_demand_stage', String(row.id), String(value));
    return res.json({ success: true, dryRun: !!r.dryRun, value });
  } catch (e) { return res.json({ success: false, error: e.message }); }
});

// Siemens S7: read / write arbitrary tags through a configured gateway (commissioning)
router.post('/gateways/:id/s7/read', async (req, res) => {
  const w = req.app.locals.poller.workers.get(Number(req.params.id));
  if (!w || !w.driver || typeof w.driver.readTags !== 'function') return fail(res, 'gateway is not a running S7 gateway');
  if (!w.driver.connected) return fail(res, 'gateway not connected');
  const tags = Array.isArray((req.body || {}).tags) ? req.body.tags : [];
  if (!tags.length) return fail(res, 'tags required');
  try {
    const stat = await w.driver.readTags(tags.map((t, i) => ({ key: t.key || ('t' + i), ...t })));
    return res.json({ success: true, ...stat });
  } catch (e) { return res.json({ success: false, error: e.message }); }
});

router.post('/gateways/:id/s7/write', async (req, res) => {
  const w = req.app.locals.poller.workers.get(Number(req.params.id));
  if (!w || !w.driver || typeof w.driver.writeTag !== 'function') return fail(res, 'gateway is not a running S7 gateway');
  if (!w.driver.connected) return fail(res, 'gateway not connected');
  const { tag, value } = req.body || {};
  if (!tag) return fail(res, 'tag required');
  try {
    await w.driver.writeTag(tag, value);
    audit(req.user, 's7_write', req.params.id, { tag, value });
    return res.json({ success: true });
  } catch (e) { return res.json({ success: false, error: e.message }); }
});

// ---------------- PLC (Siemens S7) ----------------
/*
 * One PLC = one siemens-s7 gateway (connection) + one or more devices (variable
 * sets). Saved in a single transaction so the connection and its variables never
 * drift apart. Body:
 *   { gateway: { id?, name, plantId, host, port, rack, slot, timeoutMs, lib, enabled, notes },
 *     device:  { id?, name, code, lineId, sectionId, template, pollMs, faceKey, variables: [ { addr, key, label, group, ... } ], enabled, ... } }
 * Variables use Node-RED addresses (DB1004,REAL20); they are stored as S7 tags.
 */
const plcTag = (v) => {
  const t = S7Addr.parse(v.addr);
  if (!t) throw new Error(`variable "${v.key || v.label || v.addr || '?'}": ${S7Addr.explain(v.addr)}`);
  const tag = { ...v, ...t };
  delete tag.addr;
  const n = templates.normalizeTag(tag);
  if (!n) throw new Error(`variable at ${v.addr} needs a key`);
  return n;
};

const savePlc = db.transaction((g, d, user) => {
  let gatewayId = g.id;
  if (gatewayId) {
    statements.updateGateway.run(g.plant_id, g.name, 'siemens-s7', g.host, g.port, g.config_json, g.enabled, g.notes, gatewayId);
    audit(user, 'update_plc', String(gatewayId), g.name);
  } else {
    gatewayId = statements.createGateway.run(g.plant_id, g.name, 'siemens-s7', g.host, g.port, g.config_json, g.enabled, g.notes, now()).lastInsertRowid;
    audit(user, 'create_plc', String(gatewayId), g.name);
  }
  let deviceId = d.id;
  if (deviceId) statements.updateMeter.run({ ...d, gateway_id: gatewayId });
  else deviceId = statements.createMeter.run({ ...d, gateway_id: gatewayId, created_at: now() }).lastInsertRowid;
  return { gatewayId, deviceId };
});

router.post('/plc', (req, res) => {
  const b = req.body || {};
  const gb = b.gateway || {};
  const dbd = b.device || {};
  const curG = gb.id ? statements.getGateway.get(gb.id) : null;
  if (gb.id && !curG) return fail(res, 'PLC not found', 404);
  if (curG && curG.protocol !== 'siemens-s7') return fail(res, 'gateway is not a Siemens S7 PLC');
  const curD = dbd.id ? statements.getMeter.get(dbd.id) : null;
  if (dbd.id && !curD) return fail(res, 'device not found', 404);
  const curCfg = curG ? parseJson(curG.config_json, {}) : {};
  const g = gatewayBody({
    ...gb,
    protocol: 'siemens-s7',
    port: gb.port === undefined ? (curG ? curG.port : 102) : gb.port,
    config: { ...curCfg, rack: numOrNull(gb.rack) ?? curCfg.rack ?? 0, slot: numOrNull(gb.slot) ?? curCfg.slot ?? 1, timeoutMs: numOrNull(gb.timeoutMs) ?? curCfg.timeoutMs ?? 3000, lib: ['auto', 'snap7', 'nodes7'].includes(gb.lib) ? gb.lib : (curCfg.lib || 'auto') },
  }, curG || {});
  g.id = curG ? curG.id : null;
  if (!g.name) return fail(res, 'PLC name required');
  if (!g.host) return fail(res, 'PLC address (IP) required');
  let registerMap;
  try {
    const vars = Array.isArray(dbd.variables) ? dbd.variables : null;
    if (vars) {
      const tags = vars.map(plcTag);
      const keys = new Set();
      for (const t of tags) { if (keys.has(t.key)) return fail(res, `duplicate variable key "${t.key}"`); keys.add(t.key); }
      registerMap = { registers: tags };
    } else registerMap = curD ? parseJson(curD.register_map_json, null) : null;
  } catch (e) { return fail(res, e.message); }
  const curConn = curD ? parseJson(curD.conn_json, {}) : {};
  const conn = { ...curConn, faceKey: dbd.faceKey === undefined ? curConn.faceKey : (dbd.faceKey || undefined) };
  Object.keys(conn).forEach((k) => { if (conn[k] === undefined || conn[k] === '') delete conn[k]; });
  const d = meterBody({ ...dbd, template: dbd.template || (curD ? curD.template : 'siemens-s7-tags'), plantId: dbd.plantId === undefined ? g.plant_id : dbd.plantId, registerMap, conn: Object.keys(conn).length ? conn : null, unitId: 1, alarmConfig: dbd.alarmConfig !== undefined ? dbd.alarmConfig : (curD ? undefined : { enabled: false }) }, curD || {});
  d.id = curD ? curD.id : null;
  d.name = d.name || g.name;
  if (d.line_id && !d.plant_id) d.plant_id = statements.getLine.get(d.line_id)?.plant_id || null;
  if (!templates.get(d.template) || templates.get(d.template).protocolHint !== 's7') d.template = 'siemens-s7-tags';
  try {
    const r = savePlc(g, d, req.user);
    reload(req);
    return res.json({ success: true, ...r });
  } catch (e) {
    return fail(res, /UNIQUE/.test(e.message) ? 'device code already exists' : e.message);
  }
});

router.delete('/plc/:id', (req, res) => {
  const id = Number(req.params.id);
  const g = statements.getGateway.get(id);
  if (!g) return fail(res, 'PLC not found', 404);
  const a = req.app.locals.alarms;
  db.transaction(() => {
    for (const m of statements.listMeters.all().filter((x) => x.gateway_id === id)) { deleteMeter(m.id); if (a) a.forgetMeter(m.id); }
    deleteGateway(id);
  })();
  if (a) a.forgetGateway(id);
  audit(req.user, 'delete_plc', String(id), g.name);
  reload(req);
  res.json({ success: true });
});

// validate Node-RED addresses without saving (live feedback in the editor)
router.post('/plc/parse', (req, res) => {
  const list = Array.isArray((req.body || {}).addresses) ? req.body.addresses : [];
  res.json({ success: true, results: list.map((a) => ({ addr: a, tag: S7Addr.parse(a), error: S7Addr.parse(a) ? '' : S7Addr.explain(a) })) });
});

// ---------------- users ----------------
router.get('/users', (req, res) => res.json({ success: true, users: statements.listUsers.all() }));

router.post('/users', (req, res) => {
  const b = req.body || {};
  const username = str(b.username, 40);
  if (!username || !b.password) return fail(res, 'username and password required');
  if (!auth.ROLES.includes(b.role)) return fail(res, 'invalid role');
  const { salt, hash } = auth.hashPassword(b.password);
  try {
    const info = statements.createUser.run(username, hash, salt, b.role, str(b.displayName, 80), now());
    audit(req.user, 'create_user', username, b.role);
    return res.json({ success: true, id: info.lastInsertRowid });
  } catch (e) {
    return fail(res, 'username already exists');
  }
});

router.patch('/users/:id', (req, res) => {
  const b = req.body || {};
  const cur = statements.getUser.get(req.params.id);
  if (!cur) return fail(res, 'user not found', 404);
  const role = auth.ROLES.includes(b.role) ? b.role : cur.role;
  const enabled = b.enabled === undefined ? cur.enabled : (b.enabled ? 1 : 0);
  if (cur.id === req.user.id && (role !== 'admin' || !enabled)) return fail(res, 'cannot demote or disable yourself');
  statements.updateUser.run(role, b.displayName === undefined ? cur.display_name : str(b.displayName, 80), enabled, cur.id);
  if (b.password) {
    const { salt, hash } = auth.hashPassword(b.password);
    statements.setPassword.run(hash, salt, cur.id);
    statements.deleteUserSessions.run(cur.id);
  }
  if (!enabled) statements.deleteUserSessions.run(cur.id);
  audit(req.user, 'update_user', cur.username, { role, enabled, password: !!b.password });
  return res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
  if (Number(req.params.id) === req.user.id) return fail(res, 'cannot delete yourself');
  statements.deleteUserSessions.run(req.params.id);
  statements.deleteUser.run(req.params.id);
  audit(req.user, 'delete_user', req.params.id);
  res.json({ success: true });
});

// ---------------- API keys ----------------
router.get('/api-keys', (req, res) => res.json({ success: true, keys: statements.listApiKeys.all() }));

router.post('/api-keys', (req, res) => {
  const b = req.body || {};
  const name = str(b.name, 80);
  if (!name) return fail(res, 'name required');
  const scopes = (Array.isArray(b.scopes) ? b.scopes : String(b.scopes || 'read').split(','))
    .map((s) => s.trim()).filter((s) => ['read', 'write', 'ingest', 'all'].includes(s));
  const created = auth.createApiKey(name, scopes.length ? scopes.join(',') : 'read', req.user.username);
  audit(req.user, 'create_api_key', name, scopes.join(','));
  res.json({ success: true, id: created.id, key: created.key, scopes });
});

router.patch('/api-keys/:id', (req, res) => {
  const b = req.body || {};
  const cur = statements.listApiKeys.all().find((k) => k.id === Number(req.params.id));
  if (!cur) return fail(res, 'key not found', 404);
  const scopes = b.scopes === undefined ? cur.scopes : (Array.isArray(b.scopes) ? b.scopes.join(',') : String(b.scopes));
  statements.updateApiKey.run(str(b.name, 80) || cur.name, scopes, b.enabled === undefined ? cur.enabled : (b.enabled ? 1 : 0), cur.id);
  res.json({ success: true });
});

router.delete('/api-keys/:id', (req, res) => {
  statements.deleteApiKey.run(req.params.id);
  audit(req.user, 'delete_api_key', req.params.id);
  res.json({ success: true });
});

// ---------------- settings / system ----------------
router.get('/settings', (req, res) => {
  res.json({ success: true, settings: Object.fromEntries(statements.allSettings.all().map((r) => [r.key, r.value])) });
});

router.post('/settings', (req, res) => {
  const b = req.body || {};
  for (const [k, v] of Object.entries(b)) if (/^[a-z0-9_.-]{1,60}$/i.test(k)) setSetting(k, v);
  audit(req.user, 'update_settings', null, Object.keys(b).join(','));
  res.json({ success: true });
});

router.get('/audit', (req, res) => {
  res.json({ success: true, rows: statements.listAudit.all(Math.min(parseInt(req.query.limit, 10) || 200, 2000)) });
});

router.post('/reload', (req, res) => {
  reload(req);
  res.json({ success: true });
});

router.get('/system', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    success: true,
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
    memoryMb: Math.round(mem.rss / 1048576),
    samples: statements.countSamples.get().n,
    dbFile: 'data/power.db',
    wsClients: req.app.locals.realtime ? req.app.locals.realtime.clients.size : 0,
    protocols: drivers.list(),
  });
});

module.exports = router;
