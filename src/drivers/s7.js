const templates = require('../templates');

/*
 * Siemens S7 driver (S7-300 / 400 / 1200 / 1500 / ET200 / LOGO! via ISO-on-TCP).
 *
 * Backend: node-snap7 (Snap7 binding, native, preferred) with nodes7 (pure JS)
 * as a fallback when the native module is not available on the machine.
 * Gateway config_json: { rack: 0, slot: 1, timeoutMs: 3000, lib: 'auto'|'snap7'|'nodes7' }
 *   S7-1200 / 1500: rack 0, slot 1 (enable PUT/GET + disable optimized block access on the DB)
 *   S7-300 / 400 : rack 0, slot 2
 *
 * Tags (used as "registers" in a meter template, and as stage outputs of the
 * peak-demand controller):
 *   { key, area: 'DB'|'M'|'I'|'Q', db: 1, start: 4, type: 'REAL'|'LREAL'|'INT'|'DINT'|'WORD'|'DWORD'|'BYTE'|'BOOL', bit: 0, scale: 1 }
 *
 * readTags(tags)  -> { key: value }      (bulk read, one request per contiguous area block)
 * writeTag(tag, value) -> true           (single tag write, BOOL writes one bit)
 * readMeter(meter)                       (same contract as the Modbus driver)
 * plcInfo()                              CPU diagnostics: RUN/STOP, module, order code + firmware,
 *                                        serial, PLC clock (+drift), PDU size, protection, block counts
 *                                        (node-snap7 only; S7-1200/1500 answer a subset)
 */
let snap7 = null;
let nodes7 = null;
try { snap7 = require('node-snap7'); } catch (e) { snap7 = null; }          // eslint-disable-line global-require
try { nodes7 = require('nodes7'); } catch (e) { nodes7 = null; }            // eslint-disable-line global-require

const AREA = { DB: 0x84, M: 0x83, I: 0x81, Q: 0x82 };
const SIZE = { BOOL: 1, BYTE: 1, INT: 2, WORD: 2, DINT: 4, DWORD: 4, REAL: 4, LREAL: 8 };
const WL_BYTE = 0x02;
const WL_BIT = 0x01;

const sizeOf = (t) => SIZE[String(t || 'REAL').toUpperCase()] || 4;
const normType = (t) => String(t || 'REAL').toUpperCase();

const decode = (buf, tag) => {
  const t = normType(tag.type);
  switch (t) {
    case 'BOOL': return (buf[0] >> (tag.bit || 0)) & 1;
    case 'BYTE': return buf.readUInt8(0);
    case 'INT': return buf.readInt16BE(0);
    case 'WORD': return buf.readUInt16BE(0);
    case 'DINT': return buf.readInt32BE(0);
    case 'DWORD': return buf.readUInt32BE(0);
    case 'LREAL': return buf.readDoubleBE(0);
    case 'REAL':
    default: return buf.readFloatBE(0);
  }
};

const encode = (tag, value) => {
  const t = normType(tag.type);
  const v = Number(value);
  let buf;
  switch (t) {
    case 'BYTE': buf = Buffer.alloc(1); buf.writeUInt8(v & 0xff, 0); return buf;
    case 'INT': buf = Buffer.alloc(2); buf.writeInt16BE(Math.round(v), 0); return buf;
    case 'WORD': buf = Buffer.alloc(2); buf.writeUInt16BE(Math.round(v) & 0xffff, 0); return buf;
    case 'DINT': buf = Buffer.alloc(4); buf.writeInt32BE(Math.round(v), 0); return buf;
    case 'DWORD': buf = Buffer.alloc(4); buf.writeUInt32BE(Math.round(v) >>> 0, 0); return buf;
    case 'LREAL': buf = Buffer.alloc(8); buf.writeDoubleBE(v, 0); return buf;
    case 'REAL':
    default: buf = Buffer.alloc(4); buf.writeFloatBE(v, 0); return buf;
  }
};

