/*
 * Canonical metric registry.
 *
 * Every driver / template maps its device-specific registers onto these keys,
 * so the dashboard, alarm rules, storage and exports all speak one vocabulary
 * whatever the meter brand is. Order here is the display order in the UI.
 *
 *   key      - canonical name (also the samples column name)
 *   label    - label shown on the meter face / detail
 *   unit     - display unit
 *   group    - card the value lives in on the detail page
 *   decimals - display precision
 *   stored   - kept as its own column in `samples` (charts / exports)
 *   phase    - A/B/C/N when the value belongs to a phase (chart series color)
 *   counter  - cumulative energy register (deltas are what a report wants)
 */
const METRICS = [
  // Voltage L-N
  { key: 'va', label: 'Voltage A-N', unit: 'V', group: 'voltage', decimals: 1, stored: true, phase: 'A' },
  { key: 'vb', label: 'Voltage B-N', unit: 'V', group: 'voltage', decimals: 1, stored: true, phase: 'B' },
  { key: 'vc', label: 'Voltage C-N', unit: 'V', group: 'voltage', decimals: 1, stored: true, phase: 'C' },
  { key: 'v_ln_avg', label: 'Voltage L-N Avg', unit: 'V', group: 'voltage', decimals: 1, stored: true },
  // Voltage L-L
  { key: 'vab', label: 'Voltage A-B', unit: 'V', group: 'voltage_ll', decimals: 1, stored: true, phase: 'A' },
  { key: 'vbc', label: 'Voltage B-C', unit: 'V', group: 'voltage_ll', decimals: 1, stored: true, phase: 'B' },
  { key: 'vca', label: 'Voltage C-A', unit: 'V', group: 'voltage_ll', decimals: 1, stored: true, phase: 'C' },
  { key: 'v_ll_avg', label: 'Voltage L-L Avg', unit: 'V', group: 'voltage_ll', decimals: 1, stored: true },
  // Current
  { key: 'ia', label: 'Current A', unit: 'A', group: 'current', decimals: 2, stored: true, phase: 'A' },
  { key: 'ib', label: 'Current B', unit: 'A', group: 'current', decimals: 2, stored: true, phase: 'B' },
  { key: 'ic', label: 'Current C', unit: 'A', group: 'current', decimals: 2, stored: true, phase: 'C' },
  { key: 'in', label: 'Current N', unit: 'A', group: 'current', decimals: 2, stored: true, phase: 'N' },
  { key: 'i_avg', label: 'Current Avg', unit: 'A', group: 'current', decimals: 2, stored: true },
  // Active power
  { key: 'pa', label: 'Active Power A', unit: 'kW', group: 'power', decimals: 2, stored: true, phase: 'A' },
  { key: 'pb', label: 'Active Power B', unit: 'kW', group: 'power', decimals: 2, stored: true, phase: 'B' },
  { key: 'pc', label: 'Active Power C', unit: 'kW', group: 'power', decimals: 2, stored: true, phase: 'C' },
  { key: 'p_total', label: 'Active Power Total', unit: 'kW', group: 'power', decimals: 2, stored: true },
  // Reactive / apparent
  { key: 'qa', label: 'Reactive Power A', unit: 'kVAR', group: 'power_qs', decimals: 2, stored: false, phase: 'A' },
  { key: 'qb', label: 'Reactive Power B', unit: 'kVAR', group: 'power_qs', decimals: 2, stored: false, phase: 'B' },
  { key: 'qc', label: 'Reactive Power C', unit: 'kVAR', group: 'power_qs', decimals: 2, stored: false, phase: 'C' },
  { key: 'q_total', label: 'Reactive Power Total', unit: 'kVAR', group: 'power_qs', decimals: 2, stored: true },
  { key: 'sa', label: 'Apparent Power A', unit: 'kVA', group: 'power_qs', decimals: 2, stored: false, phase: 'A' },
  { key: 'sb', label: 'Apparent Power B', unit: 'kVA', group: 'power_qs', decimals: 2, stored: false, phase: 'B' },
  { key: 'sc', label: 'Apparent Power C', unit: 'kVA', group: 'power_qs', decimals: 2, stored: false, phase: 'C' },
  { key: 's_total', label: 'Apparent Power Total', unit: 'kVA', group: 'power_qs', decimals: 2, stored: true },
  // Power factor / frequency
  { key: 'pfa', label: 'Power Factor A', unit: '', group: 'pf', decimals: 3, stored: false, phase: 'A' },
  { key: 'pfb', label: 'Power Factor B', unit: '', group: 'pf', decimals: 3, stored: false, phase: 'B' },
  { key: 'pfc', label: 'Power Factor C', unit: '', group: 'pf', decimals: 3, stored: false, phase: 'C' },
  { key: 'pf', label: 'Power Factor Total', unit: '', group: 'pf', decimals: 3, stored: true },
  { key: 'freq', label: 'Frequency', unit: 'Hz', group: 'pf', decimals: 2, stored: true },
  // Energy (cumulative counters)
  { key: 'kwh_import', label: 'Active Energy Import', unit: 'kWh', group: 'energy', decimals: 1, stored: true, counter: true },
  { key: 'kwh_export', label: 'Active Energy Export', unit: 'kWh', group: 'energy', decimals: 1, stored: true, counter: true },
  { key: 'kvarh_import', label: 'Reactive Energy Import', unit: 'kVARh', group: 'energy', decimals: 1, stored: true, counter: true },
  { key: 'kvarh_export', label: 'Reactive Energy Export', unit: 'kVARh', group: 'energy', decimals: 1, stored: false, counter: true },
  { key: 'kvah', label: 'Apparent Energy', unit: 'kVAh', group: 'energy', decimals: 1, stored: false, counter: true },
  // Demand
  { key: 'demand_kw', label: 'Active Power Demand', unit: 'kW', group: 'demand', decimals: 2, stored: true },
  { key: 'demand_peak_kw', label: 'Peak Demand', unit: 'kW', group: 'demand', decimals: 2, stored: true },
  { key: 'demand_kva', label: 'Apparent Power Demand', unit: 'kVA', group: 'demand', decimals: 2, stored: false },
  // Power quality
  { key: 'thd_va', label: 'THD Voltage A-N', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'A' },
  { key: 'thd_vb', label: 'THD Voltage B-N', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'B' },
  { key: 'thd_vc', label: 'THD Voltage C-N', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'C' },
  { key: 'thd_ia', label: 'THD Current A', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'A' },
  { key: 'thd_ib', label: 'THD Current B', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'B' },
  { key: 'thd_ic', label: 'THD Current C', unit: '%', group: 'thd', decimals: 1, stored: true, phase: 'C' },
  { key: 'v_unbal', label: 'Voltage Unbalance', unit: '%', group: 'thd', decimals: 2, stored: true },
  { key: 'i_unbal', label: 'Current Unbalance', unit: '%', group: 'thd', decimals: 2, stored: true },
];

