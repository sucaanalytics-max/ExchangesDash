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

// Escapes text for HTML content and double-quoted attributes.
function escHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function fmtChartDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }).replace(' ', '-');
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
    updateFeeNotice();
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

  el.innerHTML = `<div class="rx">
    ${ex === 'mcx' ? rxAlert('<strong>Placeholder inputs.</strong> There is no MCX valuation baseline in this repo: PAT margin, other income and P/E multiples are round-number placeholders, so these targets are illustrative until you set them.') : ''}
    <section class="rx-kpis" aria-label="Valuation summary" data-rx="kpis"></section>
    ${rxPanel({ title: 'Valuation range by method', meta: '₹ per share · bars span the range, tick = base or centre',
      right: rxLegend([{ label: 'This model', color: RX.model }, { label: 'Market-based', color: RX.grey }, { label: cmp != null ? `CMP ${rxRupee(cmp)}` : 'CMP', color: RX.neg, kind: 'tick' }]),
      body: '<div class="rx-pb"><div class="rx-ff" data-rx="ff"></div></div>', foot: '<span data-rx="ffNote"></span>' })}
    <div class="rx-row">
      <section class="rx-panel rx-col-wide" aria-label="Assumptions">
        <div class="rx-ph"><h2>Assumptions</h2><span class="rx-meta">One model, three scenarios · saved in this browser</span>
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

  function render() {
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

    // KPIs
    const blendParts = [base.now, fv, brokerAvg != null ? brokerAvg / (1 + v.disc / 100) : null].filter(x => x != null && isFinite(x));
    const blend = blendParts.length ? blendParts.reduce((a, b) => a + b, 0) / blendParts.length : null;
    const range = yr.length ? `${sinceListing ? 'since listing' : '52-week'} ${rxRupee(Math.min(...yr))} – ${fmtNum(Math.max(...yr), 0)}` : cmpWhen;
    q('kpis').innerHTML = [
      rxKpi('CMP', cmp != null ? rxRupee(cmp) : '—', `${cmpWhen}${yr.length ? ' · ' + range : ''}`),
      rxKpi(`EPS ${fyE} · base`, rxRupee(base.eps, 2), `PAT ${rxCr(base.pat, 0)} on ${fmtNum(v.shares, 2)} Cr shares`),
      rxKpi('P/E at CMP', cmp && base.eps ? `${fmtNum(cmp / base.eps, 1)}×` : '—', `vs base multiple ${fmtNum(v.pe1, 0)}×`),
      rxKpi(`Base target · ${basisName}`, rxRupee(pick(base)), up(base) == null ? 'no CMP yet' : `${rxChangeHTML(up(base))} vs CMP`, { accent: true }),
      blendParts.length > 1
        ? rxKpi('Blended target · today', rxRupee(blend), cmp ? `${rxChangeHTML(blend / cmp - 1)} · avg of ${['model (today)', fv != null ? 'regression' : null, brokerAvg != null ? 'analysts (discounted)' : null].filter(Boolean).join(', ')}` : 'needs a CMP')
        : rxKpi('Blended target · today', '—', 'needs a regression fair value or analyst targets beside the model'),
    ].join('');

    // Football field
    const rows = [{ label: 'P/E × EPS', note: `this model · ${basisName}`, lo: pick(sc[0]), mid: pick(base), hi: pick(sc[2]), color: RX.model, midLabel: 'base' }];
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
  render();
}