// nodes7 address string for a tag: DB1,REAL4  DB1,X4.0  MR4  MX4.0  IX0.0  QW2
const nodes7Addr = (tag) => {
  const t = normType(tag.type);
  const area = String(tag.area || 'DB').toUpperCase();
  const code = { BOOL: 'X', BYTE: 'B', INT: 'I', WORD: 'W', DINT: 'DI', DWORD: 'D', REAL: 'R', LREAL: 'LR' }[t] || 'R';
  const suffix = t === 'BOOL' ? `${tag.start}.${tag.bit || 0}` : String(tag.start);
  const dbCode = { BOOL: 'X', BYTE: 'BYTE', INT: 'INT', WORD: 'WORD', DINT: 'DINT', DWORD: 'DWORD', REAL: 'REAL', LREAL: 'LREAL' }[t] || 'REAL';
  if (area === 'DB') return `DB${tag.db || 1},${dbCode}${suffix}`;
  return `${area}${code}${suffix}`;
};

/** Group tags of one area/db into contiguous byte ranges (max 200 bytes, gap <= 16). */
const planBlocks = (tags) => {
  const groups = new Map();
  for (const t of tags) {
    if (!Number.isFinite(t.start)) continue;
    const area = String(t.area || 'DB').toUpperCase();
    const k = `${area}|${area === 'DB' ? (t.db || 1) : 0}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...t, area, size: sizeOf(t.type) });
  }
  const blocks = [];
  for (const [k, list] of groups) {
    const [area, db] = k.split('|');
    list.sort((a, b) => a.start - b.start);
    let cur = null;
    for (const t of list) {
      const end = t.start + t.size;
      if (cur && t.start - cur.end <= 16 && end - cur.start <= 200) { cur.end = Math.max(cur.end, end); cur.tags.push(t); } else { cur = { area, db: Number(db), start: t.start, end, tags: [t] }; blocks.push(cur); }
    }
  }
  return blocks;
};

class S7Driver {
  constructor(gateway) {
    this.gateway = gateway;
    this.cfg = gateway.config || {};
    this.lib = this.cfg.lib && this.cfg.lib !== 'auto' ? this.cfg.lib : (snap7 ? 'snap7' : 'nodes7');
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.busy = Promise.resolve();
  }

  static available() { return !!(snap7 || nodes7); }
  static backend() { return snap7 ? 'node-snap7' : nodes7 ? 'nodes7' : null; }

  // serialise every request on the socket
  _queue(fn) {
    const p = this.busy.then(fn, fn);
    this.busy = p.catch(() => {});
    return p;
  }

  async connect() {
    await this.close();
    const g = this.gateway;
    const rack = Number.isFinite(this.cfg.rack) ? this.cfg.rack : 0;
    const slot = Number.isFinite(this.cfg.slot) ? this.cfg.slot : 1;
    const timeout = this.cfg.timeoutMs || 3000;
    if (this.lib === 'snap7') {
      if (!snap7) throw new Error('node-snap7 not installed');
      const c = new snap7.S7Client();
      // constants (S7AreaDB, S7WLByte, PingTimeout ...) live on the client instance
      try { c.SetParam(c.PingTimeout, timeout); c.SetParam(c.RecvTimeout, timeout); c.SetParam(c.SendTimeout, timeout); if (g.port && Number(g.port) !== 102) c.SetParam(c.RemotePort, Number(g.port)); } catch (e) { /* defaults */ }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('connect timeout')), timeout + 2000);
        c.ConnectTo(g.host, rack, slot, (err) => { clearTimeout(timer); if (err) reject(new Error(c.ErrorText(err))); else resolve(); });
      });
      this.client = c;
    } else {
      if (!nodes7) throw new Error('nodes7 not installed');
      const c = new nodes7({ silent: true });
      await new Promise((resolve, reject) => {
        c.initiateConnection({ host: g.host, port: g.port || 102, rack, slot, timeout }, (err) => (err ? reject(new Error(String(err))) : resolve()));
      });
      this.client = c;
    }
    this.connected = true;
    this.lastError = null;
  }

  async close() {
    const c = this.client;
    this.client = null;
    this.connected = false;
    if (!c) return;
    await new Promise((resolve) => {
      try {
        if (this.lib === 'snap7') { c.Disconnect(); resolve(); } else c.dropConnection(() => resolve());
      } catch (e) { resolve(); }
      setTimeout(resolve, 500);
    });
  }

  _dead(msg) {
    if (/timeout|closed|ECONN|EPIPE|not connected|ISO|TCP|refused|reset/i.test(msg)) { this.connected = false; return true; }
    return false;
  }

  /** Read a set of tags. Resolves { values, requests, errors, bytesRx, bytesTx, latencyMs, lastError }. */
  readTags(tags) {
    return this._queue(async () => {
      if (!this.client || !this.connected) throw new Error('not connected');
      const t0 = Date.now();
      const stat = { values: {}, requests: 0, errors: 0, bytesRx: 0, bytesTx: 0, latencyMs: 0, lastError: null };
      const blocks = planBlocks(tags);
      if (this.lib === 'snap7') {
        for (const b of blocks) {
          stat.requests += 1; stat.bytesTx += 31;
          try {
            const buf = await new Promise((resolve, reject) => {
              this.client.ReadArea(AREA[b.area], b.db, b.start, b.end - b.start, WL_BYTE, (err, data) => (err ? reject(new Error(this.client.ErrorText(err))) : resolve(data)));
            });
            stat.bytesRx += buf.length + 25;
            for (const t of b.tags) {
              let v = decode(buf.subarray(t.start - b.start, t.start - b.start + t.size), t);
              if (Number.isFinite(t.scale) && t.scale !== 1) v *= t.scale;
              if (Number.isFinite(t.offset) && t.offset) v += t.offset;
              if (Number.isFinite(v)) stat.values[t.key] = v;
            }
          } catch (e) {
            stat.errors += 1; stat.lastError = e.message;
            if (this._dead(e.message)) throw e;
          }
        }
      } else {
        const addrs = tags.filter((t) => Number.isFinite(t.start)).map((t) => [t, nodes7Addr(t)]);
        stat.requests += Math.max(1, blocks.length); stat.bytesTx += 31 * Math.max(1, blocks.length);
        try {
          this.client.removeItems();
          this.client.addItems(addrs.map((a) => a[1]));
          const values = await new Promise((resolve, reject) => {
            this.client.readAllItems((err, v) => (err ? reject(new Error('read failed')) : resolve(v)));
          });
          stat.bytesRx += addrs.reduce((a, [t]) => a + sizeOf(t.type), 0) + 25 * blocks.length;
          for (const [t, addr] of addrs) {
            let v = values[addr];
            if (typeof v === 'boolean') v = v ? 1 : 0;
            if (Number.isFinite(t.scale) && t.scale !== 1 && Number.isFinite(v)) v *= t.scale;
            if (Number.isFinite(t.offset) && t.offset && Number.isFinite(v)) v += t.offset;
            if (Number.isFinite(v)) stat.values[t.key] = v;
          }
        } catch (e) {
          stat.errors += 1; stat.lastError = e.message;
          if (this._dead(e.message)) throw e;
        }
      }
      stat.latencyMs = Date.now() - t0;
      this.lastError = stat.lastError;
      return stat;
    });
  }

  /** Write one tag. BOOL writes a single bit; numeric types write the whole value. */
  writeTag(tag, value) {
    return this._queue(async () => {
      if (!this.client || !this.connected) throw new Error('not connected');
      const area = String(tag.area || 'DB').toUpperCase();
      const db = area === 'DB' ? (tag.db || 1) : 0;
      const t = normType(tag.type);
      if (this.lib === 'snap7') {
        await new Promise((resolve, reject) => {
          const done = (err) => (err ? reject(new Error(this.client.ErrorText(err))) : resolve());
          if (t === 'BOOL') {
            const buf = Buffer.from([value ? 1 : 0]);
            this.client.WriteArea(AREA[area], db, tag.start * 8 + (tag.bit || 0), 1, WL_BIT, buf, done);
          } else {
            const buf = encode(tag, value);
            this.client.WriteArea(AREA[area], db, tag.start, buf.length, WL_BYTE, buf, done);
          }
        }).catch((e) => { this._dead(e.message); throw e; });
      } else {
        await new Promise((resolve, reject) => {
          this.client.writeItems(nodes7Addr(tag), t === 'BOOL' ? !!value : Number(value), (err) => (err ? reject(new Error('write failed')) : resolve()));
        }).catch((e) => { this._dead(e.message); throw e; });
      }
      return true;
    });
  }

  /** CPU diagnostics through the Snap7 system functions. Every call is optional - a CPU that refuses one just leaves it null. */
  plcInfo() {
    return this._queue(async () => {
      if (!this.client || !this.connected) throw new Error('not connected');
      const t0 = Date.now();
      const info = { at: t0, backend: this.lib, status: 'UNKNOWN', statusCode: null, cpu: null, cp: null, orderCode: null, firmware: null, plcTime: null, clockDriftSec: null, protection: null, blocks: null, pduLength: null, pduRequested: null, latencyMs: 0, errors: [] };
      if (this.lib !== 'snap7') { info.errors.push('diagnostics need node-snap7'); return info; }
      const c = this.client;
      const call = (m, ...args) => new Promise((resolve) => {
        if (typeof c[m] !== 'function') return resolve(null);
        try { c[m](...args, (err, data) => resolve(err ? (info.errors.push(m + ': ' + c.ErrorText(err)), null) : data)); } catch (e) { info.errors.push(m + ': ' + e.message); resolve(null); }
      });
      const st = await call('PlcStatus');
      if (typeof st === 'number') { info.statusCode = st; info.status = st === c.S7CpuStatusRun ? 'RUN' : st === c.S7CpuStatusStop ? 'STOP' : 'UNKNOWN'; }
      const cpu = await call('GetCpuInfo');
      if (cpu) info.cpu = { moduleType: cpu.ModuleTypeName, serial: cpu.SerialNumber, asName: cpu.ASName, moduleName: cpu.ModuleName, copyright: cpu.Copyright };
      const order = await call('GetOrderCode');
      if (order) { info.orderCode = order.Code; info.firmware = `V${order.V1}.${order.V2}.${order.V3}`; }
      const cp = await call('GetCpInfo');
      if (cp) info.cp = { maxPdu: cp.MaxPduLength, maxConnections: cp.MaxConnections, maxMpiRate: cp.MaxMpiRate, maxBusRate: cp.MaxBusRate };
      const dt = await call('GetPlcDateTime');
      if (dt instanceof Date && !Number.isNaN(dt.getTime())) { info.plcTime = dt.getTime(); info.clockDriftSec = Math.round((dt.getTime() - Date.now()) / 1000); }
      const prot = await call('GetProtection');
      if (prot) info.protection = { level: prot.sch_schaal, parameterised: prot.sch_par, valid: prot.sch_rel, mode: prot.bart_sch, startup: prot.anl_sch };
      const bl = await call('ListBlocks');
      if (bl) info.blocks = { OB: bl.OBCount, FB: bl.FBCount, FC: bl.FCCount, SFB: bl.SFBCount, SFC: bl.SFCCount, DB: bl.DBCount, SDB: bl.SDBCount };
      try { info.pduLength = c.PDULength(); info.pduRequested = c.PDURequested(); } catch (e) { /* older binding */ }
      info.latencyMs = Date.now() - t0;
      return info;
    });
  }

  /** Meter contract: the meter's register map lists S7 tags keyed by metric. */
  async readMeter(meter) {
    const map = templates.resolve(meter.template, meter.register_map_json);
    const tags = (map.registers || []).filter((r) => r.area || Number.isFinite(r.db) || Number.isFinite(r.start)).map((r) => ({ ...r, area: r.area || 'DB', start: Number.isFinite(r.start) ? r.start : r.addr }));
    if (!tags.length) return { values: {}, requests: 0, errors: 1, bytesRx: 0, bytesTx: 0, latencyMs: 0, lastError: 'no S7 tags configured' };
    return this.readTags(tags);
  }
}

module.exports = S7Driver;
module.exports.nodes7Addr = nodes7Addr;
module.exports.planBlocks = planBlocks;
