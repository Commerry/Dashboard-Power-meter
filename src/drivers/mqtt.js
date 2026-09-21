const { pickJson } = require('./decode');
const templates = require('../templates');

/*
 * MQTT driver - the gateway is a broker, each meter is a topic.
 *
 * Gateway: host, port (1883), config_json { username, password, tls, clientId }
 * Meter:   conn_json { topic, jsonMap? }   (jsonMap overrides the template map)
 *
 * Event-driven: the poller calls start(onReading) once; readings arrive
 * whenever the device publishes.
 */
let mqttLib = null;
try {
  mqttLib = require('mqtt'); // eslint-disable-line global-require
} catch (e) {
  mqttLib = null;
}

class MqttDriver {
  constructor(gateway) {
    this.gateway = gateway;
    this.cfg = gateway.config || {};
    this.client = null;
    this.connected = false;
    this.lastError = null;
    this.byTopic = new Map();
    this.stats = { bytesRx: 0, bytesTx: 0, messages: 0 };
    this.eventDriven = true;
  }

  static available() { return !!mqttLib; }

  async start(meters, onReading) {
    if (!mqttLib) throw new Error('mqtt package not installed (npm install mqtt)');
    await this.close();
    const g = this.gateway;
    const scheme = this.cfg.tls ? 'mqtts' : 'mqtt';
    const url = `${scheme}://${g.host}:${g.port || 1883}`;
    this.byTopic.clear();
    for (const m of meters) {
      const conn = m.conn || {};
      if (!conn.topic) continue;
      const map = templates.resolve(m.template, m.register_map_json);
      this.byTopic.set(conn.topic, { meter: m, jsonMap: conn.jsonMap || map.jsonMap });
    }
    const client = mqttLib.connect(url, {
      username: this.cfg.username || undefined,
      password: this.cfg.password || undefined,
      clientId: this.cfg.clientId || `powercenter-${g.id}-${Math.random().toString(16).slice(2, 8)}`,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    });
    this.client = client;
    client.on('connect', () => {
      this.connected = true;
      this.lastError = null;
      for (const topic of this.byTopic.keys()) client.subscribe(topic);
    });
    client.on('reconnect', () => { this.connected = false; });
    client.on('close', () => { this.connected = false; });
    client.on('error', (e) => { this.lastError = e.message; this.connected = false; });
    client.on('message', (topic, payload) => {
      this.stats.messages += 1;
      this.stats.bytesRx += payload.length;
      const hit = this.byTopic.get(topic) || this._wildcardMatch(topic);
      if (!hit) return;
      let obj;
      try { obj = JSON.parse(payload.toString('utf8')); } catch (e) { return; }
      const values = pickJson(obj, hit.jsonMap);
      onReading(hit.meter, { values, bytesRx: payload.length, bytesTx: 0, requests: 1, errors: 0, latencyMs: 0 });
    });
  }

  // support "plant/+/meter1" style subscriptions
  _wildcardMatch(topic) {
    for (const [pattern, hit] of this.byTopic) {
      if (!pattern.includes('+') && !pattern.includes('#')) continue;
      const re = new RegExp('^' + pattern.replace(/[.*?^${}()|[\]\\]/g, '\\$&').replace(/\+/g, '[^/]+').replace(/#/g, '.*') + '$');
      if (re.test(topic)) return hit;
    }
    return null;
  }

  async close() {
    const c = this.client;
    this.client = null;
    this.connected = false;
    if (!c) return;
    await new Promise((resolve) => { try { c.end(true, {}, resolve); } catch (e) { resolve(); } setTimeout(resolve, 500); });
  }
}

module.exports = MqttDriver;
