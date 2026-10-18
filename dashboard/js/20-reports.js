// dashboard/js/20-reports.js — Report downloads: shared report helpers, weekly PDF, mobile report.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// SHARED REPORT HELPERS
// ========================

// Revenue files for the downloadable reports: the current fee mode, with the
// same fallback as the views. NSE/BSE are required, MCX optional.
async function fetchReportRevenue(ex, required) {
  const rev = await fetchRevenueFiles(ex);
  const val = r => (r.status === 'fulfilled' ? r.value.json : null);
  if (required && !val(rev.raw)) throw rev.raw.reason;
  if (required && !val(rev.enr)) throw rev.enr.reason;
  return { dash: val(rev.raw), enr: val(rev.enr), eff: rev.eff };
}

// Fee-basis / modelled flags of one exchange's rows, for the report tables
function reportFlagsFor(dash) {
  const daily = dash?.daily_all || [];
  return {
    q:       (label, sk) => periodFlags((dash?.quarterly || []).find(x => x.quarter === label), sk),
    m:       (label, sk) => periodFlags((dash?.monthly || []).find(x => x.month === label), sk),
    tail:    (from, to, sk) => rowsFlags(daily.slice(from, to), sk),
    weekday: (day, n, sk) => rowsFlags(daily.filter(r => r.day === day).slice(-n), sk),
  };
}

// Printed markers (tooltips do not print): the weekly report styles them with
// .pr-flag; the standalone mobile report needs inline styles.
function reportTags(f, inline) {
  if (!f) return '';
  const tag = (text, color, cls) => inline
    ? `<span style="display:inline-block;margin-left:3px;padding:0 3px;border:1px solid ${color};border-radius:3px;color:${color};font-size:9px;font-weight:700;line-height:1.3;vertical-align:1px">${text}</span>`
    : `<span class="pr-flag${cls}">${text}</span>`;
  return (f.slab || f.prov ? tag('est.', '#A56000', '') : '') + (f.modelled ? tag('modelled', '#6D28D9', ' pr-flag--modelled') : '');
}

// One line under a report's title: the fee basis of its NSE/BSE figures and
// what the markers mean.
function reportFeeLine(nseEff, bseEff, mcxDash) {
  const parts = [];
  const charged = [nseEff && 'NSE', bseEff && 'BSE'].filter(Boolean);
  const today = [!nseEff && 'NSE', !bseEff && 'BSE'].filter(Boolean);
  if (charged.length) parts.push(`${charged.join('/')} fees as charged: each trading day at the transaction fees then in force (fee register); est. = slab-era flat estimate or provisional calibrated BSE cash rate.`);
  if (today.length) parts.push(`${today.join('/')} fees at today's rates: every trading day at today's statutory transaction fees (fee register)${FEE_MODE === 'charged' ? ' — date-effective data not generated yet' : ''}.`);
  parts.push('MCX: source values.');
  const mh = mcxDash?.modelled_history;
  if (mh && mh.days > 0) parts.push(`modelled = MCX history ${fmtLongDate(mh.first_date)} – ${fmtLongDate(mh.last_date)}, excluded from comparisons (—).`);
  return parts.join(' ');
}

