/*
 * Power Center client for Node.js (>= 18) and browsers.
 *
 *   const { PowerCenter } = require('./power-center-client');
 *   const pc = new PowerCenter('http://server:64088', 'pc_xxxx');
 *   const latest = await pc.latest('L1-PM01');
 *   const hist = await pc.history('L1-PM01', { from: Date.now() - 86400000, interval: 900, keys: ['p_total', 'v_ln_avg'] });
 *   await pc.ingest('PULSE-01', { kwh_import: 1200.5, p_total: 3.1 });
 *
 *   const ws = pc.subscribe({ lineId: 3 }, (msg) => { if (msg.type === 'reading') console.log(msg.meterId, msg.values.p_total); });
 *   ws.close();
 *
 * Zero dependencies. In Node the WebSocket comes from the `ws` package if
 * installed, otherwise from the global WebSocket (Node 22+).
 */
class PowerCenter {
  constructor(baseUrl, apiKey, { timeoutMs = 10000 } = {}) {
    this.base = String(baseUrl).replace(/\/+$/, '');
    this.key = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(this.base + '/api/v1' + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { 'X-Api-Key': this.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) {
        const err = new Error(data.error || `HTTP ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  ping() { return this.request('/ping'); }
  metrics() { return this.request('/metrics').then((d) => d.metrics); }
  plants() { return this.request('/plants'); }
  gateways() { return this.request('/gateways').then((d) => d.gateways); }
  meters(query = {}) { return this.request('/meters', { query }).then((d) => d.meters); }
  meter(idOrCode) { return this.request(`/meters/${encodeURIComponent(idOrCode)}`).then((d) => d.meter); }
  latest(idOrCode) { return this.request(`/meters/${encodeURIComponent(idOrCode)}/latest`); }
  history(idOrCode, { from, to, interval = 'raw', keys, limit } = {}) {
    return this.request(`/meters/${encodeURIComponent(idOrCode)}/history`, { query: { from, to, interval, keys, limit } });
  }
  summary(idOrCode, { from, to } = {}) { return this.request(`/meters/${encodeURIComponent(idOrCode)}/summary`, { query: { from, to } }); }
  hourly(idOrCode, { from, to } = {}) { return this.request(`/meters/${encodeURIComponent(idOrCode)}/hourly`, { query: { from, to } }).then((d) => d.rows); }
  events(query = {}) { return this.request('/events', { query }).then((d) => d.events); }
  activeEvents() { return this.request('/events/active').then((d) => d.events); }
  ack(eventId, note = '') { return this.request(`/events/${eventId}/ack`, { method: 'POST', body: { note } }); }

  // peak demand
  demand() { return this.request('/demand'); }
  demandGroup(id, { from, to } = {}) { return this.request(`/demand/${id}`, { query: { from, to } }); }
  demandAuto(id, auto) { return this.request(`/demand/${id}/auto`, { method: 'POST', body: { auto } }); }
  demandShed(id, stageId) { return this.request(`/demand/${id}/stages/${stageId}/shed`, { method: 'POST', body: {} }); }
  demandRestore(id, stageId) { return this.request(`/demand/${id}/stages/${stageId}/restore`, { method: 'POST', body: {} }); }

  /** Push one reading: values = { metricKey: number } (or raw data via { data }) */
  ingest(meter, values, at) { return this.request('/ingest', { method: 'POST', body: { meter, values, at } }); }
  ingestRaw(meter, data, at) { return this.request('/ingest', { method: 'POST', body: { meter, data, at } }); }
  ingestBatch(readings) { return this.request('/ingest', { method: 'POST', body: { readings } }); }

  /** Realtime subscription. Returns the socket; call .close() when done. Reconnects automatically. */
  subscribe(scope, onMessage, { onOpen, onClose, reconnectMs = 3000 } = {}) {
    const WS = typeof WebSocket !== 'undefined' ? WebSocket : (() => { try { return require('ws'); } catch (e) { throw new Error('install the ws package or use Node 22+'); } })(); // eslint-disable-line global-require
    const url = this.base.replace(/^http/, 'ws') + '/ws?api_key=' + encodeURIComponent(this.key);
    let ws; let closed = false;
    const connect = () => {
      ws = new WS(url);
      ws.onopen = () => { ws.send(JSON.stringify({ type: 'sub', scope })); if (onOpen) onOpen(); };
      ws.onmessage = (ev) => { try { onMessage(JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString())); } catch (e) { /* ignore */ } };
      ws.onclose = () => { if (onClose) onClose(); if (!closed) setTimeout(connect, reconnectMs); };
      ws.onerror = () => { try { ws.close(); } catch (e) { /* ignore */ } };
    };
    connect();
    return { close() { closed = true; ws.close(); }, setScope(s) { scope = s; if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'sub', scope })); } };
  }
}

if (typeof module !== 'undefined') module.exports = { PowerCenter };
if (typeof window !== 'undefined') window.PowerCenter = PowerCenter;
