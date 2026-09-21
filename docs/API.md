# Power Center — Public API

Base URL: `http://<server>:8095/api/v1`

## Authentication

Create a key in **Settings › API keys** (admin). Send it on every request:

```
X-Api-Key: pc_xxxxxxxxxxxxxxxx
```

Alternatives: `?api_key=pc_...` query string, or `Authorization: Bearer pc_...`.

| scope | allows |
|---|---|
| `read` | every `GET` |
| `write` | acknowledge alarms |
| `ingest` | `POST /ingest` |
| `all` | everything |

Errors: `401` no/invalid key · `403` missing scope · `404` unknown meter · `400` bad payload. Every body has `success: true|false` and `error` on failure.

Times are **unix milliseconds** (`at`, `from`, `to`, `startedAt`, `endedAt`). `from` / `to` also accept ISO strings (`2026-09-21T08:00:00+07:00`). Default range = last 24 h.

Meters are addressed by numeric `id` **or** by `code` (`/meters/L1-PM01/...`).

---

## Read

### `GET /ping`
`{ success, at, version: 1 }` — no key needed.

### `GET /metrics`
List of metric keys with label / unit / group / decimals:

```json
{ "key": "p_total", "label": "Active Power Total", "unit": "kW", "group": "power", "decimals": 2, "stored": true }
```

Main keys: `va vb vc v_ln_avg vab vbc vca v_ll_avg ia ib ic in i_avg pa pb pc p_total qa qb qc q_total sa sb sc s_total pfa pfb pfc pf freq kwh_import kwh_export kvarh_import kvarh_export kvah demand_kw demand_peak_kw demand_kva thd_va thd_vb thd_vc thd_ia thd_ib thd_ic v_unbal i_unbal`

### `GET /plants`
Full tree with live counters:

```json
{ "plants": [ { "id": 1, "name": "Samut Prakan Plant", "code": "SPK", "meters": 13, "online": 13, "alarms": 0, "kw": 142.4,
   "lines": [ { "id": 1, "name": "Line 1 - Extrusion", "meters": 5, "online": 5, "kw": 64.4, "sections": [ { "id": 1, "name": "Extruder", "meters": 1 } ] } ] } ],
  "unassigned": { "meters": 0, "online": 0, "alarms": 0 } }
```

### `GET /meters?plantId=&lineId=&values=0`
All meters with their latest values. `values=0` omits the value object (lighter).

```json
{ "at": 1726900000000, "meters": [ {
  "id": 1, "name": "L1-PM01", "code": "L1-PM01", "plantId": 1, "plantName": "...", "lineId": 1, "lineName": "...", "sectionName": "Extruder",
  "gatewayId": 1, "gatewayName": "GW-SPK-01", "template": "schneider-pm5xxx", "brand": "Schneider Electric", "model": "PowerLogic PM5xxx", "unitId": 1,
  "nominalV": 230, "ratedKw": 90, "ratedA": 171, "phases": 3,
  "status": "ok",              // ok | error | offline | unknown | disabled
  "at": 1726900000000, "lastOk": 1726900000000, "latencyMs": 35,
  "alarm": "warn",             // highest open severity: null | warn | error | critical
  "alarms": [ { "type": "low_pf", "severity": "warn", "value": 0.82, "id": 55 } ],
  "values": { "va": 230.1, "vb": 229.8, "vc": 231.0, "ia": 25.1, "p_total": 14.9, "pf": 0.89, "freq": 50.01, "kwh_import": 245903.8, ... }
} ] }
```

### `GET /meters/:id`
One meter, same shape.

### `GET /meters/:id/latest`
Cheapest call for polling: `{ meterId, code, name, status, at, alarm, values }`.

### `GET /meters/:id/history?from=&to=&interval=&keys=&limit=`
- `interval`: `raw` (default) or seconds `60 | 300 | 900 | 3600 | 86400`. Buckets are **averages**; energy counters are the bucket **max**; `v_ln_min/v_ln_max` and `p_min/p_max` are added so a dip inside a bucket is still visible.
- `keys`: comma list of stored metric keys **or the device's own custom tag keys** (default: all stored + custom)
- `limit`: raw mode decimates (stride) to at most this many rows (default 5000, max 50000)

```json
{ "meterId": 1, "from": ..., "to": ..., "interval": 900, "keys": ["p_total","v_ln_avg"],
  "rows": [ { "at": 1726900200000, "n": 30, "p_total": 14.6, "v_ln_avg": 230.4, "v_ln_min": 228.9, "v_ln_max": 231.7, "p_min": 14.1, "p_max": 15.3 } ] }
```

