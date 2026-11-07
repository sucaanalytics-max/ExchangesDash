// dashboard/js/32-brokers-fo-drivers.js — Brokers → F&O vs Exchanges: why a broker's
// F&O revenue and NSE + BSE F&O revenue move by different amounts.
// - Exchanges are paid on option premium: exchange F&O revenue ≈ fee rate × premium.
// - The engine's broker F&O revenue is a contract count times a rate fixed for the
//   month or quarter: broker F&O = k × contracts.
// - So broker ÷ exchange = k × (contracts ÷ exchange revenue). Within a period k is
//   constant and the ratio moves only with contracts per ₹ of exchange revenue.
// Every figure is a ratio of published numbers: the engine's sb_daily_revenue (segment
// 'fo') and the exchanges' daily_all in /data/{nse,bse}_dashboard_data_eff.json (fees
// as charged). Nothing here re-computes ADR.

const BRK_FO_PERIODS = [['3m', '3 M', 3], ['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24]];
const BRK_FO_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const BRK_FO_WINDOWS = [10, 20, 45];
const BRK_FO_DAYS = [['all', 'All days'], ['exp', 'Expiry days'], ['non', 'Non-expiry days']];
const BRK_FO_EXP_COLOR = '#D39A6E';   // RX.above: expiry-day dots

// win: trading days in the rolling A ÷ B; days: which days count ('all' | 'exp' | 'non'); dots: draw single days
BRK.foView = { period: '6m', win: 20, days: 'all', dots: false };
let BRK_FO_EXCH = null;   // { nse: Map(date → row), bse: Map, exp: Set of NSE or BSE expiry dates, eff } once loaded; shared by every broker

async function brkFoLoadExchanges() {
  if (BRK_FO_EXCH) return BRK_FO_EXCH;
  const load = async ex => {
    try { return { rows: (await fetchDataFile(`/data/${ex}_dashboard_data_eff.json`)).json.daily_all, eff: true }; }
    catch (err) { return { rows: (await fetchDataFile(`/data/${ex}_dashboard_data.json`)).json.daily_all, eff: false }; }
  };
  const [nse, bse] = await Promise.all([load('nse'), load('bse')]);
  // Expiry days: each exchange's weekly benchmark expiry (Nifty, Sensex), as Revenue Summary counts them
  const exp = new Set([...expiryDateSet(nse.rows, 'nse'), ...expiryDateSet(bse.rows, 'bse')]);
  BRK_FO_EXCH = { nse: new Map(nse.rows.map(r => [r.date, r])), bse: new Map(bse.rows.map(r => [r.date, r])), exp, eff: nse.eff && bse.eff };
  return BRK_FO_EXCH;
}

// One row per day with the broker's F&O revenue and both exchanges' data.
// C: NSE + BSE F&O contracts, Mn · P: options premium, ₹ Cr · R: exchange F&O revenue, ₹ Cr · B: broker F&O, ₹ Cr
function brkFoRows(daily, ex) {
  const out = [];
  daily.filter(r => r.segment === 'fo' && r.revenue_cr != null).forEach(r => {
    const n = ex.nse.get(r.trade_date), b = ex.bse.get(r.trade_date);
    if (!n || !b) return;
    const C = ((n.total_contracts || 0) + (b.total_contracts || 0)) / 1e6;
    const P = (n.io_premium || 0) + (n.so_premium || 0) + (b.options_premium_turnover || 0);
    const R = (n.fo_rev || 0) + (b.fo_rev || 0);
    if (!(C > 0 && P > 0 && R > 0 && r.revenue_cr > 0)) return;
    out.push({ date: r.trade_date, B: r.revenue_cr, C, P, R, projected: r.regime !== 'actual', exp: ex.exp.has(r.trade_date),
      wd: new Date(r.trade_date + 'T00:00:00Z').getUTCDay() - 1 });
  });
  return out.sort((a, b) => a.date < b.date ? -1 : 1);
}

// Square of the correlation of two series (R² of a one-variable fit)
function brkFoR2(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? (sxy * sxy) / (sxx * syy) : null;
}

// Least-squares line y = a + b·x
function brkFoFit(xs, ys) {
  const n = xs.length, mx = xs.reduce((a, v) => a + v, 0) / n, my = ys.reduce((a, v) => a + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

// A ÷ B over the last `win` rows to each row (sums, not an average of daily ratios, so a
// big expiry day weighs what it earned); null until `win` rows are in
function brkFoRolling(rows, win, a, b, scale = 1) {
  let sa = 0, sb = 0;
  return rows.map((r, i) => {
    sa += a(r); sb += b(r);
    if (i >= win) { sa -= a(rows[i - win]); sb -= b(rows[i - win]); }
    return i >= win - 1 && sb ? sa / sb * scale : null;
  });
}

// Latest same-weekday day vs the average of the last n such days, split exactly into
// exchange revenue × contracts per ₹ of exchange revenue × the broker's rate per contract
function brkFoBridge(rows, wd, n) {
  const days = rows.filter(r => r.wd === wd).slice(-n).reverse();
  if (days.length < n) return null;
  const avg = k => days.reduce((a, r) => a + r[k], 0) / n, last = days[0];
  const rR = last.R / avg('R'), rC = last.C / avg('C'), rB = last.B / avg('B');
  return { last, days, exch: rR - 1, cpr: rC / rR - 1, contracts: rC - 1, rate: rB / rC - 1, broker: rB - 1 };
}

async function buildBrokersFo() {
  const el = brkSection('fo'), summary = BRK.summary, st = BRK.foView;
  if (!el) return;
  if (!summary.run) { el.innerHTML = `<div class="brk-wrap">${brkRunBar({ legend: false })}${brkNoRunHTML()}</div>`; return; }
  if (!BRK.daily || !BRK_FO_EXCH) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading daily F&O revenue and exchange data…</div></div>';
    try {
      const [daily] = await Promise.all([BRK.daily || brkFetch('daily', BRK.mode), brkFoLoadExchanges()]);
      if (BRK.summary !== summary) return;   // the broker or run changed meanwhile
      BRK.daily = daily;
    } catch (err) { el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load the data: ${escHtml(err.message)}</div></div>`; return; }
  }
  const name = escHtml(BRK_BROKER.name), view = BRK_BROKER.view;
  const all = brkFoRows(BRK.daily.rows, BRK_FO_EXCH);
  if (all.length < 20) {
    el.innerHTML = `<div class="brk-wrap">${brkRunBar({ legend: false })}<div class="brk-empty">Too few days with both ${name}'s F&O revenue and NSE + BSE data to compare.</div></div>`;
    return;
  }
  const months = BRK_FO_PERIODS.find(p => p[0] === st.period)[2];
  const start = brkMonthsBack(all[all.length - 1].date, months);
  // Rolling ratios run over every chosen day (so the period's first points have a full window), then cut to the period
  const chosen = all.filter(r => st.days === 'all' || (st.days === 'exp') === r.exp);
  const rollA = brkFoRolling(chosen, st.win, r => r.B, r => r.R, 100);
  const rollB = brkFoRolling(chosen, st.win, r => r.C * 1e6, r => r.P);
  const first = chosen.findIndex(r => r.date >= start);
  const rows = first < 0 ? [] : chosen.slice(first), rA = rollA.slice(first), rB = rollB.slice(first);
  const controls = `<div class="brk-price-controls">
    <div><div class="rx-lbl">Period</div>${rxSeg('brkFoPeriod', BRK_FO_PERIODS.map(p => [p[0], p[1]]), st.period, 'Period')}</div>
    <div><div class="rx-lbl">Rolling window, trading days</div>${rxSeg('brkFoWin', BRK_FO_WINDOWS.map(n => [String(n), String(n)]), String(st.win), 'Rolling window')}</div>
    <div><div class="rx-lbl">Days</div>${rxSeg('brkFoDays', BRK_FO_DAYS, st.days, 'Days')}</div>
    <div><div class="rx-lbl">Single days</div>${rxSeg('brkFoDots', [['off', 'Hide'], ['on', 'Show']], st.dots ? 'on' : 'off', 'Single days')}</div>
  </div>`;
  if (rows.length < 5) {   // keep the controls, so the viewer can pick a longer period or all days
    el.innerHTML = `<div class="brk-wrap">${brkRunBar({ legend: false })}<div class="rx">${controls}<div class="brk-empty">Too few ${escHtml(BRK_FO_DAYS.find(d => d[0] === st.days)[1].toLowerCase())} in this period. Pick a longer period or all days.</div></div></div>`;
    brkFoListeners(el.firstElementChild);
    return;
  }
  const last = rows[rows.length - 1];
  const daysLabel = BRK_FO_DAYS.find(d => d[0] === st.days)[1].toLowerCase();
  const ln = Math.log;
  const r2Rate = brkFoR2(rows.map(r => ln(r.C / r.R)), rows.map(r => ln(r.B / r.R)));
  const r2Prem = brkFoR2(rows.map(r => ln(r.C / r.P)), rows.map(r => ln(r.B / r.R)));
  const r2Level = brkFoR2(rows.map(r => ln(r.R)), rows.map(r => ln(r.B)));
  const periodLabel = `${BRK_FO_PERIODS.find(p => p[0] === st.period)[1]} · ${escHtml(fmtLongDate(rows[0].date))} to ${escHtml(fmtLongDate(last.date))}`;
  const id = s => `brk-${view}-fo-${s}`;
  const fees = BRK_FO_EXCH.eff ? 'fees as charged' : "fees at today's rates (the as-charged files were unavailable)";

  const identity = `<div class="brk-fo-identity">
    <div><span class="rx-lbl">Exchanges are paid on premium</span><b>Exchange F&amp;O revenue ≈ fee rate × option premium</b></div>
    <div><span class="rx-lbl">The engine counts contracts</span><b>${name} F&amp;O revenue = k × NSE + BSE contracts</b><span class="rx-foot">k = share × revenue per order ÷ contracts per order, fixed for the month or quarter</span></div>
    <div><span class="rx-lbl">Divide one by the other</span><b>${name} ÷ Exchange revenue = k × (contracts ÷ exchange revenue)</b><span class="rx-foot">Within a period k is constant, so the ratio moves only with contracts per ₹ of exchange revenue: the inverse of the premium per contract</span></div>
  </div>`;

  const lastA = rA[rA.length - 1], lastB = rB[rB.length - 1];
  const firstIdx = rA.findIndex(v => v != null);

  const kpis = rxKpis([
    rxKpi(`A: ${name} ÷ exchange F&amp;O, ${st.win}-day`, lastA == null ? '—' : fmtNum(lastA, 1) + ' %',
      firstIdx < 0 || lastA == null ? `to ${escHtml(fmtLongDate(last.date))}` : `${rxChangeHTML(lastA / rA[firstIdx] - 1)} since ${escHtml(fmtLongDate(rows[firstIdx].date))}`),
    rxKpi(`B: contracts per ₹ Cr of premium, ${st.win}-day`, lastB == null ? '—' : fmtNum(lastB, 0),
      firstIdx < 0 || lastB == null ? `to ${escHtml(fmtLongDate(last.date))}` : `${rxChangeHTML(lastB / rB[firstIdx] - 1)} since ${escHtml(fmtLongDate(rows[firstIdx].date))}`),
    rxKpi(`R², ${name} vs exchange revenue`, r2Level == null ? '—' : fmtNum(r2Level, 2), 'daily levels (logs): exchange revenue alone'),
    rxKpi('R², ratio vs contracts ÷ premium', r2Prem == null ? '—' : fmtNum(r2Prem, 2), `log(${name} ÷ exchange) on log(contracts ÷ premium)`, { accent: true }),
    rxKpi('R², ratio vs contracts ÷ exchange revenue', r2Rate == null ? '—' : fmtNum(r2Rate, 2), 'the rest is k changing at period ends', { accent: true }),
  ], 'F&O vs exchanges');

  // Weekday bridge: latest vs last 3 and last 10 same weekdays
  const bridgeRows = n => BRK_FO_WEEKDAYS.map((label, wd) => {
    const b = brkFoBridge(all, wd, n);
    if (!b) return `<tr><td class="rx-l">${label}</td><td colspan="6" class="rx-l rx-foot">fewer than ${n} ${label}s</td></tr>`;
    const dates = b.days.map(r => fmtTradeDate(r.date)).join(', ');
    return `<tr><td class="rx-l" title="${escHtml(dates)}">${label} <span class="rx-foot">${escHtml(fmtTradeDate(b.last.date))}</span></td>
      <td>${rxSignedPct(b.exch)}</td><td>${rxSignedPct(b.cpr)}</td><td>${rxSignedPct(b.contracts)}</td><td>${rxSignedPct(b.rate)}</td><td><b>${rxSignedPct(b.broker)}</b></td></tr>`;
  }).join('');
  const bridgeHead = `<thead><tr><th scope="col" class="rx-l">Latest</th><th scope="col" title="NSE + BSE F&amp;O revenue">Exchange F&amp;O</th><th scope="col" title="Contracts per ₹ of exchange F&amp;O revenue">× Contracts per ₹</th><th scope="col" title="NSE + BSE F&amp;O contracts">= Contracts</th><th scope="col" title="${name}'s rate per contract (k): share × revenue per order ÷ contracts per order">× Rate (k)</th><th scope="col">= ${name} F&amp;O</th></tr></thead>`;
  const bridgePanel = rxPanel({ title: 'Weekday bridge: exchange change to broker change', meta: `latest same weekday vs the average of the last 3 and last 10 · to ${escHtml(fmtLongDate(all[all.length - 1].date))}`,
    body: `<div class="rx-scroll"><table class="rx-table"><caption class="rx-l rx-foot">vs average of last 3</caption>${bridgeHead}<tbody>${bridgeRows(3)}</tbody></table>
      <table class="rx-table"><caption class="rx-l rx-foot">vs average of last 10</caption>${bridgeHead}<tbody>${bridgeRows(10)}</tbody></table></div>`,
    foot: 'Columns: NSE + BSE F&O revenue; contracts per ₹ of that revenue; NSE + BSE contracts; the engine\'s rate per contract (k); the broker\'s F&O revenue. Each row multiplies out exactly: (1 + exchange) × (1 + contracts per ₹ of exchange revenue) = 1 + contracts, and × (1 + rate per contract) = 1 + broker. The rate per contract moves only when the window spans a month or quarter end (a new k). Hover a weekday for the dates used.' });

  el.innerHTML = `<div class="brk-wrap">${brkRunBar({ legend: false })}<div class="rx">${controls}
    <p class="rx-foot brk-price-foot">${name} F&amp;O: the engine's published daily revenue. Exchanges: NSE + BSE F&amp;O revenue (${fees}), F&amp;O contracts and options premium from the exchange data. Days on which either side has no figure are left out.</p>
    ${rxPanel({ title: 'Why the two revenues differ', meta: 'the identity behind this tab', body: identity })}
    ${kpis}
    ${bridgePanel}
    ${rxPanel({ title: `A ÷ B trend: ${name}'s share of exchange F&amp;O and contracts per ₹ of premium`, meta: `${periodLabel} · ${daysLabel} · ${st.win}-day rolling`,
      body: `<div class="rx-pb"><div class="brk-fo-ab-lbl"><b>A</b> ${name} F&amp;O ÷ NSE + BSE F&amp;O revenue, %</div>${rxCanvas(id('a'))}<div data-brk-leg="a"></div>
        <div class="brk-fo-ab-lbl"><b>B</b> NSE + BSE F&amp;O contracts ÷ options premium, contracts per ₹ Cr</div>${rxCanvas(id('b'))}<div data-brk-leg="b"></div></div>`,
      foot: `Each bold line is a ${st.win}-day ratio of sums (A: Σ ${name} ÷ Σ exchange revenue; B: Σ contracts ÷ Σ premium), so the weekly expiry swing drops out and the trend shows. Show single days to see why: orange dots are NSE or BSE expiry days, where contracts jump and premium per contract falls. A rises and falls with B because ${name}'s figure counts contracts and the exchanges' counts premium; the dashed step in A is k, the engine's rate per contract, which resets at month or quarter ends.${rows[0].date < '2024-11-20' && st.days !== 'all' ? ' Before 20 Nov 2024 the exchanges also had other weekly index expiries (Bank Nifty, Fin Nifty, Bankex and more); only the Nifty and Sensex ones count as expiry days here, so non-expiry days before then include the others.' : ''}` })}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-wide', title: `${name} as % of exchange F&O vs contracts per ₹ Cr of exchange revenue`, meta: periodLabel,
        body: `<div class="rx-pb">${rxCanvas(id('scatter'))}<div data-brk-leg="scatter"></div></div>` })}
      ${rxPanel({ cls: 'rx-col-narrow', title: 'How to read it', meta: '', body: `<div class="rx-pb rx-foot brk-fo-read">
        <p><b>Exchange revenue up, contracts up more</b> (an expiry day, a BSE Sensex expiry): the broker figure rises more than the exchanges'.</p>
        <p><b>Premium per contract up</b> (no expiry, higher volatility): exchange revenue rises, the broker figure doesn't follow.</p>
        <p><b>So</b> broker % change ≈ exchange % change + % change in contracts per ₹ of exchange revenue, plus a step in k at period ends.</p>
        <p>This explains the engine's figure. Whether the broker's actual orders follow contracts this closely is a separate question.</p></div>` })}
    </div>
  </div></div>`;
  const root = el.firstElementChild;
  brkFoListeners(root);

  const labels = rows.map(r => fmtChartDate(r.date));
  const dateTitle = items => `${rxDate(rows[items[0].dataIndex].date)} · ${BRK_FO_WEEKDAYS[rows[items[0].dataIndex].wd] || ''}`;
  const xAxis = { grid: { display: false }, afterBuildTicks: brkMonthTicks(rows.map(r => r.date), 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } };

  // A and B share the x axis and fixed axis widths, so a date sits at the same x in both
  const fixW = { afterFit: sc => { sc.width = 64; } };
  const dot = r => r.exp ? BRK_FO_EXP_COLOR : RX.light;
  // y range fits what is drawn (the rolling line alone unless single days are shown)
  const range = (data, roll) => {
    const v = (st.dots ? data.concat(roll) : roll).filter(x => x != null && isFinite(x));
    const lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.08 || hi * 0.05;
    return { min: Math.max(0, lo - pad), max: hi + pad };
  };
  const abChart = (key, data, roll, label, fmtV, extra) => { const yr = range(data, roll); return rxChart(`brk-${view}-fo-${key}`, id(key), 230, {
    type: 'line',
    data: { labels, datasets: [
      { label: `${label}, ${st.win}-day`, data: roll, borderColor: RX.model, borderWidth: 2.25, pointRadius: 0, tension: 0, spanGaps: false, order: 0 },
      { label: `${label}, day`, data, hidden: !st.dots, showLine: false, pointRadius: 2.2, pointHoverRadius: 4, pointBackgroundColor: rows.map(dot), pointBorderWidth: 0, order: 2 },
      ...(extra ? [extra.ds] : []),
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { title: dateTitle,
        label: ctx => ctx.datasetIndex === 2 ? extra.label(ctx.raw) : ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : fmtV(ctx.raw)}`,
        afterBody: items => st.dots ? [] : [` ${label}, day: ${fmtV(data[items[0].dataIndex])}`],
        footer: items => { const r = rows[items[0].dataIndex]; return `${r.exp ? 'Expiry day · ' : ''}${BRK_BROKER.name} ₹${fmtNum(r.B, 2)} Cr · exchange ₹${fmtNum(r.R, 1)} Cr · ${fmtNum(r.C, 0)} Mn contracts · premium ₹${fmtNum(r.P, 0)} Cr${r.projected ? ' · projected' : ''}`; } } } },
      scales: { x: xAxis,
        y: { ...fixW, position: 'left', min: yr.min, max: yr.max, ticks: { includeBounds: false, callback: v => fmtV(v) } },
        // k's axis is A's axis times mean k ÷ mean A: a 2 % step in k is drawn as a 2 % move in A
        y1: { ...fixW, position: 'right', display: true, grid: { display: false }, border: { display: !!extra },
          ...(extra ? { min: yr.min * extra.scale, max: yr.max * extra.scale } : {}),
          ticks: extra ? { includeBounds: false, callback: v => fmtNum(v, 2) } : { display: false }, title: extra ? { display: true, text: 'k, ₹ Cr per 100 Mn contracts' } : { display: false } } },
    },
  }); };
  const kVals = rows.map(r => r.B / r.C * 100), aVals = rA.filter(v => v != null);
  const kStep = { scale: (kVals.reduce((a, v) => a + v, 0) / kVals.length) / (aVals.reduce((a, v) => a + v, 0) / (aVals.length || 1)),
    ds: { label: 'k', data: kVals, yAxisID: 'y1', borderColor: RX.ink, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, stepped: true, order: 1 },
    label: v => ` k: ₹${fmtNum(v, 2)} Cr per 100 Mn contracts` };
  abChart('a', rows.map(r => r.B / r.R * 100), rA, `${BRK_BROKER.name} ÷ exchange`, v => fmtNum(v, 1) + ' %', kStep);
  abChart('b', rows.map(r => r.C * 1e6 / r.P), rB, 'Contracts per ₹ Cr of premium', v => fmtNum(v, 0));
  const dotsLeg = !st.dots ? [] : st.days === 'non' ? [{ label: 'Day', color: RX.light }] : st.days === 'exp' ? [{ label: 'Expiry day', color: BRK_FO_EXP_COLOR }]
    : [{ label: 'Expiry day (NSE or BSE)', color: BRK_FO_EXP_COLOR }, { label: 'Other day', color: RX.light }];
  root.querySelector('[data-brk-leg="a"]').innerHTML = rxLegend([{ label: `${st.win}-day ratio`, color: RX.model, kind: 'line' }, ...dotsLeg,
    { label: 'k, the engine\'s rate per contract (right)', color: RX.ink, kind: 'dash' }]);
  root.querySelector('[data-brk-leg="b"]').innerHTML = rxLegend([{ label: `${st.win}-day ratio`, color: RX.model, kind: 'line' }, ...dotsLeg]);

  const xs = rows.map(r => r.C / r.R), ys = rows.map(r => r.B / r.R * 100), fit = brkFoFit(xs, ys);
  const xMin = Math.min(...xs), xMax = Math.max(...xs), r2Lin = brkFoR2(xs, ys);
  rxChart(`brk-${view}-fo-scatter`, id('scatter'), 280, {
    type: 'scatter',
    data: { datasets: [
      { label: 'Day', data: rows.map((r, i) => ({ x: xs[i], y: ys[i], date: r.date })),
        pointBackgroundColor: rows.map((r, i) => RX.seq[Math.min(4, Math.floor(i / rows.length * 5))]), pointBorderColor: '#FFFFFF', pointBorderWidth: 0.5, pointRadius: 3.2, pointHoverRadius: 5 },
      { label: 'Latest', data: [{ x: xs[xs.length - 1], y: ys[ys.length - 1], date: last.date }], pointBackgroundColor: '#FFFFFF', pointBorderColor: RX.ink, pointBorderWidth: 2, pointRadius: 6 },
      { type: 'line', label: 'Fit', data: [{ x: xMin, y: fit.a + fit.b * xMin }, { x: xMax, y: fit.a + fit.b * xMax }], borderColor: RX.model, borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0 },
    ] },
    options: {
      plugins: { tooltip: { filter: item => item.dataset.label !== 'Fit', callbacks: {
        title: items => rxDate(items[0].raw.date), label: ctx => ` ${fmtNum(ctx.parsed.x, 2)} Mn contracts per ₹ Cr · ${BRK_BROKER.name} ${fmtNum(ctx.parsed.y, 1)} % of exchange` } } },
      scales: {
        x: { type: 'linear', grace: '4%', title: { display: true, text: 'Mn contracts per ₹ Cr of exchange F&O revenue' }, ticks: { callback: v => fmtNum(v, 1) } },
        y: { grace: '4%', title: { display: true, text: `${BRK_BROKER.name} as % of exchange F&O` }, ticks: { callback: v => fmtNum(v, 0) + ' %' } },
      },
    },
  });
  root.querySelector('[data-brk-leg="scatter"]').innerHTML = rxLegend([
    { label: 'Older', color: RX.seq[0] }, { label: 'Recent', color: RX.seq[4] },
    { label: `Latest (${fmtTradeDate(last.date)})`, color: '#FFFFFF', style: `border:2px solid ${RX.ink};border-radius:50%;width:11px;height:11px` },
    { label: `Fit, R² ${r2Lin == null ? '—' : fmtNum(r2Lin, 2)}`, color: RX.model, kind: 'dash' },
  ]);
}

// Controls; listeners sit on this build's wrapper, so a rebuild never stacks them
function brkFoListeners(root) {
  const st = BRK.foView;
  rxOnSeg(root, 'brkFoPeriod', v => { st.period = v; buildBrokersFo(); });
  rxOnSeg(root, 'brkFoWin', v => { st.win = +v; buildBrokersFo(); });
  rxOnSeg(root, 'brkFoDays', v => { st.days = v; buildBrokersFo(); });
  rxOnSeg(root, 'brkFoDots', v => { st.dots = v === 'on'; buildBrokersFo(); });
}
