/*
 * Register maps for other common brands. Same shape as schneider.js.
 */
const f32 = (key, addr, extra = {}) => ({ key, addr, type: 'float32', ...extra });

module.exports = [
  {
    id: 'eastron-sdm630',
    brand: 'Eastron',
    model: 'SDM630 / SDM630MCT',
    name: 'Eastron SDM630 (Modbus RTU/TCP)',
    protocolHint: 'modbus',
    fn: 'input',        // SDM630 exposes measurements as input registers (FC04)
    base: 0,            // addresses as printed in the Eastron protocol sheet
    wordOrder: 'ABCD',
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
    registers: [
      f32('va', 0x0000), f32('vb', 0x0002), f32('vc', 0x0004),
      f32('ia', 0x0006), f32('ib', 0x0008), f32('ic', 0x000a),
      f32('pa', 0x000c, { scale: 0.001 }), f32('pb', 0x000e, { scale: 0.001 }), f32('pc', 0x0010, { scale: 0.001 }),
      f32('sa', 0x0012, { scale: 0.001 }), f32('sb', 0x0014, { scale: 0.001 }), f32('sc', 0x0016, { scale: 0.001 }),
      f32('qa', 0x0018, { scale: 0.001 }), f32('qb', 0x001a, { scale: 0.001 }), f32('qc', 0x001c, { scale: 0.001 }),
      f32('pfa', 0x001e), f32('pfb', 0x0020), f32('pfc', 0x0022),
      f32('v_ln_avg', 0x002a), f32('i_avg', 0x002e),
      f32('p_total', 0x0034, { scale: 0.001 }), f32('s_total', 0x0038, { scale: 0.001 }),
      f32('q_total', 0x003c, { scale: 0.001 }), f32('pf', 0x003e), f32('freq', 0x0046),
      f32('kwh_import', 0x0048), f32('kwh_export', 0x004a),
      f32('kvarh_import', 0x004c), f32('kvarh_export', 0x004e),
      f32('demand_kw', 0x0054, { scale: 0.001 }), f32('demand_peak_kw', 0x0056, { scale: 0.001 }),
      f32('vab', 0x00c8), f32('vbc', 0x00ca), f32('vca', 0x00cc), f32('v_ll_avg', 0x00ce),
      f32('in', 0x00e0),
      f32('thd_va', 0x00ea), f32('thd_vb', 0x00ec), f32('thd_vc', 0x00ee),
      f32('thd_ia', 0x00f0), f32('thd_ib', 0x00f2), f32('thd_ic', 0x00f4),
    ],
  },
  {
    id: 'siemens-pac3200',
    brand: 'Siemens',
    model: 'SENTRON PAC3200 / PAC3220 / PAC4200',
    name: 'Siemens SENTRON PAC3200 (Modbus TCP)',
    protocolHint: 'modbus',
    fn: 'holding',
    base: 0,            // offsets as printed in the SENTRON manual
    wordOrder: 'ABCD',
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
    registers: [
      f32('va', 1), f32('vb', 3), f32('vc', 5),
      f32('vab', 7), f32('vbc', 9), f32('vca', 11),
      f32('ia', 13), f32('ib', 15), f32('ic', 17),
      f32('sa', 19, { scale: 0.001 }), f32('sb', 21, { scale: 0.001 }), f32('sc', 23, { scale: 0.001 }),
      f32('pa', 25, { scale: 0.001 }), f32('pb', 27, { scale: 0.001 }), f32('pc', 29, { scale: 0.001 }),
      f32('qa', 31, { scale: 0.001 }), f32('qb', 33, { scale: 0.001 }), f32('qc', 35, { scale: 0.001 }),
      f32('pfa', 37), f32('pfb', 39), f32('pfc', 41),
      f32('thd_va', 43), f32('thd_vb', 45), f32('thd_vc', 47),
      f32('thd_ia', 49), f32('thd_ib', 51), f32('thd_ic', 53),
      f32('freq', 55), f32('v_ln_avg', 57), f32('v_ll_avg', 59), f32('i_avg', 61),
      f32('s_total', 63, { scale: 0.001 }), f32('p_total', 65, { scale: 0.001 }),
      f32('q_total', 67, { scale: 0.001 }), f32('pf', 69),
      f32('v_unbal', 71), f32('i_unbal', 73),
      { key: 'kwh_import', addr: 801, type: 'float64', scale: 0.001 },
      { key: 'kwh_export', addr: 805, type: 'float64', scale: 0.001 },
      { key: 'kvarh_import', addr: 809, type: 'float64', scale: 0.001 },
      { key: 'kvarh_export', addr: 813, type: 'float64', scale: 0.001 },
    ],
  },
  {
    id: 'generic-modbus',
    brand: 'Generic',
    model: 'Custom register map',
    name: 'Generic Modbus meter (define registers per meter)',
    protocolHint: 'modbus',
    fn: 'holding',
    base: 0,
    wordOrder: 'ABCD',
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
    registers: [
      // starting point - edit per meter in Settings > Meter > Register map
      f32('va', 0), f32('vb', 2), f32('vc', 4),
      f32('ia', 6), f32('ib', 8), f32('ic', 10),
      f32('p_total', 12), f32('pf', 14), f32('freq', 16),
      f32('kwh_import', 18),
    ],
  },
  {
    id: 'siemens-s7-tags',
    brand: 'Siemens',
    model: 'S7 PLC data block',
    name: 'Siemens S7 PLC tags (values already computed in the PLC)',
    protocolHint: 's7',
    fn: 'holding',
    base: 0,
    wordOrder: 'ABCD',
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
    // S7 tags: area DB/M/I/Q, db number, byte offset, type REAL/INT/DINT/WORD/DWORD/BOOL(bit)
    registers: [
      { key: 'p_total', area: 'DB', db: 1, start: 0, type: 'REAL' },
      { key: 'v_ln_avg', area: 'DB', db: 1, start: 4, type: 'REAL' },
      { key: 'i_avg', area: 'DB', db: 1, start: 8, type: 'REAL' },
      { key: 'pf', area: 'DB', db: 1, start: 12, type: 'REAL' },
      { key: 'freq', area: 'DB', db: 1, start: 16, type: 'REAL' },
      { key: 'kwh_import', area: 'DB', db: 1, start: 20, type: 'REAL' },
    ],
  },
  {
    id: 'siemens-s7-energy-db1004',
    brand: 'Siemens',
    model: 'S7 PLC energy summary (DB1004)',
    name: 'Siemens PLC energy summary - kW / kWh-RT per shift, day and week (DB1004)',
    protocolHint: 's7',
    fn: 'holding',
    base: 0,
    wordOrder: 'ABCD',
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
    faceKey: 'kw_day',
    faceSlots: ['kwhrt_day', 'kw_yesterday', 'kw_week', 'kwh_total'],
    layout: 'plc-summary',
    // values are already computed inside the PLC program; the dashboard shows them as a period matrix
    registers: (() => {
      const R = (key, start, extra) => ({ key, area: 'DB', db: 1004, start, type: 'REAL', ...extra });
      const periods = [['shift_a', 'Shift A', 0], ['shift_b', 'Shift B', 4], ['shift_c', 'Shift C', 8], ['day', 'Today', 12], ['yesterday', 'Yesterday', 16], ['week', 'This week', 20], ['last_week', 'Last week', 24]];
      return [
        R('wh_l', 0, { label: 'Wh_L', group: 'PLC totals', unit: 'Wh', decimals: 0 }),
        R('kwh_total', 16, { label: 'kWh', group: 'PLC totals', unit: 'kWh', decimals: 1 }),
        ...periods.map(([k, row, off]) => R('kw_' + k, 20 + off, { label: 'kW ' + row, group: 'Energy by period', unit: 'kW', decimals: 2, row, col: 'kW' })),
        ...periods.map(([k, row, off]) => R('kwhrt_' + k, 76 + off, { label: 'kWh-RT ' + row, group: 'Energy by period', unit: 'kWh', decimals: 2, row, col: 'kWh-RT' })),
      ];
    })(),
  },
  {
    id: 'generic-json',
    brand: 'Generic',
    model: 'JSON (MQTT / HTTP / push)',
    name: 'Generic JSON payload (MQTT topic, HTTP endpoint or push API)',
    protocolHint: 'json',
    registers: [],
    // JSON field -> metric key. Dotted paths are supported ("data.voltage.a").
    jsonMap: {
      va: 'va', vb: 'vb', vc: 'vc', ia: 'ia', ib: 'ib', ic: 'ic',
      p_total: 'p_total', q_total: 'q_total', s_total: 's_total', pf: 'pf', freq: 'freq',
      kwh_import: 'kwh_import',
    },
    defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
  },
  {
    id: 'pulse-counter',
    brand: 'Generic',
    model: 'Pulse counter (kWh pulses)',
    name: 'Pulse counter device (ESP32 / Arduino push)',
    protocolHint: 'json',
    registers: [],
    jsonMap: { kwh_import: 'kwh', p_total: 'kw' },
    defaults: { nominalV: 230, nominalHz: 50, phases: 1 },
  },
];