### `GET /meters/:id/summary?from=&to=`
```json
{ "samples": 2880, "kwh": 351.2, "kvarh": 120.4, "kwAvg": 14.6, "kwMax": 15.3, "kwMin": 4.1, "peakDemand": 15.4,
  "vAvg": 230.5, "vMin": 166.2, "vMax": 231.7, "iMax": 25.5, "pfAvg": 0.89, "pfMin": 0.86, "fMin": 49.96, "fMax": 50.04,
  "eventCount": 3, "events": [ { "type": "sag", "severity": "error", "count": 1, "durationSec": 12 } ] }
```

### `GET /meters/:id/hourly?from=&to=`
Hourly rollups: `{ rows: [ { hour_start, kwh, kvarh, kw_avg, kw_max, kw_min, v_avg, v_min, v_max, i_max, pf_avg, samples, kwh_end } ] }`

### `GET /events?from=&to=&plantId=&lineId=&meterId=&active=1&severity=&type=`
Alarm log. `severity`/`type` accept comma lists.

```json
{ "events": [ { "id": 55, "meterId": 3, "meterName": "L3-PM02", "meterCode": "L3-PM02", "plantId": 1, "plantName": "...", "lineId": 3, "lineName": "...",
  "gatewayId": null, "type": "sag", "severity": "error", "message": "Under-voltage 166.2 V (72%)", "value": 166.2,
  "startedAt": 1726900000000, "endedAt": 1726900012000, "durationSec": 12, "active": false,
  "ackedBy": "op1", "ackedAt": 1726900500000, "ackNote": "checked" } ] }
```

Types: `outage sag swell overload overcurrent low_pf freq unbalance thd offline gateway demand demand_exceeded demand_write tag:<key>` · severities: `warn error critical`

### `GET /events/active`
Open alarms only.

### `GET /gateways`
Gateways with live traffic: `connected, latencyMs, avgLatencyMs, uptimeSec, reconnects, rate { rxBps, txBps, reqPerSec, errPerSec }, totals { reqOk, reqErr, bytesRx, bytesTx }, ring (120 × [rx, tx, ok, err] per second), metersOnline / metersTotal, log[]`.

### `GET /demand`
Peak-demand groups with live state:

```json
{ "summary": { "groups": 1, "worst": "ok", "shedding": 0, "auto": 1 },
  "groups": [ { "id": 1, "name": "SPK main incoming", "plantId": 1, "auto": true, "status": "ok",
    "targetKw": 1300, "marginKw": 60, "thresholdKw": 1240, "releaseKw": 1140.8, "blockMin": 15,
    "kwNow": 718.2, "blockAvg": 716.4, "projected": 717.0, "blockStart": 1726900200000, "elapsedSec": 546, "remainingSec": 354,
    "peaks": { "today": 1210.5, "month": 1288.0, "monthAt": 1726830000000, "exceededToday": 0, "exceededMonth": 1 },
    "stages": [ { "id": 1, "name": "Chiller 2 setpoint +2C", "priority": 1, "shed": false, "mode": null, "dryRun": true, "kwEstimate": 90, "tag": null } ] } ] }
```

`status`: `ok` · `shedding` · `warn` (projected > target − margin) · `critical` (projected > target) · `exceeded` (block average already above target) · `nodata`

### `GET /demand/:id?from=&to=`
One group plus its completed blocks: `{ group, blocks: [ { block_start, avg_kw, max_kw, min_kw, target_kw, shed_stages, exceeded } ] }`

---

## Write

### `POST /events/:id/ack`  (scope `write`)
Body `{ "note": "optional" }`.

### `POST /demand/:id/auto`  (scope `write`)
Body `{ "auto": true|false }` — enable / disable automatic load shedding.

### `POST /demand/:id/stages/:stageId/shed` · `/restore`  (scope `write`)
Manual shed / restore of one stage. Writes the stage's shed / restore value to its Siemens S7 tag (`400` with the PLC error when the write fails; dry-run stages are only logged).

---

## Ingest (devices pushing their own readings)  (scope `ingest`)

### `POST /ingest`

Single reading with canonical keys:

```json
{ "meter": "L1-PM01", "at": 1726900000000,
  "values": { "va": 230.5, "vb": 229.8, "vc": 231.0, "ia": 12.3, "p_total": 8.2, "pf": 0.95, "freq": 50.01, "kwh_import": 123456.7 } }
```

Raw device payload mapped through the meter's template / `conn.jsonMap` (`{ metricKey: "dotted.path" }`):

```json
{ "meter": "PULSE-01", "data": { "kwh": 1200.5, "kw": 3.1, "sensor": { "temp": 41 } } }
```

Batch:

```json
{ "readings": [ { "meter": "PULSE-01", "values": { "kwh_import": 1200.5 } }, { "meter": 12, "values": { "p_total": 5.0 } } ] }
```

Response: `{ success, accepted, results: [ { ok, meter, keys } | { ok:false, error } ] }` — `200` when at least one reading was accepted, `400` otherwise.

