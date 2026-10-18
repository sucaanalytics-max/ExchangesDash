// dashboard/js/12-revenue-predictor.js — Revenue Predictor tab and the NSE default forecast.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// NSE: TEMPORAL ANALYSIS
// ========================

function buildNSETemporalCharts() {
  // Day-of-week
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const dowData = days.map(d => (DATA.dow_avg || {})[d] || { avg_total: 0, avg_options: 0, avg_futures: 0, avg_cash: 0 });

  setCanvasHeight('chartDOW', 280);
  charts.dow = new Chart(document.getElementById('chartDOW'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        { label: 'Options', data: dowData.map(x => x.avg_options), backgroundColor: CHART_COLORS[0], stack: 's', borderRadius: 2 },
        { label: 'Futures', data: dowData.map(x => x.avg_futures), backgroundColor: CHART_COLORS[1], stack: 's', borderRadius: 2 },
        { label: 'Cash', data: dowData.map(x => x.avg_cash), backgroundColor: CHART_COLORS[3], stack: 's', borderRadius: 2 },
      ]
    },
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw),
            footer: items => 'Total Avg: ' + fmt(items.reduce((s, i) => s + i.raw, 0))
          }
        }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Monthly revenue
  const m = DATA.monthly;
  setCanvasHeight('chartMonthlyRev', 280);
  charts.monthlyRev = new Chart(document.getElementById('chartMonthlyRev'), {
    type: 'line',
    data: {
      labels: m.map(x => x.month),
      datasets: [{
        label: 'Monthly Revenue',
        data: m.map(x => x.total_rev),
        borderColor: CHART_COLORS[0],
        backgroundColor: CHART_COLORS[0] + '15',
        fill: true,
        pointRadius: 2,
      }]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 18, maxRotation: 45, font: { size: CHART_FONT.tick } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Daily with 10-day MA
  const d = DATA.daily;
  const dailyLabels = d.map(x => {
    const dt = new Date(x.date);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  const dailyRev = d.map(x => x.total_rev);
  const ma10 = dailyRev.map((_, i) => {
    if (i < 9) return null;
    let sum = 0;
    for (let j = i - 9; j <= i; j++) sum += dailyRev[j];
    return sum / 10;
  });

  setCanvasHeight('chartDailyMA', 280);
  charts.dailyMA = new Chart(document.getElementById('chartDailyMA'), {
    type: 'line',
    data: {
      labels: dailyLabels,
      datasets: [
        { label: 'Daily Revenue', data: dailyRev, borderColor: CHART_COLORS[0] + '60', borderWidth: 1, pointRadius: 1 },
        { label: '10-day MA', data: ma10, borderColor: CHART_COLORS[5], borderWidth: 2.5 },
      ]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 15, font: { size: CHART_FONT.tick } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });

  // Quarterly table
  buildNSEQuarterlyTable();
}

// ========================
// NSE: QUARTER COMPARISON
// ========================

function initNSEQuarterCompare() {
  const quarters = [...new Set(DATA.daily.map(d => d.fy_quarter))];
  const sel1 = document.getElementById('qtrSelect1');
  const sel2 = document.getElementById('qtrSelect2');
  sel1.innerHTML = '';
  sel2.innerHTML = '<option value="">None</option>';

  const reversedQ = [...quarters].reverse();
  reversedQ.forEach(q => {
    sel1.innerHTML += `<option value="${q}">${q}</option>`;
    sel2.innerHTML += `<option value="${q}">${q}</option>`;
  });
  sel1.value = reversedQ[0];

  function renderQtrCompare() {
    if (charts.qtrCompare) charts.qtrCompare.destroy();
    const q1 = sel1.value;
    const q2 = sel2.value;
    if (!q1) return;

    const q1Data = DATA.daily.filter(d => d.fy_quarter === q1);
    const maxDays = q1Data.length;
    const labels = q1Data.map((_, i) => 'Day ' + (i + 1));
    const datasets = [{
      label: q1,
      data: q1Data.map(d => d.total_rev),
      borderColor: CHART_COLORS[0],
      backgroundColor: CHART_COLORS[0] + '15',
      fill: true, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
    }];

    if (q2) {
      const q2Data = DATA.daily.filter(d => d.fy_quarter === q2);
      if (q2Data.length > maxDays) {
        for (let i = maxDays; i < q2Data.length; i++) labels.push('Day ' + (i + 1));
      }
      datasets.push({
        label: q2,
        data: q2Data.map(d => d.total_rev),
        borderColor: CHART_COLORS[1],
        backgroundColor: CHART_COLORS[1] + '15',
        fill: true, borderWidth: 2, borderDash: [5, 3], pointRadius: 2, pointHoverRadius: 5,
      });
    }

    charts.qtrCompare = new Chart(document.getElementById('chartQtrCompare'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              title: items => items[0].label,
              label: ctx => {
                const qData = ctx.dataset.label === q1
                  ? DATA.daily.filter(d => d.fy_quarter === q1)
                  : DATA.daily.filter(d => d.fy_quarter === q2);
                const actualDate = qData[ctx.dataIndex] ? qData[ctx.dataIndex].date : '';
                return ctx.dataset.label + ': ' + fmt(ctx.raw) + (actualDate ? ' (' + actualDate + ')' : '');
              }
            }
          }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 20, font: { size: CHART_FONT.tick } } },
          y: { ticks: { callback: v => '\u20b9' + fmtNum(v, 0) + ' Cr' } }
        }
      }
    });
  }

  sel1.addEventListener('change', renderQtrCompare);
  sel2.addEventListener('change', renderQtrCompare);
  renderQtrCompare();
}

// ========================
// NSE: DEFAULT FORECAST (pipeline ratio model)
// ========================
// One default forecast: the pipeline's ratio model (ENRICHED_DATA
// .pnl_forecast_model / .pnl_predicted_quarters / .pnl_predictor), which the
// Revenue Predictor's Base scenario reproduces; manual nse_pnl forecast rows are
// labelled as such. EBITDA there is operating EBITDA (nse_pnl rows:
// ENRICHED_DATA.pnl_operating). An enriched file written before these fields
// existed has no P&L on the predictor, only revenue.

const NSE_EBITDA_DEF = 'Operating EBITDA = revenue from operations − operating expenses, before depreciation, excluding other (non-operating) income.';
const NSE_ONE_OFF_LABELS = { sebi_settlement: 'SEBI settlement' };

function nseForecastModel() {
  const m = ENRICHED_DATA.pnl_forecast_model;
  return m && m.name ? m : null;
}

function nseQuarterRange(qs) {
  return qs.length > 1 ? `${qs[0]} – ${qs[qs.length - 1]}` : (qs[0] || '');
}

function nseOneOffText(oneOffs) {
  return Object.entries(oneOffs || {})
    .map(([k, v]) => `${NSE_ONE_OFF_LABELS[k] || k.replace(/_/g, ' ')} ${fmt(v, 0)}`).join(', ');
}

