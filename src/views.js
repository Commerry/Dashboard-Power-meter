const { statements, parseJson } = require('./db');
const templates = require('./templates');

/*
 * DTO builders shared by the dashboard API and the public v1 API, so both
 * describe a meter / gateway / event the same way.
 */
const ctx = { poller: null, alarms: null };

const attach = (poller, alarms) => {
  ctx.poller = poller;
  ctx.alarms = alarms;
};

const nameMaps = () => ({
  plants: new Map(statements.listPlants.all().map((p) => [p.id, p])),
  lines: new Map(statements.listLines.all().map((l) => [l.id, l])),
  sections: new Map(statements.listSections.all().map((s) => [s.id, s])),
  gateways: new Map(statements.listGateways.all().map((g) => [g.id, g])),
  groups: new Map(statements.listDemandGroups.all().map((g) => [g.id, g])),
});

const meterView = (row, maps = nameMaps(), { full = false } = {}) => {
  const cur = ctx.poller ? ctx.poller.latest.get(row.id) : null;
  const st = ctx.alarms ? ctx.alarms.statusOf(row.id) : { severity: null, types: [] };
  const t = templates.get(row.template);
  const out = {
    id: row.id,
    name: row.name,
    code: row.code,
    plantId: row.plant_id,
    plantName: maps.plants.get(row.plant_id)?.name || null,
    lineId: row.line_id,
    lineName: maps.lines.get(row.line_id)?.name || null,
    sectionId: row.section_id,
    sectionName: maps.sections.get(row.section_id)?.name || null,
    gatewayId: row.gateway_id,
    gatewayName: maps.gateways.get(row.gateway_id)?.name || null,
    gatewayProtocol: maps.gateways.get(row.gateway_id)?.protocol || null,
    template: row.template,
    brand: t ? t.brand : null,
    model: t ? t.model : null,
    unitId: row.unit_id,
    pollMs: row.poll_ms,
    nominalV: row.nominal_v,
    nominalHz: row.nominal_hz,
    ctPrimary: row.ct_primary,
    ratedKw: row.rated_kw,
    ratedA: row.rated_a,
    phases: row.phases,
    enabled: !!row.enabled,
    sortOrder: row.sort_order,
    notes: row.notes,
    status: row.enabled ? (cur ? cur.status : 'unknown') : 'disabled',
    lastOk: cur ? cur.lastOk : null,
    lastError: cur ? cur.lastError : null,
    latencyMs: cur ? cur.latencyMs : null,
    at: cur ? cur.at : null,
    alarm: st.severity,
    alarms: st.types,
    values: cur ? cur.values : {},
    tags: templates.tagMeta(row.template, row.register_map_json),
    faceKey: (parseJson(row.conn_json, {}) || {}).faceKey || (t && t.faceKey) || null,
    layout: t && t.layout ? t.layout : null,
    faceSlots: t && t.faceSlots ? t.faceSlots : null,
  };
  if (full) {
    out.conn = parseJson(row.conn_json, {});
    out.registerMap = parseJson(row.register_map_json, null);
    out.alarmConfig = parseJson(row.alarm_json, {});
    out.createdAt = row.created_at;
  }
  return out;
};

const gatewayView = (row, maps = nameMaps()) => {
  const snap = ctx.poller ? ctx.poller.gatewaySnapshot(row.id) : null;
  const meters = statements.metersOfGateway.all(row.id);
  return {
    id: row.id,
    name: row.name,
    plantId: row.plant_id,
    plantName: maps.plants.get(row.plant_id)?.name || null,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    config: parseJson(row.config_json, {}),
    enabled: !!row.enabled,
    notes: row.notes,
    createdAt: row.created_at,
    metersTotal: meters.length,
    live: snap,
    meters: meters.map((m) => {
      const cur = ctx.poller ? ctx.poller.latest.get(m.id) : null;
      return {
        id: m.id, name: m.name, unitId: m.unit_id, template: m.template, pollMs: m.poll_ms,
        status: cur ? cur.status : 'unknown', lastOk: cur ? cur.lastOk : null, lastError: cur ? cur.lastError : null,
        latencyMs: cur ? cur.latencyMs : null,
      };
    }),
  };
};

