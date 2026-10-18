// dashboard/js/11-market-share.js — NSE+BSE Market Share Trend tab.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// NSE vs BSE MARKET SHARE TREND (Options + Total, live chart + report)
// ========================

// Monthly NSE-vs-BSE market share — one point per calendar month (smooth, low-noise default view)
function buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw) {
  const nseM = nseRaw?.monthly || [];
  const bseByMonth = new Map((bseRaw?.monthly || []).map(m => [m.month, m]));
  const rows = [];
  nseM.forEach(n => {
    const b = bseByMonth.get(n.month);
    if (!b) return;
    const totalSum = (n.total_rev || 0) + (b.total_rev || 0);
    const optSum   = (n.opt_rev   || 0) + (b.opt_rev   || 0);
    rows.push({
      label: n.month,
      totalShareNSE: totalSum ? (n.total_rev || 0) / totalSum * 100 : null,
      totalShareBSE: totalSum ? (b.total_rev || 0) / totalSum * 100 : null,
      optShareNSE:   optSum   ? (n.opt_rev   || 0) / optSum   * 100 : null,
      optShareBSE:   optSum   ? (b.opt_rev   || 0) / optSum   * 100 : null,
    });
  });
  return rows;
}

// Rolling N-day NSE-vs-BSE market share — daily granularity smoothed by a trailing window,
// so the line reads as a trend rather than a dense daily zigzag.
function buildNSEBSERollingShareSeries(nseRaw, bseRaw, windowSize) {
  const nseDaily = (nseRaw?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const bseByDate = new Map((bseRaw?.daily_all || []).map(r => [r.date, r]));
  const merged = [];
  nseDaily.forEach(n => {
    const b = bseByDate.get(n.date);
    if (!b) return;
    merged.push({
      date: n.date,
      nseTotalRev: n.total_rev || 0, bseTotalRev: b.total_rev || 0,
      nseOptRev:   n.opt_rev   || 0, bseOptRev:   b.opt_rev   || 0,
    });
  });

  const rows = merged.map((r, i) => {
    const slice = merged.slice(Math.max(0, i - windowSize + 1), i + 1);
    const nseTotalSum = slice.reduce((s, x) => s + x.nseTotalRev, 0);
    const bseTotalSum = slice.reduce((s, x) => s + x.bseTotalRev, 0);
    const nseOptSum   = slice.reduce((s, x) => s + x.nseOptRev, 0);
    const bseOptSum   = slice.reduce((s, x) => s + x.bseOptRev, 0);
    const totalSum = nseTotalSum + bseTotalSum;
    const optSum   = nseOptSum + bseOptSum;
    return {
      label: fmtChartDate(r.date),
      totalShareNSE: totalSum ? nseTotalSum / totalSum * 100 : null,
      totalShareBSE: totalSum ? bseTotalSum / totalSum * 100 : null,
      optShareNSE:   optSum   ? nseOptSum   / optSum   * 100 : null,
      optShareBSE:   optSum   ? bseOptSum   / optSum   * 100 : null,
    };
  });

  // Drop the leading partial-window rows — they're averaged over fewer than windowSize days
  return rows.slice(windowSize - 1);
}

// Full-history daily NSE-vs-BSE options share (no windowing) — feeds the trend predictor below.
function buildOptionsShareDailySeries(nseRaw, bseRaw) {
  const nseDaily = (nseRaw?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const bseByDate = new Map((bseRaw?.daily_all || []).map(r => [r.date, r]));
  const rows = [];
  nseDaily.forEach(n => {
    const b = bseByDate.get(n.date);
    if (!b) return;
    const optSum = (n.opt_rev || 0) + (b.opt_rev || 0);
    if (!optSum) return;
    rows.push({ date: n.date, optShareNSE: (n.opt_rev || 0) / optSum * 100 });
  });
  return rows;
}

// Predicts NSE's options-market-share trend by fitting a long-term (~1yr) and a recent (~3mo)
// OLS regression over a lightly-smoothed daily share series, then picking whichever is more
// decision-relevant: higher R² by default, ties broken toward recency, overridden to the recent
// window if it shows a genuine regime change (opposite sign, much steeper, still a moderate+ fit).
function computeOptionsSharePredictor(nseRaw, bseRaw) {
  const daily = buildOptionsShareDailySeries(nseRaw, bseRaw);
  if (daily.length < 20) return null;

  const SMOOTH_WINDOW = 5, LONG_WINDOW = 252, RECENT_WINDOW = 60, TRADING_DAYS_PER_MONTH = 21;

  const smoothedVals = computeRollingMA(daily.map(r => r.optShareNSE), SMOOTH_WINDOW);
  const smoothed = daily.map((r, i) => smoothedVals[i] != null ? { date: r.date, share: smoothedVals[i] } : null).filter(Boolean);
  if (smoothed.length < 20) return null;

  function fitWindow(windowSize) {
    const rows = smoothed.slice(-windowSize);
    if (rows.length < 10) return null;
    const ols = computeOLS(rows.map((_, i) => i), rows.map(r => r.share));
    return {
      rows, ols,
      startDate: rows[0].date, endDate: rows[rows.length - 1].date,
      n: rows.length,
      ratePerMonth: ols.slope * TRADING_DAYS_PER_MONTH,
      fit: ols.r2 > 0.7 ? 'strong' : ols.r2 > 0.4 ? 'moderate' : 'weak',
    };
  }

  const longFit   = fitWindow(Math.min(LONG_WINDOW, smoothed.length));
  const recentFit = fitWindow(Math.min(RECENT_WINDOW, smoothed.length));
  if (!longFit || !recentFit) return null;

  const R2_TIE_TOLERANCE = 0.03, REGIME_SLOPE_RATIO = 1.5, REGIME_MIN_R2 = 0.4;
  const signFlip = recentFit.ols.slope !== 0 && Math.sign(recentFit.ols.slope) !== Math.sign(longFit.ols.slope);
  const regimeChange = signFlip
    && Math.abs(recentFit.ols.slope) > Math.abs(longFit.ols.slope) * REGIME_SLOPE_RATIO
    && recentFit.ols.r2 >= REGIME_MIN_R2;

  let chosen, reason;
  if (regimeChange) {
    chosen = 'recent'; reason = 'Regime change detected — recent trend has reversed and accelerated vs. the long-term trend';
  } else if (recentFit.ols.r2 >= longFit.ols.r2 - R2_TIE_TOLERANCE) {
    chosen = 'recent'; reason = recentFit.ols.r2 > longFit.ols.r2 ? 'Higher R² fit' : 'Comparable fit — recency preferred';
  } else {
    chosen = 'long'; reason = 'Higher R² fit';
  }
  const chosenFit = chosen === 'recent' ? recentFit : longFit;
  const lastIndex = chosenFit.rows.length - 1;

  function project(months) {
    const idx = lastIndex + months * TRADING_DAYS_PER_MONTH;
    const raw = chosenFit.ols.slope * idx + chosenFit.ols.intercept;
    return Math.max(0, Math.min(100, raw));
  }

  return {
    longFit, recentFit, chosen, reason, chosenFit,
    currentShare: smoothed[smoothed.length - 1].share,
    asOfDate: smoothed[smoothed.length - 1].date,
    smoothed,
    projections: [3, 6, 12].map(m => ({ months: m, nseShare: project(m) })),
  };
}

const MS_GRANULARITIES = [
  { key: 'monthly', label: 'Monthly' },
  { key: '20d',     label: '20-Day Rolling' },
  { key: '45d',     label: '45-Day Rolling' },
];

function getMarketShareRows(nseRaw, bseRaw, granularity) {
  if (granularity === '20d') return buildNSEBSERollingShareSeries(nseRaw, bseRaw, 20);
  if (granularity === '45d') return buildNSEBSERollingShareSeries(nseRaw, bseRaw, 45);
  return buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw);
}

function buildMarketShareChart(canvasId, rows, field) {
  if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
  if (!rows.length) return;
  const nseKey = field === 'total' ? 'totalShareNSE' : 'optShareNSE';
  const bseKey = field === 'total' ? 'totalShareBSE' : 'optShareBSE';
  setCanvasHeight(canvasId, 280);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels: rows.map(r => r.label),
      datasets: [
        { label: 'NSE %', data: rows.map(r => r[nseKey]), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'BSE %', data: rows.map(r => r[bseKey]), borderColor: MS_META.bse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.raw.toFixed(1) + ' %' } } },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: CHART_FONT.tick } } },
        y: { min: 0, max: 100, ticks: { callback: v => v + ' %' } },
      }
    }
  });
}

