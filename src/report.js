const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const { db, statements } = require('./db');
const { METRICS, BY_KEY, STORED_KEYS } = require('./metrics');
const templates = require('./templates');
const { ZipWriter } = require('./zip');

/*
 * History queries + export builder.
 *
 *   series()   - rows for a chart: raw or averaged into fixed buckets
 *   summary()  - per-meter stats over a range (kWh delta, avg/max kW, V min/max, events)
 *   build()    - CSV (one meter) or ZIP (many meters: one CSV each + summary + events)
 *
 * Interval buckets: 'raw' | 60 | 300 | 900 | 3600 | 86400 seconds.
 * Counters (kWh) are taken as MAX in the bucket; everything else is AVG with
 * MIN/MAX for the voltage so a sag inside the bucket is still visible.
 */
const TZ = () => config.tz || 'Asia/Bangkok';

const localTime = (ms) => {
  if (!ms) return '';
  return new Date(ms).toLocaleString('sv-SE', { timeZone: TZ() });
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
// BOM so Excel detects UTF-8, CRLF so it looks right on Windows
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const num = (n, digits = 3) => (typeof n === 'number' && Number.isFinite(n)
  ? Math.round(n * 10 ** digits) / 10 ** digits : '');

// Custom device tags are not columns; they live in samples.extra_json and are
// read back with SQLite's json_extract, so they chart / export like any metric.
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,40}$/;
const customKeysOf = (meter) => (meter ? templates.tagMeta(meter.template, meter.register_map_json).filter((t) => t.custom).map((t) => t.key) : []);
const isStored = (k) => BY_KEY.has(k) && BY_KEY.get(k).stored;
const colExpr = (k) => (isStored(k) ? `"${k}"` : `json_extract(extra_json, '$."${k}"')`);
const colSel = (k) => (isStored(k) ? `"${k}"` : `${colExpr(k)} AS "${k}"`);

/** keys the caller asked for, limited to stored metrics + the device's own custom tags */
const safeKeys = (keys, meter) => {
  const custom = new Set(customKeysOf(meter));
  const wanted = Array.isArray(keys) && keys.length ? keys : [...STORED_KEYS, ...custom];
  return wanted.filter((k) => SAFE_KEY.test(String(k)) && (isStored(k) || custom.has(k)));
};

/** Chart / API series for one meter. */
const series = ({ meterId, meter, from, to, interval = 'raw', keys, limit = 5000 }) => {
  const row = meter || statements.getMeter.get(meterId);
  const ks = safeKeys(keys, row);
  if (!ks.length) return { keys: [], rows: [] };
  const sec = interval === 'raw' ? 0 : Math.max(0, parseInt(interval, 10) || 0);
  if (!sec) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM samples WHERE meter_id = ? AND at >= ? AND at <= ?').get(meterId, from, to).n;
    // stride-decimate when the range holds more points than the chart can use
    const stride = Math.max(1, Math.ceil(n / limit));
    const cols = ks.map(colSel).join(', ');
    const inner = ks.map((k) => `"${k}"`).join(', ');
    const rows = stride === 1
      ? db.prepare(`SELECT at, ${cols} FROM samples WHERE meter_id = ? AND at >= ? AND at <= ? ORDER BY at`).all(meterId, from, to)
      : db.prepare(`SELECT at, ${inner} FROM (SELECT at, ${cols}, ROW_NUMBER() OVER (ORDER BY at) AS rn FROM samples WHERE meter_id = ? AND at >= ? AND at <= ?) WHERE (rn - 1) % ? = 0 ORDER BY at`).all(meterId, from, to, stride);
    return { keys: ks, rows, interval: 'raw', total: n, stride };
  }
  const bucket = sec * 1000;
  const agg = ks.map((k) => {
    const m = BY_KEY.get(k);
    if (m && m.counter) return `MAX(${colExpr(k)}) AS "${k}"`;
    return `AVG(${colExpr(k)}) AS "${k}"`;
  });
  // min/max of the headline voltage & power so dips survive averaging
  const extra = [];
  if (ks.includes('v_ln_avg')) extra.push('MIN("v_ln_avg") AS v_ln_min', 'MAX("v_ln_avg") AS v_ln_max');
  if (ks.includes('p_total')) extra.push('MIN("p_total") AS p_min', 'MAX("p_total") AS p_max');
  const rows = db.prepare(`
    SELECT (at / ${bucket}) * ${bucket} AS at, COUNT(*) AS n, ${[...agg, ...extra].join(', ')}
    FROM samples WHERE meter_id = ? AND at >= ? AND at <= ?
    GROUP BY at / ${bucket} ORDER BY at`).all(meterId, from, to);
  return { keys: ks, rows, interval: sec };
};

