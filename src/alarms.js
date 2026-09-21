const EventEmitter = require('events');
const config = require('./config');
const { statements, parseJson } = require('./db');
const templates = require('./templates');

/*
 * Alarm engine.
 *
 * Every reading is checked against the meter's thresholds (alarm_json merged
 * over the defaults below). A condition opens an event row the first time it
 * is seen, keeps the row updated while it lasts, and closes it once the
 * reading has been clean for CLEAR_AFTER consecutive polls (small hysteresis
 * so a flickering value does not produce dozens of one-second events).
 *
 * Event types
 *   outage      voltage < outagePct % of nominal          critical
 *   sag         voltage below nominal - underVoltagePct    warn / error
 *   swell       voltage above nominal + overVoltagePct     warn / error
 *   overload    active power above rated_kw                warn / error
 *   overcurrent current above rated_a (or CT primary)      warn / error
 *   low_pf      power factor below lowPf                   warn
 *   freq        frequency deviates more than freqDev Hz    warn / error
 *   unbalance   voltage / current unbalance                warn
 *   thd         THD voltage / current                      warn
 *   offline     no good read for offlineAfterSec           error
 *   tag:<key>   custom tag above hi / below lo               warn / error (hiCrit / loCrit)
 *   gateway     gateway unreachable                        error
 *
 * Emits 'event' { action: 'open'|'update'|'close', event } for realtime + webhooks.
 */
const CLEAR_AFTER = 2;

const DEFAULTS = {
  enabled: true,
  underVoltagePct: 10,
  criticalUnderVoltagePct: 20,
  outagePct: 50,
  overVoltagePct: 10,
  criticalOverVoltagePct: 15,
  overloadPct: 100,
  criticalOverloadPct: 120,
  overcurrentPct: 100,
  criticalOvercurrentPct: 120,
  lowPf: 0.85,
  freqDev: 1.0,
  criticalFreqDev: 2.5,
  vUnbalPct: 2,
  iUnbalPct: 15,
  thdVPct: 5,
  thdIPct: 25,
};

const SEVERITY_RANK = { info: 0, warn: 1, error: 2, critical: 3 };

class AlarmEngine extends EventEmitter {
  constructor() {
    super();
    // meterId -> Map(type -> { id, severity, value, clear })
    this.open = new Map();
    this.gatewayOpen = new Map(); // gatewayId -> eventId
    this.gatewayConds = new Map(); // `${gatewayId}|${type}` -> eventId (plc_stop, plc_clock ...)
    this.tagRules = new Map();    // meterId -> { sig, rules }
    this._loadOpen();
  }

  /** Tags of a device that carry hi / lo thresholds (cached per register map). */
  rulesFor(meter) {
    const sig = `${meter.template}|${meter.register_map_json || ''}`;
    const c = this.tagRules.get(meter.id);
    if (c && c.sig === sig) return c.rules;
    const rules = templates.tagMeta(meter.template, meter.register_map_json).filter((t) => t.alarm).map((t) => ({ key: t.key, label: t.label, unit: t.unit, decimals: t.decimals, ...t.alarm }));
    this.tagRules.set(meter.id, { sig, rules });
    return rules;
  }

  _loadOpen() {
    for (const e of statements.activeEvents.all()) {
      if (e.type === 'gateway' && e.gateway_id) {
        this.gatewayOpen.set(e.gateway_id, e.id);
        continue;
      }
      if (e.gateway_id && !e.meter_id) { this.gatewayConds.set(`${e.gateway_id}|${e.type}`, e.id); continue; }
      if (!e.meter_id) continue;
      if (!this.open.has(e.meter_id)) this.open.set(e.meter_id, new Map());
      this.open.get(e.meter_id).set(e.type, { id: e.id, severity: e.severity, value: e.value, clear: 0 });
    }
  }

  thresholdsFor(meter) {
    return { ...DEFAULTS, ...parseJson(meter.alarm_json, {}) };
  }