// Renders the predictor chart: 5D-smoothed NSE share history, both fitted trend lines drawn over
// their own windows, and the chosen model's line extended 3/6/12 months into the future.
function chartOptionsSharePredictor(canvasId, predictor) {
  if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
  if (!predictor) return;
  const { smoothed, longFit, recentFit, chosenFit } = predictor;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  setCanvasHeight(canvasId, 300);

  const TRADING_DAYS_PER_MONTH = 21;
  const historyLabels = smoothed.map(r => fmtChartDate(r.date));
  const futureLabels = ['+3M', '+6M', '+12M'];
  const labels = historyLabels.concat(futureLabels);
  const pad = arr => arr.concat(new Array(futureLabels.length).fill(null));

  function overlaySeries(fit) {
    const n = smoothed.length;
    const arr = new Array(n).fill(null);
    const offset = n - fit.rows.length;
    fit.rows.forEach((_, i) => { arr[offset + i] = fit.ols.slope * i + fit.ols.intercept; });
    return pad(arr);
  }

  const lastIndexInChosen = chosenFit.rows.length - 1;
  const futurePoints = [3, 6, 12].map(m => {
    const idx = lastIndexInChosen + m * TRADING_DAYS_PER_MONTH;
    return Math.max(0, Math.min(100, chosenFit.ols.slope * idx + chosenFit.ols.intercept));
  });
  const projectionSeries = new Array(historyLabels.length - 1).fill(null)
    .concat([smoothed[smoothed.length - 1].share], futurePoints);

  charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'NSE Options Share (5D avg)', data: pad(smoothed.map(r => r.share)), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.15 },
        { label: 'Long-Term Trend (252D)', data: overlaySeries(longFit), borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
        { label: 'Recent Trend (60D)', data: overlaySeries(recentFit), borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
        { label: 'Projection', data: projectionSeries, borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, borderDash: [2, 2], pointRadius: 2 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.raw == null ? '—' : ctx.raw.toFixed(1) + ' %') } } },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: CHART_FONT.tick } } },
        y: { min: 0, max: 100, ticks: { callback: v => v + ' %' } },
      }
    }
  });
}

