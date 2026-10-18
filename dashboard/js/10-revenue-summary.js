// dashboard/js/10-revenue-summary.js — Revenue Summary tab (incl. EXPIRY_RULES) and the market-share panel.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// REVENUE SUMMARY — SHARED
// ========================

function getRevFieldObj(segKey) {
  // Returns field names for quarterly and monthly data
  if (segKey === 'total') return { qField: 'total_rev', mField: 'total_rev', dField: 'total_rev' };
  if (segKey === 'options') return { qField: 'opt_rev', mField: 'opt_rev', dField: 'opt_rev' };
  if (segKey === 'futures') return { qField: 'fut_rev', mField: 'fut_rev', dField: 'fut_rev' };
  if (segKey === 'cash') return { qField: 'cash_rev', mField: 'cash_rev', dField: 'cash_rev' };
  return { qField: 'total_rev', mField: 'total_rev', dField: 'total_rev' };
}

function getYoYQuarter(qLabel) {
  const m = qLabel.match(/^(Q\d) FY (\d{4})$/);
  if (!m) return null;
  return m[1] + ' FY ' + (parseInt(m[2]) - 1);
}

// ── Expiry calendar (NSE & BSE only) ─────────────────────────────────────────
// Copy of EXPIRY_RULES in scripts/expiry_calendar.py, the source of truth (the
// circular behind each rule is noted there); scripts/check_expiry_calendar.py
// fails CI if the two drift. The weekly expiry falls on `weekday`, the monthly
// on the month's last `weekday`. Dates are inclusive, null = open-ended, and
// boundaries sit on Monday/Sunday so each Mon–Sun week has one expiry day.
const EXPIRY_RULES = [
  { exchange: 'nse', effective_from: null,         effective_to: '2025-08-31', weekday: 'Thursday' },
  { exchange: 'nse', effective_from: '2025-09-01', effective_to: null,         weekday: 'Tuesday' },
  { exchange: 'bse', effective_from: null,         effective_to: '2025-01-05', weekday: 'Friday' },
  { exchange: 'bse', effective_from: '2025-01-06', effective_to: '2025-08-31', weekday: 'Tuesday' },
  { exchange: 'bse', effective_from: '2025-09-01', effective_to: null,         weekday: 'Thursday' },
];
const EXPIRY_DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function expiryRuleFor(exchange, dateStr) {
  return EXPIRY_RULES.find(r => r.exchange === exchange
    && (r.effective_from === null || dateStr >= r.effective_from)
    && (r.effective_to === null || dateStr <= r.effective_to)) || null;
}

// True when dateStr ('YYYY-MM-DD') falls on the expiry weekday of the rule in
// force on that same date — so across a rule change each candidate day is
// judged by its own rule (e.g. NSE Aug 2025 → last Thursday, Sep → last Tuesday).
function isScheduledExpiry(exchange, dateStr) {
  const rule = expiryRuleFor(exchange, dateStr);
  return !!rule && EXPIRY_DOW_NAMES[new Date(dateStr + 'T00:00:00Z').getUTCDay()] === rule.weekday;
}

