const EventEmitter = require('events');
const config = require('./config');
const drivers = require('./drivers');
const { statements, parseJson } = require('./db');
const { deriveMissing } = require('./metrics');

/*
 * Acquisition engine.
 *
 * One GatewayWorker per enabled gateway, all running concurrently. Inside a
 * worker the meters are polled on their own interval; the driver serialises
 * requests on the socket when the transport needs it (Modbus).
 *
 * Every good read becomes a `reading` event:
 *   { meter, at, values, stat }   -> alarms, storage, websocket, mqtt publish
 *
 * The worker also keeps live traffic counters for the gateway monitor page:
 * requests / errors / bytes in + out per second (120 s ring), latency, uptime,
 * reconnect count and a short connection log.
 */
const RING_SEC = 120;
const LOG_MAX = 60;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decorateMeter = (row) => ({
  ...row,
  conn: parseJson(row.conn_json, {}),
  pollMs: row.poll_ms || config.defaultPollMs,
});

class GatewayWorker {
  constructor(gateway, meters, poller) {
    this.gateway = { ...gateway, config: parseJson(gateway.config_json, {}) };
    this.meters = meters.map(decorateMeter);
    this.poller = poller;
    this.proto = drivers.get(gateway.protocol);
    this.driver = drivers.create(this.gateway);
    this.running = false;
    this.connected = false;
    this.lastError = null;
    this.connectedSince = null;
    this.reconnects = 0;
    this.log = [];
    this.totals = { reqOk: 0, reqErr: 0, bytesRx: 0, bytesTx: 0, latencySum: 0, latencyN: 0 };
    this.minute = { reqOk: 0, reqErr: 0, bytesRx: 0, bytesTx: 0, latencySum: 0, latencyN: 0 };
    this.ring = Array.from({ length: RING_SEC }, () => ({ rx: 0, tx: 0, ok: 0, err: 0 }));
    this.ringSec = Math.floor(Date.now() / 1000);
    this.nextDue = new Map(); // meterId -> timestamp
    this.lastActivity = null;
    this.lastLatency = null;
    this.plc = null;          // CPU diagnostics (S7 gateways)
    this.plcAt = 0;
    this.plcBusy = false;
  }

  /** S7: refresh CPU diagnostics (RUN/STOP, model, clock ...) about once a minute. */
  async refreshPlcInfo(force = false) {
    if (!this.driver || typeof this.driver.plcInfo !== 'function' || !this.driver.connected) return;
    if (this.plcBusy || (!force && Date.now() - this.plcAt < 60000)) return;
    this.plcBusy = true;
    try {
      const info = await this.driver.plcInfo();
      this.plc = info;
      this.plcAt = Date.now();
      if (info.status === 'STOP') this.poller.alarms.setGatewayCondition(this.gateway, 'plc_stop', 'error', `PLC ${this.gateway.name} is in STOP`);
      else if (info.status === 'RUN') this.poller.alarms.clearGatewayCondition(this.gateway, 'plc_stop');
      if (info.clockDriftSec !== null && Math.abs(info.clockDriftSec) > 120) this.poller.alarms.setGatewayCondition(this.gateway, 'plc_clock', 'warn', `PLC ${this.gateway.name} clock off by ${info.clockDriftSec} s`);
      else if (info.clockDriftSec !== null) this.poller.alarms.clearGatewayCondition(this.gateway, 'plc_clock');
      this.poller.emit('gateway', this.snapshot());
    } catch (e) {
      this.logLine('err', `diagnostics: ${e.message}`);
    } finally {
      this.plcBusy = false;
    }
  }

  logLine(level, text) {
    this.log.unshift({ at: Date.now(), level, text });
    if (this.log.length > LOG_MAX) this.log.length = LOG_MAX;
  }