function fmtRatePerMonth(v) {
  const sign = v > 0.001 ? '+' : v < -0.001 ? '−' : '';
  return sign + Math.abs(v).toFixed(2) + ' pp/mo';
}

// Builds the KPI row + trend-comparison table + chart panel + projection table for the predictor.
function optionsSharePredictorHTML(predictor) {
  if (!predictor) {
    return `<div class="chart-panel" style="text-align:center;padding:40px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600">Not enough overlapping history to fit an options-share trend</div>
    </div>`;
  }
  const { longFit, recentFit, chosen, reason, chosenFit, currentShare, asOfDate, projections } = predictor;
  const rateSentiment = chosenFit.ratePerMonth > 0.05 ? 'positive' : chosenFit.ratePerMonth < -0.05 ? 'negative' : '';
  const chosenLabel = chosen === 'recent' ? 'Recent (60D)' : 'Long-Term (252D)';

  const kpiHTML = `
  <div class="share-kpi-grid">
    ${kpi('Current NSE Options Share', fmtNum(currentShare, 1) + ' %', 'as of ' + asOfDate + ' (5D avg)', '')}
    ${kpi('Rate of Change (NSE)', fmtRatePerMonth(chosenFit.ratePerMonth), chosenLabel + ' · ' + chosenFit.fit + ' fit (R²=' + Math.round(chosenFit.ols.r2 * 100) + '%)', rateSentiment)}
    ${kpi('12M Projected NSE Share', fmtNum(projections[2].nseShare, 1) + ' %', 'assumes trend continues, capped 0–100%', '')}
    ${kpi('Model Selected', chosenLabel, reason, '')}
  </div>`;

  const fitRow = (label, fit, isChosen) => `
    <tr${isChosen ? '' : ' style="color:var(--color-text-muted)"'}>
      <td>${label} <span style="font-size:11px;color:var(--color-text-muted)">${isChosen ? '(used)' : '(informational)'}</span></td>
      <td style="text-align:center">${fit.startDate} → ${fit.endDate}</td>
      <td style="text-align:center">${fmtRatePerMonth(fit.ratePerMonth)}</td>
      <td style="text-align:center">${Math.round(fit.ols.r2 * 100)}%</td>
      <td style="text-align:center">${fit.fit}</td>
    </tr>`;

  const tableHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:0">
    <div class="chart-title">Trend Comparison — Long-Term vs Recent</div>
    <div class="table-scroll">
    <table class="data-table" style="margin:0">
      <thead><tr><th>Window</th><th style="text-align:center">Date Range</th><th style="text-align:center">Rate (NSE)</th><th style="text-align:center">R²</th><th style="text-align:center">Fit</th></tr></thead>
      <tbody>
        ${fitRow('Long-Term (252D, ~1yr)', longFit, chosen === 'long')}
        ${fitRow('Recent (60D, ~3mo)', recentFit, chosen === 'recent')}
      </tbody>
    </table>
    </div>
  </div>`;

  const chartHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">Options Share Predictor — NSE vs BSE</div>
    <div class="chart-wrapper"><canvas id="chartOptionsSharePredictor"></canvas></div>
  </div>`;

  const projRows = projections.map(p => `
    <tr>
      <td>+${p.months} Months</td>
      <td style="text-align:center">${fmtNum(p.nseShare, 1)} %</td>
      <td style="text-align:center">${fmtNum(100 - p.nseShare, 1)} %</td>
    </tr>`).join('');

  const projHTML = `
  <div class="chart-panel" style="padding:0">
    <div class="chart-title">Forward Projection</div>
    <div class="table-scroll">
    <table class="data-table" style="margin:0">
      <thead><tr><th>Horizon</th><th style="text-align:center">NSE Share</th><th style="text-align:center">BSE Share</th></tr></thead>
      <tbody>${projRows}</tbody>
    </table>
    </div>
    <p class="section-desc" style="padding:10px 14px 14px">Linear extrapolation of the ${chosen === 'recent' ? 'recent (60-day)' : 'long-term (252-day)'} trend; assumes no regime change; clipped to 0–100%.</p>
  </div>`;

  return kpiHTML + tableHTML + chartHTML + projHTML;
}