// Header wording for the month-end tables: "Tuesday" while one rule covers the
// data, otherwise the history, e.g. "expiry weekday (Thu → Tue from Sep 2025)".
function monthEndExpiryWeekdayLabel(exchange, dailyAll) {
  const first = dailyAll.reduce((mn, r) => (!mn || r.date < mn ? r.date : mn), '');
  const last = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const rules = EXPIRY_RULES.filter(r => r.exchange === exchange
    && (r.effective_to === null || r.effective_to >= first)
    && (r.effective_from === null || r.effective_from <= last));
  if (rules.length <= 1) return rules.length ? rules[0].weekday : 'expiry weekday';
  const mon = s => new Date(s + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const steps = rules.map((r, i) => i === 0 || !r.effective_from
    ? r.weekday.slice(0, 3)
    : `${r.weekday.slice(0, 3)} from ${mon(r.effective_from)}`);
  return `expiry weekday (${steps.join(' → ')})`;
}

// ── Month-end expiry comparison (NSE & BSE only) ──────────────────────────────
// Derived purely from observed trading dates in DATA.daily_all — no separate
// holiday calendar needed. Expiry = the calendar month's last scheduled expiry
// day per EXPIRY_RULES (last Tuesday for NSE since Sep 2025, last Thursday
// before; see the table for BSE); if that exact date isn't an actual trading
// day (holiday), walk back one calendar day at a time until landing on one that is.
function computeMonthExpiryDates(dailyAll, exchange) {
  const tradingDates = new Set(dailyAll.map(r => r.date));
  const monthsSet = new Set(dailyAll.map(r => r.date.slice(0, 7)));
  const lastDataDate = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const pad2 = n => String(n).padStart(2, '0');
  const toStr = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

  const results = [];
  monthsSet.forEach(monthKey => {
    const [y, m] = monthKey.split('-').map(Number);
    const lastDayNum = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last calendar day of month m
    const cursor = new Date(Date.UTC(y, m - 1, lastDayNum));
    // Latest day of the month that is a scheduled expiry under the rule in
    // force on that day. A month straddling a rule change therefore ends on
    // the new rule's last weekday if that falls on/after the change, else on
    // the old rule's (BSE Jan 2025: Friday rule to 5 Jan, then Tuesday → 28 Jan).
    while (cursor.getUTCDate() > 1 && !isScheduledExpiry(exchange, toStr(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!isScheduledExpiry(exchange, toStr(cursor))) return; // no rule covers this month

    // Expiry still in the future (e.g. this month's last Tuesday hasn't happened
    // yet): skip it. Otherwise the holiday walk-back below would misread the
    // missing date as a holiday and label an ordinary earlier day as the expiry.
    if (toStr(cursor) > lastDataDate) return;

    let dateStr = toStr(cursor);
    let guard = 10; // holidays cluster at most a few days; bail out rather than loop unbounded
    while (!tradingDates.has(dateStr) && guard-- > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      dateStr = toStr(cursor);
    }
    if (tradingDates.has(dateStr)) results.push({ monthKey, expiryDate: dateStr });
  });
  return results.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

// Same idea as computeMonthExpiryDates but scoped to each ISO week instead of
// each calendar month: that week's scheduled expiry day per EXPIRY_RULES
// (Tuesday NSE / Thursday BSE today), or the nearest earlier trading day if
// that's a holiday — bounded to not walk back past that week's own Monday (a
// holiday-shift never borrows from last week).
function computeWeekExpiryDates(dailyAll, exchange) {
  const tradingDates = new Set(dailyAll.map(r => r.date));
  const pad2 = n => String(n).padStart(2, '0');
  const toStr = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const parseUTC = s => new Date(s + 'T00:00:00Z');
  const mondayOf = d => {
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const m = new Date(d);
    m.setUTCDate(m.getUTCDate() + diff);
    return m;
  };

  const lastDataDate = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const weeksSet = new Set();
  dailyAll.forEach(r => weeksSet.add(toStr(mondayOf(parseUTC(r.date)))));

  const results = [];
  weeksSet.forEach(weekStartStr => {
    const monday = parseUTC(weekStartStr);
    // The week's scheduled expiry: the day (Mon–Fri) whose weekday matches the
    // rule in force on that day. Rule boundaries are Mondays, so exactly one
    // day qualifies; the latest is taken should a mid-week change ever qualify two.
    let target = null;
    for (let i = 4; i >= 0 && !target; i--) {
      const c = new Date(monday);
      c.setUTCDate(monday.getUTCDate() + i);
      if (isScheduledExpiry(exchange, toStr(c))) target = c;
    }
    if (!target) return;
    // Same future-expiry guard as computeMonthExpiryDates: this week's expiry
    // day may not have happened yet.
    if (toStr(target) > lastDataDate) return;
    const cursor = new Date(target);
    let dateStr = toStr(cursor);
    while (!tradingDates.has(dateStr) && cursor.getTime() >= monday.getTime()) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      dateStr = toStr(cursor);
    }
    if (tradingDates.has(dateStr) && cursor.getTime() >= monday.getTime()) {
      results.push({ weekStart: weekStartStr, expiryDate: dateStr });
    }
  });
  return results.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ── Month-end expiry lookups, by index into DATA.monthly/DATA.quarterly —
// mirrors getMAvg/getQAvg's indexing scheme so the dropdown rows can reuse
// the same mOpts/qOpts option lists and default-selection logic.
function getExpiryDateForMonthLabel(exchange, monthLabel, dailyAll) {
  const rec0 = dailyAll.find(r => r.fy_month === monthLabel);
  if (!rec0) return null;
  const monthKey = rec0.date.slice(0, 7);
  const match = computeMonthExpiryDates(dailyAll, exchange).find(e => e.monthKey === monthKey);
  return match ? match.expiryDate : null;
}

function getExpiryValueForMonthIdx(mIdx, exchange, segKey) {
  const m = DATA.monthly?.[mIdx];
  if (!m) return null;
  const dailyAll = DATA.daily_all || [];
  const expiryDate = getExpiryDateForMonthLabel(exchange, m.month, dailyAll);
  const rec = expiryDate ? dailyAll.find(r => r.date === expiryDate) : null;
  if (!rec) return null;
  const rf = getRevFieldObj(segKey);
  return { label: m.month, value: rec[rf.dField] || 0, flags: periodFlags(rec, segKey) };
}

function getExpiryValueForQuarterLabel(quarterLabel, exchange, segKey) {
  if (!quarterLabel) return null;
  const dailyAll = DATA.daily_all || [];
  const rf = getRevFieldObj(segKey);
  const byDate = new Map(dailyAll.map(r => [r.date, r]));
  const recs = computeMonthExpiryDates(dailyAll, exchange)
    .map(e => byDate.get(e.expiryDate))
    .filter(rec => rec && rec.fy_quarter === quarterLabel);
  const vals = recs.map(rec => rec[rf.dField] || 0);
  if (!vals.length) return null;
  return { label: quarterLabel, value: vals.reduce((s, v) => s + v, 0) / vals.length, flags: rowsFlags(recs, segKey) };
}

function getExpiryValueForQuarterIdx(qIdx, exchange, segKey) {
  const q = DATA.quarterly?.[qIdx];
  return q ? getExpiryValueForQuarterLabel(q.quarter, exchange, segKey) : null;
}

function renderExpiryMonthRow(rowNum, mIdx, exchange, segKey) {
  const cur   = getExpiryValueForMonthIdx(mIdx, exchange, segKey);
  const valEl = document.getElementById(`expiryMVal${rowNum}-${segKey}`);
  const chgEl = document.getElementById(`expiryMChg${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) + flagTags(cur.flags) : '—';
  if (chgEl) {
    // True calendar-adjacent previous month, independent of whatever the row above shows.
    const prev = getExpiryValueForMonthIdx(mIdx - 1, exchange, segKey);
    chgEl.innerHTML = (prev && prev.value && cur) ? wireChg((cur.value - prev.value) / prev.value) : '';
  }
}

function renderExpiryQuarterRow(rowNum, qIdx, exchange, segKey) {
  const cur   = getExpiryValueForQuarterIdx(qIdx, exchange, segKey);
  const q     = DATA.quarterly?.[qIdx];
  const valEl = document.getElementById(`expiryQVal${rowNum}-${segKey}`);
  const chgEl = document.getElementById(`expiryQChg${rowNum}-${segKey}`);
  const yoyEl = document.getElementById(`expiryQYoy${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) + flagTags(cur.flags) : '—';
  if (chgEl) {
    const prev = getExpiryValueForQuarterIdx(qIdx - 1, exchange, segKey);
    chgEl.innerHTML = (prev && prev.value && cur) ? wireChg((cur.value - prev.value) / prev.value) : '';
  }
  if (yoyEl) {
    const yoyLabel = q ? getYoYQuarter(q.quarter) : null;
    const yoyRef   = yoyLabel ? getExpiryValueForQuarterLabel(yoyLabel, exchange, segKey) : null;
    yoyEl.innerHTML = (yoyRef && yoyRef.value && cur) ? wireChg((cur.value - yoyRef.value) / yoyRef.value) : '';
  }
}

function syncExpiryM(rowNum, mIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`expiryM${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== mIdx) sel.value = mIdx;
    renderExpiryMonthRow(rowNum, mIdx, currentExchange, sk);
  });
}

function syncExpiryQ(rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`expiryQ${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderExpiryQuarterRow(rowNum, qIdx, currentExchange, sk);
  });
}

function buildExpiryComparisonHTML(exchange, segKey, mOpts, qOpts) {
  const dailyAll = DATA.daily_all || [];
  if (!dailyAll.length) return '';

  const mkSel = (id, opts) => `<select class="xl-row-sel" id="${id}">${opts}</select>`;

  // 8 + 6 independently selectable rows — values/deltas populated after
  // render by wireExpiryDropdowns() (called from buildRevenueSummary), same
  // two-pass approach the FY/Quarter/Month table already uses.
  const monthRowsHTML = Array.from({ length: 8 }, (_, r) => `
    <tr>
      <td>${mkSel(`expiryM${r}-${segKey}`, mOpts)}</td>
      <td class="wire-value" id="expiryMVal${r}-${segKey}"></td>
      <td id="expiryMChg${r}-${segKey}"></td>
    </tr>`).join('');

  const quarterRowsHTML = Array.from({ length: 6 }, (_, r) => `
    <tr>
      <td>${mkSel(`expiryQ${r}-${segKey}`, qOpts)}</td>
      <td class="wire-value" id="expiryQVal${r}-${segKey}"></td>
      <td id="expiryQChg${r}-${segKey}"></td>
      <td id="expiryQYoy${r}-${segKey}"></td>
    </tr>`).join('');

  const expiryWeekday = monthEndExpiryWeekdayLabel(exchange, dailyAll);
  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Month-End Expiry Comparison <span class="xl-seg-unit">last trading day on/before the month's last ${expiryWeekday} · ₹ Cr</span></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:var(--space-3)">
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table expiry-month-table">
          <thead><tr><th>Month</th><th>Val (In Cr)</th><th>MoM</th></tr></thead>
          <tbody>${monthRowsHTML}</tbody>
        </table>
      </div>
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table expiry-quarter-table">
          <thead><tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr></thead>
          <tbody>${quarterRowsHTML}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// Isolates "is month-end special" from "is this just a normal weekly expiry":
// for each month, averages that month's OTHER weekly-expiry days (excluding
// the month-end one itself) and compares against the month-end figure.
function buildWeeklyVsMonthEndHTML(exchange, segKey) {
  const rf = getRevFieldObj(segKey);
  const dailyAll = DATA.daily_all || [];
  if (!dailyAll.length) return '';
  const byDate = new Map(dailyAll.map(r => [r.date, r]));

  const monthEndByKey = new Map(computeMonthExpiryDates(dailyAll, exchange).map(e => [e.monthKey, e.expiryDate]));

  const weeksByMonth = new Map();
  computeWeekExpiryDates(dailyAll, exchange).forEach(w => {
    const mk = w.expiryDate.slice(0, 7);
    if (!weeksByMonth.has(mk)) weeksByMonth.set(mk, []);
    weeksByMonth.get(mk).push(w.expiryDate);
  });

  const rows = [];
  weeksByMonth.forEach((weekDates, monthKey) => {
    const meDate = monthEndByKey.get(monthKey);
    const meRec  = meDate ? byDate.get(meDate) : null;
    if (!meRec) return;
    const otherRecs = weekDates
      .filter(d => d !== meDate)
      .map(d => byDate.get(d))
      .filter(Boolean);
    const otherVals = otherRecs.map(r => r[rf.dField] || 0);
    if (!otherVals.length) return; // month had no other weekly expiry to compare against
    const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
    const monthEndVal = meRec[rf.dField] || 0;
    const diff = avgWeekly ? (monthEndVal - avgWeekly) / avgWeekly : null;
    rows.push({ monthKey, fy_month: meRec.fy_month, avgWeekly, monthEndVal, diff,
      weeklyFlags: rowsFlags(otherRecs, segKey), monthEndFlags: periodFlags(meRec, segKey) });
  });
  rows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  if (!rows.length) return '';

  const recent = rows.slice(-12);
  const rowsHTML = recent.map(r => `
    <tr>
      <td>${r.fy_month}</td>
      <td class="wire-value">${wireVal(r.avgWeekly, 2)}${flagTags(r.weeklyFlags)}</td>
      <td class="wire-value">${wireVal(r.monthEndVal, 2)}${flagTags(r.monthEndFlags)}</td>
      ${wireDeltaTd(r.diff)}
    </tr>`).join('');

  // Summary rows: avg of each column over the trailing N months, drawn from the
  // full `rows` history (not just the 12 displayed above) so "Last 3/6 Months"
  // stay correct even if the table's own window were ever narrowed.
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const summaryHTML = [3, 6, 12].map(n => {
    const window = rows.slice(-n);
    const avgWeekly = avg(window.map(r => r.avgWeekly));
    const avgMonthEnd = avg(window.map(r => r.monthEndVal));
    const diff = avgWeekly ? (avgMonthEnd - avgWeekly) / avgWeekly : null;
    return `
    <tr class="xl-r-cur">
      <td>Last ${n} Months Avg</td>
      <td class="wire-value">${wireVal(avgWeekly, 2)}${flagTags(mergeFlags(window.map(r => r.weeklyFlags)))}</td>
      <td class="wire-value">${wireVal(avgMonthEnd, 2)}${flagTags(mergeFlags(window.map(r => r.monthEndFlags)))}</td>
      ${wireDeltaTd(diff)}
    </tr>`;
  }).join('');

  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Weekly vs Month-End Expiry <span class="xl-seg-unit">avg of that month's other weekly expiries vs the month-end one · ₹ Cr</span></div>
    <div class="wire-table-scroll" style="margin-top:var(--space-3)">
      <table class="wire-table wvm-table">
        <thead><tr><th>Month</th><th>Avg Weekly Expiry</th><th>Month-End Expiry</th><th>Difference</th></tr></thead>
        <tbody>${rowsHTML}${summaryHTML}</tbody>
      </table>
    </div>
  </div>`;
}

function computeQuarterMetrics(qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const allQ = DATA.quarterly;
  const sel = allQ[qIdx];
  const days = sel.days || sel.trading_days || 1;
  const selAvg = sel[rf.qField] / days;
  const prev = qIdx > 0 ? allQ[qIdx - 1] : null;
  const prevDays = prev ? (prev.days || prev.trading_days || 1) : 1;
  const prevAvg = prev ? prev[rf.qField] / prevDays : null;
  const qoq = prevAvg ? (selAvg - prevAvg) / prevAvg : null;

  const yoyLabel = getYoYQuarter(sel.quarter);
  const yoyQ = yoyLabel ? allQ.find(q => q.quarter === yoyLabel) : null;
  const yoyDays = yoyQ ? (yoyQ.days || yoyQ.trading_days || 1) : 1;
  const yoyAvg = yoyQ ? yoyQ[rf.qField] / yoyDays : null;
  const yoy = yoyAvg ? (selAvg - yoyAvg) / yoyAvg : null;

  return {
    label: sel.quarter,
    value: selAvg,
    prevLabel: prev ? prev.quarter : '—',
    prevValue: prevAvg,
    qoq: qoq,
    yoyLabel: yoyLabel || '—',
    yoyValue: yoyAvg,
    yoy: yoy
  };
}

function computeMonthMetrics(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const allM = DATA.monthly;
  const sel = allM[mIdx];
  const days = sel.trading_days || sel.days || 1;
  const selAvg = sel[rf.mField] / days;
  const prev = mIdx > 0 ? allM[mIdx - 1] : null;
  const prevDays = prev ? (prev.trading_days || prev.days || 1) : 1;
  const prevAvg = prev ? prev[rf.mField] / prevDays : null;
  const mom = prevAvg ? (selAvg - prevAvg) / prevAvg : null;

  // 125 trading days (~6 months at ~21 trading days/month) of actual daily
  // rows ending at the selected month's last trading day — matches the
  // pipeline's avg_6m (see seg_summary in scripts/*_pipeline.py), not an
  // average of 6 calendar-month buckets, so this agrees with the value
  // already rendered from the JSON when the dropdown lands on "now".
  const dailyAll = DATA.daily_all || [];
  const endIdx = dailyAll.reduce((last, r, i) => r.fy_month === sel.month ? i : last, -1);
  const window6m = endIdx >= 0 ? dailyAll.slice(Math.max(0, endIdx - 124), endIdx + 1) : [];
  const avg6m = window6m.length ? window6m.reduce((s, r) => s + (r[rf.dField] || 0), 0) / window6m.length : null;
  const mo6m = avg6m ? (selAvg - avg6m) / avg6m : null;

  return {
    label: sel.month,
    value: selAvg,
    prevLabel: prev ? prev.month : '—',
    prevValue: prevAvg,
    mom: mom,
    avg6mValue: avg6m,
    mo6m: mo6m
  };
}

// ── Excel-style Revenue Summary ──────────────────────────────────────────────

function xlChg(val) {
  if (val == null || isNaN(val)) return '<span class="xl-chg xl-neu">—</span>';
  const abs = Math.abs(val * 100).toFixed(1);
  const sign = val > 0.0005 ? '+' : val < -0.0005 ? '−' : '';
  const cls  = val > 0.0005 ? 'xl-pos' : val < -0.0005 ? 'xl-neg' : 'xl-neu';
  return `<span class="xl-chg ${cls}">${sign}${abs} %</span>`;
}

function xlVal(v) {
  if (v == null || isNaN(v)) return '<span class="xl-num">—</span>';
  return `<span class="xl-num">${fmt(v)}</span>`;
}

// ── Wire-table formatters — exact match to the reference's bare-number style
// (no ₹/Cr, whole-number % deltas, no leading + sign) ─────────────────────────
function wireVal(v, decimals) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}

function xlValPlain(v, decimals) {
  if (v == null || isNaN(v)) return '<span class="xl-num">—</span>';
  return `<span class="xl-num">${wireVal(v, decimals)}</span>`;
}

function wireChg(val) {
  if (val == null || isNaN(val)) return '<span class="xl-chg xl-neu">—</span>';
  const pct = Math.round(val * 100);
  const cls = pct > 0 ? 'xl-pos' : pct < 0 ? 'xl-neg' : 'xl-neu';
  return `<span class="xl-chg ${cls}">${pct}%</span>`;
}

function wireDeltaTd(val) {
  if (val == null || isNaN(val)) return '<td></td>';
  const pct = Math.round(val * 100);
  const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
  return `<td class="wire-delta ${cls}">${pct}%</td>`;
}

// ── Per-exchange sources ──────────────────────────────────────────────────────
// A combined view's daily average for any period is the sum of each
// exchange's own daily average for it (that exchange's revenue ÷ its own
// trading days). Single-exchange views have one source, DATA itself, so the
// sum is just that exchange's figure. An exchange with no rows for the
// period adds nothing (e.g. MCX alone before NSE/BSE data starts in FY 2024).
function revenueSources() {
  return DATA.components || [{ quarterly: DATA.quarterly || [], monthly: DATA.monthly || [], daily_all: DATA.daily_all || [] }];
}

function sumOverSources(perSource) {
  const vals = revenueSources().map(perSource).filter(v => v != null);
  return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
}

// ── Fee-basis and modelled-history labels ─────────────────────────────────────
// Date-effective NSE/BSE rows and periods carry fee_basis / fee_basis_by_product
// (scripts/fee_register.py); MCX rows carry `modelled` and MCX periods
// `modelled_days`. A displayed value is flagged when any row behind it was
// priced at a slab-era flat estimate (slab) or a provisional calibrated BSE cash
// rate (prov), or is modelled MCX history (modelled). Values get an "est." or
// "modelled" marker; a % change with modelled days on either side is shown as
// "—". Files without these fields (today's rates, older pipeline output) carry
// no flags, so nothing is marked.
const SEG_PRODUCT = { options: 'opt', futures: 'fut', cash: 'cash' };
const NO_FLAGS = Object.freeze({ slab: false, prov: false, modelled: false });
const FEE_EST_TITLES = {
  slab: 'Slab-era estimate: transaction fees were tiered by volume slab before 1 Oct 2024 (NSE; BSE options from 1 Nov 2023), so this figure uses a flat estimate of the blended rate (fee register).',
  prov: "Provisional: BSE cash revenue here uses a calibrated rate from BSE's last four reported quarters; it is updated when BSE reports the quarter.",
};
const MCX_MODELLED_TITLE = 'MCX revenue before 2 Sep 2024 is modelled — scaled to reported quarters, options split derived';

// Flags of one daily row or aggregate period, for a segment ('total' = any product)
function periodFlags(item, segKey) {
  if (!item) return NO_FLAGS;
  const prod = SEG_PRODUCT[segKey];
  const byProd = item.fee_basis_by_product;
  const bases = byProd ? (prod ? [byProd[prod]] : Object.values(byProd)) : (item.fee_basis ? [item.fee_basis] : []);
  const slab = bases.includes('slab_estimate');
  const prov = bases.includes('calibrated_provisional');
  const modelled = item.modelled === true || item.modelled_days > 0;
  return slab || prov || modelled ? { slab, prov, modelled } : NO_FLAGS;
}

function mergeFlags(list) {
  const out = { slab: false, prov: false, modelled: false };
  list.forEach(f => { if (f) { out.slab = out.slab || f.slab; out.prov = out.prov || f.prov; out.modelled = out.modelled || f.modelled; } });
  return out;
}

function rowsFlags(rows, segKey) { return mergeFlags((rows || []).map(r => periodFlags(r, segKey))); }

// Over every exchange behind the view (one for single-exchange views)
function sourcesFlags(perSource) { return mergeFlags(revenueSources().map(perSource)); }

function quarterFlags(label, segKey) {
  return sourcesFlags(src => periodFlags(src.quarterly.find(q => q.quarter === label), segKey));
}

function monthFlags(label, segKey) {
  return sourcesFlags(src => {
    const m = (src.monthly || []).find(x => x.month === label);
    return m ? periodFlags(m, segKey) : rowsFlags(src.daily_all.filter(r => r.fy_month === label), segKey);
  });
}

function fyFlags(fyStr, segKey) {
  return sourcesFlags(src => mergeFlags(src.quarterly.filter(q => q.quarter.endsWith(fyStr)).map(q => periodFlags(q, segKey))));
}

// Rows of each exchange's daily series from `from` to `to` (slice indices)
function tailFlags(from, to, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.slice(from, to), segKey));
}

// The 125 trading days ending at a month's last trading day (as getM6mAvg)
function m6Flags(monthLabel, segKey) {
  return sourcesFlags(src => {
    const daily = src.daily_all;
    const endIdx = daily.reduce((last, r, i) => r.fy_month === monthLabel ? i : last, -1);
    return endIdx < 0 ? NO_FLAGS : rowsFlags(daily.slice(Math.max(0, endIdx - 124), endIdx + 1), segKey);
  });
}

// A weekday's last n occurrences, or all of them within one quarter
function weekdayFlags(weekday, n, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.filter(r => r.day === weekday).slice(-n), segKey));
}

function weekdayQuarterFlags(weekday, qLabel, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.filter(r => r.day === weekday && r.fy_quarter === qLabel), segKey));
}

// "est." / "modelled" markers for a value with these flags ('' when none)
function flagTags(f) {
  if (!f) return '';
  let html = '';
  if (f.slab || f.prov) {
    const title = [f.slab && FEE_EST_TITLES.slab, f.prov && FEE_EST_TITLES.prov].filter(Boolean).join(' ');
    html += `<span class="fee-est" title="${title}">est.</span>`;
  }
  if (f.modelled) html += `<span class="mcx-modelled" title="${MCX_MODELLED_TITLE}">modelled</span>`;
  return html;
}

// A % change between periods, one of which contains modelled MCX days, is not shown
const CMP_MODELLED_SPAN = `<span class="xl-chg xl-neu cmp-na" title="${MCX_MODELLED_TITLE}">—</span>`;
const CMP_MODELLED_TD = `<td class="wire-delta neutral cmp-na" title="${MCX_MODELLED_TITLE}">—</td>`;

function anyModelled(...flags) { return flags.some(f => f && f.modelled); }

// ── Simple avg getters (no derived comparisons) ───────────────────────────────
function getFYAvg(fyStr, segKey) {
  const rf = getRevFieldObj(segKey);
  const value = sumOverSources(src => {
    const quarters = src.quarterly.filter(q => q.quarter.endsWith(fyStr));
    if (!quarters.length) return null;
    const rev  = quarters.reduce((s, q) => s + (q[rf.qField] || 0), 0);
    const days = quarters.reduce((s, q) => s + (q.days || q.trading_days || 1), 0);
    return rev / days;
  });
  return value == null ? null : { label: fyStr, value };
}

function getQAvg(qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const q  = DATA.quarterly[qIdx];
  if (!q) return null;
  const days = q.days || q.trading_days || 1;
  return { label: q.quarter, value: q[rf.qField] / days };
}

function getMAvg(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const m  = DATA.monthly[mIdx];
  if (!m) return null;
  const days = m.trading_days || m.days || 1;
  return { label: m.month, value: m[rf.mField] / days };
}

// "Avg 6M (125 days)": average of the last 125 trading days ending at the
// month's last trading day — the pipelines' avg_6m (seg_summary in
// scripts/*_pipeline.py), so for the latest month it equals the enriched
// value. Not an average of six calendar-month averages, which would weight a
// partial month like a full one.
const AVG_6M_LABEL = 'Avg 6M (125 days)';

function getM6mAvg(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const m  = DATA.monthly[mIdx];
  if (!m) return null;
  return sumOverSources(src => {
    const daily  = src.daily_all;
    const endIdx = daily.reduce((last, r, i) => r.fy_month === m.month ? i : last, -1);
    if (endIdx < 0) return null;
    const window = daily.slice(Math.max(0, endIdx - 124), endIdx + 1);
    return window.reduce((s, r) => s + (r[rf.dField] || 0), 0) / window.length;
  });
}

// ── Per-row render functions ──────────────────────────────────────────────────
// % change shown on each comparison row = (row0 - rowN) / rowN
// i.e. "current period is X% vs this row"

function renderFYRow(rowNum, fyStr, segKey) {
  const cur   = getFYAvg(fyStr, segKey);
  const flags = fyFlags(fyStr, segKey);
  const valEl = document.getElementById('xlFYVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlFYChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const refFY = document.getElementById('xlFY0-' + segKey)?.value;
    const ref = getFYAvg(refFY, segKey);
    chgEl.innerHTML = anyModelled(flags, fyFlags(refFY, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderQRow(rowNum, qIdx, segKey) {
  const cur   = getQAvg(qIdx, segKey);
  const flags = cur ? quarterFlags(cur.label, segKey) : NO_FLAGS;
  const valEl = document.getElementById('xlQVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlQChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const ref = getQAvg(parseInt(document.getElementById('xlQ0-' + segKey)?.value), segKey);
    chgEl.innerHTML = anyModelled(flags, ref && quarterFlags(ref.label, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderMRow(rowNum, mIdx, segKey) {
  const cur   = getMAvg(mIdx, segKey);
  const flags = cur ? monthFlags(cur.label, segKey) : NO_FLAGS;
  const valEl = document.getElementById('xlMVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlMChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) {
      chgEl.innerHTML = '';
      // Recompute Avg 6M (125 days ending at row 0's month); its % chg is
      // row 0's month vs that average, like the pipelines' mo6m
      const avg = getM6mAvg(mIdx, segKey);
      const avgFlags = cur ? m6Flags(cur.label, segKey) : NO_FLAGS;
      const avgValEl = document.getElementById('xlMAvgVal-' + segKey);
      const avgChgEl = document.getElementById('xlMAvgChg-' + segKey);
      if (avgValEl) avgValEl.innerHTML = xlValPlain(avg, 2) + flagTags(avgFlags);
      if (avgChgEl) avgChgEl.innerHTML = anyModelled(flags, avgFlags) ? CMP_MODELLED_SPAN
        : wireChg(avg && cur ? (cur.value - avg) / avg : null);
      return;
    }
    const ref = getMAvg(parseInt(document.getElementById('xlM0-' + segKey)?.value), segKey);
    chgEl.innerHTML = anyModelled(flags, ref && monthFlags(ref.label, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

// ── Cross-segment sync functions ──────────────────────────────────────────────
const XL_SEGS = ['total', 'options', 'futures', 'cash'];

function syncXLFY(rowNum, fyStr) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlFY' + rowNum + '-' + sk);
    if (sel && sel.value !== fyStr) sel.value = fyStr;
    renderFYRow(rowNum, fyStr, sk);
    if (rowNum === 0) renderFYRow(1, document.getElementById('xlFY1-' + sk)?.value, sk);
  });
}

function syncXLQ(rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlQ' + rowNum + '-' + sk);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderQRow(rowNum, qIdx, sk);
    if (rowNum === 0) {
      [1, 2, 3].forEach(r => {
        const ri = parseInt(document.getElementById('xlQ' + r + '-' + sk)?.value);
        if (!isNaN(ri)) renderQRow(r, ri, sk);
      });
    }
  });
}

// ── Quarter wire-table (Day-of-Week × Quarter) — independently selectable
// per-weekday quarter rows. Unlike getQAvg (whole-quarter daily average from
// the pre-aggregated DATA.quarterly), this filters DATA.daily_all down to a
// single weekday within the chosen quarter, since no pre-aggregated
// per-weekday-per-quarter figure exists for arbitrary quarters (the pipeline
// only ever computed it for the fixed current/prev/YoY trio).
function getWeekdayQAvg(weekday, qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const q  = DATA.quarterly[qIdx];
  if (!q) return null;
  return sumOverSources(src => {
    const rows = src.daily_all.filter(r => r.day === weekday && r.fy_quarter === q.quarter);
    if (!rows.length) return null;
    return rows.reduce((s, r) => s + (r[rf.dField] || 0), 0) / rows.length;
  });
}

function renderWireQRow(weekday, rowNum, qIdx, segKey) {
  const valEl = document.getElementById(`wireQVal-${weekday}-${rowNum}-${segKey}`);
  const q = DATA.quarterly[qIdx];
  if (valEl) valEl.innerHTML = wireVal(getWeekdayQAvg(weekday, qIdx, segKey), 1)
    + (q ? flagTags(weekdayQuarterFlags(weekday, q.quarter, segKey)) : '');
}

function syncWireQ(weekday, rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`wireQ-${weekday}-${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderWireQRow(weekday, rowNum, qIdx, sk);
  });
}

function syncXLM(rowNum, mIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlM' + rowNum + '-' + sk);
    if (sel && parseInt(sel.value) !== mIdx) sel.value = mIdx;
    renderMRow(rowNum, mIdx, sk);
    if (rowNum === 0) {
      const r1 = parseInt(document.getElementById('xlM1-' + sk)?.value);
      if (!isNaN(r1)) renderMRow(1, r1, sk);
    }
  });
}

// ── Segment block template ────────────────────────────────────────────────────
function xlSegmentBlock(segData, label, segKey, fyOpts, qOpts, mOpts) {
  const s   = segData;
  const wl5 = s.weekly.last5;
  const wp5 = s.weekly.prev5;
  const w20 = s.weekly.last20 || {};
  const w50 = s.weekly.last45;
  const dow = s.day_of_week;
  const dayFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // "Last 5 Days" above is a naive trailing slice of the last 5 trading rows
  // (see seg_summary in scripts/nse_pipeline.py / bse_pipeline.py) — when a
  // holiday shifts that window back far enough, it can catch the same weekday
  // (e.g. BSE's Thursday expiry) twice, skewing the average. The center
  // "Week>>" wire-table already shows one "latest" value per weekday, so
  // averaging those 5 gives a like-for-like week (one of each weekday,
  // expiry day included exactly once) with no holiday distortion possible.
  const dowLatestAvg = dayFull.reduce((sum, d) => sum + ((dow[d] || {}).latest || 0), 0) / dayFull.length;

  // Fee-basis / modelled flags of the trailing windows behind each figure
  const fl5 = tailFlags(-5, undefined, segKey), flp5 = tailFlags(-10, -5, segKey);
  const fl20 = tailFlags(-20, undefined, segKey), fl45 = tailFlags(-45, undefined, segKey);
  const flDow = mergeFlags(dayFull.map(d => weekdayFlags(d, 1, segKey)));
  const chgOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_SPAN : wireChg(val);
  const tdOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_TD : wireDeltaTd(val);

  const wRows = [
    `<tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}${flagTags(fl5)}</td><td>${chgOrNA(wl5.wow, fl5, flp5)}</td><td>${chgOrNA(wl5.wo10w, fl45)}</td></tr>`,
    `<tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}${flagTags(flp5)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}${flagTags(fl20)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 45 Days</td><td>${xlValPlain(w50.value, 2)}${flagTags(fl45)}</td><td></td><td></td></tr>`,
    `<tr><td>Mon–Fri Avg (Latest)</td><td>${xlValPlain(dowLatestAvg, 2)}${flagTags(flDow)}</td><td></td><td></td></tr>`,
  ].join('');

  const wireDetailRow = (label, val, flags) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}${flagTags(flags)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const mkSel = (id, opts) => `<select class="xl-row-sel" id="${id}">${opts}</select>`;

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const f1 = weekdayFlags(d, 1, segKey), f3 = weekdayFlags(d, 3, segKey), f10 = weekdayFlags(d, 10, segKey);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(f1)}</td>
      ${tdOrNA(dd.do3d, f3)}
      ${tdOrNA(dd.do10d, f10)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d, f3)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d, f10)}`;
  }).join(wireSpacerRow);

  // Quarter wire-table: 3 independently selectable quarters per weekday
  // (was a fixed current/prev/YoY trio computed server-side — see
  // getWeekdayQAvg/renderWireQRow/syncWireQ for the client-side recompute).
  const wireQSelRow = (weekday, rowNum) => `
    <tr class="wire-detail">
      <td>${mkSel(`wireQ-${weekday}-${rowNum}-${segKey}`, qOpts)}</td>
      <td class="wire-value" id="wireQVal-${weekday}-${rowNum}-${segKey}"></td>
      <td></td><td></td>
    </tr>`;

  const qdowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const fq = label => label ? weekdayQuarterFlags(d, label, segKey) : NO_FLAGS;
    const fCur = fq(dd.cur_q_label);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(weekdayFlags(d, 1, segKey))}</td>
      ${tdOrNA(dd.qoq, fCur, fq(dd.prev_q_label))}
      ${tdOrNA(dd.yoy, fCur, fq(dd.yoy_q_label))}
    </tr>
    ${wireQSelRow(d, 0)}
    ${wireQSelRow(d, 1)}
    ${wireQSelRow(d, 2)}`;
  }).join(wireSpacerRow);

  // FY: 2 independently selectable rows
  const fyRows = [0, 1].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlFY' + r + '-' + segKey, fyOpts)}</td>
      <td id="xlFYVal${r}-${segKey}"></td>
      <td id="xlFYChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('');

  // Quarter: 4 independently selectable rows (current, prev1, prev2, same-Q last year)
  const qRows = [0, 1, 2, 3].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlQ' + r + '-' + segKey, qOpts)}</td>
      <td id="xlQVal${r}-${segKey}"></td>
      <td id="xlQChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('');

  // Month: 2 selectable rows + 1 Avg 6M (125 days) row
  const mRows = [0, 1].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlM' + r + '-' + segKey, mOpts)}</td>
      <td id="xlMVal${r}-${segKey}"></td>
      <td id="xlMChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('') + `
    <tr>
      <td style="color:var(--color-text-secondary);font-size:11.5px">${AVG_6M_LABEL}</td>
      <td id="xlMAvgVal-${segKey}"></td>
      <td id="xlMAvgChg-${segKey}"></td>
      <td></td>
    </tr>`;

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg · ${feeUnitLabel()}</span></div>
      <div class="xl-main-row">

        <table class="xl-period-table">
          <colgroup>
            <col class="xl-col-period">
            <col class="xl-col-val">
            <col class="xl-col-chg1">
            <col class="xl-col-chg2">
          </colgroup>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Financial Year</td><td>Total</td><td>% chg</td><td></td></tr>
            ${fyRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Quarter&gt;&gt;</td><td>Val (In Cr)</td><td>% chg</td><td></td></tr>
            ${qRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Month&gt;&gt;</td><td>Val (In Cr)</td><td>% chg</td><td></td></tr>
            ${mRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td title="Last 5 days vs the last 45 days">vs 45D</td></tr>
            ${wRows}
          </tbody>
        </table>

        <div class="wire-table-scroll">
        <table class="wire-table weekday-wire-table">
          <thead>
            <tr><th>Week&gt;&gt;</th><th>Val (In Cr)</th><th>Do 3D</th><th>Do 10D</th></tr>
          </thead>
          <tbody>${dowRows}</tbody>
        </table>
        </div>

        <div class="wire-table-scroll">
        <table class="wire-table quarter-wire-table">
          <thead>
            <tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr>
          </thead>
          <tbody>${qdowRows}</tbody>
        </table>
        </div>

      </div>

      ${(currentExchange === 'nse' || currentExchange === 'bse')
        ? buildExpiryComparisonHTML(currentExchange, segKey, mOpts, qOpts) + buildWeeklyVsMonthEndHTML(currentExchange, segKey)
        : ''}

    </div>`;
}

