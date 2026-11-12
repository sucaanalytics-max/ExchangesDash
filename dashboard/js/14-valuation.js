// dashboard/js/14-valuation.js — Valuation Model tab: shares outstanding, valuation helpers.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// SHARES OUTSTANDING — the one place share counts live
// ========================

// Crore shares, the default for every EPS on the Revenue Predictor and
// Valuation Model tabs (editable there). Nothing fetches share
// counts — yfinance supplies prices only — so these are static, and each view
// shows the value with its source and as-of note. as_of is null where the repo
// records no date; source says how far the figure can be trusted.
// BSE's 40.79 is the 407.88m shares PL Capital's initiation (18 Jun 2026)
// lists; Motilal Oswal's 1QFY27 update (4 Aug 2026) rounds the same count to
// 408m. It replaced 40.73, which the Excel workbook read from a
// Bloomberg/FactSet plugin with no recorded date (see
// docs/superpowers/specs/2026-07-02-bse-excel-valuation-replication-design.md).
// NSE's 247.5 is its paid-up equity capital (₹247.50 Cr at ₹1 face value) in
// the audited Q1 FY27 results; reported PAT ÷ EPS gives 247.4–247.6 every quarter.
// chip/kind: the input's provenance tag on the Predictor and Valuation tabs.
const SHARES_OUTSTANDING_CR = {
  bse: { value: 40.79, as_of: '2026-06-18', source: 'PL Capital initiation, 18 Jun 2026 (407.88m); MOSL 1QFY27 update, 4 Aug 2026 (408m)', chip: 'Broker reports · Jun 2026', kind: 'data' },
  mcx: { value: 25.45, as_of: null, source: 'hard-coded, unverified', chip: 'Hard-coded · unverified', kind: 'warn' },
  nse: { value: 247.5, as_of: '2026-06-30', source: 'paid-up equity capital ₹247.50 Cr at ₹1 face value, audited Q1 FY27 results (30 Jul 2026)', chip: 'Results filing · Jun 2026', kind: 'data' },
};

function sharesChip(ex) {
  const s = SHARES_OUTSTANDING_CR[ex];
  return `<span class="rx-chip rx-chip--${s.kind}" title="${escHtml(s.source)}">${s.chip}</span>`;
}

// ========================
// VALUATION HELPERS
// ========================

