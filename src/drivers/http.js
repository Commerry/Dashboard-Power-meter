const { pickJson } = require('./decode');
const templates = require('../templates');

/*
 * HTTP/JSON driver - poll a REST endpoint per meter.
 *
 * Gateway: host/port are informational (base URL), config_json { headers, timeoutMs }
 * Meter:   conn_json { url, method, headers, body, jsonMap }
 *          url may be absolute or relative to http://<gateway.host>:<port>
 */
class HttpDriver {
  constructor(gateway) {
    this.gateway = gateway;
    this.cfg = gateway.config || {};
    this.connected = true; // stateless
    this.lastError = null;
  }

  static available() { return typeof fetch === 'function'; }

  async connect() { this.connected = true; }
  async close() { this.connected = false; }

  async readMeter(meter) {
    const conn = meter.conn || {};
    const g = this.gateway;
    let url = conn.url || '';
    if (!/^https?:\/\//i.test(url)) {
      const base = `http://${g.host}${g.port ? ':' + g.port : ''}`;
      url = base + (url.startsWith('/') ? url : '/' + url);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs || 5000);
    const t0 = Date.now();
    const stat = { values: {}, requests: 1, errors: 0, bytesTx: url.length + 60, bytesRx: 0, latencyMs: 0, lastError: null };
    try {
      const res = await fetch(url, {
        method: conn.method || 'GET',
        headers: { ...(this.cfg.headers || {}), ...(conn.headers || {}) },
        body: conn.body ? JSON.stringify(conn.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      stat.bytesRx = text.length;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const obj = JSON.parse(text);
      const map = templates.resolve(meter.template, meter.register_map_json);
      stat.values = pickJson(obj, conn.jsonMap || map.jsonMap);
    } catch (e) {
      stat.errors = 1;
      stat.lastError = e.name === 'AbortError' ? 'timeout' : e.message;
    } finally {
      clearTimeout(timer);
    }
    stat.latencyMs = Date.now() - t0;
    this.lastError = stat.lastError;
    return stat;
  }
}

module.exports = HttpDriver;