// nse_pnl quarters that have ended (before the quarter now trading) but are
// still manual forecasts because their actuals have not been entered.
function nsePendingActualQuarters() {
  const q = DATA.quarterly || [];
  const cq = ENRICHED_DATA.pnl_predictor?.quarter || (q.length ? q[q.length - 1].quarter : null);
  if (!cq) return [];
  return (DATA.pnl || []).filter(r => r.is_predicted && quarterSortKey(r.quarter) < quarterSortKey(cq)).map(r => r.quarter);
}

// ========================
// NSE: ADVANCED ANALYTICS
// ========================

function buildNSEAdvancedCharts() {
  const d = DATA.daily;
  const hasVix = d.some(x => x.vix > 0);
  const labels = d.map(x => {
    const dt = new Date(x.date);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });

  // PN ratio vs VIX
  setCanvasHeight('chartPNVix', 300);
  if (hasVix) {
    charts.pnVix = new Chart(document.getElementById('chartPNVix'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'P/N Ratio (bps)',
            data: d.map(x => x.pn_ratio * 10000),
            borderColor: CHART_COLORS[0],
            yAxisID: 'y1',
            borderWidth: 1.5,
            pointRadius: 1,
          },
          {
            label: 'India VIX',
            data: d.map(x => x.vix),
            borderColor: CHART_COLORS[5],
            yAxisID: 'y2',
            borderWidth: 2,
            borderDash: [4, 3],
            pointRadius: 0,
          },
        ]
      },
      options: {
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { size: CHART_FONT.tick } } },
          y1: { position: 'left', title: { display: true, text: 'P/N Ratio (bps)', color: CHART_COLORS[0], font: { size: CHART_FONT.title } } },
          y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'India VIX', color: CHART_COLORS[5], font: { size: CHART_FONT.title } } },
        }
      }
    });
  }

  // Scatter
  setCanvasHeight('chartScatter', 300);
  if (hasVix) {
    charts.scatter = new Chart(document.getElementById('chartScatter'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Daily Revenue vs VIX',
          data: d.map(x => ({ x: x.vix, y: x.total_rev })),
          backgroundColor: CHART_COLORS[0] + '80',
          pointRadius: 4,
          pointHoverRadius: 6,
        }]
      },
      options: {
        scales: {
          x: { title: { display: true, text: 'India VIX', font: { size: CHART_FONT.title } }, ticks: { font: { size: CHART_FONT.tick } } },
          y: { title: { display: true, text: 'Total Revenue (₹ Cr)', font: { size: CHART_FONT.title } }, ticks: { callback: v => '₹' + fmtNum(v, 0) } },
        },
        plugins: {
          tooltip: { callbacks: { label: ctx => 'VIX: ' + fmtNum(ctx.raw.x, 1) + ', Rev: ' + fmt(ctx.raw.y) } }
        }
      }
    });
  }

  // Contracts vs Revenue
  setCanvasHeight('chartContracts', 300);
  charts.contracts = new Chart(document.getElementById('chartContracts'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Revenue',
          data: d.map(x => x.total_rev),
          borderColor: CHART_COLORS[0],
          yAxisID: 'y1',
          borderWidth: 1.5,
        },
        {
          label: 'Contracts (Mn)',
          data: d.map(x => x.total_contracts / 1e6),
          borderColor: CHART_COLORS[4],
          yAxisID: 'y2',
          borderWidth: 1.5,
          borderDash: [4, 3],
        },
      ]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: CHART_FONT.tick } } },
        y1: { position: 'left', title: { display: true, text: 'Revenue (₹ Cr)', color: CHART_COLORS[0], font: { size: CHART_FONT.title } } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Contracts (Mn)', color: CHART_COLORS[4], font: { size: CHART_FONT.title } } },
      }
    }
  });

  buildHeatmap();
}