// Caption under a share-trend chart naming the months whose NSE or BSE revenue
// (date-effective files only) uses a slab-era flat estimate or a provisional
// BSE cash rate, as runs of consecutive months. '' when there are none.
function marketShareFlagNote(nseRaw, bseRaw, segKey) {
  const bseByMonth = new Map((bseRaw?.monthly || []).map(m => [m.month, m]));
  const months = (nseRaw?.monthly || []).filter(n => bseByMonth.has(n.month))
    .map(n => ({ label: n.month, f: mergeFlags([periodFlags(n, segKey), periodFlags(bseByMonth.get(n.month), segKey)]) }));
  const runs = kind => {
    const out = [];
    months.forEach((m, i) => {
      if (!m.f[kind]) return;
      if (i > 0 && months[i - 1].f[kind]) out[out.length - 1].to = m.label;
      else out.push({ from: m.label, to: m.label });
    });
    return out.map(r => r.from === r.to ? r.from : `${r.from} – ${r.to}`).join(', ');
  };
  const parts = [];
  const slab = runs('slab'), prov = runs('prov');
  if (slab) parts.push(`${flagTags({ slab: true })} ${slab}: slab-era flat fee estimates`);
  if (prov) parts.push(`${flagTags({ prov: true })} ${prov}: provisional BSE cash rate`);
  return parts.length ? `<p class="fee-chart-note">${parts.join('; ')}.</p>` : '';
}

