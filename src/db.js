const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { STORED_KEYS } = require('./metrics');

/*
 * SQLite schema + prepared statements.
 *
 * Hierarchy:   plants -> lines -> sections -> meters
 *              plants -> gateways  (a meter binds to one gateway + unit id)
 *
 * Time series: samples (one row per meter per STORE_INTERVAL, wide columns per
 *              metric so charts/exports are a plain SELECT), hourly rollups
 *              (energy deltas + min/max/avg, kept for years), events (alarm
 *              start/end), gateway_stats (traffic / latency per minute).
 *
 * Time columns in the time-series tables are unix milliseconds (INTEGER) for
 * fast range scans; record metadata uses ISO strings like the OCR Center.
 */
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'power.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

const sampleCols = STORED_KEYS.map((k) => `"${k}" REAL`).join(',\n  ');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
  display_name  TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS plants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  code       TEXT,
  province   TEXT,
  address    TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  code       TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (plant_id, name)
);

CREATE TABLE IF NOT EXISTS sections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  line_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  UNIQUE (line_id, name)
);

CREATE TABLE IF NOT EXISTS gateways (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id    INTEGER,
  name        TEXT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'modbus-tcp',
  host        TEXT,
  port        INTEGER,
  config_json TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meters (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id          INTEGER,
  line_id           INTEGER,
  section_id        INTEGER,
  gateway_id        INTEGER,
  name              TEXT NOT NULL,
  code              TEXT UNIQUE,
  template          TEXT NOT NULL DEFAULT 'schneider-pm5xxx',
  unit_id           INTEGER DEFAULT 1,
  conn_json         TEXT,
  register_map_json TEXT,
  poll_ms           INTEGER,
  nominal_v         REAL DEFAULT 230,
  nominal_hz        REAL DEFAULT 50,
  ct_primary        REAL,
  rated_kw          REAL,
  rated_a           REAL,
  phases            INTEGER DEFAULT 3,
  alarm_json        TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER DEFAULT 0,
  notes             TEXT,
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS samples (
  meter_id INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  ${sampleCols},
  extra_json TEXT,
  PRIMARY KEY (meter_id, at)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hourly (
  meter_id    INTEGER NOT NULL,
  hour_start  INTEGER NOT NULL,
  kwh         REAL,
  kvarh       REAL,
  kw_avg      REAL,
  kw_max      REAL,
  kw_min      REAL,
  v_avg       REAL,
  v_min       REAL,
  v_max       REAL,
  i_max       REAL,
  pf_avg      REAL,
  samples     INTEGER,
  kwh_end     REAL,
  PRIMARY KEY (meter_id, hour_start)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  meter_id   INTEGER,
  gateway_id INTEGER,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL,
  message    TEXT,
  value      REAL,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  acked_by   TEXT,
  acked_at   INTEGER,
  ack_note   TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_meter_start ON events (meter_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_open ON events (ended_at) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_start ON events (started_at DESC);

CREATE TABLE IF NOT EXISTS gateway_stats (
  gateway_id    INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  latency_ms    REAL,
  req_ok        INTEGER,
  req_err       INTEGER,
  bytes_rx      INTEGER,
  bytes_tx      INTEGER,
  meters_online INTEGER,
  meters_total  INTEGER,
  PRIMARY KEY (gateway_id, at)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'read',
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ---- peak demand management ----
CREATE TABLE IF NOT EXISTS demand_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id      INTEGER,
  name          TEXT NOT NULL,
  target_kw     REAL NOT NULL DEFAULT 1000,
  margin_kw     REAL NOT NULL DEFAULT 50,
  block_min     INTEGER NOT NULL DEFAULT 15,
  release_pct   REAL NOT NULL DEFAULT 0.9,
  action_gap_sec INTEGER NOT NULL DEFAULT 30,
  meter_ids     TEXT,
  auto          INTEGER NOT NULL DEFAULT 0,
  enabled       INTEGER NOT NULL DEFAULT 1,
  notes         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS demand_stages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id      INTEGER NOT NULL,
  name          TEXT NOT NULL,
  priority      INTEGER NOT NULL DEFAULT 1,
  gateway_id    INTEGER,
  tag_json      TEXT,
  shed_value    REAL NOT NULL DEFAULT 1,
  restore_value REAL NOT NULL DEFAULT 0,
  kw_estimate   REAL,
  min_off_sec   INTEGER NOT NULL DEFAULT 120,
  max_off_sec   INTEGER NOT NULL DEFAULT 900,
  enabled       INTEGER NOT NULL DEFAULT 1,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS demand_blocks (
  group_id     INTEGER NOT NULL,
  block_start  INTEGER NOT NULL,
  avg_kw       REAL,
  max_kw       REAL,
  min_kw       REAL,
  target_kw    REAL,
  shed_stages  INTEGER,
  exceeded     INTEGER,
  samples      INTEGER,
  PRIMARY KEY (group_id, block_start)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS demand_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  at         INTEGER NOT NULL,
  action     TEXT NOT NULL,
  stage_id   INTEGER,
  stage_name TEXT,
  kw_now     REAL,
  projected  REAL,
  detail     TEXT,
  user       TEXT
);
CREATE INDEX IF NOT EXISTS idx_demand_log_group ON demand_log (group_id, at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id  INTEGER,
  username TEXT,
  action   TEXT NOT NULL,
  target   TEXT,
  detail   TEXT,
  at       TEXT NOT NULL
);
`);

// migration: events.group_id (peak-demand alarms belong to a demand group, not a meter)
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'group_id')) {
  db.exec('ALTER TABLE events ADD COLUMN group_id INTEGER');
}

// migration: new stored metrics get their own column in samples
const sampleColsNow = new Set(db.prepare('PRAGMA table_info(samples)').all().map((c) => c.name));
for (const k of STORED_KEYS) {
  if (!sampleColsNow.has(k)) db.exec(`ALTER TABLE samples ADD COLUMN "${k}" REAL`);
}

const now = () => new Date().toISOString();

const statements = {
  // users / sessions
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUser: db.prepare('SELECT id, username, role, display_name, enabled, created_at, last_login FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT id, username, role, display_name, enabled, created_at, last_login FROM users ORDER BY username'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  createUser: db.prepare('INSERT INTO users (username, password_hash, salt, role, display_name, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)'),
  updateUser: db.prepare('UPDATE users SET role = ?, display_name = ?, enabled = ? WHERE id = ?'),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'),
  touchLogin: db.prepare('UPDATE users SET last_login = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  createSession: db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)'),
  getSession: db.prepare('SELECT s.id, s.user_id, s.expires_at, u.username, u.role, u.display_name, u.enabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  // plants / lines / sections
  listPlants: db.prepare('SELECT * FROM plants ORDER BY sort_order, name'),
  getPlant: db.prepare('SELECT * FROM plants WHERE id = ?'),
  createPlant: db.prepare('INSERT INTO plants (name, code, province, address, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  updatePlant: db.prepare('UPDATE plants SET name = ?, code = ?, province = ?, address = ? WHERE id = ?'),
  deletePlant: db.prepare('DELETE FROM plants WHERE id = ?'),
  setPlantOrder: db.prepare('UPDATE plants SET sort_order = ? WHERE id = ?'),

  listLines: db.prepare('SELECT * FROM lines ORDER BY plant_id, sort_order, name'),
  linesOfPlant: db.prepare('SELECT * FROM lines WHERE plant_id = ? ORDER BY sort_order, name'),
  getLine: db.prepare('SELECT * FROM lines WHERE id = ?'),
  createLine: db.prepare('INSERT INTO lines (plant_id, name, code, sort_order, created_at) VALUES (?, ?, ?, ?, ?)'),
  updateLine: db.prepare('UPDATE lines SET name = ?, code = ?, plant_id = ? WHERE id = ?'),
  deleteLine: db.prepare('DELETE FROM lines WHERE id = ?'),
  setLineOrder: db.prepare('UPDATE lines SET sort_order = ? WHERE id = ?'),
  detachLineMeters: db.prepare('UPDATE meters SET line_id = NULL, section_id = NULL WHERE line_id = ?'),
  detachPlantLines: db.prepare('UPDATE lines SET plant_id = NULL WHERE plant_id = ?'),
  detachPlantMeters: db.prepare('UPDATE meters SET plant_id = NULL, line_id = NULL, section_id = NULL WHERE plant_id = ?'),
  detachPlantGateways: db.prepare('UPDATE gateways SET plant_id = NULL WHERE plant_id = ?'),

  listSections: db.prepare('SELECT * FROM sections ORDER BY line_id, sort_order, name'),
  sectionsOfLine: db.prepare('SELECT * FROM sections WHERE line_id = ? ORDER BY sort_order, name'),
  createSection: db.prepare('INSERT INTO sections (line_id, name, sort_order) VALUES (?, ?, ?)'),
  updateSection: db.prepare('UPDATE sections SET name = ? WHERE id = ?'),
  deleteSection: db.prepare('DELETE FROM sections WHERE id = ?'),
  deleteSectionsOfLine: db.prepare('DELETE FROM sections WHERE line_id = ?'),
  detachSectionMeters: db.prepare('UPDATE meters SET section_id = NULL WHERE section_id = ?'),

  // gateways
  listGateways: db.prepare('SELECT * FROM gateways ORDER BY plant_id, name'),
  getGateway: db.prepare('SELECT * FROM gateways WHERE id = ?'),
  createGateway: db.prepare('INSERT INTO gateways (plant_id, name, protocol, host, port, config_json, enabled, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  updateGateway: db.prepare('UPDATE gateways SET plant_id = ?, name = ?, protocol = ?, host = ?, port = ?, config_json = ?, enabled = ?, notes = ? WHERE id = ?'),
  deleteGateway: db.prepare('DELETE FROM gateways WHERE id = ?'),
  detachGatewayMeters: db.prepare('UPDATE meters SET gateway_id = NULL WHERE gateway_id = ?'),
  deleteGatewayEvents: db.prepare('DELETE FROM events WHERE gateway_id = ? AND meter_id IS NULL'),
  deleteGatewayStats: db.prepare('DELETE FROM gateway_stats WHERE gateway_id = ?'),

  // meters
  listMeters: db.prepare('SELECT * FROM meters ORDER BY plant_id, line_id, section_id, sort_order, name'),
  metersOfLine: db.prepare('SELECT * FROM meters WHERE line_id = ? ORDER BY section_id, sort_order, name'),
  metersOfGateway: db.prepare('SELECT * FROM meters WHERE gateway_id = ? AND enabled = 1 ORDER BY unit_id, name'),
  getMeter: db.prepare('SELECT * FROM meters WHERE id = ?'),
  getMeterByCode: db.prepare('SELECT * FROM meters WHERE code = ?'),
  createMeter: db.prepare(`INSERT INTO meters (plant_id, line_id, section_id, gateway_id, name, code, template, unit_id, conn_json,
    register_map_json, poll_ms, nominal_v, nominal_hz, ct_primary, rated_kw, rated_a, phases, alarm_json, enabled, sort_order, notes, created_at)
    VALUES (@plant_id, @line_id, @section_id, @gateway_id, @name, @code, @template, @unit_id, @conn_json,
    @register_map_json, @poll_ms, @nominal_v, @nominal_hz, @ct_primary, @rated_kw, @rated_a, @phases, @alarm_json, @enabled, @sort_order, @notes, @created_at)`),
  updateMeter: db.prepare(`UPDATE meters SET plant_id = @plant_id, line_id = @line_id, section_id = @section_id, gateway_id = @gateway_id,
    name = @name, code = @code, template = @template, unit_id = @unit_id, conn_json = @conn_json, register_map_json = @register_map_json,
    poll_ms = @poll_ms, nominal_v = @nominal_v, nominal_hz = @nominal_hz, ct_primary = @ct_primary, rated_kw = @rated_kw, rated_a = @rated_a,
    phases = @phases, alarm_json = @alarm_json, enabled = @enabled, sort_order = @sort_order, notes = @notes WHERE id = @id`),
  deleteMeter: db.prepare('DELETE FROM meters WHERE id = ?'),
  setMeterOrder: db.prepare('UPDATE meters SET sort_order = ? WHERE id = ?'),
  deleteMeterSamples: db.prepare('DELETE FROM samples WHERE meter_id = ?'),
  deleteMeterHourly: db.prepare('DELETE FROM hourly WHERE meter_id = ?'),
  deleteMeterEvents: db.prepare('DELETE FROM events WHERE meter_id = ?'),

  // samples
  insertSample: db.prepare(`INSERT OR REPLACE INTO samples (meter_id, at, ${STORED_KEYS.map((k) => `"${k}"`).join(', ')}, extra_json)
    VALUES (@meter_id, @at, ${STORED_KEYS.map((k) => '@' + k).join(', ')}, @extra_json)`),
  lastSample: db.prepare('SELECT * FROM samples WHERE meter_id = ? ORDER BY at DESC LIMIT 1'),
  firstSampleAfter: db.prepare('SELECT * FROM samples WHERE meter_id = ? AND at >= ? ORDER BY at ASC LIMIT 1'),
  lastSampleBefore: db.prepare('SELECT * FROM samples WHERE meter_id = ? AND at <= ? ORDER BY at DESC LIMIT 1'),
  countSamples: db.prepare('SELECT COUNT(*) AS n FROM samples'),
  pruneSamples: db.prepare('DELETE FROM samples WHERE at < ?'),

  // hourly rollups
  upsertHourly: db.prepare(`INSERT OR REPLACE INTO hourly (meter_id, hour_start, kwh, kvarh, kw_avg, kw_max, kw_min, v_avg, v_min, v_max, i_max, pf_avg, samples, kwh_end)
    VALUES (@meter_id, @hour_start, @kwh, @kvarh, @kw_avg, @kw_max, @kw_min, @v_avg, @v_min, @v_max, @i_max, @pf_avg, @samples, @kwh_end)`),
  hourlyRange: db.prepare('SELECT * FROM hourly WHERE meter_id = ? AND hour_start >= ? AND hour_start < ? ORDER BY hour_start'),
  pruneHourly: db.prepare('DELETE FROM hourly WHERE hour_start < ?'),

  // events
  openEvent: db.prepare('SELECT * FROM events WHERE meter_id IS ? AND gateway_id IS ? AND type = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
  insertEvent: db.prepare('INSERT INTO events (meter_id, gateway_id, type, severity, message, value, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  updateEventValue: db.prepare('UPDATE events SET value = ?, message = ?, severity = ? WHERE id = ?'),
  closeEvent: db.prepare('UPDATE events SET ended_at = ? WHERE id = ?'),
  closeAllOpenEvents: db.prepare('UPDATE events SET ended_at = ? WHERE ended_at IS NULL AND type != ?'),
  ackEvent: db.prepare('UPDATE events SET acked_by = ?, acked_at = ?, ack_note = ? WHERE id = ?'),
  getEvent: db.prepare('SELECT * FROM events WHERE id = ?'),
  activeEvents: db.prepare('SELECT * FROM events WHERE ended_at IS NULL ORDER BY started_at DESC'),
  pruneEvents: db.prepare('DELETE FROM events WHERE started_at < ? AND ended_at IS NOT NULL'),

  // gateway stats
  insertGatewayStat: db.prepare(`INSERT OR REPLACE INTO gateway_stats (gateway_id, at, latency_ms, req_ok, req_err, bytes_rx, bytes_tx, meters_online, meters_total)
    VALUES (@gateway_id, @at, @latency_ms, @req_ok, @req_err, @bytes_rx, @bytes_tx, @meters_online, @meters_total)`),
  gatewayStats: db.prepare('SELECT * FROM gateway_stats WHERE gateway_id = ? AND at >= ? ORDER BY at'),
  pruneGatewayStats: db.prepare('DELETE FROM gateway_stats WHERE at < ?'),

  // api keys
  listApiKeys: db.prepare('SELECT id, name, prefix, scopes, created_by, created_at, last_used_at, enabled FROM api_keys ORDER BY created_at DESC'),
  getApiKeyByHash: db.prepare('SELECT * FROM api_keys WHERE key_hash = ?'),
  createApiKey: db.prepare('INSERT INTO api_keys (name, key_hash, prefix, scopes, created_by, created_at, enabled) VALUES (?, ?, ?, ?, ?, ?, 1)'),
  updateApiKey: db.prepare('UPDATE api_keys SET name = ?, scopes = ?, enabled = ? WHERE id = ?'),
  touchApiKey: db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?'),
  deleteApiKey: db.prepare('DELETE FROM api_keys WHERE id = ?'),

  // peak demand
  listDemandGroups: db.prepare('SELECT * FROM demand_groups ORDER BY plant_id, name'),
  getDemandGroup: db.prepare('SELECT * FROM demand_groups WHERE id = ?'),
  createDemandGroup: db.prepare(`INSERT INTO demand_groups (plant_id, name, target_kw, margin_kw, block_min, release_pct, action_gap_sec, meter_ids, auto, enabled, notes, created_at)
    VALUES (@plant_id, @name, @target_kw, @margin_kw, @block_min, @release_pct, @action_gap_sec, @meter_ids, @auto, @enabled, @notes, @created_at)`),
  updateDemandGroup: db.prepare(`UPDATE demand_groups SET plant_id = @plant_id, name = @name, target_kw = @target_kw, margin_kw = @margin_kw, block_min = @block_min,
    release_pct = @release_pct, action_gap_sec = @action_gap_sec, meter_ids = @meter_ids, auto = @auto, enabled = @enabled, notes = @notes WHERE id = @id`),
  setDemandAuto: db.prepare('UPDATE demand_groups SET auto = ? WHERE id = ?'),
  deleteDemandGroup: db.prepare('DELETE FROM demand_groups WHERE id = ?'),
  listDemandStages: db.prepare('SELECT * FROM demand_stages ORDER BY group_id, priority, id'),
  stagesOfGroup: db.prepare('SELECT * FROM demand_stages WHERE group_id = ? ORDER BY priority, id'),
  getDemandStage: db.prepare('SELECT * FROM demand_stages WHERE id = ?'),
  createDemandStage: db.prepare(`INSERT INTO demand_stages (group_id, name, priority, gateway_id, tag_json, shed_value, restore_value, kw_estimate, min_off_sec, max_off_sec, enabled, notes)
    VALUES (@group_id, @name, @priority, @gateway_id, @tag_json, @shed_value, @restore_value, @kw_estimate, @min_off_sec, @max_off_sec, @enabled, @notes)`),
  updateDemandStage: db.prepare(`UPDATE demand_stages SET group_id = @group_id, name = @name, priority = @priority, gateway_id = @gateway_id, tag_json = @tag_json,
    shed_value = @shed_value, restore_value = @restore_value, kw_estimate = @kw_estimate, min_off_sec = @min_off_sec, max_off_sec = @max_off_sec, enabled = @enabled, notes = @notes WHERE id = @id`),
  deleteDemandStage: db.prepare('DELETE FROM demand_stages WHERE id = ?'),
  deleteStagesOfGroup: db.prepare('DELETE FROM demand_stages WHERE group_id = ?'),
  upsertDemandBlock: db.prepare(`INSERT OR REPLACE INTO demand_blocks (group_id, block_start, avg_kw, max_kw, min_kw, target_kw, shed_stages, exceeded, samples)
    VALUES (@group_id, @block_start, @avg_kw, @max_kw, @min_kw, @target_kw, @shed_stages, @exceeded, @samples)`),
  demandBlocks: db.prepare('SELECT * FROM demand_blocks WHERE group_id = ? AND block_start >= ? AND block_start < ? ORDER BY block_start'),
  demandPeak: db.prepare('SELECT MAX(avg_kw) AS peak, COUNT(*) AS n, SUM(exceeded) AS exceeded FROM demand_blocks WHERE group_id = ? AND block_start >= ? AND block_start < ?'),
  demandPeakBlock: db.prepare('SELECT block_start, avg_kw FROM demand_blocks WHERE group_id = ? AND block_start >= ? AND block_start < ? ORDER BY avg_kw DESC LIMIT 1'),
  insertDemandLog: db.prepare('INSERT INTO demand_log (group_id, at, action, stage_id, stage_name, kw_now, projected, detail, user) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  demandLog: db.prepare('SELECT * FROM demand_log WHERE group_id = ? ORDER BY at DESC LIMIT ?'),
  deleteDemandBlocks: db.prepare('DELETE FROM demand_blocks WHERE group_id = ?'),
  deleteDemandLog: db.prepare('DELETE FROM demand_log WHERE group_id = ?'),
  pruneDemandBlocks: db.prepare('DELETE FROM demand_blocks WHERE block_start < ?'),
  pruneDemandLog: db.prepare('DELETE FROM demand_log WHERE at < ?'),
  openGroupEvent: db.prepare('SELECT * FROM events WHERE group_id = ? AND type = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
  insertGroupEvent: db.prepare('INSERT INTO events (group_id, type, severity, message, value, started_at) VALUES (?, ?, ?, ?, ?, ?)'),

  // settings
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
  allSettings: db.prepare('SELECT key, value FROM settings'),

  // audit
  insertAudit: db.prepare('INSERT INTO audit_log (user_id, username, action, target, detail, at) VALUES (?, ?, ?, ?, ?, ?)'),
  listAudit: db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'),
  pruneAudit: db.prepare('DELETE FROM audit_log WHERE at < ?'),
};

const getSetting = (key, def = null) => {
  const row = statements.getSetting.get(key);
  return row ? row.value : def;
};
const setSetting = (key, value) => statements.setSetting.run(key, value === null || value === undefined ? null : String(value));

const audit = (user, action, target, detail) => {
  statements.insertAudit.run(user ? user.id : null, user ? user.username : 'system', action, target || null,
    detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null, now());
};

const parseJson = (s, def) => {
  if (!s) return def;
  try { return JSON.parse(s); } catch (e) { return def; }
};

// ---- cascading deletes (kept in JS so the intent is readable) ----
const deleteMeter = db.transaction((id) => {
  statements.deleteMeterSamples.run(id);
  statements.deleteMeterHourly.run(id);
  statements.deleteMeterEvents.run(id);
  statements.deleteMeter.run(id);
});

const deleteLine = db.transaction((id) => {
  statements.detachLineMeters.run(id);
  statements.deleteSectionsOfLine.run(id);
  statements.deleteLine.run(id);
});

const deletePlant = db.transaction((id) => {
  for (const line of statements.linesOfPlant.all(id)) deleteLine(line.id);
  statements.detachPlantMeters.run(id);
  statements.detachPlantGateways.run(id);
  statements.deletePlant.run(id);
});

const deleteGateway = db.transaction((id) => {
  statements.detachGatewayMeters.run(id);
  statements.deleteGatewayEvents.run(id);
  statements.deleteGatewayStats.run(id);
  statements.deleteGateway.run(id);
});

const deleteDemandGroup = db.transaction((id) => {
  statements.deleteStagesOfGroup.run(id);
  statements.deleteDemandBlocks.run(id);
  statements.deleteDemandLog.run(id);
  statements.deleteDemandGroup.run(id);
});

const deleteSection = db.transaction((id) => {
  statements.detachSectionMeters.run(id);
  statements.deleteSection.run(id);
});

const reorder = db.transaction((stmt, ids) => {
  ids.forEach((id, i) => stmt.run(i, id));
});

// hourly rollup: aggregate samples of one hour for one meter
const rollupHourStmt = db.prepare(`
  SELECT COUNT(*) AS n,
         AVG(p_total) AS kw_avg, MAX(p_total) AS kw_max, MIN(p_total) AS kw_min,
         AVG(v_ln_avg) AS v_avg, MIN(v_ln_avg) AS v_min, MAX(v_ln_avg) AS v_max,
         MAX(i_avg) AS i_max, AVG(pf) AS pf_avg,
         MIN(kwh_import) AS kwh_start, MAX(kwh_import) AS kwh_end,
         MIN(kvarh_import) AS kvarh_start, MAX(kvarh_import) AS kvarh_end
  FROM samples WHERE meter_id = ? AND at >= ? AND at < ?`);

const rollupHour = (meterId, hourStart) => {
  const r = rollupHourStmt.get(meterId, hourStart, hourStart + 3600000);
  if (!r || !r.n) return false;
  // energy delta: counter at end of hour minus counter at end of previous hour
  // (falls back to min/max within the hour for the very first hour)
  const prev = statements.lastSampleBefore.get(meterId, hourStart);
  const kwhStart = prev && Number.isFinite(prev.kwh_import) ? prev.kwh_import : r.kwh_start;
  const kvarhStart = prev && Number.isFinite(prev.kvarh_import) ? prev.kvarh_import : r.kvarh_start;
  statements.upsertHourly.run({
    meter_id: meterId,
    hour_start: hourStart,
    kwh: Number.isFinite(r.kwh_end) && Number.isFinite(kwhStart) ? Math.max(0, r.kwh_end - kwhStart) : null,
    kvarh: Number.isFinite(r.kvarh_end) && Number.isFinite(kvarhStart) ? Math.max(0, r.kvarh_end - kvarhStart) : null,
    kw_avg: r.kw_avg, kw_max: r.kw_max, kw_min: r.kw_min,
    v_avg: r.v_avg, v_min: r.v_min, v_max: r.v_max,
    i_max: r.i_max, pf_avg: r.pf_avg, samples: r.n, kwh_end: r.kwh_end,
  });
  return true;
};

const prune = (keep) => {
  const cutMs = (days) => Date.now() - days * 86400000;
  const cutIso = (days) => new Date(cutMs(days)).toISOString();
  const out = {
    samples: statements.pruneSamples.run(cutMs(keep.samplesDays)).changes,
    hourly: statements.pruneHourly.run(cutMs(keep.hourlyDays)).changes,
    events: statements.pruneEvents.run(cutMs(keep.eventsDays)).changes,
    gatewayStats: statements.pruneGatewayStats.run(cutMs(keep.gatewayStatsDays)).changes,
    audit: statements.pruneAudit.run(cutIso(keep.auditDays)).changes,
    demandBlocks: statements.pruneDemandBlocks.run(cutMs(keep.hourlyDays)).changes,
    demandLog: statements.pruneDemandLog.run(cutMs(keep.eventsDays)).changes,
    sessions: statements.pruneSessions.run(Date.now()).changes,
  };
  return out;
};

module.exports = {
  db, statements, now, parseJson, getSetting, setSetting, audit,
  deleteMeter, deleteLine, deletePlant, deleteGateway, deleteSection, deleteDemandGroup, reorder,
  rollupHour, prune,
};