  _bucket() {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.ringSec) {
      const gap = Math.min(RING_SEC, sec - this.ringSec);
      for (let i = 0; i < gap; i += 1) {
        this.ring.push({ rx: 0, tx: 0, ok: 0, err: 0 });
        this.ring.shift();
      }
      this.ringSec = sec;
    }
    return this.ring[RING_SEC - 1];
  }

  account(stat) {
    const b = this._bucket();
    const ok = Math.max(0, (stat.requests || 0) - (stat.errors || 0));
    b.rx += stat.bytesRx || 0;
    b.tx += stat.bytesTx || 0;
    b.ok += ok;
    b.err += stat.errors || 0;
    for (const bag of [this.totals, this.minute]) {
      bag.reqOk += ok;
      bag.reqErr += stat.errors || 0;
      bag.bytesRx += stat.bytesRx || 0;
      bag.bytesTx += stat.bytesTx || 0;
      if (Number.isFinite(stat.latencyMs) && stat.latencyMs > 0) {
        bag.latencySum += stat.latencyMs;
        bag.latencyN += 1;
      }
    }
    if (Number.isFinite(stat.latencyMs) && stat.latencyMs > 0) this.lastLatency = stat.latencyMs;
    this.lastActivity = Date.now();
  }

  /** Flush the one-minute counters into gateway_stats. */
  flushMinute(at) {
    const m = this.minute;
    const online = this.meters.filter((x) => this.poller.latest.get(x.id)?.status === 'ok').length;
    statements.insertGatewayStat.run({
      gateway_id: this.gateway.id,
      at,
      latency_ms: m.latencyN ? m.latencySum / m.latencyN : null,
      req_ok: m.reqOk,
      req_err: m.reqErr,
      bytes_rx: m.bytesRx,
      bytes_tx: m.bytesTx,
      meters_online: online,
      meters_total: this.meters.length,
    });
    this.minute = { reqOk: 0, reqErr: 0, bytesRx: 0, bytesTx: 0, latencySum: 0, latencyN: 0 };
  }

  async start() {
    this.running = true;
    if (!this.driver) {
      // push protocol: nothing to run, readings arrive via the ingest API
      this.connected = true;
      this.connectedSince = Date.now();
      this.logLine('info', 'push gateway - waiting for device posts');
      return;
    }
    if (this.proto.kind === 'event') {
      this._runEvent();
    } else {
      this._runPoll();
    }
  }

  async _runEvent() {
    while (this.running) {
      try {
        await this.driver.start(this.meters, (meter, stat) => {
          this.account(stat);
          if (Object.keys(stat.values || {}).length) this.poller.onReading(this, meter, stat);
        });
        this.logLine('info', 'subscribed to broker');
        // the mqtt driver reconnects on its own; poll its state for the UI
        while (this.running) {
          const c = !!this.driver.connected;
          if (c !== this.connected) this._setConnected(c, this.driver.lastError);
          await sleep(1000);
        }
      } catch (e) {
        this._setConnected(false, e.message);
        await sleep(5000);
      }
    }
  }

  async _runPoll() {
    let backoff = 2000;
    while (this.running) {
      if (!this.driver.connected) {
        try {
          await this.driver.connect();
          this._setConnected(true);
          backoff = 2000;
          this.refreshPlcInfo(true);
        } catch (e) {
          this._setConnected(false, e.message);
          const b = this._bucket();
          b.err += 1;
          this.totals.reqErr += 1;
          this.minute.reqErr += 1;
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 30000);
          continue;
        }
      }
      const now = Date.now();
      let soonest = now + 1000;
      this.refreshPlcInfo();
      for (const meter of this.meters) {
        if (!this.running) break;
        const due = this.nextDue.get(meter.id) || 0;
        if (due > now) {
          soonest = Math.min(soonest, due);
          continue;
        }
        // schedule the next run from the *start* of this read so the cadence
        // stays fixed regardless of how long the read took
        this.nextDue.set(meter.id, now + meter.pollMs);
        try {
          const stat = await this.driver.readMeter(meter);
          this.account(stat);
          if (Object.keys(stat.values || {}).length) {
            this.poller.onReading(this, meter, stat);
          } else {
            this.poller.onReadFailed(this, meter, stat.lastError || 'no data');
          }
        } catch (e) {
          // transport died: mark down, reconnect on next loop
          this.account({ requests: 1, errors: 1 });
          this.poller.onReadFailed(this, meter, e.message);
          this._setConnected(false, e.message);
          break;
        }
        soonest = Math.min(soonest, this.nextDue.get(meter.id));
      }
      if (!this.meters.length) soonest = now + 5000;
      await sleep(Math.max(20, soonest - Date.now()));
    }
  }

  _setConnected(c, err) {
    if (c === this.connected && (err || null) === this.lastError) return;
    this.connected = c;
    this.lastError = err || null;
    if (c) {
      this.connectedSince = Date.now();
      this.logLine('ok', `connected to ${this.gateway.host || this.gateway.protocol}${this.gateway.port ? ':' + this.gateway.port : ''}`);
      this.poller.alarms.setGatewayUp(this.gateway);
    } else {
      if (this.connectedSince) this.reconnects += 1;
      this.connectedSince = null;
      this.logLine('err', `disconnected: ${err || 'unknown error'}`);
      this.poller.alarms.setGatewayDown(this.gateway, `Gateway ${this.gateway.name}: ${err || 'unreachable'}`);
    }
    this.poller.emit('gateway', this.snapshot());
  }

  async stop() {
    this.running = false;
    if (this.driver) await this.driver.close().catch(() => {});
  }

  snapshot() {
    const ring = this.ring;
    const last10 = ring.slice(-10);
    const sum = (k) => last10.reduce((a, b) => a + b[k], 0);
    const online = this.meters.filter((x) => this.poller.latest.get(x.id)?.status === 'ok').length;
    return {
      id: this.gateway.id,
      name: this.gateway.name,
      plantId: this.gateway.plant_id,
      protocol: this.gateway.protocol,
      host: this.gateway.host,
      port: this.gateway.port,
      enabled: !!this.gateway.enabled,
      connected: this.connected,
      lastError: this.lastError,
      connectedSince: this.connectedSince,
      uptimeSec: this.connectedSince ? Math.round((Date.now() - this.connectedSince) / 1000) : 0,
      reconnects: this.reconnects,
      lastActivity: this.lastActivity,
      latencyMs: this.lastLatency,
      avgLatencyMs: this.totals.latencyN ? Math.round(this.totals.latencySum / this.totals.latencyN) : null,
      totals: { ...this.totals },
      rate: { rxBps: sum('rx') / 10, txBps: sum('tx') / 10, reqPerSec: (sum('ok') + sum('err')) / 10, errPerSec: sum('err') / 10 },
      ring: ring.map((b) => [b.rx, b.tx, b.ok, b.err]),
      metersTotal: this.meters.length,
      metersOnline: online,
      plc: this.plc,
      log: this.log,
    };
  }
}

