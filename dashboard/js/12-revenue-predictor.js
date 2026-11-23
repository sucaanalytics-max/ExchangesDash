// dashboard/js/12-revenue-predictor.js — Revenue Predictor tab and the NSE default forecast.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

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
// REVENUE PREDICTOR TAB — one scenario model per exchange
// ========================
// The quarter's transaction revenue = revenue banked so far + daily revenue
// for the sessions left × those sessions. Bear, Base and Bull show side by
// side: Base runs the sessions left at the expiry-aware pace (predictorRestMix),
// Bear / Bull scale it ∓ a spread (15 % unless edited). At the flat
// quarter-to-date pace predictorScenario reproduces the pipeline's
// extrapolation (pnl_predictor), and for NSE its default ratio-model forecast
// line for line (the P&L's "Published" column). NSE carries the ratio model to PAT and
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

// ── Expiry-aware pace for the sessions left (NSE, BSE) ──
// The sessions left split into expiry, pre-expiry and other days: the scheduled
// expiries (EXPIRY_RULES, the exchange's own weekly expiry) over the quarter's
// remaining weekdays, scaled to the sessions left (the browser knows no future
// holidays). Each kind runs at its quarter-to-date per-segment average, or the
// last 60 sessions' when the quarter has fewer than 3 days of that kind, or the
// flat QTD average when those are short too. MCX keeps the flat QTD pace.
const PREDICTOR_MIN_BUCKET = 3;
const PREDICTOR_BUCKETS = [['e', 'expiry'], ['p', 'pre-expiry'], ['o', 'other']];

// Last calendar day of an Indian FY quarter label ("Q3 FY 2027" → "2026-12-31")
function quarterEndIso(label) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  if (!m) return null;
  const fy = +m[2];
  return [`${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`][+m[1] - 1];
}