// Indian FY convention: Apr-Jun=Q1, Jul-Sep=Q2, Oct-Dec=Q3, Jan-Mar=Q4, FY named for the March-ending year
function currentFYQuarterLabel(d) {
  const month = d.getMonth(); // 0 = Jan
  const year  = d.getFullYear();
  const fyYear = month >= 3 ? year + 1 : year;
  const q = month >= 3 && month <= 5 ? 1 : month >= 6 && month <= 8 ? 2 : month >= 9 && month <= 11 ? 3 : 4;
  return { fy: `FY ${fyYear}`, quarter: `Q${q} FY ${fyYear}` };
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function bseDailySeries(rawData) {
  return (rawData?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
}

// Combined NSE+BSE total-market ADR and BSE's share of it, over a given set of BSE trading rows
function combinedMarketADRForRows(bseRows, nseSeries) {
  const nseByDate = new Map(nseSeries.map(r => [r.date, r.total_rev]));
  let bseSum = 0, totalSum = 0;
  bseRows.forEach(r => {
    const nseRev = nseByDate.get(r.date) || 0;
    bseSum   += r.total_rev || 0;
    totalSum += (r.total_rev || 0) + nseRev;
  });
  return { totalMarketADR: totalSum / (bseRows.length || 1), bseShare: totalSum ? bseSum / totalSum : 0 };
}

function combinedMarketADR(bseSeries, nseSeries, n) {
  return combinedMarketADRForRows(bseSeries.slice(-n), nseSeries);
}

let BSE_ANALYST_TARGETS_CACHE = null;

async function loadBSEAnalystTargets() {
  if (BSE_ANALYST_TARGETS_CACHE) return BSE_ANALYST_TARGETS_CACHE;
  try {
    const r = await fetch('./data/bse_analyst_targets.json');
    const j = await r.json();
    BSE_ANALYST_TARGETS_CACHE = j.targets || [];
  } catch {
    BSE_ANALYST_TARGETS_CACHE = [];
  }
  return BSE_ANALYST_TARGETS_CACHE;
}

// Broker targets older than this are flagged as stale wherever they are shown.
const ANALYST_TARGET_STALE_DAYS = 90;

// "May 2026", "May–Aug 2026" or "Dec 2025–Aug 2026": the span of the broker notes' dates.
function analystMonths(oldest, newest) {
  const [lo, hi] = [rxDate(oldest).replace(/^\d+ /, ''), rxDate(newest || oldest).replace(/^\d+ /, '')];
  if (lo === hi) return lo;
  const [loM, loY] = lo.split(' ');
  return loY === hi.split(' ')[1] ? `${loM}–${hi}` : `${lo}–${hi}`;
}

// Whole days from an ISO date ("2026-05-08") to today's IST date.
function daysSinceIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(istDateOf() || '');
  if (!m || !t) return null;
  return Math.round((Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
}

// http(s) URL from a hand-edited file, attribute-escaped; anything else → null.
function safeHttpUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url.href.replace(/"/g, '%22') : null;
  } catch { return null; }
}

// ========================
// VALUATION MODEL TAB — one model per exchange
// ========================
// FY average daily revenue (ADR) → transaction revenue → + other income →
// × PAT margin → PAT → ÷ shares → FY EPS → × P/E → FY-end target, optionally
// discounted to today. Bear / Base / Bull differ by rest-of-year ADR growth and
// P/E. The base ADR is either the FY projection (FY revenue to date + trailing
// 45-session average for the sessions left) or, for BSE, the Excel "Annual
// Predictor" method (BSE's FY revenue to date + NSE+BSE market ADR × BSE's
// 20-session share for the sessions left). Inputs are saved per exchange.

const VALUATION_DEFAULTS = {
  // Excel "BSE" sheet starting values (Annual Predictor and Quick Valuation)
  bse: { src: 'mkt', g0: -5, g1: 0, g2: 5, days: 247, oiMode: 'fixed', oi: 2055.39, margin: 52, pe0: 40, pe1: 45, pe2: 50, disc: 18 },
  // Owner assumptions: other income as a % of total income, no discounting
  nse: { src: 'proj', g0: 0, g1: 0, g2: 0, days: 247, oiMode: 'pct', oi: 30, margin: 55, pe0: 25, pe1: 35, pe2: 45, disc: 0 },
  // Placeholders (no MCX valuation baseline exists); MCX trades ~257 sessions a year
  mcx: { src: 'proj', g0: 0, g1: 0, g2: 0, days: 257, oiMode: 'fixed', oi: 0, margin: 50, pe0: 25, pe1: 30, pe2: 35, disc: 0 },
};
const VALUATION_SOURCE = {
  bse: { kind: '', label: 'Excel model' },
  nse: { kind: '', label: 'Owner assumption' },
  mcx: { kind: 'warn', label: 'Placeholder' },
};
const VALUATION_SCENARIOS = ['bear', 'base', 'bull'];
const valuationStorageKey = ex => `valuation_${ex}_v2`;

// Saved inputs; on first use, carries over values saved by the earlier Quick
// Valuation panel (quickValuation_{ex}_v1) and BSE Annual Predictor
// (bseValuationAssumptions_v1).
function loadValuationInputs(ex) {
  const d = { ...VALUATION_DEFAULTS[ex], shares: SHARES_OUTSTANDING_CR[ex].value };
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const saved = read(valuationStorageKey(ex));
  if (saved) return { ...d, ...saved };
  const out = { ...d };
  const qv = read(`quickValuation_${ex}_v1`);
  if (qv) {
    if (qv.patMarginPct != null) out.margin = qv.patMarginPct;
    if (d.oiMode === 'pct' && qv.otherIncomePct != null) out.oi = qv.otherIncomePct;
    if (d.oiMode === 'fixed' && qv.otherIncomeCr != null) out.oi = qv.otherIncomeCr;
    ['Bear', 'Base', 'Bull'].forEach((s, i) => { if (qv['pe' + s] != null) out['pe' + i] = qv['pe' + s]; });
  }
  const bv = ex === 'bse' ? read('bseValuationAssumptions_v1') : null;
  if (bv) {
    ['Bear', 'Base', 'Bull'].forEach((s, i) => { if (bv[`adrGrowth${s}Pct`] != null) out['g' + i] = bv[`adrGrowth${s}Pct`]; });
    if (bv.discountPct != null) out.disc = bv.discountPct;
    if (bv.sharesOutstandingCr != null) out.shares = bv.sharesOutstandingCr;
    if (bv.fy27TotalTradingDays != null) out.days = bv.fy27TotalTradingDays;
  }
  return out;
}

function saveValuationInputs(ex, v) {
  try { localStorage.setItem(valuationStorageKey(ex), JSON.stringify(v)); } catch (e) { /* storage blocked: not remembered */ }
}

// FY revenue to date, trailing averages and (BSE) market-share inputs
function valuationContext(ex, series, nseSeries) {
  const fy = currentFYQuarterLabel(new Date()).fy;
  const fyRows = series.filter(r => r.fy === fy);
  const sum = rows => rows.reduce((s, r) => s + (r.total_rev || 0), 0);
  const avg = rows => rows.length ? sum(rows) / rows.length : 0;
  const prevFY = 'FY ' + (Number(fy.match(/\d{4}/)[0]) - 1);
  const ctx = {
    fy, fyShort: `FY${fy.slice(-2)}`, fyRows, elapsed: fyRows.length, revToDate: sum(fyRows), adr45: avg(series.slice(-45)),
    prevFY, prevFYDays: series.filter(r => r.fy === prevFY).length,
    flags: mergeFlags([rowsFlags(fyRows, 'total'), rowsFlags(series.slice(-45), 'total')]),
  };
  if (ex === 'bse' && nseSeries && nseSeries.length) {
    const fyM = combinedMarketADRForRows(fyRows, nseSeries);
    const m45 = combinedMarketADR(series, nseSeries, 45);
    const m20 = combinedMarketADR(series, nseSeries, 20);
    ctx.mkt = {
      adrFY: avg(fyRows), adr45: avg(series.slice(-45)), adr20: avg(series.slice(-20)),
      totalFY: fyM.totalMarketADR, total45: m45.totalMarketADR, total20: m20.totalMarketADR,
      shareFY: fyM.bseShare, share45: m45.bseShare, share20: m20.bseShare,
    };
  }
  return ctx;
}

// One scenario: g = rest-of-year ADR growth %, pe = multiple
function valuationScenario(ctx, v, g, pe, cmp) {
  const rest = Math.max(v.days - ctx.elapsed, 0);
  const restAdr = v.src === 'mkt' && ctx.mkt ? ctx.mkt.total45 * ctx.mkt.share20 : ctx.adr45;
  const adr = v.days ? (ctx.revToDate + restAdr * (1 + g / 100) * rest) / v.days : 0;
  return valuationFromAdr(adr, v, pe, cmp);
}

function valuationFromAdr(adr, v, pe, cmp) {
  const txn = adr * v.days;
  const pct = Math.min(v.oi, 99.9);
  const oi = v.oiMode === 'pct' ? txn * pct / (100 - pct) : v.oi;
  const total = txn + oi;
  const pat = total * v.margin / 100;
  const eps = v.shares ? pat / v.shares : null;
  const fwd = eps != null ? eps * pe : null;
  const now = fwd != null ? fwd / (1 + v.disc / 100) : null;
  return { adr, txn, oi, total, pat, eps, pe, fwd, now, upFwd: fwd && cmp ? fwd / cmp - 1 : null, upNow: now && cmp ? now / cmp - 1 : null };
}

// ========================
// TRIANGULATED TARGET — the Excel "BSE" sheet's Summary table
// ========================
// Three methods, each Bear / Base / Bull in today's ₹, then a weighted average:
//   Regression: intercept + slope × ADR (the current quarter's, by default) of
//     the published 45-session fit; Bear / Bull scale that ADR by ∓ band %.
//   Ratio: price ÷ 45-session revenue MA, mean ∓ 1σ, × next-FY ADR → next-FY-end
//     price, discounted to this FY end (d1) and then to today (d2: by default d1's rate for
//     the part of this FY left, from today's date; the workbook keeps a flat 9 %).
//   ADR model: next-FY ADR × sessions + other income → × PAT margin ÷ shares →
//     EPS × P/E (Bear / Base / Bull), discounted the same way.
// Next-FY ADR: the current quarter's ADR grown qoq % each quarter through the
// next FY's Q4, averaged over that FY's four quarters.
// The inputs are separate from the FY model above (the Excel keeps them apart:
// BSE's 51 % margin and other income × 1.15 here, 52 % and a fixed ₹2,055 Cr there).
const TRIANGULATION_DEFAULTS = {
  // Excel "BSE" sheet: ADR Estimate (D28:D34), section 3 (D69:F82), Summary (D87:G90)
  bse: { adr0: null, qoq: 2, regAdr: null, band: 10, days: 247, oiMode: 'fixed', oi: 2055.39, oiG: 15, margin: 51, pe0: 40, pe1: 45, pe2: 50, d1: 18, d2: null, w0: 20, w1: 40, w2: 40 },
  // NSE / MCX: the FY model's own assumptions, no growth, the Excel's discounts and weights
  nse: { adr0: null, qoq: 0, regAdr: null, band: 10, days: 247, oiMode: 'pct', oi: 30, oiG: 0, margin: 55, pe0: 25, pe1: 35, pe2: 45, d1: 18, d2: null, w0: 20, w1: 40, w2: 40 },
  mcx: { adr0: null, qoq: 0, regAdr: null, band: 10, days: 257, oiMode: 'fixed', oi: 0, oiG: 0, margin: 50, pe0: 25, pe1: 30, pe2: 35, d1: 18, d2: null, w0: 20, w1: 40, w2: 40 },
};
const triangulationStorageKey = ex => `triangulation_${ex}_v1`;
// The workbook's discount to today, and the fallback without a date
const TRIANGULATION_FLAT_D2 = 9;

// Inputs the next-FY block shares in meaning with the current-FY model but keeps apart, as the
// workbook does (BSE: 51 % PAT margin there, 52 % in the FY model). Other income compares the
// current FY's base (₹ Cr, grown by oiG in the next-FY block) or its % of total income.
const TRIANGULATION_SHARED = [
  { label: 'PAT margin', keys: ['margin'] },
  { label: 'P/E', keys: ['pe0', 'pe1', 'pe2'] },
  { label: 'other income', keys: ['oi'] },
];

// The shared inputs on which the next-FY block (t) differs from the current-FY model (v):
// [{ label, keys, fy1: t's values, fy0: v's values }]; other income only when both use the same mode
function triangulationVsFyModel(t, v) {
  return TRIANGULATION_SHARED
    .filter(g => g.keys[0] !== 'oi' || t.oiMode === v.oiMode)
    .filter(g => g.keys.some(k => !(Math.abs(Number(t[k]) - Number(v[k])) < 1e-9)))
    .map(g => ({ ...g, fy1: g.keys.map(k => t[k]), fy0: g.keys.map(k => v[k]) }));
}

// Discount from the current FY's end back to today, in %: the annual rate d1 for the part of a
// year left, (1 + d1)^(days / 365) − 1; 0 once that FY has ended; null without valid dates.
function discountToToday(d1Pct, todayIso, fyEndIso) {
  const days = (Date.parse(`${fyEndIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000;
  if (!isFinite(days)) return null;
  return days <= 0 ? 0 : (Math.pow(1 + d1Pct / 100, days / 365) - 1) * 100;
}

function loadTriangulationInputs(ex) {
  const d = { ...TRIANGULATION_DEFAULTS[ex] };
  try {
    const saved = JSON.parse(localStorage.getItem(triangulationStorageKey(ex)) || 'null');
    // Inputs saved before the discount to today followed the date carry the old flat default (9):
    // drop it, so they get the dated discount too
    if (saved && saved.d2 === TRIANGULATION_FLAT_D2) delete saved.d2;
    if (saved) Object.assign(d, saved, { oiMode: d.oiMode });
  } catch (e) { /* storage blocked or unreadable: defaults */ }
  return d;
}

function saveTriangulationInputs(ex, t) {
  try { localStorage.setItem(triangulationStorageKey(ex), JSON.stringify(t)); } catch (e) { /* storage blocked: not remembered */ }
}

// "Q3 FY 2027" → { q: 3, fy: 2027 }
function parseFYQuarter(label) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  return m ? { q: +m[1], fy: +m[2] } : null;
}

// The quarter's ADR on the share-price fits' own basis: their revenue
// (SHARE_DATA.revenue_daily, at today's statutory rates)
// averaged over the quarter's trading dates it has. { adr, n }, or null when it has none.
function fitBasisAdr(revenueDaily, dates) {
  const byDate = new Map((revenueDaily || []).map(r => [r.date, r.revenue_cr]));
  const vals = dates.map(d => byDate.get(d)).filter(x => x != null && isFinite(x));
  return vals.length ? { adr: vals.reduce((s, x) => s + x, 0) / vals.length, n: vals.length } : null;
}

// Quarter-by-quarter ADR from the start quarter to the next FY's Q4, and that FY's average
function triangulationAdrPath(start, startAdr, qoqPct) {
  const path = [];
  let { q, fy } = start, adr = startAdr;
  while (fy <= start.fy + 1) {
    path.push({ q, fy, label: `Q${q} FY${String(fy).slice(-2)}`, adr });
    adr *= 1 + qoqPct / 100;
    if (++q > 4) { q = 1; fy++; }
  }
  const next = path.filter(p => p.fy === start.fy + 1);
  return { path, fy: start.fy + 1, adr: next.reduce((s, p) => s + p.adr, 0) / next.length };
}

// t: inputs; adrFY: next-FY ADR (ADR model); regAdr: ADR fed to the fit; ratioAdrFY: next-FY
// ADR for the ratio (default adrFY); the regression and ratio take theirs on the fits' revenue
// basis; reg: { slope, intercept } or null (fit withheld); ratio: { mean, sd } or null; shares
// in Cr. Weights are normalised over the methods that have a value, so a missing method drops
// out of the average.
function triangulationModel(t, { adrFY, regAdr, ratioAdrFY, reg, ratio, shares }) {
  const toFYEnd = x => x / (1 + t.d1 / 100);
  const toToday = x => toFYEnd(x) / (1 + t.d2 / 100);
  const txn = adrFY * t.days;
  const pct = Math.min(t.oi, 99.9);
  const oi = t.oiMode === 'pct' ? txn * pct / (100 - pct) : t.oi * (1 + t.oiG / 100);
  const total = txn + oi;
  const pat = total * t.margin / 100;
  const eps = shares ? pat / shares : null;
  const fwd = [0, 1, 2].map(i => eps != null ? eps * t['pe' + i] : null);
  const adr = { adrFY, txn, oi, total, pat, eps, fwd, mid: fwd.map(f => f != null ? toFYEnd(f) : null), now: fwd.map(f => f != null ? toToday(f) : null) };
  const regVals = reg ? [1 - t.band / 100, 1, 1 + t.band / 100].map(k => reg.intercept + reg.slope * regAdr * k) : null;
  let ratioM = null;
  if (ratio) {
    const k = [ratio.mean - ratio.sd, ratio.mean, ratio.mean + ratio.sd];
    const rAdr = ratioAdrFY ?? adrFY;
    const f = k.map(x => x * rAdr);
    ratioM = { k, adrFY: rAdr, fwd: f, mid: f.map(toFYEnd), now: f.map(toToday) };
  }
  const methods = [['reg', t.w0, regVals], ['ratio', t.w1, ratioM && ratioM.now], ['adr', t.w2, eps != null ? adr.now : null]];
  const used = methods.filter(([, w, vals]) => vals && w > 0);
  const wSum = used.reduce((s, [, w]) => s + w, 0);
  const avg = wSum > 0 ? [0, 1, 2].map(i => used.reduce((s, [, w, vals]) => s + vals[i] * w, 0) / wSum) : null;
  return { adr, reg: regVals, ratio: ratioM, avg, used: used.map(([k]) => k), wSum, wTotal: t.w0 + t.w1 + t.w2 };
}

// ========================
// EXCEL LAYOUT — the workbook's valuation block and Summary, top of the tab
// ========================
// Pure row lists and cell text, so the layout is testable without a DOM.
// block: boxed group (0 = ADR to upside, 1 = to this FY end, 2 = to today);
// gut: input in the left gutter; input: [bear, base, bull] input keys (null = shown).

// fy: the next FY (2028 → "FY 28"); oiMode picks the other-income gutter input
function valuationExcelRows(fy, oiMode) {
  const y1 = `FY ${String(fy).slice(-2)}`, y0 = `FY ${String(fy - 1).slice(-2)}`;
  return [
    { key: 'adrFY', label: `ADR ${y1}`, block: 0, bold: true, gut: 'qoq' },
    { key: 'oi', label: 'Other Income', block: 0, gut: oiMode === 'pct' ? 'oi' : 'oiG' },
    { key: 'total', label: 'Total Income', block: 0 },
    { key: 'margin', label: 'PAT Margin', block: 0 },
    { key: 'eps', label: 'EPS', block: 0 },
    { key: 'pe', label: 'PE', block: 0, tint: 'green', input: ['pe0', 'pe1', 'pe2'] },
    { key: 'fwd', label: `Price Target ${y1}`, block: 0, bold: true, boxed: true },
    { key: 'up', label: 'Upside', block: 0, tint: 'peach' },
    { key: 'd1', label: 'Discount %', block: 1, input: [null, 'd1', null] },
    { key: 'mid', label: `Target Price ${y0}`, block: 1, bold: true },
    { key: 'd2', label: 'Discount %', block: 2, input: [null, 'd2', null] },
    { key: 'now', label: 'Target Price Current', block: 2, bold: true },
  ];
}

// The Summary rows; the last is "Average" only while the three weights are equal
function triangulationSummaryRows(t) {
  const equal = Math.abs(t.w0 - t.w1) < 1e-9 && Math.abs(t.w1 - t.w2) < 1e-9;
  return [
    { key: 'reg', label: 'Regression', gut: 'band', w: 'w0' },
    { key: 'ratio', label: 'Ratio Analysis', tint: 'peach', w: 'w1' },
    { key: 'adr', label: 'ADR', w: 'w2' },
    { key: 'avg', label: equal ? 'Average' : 'Weighted average', tint: 'lilac', bold: true },
  ];
}

// Cell text, [bear, base, bull] per row key of both tables, from triangulationModel's
// result: ADR to 1 decimal, ₹ and EPS whole, margin and upside whole %, discounts 1-decimal %.
// Upside is the next-FY-end target against CMP.
function valuationExcelCells(tri, t, cmp) {
  const n0 = x => x == null || !isFinite(x) ? '—' : fmtNum(x, 0);
  const each = f => [0, 1, 2].map(f);
  const a = tri.adr;
  return {
    adrFY: each(() => fmtNum(a.adrFY, 1)),
    oi: each(() => n0(a.oi)),
    total: each(() => n0(a.total)),
    margin: each(() => `${fmtNum(t.margin, 0)} %`),
    eps: each(() => n0(a.eps)),
    fwd: each(i => n0(a.fwd[i])),
    up: each(i => a.fwd[i] != null && cmp ? rxSignedPct(a.fwd[i] / cmp - 1, 0) : '—'),
    d1: each(() => `${fmtNum(t.d1, 1)} %`),
    mid: each(i => n0(a.mid[i])),
    d2: each(() => `${fmtNum(t.d2, 1)} %`),
    now: each(i => n0(a.now[i])),
    reg: each(i => tri.reg ? n0(tri.reg[i]) : '—'),
    ratio: each(i => tri.ratio ? n0(tri.ratio.now[i]) : '—'),
    adr: each(i => n0(a.now[i])),
    avg: each(i => tri.avg ? n0(tri.avg[i]) : '—'),
  };
}

// Rounded axis bounds and tick step for a ₹ range
function niceRange(lo, hi, ticks = 6) {
  const span = Math.max(hi - lo, 1);
  const raw = span / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

async function buildValuation(ex) {
  const el = document.getElementById(`${ex}ValuationContent`);
  if (!el) return;
  const series = bseDailySeries(DATA);
  if (!series.length) { el.innerHTML = ''; return; }
  let nseSeries = null, analysts = [];
  if (ex === 'bse') {
    await ensureFreshMarketData(['nse']);
    nseSeries = bseDailySeries(MARKET_RAW.nse || {});
    analysts = await loadBSEAnalystTargets();
    if (currentExchange !== ex) return;  // switched away while loading
    // This view combines BSE's own rows with NSE's from the shared cache
    VIEW_BUILT_FROM.nse = marketSig('nse');
    VIEW_SOURCES.valuation = [{ ex: 'bse', date: lastTradeDate(series) }, { ex: 'nse', date: lastTradeDate(nseSeries) }];
    updateSnapshotNotice();
  }

  const ctx = valuationContext(ex, series, nseSeries);
  const name = SHARE_EXCHANGE_NAMES[ex];
  const defaults = { ...VALUATION_DEFAULTS[ex], shares: SHARES_OUTSTANDING_CR[ex].value };
  const v = loadValuationInputs(ex);
  if (v.src === 'mkt' && !ctx.mkt) v.src = 'proj';
  const state = { basis: v.disc > 0 ? 'now' : 'fwd' };
  const lat = SHARE_DATA?.latest || {};
  const cmp = lat.price_actual ?? null;
  const prov = VALUATION_SOURCE[ex];

  // Market-based ranges for the football field (from the share feed)
  const shareSer = SHARE_DATA?.series || [];
  const lastShareDate = shareSer.length ? shareSer[shareSer.length - 1].date : null;
  const yearAgo = lastShareDate ? (() => { const d = new Date(lastShareDate + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); })() : null;
  const yr = shareSer.filter(r => r.date >= yearAgo && r.price > 0).map(r => r.price);
  const sinceListing = SHARE_DATA?.listing_date && shareSer.length && shareSer[0].date >= yearAgo;
  const fv = lat.price_pred ?? null;
  const meth = SHARE_DATA?.methodology || null;
  const mape = meth?.holdout?.mape_pct ?? null;
  const shareModel = SHARE_DATA?.regression && SHARE_DATA.status !== 'collecting' ? computeShareModel(SHARE_DATA, SHARE_DATA.ma_window || 45) : null;
  const ratio = shareModel ? shareRatioStats(shareModel.series, SHARE_DATA.regression_start) : null;
  const lastMa = shareModel ? latestShareRow(shareModel.series, lat.date)?.rev_ma : null;
  const brokerAvg = analysts.length ? analysts.reduce((s, t) => s + t.target_price, 0) / analysts.length : null;
  const oldest = analysts.reduce((mn, t) => (t.date && (!mn || t.date < mn) ? t.date : mn), null);
  const newest = analysts.reduce((mx, t) => (t.date && (!mx || t.date > mx) ? t.date : mx), null);
  const oldestAge = daysSinceIso(oldest);

  // Triangulated target: the latest quarter in the data starts the ADR path
  const tDefaults = { ...TRIANGULATION_DEFAULTS[ex] };
  const t = loadTriangulationInputs(ex);
  const lastRow = series[series.length - 1];
  const startQ = parseFYQuarter(lastRow.fy_quarter);
  // Typed-over ADRs belong to the quarter they were typed in; a new quarter starts from the data
  if (t.adrQ !== lastRow.fy_quarter) { t.adr0 = null; t.regAdr = null; }
  t.adrQ = lastRow.fy_quarter;
  tDefaults.adrQ = lastRow.fy_quarter;
  const qRows = series.filter(r => r.fy_quarter === lastRow.fy_quarter);
  const qAdr = qRows.length ? qRows.reduce((s, r) => s + (r.total_rev || 0), 0) / qRows.length : 0;
  // Regression and ratio are fitted on the share feed's revenue (today's rates), so they
  // take the quarter's ADR on that basis; the ADR model's (qAdr) is the tab's own rows
  const qFit = fitBasisAdr(SHARE_DATA?.revenue_daily, qRows.map(r => r.date));
  const qAdrFit = qFit ? qFit.adr : qAdr;
  const qFlags = rowsFlags(qRows, 'total');
  const yy = fy => `FY${String(fy).slice(-2)}`;
  const qLabel = startQ ? `Q${startQ.q} ${yy(startQ.fy)}` : '';
  const fy0S = startQ ? yy(startQ.fy) : ctx.fyShort, fy1S = startQ ? yy(startQ.fy + 1) : '';
  const regWithheld = shareModel ? (shareModel.meth ? !shareModel.meth.fair_value_supported : fv == null) : true;
  const regFit = shareModel && !regWithheld ? shareModel.reg : null;
  const regWhy = !shareModel
    ? (SHARE_DATA?.status === 'collecting' ? `${SHARE_DATA.n_days} of ${SHARE_DATA.min_days_required} sessions collected` : 'no share-price fit')
    : regWithheld ? `fit withheld: ${(shareModel.meth?.gate_reasons || ['not significant']).join('; ')}` : '';
  // Discount to today: d1's rate for the days left to this FY's end (IST date), unless typed over
  const todayIso = istDateOf();
  const fyEndIso = startQ ? `${startQ.fy}-03-31` : null;
  const daysToFYEnd = todayIso && fyEndIso ? Math.max(0, Math.round((Date.parse(`${fyEndIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000)) : null;
  const autoD2 = () => discountToToday(t.d1, todayIso, fyEndIso) ?? TRIANGULATION_FLAT_D2;
  const tEff = key => key === 'adr0' ? (t.adr0 ?? qAdr) : key === 'regAdr' ? (t.regAdr ?? t.adr0 ?? qAdrFit)
    : key === 'd2' ? (t.d2 ?? autoD2()) : t[key];
  const tShow = key => key === 'adr0' || key === 'regAdr' ? Math.round(tEff(key) * 100) / 100
    : key === 'd2' ? Math.round(tEff(key) * 10) / 10 : t[key];

  const cmpWhen = cmp == null ? 'no price yet' : lat.is_live ? 'live quote' : `close ${fmtTradeDate(lat.date)}`;
  const fyE = `${ctx.fyShort}E`;
  const chip = (kind, label) => rxChip(label, kind);
  const srcChip = () => chip(prov.kind, prov.label);
  const fieldChip = {
    g: () => ex === 'bse' ? chip('', 'Excel model') : chip('', 'No growth assumed'),
    days: () => chip(ctx.prevFYDays && v.days === ctx.prevFYDays ? 'data' : '', ctx.prevFYDays ? `${ctx.prevFY.replace(' ', '')} had ${ctx.prevFYDays}` : 'Assumption'),
    oi: srcChip, margin: srcChip, pe: srcChip,
    shares: () => sharesChip(ex),
    disc: () => ex === 'bse' ? chip('', 'Excel model') : chip('', 'Not discounted'),
  };
  const edited = keys => keys.some(k => Math.abs(Number(v[k]) - Number(defaults[k])) > 1e-9);
  const editedChip = keys => edited(keys) ? ' ' + rxChip('Edited', 'edit') : '';

  const inp = (key, step, aria, w = '') => `<input class="rx-in rx-num-in" type="number" step="${step}" inputmode="decimal" data-key="${key}" aria-label="${escHtml(aria)}" value="${v[key]}"${w ? ` style="width:${w}"` : ''}>`;

  const adrSrcOptions = [['proj', 'FY projection']].concat(ctx.mkt ? [['mkt', 'Market × BSE share (Excel)']] : []);
  const mkt = ctx.mkt;
  const mktTable = mkt ? `<div class="rx-scroll" style="margin-top:6px"><table class="rx-table"><thead><tr><th scope="col">Market input</th><th scope="col">FY to date</th><th scope="col">Last 45</th><th scope="col">Last 20</th></tr></thead><tbody>
      <tr><td>NSE + BSE ADR, ₹ Cr</td><td>${fmtNum(mkt.totalFY, 2)}</td><td>${fmtNum(mkt.total45, 2)}</td><td>${fmtNum(mkt.total20, 2)}</td></tr>
      <tr><td>BSE share</td><td>${fmtPct(mkt.shareFY)}</td><td>${fmtPct(mkt.share45)}</td><td>${fmtPct(mkt.share20)}</td></tr>
      <tr><td>BSE ADR, ₹ Cr</td><td>${fmtNum(mkt.adrFY, 2)}</td><td>${fmtNum(mkt.adr45, 2)}</td><td>${fmtNum(mkt.adr20, 2)}</td></tr></tbody></table></div>` : '';

  const tin = (key, step, aria, w = '', cls = '') => `<input class="rx-in rx-num-in${cls ? ' ' + cls : ''}" type="number" step="${step}" inputmode="decimal" data-tkey="${key}" aria-label="${escHtml(aria)}" value="${tShow(key)}"${w ? ` style="width:${w}"` : ''}>`;
  const tsrc = k => `<td class="rx-src" data-tsrc="${k}"></td>`;
  const triPath = startQ ? triangulationAdrPath(startQ, 0, 0).path : [];

  // The workbook's layout: gutter inputs | label | Bear | Base | Bull, blocks boxed
  const xlGutIn = {
    qoq: [0.5, 'QoQ ADR growth, %', `ADR growth each quarter from ${qLabel} to Q4 ${fy1S}`],
    oiG: [1, `Other income growth ${fy0S} to ${fy1S}, %`, `Other income growth from ${fy0S} to ${fy1S}`],
    oi: [1, 'Other income, % of total income', 'Other income as a % of total income'],
    band: [1, 'Regression Bear / Bull ADR band, ± %', 'Bear / Bull: the regression ADR ∓ this %'],
  };
  const xlGut = key => key
    ? `<td class="rx-xl-gut" title="${escHtml(xlGutIn[key][2])}">${tin(key, xlGutIn[key][0], xlGutIn[key][1], '', 'rx-xl-in')}<span class="rx-xl-unit">%</span></td>`
    : '<td class="rx-xl-gut"></td>';
  const xlHeads = ['Bear', 'Base', 'Bull'].map((s, i) => `<th scope="col" class="rx-xl-h rx-xl-${s.toLowerCase()} rx-xl-t${i === 2 ? ' rx-xl-r' : ''}">${s}</th>`).join('');
  const xlGap = cols => `<tr class="rx-xl-gap" aria-hidden="true"><td colspan="${cols}"></td></tr>`;
  const xlInAria = {
    pe0: `Bear PE ${fy1S}`, pe1: `Base PE ${fy1S}`, pe2: `Bull PE ${fy1S}`,
    d1: `Discount from ${fy1S} end to ${fy0S} end, %`, d2: `Discount from ${fy0S} end to today, %`,
  };
  // edge(rows, i): the box edges a row's cells carry (top of a later block, bottom of a block or of a boxed row)
  const xlEdge = (rows, i) => {
    const r = rows[i], prev = rows[i - 1], next = rows[i + 1];
    return (prev && prev.block !== r.block ? ' rx-xl-t' : '') + (!next || next.block !== r.block || next.boxed || r.boxed ? ' rx-xl-b' : '');
  };
  const xlTr = (r, e, gut, cells, after = '') => {
    const cls = [r.tint ? `rx-xl-${r.tint}` : '', r.bold ? 'rx-xl-bold' : '', r.boxed ? 'rx-xl-boxed' : ''].filter(Boolean).join(' ');
    return `<tr${cls ? ` class="${cls}"` : ''}>${gut}<td class="rx-xl-lab${e}"${r.key === 'avg' ? ' data-rx="xlAvgLabel"' : ''}>${r.label}</td>${cells}${after}</tr>`;
  };
  const xlRows = startQ ? valuationExcelRows(startQ.fy + 1, t.oiMode) : [];
  const xlBody = xlRows.map((r, i) => {
    const e = xlEdge(xlRows, i);
    const cells = [0, 1, 2].map(j => {
      const key = r.input && r.input[j];
      const cls = `${e}${j === 2 ? ' rx-xl-r' : ''}${key && r.key !== 'pe' ? ' rx-xl-key' : ''}`.trim();
      return `<td${cls ? ` class="${cls}"` : ''}${key ? '' : ` data-xout="${r.key}-${j}"`}>${key ? tin(key, r.key === 'pe' ? 1 : 0.5, xlInAria[key], '', r.key === 'pe' ? '' : 'rx-xl-in') : ''}</td>`;
    }).join('');
    return (e.includes('rx-xl-t') ? xlGap(5) : '') + xlTr(r, e, xlGut(r.gut), cells);
  }).join('');
  const sumRows = triangulationSummaryRows(t);
  const sumBody = sumRows.map((r, i) => {
    const e = xlEdge(sumRows, i);
    const cells = [0, 1, 2].map(j => `<td class="${`${e}${j === 2 ? ' rx-xl-r' : ''}`.trim()}" data-xout="${r.key}-${j}"></td>`).join('');
    const w = `<td class="rx-xl-w">${r.w ? `${tin(r.w, 5, `${r.label} weight, %`, '', 'rx-xl-in')}<span class="rx-xl-unit">%</span>` : '<span data-tout="wsum"></span>'}</td>`;
    return xlTr(r, e, xlGut(r.gut), cells, w);
  }).join('');

  const triHTML = startQ ? `
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-xl-val', title: `Valuation · ${fy1S}E`, meta: `ADR ₹ Cr / session · income ₹ Cr · EPS and targets ₹ per share · ADR from ${qLabel}`,
        right: '<button type="button" class="rx-link" data-rx="triReset">Reset to defaults</button>',
        body: `<div class="rx-pb rx-scroll"><table class="rx-table rx-xl" aria-label="Valuation ${fy1S}E, Bear / Base / Bull">
          <thead><tr><td class="rx-xl-gut"></td><th scope="col" class="rx-xl-lab rx-xl-cmp rx-xl-t">CMP ${cmp != null ? rxRupee(cmp) : '—'}</th>${xlHeads}</tr></thead>
          <tbody>${xlBody}</tbody></table></div>`,
        foot: `Light-blue boxes are inputs: QoQ ADR growth beside ADR ${fy1S.replace('FY', 'FY ')}, ${t.oiMode === 'pct' ? 'other income as a % of total income' : `other-income growth from ${fy0S}`} beside Other Income, and each discount in the Base column; the PE row is editable. Upside: the ${fy1S}-end target vs CMP (${cmpWhen}). Sessions${t.oiMode === 'pct' ? '' : `, ${fy0S} other income`} and PAT margin are set under ADR model inputs below. <span data-rx="triDiff"></span>` })}
      ${rxPanel({ cls: 'rx-col-xl-sum', title: 'Triangulated target', meta: 'today, ₹ per share · three methods, weighted',
        body: `<div class="rx-pb rx-scroll"><table class="rx-table rx-xl" aria-label="Triangulated target summary">
          <thead><tr><td class="rx-xl-gut"></td><th scope="col" class="rx-xl-lab rx-xl-h rx-xl-sum rx-xl-t">Summary</th>${xlHeads}<th scope="col" class="rx-xl-w">Weight</th></tr></thead>
          <tbody>${sumBody}</tbody></table></div>`,
        foot: '<span data-rx="triUp"></span> <span data-rx="triNote"></span>',
        how: rxHow('Basis of each row', `<ul>
          <li><strong>Regression:</strong> <span data-tsrc="reg"></span></li>
          <li><strong>Ratio Analysis:</strong> <span data-tsrc="ratio"></span></li>
          <li><strong>ADR:</strong> <span data-tsrc="adr"></span> (the valuation block's Target Price Current).</li>
          <li><strong>Average:</strong> <span data-tsrc="avg"></span>.</li></ul>`) })}
    </div>` : '';
  // How the figures are built: the ADR path, the ADR model's other inputs, the fits
  const triDetailHTML = startQ ? `
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-narrow', title: `ADR path to ${fy1S}`, meta: '₹ Cr / session · compounding QoQ',
        body: `<div class="rx-scroll"><table class="rx-table">
          <thead><tr><th scope="col">Quarter</th><th scope="col">ADR</th><th scope="col" class="rx-l">Source</th></tr></thead>
          <tbody>
            ${triPath.map((p, i) => i === 0
              ? `<tr><td>${p.label} · to date${flagTags(qFlags)}</td><td>${tin('adr0', 0.1, `${p.label} ADR`)}</td>${tsrc('adr0')}</tr>`
              : `<tr><td>${p.label}</td><td data-tout="path-${i}"></td><td class="rx-src"></td></tr>`).join('')}
            <tr class="rx-sub"><td>${fy1S} average</td><td data-tout="pathAvg"></td><td class="rx-src">mean of its four quarters</td></tr>
            <tr><td>QoQ growth, %</td><td data-tout="qoqV"></td>${tsrc('qoq')}</tr>
          </tbody></table></div>` })}
      ${rxPanel({ cls: 'rx-col-wide', title: `ADR model ${fy1S}E · inputs`, meta: 'How the figures above are built · saved in this browser',
        body: `<div class="rx-scroll"><table class="rx-table rx-wrap-lab">
          <thead><tr><th scope="col">ADR model</th><th scope="col">Value</th><th scope="col" class="rx-l">Source</th></tr></thead>
          <tbody>
            <tr><td>ADR ${fy1S}E, ₹ Cr / session${flagTags(qFlags)}</td><td data-tout="adrFY"></td><td class="rx-src">from the ADR path</td></tr>
            <tr><td>Trading sessions in ${fy1S}</td><td>${tin('days', 1, `Trading sessions in ${fy1S}`)}</td>${tsrc('days')}</tr>
            <tr><td>Transaction revenue, ₹ Cr</td><td data-tout="txn"></td><td class="rx-src">ADR × sessions</td></tr>
            ${t.oiMode === 'pct'
              ? `<tr><td>Other income, % of total income</td><td data-tout="oiV"></td>${tsrc('oi')}</tr>
                 <tr><td>Other income, ₹ Cr</td><td data-tout="oi"></td><td class="rx-src">solved from the %</td></tr>`
              : `<tr><td>Other income ${fy0S}, ₹ Cr</td><td>${tin('oi', 10, `Other income ${fy0S}`, '96px')}</td>${tsrc('oi')}</tr>
                 <tr><td>Other income growth to ${fy1S}, %</td><td data-tout="oiGV"></td>${tsrc('oiG')}</tr>
                 <tr><td>Other income ${fy1S}, ₹ Cr</td><td data-tout="oi"></td><td class="rx-src"></td></tr>`}
            <tr class="rx-sub"><td>Total income, ₹ Cr</td><td data-tout="total"></td><td class="rx-src"></td></tr>
            <tr><td>PAT margin, %</td><td>${tin('margin', 0.5, `PAT margin ${fy1S}`)}</td>${tsrc('margin')}</tr>
            <tr class="rx-sub"><td>PAT, ₹ Cr</td><td data-tout="pat"></td><td class="rx-src"></td></tr>
            <tr><td>Shares, Cr</td><td data-tout="shares"></td><td class="rx-src">${sharesChip(ex)} set in the current FY model below</td></tr>
            <tr class="rx-sub"><td>EPS ${fy1S}E, ₹</td><td data-tout="eps"></td><td class="rx-src"></td></tr>
            <tr><td>PE, Bear / Base / Bull, ×</td><td data-tout="peV"></td>${tsrc('pe')}</tr>
            <tr><td>Discount to ${fy0S} end, %</td><td data-tout="d1V"></td>${tsrc('d1')}</tr>
            <tr><td>Discount to today, %</td><td data-tout="d2V"></td>${tsrc('d2')}</tr>
          </tbody></table>
          <table class="rx-table rx-wrap-lab" style="margin-top:10px">
          <thead><tr><th scope="col">Regression and ratio</th><th scope="col">Value</th><th scope="col" class="rx-l">Source</th></tr></thead>
          <tbody>
            <tr><td>Intercept, ₹</td><td data-tout="regA"></td><td class="rx-src" rowspan="2" data-tsrc="fit"></td></tr>
            <tr><td>Slope, ₹ per ₹ Cr</td><td data-tout="regB"></td></tr>
            <tr><td>ADR into the fit, ₹ Cr</td><td>${tin('regAdr', 0.1, 'ADR into the regression')}</td>${tsrc('regAdr')}</tr>
            <tr><td>Bear / Bull ADR band, ± %</td><td data-tout="bandV"></td>${tsrc('band')}</tr>
            <tr><td>Price ÷ MA, mean ×</td><td data-tout="ratioMean"></td><td class="rx-src" rowspan="2" data-tsrc="ratioFit"></td></tr>
            <tr><td>Price ÷ MA, σ ×</td><td data-tout="ratioSd"></td></tr>
            <tr><td>${qLabel} ADR at today’s rates, ₹ Cr</td><td data-tout="qAdrFit"></td><td class="rx-src" data-tsrc="qAdrFit"></td></tr>
            <tr><td>${fy1S} ADR into the ratio, ₹ Cr</td><td data-tout="ratioAdr"></td><td class="rx-src" data-tsrc="ratioAdr"></td></tr>
          </tbody></table></div>` })}
    </div>` : '';

  el.innerHTML = `<div class="rx">
    ${ex === 'mcx' ? rxAlert('<strong>Placeholder inputs.</strong> There is no MCX valuation baseline in this repo: PAT margin, other income and P/E multiples are round-number placeholders, so these targets are illustrative until you set them.') : ''}
    ${triHTML}
    <section class="rx-kpis" aria-label="Valuation summary" data-rx="kpis"></section>
    <p class="rx-foot rx-kpi-note" data-rx="kpiNote"></p>
    ${triDetailHTML}
    ${rxPanel({ title: 'Valuation range by method', meta: '₹ per share · bars span the range, tick = base or centre',
      right: rxLegend([{ label: 'This model', color: RX.model }, { label: 'Market-based', color: RX.grey }, { label: cmp != null ? `CMP ${rxRupee(cmp)}` : 'CMP', color: RX.neg, kind: 'tick' }]),
      body: '<div class="rx-pb"><div class="rx-ff" data-rx="ff"></div></div>', foot: '<span data-rx="ffNote"></span>' })}
    <div class="rx-row">
      <section class="rx-panel rx-col-wide" aria-label="Current FY model, ${ctx.fyShort}">
        <div class="rx-ph"><h2>Current FY model · ${ctx.fyShort}</h2><span class="rx-meta">Feeds the football field and sensitivity · one model, three scenarios · saved in this browser</span>
          <div class="rx-ph-right"><span class="rx-lbl">Targets as</span>${rxSeg('basis', [['fwd', `${ctx.fyShort} end`], ['now', 'Today (discounted)']], state.basis, 'Target basis')}<button type="button" class="rx-link" data-rx="reset">Reset to defaults</button></div></div>
        <div class="rx-pb" style="padding-bottom:6px">
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center"><span class="rx-lbl">Base ADR from</span>${rxSeg('src', adrSrcOptions, v.src, 'Base ADR method')}</div>
          <p class="rx-foot" data-rx="srcNote" style="margin-top:6px"></p>
        </div>
        <div class="rx-scroll"><table class="rx-table">
          <thead><tr><th scope="col">Line</th><th scope="col">Bear</th><th scope="col">Base</th><th scope="col">Bull</th><th scope="col" class="rx-l">Source</th></tr></thead>
          <tbody>
            <tr><td>ADR growth, rest of year, %</td><td>${inp('g0', 1, 'Bear ADR growth')}</td><td>${inp('g1', 1, 'Base ADR growth')}</td><td>${inp('g2', 1, 'Bull ADR growth')}</td><td class="rx-src" data-src="g"></td></tr>
            <tr><td>ADR, ₹ Cr / session${flagTags(ctx.flags)}</td><td data-out="adr-0"></td><td data-out="adr-1"></td><td data-out="adr-2"></td><td class="rx-src">${chip('data', `${ctx.elapsed} sessions actual`)}</td></tr>
            <tr><td>Trading sessions in ${ctx.fy}</td><td colspan="3" class="rx-c">${inp('days', 1, 'Trading sessions in the year')}</td><td class="rx-src" data-src="days"></td></tr>
            <tr><td>Transaction revenue, ₹ Cr</td><td data-out="txn-0"></td><td data-out="txn-1"></td><td data-out="txn-2"></td><td class="rx-src"></td></tr>
            <tr><td>${v.oiMode === 'pct' ? 'Other income, % of total income' : 'Other income, ₹ Cr'}</td><td colspan="3" class="rx-c">${inp('oi', 1, 'Other income', '96px')}</td><td class="rx-src" data-src="oi"></td></tr>
            ${v.oiMode === 'pct' ? '<tr><td>Other income, ₹ Cr</td><td data-out="oi-0"></td><td data-out="oi-1"></td><td data-out="oi-2"></td><td class="rx-src">solved from the %</td></tr>' : ''}
            <tr class="rx-sub"><td>Total income, ₹ Cr</td><td data-out="total-0"></td><td data-out="total-1"></td><td data-out="total-2"></td><td class="rx-src"></td></tr>
            <tr><td>PAT margin, %</td><td colspan="3" class="rx-c">${inp('margin', 0.5, 'PAT margin')}</td><td class="rx-src" data-src="margin"></td></tr>
            <tr class="rx-sub"><td>PAT, ₹ Cr</td><td data-out="pat-0"></td><td data-out="pat-1"></td><td data-out="pat-2"></td><td class="rx-src"></td></tr>
            <tr><td>Shares, Cr</td><td colspan="3" class="rx-c">${inp('shares', 0.01, 'Shares outstanding')}</td><td class="rx-src" data-src="shares"></td></tr>
            <tr class="rx-sub"><td>EPS ${fyE}, ₹</td><td data-out="eps-0"></td><td data-out="eps-1"></td><td data-out="eps-2"></td><td class="rx-src"></td></tr>
            <tr><td>P/E, ×</td><td>${inp('pe0', 1, 'Bear P/E')}</td><td>${inp('pe1', 1, 'Base P/E')}</td><td>${inp('pe2', 1, 'Bull P/E')}</td><td class="rx-src" data-src="pe"></td></tr>
            <tr class="rx-sub"><td>Target at ${ctx.fyShort} end, ₹</td><td data-out="fwd-0"></td><td data-out="fwd-1"></td><td data-out="fwd-2"></td><td class="rx-src">EPS × P/E</td></tr>
            <tr><td>Discount to today, %</td><td colspan="3" class="rx-c">${inp('disc', 0.5, 'Discount rate')}</td><td class="rx-src" data-src="disc"></td></tr>
            <tr class="rx-sub"><td>Target today, ₹</td><td data-out="now-0"></td><td data-out="now-1"></td><td data-out="now-2"></td><td class="rx-src">÷ (1 + discount)</td></tr>
            <tr class="rx-out"><td>Upside vs CMP · <span data-rx="basisName"></span></td><td data-out="up-0"></td><td data-out="up-1"></td><td data-out="up-2"></td><td class="rx-src">CMP ${cmp != null ? rxRupee(cmp) : '—'}, ${cmpWhen}</td></tr>
          </tbody>
        </table></div>
        ${rxHow('How this model works', `<ul>
          <li><strong>FY projection:</strong> ${ctx.fy} revenue to date (${ctx.elapsed} sessions, ${rxCr(ctx.revToDate, 0)}) plus the trailing 45-session average (${rxCr(ctx.adr45, 2)}) for the sessions left, divided by the sessions in the year.</li>
          ${ctx.mkt ? `<li><strong>Market × BSE share (Excel “Annual Predictor”):</strong> the sessions left earn the NSE + BSE 45-session market ADR × BSE’s 20-session share (${rxCr(mkt.total45 * mkt.share20, 2)} a session).</li>` : ''}
          <li>Scenario growth applies to the sessions left only; P/E differs by scenario. Other income${v.oiMode === 'pct' ? ' is solved so it is the given % of total income (transaction revenue + other income)' : ' is a fixed annual figure'}.</li>
          <li>The ${ctx.fyShort}-end target is EPS × P/E on the full-year ${fyE} EPS, not a spot fair value; “Today” discounts it by the discount rate.</li>
        </ul>${mktTable}`)}
      </section>
      ${rxPanel({ cls: 'rx-col-narrow', title: 'Sensitivity', meta: '<span data-rx="sensMeta"></span>',
        body: `<div class="rx-pb rx-scroll"><table class="rx-table rx-sens" data-rx="sens"></table>
          <div style="margin-top:10px">${rxLegend([{ label: 'Downside', color: '#E9B48C' }, { label: '', color: '#F5D9C4' }, { label: '±5 %', color: '#F1F1EE' }, { label: '', color: '#CBD8F4' }, { label: 'Upside', color: '#9DB4E8' }])}</div>
          <p class="rx-foot" style="margin-top:6px">Outlined: base case. Other inputs as set.</p></div>` })}
    </div>
    ${ex === 'bse' ? rxPanel({ title: 'Analyst targets', meta: 'bse_analyst_targets.json · 12-month targets',
      right: oldestAge != null && oldestAge > ANALYST_TARGET_STALE_DAYS ? rxChip(`Oldest ${oldestAge} days old`, 'warn') : '',
      body: `<div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col">Broker</th><th scope="col">Target</th><th scope="col">vs CMP</th><th scope="col" class="rx-l">Rating</th><th scope="col">Date</th><th scope="col">Age</th><th scope="col" class="rx-l">Method</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        ${analysts.length ? analysts.slice().sort((a, b) => b.target_price - a.target_price).map(t => {
          const age = daysSinceIso(t.date);
          const url = safeHttpUrl(t.source_url);
          return `<tr><td>${escHtml(t.broker)}</td><td>${rxRupee(t.target_price)}</td><td>${cmp ? rxChangeHTML(t.target_price / cmp - 1) : '—'}</td><td class="rx-l">${escHtml(t.rating || '')}</td><td>${rxDate(t.date)}</td><td>${age == null ? '—' : rxChip(`${age} d`, age > ANALYST_TARGET_STALE_DAYS ? 'warn' : '')}</td><td class="rx-wrap">${escHtml(t.methodology || '')}</td><td class="rx-l">${url ? `<a class="rx-link" href="${url}" target="_blank" rel="noopener noreferrer">Report ↗</a>` : '<span class="rx-foot">not on file</span>'}</td></tr>`;
        }).join('') : '<tr><td colspan="8" class="rx-l">No analyst targets on file: add them to dashboard/data/bse_analyst_targets.json</td></tr>'}
      </tbody></table></div>`,
      foot: `Notes older than ${ANALYST_TARGET_STALE_DAYS} days are flagged. Revenue trend tables are on <button type="button" class="rx-link" data-rx-goto="revenue">Revenue Summary</button>; the moving-average charts on <button type="button" class="rx-link" data-rx-goto="share">Regression</button>.` }) : ''}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);

  function compute() {
    return VALUATION_SCENARIOS.map((s, i) => valuationScenario(ctx, v, v['g' + i], v['pe' + i], cmp));
  }

  function renderTri() {
    if (!startQ) return null;
    const a0 = tEff('adr0');
    const path = triangulationAdrPath(startQ, a0, t.qoq);
    const regAdr = tEff('regAdr');
    // A typed-over ADR drives every method; otherwise the ratio grows the fit-basis ADR the same way
    const ratioPath = t.adr0 != null ? path : triangulationAdrPath(startQ, qAdrFit, t.qoq);
    const tm = { ...t, d2: tEff('d2') };   // the inputs as used: the dated discount filled in
    const tri = triangulationModel(tm, { adrFY: path.adr, regAdr, ratioAdrFY: ratioPath.adr, reg: regFit, ratio, shares: v.shares });
    const set = (k, html) => { const n = el.querySelector(`[data-tout="${k}"]`); if (n) n.innerHTML = html; };
    const src = (k, html) => { const n = el.querySelector(`[data-tsrc="${k}"]`); if (n) n.innerHTML = html; };
    const upC = x => x == null || !cmp ? '—' : `<span class="${x / cmp - 1 >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(x / cmp - 1, 0)}</span>`;
    const disc = `÷ ${fmtNum(1 + tm.d1 / 100, 2)} ÷ ${fmtNum(1 + tm.d2 / 100, 2)}`;
    // The two Excel-layout tables; upside cells keep the up / down colour
    Object.entries(valuationExcelCells(tri, tm, cmp)).forEach(([k, vals]) => vals.forEach((txt, i) => {
      const n = el.querySelector(`[data-xout="${k}-${i}"]`);
      if (n) n.innerHTML = k === 'up' && txt !== '—' ? `<span class="${txt[0] === '+' ? 'rx-up' : 'rx-dn'}">${txt}</span>` : txt;
    }));
    q('xlAvgLabel').textContent = triangulationSummaryRows(t)[3].label;
    set('wsum', `${fmtNum(tri.wTotal, 0)} %`);
    q('triUp').innerHTML = tri.avg && cmp ? `Average vs CMP: ${[0, 1, 2].map(i => upC(tri.avg[i])).join(' / ')}.` : '';
    src('reg', regFit
      ? `₹${fmtNum(regFit.intercept, 0)} + ${fmtNum(regFit.slope, 1)} × ADR ${fmtNum(regAdr, 2)}, ∓ ${fmtNum(t.band, 0)} % for Bear / Bull`
      : `<span class="rx-foot">${escHtml(regWhy)}</span>`);
    src('ratio', tri.ratio
      ? `${fmtNum(tri.ratio.k[0], 0)} / ${fmtNum(tri.ratio.k[1], 0)} / ${fmtNum(tri.ratio.k[2], 0)} × ${fy1S} ADR ${fmtNum(tri.ratio.adrFY, 2)}, ${disc}`
      : '<span class="rx-foot">no price ÷ MA history</span>');
    src('adr', tri.adr.eps != null ? `EPS ₹${fmtNum(tri.adr.eps, 2)} × ${fmtNum(t.pe0, 0)} / ${fmtNum(t.pe1, 0)} / ${fmtNum(t.pe2, 0)}, ${disc}` : 'needs a share count');
    src('avg', tri.wSum && tri.wSum !== tri.wTotal ? `over ${tri.used.length} method${tri.used.length === 1 ? '' : 's'} with a value` : 'Σ weight × target ÷ Σ weight');

    // ADR model and path
    set('adrFY', fmtNum(path.adr, 2)); set('txn', fmtNum(tri.adr.txn, 0)); set('oi', fmtNum(tri.adr.oi, 0));
    set('total', fmtNum(tri.adr.total, 0)); set('pat', fmtNum(tri.adr.pat, 0)); set('shares', fmtNum(v.shares, 2));
    set('eps', tri.adr.eps != null ? fmtNum(tri.adr.eps, 2) : '—');
    path.path.forEach((p, i) => { if (i) set(`path-${i}`, fmtNum(p.adr, 2)); });
    set('pathAvg', fmtNum(path.adr, 2));
    set('regA', regFit ? fmtNum(regFit.intercept, 0) : '—'); set('regB', regFit ? fmtNum(regFit.slope, 2) : '—');
    set('ratioMean', ratio ? fmtNum(ratio.mean, 1) : '—'); set('ratioSd', ratio ? fmtNum(ratio.sd, 1) : '—');
    set('qAdrFit', fmtNum(qAdrFit, 2)); set('ratioAdr', fmtNum(ratioPath.adr, 2));
    src('qAdrFit', qFit ? chip('data', `${qFit.n} sessions · the fits’ revenue`) : '<span class="rx-foot">not in the share feed: the tab’s own ADR</span>');
    src('ratioAdr', t.adr0 != null ? rxChip('Edited', 'edit') + ` from ${qLabel} ADR ${fmtNum(t.adr0, 2)}` : `the ADR path, from ${qLabel} at today’s rates`);
    // Inputs that live in the Excel layout, echoed beside their sources
    set('qoqV', `${fmtNum(t.qoq, 1)} %`); set('bandV', `± ${fmtNum(t.band, 0)} %`);
    set('oiV', `${fmtNum(t.oi, 1)} %`); set('oiGV', `${fmtNum(t.oiG, 1)} %`);
    set('peV', `${fmtNum(t.pe0, 0)} / ${fmtNum(t.pe1, 0)} / ${fmtNum(t.pe2, 0)}`);
    set('d1V', `${fmtNum(t.d1, 1)} %`); set('d2V', `${fmtNum(tm.d2, 1)} %`);
    src('fit', regFit ? chip('data', `${SHARE_DATA.ticker} · R² ${fmtNum(regFit.r_squared, 2)}`) : `<span class="rx-foot">${escHtml(regWhy)}</span>`);
    src('ratioFit', ratio ? chip('data', `fit sessions since ${rxDate(SHARE_DATA.regression_start)}`) : '');
    const ed = keys => keys.some(k => t[k] !== tDefaults[k] && !(t[k] != null && tDefaults[k] != null && Math.abs(t[k] - tDefaults[k]) < 1e-9));
    const eChip = keys => ed(keys) ? ' ' + rxChip('Edited', 'edit') : '';
    const excel = ex === 'bse' ? chip('', 'Excel model') : chip('', 'Excel BSE sheet');
    const provC = ex === 'bse' ? chip('', 'Excel model') : srcChip();
    const qoqA = (Math.pow(1 + t.qoq / 100, 4) - 1);
    src('adr0', (ed(['adr0']) ? rxChip('Edited', 'edit') : chip('data', `${qRows.length} sessions`)));
    src('regAdr', ed(['regAdr']) ? rxChip('Edited', 'edit') : chip('', qFit ? `= ${qLabel} ADR at today’s rates` : `= ${qLabel} ADR`));
    src('qoq', (ex === 'bse' ? chip('', 'Excel model') : chip('', 'No growth assumed')) + ` ${fmtPct(qoqA)} a year` + eChip(['qoq']));
    src('days', chip(ctx.prevFYDays && t.days === ctx.prevFYDays ? 'data' : '', ctx.prevFYDays ? `${ctx.prevFY.replace(' ', '')} had ${ctx.prevFYDays}` : 'Assumption') + eChip(['days']));
    // Where this block's margin, P/E or other income differs from the FY model's
    const diffs = triangulationVsFyModel(t, v);
    const diffOf = key => diffs.find(d => d.keys.includes(key));
    const diffVals = (d, vals) => d.keys[0] === 'oi' ? (t.oiMode === 'pct' ? `${fmtNum(vals[0], 1)} %` : `₹${fmtNum(vals[0], 0)} Cr`)
      : d.keys[0] === 'margin' ? `${fmtNum(vals[0], 1)} %` : `${vals.map(x => fmtNum(x, 0)).join(' / ')}×`;
    const fyChip = key => { const d = diffOf(key); return d ? ' ' + rxChip(`${ctx.fyShort} model: ${diffVals(d, d.fy0)}`, 'warn') : ''; };
    q('triDiff').innerHTML = diffs.length
      ? `Differs from the ${ctx.fyShort} model below${ex === 'bse' ? ' (the workbook keeps the two apart)' : ''}: ${diffs.map(d => `${d.label} ${diffVals(d, d.fy1)} here, ${diffVals(d, d.fy0)} there`).join('; ')}. <button type="button" class="rx-link" data-rx="triMatch">Use the ${ctx.fyShort} model’s</button>`
      : `PAT margin, P/E and ${t.oiMode === 'pct' ? 'other income %' : `${fy0S} other income`} match the ${ctx.fyShort} model below.`;
    ['oi', 'margin'].forEach(k => src(k, provC + eChip([k]) + fyChip(k)));
    src('oiG', provC + eChip(['oiG']));
    src('pe', provC + eChip(['pe0', 'pe1', 'pe2']) + fyChip('pe0'));
    ['d1', 'band'].forEach(k => src(k, excel + eChip([k])));
    src('d2', ed(['d2']) ? rxChip('Edited', 'edit')
      : daysToFYEnd != null ? chip('data', `${daysToFYEnd} days to ${fy0S} end at ${fmtNum(t.d1, 1)} % a year`) : excel);
    el.querySelectorAll('input[data-tkey]').forEach(i => {
      i.classList.toggle('is-edited', ed([i.dataset.tkey]));
      if (i.dataset.tkey === 'regAdr' && t.regAdr == null && document.activeElement !== i) i.value = tShow('regAdr');
      if (i.dataset.tkey === 'd2' && t.d2 == null && document.activeElement !== i) i.value = tShow('d2');   // follows d1
    });

    const notes = [];
    if (!regFit) notes.push(`Regression unavailable (${regWhy}); its weight is shared by the other methods.`);
    if (!ratio) notes.push('No price ÷ MA history for the ratio method.');
    if (tri.adr.eps == null) notes.push('ADR model unavailable: needs a share count; its weight is shared by the other methods.');
    if (tri.wTotal !== 100) notes.push(`Weights add to ${fmtNum(tri.wTotal, 0)} %; the average divides by the weights used.`);
    const basisGap = qFit && Math.abs(qAdr - qAdrFit) > 0.005;
    notes.push(`${qLabel} ADR is ${qRows.length} sessions to date. `
      + (qFit ? `Regression and Ratio take it at today’s rates (₹${fmtNum(qAdrFit, 2)} Cr), the basis their fits are built on; the ADR model takes the tab’s own rows${basisGap ? ` (₹${fmtNum(qAdr, 2)} Cr)` : ''}`
              : 'The share feed has no revenue for it yet, so all three methods take the tab’s own rows')
      + `${ex === 'bse' ? '. The Excel workbook prices at today’s rates too' : ''}.`);
    if (t.d2 == null && daysToFYEnd != null) notes.push(`Discount to today: ${fmtNum(tm.d2, 1)} %, ${fmtNum(t.d1, 1)} % a year for the ${daysToFYEnd} days left to ${fy0S} end (the workbook keeps a flat ${TRIANGULATION_FLAT_D2} %).`);
    if (ex !== 'bse') notes.push('P/E, margin and other income start from this tab’s FY model; discounts and weights from the Excel BSE sheet.');
    q('triNote').innerHTML = notes.join(' ');
    return tri;
  }

  function render() {
    const tri = renderTri();
    const sc = compute();
    const base = sc[1];
    const pick = s => state.basis === 'now' ? s.now : s.fwd;
    const up = s => state.basis === 'now' ? s.upNow : s.upFwd;
    const basisName = state.basis === 'now' ? 'today' : `${ctx.fyShort} end`;
    q('basisName').textContent = basisName;
    q('srcNote').textContent = v.src === 'mkt' && ctx.mkt
      ? `${ctx.elapsed} sessions actual (${rxCr(ctx.revToDate, 0)}), then ${rxCr(ctx.mkt.total45 * ctx.mkt.share20, 2)} a session: market ADR ${fmtNum(ctx.mkt.total45, 2)} × BSE 20-session share ${fmtPct(ctx.mkt.share20)}.`
      : `${ctx.elapsed} sessions actual (${rxCr(ctx.revToDate, 0)}), then the trailing 45-session average ${rxCr(ctx.adr45, 2)} a session.`;

    // Assumption table outputs
    sc.forEach((s, i) => {
      const set = (k, html) => { const n = el.querySelector(`[data-out="${k}-${i}"]`); if (n) n.innerHTML = html; };
      set('adr', fmtNum(s.adr, 2)); set('txn', fmtNum(s.txn, 0)); set('oi', fmtNum(s.oi, 0)); set('total', fmtNum(s.total, 0));
      set('pat', fmtNum(s.pat, 0)); set('eps', fmtNum(s.eps, 2)); set('fwd', fmtNum(s.fwd, 0)); set('now', fmtNum(s.now, 0));
      set('up', up(s) == null ? '—' : `<span class="${up(s) >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(up(s))}</span>`);
    });
    Object.entries({ g: ['g0', 'g1', 'g2'], days: ['days'], oi: ['oi'], margin: ['margin'], shares: ['shares'], pe: ['pe0', 'pe1', 'pe2'], disc: ['disc'] })
      .forEach(([k, keys]) => { const n = el.querySelector(`[data-src="${k}"]`); if (n) n.innerHTML = fieldChip[k]() + editedChip(keys); });
    el.querySelectorAll('input[data-key]').forEach(i => i.classList.toggle('is-edited', Math.abs(Number(v[i.dataset.key]) - Number(defaults[i.dataset.key])) > 1e-9));

    // KPIs. The targets value different things, so each tile names what: the current-FY model
    // (P/E × this FY's EPS), the triangulated target (next-FY methods, today) and, where there
    // are broker notes, the analysts' 12-month mean; the note under the row says why they differ.
    const triBase = tri && tri.avg ? tri.avg[1] : null;
    const triNames = { reg: 'regression', ratio: 'ratio', adr: 'ADR' };
    const triW = !tri ? '' : tri.used.length === 1 ? `${triNames[tri.used[0]]} only`
      : [['reg', t.w0], ['ratio', t.w1], ['adr', t.w2]].filter(([k]) => tri.used.includes(k)).map(([k, w]) => `${triNames[k]} ${fmtNum(w, 0)}`).join(' · ');
    const range = yr.length ? `${sinceListing ? 'since listing' : '52-week'} ${rxRupee(Math.min(...yr))} – ${fmtNum(Math.max(...yr), 0)}` : cmpWhen;
    const vsCmp = x => cmp && x != null ? `${rxChangeHTML(x / cmp - 1)} vs CMP` : 'no CMP yet';
    const tiles = [
      rxKpi('CMP', cmp != null ? rxRupee(cmp) : '—', `${cmpWhen}${yr.length ? ' · ' + range : ''}`),
      rxKpi(`EPS ${fyE} · base`, rxRupee(base.eps, 2), `PAT ${rxCr(base.pat, 0)} on ${fmtNum(v.shares, 2)} Cr shares`),
      rxKpi('P/E at CMP', cmp && base.eps ? `${fmtNum(cmp / base.eps, 1)}×` : '—', `vs base multiple ${fmtNum(v.pe1, 0)}×`),
      rxKpi(`${ctx.fyShort} model · base · ${basisName}`, rxRupee(pick(base)), `${vsCmp(pick(base))} · ${fmtNum(v.pe1, 0)}× ${fyE} EPS`, { accent: true }),
      triBase != null
        ? rxKpi('Triangulated · base · today', rxRupee(triBase), `${vsCmp(triBase)} · ${fy1S} methods: ${triW}`)
        : rxKpi('Triangulated · base · today', '—', 'no method has a value'),
    ];
    if (brokerAvg != null) {
      const stale = oldestAge != null && oldestAge > ANALYST_TARGET_STALE_DAYS;
      tiles.push(rxKpi('Analysts · 12-month', rxRupee(brokerAvg), `${vsCmp(brokerAvg)} · mean of ${analysts.length}${stale ? ` · oldest ${oldestAge} days` : ''}`));
    }
    q('kpis').innerHTML = tiles.join('');
    // Why the model targets differ: they price different years' earnings
    const fyDisc = state.basis === 'now' && v.disc > 0 ? `, discounted ÷ ${fmtNum(1 + v.disc / 100, 2)} to today` : '';
    let triText = '';
    if (triBase != null) {
      const adrHow = `${fy1S}E EPS ${rxRupee(tri.adr.eps, 2)} at ${fmtNum(t.pe1, 0)}×, ÷ ${fmtNum(1 + t.d1 / 100, 2)} ÷ ${fmtNum(1 + tEff('d2') / 100, 2)} to today`;
      const names = tri.used.map(k => triNames[k]);
      const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
      triText = tri.used.length === 1 && tri.used[0] === 'adr'
        ? `The triangulated target is the ${fy1S} ADR method alone: ${adrHow}. `
        : `The triangulated target is built on ${fy1S}: the ${list} method${names.length > 1 ? 's' : ''}, each a price for today${tri.used.includes('adr') ? `; its ADR method is ${adrHow}` : ''}. `;
    }
    q('kpiNote').innerHTML = (base.eps != null ? `The ${ctx.fyShort} model prices ${fyE} EPS of ${rxRupee(base.eps, 2)} at ${fmtNum(v.pe1, 0)}×${fyDisc}. ` : '')
      + triText + (brokerAvg != null ? 'Analyst targets are their 12-month prices, not discounted.' : '');

    // Football field
    const rows = [];
    if (triBase != null) rows.push({ label: 'Triangulated', note: `today · weighted ${fy1S} methods`, lo: tri.avg[0], mid: triBase, hi: tri.avg[2], color: RX.model, midLabel: 'base' });
    rows.push({ label: 'P/E × EPS', note: `${ctx.fyShort} model · ${basisName}`, lo: pick(sc[0]), mid: pick(base), hi: pick(sc[2]), color: RX.model, midLabel: 'base' });
    if (fv != null) rows.push({ label: 'Regression fair value', note: mape != null ? `${rxRupee(fv)} ± ${mape.toFixed(1)} % holdout error${meth?.holdout && !meth.holdout.beats_naive ? ' · loses to “price unchanged”' : ''}` : 'published fair value', lo: mape != null ? fv * (1 - mape / 100) : fv, mid: fv, hi: mape != null ? fv * (1 + mape / 100) : fv, color: RX.grey, midLabel: 'fair value' });
    else rows.push({ label: 'Regression fair value', note: SHARE_DATA?.status === 'collecting' ? `${SHARE_DATA.n_days} of ${SHARE_DATA.min_days_required} sessions collected` : 'withheld: fit not significant', na: true });
    if (ratio && lastMa) rows.push({ label: 'Price ÷ revenue MA band', note: `mean ± 1σ × MA ₹${fmtNum(lastMa, 2)} Cr`, lo: (ratio.mean - ratio.sd) * lastMa, mid: ratio.mean * lastMa, hi: (ratio.mean + ratio.sd) * lastMa, color: RX.grey, midLabel: 'mean' });
    if (analysts.length) {
      const tp = analysts.map(t => t.target_price);
      rows.push({ label: 'Analyst targets', note: `${analysts.length} brokers, 12-month${oldest ? ` · ${analystMonths(oldest, newest)}` : ''}`, lo: Math.min(...tp), mid: brokerAvg, hi: Math.max(...tp), color: RX.grey, midLabel: 'mean' });
    }
    if (yr.length) rows.push({ label: sinceListing ? 'Range since listing' : '52-week range', note: `${SHARE_DATA.ticker} closes`, lo: Math.min(...yr), mid: cmp, hi: Math.max(...yr), color: RX.light, midLabel: 'CMP' });
    const vals = rows.filter(r => !r.na).flatMap(r => [r.lo, r.hi]).concat(cmp != null ? [cmp] : []).filter(x => x != null && isFinite(x));
    const nr = niceRange(Math.min(...vals) * 0.97, Math.max(...vals) * 1.03, 6);
    const pos = x => ((Math.max(nr.lo, Math.min(nr.hi, x)) - nr.lo) / (nr.hi - nr.lo) * 100).toFixed(2);
    const cmpLine = cmp != null ? `<div class="rx-ff-cmp" style="left:${pos(cmp)}%" title="CMP ${rxRupee(cmp)}"></div>` : '';
    const ticks = [];
    for (let t = nr.lo; t <= nr.hi + 1e-9; t += nr.step) ticks.push(t);
    q('ff').innerHTML = rows.map(r => `
      <div class="rx-ff-lab">${r.label}<span>${r.note}</span></div>
      <div class="rx-ff-trk">${r.na ? '<span class="rx-ff-na">not available</span>' : `
        <div class="rx-ff-bar" style="left:${pos(r.lo)}%;width:${Math.max(pos(r.hi) - pos(r.lo), 0.6).toFixed(2)}%;background:${r.color}" title="${r.label}: ${rxRupee(r.lo)} – ${rxRupee(r.hi)}"></div>
        ${r.mid != null ? `<div class="rx-ff-tick" style="left:${pos(r.mid)}%"></div>` : ''}`}${cmpLine}</div>
      <div class="rx-ff-val">${r.na ? '<span>—</span>' : `<strong>${rxRupee(r.lo)} – ${fmtNum(r.hi, 0)}</strong><span>${r.midLabel} ${rxRupee(r.mid)}</span>`}</div>`).join('') + `
      <div class="rx-ff-axis-pad"></div><div class="rx-ff-axis">${ticks.map(t => `<span style="left:${pos(t)}%">${rxRupee(t)}</span>`).join('')}</div><div class="rx-ff-axis-pad"></div>`;
    q('ffNote').innerHTML = `The model row follows “Targets as”. ${fv != null ? 'Regression and ratio rows use the published 45-session fit; see the Regression tab.' : ''} ${analysts.length && oldestAge > ANALYST_TARGET_STALE_DAYS ? `Analyst targets are raw 12-month figures and up to ${oldestAge} days old.` : ''}`;

    // Sensitivity: P/E rows × ADR columns around the base case
    const peStep = 5, adrStep = niceRange(0, base.adr * 0.2, 4).step;
    const pes = [-2, -1, 0, 1, 2].map(k => v.pe1 + k * peStep).filter(x => x > 0);
    const adrs = [-2, -1, 0, 1, 2].map(k => base.adr + k * adrStep).filter(x => x > 0);
    const shade = u => u == null ? '#F1F1EE' : u <= -0.15 ? '#E9B48C' : u <= -0.05 ? '#F5D9C4' : u < 0.05 ? '#F1F1EE' : u < 0.15 ? '#CBD8F4' : '#9DB4E8';
    q('sensMeta').textContent = `Target ${basisName}, ₹ · P/E × ADR (₹ Cr / session)`;
    q('sens').innerHTML = `<thead><tr><th scope="col">P/E · ADR</th>${adrs.map((a, j) => `<th scope="col">${fmtNum(a, adrStep < 1 ? 2 : 1)}${j === 2 ? '<br><span class="rx-foot">base</span>' : ''}</th>`).join('')}</tr></thead><tbody>${pes.map(pe => `<tr><th scope="row">${fmtNum(pe, 0)}×</th>${adrs.map((a, j) => {
      const r = valuationFromAdr(a, v, pe, cmp);
      const u = up(r);
      return `<td class="${pe === v.pe1 && j === 2 ? 'is-base' : ''}" style="background:${shade(u)}">${rxRupee(pick(r))}<small>${u == null ? '' : rxSignedPct(u, 0)}</small></td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
  }

  const save = debounce(() => saveValuationInputs(ex, v), 400);
  el.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const num = parseFloat(e.target.value);
    if (!isFinite(num)) return;
    v[key] = num;
    render();
    save();
  });
  el.addEventListener('change', e => { const key = e.target.dataset && e.target.dataset.key; if (key) e.target.value = v[key]; });
  q('reset').addEventListener('click', () => {
    Object.assign(v, defaults);
    if (v.src === 'mkt' && !ctx.mkt) v.src = 'proj';
    el.querySelectorAll('input[data-key]').forEach(i => { i.value = v[i.dataset.key]; });
    el.querySelectorAll('[data-rx-seg="src"] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === v.src)));
    try { localStorage.removeItem(valuationStorageKey(ex)); } catch (e) { /* storage blocked */ }
    render();
  });
  rxOnSeg(el, 'basis', b => { state.basis = b; render(); });
  rxOnSeg(el, 'src', s => { v.src = s; render(); save(); });

  // Triangulated target inputs (data-tkey, saved apart from the FY model's)
  const tsave = debounce(() => saveTriangulationInputs(ex, t), 400);
  el.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.tkey;
    if (!key) return;
    const num = parseFloat(e.target.value);
    if (!isFinite(num)) return;
    t[key] = num;
    render();
    tsave();
  });
  el.addEventListener('change', e => { const key = e.target.dataset && e.target.dataset.tkey; if (key) e.target.value = tShow(key); });
  // "Use the FY model's": copy its margin, P/E and other income into this block (saved like an edit)
  el.addEventListener('click', e => {
    if (!e.target.closest || !e.target.closest('[data-rx="triMatch"]')) return;
    triangulationVsFyModel(t, v).forEach(d => d.keys.forEach(k => { t[k] = v[k]; }));
    el.querySelectorAll('input[data-tkey]').forEach(i => { i.value = tShow(i.dataset.tkey); });
    render();
    tsave();
  });
  const triReset = q('triReset');
  if (triReset) triReset.addEventListener('click', () => {
    Object.assign(t, tDefaults);
    el.querySelectorAll('input[data-tkey]').forEach(i => { i.value = tShow(i.dataset.tkey); });
    try { localStorage.removeItem(triangulationStorageKey(ex)); } catch (e) { /* storage blocked */ }
    render();
  });
  render();
}