class Poller extends EventEmitter {
  constructor({ alarms }) {
    super();
    this.alarms = alarms;
    this.workers = new Map(); // gatewayId -> worker
    this.latest = new Map();  // meterId -> { at, values, status, lastError, lastOk, gatewayId }
    this.meterIndex = new Map(); // meterId -> meter row (decorated)
    this.ticker = null;
    this.minuteTimer = null;
  }

  async start() {
    await this.reload();
    this.ticker = setInterval(() => this._tick(), 1000);
    this.minuteTimer = setInterval(() => this._flushMinute(), config.gatewayStatsSec * 1000);
  }

  async stop() {
    clearInterval(this.ticker);
    clearInterval(this.minuteTimer);
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    this.workers.clear();
  }

  /** Rebuild workers from the database (call after any config change). */
  async reload() {
    await Promise.all([...this.workers.values()].map((w) => w.stop()));
    this.workers.clear();
    this.meterIndex.clear();
    const meters = statements.listMeters.all();
    for (const m of meters) {
      this.meterIndex.set(m.id, decorateMeter(m));
      if (!this.latest.has(m.id)) {
        this.latest.set(m.id, { at: null, values: {}, status: 'unknown', lastError: null, lastOk: null, gatewayId: m.gateway_id });
      } else {
        this.latest.get(m.id).gatewayId = m.gateway_id;
      }
    }
    for (const id of [...this.latest.keys()]) if (!this.meterIndex.has(id)) this.latest.delete(id);
    for (const g of statements.listGateways.all()) {
      if (!g.enabled) continue;
      const mine = meters.filter((m) => m.gateway_id === g.id && m.enabled);
      const w = new GatewayWorker(g, mine, this);
      this.workers.set(g.id, w);
      w.start().catch((e) => console.error(`gateway ${g.name}: ${e.message}`));
    }
    this.emit('reloaded');
  }

