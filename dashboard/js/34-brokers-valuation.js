// dashboard/js/34-brokers-valuation.js — Brokers → Valuation (Angel One, Groww; Motilal Oswal's P/B): the
// valuation the brokers-dashboard engine publishes after each ADR run
// (src/engine/valuation.py there; table sb_valuation_lines, read through
// /api/brokers?view=valuation). Three methods, triangulated by weight:
//   Regression  price = intercept + slope × 45-day ADR (plain least squares)
//   Ratio       mean ± 1 SD of price ÷ 45-day ADR, × the current quarter's ADR
// (both fitted over the Timeline window the reader picks; 'All' is the workbook's)
//   ADR         the PAT model's FY 2028 target price today (PAT Predictor tab)
// and the charts of AB's workbook ADR model sheets. This file lays the published
// lines out and computes nothing but chart lines from published parameters: the
// mean ± SD bands, and a window's fit line and implied price (slope × ADR + intercept);
// and, while the reader has edited the PAT Predictor's inputs (BRK_PAT_LIVE), the ADR
// method at those inputs with the net value and upside re-weighted (brkValReweight).
// The three weights are inputs too: the net value and upside are re-weighted on the page
// with the reader's weights (scaled to add up to 100 %), kept in memory per broker and run.
// So is the ADR the regression and ratio methods value (AB, 14 Nov 2026): the reader's ₹ Cr / day
// replaces the current quarter's ADR in both (brkValAtAdr, from the window's published fit), and
// Default puts the published one back; memory only, per broker and run.

const BRK_VAL_METHODS = [['regression', 'Regression'], ['ratio', 'Ratio analysis'], ['adr', 'ADR (PAT model)']];
const BRK_VAL_SCEN = [['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull']];
// Timeline: the regression and ratio are fitted over the window, and the P/E bands drawn over it ('all' = the
// workbook's own window, the whole series). The engine publishes every window the data cover. The Timeline above
// the KPIs sets the valuation table and every chart; each chart also has its own (BRK.valView.chart), which
// redraws only that chart from the window's published fit, ratio band or P/E band.
const BRK_VAL_WINDOWS = [['all', 'All'], ['3m', '3M'], ['6m', '6M'], ['1y', '1Y'], ['2y', '2Y'], ['3y', '3Y'], ['apr25', 'Since Apr 2025']];
BRK.valView = { win: 'all' };
// The method weights as the reader set them, per broker id: { run, w: { method: fraction } }. Kept only
// while they differ from the published weights; memory only, never saved.
const BRK_VAL_W = {};
// The reader's ADR for the regression and ratio methods, per broker id: { run, basis, adr } (₹ Cr / day; basis
// 'qtd' the current quarter's average so far, as published, or 'dma' the latest 45-day ADR). Kept only while it
// differs from the published one; memory only, never saved.
const BRK_VAL_ADR = {};
// The ADR bases of the toggle above the valuation: [key, label]
const BRK_VAL_ADR_BASES = [['dma', '45-DMA'], ['qtd', 'quarter average']];

// The latest 45-day ADR in the published series: { date, dma } (null without one)
function brkValLatestDma(days) {
  for (let i = days.length - 1; i >= 0; i--) if (days[i].dma != null) return { date: days[i].date, dma: days[i].dma };
  return null;
}

// The regression and ratio methods' bear / base / bull at an ADR (₹ Cr / day), from a window's published fit:
// the engine's valuation.regression (slope × ADR + intercept; bear / bull move slope × ADR by ∓ band) and
// valuation.ratio ((mean ∓ 1 SD) × ADR). fit: { slope, intercept, band, mean, sd }.
function brkValAtAdr(fit, adr) {
  const { slope, intercept, band, mean, sd } = fit;
  return {
    regression: { bear: slope * adr * (1 - band) + intercept, base: slope * adr + intercept, bull: slope * adr * (1 + band) + intercept },
    ratio: { bear: (mean - sd) * adr, base: mean * adr, bull: (mean + sd) * adr },
  };
}

// Whether brkValAtAdr at the published ADR reproduces the published regression and ratio prices (S: a window's
// summary lines): the names of the method / scenario pairs off by more than tol ₹ ([] = they match). Checked on
// load; the ADR input is offered only when it is [], so a change in the engine's formula can't make the page's
// figures jump when the reader types an ADR (review on #93, 16 Nov 2026).
function brkValAdrCheck(fit, adr, S, tol = 0.005) {
  const at = brkValAtAdr(fit, adr), off = [];
  ['regression', 'ratio'].forEach(m => BRK_VAL_SCEN.forEach(([s]) => {
    const p = S?.[m]?.[s]?.value;
    if (p == null || !(Math.abs(at[m][s] - p) <= tol)) off.push(`${m} ${s}`);
  }));
  return off;
}

// The Indian FY quarter of a date as the page labels it, '2026-11-13' → 'Q3 FY27' (Apr–Jun is Q1); '' for no date.
// The quarter of the published ADR (adr_now, the quarter's average so far) is the run's as-of date's.
function brkValQuarter(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(iso || '');
  if (!m) return '';
  const y = +m[1], mo = +m[2];
  return `Q${Math.floor(((mo + 8) % 12) / 3) + 1} FY${String((mo >= 4 ? y + 1 : y) % 100).padStart(2, '0')}`;
}

function brkValIndex(rows) {
  const sum = {}, inputs = {}, common = {}, weight = {}, series = {}, pe = [], bands = {}, pbDays = {}, pbBands = {}, pbBook = {};
  rows.forEach(r => {
    if (r.section === 'pb') { (pbDays[r.period_key] = pbDays[r.period_key] || { date: r.period_key })[r.line] = r.value; if (r.line === 'pb') pbDays[r.period_key].rule = r.rule; return; }
    if (r.section === 'pb_bands') { (pbBands[r.period_key] = pbBands[r.period_key] || {})[r.line] = r; return; }
    if (r.section === 'pb_book') { (pbBook[r.period_key] = pbBook[r.period_key] || { quarter: r.period_key })[r.line] = r; return; }
    if (r.section === 'weights') weight[r.period_key] = r;
    else if (r.section === 'summary') ((sum[r.period_key] = sum[r.period_key] || {})[r.line] = sum[r.period_key][r.line] || {})[r.scenario] = r;
    else if (r.section === 'inputs') (inputs[r.period_key] = inputs[r.period_key] || {})[r.line] = r;
    else if (r.section === 'common') common[r.line] = r;
    else if (r.section === 'series') (series[r.period_key] = series[r.period_key] || { date: r.period_key })[r.line] = r.value;
    else if (r.section === 'pe') pe.push({ date: r.period_key, pe: r.value, rule: r.rule });
    else if (r.section === 'pe_bands') (bands[r.period_key] = bands[r.period_key] || {})[r.line] = r;
  });
  const days = Object.values(series).sort((a, b) => (a.date < b.date ? -1 : 1));
  pe.sort((a, b) => (a.date < b.date ? -1 : 1));
  const pb = Object.values(pbDays).filter(r => r.pb != null).sort((a, b) => (a.date < b.date ? -1 : 1));
  const book = Object.values(pbBook).sort((a, b) => quarterSortKey(a.quarter) - quarterSortKey(b.quarter));
  return { sum, inputs, common, weight, days, pe, bands, pb, pbBands, book };
}

