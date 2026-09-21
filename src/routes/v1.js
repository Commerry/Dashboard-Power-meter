const express = require('express');
const { statements, parseJson } = require('../db');
const auth = require('../auth');
const report = require('../report');
const views = require('../views');
const { METRICS } = require('../metrics');
const { pickJson } = require('../drivers/decode');
const templates = require('../templates');

/*
 * Public API v1 - for other systems (MES, ERP, BI, Node-RED, PLC gateways).
 * Mounted at /api/v1. Authenticate with an API key (Settings > API keys):
 *
 *   X-Api-Key: pc_xxxxxxxx           (or ?api_key=... or Authorization: Bearer)
 *
 * Scopes:  read   - everything under GET
 *          write  - acknowledge alarms
 *          ingest - POST /ingest (devices pushing their own readings)
 *          all    - everything
 *
 * Times are unix milliseconds unless stated. Full reference: docs/API.md
 */
const router = express.Router();

const toMs = (input, fallback) => {
  if (input === undefined || input === null || input === '') return fallback;
  if (/^\d+$/.test(String(input))) return Number(input);
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? fallback : d.getTime();
};
const rangeOf = (q) => {
  const to = toMs(q.to, Date.now());
  const from = toMs(q.from, to - 24 * 3600000);
  return { from, to };
};

const findMeter = (idOrCode) => (/^\d+$/.test(String(idOrCode))
  ? statements.getMeter.get(Number(idOrCode))
  : statements.getMeterByCode.get(String(idOrCode)));

// ---------------- read ----------------
router.get('/ping', (req, res) => res.json({ success: true, at: Date.now(), version: 1 }));

router.get('/metrics', auth.requireApiKey('read'), (req, res) => res.json({ success: true, metrics: METRICS }));

router.get('/plants', auth.requireApiKey('read'), (req, res) => res.json({ success: true, ...views.tree() }));

router.get('/gateways', auth.requireApiKey('read'), (req, res) => {
  const maps = views.nameMaps();
  res.json({ success: true, gateways: statements.listGateways.all().map((g) => ({ ...views.gatewayView(g, maps), config: undefined })) });
});

router.get('/meters', auth.requireApiKey('read'), (req, res) => {
  const maps = views.nameMaps();
  let rows = statements.listMeters.all();
  if (req.query.plantId) rows = rows.filter((m) => m.plant_id === Number(req.query.plantId));
  if (req.query.lineId) rows = rows.filter((m) => m.line_id === Number(req.query.lineId));
  const compact = req.query.values === '0';
  res.json({ success: true, at: Date.now(), meters: rows.map((m) => { const v = views.meterView(m, maps); if (compact) delete v.values; return v; }) });
});

