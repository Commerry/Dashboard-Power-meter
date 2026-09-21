/*
 * Schneider Electric register maps.
 *
 * Addresses are the "register number" as printed in the Schneider register
 * lists (1-based). The Modbus driver subtracts 1 on the wire (`base: 1`).
 * Every value is Float32 big-endian (ABCD) unless stated; energy counters are
 * Int64 in Wh / VARh / VAh and scaled to k-units here.
 *
 * The PM2xxx / PM5xxx / PM8000 / iEM3xxx families share the same "3000 block"
 * for instantaneous values, so one map covers them and the family only changes
 * which optional blocks (THD, demand, unbalance) exist.
 *
 * Verify against the register list of the exact firmware when a value looks
 * wrong - an admin can override any address per meter from Settings.
 */

// Schneider's PF encoding: |pf| <= 1 is the plain value, values between 1 and 2
// encode a leading PF as (2 - pf). Normalise to the usual -1..1.
const schneiderPf = (v) => {
  if (!Number.isFinite(v)) return v;
  const a = Math.abs(v);
  const pf = a > 1 ? 2 - a : a;
  return v < 0 ? -pf : pf;
};

const f32 = (key, addr, extra = {}) => ({ key, addr, type: 'float32', ...extra });
const i64k = (key, addr) => ({ key, addr, type: 'int64', scale: 0.001 }); // Wh -> kWh

const block3000 = [
  f32('ia', 3000), f32('ib', 3002), f32('ic', 3004), f32('in', 3006), f32('i_avg', 3010),
  f32('vab', 3020), f32('vbc', 3022), f32('vca', 3024), f32('v_ll_avg', 3026),
  f32('va', 3028), f32('vb', 3030), f32('vc', 3032), f32('v_ln_avg', 3036),
  f32('pa', 3054), f32('pb', 3056), f32('pc', 3058), f32('p_total', 3060),
  f32('qa', 3062), f32('qb', 3064), f32('qc', 3066), f32('q_total', 3068),
  f32('sa', 3070), f32('sb', 3072), f32('sc', 3074), f32('s_total', 3076),
  f32('pfa', 3078, { transform: 'schneider_pf' }), f32('pfb', 3080, { transform: 'schneider_pf' }),
  f32('pfc', 3082, { transform: 'schneider_pf' }), f32('pf', 3084, { transform: 'schneider_pf' }),
  f32('freq', 3110),
];

const unbalance = [f32('i_unbal', 3018), f32('v_unbal', 3052)];

const energy3204 = [
  i64k('kwh_import', 3204), i64k('kwh_export', 3208),
  i64k('kvarh_import', 3220), i64k('kvarh_export', 3224),
  i64k('kvah', 3236),
];

const demand = [f32('demand_kw', 3762), f32('demand_peak_kw', 3768)];

const thd = [
  f32('thd_ia', 21300), f32('thd_ib', 21302), f32('thd_ic', 21304),
  f32('thd_va', 21330), f32('thd_vb', 21332), f32('thd_vc', 21334),
];

const base = {
  brand: 'Schneider Electric',
  protocolHint: 'modbus',
  fn: 'holding',
  base: 1,
  wordOrder: 'ABCD',
  defaults: { nominalV: 230, nominalHz: 50, phases: 3 },
};

module.exports = [
  {
    ...base,
    id: 'schneider-pm5xxx',
    model: 'PowerLogic PM5xxx',
    name: 'Schneider PM5100 / PM5300 / PM5500 series',
    registers: [...block3000, ...unbalance, ...energy3204, ...demand, ...thd],
  },
  {
    ...base,
    id: 'schneider-pm2xxx',
    model: 'PowerLogic PM2xxx',
    name: 'Schneider PM2100 / PM2200 series',
    registers: [...block3000, ...unbalance, ...energy3204, ...demand, ...thd],
  },
  {
    ...base,
    id: 'schneider-pm8000',
    model: 'PowerLogic PM8000',
    name: 'Schneider PM8000 series',
    registers: [...block3000, ...unbalance, ...energy3204, ...demand, ...thd],
  },
  {
    ...base,
    id: 'schneider-iem3x55',
    model: 'iEM3155 / iEM3255 / iEM3355',
    name: 'Schneider iEM3x55 energy meter',
    registers: [...block3000, ...energy3204],
  },
  {
    ...base,
    id: 'schneider-iem3x50',
    model: 'iEM3150 / iEM3250 / iEM3350',
    name: 'Schneider iEM3x50 energy meter',
    registers: [
      ...block3000,
      i64k('kwh_import', 45100),
      i64k('kwh_export', 45104),
      i64k('kvarh_import', 45108),
      i64k('kvarh_export', 45112),
    ],
  },
  {
    ...base,
    id: 'schneider-em6400',
    model: 'EM6400 / EM6400NG',
    name: 'Schneider EM6400 series',
    registers: [
      // EM6400NG uses the same common block for instantaneous values
      ...block3000,
      ...energy3204,
    ],
  },
];

module.exports.transforms = { schneider_pf: schneiderPf };
