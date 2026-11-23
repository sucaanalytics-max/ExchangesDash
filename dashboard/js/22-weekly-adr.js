// dashboard/js/22-weekly-adr.js — week-on-week ADR panel on Revenue Summary (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// WEEK-ON-WEEK ADR — NSE, BSE, MCX and Total on total revenue (NSE/BSE at today's rates, MCX source values),
// whatever the exchange switcher shows. Weeks are Monday-keyed (cpWeekStart).
// A holiday week is a complete week with fewer than 5 sessions. A week is
// complete when the exchange's data reaches its Friday or, given a reference
// calendar (NSE's trading dates) and today's date, when every weekday after the
// exchange's last session in it has passed with no NSE session (so a week whose
// Friday is a holiday is complete on Saturday, while a day BSE's file merely
// lags NSE's on is not a holiday). Other weeks are "in progress" and never
// normalised. NSE and BSE complete weeks whose session count is not 5 get a
// normalised 5-day week: the expiry pair (the week's expiry day from
// computeWeekExpiryDates, holiday-shifted, plus the session on the scheduled
// pre-expiry weekday, preExpiryDateSet, when it traded before the expiry) at its
// own revenue, and every other day at the average of the week's non-pair sessions:
//   norm.total = pairRev + nonPairAvg × (5 − pair sessions),  norm.avg = norm.total / 5
// A missing pre-expiry day is filled at the non-pair average, which slightly
// understates it. MCX has no weekly expiry pattern and is never normalised.
// ========================

// Exchanges in the panel, in column order; those whose holiday weeks are normalised.
const WEEKLY_ADR_EXCHANGES = ['nse', 'bse', 'mcx'];
const WEEKLY_NORMALISED = new Set(['nse', 'bse']);

// An exchange's weeks, newest first: { week (Monday), sessions, total, avg,
// complete, holiday, missing (Mon–Fri dates with no session, holiday weeks
// only), pair (expiry pair dates, ascending; [] for MCX), norm ({ total, avg }
// or null) }. rows is the exchange's daily_all; modelled rows are dropped.
// ctx (optional): { today (IST 'YYYY-MM-DD'), refDates (NSE's trading dates, a
// Set or array) }; without it a week is complete only once the data reaches its Friday.
function weeklyAdrWeeks(rows, exchange, ctx = null) {
  const days = (rows || []).filter(r => r && r.date && !r.modelled)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!days.length) return [];
  const lastDate = days[days.length - 1].date;
  const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const expiryByWeek = new Map(computeWeekExpiryDates(days, exchange).map(e => [e.weekStart, e.expiryDate]));
  const preSet = preExpiryDateSet(days, exchange);
  const today = ctx && ctx.today;
  const ref = ctx && ctx.refDates ? (ctx.refDates instanceof Set ? ctx.refDates : new Set(ctx.refDates)) : null;
  // Every weekday after `after` up to `fri` has passed (before today) with no NSE session
  const restWereHolidays = (after, fri) => {
    if (!today || !ref) return false;
    for (let d = addDays(after, 1); d <= fri; d = addDays(d, 1)) {
      const wd = new Date(d + 'T00:00:00Z').getUTCDay();
      if (wd === 0 || wd === 6) continue;
      if (!(today > d) || ref.has(d)) return false;
    }
    return true;
  };
  // The week's scheduled expiry date (rule in force that week), or null
  const scheduled = week => {
    for (let i = 4; i >= 0; i--) if (isScheduledExpiry(exchange, addDays(week, i))) return addDays(week, i);
    return null;
  };
  const byWeek = new Map();
  days.forEach(r => {
    const w = cpWeekStart(r.date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  });
  const rev = r => Number(r.total_rev) || 0;
  return [...byWeek.keys()].sort().reverse().map(week => {
    const ds = byWeek.get(week);
    const total = ds.reduce((s, r) => s + rev(r), 0);
    const sessions = ds.length;
    const fri = addDays(week, 4);
    const complete = fri <= lastDate || restWereHolidays(ds[ds.length - 1].date, fri);
    const holiday = complete && sessions < 5;
    const dates = new Set(ds.map(r => r.date));
    const missing = holiday ? [0, 1, 2, 3, 4].map(i => addDays(week, i)).filter(d => !dates.has(d)) : [];
    // computeWeekExpiryDates leaves out a week whose scheduled expiry is after the
    // last data date; once such a week is complete (the rest were holidays) its
    // expiry is the last session on or before the scheduled day
    let expiry = expiryByWeek.get(week);
    if (!expiry && complete && WEEKLY_NORMALISED.has(exchange)) {
      const target = scheduled(week);
      const on = target ? ds.filter(r => r.date <= target) : [];
      if (on.length) expiry = on[on.length - 1].date;
    }
    // The pair: the scheduled pre-expiry session if it traded before the expiry, then the expiry
    const pair = [];
    if (expiry) {
      const pre = ds.find(r => preSet.has(r.date) && r.date < expiry);
      if (pre) pair.push(pre.date);
      pair.push(expiry);
    }
    let norm = null;
    if (WEEKLY_NORMALISED.has(exchange) && complete && sessions !== 5) {
      const nonPair = ds.filter(r => !pair.includes(r.date));
      if (nonPair.length) {
        const pairRev = ds.filter(r => pair.includes(r.date)).reduce((s, r) => s + rev(r), 0);
        const nonPairAvg = nonPair.reduce((s, r) => s + rev(r), 0) / nonPair.length;
        const t = pairRev + nonPairAvg * (5 - pair.length);
        norm = { total: t, avg: t / 5 };
      }
    }
    return { week, sessions, total, avg: total / sessions, complete, holiday, missing, pair, norm };
  });
}