function predictorNextIso(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// { perSeg: daily ₹ Cr per segment for the sessions left, mix: { e, p, o } session
// counts (null when flat), src: where each kind's average came from, rest }
function predictorRestMix(ex, ctx, days, dailyAll) {
  const rest = Math.max(days - ctx.n, 0);
  const flat = { ...ctx.adr };
  const out = { perSeg: flat, mix: null, src: null, avg: null, rest };
  if (!EXPIRY_RULES.some(r => r.exchange === ex) || !rest || !ctx.daily.length) return out;
  const end = quarterEndIso(ctx.cq.quarter);
  if (!end) return out;
  let e = 0, p = 0, w = 0;
  for (let d = predictorNextIso(ctx.daily[ctx.daily.length - 1].date); d <= end; d = predictorNextIso(d)) {
    const wd = new Date(d + 'T00:00:00Z').getUTCDay();
    if (wd === 0 || wd === 6) continue;
    w++;
    if (isScheduledExpiry(ex, d)) e++;
    else if (isScheduledExpiry(ex, predictorNextIso(d))) p++;
  }
  if (!w) return out;
  const scale = Math.min(1, rest / w);
  const E = Math.round(e * scale), P = Math.min(Math.round(p * scale), rest - E), O = Math.max(rest - E - P, 0);
  const all = dailyAll || [];
  const exp = expiryDateSet(all, ex), pre = preExpiryDateSet(all, ex);
  const kind = r => (exp.has(r.date) ? 'e' : pre.has(r.date) ? 'p' : 'o');
  const avg = (rows, k) => {
    const sel = rows.filter(r => kind(r) === k);
    return sel.length >= PREDICTOR_MIN_BUCKET ? Object.fromEntries(ctx.segs.map(sg => [sg, sel.reduce((a, r) => a + (r[sg + '_rev'] || 0), 0) / sel.length])) : null;
  };
  const recent = all.slice(-60);
  const b = {}, src = {};
  PREDICTOR_BUCKETS.forEach(([k]) => {
    b[k] = avg(ctx.daily, k); src[k] = 'quarter to date';
    if (!b[k]) { b[k] = avg(recent, k); src[k] = 'last 60 sessions'; }
    if (!b[k]) { b[k] = flat; src[k] = 'flat QTD average'; }
  });
  const perSeg = Object.fromEntries(ctx.segs.map(sg => [sg, (E * b.e[sg] + P * b.p[sg] + O * b.o[sg]) / rest]));
  return { perSeg, mix: { e: E, p: P, o: O }, src, avg: b, rest };
}

// "29 left: 4 expiry · 4 pre-expiry · 21 other"
function predictorMixText(mix, rest) {
  if (!mix) return `${rest} left, each at the quarter-to-date average`;
  return `${rest} left: ${PREDICTOR_BUCKETS.map(([k, l]) => `${mix[k]} ${l}`).join(' · ')}`;
}

// ── Saved scenario: this browser's edits, per exchange and quarter ──
const PREDICTOR_STORAGE_KEY = 'revenue_predictor_v1';
function readPredictorStore() {
  try {
    const o = JSON.parse(localStorage.getItem(PREDICTOR_STORAGE_KEY) || 'null');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) { return {}; }   // storage blocked or unreadable: nothing saved
}
function readPredictorSaved(ex, quarter) {
  const e = readPredictorStore()[ex];
  return e && e.quarter === quarter && e.v && typeof e.v === 'object' ? e : null;
}
function writePredictorSaved(ex, quarter, edits, spread) {
  const o = readPredictorStore();
  if (Object.keys(edits).length || spread !== PREDICTOR_PRESET_PCT) o[ex] = { quarter, v: edits, spread };
  else delete o[ex];
  try { localStorage.setItem(PREDICTOR_STORAGE_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked: not remembered */ }
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
  const cqL = ctx.cq.quarter;
  // Base: the expiry-aware pace for the sessions left (flat QTD for MCX)
  const restMix = predictorRestMix(ex, ctx, ctx.days, DATA.daily_all || DATA.daily || []);
  const defaults = predictorDefaults(ex, ctx);
  ctx.segs.forEach(k => { defaults[k] = restMix.perSeg[k]; });
  // This browser's saved edits for this quarter, over the defaults
  const v = { ...defaults };
  const saved = readPredictorSaved(ex, cqL);
  if (saved) Object.entries(saved.v).forEach(([k, x]) => { if (k in defaults && isFinite(x) && x >= 0) v[k] = k === 'days' ? Math.max(Math.round(x), ctx.n) : x; });
  let spread = saved && isFinite(saved.spread) && saved.spread >= 0 && saved.spread < 100 ? saved.spread : PREDICTOR_PRESET_PCT;
  const nextL = shiftQuarter(cqL, 1);
  const lyL = shiftQuarter(cqL, -4);
  const prevL = shiftQuarter(cqL, -1);
  const cqFlags = periodFlags(ctx.cq, 'total');
  const lyModelled = ctx.ly && periodFlags(ctx.ly, 'total').modelled;
  const prevModelled = ctx.prev && periodFlags(ctx.prev, 'total').modelled;
  const groups = predictorFields(ex, ctx);
  groups[0].fields.forEach(f => { f.tag = rxChip(restMix.mix ? 'Expiry-aware pace' : `QTD avg · ${ctx.n} sessions`, 'data'); });
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

  const baseHow = `<li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left. ${restMix.mix
      ? `Base runs the sessions left at the expiry-aware pace: ${predictorMixText(restMix.mix, restMix.rest)}, each kind at its average (${PREDICTOR_BUCKETS.map(([k, l]) => `${l}: ${restMix.src[k]}`).join('; ')}). The expiries counted are ${name}’s own weekly expiries, scheduled over the weekdays left; holidays are not known in advance, so the split is scaled to the sessions left.`
      : 'Base runs the sessions left at the quarter-to-date average.'}</li>
      <li>Bear / Bull: the Base daily revenue for the sessions left ∓ ${fmtNum(spread, 0)} % (the spread is an input).</li>`;
  const howNSE = model ? rxHow('How the forecast works', `<ul>${baseHow}
      <li>Other operating revenue (${fmtPct(model.other_operating_revenue_ratio)}) and other income (${fmtPct(model.non_operating_income_ratio)}) scale with transaction revenue; operating expenses (${fmtPct(model.operating_expense_ratio)}) and depreciation (${fmtPct(model.depreciation_ratio)}) scale with operating revenue; associates ${rxCr(model.share_profit_associates)}; tax at the ${shortQuarterRange(model.tax_rate_quarters)} effective rate (${fmtPct(model.tax_rate)}).</li>
      <li>Ratios come from actual ${nseQuarterRange(model.base_quarters)}${Object.keys(model.one_offs_excluded || {}).length ? `, one-offs excluded (${Object.entries(model.one_offs_excluded).map(([q, o]) => `${nseOneOffText(o)} in ${q}`).join('; ')})` : ''}. Forecasts carry no one-offs.</li>
      <li>“Published” is the pipeline’s own default forecast (flat quarter-to-date pace). ${nextL} grows transaction revenue at the current quarter’s year-on-year per-session rate. ${NSE_EBITDA_DEF}</li>
    </ul>`) : '';
  const howBSE = rxHow('How this estimate works', `<ul>${baseHow}
      <li>Other income and PAT margin are the starting values of the Excel “Quarterly Predictor”; BSE’s reported P&amp;L is not in this repo, so there are no actuals to compare against.</li>
      <li>BSE cash revenue for the latest quarter is at a provisional calibrated rate until BSE reports it (marked est.).</li>
    </ul>`);
  const howMCX = rxHow('How this estimate works', `<ul>${baseHow}
      <li>MCX stops at revenue: no MCX other-income or margin inputs are maintained here. MCX total revenue is futures + options; days before 2 Sep 2024 are modelled and left out of comparisons.</li>
    </ul>`);

  const pnlPanel = ex === 'nse' && model ? rxPanel({ cls: 'rx-col-wide', title: 'P&amp;L', meta: '₹ Cr · operating EBITDA excludes other income',
      body: `<div class="rx-scroll"><table class="rx-table rx-scen" data-rx="pnl"></table></div>`, foot: '<span data-rx="pnlFoot"></span>', how: howNSE })
    : ex === 'bse' ? rxPanel({ cls: 'rx-col-wide', title: 'Quarter P&amp;L', meta: '₹ Cr · Excel quarterly model',
      body: `<div class="rx-scroll"><table class="rx-table rx-scen" data-rx="pnl"></table></div>`, how: howBSE })
    : rxPanel({ cls: 'rx-col-wide', title: 'Segments', meta: '₹ Cr', body: `<div class="rx-scroll"><table class="rx-table rx-scen" data-rx="segs"></table></div>`, how: howMCX });
  const bridgePanel = hasPnl ? rxPanel({ cls: 'rx-col-narrow', title: 'Base bridge', meta: `${cqL}, ₹ Cr`,
      body: `<div class="rx-pb"><div class="rx-walk" data-rx="walk"></div><div style="margin-top:10px">${rxLegend([{ label: 'Subtotal', color: RX.ink }, { label: 'Adds', color: RX.add }, { label: 'Deducts', color: RX.deduct }])}</div></div>` })
    : rxPanel({ cls: 'rx-col-narrow', title: 'Segment mix', meta: `${cqL} Base`, body: '<div class="rx-pb" data-rx="mix"></div>' });

  const histTitle = ex === 'nse' && model ? 'PAT by quarter' : 'Transaction revenue by quarter';
  const histMeta = ex === 'nse' && model ? '₹ Cr · reported, manual nse_pnl forecasts, and the forecast' : '₹ Cr · trading data';
  const rangeLeg = { label: `${shortQuarterRange([cqL])} Bear – Bull`, color: RX.ink, kind: 'tick' };
  const histLegend = ex === 'nse' && model
    ? rxLegend([{ label: 'Reported', color: RX.ink }, { label: 'Manual forecast, quarter ended', kind: 'hatch', style: 'background:repeating-linear-gradient(135deg,#fff 0 3px,#8A8D94 3px 4.5px);box-shadow:inset 0 0 0 1px #8A8D94' }, { label: `${cqL} Base`, color: RX.model }, rangeLeg, { label: `${nextL} default`, color: '#9DB4E8' }])
    : rxLegend([{ label: 'Actual', color: RX.ink }, { label: 'Banked this quarter', color: RX.ink2 }, { label: 'Projected (Base)', color: RX.model }, rangeLeg].concat(ex === 'mcx' ? [{ label: 'Modelled history', color: RX.light }] : []));

  el.innerHTML = `<div class="rx">
    <div class="rx-val-bar">
      <span><strong>${name} · ${cqL}</strong> <span class="rx-foot">Bear / Base / Bull · Base = ${restMix.mix ? 'expiry-aware pace' : 'quarter-to-date pace'} for the ${restMix.rest} sessions left · Bear / Bull ∓ <span data-rx="spreadTxt">${fmtNum(spread, 0)}</span> %</span></span>
      <span data-rx="editedChip"></span>
      <button type="button" class="rx-btn rx-btn--primary" data-rp-open aria-haspopup="dialog">Assumptions</button>
    </div>
    <section class="rx-kpis" aria-label="${cqL} scenarios" data-rx="kpis"></section>
    ${staleHTML}
    ${rxPanel({ title: 'Quarter progress', meta: `Daily transaction revenue, ₹ Cr · ${cqL} to ${fmtTradeDate(lastDate)}${flagTags(cqFlags)}`,
      right: rxLegend([{ label: 'Session', color: RX.ink }, { label: 'QTD avg', color: RX.model, kind: 'line' }].concat(ctx.prev && !prevModelled ? [{ label: `${prevL} avg`, color: RX.grey, kind: 'dash' }] : [])),
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`rxPredDaily-${ex}`)}<div data-rx="bullet" style="margin-top:14px"></div></div>
        <div class="rx-scroll"><table class="rx-table rx-scen" data-rx="segTable"></table></div>`,
      foot: `<span data-rx="mixNote"></span>` })}
    <div class="rx-row">${pnlPanel}${bridgePanel}</div>
    ${rxPanel({ title: histTitle, meta: histMeta, right: histLegend, body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`rxPredHist-${ex}`)}</div>` })}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);
  const prevAdr = ctx.prev && ctx.prev.days ? ctx.prev.total_rev / ctx.prev.days : null;
  const actualLY = ex === 'nse' ? nseActualPnl(lyL) : null;
  const defCur = ex === 'nse' ? nseDefaultPnl(cqL) : null;
  const defNext = ex === 'nse' ? nseDefaultPnl(nextL) : null;
  const SCEN = [['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull']];

  // The three scenarios: Base = the inputs; Bear / Bull scale its daily revenue for the sessions left
  function scenarios() {
    const f = { bear: 1 - spread / 100, base: 1, bull: 1 + spread / 100 };
    const out = {};
    SCEN.forEach(([k]) => {
      const vv = { ...v };
      ctx.segs.forEach(sg => { vv[sg] = v[sg] * f[k]; });
      out[k] = predictorScenario(ex, ctx, vv);
    });
    return out;
  }
  const edits = () => Object.fromEntries(Object.keys(defaults).filter(k => Math.abs(Number(v[k]) - Number(defaults[k])) >= PREDICTOR_TOLERANCE).map(k => [k, v[k]]));
  const rangeTxt = (S, key, d = 0) => S.bear[key] != null && S.bull[key] != null ? `Bear ${fmtNum(S.bear[key], d)} – Bull ${fmtNum(S.bull[key], d)}` : '';

  function renderKpis(S) {
    const s = S.base;
    const qoq = ctx.prev && !prevModelled ? s.txn / ctx.prev.total_rev - 1 : null;
    const yoy = ctx.ly && !lyModelled ? s.txn / ctx.ly.total_rev - 1 : null;
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL) && !periodFlags(r, 'total').modelled).slice(-8);
    const vals = hist.map(r => r.total_rev).concat([s.txn]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pt = (val, i) => `${(i / Math.max(vals.length - 1, 1) * 100).toFixed(1)},${(25 - (val - lo) / ((hi - lo) || 1) * 23).toFixed(1)}`;
    const spark = vals.length > 2 ? `<svg class="rx-spark" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label="Transaction revenue, last ${hist.length} quarters and this quarter's Base">
        <polyline points="${hist.map((r, i) => pt(r.total_rev, i)).join(' ')}" fill="none" stroke="${RX.ink}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        <polyline points="${pt(vals[vals.length - 2], vals.length - 2)} ${pt(s.txn, vals.length - 1)}" fill="none" stroke="${RX.model}" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/></svg>` : '';
    const chg = (c, label) => c == null ? '' : `${rxChangeHTML(c)} ${label}`;
    const items = [
      rxKpi(`Txn revenue · ${cqL} · Base`, rxCr(s.txn), `${rangeTxt(S, 'txn')}<br>${[chg(qoq, 'QoQ'), chg(yoy, 'YoY')].filter(Boolean).join(' · ') || 'no comparable quarter'}`, { accent: true, extra: spark }),
      rxKpi('Quarter ADR · Base', rxCr(s.adr, 2), `${rangeTxt(S, 'adr', 2)}<br>QTD ${rxCr(ctx.bankedTotal / ctx.n, 2)} over ${ctx.n} sessions${prevAdr && !prevModelled ? ` · ${prevL} ${rxCr(prevAdr, 1)}` : ''}`),
    ];
    if (ex === 'nse' && s.pat != null) {
      const patYoY = actualLY ? s.pat / actualLY.pat - 1 : null;
      items.push(
        rxKpi('Total income', rxCr(s.total), `${rangeTxt(S, 'total')}<br>Other income ${rxCr(s.oi)}`),
        rxKpi('Operating EBITDA', rxCr(s.ebitda), `${rangeTxt(S, 'ebitda')}<br>${fmtPct(s.ebitda / s.op)} of operating revenue`),
        rxKpi('PAT', rxCr(s.pat), `${rangeTxt(S, 'pat')}<br>${patYoY != null ? chg(patYoY, 'YoY') + ' · ' : ''}${fmtPct(s.pat / s.total)} margin`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `${rangeTxt(S, 'eps', 2)}<br>Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else if (ex === 'bse') {
      items.push(
        rxKpi('Total income', rxCr(s.total), `${rangeTxt(S, 'total')}<br>Other income ${rxCr(s.oi)} (Excel model)`),
        rxKpi('PAT', rxCr(s.pat), `${rangeTxt(S, 'pat')}<br>${fmtNum(v.margin, 1)} % margin on total income`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `${rangeTxt(S, 'eps', 2)}<br>Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else {
      ctx.segs.forEach(k => items.push(rxKpi(`${PREDICTOR_SEG_LABEL[k]} · quarter`, rxCr(s.seg[k]),
        `Bear ${fmtNum(S.bear.seg[k], 0)} – Bull ${fmtNum(S.bull.seg[k], 0)}<br>${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'} of transaction revenue`)));
    }
    q('kpis').innerHTML = items.join('');
  }

  function renderBullet(S) {
    const s = S.base;
    const refs = [S.bull.txn, ctx.prev && !prevModelled ? ctx.prev.total_rev : 0, ctx.ly && !lyModelled ? ctx.ly.total_rev : 0];
    const max = Math.max(...refs) * 1.06 || 1;
    const pct = x => (Math.max(0, x) / max * 100).toFixed(2);
    const bank = Math.min(ctx.bankedTotal, s.txn);
    const marks = [];
    if (ctx.prev && !prevModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.prev.total_rev)}%;border-color:${RX.rev}" title="${prevL}: ${rxCr(ctx.prev.total_rev, 0)}"></div>`);
    if (ctx.ly && !lyModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.ly.total_rev)}%;border-left-style:dotted;border-color:${RX.ink2}" title="${lyL}: ${rxCr(ctx.ly.total_rev, 0)}"></div>`);
    q('bullet').innerHTML = `
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-bottom:6px">
        <span class="rx-lbl">Quarter transaction revenue, ₹ Cr</span>
        <span style="font-size:12px;color:var(--rx-ink-2)">Banked <strong>${fmtNum(ctx.bankedTotal, 1)}</strong> + projected <strong>${fmtNum(s.txn - ctx.bankedTotal, 1)}</strong> = <strong>${fmtNum(s.txn, 1)}</strong> <span class="rx-foot">(Bear ${fmtNum(S.bear.txn, 0)} – Bull ${fmtNum(S.bull.txn, 0)})</span></span>
      </div>
      <div class="rx-bullet" role="img" aria-label="Banked ${fmtNum(ctx.bankedTotal, 0)} crore plus projected ${fmtNum(s.txn - ctx.bankedTotal, 0)} crore; Bear ${fmtNum(S.bear.txn, 0)} to Bull ${fmtNum(S.bull.txn, 0)}">
        <div style="left:0;width:${pct(bank)}%;background:${RX.ink}" title="Banked: ${ctx.n} sessions, ${rxCr(ctx.bankedTotal)}"></div>
        <div class="rx-hatch" style="left:${pct(bank)}%;width:${(pct(s.txn) - pct(bank)).toFixed(2)}%" title="Projected (Base): ${s.rest} sessions, ${rxCr(s.txn - ctx.bankedTotal)}"></div>
        <div class="rx-scen-range" style="left:${pct(S.bear.txn)}%;width:${(pct(S.bull.txn) - pct(S.bear.txn)).toFixed(2)}%" title="Bear ${rxCr(S.bear.txn, 0)} – Bull ${rxCr(S.bull.txn, 0)}"></div>
        ${marks.join('')}
      </div>
      <div style="margin-top:8px">${rxLegend([{ label: `Banked (${ctx.n} sessions)`, color: RX.ink }, { label: `Projected, Base (${s.rest} sessions)`, kind: 'hatch' }, { label: 'Bear – Bull', color: RX.ink, kind: 'line' }]
        .concat(ctx.prev && !prevModelled ? [{ label: `${prevL} ${fmtNum(ctx.prev.total_rev, 0)}`, color: RX.rev, kind: 'tick' }] : [])
        .concat(ctx.ly && !lyModelled ? [{ label: `${lyL} ${fmtNum(ctx.ly.total_rev, 0)}`, color: RX.ink2, kind: 'tick' }] : []))}</div>`;
  }

  function renderSegTable(S) {
    const rows = ctx.segs.map(k => {
      const f = periodFlags(ctx.cq, k === 'opt' ? 'options' : k === 'fut' ? 'futures' : 'cash');
      return `<tr><td>${PREDICTOR_SEG_LABEL[k]}${flagTags(f)}</td><td>${fmtNum(ctx.banked[k], 1)}</td><td>${fmtNum(ctx.adr[k], 2)}</td><td>${fmtNum(v[k], 2)}</td><td>${fmtNum(S.bear.seg[k], 1)}</td><td class="rx-hl">${fmtNum(S.base.seg[k], 1)}</td><td>${fmtNum(S.bull.seg[k], 1)}</td><td>${S.base.txn ? fmtPct(S.base.seg[k] / S.base.txn) : '—'}</td></tr>`;
    }).join('');
    q('segTable').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">Banked</th><th scope="col">QTD / session</th><th scope="col">Rest / session</th><th scope="col">Quarter · Bear</th><th scope="col" class="rx-hl">Base</th><th scope="col">Bull</th><th scope="col">Mix</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Total${flagTags(cqFlags)}</td><td>${fmtNum(ctx.bankedTotal, 1)}</td><td>${fmtNum(ctx.bankedTotal / ctx.n, 2)}</td><td>${fmtNum(S.base.adrRest, 2)}</td><td>${fmtNum(S.bear.txn, 1)}</td><td class="rx-hl">${fmtNum(S.base.txn, 1)}</td><td>${fmtNum(S.bull.txn, 1)}</td><td>100 %</td></tr></tfoot>`;
    const editedSeg = ctx.segs.some(k => Math.abs(v[k] - defaults[k]) >= PREDICTOR_TOLERANCE);
    q('mixNote').textContent = `Rest / session: ${editedSeg ? 'your Base inputs' : restMix.mix ? `the expiry-aware pace, ${predictorMixText(restMix.mix, restMix.rest)}` : 'the quarter-to-date average'}. Bear / Bull scale it ∓ ${fmtNum(spread, 0)} %.`;
  }

  function renderPnl(S) {
    const s = S.base;
    const scenHead = SCEN.map(([k, l]) => `<th scope="col"${k === 'base' ? ' class="rx-hl"' : ''}>${shortQuarterRange([cqL])}<br>${l}</th>`).join('');
    if (ex === 'nse' && model) {
      const num = (o, key, base) => {
        if (!o || o[key] == null) return '—';
        if (base) return o[base] ? fmtPct(o[key] / o[base]) : '—';
        return key === 'eps' ? fmtNum(o[key], 2) : fmtNum(o[key], 1);
      };
      const pubSame = defCur && Math.abs(defCur.txn - s.txn) < 0.5;
      const body = NSE_PNL_ROWS.map(([label, key, cls, base]) => {
        let yoy = '';
        if (!base && actualLY && actualLY[key]) {
          const c = s[key] / actualLY[key] - 1;
          yoy = `<span class="${c >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(c)}</span>`;
        }
        return `<tr class="${cls || ''}"><td>${label}</td><td>${num(actualLY, key, base)}</td><td class="${pubSame ? 'rx-dim' : ''}">${num(defCur, key, base)}</td>${SCEN.map(([k]) => `<td${k === 'base' ? ' class="rx-hl"' : ''}>${num(S[k], key, base)}</td>`).join('')}<td>${yoy || (base ? '' : '—')}</td><td>${num(defNext, key, base)}</td></tr>`;
      }).join('');
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th><th scope="col">${shortQuarterRange([lyL])}<br>Actual</th><th scope="col" title="The pipeline's default forecast: flat quarter-to-date pace">${shortQuarterRange([cqL])}<br>Published</th>${scenHead}<th scope="col">Base<br>YoY</th><th scope="col">${shortQuarterRange([nextL])}<br>Default</th></tr></thead><tbody>${body}</tbody>`;
      const oneOff = actualLY && Object.keys(actualLY.oneOffs).length ? `${lyL} actual includes ${nseOneOffText(actualLY.oneOffs)}. ` : '';
      q('pnlFoot').textContent = (actualLY ? `${oneOff}Actual operating lines are ex-one-offs where the pipeline separates them.` : `${lyL} has no reported actuals in nse_pnl yet.`)
        + (pubSame ? ' Published equals Base here (greyed).' : ' Published: the pipeline’s forecast at the flat quarter-to-date pace.');
    } else if (ex === 'bse') {
      const per = x => s.total ? fmtPct(x / s.total) : '—';
      const row = (label, key, cls, src, pctOf = true) => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td>${SCEN.map(([k]) => `<td${k === 'base' ? ' class="rx-hl"' : ''}>${fmtNum(S[k][key], key === 'eps' ? 2 : 1)}</td>`).join('')}<td>${pctOf ? per(s[key]) : ''}</td><td class="rx-src">${src}</td></tr>`;
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th>${scenHead}<th scope="col">% of total income (Base)</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        ${row(`Transaction revenue${flagTags(cqFlags)}`, 'txn', '', 'Trading data + daily inputs')}
        ${row('Other income', 'oi', '', 'Excel model')}
        ${row('Total income', 'total', 'rx-sub', '')}
        ${row('Costs and tax (implied)', 'costs', '', '1 − PAT margin')}
        ${row('PAT', 'pat', 'rx-sub', `PAT margin ${fmtNum(v.margin, 1)} %`)}
        ${row('EPS, ₹', 'eps', 'rx-sub', `${fmtNum(v.shares, 2)} Cr shares`, false)}
      </tbody>`;
    } else {
      const rows = ctx.segs.map(k => {
        const lyv = ctx.ly && !lyModelled ? ctx.ly[k + '_rev'] : null;
        const pv = ctx.prev && !prevModelled ? ctx.prev[k + '_rev'] : null;
        return `<tr><td>${PREDICTOR_SEG_LABEL[k]}</td><td>${pv == null ? '—' : fmtNum(pv, 1)}</td><td>${lyv == null ? '—' : fmtNum(lyv, 1)}</td>${SCEN.map(([sk]) => `<td${sk === 'base' ? ' class="rx-hl"' : ''}>${fmtNum(S[sk].seg[k], 1)}</td>`).join('')}<td>${pv ? rxChangeHTML(s.seg[k] / pv - 1) : '—'}</td><td>${lyv ? rxChangeHTML(s.seg[k] / lyv - 1) : '—'}</td></tr>`;
      }).join('');
      const tp = ctx.prev && !prevModelled ? ctx.prev.total_rev : null, tl = ctx.ly && !lyModelled ? ctx.ly.total_rev : null;
      q('segs').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">${shortQuarterRange([prevL])}</th><th scope="col">${shortQuarterRange([lyL])}</th>${scenHead}<th scope="col">QoQ (Base)</th><th scope="col">YoY (Base)</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><td>Total</td><td>${tp == null ? '—' : fmtNum(tp, 1)}</td><td>${tl == null ? '—' : fmtNum(tl, 1)}</td>${SCEN.map(([sk]) => `<td${sk === 'base' ? ' class="rx-hl"' : ''}>${fmtNum(S[sk].txn, 1)}</td>`).join('')}<td>${tp ? rxChangeHTML(s.txn / tp - 1) : '—'}</td><td>${tl ? rxChangeHTML(s.txn / tl - 1) : '—'}</td></tr></tfoot>`;
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

  // History with this quarter's Base, and a Bear – Bull whisker over it
  function renderHist(S) {
    const canvasId = `rxPredHist-${ex}`;
    const s = S.base;
    if (ex === 'nse' && model) {
      const preds = ENRICHED_DATA.pnl_predicted_quarters || {};
      const rows = (DATA.pnl || []).filter(r => !preds[r.quarter] && quarterSortKey(r.quarter) < quarterSortKey(cqL));
      const pts = rows.map(r => ({ q: r.quarter, v: r.pat, kind: r.is_predicted ? 'manual' : 'actual' }))
        .concat(Object.keys(preds).sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).map(qL => ({ q: qL, v: qL === cqL ? s.pat : preds[qL].pat, kind: qL === cqL ? 'scenario' : 'default', def: preds[qL].pat })));
      const labels = pts.map(p => shortQuarterRange([p.q]));
      const curLabel = shortQuarterRange([cqL]);
      const whisker = [{ x: curLabel, y: S.bear.pat }, { x: curLabel, y: S.bull.pat }];
      if (charts.predHist && charts.predHist.$rpEx === ex) {
        charts.predHist.data.datasets[0].data = pts.map(p => p.v);
        charts.predHist.data.datasets[1].data = whisker;
        charts.predHist.update('none');
        return;
      }
      const hatch = rxHatchPattern();
      const colors = pts.map(p => p.kind === 'actual' ? RX.ink : p.kind === 'manual' ? hatch : p.kind === 'scenario' ? RX.model : '#9DB4E8');
      rxChart('predHist', canvasId, 240, {
        type: 'bar',
        data: { labels, datasets: [
          { label: 'PAT', data: pts.map(p => p.v), backgroundColor: colors, order: 2,
            borderColor: pts.map(p => p.kind === 'manual' ? '#8A8D94' : 'transparent'), borderWidth: pts.map(p => p.kind === 'manual' ? 1 : 0), borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44 },
          { type: 'line', label: 'Bear – Bull', data: whisker, borderColor: RX.ink, borderWidth: 2, pointRadius: 4, pointStyle: 'line', pointBorderWidth: 2, order: 1 },
        ] },
        options: {
          plugins: { tooltip: { callbacks: {
            title: items => pts[items[0].dataIndex] ? pts[items[0].dataIndex].q : cqL,
            label: c => {
              if (c.datasetIndex === 1) return ` ${c.dataIndex === 0 ? 'Bear' : 'Bull'} ${rxCr(c.parsed.y, 0)}`;
              const p = pts[c.dataIndex];
              const kind = { actual: 'reported', manual: 'manual forecast; quarter ended without an actual', scenario: 'Base', default: 'default forecast' }[p.kind];
              return ` PAT ${rxCr(p.v, 0)} · ${kind}`;
            },
          } } },
          scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
        },
      });
      rxFixHeight(charts.predHist);
      charts.predHist.$rpEx = ex;
      return;
    }
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL)).slice(-11);
    const labels = hist.map(r => r.quarter).concat([cqL]).map(l => shortQuarterRange([l]));
    const actual = hist.map(r => r.total_rev).concat([ctx.bankedTotal]);
    const proj = hist.map(() => null).concat([s.txn - ctx.bankedTotal]);
    const curLabel = labels[labels.length - 1];
    const whisker = [{ x: curLabel, y: S.bear.txn }, { x: curLabel, y: S.bull.txn }];
    const actualColors = hist.map(r => periodFlags(r, 'total').modelled ? RX.light : RX.ink).concat([RX.ink2]);
    if (charts.predHist && charts.predHist.$rpEx === ex) {
      charts.predHist.data.datasets[1].data = proj;
      charts.predHist.data.datasets[2].data = whisker;
      charts.predHist.update('none');
      return;
    }
    rxChart('predHist', canvasId, 240, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Actual', data: actual, backgroundColor: actualColors, stack: 'q', maxBarThickness: 44, order: 2 },
        { label: 'Projected', data: proj, backgroundColor: RX.model, stack: 'q', borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44, order: 2 },
        { type: 'line', label: 'Bear – Bull', data: whisker, stack: 'range', borderColor: RX.ink, borderWidth: 2, pointRadius: 4, pointStyle: 'line', pointBorderWidth: 2, order: 1 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => (hist[items[0].dataIndex] || ctx.cq).quarter,
          label: c => {
            if (c.datasetIndex === 2) return ` ${c.dataIndex === 0 ? 'Bear' : 'Bull'} ${rxCr(c.parsed.y, 0)}`;
            if (c.raw == null) return null;
            const isCur = c.dataIndex === hist.length;
            const r = hist[c.dataIndex];
            if (!isCur) return ` ${rxCr(c.raw, 0)}${r && periodFlags(r, 'total').modelled ? ' · modelled' : ''}`;
            return c.datasetIndex === 0 ? ` Banked ${rxCr(c.raw, 0)} (${ctx.n} sessions)` : ` Projected (Base) ${rxCr(c.raw, 0)}`;
          },
        } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: true, beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
      },
    });
    rxFixHeight(charts.predHist);
    charts.predHist.$rpEx = ex;
  }

  function update() {
    const S = scenarios();
    const ed = edits();
    q('spreadTxt').textContent = fmtNum(spread, 0);
    q('editedChip').innerHTML = Object.keys(ed).length || spread !== PREDICTOR_PRESET_PCT
      ? rxChip(`Edited · saved in this browser`, 'edit') : '';
    renderKpis(S);
    renderBullet(S);
    renderSegTable(S);
    renderPnl(S);
    renderWalk(S.base);
    renderHist(S);
    return S;
  }
  const save = () => writePredictorSaved(ex, cqL, edits(), spread);

  // Assumptions drawer: Base inputs, the Bear / Bull spread, reset, and the Base ADR to the Valuation Model
  function openAssumptions() {
    const fieldRow = f => `<div class="rx-drawer-row"><span class="rx-dl"><label for="rxPred-${ex}-${f.key}">${f.label}</label><small data-tags="${f.key}">${f.tag}</small></span>
        <span class="rx-dv"><input class="rx-in" id="rxPred-${ex}-${f.key}" type="number" step="${f.step}" min="0" inputmode="decimal" data-key="${f.key}" value="${predictorShown(v[f.key])}"></span></div>`;
    const body = openRxDrawer({
      title: `${name} · ${cqL} assumptions`,
      body: `<p class="rx-drawer-note">Base = ${restMix.mix ? `the expiry-aware pace: ${predictorMixText(restMix.mix, restMix.rest)}, each at its average` : 'the quarter-to-date pace'}. Edits are saved in this browser for ${cqL}; the figures behind update as you type.</p>
        ${groups.map((g, i) => `<div class="rx-drawer-sec">${i === 0 ? `${g.title} · Base` : g.title}</div>${g.fields.map(fieldRow).join('')}`).join('')}
        <div class="rx-drawer-sec">Scenarios</div>
        <div class="rx-drawer-row"><span class="rx-dl"><label for="rxPred-${ex}-spread">Bear / Bull spread, %</label><small>Base daily revenue for the sessions left ∓ this</small></span>
          <span class="rx-dv"><input class="rx-in" id="rxPred-${ex}-spread" type="number" step="1" min="0" max="99" inputmode="decimal" data-spread value="${fmtNum(spread, 0)}"></span></div>
        <div class="rx-drawer-sec">Valuation</div>
        <div class="rx-drawer-acts"><button type="button" class="rx-btn rx-btn--primary" data-rp-send></button><span class="rx-foot" data-rp-sent></span></div>
        <div class="rx-drawer-acts"><button type="button" class="rx-btn" data-rp-reset>Reset all to Base</button></div>`,
    });
    const sync = () => {
      const S = update();
      body.querySelector('[data-rp-send]').textContent = `Use Base ADR ₹${fmtNum(S.base.adr, 2)} Cr in Valuation`;
      groups.forEach(g => g.fields.forEach(f => {
        const edited = Math.abs(Number(v[f.key]) - Number(defaults[f.key])) >= PREDICTOR_TOLERANCE;
        const input = body.querySelector(`#rxPred-${ex}-${f.key}`);
        input.classList.toggle('is-edited', edited);
        body.querySelector(`[data-tags="${f.key}"]`).innerHTML = f.tag + (edited ? ` ${rxChip('Edited', 'edit')} <button type="button" class="rx-link" data-reset="${f.key}">reset to ${predictorShown(defaults[f.key])}</button>` : '');
      }));
      body.querySelector('[data-spread]').classList.toggle('is-edited', spread !== PREDICTOR_PRESET_PCT);
      return S;
    };
    body.addEventListener('input', e => {
      const t = e.target;
      const num = parseFloat(t.value);
      if (!isFinite(num) || num < 0) return;
      if (t.dataset.spread != null) { if (num >= 100) return; spread = num; }
      else if (t.dataset.key) v[t.dataset.key] = t.dataset.key === 'days' ? Math.max(Math.round(num), ctx.n) : num;
      else return;
      save();
      sync();
    });
    body.addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.key) t.value = predictorShown(v[t.dataset.key]);
      if (t.dataset.spread != null) t.value = fmtNum(spread, 0);
    });
    body.addEventListener('click', async e => {
      const r = e.target.closest('[data-reset]');
      if (r) { const k = r.dataset.reset; v[k] = defaults[k]; body.querySelector(`#rxPred-${ex}-${k}`).value = predictorShown(defaults[k]); save(); sync(); return; }
      if (e.target.closest('[data-rp-reset]')) {
        Object.assign(v, defaults);
        spread = PREDICTOR_PRESET_PCT;
        Object.keys(defaults).forEach(k => { const i = body.querySelector(`#rxPred-${ex}-${k}`); if (i) i.value = predictorShown(defaults[k]); });
        body.querySelector('[data-spread]').value = fmtNum(spread, 0);
        save(); sync();
        return;
      }
      if (e.target.closest('[data-rp-send]')) {
        const adr = +scenarios().base.adr.toFixed(2);
        // The valuation inputs are shared once the API answers (14-valuation.js): wait for its first answer
        const [vd] = await Promise.all([loadValuationDefaults(), VALUATION_SHARED.mode === 'pending' ? loadSharedValuationInputs() : null]);
        const out = body.querySelector('[data-rp-sent]');
        const open = '<button type="button" class="rx-link" data-rx-goto="valuation">Open Valuation Model →</button>';
        if (vd.error) { out.textContent = `Valuation inputs not loaded (${vd.error}).`; return; }
        if (!writeValuationOverrides(setValuationOverride(readValuationOverrides(), vd, ex, 'adr', adr))) {
          out.innerHTML = VALUATION_SHARED.mode === 'pending'
            ? 'The shared valuation inputs have not loaded yet: try again in a moment.'
            : `Not set: the valuation inputs are shared, and only a signed-in team member can change them (Edit inputs on the Valuation Model). ${open}`;
          return;
        }
        out.innerHTML = VALUATION_SHARED.mode === 'shared'
          ? `Set for everyone: ${name}’s shared ADR estimate is ₹${fmtNum(adr, 2)} Cr. ${open}`
          : `Set in this browser: ${name}’s ADR estimate is ₹${fmtNum(adr, 2)} Cr. ${open}`;
      }
    });
    sync();
  }

  // One click listener on the persistent container for every build (the current
  // build's opener is swapped in), so rebuilds do not stack listeners
  el._rpOpen = openAssumptions;
  if (!el._rpBound) {
    el._rpBound = true;
    el.addEventListener('click', e => { if (e.target.closest && e.target.closest('[data-rp-open]') && el._rpOpen) el._rpOpen(); });
  }

  update();
  renderDaily();
  RX_TAB_REFRESH.prediction = () => { renderDaily(); charts.predHist && charts.predHist.destroy(); delete charts.predHist; renderHist(scenarios()); };
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

// (Buttons that jump to another tab, data-rx-goto: the handler is in 00-core.js)
