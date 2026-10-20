// dashboard/js/11-market-share.js — NSE+BSE Market Share Trend tab.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// NSE vs BSE MARKET SHARE TREND (Options + Total, live chart + report)
// ========================

// Each exchange's expiry days per fy_month, for the share tooltips
function expiryDaysByMonth(raw, exchange) {
  const daily = raw?.daily_all || [];
  const set = expiryDateSet(daily, exchange);
  const out = new Map();
  daily.forEach(r => { if (set.has(r.date)) out.set(r.fy_month, (out.get(r.fy_month) || 0) + 1); });
  return out;
}

// Monthly NSE-vs-BSE market share — one point per calendar month (smooth, low-noise default view)
function buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw) {
  const nseM = nseRaw?.monthly || [];
  const bseByMonth = new Map((bseRaw?.monthly || []).map(m => [m.month, m]));
  const nseExp = expiryDaysByMonth(nseRaw, 'nse'), bseExp = expiryDaysByMonth(bseRaw, 'bse');
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
      nseExp: nseExp.get(n.month) || 0,
      bseExp: bseExp.get(n.month) || 0,
    });
  });
  return rows;
}

// Rolling N-day NSE-vs-BSE market share — daily granularity smoothed by a trailing window,
// so the line reads as a trend rather than a dense daily zigzag.
function buildNSEBSERollingShareSeries(nseRaw, bseRaw, windowSize) {
  const nseDaily = (nseRaw?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const bseByDate = new Map((bseRaw?.daily_all || []).map(r => [r.date, r]));
  const nseExpDates = expiryDateSet(nseRaw?.daily_all || [], 'nse');
  const bseExpDates = expiryDateSet(bseRaw?.daily_all || [], 'bse');
  const merged = [];
  nseDaily.forEach(n => {
    const b = bseByDate.get(n.date);
    if (!b) return;
    merged.push({
      date: n.date,
      nseTotalRev: n.total_rev || 0, bseTotalRev: b.total_rev || 0,
      nseOptRev:   n.opt_rev   || 0, bseOptRev:   b.opt_rev   || 0,
      nseIsExp: nseExpDates.has(n.date) ? 1 : 0, bseIsExp: bseExpDates.has(n.date) ? 1 : 0,
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
      nseExp: slice.reduce((s, x) => s + x.nseIsExp, 0),
      bseExp: slice.reduce((s, x) => s + x.bseIsExp, 0),
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

// Tooltip footer: each exchange's expiry days behind a share point
function expiryTooltipFooter(row) {
  if (!row || row.nseExp == null || row.bseExp == null) return '';
  return `Expiries: NSE ${row.nseExp} · BSE ${row.bseExp}` + (row.nseExp !== row.bseExp ? ' — counts differ' : '');
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
      plugins: { tooltip: { footerColor: getTooltipText(), callbacks: {
        label: ctx => ctx.dataset.label + ': ' + ctx.raw.toFixed(1) + ' %',
        footer: items => expiryTooltipFooter(rows[items[0]?.dataIndex]),
      } } },
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

// ── NSE vs BSE daily-avg revenue by period, with each exchange's expiry days ──
// NSE and BSE expire on different weekdays, so a period can hold one more
// expiry for one of them; the bars show both averages and the labels the counts.
const EXP_TREND_GRANULARITIES = [
  { key: 'monthly',   label: 'Monthly',   last: 24 },
  { key: 'quarterly', label: 'Quarterly', last: 16 },
  { key: 'weekly',    label: 'Weekly',    last: 26 },
];
const EXP_TREND_SEGMENTS = [
  { key: 'total',   label: 'Total' },
  { key: 'options', label: 'Options' },
];

// Monday of the Mon–Sun week holding a 'YYYY-MM-DD' date
function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

// Last calendar day of the period holding dateStr: month or quarter end (FY
// quarters end with calendar quarters), or that week's Friday
function periodEndDate(gran, dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (gran === 'weekly') {
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() + 6) % 7);
    return d.toISOString().slice(0, 10);
  }
  const m = d.getUTCMonth();
  const endMonth = gran === 'quarterly' ? m - (m % 3) + 2 : m;
  return new Date(Date.UTC(d.getUTCFullYear(), endMonth + 1, 0)).toISOString().slice(0, 10);
}

// One row per period both exchanges traded in, oldest first, the last N of the
// granularity: { key, label, partial, nse, bse }, each side { avg (₹ Cr/day of
// the segment), days, expiries, flags }. The latest period is `partial` while
// the data stops before its calendar end.
function buildExpiryTrendSeries(nseRaw, bseRaw, gran, segKey) {
  const g = EXP_TREND_GRANULARITIES.find(x => x.key === gran) || EXP_TREND_GRANULARITIES[0];
  const field = getRevFieldObj(segKey).dField;
  const keyOf = r => g.key === 'quarterly' ? r.fy_quarter : g.key === 'weekly' ? weekStartOf(r.date) : r.fy_month;
  const buckets = (raw, exchange) => {
    const daily = raw?.daily_all || [];
    const expDates = expiryDateSet(daily, exchange);
    const out = new Map();
    daily.forEach(r => {
      const k = keyOf(r);
      if (!out.has(k)) out.set(k, { rev: 0, days: 0, expiries: 0, rows: [], first: r.date, last: r.date });
      const b = out.get(k);
      b.rev += r[field] || 0;
      b.days += 1;
      if (expDates.has(r.date)) b.expiries += 1;
      b.rows.push(r);
      if (r.date < b.first) b.first = r.date;
      if (r.date > b.last) b.last = r.date;
    });
    return out;
  };
  const nse = buckets(nseRaw, 'nse'), bse = buckets(bseRaw, 'bse');
  const sortKey = k => g.key === 'quarterly' ? quarterSortKey(k) : g.key === 'monthly' ? monthSortKey(k) : k;
  const keys = [...nse.keys()].filter(k => bse.has(k))
    .sort((a, b) => { const x = sortKey(a), y = sortKey(b); return x < y ? -1 : x > y ? 1 : 0; })
    .slice(-g.last);

  const side = b => ({ avg: b.days ? b.rev / b.days : 0, days: b.days, expiries: b.expiries, flags: rowsFlags(b.rows, segKey) });
  return keys.map((k, i) => {
    const n = nse.get(k), b = bse.get(k);
    const first = n.first < b.first ? n.first : b.first;
    const last = n.last > b.last ? n.last : b.last;
    const label = g.key === 'quarterly' ? k
      : g.key === 'weekly' ? `w/c ${+k.slice(8, 10)} ${MONTHS_SHORT[+k.slice(5, 7) - 1]}`
      : `${MONTHS_SHORT[+first.slice(5, 7) - 1]} ${first.slice(0, 4)}`;
    return { key: k, label, partial: i === keys.length - 1 && last < periodEndDate(g.key, first), nse: side(n), bse: side(b) };
  });
}

function buildExpiryTrendChart(canvasId, rows) {
  if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
  const canvas = document.getElementById(canvasId);
  if (!canvas || !rows.length) return;
  setCanvasHeight(canvasId, 300);
  const differ = rows.map(r => r.nse.expiries !== r.bse.expiries);
  const warn = getComputedStyle(document.documentElement).getPropertyValue('--color-warning').trim() || '#A56000';
  const expiryWord = n => n === 1 ? 'expiry' : 'expiries';
  charts[canvasId] = new Chart(canvas, {
    type: 'bar',
    data: {
      // Second line: expiry days, "≠" (and amber) where NSE and BSE differ
      labels: rows.map((r, i) => [r.label + (r.partial ? '*' : ''), `N${r.nse.expiries}${differ[i] ? '≠' : '·'}B${r.bse.expiries}`]),
      datasets: [
        { label: 'NSE', data: rows.map(r => r.nse.avg), backgroundColor: MS_META.nse.color, borderRadius: 2 },
        { label: 'BSE', data: rows.map(r => r.bse.avg), backgroundColor: MS_META.bse.color, borderRadius: 2 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { footerColor: warn, callbacks: {
        title: items => { const r = rows[items[0].dataIndex]; return r.label + (r.partial ? ' (to date)' : ''); },
        label: ctx => {
          const s = rows[ctx.dataIndex][ctx.datasetIndex === 0 ? 'nse' : 'bse'];
          return `${ctx.dataset.label}: ₹${fmtNum(s.avg, 2)} Cr/day · ${s.days} days · ${s.expiries} ${expiryWord(s.expiries)}`;
        },
        footer: items => differ[items[0].dataIndex] ? 'Expiry counts differ — daily averages are not like for like' : '',
      } } },
      scales: {
        x: { ticks: { maxRotation: 0, font: { size: CHART_FONT.tick }, color: ctx => differ[ctx.index] ? warn : getTickColor() } },
        y: { beginAtZero: true, ticks: { callback: v => '₹' + v } },
      }
    }
  });
}

// The chart's rows as a table, newest first
function expiryTrendTableHTML(rows) {
  const body = rows.slice().reverse().map(r => {
    const total = r.nse.avg + r.bse.avg;
    const days = r.nse.days === r.bse.days ? r.nse.days : `${r.nse.days} / ${r.bse.days}`;
    const exp = expiryCountHTML([
      { exchange: 'nse', expiries: r.nse.expiries, days: r.nse.days },
      { exchange: 'bse', expiries: r.bse.expiries, days: r.bse.days },
    ]);
    return `<tr${r.nse.expiries !== r.bse.expiries ? ' class="exp-diff-row"' : ''}>
      <td>${r.label}${r.partial ? ' <span class="exp-partial">to date</span>' : ''}</td>
      <td style="text-align:right">${fmtNum(r.nse.avg, 2)}${flagTags(r.nse.flags)}</td>
      <td style="text-align:right">${fmtNum(r.bse.avg, 2)}${flagTags(r.bse.flags)}</td>
      <td style="text-align:right">${total > 0 ? fmtNum(r.nse.avg / total * 100, 1) + ' %' : '—'}</td>
      <td style="text-align:center">${days}</td>
      <td style="text-align:center">${exp}</td>
    </tr>`;
  }).join('');
  return `<div class="table-scroll exp-trend-table">
    <table class="data-table" style="margin:0">
      <thead><tr><th>Period</th><th style="text-align:right">NSE ₹ Cr/day</th><th style="text-align:right">BSE ₹ Cr/day</th><th style="text-align:right">NSE share</th><th style="text-align:center" title="Trading days (NSE / BSE when they differ)">Days</th><th style="text-align:center" title="Expiry days: N = NSE, B = BSE">Expiries</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
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

  const expToggleHTML = (cls, opts, active) => `<div class="share-range-toggle">${opts.map(o =>
    `<button class="share-range-btn ${cls}${o.key === active ? ' active' : ''}" data-key="${o.key}">${o.label}</button>`
  ).join('')}</div>`;

  el.innerHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Daily Avg Revenue &amp; Expiries — NSE vs BSE</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
        ${expToggleHTML('expGran-btn', EXP_TREND_GRANULARITIES, 'monthly')}
        ${expToggleHTML('expSeg-btn', EXP_TREND_SEGMENTS, 'total')}
      </div>
    </div>
    <div class="chart-wrapper"><canvas id="chartExpTrend"></canvas></div>
    <p class="fee-chart-note">₹ Cr per trading day. Under each period, its expiry days (N = NSE, B = BSE: each exchange's weekly index expiry); ≠ and amber mark periods where they differ, so the two averages are not like for like. * = period to date.</p>
    <div id="expTrendTable"></div>
  </div>
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

  let expGran = 'monthly', expSeg = 'total';
  const refreshExp = () => {
    const rows = buildExpiryTrendSeries(nseRaw, bseRaw, expGran, expSeg);
    buildExpiryTrendChart('chartExpTrend', rows);
    const tableEl = el.querySelector('#expTrendTable');
    if (tableEl) tableEl.innerHTML = expiryTrendTableHTML(rows);
  };
  refreshExp();
  [['.expGran-btn', k => { expGran = k; }], ['.expSeg-btn', k => { expSeg = k; }]].forEach(([sel, set]) => {
    el.querySelectorAll(sel).forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll(sel).forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        set(btn.dataset.key);
        refreshExp();
      });
    });
  });

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