// One cell: { avg, total, sessions, normalised }. Under 'normalised' a week with
// a normalised figure shows it (normalised: true); otherwise the actual week.
// null without a week.
function weeklyAdrCell(weekObj, mode) {
  if (!weekObj) return null;
  if (mode === 'normalised' && weekObj.norm) {
    return { avg: weekObj.norm.avg, total: weekObj.norm.total, sessions: weekObj.sessions, normalised: true };
  }
  return { avg: weekObj.avg, total: weekObj.total, sessions: weekObj.sessions, normalised: false };
}

// One panel row for `week` (a Monday): { cells: { nse, bse, mcx } (null where
// the exchange has no such week), total: { avg, total } (sums over the cells
// present; null when none), holiday: { ex: bool }, inProgress: { ex: bool } }.
// byEx holds each exchange's weeklyAdrWeeks.
function weeklyAdrRow(byEx, week, mode) {
  const cells = {}, holiday = {}, inProgress = {};
  WEEKLY_ADR_EXCHANGES.forEach(ex => {
    const w = ((byEx && byEx[ex]) || []).find(x => x.week === week) || null;
    cells[ex] = weeklyAdrCell(w, mode);
    holiday[ex] = !!(w && w.holiday);
    inProgress[ex] = !!(w && !w.complete);
  });
  const present = WEEKLY_ADR_EXCHANGES.map(ex => cells[ex]).filter(Boolean);
  const total = present.length
    ? { avg: present.reduce((s, c) => s + c.avg, 0), total: present.reduce((s, c) => s + c.total, 0) }
    : { avg: null, total: null };
  return { cells, total, holiday, inProgress };
}