const GROUPS = {
  voltage: { label: 'Voltage L-N' },
  voltage_ll: { label: 'Voltage L-L' },
  current: { label: 'Current' },
  power: { label: 'Active Power' },
  power_qs: { label: 'Reactive / Apparent' },
  pf: { label: 'Power Factor / Frequency' },
  energy: { label: 'Energy' },
  demand: { label: 'Demand' },
  thd: { label: 'Power Quality' },
};

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));
const STORED_KEYS = METRICS.filter((m) => m.stored).map((m) => m.key);

/** Derive values a template did not supply (averages, unbalance, totals). */
const deriveMissing = (v) => {
  const out = { ...v };
  const has = (k) => Number.isFinite(out[k]);
  const avg = (...ks) => {
    const xs = ks.filter(has).map((k) => out[k]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
  };
  const sum = (...ks) => {
    const xs = ks.filter(has).map((k) => out[k]);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
  };
  const unbal = (...ks) => {
    const xs = ks.filter(has).map((k) => out[k]);
    if (xs.length < 2) return undefined;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (!mean) return undefined;
    return (Math.max(...xs.map((x) => Math.abs(x - mean))) / mean) * 100;
  };
  if (!has('v_ln_avg')) out.v_ln_avg = avg('va', 'vb', 'vc');
  if (!has('v_ll_avg')) out.v_ll_avg = avg('vab', 'vbc', 'vca');
  if (!has('i_avg')) out.i_avg = avg('ia', 'ib', 'ic');
  if (!has('p_total')) out.p_total = sum('pa', 'pb', 'pc');
  if (!has('q_total')) out.q_total = sum('qa', 'qb', 'qc');
  if (!has('s_total')) out.s_total = sum('sa', 'sb', 'sc');
  if (!has('pf') && has('p_total') && has('s_total') && out.s_total) out.pf = out.p_total / out.s_total;
  if (!has('v_unbal')) out.v_unbal = unbal('va', 'vb', 'vc');
  if (!has('i_unbal')) out.i_unbal = unbal('ia', 'ib', 'ic');
  // drop empty keys so JSON stays compact
  for (const k of Object.keys(out)) {
    if (out[k] === undefined || out[k] === null || Number.isNaN(out[k])) delete out[k];
  }
  return out;
};

module.exports = { METRICS, GROUPS, BY_KEY, STORED_KEYS, deriveMissing };
