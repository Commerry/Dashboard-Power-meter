const EventEmitter = require('events');
const { statements, parseJson, now } = require('./db');
const config = require('./config');

/*
 * Peak-demand controller.
 *
 * Utilities bill demand on the average kW of a fixed integration block
 * (15 minutes in Thailand, MEA/PEA TOU). A demand group sums the kW of a set
 * of meters (normally the main incoming meters of a plant), tracks the running
 * block average and projects where the block will end if the load stays as it
 * is now. When the projection crosses target - margin the controller sheds
 * loads stage by stage (writing a tag in a Siemens S7 PLC, or dry-run when no
 * gateway is bound) and restores them, last-in first-out, once the projection
 * drops below the release level.
 *
 *   projected = (energy_so_far + kw_now * remaining_h) / block_h
 *
 * Stage rules
 *   - stages shed in priority order (1 first), one action per action_gap_sec
 *   - a shed stage stays off at least min_off_sec, never longer than max_off_sec
 *   - manual shed / restore (operator) override auto until the operator releases it
 *   - every action is logged (demand_log) and written to the PLC through the
 *     gateway's driver (writeTag); a failed write raises an alarm
 *
 * Alarms (events with group_id)
 *   demand           warn      projected > target - margin
 *   demand_exceeded  critical  block average already above target
 *   demand_write     error     PLC write failed
 */
const TICK_MS = 1000;

class DemandController extends EventEmitter {
  constructor({ poller, alarms }) {
    super();
    this.poller = poller;
    this.alarms = alarms;
    this.groups = new Map(); // id -> runtime state
    this.timer = null;
  }

