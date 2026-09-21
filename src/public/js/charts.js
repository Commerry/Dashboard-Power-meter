/* =====================================================================
   charts.js - uPlot wrappers (dark theme, crosshair tooltip, alarm bands)
   One y-axis per chart - metrics of different units go in separate charts.
   ===================================================================== */
const Charts = (() => {
  // colours come from the CSS tokens so light / dark charts match the page; refresh() re-reads them
  const C = { band: { outage: 'rgba(239,77,92,.22)', sag: 'rgba(250,178,25,.16)', swell: 'rgba(250,178,25,.16)', offline: 'rgba(107,112,128,.18)', overload: 'rgba(240,112,79,.16)', overcurrent: 'rgba(240,112,79,.16)', gateway: 'rgba(107,112,128,.18)', default: 'rgba(125,211,252,.1)' } };
  const refresh = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, d) => (cs.getPropertyValue(n) || d).trim() || d;
    Object.assign(C, {
      A: v('--ph-a', '#3987e5'), B: v('--ph-b', '#d95926'), C: v('--ph-c', '#199e70'), N: v('--ph-n', '#c98500'),
      s1: v('--series-1', '#3987e5'), s2: v('--series-2', '#d95926'), s3: v('--series-3', '#199e70'), s4: v('--series-4', '#c98500'), s5: '#d55181', s6: '#9085e9',
      accent: v('--accent', '#f5b942'), teal: v('--accent-2', '#3dd6c0'), text: v('--text-2', '#a4a9b8'), muted: v('--chart-text', '#6b7080'), grid: v('--chart-grid', '#1c2029'), axis: v('--chart-axis', '#2a2f3a'),
    });
    return C;
  };
  refresh();
  const phaseColor = (m, i) => (m && m.phase ? C[m.phase] : C['s' + ((i % 6) + 1)]);

  const axisBase = () => ({ stroke: C.muted, grid: { stroke: C.grid, width: 1 }, ticks: { stroke: C.axis, width: 1, size: 5 }, font: '11px JetBrains Mono, monospace', labelFont: '11px Inter, sans-serif' });

  // custom tooltip (values lead, series name follows; line keys)
  const tooltipPlugin = (fmt) => {
    let tip;
    return {
      hooks: {
        init: (u) => {
          tip = document.createElement('div');
          tip.className = 'u-tooltip';
          u.over.appendChild(tip);
          u.over.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
        },
        setCursor: (u) => {
          const { left, top, idx } = u.cursor;
          if (idx === null || idx === undefined || left < 0) { tip.style.display = 'none'; return; }
          const x = u.data[0][idx];
          const rows = [];
          for (let s = 1; s < u.series.length; s += 1) {
            const ser = u.series[s];
            if (!ser.show) continue;
            const v = u.data[s][idx];
            rows.push(`<div class="r"><i style="background:${ser.stroke()}"></i><span>${esc(ser.label)}</span><b>${v === null || v === undefined ? '-' : fmt(s, v)}</b></div>`);
          }
          tip.innerHTML = `<div class="t">${new Date(x * 1000).toLocaleString('en-GB', { hour12: false })}</div>${rows.join('')}`;
          tip.style.display = 'block';
          const w = tip.offsetWidth; const ow = u.over.clientWidth;
          tip.style.left = (left + 14 + w > ow ? left - w - 14 : left + 14) + 'px';
          tip.style.top = Math.max(0, top - 10) + 'px';
        },
      },
    };
  };

  // shaded bands for alarm events (outage / sag / offline ...)
  const bandsPlugin = (getEvents) => ({
    hooks: {
      drawClear: (u) => {
        const events = getEvents() || [];
        if (!events.length) return;
        const { ctx } = u;
        const [xMin, xMax] = [u.scales.x.min, u.scales.x.max];
        ctx.save();
        for (const e of events) {
          const s = Math.max(e.startedAt / 1000, xMin); const en = Math.min((e.endedAt || Date.now()) / 1000, xMax);
          if (en <= s) continue;
          const x0 = u.valToPos(s, 'x', true); const x1 = u.valToPos(en, 'x', true);
          ctx.fillStyle = C.band[e.type] || C.band.default;
          ctx.fillRect(x0, u.bbox.top, Math.max(2, x1 - x0), u.bbox.height);
        }
        ctx.restore();
      },
    },
  });

  /**
   * Line chart. series: [{ key, label, color, decimals, unit, dash? }]
   * data: [xs(sec), y1[], y2[], ...]  events: [{type, startedAt, endedAt}]
   */
  function timeSeries(el, { series, data, events = [], height = 300, unit = '', yMin = null, yMax = null, bars = false }) {
    el.innerHTML = '';
    let evs = events;
    const fmt = (s, v) => fmtNum(v, series[s - 1].decimals ?? 2) + (series[s - 1].unit ? ' ' + series[s - 1].unit : '');
    const opts = {
      width: el.clientWidth || 600,
      height,
      cursor: { x: true, y: false, points: { size: 7, width: 2 }, drag: { x: true, y: false } },
      legend: { show: series.length > 1, live: false },
      plugins: [tooltipPlugin(fmt), bandsPlugin(() => evs)],
      scales: { x: { time: true }, y: { range: (u, min, max) => { const lo = yMin !== null ? yMin : min; const hi = yMax !== null ? yMax : max; const pad = (hi - lo) * 0.08 || 1; return [yMin !== null ? lo : lo - pad, yMax !== null ? hi : hi + pad]; } } },
      axes: [
        { ...axisBase(), space: 80 },
        { ...axisBase(), size: 58, label: unit, labelSize: 14, values: (u, vals) => vals.map((v) => fmtNum(v, Math.abs(v) < 10 ? 2 : Math.abs(v) < 100 ? 1 : 0)) },
      ],
      series: [
        { label: 'time' },
        ...series.map((s, i) => ({
          label: s.label, stroke: s.color || phaseColor(metricOf(s.key), i), width: 2, points: { show: false }, dash: s.dash,
          paths: (s.bars || bars) ? uPlot.paths.bars({ size: [0.6, 30], radius: 0.15 }) : undefined,
          fill: s.fill !== undefined ? s.fill : (series.length === 1 && !bars ? s.color + '22' : undefined),
          value: (u, v) => (v === null ? '-' : fmt(i + 1, v)),
        })),
      ],
    };
    const u = new uPlot(opts, data, el);
    const ro = new ResizeObserver(() => { if (el.clientWidth) u.setSize({ width: el.clientWidth, height }); });
    ro.observe(el);
    return {
      u,
      setData(d, e) { if (e) evs = e; u.setData(d); },
      destroy() { ro.disconnect(); u.destroy(); },
    };
  }

  /** Build [xs, ...ys] from API rows for the given keys. */
  const toData = (rows, keys) => [rows.map((r) => r.at / 1000), ...keys.map((k) => rows.map((r) => (Number.isFinite(r[k]) ? r[k] : null)))];

  return { C, refresh, phaseColor, timeSeries, toData };
})();
