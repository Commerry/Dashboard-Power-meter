# Power Center

Central power-meter monitoring for every plant and every production line — reads meters of several brands through gateways (Schneider Link150 / EGX, serial servers, MQTT, HTTP, push) hundreds at a time, shows them as live digital meter faces, keeps history, detects sags / outages / overloads, exports history and exposes a public API.

Code layout and theme follow `OCR-Center` (Node + Express + SQLite + single-page frontend without a build step).

## Layout

```
Dashboard-Powermeter/
├── package.json
├── .env.example            # PORT / ADMIN_PASS / retention / MQTT publish / webhook
├── ecosystem.config.js     # pm2
├── install.sh              # install + pm2 + boot autostart (Linux)
├── docs/API.md             # public API reference
├── sdk/                    # client examples (JS, Python, ESP32/Arduino)
├── data/power.db           # SQLite (created automatically)
└── src/
    ├── server.js           # express bootstrap + websocket + engine
    ├── config.js           # reads .env
    ├── db.js               # schema + prepared statements + rollups + prune
    ├── auth.js             # users / sessions / roles / API keys (scrypt)
    ├── metrics.js          # canonical metric registry (va, ia, p_total, pf, kwh_import ...)
    ├── templates/          # register maps per model (Schneider PM2xxx/PM5xxx/PM8000/iEM3xxx, Eastron, Siemens, generic)
    ├── drivers/            # modbus (TCP / RTU-over-TCP / serial), s7 (Siemens Snap7, read+write), mqtt, http, simulator, push
    ├── demand.js           # peak-demand controller: 15-min block projection + PLC load shedding
    ├── poller.js           # acquisition engine: one worker per gateway, all gateways in parallel
    ├── alarms.js           # alarm rules: outage / sag / swell / overload / overcurrent / low pf / freq / unbalance / thd / offline
    ├── store.js            # samples every STORE_INTERVAL_SEC + hourly rollups + prune
    ├── realtime.js         # WebSocket /ws + MQTT publish + alarm webhook
    ├── report.js           # history queries + CSV/ZIP export
    ├── views.js            # DTO builders (meter / gateway / event / tree)
    ├── seed.js             # demo plants + simulator meters
    ├── tools/user.js       # add users / reset passwords from the CLI
    ├── routes/
    │   ├── api.js          # dashboard API (session)
    │   ├── admin.js        # configuration API (admin role)
    │   └── v1.js           # public API + ingest (API key)
    └── public/
        ├── index.html, login.html
        ├── css/app.css
        └── js/ app.js (router/ws/nav) · views.js (monitor pages) · settings.js (admin pages) · charts.js · ui.js
```

## Install + run

**Linux / Raspberry Pi / server (install + pm2 + autostart in one go):**

```bash
cd Dashboard-Powermeter
bash install.sh
```

**Manual (any OS incl. Windows):**

```bash
npm install
cp .env.example .env      # Windows: copy .env.example .env
npm start                 # http://localhost:64088
npm run dev               # same server with restart-on-change on port 64089 (DEV_PORT)
```

Ports: `PORT=64088` for production (`npm start` / pm2), `DEV_PORT=64089` for `npm run dev` — both can run side by side. Open the port in the firewall (`netsh advfirewall firewall add rule name="Power Center" dir=in action=allow protocol=TCP localport=64088` on Windows, `ufw allow 64088/tcp` on Linux).

Sign in with `ADMIN_USER` / `ADMIN_PASS` from `.env` (default `admin` / `admin` — **change it before production**).

On first start the database is seeded with the real Siemens PLCs listed in `SEED_PLC_IPS` (default `10.22.181.12,10.22.181.19,10.22.181.26`, each as an S7 gateway + a *DB1004 energy summary* device, rack 0 slot 1). Set `SEED_DEMO=1` to also get a simulated demo plant (off by default).