// The week dropdown: every week any exchange has, newest first, as { week,
// label ("28 Sep – 2 Oct 2026 · 4 sessions": Monday to Friday, sessions NSE's
// else the first exchange's that has the week), flag ('holiday' when any
// exchange's week is one, else null) }.
function weeklyAdrOptions(byEx) {
  const parts = iso => [Number(iso.slice(8, 10)), MONTHS_SHORT[Number(iso.slice(5, 7)) - 1], iso.slice(0, 4)];
  const range = monday => {
    const fri = new Date(monday + 'T00:00:00Z');
    fri.setUTCDate(fri.getUTCDate() + 4);
    const [d1, m1, y1] = parts(monday), [d2, m2, y2] = parts(fri.toISOString().slice(0, 10));
    if (y1 !== y2) return `${d1} ${m1} ${y1} – ${d2} ${m2} ${y2}`;
    return m1 === m2 ? `${d1}–${d2} ${m2} ${y2}` : `${d1} ${m1} – ${d2} ${m2} ${y2}`;
  };
  const lookup = WEEKLY_ADR_EXCHANGES.map(ex => new Map(((byEx && byEx[ex]) || []).map(w => [w.week, w])));
  const weeks = new Set();
  lookup.forEach(m => m.forEach((_, k) => weeks.add(k)));
  return [...weeks].sort().reverse().map(week => {
    const found = lookup.map(m => m.get(week)).filter(Boolean);
    const n = found[0].sessions;
    return { week, label: `${range(week)} · ${n} session${n === 1 ? '' : 's'}`,
             flag: found.some(w => w.holiday) ? 'holiday' : null };
  });
}

// "holiday: Fri 2 Oct" (", "-joined when a week missed more than one weekday)
function weeklyAdrHolidayText(missing) {
  return `holiday: ${(missing || []).map(d => fmtTradeDate(d, true)).join(', ')}`;
}

// The panel's rows for the chosen weeks (row 1 first) under `mode`. Each is
// { week, holiday (any exchange's week is a holiday week), cells: { ex: null or
// { avg, total, sessions, normalised, alt, missing, inProgress, pct } }, total:
// { avg, total, alt, pct, excl (exchanges with no such week, left out of Total) } }. alt is the other mode's average where the week has
// a normalised figure: the normalised one under Actual, the actual one under
// Normalised (else null). pct (rows 2–3 only) is row 1's average against this
// row's, (row 1 − this) ÷ this, as in the month table above; null on row 1,
// when either side is missing, or when either side is in progress (a part week's
// average is driven by which days are in). Total's pct is null unless both
// rows' Totals are made of the same exchanges and neither holds an in-progress cell.
function weeklyAdrTable(byEx, weeks, mode) {
  const other = mode === 'normalised' ? 'actual' : 'normalised';
  const rows = weeks.map(week => {
    const r = weeklyAdrRow(byEx, week, mode);
    const cells = {};
    let anyNorm = false;
    WEEKLY_ADR_EXCHANGES.forEach(ex => {
      const c = r.cells[ex];
      if (!c) { cells[ex] = null; return; }
      const w = byEx[ex].find(x => x.week === week);
      if (w.norm) anyNorm = true;
      const alt = !w.norm ? null : mode === 'normalised' ? w.avg : w.norm.avg;
      cells[ex] = { ...c, alt, missing: w.missing, inProgress: r.inProgress[ex], pct: null };
    });
    return { week, cells, holiday: WEEKLY_ADR_EXCHANGES.some(ex => r.holiday[ex]),
             total: { ...r.total, alt: anyNorm ? weeklyAdrRow(byEx, week, other).total.avg : null, pct: null,
                      excl: WEEKLY_ADR_EXCHANGES.filter(ex => !cells[ex]) } };
  });
  const pct = (ref, cur) => (ref == null || cur == null || !cur ? null : (ref - cur) / cur);
  const wip = row => WEEKLY_ADR_EXCHANGES.some(ex => row.cells[ex] && row.cells[ex].inProgress);
  const first = rows[0];
  rows.slice(1).forEach(row => {
    WEEKLY_ADR_EXCHANGES.forEach(ex => {
      const a = first.cells[ex], c = row.cells[ex];
      if (c && !(a && a.inProgress) && !c.inProgress) c.pct = pct(a && a.avg, c.avg);
    });
    if (row.total.excl.join() === first.total.excl.join() && !wip(first) && !wip(row)) row.total.pct = pct(first.total.avg, row.total.avg);
  });
  return rows;
}

