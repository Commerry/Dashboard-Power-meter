const schneider = require('./schneider');
const others = require('./others');
const { BY_KEY, GROUPS } = require('../metrics');

/*
 * Template registry + per-device tag resolution.
 *
 * A template is a starting list of tags for a known device model. A device
 * (meter row) may override the whole list in meters.register_map_json:
 *
 *   { fn, base, wordOrder, registers: [ tag, ... ] }
 *
 * One tag = one value read from the device:
 *   key       canonical metric key (va, p_total, kwh_import ...) OR any custom key
 *   label     display name (defaults to the metric label / key)
 *   group     card on the detail page (canonical group id or any custom name)
 *   unit, decimals
 *   Modbus:   addr, type (float32 ...), scale, offset, transform, wordOrder
 *   S7:       area (DB/M/I/Q), db, start (byte), bit, type (REAL/INT/DINT/BOOL ...), scale, offset
 *   JSON:     path ("data.voltage.l1") for MQTT / HTTP / push payloads
 *   alarms:   hi, hiCrit, lo, loCrit  (warn / error thresholds on this tag)
 */
const ALL = [...schneider, ...others];
const BY_ID = new Map(ALL.map((t) => [t.id, t]));

const transforms = { ...schneider.transforms };

const get = (id) => BY_ID.get(id) || null;

/** Public, serialisable list (no functions) for the settings UI. */
const list = () => ALL.map((t) => ({
  id: t.id,
  brand: t.brand,
  model: t.model,
  name: t.name,
  protocolHint: t.protocolHint,
  fn: t.fn,
  base: t.base,
  wordOrder: t.wordOrder,
  defaults: t.defaults,
  registerCount: t.registers.length,
  registers: t.registers,
  jsonMap: t.jsonMap || null,
  faceKey: t.faceKey || null,
  faceSlots: t.faceSlots || null,
  layout: t.layout || null,
}));

const num = (v) => (v === '' || v === null || v === undefined ? undefined : (Number.isFinite(Number(v)) ? Number(v) : undefined));

/** Normalise one tag row (from a template or a saved override). */
const normalizeTag = (r) => {
  if (!r || !r.key) return null;
  const key = String(r.key).trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  if (!key) return null;
  const canon = BY_KEY.get(key);
  const t = {
    key,
    label: r.label ? String(r.label).slice(0, 60) : (canon ? canon.label : key),
    group: r.group ? String(r.group).slice(0, 40) : (canon ? canon.group : 'device'),
    unit: r.unit !== undefined && r.unit !== null && r.unit !== '' ? String(r.unit).slice(0, 12) : (canon ? canon.unit : ''),
    decimals: num(r.decimals) !== undefined ? Math.max(0, Math.min(6, num(r.decimals))) : (canon ? canon.decimals : 2),
    type: r.type || undefined,
    scale: num(r.scale),
    offset: num(r.offset),
    transform: r.transform || undefined,
    wordOrder: r.wordOrder || undefined,
    // modbus
    addr: num(r.addr),
    // s7
    area: r.area ? String(r.area).toUpperCase() : undefined,
    db: num(r.db),
    start: num(r.start),
    bit: num(r.bit),
    // json
    path: r.path ? String(r.path).slice(0, 120) : undefined,
    // alarms on the tag
    hi: num(r.hi), hiCrit: num(r.hiCrit), lo: num(r.lo), loCrit: num(r.loCrit),
    // matrix placement on the device page (row x column inside the group)
    row: r.row ? String(r.row).slice(0, 30) : undefined,
    col: r.col ? String(r.col).slice(0, 30) : undefined,
  };
  for (const k of Object.keys(t)) if (t[k] === undefined) delete t[k];
  return t;
};

/**
 * Effective map for a device = template + per-device overrides stored in
 * meters.register_map_json. Custom tags keep their own label / group / unit.
 */
const resolve = (templateId, overrideJson) => {
  const t = get(templateId) || get('generic-modbus');
  let o = {};
  if (overrideJson) {
    try { o = JSON.parse(overrideJson) || {}; } catch (e) { o = {}; }
  }
  const raw = Array.isArray(o.registers) && o.registers.length ? o.registers : t.registers;
  const registers = raw.map(normalizeTag).filter(Boolean);
  // JSON protocols: tag.path wins over a template jsonMap
  let jsonMap = o.jsonMap || t.jsonMap || null;
  const pathTags = registers.filter((r) => r.path);
  if (pathTags.length) jsonMap = { ...(jsonMap || {}), ...Object.fromEntries(pathTags.map((r) => [r.key, r.path])) };
  return {
    id: t.id,
    fn: o.fn || t.fn || 'holding',
    base: Number.isFinite(o.base) ? o.base : (t.base || 0),
    wordOrder: o.wordOrder || t.wordOrder || 'ABCD',
    registers,
    jsonMap,
  };
};

/** Display metadata of every tag of a device (custom + canonical with overrides). */
const tagMeta = (templateId, overrideJson) => resolve(templateId, overrideJson).registers.map((r) => ({
  key: r.key, label: r.label, group: r.group, unit: r.unit, decimals: r.decimals, row: r.row, col: r.col,
  custom: !BY_KEY.has(r.key), groupLabel: GROUPS[r.group] ? GROUPS[r.group].label : r.group,
  alarm: r.hi !== undefined || r.lo !== undefined || r.hiCrit !== undefined || r.loCrit !== undefined ? { hi: r.hi, hiCrit: r.hiCrit, lo: r.lo, loCrit: r.loCrit } : null,
}));

module.exports = { ALL, get, list, resolve, tagMeta, normalizeTag, transforms };