// The weighted net value and upside per scenario, with the ADR method's values replaced by
// `adr` (the PAT Predictor's target price today at the reader's inputs): the engine's
// triangulation (valuation.py triangulate: Σ weight × value) on the published weights.
// values: { method: { scenario: price } }; weights: { method: w }. Returns { adr, net, upside }.
function brkValReweight(values, weights, adr, close) {
  const out = { adr: { ...adr }, net: {}, upside: {} };
  BRK_VAL_SCEN.forEach(([s]) => {
    out.net[s] = BRK_VAL_METHODS.reduce((a, [m]) => a + weights[m] * (m === 'adr' ? adr[s] : values[m][s]), 0);
    out.upside[s] = out.net[s] / close - 1;
  });
  return out;
}

// The reader's weights { method: fraction } scaled to add up to 1, and what they added up to.
// All zero: scaled is null (no weighted value).
function brkValScale(w) {
  const sum = BRK_VAL_METHODS.reduce((a, [m]) => a + (w[m] || 0), 0);
  return { sum, scaled: sum > 0 ? Object.fromEntries(BRK_VAL_METHODS.map(([m]) => [m, (w[m] || 0) / sum])) : null };
}

// The weight inputs of the triangulation table: the net value, upside and their KPI tiles are
// re-weighted in place as the reader types (the charts don't depend on the weights).
// W: published weights; wst: the weights shown (edited in place); vals: each method's price per
// scenario (ADR leg at the PAT Predictor's inputs when patOn); ovr: brkValReweight at W, or null.
// ast: { basis, adr } the ADR the regression and ratio methods use and the basis toggle's pick (edited in place),
// adr0 the published one (the quarter's average so far), dmaNow the latest 45-DMA, fit the window's published fit
// (brkValAtAdr), adrQ the quarter, basisLbl / basisVal a basis's label and ADR; ast is null when the fit isn't published.
function brkValWeightInputs(root, { W, wst, vals, S, ovr, close, patOn, patLive, runId, broker, ast, adr0, fit, adrQ, dmaNow, basisLbl, basisVal, adrSub }) {
  const ins = [...root.querySelectorAll('[data-vw]')];
  const adrIn = root.querySelector('[data-vadr]');
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // ADRs are shown and typed to 2 decimals: the same ADR at that precision (retyping the 22.68 shown for 22.6812… is no edit)
  const sameAdr = (a, b) => Math.round(a * 100) === Math.round(b * 100);
  const pctTxt = x => `${fmtNum(x * 100, 0)} %`;
  const adrTxt = a => `₹${fmtNum(a, 2)} Cr / day`;
  const setInputs = () => ins.forEach(i => { i.value = String(+(wst[i.dataset.vw] * 100).toFixed(4)); });
  const setAdr = () => { if (adrIn) adrIn.value = ast.adr.toFixed(2); };
  const paint = () => {
    const { sum, scaled } = brkValScale(wst);
    const edited = BRK_VAL_METHODS.some(([m]) => !near(wst[m], W[m]));
    const adrOn = !!ast && !sameAdr(ast.adr, adr0);
    const at = adrOn ? { ...vals, ...brkValAtAdr(fit, ast.adr) } : vals;   // regression and ratio at the reader's ADR
    const any = edited || adrOn;
    // the reader's weights (scaled to 100 %) only when they edited them; an ADR-only edit keeps the published W
    const wUse = edited ? scaled : W;
    const re = any ? (wUse ? brkValReweight(at, wUse, at.adr, close) : null) : ovr;
    const fig = (line, s) => (re ? re[line][s] : any ? null : S[line]?.[s]?.value ?? null);
    const why = re ? `recalculated on this page: Σ weight × price at ${edited
      ? `your weights ${BRK_VAL_METHODS.map(([m]) => fmtNum(wst[m] * 100, 0)).join(' / ')} %${near(sum, 1) ? '' : ' (scaled to 100 %)'}`
      : 'the published weights'}${adrOn ? `, regression and ratio at the ADR above, ${adrTxt(ast.adr)}` : ''}${patOn ? `, the ADR leg at the PAT Predictor's inputs (${patLive.desc})` : ''}` : '';
    // the regression and ratio rows: at the reader's ADR, or as published
    root.querySelectorAll('[data-vm]').forEach(td => {
      const [m, s] = td.dataset.vm.split('|'), x = adrOn ? at[m][s] : S[m]?.[s]?.value;
      td.textContent = x == null ? '—' : fmtNum(x, 2);
      td.classList.toggle('brk-pat-chg', adrOn);
      const f = fit, a = ast?.adr;
      const rule = !adrOn ? S[m]?.[s]?.rule || ''
        : m === 'regression' ? `${fmtNum(f.slope, 3)} × ${fmtNum(a, 2)}${s === 'base' ? '' : ` × (1 ${s === 'bear' ? '−' : '+'} ${pctTxt(f.band)})`} ${f.intercept < 0 ? '−' : '+'} ${fmtNum(Math.abs(f.intercept), 2)}: recalculated on this page at the ADR above`
          : `(${fmtNum(f.mean, 2)}${s === 'base' ? '' : ` ${s === 'bear' ? '−' : '+'} ${fmtNum(f.sd, 2)}`}) × ${fmtNum(a, 2)}: recalculated on this page at the ADR above`;
      if (rule) td.title = rule; else td.removeAttribute('title');
    });
    root.querySelectorAll('[data-vv]').forEach(td => {
      const [line, s] = td.dataset.vv.split('|'), x = fig(line, s);
      td.textContent = x == null ? '—' : line === 'upside' ? rxSignedPct(x) : fmtNum(x, 2);
      td.classList.toggle('brk-pat-chg', !!re);
      if (line === 'upside') { td.classList.toggle('rx-up', x != null && x >= 0); td.classList.toggle('rx-dn', x != null && x < 0); }
      const rule = why || S[line]?.[s]?.rule || '';
      if (rule) td.title = rule; else td.removeAttribute('title');
    });
    const k = sel => root.querySelector(`[data-vk="${sel}"]`);
    const setK = (sel, html) => { const e = k(sel); if (e) e.innerHTML = html; };
    BRK_VAL_SCEN.forEach(([s]) => {
      const n = fig('net', s), u = fig('upside', s);
      setK(`net-${s}`, n == null ? '—' : rxRupee(n, 0));
      setK(`up-${s}`, u == null ? '—' : rxChangeHTML(u));
    });
    setK('lbl', re && (any || patOn) ? 'Net value · base (your inputs)' : 'Net value · base');
    const sumCell = root.querySelector('[data-vsum]');
    sumCell.textContent = pctTxt(sum);
    sumCell.classList.toggle('brk-val-off', !near(sum, 1));
    if (near(sum, 1)) sumCell.removeAttribute('title'); else sumCell.title = 'The weights do not add up to 100 %: the net value uses them scaled to 100 %';
    ins.forEach(i => i.classList.toggle('is-edited', !near(wst[i.dataset.vw], W[i.dataset.vw])));
    root.querySelector('[data-val-reset]').disabled = !edited;
    root.querySelector('[data-val-state]').textContent = !edited ? `Published weights: ${BRK_VAL_METHODS.map(([m, l]) => `${l} ${pctTxt(W[m])}`).join(', ')}.`
      : !scaled ? 'Your weights add up to 0 %: there is no weighted value.'
        : `Showing your weights${near(sum, 1) ? '' : `, which add up to ${pctTxt(sum)} and are scaled to 100 %`}; the net value and upside are recalculated (tinted). Not saved.`;
    if (edited) BRK_VAL_W[broker] = { run: runId, w: { ...wst } }; else delete BRK_VAL_W[broker];
    if (ast) {
      const b0 = basisVal(ast.basis), typed = !sameAdr(ast.adr, b0);   // typed: the input differs from the basis
      adrIn.classList.toggle('is-edited', typed);
      const def = root.querySelector('[data-val-adr-default]');
      def.disabled = !typed;
      def.textContent = `Default: ${basisLbl(ast.basis)} ${fmtNum(b0, 2)}`;
      const vsQ = `${rxSignedPct(ast.adr / adr0 - 1)} vs ${adrQ ? `${adrQ}'s` : 'the quarter\'s'} average ${fmtNum(adr0, 2)}`;
      root.querySelector('[data-val-adr-state]').textContent = !adrOn
        ? `Regression and ratio at ${adrQ ? `${adrQ}'s` : 'the current quarter\'s'} average ADR so far, ${adrTxt(adr0)} (published).`
        : !typed && ast.basis === 'dma'
          ? `Regression and ratio at the 45-DMA, ${adrTxt(ast.adr)} on ${fmtLongDate(dmaNow.date)} (${vsQ}); they, the net value and the upside are recalculated (tinted). Not saved.`
          : `Regression and ratio at your ADR, ${adrTxt(ast.adr)} (${vsQ}); they, the net value and the upside are recalculated (tinted). Not saved.`;
      if (adrOn || ast.basis !== 'qtd') BRK_VAL_ADR[broker] = { run: runId, basis: ast.basis, adr: ast.adr }; else delete BRK_VAL_ADR[broker];
      // the ADR KPI tile: the ADR behind the regression, ratio and net value shown
      setK('adr-lbl', adrOn ? 'ADR in use' : 'Current ADR');
      setK('adr-v', `${rxCr(adrOn ? ast.adr : adr0, 2)}<small> / day</small>`);
      setK('adr-s', adrOn
        ? escHtml(`${!typed && ast.basis === 'dma' ? `45-DMA on ${fmtLongDate(dmaNow.date)}` : 'your ADR'} · published: ${adrQ ? `${adrQ} average` : 'quarter average'} ${fmtNum(adr0, 2)}`)
        : escHtml(adrSub));
    }
  };
  setInputs();
  setAdr();
  paint();
  root.addEventListener('input', e => {
    if (ast && e.target === adrIn) {
      const a = parseFloat(adrIn.value);
      if (!isFinite(a) || a <= 0) return;             // half-typed, zero or negative: keep the last good value
      ast.adr = a;
      return paint();
    }
    const i = e.target.closest('[data-vw]');
    if (!i) return;
    const x = parseFloat(i.value);
    if (!isFinite(x) || x < 0 || x > 100) return;   // half-typed or out of range: keep the last good value
    wst[i.dataset.vw] = x / 100;
    paint();
  });
  // leaving a box (blur or Enter) puts the value in use back in it, so a cleared, zero or out-of-range entry
  // never stays on screen beside figures computed from the last good one
  root.addEventListener('change', e => {
    if (ast && e.target === adrIn) setAdr();
    else if (e.target.closest('[data-vw]')) setInputs();
  });
  root.querySelector('[data-val-reset]').addEventListener('click', () => {
    Object.assign(wst, W);
    setInputs();
    paint();
  });
  // Default: back to the picked basis's ADR; the toggle: a basis, and its ADR into the input
  root.querySelector('[data-val-adr-default]')?.addEventListener('click', () => {
    ast.adr = basisVal(ast.basis);
    setAdr();
    paint();
  });
  if (ast) rxOnSeg(root, 'brkValAdrBasis', k => {
    ast.basis = k;
    ast.adr = basisVal(k);
    setAdr();
    paint();
  });
}

// a time axis of dates: month ticks, no grid
function brkValXTicks(dates) {
  return { grid: { display: false }, afterBuildTicks: brkMonthTicks(dates, 6), ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true } };
}

// mean ± 1 / 2 SD bands, drawn from a published mean and SD; returns the legend's HTML
function brkValBandChart(key, canvasId, dates, values, m, sd, fmt, tipLabel, { legendDigits = 1, tickDigits = 0 } = {}) {
  const xTicks = brkValXTicks;
  const flat = x => dates.map(() => x);
  const band = (lbl, x, fill, bg) => ({ label: lbl, data: flat(x), borderWidth: 0, pointRadius: 0, fill, backgroundColor: bg, tension: 0 });
  rxChart(key, canvasId, 260, {
    type: 'line',
    data: { labels: dates.map(fmtChartDate), datasets: [
      band('+2 SD', m + 2 * sd, { target: 4 }, 'rgba(43, 92, 200, 0.07)'),
      band('+1 SD', m + sd, { target: 3 }, 'rgba(43, 92, 200, 0.12)'),
      { label: 'Mean', data: flat(m), borderColor: RX.muted, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false },
      band('−1 SD', m - sd, false, 'transparent'),
      band('−2 SD', m - 2 * sd, false, 'transparent'),
      { label: tipLabel, data: values, borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0, fill: false },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { filter: i => i.datasetIndex === 5, callbacks: {
        title: items => rxDate(dates[items[0].dataIndex]),
        label: c => { const z = (c.raw - m) / sd; return ` ${tipLabel} ${fmt(c.raw)} (${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)} SD)`; } } } },
      scales: { x: xTicks(dates), y: { ticks: { callback: x => fmtNum(x, tickDigits) } } },
    },
  });
  const d = legendDigits;
  return rxLegend([
    { label: tipLabel, color: RX.ink, kind: 'line' },
    { label: `± 1 SD (${fmtNum(m - sd, d)}–${fmtNum(m + sd, d)})`, color: 'rgba(43, 92, 200, 0.19)' },
    { label: `± 2 SD (${fmtNum(m - 2 * sd, d)}–${fmtNum(m + 2 * sd, d)})`, color: 'rgba(43, 92, 200, 0.07)', style: 'box-shadow:inset 0 0 0 1px #DCE5F7' },
    { label: `Mean ${fmtNum(m, d)}`, color: RX.muted, kind: 'dash' }]);
}

// ── Consolidated P/B (Motilal Oswal; AB, 19 Nov 2026) ──
// close ÷ book value per share, the book value of the quarter in force (consolidated net worth ÷ shares, from the
// day ACE Equity switches to it: AB matched ACE), with mean ± 1 / 2 SD bands (sample SD) over
// the period picked on the chart's toggle. The engine publishes the daily P/B ('pb'), each period's band
// ('pb_bands': pb_mean, pb_sd, pb_current) and each quarter's book ('pb_book'); the page only draws them.
const BRK_PB_WINDOWS = BRK_VAL_WINDOWS.filter(([k]) => k !== 'all');
const BRK_PB_DEFAULT = '3y';

// The period to show: the one picked (if published), else 3Y, else the longest published
function brkValPbWin(pick, bands) {
  if (bands[pick]) return pick;
  if (bands[BRK_PB_DEFAULT]) return BRK_PB_DEFAULT;
  const ok = BRK_PB_WINDOWS.map(([k]) => k).filter(k => bands[k]);
  return ok.length ? ok[ok.length - 1] : null;
}

// The P/B panel's HTML: KPIs, a period toggle over the chart, and the quarters' book values under "How"
function brkValPbHtml(X, k, canvasId) {
  const lbl = BRK_PB_WINDOWS.find(w => w[0] === k)[1], last = X.pb[X.pb.length - 1];
  const seg = `<div class="rx-seg" role="group" aria-label="P/B period" data-rx-seg="brkValPb">${BRK_PB_WINDOWS.map(([w, l]) =>
    `<button type="button" data-value="${w}" aria-pressed="${w === k}"${X.pbBands[w] ? '' : ` disabled title="${escHtml(BRK_BROKER.name)}'s book values do not cover ${l}"`}>${l}</button>`).join('')}</div>`;
  const q = last.rule && /\((Q\d FY \d{4}):/.exec(last.rule);
  const close = last.pb * last.bvps;
  const kpis = [
    rxKpi('P/B now', `${fmtNum(last.pb, 2)}×`, `close ${rxRupee(close, 2)} on ${escHtml(fmtLongDate(last.date))}`, { accent: true }),
    rxKpi('Book value per share', rxRupee(last.bvps, 2), q ? `${escHtml(q[1])}, consolidated` : 'consolidated'),
    rxKpi(`<span data-pbk="mean-lbl">Mean · ${escHtml(lbl)}</span>`, '<span data-pbk="mean"></span>', '<span data-pbk="range"></span>'),
    rxKpi('Now vs the mean', '<span data-pbk="z"></span>', '<span data-pbk="z-s"></span>'),
  ].join('');
  const fmtQ = (r, d) => (r ? fmtNum(r.value, d) : '—');
  const book = X.book.map(b => `<tr><td class="rx-l">${escHtml(b.quarter)}</td><td>${escHtml(fmtLongDate((/in force from (\d{4}-\d{2}-\d{2})/.exec(b.net_worth?.rule || '') || [])[1] || ''))}</td>
    <td>${fmtQ(b.net_worth, 1)}</td><td>${fmtQ(b.shares, 4)}</td><td>${fmtQ(b.bvps, 2)}</td></tr>`).join('');
  return `<section class="rx-kpis" aria-label="Price to book">${kpis}</section>
    ${rxPanel({
    title: `Consolidated P/B · <span data-pbk="title">${escHtml(lbl)}</span>`, meta: '<span data-pbk="meta"></span>', attrs: 'data-val-chart="pb"',
    body: `<div class="brk-price-controls"><div><div class="rx-lbl">Period</div>${seg}</div></div>
      <div class="rx-pb">${rxCanvas(canvasId)}<div data-brk-leg="pb"></div></div>`,
    foot: `P/B = close ÷ book value per share; book value per share = consolidated net worth ÷ equity shares, on today's bonus-adjusted basis (as the closes are). Each quarter's book is in force from the day ACE Equity switches to it (the quarter end, or the first trading day after it), so the series matches ACE's Cons P/BV, within about 0.2 % (ACE also moves its share count inside a quarter).
      The mean and the ± 1 / 2 SD bands (sample SD) are over the period picked, so they move with it. Hover a day for its P/B, its distance from the mean and the arithmetic.`,
    how: rxHow('Book value by quarter and its source', `<div class="rx-scroll"><table class="rx-table">
      <thead><tr><th scope="col" class="rx-l">Quarter</th><th scope="col">In force from</th><th scope="col">Net worth, ₹ Cr</th><th scope="col">Shares, Cr</th><th scope="col">BVPS, ₹</th></tr></thead>
      <tbody>${book}</tbody></table></div>
      <p class="rx-foot">Net worth and share counts are reviewed rows of <code>sb_disclosure_facts</code> (metrics <code>net_worth</code>, <code>shares_period_end_cr</code>), each with its filing; the day each comes in is the <code>val_pb_dates</code> row of <code>sb_assumptions</code>, in the brokers-dashboard project.</p>`),
  })}`;
}

// Draw the P/B chart for period k and fill the KPIs that depend on it
function brkValPbDraw(root, X, k, chartKey, canvasId) {
  const b = X.pbBands[k], lbl = BRK_PB_WINDOWS.find(w => w[0] === k)[1];
  const from = brkValSince(b.pb_mean), P = X.pb.filter(r => r.date >= from);
  const m = b.pb_mean.value, sd = b.pb_sd.value, now = b.pb_current.value, z = (now - m) / sd;
  const set = (n, h) => { const e = root.querySelector(`[data-pbk="${n}"]`); if (e) e.innerHTML = h; };
  set('title', escHtml(lbl));
  set('meta', `${escHtml(fmtLongDate(P[0].date))} – ${escHtml(fmtLongDate(P[P.length - 1].date))} · ${fmtNum(P.length, 0)} days · mean ${fmtNum(m, 2)}× ± 1 SD ${fmtNum(sd, 2)}`);
  set('mean-lbl', `Mean · ${escHtml(lbl)}`);
  set('mean', `${fmtNum(m, 2)}×`);
  set('range', `± 1 SD ${fmtNum(m - sd, 2)}–${fmtNum(m + sd, 2)}× · ± 2 SD ${fmtNum(m - 2 * sd, 2)}–${fmtNum(m + 2 * sd, 2)}×`);
  set('z', `${z >= 0 ? '+' : '−'}${fmtNum(Math.abs(z), 2)} SD`);
  set('z-s', `${fmtNum(now, 2)}× vs ${fmtNum(m, 2)}× (${escHtml(lbl)})`);
  const leg = root.querySelector('[data-brk-leg="pb"]');
  leg.innerHTML = brkValBandChart(chartKey, canvasId, P.map(r => r.date), P.map(r => r.pb), m, sd, x => fmtNum(x, 2) + '×', 'Consolidated P/B', { legendDigits: 2, tickDigits: 1 });
}

// The P/B panel, wired: draws the period in BRK.valView.pb (3Y by default) and redraws on the toggle
function brkValPbWire(root, X, st) {
  const view = BRK_BROKER.view, canvasId = `brk-${view}-val-pb`, chartKey = `brk-${view}-val-pb`;
  const k = brkValPbWin(st.pb, X.pbBands);
  brkValPbDraw(root, X, k, chartKey, canvasId);
  rxOnSeg(root, 'brkValPb', w => { st.pb = w; brkValPbDraw(root, X, w, chartKey, canvasId); });
}

// The window's first date, from its fit or P/E-band rule ("2026-08-06 to …")
function brkValSince(r) { return (/^(\d{4}-\d{2}-\d{2})/.exec(r?.rule || '') || [])[1] || ''; }

// The P/E bands to draw for a Timeline window, as band keys of `bands` (the published pe_bands by window).
// A window: its own band. All: the workbook's two Angel One windows (last 3 years, since Apr 2025) where the
// series covers them, else the whole series (band 'all': Groww, from its listing in Nov 2025).
function brkValPeWindows(win, bands) {
  if (win !== 'all') return bands[win] ? [win] : [];
  const wb = ['3y', 'apr25'].filter(k => bands[k]);
  return wb.length ? wb : bands.all ? ['all'] : [];
}

async function buildBrokersValuation() {
  const el = brkSection('val'), summary = BRK.summary;
  if (!BRK.val || BRK.valFor !== summary) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading the valuation…</div></div>';
    let val;
    const slow = () => { if (BRK.summary === summary) el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Still loading the valuation… asked the server again.</div></div>'; };
    try { val = await brkFetchPatient('valuation', BRK.mode, slow); } catch (err) {
      el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load the valuation: ${escHtml(err.message)}</div></div>`;
      return;
    }
    if (BRK.summary !== summary) return;   // the broker or run changed meanwhile
    BRK.val = val; BRK.valFor = summary;
  }
  const val = BRK.val, name = escHtml(BRK_BROKER.name);
  if (!val.run || !val.rows.length) {
    el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="chart-panel brk-norun" role="status">
      <b>No valuation published for ${name} yet.</b>
      <p>${escHtml(val.reason || '')}. The brokers-dashboard engine publishes it to <code>sb_valuation_lines</code> after each ${escHtml(BRK.mode)} ADR run, with the PAT model; nothing is estimated on this page in the meantime.</p></div></div>`;
    return;
  }

  const X = brkValIndex(val.rows), st = BRK.valView;
  // a broker with only the P/B lines (no ADR valuation or PAT model: Motilal Oswal)
  const pbWin = X.pb.length ? brkValPbWin(st.pb, X.pbBands) : null;
  if (!Object.keys(X.sum).length) {
    if (!pbWin) {
      el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="chart-panel brk-norun" role="status"><b>No valuation published for ${name} yet.</b></div></div>`;
      return;
    }
    el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="rx">
      ${rxAlert(`<strong>Price to book, as the engine published it</strong> for ${name} (run <code title="${escHtml(val.run.run_id)}">${escHtml(val.run.run_id.slice(0, 8))}</code>, as of ${escHtml(fmtLongDate(val.run.as_of_date))}). Every figure is the engine's; the page only draws the bands from the published mean and SD.`, 'info')}
      ${brkValPbHtml(X, pbWin, `brk-${BRK_BROKER.view}-val-pb`)}
    </div></div>`;
    brkValPbWire(el.firstElementChild, X, st);
    return;
  }
  const avail = BRK_VAL_WINDOWS.filter(([k]) => X.sum[k] || X.bands[k]).map(([k]) => k);
  if (!avail.includes(st.win)) st.win = 'all';
  const win = st.win, fitWin = X.sum[win] ? win : 'all';   // a window only the P/E history covers keeps the All fit
  const S = X.sum[fitWin], I = { ...X.common, ...X.inputs[fitWin] };
  const inp = k => I[k]?.value ?? null;
  const close = inp('close'), closeOn = /close on (\d{4}-\d{2}-\d{2})/.exec(I.close?.rule || '');
  // The ADR method at the PAT Predictor's inputs, while the reader has edited them (BRK_PAT_LIVE, js/33)
  const patLive = BRK_PAT_LIVE[BRK_BROKER.id];
  const W = Object.fromEntries(BRK_VAL_METHODS.map(([m]) => [m, X.weight[m]?.value]));
  const complete = !!close && BRK_VAL_METHODS.every(([m]) => W[m] != null && BRK_VAL_SCEN.every(([s]) => S[m]?.[s]?.value != null));
  const patOn = !!(patLive?.edited && complete);
  // each method's price per scenario; the ADR leg at the PAT Predictor's inputs while those are edited
  const vals = complete ? Object.fromEntries(BRK_VAL_METHODS.map(([m]) => [m, Object.fromEntries(BRK_VAL_SCEN.map(([s]) =>
    [s, m === 'adr' && patOn ? patLive.targets[s] : S[m][s].value]))])) : null;
  const ovr = patOn ? brkValReweight(vals, W, vals.adr, close) : null;   // at the published weights
  // the weights as inputs (only with every method's figures published): the reader's, else the published
  const wSaved = BRK_VAL_W[BRK_BROKER.id];
  const wst = complete ? (wSaved && wSaved.run === val.run.run_id ? { ...wSaved.w } : { ...W }) : null;
  // the ADR the regression and ratio methods use: the reader's (this run), else the published current ADR
  const adr0 = inp('adr_now');
  const fit = { slope: inp('slope'), intercept: inp('intercept'), band: inp('band'), mean: inp('ratio_mean'), sd: inp('ratio_sd') };
  const adrQ = brkValQuarter(val.run.as_of_date);   // the quarter of adr_now: the run's as-of date's
  const adrSub = (I.adr_now?.rule || '').replace(/^mean daily ADR \(broking \+ MTF\) over /, '');   // the ADR tile's line
  // the page's formula must reproduce the published regression and ratio prices at the published ADR, else no input
  const adrOff = adr0 && Object.values(fit).every(x => x != null) ? brkValAdrCheck(fit, adr0, S) : ['no fit'];
  if (adrOff.length && adr0) console.warn(`Valuation ${BRK_BROKER.id}: the ADR input is off; the page's regression / ratio formula does not reproduce the published ${adrOff.join(', ')}`);
  const dmaNow = brkValLatestDma(X.days);   // the 45-DMA basis: the series' latest 45-day ADR
  const aSaved = BRK_VAL_ADR[BRK_BROKER.id], aKeep = aSaved && aSaved.run === val.run.run_id;
  const ast = wst && !adrOff.length
    ?{ basis: aKeep && (aSaved.basis !== 'dma' || dmaNow) ? aSaved.basis : 'qtd', adr: aKeep ? aSaved.adr : adr0 } : null;
  const v = (line, s) => (ovr && ovr[line] ? ovr[line][s] : S[line]?.[s]?.value ?? null);
  const ovrRule = line => (ovr && ovr[line] ? ` title="${escHtml(`recalculated on this page from the PAT Predictor tab's inputs (${patLive.desc})`)}"` : null);
  const winLabel = k => BRK_VAL_WINDOWS.find(w => w[0] === k)[1];
  const seg = `<div class="rx-seg" role="group" aria-label="Timeline" data-rx-seg="brkValWin">${BRK_VAL_WINDOWS.map(([k, l]) => {
    const on = avail.includes(k);
    return `<button type="button" data-value="${k}" aria-pressed="${k === win}"${on ? '' : ` disabled title="${escHtml(BRK_BROKER.name)}'s data do not cover ${l}"`}>${l}</button>`;
  }).join('')}</div>`;
  const fitSince = brkValSince(I.fit_days);
  const controls = `<div class="brk-price-controls"><div><div class="rx-lbl">Timeline</div>${seg}</div></div>
    <p class="rx-foot brk-price-foot">${win === 'all'
      ? `All: the workbook's window, every day with a 45-day ADR and a close (${escHtml(fmtLongDate(fitSince))} on).`
      : fitWin === win ? `${winLabel(win)}: the regression and the ratio bands are fitted over the days from ${escHtml(fmtLongDate(fitSince))}; the ADR leg does not depend on the window.`
        : `${winLabel(win)}: ${escHtml(BRK_BROKER.name)}'s daily ADR starts later than the window, so the regression and ratio stay on All (from ${escHtml(fmtLongDate(fitSince))}); the P/E band uses ${winLabel(win)}.`}
      Greyed-out periods start before the data do. Each chart has its own Timeline too; picking one here sets them all.</p>`;
  const sameRun = summary.run && summary.run.run_id === val.run.run_id;
  const view = BRK_BROKER.view, id = s => `brk-${view}-val-${s}`;
  const tip = (r, line) => (line && ovrRule(line)) || (r?.rule ? ` title="${escHtml(r.rule)}"` : '');
  const pct = w => `${fmtNum(w * 100, 0)} %`;

  // ── KPIs ──
  const kpis = [
    rxKpi('Share price', rxRupee(close, 2), closeOn ? `close on ${escHtml(fmtLongDate(closeOn[1]))}` : ''),
    rxKpi(`<span data-vk="lbl">${ovr ? 'Net value · base (your inputs)' : 'Net value · base'}</span>`, `<span data-vk="net-base">${rxRupee(v('net', 'base'), 0)}</span>`,
      v('upside', 'base') == null ? '' : `<span data-vk="up-base">${rxChangeHTML(v('upside', 'base'))}</span> vs the close`, { accent: true }),
    rxKpi('Bear – bull', `<span data-vk="net-bear">${rxRupee(v('net', 'bear'), 0)}</span> – <span data-vk="net-bull">${rxRupee(v('net', 'bull'), 0)}</span>`,
      `<span data-vk="up-bear">${rxChangeHTML(v('upside', 'bear'))}</span> to <span data-vk="up-bull">${rxChangeHTML(v('upside', 'bull'))}</span>`),
    rxKpi('<span data-vk="adr-lbl">Current ADR</span>', `<span data-vk="adr-v">${rxCr(inp('adr_now'), 2)}<small> / day</small></span>`, `<span data-vk="adr-s">${escHtml(adrSub)}</span>`),
    rxKpi('Regression R²', fmtNum(inp('r2'), 3), `${fmtNum(inp('fit_days'), 0)} days in the fit`),
  ].join('');

  // ── Triangulation ──
  const wCell = (m, lbl) => (wst
    ? `<td class="brk-val-w"><input class="rx-in rx-num-in" type="number" step="5" min="0" max="100" inputmode="decimal" data-vw="${m}" aria-label="Weight of ${escHtml(lbl)}, %"${X.weight[m]?.rule ? ` title="${escHtml(`published: ${pct(W[m])} · ${X.weight[m].rule}`)}"` : ''}><span class="brk-val-unit">%</span></td>`
    : `<td>${X.weight[m] ? pct(X.weight[m].value) : '—'}</td>`);
  const row = ([m, lbl]) => `<tr><td class="rx-l">${escHtml(lbl)}</td>${wCell(m, lbl)}${BRK_VAL_SCEN.map(([s]) =>
    `<td${tip(S[m]?.[s], m)}${ovr && ovr[m] ? ' class="brk-pat-chg"' : ''}${ast && m !== 'adr' ? ` data-vm="${m}|${s}"` : ''}>${v(m, s) == null ? '—' : fmtNum(v(m, s), 2)}</td>`).join('')}</tr>`;
  // the ADR the regression and ratio methods value at (its own panel, right above the valuation): a toggle between
  // the latest 45-DMA and the current quarter's average so far (the published one), and an input for any ADR
  const basisLbl = k => (k === 'dma' ? '45-DMA' : `${adrQ || 'Quarter'} average`);
  const basisVal = k => (k === 'dma' ? dmaNow?.dma : adr0);
  const adrPanel = ast ? rxPanel({
    title: 'ADR for regression and ratio', meta: '₹ Cr / day, broking + MTF · the PAT model (ADR method) is not affected',
    body: `<div class="brk-val-adr">
      <div><div class="rx-lbl">Basis</div><div class="rx-seg" role="group" aria-label="ADR basis" data-rx-seg="brkValAdrBasis">${BRK_VAL_ADR_BASES.map(([k]) => {
        const x = basisVal(k);
        return `<button type="button" data-value="${k}" aria-pressed="${k === ast.basis}"${x == null ? ' disabled' : ''} title="${escHtml(k === 'dma'
          ? (dmaNow ? `45-day average of daily ADR on ${fmtLongDate(dmaNow.date)}` : 'no 45-day ADR published')
          : (I.adr_now?.rule || ''))}">${escHtml(basisLbl(k))}${x == null ? '' : ` · ${fmtNum(x, 2)}`}</button>`;
      }).join('')}</div></div>
      <div><label class="rx-lbl" for="${`brk-${BRK_BROKER.view}-val-adr`}">ADR (type your own)</label>
        <span class="brk-val-adr-in"><input id="${`brk-${BRK_BROKER.view}-val-adr`}" class="rx-in rx-num-in" type="number" step="0.5" min="0" inputmode="decimal" data-vadr aria-describedby="${`brk-${BRK_BROKER.view}-val-adr-st`}"><span class="brk-val-unit">₹ Cr / day</span></span></div>
      <button type="button" class="rx-btn" data-val-adr-default>Default</button>
      <p class="rx-foot" id="${`brk-${BRK_BROKER.view}-val-adr-st`}" data-val-adr-state role="status" aria-live="polite"></p></div>`,
  }) : '';
  const triangulation = rxPanel({
    title: 'Valuation: three methods', meta: `₹ per share · ${escHtml(winLabel(fitWin))}${ovr ? ' · ADR method at the PAT Predictor\'s inputs' : ''} · hover a figure for its arithmetic`,
    body: `<div class="rx-scroll"><table class="rx-table brk-val-table">
      <thead><tr><th scope="col" class="rx-l">Method</th><th scope="col">Weight</th>${BRK_VAL_SCEN.map(([, l]) => `<th scope="col">${l}</th>`).join('')}</tr></thead>
      <tbody>${BRK_VAL_METHODS.map(row).join('')}
        <tr class="rx-sub"><td class="rx-l">Net value (weighted)</td><td data-vsum>100 %</td>${BRK_VAL_SCEN.map(([s]) => `<td data-vv="net|${s}"${tip(S.net?.[s], 'net')}${ovr ? ' class="brk-pat-chg"' : ''}>${fmtNum(v('net', s), 2)}</td>`).join('')}</tr>
        <tr><td class="rx-l">Upside vs the close</td><td></td>${BRK_VAL_SCEN.map(([s]) => { const u = v('upside', s); return `<td data-vv="upside|${s}" class="${u >= 0 ? 'rx-up' : 'rx-dn'}${ovr ? ' brk-pat-chg' : ''}"${tip(S.upside?.[s], 'upside')}>${rxSignedPct(u)}</td>`; }).join('')}</tr>
      </tbody></table></div>
      ${wst ? `<div class="brk-val-wbar"><button type="button" class="rx-btn" data-val-reset>Reset weights to published</button>
        <p class="rx-foot" data-val-state role="status" aria-live="polite"></p></div>` : ''}`,
    foot: `Regression: ${escHtml(I.slope ? `price = ${fmtNum(inp('slope'), 3)} × 45-day ADR + ${fmtNum(inp('intercept'), 2)}` : '—')}; bear / bull move the slope term by ∓ ${pct(inp('band') || 0)}.
      Ratio: price ÷ 45-day ADR, mean ${fmtNum(inp('ratio_mean'), 2)} ± 1 SD ${fmtNum(inp('ratio_sd'), 2)}, × ${ast ? 'the ADR above' : 'the current quarter\'s ADR'}; the regression too is valued at ${ast ? 'that ADR' : 'it'}.
      ADR: the PAT Predictor tab's FY 2028 target price today (P/E × EPS, discounted)${ovr ? `, here at the inputs you set on that tab (${escHtml(patLive.desc)}), so the ADR row, the net value and the upside are recalculated on this page with the weights in the table; reset them there to see the published figures` : ''}.
      ${wst ? 'Weights: type your own and the net value and upside are recalculated on this page (Σ weight × price; weights that do not add up to 100 % are scaled to it); edits are not saved.' : ''}
      ${ast ? `The regression and ratio rows value the ADR in the panel above (published: ${escHtml(adrQ || 'the current quarter')}'s average so far, ${fmtNum(adr0, 2)}); pick the 45-DMA or type your own and they are recalculated with this window's fit, then the net value and upside. Not saved.` : ''}`,
    how: rxHow('Inputs and their source', `<div class="rx-scroll"><table class="rx-table">
      <tbody>${Object.values(I).sort((a, b) => a.sort_order - b.sort_order).map(r => `<tr><td class="rx-l">${escHtml(r.label)}</td><td>${r.unit === 'fraction' ? fmtNum(r.value, 3) : fmtNum(r.value, r.unit === 'days' ? 0 : 2)}</td><td class="rx-l rx-wrap">${escHtml(r.rule || '')}</td></tr>`).join('')}</tbody></table></div>
      <p class="rx-foot">The weights, band, 45-day window and series start are rows of <code>sb_assumptions</code> (key prefix <code>val_</code>) in the brokers-dashboard project, each naming its workbook cell.</p>`),
  });

  // ── Charts (the workbook's ADR model sheets), each with its own Timeline (BRK.valView.chart, kept until the
  // Timeline above is changed, which sets them all) ──
  const chartWin = st.chart || (st.chart = {});
  const winKeys = BRK_VAL_WINDOWS.map(([k]) => k);
  const fitOk = winKeys.filter(k => X.sum[k]);        // the ADR charts: windows the engine fitted
  const peOk = winKeys.filter(k => X.bands[k]);       // the P/E charts: windows with a published band
  const peKeys = X.pe.length ? brkValPeWindows(win, X.bands) : [];   // one P/E chart per default band
  const pick = (name, dflt, ok) => (ok.includes(chartWin[name]) ? chartWin[name] : dflt);
  const winSel = (name, cur, ok) => `<label class="brk-val-cw"><span>Timeline</span><select class="rx-in" data-val-cw="${name}" aria-label="Timeline of this chart" title="Greyed-out periods start before the data do">${BRK_VAL_WINDOWS.map(([k, l]) =>
    `<option value="${k}"${k === cur ? ' selected' : ''}${ok.includes(k) ? '' : ' disabled'}>${l}</option>`).join('')}</select></label>`;
  const panel = (name, title, ok, cur) => rxPanel({ cls: 'rx-col-half', title, meta: '…', attrs: `data-val-chart="${name}"`,
    right: winSel(name, cur, ok), body: `<div class="rx-pb">${rxCanvas(id(name))}<div data-brk-leg="${name}"></div></div>` });
  const ADR_CHARTS = [['line', 'Share price vs 45-day ADR'], ['scatter', 'Share price vs 45-day ADR: fit'],
    ['ratio', 'Share price ÷ 45-day ADR'], ['implied', 'Actual vs regression-implied price']];
  const peLabel = k => (k === '3y' ? 'last 3 years' : k === 'apr25' ? 'since Apr 2025'
    : k === 'all' ? `all days, from ${fmtLongDate(brkValSince(X.bands.all.pe_mean))}` : winLabel(k));
  const peTitle = k => `Consolidated TTM P/E · ${peLabel(k)}`;
  const charts = ADR_CHARTS.map(([n, t]) => panel(n, t, fitOk, pick(n, fitWin, fitOk)))
    .concat(peKeys.map((k0, i) => panel(`pe${i}`, peTitle(pick(`pe${i}`, k0, peOk)), peOk, pick(`pe${i}`, k0, peOk))));

  el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="rx">
    ${rxAlert(`<strong>Valuation, as the engine published it</strong> from ${name}'s daily ADR (run <code title="${escHtml(val.run.run_id)}">${escHtml(val.run.run_id.slice(0, 8))}</code>, as of ${escHtml(fmtLongDate(val.run.as_of_date))})${sameRun ? '' : ', an earlier run than the ADR tabs show: the valuation has not been published for the latest run yet'}. ${ovr ? `The ADR method uses the PAT Predictor tab's inputs as you edited them (${escHtml(patLive.desc)}): it, the net value and the upside are recalculated on this page; every other figure is the engine's.` : 'Every figure is the engine\'s; the page only draws chart lines from its published parameters.'}`, 'info')}
    ${controls}
    <section class="rx-kpis" aria-label="Valuation summary">${kpis}</section>
    ${adrPanel}${triangulation}
    <div class="rx-row">${charts.join('')}</div>
    ${pbWin ? brkValPbHtml(X, pbWin, `brk-${view}-val-pb`) : ''}
  </div></div>`;
  const root = el.firstElementChild;
  rxOnSeg(root, 'brkValWin', k => { st.win = k; st.chart = {}; buildBrokersValuation(); });
  if (wst) brkValWeightInputs(root, { W, wst, vals, S, ovr, close, patOn, patLive, runId: val.run.run_id, broker: BRK_BROKER.id, ast, adr0, fit, adrQ, dmaNow, basisLbl, basisVal, adrSub });

  const xTicks = brkValXTicks;
  const rupee = { ticks: { callback: x => '₹' + fmtNum(x, 0) } };
  // a window's days (every day with a 45-day ADR and a close, from the window's first fitted day) and its fit
  const daysOf = k => { const from = k === 'all' ? '' : brkValSince(X.inputs[k]?.fit_days); return X.days.filter(d => d.dma != null && d.price != null && d.date >= from); };
  const fitOf = k => { const g = n => X.inputs[k]?.[n]?.value ?? null; return { slope: g('slope'), intercept: g('intercept'), r2: g('r2'), mean: g('ratio_mean'), sd: g('ratio_sd'), n: g('fit_days') }; };
  const head = (name, meta, title) => {
    const p = root.querySelector(`[data-val-chart="${name}"]`);
    if (title) p.querySelector('h2').textContent = title;
    p.querySelector('.rx-meta').textContent = meta;
  };
  const span = (D, k) => `${winLabel(k)}: ${fmtTradeDate(D[0].date)} – ${fmtTradeDate(D[D.length - 1].date)}`;

  const bandChart = brkValBandChart;
  const legOf = name => root.querySelector(`[data-brk-leg="${name}"]`);

  const draw = {
    line(name, k) {
      const D = daysOf(k);
      head(name, `${span(D, k)} · ₹ (left) · ₹ Cr / day (right)`);
      rxChart(`brk-${view}-val-line`, id('line'), 260, {
        type: 'line',
        data: { labels: D.map(r => fmtChartDate(r.date)), datasets: [
          { label: 'Share price', data: D.map(r => r.price), borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0, yAxisID: 'y' },
          { label: '45-day ADR', data: D.map(r => r.dma), borderColor: RX.rev, borderWidth: 1.5, pointRadius: 0, tension: 0, yAxisID: 'y1' },
        ] },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { callbacks: { title: items => rxDate(D[items[0].dataIndex].date), label: c => c.datasetIndex ? ` 45-day ADR ₹${fmtNum(c.raw, 2)} Cr` : ` Close ₹${fmtNum(c.raw, 2)}` } } },
          scales: { x: xTicks(D.map(r => r.date)), y: rupee, y1: { position: 'right', grid: { display: false }, ticks: { callback: x => fmtNum(x, 0) } } },
        },
      });
      legOf(name).innerHTML = rxLegend([
        { label: 'Share price (₹, left)', color: RX.ink, kind: 'line' }, { label: '45-day ADR (₹ Cr / day, right)', color: RX.rev, kind: 'line' }]);
    },
    scatter(name, k) {
      const D = daysOf(k), f = fitOf(k), fitAt = x => f.slope * x + f.intercept;
      const xs = D.map(r => r.dma), xMin = Math.min(...xs), xMax = Math.max(...xs), last = D[D.length - 1];
      head(name, `${winLabel(k)}: price = ${fmtNum(f.slope, 2)} × ADR ${f.intercept < 0 ? '−' : '+'} ${fmtNum(Math.abs(f.intercept), 2)} · R² ${fmtNum(f.r2, 3)} · ${fmtNum(f.n, 0)} days`);
      rxChart(`brk-${view}-val-scatter`, id('scatter'), 260, {
        type: 'scatter',
        data: { datasets: [
          { label: 'Day', data: D.map(r => ({ x: r.dma, y: r.price, date: r.date })), pointBackgroundColor: D.map((r, i) => RX.seq[Math.min(4, Math.floor(i / D.length * 5))]),
            pointBorderColor: '#FFFFFF', pointBorderWidth: 0.5, pointRadius: 3, pointHoverRadius: 5 },
          { label: 'Latest', data: [{ x: last.dma, y: last.price, date: last.date }], pointBackgroundColor: '#FFFFFF', pointBorderColor: RX.ink, pointBorderWidth: 2, pointRadius: 6 },
          { type: 'line', label: 'Fit', data: [{ x: xMin, y: fitAt(xMin) }, { x: xMax, y: fitAt(xMax) }], borderColor: RX.model, borderDash: [5, 3], borderWidth: 1.75, pointRadius: 0 },
        ] },
        options: {
          plugins: { tooltip: { filter: i => i.dataset.label !== 'Fit', callbacks: { title: items => rxDate(items[0].raw.date), label: c => ` 45-day ADR ₹${fmtNum(c.parsed.x, 2)} Cr · close ₹${fmtNum(c.parsed.y, 0)}` } } },
          scales: { x: { type: 'linear', grace: '4%', title: { display: true, text: '45-day ADR, ₹ Cr / day' } }, y: { grace: '4%', ...rupee } },
        },
      });
      legOf(name).innerHTML = rxLegend([
        { label: 'Older', color: RX.seq[0] }, { label: 'Recent', color: RX.seq[4] },
        { label: `Latest (${fmtTradeDate(last.date)})`, color: '#FFFFFF', style: `border:2px solid ${RX.ink};border-radius:50%;width:11px;height:11px` },
        { label: 'Fit', color: RX.model, kind: 'dash' }]);
    },
    ratio(name, k) {
      const D = daysOf(k), f = fitOf(k);
      head(name, `${span(D, k)} · mean ± 1 / 2 SD (population)`);
      legOf(name).innerHTML = bandChart(`brk-${view}-val-ratio`, id('ratio'), D.map(r => r.date), D.map(r => r.ratio),
        f.mean, f.sd, x => fmtNum(x, 2) + '×', 'Price ÷ 45-day ADR');
    },
    implied(name, k) {
      const D = daysOf(k), f = fitOf(k), fitAt = x => f.slope * x + f.intercept;
      head(name, `${span(D, k)} · ₹ · fitted over these days`);
      rxChart(`brk-${view}-val-implied`, id('implied'), 260, {
        type: 'line',
        data: { labels: D.map(r => fmtChartDate(r.date)), datasets: [
          { label: 'Actual', data: D.map(r => r.price), borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0 },
          { label: 'Regression-implied', data: D.map(r => (k === 'all' ? r.implied : fitAt(r.dma))), borderColor: RX.model, borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, tension: 0 },
        ] },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { callbacks: { title: items => rxDate(D[items[0].dataIndex].date), label: c => ` ${c.dataset.label} ₹${fmtNum(c.raw, 0)}` } } },
          scales: { x: xTicks(D.map(r => r.date)), y: rupee },
        },
      });
      legOf(name).innerHTML = rxLegend([
        { label: 'Actual share price', color: RX.ink, kind: 'line' }, { label: 'Regression-implied price', color: RX.model, kind: 'dash' }]);
    },
    pe(name, k) {
      const b = X.bands[k], from = brkValSince(b.pe_mean), P = X.pe.filter(r => r.date >= from);
      head(name, `mean ${fmtNum(b.pe_mean.value, 1)}× ± 1 / 2 SD ${fmtNum(b.pe_sd.value, 1)} · ${b.pe_mean.rule}`, peTitle(k));
      legOf(name).innerHTML = bandChart(`brk-${view}-val-${name}`, id(name), P.map(r => r.date), P.map(r => r.pe),
        b.pe_mean.value, b.pe_sd.value, x => fmtNum(x, 1) + '×', 'Consolidated TTM P/E');
    },
  };
  const drawChart = (name, k) => (name.startsWith('pe') ? draw.pe(name, k) : draw[name](name, k));
  ADR_CHARTS.forEach(([n]) => drawChart(n, pick(n, fitWin, fitOk)));
  peKeys.forEach((k0, i) => drawChart(`pe${i}`, pick(`pe${i}`, k0, peOk)));
  if (pbWin) brkValPbWire(root, X, st);
  root.querySelectorAll('[data-val-cw]').forEach(sel => sel.addEventListener('change', () => {
    chartWin[sel.dataset.valCw] = sel.value;
    drawChart(sel.dataset.valCw, sel.value);
  }));
}