> Behind a factory proxy: configure npm first (`npm config set proxy http://10.201.0.54:8080` + `https-proxy` + `strict-ssl false`).
> `serialport` (direct RS-485 on this PC) and `mqtt` are optional — if their build fails the server still runs, the protocol just shows "module missing".

## Data model

```
plant / site
 ├── production line
 │    ├── section (part of a line, e.g. Extruder, Packing) — optional
 │    │    └── meter
 │    └── meter
 └── gateway (Link150 / EGX / serial server / MQTT broker / push)
       └── meter bound to gateway + unit ID (Modbus slave) or topic / URL
```

- Sidebar: pick a plant → its lines appear → click a line → meter faces of every meter in that line (filter by section)
- Click a meter → every value (voltage L-N / L-L, current, P/Q/S per phase, PF, frequency, energy, demand, THD, unbalance) + history chart with selectable range (shaded bands where sags / outages happened) + filterable alarm log + export
- **Gateways**: monitored separately from meters — online/down, latency, requests/s, errors/s, bytes rx/tx (120 s graph), uptime, reconnects, 24 h statistics, attached meters, connection log
- **Alarms**: one table across all plants, filter by severity / type / state, acknowledge (operator and up), CSV download
- **Export**: plant / line / meters + time range + resolution (raw / 1m / 5m / 15m / 1h / day) + value groups → ZIP (one CSV per meter + summary.csv + events.csv)
- **Peak demand**: projected 15-minute demand per plant, automatic load shedding through Siemens S7 PLC tags (see below)

Live values are patched in place — only the digits change, nothing re-renders or blinks. Light / dark theme switch in the sidebar footer (remembered per browser, follows the OS setting by default).

## Roles

| role | can |
|---|---|
| `viewer` | view every page, export |
| `operator` | viewer + acknowledge alarms with a note |
| `admin` | everything: plants / lines / sections, gateways, meters, users, API keys, system |

viewer / operator never see the "Settings" and "API" menus or the configure buttons on meter pages — the server checks the role on every route as well (`403`).

Add a user from the CLI when nobody can sign in: `npm run user:add -- admin2 password admin` · reset a password: `npm run user:passwd -- admin newpassword`

## Connecting meters

**1. Add a gateway** (Settings › Gateways) and pick the protocol:

| protocol | for | settings |
|---|---|---|
| `modbus-tcp` | Schneider Link150, EGX100/300, meters with Ethernet (PM5560, PM8000) | host, port 502, timeout, inter-request delay |
| `modbus-rtu-tcp` | serial servers / RS-485-to-Ethernet passing raw RTU frames | host, port |
| `modbus-rtu` | RS-485 wired to this PC (USB adapter) | COM port, baud, parity |
| `mqtt` | devices publishing JSON to a broker | host, port 1883, user/pass, TLS |
| `http` | devices with a REST endpoint | base host, headers |
| `push` | devices posting on their own (ESP32 pulse counter, PLC, script) | — uses `/api/v1/ingest` |
| `simulator` | testing / commissioning the screens before hardware | latency, fail rate, event rate |

**Test connection** works before saving. Siemens PLCs are **not** gateways: they have their own page (see *Siemens PLCs* below).

**2. Add meters** (Settings › Meters & devices) — name, code, plant / line / section, gateway + unit ID, brand/model template, poll interval, nominal V/Hz, CT, rated kW / A (used for % and alarms), per-meter alarm thresholds.
**Test read** shows real values from the device before saving · **Bulk add** creates a whole line with consecutive unit IDs.

**Templates included:**

