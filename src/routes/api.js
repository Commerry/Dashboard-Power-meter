const express = require('express');
const fs = require('fs');
const config = require('../config');
const { db, statements, audit } = require('../db');
const { METRICS, GROUPS } = require('../metrics');
const templates = require('../templates');
const drivers = require('../drivers');
const report = require('../report');
const views = require('../views');
const auth = require('../auth');
const { DEFAULTS: ALARM_DEFAULTS } = require('../alarms');

/*
 * Dashboard-facing REST API (session login required; roles checked per route).
 * Mounted at /api.
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

// ---- who am I / static lists ----
router.get('/me', (req, res) => {
  res.json({
    success: true,
    user: { id: req.user.id, username: req.user.username, role: req.user.role, displayName: req.user.displayName },
    site: { name: config.siteName, subtitle: config.siteSubtitle, tz: config.tz },
    can: {
      admin: auth.rank(req.user.role) >= auth.rank('admin'),
      operator: auth.rank(req.user.role) >= auth.rank('operator'),
    },
  });
});

router.get('/meta', (req, res) => {
  res.json({
    success: true,
    metrics: METRICS,
    groups: GROUPS,
    templates: templates.list(),
    protocols: drivers.list(),
    alarmDefaults: ALARM_DEFAULTS,
    config: { storeIntervalSec: config.storeIntervalSec, offlineAfterSec: config.offlineAfterSec, defaultPollMs: config.defaultPollMs },
  });
});

// ---- navigation tree + summary ----
router.get('/tree', (req, res) => res.json({ success: true, ...views.tree() }));

router.get('/summary', (req, res) => {
  const rt = req.app.locals.realtime;
  res.json({ success: true, ...(rt ? rt.summary() : {}) });
});

// ---- meters ----
router.get('/meters', (req, res) => {
  const maps = views.nameMaps();
  let rows = statements.listMeters.all();
  if (req.query.lineId) rows = rows.filter((m) => m.line_id === Number(req.query.lineId));
  if (req.query.plantId) rows = rows.filter((m) => m.plant_id === Number(req.query.plantId));
  if (req.query.gatewayId) rows = rows.filter((m) => m.gateway_id === Number(req.query.gatewayId));
  if (req.query.unassigned === '1') rows = rows.filter((m) => !m.plant_id || !m.line_id);
  res.json({ success: true, meters: rows.map((m) => views.meterView(m, maps)) });
});

router.get('/meters/:id', (req, res) => {
  const row = statements.getMeter.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  return res.json({ success: true, meter: views.meterView(row, views.nameMaps(), { full: true }) });
});

router.get('/meters/:id/history', (req, res) => {
  const row = statements.getMeter.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const { from, to } = rangeOf(req.query);
  const keys = req.query.keys ? String(req.query.keys).split(',') : ['p_total', 'v_ln_avg', 'i_avg', 'pf', 'freq'];
  const limit = Math.min(parseInt(req.query.limit, 10) || 3000, 20000);
  const data = report.series({ meterId: row.id, meter: row, from, to, interval: req.query.interval || 'raw', keys, limit });
  return res.json({ success: true, from, to, ...data });
});

router.get('/meters/:id/summary', (req, res) => {
  const row = statements.getMeter.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  const { from, to } = rangeOf(req.query);
  return res.json({ success: true, from, to, ...report.summary(row.id, from, to) });
});

router.get('/meters/:id/hourly', (req, res) => {
  const { from, to } = rangeOf(req.query);
  res.json({ success: true, rows: statements.hourlyRange.all(req.params.id, from, to) });
});

// day / month boundaries in the report timezone
const periodStarts = () => {
  const now = Date.now();
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: config.tz }));
  const offset = now - local.getTime();
  const day = new Date(local); day.setHours(0, 0, 0, 0);
  const month = new Date(local); month.setDate(1); month.setHours(0, 0, 0, 0);
  return { now, dayStart: day.getTime() + offset, monthStart: month.getTime() + offset };
};

const energyFor = (meterIds) => {
  const { now, dayStart, monthStart } = periodStarts();
  const sum = (from, to) => {
    let total = null;
    for (const id of meterIds) {
      const v = report.energyDelta(id, from, to);
      if (Number.isFinite(v)) total = (total || 0) + v;
    }
    return total;
  };
  return {
    today: sum(dayStart, now),
    yesterday: sum(dayStart - 86400000, dayStart),
    month: sum(monthStart, now),
    last24h: sum(now - 86400000, now),
    meters: meterIds.length,
  };
};

// energy for the "today / this month" tiles - one meter, or a line / plant total
router.get('/meters/:id/energy', (req, res) => {
  const row = statements.getMeter.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'meter not found' });
  return res.json({ success: true, ...energyFor([row.id]) });
});

router.get('/energy', (req, res) => {
  let rows = statements.listMeters.all().filter((m) => m.enabled);
  if (req.query.lineId) rows = rows.filter((m) => m.line_id === Number(req.query.lineId));
  else if (req.query.plantId) rows = rows.filter((m) => m.plant_id === Number(req.query.plantId));
  res.json({ success: true, ...energyFor(rows.map((m) => m.id)) });
});

// ---- line / plant aggregate history (sum of p_total across meters) ----
router.get('/lines/:id/history', (req, res) => {
  const { from, to } = rangeOf(req.query);
  const sec = Math.max(60, parseInt(req.query.interval, 10) || 300);
  const bucket = sec * 1000;
  const meters = statements.metersOfLine.all(req.params.id).map((m) => m.id);
  if (!meters.length) return res.json({ success: true, rows: [] });
  const marks = meters.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT at, SUM(kw) AS kw, MIN(vmin) AS vmin, SUM(kwh) AS kwh FROM (
      SELECT meter_id, (at / ${bucket}) * ${bucket} AS at, AVG(p_total) AS kw, MIN(v_ln_avg) AS vmin, MAX(kwh_import) - MIN(kwh_import) AS kwh
      FROM samples WHERE meter_id IN (${marks}) AND at >= ? AND at <= ? GROUP BY meter_id, at / ${bucket}
    ) GROUP BY at ORDER BY at`).all(...meters, from, to);
  return res.json({ success: true, from, to, interval: sec, rows });
});

// ---- events / alarms ----
router.get('/events', (req, res) => {
  const { from, to } = rangeOf(req.query);
  const where = ['e.started_at <= ?', 'COALESCE(e.ended_at, ?) >= ?'];
  const args = [to, to, from];
  if (req.query.meterId) { where.push('e.meter_id = ?'); args.push(Number(req.query.meterId)); }
  if (req.query.gatewayId) { where.push('e.gateway_id = ?'); args.push(Number(req.query.gatewayId)); }
  if (req.query.groupId) { where.push('e.group_id = ?'); args.push(Number(req.query.groupId)); }
  if (req.query.lineId) { where.push('m.line_id = ?'); args.push(Number(req.query.lineId)); }
  if (req.query.plantId) { where.push('(m.plant_id = ? OR g.plant_id = ? OR dg.plant_id = ?)'); args.push(Number(req.query.plantId), Number(req.query.plantId), Number(req.query.plantId)); }
  if (req.query.type) { const ts = String(req.query.type).split(','); where.push(`e.type IN (${ts.map(() => '?').join(',')})`); args.push(...ts); }
  if (req.query.severity) { const ss = String(req.query.severity).split(','); where.push(`e.severity IN (${ss.map(() => '?').join(',')})`); args.push(...ss); }
  if (req.query.active === '1') where.push('e.ended_at IS NULL');
  if (req.query.unacked === '1') where.push('e.acked_at IS NULL');
  const limit = Math.min(parseInt(req.query.limit, 10) || 500, 5000);
  const rows = db.prepare(`
    SELECT e.* FROM events e LEFT JOIN meters m ON m.id = e.meter_id LEFT JOIN gateways g ON g.id = e.gateway_id LEFT JOIN demand_groups dg ON dg.id = e.group_id
    WHERE ${where.join(' AND ')} ORDER BY e.started_at DESC LIMIT ?`).all(...args, limit);
  const maps = views.nameMaps();
  res.json({ success: true, from, to, events: rows.map((e) => views.eventView(e, maps)) });
});

router.post('/events/:id/ack', auth.requireRole('operator'), (req, res) => {
  const e = statements.getEvent.get(req.params.id);
  if (!e) return res.status(404).json({ success: false, error: 'event not found' });
  statements.ackEvent.run(req.user.username, Date.now(), ((req.body || {}).note || '').slice(0, 300), e.id);
  audit(req.user, 'ack_event', String(e.id), (req.body || {}).note);
  const rt = req.app.locals.realtime;
  if (rt) rt.broadcast({ type: 'event', action: 'ack', event: views.eventView(statements.getEvent.get(e.id)) }, () => true);
  return res.json({ success: true });
});

router.post('/events/ack-all', auth.requireRole('operator'), (req, res) => {
  const note = ((req.body || {}).note || '').slice(0, 300);
  const now = Date.now();
  let n = 0;
  for (const e of statements.activeEvents.all()) {
    if (e.acked_at) continue;
    if (req.body && req.body.plantId) {
      const m = e.meter_id ? statements.getMeter.get(e.meter_id) : null;
      const g = e.gateway_id ? statements.getGateway.get(e.gateway_id) : null;
      const pid = m ? m.plant_id : (g ? g.plant_id : null);
      if (pid !== Number(req.body.plantId)) continue;
    }
    statements.ackEvent.run(req.user.username, now, note, e.id);
    n += 1;
  }
  audit(req.user, 'ack_all', null, `${n} events`);
  return res.json({ success: true, acked: n });
});

// ---- gateways (monitor) ----
// broker passwords stay admin-only
const maskGateway = (req, g) => {
  if (auth.rank(req.user.role) >= auth.rank('admin')) return g;
  const config = { ...(g.config || {}) };
  if (config.password) config.password = '••••••';
  if (config.headers) config.headers = Object.fromEntries(Object.keys(config.headers).map((k) => [k, '••••••']));
  return { ...g, config };
};

router.get('/gateways', (req, res) => {
  const maps = views.nameMaps();
  let rows = statements.listGateways.all();
  if (req.query.plantId) rows = rows.filter((g) => g.plant_id === Number(req.query.plantId));
  res.json({ success: true, gateways: rows.map((g) => maskGateway(req, views.gatewayView(g, maps))) });
});

router.get('/gateways/:id', (req, res) => {
  const row = statements.getGateway.get(req.params.id);
  if (!row) return res.status(404).json({ success: false, error: 'gateway not found' });
  return res.json({ success: true, gateway: maskGateway(req, views.gatewayView(row)) });
});

router.get('/gateways/:id/stats', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours, 10) || 24, 24 * 30);
  const rows = statements.gatewayStats.all(req.params.id, Date.now() - hours * 3600000);
  res.json({ success: true, rows });
});

// ---- peak demand ----
const demandOf = (req) => req.app.locals.demand;
const groupDto = (g, maps) => ({ ...g, plantName: maps.plants.get(g.plantId)?.name || null, meters: g.meterIds.map((id) => ({ id, name: statements.getMeter.get(id)?.name || ('#' + id) })) });

router.get('/demand', (req, res) => {
  const d = demandOf(req);
  const maps = views.nameMaps();
  let groups = d.snapshots();
  if (req.query.plantId) groups = groups.filter((g) => g.plantId === Number(req.query.plantId));
  res.json({ success: true, summary: d.summary(), groups: groups.map((g) => groupDto(g, maps)) });
});

router.get('/demand/:id', (req, res) => {
  const d = demandOf(req);
  const g = d.get(req.params.id);
  if (!g) return res.status(404).json({ success: false, error: 'demand group not found' });
  const to = Date.now(); const from = to - 24 * 3600000;
  return res.json({
    success: true,
    group: groupDto(g, views.nameMaps()),
    blocks: statements.demandBlocks.all(g.id, from, to + 1),
    log: statements.demandLog.all(g.id, 100),
  });
});

router.get('/demand/:id/blocks', (req, res) => {
  const { from, to } = rangeOf(req.query);
  res.json({ success: true, from, to, blocks: statements.demandBlocks.all(req.params.id, from, to + 1) });
});

router.get('/demand/:id/log', (req, res) => {
  res.json({ success: true, log: statements.demandLog.all(req.params.id, Math.min(parseInt(req.query.limit, 10) || 200, 2000)) });
});

router.post('/demand/:id/auto', auth.requireRole('operator'), (req, res) => {
  try {
    demandOf(req).setAuto(req.params.id, !!(req.body || {}).auto, req.user.username);
    audit(req.user, 'demand_auto', req.params.id, String(!!(req.body || {}).auto));
    return res.json({ success: true });
  } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/demand/:id/stages/:sid/shed', auth.requireRole('operator'), async (req, res) => {
  try {
    await demandOf(req).manualShed(req.params.id, req.params.sid, req.user.username);
    audit(req.user, 'demand_shed', req.params.sid, null);
    return res.json({ success: true });
  } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/demand/:id/stages/:sid/restore', auth.requireRole('operator'), async (req, res) => {
  try {
    await demandOf(req).manualRestore(req.params.id, req.params.sid, req.user.username);
    audit(req.user, 'demand_restore', req.params.sid, null);
    return res.json({ success: true });
  } catch (e) { return res.status(400).json({ success: false, error: e.message }); }
});

// ---- export ----
const resolveMeters = (body) => {
  const all = statements.listMeters.all();
  if (Array.isArray(body.meterIds) && body.meterIds.length) {
    const ids = new Set(body.meterIds.map(Number));
    return all.filter((m) => ids.has(m.id));
  }
  if (body.lineId) return all.filter((m) => m.line_id === Number(body.lineId));
  if (body.plantId) return all.filter((m) => m.plant_id === Number(body.plantId));
  return all;
};

const exportParams = (body) => {
  const { from, to } = rangeOf(body);
  return {
    meters: resolveMeters(body),
    from,
    to,
    interval: body.interval || 'raw',
    keys: Array.isArray(body.keys) && body.keys.length ? body.keys : undefined,
    includeEvents: body.includeEvents !== false,
    includeSummary: body.includeSummary !== false,
  };
};

router.post('/export/preview', (req, res) => {
  try {
    const p = exportParams(req.body || {});
    return res.json({ success: true, from: p.from, to: p.to, ...report.preview(p) });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/export', (req, res) => {
  let built = null;
  try {
    const p = exportParams(req.body || {});
    if (!p.meters.length) return res.json({ success: false, error: 'no meters in the selected scope' });
    built = report.build(p);
    audit(req.user, 'export', null, { meters: p.meters.length, from: p.from, to: p.to, interval: p.interval });
    res.setHeader('Content-Type', built.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(built.name)}"; filename*=UTF-8''${encodeURIComponent(built.name)}`);
    const stream = fs.createReadStream(built.file);
    stream.pipe(res);
    stream.on('close', () => fs.rm(built.file, { force: true }, () => {}));
    return undefined;
  } catch (e) {
    console.error('export failed:', e.message);
    if (built && built.file) fs.rm(built.file, { force: true }, () => {});
    return res.status(500).json({ success: false, error: e.message });
  }
});

// events-only CSV (the alarm page's download button)
router.get('/events.csv', (req, res) => {
  const { from, to } = rangeOf(req.query);
  const meters = req.query.meterId ? [Number(req.query.meterId)] : statements.listMeters.all().map((m) => m.id);
  const rows = report.eventsFor(meters, from, to);
  const csv = report.toCsv([
    ['start', 'end', 'duration_sec', 'meter', 'type', 'severity', 'message', 'value', 'acked_by'],
    ...rows.map((e) => [report.localTime(e.started_at), e.ended_at ? report.localTime(e.ended_at) : '', e.ended_at ? Math.round((e.ended_at - e.started_at) / 1000) : '', e.meter_name || e.gateway_name || '', e.type, e.severity, e.message, e.value, e.acked_by || '']),
  ]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
  res.send(csv);
});

module.exports = router;