/** Energy consumed in a range from the counters (first vs last sample), with hourly fallback. */
const energyDelta = (meterId, from, to, key = 'kwh_import') => {
  const first = db.prepare(`SELECT "${key}" AS v FROM samples WHERE meter_id = ? AND at >= ? AND at <= ? AND "${key}" IS NOT NULL ORDER BY at ASC LIMIT 1`).get(meterId, from, to);
  const last = db.prepare(`SELECT "${key}" AS v FROM samples WHERE meter_id = ? AND at >= ? AND at <= ? AND "${key}" IS NOT NULL ORDER BY at DESC LIMIT 1`).get(meterId, from, to);
  if (first && last && Number.isFinite(first.v) && Number.isFinite(last.v)) return Math.max(0, last.v - first.v);
  return null;
};

/** Per-meter statistics over a range. */
const summary = (meterId, from, to) => {
  const r = db.prepare(`
    SELECT COUNT(*) AS samples, AVG(p_total) AS kw_avg, MAX(p_total) AS kw_max, MIN(p_total) AS kw_min,
           AVG(v_ln_avg) AS v_avg, MIN(v_ln_avg) AS v_min, MAX(v_ln_avg) AS v_max,
           MAX(i_avg) AS i_max, AVG(i_avg) AS i_avg, AVG(pf) AS pf_avg, MIN(pf) AS pf_min,
           MIN(freq) AS f_min, MAX(freq) AS f_max, MAX(demand_peak_kw) AS peak_demand
    FROM samples WHERE meter_id = ? AND at >= ? AND at <= ?`).get(meterId, from, to);
  const ev = db.prepare(`
    SELECT type, severity, COUNT(*) AS n, SUM(COALESCE(ended_at, ?) - started_at) AS dur
    FROM events WHERE meter_id = ? AND started_at <= ? AND COALESCE(ended_at, ?) >= ?
    GROUP BY type, severity`).all(to, meterId, to, to, from);
  return {
    samples: r.samples,
    kwh: energyDelta(meterId, from, to, 'kwh_import'),
    kvarh: energyDelta(meterId, from, to, 'kvarh_import'),
    kwAvg: r.kw_avg, kwMax: r.kw_max, kwMin: r.kw_min,
    vAvg: r.v_avg, vMin: r.v_min, vMax: r.v_max,
    iMax: r.i_max, iAvg: r.i_avg, pfAvg: r.pf_avg, pfMin: r.pf_min,
    fMin: r.f_min, fMax: r.f_max, peakDemand: r.peak_demand,
    events: ev.map((e) => ({ type: e.type, severity: e.severity, count: e.n, durationSec: Math.round((e.dur || 0) / 1000) })),
    eventCount: ev.reduce((a, e) => a + e.n, 0),
  };
};