  /** Evaluate one reading. Returns the list of active conditions. */
  evaluate(meter, v) {
    const t = this.thresholdsFor(meter);
    const conds = [];
    if (t.enabled === false) return conds;
    const nomV = meter.nominal_v || 230;
    const phases = ['va', 'vb', 'vc'].filter((k) => Number.isFinite(v[k]));
    const vs = phases.map((k) => v[k]);
    if (vs.length) {
      const vmin = Math.min(...vs);
      const vmax = Math.max(...vs);
      const pctMin = (vmin / nomV) * 100;
      const pctMax = (vmax / nomV) * 100;
      if (pctMin < t.outagePct) {
        conds.push({ type: 'outage', severity: 'critical', value: vmin, message: `Voltage ${vmin.toFixed(1)} V (${pctMin.toFixed(0)}% of nominal) - power outage` });
      } else if (pctMin < 100 - t.criticalUnderVoltagePct) {
        conds.push({ type: 'sag', severity: 'error', value: vmin, message: `Under-voltage ${vmin.toFixed(1)} V (${pctMin.toFixed(0)}%)` });
      } else if (pctMin < 100 - t.underVoltagePct) {
        conds.push({ type: 'sag', severity: 'warn', value: vmin, message: `Voltage sag ${vmin.toFixed(1)} V (${pctMin.toFixed(0)}%)` });
      }
      if (pctMax > 100 + t.criticalOverVoltagePct) {
        conds.push({ type: 'swell', severity: 'error', value: vmax, message: `Over-voltage ${vmax.toFixed(1)} V (${pctMax.toFixed(0)}%)` });
      } else if (pctMax > 100 + t.overVoltagePct) {
        conds.push({ type: 'swell', severity: 'warn', value: vmax, message: `Voltage swell ${vmax.toFixed(1)} V (${pctMax.toFixed(0)}%)` });
      }
    }
    const outage = conds.some((c) => c.type === 'outage');
    if (!outage) {
      if (meter.rated_kw && Number.isFinite(v.p_total)) {
        const pct = (v.p_total / meter.rated_kw) * 100;
        if (pct > t.criticalOverloadPct) conds.push({ type: 'overload', severity: 'error', value: v.p_total, message: `Overload ${v.p_total.toFixed(1)} kW (${pct.toFixed(0)}% of rated)` });
        else if (pct > t.overloadPct) conds.push({ type: 'overload', severity: 'warn', value: v.p_total, message: `High load ${v.p_total.toFixed(1)} kW (${pct.toFixed(0)}% of rated)` });
      }
      const ratedA = meter.rated_a || meter.ct_primary;
      const is = ['ia', 'ib', 'ic'].filter((k) => Number.isFinite(v[k])).map((k) => v[k]);
      if (ratedA && is.length) {
        const imax = Math.max(...is);
        const pct = (imax / ratedA) * 100;
        if (pct > t.criticalOvercurrentPct) conds.push({ type: 'overcurrent', severity: 'error', value: imax, message: `Over-current ${imax.toFixed(1)} A (${pct.toFixed(0)}%)` });
        else if (pct > t.overcurrentPct) conds.push({ type: 'overcurrent', severity: 'warn', value: imax, message: `High current ${imax.toFixed(1)} A (${pct.toFixed(0)}%)` });
      }
      if (Number.isFinite(v.pf) && Number.isFinite(v.p_total) && v.p_total > 0.5 && Math.abs(v.pf) < t.lowPf) {
        conds.push({ type: 'low_pf', severity: 'warn', value: v.pf, message: `Low power factor ${v.pf.toFixed(3)}` });
      }
      if (Number.isFinite(v.freq)) {
        const dev = Math.abs(v.freq - (meter.nominal_hz || 50));
        if (dev > t.criticalFreqDev) conds.push({ type: 'freq', severity: 'error', value: v.freq, message: `Frequency ${v.freq.toFixed(2)} Hz` });
        else if (dev > t.freqDev) conds.push({ type: 'freq', severity: 'warn', value: v.freq, message: `Frequency deviation ${v.freq.toFixed(2)} Hz` });
      }
      if (Number.isFinite(v.v_unbal) && v.v_unbal > t.vUnbalPct) {
        conds.push({ type: 'unbalance', severity: 'warn', value: v.v_unbal, message: `Voltage unbalance ${v.v_unbal.toFixed(1)}%` });
      } else if (Number.isFinite(v.i_unbal) && v.i_unbal > t.iUnbalPct && (v.i_avg || 0) > 1) {
        conds.push({ type: 'unbalance', severity: 'warn', value: v.i_unbal, message: `Current unbalance ${v.i_unbal.toFixed(1)}%` });
      }
      const thdV = Math.max(...['thd_va', 'thd_vb', 'thd_vc'].map((k) => (Number.isFinite(v[k]) ? v[k] : -1)));
      const thdI = Math.max(...['thd_ia', 'thd_ib', 'thd_ic'].map((k) => (Number.isFinite(v[k]) ? v[k] : -1)));
      if (thdV > t.thdVPct) conds.push({ type: 'thd', severity: 'warn', value: thdV, message: `Voltage THD ${thdV.toFixed(1)}%` });
      else if (thdI > t.thdIPct && (v.i_avg || 0) > 1) conds.push({ type: 'thd', severity: 'warn', value: thdI, message: `Current THD ${thdI.toFixed(1)}%` });
    }
    // custom tag thresholds (PLC values, temperatures, pressures ...)
    for (const r of this.rulesFor(meter)) {
      const val = v[r.key];
      if (!Number.isFinite(val)) continue;
      const fmt = (x) => `${Number(x).toFixed(r.decimals ?? 1)}${r.unit ? ' ' + r.unit : ''}`;
      if (r.hiCrit !== undefined && val > r.hiCrit) conds.push({ type: 'tag:' + r.key, severity: 'error', value: val, message: `${r.label} ${fmt(val)} above ${fmt(r.hiCrit)}` });
      else if (r.hi !== undefined && val > r.hi) conds.push({ type: 'tag:' + r.key, severity: 'warn', value: val, message: `${r.label} ${fmt(val)} above ${fmt(r.hi)}` });
      else if (r.loCrit !== undefined && val < r.loCrit) conds.push({ type: 'tag:' + r.key, severity: 'error', value: val, message: `${r.label} ${fmt(val)} below ${fmt(r.loCrit)}` });
      else if (r.lo !== undefined && val < r.lo) conds.push({ type: 'tag:' + r.key, severity: 'warn', value: val, message: `${r.label} ${fmt(val)} below ${fmt(r.lo)}` });
    }
    return conds;
  }

