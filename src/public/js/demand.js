/* =====================================================================
   demand.js - Peak-demand monitor page (Views.demand)
   Built once, patched every second from the `demand` websocket message.
   ===================================================================== */
(() => {
  const STATUS = {
    nodata: { label: 'NO DATA', cls: 'neutral' },
    ok: { label: 'OK', cls: 'ok' },
    shedding: { label: 'SHEDDING', cls: 'info' },
    warn: { label: 'ABOVE THRESHOLD', cls: 'warn' },
    critical: { label: 'TARGET AT RISK', cls: 'error' },
    exceeded: { label: 'TARGET EXCEEDED', cls: 'critical' },
  };
  const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const fmtBlock = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '--:--');

  const kpi = (key, label, value, opts) => Views.kpi(key, label, value, opts);

  function groupCard(g) {
    return `<div class="card demand" data-group="${g.id}">
      <div class="card-head">
        <i class="dot"></i>
        <div style="min-width:0"><div class="card-title">${esc(g.name)}</div><div class="card-sub">${esc(g.plantName || '')} · ${g.metersTotal} meters · ${g.blockMin}-min block · target ${fmtNum(g.targetKw, 0)} kW · margin ${fmtNum(g.marginKw, 0)} kW</div></div>
        <span class="badge" data-d="status">-</span>
        <div class="right row" style="gap:.4rem">
          ${S.me.can.operator ? `<button class="btn sm" data-d="autoBtn" title="Toggle automatic load shedding">${icon('power')} <span>AUTO</span></button>` : `<span class="chip" data-d="autoChip"><b>-</b></span>`}
          ${S.me.can.admin ? `<a class="btn sm" href="#/settings/demand">${icon('settings')}</a>` : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="demand-top">
          <div class="lcd-wrap demand-lcd">
            <div class="lcd-row">${lcdHtml(g.projected, { decimals: 0, width: 5 })}<span class="lcd-unit">kW</span></div>
            <div class="lcd-label">Projected block demand<span class="ago" data-d="clock"></span></div>
          </div>
          <div class="kpis demand-kpis">
            ${kpi('avg', 'Block average', '-', { unit: 'kW', iconName: 'trend' })}
            ${kpi('now', 'Load now', '-', { unit: 'kW', iconName: 'bolt' })}
            ${kpi('today', 'Peak today', '-', { unit: 'kW', iconName: 'gauge' })}
            ${kpi('month', 'Peak this month', '-', { unit: 'kW', iconName: 'energy', tone: 'teal' })}
          </div>
        </div>
        <div class="demand-bar">
          <div class="demand-scale">
            <div class="fill" data-d="fillAvg" title="block average"></div>
            <div class="fill proj" data-d="fillProj" title="projected"></div>
            <div class="mark thr" data-d="markThr"><span>threshold</span></div>
            <div class="mark tgt" data-d="markTgt"><span>target</span></div>
          </div>
          <div class="demand-legend"><span><i class="sw" style="background:var(--accent-2)"></i> block average</span><span><i class="sw" style="background:var(--accent)"></i> projected</span><span class="right" data-d="range"></span></div>
        </div>
        <div class="demand-block">
          <div class="progress"><i data-d="progress"></i></div>
          <div class="row" style="font-size:.66rem;color:var(--text-3);font-family:var(--font-mono);margin-top:.3rem"><span data-d="blockTime">block --:-- – --:--</span><span class="right" data-d="elapsed">00:00 / 15:00</span></div>
        </div>
        <div class="sec-title" style="margin-top:.9rem">Load-shedding stages <span class="line"></span><span class="muted" style="text-transform:none;letter-spacing:0;font-weight:500" data-d="shedCount"></span></div>
        <div class="stages" data-d="stages">${g.stages.map(stageRow).join('') || '<div class="muted" style="font-size:.72rem">No stages configured</div>'}</div>
        <div class="sec-title">Block history (24 h) <span class="line"></span></div>
        <div class="chart-box" style="min-height:220px" data-d="chart"></div>
        <div class="sec-title">Action log <span class="line"></span></div>
        <div class="table-wrap" style="max-height:260px" data-d="log"><div class="empty" style="padding:1rem">loading...</div></div>
      </div></div>`;
  }

  const stageRow = (s) => `<div class="stage" data-stage="${s.id}">
      <span class="prio">${s.priority}</span>
      <div style="min-width:0"><div class="stage-name">${esc(s.name)}${s.dryRun ? ' <span class="evt-type">dry run</span>' : ''}</div>
        <div class="stage-sub">${s.kwEstimate ? `~${fmtNum(s.kwEstimate, 0)} kW · ` : ''}min off ${mmss(s.minOffSec)} · max ${mmss(s.maxOffSec)}${s.tag ? ` · ${esc(S7Addr.format(s.tag))}` : ''}</div></div>
      <span class="badge neutral stage-state" data-s="state">-</span>
      <span class="stage-since mono muted" data-s="since"></span>
      ${S.me.can.operator ? `<button class="btn xs" data-s="btn">-</button>` : ''}
    </div>`;

  function patchGroup(card, g) {
    const st = STATUS[g.status] || STATUS.nodata;
    setCls($('.card-head .dot', card), `dot ${g.status === 'ok' ? 'ok' : g.status === 'nodata' ? '' : g.status === 'shedding' ? 'warn' : g.status === 'warn' ? 'warn' : 'crit'}`);
    setText($('[data-d="status"]', card), st.label); setCls($('[data-d="status"]', card), `badge ${st.cls}`);
    const ab = $('[data-d="autoBtn"]', card);
    if (ab) { setCls(ab, `btn sm ${g.auto ? 'primary' : ''}`); setText($('span', ab), g.auto ? 'AUTO ON' : 'AUTO OFF'); ab.disabled = false; }
    const ac = $('[data-d="autoChip"]', card); if (ac) { setText($('b', ac), g.auto ? 'AUTO' : 'MANUAL'); setCls(ac, `chip ${g.auto ? 'ok' : 'warn'}`); }
    setNum($('.lcd .num', card), g.projected, (x) => lcdText(x, 0, 5));
    setText($('[data-d="clock"]', card), g.status === 'nodata' ? 'no meter data' : `${g.metersOnline}/${g.metersTotal} meters`);
    Views.patchKpi(card, 'avg', { num: g.blockAvg, fmt: (x) => fmtNum(x, 0), unit: 'kW', cls: g.blockAvg > g.targetKw ? 'bad' : g.blockAvg > g.thresholdKw ? 'warn' : '', sub: g.estimatedSec > 0 && g.elapsedSec - g.estimatedSec < 60 ? `first ${mmss(g.estimatedSec)} estimated` : `max ${fmtNum(g.blockMaxKw, 0)} · min ${fmtNum(g.blockMinKw, 0)} kW` });
    Views.patchKpi(card, 'now', { num: g.kwNow, fmt: (x) => fmtNum(x, 0), unit: 'kW', sub: `threshold ${fmtNum(g.thresholdKw, 0)} · release ${fmtNum(g.releaseKw, 0)} kW` });
    Views.patchKpi(card, 'today', { num: g.peaks ? g.peaks.today : NaN, fmt: (x) => fmtNum(x, 0), unit: 'kW', cls: g.peaks && g.peaks.today > g.targetKw ? 'bad' : '', sub: g.peaks ? `${g.peaks.blocksToday} blocks · ${g.peaks.exceededToday} exceeded` : '' });
    Views.patchKpi(card, 'month', { num: g.peaks ? g.peaks.month : NaN, fmt: (x) => fmtNum(x, 0), unit: 'kW', cls: g.peaks && g.peaks.month > g.targetKw ? 'bad' : '', sub: g.peaks && g.peaks.monthAt ? `on ${new Date(g.peaks.monthAt).toLocaleDateString('en-GB')} ${fmtBlock(g.peaks.monthAt)} · ${g.peaks.exceededMonth} exceeded` : 'no blocks yet' });
    // horizontal scale: 0 .. target*1.15
    const scaleMax = g.targetKw * 1.15;
    const pct = (v) => Math.max(0, Math.min(100, (v / scaleMax) * 100));
    setStyle($('[data-d="fillAvg"]', card), 'width', pct(g.blockAvg || 0).toFixed(1) + '%');
    setStyle($('[data-d="fillProj"]', card), 'width', pct(g.projected || 0).toFixed(1) + '%');
    setCls($('[data-d="fillProj"]', card), `fill proj ${g.projected > g.targetKw ? 'bad' : g.projected > g.thresholdKw ? 'warn' : ''}`);
    setStyle($('[data-d="markThr"]', card), 'left', pct(g.thresholdKw).toFixed(1) + '%');
    setStyle($('[data-d="markTgt"]', card), 'left', pct(g.targetKw).toFixed(1) + '%');
    setText($('[data-d="range"]', card), `0 – ${fmtNum(scaleMax, 0)} kW`);
    const total = g.elapsedSec + g.remainingSec || 1;
    setStyle($('[data-d="progress"]', card), 'width', ((g.elapsedSec / total) * 100).toFixed(1) + '%');
    setText($('[data-d="blockTime"]', card), `block ${fmtBlock(g.blockStart)} – ${fmtBlock(g.blockStart ? g.blockStart + total * 1000 : null)}`);
    setText($('[data-d="elapsed"]', card), `${mmss(g.elapsedSec)} / ${mmss(total)}`);
    setText($('[data-d="shedCount"]', card), g.shedCount ? `${g.shedCount} shed` : 'all running');
    // stages
    const box = $('[data-d="stages"]', card);
    if (box.children.length !== g.stages.length || [...box.children].some((r, i) => Number(r.dataset.stage) !== g.stages[i].id)) box.innerHTML = g.stages.map(stageRow).join('') || '<div class="muted" style="font-size:.72rem">No stages configured</div>';
    g.stages.forEach((s) => {
      const row = $(`[data-stage="${s.id}"]`, box);
      if (!row) return;
      setCls(row, `stage ${s.shed ? 'shed' : ''} ${s.enabled ? '' : 'off'}`);
      const state = !s.enabled ? 'DISABLED' : s.lastError ? 'WRITE FAILED' : s.shed ? (s.mode === 'manual' ? 'SHED (manual)' : 'SHED (auto)') : 'RUNNING';
      setText($('[data-s="state"]', row), state);
      setCls($('[data-s="state"]', row), `badge stage-state ${!s.enabled ? 'neutral' : s.lastError ? 'critical' : s.shed ? 'warn' : 'ok'}`);
      setText($('[data-s="since"]', row), s.shed && s.shedAt ? `off ${mmss(Math.round((Date.now() - s.shedAt) / 1000))}` : '');
      const btn = $('[data-s="btn"]', row);
      if (btn) { setText(btn, s.shed ? 'Restore' : 'Shed'); setCls(btn, `btn xs ${s.shed ? 'primary' : 'danger'}`); btn.disabled = !s.enabled; btn.title = s.lastError || ''; }
    });
  }

  function demand() {
    let el; let groups = []; let charts = new Map(); let logSig = new Map(); let tick;
    const build = async () => {
      const d = await api('/api/demand');
      groups = d.groups;
      setCrumbs([{ label: 'Overview', href: '#/' }, { label: 'Peak demand' }]);
      el.innerHTML = `<div class="page-head"><div><div class="page-title">Peak demand control</div><div class="page-sub">${groups.length} demand groups · 15-minute block projection · automatic load shedding through PLC stages</div></div>
        <div class="page-actions">${S.me.can.admin ? `<a class="btn primary" href="#/settings/demand">${icon('plus')} Configure groups</a>` : ''}</div></div>
        <div class="col" style="gap:1rem" id="demandGroups">${groups.map(groupCard).join('') || `<div class="empty">No demand groups yet${S.me.can.admin ? ' — create one under <a href="#/settings/demand">Settings › Peak demand</a>: pick the incoming meters, set the contract target and add PLC load-shedding stages' : ''}</div>`}</div>`;
      for (const g of groups) { const card = $(`[data-group="${g.id}"]`, el); patchGroup(card, g); bind(card, g); loadChart(g); loadLog(g); }
    };
    const bind = (card, g) => {
      const ab = $('[data-d="autoBtn"]', card);
      if (ab) ab.onclick = async () => {
        const cur = groups.find((x) => x.id === g.id);
        if (cur.auto && !await confirmDlg(`Disable automatic load shedding for "${g.name}"?\nStages already shed stay shed until restored manually or their max off time.`, { ok: 'Disable auto' })) return;
        ab.disabled = true;
        try { await api(`/api/demand/${g.id}/auto`, { body: { auto: !cur.auto } }); toast(`Automatic control ${cur.auto ? 'disabled' : 'enabled'}`, 'ok'); } catch (e) { toast(e.message, 'err'); ab.disabled = false; }
      };
      card.addEventListener('click', async (ev) => {
        const b = ev.target.closest('[data-s="btn"]');
        if (!b) return;
        const sid = Number(b.closest('.stage').dataset.stage);
        const cur = groups.find((x) => x.id === g.id); const s = cur.stages.find((x) => x.id === sid);
        const action = s.shed ? 'restore' : 'shed';
        if (!await confirmDlg(`${action === 'shed' ? 'Shed' : 'Restore'} stage "${s.name}" now?${s.dryRun ? '\n(dry run - no PLC tag bound, action is only logged)' : `\nWrites ${action === 'shed' ? s.shedValue : s.restoreValue} to the PLC tag.`}`, { ok: action === 'shed' ? 'Shed load' : 'Restore load', danger: action === 'shed' })) return;
        b.disabled = true;
        try { await api(`/api/demand/${g.id}/stages/${sid}/${action}`, { body: {} }); toast(`${s.name}: ${action}`, 'ok'); } catch (e) { toast(e.message, 'err'); b.disabled = false; }
        loadLog(cur);
      });
    };
    const loadChart = async (g) => {
      const card = $(`[data-group="${g.id}"]`, el); if (!card) return;
      const box = $('[data-d="chart"]', card);
      try {
        const to = Date.now(); const from = to - 24 * 3600000;
        const d = await api(`/api/demand/${g.id}/blocks?from=${from}&to=${to}`);
        if (charts.has(g.id)) charts.get(g.id).destroy();
        if (!d.blocks.length) { box.style.minHeight = '0'; box.innerHTML = '<div class="empty" style="padding:1.2rem">No completed blocks yet — the first block closes at the next quarter hour</div>'; charts.delete(g.id); return; }
        box.style.minHeight = '220px';
        const xs = d.blocks.map((b) => b.block_start / 1000 + (g.blockMin * 30));
        const data = [xs, d.blocks.map((b) => b.avg_kw), d.blocks.map((b) => b.target_kw || g.targetKw), d.blocks.map((b) => (b.shed_stages ? b.avg_kw : null))];
        charts.set(g.id, Charts.timeSeries(box, {
          series: [
            { key: 'avg', label: 'Block average', color: Charts.C.teal, decimals: 0, unit: 'kW', bars: true, fill: Charts.C.teal + 'aa' },
            { key: 'target', label: 'Target', color: Charts.C.s2, decimals: 0, unit: 'kW', dash: [6, 4] },
            { key: 'shed', label: 'Blocks with shedding', color: Charts.C.accent, decimals: 0, unit: 'kW', bars: true, fill: Charts.C.accent + 'aa' },
          ],
          data, height: 220, unit: 'kW', yMin: 0,
        }));
      } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
    };
    const loadLog = async (g) => {
      const card = $(`[data-group="${g.id}"]`, el); if (!card) return;
      const d = await api(`/api/demand/${g.id}/log?limit=40`);
      const sig = d.log.length ? `${d.log.length}|${d.log[0].id}` : '0';
      if (logSig.get(g.id) === sig) return;
      logSig.set(g.id, sig);
      setHtml($('[data-d="log"]', card), d.log.length ? `<table><thead><tr><th>Time</th><th>Action</th><th>Stage</th><th class="num">kW now</th><th class="num">Projected</th><th>Detail</th><th>By</th></tr></thead><tbody>
        ${d.log.map((l) => `<tr><td class="mono nowrap">${fmtTime(l.at)}</td><td><span class="evt-type ${/fail|exceed/.test(l.action) ? 'bad' : ''}">${esc(l.action.replace(/_/g, ' '))}</span></td><td>${esc(l.stage_name || '-')}</td><td class="num">${fmtNum(l.kw_now, 0)}</td><td class="num">${fmtNum(l.projected, 0)}</td><td class="muted" style="font-size:.66rem">${esc(l.detail || '')}</td><td class="mono">${esc(l.user || 'auto')}</td></tr>`).join('')}</tbody></table>` : '<div class="empty" style="padding:1rem">No actions yet</div>');
    };
    return {
      scope: { demand: true },
      mount(root) { el = root; build(); tick = setInterval(() => { for (const g of groups) loadLog(g); }, 15000); },
      onDemand(list) {
        if (!el) return;
        for (const g of list) {
          const prev = groups.find((x) => x.id === g.id);
          if (!prev) { build(); return; }
          const blockChanged = prev.blockStart && g.blockStart !== prev.blockStart;
          Object.assign(prev, g);
          const card = $(`[data-group="${g.id}"]`, el);
          if (card) patchGroup(card, prev);
          if (blockChanged) { loadChart(prev); loadLog(prev); }
        }
      },
      onEvent(msg) { if (msg.event.groupId) { const g = groups.find((x) => x.id === msg.event.groupId); if (g) loadLog(g); } },
      destroy() { clearInterval(tick); charts.forEach((c) => c.destroy()); },
    };
  }

  Views.demand = demand;
})();
