const { db, statements, now } = require('./db');
const config = require('./config');

/*
 * Demo seed - two plants, a few lines, simulator gateways and twenty meters,
 * so the dashboard has something to show before real gateways are added.
 * Runs only when there is not a single plant in the database.
 */
const seedDemo = () => {
  if (statements.listPlants.all().some((p) => p.code === 'SPK')) return false;
  const run = db.transaction(() => {
    const t = now();
    const plantA = statements.createPlant.run('Samut Prakan Plant', 'SPK', 'Samut Prakan', 'Bangpoo Industrial Estate', 0, t).lastInsertRowid;
    const plantB = statements.createPlant.run('Rayong Plant', 'RYG', 'Rayong', 'Map Ta Phut Industrial Estate', 1, t).lastInsertRowid;

    const gwA1 = statements.createGateway.run(plantA, 'GW-SPK-01 (Link150)', 'simulator', '10.10.1.21', 502, JSON.stringify({ latencyMs: 35, failRate: 0.01, eventRate: 0.002 }), 1, 'Schneider Link150 - production building 1', t).lastInsertRowid;
    const gwA2 = statements.createGateway.run(plantA, 'GW-SPK-02 (EGX300)', 'simulator', '10.10.1.22', 502, JSON.stringify({ latencyMs: 60, failRate: 0.02, eventRate: 0.003 }), 1, 'Schneider EGX300 - production building 2', t).lastInsertRowid;
    const gwB1 = statements.createGateway.run(plantB, 'GW-RYG-01 (Link150)', 'simulator', '10.20.1.21', 502, JSON.stringify({ latencyMs: 45, failRate: 0.01, eventRate: 0.002 }), 1, null, t).lastInsertRowid;
    statements.createGateway.run(plantB, 'GW-RYG-PULSE (ESP32 push)', 'push', null, null, null, 1, 'kWh pulse counters posting to /api/v1/ingest', t);

    const lines = [
      { plant: plantA, name: 'Line 1 - Extrusion', code: 'L1', gw: gwA1, sections: ['Extruder', 'Chiller', 'Packing'], meters: 5, rated: [90, 75, 120, 45, 30] },
      { plant: plantA, name: 'Line 2 - Injection', code: 'L2', gw: gwA1, sections: ['Injection', 'Robot'], meters: 4, rated: [110, 110, 60, 22] },
      { plant: plantA, name: 'Line 3 - Assembly', code: 'L3', gw: gwA2, sections: ['Conveyor', 'Utility'], meters: 4, rated: [40, 35, 55, 18] },
      { plant: plantB, name: 'Line A - Compounding', code: 'LA', gw: gwB1, sections: ['Mixer', 'Pelletizer'], meters: 4, rated: [150, 130, 80, 40] },
      { plant: plantB, name: 'Line B - Utilities', code: 'LB', gw: gwB1, sections: ['Compressor', 'Cooling tower'], meters: 3, rated: [200, 95, 60] },
    ];
    const templatesCycle = ['schneider-pm5xxx', 'schneider-pm5xxx', 'schneider-pm2xxx', 'schneider-iem3x55', 'schneider-pm8000'];
    let unit = 1;
    let order = 0;
    for (const l of lines) {
      const lineId = statements.createLine.run(l.plant, l.name, l.code, order, t).lastInsertRowid;
      order += 1;
      const sectionIds = l.sections.map((s, i) => statements.createSection.run(lineId, s, i).lastInsertRowid);
      for (let i = 0; i < l.meters; i += 1) {
        const sec = sectionIds[Math.min(i, sectionIds.length - 1)];
        statements.createMeter.run({
          plant_id: l.plant, line_id: lineId, section_id: sec, gateway_id: l.gw,
          name: `${l.code}-PM${String(i + 1).padStart(2, '0')}`, code: `${l.code}-PM${String(i + 1).padStart(2, '0')}`,
          template: templatesCycle[i % templatesCycle.length], unit_id: unit, conn_json: null, register_map_json: null,
          poll_ms: 2000, nominal_v: 230, nominal_hz: 50, ct_primary: Math.round(l.rated[i] * 2.2), rated_kw: l.rated[i], rated_a: Math.round(l.rated[i] * 1.9),
          phases: 3, alarm_json: null, enabled: 1, sort_order: i, notes: null, created_at: t,
        });
        unit += 1;
      }
    }
  });
  run();
  // peak-demand demo: plant A main incoming = every meter of plant A, three dry-run stages
  const plantA = statements.listPlants.all().find((p) => p.code === 'SPK');
  if (plantA) {
    const ids = statements.listMeters.all().filter((m) => m.plant_id === plantA.id).map((m) => m.id);
    const gid = statements.createDemandGroup.run({ plant_id: plantA.id, name: 'SPK main incoming', target_kw: 1300, margin_kw: 60, block_min: 15, release_pct: 0.92, action_gap_sec: 30, meter_ids: JSON.stringify(ids), auto: 1, enabled: 1, notes: 'demo - stages are dry-run until a Siemens S7 gateway + tag is bound', created_at: now() }).lastInsertRowid;
    const stages = [['Chiller 2 setpoint +2C', 1, 90, 180, 900], ['Compressor B unload', 2, 120, 240, 1200], ['Extruder heaters hold', 3, 60, 120, 600]];
    for (const [name, prio, kw, minOff, maxOff] of stages) {
      statements.createDemandStage.run({ group_id: gid, name, priority: prio, gateway_id: null, tag_json: null, shed_value: 1, restore_value: 0, kw_estimate: kw, min_off_sec: minOff, max_off_sec: maxOff, enabled: 1, notes: null });
    }
  }
  console.log('seed: demo plants, lines, gateways and meters created (SEED_DEMO=0 to skip)');
  return true;
};