// ── Static segment block (pre-computed data — used by Market Overview) ────────
// segKey (optional) labels the figures from the view's own rows (revenueSources):
// fee-basis "est." / MCX "modelled" markers, and "—" for comparisons with modelled days.
function xlStaticSegmentBlock(st, label, segKey) {
  if (!st) return `<div class="xl-segment"><div class="xl-seg-header">${label} <span class="xl-seg-unit">— data not available</span></div></div>`;

  const fy  = st.fy || {};
  const q   = st.quarterly || {};
  const m   = st.monthly   || {};
  const wl5 = (st.weekly || {}).last5  || {};
  const wp5 = (st.weekly || {}).prev5  || {};
  const w20 = (st.weekly || {}).last20 || {};
  const w45 = (st.weekly || {}).last45 || {};
  const dow = st.day_of_week   || {};
  const dayFull  = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  // fy.current is the FY of the latest trading day (the current quarter's FY)
  // and fy.previous the FY before it, so label them FY N and FY N-1 — not by
  // the previous quarter's label, which is still FY N except in Q1.
  const curFYNum    = +((q.current?.label || m.current?.label || '').match(/FY (\d{4})/)?.[1] || 0);
  const curFYLabel  = curFYNum ? `FY ${curFYNum}`     : 'Current FY';
  const prevFYLabel = curFYNum ? `FY ${curFYNum - 1}` : 'Prev FY';

  const fl = segKey ? fn => fn() : () => NO_FLAGS;
  const byLabel = (fn, lbl) => fl(() => lbl ? fn(lbl, segKey) : NO_FLAGS);
  const chgOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_SPAN : wireChg(val);
  const tdOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_TD : wireDeltaTd(val);
  const fFY = byLabel(fyFlags, curFYNum && curFYLabel), fPFY = byLabel(fyFlags, curFYNum && prevFYLabel);
  const fQ = byLabel(quarterFlags, q.current?.label), fPQ = byLabel(quarterFlags, q.previous?.label), fQ2 = byLabel(quarterFlags, q.prev2?.label);
  const fM = byLabel(monthFlags, m.current?.label), fPM = byLabel(monthFlags, m.previous?.label), fM6 = byLabel(m6Flags, m.current?.label);
  const fl5 = fl(() => tailFlags(-5, undefined, segKey)), flp5 = fl(() => tailFlags(-10, -5, segKey));
  const fl20 = fl(() => tailFlags(-20, undefined, segKey)), fl45 = fl(() => tailFlags(-45, undefined, segKey));

  const fyRows = `
    <tr class="xl-r-cur"><td>${curFYLabel}</td><td>${xlValPlain(fy.current, 2)}${flagTags(fFY)}</td><td>${chgOrNA(fy.yoy, fFY, fPFY)}</td><td></td></tr>
    <tr><td>${prevFYLabel}</td><td>${xlValPlain(fy.previous, 2)}${flagTags(fPFY)}</td><td></td><td></td></tr>`;

  const qRows = [
    `<tr class="xl-r-cur"><td>${q.current?.label  || '—'}</td><td>${xlValPlain(q.current?.value, 2)}${flagTags(fQ)}</td><td>${chgOrNA(q.current?.qoq, fQ, fPQ)}</td><td></td></tr>`,
    `<tr><td>${q.previous?.label || '—'}</td><td>${xlValPlain(q.previous?.value, 2)}${flagTags(fPQ)}</td><td></td><td></td></tr>`,
    q.prev2 ? `<tr><td>${q.prev2.label}</td><td>${xlValPlain(q.prev2.value, 2)}${flagTags(fQ2)}</td><td></td><td></td></tr>` : '',
  ].join('');

  const mRows = `
    <tr class="xl-r-cur"><td>${m.current?.label  || '—'}</td><td>${xlValPlain(m.current?.value, 2)}${flagTags(fM)}</td><td>${chgOrNA(m.current?.mom, fM, fPM)}</td><td></td></tr>
    <tr><td>${m.previous?.label || '—'}</td><td>${xlValPlain(m.previous?.value, 2)}${flagTags(fPM)}</td><td></td><td></td></tr>
    <tr><td>${AVG_6M_LABEL}</td><td>${xlValPlain(m.avg_6m?.value, 2)}${flagTags(fM6)}</td><td>${chgOrNA(m.current?.mo6m, fM, fM6)}</td><td></td></tr>`;

  const wRows = `
    <tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}${flagTags(fl5)}</td><td>${chgOrNA(wl5.wow, fl5, flp5)}</td><td>${chgOrNA(wl5.wo10w, fl45)}</td></tr>
    <tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}${flagTags(flp5)}</td><td></td><td></td></tr>
    <tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}${flagTags(fl20)}</td><td></td><td></td></tr>
    <tr><td>Last 45 Days</td><td>${xlValPlain(w45.value, 2)}${flagTags(fl45)}</td><td></td><td></td></tr>`;

  const wireDetailRow = (label, val, flags) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}${flagTags(flags)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const f1 = fl(() => weekdayFlags(d, 1, segKey)), f3 = fl(() => weekdayFlags(d, 3, segKey)), f10 = fl(() => weekdayFlags(d, 10, segKey));
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(f1)}</td>
      ${tdOrNA(dd.do3d, f3)}
      ${tdOrNA(dd.do10d, f10)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d, f3)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d, f10)}`;
  }).join(wireSpacerRow);

  const qdowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const fq = lbl => fl(() => lbl ? weekdayQuarterFlags(d, lbl, segKey) : NO_FLAGS);
    const fCur = fq(dd.cur_q_label), fPrev = fq(dd.prev_q_label), fYoy = fq(dd.yoy_q_label);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(fl(() => weekdayFlags(d, 1, segKey)))}</td>
      ${tdOrNA(dd.qoq, fCur, fPrev)}
      ${tdOrNA(dd.yoy, fCur, fYoy)}
    </tr>
    ${wireDetailRow(dd.cur_q_label, dd.cur_q_avg, fCur)}
    ${wireDetailRow(dd.prev_q_label, dd.prev_q_avg, fPrev)}
    ${wireDetailRow(dd.yoy_q_label, dd.yoy_q_avg, fYoy)}`;
  }).join(wireSpacerRow);

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg${segKey ? ' · ' + feeUnitLabel() : ''}</span></div>
      <div class="xl-main-row">
        <table class="xl-period-table">
          <colgroup>
            <col class="xl-col-period">
            <col class="xl-col-val">
            <col class="xl-col-chg1">
            <col class="xl-col-chg2">
          </colgroup>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Financial Year</td><td>Total</td><td>YoY</td><td></td></tr>
            ${fyRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Quarter&gt;&gt;</td><td>Val (In Cr)</td><td>QoQ</td><td></td></tr>
            ${qRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Month&gt;&gt;</td><td>Val (In Cr)</td><td>MoM</td><td></td></tr>
            ${mRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td title="Last 5 days vs the last 45 days">vs 45D</td></tr>
            ${wRows}
          </tbody>
        </table>
        <div class="wire-table-scroll">
        <table class="wire-table weekday-wire-table">
          <thead>
            <tr><th>Week&gt;&gt;</th><th>Val (In Cr)</th><th>Do 3D</th><th>Do 10D</th></tr>
          </thead>
          <tbody>${dowRows}</tbody>
        </table>
        </div>
        <div class="wire-table-scroll">
        <table class="wire-table quarter-wire-table">
          <thead>
            <tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr>
          </thead>
          <tbody>${qdowRows}</tbody>
        </table>
        </div>
      </div>
    </div>`;
}

// ── Combine summary_total objects across exchanges by summing values ──────────
function combineMarketSummaries() {
  const sts = ['nse', 'bse', 'mcx'].map(ex => MARKET_DATA[ex]?.summary_total).filter(Boolean);
  if (!sts.length) return null;

  const sum  = (...vals) => vals.reduce((a, v) => a + (v || 0), 0);
  const chg  = (cur, prev) => prev ? (cur - prev) / prev : null;

  // FY
  const fyCur  = sum(...sts.map(s => s.fy?.current));
  const fyPrev = sum(...sts.map(s => s.fy?.previous));

  // Quarter
  const qCur   = sum(...sts.map(s => s.quarterly?.current?.value));
  const qPrev  = sum(...sts.map(s => s.quarterly?.previous?.value));
  const qPrev2 = sum(...sts.map(s => s.quarterly?.prev2?.value));
  // YoY: same-quarter prior year — use the label's preceding FY if present
  const qYoyLabel = sts[0]?.quarterly?.prev2?.label;
  const qYoyVal   = qPrev2;

  // Month
  const mCur   = sum(...sts.map(s => s.monthly?.current?.value));
  const mPrev  = sum(...sts.map(s => s.monthly?.previous?.value));
  const mAvg6m = sum(...sts.map(s => s.monthly?.avg_6m?.value));

  // Week
  const w5Val  = sum(...sts.map(s => s.weekly?.last5?.value));
  const wp5Val = sum(...sts.map(s => s.weekly?.prev5?.value));
  const w20Val = sum(...sts.map(s => s.weekly?.last20?.value));
  const w45Val = sum(...sts.map(s => s.weekly?.last45?.value));

  // DoW — sum each day
  const dayFull = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const dow = {};
  dayFull.forEach(d => {
    const latest    = sum(...sts.map(s => s.day_of_week?.[d]?.latest));
    const avg3d     = sum(...sts.map(s => s.day_of_week?.[d]?.avg_3d));
    const avg10d    = sum(...sts.map(s => s.day_of_week?.[d]?.avg_10d));
    const prevQAvgs = sts.map(s => s.day_of_week?.[d]?.prev_q_avg).filter(v => v != null);
    const prevQAvg  = prevQAvgs.length ? sum(...prevQAvgs) : null;
    const prevQLabel = sts.map(s => s.day_of_week?.[d]?.prev_q_label).find(Boolean);

    // Per-weekday quarter comparison (current / previous / same quarter last year)
    const curQAvgs = sts.map(s => s.day_of_week?.[d]?.cur_q_avg).filter(v => v != null);
    const curQAvg  = curQAvgs.length ? sum(...curQAvgs) : null;
    const curQLabel = sts.map(s => s.day_of_week?.[d]?.cur_q_label).find(Boolean);
    const yoyQAvgs = sts.map(s => s.day_of_week?.[d]?.yoy_q_avg).filter(v => v != null);
    const yoyQAvg  = yoyQAvgs.length ? sum(...yoyQAvgs) : null;
    const yoyQLabel = sts.map(s => s.day_of_week?.[d]?.yoy_q_label).find(Boolean);

    dow[d] = {
      latest,
      avg_3d:  avg3d,
      avg_10d: avg10d,
      do3d:    chg(latest, avg3d),
      do10d:   chg(latest, avg10d),
      prev_q_label: prevQLabel,
      prev_q_avg:   prevQAvg,
      do_prev_q:    prevQAvg ? chg(latest, prevQAvg) : null,
      cur_q_label: curQLabel,
      cur_q_avg:   curQAvg,
      yoy_q_label: yoyQLabel,
      yoy_q_avg:   yoyQAvg,
      qoq: (curQAvg != null && prevQAvg) ? chg(curQAvg, prevQAvg) : null,
      yoy: (curQAvg != null && yoyQAvg) ? chg(curQAvg, yoyQAvg) : null,
    };
  });

  // Previous week
  const pw = {};
  dayFull.forEach(d => {
    const v = sum(...sts.map(s => s.previous_week?.[d]));
    pw[d] = v || null;
  });

  // Use NSE labels as the reference for period labels
  const ref = sts[0];

  return {
    fy: {
      current:  fyCur,
      previous: fyPrev,
      yoy:      chg(fyCur, fyPrev),
    },
    quarterly: {
      current:  { label: ref.quarterly?.current?.label,  value: qCur,   qoq: chg(qCur, qPrev), yoy: chg(qCur, qYoyVal) },
      previous: { label: ref.quarterly?.previous?.label, value: qPrev  },
      prev2:    qYoyLabel ? { label: qYoyLabel,            value: qPrev2 } : null,
    },
    monthly: {
      current:  { label: ref.monthly?.current?.label,  value: mCur,  mom: chg(mCur, mPrev), mo6m: chg(mCur, mAvg6m) },
      previous: { label: ref.monthly?.previous?.label, value: mPrev  },
      avg_6m:   { label: ref.monthly?.avg_6m?.label,   value: mAvg6m },
    },
    weekly: {
      last5:  { value: w5Val,  wow:  chg(w5Val, wp5Val), wo10w: chg(w5Val, w45Val) },
      prev5:  { value: wp5Val },
      last20: { value: w20Val },
      last45: { value: w45Val },
    },
    day_of_week:   dow,
    previous_week: pw,
  };
}

// ── Market Overview — all 3 exchanges combined ────────────────────────────────
function buildOverview() {
  const el = document.getElementById('overviewContent');
  if (!el) return;

  const anyData = ['nse', 'bse', 'mcx'].some(ex => MARKET_DATA[ex]?.summary_total);
  if (!anyData) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Loading market data…</div>';
    return;
  }

  const combined = combineMarketSummaries();
  if (!combined) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Data not available</div>';
    return;
  }

  el.innerHTML = xlStaticSegmentBlock(combined, 'Total — NSE + BSE + MCX');
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function buildRevenueSummary() {
  const ed = ENRICHED_DATA;
  if (!ed || !ed.summary_total) return;
  if (!DATA.quarterly?.length || !DATA.monthly?.length) return;

  // Build option lists (no pre-selected — set via JS after render)
  const fySet = [];
  DATA.quarterly.forEach(q => {
    const m = q.quarter.match(/FY \d{4}/);
    if (m && !fySet.includes(m[0])) fySet.push(m[0]);
  });
  fySet.reverse(); // newest first
  const fyOpts = fySet.map(fy => `<option value="${fy}">${fy}</option>`).join('');

  const allQ  = DATA.quarterly;
  const nQ    = allQ.length;
  const qOpts = [...allQ].reverse().map((q, ri) => {
    const idx = nQ - 1 - ri;
    return `<option value="${idx}">${q.quarter}</option>`;
  }).join('');

  const allM  = DATA.monthly;
  const nM    = allM.length;
  const mOpts = [...allM].reverse().map((m, ri) => {
    const idx = nM - 1 - ri;
    return `<option value="${idx}">${m.month}</option>`;
  }).join('');

  // Inject last20 from daily data if pipeline hasn't computed it yet (e.g. NSE)
  const REV_KEYS = { total: 'total_rev', options: 'opt_rev', futures: 'fut_rev', cash: 'cash_rev' };
  const d20 = (DATA.daily || []).slice(-20);
  [
    { key: 'total',   data: ed.summary_total },
    { key: 'options', data: ed.seg_options   },
    { key: 'futures', data: ed.seg_futures   },
    { key: 'cash',    data: ed.seg_cash      },
  ].forEach(({ key, data }) => {
    if (data && data.weekly && !data.weekly.last20) {
      const rk = REV_KEYS[key];
      const avg = d20.length ? d20.reduce((s, r) => s + (r[rk] || 0), 0) / d20.length : 0;
      data.weekly.last20 = { label: 'Last 20 Trading Days', value: Math.round(avg * 10000) / 10000 };
    }
  });

  // Render each segment into its own sub-tab container
  [
    { key: 'total',   data: ed.summary_total, label: 'Total Revenue' },
    { key: 'options', data: ed.seg_options,   label: 'Options Revenue' },
    { key: 'futures', data: ed.seg_futures,   label: 'Futures Revenue' },
    { key: 'cash',    data: ed.seg_cash,      label: 'Cash Revenue' },
  ].forEach(({ key, data, label }) => {
    const el = document.getElementById('subtab-rev-' + key);
    if (!el) return;
    if (!data) { el.innerHTML = ''; return; }
    el.innerHTML = xlSegmentBlock(data, label, key, fyOpts, qOpts, mOpts);
  });

  // Default row values
  const defFY0 = fySet[0] || 'FY 2027';
  const defFY1 = fySet[1] || 'FY 2026';
  const defQ0  = nQ - 1;
  const defQ1  = Math.max(0, nQ - 2);
  const defQ2  = Math.max(0, nQ - 3);
  // Same Q number as current, one year earlier
  const curQNum = (allQ[defQ0]?.quarter || '').match(/^Q(\d)/)?.[1];
  let defQ3 = Math.max(0, nQ - 5);
  if (curQNum) {
    for (let i = defQ0 - 1; i >= 0; i--) {
      if (allQ[i].quarter.startsWith('Q' + curQNum + ' ')) { defQ3 = i; break; }
    }
  }
  const defM0 = nM - 1;
  const defM1 = Math.max(0, nM - 2);

  // Set select values then render data
  XL_SEGS.forEach(sk => {
    if (!document.getElementById('xlFY0-' + sk)) return;  // segment was skipped (null data)
    document.getElementById('xlFY0-' + sk).value = defFY0;
    document.getElementById('xlFY1-' + sk).value = defFY1;
    document.getElementById('xlQ0-'  + sk).value = defQ0;
    document.getElementById('xlQ1-'  + sk).value = defQ1;
    document.getElementById('xlQ2-'  + sk).value = defQ2;
    document.getElementById('xlQ3-'  + sk).value = defQ3;
    document.getElementById('xlM0-'  + sk).value = defM0;
    document.getElementById('xlM1-'  + sk).value = defM1;

    renderFYRow(0, defFY0, sk); renderFYRow(1, defFY1, sk);
    [defQ0, defQ1, defQ2, defQ3].forEach((qi, r) => renderQRow(r, qi, sk));
    renderMRow(0, defM0, sk); renderMRow(1, defM1, sk);

    // Quarter wire-table's 3 per-weekday selectable rows — same current/prev/
    // same-Q-last-year defaults the fixed trio used to show.
    const wireQDefaults = [defQ0, defQ1, defQ3];
    WEEKDAYS.forEach(d => {
      wireQDefaults.forEach((qi, r) => {
        const sel = document.getElementById(`wireQ-${d}-${r}-${sk}`);
        if (sel) sel.value = qi;
        renderWireQRow(d, r, qi, sk);
      });
    });

    // Wire event listeners
    [0, 1].forEach(r => {
      document.getElementById('xlFY' + r + '-' + sk).addEventListener('change', function() {
        syncXLFY(r, this.value);
      });
    });
    [0, 1, 2, 3].forEach(r => {
      document.getElementById('xlQ' + r + '-' + sk).addEventListener('change', function() {
        syncXLQ(r, parseInt(this.value));
      });
    });
    [0, 1].forEach(r => {
      document.getElementById('xlM' + r + '-' + sk).addEventListener('change', function() {
        syncXLM(r, parseInt(this.value));
      });
    });
    WEEKDAYS.forEach(d => {
      [0, 1, 2].forEach(r => {
        document.getElementById(`wireQ-${d}-${r}-${sk}`)?.addEventListener('change', function() {
          syncWireQ(d, r, parseInt(this.value));
        });
      });
    });

    // Month-End Expiry Comparison's 8 month rows + 6 quarter rows (NSE/BSE
    // only — buildExpiryComparisonHTML returns '' for MCX, so these ids
    // won't exist there and the optional-chained lookups below just no-op).
    if (currentExchange === 'nse' || currentExchange === 'bse') {
      const defaultExpiryMonthIdxs = Array.from({ length: 8 }, (_, i) => nM - 8 + i).filter(i => i >= 0);
      const defaultExpiryQuarterIdxs = Array.from({ length: 6 }, (_, i) => nQ - 6 + i).filter(i => i >= 0);
      defaultExpiryMonthIdxs.forEach((mi, r) => {
        const sel = document.getElementById(`expiryM${r}-${sk}`);
        if (!sel) return;
        sel.value = mi;
        renderExpiryMonthRow(r, mi, currentExchange, sk);
        sel.addEventListener('change', function() { syncExpiryM(r, parseInt(this.value)); });
      });
      defaultExpiryQuarterIdxs.forEach((qi, r) => {
        const sel = document.getElementById(`expiryQ${r}-${sk}`);
        if (!sel) return;
        sel.value = qi;
        renderExpiryQuarterRow(r, qi, currentExchange, sk);
        sel.addEventListener('change', function() { syncExpiryQ(r, parseInt(this.value)); });
      });
    }
  });
}

// ========================
// MARKET SHARE PANEL  (generalised — works for any set of exchanges)
// ========================

const MS_META = {
  nse: { label: 'NSE', color: '#2563eb', cls: 'ms-nse' },
  bse: { label: 'BSE', color: '#c0392b', cls: 'ms-bse' },
  mcx: { label: 'MCX', color: '#16a34a', cls: 'ms-mcx' },
};

// Map enriched segment key → raw quarterly/monthly revenue field
const MS_SEG_FIELD = {
  summary_total: 'total_rev',
  seg_options:   'opt_rev',
  seg_futures:   'fut_rev',
  seg_cash:      'cash_rev',
};

function buildMarketSharePanel(exList) {
  const el = document.getElementById('marketSharePanel');
  if (!el) return;

  for (const ex of exList) {
    if (!MARKET_DATA[ex] || !MARKET_RAW[ex]) { el.innerHTML = ''; return; }
  }

  // Use NSE as label reference (same quarters as the main revenue table dropdowns)
  const refEx  = exList.includes('nse') ? 'nse' : exList[0];
  const allQ   = MARKET_RAW[refEx].quarterly || [];
  const nQ     = allQ.length;

  const curQLabel   = allQ[nQ - 1]?.quarter || '';
  const prevQLabel  = allQ[nQ - 2]?.quarter || '';
  const prev2QLabel = allQ[nQ - 3]?.quarter || '';   // e.g. Q3 FY 2026
  const curQNum     = curQLabel.match(/^Q(\d)/)?.[1] || '';
  let   yoyQLabel   = '';
  for (let i = nQ - 2; i >= 0; i--) {
    if (allQ[i].quarter.startsWith('Q' + curQNum + ' ')) { yoyQLabel = allQ[i].quarter; break; }
  }
  const curFYLabel = curQLabel.match(/FY \d{4}/)?.[0] || '';

  // Daily avg for a specific quarter from raw data
  const qAvg = (ex, qLabel, segKey) => {
    if (!qLabel) return 0;
    const q = (MARKET_RAW[ex].quarterly || []).find(x => x.quarter === qLabel);
    if (!q) return 0;
    return (q[MS_SEG_FIELD[segKey]] || 0) / (q.days || q.trading_days || 1);
  };

  const pct  = (n, d) => d > 0 ? Math.round(n / d * 100) + ' %' : '—';
  const ed   = ex => MARKET_DATA[ex];

  // Fee-basis / modelled flags of each exchange's rows behind a period. A share
  // row with modelled MCX days on any side is not shown (not like for like).
  const SEG_OF_MS_KEY = { summary_total: 'total', seg_options: 'options', seg_futures: 'futures', seg_cash: 'cash' };
  const raw = ex => MARKET_RAW[ex];
  const qFlags = (label, sk) => mergeFlags(exList.map(ex => periodFlags((raw(ex).quarterly || []).find(x => x.quarter === label), sk)));
  const fyFlagsMS = (label, sk) => mergeFlags(exList.map(ex => mergeFlags((raw(ex).quarterly || []).filter(x => x.quarter.endsWith(label)).map(x => periodFlags(x, sk)))));
  const mFlags = (which, key, sk) => mergeFlags(exList.map(ex => {
    const lbl = ed(ex)[key]?.monthly?.[which]?.label;
    return periodFlags((raw(ex).monthly || []).find(x => x.month === lbl), sk);
  }));
  const tFlags = (from, to, sk) => mergeFlags(exList.map(ex => rowsFlags((raw(ex).daily_all || []).slice(from, to), sk)));

  const SEGS = [
    { label: 'Total',   key: 'summary_total' },
    { label: 'Options', key: 'seg_options'   },
    { label: 'Futures', key: 'seg_futures'   },
    { label: 'Cash',    key: 'seg_cash'      },
  ];

  const hdrCells = exList.map(ex =>
    `<th style="color:${MS_META[ex].color}">${MS_META[ex].label} %</th>`
  ).join('');

  const segHTML = SEGS.map(({ label: segLabel, key }) => {
    if (exList.some(ex => !ed(ex)[key])) return '';
    const refED = ed(refEx)[key];
    const sk = SEG_OF_MS_KEY[key];

    // Build period rows — quarterly from raw (correct per-exchange days), rest from enriched
    const periods = [
      ...(curFYLabel  ? [{ lbl: curFYLabel,   vals: exList.map(ex => ed(ex)[key]?.fy?.current         || 0), flags: fyFlagsMS(curFYLabel, sk) }] : []),
      ...(curQLabel   ? [{ lbl: curQLabel,    vals: exList.map(ex => qAvg(ex, curQLabel,   key)), cur: true, flags: qFlags(curQLabel, sk) }] : []),
      ...(prevQLabel  ? [{ lbl: prevQLabel,   vals: exList.map(ex => qAvg(ex, prevQLabel,  key)), flags: qFlags(prevQLabel, sk) }] : []),
      ...(prev2QLabel && prev2QLabel !== prevQLabel ? [{ lbl: prev2QLabel, vals: exList.map(ex => qAvg(ex, prev2QLabel, key)), flags: qFlags(prev2QLabel, sk) }] : []),
      ...(yoyQLabel && yoyQLabel !== prevQLabel && yoyQLabel !== prev2QLabel ? [{ lbl: yoyQLabel, vals: exList.map(ex => qAvg(ex, yoyQLabel, key)), flags: qFlags(yoyQLabel, sk) }] : []),
      { lbl: refED.monthly?.current?.label  || 'Cur Month',  vals: exList.map(ex => ed(ex)[key]?.monthly?.current?.value  || 0), flags: mFlags('current', key, sk) },
      { lbl: refED.monthly?.previous?.label || 'Prev Month', vals: exList.map(ex => ed(ex)[key]?.monthly?.previous?.value || 0), flags: mFlags('previous', key, sk) },
      { lbl: AVG_6M_LABEL,    vals: exList.map(ex => ed(ex)[key]?.monthly?.avg_6m?.value  || 0), flags: tFlags(-125, undefined, sk) },
      { lbl: 'Last 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.last5?.value    || 0), flags: tFlags(-5, undefined, sk) },
      { lbl: 'Prev 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.prev5?.value    || 0), flags: tFlags(-10, -5, sk) },
      { lbl: 'Last 45 Days',  vals: exList.map(ex => ed(ex)[key]?.weekly?.last45?.value   || 0), flags: tFlags(-45, undefined, sk) },
    ];

    const rows = periods.map(({ lbl, vals, cur, flags }) => {
      const total = vals.reduce((a, b) => a + b, 0);
      const na = anyModelled(flags);
      const cells = exList.map((ex, i) => na
        ? `<td><span class="ms-pct cmp-na" title="${MCX_MODELLED_TITLE}">—</span></td>`
        : `<td><span class="ms-pct ${MS_META[ex].cls}">${pct(vals[i], total)}</span></td>`
      ).join('');
      return `<tr${cur ? ' class="xl-r-cur"' : ''}><td>${lbl}${flagTags(flags)}</td>${cells}</tr>`;
    }).join('');

    return `<div class="ms-seg">
      <div class="ms-seg-label">${segLabel}</div>
      <table class="ms-table">
        <thead><tr class="xl-col-hdr"><th>Period</th>${hdrCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const title = exList.map(ex => MS_META[ex].label).join(' + ') + ' Market Share';
  el.innerHTML = `<div class="ms-panel">
    <div class="ms-header">${title} <span class="xl-seg-unit">% of combined daily avg rev · ${feeUnitLabel()}</span></div>
    <div class="ms-segs-row">${segHTML}</div>
  </div>`;
}