function buildMarketShareTrend() {
  const el = document.getElementById('marketShareTrendContent');
  if (!el) return;

  const nseRaw = MARKET_RAW.nse, bseRaw = MARKET_RAW.bse;
  if (!getMarketShareRows(nseRaw, bseRaw, 'monthly').length) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:40px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600">No overlapping NSE/BSE data available</div>
    </div>`;
    return;
  }

  const toggleHTML = prefix => `<div class="share-range-toggle">${MS_GRANULARITIES.map(g =>
    `<button class="share-range-btn ${prefix}-gran-btn${g.key === 'monthly' ? ' active' : ''}" data-gran="${g.key}">${g.label}</button>`
  ).join('')}</div>`;

  const predictor = computeOptionsSharePredictor(nseRaw, bseRaw);
  // Fee-basis estimates inside the trend fit's window (date-effective files only)
  const predFlags = predictor
    ? mergeFlags([nseRaw, bseRaw].map(raw => rowsFlags((raw?.daily_all || []).filter(r => r.date >= predictor.chosenFit.startDate), 'options')))
    : NO_FLAGS;

  el.innerHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Options Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msOpt')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsOptions"></canvas></div>
    ${marketShareFlagNote(nseRaw, bseRaw, 'options')}
  </div>
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Total Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msTotal')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsTotal"></canvas></div>
    ${marketShareFlagNote(nseRaw, bseRaw, 'total')}
  </div>
  <h3 style="margin:0 0 var(--space-3);font-size:var(--text-lg);font-weight:700;color:var(--color-text)">Options Share Predictor${flagTags(predFlags)}</h3>
  ${optionsSharePredictorHTML(predictor)}`;

  let optGran = 'monthly', totalGran = 'monthly';
  const refreshOpt   = () => buildMarketShareChart('chartMsOptions', getMarketShareRows(nseRaw, bseRaw, optGran), 'opt');
  const refreshTotal = () => buildMarketShareChart('chartMsTotal',   getMarketShareRows(nseRaw, bseRaw, totalGran), 'total');
  refreshOpt();
  refreshTotal();
  chartOptionsSharePredictor('chartOptionsSharePredictor', predictor);

  el.querySelectorAll('.msOpt-gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.msOpt-gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      optGran = btn.dataset.gran;
      refreshOpt();
    });
  });
  el.querySelectorAll('.msTotal-gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.msTotal-gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      totalGran = btn.dataset.gran;
      refreshTotal();
    });
  });
}

// Off-screen chart-to-image rendering for the downloadable reports (mirrors buildAllRegressionChartImgs)
// Reports use the monthly view — smooth and compact, matching a periodic snapshot.
function buildMarketShareChartImgs(nseRaw, bseRaw) {
  const rows = buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw);
  if (!rows.length) return [];

  const mkDef = (label, nseKey, bseKey) => ({
    label, w: 700, h: 300,
    config: {
      type: 'line',
      data: {
        labels: rows.map(r => r.label),
        datasets: [
          { label: 'NSE %', data: rows.map(r => r[nseKey]), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'BSE %', data: rows.map(r => r[bseKey]), borderColor: MS_META.bse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        ]
      },
      options: {
        animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
        scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } }, y: { min: 0, max: 100, ticks: { callback: v => v + ' %', font: { size: 9 } } } }
      }
    }
  });

  const defs = [
    mkDef('Options Revenue Market Share — NSE vs BSE (Monthly)', 'optShareNSE', 'optShareBSE'),
    mkDef('Total Revenue Market Share — NSE vs BSE (Monthly)', 'totalShareNSE', 'totalShareBSE'),
  ];

  return defs.map(def => {
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