  onReading(worker, meter, stat, at = Date.now()) {
    const values = deriveMissing(stat.values);
    const cur = this.latest.get(meter.id) || {};
    const wasOffline = cur.status !== 'ok';
    const entry = {
      // `at` is the reading time (a pushed reading may carry its own stamp);
      // freshness for offline detection always uses the wall clock
      at, values, status: 'ok', lastError: null, lastOk: Date.now(), gatewayId: worker ? worker.gateway.id : meter.gateway_id,
      latencyMs: stat.latencyMs || null, pollMs: meter.pollMs,
    };
    this.latest.set(meter.id, entry);
    if (wasOffline) this.alarms.setOnline(meter, at);
    this.alarms.apply(meter, values, at);
    this.emit('reading', { meter, at, values, stat, status: this.alarms.statusOf(meter.id) });
  }

  onReadFailed(worker, meter, error) {
    const cur = this.latest.get(meter.id) || { values: {}, lastOk: null };
    const changed = cur.lastError !== error || cur.status === 'ok' || cur.status === 'unknown';
    cur.lastError = error;
    cur.gatewayId = worker ? worker.gateway.id : meter.gateway_id;
    // comm error now; _tick() turns it into "offline" (+ alarm) once the grace period is over
    if (cur.status !== 'offline') cur.status = 'error';
    this.latest.set(meter.id, cur);
    if (changed) this.emit('reading', { meter, at: cur.at || null, values: cur.values, stat: null, status: this.alarms.statusOf(meter.id), failed: true });
  }

  /** Readings pushed from outside (ingest API) - meter may have no gateway. */
  ingest(meter, values, at = Date.now()) {
    const worker = meter.gateway_id ? this.workers.get(meter.gateway_id) : null;
    const stat = { values, requests: 1, errors: 0, bytesRx: JSON.stringify(values).length, bytesTx: 0, latencyMs: 0 };
    if (worker) worker.account(stat);
    this.onReading(worker, decorateMeter(meter), stat, at);
  }

  _tick() {
    const now = Date.now();
    const limit = config.offlineAfterSec * 1000;
    for (const [id, cur] of this.latest) {
      const meter = this.meterIndex.get(id);
      if (!meter || !meter.enabled) continue;
      const grace = Math.max(limit, (meter.pollMs || 0) * 3);
      if (cur.status !== 'offline' && (!cur.lastOk || now - cur.lastOk > grace)) {
        cur.status = 'offline';
        this.alarms.setOffline(meter, cur.lastError || 'No response from meter', now);
        this.emit('reading', { meter, at: cur.at || null, values: cur.values, stat: null, status: this.alarms.statusOf(id), offline: true });
      }
    }
  }

  _flushMinute() {
    const at = Math.floor(Date.now() / 60000) * 60000;
    for (const w of this.workers.values()) w.flushMinute(at);
  }

  gatewaySnapshots() {
    return [...this.workers.values()].map((w) => w.snapshot());
  }

  gatewaySnapshot(id) {
    const w = this.workers.get(Number(id));
    return w ? w.snapshot() : null;
  }
}

module.exports = { Poller, GatewayWorker };
