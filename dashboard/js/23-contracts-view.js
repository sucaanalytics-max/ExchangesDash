// dashboard/js/23-contracts-view.js — Revenue Summary in F&O contracts: the period aggregates it reads, rebuilt from daily_all.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// CONTRACTS VIEW — the same Revenue Summary page in average F&O contracts per
// day (crore of contracts) instead of ₹ Cr/day. Built in the browser from each
// exchange's daily_all, with contracts placed in the revenue fields, so the
// page renders unchanged from:
//   data:     the dashboard file's raw rows (quarterly / monthly / weekly /
//             daily / daily_all), as build_outputs writes them;
//   enriched: summary_total / seg_options / seg_futures, as seg_summary
//             (scripts/nse_pipeline.py, scripts/bse_pipeline.py) writes them.
// contractsSegSummary and contractsGroup mirror the pipelines exactly (labels,
// slices, fractions, rounding), checked against them by
// tests/test_contracts_view.py on a revenue fixture.
//
// Fields, all in crore of contracts:
//   NSE: options = io + so contracts, futures = if + sf, total = both;
//   BSE: options = total_contracts (BSE publishes one F&O contract count, its
//        few futures contracts included, so all of it counts as options),
//        futures = null, total = options.
// Rows without the exchange's contract figures (BSE before 2023-04-19) are
// left out, not counted as 0. Contracts are volumes, not fees: no fee-basis
// label travels with them.
// Contracts per ₹ 1 Cr of option premium (contractsRatio) is Σ contracts ÷
// Σ premium over a period's days, the Contracts to Premium tab's method.
// ========================

const CONTRACTS_PER_CRORE = 1e7;