function buildAllRegressionChartImgs(shareData, exchangeName) {
  const reg      = shareData.regression || {};
  const maW      = shareData.ma_window || 45;
  const regStart = shareData.regression_start || '';
  const series   = (shareData.series || []).filter(r => r.date >= regStart);
  if (!series.length) return [];

  const labels  = series.map(r => fmtChartDate(r.date));
  const actuals = series.map(r => r.price);
  const preds   = series.map(r => r.price_pred);
  const revMA   = series.map(r => r.rev_ma);
  const slope   = reg.slope, intercept = reg.intercept;

  const ratios = series.map(r => r.price / r.rev_ma);
  const rN     = ratios.length;
  const mean   = ratios.reduce((a, b) => a + b, 0) / rN;
  const std    = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / rN);
  const flat   = v => series.map(() => v);

  const scatterPts = series.map(r => ({ x: r.rev_ma, y: r.price }));
  const xVals      = scatterPts.map(p => p.x);
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  const regLine = [{ x: xMin, y: slope * xMin + intercept }, { x: xMax, y: slope * xMax + intercept }];

  const sdBandOuter = CHART_COLORS[0] + '18';
  const sdBandInner = CHART_COLORS[0] + '30';
  const sdLineOuter = CHART_COLORS[0] + '55';
  const sdLineInner = CHART_COLORS[0] + '80';

  const chartDefs = [
    {
      label: 'Share Price: Actual vs Model',
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: 'Actual Price',     data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Model Prediction', data: preds,   borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [5, 3] },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 9 } } }, y: { ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } } } } }
      }
    },
    {
      label: `Rev MA${maW} vs ${exchangeName} Share Price`,
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: maW + '-Day MA Revenue (₹ Cr)', data: revMA,   borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yRev' },
          { label: exchangeName + ' Share Price (₹)', data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yPrice' },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } },
            yRev:   { type: 'linear', position: 'left',  title: { display: true, text: maW + '-Day MA Rev (₹ Cr)', font: { size: 9 } }, ticks: { callback: v => '₹' + fmtNum(v, 1) + ' Cr', font: { size: 9 } } },
            yPrice: { type: 'linear', position: 'right', title: { display: true, text: 'Share Price (₹)', font: { size: 9 } }, ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } }, grid: { drawOnChartArea: false } },
          }
        }
      }
    },
    {
      label: `Price ÷ Rev MA${maW} Ratio — Mean ± SD`,
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: '+2σ',            data: flat(mean + 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 4 }, backgroundColor: sdBandOuter },
          { label: '+1σ',            data: flat(mean + std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 3 }, backgroundColor: sdBandInner },
          { label: 'Mean',           data: flat(mean),           borderColor: CHART_COLORS[4], borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: '−1σ',            data: flat(mean - std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: '−2σ',            data: flat(mean - 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: 'Price / Rev MA', data: ratios, borderColor: CHART_COLORS[1], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } }, y: { ticks: { callback: v => v.toFixed(0), font: { size: 9 } }, title: { display: true, text: 'Price ÷ Rev MA' + maW, font: { size: 9 } } } } }
      }
    },
    {
      label: `Price vs ${maW}-Day Revenue MA — Scatter`,
      w: 700, h: 300,
      config: {
        type: 'scatter',
        data: { datasets: [
          { label: 'Price vs Rev MA', data: scatterPts, backgroundColor: CHART_COLORS[0] + '88', pointRadius: 3 },
          { label: 'Regression Line', data: regLine, type: 'line', borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 0 },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: {
            x: { title: { display: true, text: maW + '-Day MA Revenue (₹ Cr)', font: { size: 10 } }, ticks: { callback: v => '₹' + fmtNum(v, 1), font: { size: 9 } } },
            y: { title: { display: true, text: exchangeName + ' Share Price (₹)', font: { size: 10 } }, ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } } },
          }
        }
      }
    },
  ];

  return chartDefs.map(def => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${def.w}px;height:${def.h}px;`;
    const canvas = document.createElement('canvas');
    canvas.width = def.w; canvas.height = def.h;
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    const tempChart = new Chart(canvas, def.config);
    const img = tempChart.toBase64Image();
    tempChart.destroy();
    document.body.removeChild(wrap);
    return { label: def.label, img };
  });
}

// ========================
// WEEKLY REPORT PDF DOWNLOAD
// ========================

// Header REPORT / MOBILE buttons: while a report builds, show "Building…" in
// the label (hidden on phones, where the button is icon-only) and restore it after.
function setReportBtnBusy(btn, busy) {
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (label) {
    if (busy) { btn.dataset.label = label.textContent; label.textContent = 'Building…'; }
    else if (btn.dataset.label) label.textContent = btn.dataset.label;
  }
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

async function downloadWeeklyReport() {
  const btn = document.getElementById('btnDownloadReport');
  setReportBtnBusy(btn, true);

  try {
    // NSE/BSE in the current fee mode (as the views); MCX is source values
    const [nseRev, bseRev, mcxRev, bseShare, mcxShare, nseShare] = await Promise.all([
      fetchReportRevenue('nse', true),
      fetchReportRevenue('bse', true),
      fetchReportRevenue('mcx', false).catch(() => ({ dash: null, enr: null })),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/nse_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);
    const [nseEnrich, bseEnrich, mcxEnrich] = [nseRev.enr, bseRev.enr, mcxRev.enr];
    const [nseDash, bseDash, mcxDash] = [nseRev.dash, bseRev.dash, mcxRev.dash];

    // ── Week range from latest NSE daily date ──
    const nseDaily = nseDash.daily_all || nseDash.daily || [];
    const latestDateStr = nseDaily.length > 0 ? nseDaily[nseDaily.length - 1].date : null;
    function getWeekRange(dateStr) {
      if (!dateStr) return 'N/A';
      const d = new Date(dateStr + 'T00:00:00');
      const day = d.getDay();
      const daysToMon = day === 0 ? -6 : 1 - day;
      const mon = new Date(d); mon.setDate(d.getDate() + daysToMon);
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
      function ordinal(n) { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
      const monMonth = mon.toLocaleString('en-IN', { month: 'short' });
      const friStr = ordinal(fri.getDate()) + ' ' + fri.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
      if (mon.getMonth() !== fri.getMonth()) return `${ordinal(mon.getDate())} ${monMonth} – ${friStr}`;
      return `${ordinal(mon.getDate())} – ${friStr}`;
    }
    const weekRange = getWeekRange(latestDateStr);
    const genTime = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function n(num) { if (num == null || isNaN(num)) return '—'; return fmtNum(num); }
    function prFmt(val) {
      if (val == null || isNaN(val)) return '—';
      const pct = (val * 100).toFixed(1);
      if (val > 0.0001) return `<span class="pr-pos">+${pct}%</span>`;
      if (val < -0.0001) return `<span class="pr-neg">${pct}%</span>`;
      return '<span class="pr-neu">0.0%</span>';
    }
    // Markers, and "—" for a comparison with modelled MCX days on either side
    const tg = f => reportTags(f);
    const prChg = (val, ...flags) => anyModelled(...flags) ? '—' : prFmt(val);

    function buildTotalRevenueTable(enriched, F) {
      const s = enriched.summary_total;
      if (!s) return '';
      const wl5 = s.weekly.last5 || {};
      const wp5 = s.weekly.prev5 || {};
      const w20r = s.weekly.last20 || {};
      const w50 = s.weekly.last45 || {};
      const mc = s.monthly.current || {};
      const mp = s.monthly.previous || {};
      const m6 = s.monthly.avg_6m || {};
      const qc = s.quarterly.current || {};
      const qp = s.quarterly.previous || {};
      const q2 = s.quarterly.prev2 || {};
      const f5 = F.tail(-5, undefined, 'total'), fp5 = F.tail(-10, -5, 'total');
      const f20 = F.tail(-20, undefined, 'total'), f45 = F.tail(-45, undefined, 'total');
      const fmc = F.m(mc.label, 'total'), fmp = F.m(mp.label, 'total'), fm6 = F.tail(-125, undefined, 'total');
      const fqc = F.q(qc.label, 'total'), fqp = F.q(qp.label, 'total'), fq2 = F.q(q2.label, 'total');
      return `<div class="pr-sub-header">Total Revenue (Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Metric</th><th>₹ Cr</th><th>% Change</th></tr></thead>
        <tbody>
          <tr class="pr-group-label"><td colspan="3">Weekly</td></tr>
          <tr><td>L5 – This Week</td><td>${n(wl5.value)}${tg(f5)}</td><td>${prChg(wl5.wow, f5, fp5)}</td></tr>
          <tr><td>Prev5 – Last Week</td><td>${n(wp5.value)}${tg(fp5)}</td><td>—</td></tr>
          <tr><td>L20 – 20-Day Avg</td><td>${n(w20r.value)}${tg(f20)}</td><td>—</td></tr>
          <tr><td>L45 – 45-Day Avg</td><td>${n(w50.value)}${tg(f45)}</td><td>${prChg(wl5.wo10w, f45)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Monthly</td></tr>
          <tr><td>${mc.label || 'Current Month'}</td><td>${n(mc.value)}${tg(fmc)}</td><td>${prChg(mc.mom, fmc, fmp)}</td></tr>
          <tr><td>${mp.label || 'Prev Month'}</td><td>${n(mp.value)}${tg(fmp)}</td><td>—</td></tr>
          <tr><td>${AVG_6M_LABEL}</td><td>${n(m6.value)}${tg(fm6)}</td><td>${prChg(mc.mo6m, fmc, fm6)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Quarterly</td></tr>
          <tr><td>${qc.label || 'Current Q'}</td><td>${n(qc.value)}${tg(fqc)}</td><td>${prChg(qc.qoq, fqc, fqp)}</td></tr>
          <tr><td>${qp.label || 'Prev Q'}</td><td>${n(qp.value)}${tg(fqp)}</td><td>—</td></tr>
          <tr><td>${q2.label || 'YoY Q'}</td><td>${n(q2.value)}${tg(fq2)}</td><td>${prChg(qc.yoy, fqc, fq2)}</td></tr>
        </tbody>
      </table>`;
    }

    function buildDowTable(enriched, F) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const rows = dayNames.map(day => {
        const dd = dow[day] || {};
        const f1 = F.weekday(day, 1, 'total'), f3 = F.weekday(day, 3, 'total'), f10 = F.weekday(day, 10, 'total');
        return `<tr><td>${day}</td><td>${n(dd.latest)}${tg(f1)}</td><td>${n(dd.avg_3d)}${tg(f3)}</td><td>${prChg(dd.do3d, f3)}</td><td>${n(dd.avg_10d)}${tg(f10)}</td><td>${prChg(dd.do10d, f10)}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Day-of-Week Performance</div>
      <table class="pr-table">
        <thead><tr><th>Day</th><th>This Week (₹ Cr)</th><th>L3 Avg</th><th>Do3D</th><th>L10 Avg</th><th>Do10D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    function buildSegmentTable(enriched, F) {
      const segs = [
        { label: 'Options', data: enriched.seg_options, sk: 'options' },
        { label: 'Futures', data: enriched.seg_futures, sk: 'futures' },
        { label: 'Cash',    data: enriched.seg_cash,    sk: 'cash' },
      ];
      const rows = segs.map(seg => {
        const l5 = ((seg.data || {}).weekly || {}).last5 || {};
        const f5 = F.tail(-5, undefined, seg.sk);
        return `<tr><td>${seg.label}</td><td>${n(l5.value)}${tg(f5)}</td><td>${prChg(l5.wow, f5, F.tail(-10, -5, seg.sk))}</td><td>${prChg(l5.wo10w, F.tail(-45, undefined, seg.sk))}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Segment Revenue (L5 Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Segment</th><th>L5 Avg</th><th>WoW</th><th>vs 45D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    // Compact expiry comparison for the printed report — Total revenue only
    // (the report has no segment sub-tabs), fewer rows than the on-screen
    // version. Reuses computeMonthExpiryDates/computeWeekExpiryDates/
    // getYoYQuarter/quarterSortKey, all defined at module scope.
    function buildExpiryReportTable(dashData, exchange) {
      const dailyAll = dashData.daily_all || dashData.daily || [];
      if (!dailyAll.length) return '';
      const byDate = new Map(dailyAll.map(r => [r.date, r]));

      const monthExpiries = computeMonthExpiryDates(dailyAll, exchange)
        .map(({ monthKey, expiryDate }) => {
          const rec = byDate.get(expiryDate);
          return rec ? { monthKey, expiryDate, fy_month: rec.fy_month, fy_quarter: rec.fy_quarter, value: rec.total_rev || 0, flags: periodFlags(rec, 'total') } : null;
        })
        .filter(Boolean);
      if (!monthExpiries.length) return '';

      const monthly = monthExpiries.slice(-6);
      const monthlyRows = monthly.map((e, i) => {
        const prev = i > 0 ? monthly[i - 1] : null;
        const mom = prev && prev.value ? (e.value - prev.value) / prev.value : null;
        return `<tr><td>${e.fy_month}</td><td>${n(e.value)}${tg(e.flags)}</td><td>${prFmt(mom)}</td></tr>`;
      }).join('');

      const byQuarter = new Map(), flagsByQuarter = new Map();
      monthExpiries.forEach(e => {
        if (!byQuarter.has(e.fy_quarter)) { byQuarter.set(e.fy_quarter, []); flagsByQuarter.set(e.fy_quarter, []); }
        byQuarter.get(e.fy_quarter).push(e.value);
        flagsByQuarter.get(e.fy_quarter).push(e.flags);
      });
      const qAvg = q => {
        const v = byQuarter.get(q);
        return v && v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
      };
      const quarters = [...byQuarter.keys()].sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).slice(-4);
      const quarterlyRows = quarters.map((q, i) => {
        const cur     = qAvg(q);
        const prevVal = i > 0 ? qAvg(quarters[i - 1]) : null;
        const yoyVal  = qAvg(getYoYQuarter(q));
        const qoq = prevVal ? (cur - prevVal) / prevVal : null;
        const yoy = yoyVal ? (cur - yoyVal) / yoyVal : null;
        return `<tr><td>${q}</td><td>${n(cur)}${tg(mergeFlags(flagsByQuarter.get(q) || []))}</td><td>${prFmt(qoq)}</td><td>${prFmt(yoy)}</td></tr>`;
      }).join('');

      const monthEndByKey = new Map(monthExpiries.map(e => [e.monthKey, e]));
      const weeksByMonth = new Map();
      computeWeekExpiryDates(dailyAll, exchange).forEach(w => {
        const mk = w.expiryDate.slice(0, 7);
        if (!weeksByMonth.has(mk)) weeksByMonth.set(mk, []);
        weeksByMonth.get(mk).push(w.expiryDate);
      });
      const wvmRows = [];
      weeksByMonth.forEach((dates, mk) => {
        const me = monthEndByKey.get(mk);
        if (!me) return;
        const otherRecs = dates
          .filter(d => d !== me.expiryDate)
          .map(d => byDate.get(d))
          .filter(Boolean);
        const otherVals = otherRecs.map(r => r.total_rev || 0);
        if (!otherVals.length) return;
        const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
        const diff = avgWeekly ? (me.value - avgWeekly) / avgWeekly : null;
        wvmRows.push({ monthKey: mk, fy_month: me.fy_month, avgWeekly, monthEnd: me.value, diff,
          weeklyFlags: rowsFlags(otherRecs, 'total'), monthEndFlags: me.flags });
      });
      wvmRows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
      const wvmRecent = wvmRows.slice(-12);
      const wvmRowsHTML = wvmRecent.map(r =>
        `<tr><td>${r.fy_month}</td><td>${n(r.avgWeekly)}${tg(r.weeklyFlags)}</td><td>${n(r.monthEnd)}${tg(r.monthEndFlags)}</td><td>${prFmt(r.diff)}</td></tr>`
      ).join('');

      // Same trailing-average summary rows as the on-screen Weekly vs Month-End
      // Expiry table, drawn from the full wvmRows history (not just the 12
      // displayed above) so they stay correct if that window is ever narrowed.
      const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
      const wvmSummaryHTML = [3, 6, 12].map(nMonths => {
        const w = wvmRows.slice(-nMonths);
        const avgWeekly = avgOf(w.map(r => r.avgWeekly));
        const avgMonthEnd = avgOf(w.map(r => r.monthEnd));
        const diff = avgWeekly ? (avgMonthEnd - avgWeekly) / avgWeekly : null;
        return `<tr style="font-weight:700"><td>Last ${nMonths} Months Avg</td><td>${n(avgWeekly)}${tg(mergeFlags(w.map(r => r.weeklyFlags)))}</td><td>${n(avgMonthEnd)}${tg(mergeFlags(w.map(r => r.monthEndFlags)))}</td><td>${prFmt(diff)}</td></tr>`;
      }).join('');

      const expiryWeekday = monthEndExpiryWeekdayLabel(exchange, dailyAll);
      return `
      <div class="pr-sub-header">Month-End Expiry Comparison (Total Rev, ₹ Cr) — last trading day on/before month's last ${expiryWeekday}</div>
      <table class="pr-table" style="margin-bottom:8px">
        <thead><tr><th>Month</th><th>₹ Cr</th><th>MoM</th></tr></thead>
        <tbody>${monthlyRows}</tbody>
      </table>
      <table class="pr-table" style="margin-bottom:8px">
        <thead><tr><th>Quarter</th><th>₹ Cr</th><th>QoQ</th><th>YoY</th></tr></thead>
        <tbody>${quarterlyRows}</tbody>
      </table>
      <div class="pr-sub-header">Weekly vs Month-End Expiry (Total Rev, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Month</th><th>Avg Weekly Expiry</th><th>Month-End Expiry</th><th>Difference</th></tr></thead>
        <tbody>${wvmRowsHTML}${wvmSummaryHTML}</tbody>
      </table>`;
    }

    // flagDash: the exchange's dashboard file, for the fee-basis / modelled markers
    function buildExchangeSection(label, enriched, includeSegments, dashData, exchangeKey, flagDash) {
      const F = reportFlagsFor(flagDash || dashData);
      return `<div class="pr-section">
        <div class="pr-section-header">${label}</div>
        <div class="pr-section-body">
          ${buildTotalRevenueTable(enriched, F)}
          ${buildDowTable(enriched, F)}
          ${includeSegments ? buildSegmentTable(enriched, F) : ''}
          ${dashData && exchangeKey ? buildExpiryReportTable(dashData, exchangeKey) : ''}
        </div>
      </div>`;
    }

    function buildRegressionSection(shareData, exchangeName) {
      if (!shareData) return '';
      const reg      = shareData.regression || {};
      const lat      = shareData.latest || {};
      const maW      = shareData.ma_window || 45;
      const regStart = shareData.regression_start || '';

      const statsHTML = `
      <div class="pr-regression-stats">
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">R²</div><div class="pr-reg-stat-value">${reg.r_squared != null ? reg.r_squared.toFixed(4) : '—'}</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">Pearson r</div><div class="pr-reg-stat-value">${reg.pearson_r != null ? reg.pearson_r.toFixed(4) : '—'}</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">MA Window</div><div class="pr-reg-stat-value">${maW}-day</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">Fit Quality</div><div class="pr-reg-stat-value" style="text-transform:capitalize">${reg.fit || '—'}</div></div>
      </div>
      <div class="pr-reg-equation">${reg.equation || '—'}</div>
      <table class="pr-table" style="max-width:360px;margin-bottom:10px">
        <thead><tr><th>Latest (${lat.date || '—'})</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Actual Price</td><td>₹${lat.price_actual != null ? fmtNum(lat.price_actual, 0) : '—'}</td></tr>
          <tr><td>Model Predicted</td><td>₹${lat.price_pred != null ? fmtNum(lat.price_pred, 0) : '—'}</td></tr>
          <tr><td>Error %</td><td>${lat.error_pct != null ? lat.error_pct + '%' : '—'}</td></tr>
          <tr><td>Rev MA${maW} (₹ Cr)</td><td>${lat.rev_ma != null ? fmtNum(lat.rev_ma, 2) : '—'}</td></tr>
          <tr><td>Regression from</td><td>${regStart}</td></tr>
          <tr><td>N (trading days)</td><td>${shareData.n_days || '—'}</td></tr>
        </tbody>
      </table>`;

      const chartResults = buildAllRegressionChartImgs(shareData, exchangeName);
      const chartsHTML = chartResults.map((c, i) => {
        // Scatter (last chart) spans full width
        const span = i === chartResults.length - 1 ? ' style="grid-column:1/-1"' : '';
        return `<div class="pr-chart-item"${span}><div class="pr-chart-label">${c.label}</div><img src="${c.img}" alt="${c.label}"></div>`;
      }).join('');

      return `<div class="pr-section">
        <div class="pr-section-header">${exchangeName} Share Price Regression</div>
        <div class="pr-section-body">
          ${statsHTML}
          <div class="pr-chart-grid">${chartsHTML}</div>
        </div>
      </div>`;
    }

    // NSE listed 2026-09-24: until nse_share_analysis.json reaches status="ready"
    // (20 trading days) there is no fit to print, so show collection progress.
    function buildNSEShareSection(shareData) {
      if (!shareData) return '';
      const ready = shareData.status === 'ready' && shareData.regression;
      if (ready) {
        const note = shareData.limited_data
          ? `<div class="pr-summary" style="margin:0 10px 8px">Limited data: only ${shareData.n_days} trading days since the ${shareData.listing_date} listing — treat the fit as indicative.</div>`
          : '';
        return buildRegressionSection(shareData, 'NSE').replace(/(<div class="pr-section-body">)/, '$1' + note);
      }
      const lat   = shareData.latest || {};
      const first = shareData.first_price;
      const since = first && lat.price_actual ? ((lat.price_actual / first - 1) * 100).toFixed(1) + '%' : '—';
      return `<div class="pr-section">
        <div class="pr-section-header">NSE Share Price Regression</div>
        <div class="pr-section-body">
          <div class="pr-regression-stats">
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Days Collected</div><div class="pr-reg-stat-value">${shareData.n_days} / ${shareData.min_days_required}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Latest Close</div><div class="pr-reg-stat-value">₹${lat.price_actual != null ? fmtNum(lat.price_actual, 2) : '—'}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Since Listing</div><div class="pr-reg-stat-value">${since}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Listed On</div><div class="pr-reg-stat-value">${shareData.listing_date}</div></div>
          </div>
          <div class="pr-summary">NSE listed on ${shareData.listing_date}. The revenue → share price regression starts automatically once ${shareData.min_days_required} trading days of price history are available; prices are being collected daily.</div>
        </div>
      </div>`;
    }

    function buildMarketShareSection() {
      const chartResults = buildMarketShareChartImgs(nseDash, bseDash);
      if (!chartResults.length) return '';
      const chartsHTML = chartResults.map(c =>
        `<div class="pr-chart-item" style="grid-column:1/-1"><div class="pr-chart-label">${c.label}</div><img src="${c.img}" alt="${c.label}"></div>`
      ).join('');
      return `<div class="pr-section">
        <div class="pr-section-header">NSE vs BSE Market Share Trend</div>
        <div class="pr-section-body">
          <div class="pr-chart-grid">${chartsHTML}</div>
        </div>
      </div>`;
    }

    const html = `<div class="pr-wrapper">
      <div class="pr-header">
        <span class="pr-title">NSE/BSE Weekly Update – Week of ${weekRange}</span>
        <span class="pr-subtitle">Generated: ${genTime}</span>
      </div>
      <p class="pr-fee-line">${reportFeeLine(nseRev.eff, bseRev.eff, mcxDash)}</p>
      ${buildExchangeSection('NSE Update', nseEnrich, true, nseDash, 'nse')}
      ${buildNSEShareSection(nseShare)}
      ${buildExchangeSection('BSE Update', bseEnrich, false, bseDash, 'bse')}
      ${buildRegressionSection(bseShare, 'BSE')}
      ${buildMarketShareSection()}
      ${mcxEnrich ? buildExchangeSection('MCX Update', mcxEnrich, true, null, null, mcxDash) : ''}
      ${buildRegressionSection(mcxShare, 'MCX')}
      <div class="pr-footer">NSE/BSE/MCX Analytics Dashboard — Auto-generated report</div>
    </div>`;

    const el = document.getElementById('print-report');
    el.innerHTML = html;
    el.style.display = 'block';
    setTimeout(() => { window.print(); el.style.display = 'none'; }, 150);
  } finally {
    setReportBtnBusy(btn, false);
  }
}

// ========================
// MOBILE REPORT DOWNLOAD
// ========================

async function downloadMobileReport() {
  const btn = document.getElementById('btnMobileReport');
  setReportBtnBusy(btn, true);

  try {
    // NSE/BSE in the current fee mode (as the views); MCX is source values
    const [nseRev, bseRev, mcxRev, bseShare, mcxShare] = await Promise.all([
      fetchReportRevenue('nse', true),
      fetchReportRevenue('bse', true),
      fetchReportRevenue('mcx', false).catch(() => ({ dash: null, enr: null })),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);
    const [nseEnrich, bseEnrich, mcxEnrich] = [nseRev.enr, bseRev.enr, mcxRev.enr];
    const [nseDash, bseDash, mcxDash] = [nseRev.dash, bseRev.dash, mcxRev.dash];

    const nseDaily = nseDash.daily_all || nseDash.daily || [];
    const latestDateStr = nseDaily.length > 0 ? nseDaily[nseDaily.length - 1].date : '';
    const genTime = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function n(v) { return (v == null || isNaN(v)) ? '—' : fmtNum(v); }
    function pct(v, decimals) {
      if (v == null || isNaN(v)) return '—';
      const p = (v * 100).toFixed(decimals != null ? decimals : 1);
      return (v > 0.0001 ? '+' : '') + p + '%';
    }
    // Highlighted pill for a % change — green background for positive, red for negative
    function pctBadge(v, decimals) {
      if (v == null || isNaN(v)) return '<span style="color:#9ca3af">—</span>';
      const isPos = v > 0.0001, isNeg = v < -0.0001;
      const bg = isPos ? '#dcfce7' : isNeg ? '#fee2e2' : '#f3f4f6';
      const fg = isPos ? '#15803d' : isNeg ? '#b91c1c' : '#6b7280';
      return `<span style="display:inline-block;background:${bg};color:${fg};padding:1px 7px;border-radius:5px;font-weight:700;white-space:nowrap">${pct(v, decimals)}</span>`;
    }

    // Markers, and "—" for a comparison with modelled MCX days on either side
    const tg = f => reportTags(f, true);
    const badgeOrNA = (val, ...flags) => pctBadge(anyModelled(...flags) ? null : val);

    // ── KPI card for weekly/quarterly headline ──
    // flags: the figure's fee-basis / modelled flags; cmpNA: its comparison is
    // against modelled MCX days, so "—" replaces the % change
    function kpiCard(label, value, change, changeLabel, flags, cmpNA) {
      const chgStr = cmpNA
        ? `<div style="margin-top:4px">${pctBadge(null)} <span style="font-size:10px;color:#9ca3af">${changeLabel || ''}</span></div>`
        : change != null ? `<div style="margin-top:4px">${pctBadge(change)} <span style="font-size:10px;color:#9ca3af">${changeLabel || ''}</span></div>` : '';
      return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;flex:1;min-width:130px">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}${tg(flags)}</div>
        <div style="font-size:20px;font-weight:700;color:#111;letter-spacing:-.02em">₹${n(value)}<span style="font-size:11px;font-weight:400;color:#6b7280"> Cr</span></div>
        ${chgStr}
      </div>`;
    }

    // ── DoW table rows ──
    function dowRows(enriched, F) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
      return days.map(d => {
        const dd = dow[d] || {};
        const f3 = F.weekday(d, 3, 'total');
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#374151">${d.slice(0,3)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(dd.latest)}${tg(F.weekday(d, 1, 'total'))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(dd.do3d, f3)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280">${n(dd.avg_10d)}${tg(F.weekday(d, 10, 'total'))}</td>
        </tr>`;
      }).join('');
    }

    // dash: the exchange's dashboard file, for the fee-basis / modelled markers
    function exchangeSection(name, color, enriched, dash) {
      const F = reportFlagsFor(dash);
      const s   = enriched.summary_total || {};
      const wl5 = s.weekly?.last5 || {};
      const wp5 = s.weekly?.prev5 || {};
      const w20 = s.weekly?.last20 || {};
      const w45 = s.weekly?.last45 || {};
      const qc  = s.quarterly?.current || {};
      const qp  = s.quarterly?.previous || {};
      const mc  = s.monthly?.current || {};
      const m6  = s.monthly?.avg_6m || {};

      const segs = [
        { label: 'Options', d: enriched.seg_options, sk: 'options' },
        { label: 'Futures', d: enriched.seg_futures, sk: 'futures' },
        { label: 'Cash',    d: enriched.seg_cash,    sk: 'cash' },
      ];
      const segRows = segs.map(sg => {
        const l5 = sg.d?.weekly?.last5 || {};
        const f5 = F.tail(-5, undefined, sg.sk);
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;color:#374151">${sg.label}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(l5.value)}${tg(f5)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(l5.wow, f5, F.tail(-10, -5, sg.sk))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(l5.wo10w, F.tail(-45, undefined, sg.sk))}</td>
        </tr>`;
      }).join('');
      const f5 = F.tail(-5, undefined, 'total'), fp5 = F.tail(-10, -5, 'total');
      const f20 = F.tail(-20, undefined, 'total'), f45 = F.tail(-45, undefined, 'total');
      const fqc = F.q(qc.label, 'total'), fqp = F.q(qp.label, 'total'), fq2 = F.q(s.quarterly?.prev2?.label, 'total');
      const fmc = F.m(mc.label, 'total'), fmp = F.m(s.monthly?.previous?.label, 'total');

      return `
      <div style="margin-bottom:20px">
        <div style="background:${color};color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">${name}</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px 14px 6px">

          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard('This Week (L5)', wl5.value, wl5.wow, 'WoW', f5, anyModelled(f5, fp5))}
            ${kpiCard('Last Week (P5)', wp5.value, null, '', fp5)}
            ${kpiCard('20-Day Avg', w20.value, null, '', f20)}
            ${kpiCard('45-Day Avg', w45.value, wl5.wo10w, 'Wo45', f45, anyModelled(f45))}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard(qc.label || 'Current Q', qc.value, qc.qoq, 'QoQ', fqc, anyModelled(fqc, fqp))}
            ${kpiCard(qp.label || 'Prev Q', qp.value, null, '', fqp)}
            ${kpiCard(s.quarterly?.prev2?.label || 'Year-ago Q', s.quarterly?.prev2?.value, qc.yoy, 'YoY (current Q)', fq2, anyModelled(fqc, fq2))}
            ${kpiCard(mc.label || 'Current Month', mc.value, mc.mom, 'MoM', fmc, anyModelled(fmc, fmp))}
          </div>

          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.05em;margin:10px 0 6px">Day of Week (₹ Cr daily avg)</div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f9fafb">
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Day</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Latest</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Do3D</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">10D Avg</th>
              </tr></thead>
              <tbody>${dowRows(enriched, F)}</tbody>
            </table>
          </div>

          ${segs[0].d ? `
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.05em;margin:12px 0 6px">Segments (L5 Daily Avg)</div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f9fafb">
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Segment</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">₹ Cr</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">WoW</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Wo45</th>
              </tr></thead>
              <tbody>${segRows}</tbody>
            </table>
          </div>` : ''}

        </div>
      </div>`;
    }

    function regressionSection(shareData, exchangeName, color) {
      if (!shareData) return '';
      const reg = shareData.regression || {};
      const lat = shareData.latest || {};
      const maW = shareData.ma_window || 45;

      // Build charts at mobile width (380px)
      const origDefs = shareData;
      const chartResults = buildAllRegressionChartImgs(shareData, exchangeName);

      const statPills = [
        { l: 'R²',         v: reg.r_squared?.toFixed(4) || '—' },
        { l: 'Pearson r',  v: reg.pearson_r?.toFixed(4)  || '—' },
        { l: 'MA Window',  v: maW + '-day' },
        { l: 'Fit',        v: reg.fit || '—' },
      ].map(s => `<div style="background:#f0f4f0;border-radius:6px;padding:8px 10px;flex:1;min-width:70px;text-align:center">
        <div style="font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${s.l}</div>
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;text-transform:capitalize">${s.v}</div>
      </div>`).join('');

      const latRows = [
        ['Date', lat.date || '—'],
        ['Actual Price', lat.price_actual != null ? '₹' + fmtNum(lat.price_actual, 0) : '—'],
        ['Predicted',    lat.price_pred   != null ? '₹' + fmtNum(lat.price_pred,   0) : '—'],
        ['Error %',      lat.error_pct != null ? lat.error_pct + '%' : '—'],
        ['Rev MA' + maW, lat.rev_ma    != null ? '₹' + fmtNum(lat.rev_ma, 2) + ' Cr' : '—'],
      ].map(([l, v]) => `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:12px">${l}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;text-align:right;font-size:12px">${v}</td>
      </tr>`).join('');

      const chartImgs = chartResults.map(c =>
        `<div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.04em;margin-bottom:4px">${c.label}</div>
          <img src="${c.img}" alt="${c.label}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
        </div>`
      ).join('');

      return `
      <div style="margin-bottom:20px">
        <div style="background:${color};color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">${exchangeName} Share Price Regression</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px">
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${statPills}</div>
          <div style="font-size:10px;font-family:monospace;background:#f0f4f0;border-left:3px solid ${color};padding:6px 10px;border-radius:0 4px 4px 0;color:#374151;margin-bottom:12px">${reg.equation || '—'}</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:14px"><tbody>${latRows}</tbody></table>
          ${chartImgs}
        </div>
      </div>`;
    }

    function marketShareSection() {
      const chartResults = buildMarketShareChartImgs(nseDash, bseDash);
      if (!chartResults.length) return '';
      const chartImgs = chartResults.map(c =>
        `<div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.04em;margin-bottom:4px">${c.label}</div>
          <img src="${c.img}" alt="${c.label}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
        </div>`
      ).join('');
      return `
      <div style="margin-bottom:20px">
        <div style="background:#374151;color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">NSE vs BSE Market Share Trend</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px">
          ${chartImgs}
        </div>
      </div>`;
    }

    const body = `
      ${exchangeSection('NSE Update', '#1d4ed8', nseEnrich, nseDash)}
      ${exchangeSection('BSE Update', '#0f766e', bseEnrich, bseDash)}
      ${regressionSection(bseShare, 'BSE', '#0f766e')}
      ${marketShareSection()}
      ${mcxEnrich ? exchangeSection('MCX Update', '#7c3aed', mcxEnrich, mcxDash) : ''}
      ${regressionSection(mcxShare, 'MCX', '#7c3aed')}
    `;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>NSE/BSE Weekly Report — ${latestDateStr}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: #f3f4f6; color: #111; padding: 12px; max-width: 480px; margin: 0 auto; }
  @media (min-width: 480px) { body { padding: 20px; } }
</style>
</head>
<body>
<div style="background:#1e3a2f;color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:16px">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px">NSE/BSE Weekly Update</div>
  <div style="font-size:12px;color:#86efac">As of ${latestDateStr} &nbsp;·&nbsp; Generated ${genTime}</div>
  <div style="font-size:10.5px;color:#d1fae5;margin-top:6px;line-height:1.4">${reportFeeLine(nseRev.eff, bseRev.eff, mcxDash)}</div>
</div>
${body}
<div style="text-align:center;font-size:10px;color:#9ca3af;margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb">
  NSE/BSE/MCX Analytics Dashboard — Auto-generated report
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `nse-bse-report-${latestDateStr || 'latest'}.html`;
    a.click();
    URL.revokeObjectURL(url);

  } finally {
    setReportBtnBusy(btn, false);
  }
}