  /** Apply conditions from a fresh reading to the open-event state. */
  apply(meter, values, at = Date.now()) {
    const conds = this.evaluate(meter, values);
    const open = this._openFor(meter.id);
    const seen = new Set();
    for (const c of conds) {
      seen.add(c.type);
      const cur = open.get(c.type);
      if (!cur) {
        this._openEvent(meter.id, null, c, at);
      } else {
        cur.clear = 0;
        if (cur.severity !== c.severity || Math.abs((cur.value || 0) - c.value) > Math.abs(c.value) * 0.05) {
          statements.updateEventValue.run(c.value, c.message, c.severity, cur.id);
          cur.severity = c.severity;
          cur.value = c.value;
          this.emit('event', { action: 'update', event: statements.getEvent.get(cur.id) });
        }
      }
    }
    for (const [type, cur] of open) {
      if (type === 'offline' || seen.has(type)) continue;
      cur.clear += 1;
      if (cur.clear >= CLEAR_AFTER) this._closeEvent(meter.id, type, at);
    }
    return conds;
  }

  setOffline(meter, reason, at = Date.now()) {
    const open = this._openFor(meter.id);
    if (open.has('offline')) return;
    this._openEvent(meter.id, null, { type: 'offline', severity: 'error', value: null, message: reason || 'No response from meter' }, at);
  }

