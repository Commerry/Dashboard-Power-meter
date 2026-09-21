const ModbusDriver = require('./modbus');
const MqttDriver = require('./mqtt');
const HttpDriver = require('./http');
const SimulatorDriver = require('./simulator');
const S7Driver = require('./s7');

/*
 * Protocol registry. A gateway's `protocol` picks the driver.
 *
 *   kind 'poll'  - poller calls driver.readMeter(meter) on the meter's interval
 *   kind 'event' - driver.start(meters, onReading) pushes readings itself
 *   kind 'push'  - nothing to run; readings come in through POST /api/v1/ingest
 */
const PROTOCOLS = [
  { id: 'modbus-tcp', name: 'Modbus TCP (Link150 / EGX / Ethernet meter)', kind: 'poll', Driver: ModbusDriver, defaultPort: 502 },
  { id: 'modbus-rtu-tcp', name: 'Modbus RTU over TCP (serial server)', kind: 'poll', Driver: ModbusDriver, defaultPort: 4001 },
  { id: 'modbus-rtu', name: 'Modbus RTU serial (RS-485 on this PC)', kind: 'poll', Driver: ModbusDriver, defaultPort: 0 },
  { id: 'mqtt', name: 'MQTT broker (JSON topics)', kind: 'event', Driver: MqttDriver, defaultPort: 1883 },
  { id: 'http', name: 'HTTP / REST JSON polling', kind: 'poll', Driver: HttpDriver, defaultPort: 80 },
  { id: 'siemens-s7', name: 'Siemens S7 PLC (Snap7 / ISO-on-TCP, read + write)', kind: 'poll', Driver: S7Driver, defaultPort: 102, writable: true },
  { id: 'push', name: 'Push API (device POSTs to this server)', kind: 'push', Driver: null, defaultPort: 0 },
  { id: 'simulator', name: 'Simulator (demo / commissioning)', kind: 'poll', Driver: SimulatorDriver, defaultPort: 0 },
];

const BY_ID = new Map(PROTOCOLS.map((p) => [p.id, p]));

const get = (id) => BY_ID.get(id) || null;

const list = () => PROTOCOLS.map((p) => ({
  id: p.id, name: p.name, kind: p.kind, defaultPort: p.defaultPort, writable: !!p.writable,
  available: p.Driver ? p.Driver.available() : true,
  backend: p.Driver && p.Driver.backend ? p.Driver.backend() : null,
}));

const create = (gateway) => {
  const p = get(gateway.protocol);
  if (!p || !p.Driver) return null;
  return new p.Driver(gateway);
};

module.exports = { PROTOCOLS, get, list, create };