| template | brand / model |
|---|---|
| `schneider-pm5xxx` | PM5100 / PM5300 / PM5500 (default) |
| `schneider-pm2xxx` | PM2100 / PM2200 |
| `schneider-pm8000` | PM8000 |
| `schneider-iem3x55` | iEM3155 / 3255 / 3355 |
| `schneider-iem3x50` | iEM3150 / 3250 / 3350 |
| `schneider-em6400` | EM6400 / EM6400NG |
| `eastron-sdm630` | Eastron SDM630 |
| `siemens-pac3200` | SENTRON PAC3200 / 3220 / 4200 |
| `siemens-s7-tags` | Siemens S7 PLC data block (kW / kWh already computed in the PLC) |
| `generic-modbus` | define every register yourself |
| `generic-json` | MQTT / HTTP / push — map JSON fields to values |
| `pulse-counter` | kWh pulse counter (ESP32 / Arduino) |

**Tags / values tab (every device)** — the template is only a starting list. Each row is one value read from the device:

| column | meaning |
|---|---|
| Name | display name on the dashboard (e.g. *Chilled water supply*) |
| Key | a canonical metric (`va`, `ia`, `p_total`, `kwh_import` …) so the value feeds the standard faces, alarms and demand control — **or any key of your own** (`tank_temp`, `oil_press` …) |
| Group | card on the device page: a standard group or any name (*Chiller*, *Hydraulics*) |
| Modbus | register address (as in the manual, base 0/1), data type float32 / int16 / uint16 / int32 / uint32 / int64 / uint64 / float64, transform |
| JSON (MQTT / HTTP / push) | dotted path inside the payload (`data.temps.supply`) |
| Scale · Unit · Dec | multiplier, display unit and decimals |
| High / Low alarm | warn and error thresholds on that tag (`tag:<key>` alarms) |

Custom tags get their own group card, chart button, export column and alarm; **Face value** picks which value the meter face shows for that device. **Test read** shows the decoded values by name before saving. Models not listed use `generic-modbus` / `generic-json` as the blank starting point.

Schneider addresses follow the documentation (1-based, block 3000: I / V / P / Q / S / PF / Hz, 3204 energy Int64, 21300 THD); the driver subtracts 1 on the wire.

## Alarm rules (automatic, adjustable per meter)

| type | condition (defaults) | severity |
|---|---|---|
| `outage` | any phase below 50 % of nominal | critical |
| `sag` | below -10 % / -20 % | warn / error |
| `swell` | above +10 % / +15 % | warn / error |
| `overload` | kW above 100 % / 120 % of rating | warn / error |
| `overcurrent` | A above 100 % / 120 % of rating (or CT) | warn / error |
| `low_pf` | PF < 0.85 (while loaded) | warn |
| `freq` | deviation > 1 Hz / 2.5 Hz | warn / error |
| `unbalance` | voltage unbalance > 2 % or current > 15 % | warn |
| `thd` | THD V > 5 % or THD I > 25 % | warn |
| `offline` | no reading for `OFFLINE_AFTER_SEC` | error |
| `gateway` | gateway unreachable | error |

Every event carries start / end, the value at the time and who acknowledged it · an alarm edge forces a stored sample so charts show the exact moment even with a long STORE_INTERVAL · set `ALARM_WEBHOOK_URL` to POST alarms to LINE Notify / Teams / n8n.

## Siemens PLCs (Settings › PLC)

PLCs are configured on their own page, the way the Node-RED S7 node does it — one **connection** plus a list of **variables**:

| section | fields |
|---|---|
| Connection | name, plant, address (IP), port 102, rack, slot, cycle time (ms), timeout (ms), library (`node-snap7` native / `nodes7` pure JS), enabled |
| Device on the dashboard | device name, code (API / ingest), production line / section, face value, layout preset, read on/off |
| Variables | **Address** in Node-RED syntax, name, key, group, matrix row / column, scale, unit, decimals, high / low alarm (warn + error) |

Address syntax (parsed by `src/s7addr.js`, shared with the browser):

