const config = require('./config');
const { db, statements, rollupHour, prune } = require('./db');
const { STORED_KEYS, BY_KEY } = require('./metrics');

/*
 * Time-series storage.
 *
 * Readings arrive every couple of seconds per meter; one row per meter is
 * written every STORE_INTERVAL_SEC (plus one immediately when an alarm state
 * changes, so an outage always has a sample at its edges). Writes are batched
 * in one transaction per second to keep SQLite happy with hundreds of meters.
 *
 * Hourly rollups run every 5 minutes for the current and previous hour;
 * retention prune runs hourly.
 */
class Store {
  constructor(poller, alarms) {
    this.poller = poller;
    this.alarms = alarms;
    this.lastStored = new Map(); // meterId -> timestamp
    this.queue = [];
    this.flushTimer = null;
    this.rollupTimer = null;
    this.pruneTimer = null;
    this.insertMany = db.transaction((rows) => {
      for (const r of rows) statements.insertSample.run(r);
    });
  }

  start() {
    this.poller.on('reading', (r) => this.onReading(r));
    this.alarms.on('event', (e) => this.onEvent(e));
    this.flushTimer = setInterval(() => this.flush(), 1000);
    this.rollupTimer = setInterval(() => this.rollup(), 5 * 60 * 1000);
    this.pruneTimer = setInterval(() => this.runPrune(), 3600 * 1000);
    setTimeout(() => this.rollup(), 20000);
  }

  stop() {
    clearInterval(this.flushTimer);
    clearInterval(this.rollupTimer);
    clearInterval(this.pruneTimer);
    this.flush();
  }

  rowFor(meterId, at, values) {
    const row = { meter_id: meterId, at, extra_json: null };
    const extra = {};
    for (const k of STORED_KEYS) row[k] = Number.isFinite(values[k]) ? values[k] : null;
    for (const [k, v] of Object.entries(values)) {
      if (!BY_KEY.has(k) || !BY_KEY.get(k).stored) extra[k] = v;
    }
    if (Object.keys(extra).length) row.extra_json = JSON.stringify(extra);
    return row;
  }

  onReading({ meter, at, values, offline, failed }) {
    if (offline || failed) return;
    const last = this.lastStored.get(meter.id) || 0;
    if (at - last < config.storeIntervalSec * 1000) return;
    this.lastStored.set(meter.id, at);
    this.queue.push(this.rowFor(meter.id, at, values));
  }

  // an alarm edge forces a sample so the chart shows exactly when it happened
  onEvent({ event }) {
    if (!event || !event.meter_id) return;
    const cur = this.poller.latest.get(event.meter_id);
    if (!cur || !cur.at) return;
    const at = event.ended_at || event.started_at || Date.now();
    this.lastStored.set(event.meter_id, at);
    this.queue.push(this.rowFor(event.meter_id, at, cur.values));
  }

  flush() {
    if (!this.queue.length) return;
    const rows = this.queue;
    this.queue = [];
    try {
      this.insertMany(rows);
    } catch (e) {
      console.error('store: insert failed:', e.message);
    }
  }

  rollup() {
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const run = db.transaction(() => {
      for (const id of this.poller.meterIndex.keys()) {
        rollupHour(id, hour - 3600000);
        rollupHour(id, hour);
      }
    });
    try { run(); } catch (e) { console.error('store: rollup failed:', e.message); }
  }

  /** Rebuild rollups for a range (used after importing history or on demand). */
  rebuildRollups(meterId, fromMs, toMs) {
    const start = Math.floor(fromMs / 3600000) * 3600000;
    let n = 0;
    const run = db.transaction(() => {
      for (let h = start; h < toMs; h += 3600000) if (rollupHour(meterId, h)) n += 1;
    });
    run();
    return n;
  }

  runPrune() {
    try {
      const r = prune(config.keep);
      if (r.samples || r.events || r.gatewayStats) {
        console.log(`prune: samples ${r.samples}, hourly ${r.hourly}, events ${r.events}, gateway stats ${r.gatewayStats}, audit ${r.audit}`);
      }
    } catch (e) {
      console.error('prune failed:', e.message);
    }
  }
}

module.exports = { Store };
