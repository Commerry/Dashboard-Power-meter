const { planBlocks, decodeBlock } = require('./decode');
const templates = require('../templates');

/*
 * Modbus driver - one instance per gateway.
 *
 * A Schneider gateway (EGX / Link150 / PM5xxx with built-in TCP) exposes many
 * meters on one TCP socket, one unit ID each. The bus behind it is serial, so
 * requests to one gateway are strictly sequential; different gateways run in
 * parallel from the poller.
 *
 *   modbus-tcp      Modbus/TCP  (Link150, EGX100/300, meters with Ethernet)
 *   modbus-rtu-tcp  Modbus RTU frames inside TCP (transparent serial servers)
 *   modbus-rtu      Serial RS-485 port on this machine (needs `serialport`)
 *
 * Gateway config_json: { timeoutMs, interRequestMs, maxWordsPerRead }
 */
let ModbusRTU = null;
try {
  ModbusRTU = require('modbus-serial'); // eslint-disable-line global-require
} catch (e) {
  ModbusRTU = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ModbusDriver {
  constructor(gateway) {
    this.gateway = gateway;
    this.cfg = gateway.config || {};
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.busy = Promise.resolve();
    this.blockCache = new Map(); // meterId -> { sig, blocks, map }
  }

  static available() { return !!ModbusRTU; }

  async connect() {
    if (!ModbusRTU) throw new Error('modbus-serial not installed (npm install)');
    if (this.client) await this.close();
    const g = this.gateway;
    const client = new ModbusRTU();
    client.setTimeout(this.cfg.timeoutMs || 2000);
    const port = g.port || 502;
    if (g.protocol === 'modbus-rtu-tcp') {
      await client.connectTcpRTUBuffered(g.host, { port });
    } else if (g.protocol === 'modbus-rtu') {
      const s = this.cfg.serial || {};
      await client.connectRTUBuffered(s.path || g.host, {
        baudRate: s.baudRate || 9600,
        parity: s.parity || 'none',
        dataBits: s.dataBits || 8,
        stopBits: s.stopBits || 1,
      });
    } else {
      await client.connectTCP(g.host, { port });
    }
    this.client = client;
    this.connected = true;
    this.lastError = null;
  }

  async close() {
    const c = this.client;
    this.client = null;
    this.connected = false;
    if (!c) return;
    await new Promise((resolve) => {
      try { c.close(() => resolve()); } catch (e) { resolve(); }
      setTimeout(resolve, 500);
    });
  }

  // Blocks depend only on the effective register map - cache per meter.
  _blocksFor(meter) {
    const sig = `${meter.template}|${meter.register_map_json || ''}`;
    const cached = this.blockCache.get(meter.id);
    if (cached && cached.sig === sig) return cached;
    const map = templates.resolve(meter.template, meter.register_map_json);
    const blocks = planBlocks(map.registers, { maxWords: this.cfg.maxWordsPerRead || 120 });
    const entry = { sig, blocks, map };
    this.blockCache.set(meter.id, entry);
    return entry;
  }

  /**
   * Read every register block of one meter. Resolves with
   * { values, requests, errors, bytesTx, bytesRx, latencyMs }.
   * Throws only when the transport itself is dead (so the poller reconnects).
   */
  async readMeter(meter) {
    if (!this.client || !this.connected) throw new Error('not connected');
    const { blocks, map } = this._blocksFor(meter);
    const stat = { values: {}, requests: 0, errors: 0, bytesTx: 0, bytesRx: 0, latencyMs: 0, lastError: null };
    const isTcp = this.gateway.protocol === 'modbus-tcp';
    const reqBytes = isTcp ? 12 : 8;
    const interMs = this.cfg.interRequestMs || 0;

    // serialise on the socket: one request in flight per gateway
    const run = async () => {
      const t0 = Date.now();
      this.client.setID(meter.unit_id || 1);
      for (const block of blocks) {
        const addr = block.start - (map.base || 0);
        stat.requests += 1;
        stat.bytesTx += reqBytes;
        try {
          const res = map.fn === 'input'
            ? await this.client.readInputRegisters(addr, block.count)
            : await this.client.readHoldingRegisters(addr, block.count);
          stat.bytesRx += (isTcp ? 9 : 5) + block.count * 2;
          Object.assign(stat.values, decodeBlock(res.data, block, map.wordOrder, templates.transforms));
        } catch (e) {
          stat.errors += 1;
          stat.lastError = e.message || String(e);
          // socket-level errors kill the connection; Modbus exceptions do not
          if (/ECONN|EPIPE|ENOTCONN|closed|Port Not Open|EHOSTUNREACH|ETIMEDOUT/i.test(stat.lastError)) {
            this.connected = false;
            throw e;
          }
        }
        if (interMs) await sleep(interMs);
      }
      stat.latencyMs = Date.now() - t0;
      return stat;
    };

    const p = this.busy.then(run, run);
    this.busy = p.catch(() => {});
    return p;
  }
}

module.exports = ModbusDriver;