const eventView = (e, maps = nameMaps()) => {
  const m = e.meter_id ? statements.getMeter.get(e.meter_id) : null;
  const g = e.gateway_id ? maps.gateways.get(e.gateway_id) : null;
  const dg = e.group_id ? maps.groups.get(e.group_id) : null;
  return {
    id: e.id,
    groupId: e.group_id || null,
    groupName: dg ? dg.name : null,
    meterId: e.meter_id,
    meterName: m ? m.name : null,
    meterCode: m ? m.code : null,
    plantId: m ? m.plant_id : (g ? g.plant_id : (dg ? dg.plant_id : null)),
    plantName: maps.plants.get(m ? m.plant_id : (g ? g.plant_id : (dg ? dg.plant_id : null)))?.name || null,
    lineId: m ? m.line_id : null,
    lineName: m ? maps.lines.get(m.line_id)?.name || null : null,
    gatewayId: e.gateway_id,
    gatewayName: g ? g.name : null,
    type: e.type,
    severity: e.severity,
    message: e.message,
    value: e.value,
    startedAt: e.started_at,
    endedAt: e.ended_at,
    durationSec: Math.round(((e.ended_at || Date.now()) - e.started_at) / 1000),
    active: !e.ended_at,
    ackedBy: e.acked_by,
    ackedAt: e.acked_at,
    ackNote: e.ack_note,
  };
};

/** Whole navigation tree: plants -> lines -> sections, with meter counts + live status. */
const tree = () => {
  const maps = nameMaps();
  const meters = statements.listMeters.all();
  const plants = [...maps.plants.values()].map((p) => ({
    id: p.id, name: p.name, code: p.code, province: p.province, address: p.address, sortOrder: p.sort_order,
    lines: [], meters: 0, online: 0, alarms: 0, kw: 0,
  }));
  const byPlant = new Map(plants.map((p) => [p.id, p]));
  for (const l of maps.lines.values()) {
    const p = byPlant.get(l.plant_id);
    if (!p) continue;
    p.lines.push({ id: l.id, name: l.name, code: l.code, sortOrder: l.sort_order, plantId: l.plant_id, sections: [], meters: 0, online: 0, alarms: 0, kw: 0 });
  }
  const byLine = new Map();
  for (const p of plants) for (const l of p.lines) byLine.set(l.id, l);
  for (const s of maps.sections.values()) {
    const l = byLine.get(s.line_id);
    if (l) l.sections.push({ id: s.id, name: s.name, sortOrder: s.sort_order, lineId: s.line_id, meters: 0 });
  }
  const unassigned = { meters: 0, online: 0, alarms: 0 };
  for (const m of meters) {
    if (!m.enabled) continue;
    const cur = ctx.poller ? ctx.poller.latest.get(m.id) : null;
    const st = ctx.alarms ? ctx.alarms.statusOf(m.id) : { severity: null, types: [] };
    const ok = cur && cur.status === 'ok';
    const kw = ok && Number.isFinite(cur.values.p_total) ? cur.values.p_total : 0;
    const p = byPlant.get(m.plant_id);
    const l = byLine.get(m.line_id);
    if (p) { p.meters += 1; if (ok) p.online += 1; if (st.severity) p.alarms += 1; p.kw += kw; }
    if (l) {
      l.meters += 1; if (ok) l.online += 1; if (st.severity) l.alarms += 1; l.kw += kw;
      const s = l.sections.find((x) => x.id === m.section_id);
      if (s) s.meters += 1;
    }
    if (!p) { unassigned.meters += 1; if (ok) unassigned.online += 1; if (st.severity) unassigned.alarms += 1; }
  }
  return { plants, unassigned };
};

module.exports = { attach, nameMaps, meterView, gatewayView, eventView, tree, ctx };
