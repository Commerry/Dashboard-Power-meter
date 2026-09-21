const { WebSocketServer } = require('ws');
const config = require('./config');
const auth = require('./auth');
const { statements } = require('./db');
const views = require('./views');

/*
 * Realtime fan-out.
 *
 *   WebSocket /ws   dashboard + API subscribers
 *   MQTT publish    optional mirror of every reading to a broker
 *   Webhook         optional POST on alarm open / close
 *
 * A client subscribes with { type:'sub', scope } where scope is one of
 *   { all: true }            summary + events + gateways (no per-meter readings)
 *   { plantId }              readings of every meter in the plant
 *   { lineId }               readings of every meter in the line
 *   { meterIds: [..] }       readings of those meters
 *   { gateways: true }       gateway traffic snapshots every second
 *   { demand: true }         peak-demand group snapshots every second
 *
 * Readings are pushed as they happen; with hundreds of meters the scope keeps
 * the traffic to what the screen is showing.
 */
const send = (ws, obj) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
};

class Realtime {
  constructor({ server, poller, alarms, demand }) {
    this.poller = poller;
    this.alarms = alarms;
    this.demand = demand;
    this.wss = new WebSocketServer({ noServer: true });
    this.clients = new Set();
    this.mqtt = null;
    server.on('upgrade', (req, socket, head) => {
      if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
      const user = auth.sessionUser(req);
      const url = new URL(req.url, 'http://x');
      const key = url.searchParams.get('api_key');
      const apiKey = key ? auth.apiKeyFromRequest({ get: () => null, query: { api_key: key } }) : null;
      if (!user && !apiKey) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        ws.scope = { all: true };
        ws.user = user;
        ws.isAlive = true;
        this.clients.add(ws);
        ws.on('pong', () => { ws.isAlive = true; });
        ws.on('message', (data) => this.onMessage(ws, data));
        ws.on('close', () => this.clients.delete(ws));
        send(ws, { type: 'hello', at: Date.now(), site: config.siteName });
        this.sendSummary(ws);
      });
    });

    poller.on('reading', (r) => this.onReading(r));
    poller.on('gateway', (g) => this.broadcast({ type: 'gateway', gateway: g }, (ws) => ws.scope.all || ws.scope.gateways));
    alarms.on('event', (e) => this.onEvent(e));
    if (demand) demand.on('tick', (groups) => this.broadcast({ type: 'demand', groups }, (ws) => ws.scope.demand));

    this.summaryTimer = setInterval(() => {
      for (const ws of this.clients) if (ws.scope.all || ws.scope.plantId || ws.scope.lineId) this.sendSummary(ws);
    }, 2000);
    this.gatewayTimer = setInterval(() => {
      const snaps = poller.gatewaySnapshots().map((s) => ({ ...s, log: undefined }));
      this.broadcast({ type: 'gateways', gateways: snaps }, (ws) => ws.scope.gateways);
    }, 1000);
    this.pingTimer = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) { ws.terminate(); this.clients.delete(ws); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch (e) { /* closing */ }
      }
    }, 30000);

    this.setupMqtt();
  }

  onMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    if (msg.type === 'sub') {
      ws.scope = msg.scope || { all: true };
      // send a snapshot of the scope right away so the screen fills instantly
      for (const id of this.metersInScope(ws.scope)) {
        const cur = this.poller.latest.get(id);
        const meter = this.poller.meterIndex.get(id);
        if (cur && meter) send(ws, this.readingMsg(meter, cur.at, cur.values, cur, this.alarms.statusOf(id)));
      }
      this.sendSummary(ws);
    } else if (msg.type === 'ping') {
      send(ws, { type: 'pong', at: Date.now() });
    }
  }

  metersInScope(scope) {
    const ids = [];
    for (const [id, m] of this.poller.meterIndex) {
      if (scope.meterIds && scope.meterIds.includes(id)) ids.push(id);
      else if (scope.lineId && m.line_id === Number(scope.lineId)) ids.push(id);
      else if (scope.plantId && m.plant_id === Number(scope.plantId)) ids.push(id);
    }
    return ids;
  }

  inScope(ws, meter) {
    const s = ws.scope || {};
    if (s.meterIds && s.meterIds.includes(meter.id)) return true;
    if (s.lineId && meter.line_id === Number(s.lineId)) return true;
    if (s.plantId && meter.plant_id === Number(s.plantId)) return true;
    return false;
  }

  readingMsg(meter, at, values, cur, status) {
    return {
      type: 'reading',
      meterId: meter.id,
      at,
      status: cur.status,
      alarm: status ? status.severity : null,
      alarms: status ? status.types : [],
      lastError: cur.lastError || null,
      latencyMs: cur.latencyMs || null,
      values,
    };
  }

  onReading({ meter, at, values, status }) {
    const cur = this.poller.latest.get(meter.id) || {};
    const msg = this.readingMsg(meter, at, values, cur, status);
    this.broadcast(msg, (ws) => this.inScope(ws, meter));
    this.publishMqtt(meter, at, values, cur.status);
  }

  onEvent({ action, event }) {
    const msg = { type: 'event', action, event: views.eventView(event) };
    this.broadcast(msg, () => true);
    this.webhook(msg);
  }

  summary() {
    let online = 0; let offline = 0; let error = 0; let kw = 0;
    const perPlant = new Map();
    for (const [id, cur] of this.poller.latest) {
      const m = this.poller.meterIndex.get(id);
      if (!m || !m.enabled) continue;
      const p = perPlant.get(m.plant_id) || { online: 0, offline: 0, kw: 0, alarms: 0 };
      if (cur.status === 'ok') { online += 1; p.online += 1; } else { offline += 1; p.offline += 1; }
      if (cur.status === 'error') error += 1;
      if (cur.status === 'ok' && Number.isFinite(cur.values.p_total)) { kw += cur.values.p_total; p.kw += cur.values.p_total; }
      const st = this.alarms.statusOf(id);
      if (st.severity) p.alarms += st.types.length;
      perPlant.set(m.plant_id, p);
    }
    const active = statements.activeEvents.all();
    return {
      type: 'summary',
      at: Date.now(),
      meters: { total: online + offline, online, offline, error },
      kwTotal: kw,
      alarms: {
        total: active.length,
        critical: active.filter((e) => e.severity === 'critical').length,
        error: active.filter((e) => e.severity === 'error').length,
        warn: active.filter((e) => e.severity === 'warn').length,
        unacked: active.filter((e) => !e.acked_at).length,
      },
      gateways: this.poller.gatewaySnapshots().map((g) => ({ id: g.id, connected: g.connected, plantId: g.plantId, metersOnline: g.metersOnline, metersTotal: g.metersTotal })),
      demand: this.demand ? this.demand.summary() : null,
      plants: Object.fromEntries(perPlant),
    };
  }

  sendSummary(ws) { send(ws, this.summary()); }

  broadcast(msg, filter) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      if (filter && !filter(ws)) continue;
      ws.send(data);
    }
  }

  // ---- outbound MQTT mirror ----
  setupMqtt() {
    const c = config.mqttPublish;
    if (!c.url) return;
    let mqtt;
    try { mqtt = require('mqtt'); } catch (e) { console.warn('MQTT_PUBLISH_URL set but mqtt package missing'); return; } // eslint-disable-line global-require
    this.mqtt = mqtt.connect(c.url, { username: c.username || undefined, password: c.password || undefined, reconnectPeriod: 5000 });
    this.mqtt.on('connect', () => console.log('mqtt publish: connected', c.url));
    this.mqtt.on('error', (e) => console.warn('mqtt publish:', e.message));
  }

  publishMqtt(meter, at, values, status) {
    if (!this.mqtt || !this.mqtt.connected) return;
    const topic = `${config.mqttPublish.prefix}/${meter.plant_id || 0}/${meter.line_id || 0}/${meter.code || meter.id}`;
    this.mqtt.publish(topic, JSON.stringify({ meterId: meter.id, code: meter.code, name: meter.name, at, status, ...values }), { qos: 0 });
  }

  // ---- alarm webhook ----
  webhook(msg) {
    if (!config.alarmWebhookUrl || msg.action === 'update') return;
    fetch(config.alarmWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: config.siteName, ...msg }),
    }).catch((e) => console.warn('alarm webhook failed:', e.message));
  }
}

module.exports = { Realtime };
