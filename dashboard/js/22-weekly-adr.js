// dashboard/js/22-weekly-adr.js — week-on-week ADR panel on Revenue Summary (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// WEEK-ON-WEEK ADR — NSE, BSE, MCX and Total on total revenue at today's rates,
// whatever the exchange switcher shows. Weeks are Monday-keyed (cpWeekStart).
// A holiday week is a complete week (its Friday on or before the exchange's last
// data date) with fewer than 5 sessions; the current week is "in progress" and
// never normalised. NSE and BSE complete weeks whose session count is not 5 get a
// normalised 5-day week: the expiry pair (the week's expiry day from
// computeWeekExpiryDates, holiday-shifted, plus the latest session before it in
// the same week) at its own revenue, and every other day at the average of the
// week's non-pair sessions:
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
function weeklyAdrWeeks(rows, exchange) {
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
    const complete = addDays(week, 4) <= lastDate;
    const holiday = complete && sessions < 5;
    const dates = new Set(ds.map(r => r.date));
    const missing = holiday ? [0, 1, 2, 3, 4].map(i => addDays(week, i)).filter(d => !dates.has(d)) : [];
    const expiry = expiryByWeek.get(week);
    const pair = [];
    if (expiry) {
      const before = ds.filter(r => r.date < expiry);
      if (before.length) pair.push(before[before.length - 1].date);
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
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const parts = iso => [Number(iso.slice(8, 10)), MON[Number(iso.slice(5, 7)) - 1], iso.slice(0, 4)];
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