// ========================
// WEEK-ON-WEEK ADR PANEL — #weeklyAdrPanel, above the VIX panel below the
// Revenue Summary sub-tabs. The same in every exchange view: NSE, BSE and MCX
// are loaded whatever the switcher shows (loadCrossExchangeRows, 01-data.js, as
// for buildVixPanel), and the panel re-draws itself when the cached files move.
// ========================
const WEEKLY_ADR_MODE_KEY = 'weeklyAdrMode';
let weeklyAdrBuildSeq = 0;               // latest build; an older one still loading yields to it
let WEEKLY_ADR = null;                   // { byEx, opts, last } the panel was last drawn from
// The week chosen in each row; null = the default (weeklyAdrDefaultWeeks)
const weeklyAdrPicks = [null, null, null];

// The default weeks for rows 1–3: the latest complete week by NSE's weeks (else
// the first exchange with weeks) and the two options before it; the current,
// in-progress week stays in the dropdown. opts newest first (weeklyAdrOptions).
function weeklyAdrDefaultWeeks(byEx, opts) {
  if (!opts.length) return [];
  const ref = ['nse', ...WEEKLY_ADR_EXCHANGES].map(ex => (byEx && byEx[ex]) || []).find(ws => ws.length) || [];
  const done = ref.find(w => w.complete);
  const i = done ? Math.max(0, opts.findIndex(o => o.week === done.week)) : 0;
  return [0, 1, 2].map(k => (opts[i + k] || opts[opts.length - 1]).week);
}

let weeklyAdrModeCur = null;           // 'actual' | 'normalised'; read from sessionStorage on first use

function weeklyAdrMode() {
  if (weeklyAdrModeCur == null) {
    let saved = null;
    try { saved = sessionStorage.getItem(WEEKLY_ADR_MODE_KEY); } catch (e) { /* storage blocked: the default */ }
    weeklyAdrModeCur = saved === 'normalised' ? 'normalised' : 'actual';
  }
  return weeklyAdrModeCur;
}

function weeklyAdrSetMode(mode) {
  weeklyAdrModeCur = mode;
  try { sessionStorage.setItem(WEEKLY_ADR_MODE_KEY, mode); } catch (e) { /* storage blocked: kept for this page only */ }
}

// "Thursday to 31 Aug 2025, Tuesday from 1 Sep 2025", from EXPIRY_RULES
function weeklyAdrRulesText(exchange) {
  return EXPIRY_RULES.filter(r => r.exchange === exchange).map(r => r.weekday
    + (r.effective_from && r.effective_to ? ` ${rxDate(r.effective_from)} – ${rxDate(r.effective_to)}`
      : r.effective_to ? ` to ${rxDate(r.effective_to)}` : r.effective_from ? ` from ${rxDate(r.effective_from)}` : '')).join(', ');
}

function weeklyAdrCellHTML(c, mode, rowNum) {
  if (!c) return '<td class="wadr-c"><span class="wadr-v">—</span></td>';
  const lines = [`<span class="wadr-v${c.normalised ? ' wadr-v--norm' : ''}">${fmtNum(c.avg, 2)}</span>`,
    `<span class="wadr-s">₹${fmtNum(c.total, 1)} Cr${c.inProgress ? '' : ` · ${c.sessions} session${c.sessions === 1 ? '' : 's'}`}</span>`];
  if (c.alt != null) lines.push(`<span class="wadr-alt">${mode === 'normalised' ? 'actual' : 'normalised'} ${fmtNum(c.alt, 2)}</span>`);
  if (rowNum > 0) lines.push(`<span class="wadr-pct${c.pct == null ? '' : c.pct >= 0 ? ' rx-up' : ' rx-dn'}">${rxSignedPct(c.pct)}</span>`);
  if (c.inProgress) lines.push(rxChip(`in progress · ${c.sessions} session${c.sessions === 1 ? '' : 's'}`));
  if (c.missing && c.missing.length) lines.push(rxChip(escHtml(weeklyAdrHolidayText(c.missing)), 'warn'));
  return `<td class="wadr-c">${lines.join('')}</td>`;
}