  start() {
    this.reload();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() { clearInterval(this.timer); }

  /** Re-read configuration; runtime state (block accumulators, shed flags) survives when the group still exists. */
  reload() {
    const rows = statements.listDemandGroups.all();
    const seen = new Set();
    for (const row of rows) {
      seen.add(row.id);
      const stages = statements.stagesOfGroup.all(row.id).map((s) => ({ ...s, tag: parseJson(s.tag_json, null) }));
      let st = this.groups.get(row.id);
      if (!st) {
        st = { id: row.id, cfg: row, stages: [], block: null, kwNow: null, blockAvg: null, projected: null, lastActionAt: 0, lastTickAt: Date.now(), online: 0, total: 0, warnOpen: null, exceededOpen: null, peaks: null };
        this.groups.set(row.id, st);
      }
      st.cfg = row;
      st.meterIds = (parseJson(row.meter_ids, []) || []).map(Number);
      // merge stage runtime flags
      const prev = new Map(st.stages.map((s) => [s.id, s]));
      st.stages = stages.map((s) => ({ ...s, shed: prev.get(s.id)?.shed || false, shedAt: prev.get(s.id)?.shedAt || null, mode: prev.get(s.id)?.mode || null, lastError: prev.get(s.id)?.lastError || null, releasedAt: prev.get(s.id)?.releasedAt || null }));
      if (!st.peaks) this._refreshPeaks(st);
      // open group alarms survive restarts
      const w = statements.openGroupEvent.get(row.id, 'demand'); st.warnOpen = w ? w.id : st.warnOpen;
      const x = statements.openGroupEvent.get(row.id, 'demand_exceeded'); st.exceededOpen = x ? x.id : st.exceededOpen;
    }
    for (const id of [...this.groups.keys()]) if (!seen.has(id)) this.groups.delete(id);
  }

  // ---- period helpers (report timezone) ----
  _periodStarts() {
    const t = Date.now();
    const local = new Date(new Date(t).toLocaleString('en-US', { timeZone: config.tz }));
    const offset = t - local.getTime();
    const day = new Date(local); day.setHours(0, 0, 0, 0);
    const month = new Date(local); month.setDate(1); month.setHours(0, 0, 0, 0);
    return { dayStart: day.getTime() + offset, monthStart: month.getTime() + offset, now: t };
  }

  _refreshPeaks(st) {
    const { dayStart, monthStart, now: t } = this._periodStarts();
    const d = statements.demandPeak.get(st.id, dayStart, t + 1);
    const m = statements.demandPeak.get(st.id, monthStart, t + 1);
    const mb = statements.demandPeakBlock.get(st.id, monthStart, t + 1);
    st.peaks = { today: d.peak || 0, month: m.peak || 0, monthAt: mb ? mb.block_start : null, exceededToday: d.exceeded || 0, exceededMonth: m.exceeded || 0, blocksToday: d.n || 0 };
  }

  _kwNow(st) {
    let kw = 0; let online = 0;
    for (const id of st.meterIds) {
      const cur = this.poller.latest.get(id);
      if (cur && cur.status === 'ok' && Number.isFinite(cur.values.p_total)) { kw += cur.values.p_total; online += 1; }
    }
    st.online = online; st.total = st.meterIds.length;
    return online ? kw : null;
  }

  tick() {
    const t = Date.now();
    for (const st of this.groups.values()) {
      if (!st.cfg.enabled) continue;
      const cfg = st.cfg;
      const blockLen = Math.max(1, cfg.block_min) * 60000;
      const blockStart = Math.floor(t / blockLen) * blockLen;
      const kwNow = this._kwNow(st);
      st.kwNow = kwNow;
      if (!st.block || st.block.start !== blockStart) {
        if (st.block) this._closeBlock(st, t);
        st.block = { start: blockStart, energy: 0, samples: 0, max: -Infinity, min: Infinity, shedMax: 0, seeded: false, estimatedH: 0 };
        st.lastTickAt = t;
        if (st.exceededOpen) this._closeEvent(st, 'exceededOpen', t);
      }
      const dtH = Math.min(5000, Math.max(0, t - st.lastTickAt)) / 3600000;
      st.lastTickAt = t;
      // equipment protection runs even while the incoming meters are silent
      this._safety(st, t);
      if (kwNow === null) { st.status = 'nodata'; continue; }
      const b = st.block;
      const elapsedH = (t - blockStart) / 3600000;
      // joined the block late (start-up / no data): assume the load was flat until now
      if (!b.seeded) { b.seeded = true; b.energy = kwNow * elapsedH; b.estimatedH = elapsedH; }
      else { b.energy += kwNow * dtH; }
      b.samples += 1; b.max = Math.max(b.max, kwNow); b.min = Math.min(b.min, kwNow);
      const blockH = blockLen / 3600000;
      st.blockAvg = elapsedH > 0.0005 ? b.energy / elapsedH : kwNow;
      st.projected = (b.energy + kwNow * (blockH - elapsedH)) / blockH;
      st.elapsedSec = Math.round((t - blockStart) / 1000);
      st.remainingSec = Math.round((blockStart + blockLen - t) / 1000);
      const threshold = cfg.target_kw - cfg.margin_kw;
      const shedCount = st.stages.filter((s) => s.shed).length;
      b.shedMax = Math.max(b.shedMax, shedCount);
      st.status = st.blockAvg > cfg.target_kw ? 'exceeded' : st.projected > cfg.target_kw ? 'critical' : st.projected > threshold ? 'warn' : shedCount ? 'shedding' : 'ok';
      this._alarms(st, threshold, t);
      this._control(st, threshold, t);
    }
    this.emit('tick', this.snapshots());
  }

  /** Never keep a shed stage (auto or manual) off longer than max_off_sec. Returns true when a restore was issued (lastActionAt then blocks a re-shed for action_gap_sec). */
  _safety(st, t) {
    for (const s of st.stages) {
      if (s.shed && s.shedAt && s.max_off_sec > 0 && t - s.shedAt >= s.max_off_sec * 1000) { this._restore(st, s, s.mode || 'auto', 'max off time reached', t); return true; }
    }
    return false;
  }

  _control(st, threshold, t) {
    const cfg = st.cfg;
    const gapOk = t - st.lastActionAt >= cfg.action_gap_sec * 1000;
    if (!cfg.auto) return;
    if (st.projected > threshold) {
      if (!gapOk) return;
      const next = st.stages.filter((s) => s.enabled && !s.shed && !(s.releasedAt && t - s.releasedAt < cfg.action_gap_sec * 1000)).sort((a, b) => a.priority - b.priority)[0];
      if (next) this._shed(st, next, 'auto', `projected ${st.projected.toFixed(0)} kW > ${threshold.toFixed(0)} kW`, t);
      return;
    }
    if (st.projected < threshold * cfg.release_pct && gapOk) {
      const back = st.stages.filter((s) => s.shed && s.mode === 'auto' && t - s.shedAt >= s.min_off_sec * 1000).sort((a, b) => b.priority - a.priority)[0];
      if (back) this._restore(st, back, 'auto', `projected ${st.projected.toFixed(0)} kW < release ${(threshold * cfg.release_pct).toFixed(0)} kW`, t);
    }
  }

  async _write(st, stage, value) {
    if (!stage.gateway_id || !stage.tag) return { ok: true, dryRun: true };
    const worker = this.poller.workers.get(stage.gateway_id);
    if (!worker || !worker.driver || typeof worker.driver.writeTag !== 'function') return { ok: false, error: 'gateway has no writable driver' };
    if (!worker.driver.connected) return { ok: false, error: 'gateway not connected' };
    try {
      await worker.driver.writeTag(stage.tag, value);
      worker.account({ requests: 1, errors: 0, bytesTx: 35, bytesRx: 22, latencyMs: 0 });
      return { ok: true };
    } catch (e) {
      worker.account({ requests: 1, errors: 1, bytesTx: 35, bytesRx: 0 });
      return { ok: false, error: e.message };
    }
  }

  async _shed(st, stage, mode, reason, t, user) {
    st.lastActionAt = t;
    const r = await this._write(st, stage, stage.shed_value);
    if (r.ok) {
      stage.shed = true; stage.shedAt = t; stage.mode = mode; stage.lastError = null;
      this._log(st, mode === 'manual' ? 'manual_shed' : 'shed', stage, `${reason}${r.dryRun ? ' (dry run - no PLC tag)' : ''}`, user);
      this.emit('action', { groupId: st.id, action: 'shed', stage: stage.name });
    } else {
      stage.lastError = r.error;
      this._log(st, 'write_fail', stage, `shed failed: ${r.error}`, user);
      this._writeAlarm(st, stage, r.error, t);
    }
    return r;
  }

  async _restore(st, stage, mode, reason, t, user) {
    st.lastActionAt = t;
    const r = await this._write(st, stage, stage.restore_value);
    if (r.ok) {
      stage.shed = false; stage.releasedAt = t; stage.mode = null; stage.lastError = null;
      this._log(st, mode === 'manual' ? 'manual_restore' : 'restore', stage, `${reason}${r.dryRun ? ' (dry run)' : ''}`, user);
      this.emit('action', { groupId: st.id, action: 'restore', stage: stage.name });
    } else {
      stage.lastError = r.error;
      this._log(st, 'write_fail', stage, `restore failed: ${r.error}`, user);
      this._writeAlarm(st, stage, r.error, t);
    }
    return r;
  }

  _log(st, action, stage, detail, user) {
    statements.insertDemandLog.run(st.id, Date.now(), action, stage ? stage.id : null, stage ? stage.name : null, st.kwNow, st.projected, detail || null, user || null);
  }

  _openEvent(st, key, type, severity, message, value, t) {
    const info = statements.insertGroupEvent.run(st.id, type, severity, message, value, t);
    st[key] = info.lastInsertRowid;
    this.alarms.emit('event', { action: 'open', event: statements.getEvent.get(info.lastInsertRowid) });
  }

  _closeEvent(st, key, t) {
    const id = st[key];
    if (!id) return;
    statements.closeEvent.run(t, id);
    st[key] = null;
    this.alarms.emit('event', { action: 'close', event: statements.getEvent.get(id) });
  }

  _alarms(st, threshold, t) {
    const cfg = st.cfg;
    if (st.projected > threshold && !st.warnOpen) {
      this._openEvent(st, 'warnOpen', 'demand', 'warn', `${cfg.name}: projected demand ${st.projected.toFixed(0)} kW above ${threshold.toFixed(0)} kW (target ${cfg.target_kw})`, st.projected, t);
    } else if (st.warnOpen && st.projected < threshold * cfg.release_pct) {
      this._closeEvent(st, 'warnOpen', t);
    }
    if (st.blockAvg > cfg.target_kw && !st.exceededOpen) {
      this._openEvent(st, 'exceededOpen', 'demand_exceeded', 'critical', `${cfg.name}: block average ${st.blockAvg.toFixed(0)} kW exceeds target ${cfg.target_kw} kW`, st.blockAvg, t);
    }
  }

  _writeAlarm(st, stage, error, t) {
    const open = statements.openGroupEvent.get(st.id, 'demand_write');
    if (open) return;
    const info = statements.insertGroupEvent.run(st.id, 'demand_write', 'error', `${st.cfg.name}: PLC write for stage "${stage.name}" failed - ${error}`, null, t);
    statements.closeEvent.run(t + 1, info.lastInsertRowid); // point event
    this.alarms.emit('event', { action: 'open', event: statements.getEvent.get(info.lastInsertRowid) });
  }

  _closeBlock(st, t) {
    const b = st.block;
    if (!b || !b.samples) return;
    const blockH = (Math.max(1, st.cfg.block_min) * 60000) / 3600000;
    const avg = b.energy / blockH;
    statements.upsertDemandBlock.run({
      group_id: st.id, block_start: b.start, avg_kw: avg, max_kw: b.max === -Infinity ? null : b.max, min_kw: b.min === Infinity ? null : b.min,
      target_kw: st.cfg.target_kw, shed_stages: b.shedMax, exceeded: avg > st.cfg.target_kw ? 1 : 0, samples: b.samples,
    });
    if (avg > st.cfg.target_kw) this._log(st, 'block_exceeded', null, `block ${new Date(b.start).toISOString()} average ${avg.toFixed(1)} kW > target ${st.cfg.target_kw} kW`);
    this._refreshPeaks(st);
  }

  // ---- operator actions ----
  async manualShed(groupId, stageId, user) {
    const st = this.groups.get(Number(groupId)); const s = st && st.stages.find((x) => x.id === Number(stageId));
    if (!s) throw new Error('stage not found');
    if (s.shed) throw new Error('stage already shed');
    const r = await this._shed(st, s, 'manual', `manual shed by ${user}`, Date.now(), user);
    if (!r.ok) throw new Error('PLC write failed: ' + r.error);
    return s;
  }

  async manualRestore(groupId, stageId, user) {
    const st = this.groups.get(Number(groupId)); const s = st && st.stages.find((x) => x.id === Number(stageId));
    if (!s) throw new Error('stage not found');
    if (!s.shed) throw new Error('stage is not shed');
    const r = await this._restore(st, s, 'manual', `manual restore by ${user}`, Date.now(), user);
    if (!r.ok) throw new Error('PLC write failed: ' + r.error);
    return s;
  }

  setAuto(groupId, auto, user) {
    const st = this.groups.get(Number(groupId));
    if (!st) throw new Error('group not found');
    statements.setDemandAuto.run(auto ? 1 : 0, st.id);
    st.cfg.auto = auto ? 1 : 0;
    this._log(st, auto ? 'auto_on' : 'auto_off', null, `automatic control ${auto ? 'enabled' : 'disabled'} by ${user}`, user);
  }

  /** Test a stage output: write shed then restore value (commissioning). */
  async testStage(stageId, value) {
    const row = statements.getDemandStage.get(stageId);
    if (!row) throw new Error('stage not found');
    const stage = { ...row, tag: parseJson(row.tag_json, null) };
    const st = this.groups.get(row.group_id) || { id: row.group_id };
    const r = await this._write(st, stage, value);
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  // ---- views ----
  snapshot(st) {
    const cfg = st.cfg;
    const threshold = cfg.target_kw - cfg.margin_kw;
    return {
      id: st.id, name: cfg.name, plantId: cfg.plant_id, enabled: !!cfg.enabled, auto: !!cfg.auto,
      targetKw: cfg.target_kw, marginKw: cfg.margin_kw, thresholdKw: threshold, releaseKw: threshold * cfg.release_pct, blockMin: cfg.block_min,
      meterIds: st.meterIds, metersOnline: st.online, metersTotal: st.total,
      kwNow: st.kwNow, blockAvg: st.blockAvg, projected: st.projected, status: st.status || 'nodata',
      blockStart: st.block ? st.block.start : null, elapsedSec: st.elapsedSec || 0, remainingSec: st.remainingSec || 0, estimatedSec: st.block ? Math.round(st.block.estimatedH * 3600) : 0,
      blockMaxKw: st.block && st.block.max !== -Infinity ? st.block.max : null, blockMinKw: st.block && st.block.min !== Infinity ? st.block.min : null,
      peaks: st.peaks, shedCount: st.stages.filter((s) => s.shed).length,
      stages: st.stages.map((s) => ({ id: s.id, name: s.name, priority: s.priority, enabled: !!s.enabled, gatewayId: s.gateway_id, tag: s.tag, shedValue: s.shed_value, restoreValue: s.restore_value, kwEstimate: s.kw_estimate, minOffSec: s.min_off_sec, maxOffSec: s.max_off_sec, shed: s.shed, shedAt: s.shedAt, mode: s.mode, lastError: s.lastError, dryRun: !s.gateway_id || !s.tag })),
      lastActionAt: st.lastActionAt || null,
    };
  }

  snapshots() { return [...this.groups.values()].map((st) => this.snapshot(st)); }
  get(id) { const st = this.groups.get(Number(id)); return st ? this.snapshot(st) : null; }

  summary() {
    const list = this.snapshots().filter((g) => g.enabled);
    const rank = { nodata: 0, ok: 1, shedding: 2, warn: 3, critical: 4, exceeded: 5 };
    const worst = list.reduce((w, g) => (rank[g.status] > rank[w] ? g.status : w), 'ok');
    return { groups: list.length, worst, shedding: list.reduce((a, g) => a + g.shedCount, 0), auto: list.filter((g) => g.auto).length };
  }
}

module.exports = { DemandController };
module.exports.now = now;