Ingested values go through the same pipeline as polled ones: derived averages/unbalance, alarm rules, storage, websocket, MQTT mirror. The meter must exist (create it with template `generic-json` or `pulse-counter`, gateway type **push** or none) and be enabled.

---

## WebSocket

`ws://<server>:8095/ws?api_key=pc_...`

Send a subscription after connecting:

```json
{ "type": "sub", "scope": { "lineId": 3 } }
```

Scopes: `{ all: true }` (summary + events + gateways only), `{ plantId }`, `{ lineId }`, `{ meterIds: [1,2,3] }`, `{ gateways: true }` (traffic snapshot every second).

Messages:

| type | when | payload |
|---|---|---|
| `hello` | on connect | `{ at, site }` |
| `reading` | every poll of a meter in scope (+ snapshot right after `sub`) | `{ meterId, at, status, alarm, alarms[], latencyMs, values{} }` |
| `summary` | every 2 s | `{ meters{total,online,offline}, kwTotal, alarms{total,critical,error,warn,unacked}, gateways[], plants{} }` |
| `event` | alarm open / update / close / ack | `{ action, event }` (same shape as `/events`) |
| `gateway` / `gateways` | state change / every 1 s with `gateways` scope | gateway snapshot(s) |

---

## Export (session login, used by the dashboard)

`POST /api/export` body `{ plantId | lineId | meterIds[], from, to, interval, keys[], includeEvents, includeSummary }` → ZIP (or CSV for one meter without extras). `POST /api/export/preview` returns counts first.

---

## Examples

```bash
# latest values
curl -H "X-Api-Key: $KEY" http://server:8095/api/v1/meters/L1-PM01/latest

# 15-minute averages for yesterday
curl -H "X-Api-Key: $KEY" "http://server:8095/api/v1/meters/1/history?from=2026-09-20T00:00:00+07:00&to=2026-09-21T00:00:00+07:00&interval=900&keys=p_total,v_ln_avg,pf"

# push a reading
curl -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"meter":"PULSE-01","values":{"kwh_import":1200.5,"p_total":3.1}}' http://server:8095/api/v1/ingest
```

## Siemens S7 PLC (Snap7)

A gateway with protocol `siemens-s7` (port 102, rack/slot in its config) is used two ways:

- **as a meter source**: a meter with template `siemens-s7-tags` maps metrics to PLC tags `{ area: "DB"|"M"|"I"|"Q", db, start (byte), type: REAL|LREAL|INT|DINT|WORD|DWORD|BYTE|BOOL, bit }` — the PLC's own kW / kWh values show up like any other meter
- **as an actuator**: peak-demand stages write a tag on shed / restore (`shedValue` / `restoreValue`); the PLC program reacts (raise a chiller setpoint, unload a compressor, hold heaters ...)

Backends: `node-snap7` (native Snap7, preferred) with `nodes7` (pure JavaScript) fallback. On S7-1200/1500 enable **PUT/GET communication** and disable **optimized block access** on the DBs used.

Admin commissioning endpoints (session, admin role): `POST /api/admin/gateways/:id/s7/read { tags: [...] }`, `POST /api/admin/gateways/:id/s7/write { tag, value }`, `POST /api/admin/demand/stages/:id/test { value }`.

### PLC configuration (session, admin role)

The PLC page saves a connection and one variable set in a single transaction. Variables use Node-RED addresses (`DB1004,REAL20`, `DB1,X0.3`, `MW10`, `I0.0`, `QB2`); the server parses them with `src/s7addr.js` and stores S7 tags.

```
POST /api/admin/plc
{
  "gateway": { "id": 4, "name": "PLC-01", "plantId": 1, "host": "10.22.181.12", "port": 102, "rack": 0, "slot": 1, "timeoutMs": 3000, "lib": "auto", "enabled": true },
  "device":  { "id": 7, "name": "PLC-01 energy", "code": "PLC-01", "lineId": 1, "template": "siemens-s7-energy-db1004", "pollMs": 5000, "faceKey": "kw_day",
               "variables": [ { "addr": "DB1004,REAL32", "key": "kw_day", "label": "kW today", "group": "Energy by period", "unit": "kW", "decimals": 2, "row": "Today", "col": "kW", "hi": 900 } ] }
}
-> { "success": true, "gatewayId": 4, "deviceId": 7 }        (omit the ids to create; omit "variables" to keep the stored list)
DELETE /api/admin/plc/:gatewayId                             deletes the PLC and every variable set (with history)
POST   /api/admin/plc/parse { "addresses": ["DB1,REAL0", "MW10.1"] }   -> per address: parsed tag or an error text
```

See `sdk/` for JavaScript, Python and ESP32 clients.