  setOnline(meter, at = Date.now()) {
    const open = this._openFor(meter.id);
    if (!open.has('offline')) return;
    this._closeEvent(meter.id, 'offline', at);
  }

  setGatewayDown(gateway, reason, at = Date.now()) {
    if (this.gatewayOpen.has(gateway.id)) return;
    const info = statements.insertEvent.run(null, gateway.id, 'gateway', 'error', reason || `Gateway ${gateway.name} unreachable`, null, at);
    this.gatewayOpen.set(gateway.id, info.lastInsertRowid);
    this.emit('event', { action: 'open', event: statements.getEvent.get(info.lastInsertRowid) });
  }

  setGatewayUp(gateway, at = Date.now()) {
    const id = this.gatewayOpen.get(gateway.id);
    if (!id) return;
    statements.closeEvent.run(at, id);
    this.gatewayOpen.delete(gateway.id);
    this.emit('event', { action: 'close', event: statements.getEvent.get(id) });
  }

  setGatewayCondition(gateway, type, severity, message, at = Date.now()) {
    const k = `${gateway.id}|${type}`;
    if (this.gatewayConds.has(k)) return;
    const info = statements.insertEvent.run(null, gateway.id, type, severity, message, null, at);
    this.gatewayConds.set(k, info.lastInsertRowid);
    this.emit('event', { action: 'open', event: statements.getEvent.get(info.lastInsertRowid) });
  }

  clearGatewayCondition(gateway, type, at = Date.now()) {
    const k = `${gateway.id}|${type}`;
    const id = this.gatewayConds.get(k);
    if (!id) return;
    statements.closeEvent.run(at, id);
    this.gatewayConds.delete(k);
    this.emit('event', { action: 'close', event: statements.getEvent.get(id) });
  }

  /** Highest open severity per meter - the dashboard paints the face with it. */
  statusOf(meterId) {
    const open = this.open.get(meterId);
    if (!open || !open.size) return { severity: null, types: [] };
    let worst = null;
    const types = [];
    for (const [type, e] of open) {
      types.push({ type, severity: e.severity, value: e.value, id: e.id });
      if (!worst || SEVERITY_RANK[e.severity] > SEVERITY_RANK[worst]) worst = e.severity;
    }
    return { severity: worst, types };
  }

  _openFor(meterId) {
    if (!this.open.has(meterId)) this.open.set(meterId, new Map());
    return this.open.get(meterId);
  }

  _openEvent(meterId, gatewayId, c, at) {
    const info = statements.insertEvent.run(meterId, gatewayId, c.type, c.severity, c.message, c.value, at);
    this._openFor(meterId).set(c.type, { id: info.lastInsertRowid, severity: c.severity, value: c.value, clear: 0 });
    this.emit('event', { action: 'open', event: statements.getEvent.get(info.lastInsertRowid) });
  }

  _closeEvent(meterId, type, at) {
    const open = this._openFor(meterId);
    const cur = open.get(type);
    if (!cur) return;
    statements.closeEvent.run(at, cur.id);
    open.delete(type);
    this.emit('event', { action: 'close', event: statements.getEvent.get(cur.id) });
  }

  forgetMeter(meterId) {
    this.open.delete(meterId);
    this.tagRules.delete(meterId);
  }

  forgetGateway(gatewayId) {
    this.gatewayOpen.delete(gatewayId);
    for (const k of [...this.gatewayConds.keys()]) if (k.startsWith(`${gatewayId}|`)) this.gatewayConds.delete(k);
  }
}

module.exports = { AlarmEngine, DEFAULTS, SEVERITY_RANK };