function weeklyAdrTotalHTML(t, mode, rowNum) {
  if (t.avg == null) return '<td class="wadr-c wadr-tot"><span class="wadr-v">—</span></td>';
  const lines = [`<span class="wadr-v">${fmtNum(t.avg, 2)}</span>`, `<span class="wadr-s">₹${fmtNum(t.total, 1)} Cr</span>`];
  if (t.excl.length) lines.push(`<span class="wadr-excl" title="No such week in ${t.excl.map(e => e.toUpperCase()).join(' or ')}'s data: Total leaves it out, and its % change is shown only against a Total of the same exchanges">excl. ${t.excl.map(e => e.toUpperCase()).join(', ')}</span>`);
  if (t.alt != null) lines.push(`<span class="wadr-alt">${mode === 'normalised' ? 'actual' : 'normalised'} ${fmtNum(t.alt, 2)}</span>`);
  if (rowNum > 0) lines.push(`<span class="wadr-pct${t.pct == null ? '' : t.pct >= 0 ? ' rx-up' : ' rx-dn'}">${rxSignedPct(t.pct)}</span>`);
  return `<td class="wadr-c wadr-tot">${lines.join('')}</td>`;
}

// "Monday + Tuesday": the expiry pair's weekdays under the rule in force now
function weeklyAdrPairNow(exchange) {
  const rule = EXPIRY_RULES.find(r => r.exchange === exchange && r.effective_to === null);
  const i = rule ? EXPIRY_DOW_NAMES.indexOf(rule.weekday) : -1;
  return i > 1 ? `${EXPIRY_DOW_NAMES[i - 1]} + ${rule.weekday}` : rule ? rule.weekday : '—';
}

function weeklyAdrHowHTML() {
  return rxHow('How this is worked out', `<ul>
    <li><b>Weeks:</b> Monday to Sunday, from each exchange's daily rows; each cell is the average revenue per session that week (₹ Cr/day, total revenue at today's statutory rates for NSE and BSE; MCX as reported, fut + opt, source values not re-priced), with the week's revenue and session count below. Total adds the three exchanges' averages. Muhurat and DR-test sessions are not counted; full weekend sessions (Budget days) are.</li>
    <li><b>Holiday week:</b> a complete week with fewer than 5 sessions, shaded amber and with the missing weekdays named. A week is complete once that exchange's data reaches its Friday, or once every weekday after its last session that week has passed with no NSE session (a Friday holiday, say: the week is complete on Saturday). Until then it is "in progress" and never normalised, and its % change is left blank; BSE's file often runs a day behind NSE's, so its count can differ, and a day BSE lacks only because its file lags is not taken for a holiday. Row 1 defaults to the latest complete week; the current week stays in the dropdown.</li>
    <li><b>Expiry pair:</b> the week's weekly expiry day, moved to the previous session when it falls on a holiday, plus the session on the scheduled pre-expiry weekday (the expiry weekday's eve) when it traded before the expiry. A holiday on the pre-expiry day leaves the expiry alone in the pair (no other day takes its place), and when a holiday moved the expiry onto that day the pair is just the expiry. The expiry weekday follows the rule in force that week: NSE ${escHtml(weeklyAdrRulesText('nse'))}; BSE ${escHtml(weeklyAdrRulesText('bse'))}. Today that makes the pair NSE ${weeklyAdrPairNow('nse')} and BSE ${weeklyAdrPairNow('bse')}.</li>
    <li><b>Normalised:</b> NSE and BSE weeks with other than 5 sessions are rebuilt as a 5-day week: normalised total = expiry-pair revenue + (average of the week's other sessions) × (5 − pair sessions), and the normalised average is that total ÷ 5. With no session outside the pair there is no normalised figure. Under <i>Actual</i> the normalised figure is shown below the actual one; under <i>Normalised</i> it replaces it (and the % changes use it) and the actual figure is shown below.</li>
    <li><b>Limitation:</b> when the missing day is the pre-expiry day, it is filled at the average of the other sessions, which slightly understates it (pre-expiry days usually earn more).</li>
    <li><b>MCX:</b> never normalised. It has no weekly expiry pattern and trades on most exchange holidays, so its column is always the plain average.</li>
  </ul>`);
}