router.get('/meters/:id', auth.requireApiKey('read'), (req, res) => {
  const row = findMeter(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  return res.json({ success: true, meter: views.meterView(row) });
});

// latest values only - the cheapest call for polling integrations
router.get('/meters/:id/latest', auth.requireApiKey('read'), (req, res) => {
  const row = findMeter(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const v = views.meterView(row);
  return res.json({ success: true, meterId: v.id, code: v.code, name: v.name, status: v.status, at: v.at, alarm: v.alarm, values: v.values });
});

router.get('/meters/:id/history', auth.requireApiKey('read'), (req, res) => {
  const row = findMeter(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const { from, to } = rangeOf(req.query);
  const keys = req.query.keys ? String(req.query.keys).split(',') : undefined;
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 50000);
  return res.json({ success: true, meterId: row.id, from, to, ...report.series({ meterId: row.id, meter: row, from, to, interval: req.query.interval || 'raw', keys, limit }) });
});

router.get('/meters/:id/summary', auth.requireApiKey('read'), (req, res) => {
  const row = findMeter(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const { from, to } = rangeOf(req.query);
  return res.json({ success: true, meterId: row.id, from, to, ...report.summary(row.id, from, to) });
});

router.get('/meters/:id/hourly', auth.requireApiKey('read'), (req, res) => {
  const row = findMeter(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const { from, to } = rangeOf(req.query);
  return res.json({ success: true, meterId: row.id, rows: statements.hourlyRange.all(row.id, from, to) });
});

router.get('/events', auth.requireApiKey('read'), (req, res) => {
  const { from, to } = rangeOf(req.query);
  let meters = statements.listMeters.all();
  if (req.query.plantId) meters = meters.filter((m) => m.plant_id === Number(req.query.plantId));
  if (req.query.lineId) meters = meters.filter((m) => m.line_id === Number(req.query.lineId));
  if (req.query.meterId) meters = meters.filter((m) => m.id === Number(req.query.meterId) || m.code === req.query.meterId);
  let rows = report.eventsFor(meters.map((m) => m.id), from, to);
  if (req.query.active === '1') rows = rows.filter((e) => !e.ended_at);
  if (req.query.severity) { const s = String(req.query.severity).split(','); rows = rows.filter((e) => s.includes(e.severity)); }
  if (req.query.type) { const t = String(req.query.type).split(','); rows = rows.filter((e) => t.includes(e.type)); }
  const maps = views.nameMaps();
  res.json({ success: true, from, to, events: rows.map((e) => views.eventView(e, maps)) });
});

router.get('/events/active', auth.requireApiKey('read'), (req, res) => {
  const maps = views.nameMaps();
  res.json({ success: true, events: statements.activeEvents.all().map((e) => views.eventView(e, maps)) });
});

// ---------------- peak demand ----------------
router.get('/demand', auth.requireApiKey('read'), (req, res) => {
  const d = req.app.locals.demand;
  res.json({ success: true, at: Date.now(), summary: d.summary(), groups: d.snapshots() });
});

router.get('/demand/:id', auth.requireApiKey('read'), (req, res) => {
  const g = req.app.locals.demand.get(req.params.id);
  if (!g) return res.status(404).json({ success: false, error: 'demand group not found' });
  const { from, to } = rangeOf(req.query);
  return res.json({ success: true, group: g, blocks: statements.demandBlocks.all(g.id, from, to + 1) });
});

router.post('/demand/:id/auto', auth.requireApiKey('write'), (req, res) => {
  try { req.app.locals.demand.setAuto(req.params.id, !!(req.body || {}).auto, req.apiKey ? 'api:' + req.apiKey.name : req.user.username); return res.json({ success: true }); } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/demand/:id/stages/:sid/:action', auth.requireApiKey('write'), async (req, res) => {
  const by = req.apiKey ? 'api:' + req.apiKey.name : req.user.username;
  try {
    if (req.params.action === 'shed') await req.app.locals.demand.manualShed(req.params.id, req.params.sid, by);
    else if (req.params.action === 'restore') await req.app.locals.demand.manualRestore(req.params.id, req.params.sid, by);
    else return res.status(400).json({ success: false, error: 'action must be shed or restore' });
    return res.json({ success: true });
  } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
});

// ---------------- write ----------------
router.post('/events/:id/ack', auth.requireApiKey('write'), (req, res) => {
  const e = statements.getEvent.get(req.params.id);
  if (!e) return res.status(404).json({ success: false, error: 'event not found' });
  const by = req.apiKey ? `api:${req.apiKey.name}` : req.user.username;
  statements.ackEvent.run(by, Date.now(), ((req.body || {}).note || '').slice(0, 300), e.id);
  return res.json({ success: true });
});

// ---------------- ingest (devices pushing readings) ----------------
/*
 * POST /api/v1/ingest
 * {
 *   "meter": "LINE1-M03",          meter code or numeric id
 *   "at": 1726900000000,           optional, unix ms (default now)
 *   "values": { "va": 231.2, "p_total": 12.5, "kwh_import": 12345.6 }
 * }
 * or a raw device payload with "meter" + "data": {...} mapped through the
 * meter's template jsonMap / conn.jsonMap. Batch: { "readings": [ {...}, ... ] }
 */
const ingestOne = (poller, item) => {
  const meter = findMeter(item.meter || item.meterId || item.code || '');
  if (!meter) return { ok: false, error: 'meter not found', meter: item.meter };
  if (!meter.enabled) return { ok: false, error: 'meter disabled', meter: meter.code || meter.id };
  let values = item.values;
  if (!values && item.data) {
    const map = templates.resolve(meter.template, meter.register_map_json);
    const conn = parseJson(meter.conn_json, {});
    values = pickJson(item.data, conn.jsonMap || map.jsonMap);
  }
  if (!values || typeof values !== 'object') return { ok: false, error: 'values missing', meter: meter.code || meter.id };
  const clean = {};
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(k)) continue; // same key rules as the tag editor
    const n = typeof v === 'string' ? parseFloat(v) : v;
    if (Number.isFinite(n)) clean[k] = n;
  }
  if (!Object.keys(clean).length) return { ok: false, error: 'no numeric values', meter: meter.code || meter.id };
  poller.ingest(meter, clean, toMs(item.at, Date.now()));
  return { ok: true, meter: meter.code || meter.id, keys: Object.keys(clean).length };
};

router.post('/ingest', auth.requireApiKey('ingest'), (req, res) => {
  const poller = req.app.locals.poller;
  const body = req.body || {};
  const items = Array.isArray(body.readings) ? body.readings : [body];
  const results = items.map((it) => ingestOne(poller, it || {}));
  const okCount = results.filter((r) => r.ok).length;
  res.status(okCount ? 200 : 400).json({ success: okCount === results.length, accepted: okCount, results });
});

module.exports = router;