/*
 * Real PLCs (Siemens S7, DB1004 energy summary). Created when the database has
 * no plant yet; IPs from SEED_PLC_IPS (comma list) - blank disables.
 */
const seedPlc = () => {
  if (statements.listPlants.all().length) return false;
  const ips = String(config.seedPlcIps || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!ips.length) return false;
  const run = db.transaction(() => {
    const t = now();
    const plant = statements.createPlant.run('Plant 1', 'P1', null, null, 0, t).lastInsertRowid;
    const line = statements.createLine.run(plant, 'PLC energy summary', 'PLC', 0, t).lastInsertRowid;
    ips.forEach((ip, i) => {
      const n = String(i + 1).padStart(2, '0');
      const gw = statements.createGateway.run(plant, `PLC-${n} (${ip})`, 'siemens-s7', ip, 102, JSON.stringify({ rack: 0, slot: 1, timeoutMs: 3000, lib: 'auto' }), 1, 'Siemens S7 - energy summary in DB1004', t).lastInsertRowid;
      statements.createMeter.run({
        plant_id: plant, line_id: line, section_id: null, gateway_id: gw,
        name: `PLC-${n} energy`, code: `PLC-${n}`, template: 'siemens-s7-energy-db1004', unit_id: 1,
        conn_json: JSON.stringify({ faceKey: 'kw_day' }), register_map_json: null,
        poll_ms: 5000, nominal_v: 230, nominal_hz: 50, ct_primary: null, rated_kw: null, rated_a: null,
        phases: 3, alarm_json: JSON.stringify({ enabled: false }), enabled: 1, sort_order: i, notes: `DB1004 @ ${ip}`, created_at: t,
      });
    });
  });
  run();
  console.log(`seed: ${ips.length} Siemens PLC gateways + devices created (SEED_PLC_IPS)`);
  return true;
};

module.exports = { seedDemo, seedPlc };

if (require.main === module) {
  const auth = require('./auth'); // eslint-disable-line global-require
  auth.ensureAdmin();
  console.log(seedDemo() ? 'seeded' : 'database already has plants - nothing done');
}