function renderWeeklyAdrPanel(el) {
  const { byEx, opts, last } = WEEKLY_ADR;
  const mode = weeklyAdrMode();
  const known = new Set(opts.map(o => o.week));
  const defaults = weeklyAdrDefaultWeeks(byEx, opts);
  const weeks = [0, 1, 2].map(r => (weeklyAdrPicks[r] && known.has(weeklyAdrPicks[r]) ? weeklyAdrPicks[r] : defaults[r]));
  const table = weeklyAdrTable(byEx, weeks, mode);
  const wip = new Set(WEEKLY_ADR_EXCHANGES.flatMap(ex => byEx[ex].filter(w => !w.complete).map(w => w.week)));
  const sel = (r, cur) => `<select class="xl-row-sel wadr-sel" data-wadr-row="${r}" aria-label="Week for row ${r + 1}">${opts.map(o =>
    `<option value="${o.week}"${o.week === cur ? ' selected' : ''}>${escHtml(o.label + (o.flag === 'holiday' ? ' · holiday' : '') + (wip.has(o.week) ? ' · in progress' : ''))}</option>`).join('')}</select>`;
  const body = table.map((row, r) => {
    const cls = [r === 0 ? 'wadr-ref' : '', row.holiday ? 'wadr-hol' : ''].filter(Boolean).join(' ');
    return `<tr${cls ? ` class="${cls}"` : ''}${row.holiday ? ' title="Holiday week: a complete week with fewer than 5 sessions"' : ''}>
      <td class="wadr-wk">${sel(r, row.week)}</td>
      ${WEEKLY_ADR_EXCHANGES.map(ex => weeklyAdrCellHTML(row.cells[ex], mode, r)).join('')}
      ${weeklyAdrTotalHTML(row.total, mode, r)}</tr>`;
  }).join('');
  const dates = WEEKLY_ADR_EXCHANGES.filter(ex => last[ex]);
  const newest = dates.map(ex => last[ex]).sort().pop();
  const behind = dates.filter(ex => last[ex] < newest);
  el.innerHTML = rxPanel({
    title: 'Week-on-week average daily revenue',
    meta: `₹ Cr per session · ${feeUnitLabelFor(WEEKLY_ADR_EXCHANGES)} · NSE, BSE, MCX and Total${newest ? ` · to ${escHtml(rxDate(newest))}` : ''}`,
    right: rxSeg('wadrMode', [['actual', 'Actual'], ['normalised', 'Normalised']], mode, 'Holiday weeks: actual or normalised'),
    body: `<div class="rx-scroll"><table class="rx-table wadr">
      <thead><tr><th>Week</th><th>NSE</th><th>BSE</th><th>MCX</th><th>Total</th></tr></thead>
      <tbody>${body}</tbody></table></div>`,
    foot: `Row 1 defaults to the latest complete week. Rows 2 and 3 show % change from that week to row 1's week, blank against a week in progress; a Total that leaves an exchange out (no such week in its data) has no % change unless row 1's leaves out the same. Amber: a holiday week (complete, fewer than 5 sessions). ${mode === 'normalised'
      ? 'NSE and BSE holiday weeks show their normalised 5-day average; MCX is never normalised.'
      : 'Actual averages; holiday weeks also show their normalised 5-day average (MCX is never normalised).'}${behind.length
      ? ` ${behind.map(ex => `${ex.toUpperCase()} to ${escHtml(rxDate(last[ex]))}`).join(', ')}.` : ''}`,
    how: weeklyAdrHowHTML(),
    attrs: 'id="weeklyAdrBox"',
  });
}

