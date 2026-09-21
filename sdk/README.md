# Power Center SDK / examples

| file | use |
|---|---|
| `power-center-client.js` | Node.js (>= 18) / browser client — REST + realtime WebSocket, no dependencies |
| `power_center.py` | Python 3.8+ client — standard library only; drops straight into pandas |
| `esp32_pulse_ingest.ino` | ESP32 kWh pulse counter that pushes readings to `/api/v1/ingest` |

Full endpoint reference: [../docs/API.md](../docs/API.md)

## Node.js

```js
const { PowerCenter } = require('./power-center-client');
const pc = new PowerCenter('http://server:64088', process.env.PC_KEY);

const { values } = await pc.latest('L1-PM01');
console.log(values.p_total, 'kW');

const hist = await pc.history('L1-PM01', { from: Date.now() - 86400000, interval: 900, keys: ['p_total', 'v_ln_avg'] });

const sub = pc.subscribe({ lineId: 1 }, (msg) => {
  if (msg.type === 'reading') console.log(msg.meterId, msg.values.p_total);
  if (msg.type === 'event') console.log(msg.action, msg.event.type, msg.event.meterName);
});
```

## Python

```python
from power_center import PowerCenter
pc = PowerCenter("http://server:64088", "pc_xxx")
for m in pc.meters(line_id=1):
    print(m["name"], m["status"], m["values"].get("p_total"))
pc.ingest("PULSE-01", {"kwh_import": 1200.5, "p_total": 3.1})
```

## Node-RED / n8n / PLC

Plain HTTP: `GET /api/v1/meters/<code>/latest` with header `X-Api-Key`, or POST JSON to `/api/v1/ingest`. Alarm webhooks (`ALARM_WEBHOOK_URL` in `.env`) POST `{ site, type: "event", action: "open"|"close", event: {...} }`.