| address | meaning |
|---|---|
| `DB1004,REAL20` | REAL at byte 20 of DB1004 (`INT`, `DINT`, `WORD`, `DWORD`, `BYTE`, `LREAL` likewise) |
| `DB1,X0.3` | BOOL bit 3 of byte 0 in DB1 |
| `MR10` `MW10` `MD10` `MB10` `M0.0` | memory (flags): REAL / WORD / DWORD / BYTE / bit |
| `I0.0` `IB0` `IW0` `ID0` (`E…`) | inputs · `Q0.2` `QB2` `QW2` `QD2` (`A…`) outputs |

Arrays and strings are not supported (one value per variable). The editor validates every address as you type, suggests the next address when you add a row, derives a key from the name, **imports** a Node-RED variable list (JSON export or `address name` lines), **copies** the list back out as Node-RED JSON, **tests the connection** (CPU diagnostics) and **reads all variables** before saving. A PLC can expose several variable sets (e.g. one per line) — each is a device on the dashboard. Saving writes the connection and its variables in one transaction (`POST /api/admin/plc`).

Requirements on the CPU: PUT/GET communication enabled, *optimized block access* off on every DB used. S7-1200/1500: rack 0 slot 1 · S7-300/400: rack 0 slot 2.

### DB1004 energy summary layout and PLC monitoring

Values computed inside the PLC are read straight from its data block and shown in a PLC-specific layout — no meter math:

| DB1004 offset | tag | shown as |
|---|---|---|
| 0.0 REAL | `wh_l` Wh_L | PLC totals card |
| 16.0 REAL | `kwh_total` kWh | PLC totals card |
| 20.0 … 44.0 REAL | `kw_shift_a/b/c`, `kw_day`, `kw_yesterday`, `kw_week`, `kw_last_week` | **Energy by period** matrix, column kW |
| 76.0 … 100.0 REAL | `kwhrt_shift_a/b/c`, `kwhrt_day`, `kwhrt_yesterday`, `kwhrt_week`, `kwhrt_last_week` | **Energy by period** matrix, column kWh-RT |

Device page for a PLC: headline cards (kW today, kWh-RT today, kWh, Wh_L), PLC diagnostics strip, per-period matrix (Shift A/B/C, Today, Yesterday, This week, Last week × kW / kWh-RT), charts per group and unit. Addresses, names, groups and matrix row/column are all editable in the PLC's variable list (preset `siemens-s7-energy-db1004` is only the starting point; **Load preset list** restores it).

**What the gateway monitor reads from a Siemens CPU** (Snap7 system functions, refreshed every minute): RUN / STOP state (alarm `plc_stop` on STOP), module type, order code + firmware version, serial number, station / module name, PLC clock and drift against the server (alarm `plc_clock` above 2 min), negotiated PDU size, protection level / mode, block counts (OB/FB/FC/DB), plus the normal gateway figures (latency, requests/s, errors, bytes, uptime, reconnects, connection log). S7-1200/1500 CPUs answer RUN/STOP and order code; some of the other functions are refused by newer firmware and simply show "-". Requirements on the CPU: PUT/GET communication enabled, DB1004 with *optimized block access* off.

## Peak-demand control (Siemens S7)

Utilities bill the peak **15-minute block average**. A **demand group** sums the incoming meters of a plant, tracks the running block average and projects the block end:

```
projected = (energy so far + kW now × remaining time) / block length
```

When the projection crosses **target − margin** the controller sheds loads **stage by stage** (priority order, one action per *gap* seconds) by writing a tag in a Siemens S7 PLC — a BOOL bit, an INT or a REAL setpoint — and restores them last-in-first-out once the projection falls below the **release level**. Each stage has a minimum off time (no chattering) and a maximum off time (equipment protection). Stages without a PLC tag run as **dry run** (logged only) so the logic can be proven on the dashboard before wiring the PLC.