// weeklyAdrWeeks' ctx: today's IST date and NSE's trading dates as the reference
// calendar for holiday weeks (null without NSE's rows: weeks then complete only
// once the data reaches their Friday)
function weeklyAdrContext(nseRows, now = Date.now()) {
  if (!nseRows || !nseRows.length) return null;
  return { today: new Date(now + 330 * 60000).toISOString().slice(0, 10),
           refDates: new Set(nseRows.filter(r => r && r.date).map(r => r.date)) };
}

// Selects and the toggle re-render only this panel; wired once on the container
function weeklyAdrWire(el) {
  if (el.dataset.wadrWired) return;
  el.dataset.wadrWired = '1';
  el.addEventListener('change', e => {
    const s = e.target.closest('select[data-wadr-row]');
    if (!s || !WEEKLY_ADR) return;
    const r = Number(s.dataset.wadrRow);
    weeklyAdrPicks[r] = s.value;
    renderWeeklyAdrPanel(el);
    el.querySelector(`select[data-wadr-row="${r}"]`)?.focus();
  });
  el.addEventListener('click', e => {
    const b = e.target.closest('[data-rx-seg="wadrMode"] button[data-value]');
    if (!b || !WEEKLY_ADR || b.getAttribute('aria-pressed') === 'true') return;
    weeklyAdrSetMode(b.dataset.value);
    renderWeeklyAdrPanel(el);
    el.querySelector(`[data-rx-seg="wadrMode"] button[data-value="${b.dataset.value}"]`)?.focus();
  });
}

async function buildWeeklyAdrPanel() {
  const el = document.getElementById('weeklyAdrPanel');
  if (!el || isViewKey(currentExchange)) return;
  const seq = ++weeklyAdrBuildSeq;
  const title = 'Week-on-week average daily revenue';
  const { rowsByEx, sigs } = await loadCrossExchangeRows(WEEKLY_ADR_EXCHANGES, () => {
    if (!el.firstChild) el.innerHTML = rxPanel({ title, body: '<div class="rx-empty"><b>Loading NSE, BSE and MCX data…</b></div>' });
  });
  if (seq !== weeklyAdrBuildSeq) return;   // a later build took over while loading
  // Re-drawn on its own (not the whole view) when a cached file it used changes
  registerCrossPanel('weeklyAdr', sigs, buildWeeklyAdrPanel, 'weeklyAdrPanel');
  const ctx = weeklyAdrContext(rowsByEx.nse);
  const byEx = {}, last = {};
  WEEKLY_ADR_EXCHANGES.forEach(ex => {
    const rows = rowsByEx[ex] || [];
    byEx[ex] = weeklyAdrWeeks(rows, ex, ctx);
    last[ex] = rows.filter(r => r && r.date && !r.modelled).reduce((mx, r) => (r.date > mx ? r.date : mx), '') || null;
  });
  const opts = weeklyAdrOptions(byEx);
  if (!opts.length) {
    el.innerHTML = rxPanel({ title, body: '<div class="rx-empty"><b>Couldn\'t load NSE, BSE or MCX data</b>Try again in a moment.</div>' });
    WEEKLY_ADR = null;
    return;
  }
  WEEKLY_ADR = { byEx, opts, last };
  weeklyAdrWire(el);
  renderWeeklyAdrPanel(el);
}