function buildHeatmap() {
  const q = DATA.quarterly;
  const fys = {};
  q.forEach(item => {
    const parts = item.quarter.split(' ');
    const qNum = parts[0];
    const fy = parts[1] + ' ' + parts[2];
    if (!fys[fy]) fys[fy] = {};
    fys[fy][qNum] = item;
  });

  const allVals = q.map(x => x.total_rev);
  const minRev = Math.min(...allVals);
  const maxRev = Math.max(...allVals);
  const rgb = getHeatmapRgb();

  let html = '<table class="data-table"><thead><tr><th>FY</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr></thead><tbody>';
  Object.keys(fys).forEach(fy => {
    html += `<tr><td>${fy}</td>`;
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(qn => {
      const item = fys[fy][qn];
      if (item) {
        const intensity = (item.total_rev - minRev) / (maxRev - minRev);
        const bg = `rgba(${rgb}, ${(0.1 + intensity * 0.5).toFixed(2)})`;
        html += `<td style="background:${bg};font-weight:600">${fmt(item.total_rev)}</td>`;
      } else {
        html += `<td style="color:var(--color-text-faint)">—</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('heatmapContainer').innerHTML = html;
}

// ========================
// REVENUE PREDICTOR TAB — one scenario model per exchange
// ========================
// The quarter's transaction revenue = revenue banked so far + daily revenue
// for the sessions left × those sessions. With the daily inputs at their
// quarter-to-date averages (the Base preset) that equals the pipeline's
// extrapolation (pnl_predictor), and for NSE the P&L below it reproduces the
// pipeline's default ratio-model forecast line for line. Bear / Bull scale the
// rest-of-quarter daily revenue ±15 %. NSE carries the ratio model to PAT and
// EPS; BSE uses the Excel "Quarterly Predictor" (other income and PAT margin);
// MCX stops at revenue (no MCX P&L inputs in this repo).

const PREDICTOR_SEGMENTS = { nse: ['opt', 'fut', 'cash'], bse: ['opt', 'fut', 'cash'], mcx: ['opt', 'fut'] };
const PREDICTOR_SEG_LABEL = { opt: 'Options', fut: 'Futures', cash: 'Cash' };
const PREDICTOR_PRESET_PCT = 15;
// Inputs show 2 decimals but hold full precision until edited, so the Base
// preset is the pipeline's figure to the rupee; a value within half the last
// shown digit of its default counts as unchanged.
const PREDICTOR_TOLERANCE = 0.005;
function predictorShown(x) { return +(+x).toFixed(2); }

// BSE Excel "Quarterly Predictor" starting values (other income ₹ Cr / quarter, PAT margin %)
const BSE_QTR_PNL_DEFAULTS = { oiQ: 472.16, margin: 50 };

// "Q3 FY 2027" shifted by n quarters ("Q2 FY 2027" for -1, "Q3 FY 2026" for -4)
function shiftQuarter(label, n) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  if (!m) return null;
  const idx = +m[2] * 4 + (+m[1] - 1) + n;
  return `Q${(idx % 4) + 1} FY ${Math.floor(idx / 4)}`;
}

// "Q2 FY 2026" … "Q3 FY 2026" → "Q2–Q3 FY26"
function shortQuarterRange(qs) {
  const s = q => { const m = /^Q([1-4]) FY \d{2}(\d{2})$/.exec(q || ''); return m ? { q: 'Q' + m[1], fy: 'FY' + m[2] } : null; };
  const a = s(qs[0]), b = s(qs[qs.length - 1]);
  if (!a || !b) return qs.join(', ');
  if (qs.length === 1) return `${a.q} ${a.fy}`;
  return a.fy === b.fy ? `${a.q}–${b.q} ${a.fy}` : `${a.q} ${a.fy}–${b.q} ${b.fy}`;
}

function predictorContext(ex) {
  const q = DATA.quarterly || [];
  const p = ENRICHED_DATA.pnl_predictor || {};
  const cqLabel = p.quarter || DATA.summary?.current_quarter || (q.length ? q[q.length - 1].quarter : null);
  const cq = q.find(r => r.quarter === cqLabel) || q[q.length - 1];
  if (!cq) return null;
  const segs = PREDICTOR_SEGMENTS[ex];
  const n = cq.days || cq.trading_days || 0;
  const banked = {};
  segs.forEach(k => { banked[k] = cq[k + '_rev'] || 0; });
  const bankedTotal = segs.reduce((s, k) => s + banked[k], 0);
  const adr = {};
  segs.forEach(k => { adr[k] = n ? banked[k] / n : 0; });
  const prev = q.find(r => r.quarter === shiftQuarter(cq.quarter, -1)) || null;
  const ly = q.find(r => r.quarter === shiftQuarter(cq.quarter, -4)) || null;
  const daily = (DATA.daily_all || DATA.daily || []).filter(r => r.fy_quarter === cq.quarter);
  return {
    ex, segs, cq, n, banked, bankedTotal, adr, prev, ly, daily,
    days: p.expected_trading_days || Math.max(n, 62),
    quarters: q,
  };
}

function predictorDefaults(ex, ctx) {
  const v = { days: ctx.days };
  ctx.segs.forEach(k => { v[k] = ctx.adr[k]; });
  const m = ex === 'nse' ? nseForecastModel() : null;
  if (m) Object.assign(v, {
    oor: m.other_operating_revenue_ratio * 100,
    oi: m.non_operating_income_ratio * 100,
    opex: m.operating_expense_ratio * 100,
    dep: m.depreciation_ratio * 100,
    assoc: +m.share_profit_associates,
    tax: m.tax_rate * 100,
    shares: SHARES_OUTSTANDING_CR.nse.value,
  });
  if (ex === 'bse') Object.assign(v, BSE_QTR_PNL_DEFAULTS, { shares: SHARES_OUTSTANDING_CR.bse.value });
  return v;
}

// Scenario P&L for input values `v` (ctx from predictorContext). The NSE branch
// is scripts/nse_pipeline.py's ratio model (build_entry) with editable ratios.
function predictorScenario(ex, ctx, v) {
  const rest = Math.max(v.days - ctx.n, 0);
  const seg = {};
  let txn = 0;
  ctx.segs.forEach(k => { seg[k] = ctx.banked[k] + v[k] * rest; txn += seg[k]; });
  const out = { seg, txn, rest, adr: v.days ? txn / v.days : 0, adrRest: ctx.segs.reduce((s, k) => s + v[k], 0) };
  if (ex === 'nse' && v.oor != null) {
    out.oorV = txn * v.oor / 100;
    out.op = txn + out.oorV;
    out.oi = txn * v.oi / 100;
    out.total = out.op + out.oi;
    out.opx = out.op * v.opex / 100;
    out.ebitda = out.op - out.opx;
    out.dep = out.op * v.dep / 100;
    out.assoc = v.assoc;
    out.pbt = out.ebitda - out.dep + out.oi + out.assoc;
    out.tax = out.pbt * v.tax / 100;
    out.pat = out.pbt - out.tax;
    out.eps = v.shares ? out.pat / v.shares : null;
  } else if (ex === 'bse') {
    out.oi = v.oiQ;
    out.total = txn + v.oiQ;
    out.pat = out.total * v.margin / 100;
    out.costs = out.total - out.pat;
    out.eps = v.shares ? out.pat / v.shares : null;
  }
  return out;
}

// Input rows of the assumptions panel, by group
function predictorFields(ex, ctx) {
  const rest = Math.max(ctx.days - ctx.n, 0);
  const groups = [{
    title: `Daily revenue for the ${rest} sessions left, ₹ Cr`,
    fields: ctx.segs.map(k => ({ key: k, label: PREDICTOR_SEG_LABEL[k], step: 0.1, tag: rxChip(`QTD avg · ${ctx.n} sessions`, 'data') })),
  }, {
    title: 'Quarter',
    fields: [{ key: 'days', label: 'Trading sessions in the quarter', step: 1, tag: rxChip('Pipeline estimate') }],
  }];
  const m = ex === 'nse' ? nseForecastModel() : null;
  if (m) {
    const base = shortQuarterRange(m.base_quarters || []);
    const taxQ = shortQuarterRange(m.tax_rate_quarters || []);
    groups.push({
      title: `Ratios · actual ${base}, one-offs excluded`,
      fields: [
        { key: 'oor', label: 'Other operating revenue, % of txn revenue', step: 0.1, tag: rxChip(base) },
        { key: 'oi', label: 'Other income, % of txn revenue', step: 0.1, tag: rxChip(base) },
        { key: 'opex', label: 'Operating expenses, % of operating revenue', step: 0.1, tag: rxChip(base) },
        { key: 'dep', label: 'Depreciation, % of operating revenue', step: 0.1, tag: rxChip(base) },
        { key: 'assoc', label: 'Share of associates, ₹ Cr', step: 0.5, tag: rxChip(base) },
        { key: 'tax', label: 'Tax rate, %', step: 0.1, tag: rxChip(`${taxQ} effective`) },
        { key: 'shares', label: 'Shares outstanding, Cr', step: 0.1, tag: sharesChip('nse') },
      ],
    });
  }
  if (ex === 'bse') groups.push({
    title: 'Excel “Quarterly Predictor”',
    fields: [
      { key: 'oiQ', label: 'Other income, ₹ Cr for the quarter', step: 1, tag: rxChip('Excel model') },
      { key: 'margin', label: 'PAT margin, % of total income', step: 0.5, tag: rxChip('Excel model') },
      { key: 'shares', label: 'Shares outstanding, Cr', step: 0.01, tag: sharesChip('bse') },
    ],
  });
  return groups;
}

// P&L rows for NSE: [label, key, row class]; ratio rows divide `key` by `base`
const NSE_PNL_ROWS = [
  ['Transaction revenue', 'txn'], ['Other operating revenue', 'oorV'], ['Operating revenue', 'op', 'rx-sub'],
  ['Other income', 'oi'], ['Total income', 'total', 'rx-sub'], ['Operating expenses', 'opx'],
  ['Operating EBITDA', 'ebitda', 'rx-sub'], ['EBITDA margin', 'ebitda', 'rx-pct', 'op'], ['Depreciation', 'dep'],
  ['Share of associates', 'assoc'], ['PBT', 'pbt', 'rx-sub'], ['Tax', 'tax'], ['PAT', 'pat', 'rx-sub'],
  ['PAT margin', 'pat', 'rx-pct', 'total'], ['EPS, ₹', 'eps', 'rx-sub'],
];

// Reported Q-year-ago P&L in the scenario's keys (null if not an actual quarter)
function nseActualPnl(quarter) {
  const r = (DATA.pnl || []).find(x => x.quarter === quarter && !x.is_predicted);
  if (!r) return null;
  const op = (ENRICHED_DATA.pnl_operating || []).find(x => x.quarter === quarter) || {};
  const opRev = op.operating_revenue;
  return {
    txn: r.transaction_rev, oorV: opRev != null ? opRev - r.transaction_rev : null, op: opRev,
    oi: op.non_operating_income, total: r.total_revenue, opx: op.operating_expenses, ebitda: op.operating_ebitda,
    dep: op.depreciation ?? r.depreciation, assoc: r.share_profit_associates, pbt: r.pbt, tax: r.income_tax,
    pat: r.pat, eps: r.eps, oneOffs: op.one_offs || {},
  };
}

// Pipeline default forecast for a quarter, in the scenario's keys
function nseDefaultPnl(quarter) {
  const f = ENRICHED_DATA.pnl_predicted_quarters?.[quarter];
  if (!f) return null;
  return {
    txn: f.transaction_rev, oorV: f.operating_revenue - f.transaction_rev, op: f.operating_revenue,
    oi: f.non_operating_income, total: f.total_revenue, opx: f.operating_expenses, ebitda: f.operating_ebitda,
    dep: f.depreciation, assoc: f.share_profit_associates, pbt: f.pbt, tax: f.income_tax, pat: f.pat, eps: f.eps,
  };
}

function buildRevenuePredictor(ex) {
  const el = document.getElementById(`${ex}PredictionContent`);
  if (!el) return;
  const ctx = predictorContext(ex);
  if (!ctx || !ctx.n) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Revenue predictor', body: '<div class="rx-empty"><b>No sessions in the current quarter yet</b>The predictor starts after the quarter’s first trading day.</div>' })}</div>`;
    return;
  }
  const name = SHARE_EXCHANGE_NAMES[ex];
  const model = ex === 'nse' ? nseForecastModel() : null;
  const hasPnl = (ex === 'nse' && !!model) || ex === 'bse';
  const defaults = predictorDefaults(ex, ctx);
  const v = { ...defaults };
  const cqL = ctx.cq.quarter;
  const nextL = shiftQuarter(cqL, 1);
  const lyL = shiftQuarter(cqL, -4);
  const prevL = shiftQuarter(cqL, -1);
  const cqFlags = periodFlags(ctx.cq, 'total');
  const lyModelled = ctx.ly && periodFlags(ctx.ly, 'total').modelled;
  const prevModelled = ctx.prev && periodFlags(ctx.prev, 'total').modelled;
  const groups = predictorFields(ex, ctx);
  const presets = { bear: 1 - PREDICTOR_PRESET_PCT / 100, base: 1, bull: 1 + PREDICTOR_PRESET_PCT / 100 };
  const lastDate = ctx.daily.length ? ctx.daily[ctx.daily.length - 1].date : DATA.summary?.last_date;

  // NSE: quarters that have ended but still hold manual forecasts in nse_pnl
  let staleHTML = '';
  if (ex === 'nse') {
    const pending = nsePendingActualQuarters();
    if (pending.length) {
      const last = pending[pending.length - 1];
      const manual = (DATA.pnl || []).find(r => r.quarter === last);
      const traded = ctx.quarters.find(r => r.quarter === last);
      const cmp = manual && traded && manual.transaction_rev
        ? ` ${last}’s manual forecast has transaction revenue ${rxCr(manual.transaction_rev, 0)}; trading data says ${rxCr(traded.total_rev, 0)}.` : '';
      const list = pending.length === 1 ? pending[0] : pending.slice(0, -1).join(', ') + ' and ' + last;
      staleHTML = rxAlert(`<strong>Ratios rest on ${model ? shortQuarterRange(model.base_quarters) : 'older quarters'}.</strong> ${list} ${pending.length === 1 ? 'has' : 'have'} ended but nse_pnl still holds manual forecasts for ${pending.length === 1 ? 'it' : 'them'}, so the default forecast cannot use ${pending.length === 1 ? 'its' : 'their'} actuals.${cmp}`);
    }
  }

  const fieldsHTML = groups.map(g => `<div class="rx-field-group"><span class="rx-lbl">${g.title}</span>${g.fields.map(f => `
      <div class="rx-field">
        <label for="rxPred-${ex}-${f.key}">${f.label}</label>
        <input class="rx-in" id="rxPred-${ex}-${f.key}" type="number" step="${f.step}" min="0" inputmode="decimal" data-key="${f.key}" value="${predictorShown(defaults[f.key])}">
        <div class="rx-tags" data-tags="${f.key}">${f.tag}</div>
      </div>`).join('')}</div>`).join('');

  const howNSE = model ? rxHow('How the default forecast works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left. At the quarter-to-date averages this is the pipeline’s extrapolation.</li>
      <li>Other operating revenue (${fmtPct(model.other_operating_revenue_ratio)}) and other income (${fmtPct(model.non_operating_income_ratio)}) scale with transaction revenue; operating expenses (${fmtPct(model.operating_expense_ratio)}) and depreciation (${fmtPct(model.depreciation_ratio)}) scale with operating revenue; associates ${rxCr(model.share_profit_associates)}; tax at the ${shortQuarterRange(model.tax_rate_quarters)} effective rate (${fmtPct(model.tax_rate)}).</li>
      <li>Ratios come from actual ${nseQuarterRange(model.base_quarters)}${Object.keys(model.one_offs_excluded || {}).length ? `, one-offs excluded (${Object.entries(model.one_offs_excluded).map(([q, o]) => `${nseOneOffText(o)} in ${q}`).join('; ')})` : ''}. Forecasts carry no one-offs.</li>
      <li>${nextL} grows transaction revenue at the current quarter’s year-on-year per-session rate. ${NSE_EBITDA_DEF}</li>
    </ul>`) : '';
  const howBSE = rxHow('How this estimate works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left (quarter-to-date averages by default).</li>
      <li>Other income and PAT margin are the starting values of the Excel “Quarterly Predictor”; BSE’s reported P&amp;L is not in this repo, so there are no actuals to compare against.</li>
      <li>BSE cash revenue for the latest quarter is at a provisional calibrated rate until BSE reports it (marked est.).</li>
    </ul>`);
  const howMCX = rxHow('How this estimate works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left (quarter-to-date averages by default).</li>
      <li>MCX stops at revenue: no MCX other-income or margin inputs are maintained here. MCX total revenue is futures + options; days before 2 Sep 2024 are modelled and left out of comparisons.</li>
    </ul>`);

  const pnlPanel = ex === 'nse' && model ? rxPanel({ cls: 'rx-col-wide', title: 'P&amp;L', meta: '₹ Cr · operating EBITDA excludes other income',
      right: rxLegend([{ label: 'Your scenario', color: '#EAF0FB', style: 'box-shadow:inset 0 0 0 1px #B9C9EE' }]),
      body: `<div class="rx-scroll"><table class="rx-table" data-rx="pnl"></table></div>`, foot: '<span data-rx="pnlFoot"></span>', how: howNSE })
    : ex === 'bse' ? rxPanel({ cls: 'rx-col-wide', title: 'Quarter P&amp;L', meta: '₹ Cr · Excel quarterly model',
      body: `<div class="rx-scroll"><table class="rx-table" data-rx="pnl"></table></div>`, how: howBSE })
    : rxPanel({ cls: 'rx-col-wide', title: 'Segments', meta: '₹ Cr', body: `<div class="rx-scroll"><table class="rx-table" data-rx="segs"></table></div>`, how: howMCX });
  const bridgePanel = hasPnl ? rxPanel({ cls: 'rx-col-narrow', title: 'Scenario bridge', meta: `${cqL}, ₹ Cr`,
      body: `<div class="rx-pb"><div class="rx-walk" data-rx="walk"></div><div style="margin-top:10px">${rxLegend([{ label: 'Subtotal', color: RX.ink }, { label: 'Adds', color: RX.add }, { label: 'Deducts', color: RX.deduct }])}</div></div>` })
    : rxPanel({ cls: 'rx-col-narrow', title: 'Segment mix', meta: `${cqL} scenario`, body: '<div class="rx-pb" data-rx="mix"></div>' });

  const histTitle = ex === 'nse' && model ? 'PAT by quarter' : 'Transaction revenue by quarter';
  const histMeta = ex === 'nse' && model ? '₹ Cr · reported, manual nse_pnl forecasts, and the forecast' : '₹ Cr · trading data';
  const histLegend = ex === 'nse' && model
    ? rxLegend([{ label: 'Reported', color: RX.ink }, { label: 'Manual forecast, quarter ended', kind: 'hatch', style: 'background:repeating-linear-gradient(135deg,#fff 0 3px,#8A8D94 3px 4.5px);box-shadow:inset 0 0 0 1px #8A8D94' }, { label: `${cqL} scenario`, color: RX.model }, { label: `${nextL} default`, color: '#9DB4E8' }])
    : rxLegend([{ label: 'Actual', color: RX.ink }, { label: 'Banked this quarter', color: RX.ink2 }, { label: 'Projected', color: RX.model }].concat(ex === 'mcx' ? [{ label: 'Modelled history', color: RX.light }] : []));

  el.innerHTML = `<div class="rx">
    <section class="rx-kpis" aria-label="${cqL} scenario" data-rx="kpis"></section>
    ${staleHTML}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-wide', title: 'Quarter progress', meta: `Daily transaction revenue, ₹ Cr · ${cqL} to ${fmtTradeDate(lastDate)}${flagTags(cqFlags)}`,
        right: rxLegend([{ label: 'Session', color: RX.ink }, { label: 'QTD avg', color: RX.model, kind: 'line' }].concat(ctx.prev && !prevModelled ? [{ label: `${prevL} avg`, color: RX.grey, kind: 'dash' }] : [])),
        body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`rxPredDaily-${ex}`)}<div data-rx="bullet" style="margin-top:14px"></div></div>
          <div class="rx-scroll"><table class="rx-table" data-rx="segTable"></table></div>` })}
      <section class="rx-panel rx-col-narrow" aria-label="Assumptions">
        <div class="rx-ph"><h2>Assumptions</h2><span class="rx-meta" data-rx="scenLabel"></span><div class="rx-ph-right"><button type="button" class="rx-link" data-rx="resetAll">Reset all</button></div></div>
        <div class="rx-pb" style="padding-top:10px">
          ${rxSeg('preset', [['bear', `Bear −${PREDICTOR_PRESET_PCT} %`], ['base', 'Base'], ['bull', `Bull +${PREDICTOR_PRESET_PCT} %`]], 'base', 'Scenario preset')}
          <p class="rx-foot" style="margin-top:8px">Presets scale the daily revenue for the sessions left. Editing any input makes this a custom scenario; ${ex === 'nse' ? 'the “Default” columns stay as the pipeline published them.' : 'nothing is saved.'}</p>
          ${fieldsHTML}
        </div>
      </section>
    </div>
    <div class="rx-row">${pnlPanel}${bridgePanel}</div>
    ${rxPanel({ title: histTitle, meta: histMeta, right: histLegend, body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`rxPredHist-${ex}`)}</div>` })}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);
  const prevAdr = ctx.prev && ctx.prev.days ? ctx.prev.total_rev / ctx.prev.days : null;
  const lyAdr = ctx.ly && ctx.ly.days ? ctx.ly.total_rev / ctx.ly.days : null;
  const actualLY = ex === 'nse' ? nseActualPnl(lyL) : null;
  const defCur = ex === 'nse' ? nseDefaultPnl(cqL) : null;
  const defNext = ex === 'nse' ? nseDefaultPnl(nextL) : null;

  function scenarioName() {
    const keys = Object.keys(defaults);
    const same = (o) => keys.every(k => Math.abs(Number(v[k]) - Number(o[k])) < PREDICTOR_TOLERANCE);
    for (const [name, f] of Object.entries(presets)) {
      const o = { ...defaults };
      ctx.segs.forEach(k => { o[k] = defaults[k] * f; });
      if (same(o)) return name;
    }
    return 'custom';
  }

  function renderKpis(s) {
    const qoq = ctx.prev && !prevModelled ? s.txn / ctx.prev.total_rev - 1 : null;
    const yoy = ctx.ly && !lyModelled ? s.txn / ctx.ly.total_rev - 1 : null;
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL) && !periodFlags(r, 'total').modelled).slice(-8);
    const vals = hist.map(r => r.total_rev).concat([s.txn]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pt = (val, i) => `${(i / Math.max(vals.length - 1, 1) * 100).toFixed(1)},${(25 - (val - lo) / ((hi - lo) || 1) * 23).toFixed(1)}`;
    const spark = vals.length > 2 ? `<svg class="rx-spark" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label="Transaction revenue, last ${hist.length} quarters and this quarter's scenario">
        <polyline points="${hist.map((r, i) => pt(r.total_rev, i)).join(' ')}" fill="none" stroke="${RX.ink}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        <polyline points="${pt(vals[vals.length - 2], vals.length - 2)} ${pt(s.txn, vals.length - 1)}" fill="none" stroke="${RX.model}" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/></svg>` : '';
    const chg = (c, label) => c == null ? '' : `${rxChangeHTML(c)} ${label}`;
    const items = [
      rxKpi(`Txn revenue · ${cqL}`, rxCr(s.txn), [chg(qoq, 'QoQ'), chg(yoy, 'YoY')].filter(Boolean).join(' · ') || 'no comparable quarter', { accent: true, extra: spark }),
      rxKpi('Avg daily txn revenue', rxCr(s.adr, 2), `QTD ${rxCr(ctx.bankedTotal / ctx.n, 2)} over ${ctx.n} sessions${prevAdr && !prevModelled ? ` · ${prevL} ${rxCr(prevAdr, 1)}` : ''}`),
    ];
    if (ex === 'nse' && s.pat != null) {
      const patYoY = actualLY ? s.pat / actualLY.pat - 1 : null;
      items.push(
        rxKpi('Total income', rxCr(s.total), `Other income ${rxCr(s.oi)}`),
        rxKpi('Operating EBITDA', rxCr(s.ebitda), `${fmtPct(s.ebitda / s.op)} of operating revenue`),
        rxKpi('PAT', rxCr(s.pat), `${patYoY != null ? chg(patYoY, 'YoY') + ' · ' : ''}${fmtPct(s.pat / s.total)} margin`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else if (ex === 'bse') {
      items.push(
        rxKpi('Total income', rxCr(s.total), `Other income ${rxCr(s.oi)} (Excel model)`),
        rxKpi('PAT', rxCr(s.pat), `${fmtNum(v.margin, 1)} % margin on total income`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else {
      ctx.segs.forEach(k => items.push(rxKpi(`${PREDICTOR_SEG_LABEL[k]} · quarter`, rxCr(s.seg[k]), `${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'} of transaction revenue`)));
    }
    q('kpis').innerHTML = items.join('');
  }

  function renderBullet(s) {
    const refs = [s.txn, ctx.prev && !prevModelled ? ctx.prev.total_rev : 0, ctx.ly && !lyModelled ? ctx.ly.total_rev : 0];
    const max = Math.max(...refs) * 1.06 || 1;
    const pct = x => (Math.max(0, x) / max * 100).toFixed(2);
    const bank = Math.min(ctx.bankedTotal, s.txn);
    const marks = [];
    if (ctx.prev && !prevModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.prev.total_rev)}%;border-color:${RX.rev}" title="${prevL}: ${rxCr(ctx.prev.total_rev, 0)}"></div>`);
    if (ctx.ly && !lyModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.ly.total_rev)}%;border-left-style:dotted;border-color:${RX.ink2}" title="${lyL}: ${rxCr(ctx.ly.total_rev, 0)}"></div>`);
    q('bullet').innerHTML = `
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-bottom:6px">
        <span class="rx-lbl">Quarter transaction revenue, ₹ Cr</span>
        <span style="font-size:12px;color:var(--rx-ink-2)">Banked <strong>${fmtNum(ctx.bankedTotal, 1)}</strong> + projected <strong>${fmtNum(s.txn - ctx.bankedTotal, 1)}</strong> = <strong>${fmtNum(s.txn, 1)}</strong></span>
      </div>
      <div class="rx-bullet" role="img" aria-label="Banked ${fmtNum(ctx.bankedTotal, 0)} crore plus projected ${fmtNum(s.txn - ctx.bankedTotal, 0)} crore">
        <div style="left:0;width:${pct(bank)}%;background:${RX.ink}" title="Banked: ${ctx.n} sessions, ${rxCr(ctx.bankedTotal)}"></div>
        <div class="rx-hatch" style="left:${pct(bank)}%;width:${(pct(s.txn) - pct(bank)).toFixed(2)}%" title="Projected: ${s.rest} sessions, ${rxCr(s.txn - ctx.bankedTotal)}"></div>
        ${marks.join('')}
      </div>
      <div style="margin-top:8px">${rxLegend([{ label: `Banked (${ctx.n} sessions)`, color: RX.ink }, { label: `Projected (${s.rest} sessions)`, kind: 'hatch' }]
        .concat(ctx.prev && !prevModelled ? [{ label: `${prevL} ${fmtNum(ctx.prev.total_rev, 0)}`, color: RX.rev, kind: 'tick' }] : [])
        .concat(ctx.ly && !lyModelled ? [{ label: `${lyL} ${fmtNum(ctx.ly.total_rev, 0)}`, color: RX.ink2, kind: 'tick' }] : []))}</div>`;
  }

  function renderSegTable(s) {
    const rows = ctx.segs.map(k => {
      const f = periodFlags(ctx.cq, k === 'opt' ? 'options' : k === 'fut' ? 'futures' : 'cash');
      return `<tr><td>${PREDICTOR_SEG_LABEL[k]}${flagTags(f)}</td><td>${fmtNum(ctx.banked[k], 1)}</td><td>${fmtNum(ctx.adr[k], 2)}</td><td class="rx-hl">${fmtNum(v[k], 2)}</td><td class="rx-hl">${fmtNum(s.seg[k], 1)}</td><td>${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'}</td></tr>`;
    }).join('');
    q('segTable').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">Banked</th><th scope="col">QTD / session</th><th scope="col" class="rx-hl">Rest / session</th><th scope="col" class="rx-hl">Quarter</th><th scope="col">Mix</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Total${flagTags(cqFlags)}</td><td>${fmtNum(ctx.bankedTotal, 1)}</td><td>${fmtNum(ctx.bankedTotal / ctx.n, 2)}</td><td class="rx-hl">${fmtNum(s.adrRest, 2)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>100 %</td></tr></tfoot>`;
  }

  function renderPnl(s) {
    if (ex === 'nse' && model) {
      const num = (o, key, base) => {
        if (!o || o[key] == null) return '—';
        if (base) return o[base] ? fmtPct(o[key] / o[base]) : '—';
        return key === 'eps' ? fmtNum(o[key], 2) : fmtNum(o[key], 1);
      };
      const body = NSE_PNL_ROWS.map(([label, key, cls, base]) => {
        let yoy = '';
        if (!base && actualLY && actualLY[key]) {
          const c = s[key] / actualLY[key] - 1;
          yoy = `<span class="${c >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(c)}</span>`;
        }
        return `<tr class="${cls || ''}"><td>${label}</td><td>${num(actualLY, key, base)}</td><td>${num(defCur, key, base)}</td><td class="rx-hl">${num(s, key, base)}</td><td>${yoy || (base ? '' : '—')}</td><td>${num(defNext, key, base)}</td></tr>`;
      }).join('');
      const scenHead = scenarioName() === 'base' ? 'Scenario<br>= default' : 'Scenario';
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th><th scope="col">${shortQuarterRange([lyL])}<br>Actual</th><th scope="col">${shortQuarterRange([cqL])}<br>Default</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])}<br>${scenHead}</th><th scope="col">Scenario<br>YoY</th><th scope="col">${shortQuarterRange([nextL])}<br>Default</th></tr></thead><tbody>${body}</tbody>`;
      const oneOff = actualLY && Object.keys(actualLY.oneOffs).length ? `${lyL} actual includes ${nseOneOffText(actualLY.oneOffs)}. ` : '';
      q('pnlFoot').textContent = actualLY ? `${oneOff}Actual operating lines are ex-one-offs where the pipeline separates them.` : `${lyL} has no reported actuals in nse_pnl yet.`;
    } else if (ex === 'bse') {
      const per = x => s.txn ? fmtPct(x / s.total) : '—';
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])} scenario</th><th scope="col">% of total income</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        <tr><td>Transaction revenue${flagTags(cqFlags)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>${per(s.txn)}</td><td class="rx-src">Trading data + daily inputs</td></tr>
        <tr><td>Other income</td><td class="rx-hl">${fmtNum(s.oi, 1)}</td><td>${per(s.oi)}</td><td class="rx-src">Excel model</td></tr>
        <tr class="rx-sub"><td>Total income</td><td class="rx-hl">${fmtNum(s.total, 1)}</td><td>100 %</td><td class="rx-src"></td></tr>
        <tr><td>Costs and tax (implied)</td><td class="rx-hl">${fmtNum(s.costs, 1)}</td><td>${per(s.costs)}</td><td class="rx-src">1 − PAT margin</td></tr>
        <tr class="rx-sub"><td>PAT</td><td class="rx-hl">${fmtNum(s.pat, 1)}</td><td>${per(s.pat)}</td><td class="rx-src">PAT margin ${fmtNum(v.margin, 1)} %</td></tr>
        <tr class="rx-sub"><td>EPS, ₹</td><td class="rx-hl">${fmtNum(s.eps, 2)}</td><td></td><td class="rx-src">${fmtNum(v.shares, 2)} Cr shares</td></tr>
      </tbody>`;
    } else {
      const rows = ctx.segs.map(k => {
        const lyv = ctx.ly && !lyModelled ? ctx.ly[k + '_rev'] : null;
        const pv = ctx.prev && !prevModelled ? ctx.prev[k + '_rev'] : null;
        return `<tr><td>${PREDICTOR_SEG_LABEL[k]}</td><td>${pv == null ? '—' : fmtNum(pv, 1)}</td><td>${lyv == null ? '—' : fmtNum(lyv, 1)}</td><td class="rx-hl">${fmtNum(s.seg[k], 1)}</td><td>${pv ? rxChangeHTML(s.seg[k] / pv - 1) : '—'}</td><td>${lyv ? rxChangeHTML(s.seg[k] / lyv - 1) : '—'}</td></tr>`;
      }).join('');
      const tp = ctx.prev && !prevModelled ? ctx.prev.total_rev : null, tl = ctx.ly && !lyModelled ? ctx.ly.total_rev : null;
      q('segs').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">${shortQuarterRange([prevL])}</th><th scope="col">${shortQuarterRange([lyL])}</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])} scenario</th><th scope="col">QoQ</th><th scope="col">YoY</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><td>Total</td><td>${tp == null ? '—' : fmtNum(tp, 1)}</td><td>${tl == null ? '—' : fmtNum(tl, 1)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>${tp ? rxChangeHTML(s.txn / tp - 1) : '—'}</td><td>${tl ? rxChangeHTML(s.txn / tl - 1) : '—'}</td></tr></tfoot>`;
    }
  }

  function renderWalk(s) {
    if (!hasPnl) {
      q('mix').innerHTML = `<div style="display:flex;height:12px;gap:2px;margin:4px 0 10px">${ctx.segs.map((k, i) => `<div style="flex:${Math.max(s.seg[k], 0)} 1 0;background:${[RX.model, RX.rev, RX.ink2][i]}" title="${PREDICTOR_SEG_LABEL[k]} ${rxCr(s.seg[k])}"></div>`).join('')}</div>
        ${rxLegend(ctx.segs.map((k, i) => ({ label: `${PREDICTOR_SEG_LABEL[k]} ${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'}`, color: [RX.model, RX.rev, RX.ink2][i] })))}
        <p class="rx-foot" style="margin-top:10px">${ctx.ly && !lyModelled ? `${lyL}: options ${fmtPct(ctx.ly.opt_rev / ctx.ly.total_rev)} of revenue.` : ''}</p>`;
      return;
    }
    const steps = ex === 'nse'
      ? [['Transaction rev', s.txn, 'tot'], ['Other op. revenue', s.oorV, 'add'], ['Operating rev', s.op, 'tot'], ['Op. expenses', -s.opx, 'sub'],
         ['Op. EBITDA', s.ebitda, 'tot'], ['Depreciation', -s.dep, 'sub'], ['Other income', s.oi, 'add'], ['Associates', s.assoc, 'add'],
         ['PBT', s.pbt, 'tot'], ['Tax', -s.tax, 'sub'], ['PAT', s.pat, 'tot']]
      : [['Transaction rev', s.txn, 'tot'], ['Other income', s.oi, 'add'], ['Total income', s.total, 'tot'], ['Costs and tax', -s.costs, 'sub'], ['PAT', s.pat, 'tot']];
    let run = 0, max = 0;
    const bars = steps.map(([label, val, kind]) => {
      let l, w;
      if (kind === 'tot') { l = 0; w = val; run = val; } else if (val >= 0) { l = run; w = val; run += val; } else { run += val; l = run; w = -val; }
      max = Math.max(max, l + w);
      return { label, val, kind, l, w };
    });
    max = max * 1.02 || 1;
    q('walk').innerHTML = bars.map(b => {
      const color = b.kind === 'tot' ? RX.ink : b.val >= 0 ? RX.add : RX.deduct;
      const txt = b.kind === 'tot' ? fmtNum(b.val, 0) : `${b.val >= 0 ? '+' : '−'}${fmtNum(Math.abs(b.val), 0)}`;
      return `<div class="rx-walk-row${b.kind === 'tot' ? ' is-total' : ''}"><span>${b.label}</span>
        <div class="rx-walk-trk"><div style="left:${(b.l / max * 100).toFixed(2)}%;width:${Math.max(b.w / max * 100, 0.4).toFixed(2)}%;background:${color}" title="${b.label}: ${rxCr(Math.abs(b.val))}"></div></div>
        <span class="${b.kind === 'tot' ? '' : b.val >= 0 ? 'rx-up' : 'rx-dn'}">${txt}</span></div>`;
    }).join('');
  }

  let lastScenario = null;
  function renderDaily() {
    const rows = ctx.daily;
    const qtdAvg = ctx.bankedTotal / ctx.n;
    const ds = [
      { type: 'bar', label: 'Session', data: rows.map(r => r.total_rev), backgroundColor: RX.ink, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 34, order: 2 },
      { type: 'line', label: 'QTD avg', data: rows.map(() => qtdAvg), borderColor: RX.model, borderWidth: 2, pointRadius: 0, order: 1 },
    ];
    if (prevAdr && !prevModelled) ds.push({ type: 'line', label: `${prevL} avg`, data: rows.map(() => prevAdr), borderColor: RX.grey, borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, order: 1 });
    rxChart('predDaily', `rxPredDaily-${ex}`, 200, {
      type: 'bar',
      data: { labels: rows.map(r => fmtTradeDate(r.date)), datasets: ds },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => fmtTradeDate(rows[items[0].dataIndex].date, true),
          label: ctx2 => ` ${ctx2.dataset.label}: ${rxCr(ctx2.raw, 2)}`,
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } },
          y: { beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } },
        },
      },
    });
    rxFixHeight(charts.predDaily);
  }

  function renderHist(s) {
    const canvasId = `rxPredHist-${ex}`;
    if (ex === 'nse' && model) {
      const preds = ENRICHED_DATA.pnl_predicted_quarters || {};
      const rows = (DATA.pnl || []).filter(r => !preds[r.quarter] && quarterSortKey(r.quarter) < quarterSortKey(cqL));
      const pts = rows.map(r => ({ q: r.quarter, v: r.pat, kind: r.is_predicted ? 'manual' : 'actual' }))
        .concat(Object.keys(preds).sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).map(qL => ({ q: qL, v: qL === cqL ? s.pat : preds[qL].pat, kind: qL === cqL ? 'scenario' : 'default', def: preds[qL].pat })));
      const hatch = rxHatchPattern();
      const colors = pts.map(p => p.kind === 'actual' ? RX.ink : p.kind === 'manual' ? hatch : p.kind === 'scenario' ? RX.model : '#9DB4E8');
      const cfg = {
        type: 'bar',
        data: { labels: pts.map(p => shortQuarterRange([p.q])), datasets: [{ label: 'PAT', data: pts.map(p => p.v), backgroundColor: colors,
          borderColor: pts.map(p => p.kind === 'manual' ? '#8A8D94' : 'transparent'), borderWidth: pts.map(p => p.kind === 'manual' ? 1 : 0), borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44 }] },
        options: {
          plugins: { tooltip: { callbacks: {
            title: items => pts[items[0].dataIndex].q,
            label: c => {
              const p = pts[c.dataIndex];
              const kind = { actual: 'reported', manual: 'manual forecast; quarter ended without an actual', scenario: 'your scenario', default: 'default forecast' }[p.kind];
              return ` PAT ${rxCr(p.v, 0)} · ${kind}`;
            },
            footer: items => { const p = pts[items[0].dataIndex]; return p.kind === 'scenario' && Math.abs(p.v - p.def) > 0.5 ? `Default forecast ${rxCr(p.def, 0)}` : ''; },
          } } },
          scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
        },
      };
      if (charts.predHist && lastScenario === 'nse') { charts.predHist.data.datasets[0].data = pts.map(p => p.v); charts.predHist.update('none'); return; }
      rxChart('predHist', canvasId, 240, cfg);
      rxFixHeight(charts.predHist);
      lastScenario = 'nse';
      return;
    }
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL)).slice(-11);
    const labels = hist.map(r => r.quarter).concat([cqL]).map(l => shortQuarterRange([l]));
    const actual = hist.map(r => r.total_rev).concat([ctx.bankedTotal]);
    const proj = hist.map(() => null).concat([s.txn - ctx.bankedTotal]);
    const actualColors = hist.map(r => periodFlags(r, 'total').modelled ? RX.light : RX.ink).concat([RX.ink2]);
    if (charts.predHist && lastScenario === ex) { charts.predHist.data.datasets[1].data = proj; charts.predHist.update('none'); return; }
    rxChart('predHist', canvasId, 240, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Actual', data: actual, backgroundColor: actualColors, stack: 'q', maxBarThickness: 44 },
        { label: 'Projected', data: proj, backgroundColor: RX.model, stack: 'q', borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => (hist[items[0].dataIndex] || ctx.cq).quarter,
          label: c => {
            if (c.raw == null) return null;
            const isCur = c.dataIndex === hist.length;
            const r = hist[c.dataIndex];
            if (!isCur) return ` ${rxCr(c.raw, 0)}${r && periodFlags(r, 'total').modelled ? ' · modelled' : ''}`;
            return c.datasetIndex === 0 ? ` Banked ${rxCr(c.raw, 0)} (${ctx.n} sessions)` : ` Projected ${rxCr(c.raw, 0)}`;
          },
        } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: true, beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
      },
    });
    rxFixHeight(charts.predHist);
    lastScenario = ex;
  }

  // The Base scenario shows NSE's published default forecast as is (the JS
  // recomputation agrees to within rounding of the pipeline's stored ratios).
  function scenarioNow(name) {
    const s = predictorScenario(ex, ctx, v);
    return name === 'base' && defCur ? { ...s, ...defCur } : s;
  }

  function update() {
    const name = scenarioName();
    const s = scenarioNow(name);
    el.querySelectorAll('[data-rx-seg="preset"] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === name)));
    q('scenLabel').textContent = name === 'base' ? 'Base = quarter-to-date pace' : name === 'custom' ? 'Custom scenario' : `${name === 'bear' ? 'Bear' : 'Bull'}: rest-of-quarter revenue ${name === 'bear' ? '−' : '+'}${PREDICTOR_PRESET_PCT} %`;
    groups.forEach(g => g.fields.forEach(f => {
      const edited = Math.abs(Number(v[f.key]) - Number(defaults[f.key])) >= PREDICTOR_TOLERANCE;
      const input = el.querySelector(`#rxPred-${ex}-${f.key}`);
      input.classList.toggle('is-edited', edited);
      el.querySelector(`[data-tags="${f.key}"]`).innerHTML = f.tag + (edited ? ` ${rxChip('Edited', 'edit')} <button type="button" class="rx-link" data-reset="${f.key}">reset to ${predictorShown(defaults[f.key])}</button>` : '');
    }));
    renderKpis(s);
    renderBullet(s);
    renderSegTable(s);
    renderPnl(s);
    renderWalk(s);
    renderHist(s);
  }

  el.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const num = parseFloat(e.target.value);
    if (!isFinite(num) || num < 0) return;
    v[key] = key === 'days' ? Math.max(Math.round(num), ctx.n) : num;
    update();
  });
  el.addEventListener('change', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (key) e.target.value = predictorShown(v[key]);
  });
  el.addEventListener('click', e => {
    const r = e.target.closest('[data-reset]');
    if (r) { const k = r.dataset.reset; v[k] = defaults[k]; el.querySelector(`#rxPred-${ex}-${k}`).value = predictorShown(defaults[k]); update(); return; }
    if (e.target.closest('[data-rx="resetAll"]')) {
      Object.assign(v, defaults);
      Object.keys(defaults).forEach(k => { const i = el.querySelector(`#rxPred-${ex}-${k}`); if (i) i.value = predictorShown(defaults[k]); });
      update();
    }
  });
  rxOnSeg(el, 'preset', name => {
    const f = presets[name];
    ctx.segs.forEach(k => { v[k] = defaults[k] * f; el.querySelector(`#rxPred-${ex}-${k}`).value = predictorShown(v[k]); });
    update();
  });

  update();
  renderDaily();
  RX_TAB_REFRESH.prediction = () => { renderDaily(); charts.predHist && charts.predHist.destroy(); delete charts.predHist; lastScenario = null; renderHist(scenarioNow(scenarioName())); };
}

// Diagonal hatch fill for Chart.js bars (manual forecasts)
function rxHatchPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const g = c.getContext('2d');
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, 6, 6);
  g.strokeStyle = '#8A8D94';
  g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-1, 7); g.lineTo(7, -1); g.stroke();
  return g.createPattern(c, 'repeat');
}

// Buttons that jump to another tab (e.g. "value it →" on the predictor)
document.addEventListener('click', e => {
  const go = e.target.closest('[data-rx-goto]');
  if (!go) return;
  const nav = document.querySelector(`.nav-item[data-tab="${go.dataset.rxGoto}"]`);
  if (nav) nav.click();
});