Setup: Settings › PLC → add the PLC (IP, rack, slot) · Settings › Peak demand → add a group (meters, target kW, margin, block length, release %, action gap) → add stages (name, priority, PLC, tag address such as `DB1,X0.0` or `DB10,INT4`, shed → restore value, estimated kW, min / max off) · the ▶ button writes the shed value once to check the PLC reacts · turn on **Auto**. The maximum off time is enforced for automatic and manual sheds alike, even while the incoming meters are silent.

Monitor page: projected demand LCD, block average / load now / peak today / peak this month, threshold + target scale, block progress, stage states with manual **Shed / Restore** (operator), completed-block chart against the target, action log. Alarms: `demand` (warn, projected above threshold), `demand_exceeded` (critical, block average above target), `demand_write` (error, PLC write failed). Everything is also available at `/api/v1/demand`.

Backends: `node-snap7` (native Snap7, prebuilt for Windows / Linux x64 / ARM) with `nodes7` (pure JavaScript) as fallback — selectable per PLC. On S7-1200/1500 enable **PUT/GET** and disable **optimized block access** on the DBs you use.

## Stored data

| table | content | retention (.env) |
|---|---|---|
| `samples` | every metric per meter every `STORE_INTERVAL_SEC` (default 30 s) + on alarm edges | `SAMPLES_KEEP_DAYS=90` |
| `hourly` | kWh, kW avg/max/min, V avg/min/max, I max, PF per hour | `HOURLY_KEEP_DAYS=730` |
| `events` | alarm log | `EVENTS_KEEP_DAYS=365` |
| `gateway_stats` | latency / requests / bytes per minute | `GATEWAY_STATS_KEEP_DAYS=30` |
| `demand_blocks` / `demand_log` | completed demand blocks / every shed, restore and mode change | `HOURLY_KEEP_DAYS` / `EVENTS_KEEP_DAYS` |
| `audit_log` | who changed what, when | `AUDIT_KEEP_DAYS=365` |

Sizing: 500 meters × 30 s ≈ 1.4 M rows/day ≈ 250 MB/day, ≈ 22 GB at 90 days — `STORE_INTERVAL_SEC=60` halves it (the live values on screen are not affected).

## Realtime

The dashboard receives values over WebSocket `/ws` and subscribes only to what is on screen (a line / a meter / the gateways), so hundreds of lines never mean broadcasting everything to everyone · every gateway has its own worker running in parallel; inside one gateway requests are queued (an RS-485 bus answers one meter at a time) · poll interval is per meter.

Live values never rebuild the DOM: only the text of the changed number is patched, and it **rolls** from the old value to the new one (~0.45 s, `setNum` / `setValNum` in `ui.js`) so updates look smooth instead of jumping; gauge arcs and progress bars glide the same way. Users who prefer reduced motion, hidden tabs and first paints get the value at once. The layout adapts from phones (390 px: stacked cards, full-screen dialogs, scrollable tables, sidebar as a drawer) to wide screens; the sign-in page shows only the logo and the form on small screens and never shows any readings.

## Public API / exporting values

- REST `/api/v1/*` with `X-Api-Key` (created under Settings › API keys, scopes `read` / `write` / `ingest` / `all`)
- WebSocket `/ws?api_key=` for realtime values
- `POST /api/v1/ingest` for devices pushing their own readings
- `MQTT_PUBLISH_URL` mirrors every reading to a broker (`powercenter/<plant>/<line>/<meter code>`)
- CSV/ZIP export from the dashboard or `POST /api/export`

Full reference: [docs/API.md](docs/API.md) · client examples: [sdk/](sdk/)

## Site name / security

```
SITE_NAME=PSE POWER CENTER
SITE_SUBTITLE=Energy Monitoring
ADMIN_USER=admin
ADMIN_PASS=change-me
```

- passwords stored with scrypt, sessions in SQLite (survive restarts), API keys stored as SHA-256; failed logins are rate-limited
- put it behind a reverse proxy (nginx / Caddy) with HTTPS when reachable from outside the plant
- after editing `.env` run `pm2 restart power-center`
