/*
 * Simulator driver - realistic three-phase values without hardware.
 *
 * Used by the demo seed and for commissioning the dashboard before the
 * gateways are wired. Each meter follows a daily load profile with noise and
 * gets occasional disturbances (voltage sag, swell, outage, overload) so the
 * alarm log has something to show.
 *
 * Gateway config_json: { latencyMs: 40, failRate: 0.01, eventRate: 0.002 }
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const loadProfile = (hour) => {
  // factory: ramps up 07:00, peak 10-16, dips at lunch, ramps down 18:00
  if (hour < 6) return 0.18;
  if (hour < 7) return 0.35;
  if (hour < 8) return 0.7;
  if (hour < 12) return 0.84;
  if (hour < 13) return 0.55;
  if (hour < 17) return 0.86;
  if (hour < 18) return 0.75;
  if (hour < 20) return 0.45;
  return 0.25;
};

class SimulatorDriver {
  constructor(gateway) {
    this.gateway = gateway;
    this.cfg = gateway.config || {};
    this.connected = false;
    this.lastError = null;
    this.state = new Map(); // meterId -> { kwh, kvarh, peak, event }
  }

  static available() { return true; }

  async connect() { await sleep(30); this.connected = true; }
  async close() { this.connected = false; }

  _stateFor(meter) {
    let s = this.state.get(meter.id);
    if (!s) {
      const seed = (meter.id * 7919) % 1000;
      s = { kwh: 120000 + seed * 137, kvarh: 21000 + seed * 23, kvah: 130000 + seed * 140, peak: 0, event: null, phaseBias: [(seed % 7) / 400, ((seed * 3) % 7) / 400, ((seed * 5) % 7) / 400], lastAt: Date.now() };
      this.state.set(meter.id, s);
    }
    return s;
  }

  _maybeEvent(s) {
    const rate = Number.isFinite(this.cfg.eventRate) ? this.cfg.eventRate : 0.002;
    if (s.event) {
      if (Date.now() > s.event.until) s.event = null;
      return;
    }
    if (Math.random() < rate) {
      const kinds = ['sag', 'sag', 'sag', 'swell', 'outage', 'overload'];
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const dur = kind === 'outage' ? 8000 + Math.random() * 20000 : 4000 + Math.random() * 15000;
      s.event = { kind, until: Date.now() + dur, depth: 0.7 + Math.random() * 0.2 };
    }
  }

  async readMeter(meter) {
    const latency = Number.isFinite(this.cfg.latencyMs) ? this.cfg.latencyMs : 40;
    await sleep(latency + Math.random() * latency);
    const failRate = Number.isFinite(this.cfg.failRate) ? this.cfg.failRate : 0.01;
    const stat = { values: {}, requests: 3, errors: 0, bytesTx: 36, bytesRx: 0, latencyMs: latency, lastError: null };
    if (Math.random() < failRate) {
      stat.errors = 1;
      stat.lastError = 'Modbus exception: Gateway target device failed to respond';
      return stat;
    }
    const s = this._stateFor(meter);
    this._maybeEvent(s);

    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const nomV = meter.nominal_v || 230;
    const rated = meter.rated_kw || 75;
    const phases = meter.phases || 3;
    const jitter = (a) => 1 + (Math.random() - 0.5) * a;

    let loadFactor = loadProfile(hour) * jitter(0.08) * (0.85 + (meter.id % 5) * 0.06);
    let vScale = 1 + (Math.random() - 0.5) * 0.01;
    let pf = 0.86 + (meter.id % 4) * 0.03;
    if (s.event) {
      if (s.event.kind === 'sag') vScale *= s.event.depth;
      if (s.event.kind === 'swell') vScale *= 1.12;
      if (s.event.kind === 'outage') { vScale = 0.02; loadFactor = 0.01; }
      if (s.event.kind === 'overload') loadFactor = 1.18;
    }
    const pTotal = rated * loadFactor;
    const v = [0, 1, 2].map((i) => nomV * vScale * (1 + s.phaseBias[i] * 0.3) * jitter(0.004));
    const pShare = [0.34 + s.phaseBias[0], 0.33 + s.phaseBias[1], 0.33 - s.phaseBias[0] - s.phaseBias[1]];
    const p = pShare.map((sh) => pTotal * sh);
    const sPh = p.map((x) => x / pf);
    const q = sPh.map((x, i) => Math.sqrt(Math.max(0, x * x - p[i] * p[i])));
    const i = sPh.map((x, k) => (v[k] > 5 ? (x * 1000) / v[k] : 0));

    const dtH = (Date.now() - s.lastAt) / 3600000;
    s.lastAt = Date.now();
    s.kwh += pTotal * dtH;
    s.kvarh += q.reduce((a, b) => a + b, 0) * dtH;
    s.kvah += sPh.reduce((a, b) => a + b, 0) * dtH;
    s.peak = Math.max(s.peak, pTotal);

    const values = {
      va: v[0], vb: v[1], vc: v[2],
      vab: v[0] * 1.732, vbc: v[1] * 1.732, vca: v[2] * 1.732,
      ia: i[0], ib: i[1], ic: i[2], in: Math.abs(i[0] - i[1]) * 0.3 + Math.random(),
      pa: p[0], pb: p[1], pc: p[2], p_total: pTotal,
      qa: q[0], qb: q[1], qc: q[2], q_total: q.reduce((a, b) => a + b, 0),
      sa: sPh[0], sb: sPh[1], sc: sPh[2], s_total: sPh.reduce((a, b) => a + b, 0),
      pfa: pf * jitter(0.01), pfb: pf * jitter(0.01), pfc: pf * jitter(0.01), pf,
      freq: (meter.nominal_hz || 50) + (Math.random() - 0.5) * 0.08 + (s.event && s.event.kind === 'outage' ? -0.6 : 0),
      kwh_import: s.kwh, kwh_export: 0, kvarh_import: s.kvarh, kvarh_export: 0, kvah: s.kvah,
      demand_kw: pTotal * 0.97, demand_peak_kw: s.peak,
      thd_va: 1.2 + Math.random() * 0.8, thd_vb: 1.1 + Math.random() * 0.8, thd_vc: 1.3 + Math.random() * 0.8,
      thd_ia: 5 + Math.random() * 4, thd_ib: 4.5 + Math.random() * 4, thd_ic: 5.5 + Math.random() * 4,
    };
    if (phases === 1) {
      for (const k of ['vb', 'vc', 'vab', 'vbc', 'vca', 'ib', 'ic', 'pb', 'pc', 'qb', 'qc', 'sb', 'sc', 'pfb', 'pfc', 'thd_vb', 'thd_vc', 'thd_ib', 'thd_ic']) delete values[k];
      values.pa = pTotal; values.ia = (pTotal / pf * 1000) / Math.max(v[0], 5);
    }
    stat.values = values;
    stat.bytesRx = 9 * 3 + 2 * 240;
    return stat;
  }
}

module.exports = SimulatorDriver;