/** Events in a range for a set of meters (and their gateways). */
const eventsFor = (meterIds, from, to) => {
  if (!meterIds.length) return [];
  const marks = meterIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT e.*, m.name AS meter_name, m.code AS meter_code, g.name AS gateway_name
    FROM events e LEFT JOIN meters m ON m.id = e.meter_id LEFT JOIN gateways g ON g.id = e.gateway_id
    WHERE (e.meter_id IN (${marks}) OR e.gateway_id IN (SELECT DISTINCT gateway_id FROM meters WHERE id IN (${marks})))
      AND e.started_at <= ? AND COALESCE(e.ended_at, ?) >= ?
    ORDER BY e.started_at`).all(...meterIds, ...meterIds, to, to, from);
};

const meterCsv = (meter, from, to, interval, keys) => {
  // the device's own tags always ride along (label / unit from its tag list)
  const meta = new Map(templates.tagMeta(meter.template, meter.register_map_json).map((t) => [t.key, t]));
  const custom = [...meta.values()].filter((t) => t.custom).map((t) => t.key);
  const wanted = Array.isArray(keys) && keys.length ? [...keys, ...custom] : undefined;
  const s = series({ meterId: meter.id, meter, from, to, interval, keys: wanted, limit: 2000000 });
  const info = (k) => meta.get(k) || BY_KEY.get(k) || { label: k, unit: '', decimals: 2 };
  const header = ['time (' + TZ() + ')', 'timestamp_ms', ...s.keys.map((k) => `${info(k).label}${info(k).unit ? ' (' + info(k).unit + ')' : ''}`)];
  if (interval !== 'raw') header.push('samples');
  const rows = [header];
  for (const r of s.rows) {
    const line = [localTime(r.at), r.at, ...s.keys.map((k) => num(r[k], info(k).decimals + 1))];
    if (interval !== 'raw') line.push(r.n);
    rows.push(line);
  }
  return toCsv(rows);
};

const eventsCsv = (events) => toCsv([
  ['start', 'end', 'duration_sec', 'meter', 'code', 'gateway', 'type', 'severity', 'message', 'value', 'acked_by', 'acked_at', 'note'],
  ...events.map((e) => [
    localTime(e.started_at), e.ended_at ? localTime(e.ended_at) : 'active',
    e.ended_at ? Math.round((e.ended_at - e.started_at) / 1000) : '',
    e.meter_name || '', e.meter_code || '', e.gateway_name || '', e.type, e.severity, e.message || '', num(e.value, 3),
    e.acked_by || '', e.acked_at ? localTime(e.acked_at) : '', e.ack_note || '',
  ]),
]);

const summaryCsv = (meters, from, to) => {
  const rows = [[
    'meter', 'code', 'plant', 'line', 'samples', 'energy_kwh', 'reactive_energy_kvarh',
    'kw_avg', 'kw_max', 'kw_min', 'peak_demand_kw',
    'v_avg', 'v_min', 'v_max', 'i_max_a', 'pf_avg', 'pf_min',
    'freq_min', 'freq_max', 'alarms', 'outages', 'sags', 'offline_events',
  ]];
  for (const m of meters) {
    const s = summary(m.id, from, to);
    const count = (t) => s.events.filter((e) => e.type === t).reduce((a, e) => a + e.count, 0);
    rows.push([
      m.name, m.code || '', m.plant_name || '', m.line_name || '', s.samples, num(s.kwh, 2), num(s.kvarh, 2),
      num(s.kwAvg, 2), num(s.kwMax, 2), num(s.kwMin, 2), num(s.peakDemand, 2),
      num(s.vAvg, 1), num(s.vMin, 1), num(s.vMax, 1), num(s.iMax, 2), num(s.pfAvg, 3), num(s.pfMin, 3),
      num(s.fMin, 2), num(s.fMax, 2), s.eventCount, count('outage'), count('sag'), count('offline'),
    ]);
  }
  return toCsv(rows);
};

const withNames = (meters) => {
  const plants = new Map(statements.listPlants.all().map((p) => [p.id, p.name]));
  const lines = new Map(statements.listLines.all().map((l) => [l.id, l.name]));
  return meters.map((m) => ({ ...m, plant_name: plants.get(m.plant_id) || '', line_name: lines.get(m.line_id) || '' }));
};

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'meter';

const stamp = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: TZ() }).replace(/[: ]/g, '-').slice(0, 16);

/** Preview counts before the download. */
const preview = ({ meters, from, to, interval }) => {
  const ids = meters.map((m) => m.id);
  const marks = ids.map(() => '?').join(',');
  const samples = ids.length ? db.prepare(`SELECT COUNT(*) AS n FROM samples WHERE meter_id IN (${marks}) AND at >= ? AND at <= ?`).get(...ids, from, to).n : 0;
  const events = eventsFor(ids, from, to).length;
  const kwh = ids.reduce((a, id) => a + (energyDelta(id, from, to) || 0), 0);
  const sec = interval === 'raw' ? 0 : parseInt(interval, 10) || 0;
  const rowsOut = sec ? Math.min(samples, Math.ceil((to - from) / (sec * 1000)) * ids.length) : samples;
  return { meters: ids.length, samples, events, kwh, rowsOut };
};

/**
 * Build the export file. Returns { file, name, mime, meters, rows }.
 * One meter + no events wanted -> plain CSV. Otherwise ZIP.
 */
const build = ({ meters, from, to, interval = 'raw', keys, includeEvents = true, includeSummary = true }) => {
  const named = withNames(meters);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-export-'));
  const label = `${stamp(from)}_to_${stamp(to)}`;
  if (named.length === 1 && !includeEvents && !includeSummary) {
    const m = named[0];
    const file = path.join(tmp, 'export.csv');
    fs.writeFileSync(file, meterCsv(m, from, to, interval, keys));
    return { file, name: `${safeName(m.name)}_${label}.csv`, mime: 'text/csv; charset=utf-8', meters: 1 };
  }
  const file = path.join(tmp, 'export.zip');
  const zip = new ZipWriter(file);
  for (const m of named) {
    zip.addText(`meters/${safeName(m.plant_name || 'plant')}/${safeName(m.line_name || 'line')}/${safeName(m.name)}.csv`, meterCsv(m, from, to, interval, keys));
  }
  if (includeSummary) zip.addText('summary.csv', summaryCsv(named, from, to));
  if (includeEvents) zip.addText('events.csv', eventsCsv(eventsFor(named.map((m) => m.id), from, to)));
  zip.addText('README.txt', [
    `Power Center export`,
    `Range   : ${localTime(from)} - ${localTime(to)} (${TZ()})`,
    `Interval: ${interval === 'raw' ? 'raw samples' : interval + ' second buckets (avg; counters = max)'}`,
    `Meters  : ${named.length}`,
    '',
    'meters/<plant>/<line>/<meter>.csv  one row per sample or bucket',
    'summary.csv                        per-meter energy, load, voltage and alarm counts',
    'events.csv                         alarm log for the range',
  ].join('\r\n'));
  zip.close();
  return { file, name: `power-export_${label}.zip`, mime: 'application/zip', meters: named.length };
};

module.exports = { series, summary, eventsFor, energyDelta, preview, build, localTime, toCsv, customKeysOf, METRICS };