// A finite number, or null (absent, null or not a number)
function contractsNum(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// Python's round(x, dp): the nearest decimal, ties (exact in binary, e.g.
// 0.125 at 2 dp) to even. toFixed rounds those ties away from zero.
function contractsRound(x, dp) {
  if (typeof x !== 'number' || !isFinite(x) || Math.abs(x) >= 1e21) return x;
  const exact = Math.abs(x).toFixed(100);   // the double's exact decimal digits
  const cut = exact.indexOf('.') + dp + 1;   // first dropped digit
  const tie = exact[cut] === '5' && /^0*$/.test(exact.slice(cut + 1));
  if (tie) {
    const kept = exact.slice(0, cut);
    const last = kept[kept.length - 1] === '.' ? kept[kept.length - 2] : kept[kept.length - 1];
    if (+last % 2 === 0) return (x < 0 ? -1 : 1) * Number(kept);
  }
  return Number(x.toFixed(dp));
}

// Python 3.12's sum() of floats (the pipelines' runtime): Neumaier-compensated
function contractsPySum(vals) {
  let s = 0, c = 0;
  for (const x of vals) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return c && isFinite(c) ? s + c : s;
}

// Monday of the row's week, 'YYYY-MM-DD' (the pipelines' week_label)
function contractsWeekLabel(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
}

// One exchange's daily rows in contracts. Each keeps its date labels and
// carries opt_contracts (count) and opt_premium (₹ Cr) for contractsRatio.
// Other exchanges (MCX) have no contracts view: [].
function contractsDailyRows(rows, exchange) {
  const out = [];
  (rows || []).forEach(r => {
    let opt, fut, premium;
    if (exchange === 'nse') {
      const c = ['io_contracts', 'so_contracts', 'if_contracts', 'sf_contracts'].map(k => contractsNum(r[k]));
      if (c.includes(null)) return;
      opt = c[0] + c[1];
      fut = c[2] + c[3];
      premium = (contractsNum(r.io_premium) || 0) + (contractsNum(r.so_premium) || 0);
    } else if (exchange === 'bse') {
      opt = contractsNum(r.total_contracts);
      fut = null;
      premium = contractsNum(r.options_premium_turnover) || 0;
    } else {
      return;
    }
    if (!(opt + (fut || 0) > 0)) return;   // no contract figures that day
    out.push({
      date: r.date, day: r.day, fy: r.fy, fy_quarter: r.fy_quarter, fy_month: r.fy_month,
      total_rev: (opt + (fut || 0)) / CONTRACTS_PER_CRORE,
      opt_rev: opt / CONTRACTS_PER_CRORE,
      fut_rev: fut == null ? null : fut / CONTRACTS_PER_CRORE,
      cash_rev: null,
      opt_contracts: opt,
      opt_premium: premium,
    });
  });
  // Every session's date (with or without contract counts), for placing expiries
  // (computeWeekExpiryDates, 10-revenue-summary.js): BSE's Friday expiries of 21 and
  // 28 Apr 2023 have no counts, and are expiries all the same, not holidays
  Object.defineProperty(out, 'tradingDates', { value: new Set((rows || []).map(r => r.date)) });
  return out;
}

// The pipelines' recompute_quarterly / recompute_monthly / recompute_weekly:
// one row per period in first-seen order, each field summed and rounded to
// `dp` (NSE's pipeline rounds to 2, BSE's to 4), with the day count. A field
// no row of the period has (BSE futures, cash) is null, not 0.
function contractsGroup(rows, keyOf, labelKey, dp = 4) {
  const fields = ['opt_rev', 'fut_rev', 'cash_rev', 'total_rev'];
  const groups = new Map();
  rows.forEach(r => {
    const key = keyOf(r);
    let g = groups.get(key);
    if (!g) {
      g = { row: { [labelKey]: key, opt_rev: 0, fut_rev: 0, cash_rev: 0, total_rev: 0, days: 0 }, seen: {} };
      groups.set(key, g);
    }
    fields.forEach(f => {
      if (r[f] != null) g.seen[f] = true;
      g.row[f] += +r[f] || 0;
    });
    g.row.days += 1;
  });
  return [...groups.values()].map(({ row, seen }) => {
    fields.forEach(f => { row[f] = seen[f] ? contractsRound(row[f], dp) : null; });
    return row;
  });
}

// The pipelines' seg_summary(daily_data, rev_key), line for line. `dp` is the
// rounding of its quarter and month sums (see contractsGroup).
function contractsSegSummary(rows, field, dp = 4) {
  const daily = rows || [];
  const r4 = x => contractsRound(x, 4);
  const val = d => +d[field] || 0;
  const sumOf = list => contractsPySum(list.map(val));
  const n = daily.length;

  const q = contractsGroup(daily, d => d.fy_quarter, 'quarter', dp);
  const cq = q.length ? q[q.length - 1] : null;
  const pq = q.length > 1 ? q[q.length - 2] : null;
  let yoyQ = null;
  if (cq) {
    const parts = String(cq.quarter).trim().split(/\s+/);
    const target = `${parts[0]} FY ${parseInt(parts[2], 10) - 1}`;
    yoyQ = q.find(x => x.quarter === target) || null;
  }
  const cqAvg = cq ? (+cq[field] || 0) / Math.max(cq.days, 1) : 0;
  const pqAvg = pq ? (+pq[field] || 0) / Math.max(pq.days, 1) : 0;
  const yoyAvg = yoyQ ? (+yoyQ[field] || 0) / Math.max(yoyQ.days, 1) : 0;
  const quarterly = {
    current:  { label: cq ? cq.quarter : '', value: r4(cqAvg),
                qoq: pqAvg ? r4((cqAvg - pqAvg) / pqAvg) : 0,
                yoy: yoyAvg ? r4((cqAvg - yoyAvg) / yoyAvg) : 0 },
    previous: { label: pq ? pq.quarter : '', value: r4(pqAvg) },
    prev2:    { label: yoyQ ? yoyQ.quarter : '', value: r4(yoyAvg) },
  };

  const m = contractsGroup(daily, d => d.fy_month, 'month', dp);
  const cm = m.length ? m[m.length - 1] : null;
  const pm = m.length > 1 ? m[m.length - 2] : null;
  const cmAvg = cm ? (+cm[field] || 0) / Math.max(cm.days, 1) : 0;
  const pmAvg = pm ? (+pm[field] || 0) / Math.max(pm.days, 1) : 0;
  const last125 = daily.slice(-125);
  const avg6m = sumOf(last125) / Math.max(last125.length, 1);
  const monthly = {
    current:  { label: cm ? cm.month : '', value: r4(cmAvg),
                mom: pmAvg ? r4((cmAvg - pmAvg) / pmAvg) : 0,
                mo6m: avg6m ? r4((cmAvg - avg6m) / avg6m) : 0 },
    previous: { label: pm ? pm.month : '', value: r4(pmAvg) },
    avg_6m:   { label: 'Avg Of Last 6 Months', value: r4(avg6m) },
  };

  const last5 = daily.slice(-5);
  const prev5 = n >= 10 ? daily.slice(-10, -5) : [];
  const last20 = daily.slice(-20);
  const last45 = daily.slice(-45);
  const l5Avg = sumOf(last5) / Math.max(last5.length, 1);
  const p5Avg = prev5.length ? sumOf(prev5) / Math.max(prev5.length, 1) : 0;
  const l20Avg = sumOf(last20) / Math.max(last20.length, 1);
  const l45Avg = sumOf(last45) / Math.max(last45.length, 1);
  const weekly = {
    last5:  { label: 'Last 5 Trading Days', value: r4(l5Avg),
              wow: p5Avg ? r4((l5Avg - p5Avg) / p5Avg) : 0,
              wo10w: l45Avg ? r4((l5Avg - l45Avg) / l45Avg) : 0 },
    prev5:  { label: 'Previous 5 Trading Days', value: r4(p5Avg) },
    last20: { label: 'Last 20 Trading Days', value: r4(l20Avg) },
    last45: { label: 'Last 45 Trading Days', value: r4(l45Avg) },
  };

  const pqLabel = pq ? pq.quarter : null;
  const cqLabel = cq ? cq.quarter : null;
  const yoyLabel = yoyQ ? yoyQ.quarter : null;
  const dayAvg = list => (list.length ? sumOf(list) / list.length : null);
  const dow = {}, prevWeek = {};
  WEEKDAYS.forEach(day => {
    const recs = daily.filter(d => d.day === day);
    const latest = recs.length ? val(recs[recs.length - 1]) : 0;
    const last3 = recs.slice(-3), last10 = recs.slice(-10);
    const avg3 = sumOf(last3) / Math.max(last3.length, 1);
    const avg10 = sumOf(last10) / Math.max(last10.length, 1);
    const pqDay = dayAvg(pqLabel ? recs.filter(d => d.fy_quarter === pqLabel) : []);
    const cqDay = dayAvg(cqLabel ? recs.filter(d => d.fy_quarter === cqLabel) : []);
    const yoyDay = dayAvg(yoyLabel ? recs.filter(d => d.fy_quarter === yoyLabel) : []);
    dow[day] = {
      latest: r4(latest),
      do3d: avg3 ? r4((latest - avg3) / avg3) : 0,
      do10d: avg10 ? r4((latest - avg10) / avg10) : 0,
      avg_3d: r4(avg3), avg_10d: r4(avg10),
      prev_q_label: pqLabel,
      prev_q_avg: pqDay != null ? r4(pqDay) : null,
      do_prev_q: pqDay ? r4((latest - pqDay) / pqDay) : null,
      cur_q_label: cqLabel,
      cur_q_avg: cqDay != null ? r4(cqDay) : null,
      yoy_q_label: yoyLabel,
      yoy_q_avg: yoyDay != null ? r4(yoyDay) : null,
      qoq: cqDay != null && pqDay ? r4((cqDay - pqDay) / pqDay) : null,
      yoy: cqDay != null && yoyDay ? r4((cqDay - yoyDay) / yoyDay) : null,
    };
    if (recs.length >= 2) prevWeek[day] = r4(val(recs[recs.length - 2]));
  });

  const fyGroups = new Map();
  daily.forEach(d => {
    const g = fyGroups.get(d.fy) || { sum: 0, count: 0 };
    g.sum += val(d);
    g.count += 1;
    fyGroups.set(d.fy, g);
  });
  const fyList = [...fyGroups.values()];
  const fyAvg = g => g.sum / Math.max(g.count, 1);
  const curFy = fyList.length ? fyAvg(fyList[fyList.length - 1]) : 0;
  const prevFy = fyList.length > 1 ? fyAvg(fyList[fyList.length - 2]) : 0;
  const fyYoy = prevFy ? (curFy - prevFy) / prevFy : 0;

  return {
    quarterly, monthly, weekly,
    day_of_week: dow,
    previous_week: prevWeek,
    fy: { current: r4(curFy), previous: r4(prevFy), yoy: r4(fyYoy) },
  };
}

// The dashboard file's raw rows (build_outputs / build_dashboard_json): every
// quarter and month, the last 15 weeks, the last 120 days and every day
function contractsAggregates(rows, dp = 4) {
  const daily_all = rows || [];
  return {
    quarterly: contractsGroup(daily_all, d => d.fy_quarter, 'quarter', dp),
    monthly:   contractsGroup(daily_all, d => d.fy_month, 'month', dp),
    weekly:    contractsGroup(daily_all, d => contractsWeekLabel(d.date), 'week', dp).slice(-15),
    daily:     daily_all.slice(-120),
    daily_all,
  };
}

// One exchange's contracts view from its dashboard data file. BSE has no
// futures (seg_futures null: its Futures figures show "—", never 0), and no
// exchange has cash in contracts (seg_cash null).
function contractsView(raw, exchange) {
  const rows = contractsDailyRows(raw && raw.daily_all, exchange);
  const seg = field => contractsSegSummary(rows, field);
  return {
    exchange,
    data: contractsAggregates(rows),
    enriched: {
      summary_total: seg('total_rev'),
      seg_options:   seg('opt_rev'),
      seg_futures:   exchange === 'nse' ? seg('fut_rev') : null,
      seg_cash:      null,
    },
  };
}

// The daily rows behind a view's contracts-per-premium ratio. One exchange:
// its own rows (in daily_all's order, so a trailing slice is the page's). A
// combined view: one row per date on which every exchange traded options
// (contracts and premium > 0 on each side), contracts and premium summed, as
// the Contracts to Premium tab joins them (contractsPremiumDaily). Cached per view.
const CONTRACTS_JOINED_ROWS = new WeakMap();

function contractsViewRows(view) {
  const data = (view && view.data) || {};
  if (!data.components) return data.daily_all || [];
  if (CONTRACTS_JOINED_ROWS.has(view)) return CONTRACTS_JOINED_ROWS.get(view);
  const traded = r => r.opt_contracts > 0 && r.opt_premium > 0;
  const byDate = data.components.map(c => new Map((c.daily_all || []).filter(traded).map(r => [r.date, r])));
  const rows = [...(byDate[0] || new Map()).keys()].sort()
    .filter(date => byDate.every(m => m.has(date)))
    .map(date => {
      const parts = byDate.map(m => m.get(date));
      const f = parts[0];
      return { date, day: f.day, fy: f.fy, fy_quarter: f.fy_quarter, fy_month: f.fy_month,
        opt_contracts: parts.reduce((a, r) => a + r.opt_contracts, 0),
        opt_premium: parts.reduce((a, r) => a + r.opt_premium, 0) };
    });
  CONTRACTS_JOINED_ROWS.set(view, rows);
  return rows;
}

// Contracts per ₹ 1 Cr of option premium over the rows passing `filter`:
// Σ opt_contracts ÷ Σ opt_premium, never a mean of daily ratios; null without
// premium. A day without premium (≤ 0) is left out entirely: its contracts
// alone would inflate the ratio.
function contractsRatio(rows, filter) {
  let contracts = 0, premium = 0;
  (rows || []).forEach(r => {
    if (filter && !filter(r)) return;
    if (!(r.opt_premium > 0)) return;
    contracts += r.opt_contracts || 0;
    premium += r.opt_premium;
  });
  return premium > 0 ? contracts / premium : null;
}

// NSE+BSE in contracts, built as the revenue NSE+BSE view is (combineRawData,
// combineEnrichedData in 01-data.js): period rows sum each exchange's own
// daily average (days = 1), FY / weekday × quarter / 125-day figures come from
// `components`, and an exchange without a period or segment adds nothing.
// Futures are NSE's alone (BSE's one contract count is all under Options), flagged by fut_note.
function contractsCombined(viewNse, viewBse) {
  const views = [viewNse, viewBse].filter(Boolean);
  const data = combineRawData(views.map(v => ({ exchange: v.exchange, raw: v.data })));
  data.fut_note = true;
  return {
    exchange: 'nsebse',
    data,
    enriched: combineEnrichedData(views.map(v => v.enriched)),
    fut_note: true,
  };
}

// ========================
// ₹ ADR | CONTRACTS TOGGLE — Revenue Summary's unit, in its sub-tab row.
// Shown in the NSE, BSE and NSE+BSE views; elsewhere (MCX, All, Brokers, MTF)
// it is hidden and the page renders revenue, while the stored choice is kept
// for the next NSE / BSE view. The choice lives in sessionStorage (every access
// guarded: blocked storage means ADR, and a switch still applies in memory).
// Contracts mode swaps only what the Revenue Summary renders from (RS_VIEW in
// 10-revenue-summary.js): DATA, rawFor, MARKET_RAW / MARKET_DATA and every
// other tab, the live cards and the banner stay in revenue.
// ========================
const CONTRACTS_VIEW_EXCHANGES = ['nse', 'bse', 'nsebse'];
const CONTRACTS_MODE_KEY = 'revSummaryUnit';
// mode: 'adr' | 'contracts' once read; cache: contracts views by exchange
const CONTRACTS_STATE = { mode: null, cache: {} };

function contractsStoredMode() {
  if (CONTRACTS_STATE.mode == null) {
    let stored = null;
    try { stored = sessionStorage.getItem(CONTRACTS_MODE_KEY); } catch (e) { /* storage blocked: ADR */ }
    CONTRACTS_STATE.mode = stored === 'contracts' ? 'contracts' : 'adr';
  }
  return CONTRACTS_STATE.mode;
}

// True when the Revenue Summary renders contracts: stored as Contracts, in an NSE / BSE view
function contractsModeActive() {
  return contractsStoredMode() === 'contracts' && CONTRACTS_VIEW_EXCHANGES.includes(currentExchange);
}

function setContractsMode(on) {
  CONTRACTS_STATE.mode = on ? 'contracts' : 'adr';
  try { sessionStorage.setItem(CONTRACTS_MODE_KEY, CONTRACTS_STATE.mode); } catch (e) { /* kept in memory */ }
  rebuildRevenueSummaryPage();
}

// The unit the Revenue Summary's labels use. ADR keeps the page's texts as
// they were: unit (segment headers), short ("Val (In Cr)"), noun ("Total
// Revenue"), wireDp (weekday tables' decimals) and amount (hover text).
const REV_UNITS = {
  adr: { key: 'adr', unit: '₹ Cr', short: 'In Cr', noun: 'Revenue', wireDp: 1, amount: v => `₹${fmtNum(v, 2)} Cr` },
  contracts: { key: 'contracts', unit: 'Cr contracts', short: 'Cr ctr', noun: 'Contracts', wireDp: 2,
    amount: v => `${fmtNum(v, 2)} Cr contracts` },
};

function revUnit() {
  return REV_UNITS[contractsModeActive() ? 'contracts' : 'adr'];
}

// One exchange's contracts view, cached per (exchange, data signature): the
// dashboard file behind it (rawFor) and that file's fingerprint, so toggling
// or redrawing reuses it until the data changes.
function contractsViewFor(ex) {
  const raw = rawFor(ex);
  if (!raw || !raw.daily_all) return null;
  const sig = VIEW_LOADED && VIEW_LOADED.exchange === ex && raw === DATA ? VIEW_LOADED.sig : marketSig(ex);
  const hit = CONTRACTS_STATE.cache[ex];
  if (hit && hit.raw === raw && hit.sig === sig) return hit.view;
  const view = contractsView(raw, ex);
  CONTRACTS_STATE.cache[ex] = { raw, sig, view };
  return view;
}

// What the Revenue Summary renders from in Contracts mode (null: revenue)
function contractsPageView() {
  if (!contractsModeActive()) return null;
  if (currentExchange !== 'nsebse') return contractsViewFor(currentExchange);
  const nseView = contractsViewFor('nse'), bseView = contractsViewFor('bse');
  if (!nseView || !bseView) return null;
  const hit = CONTRACTS_STATE.cache.nsebse;
  if (hit && hit.nse === nseView && hit.bse === bseView) return hit.view;
  const view = contractsCombined(nseView, bseView);
  CONTRACTS_STATE.cache.nsebse = { nse: nseView, bse: bseView, view };
  return view;
}

// The toggle (shown in NSE / BSE / NSE+BSE) and the Cash sub-tab (hidden in
// Contracts: F&O only; an open Cash tab falls back to Total). Every other
// sub-tab stays open across a switch.
function syncRevUnitControls() {
  const box = document.getElementById('revUnitToggle');
  const shown = CONTRACTS_VIEW_EXCHANGES.includes(currentExchange);
  const on = contractsModeActive();
  if (box) {
    // A switch redraws the buttons; keyboard focus moves to the pressed one
    const hadFocus = !!(box.contains && document.activeElement && box.contains(document.activeElement));
    box.hidden = !shown;
    box.innerHTML = shown ? rxSeg('revunit', [['adr', '₹ ADR'], ['contracts', 'Contracts']], on ? 'contracts' : 'adr',
      'Revenue Summary in average daily revenue or F&O contracts') : '';
    if (shown) rxOnSeg(box, 'revunit', v => setContractsMode(v === 'contracts'));
    const pressed = hadFocus && box.querySelector('button[aria-pressed="true"]');
    if (pressed) pressed.focus();
  }
  const tabs = document.getElementById('revSubTabs');
  const cash = tabs && tabs.querySelector('[data-subtab="rev-cash"]');
  if (!cash) return;
  cash.hidden = on;
  if (on && cash.classList.contains('active')) {
    const total = tabs.querySelector('[data-subtab="rev-total"]');
    if (total) total.click();
  }
}

// Redraws what the toggle changes: the Revenue Summary and, in NSE+BSE, the market-share panel
function rebuildRevenueSummaryPage() {
  const combined = COMBINED_VIEWS[currentExchange];
  runSections([buildRevenueSummary].concat(combined ? [() => buildMarketSharePanel(combined)] : []));
}
