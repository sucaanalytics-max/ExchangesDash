// dashboard/js/40-mtf.js — MTF mode: the exchanges' margin trading (MTF) books.
// Reads dashboard/data/mtf_daily.json and mtf_stocks_latest.json, which
// scripts/mtf_pipeline.py writes after each daily NSE / BSE run. Three views in
// the MTF pill (registerModeView('mtf', …), VIEW MODES in 00-core.js): NSE+BSE,
// NSE and BSE, each with the tabs in MTF_TABS. The pipeline publishes the
// figures; this file sums them into periods and lays them out.

const MTF_DAILY_URL = './data/mtf_daily.json';
const MTF_STOCKS_URL = './data/mtf_stocks_latest.json';
const MTF_BROKERS_URL = './data/mtf_brokers.json';
const MTF_MAX_AGE_MS = 15 * 60 * 1000;   // re-fetch the files when a view loads after this long
// When each exchange's file for a reporting day appears (the daily job's fetch times,
// Nov 2026: NSE's after 21:00 IST the next trading day; BSE's about 21:00 IST two
// trading days on, e.g. 3 Nov on 5 Nov, 6 Nov on 11 Nov after the 10 Nov holiday)
const MTF_PUBLISHED = {
  nse: 'NSE publishes a day’s file late at night (IST) on the next trading day',
  bse: 'BSE publishes a day’s file in the evening (IST) about two trading days after the day',
};
const MTF_PUBLISH_LAG = `${MTF_PUBLISHED.nse}; ${MTF_PUBLISHED.bse}.`;

// Sidebar tabs: label and NAV_ICONS key
const MTF_TABS = {
  summary: { label: 'Summary', icon: 'revenue' },
  book:    { label: 'MTF Book', icon: 'book' },
  periods: { label: 'By Quarter', icon: 'calendar' },
  flows:   { label: 'Flows', icon: 'prediction' },
  stocks:  { label: 'Top Securities', icon: 'list' },
  brokers: { label: 'Brokers', icon: 'briefcase' },
};

// The views: pill order, exchange series, and their tabs (BSE's flows stop at
// Sep 2025; there are none to combine; brokers' shares are of the NSE + BSE book)
const MTF_VIEW_DEFS = [
  { id: 'combined', name: 'NSE + BSE', pill: 'NSE+BSE', tabs: ['summary', 'book', 'periods', 'stocks', 'brokers'] },
  { id: 'nse', name: 'NSE', pill: 'NSE', tabs: ['summary', 'book', 'periods', 'flows', 'stocks'] },
  { id: 'bse', name: 'BSE', pill: 'BSE', tabs: ['summary', 'book', 'periods', 'flows', 'stocks'] },
];

// Dated notes on the exchanges' own series. kind 'break': the series changes
// level, source or reporting basis on that date, so a change measured across it
// compares different bases; 'excluded': the day is left out of the series.
// Every exchange's notes also apply to the combined view.
const MTF_NOTES = [
  { ex: 'bse', date: '2024-03-12', kind: 'break',
    text: 'BSE’s own series steps up 56 % between 7 Mar 2024 (₹1,712 Cr) and 12 Mar 2024 (₹2,675 Cr) and stays there; '
      + 'BSE’s 11 Mar 2024 file is partial (458 securities, ₹22 Cr) and left out.' },
  { ex: 'bse', date: '2025-10-01', kind: 'break',
    text: 'BSE’s book falls 33 % on 1 Oct 2025 (₹4,588 Cr on 30 Sep, ₹3,094 Cr on 1 Oct). The drop is BSE’s own: its old '
      + 'archive, whose last day is 1 Oct, falls the same way (to ₹3,126 Cr). From that day BSE publishes a new file, which has no fresh / '
      + 'liquidated flows and runs 0.05–0.7 % below an independent copy of BSE’s data (1 % below the archive on 1 Oct, the one day both exist).' },
  { ex: 'nse', date: '2025-10-01', kind: 'break',
    text: 'NSE’s book rises 7 % on 1 Oct 2025 (₹99,446 Cr on 30 Sep, ₹1,06,409 Cr on 1 Oct), with ₹10,389 Cr of fresh exposure '
      + 'against about ₹6,000 Cr on an ordinary day. From that day brokers report MTF to the exchanges on revised rules, which '
      + 'moved several of them to reporting their gross book, so part of the step is a change of basis, not new lending '
      + '(ICRA, “Securities Broking”, 24 Jun 2026: “revised MTF reporting led to the shifting of several brokers to gross reporting, '
      + 'resulting in some optical growth”).' },
  { ex: 'bse', date: '2025-10-20', kind: 'excluded',
    text: 'BSE’s 20 Oct 2025 file doubles the book (₹6,379 Cr against ₹3,199 and ₹3,194 Cr either side); the day is left out.' },
];

const MTF_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MTF_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// Summary: the "average of the last 6 months" is this many reporting days ending at the month's last day (the
// exchanges' Revenue Summary uses the same 125-day window, so a part-month weighs by its days, not as a whole month)
const MTF_AVG6M_DAYS = 125;

// The files (loaded once, re-fetched after MTF_MAX_AGE_MS), the view on show,
// and the toggles, which persist across views (sel: the Summary's quarter and month;
// sumRange: its share chart's range; bMetric: the Brokers chart's share / book)
// Brokers tab: bCmp, the comparison ('chg' the previous figure, 'yoy' a year earlier); bSort, the league
// table's order; bMetric / bScale, the small multiples' measure and y scale)
let MTF = { doc: null, stocks: null, brokers: null, at: 0, view: 'combined', range: '1y', sumRange: '1y', gran: 'quarter',
  bMetric: 'share', bCmp: 'chg', bSort: { key: 'share', dir: -1 }, bScale: 'own', sel: {}, built: {} };

// ═══════════════════════════════════════════════════════════════
// PURE HELPERS (tests/test_mtf_dashboard.py runs these in Node)
// ═══════════════════════════════════════════════════════════════

// Indian FY quarter of an ISO date, from the string (no Date: no time-zone shift)
function mtfQuarterOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return `Q${m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4} FY ${m >= 4 ? y + 1 : y}`;
}

// A period's label, running index (consecutive periods differ by 1) and calendar
// bounds; gran 'fy' (Indian FY, Apr–Mar), 'quarter' (Indian FY) or 'month'
function mtfPeriodOf(iso, gran) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const pad = n => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (gran === 'fy') {
    const fy = m >= 4 ? y + 1 : y;
    return { label: `FY ${fy}`, idx: fy, start: `${fy - 1}-04-01`, end: `${fy}-03-31` };
  }
  if (gran === 'month') {
    return { label: `${MTF_MONTHS[m - 1]} ${y}`, idx: y * 12 + m - 1,
      start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  }
  const label = mtfQuarterOf(iso);
  const q = +label[1], fy = +label.slice(-4);
  const sm = (q * 3 + 1) % 12 || 12, sy = q === 4 ? fy : fy - 1;   // Q1 Apr, Q2 Jul, Q3 Oct (fy - 1); Q4 Jan (fy)
  const em = sm + 2;
  return { label, idx: fy * 4 + q - 1, start: `${sy}-${pad(sm)}-01`, end: `${sy}-${pad(em)}-${pad(lastDay(sy, em))}` };
}

// Calendar days from ISO date `a` to `b`
function mtfDaysAfter(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }

// ISO date `n` months before `iso`, the day clamped to the month's length
function mtfMonthsBack(iso, n) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const idx = y * 12 + (m - 1) - n;
  const yy = Math.floor(idx / 12), mm = idx % 12 + 1;
  const dd = Math.min(d, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Points of a view, oldest first: { date, value (₹ Cr), securities, … }.
// NSE: the closing book; BSE: the amount financed; combined: their sum on dates
// both published (nse, bse parts). Spike days are left out (combined already
// leaves them out); days under `unavailable` never reach the series.
function mtfSeries(doc, view) {
  if (!doc) return [];
  const keep = r => !(r.flags || []).includes('spike');
  let pts;
  if (view === 'combined') {
    pts = (doc.combined || []).map(r => ({ date: r.date, value: r.total_cr, nse: r.nse_cr, bse: r.bse_cr }));
  } else if (view === 'nse') {
    pts = (doc.nse || []).filter(keep).map(r => ({ date: r.date, value: r.closing_cr, securities: r.securities,
      opening: r.opening_cr, fresh: r.fresh_cr, liquidated: r.liquidated_cr, revised: !!r.revised }));
  } else {
    pts = (doc.bse || []).filter(keep).map(r => ({ date: r.date, value: r.amount_financed_cr, securities: r.securities,
      opening: r.opening_cr, fresh: r.fresh_cr, liquidated: r.liquidated_cr, file: r.file }));
  }
  return pts.filter(p => p.value != null && isFinite(p.value)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// NSE + BSE ends on the last date both exchanges published, so it stops at the
// exchange that publishes later (BSE's file appears about two trading days after
// the day, NSE's on the next): the exchanges whose own series runs past it, as
// [{ ex, date }], NSE first; empty when neither does or there is no combined day.
function mtfAhead(doc) {
  const comb = mtfSeries(doc, 'combined');
  if (!comb.length) return [];
  const end = comb[comb.length - 1].date;
  return ['nse', 'bse'].map(ex => {
    const s = mtfSeries(doc, ex);
    return { ex, date: s.length ? s[s.length - 1].date : null };
  }).filter(a => a.date && a.date > end);
}

// "NSE to 9 Nov 2026" for the NSE + BSE view when an exchange runs past it, else ''
function mtfAheadText(doc, view) {
  if (view !== 'combined') return '';
  return mtfAhead(doc).map(a => `${a.ex.toUpperCase()} to ${rxDate(a.date)}`).join(', ');
}

// The last point on or before `iso`, or null
function mtfPointOnOrBefore(points, iso) {
  let hit = null;
  for (const p of points) {
    if (p.date > iso) break;
    hit = p;
  }
  return hit;
}

// Latest book and its change over one session, one month and one year (the
// comparison is the last session on or before the same date a month / year
// earlier). chg = value / then − 1.
function mtfChanges(points) {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const vs = p => (p && p.value ? { date: p.date, value: p.value, chg: last.value / p.value - 1 } : null);
  return {
    date: last.date, value: last.value, point: last,
    d1: vs(points.length > 1 ? points[points.length - 2] : null),
    m1: vs(mtfPointOnOrBefore(points, mtfMonthsBack(last.date, 1))),
    y1: vs(mtfPointOnOrBefore(points, mtfMonthsBack(last.date, 12))),
  };
}

// Per period (oldest first): days, average and end book, its first / last
// dates, change of the average vs the previous period and the same period a
// year earlier, partial = the period runs past the latest point, and
// startsLate = the series begins more than a week into the period. Combined
// points also give the NSE and BSE averages.
function mtfPeriodRows(points, gran) {
  const byIdx = new Map();
  points.forEach(p => {
    const per = mtfPeriodOf(p.date, gran);
    let r = byIdx.get(per.idx);
    if (!r) {
      r = { label: per.label, idx: per.idx, start: per.start, end: per.end, days: 0, sum: 0, nseSum: 0, bseSum: 0, first: p.date };
      byIdx.set(per.idx, r);
    }
    r.days += 1;
    r.sum += p.value;
    if (p.nse != null) r.nseSum += p.nse;
    if (p.bse != null) r.bseSum += p.bse;
    r.last = p.date;
    r.endValue = p.value;
  });
  const rows = [...byIdx.values()].sort((a, b) => a.idx - b.idx);
  const yearBack = gran === 'month' ? 12 : gran === 'fy' ? 1 : 4;
  const lastDate = points.length ? points[points.length - 1].date : null;
  const firstDate = points.length ? points[0].date : null;
  return rows.map(r => {
    const prev = byIdx.get(r.idx - 1), ly = byIdx.get(r.idx - yearBack);
    const avg = r.sum / r.days;
    const out = {
      label: r.label, idx: r.idx, start: r.start, end: r.end, first: r.first, last: r.last, days: r.days,
      avg, endValue: r.endValue,
      chg: prev ? avg / (prev.sum / prev.days) - 1 : null, prevFirst: prev ? prev.first : null,
      yoy: ly ? avg / (ly.sum / ly.days) - 1 : null, lyFirst: ly ? ly.first : null,
      partial: r.last === lastDate && r.last < r.end,
      startsLate: r.first === firstDate && mtfDaysAfter(r.start, r.first) > 7,
    };
    if (points.length && points[0].nse !== undefined) {
      out.nseAvg = r.nseSum / r.days;
      out.bseAvg = r.bseSum / r.days;
    }
    return out;
  });
}

// The Summary tab's tables for a view's points (oldest first, as mtfSeries gives
// them), laid out like the exchanges' Revenue Summary and the brokers' Summary.
// Every figure is the average book over the reporting days it covers (the book
// is a balance: averaged, never summed). A window is { value, first, last, days }.
//   fy  every FY, newest first; yoy = vs the FY before
//   q   the selected quarter (sel.q, else the latest), the one before it and the
//       same quarter a year earlier; qoq / yoy compare the selected one with them
//   m   the selected month (sel.m, else the latest) and up to 5 before it, each with
//       mom = vs the month before; avg6 = the last MTF_AVG6M_DAYS reporting days to
//       the selected month's last day, mo6m = the month vs avg6
//   w   as of the latest day: last 5, previous 5, last 45 and last 20 reporting days;
//       wow = last 5 vs previous 5, vs45 = last 5 vs last 45
//   d   per weekday: its latest day and the average of its last 3 / last 10 days
//       (the latest included); do3 / do10 = the latest vs those averages
// Period rows also carry prevFirst / lyFirst (first day of the period compared
// with) and startsLate (the series begins more than a week into the period).
// quarters / months: every label, newest first, for the selects.
function mtfSummary(points, sel = {}) {
  if (!points.length) return null;
  const win = ps => (ps.length ? { value: ps.reduce((a, p) => a + p.value, 0) / ps.length,
    first: ps[0].date, last: ps[ps.length - 1].date, days: ps.length } : null);
  const chg = (a, b) => (a && b && b.value ? a.value / b.value - 1 : null);
  const row = r => (r ? { label: r.label, value: r.avg, first: r.first, last: r.last, days: r.days,
    prevFirst: r.prevFirst, lyFirst: r.lyFirst, startsLate: r.startsLate } : null);
  const index = rows => ({ byLabel: new Map(rows.map(r => [r.label, r])), byIdx: new Map(rows.map(r => [r.idx, r])) });

  const fy = mtfPeriodRows(points, 'fy').reverse().map(r => ({ ...row(r), yoy: r.chg }));

  const qRows = mtfPeriodRows(points, 'quarter'), qi = index(qRows);
  const qSel = qi.byLabel.get(sel.q) || qRows[qRows.length - 1];
  const qPrev = row(qi.byIdx.get(qSel.idx - 1)), qLy = row(qi.byIdx.get(qSel.idx - 4));
  const q = { key: qSel.label, sel: row(qSel), prev: qPrev, ly: qLy, qoq: chg(row(qSel), qPrev), yoy: chg(row(qSel), qLy) };

  const mRows = mtfPeriodRows(points, 'month'), mi = index(mRows);
  const mSel = mi.byLabel.get(sel.m) || mRows[mRows.length - 1];
  const months = [];
  for (let i = 0; i < 6 && mi.byIdx.get(mSel.idx - i); i++) {
    const r = mi.byIdx.get(mSel.idx - i);
    months.push({ ...row(r), mom: r.chg });
  }
  const end = points.findIndex(p => p.date === mSel.last);
  const avg6 = win(points.slice(Math.max(0, end - MTF_AVG6M_DAYS + 1), end + 1));
  const m = { key: mSel.label, rows: months, avg6, mo6m: chg(row(mSel), avg6) };

  const last5 = win(points.slice(-5)), prev5 = win(points.slice(-10, -5));
  const last45 = win(points.slice(-45)), last20 = win(points.slice(-20));
  const w = { last5, prev5, last45, last20, wow: chg(last5, prev5), vs45: chg(last5, last45) };

  const weekday = iso => new Date(iso + 'T00:00:00Z').getUTCDay();   // 1 = Monday
  const d = MTF_WEEKDAYS.map((day, i) => {
    const ps = points.filter(p => weekday(p.date) === i + 1);
    const latest = win(ps.slice(-1)), avg3 = win(ps.slice(-3)), avg10 = win(ps.slice(-10));
    return { day, latest, avg3, avg10, do3: chg(latest, avg3), do10: chg(latest, avg10) };
  });

  return { asOf: points[points.length - 1].date, fy, q, m, w, d,
    quarters: qRows.map(r => r.label).reverse(), months: mRows.map(r => r.label).reverse() };
}

// Monthly fresh exposure, liquidated exposure and net (fresh − liquidated), in
// ₹ Cr, from the days that publish them (BSE: its archive, to Sep 2025);
// partial / startsLate as in mtfPeriodRows
function mtfFlowRows(points) {
  const byIdx = new Map();
  const withFlows = points.filter(p => p.fresh != null && p.liquidated != null && (p.file === undefined || p.file === 'archive'));
  const lastDate = points.length ? points[points.length - 1].date : null;
  const firstDate = withFlows.length ? withFlows[0].date : null;
  withFlows.forEach(p => {
    const per = mtfPeriodOf(p.date, 'month');
    let r = byIdx.get(per.idx);
    if (!r) { r = { label: per.label, idx: per.idx, start: per.start, end: per.end, days: 0, fresh: 0, liquidated: 0, first: p.date }; byIdx.set(per.idx, r); }
    r.days += 1;
    r.fresh += p.fresh;
    r.liquidated += p.liquidated;
    r.last = p.date;
    r.endValue = p.value;
  });
  return [...byIdx.values()].sort((a, b) => a.idx - b.idx).map(r => ({ ...r, net: r.fresh - r.liquidated,
    partial: r.last === lastDate && r.last < r.end, startsLate: r.first === firstDate && mtfDaysAfter(r.start, r.first) > 7 }));
}

// The dated notes of a kind for a view (every exchange's for the combined view)
function mtfNotesFor(view, kind = 'break') {
  return MTF_NOTES.filter(n => n.kind === kind && (n.ex === view || view === 'combined'));
}

// The dated notes of a kind for a view whose dates fall in (from, to]
function mtfNotesBetween(view, from, to, kind = 'break') {
  return mtfNotesFor(view, kind).filter(n => (!from || n.date > from) && (!to || n.date <= to));
}

// Top securities of an exchange's latest day: rows sorted by amount financed,
// with each one's share of the day's total, the top-10 share and the count
function mtfTopRows(stocks, ex, n = 15) {
  const block = stocks && stocks[ex];
  const cols = stocks && stocks.columns && stocks.columns[ex];
  if (!block || !Array.isArray(block.rows) || !cols) return null;
  const at = name => cols.indexOf(name);
  const iId = at(ex === 'nse' ? 'symbol' : 'id'), iName = at('name'), iQty = at('qty_financed'), iAmt = at('amount_lakh');
  const all = block.rows.map(r => ({ id: r[iId], name: r[iName], qty: r[iQty], cr: (r[iAmt] || 0) / 100 }))
    .sort((a, b) => b.cr - a.cr);
  const total = all.reduce((s, r) => s + r.cr, 0);
  const share = r => (total ? r.cr / total : null);
  return {
    date: block.date, count: all.length, total,
    top10: total ? all.slice(0, 10).reduce((s, r) => s + r.cr, 0) / total : null,
    rows: all.slice(0, n).map((r, i) => ({ ...r, rank: i + 1, share: share(r) })),
  };
}

// ── Brokers: mtf_brokers.json, which mtf_pipeline.brokers_doc writes from the hand-kept
// register scripts/broker_mtf_register.py: each broker's disclosed figures (book or market
// share) priced against the NSE + BSE book on the same date

// The categorical slots, in fixed order (dataviz reference palette, light): a broker keeps
// its slot (its place in the register), whatever is shown; the brokers after the eighth
// reuse the slots dashed
const MTF_BROKER_PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#8c564b'];

// What each measure is, as a chip: [label, rx-chip kind, title]
const MTF_MEASURE_CHIPS = {
  share: ['share as published', 'data', 'The filing states a market share; the book is that share of the NSE + BSE book on the date'],
  gross: ['gross', 'ok', 'The gross MTF book: the basis the exchanges’ book is on'],
  net: ['net', 'warn', 'Net of client cash collateral, or the balance-sheet loan line: usually 80–87 % of gross, so the share understates'],
  client_funding: ['client funding', 'warn', 'MTF plus interest-bearing trade receivables (no MTF-only figure is published), so the share overstates'],
  unstated: ['basis not stated', '', 'The document calls it the MTF book without saying gross or net'],
};

// How a figure's basis reads beside its measure ('period_end' says nothing): a monthly average, or
// a reading of a figure the broker keeps updating on its web page, taken on each MTF run
const MTF_BASIS_LABELS = { month_avg: 'month avg', live: 'live' };

// A broker's figures on its primary measure and basis, oldest first: the series the
// league table, the chart and the share-by-quarter table follow
function mtfBrokerPrimary(b) {
  const pm = (b && b.primary) || {};
  return ((b && b.series) || []).filter(p => p.measure === pm.measure && p.basis === pm.basis);
}

// League-table rows, largest latest market share first (then book; brokers with none last, in register order):
// the latest primary figure, the two before it (newest first), and, newest first, the latest
// figure on each other measure or basis that is at least as recent (e.g. a monthly average,
// or a balance-sheet book beside a published share)
function mtfBrokerRows(doc) {
  if (!doc || !Array.isArray(doc.brokers)) return [];
  return doc.brokers.map((b, order) => {
    const pts = mtfBrokerPrimary(b);
    const latest = pts.length ? pts[pts.length - 1] : null;
    const lastOf = new Map();                       // measure|basis → its latest figure (series is oldest first)
    (b.series || []).filter(p => !pts.includes(p)).forEach(p => lastOf.set(`${p.measure}|${p.basis}`, p));
    const alts = [...lastOf.values()].filter(p => !latest || p.as_of >= latest.as_of)
      .sort((x, y) => (x.as_of < y.as_of ? 1 : x.as_of > y.as_of ? -1 : 0));
    return { id: b.id, short: b.short, name: b.name, type: b.type, parent: b.parent, primary: b.primary, sources: b.sources,
      order, latest, history: pts.slice(-3, -1).reverse(), count: pts.length, alts };
  }).sort((a, b) => mtfNum(b.latest && b.latest.share_pct) - mtfNum(a.latest && a.latest.share_pct)
    || mtfNum(b.latest && b.latest.book_cr) - mtfNum(a.latest && a.latest.book_cr) || a.order - b.order);
}

// A figure for sorting, or -1 where there is none (sorts last)
function mtfNum(v) { return v == null || !isFinite(v) ? -1 : v; }

// A figure older than this on the day shown is flagged (age chip, hatched bar, hollow point)
const MTF_BROKER_STALE_DAYS = 120;
function mtfBrokerStale(p, todayIso) { return !!p && !!p.as_of && mtfDaysAfter(p.as_of, todayIso) > MTF_BROKER_STALE_DAYS; }

// A row's latest figure against the previous one ('chg') or the one about a year earlier ('yoy'), on the
// same measure: {now, then, pp, bookPct, bookChg, from, to, crosses} (crosses: across a series change), or null
function mtfBrokerCompare(row, cmp) {
  const p = row && row.latest;
  const c = p && p[cmp];
  if (!c || c.share_pp == null || !isFinite(c.share_pp) || p.share_pct == null || !isFinite(p.share_pct)) return null;
  return { now: p.share_pct, then: p.share_pct - c.share_pp, pp: c.share_pp,
    bookPct: c.book_pct != null && isFinite(c.book_pct) ? c.book_pct : null,
    bookChg: c.book_cr != null && isFinite(c.book_cr) ? c.book_cr : null,
    from: c.from, to: p.as_of, crosses: mtfNotesBetween('combined', c.from, p.as_of).length > 0 };
}

// League rows in a column's order (dir -1 largest first): 'share', 'move' (share pp), 'book',
// 'bookchg' (book %), 'asof'. Rows without the figure go last; ties keep the share ranking.
function mtfBrokerSort(rows, key = 'share', dir = -1, cmp = 'chg') {
  const val = r => {
    const p = r.latest;
    if (!p) return null;
    const c = key === 'move' || key === 'bookchg' ? mtfBrokerCompare(r, cmp) : null;
    const v = key === 'move' ? c && c.pp : key === 'bookchg' ? c && c.bookPct : key === 'book' ? p.book_cr
      : key === 'asof' ? Date.parse(p.as_of) : p.share_pct;
    return v == null || !isFinite(v) ? null : v;
  };
  return rows.map((r, i) => ({ r, i, v: val(r) }))
    .sort((a, b) => (a.v == null) - (b.v == null) || (a.v == null ? 0 : dir * (a.v - b.v)) || a.i - b.i)
    .map(x => x.r);
}

// A broker's fixed chart style: its register slot's colour, dashed after the eighth
function mtfBrokerStyle(doc, id) {
  const i = Math.max(0, ((doc && doc.brokers) || []).findIndex(b => b.id === id));
  const n = MTF_BROKER_PALETTE.length;
  return { slot: i, color: MTF_BROKER_PALETTE[i % n], dash: i >= n ? [6, 4] : [] };
}

// A broker's primary figures as chart points {x: ms, y, p}; metric 'share' (%) or 'book' (₹ Cr)
function mtfBrokerPoints(b, metric) {
  return mtfBrokerPrimary(b).map(p => ({ x: Date.parse(p.as_of + 'T00:00:00Z'), y: metric === 'book' ? p.book_cr : p.share_pct, p }))
    .filter(q => q.y != null && isFinite(q.y));
}

// Share moves to the latest disclosed quarter end from the one before ('chg') or the same quarter a
// year earlier ('yoy'), for brokers with a share at both (their primary measure both times):
// {cur, prev, moves: [{id, from, to, pp}]}, gains first
function mtfBrokerMoves(doc, cmp = 'chg') {
  const qs = (doc && doc.quarters) || [];
  const lag = cmp === 'yoy' ? 4 : 1;
  let i = qs.length - 1;
  while (i >= 0 && !qs[i].tracked_n) i--;
  if (i < lag) return null;
  const cur = qs[i], prev = qs[i - lag];
  const moves = Object.keys(cur.shares).filter(id => prev.shares[id] != null)
    .map(id => ({ id, from: prev.shares[id], to: cur.shares[id], pp: cur.shares[id] - prev.shares[id] }))
    .sort((a, b) => b.pp - a.pp);
  return { cur, prev, moves };
}

// "16.1 %", "~14 %" (a share the filing rounds to a whole number), "6.62 %" (one we compute)
function mtfShareText(p) {
  if (!p || p.share_pct == null || !isFinite(p.share_pct)) return '—';
  if (p.precision === 'integer') return `~${p.share_pct.toFixed(0)} %`;
  return `${p.share_pct.toFixed(p.measure === 'share' ? 1 : 2)} %`;
}

// "₹10,498 Cr"; "≈ ₹25,553 Cr" derived from a published share; "~₹9,600 Cr" rounded in the document
function mtfBookText(p) {
  if (!p || p.book_cr == null || !isFinite(p.book_cr)) return '—';
  return `${p.derived ? '≈ ' : p.rounded ? '~' : ''}${rxCr(p.book_cr, 0)}`;
}

// Quarter ends (ms) from min to max, for the chart's x ticks
function mtfQuarterTicks(min, max) {
  const out = [];
  const d = new Date(min);
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3);
  for (;;) {
    const v = Date.UTC(y, q * 3 + 3, 0);
    if (v > max) break;
    if (v >= min) out.push(v);
    q += 1;
    if (q === 4) { q = 0; y += 1; }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// VIEW: load, build, show
// ═══════════════════════════════════════════════════════════════

function mtfDef(id) { return MTF_VIEW_DEFS.find(d => d.id === id) || MTF_VIEW_DEFS[0]; }

function mtfSection(tab) { return viewSection(VIEW_MODES.mtf.prefix + MTF.view, tab); }

async function mtfLoad(def, owns = () => true) {
  if (!MTF.doc || Date.now() - MTF.at > MTF_MAX_AGE_MS) {
    const [daily, stocks, brokers] = await Promise.all([
      fetchDataFile(MTF_DAILY_URL),
      fetchDataFile(MTF_STOCKS_URL).catch(err => { console.warn('MTF securities file not loaded:', err); return null; }),
      fetchDataFile(MTF_BROKERS_URL).catch(err => { console.warn('MTF brokers file not loaded:', err); return null; }),
    ]);
    if (!owns()) return;
    MTF.doc = daily.json;
    MTF.stocks = stocks ? stocks.json : null;
    MTF.brokers = brokers ? brokers.json : null;
    MTF.at = Date.now();
  }
  if (!owns()) return;
  MTF.view = def.id;
}

// build(): clear the tabs of every MTF view (an earlier view's sections stay in
// the page, and must not keep canvases or toggles); each tab of this view
// builds when shown (charts need their size)
function mtfBuild() {
  MTF.built = {};
  MTF_VIEW_DEFS.forEach(d => d.tabs.forEach(t => {
    const el = viewSection(VIEW_MODES.mtf.prefix + d.id, t);
    if (el) el.innerHTML = '';
  }));
}

function mtfShow(tab) {
  if (MTF.built[tab]) return;
  const el = mtfSection(tab);
  if (!el) return;
  const builders = { summary: mtfBuildSummary, book: mtfBuildBook, periods: mtfBuildPeriods, flows: mtfBuildFlows, stocks: mtfBuildStocks,
    brokers: mtfBuildBrokers };
  try {
    builders[tab]?.(el);
    MTF.built[tab] = true;
  } catch (err) {
    console.error(`MTF ${tab} failed:`, err);
    el.innerHTML = `<div class="rx">${rxPanel({ title: MTF_TABS[tab]?.label || tab,
      body: '<div class="rx-empty"><b>This section could not be drawn</b>The data file may be updating; reload in a moment.</div>' })}</div>`;
  }
}

function mtfMeta() {
  const pts = mtfSeries(MTF.doc, MTF.view);
  const last = pts.length ? pts[pts.length - 1].date : null;
  const ahead = mtfAheadText(MTF.doc, MTF.view);
  return last
    ? { quarter: mtfQuarterOf(last), updated: `MTF to ${fmtLongDate(last)}`, updatedExtra: ahead,
        updatedTitle: `Reporting date of the latest book; mtf_daily.json written ${MTF.doc.updated_at || '—'}.${ahead
          ? ` NSE + BSE ends on the last date both exchanges published (${ahead}). ${MTF_PUBLISH_LAG}` : ''}` }
    : { quarter: '—', updated: 'no MTF data' };
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

const MTF_COLORS = { nse: RX.model, bse: RX.rev, combined: RX.ink };
// Book chart ranges: [key, label, n, unit]. Unit 'd' is the last n reporting
// days in the series (sessions, not calendar days); 'm' is n calendar months
// back from the latest reporting day.
const MTF_RANGES = [['10d', '10D', 10, 'd'], ['20d', '20D', 20, 'd'], ['45d', '45D', 45, 'd'],
  ['3m', '3M', 3, 'm'], ['6m', '6M', 6, 'm'], ['1y', '1Y', 12, 'm'], ['3y', '3Y', 36, 'm']];

function mtfEmpty(title, why) {
  return `<div class="rx">${rxPanel({ title, body: `<div class="rx-empty"><b>No data yet</b>${why}</div>` })}</div>`;
}

// "1 month: ▲ +3.2 %" sub-line of a KPI; a comparison that crosses a
// series change says so
function mtfVsLine(view, c, label) {
  if (!c) return `${label}: no earlier session`;
  const crosses = mtfNotesBetween(view, c.date, null).length;
  return `vs ${rxDate(c.date)} · ${rxCr(c.value, 0)}${crosses ? ' · crosses a series change' : ''}`;
}

function mtfKpis(view, pts) {
  const ch = mtfChanges(pts);
  if (!ch) return '';
  const chg = (c, label) => rxKpi(label, c ? rxChangeHTML(c.chg) : '—', mtfVsLine(view, c, label));
  if (view === 'combined') {
    const p = ch.point;
    return rxKpis([
      rxKpi('NSE + BSE book', rxCr(ch.value, 0), `Reporting date ${rxDate(ch.date)}`, { accent: true }),
      rxKpi('NSE', rxCr(p.nse, 0), `${fmtPct(p.nse / ch.value)} of the combined book`),
      rxKpi('BSE', rxCr(p.bse, 0), `${fmtPct(p.bse / ch.value)} of the combined book`),
      chg(ch.m1, '1 month'),
      chg(ch.y1, '1 year'),
    ], 'Latest MTF book');
  }
  return rxKpis([
    rxKpi(`${mtfDef(view).name} book`, rxCr(ch.value, 0), `Reporting date ${rxDate(ch.date)}`, { accent: true }),
    chg(ch.d1, '1 session'),
    chg(ch.m1, '1 month'),
    chg(ch.y1, '1 year'),
    rxKpi('Securities', fmtNum(ch.point.securities, 0), 'with a funded position'),
  ], 'Latest MTF book');
}

// Points in the selected range (a MTF_RANGES key; unknown keys read as 1Y),
// ending at the latest
function mtfInRange(pts, range) {
  if (!pts.length) return pts;
  const [, , n, unit] = MTF_RANGES.find(r => r[0] === range) || MTF_RANGES.find(r => r[0] === '1y');
  if (unit === 'd') return pts.slice(-n);
  const from = mtfMonthsBack(pts[pts.length - 1].date, n);
  return pts.filter(p => p.date > from);
}

// Whether a range is short enough to tick by day ("30 Oct") rather than by month
function mtfRangeIsShort(range) {
  const r = MTF_RANGES.find(x => x[0] === range);
  return !!r && (r[3] === 'd' || r[2] <= 3);
}

// x-axis tick: "Oct 26", or "30 Oct" with byDay
function mtfDateTick(labels, byDay) {
  return function (val) {
    const iso = labels[val];
    if (!iso) return '';
    return byDay ? `${+iso.slice(8, 10)} ${MTF_MONTHS[+iso.slice(5, 7) - 1]}` : `${MTF_MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}`;
  };
}

// ── Summary tab: the workbook-style tables (Revenue Summary / brokers' Summary layout)
// ₹ Cr cell (#,##0.00, as the workbooks show it); its title says which days it averages
function mtfXlVal(w) {
  if (!w) return '<span class="xl-num">—</span>';
  const span = w.days > 1 ? `${rxDate(w.first)} to ${rxDate(w.last)}` : rxDate(w.first);
  return `<span class="xl-num" title="${escHtml(`${w.days} reporting day${w.days === 1 ? '' : 's'}: ${span}`)}">${
    w.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
}

// Change cells (0.0 %, green / red as in the workbooks), with a † when measured across a series change;
// those cells drop their fill (xl-brk / wire-brk), so a change of reporting basis doesn't read as growth
// A change that rounds to 0.0 % is shown as a neutral 0.0 % (never a red "-0.0%")
function mtfRoundChg(v) {
  const r = +(v * 100).toFixed(1);
  return r === 0 ? 0 : r;
}
function mtfXlChg(v, mark = '') {
  if (v == null || !isFinite(v)) return '<td><span class="xl-chg xl-neu">—</span></td>';
  const r = mtfRoundChg(v);
  return `<td><span class="xl-chg ${r > 0 ? 'xl-pos' : r < 0 ? 'xl-neg' : 'xl-neu'}${mark ? ' xl-brk' : ''}">${r.toFixed(1)}%${mark || ''}</span></td>`;
}

function mtfWireChg(v, mark = '') {
  if (v == null || !isFinite(v)) return '<td class="wire-delta neutral">—</td>';
  const r = mtfRoundChg(v);
  return `<td class="wire-delta ${r > 0 ? 'positive' : r < 0 ? 'negative' : 'neutral'}${mark ? ' wire-brk' : ''}">${r.toFixed(1)}%${mark || ''}</td>`;
}

function mtfSummaryHTML(view, s) {
  const mark = (from, to) => mtfBreakMark(view, from, to);
  const hdr = (cols) => `<tr class="xl-col-hdr">${cols.map(([t, tip]) => `<td${tip ? ` title="${escHtml(tip)}"` : ''}>${t}</td>`).join('')}</tr>`;
  const label = r => `${escHtml(r.label)}${r.startsLate
    ? ` <span class="mtf-sum-from" title="${escHtml(`The series starts on ${rxDate(r.first)}, so this period is only partly covered`)}">from ${rxDate(r.first)}</span>` : ''}`;
  const select = (key, opts, cur, aria) => `<select class="xl-row-sel mtf-sum-sel" data-sel="${key}" aria-label="${aria}">${
    opts.map(o => `<option${o === cur ? ' selected' : ''}>${escHtml(o)}</option>`).join('')}</select>`;
  const tr = (cur, cells) => `<tr${cur ? ' class="xl-r-cur"' : ''}>${cells}</tr>`;
  const plain = (lbl, w) => tr(false, `<td>${lbl}</td><td>${mtfXlVal(w)}</td><td></td><td></td>`);

  const fy = s.fy.map((r, i) => tr(i === 0, `<td>${label(r)}</td><td>${mtfXlVal(r)}</td>${
    i < s.fy.length - 1 ? mtfXlChg(r.yoy, mark(r.prevFirst, r.last)) : '<td></td>'}<td></td>`)).join('');

  const { q } = s;
  const qRows = tr(true, `<td>${select('q', s.quarters, q.key, 'Quarter')}</td><td>${mtfXlVal(q.sel)}</td>${
    mtfXlChg(q.qoq, q.prev && mark(q.prev.first, q.sel.last))}${mtfXlChg(q.yoy, q.ly && mark(q.ly.first, q.sel.last))}`)
    + (q.prev ? plain(label(q.prev), q.prev) : '') + (q.ly ? plain(label(q.ly), q.ly) : '');

  const { m } = s;
  const avg6Label = `Avg of last 6 months${m.avg6 && m.avg6.days < MTF_AVG6M_DAYS ? ` (${m.avg6.days} days)` : ''}`;
  const mRows = m.rows.map((r, i) => tr(i === 0, `<td>${i === 0 ? select('m', s.months, m.key, 'Month') : label(r)}${
    i === 0 && r.startsLate ? label({ ...r, label: '' }) : ''}</td><td>${mtfXlVal(r)}</td>${
    mtfXlChg(r.mom, r.prevFirst && mark(r.prevFirst, r.last))}${
    i === 0 ? mtfXlChg(m.mo6m, m.avg6 && mark(m.avg6.first, r.last)) : '<td></td>'}`)).join('')
    + tr(false, `<td class="mtf-sum-muted" title="${escHtml(`The last ${MTF_AVG6M_DAYS} reporting days to the month's last day`)}">${avg6Label}</td><td>${mtfXlVal(m.avg6)}</td><td></td><td></td>`);

  const { w } = s;
  const wRows = tr(true, `<td>Last 5 trading days</td><td>${mtfXlVal(w.last5)}</td>${
    mtfXlChg(w.wow, w.prev5 && mark(w.prev5.first, w.last5.last))}${mtfXlChg(w.vs45, w.last45 && mark(w.last45.first, w.last5.last))}`)
    + plain('Previous 5 trading days', w.prev5) + plain('Last 20 trading days', w.last20) + plain('Last 45 trading days', w.last45);

  const period = `<table class="xl-period-table">
      <colgroup><col class="xl-col-period"><col class="xl-col-val"><col class="xl-col-chg1"><col class="xl-col-chg2"></colgroup>
      <tbody class="xl-sec">${hdr([['Financial Year'], ['Avg (In Cr)', 'Average book over the FY’s reporting days'], ['YoY', 'vs the previous financial year'], ['']])}${fy}</tbody>
      <tbody class="xl-sec">${hdr([['Quarter&gt;&gt;'], ['Val (In Cr)'], ['QoQ', 'vs the previous quarter'], ['YoY', 'vs the same quarter last year']])}${qRows}</tbody>
      <tbody class="xl-sec">${hdr([['Month&gt;&gt;'], ['Val (In Cr)'], ['MoM', 'vs the previous month'], ['vs 6M', `vs the average of the last 6 months (${MTF_AVG6M_DAYS} reporting days)`]])}${mRows}</tbody>
      <tbody class="xl-sec">${hdr([['Week&gt;&gt;'], ['Val (In Cr)'], ['WoW', 'Last 5 trading days vs the 5 before'], ['vs 45D', 'Last 5 trading days vs the last 45']])}${wRows}</tbody>
    </table>`;

  const days = s.d.filter(x => x.latest).map(x => {
    const detail = (n, a) => `<tr class="wire-detail"><td>Average of last ${n} ${x.day}s</td><td class="wire-value">${mtfXlVal(a)}</td><td></td><td></td></tr>`;
    return `<tr class="wire-day-main"><td>${x.day} <span class="mtf-sum-date">${escHtml(rxDate(x.latest.last).slice(0, -5))}</span></td><td class="wire-value">${mtfXlVal(x.latest)}</td>${
      mtfWireChg(x.do3, mark(x.avg3.first, x.latest.last))}${mtfWireChg(x.do10, mark(x.avg10.first, x.latest.last))}</tr>${detail(3, x.avg3)}${detail(10, x.avg10)}`;
  }).join('<tr class="wire-day-spacer"><td colspan="4"></td></tr>');
  const weekday = `<div class="wire-table-scroll"><table class="wire-table weekday-wire-table">
      <colgroup><col><col><col><col></colgroup>
      <thead><tr><th>Weekday&gt;&gt;</th><th>Val (In Cr)</th><th title="The latest such weekday vs the average of the last 3 (itself included)">Do 3D</th><th title="The latest such weekday vs the average of the last 10 (itself included)">Do 10D</th></tr></thead>
      <tbody>${days}</tbody></table></div>`;
  return `${period}${weekday}`;
}

function mtfBuildSummary(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const pts = mtfSeries(MTF.doc, view);
  if (!pts.length) { el.innerHTML = mtfEmpty('Summary', 'mtf_daily.json has no days for this view.'); return; }
  const kpis = mtfKpis(view, pts);   // the latest book, as on the MTF Book tab
  const draw = () => {
    const s = mtfSummary(pts, MTF.sel);
    const first = pts[0].date;
    const ahead = mtfAheadText(MTF.doc, view);
    const breaks = mtfNotesFor(view, 'break');
    const excluded = mtfNotesFor(view, 'excluded');
    el.innerHTML = `<div class="mtf-sum">
      ${kpis ? `<div class="rx mtf-sum-kpis">${kpis}</div>` : ''}
      <div class="mtf-sum-bar"><span><b>${def.name}</b> · as of <b>${rxDate(s.asOf)}</b> (reporting date)</span>
        ${ahead ? `<span>${escHtml(ahead)} · NSE + BSE ends on the last date both published</span>` : ''}
        <span>${s.fy.length} financial years · series from ${rxDate(first)}</span></div>
      <div class="xl-segment mtf-sum-panel">
        <div class="xl-seg-header">${def.name} MTF book <span class="xl-seg-unit">₹ Cr · average over reporting days</span></div>
        <div class="xl-main-row">${mtfSummaryHTML(view, s)}</div>
      </div>
      ${view === 'combined' ? `<div class="rx mtf-sum-share">${rxPanel({ title: 'BSE share of the combined book', meta: '% of NSE + BSE, by reporting date',
        right: rxSeg('mtfSumRange', MTF_RANGES.map(r => [r[0], r[1]]), MTF.sumRange, 'Chart range'),
        body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas('mtfSumShareChart-combined')}</div><div data-mtf="sumShareNotes"></div>` })}</div>` : ''}
      <ul class="mtf-sum-notes">
        <li>Each figure is the average of the daily book over the reporting days it covers; changes compare those averages. Hover a figure for its days.</li>
        <li>Pick the quarter or the month in its first row; the week and weekday tables run to the latest reporting date.</li>
        ${view === 'combined' ? `<li>NSE + BSE counts only the dates both exchanges published. ${escHtml(MTF_PUBLISH_LAG)}</li>` : ''}
        ${breaks.length ? `<li><span class="mtf-dagger">†</span> measured across a change in an exchange’s own series (${breaks.map(n => `${n.ex.toUpperCase()} ${rxDate(n.date)}`).join(', ')}), shown without a fill: not like-for-like; see the notes on the MTF Book tab.</li>` : ''}
        ${excluded.length ? `<li>Left out: ${excluded.map(n => rxDate(n.date)).join(', ')} (a one-day jump in BSE’s file that reverts).</li>` : ''}
      </ul>
    </div>`;
    if (view !== 'combined') return;
    const drawShare = () => {
      const shown = mtfInRange(pts, MTF.sumRange);
      const notes = mtfNotesBetween(view, shown.length ? shown[0].date : null, null);
      el.querySelector('[data-mtf="sumShareNotes"]').innerHTML = notes.length
        ? `<div class="rx-chart-note mtf-notes">${notes.map(n => rxAlert(`<strong>${rxDate(n.date)}.</strong> ${n.text}`, 'info')).join('')}</div>` : '';
      mtfDrawShare('mtfSumShare', 'mtfSumShareChart-combined', shown, MTF.sumRange);
    };
    drawShare();
    rxOnSeg(el, 'mtfSumRange', v => { MTF.sumRange = v; drawShare(); });
  };
  draw();
  el.onchange = e => {
    const sel = e.target.closest('.mtf-sum-sel');
    if (!sel) return;
    MTF.sel[sel.dataset.sel] = sel.value;
    draw();
  };
}

function mtfBuildBook(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const pts = mtfSeries(MTF.doc, view);
  if (!pts.length) { el.innerHTML = mtfEmpty('MTF book', 'mtf_daily.json has no days for this view.'); return; }
  const last = pts[pts.length - 1];
  const legend = view === 'combined'
    ? rxLegend([{ label: 'NSE + BSE', color: MTF_COLORS.combined, kind: 'line' }, { label: 'NSE', color: MTF_COLORS.nse, kind: 'line' },
      { label: 'BSE (the gap)', color: 'rgba(196,98,26,0.35)' }])
    : rxLegend([{ label: `${def.name} book`, color: MTF_COLORS[view], kind: 'line' }]);
  const recent = pts.slice(-10).reverse();
  const recentHead = view === 'combined'
    ? '<th scope="col">Reporting date</th><th scope="col">NSE</th><th scope="col">BSE</th><th scope="col">NSE + BSE</th><th scope="col">Change</th>'
    : `<th scope="col">Reporting date</th><th scope="col">Book</th><th scope="col">Change</th><th scope="col">Securities</th>${
      view === 'nse' ? '<th scope="col">Fresh</th><th scope="col">Liquidated</th><th scope="col" class="rx-l">Note</th>' : ''}`;
  const recentRows = recent.map((p, i) => {
    const prev = pts[pts.length - 2 - i];
    const chg = prev ? rxChangeHTML(p.value / prev.value - 1, 2) : '—';
    if (view === 'combined') {
      return `<tr><td>${fmtTradeDate(p.date, true)}</td><td>${fmtNum(p.nse, 0)}</td><td>${fmtNum(p.bse, 0)}</td><td class="rx-strong">${fmtNum(p.value, 0)}</td><td>${chg}</td></tr>`;
    }
    return `<tr><td>${fmtTradeDate(p.date, true)}</td><td class="rx-strong">${fmtNum(p.value, 0)}</td><td>${chg}</td><td>${fmtNum(p.securities, 0)}</td>${
      view === 'nse' ? `<td>${fmtNum(p.fresh, 0)}</td><td>${fmtNum(p.liquidated, 0)}</td><td class="rx-l">${p.revised ? rxChip('revised', 'data') : ''}</td>` : ''}</tr>`;
  }).join('');

  el.innerHTML = `<div class="rx">
    ${mtfKpis(view, pts)}
    ${rxPanel({ title: view === 'combined' ? 'NSE + BSE MTF book' : `${def.name} MTF book`,
      meta: `₹ Cr by reporting date · to ${rxDate(last.date)}${mtfAheadText(MTF.doc, view) ? ` (${escHtml(mtfAheadText(MTF.doc, view))})` : ''}`,
      right: `${legend}${rxSeg('mtfRange', MTF_RANGES.map(r => [r[0], r[1]]), MTF.range, 'Chart range')}`,
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfBookChart-${view}`)}</div><div data-mtf="bookNotes"></div>` })}
    ${view === 'combined' ? rxPanel({ title: 'BSE share of the combined book', meta: '% of NSE + BSE, by reporting date',
      body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`mtfShareChart-${view}`)}</div>` }) : ''}
    ${rxPanel({ title: 'Latest reporting days', meta: '₹ Cr',
      body: `<div class="rx-scroll"><table class="rx-table"><thead><tr>${recentHead}</tr></thead><tbody>${recentRows}</tbody></table></div>` })}
    ${rxPanel({ title: 'About these figures', body: mtfAboutHTML(view) })}
  </div>`;

  const draw = () => {
    const shown = mtfInRange(pts, MTF.range);
    const labels = shown.map(p => p.date);
    const byDay = mtfRangeIsShort(MTF.range);
    const pointRadius = shown.length <= 45 ? 2 : 0;   // mark each session on the short ranges
    const notes = mtfNotesBetween(view, shown.length ? shown[0].date : null, null);
    el.querySelector('[data-mtf="bookNotes"]').innerHTML = notes.length
      ? `<div class="rx-chart-note mtf-notes">${notes.map(n => rxAlert(`<strong>${rxDate(n.date)}.</strong> ${n.text}`, 'info')).join('')}</div>` : '';
    const tooltip = { callbacks: {
      title: items => fmtTradeDate(labels[items[0].dataIndex], true) + ' ' + labels[items[0].dataIndex].slice(0, 4),
      label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}`,
      footer: items => (view === 'combined' ? `BSE: ${rxCr(shown[items[0].dataIndex].bse, 0)}` : ''),
    } };
    // NSE + BSE: two lines, not a stack from zero, so the axis can fit the moves; the band between them is BSE
    const datasets = view === 'combined'
      ? [{ label: 'NSE + BSE', data: shown.map(p => p.value), borderColor: MTF_COLORS.combined, backgroundColor: 'rgba(196,98,26,0.35)', fill: '+1' },
         { label: 'NSE', data: shown.map(p => p.nse), borderColor: MTF_COLORS.nse, backgroundColor: 'transparent', fill: false }]
      : [{ label: `${def.name} book`, data: shown.map(p => p.value), borderColor: MTF_COLORS[view], backgroundColor: 'transparent', fill: false }];
    datasets.forEach(d => Object.assign(d, { borderWidth: 1.6, pointRadius, pointHoverRadius: 3, tension: 0 }));
    rxChart('mtfBook', `mtfBookChart-${view}`, 260, {
      type: 'line',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback: mtfDateTick(labels, byDay) } },
          y: { ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    if (view === 'combined') mtfDrawShare('mtfShare', `mtfShareChart-${view}`, shown, MTF.range);
  };
  draw();
  rxOnSeg(el, 'mtfRange', v => { MTF.range = v; draw(); });
}

// BSE's share of the combined book (%), one point per reporting date, for the NSE + BSE
// view's MTF Book and Summary tabs; `range` (a MTF_RANGES key) sets the ticks and markers
function mtfDrawShare(key, canvasId, shown, range) {
  const labels = shown.map(p => p.date);
  rxChart(key, canvasId, 160, {
    type: 'line',
    data: { labels, datasets: [{ label: 'BSE share', data: shown.map(p => (p.value ? p.bse / p.value * 100 : null)),
      borderColor: MTF_COLORS.bse, borderWidth: 1.6, pointRadius: shown.length <= 45 ? 2 : 0, pointHoverRadius: 3, tension: 0 }] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: {
        title: items => fmtTradeDate(labels[items[0].dataIndex], true) + ' ' + labels[items[0].dataIndex].slice(0, 4),
        label: c => ` BSE share: ${c.raw.toFixed(2)} %`,
      } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback: mtfDateTick(labels, mtfRangeIsShort(range)) } },
        y: { ticks: { callback: v => v.toFixed(1) + ' %' } },
      },
    },
  });
  rxFixHeight(charts[key]);
}

// A left-out day's reason as a kind to count: [singular, plural]
function mtfLeftOutKind(why) {
  const w = String(why || '');
  if (/^not published/.test(w)) return ['not published', 'not published'];
  if (/^file is for /.test(w)) return ['file for another date', 'files for another date'];
  if (/^partial file/.test(w)) return ['partial file', 'partial files'];
  if (/no closing book|no securities/.test(w)) return ['file with no book', 'files with no book'];
  if (/one-day jump/.test(w)) return ['one-day jump that reverts', 'one-day jumps that revert'];
  return [w, w];
}

// The "About these figures" text: sources, conventions, the days left out and
// the dated notes on the series
function mtfAboutHTML(view) {
  const doc = MTF.doc || {};
  const exs = view === 'combined' ? ['nse', 'bse'] : [view];
  const src = {
    nse: '<b>NSE</b>: “Net scripwise outstanding at the end of the day” from NSE’s daily margin trading file (<code>mrg_trading_DDMMYY.zip</code>). '
      + 'NSE republishes a day a few days later with late member submissions; the revised figures are used (marked “revised”).',
    bse: '<b>BSE</b>: the sum of “Amount financed by members” over the securities in BSE’s margin trading file; days before 1 Oct 2025 come from BSE’s margin trading archive.',
  };
  // Days left out: a count per exchange by kind of reason, the dated list folded away below it
  const summary = [], starts = [], days = [];
  exs.forEach(ex => {
    const EX = ex.toUpperCase();
    const rows = doc[ex] || [];
    const first = rows.reduce((m, r) => (!m || r.date < m ? r.date : m), null);
    const out = rows.filter(r => (r.flags || []).includes('spike')).map(r => [r.date, 'a one-day jump that reverts']);
    // days before the exchange's first file are where its series starts, not gaps in it: one line for them
    const missing = Object.entries((doc.unavailable || {})[ex] || {});
    const before = missing.filter(([d]) => first && d < first);
    out.push(...missing.filter(([d]) => !first || d >= first));
    if (before.length) {
      starts.push(`${EX} has no file for the ${before.length} trading day${before.length === 1 ? '' : 's'} from ${rxDate(before.map(([d]) => d).sort()[0])}, so its series starts on ${rxDate(first)}`);
    }
    if (!out.length) return;
    const counts = new Map();
    out.forEach(([, why]) => { const k = mtfLeftOutKind(why); const c = counts.get(k[0]) || { k, n: 0 }; c.n += 1; counts.set(k[0], c); });
    summary.push(`${EX} ${out.length} day${out.length === 1 ? '' : 's'} (${[...counts.values()].map(({ k, n }) => `${n} ${escHtml(n === 1 ? k[0] : k[1])}`).join(', ')})`);
    out.sort((a, b) => (a[0] < b[0] ? -1 : 1)).forEach(([d, why]) => days.push(`${EX} ${rxDate(d)}: ${escHtml(why)}`));
  });
  const leftOut = summary.length || starts.length
    ? `<li><b>Left out</b>: ${summary.length ? `${summary.join('; ')}.` : ''}${starts.length ? ` ${starts.join('; ')}.` : ''}${days.length
      ? `<details class="mtf-left"><summary>List the ${days.length} day${days.length === 1 ? '' : 's'}</summary><ul>${days.map(x => `<li>${x}</li>`).join('')}</ul></details>` : ''}</li>`
    : '';
  const notes = MTF_NOTES.filter(n => exs.includes(n.ex) && n.kind === 'break');
  return `<div class="rx-pb mtf-about">
    <ul>
      ${exs.map(ex => `<li>${src[ex]}</li>`).join('')}
      ${view === 'combined' ? '<li><b>NSE + BSE</b>: the sum on dates both exchanges published. Many securities trade on both, so the security counts are not added.</li>' : ''}
      <li>Each day is the <b>reporting date</b>, the trading day the book is for. ${exs.map(ex => MTF_PUBLISHED[ex]).join('; ')}, so the latest date trails the market by ${
        exs.includes('bse') ? 'about two sessions' : 'a session'}${view === 'combined' ? ', and NSE + BSE usually ends a session before NSE' : ''}.</li>
      <li>This is the exchanges’ disclosed MTF book across all members, not any one broker’s loan book or interest income.</li>
      ${leftOut}
    </ul>
    ${notes.length ? `<p class="rx-lbl" style="margin:10px 0 4px">Series changes</p><ul>${notes.map(n => `<li><b>${rxDate(n.date)}</b>: ${n.text}</li>`).join('')}</ul>` : ''}
    <p class="rx-foot">Source: <code>dashboard/data/mtf_daily.json</code>, written ${escHtml(rxDate(doc.updated_at || ''))} by <code>scripts/mtf_pipeline.py</code>.</p>
  </div>`;
}

// "to 3 Nov 2026" / "from 6 Nov 2023" after a period the file covers only in part
function mtfPartChip(r) {
  return r.partial ? ` <span class="rx-chip">to ${rxDate(r.last)}</span>`
    : r.startsLate ? ` <span class="rx-chip">from ${rxDate(r.first)}</span>` : '';
}

// A † after a change measured across a series change
function mtfBreakMark(view, from, to) {
  const n = from ? mtfNotesBetween(view, from, to) : [];
  return n.length ? `<sup class="mtf-dagger" title="${escHtml(n.map(x => `${x.ex.toUpperCase()} ${rxDate(x.date)}`).join(', '))}: series change in between">†</sup>` : '';
}

function mtfBuildPeriods(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const pts = mtfSeries(MTF.doc, view);
  if (!pts.length) { el.innerHTML = mtfEmpty('By quarter', 'mtf_daily.json has no days for this view.'); return; }
  el.innerHTML = `<div class="rx">
    ${rxPanel({ title: `${def.name} average daily MTF book`, meta: '<span data-mtf="perMeta"></span>',
      right: `<span data-mtf="perLegend"></span>${rxSeg('mtfGran', [['quarter', 'Quarter'], ['month', 'Month']], MTF.gran, 'Period')}`,
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfPeriodChart-${view}`)}</div>
        <div class="rx-scroll"><table class="rx-table mtf-per-table" data-mtf="perTable"></table></div>
        <p class="rx-foot rx-pb" data-mtf="perFoot"></p>` })}
  </div>`;
  const q = k => el.querySelector(`[data-mtf="${k}"]`);
  const draw = () => {
    const gran = MTF.gran;
    const rows = mtfPeriodRows(pts, gran);
    const unit = gran === 'month' ? 'month' : 'quarter';
    q('perMeta').textContent = `₹ Cr, average over each ${unit}’s reporting days${gran === 'month' ? '' : ' (Indian FY quarters)'}`;
    q('perLegend').innerHTML = view === 'combined'
      ? rxLegend([{ label: 'NSE', color: MTF_COLORS.nse }, { label: 'BSE', color: MTF_COLORS.bse }])
      : rxLegend([{ label: 'Average book', color: MTF_COLORS[view] }, { label: 'To date', color: '#BFC9DD' }]);
    const shown = gran === 'month' ? rows.slice(-24) : rows;
    const labels = shown.map(r => r.label + (r.partial || r.startsLate ? '*' : ''));
    const datasets = view === 'combined'
      ? [{ label: 'NSE', data: shown.map(r => r.nseAvg), backgroundColor: shown.map(r => (r.partial ? '#A9BDE8' : MTF_COLORS.nse)), stack: 'a' },
         { label: 'BSE', data: shown.map(r => r.bseAvg), backgroundColor: shown.map(r => (r.partial ? '#E3B48F' : MTF_COLORS.bse)), stack: 'a' }]
      : [{ label: 'Average book', data: shown.map(r => r.avg), backgroundColor: shown.map(r => (r.partial ? '#BFC9DD' : MTF_COLORS[view])) }];
    datasets.forEach(d => Object.assign(d, { borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 40 }));
    rxChart('mtfPeriods', `mtfPeriodChart-${view}`, 220, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => { const r = shown[items[0].dataIndex]; return `${r.label}${r.partial ? ` (to ${rxDate(r.last)})` : r.startsLate ? ` (from ${rxDate(r.first)})` : ''}`; },
          label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}`,
          footer: items => { const r = shown[items[0].dataIndex]; return `${r.days} reporting days${view === 'combined' ? ` · total ${rxCr(r.avg, 0)}` : ''}`; },
        } } },
        scales: {
          x: { stacked: view === 'combined', grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { stacked: view === 'combined', beginAtZero: true, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    const chgHead = gran === 'month' ? 'MoM' : 'QoQ';
    const extraHead = view === 'combined' ? '<th scope="col" class="mtf-ph-hide">NSE avg</th><th scope="col" class="mtf-ph-hide">BSE avg</th><th scope="col">BSE share</th>' : '';
    const body = rows.slice().reverse().map(r => {
      const label = `${r.label}${mtfPartChip(r)}`;
      const extra = view === 'combined'
        ? `<td class="mtf-ph-hide">${fmtNum(r.nseAvg, 0)}</td><td class="mtf-ph-hide">${fmtNum(r.bseAvg, 0)}</td><td>${fmtPct(r.bseAvg / r.avg)}</td>` : '';
      return `<tr><td>${label}</td><td class="mtf-ph-hide">${r.days}</td><td class="rx-strong">${fmtNum(r.avg, 0)}</td><td class="mtf-ph-hide">${fmtNum(r.endValue, 0)}</td>
        <td>${r.chg == null ? '—' : rxChangeHTML(r.chg) + mtfBreakMark(view, r.prevFirst, r.last)}</td>
        <td>${r.yoy == null ? '—' : rxChangeHTML(r.yoy) + mtfBreakMark(view, r.lyFirst, r.last)}</td>${extra}</tr>`;
    }).join('');
    q('perTable').innerHTML = `<thead><tr><th scope="col">${gran === 'month' ? 'Month' : 'Quarter'}</th><th scope="col" class="mtf-ph-hide">Days</th>
      <th scope="col">Average book</th><th scope="col" class="mtf-ph-hide">End of period</th><th scope="col">${chgHead}</th><th scope="col">YoY</th>${extraHead}</tr></thead>
      <tbody>${body}</tbody>`;
    const breaks = mtfNotesBetween(view, null, null);
    q('perFoot').innerHTML = `Changes compare average daily books. * : part of the ${unit} (“to …”: so far; “from …”: the first day in the file).`
      + (breaks.length ? ` † The comparison spans a change in an exchange’s own series (${breaks.map(n => `${n.ex.toUpperCase()} ${rxDate(n.date)}`).join(', ')}; see the MTF Book tab).` : '')
      + (gran === 'month' ? ' The chart shows the last 24 months; the table all of them.' : '');
  };
  draw();
  rxOnSeg(el, 'mtfGran', v => { MTF.gran = v; draw(); });
}

function mtfBuildFlows(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const rows = mtfFlowRows(mtfSeries(MTF.doc, view));
  if (!rows.length) { el.innerHTML = mtfEmpty('Flows', `${def.name}’s files carry no fresh / liquidated exposure.`); return; }
  const shown = rows.slice(-24);
  const lastRow = rows.filter(r => !r.partial).pop() || rows[rows.length - 1];   // KPIs: the last complete month
  const bseNote = view === 'bse'
    ? rxAlert('BSE’s margin trading file from 1 Oct 2025 publishes only the amount financed, so BSE’s flows stop at '
      + `${escHtml(lastRow.label)}. They come from BSE’s margin trading archive, whose opening + fresh − liquidated does not always equal its closing book (a few ₹ Cr on most days).`, 'info')
    : '';
  el.innerHTML = `<div class="rx">
    ${rxKpis([
      rxKpi(`Fresh exposure · ${escHtml(lastRow.label)}`, rxCr(lastRow.fresh, 0), `${lastRow.days} reporting days`),
      rxKpi(`Liquidated · ${escHtml(lastRow.label)}`, rxCr(lastRow.liquidated, 0), `to ${rxDate(lastRow.last)}`),
      rxKpi(`Net · ${escHtml(lastRow.label)}`, `<span class="${lastRow.net >= 0 ? 'rx-up' : 'rx-dn'}">${lastRow.net >= 0 ? '+' : '−'}${rxCr(Math.abs(lastRow.net), 0)}</span>`, 'fresh − liquidated'),
      rxKpi('Book at month end', rxCr(lastRow.endValue, 0), `${rxDate(lastRow.last)}`),
    ], 'Latest month of flows')}
    ${bseNote}
    ${rxPanel({ title: `${def.name} MTF flows by month`, meta: '₹ Cr, summed over each month’s reporting days',
      right: rxLegend([{ label: 'Fresh exposure', color: RX.model }, { label: 'Liquidated', color: RX.deduct }, { label: 'Net (right axis)', color: RX.ink, kind: 'line' }]),
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfFlowChart-${view}`)}</div>
        <div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col">Month</th><th scope="col">Days</th><th scope="col">Fresh</th>
          <th scope="col">Liquidated</th><th scope="col">Net</th><th scope="col">Month-end book</th></tr></thead>
          <tbody>${rows.slice().reverse().map(r => `<tr><td>${escHtml(r.label)}${mtfPartChip(r)}</td><td>${r.days}</td><td>${fmtNum(r.fresh, 0)}</td><td>${fmtNum(r.liquidated, 0)}</td>
            <td class="${r.net >= 0 ? 'rx-up' : 'rx-dn'}">${r.net >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.net), 0)}</td><td>${fmtNum(r.endValue, 0)}</td></tr>`).join('')}</tbody></table></div>
        <p class="rx-foot rx-pb">* : part of the month (“to …”: so far; “from …”: the first day in the file). The chart shows the last 24 months with flows; the table all of them. Net is fresh exposure less liquidated exposure; the book also moves with revisions and members’ corrections.</p>` })}
  </div>`;
  rxChart('mtfFlows', `mtfFlowChart-${view}`, 240, {
    type: 'bar',
    data: { labels: shown.map(r => r.label + (r.partial || r.startsLate ? '*' : '')), datasets: [
      { type: 'line', label: 'Net', data: shown.map(r => r.net), yAxisID: 'y1', borderColor: RX.ink, borderWidth: 1.6, pointRadius: 2, tension: 0, order: 0 },
      { label: 'Fresh exposure', data: shown.map(r => r.fresh), backgroundColor: RX.model, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 22, order: 1 },
      { label: 'Liquidated', data: shown.map(r => r.liquidated), backgroundColor: RX.deduct, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 22, order: 1 },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: true, ticks: { callback: v => fmtNum(v, 0) } },
        // Net is a tenth the size of the gross flows: on their axis it would sit on zero
        y1: { position: 'right', ticks: { color: RX.ink, callback: v => fmtNum(v, 0) },
          grid: { drawOnChartArea: true, color: c => (c.tick && c.tick.value === 0 ? RX.grey : 'transparent') } },
      },
    },
  });
}

// withId: a Symbol / ISIN column (left out where two tables share a row)
function mtfStocksTable(top, ex, n, withId = true) {
  const idHead = ex === 'nse' ? 'Symbol' : 'ISIN';
  return `<div class="rx-scroll"><table class="rx-table mtf-stocks"><thead><tr><th scope="col">#</th><th scope="col" class="rx-l">Security</th>
    ${withId ? `<th scope="col" class="rx-l mtf-id">${idHead}</th>` : ''}<th scope="col">Amount financed</th><th scope="col">Share</th><th scope="col">Quantity</th></tr></thead>
    <tbody>${top.rows.slice(0, n).map(r => `<tr><td>${r.rank}</td><td class="rx-l mtf-name" title="${escHtml(r.id || '')}">${escHtml(r.name || r.id || '—')}</td>${
      withId ? `<td class="rx-l rx-mono mtf-id">${escHtml(r.id || '')}</td>` : ''}
      <td class="rx-strong">${rxCr(r.cr, 1)}</td><td>${fmtPct(r.share)}</td><td>${fmtNum(r.qty, 0)}</td></tr>`).join('')}</tbody></table></div>`;
}

function mtfBuildStocks(el) {
  const view = MTF.view;
  const exs = view === 'combined' ? ['nse', 'bse'] : [view];
  const tops = exs.map(ex => ({ ex, top: mtfTopRows(MTF.stocks, ex, 15) }));
  if (tops.every(t => !t.top)) { el.innerHTML = mtfEmpty('Top securities', 'mtf_stocks_latest.json is not available.'); return; }
  const foot = 'Latest reporting day only: the per-security history is not kept in this file. Many securities trade on both exchanges, so the two lists are not added.';
  if (view === 'combined') {
    el.innerHTML = `<div class="rx">
      <div class="rx-row">${tops.map(({ ex, top }) => rxPanel({ cls: 'rx-col-half', title: `${ex.toUpperCase()}: top 10 securities`,
        meta: top ? `${rxDate(top.date)} · top 10 = ${fmtPct(top.top10)} of ${rxCr(top.total, 0)}` : 'not available',
        body: top ? mtfStocksTable(top, ex, 10, false) : '<div class="rx-empty">Not in the file.</div>' })).join('')}</div>
      <p class="rx-foot">${foot}</p>
    </div>`;
    return;
  }
  const top = tops[0].top;
  if (!top) { el.innerHTML = mtfEmpty('Top securities', `mtf_stocks_latest.json has no ${view.toUpperCase()} day.`); return; }
  const lead = top.rows[0];
  el.innerHTML = `<div class="rx">
    ${rxKpis([
      rxKpi('Securities', fmtNum(top.count, 0), `with a funded position on ${rxDate(top.date)}`, { accent: true }),
      rxKpi('Top 10 share', fmtPct(top.top10), `of ${rxCr(top.total, 0)}`),
      rxKpi('Largest', lead ? escHtml(lead.name || lead.id) : '—', lead ? `${rxCr(lead.cr, 0)} · ${fmtPct(lead.share)}` : ''),
    ], 'Concentration')}
    ${rxPanel({ title: `${view.toUpperCase()}: top 15 securities by amount financed`, meta: `${rxDate(top.date)} · ₹ Cr, quantity in shares`,
      body: mtfStocksTable(top, view, 15), foot: foot.split('. ')[0] + '.' })}
  </div>`;
}

// ── Brokers tab: a toolbar (compare with the previous figure or a year earlier) over the KPIs,
// a market share league (one line per broker: share as a bar with a tick at the earlier figure,
// details on demand), size vs momentum beside how to read the figures, small multiples of each
// broker's share over time, the share by quarter end as a highlight table, and the sources

// A dashed vertical line at each date in options.plugins.mtfBreakLine.dates (series changes)
const MTF_BREAK_LINE = {
  id: 'mtfBreakLine',
  afterDatasetsDraw(chart, args, opts) {
    const x = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
    ((opts && opts.dates) || []).forEach(iso => {
      const v = Date.parse(iso + 'T00:00:00Z');
      if (!x || v < x.min || v > x.max) return;
      const px = x.getPixelForValue(v);
      ctx.save();
      ctx.strokeStyle = RX.grey;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      ctx.restore();
    });
  },
};

// Direct labels beside a bubble chart's points (each point's `label`), moved up or down to
// clear the labels already drawn; with options.plugins.mtfPointLabels.quadrants, a muted
// "Gaining share" / "Losing share" at the top and bottom of the plot
const MTF_POINT_LABELS = {
  id: 'mtfPointLabels',
  afterDatasetsDraw(chart, args, opts) {
    const ctx = chart.ctx, area = chart.chartArea;
    ctx.save();
    if (opts && opts.quadrants) {
      ctx.font = `600 10.5px ${RX_FONT}`;
      ctx.fillStyle = RX.grey;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText('GAINING SHARE', area.right - 4, area.top + 4);
      ctx.textBaseline = 'bottom';
      ctx.fillText('LOSING SHARE', area.right - 4, area.bottom - 4);
    }
    ctx.font = `500 11px ${RX_FONT}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const placed = [];
    const hits = b => placed.some(o => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y);
    const inside = b => b.x >= area.left && b.x + b.w <= area.right && b.y >= area.top && b.y + b.h <= area.bottom;
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      // largest points first, so the big brokers keep the spot beside their point; then the
      // first free spot to the right, then the left, stepping away from the point (with a leader line)
      meta.data.map((el, i) => ({ el, d: ds.data[i] })).sort((a, b) => (b.d.r || 0) - (a.d.r || 0)).forEach(({ el, d }) => {
        if (!d || !d.label) return;
        const r = (el.options && el.options.radius) || d.r || 4;
        const w = ctx.measureText(d.label).width, h = 12;
        let spot = null;
        for (const dy of [0, -13, 13, -26, 26, -39, 39]) {
          for (const side of [1, -1]) {
            const x = side > 0 ? el.x + r + 4 : el.x - r - 4 - w;
            const box = { x, y: el.y + dy - h / 2, w, h };
            if (inside(box) && !hits(box)) { spot = { box, dy, side }; break; }
          }
          if (spot) break;
        }
        if (!spot) spot = { box: { x: el.x + r + 4, y: el.y - h / 2, w, h }, dy: 0, side: 1 };
        placed.push(spot.box);
        if (spot.dy) {
          ctx.strokeStyle = RX.light;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(el.x + spot.side * r * 0.7, el.y + Math.sign(spot.dy) * r * 0.7);
          ctx.lineTo(spot.side > 0 ? spot.box.x - 1 : spot.box.x + w + 1, el.y + spot.dy);
          ctx.stroke();
        }
        ctx.fillStyle = RX.ink2;
        ctx.fillText(d.label, spot.box.x, el.y + spot.dy);
      });
    });
    ctx.restore();
  },
};

function mtfMeasureChip(measure) {
  const [label, kind, title] = MTF_MEASURE_CHIPS[measure] || [measure, '', ''];
  return `<span title="${escHtml(title)}">${rxChip(escHtml(label), kind)}</span>`;
}

// "▲ +0.42 pp" (green) / "▼ −0.30 pp" (red); † when the two dates straddle a series change
function mtfPpHTML(pp, from, to, digits = 2) {
  if (pp == null || !isFinite(pp)) return '—';
  pp = +pp.toFixed(digits);                 // a move that rounds to 0 is no move
  const cls = pp > 0 ? 'rx-up' : pp < 0 ? 'rx-dn' : '';
  const txt = pp > 0 ? `▲ +${pp.toFixed(digits)}` : pp < 0 ? `▼ −${Math.abs(pp).toFixed(digits)}` : (0).toFixed(digits);
  return `<span class="${cls}">${txt} pp</span>${mtfBreakMark('combined', from, to)}`;
}

// "30 Sep 26" for table cells; "Jun 26" for the month of a comparison
function mtfShortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${+m[3]} ${MTF_MONTHS[+m[2] - 1]} ${m[1].slice(2)}` : '—';
}
function mtfShortMonth(iso) {
  const m = /^(\d{4})-(\d{2})/.exec(iso || '');
  return m ? `${MTF_MONTHS[+m[2] - 1]} ${m[1].slice(2)}` : '';
}

// "5 mo" (short) / "5 months old" chip for a figure older than MTF_BROKER_STALE_DAYS, else ''
function mtfAgeChip(p, todayIso, long = false) {
  if (!mtfBrokerStale(p, todayIso)) return '';
  const mo = Math.round(mtfDaysAfter(p.as_of, todayIso) / 30.4);
  return rxChip(long ? `${mo} months old` : `${mo} mo`, 'warn');
}

// A figure's document: "Title · p.40 ↗", or with `short` just "p.40 ↗" (the title in its label)
function mtfBrokerLink(p, short = false) {
  if (!p || !p.url) return '';
  const name = p.source || 'Document';
  const page = p.page ? ` · p.${p.page}` : '';
  return short
    ? `<a href="${escHtml(p.url)}" target="_blank" rel="noopener noreferrer" title="${escHtml(name + page)}" aria-label="${escHtml(`${name}${p.page ? `, page ${p.page}` : ''} (opens in a new tab)`)}">${p.page ? `p.${p.page}` : 'doc'}&nbsp;↗</a>`
    : `<a href="${escHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escHtml(name)}${page}&nbsp;↗</a>`;
}

// ── League table: one line per broker, the share as a bar with a tick at the earlier figure;
// a row opens to its source, the quoted words, both comparisons and the figures before it

function mtfBrokerDetail(doc, r, todayIso) {
  const p = r.latest;
  if (!p) return '<p>No figure on its main measure yet.</p>';
  const shareOf = v => mtfShareText({ ...p, share_pct: v });
  const cmpLine = (cmp, label) => {
    const c = mtfBrokerCompare(r, cmp);
    if (!c) return `<li>${label}: no figure on the same measure</li>`;
    const book = c.bookPct != null
      ? `; book ${rxSignedPct(c.bookPct)}${c.bookChg != null ? ` (${c.bookChg >= 0 ? '+' : '−'}${rxCr(Math.abs(c.bookChg), 0)})` : ''}` : '';
    return `<li>${label}, ${rxDate(c.from)}: ${shareOf(c.then)} → ${shareOf(c.now)}, ${mtfPpHTML(c.pp, c.from, c.to, p.precision === 'integer' ? 0 : 2)}${book}</li>`;
  };
  const earlier = r.history.length
    ? `<ul>${r.history.map(h => `<li>${rxDate(h.as_of)}: ${mtfBookText(h)} · ${mtfShareText(h)}</li>`).join('')}</ul>` : '<p>None before it.</p>';
  const alts = r.alts.map(a => `<li>${escHtml((MTF_MEASURE_CHIPS[a.measure] || [a.measure])[0])}${MTF_BASIS_LABELS[a.basis] ? `, ${MTF_BASIS_LABELS[a.basis]}` : ''}: ${
    mtfBookText(a)} (${mtfShareText(a)}) · ${rxDate(a.as_of)}${a.url ? ` · ${mtfBrokerLink(a, true)}` : ''}</li>`).join('');
  return `<div class="mtf-bk-dgrid">
    <div><div class="rx-lbl">The figure</div>
      <p><b>${escHtml(r.name)}</b>${r.parent ? ` · ${escHtml(r.parent)}` : ''}</p>
      <p>${mtfBookText(p)} · ${mtfShareText(p)} of the NSE + BSE book on ${rxDate(p.as_of)} ${mtfAgeChip(p, todayIso, true)}</p>
      <p>${mtfMeasureChip(p.measure)}${MTF_BASIS_LABELS[p.basis] ? ` ${rxChip(MTF_BASIS_LABELS[p.basis])}` : ''} ${escHtml((doc.measures || {})[p.measure] || '')}</p></div>
    <div><div class="rx-lbl">Source</div>
      <p>${mtfBrokerLink(p) || escHtml(p.source || '—')}</p>
      ${p.quote ? `<blockquote>“${escHtml(p.quote)}”</blockquote>` : ''}
      ${p.note ? `<p class="mtf-bk-note">${escHtml(p.note)}</p>` : ''}</div>
    <div><div class="rx-lbl">Changes, on the same measure</div>
      <ul>${cmpLine('chg', 'Since the previous figure')}${cmpLine('yoy', 'Since a year earlier')}</ul>
      <div class="rx-lbl">Earlier figures</div>${earlier}
      ${alts ? `<div class="rx-lbl">Other measures</div><ul>${alts}</ul>` : ''}</div>
  </div>`;
}

const MTF_CHEVRON = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

// `ranked`: mtfBrokerRows (share order, which # shows whatever the sort); `sort`: {key, dir};
// `cmp`: 'chg' / 'yoy'; `open`: ids whose details are shown
function mtfBrokerLeague(doc, ranked, todayIso, sort, cmp, open) {
  const rank = new Map(ranked.map((r, i) => [r.id, i + 1]));
  const rows = mtfBrokerSort(ranked, sort.key, sort.dir, cmp);
  const scale = Math.max(1, ...ranked.map(r => mtfNum(r.latest && r.latest.share_pct)),
    ...ranked.map(r => { const c = mtfBrokerCompare(r, cmp); return c ? c.then : -1; }));
  const pct = v => `${Math.max(0, Math.min(100, v / scale * 100)).toFixed(2)}%`;
  // the date most figures share is muted; any other date stands out
  const counts = new Map();
  ranked.forEach(r => { if (r.latest) counts.set(r.latest.as_of, (counts.get(r.latest.as_of) || 0) + 1); });
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
  const body = rows.map(r => {
    const p = r.latest;
    const st = mtfBrokerStyle(doc, r.id);
    const c = mtfBrokerCompare(r, cmp);
    const stale = mtfBrokerStale(p, todayIso);
    const share = p && p.share_pct != null && isFinite(p.share_pct)
      ? `<div class="mtf-bk-barcell"><span class="mtf-bk-val">${mtfShareText(p)}</span><span class="mtf-bk-track">`
        + `<span class="mtf-bk-fill${stale ? ' is-stale' : ''}" style="width:${pct(p.share_pct)};background-color:${st.color}"></span>${
          c ? `<span class="mtf-bk-tick" style="left:${pct(c.then)}" title="${escHtml(`${mtfShareText({ ...p, share_pct: c.then })} on ${rxDate(c.from)}`)}"></span>` : ''}</span></div>`
      : '—';
    const move = c
      ? `${mtfPpHTML(c.pp, c.from, c.to, p.precision === 'integer' ? 0 : 2)} <span class="mtf-bk-since" title="${escHtml(`vs ${rxDate(c.from)}`)}">${mtfShortMonth(c.from)}</span>`
      : '<span class="mtf-bk-none" title="No figure on the same measure to compare with">—</span>';
    const id = `mtf-bk-d-${r.id}`;
    const isOpen = open.has(r.id);
    return `<tr class="mtf-bk-row${isOpen ? ' is-open' : ''}" data-bk="${escHtml(r.id)}">
      <td class="mtf-ph-hide mtf-bk-rank">${rank.get(r.id)}</td>
      <td class="rx-l mtf-bk-name"><i class="mtf-bk-sw${st.dash.length ? ' mtf-bk-sw--dash' : ''}" style="color:${st.color}"></i><b>${escHtml(r.short)}</b>${
        p ? ` <span class="mtf-ph-hide">${mtfMeasureChip(p.measure)}</span>` : ''}${stale ? ` <span class="mtf-ph-only">${mtfAgeChip(p, todayIso)}</span>` : ''}</td>
      <td class="mtf-bk-sharecell">${share}</td>
      <td class="mtf-bk-move">${move}</td>
      <td class="mtf-ph-hide rx-strong">${p ? mtfBookText(p) : '—'}</td>
      <td class="mtf-ph-hide">${c && c.bookPct != null ? rxSignedPct(c.bookPct) : '—'}</td>
      <td class="mtf-ph-hide mtf-bk-asof${p && p.as_of !== common ? ' is-odd' : ''}">${p ? mtfShortDate(p.as_of) : '—'}${stale ? ` ${mtfAgeChip(p, todayIso)}` : ''}</td>
      <td class="mtf-ph-hide mtf-bk-doc">${p ? mtfBrokerLink(p, true) : ''}</td>
      <td class="mtf-bk-btn"><button type="button" class="mtf-bk-more" aria-expanded="${isOpen}" aria-controls="${id}" aria-label="Details for ${escHtml(r.short)}">${MTF_CHEVRON}</button></td>
    </tr>
    <tr class="mtf-bk-detail" id="${id}"${isOpen ? '' : ' hidden'}><td colspan="9">${mtfBrokerDetail(doc, r, todayIso)}</td></tr>`;
  }).join('');
  const th = (key, label, cls = '', title = '') => {
    const on = sort.key === key;
    return `<th scope="col" class="${cls}"${on ? ` aria-sort="${sort.dir < 0 ? 'descending' : 'ascending'}"` : ''}${title ? ` title="${escHtml(title)}"` : ''}>`
      + `<button type="button" class="mtf-bk-sort${on ? ' is-on' : ''}" data-sort="${key}">${label}</button></th>`;
  };
  const vs = cmp === 'yoy' ? 'vs a year earlier' : 'vs previous';
  return `<table class="rx-table mtf-bk-table">
    <thead>
      <tr><th scope="col" rowspan="2" class="mtf-ph-hide">#</th><th scope="col" rowspan="2" class="rx-l">Broker</th>
        <th scope="colgroup" colspan="2" class="mtf-bk-grp">Share of the NSE + BSE book</th>
        <th scope="colgroup" colspan="3" class="mtf-bk-grp mtf-ph-hide">The broker’s MTF book</th>
        <th scope="col" rowspan="2" class="mtf-ph-hide">Doc</th><th scope="col" rowspan="2"><span class="mtf-sr">Details</span></th></tr>
      <tr>${th('share', 'Share now', 'mtf-bk-sharecol')}${th('move', vs, '', 'Change in share, in percentage points, on the same measure')}${
        th('book', 'Book', 'mtf-ph-hide')}${th('bookchg', 'Change', 'mtf-ph-hide', `Change in the book ${vs}`)}${th('asof', 'As of', 'mtf-ph-hide')}</tr>
    </thead>
    <tbody>${body}</tbody></table>`;
}

// ── Size vs momentum: share now (x) against its change (y), bubble area ∝ book, labelled directly
function mtfDrawBrokerQuadrant(doc, ranked, todayIso, cmp, noteEl) {
  const pts = [], missing = [];
  ranked.forEach(r => {
    const c = mtfBrokerCompare(r, cmp);
    if (!c) { if (r.latest) missing.push(r.short); return; }
    pts.push({ row: r, c, color: mtfBrokerStyle(doc, r.id).color, stale: mtfBrokerStale(r.latest, todayIso) });
  });
  const maxBook = Math.max(1, ...pts.map(q => q.row.latest.book_cr || 0));
  // a symmetric y axis, so zero (no change) is the middle line, ending on a round step
  const raw = Math.max(0.4, ...pts.map(q => Math.abs(q.c.pp))) * 1.15;
  const step = raw <= 1 ? 0.25 : 0.5;
  const span = Math.ceil(raw / step) * step;
  const data = pts.map((q, i) => ({ x: q.c.now, y: q.c.pp, r: 4 + 14 * Math.sqrt(Math.max(0, q.row.latest.book_cr || 0) / maxBook), label: q.row.short, i }));
  rxChart('mtfBkQuad', 'mtfBkQuadChart', 320, {
    type: 'bubble',
    data: { datasets: [{ data,
      backgroundColor: pts.map(q => rxAlpha(q.color, q.stale ? 0.06 : 0.42)),
      borderColor: pts.map(q => q.color), borderWidth: pts.map(q => (q.stale ? 1.5 : 1)), hoverBorderWidth: 2 }] },
    plugins: [MTF_POINT_LABELS],
    options: {
      layout: { padding: { top: 6, right: 6 } },
      plugins: {
        mtfPointLabels: { quadrants: true },
        tooltip: { callbacks: {
          title: items => pts[items[0].raw.i].row.short,
          label: item => {
            const q = pts[item.raw.i], p = q.row.latest;
            return [` Share ${mtfShareText({ ...p, share_pct: q.c.then })} → ${mtfShareText(p)} (${q.c.pp >= 0 ? '+' : '−'}${Math.abs(q.c.pp).toFixed(2)} pp)`,
              ` Book ${mtfBookText(p)}${q.c.bookPct != null ? ` (${rxSignedPct(q.c.bookPct)})` : ''}`,
              ` ${rxDate(q.c.from)} → ${rxDate(p.as_of)}`];
          },
          footer: items => {
            const q = pts[items[0].raw.i];
            return `${(MTF_MEASURE_CHIPS[q.row.latest.measure] || [q.row.latest.measure])[0]}${q.stale ? ' · over 4 months old' : ''}${q.c.crosses ? ' · † across 1 Oct 2025' : ''}`;
          },
        } },
      },
      scales: {
        x: { beginAtZero: true, title: { display: true, text: 'Share of the NSE + BSE book now (%)' }, ticks: { callback: v => `${v} %` } },
        y: { min: -span, max: span, title: { display: true, text: `Change ${cmp === 'yoy' ? 'over a year' : 'since the previous figure'} (pp)` },
          grid: { color: c => (c.tick && c.tick.value === 0 ? RX.grey : RX.grid) },
          ticks: { stepSize: step, callback: v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(+v.toFixed(2))}` } },
      },
    },
  });
  noteEl.innerHTML = `Bubble area: the broker’s book. Hollow: a figure over 4 months old. Each change is on the broker’s own measure, between its own dates.${
    missing.length ? ` No figure ${cmp === 'yoy' ? 'a year earlier' : 'before the latest'} on the same measure: ${missing.map(escHtml).join(', ')}.` : ''}`;
}

// ── How to read: coverage, the measures and the marks used across the tab
function mtfBrokerReadHTML(doc, rows) {
  const mv = mtfBrokerMoves(doc);
  const m = doc.measures || {};
  const counts = {};
  rows.forEach(r => { const k = r.latest && r.latest.measure; if (k) counts[k] = (counts[k] || 0) + 1; });
  return `<div class="rx-pb mtf-bk-read">
    ${mv ? `<p><b>${mv.cur.tracked_n} of ${rows.length}</b> brokers have a figure for ${escHtml(mv.cur.label)}, together <b>${mv.cur.tracked_pct.toFixed(1)} %</b> of the NSE + BSE book, on mixed measures.</p>` : ''}
    <div class="rx-lbl">Each broker reports its own measure</div>
    <ul>${Object.keys(MTF_MEASURE_CHIPS).filter(k => counts[k]).map(k => `<li>${mtfMeasureChip(k)} <b>${counts[k]}</b> · ${escHtml(m[k] || MTF_MEASURE_CHIPS[k][2])}</li>`).join('')}</ul>
    <div class="rx-lbl">Marks</div>
    <ul class="mtf-bk-keys">
      <li><i class="mtf-bk-key-tick"></i>the share at the earlier figure, on the same measure</li>
      <li><i class="mtf-bk-key-stale"></i>a figure over 4 months old (hollow in the chart)</li>
      <li><span class="mtf-dagger">†</span> the change spans 1 Oct 2025, when brokers moved to gross reporting and NSE’s book stepped up 7 %</li>
      <li>≈ derived from a published share · ~ rounded in the document</li>
    </ul>
  </div>`;
}

// ── Small multiples: each broker's share (or book) at each figure, one panel each, same time axis
function mtfDrawBrokerSmall(doc, ranked, todayIso, grid, metaEl) {
  const metric = MTF.bMetric, same = MTF.bScale === 'same';
  const series = ranked.map(r => {
    const b = doc.brokers.find(x => x.id === r.id);
    return { r, st: mtfBrokerStyle(doc, r.id), pts: mtfBrokerPoints(b, metric) };
  }).filter(x => x.pts.length);
  Object.keys(charts).filter(k => k.startsWith('mtfBkSm-')).forEach(k => { charts[k].destroy(); delete charts[k]; });
  if (!series.length) { grid.innerHTML = '<div class="rx-empty">No figures yet.</div>'; return; }
  const xs = series.flatMap(x => x.pts.map(q => q.x));
  const xmin = Math.min(...xs) - 30 * 864e5, xmax = Math.max(...xs) + 30 * 864e5;
  const ymax = Math.max(...series.flatMap(x => x.pts.map(q => q.y)));
  const years = [];
  for (let y = new Date(xmin).getUTCFullYear() + 1; Date.UTC(y, 0, 1) <= xmax; y++) years.push(Date.UTC(y, 0, 1));
  const breaks = [...new Set(mtfNotesFor('combined', 'break').map(n => n.date))];
  const fmtV = v => (metric === 'book' ? (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : fmtNum(v, 0)) : `${+v.toFixed(1)} %`);
  metaEl.textContent = `${metric === 'book' ? '₹ Cr' : '% of the NSE + BSE book'} · each disclosed figure, ${rxDate(new Date(Math.min(...xs)).toISOString())} to ${rxDate(new Date(Math.max(...xs)).toISOString())}`;
  grid.innerHTML = series.map(x => {
    const p = x.r.latest;
    return `<div class="mtf-bk-card">
      <div class="mtf-bk-card-h"><i class="mtf-bk-sw" style="color:${x.st.color}"></i><b title="${escHtml(x.r.name)}">${escHtml(x.r.short)}</b>
        <span class="mtf-bk-card-v">${p ? (metric === 'book' ? mtfBookText(p) : mtfShareText(p)) : '—'}</span></div>
      <div class="mtf-bk-card-s">${p ? mtfMeasureChip(p.measure) : ''}<span>${p ? mtfShortDate(p.as_of) : ''}</span>${p ? mtfAgeChip(p, todayIso) : ''}</div>
      ${rxCanvas(`mtfBkSm-${x.r.id}`)}</div>`;
  }).join('');
  series.forEach(x => {
    const ys = x.pts.map(q => q.y);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) * 0.2 || hi * 0.1 || 1;
    const key = `mtfBkSm-${x.r.id}`;
    rxChart(key, key, 86, {
      type: 'line',
      data: { datasets: [{ data: x.pts, borderColor: x.st.color, backgroundColor: x.st.color, borderWidth: 1.8,
        pointRadius: 2, pointHoverRadius: 4, tension: 0 }] },
      plugins: [MTF_BREAK_LINE],
      options: {
        animation: false,
        interaction: { mode: 'nearest', intersect: false },
        layout: { padding: { top: 4, right: 2 } },
        plugins: {
          mtfBreakLine: { dates: breaks },
          tooltip: { callbacks: { title: items => rxDate(items[0].raw.p.as_of), label: c => ` ${mtfShareText(c.raw.p)} · ${mtfBookText(c.raw.p)}` } },
        },
        scales: {
          x: { type: 'linear', min: xmin, max: xmax, grid: { display: true },
            afterBuildTicks: sc => { sc.ticks = years.map(v => ({ value: v })); },
            ticks: { maxRotation: 0, autoSkip: false, callback: v => `’${String(new Date(v).getUTCFullYear()).slice(2)}` } },
          y: Object.assign(same ? { min: 0, max: ymax * 1.05 } : { min: Math.max(0, lo - pad), max: hi + pad },
            { ticks: { maxTicksLimit: 3, includeBounds: false, callback: fmtV } }),
        },
      },
    });
    rxFixHeight(charts[key]);
  });
}

// ── Share by quarter end: a highlight table, each cell tinted by its change from the quarter before
function mtfBrokerQuarterTable(doc, rows) {
  const qs = doc.quarters || [];
  if (!qs.length) return '<div class="rx-empty">No quarter ends yet.</div>';
  const byId = Object.fromEntries((doc.brokers || []).map(b => [b.id, b]));
  const cell = (r, q, j) => {
    const v = q.shares[r.id];
    if (v == null) return '<td class="mtf-bk-none">—</td>';
    const p = mtfBrokerPrimary(byId[r.id]).find(x => x.as_of === q.end) || { share_pct: v };
    const prevQ = qs[j - 1];
    const pv = prevQ ? prevQ.shares[r.id] : null;
    if (pv == null) return `<td>${mtfShareText(p)}</td>`;
    const digits = p.precision === 'integer' ? 0 : 2;
    const pp = +(v - pv).toFixed(digits);
    const bg = pp ? `background:${rxAlpha(pp > 0 ? RX.pos : RX.neg, 0.05 + Math.min(Math.abs(pp), 1) * 0.2)}` : '';
    return `<td class="mtf-bk-hl"${bg ? ` style="${bg}"` : ''} title="${escHtml(`${pp > 0 ? '+' : pp < 0 ? '−' : '±'}${Math.abs(pp).toFixed(digits)} pp vs ${prevQ.label}`)}">${
      mtfShareText(p)}<span class="mtf-bk-qpp ${pp > 0 ? 'rx-up' : pp < 0 ? 'rx-dn' : ''}">${pp > 0 ? '+' : pp < 0 ? '−' : '±'}${Math.abs(pp).toFixed(digits)}</span>${
      mtfBreakMark('combined', prevQ.end, q.end)}</td>`;
  };
  const body = rows.map(r => {
    const st = mtfBrokerStyle(doc, r.id);
    return `<tr><td class="rx-l"><i class="mtf-bk-sw${st.dash.length ? ' mtf-bk-sw--dash' : ''}" style="color:${st.color}"></i>${escHtml(r.short)}${
      r.primary ? ` <span class="mtf-ph-hide">${mtfMeasureChip(r.primary.measure)}</span>` : ''}</td>${qs.map((q, j) => cell(r, q, j)).join('')}</tr>`;
  }).join('');
  return `<div class="rx-scroll" data-mtf="bkQtrWrap"><table class="rx-table mtf-bk-qtable">
    <thead><tr><th scope="col" class="rx-l">Broker</th>${qs.map(q => `<th scope="col">${escHtml(q.label)}<div class="mtf-bk-sub">${rxDate(q.end)}</div></th>`).join('')}</tr></thead>
    <tbody>${body}</tbody>
    <tfoot>
      <tr><td class="rx-l">NSE + BSE book</td>${qs.map(q => `<td>${rxCr(q.industry_cr, 0)}</td>`).join('')}</tr>
      <tr><td class="rx-l">Brokers with a figure · their total share</td>${qs.map(q => `<td>${q.tracked_n ? `${q.tracked_n} · ${q.tracked_pct.toFixed(1)} %` : '—'}</td>`).join('')}</tr>
    </tfoot></table></div>`;
}

function mtfBrokerSourcesHTML(doc, rows) {
  const cad = s => (s.cadence === 'irregular' ? 'irregular (rating rationales, posts)'
    : `${s.cadence}, about ${s.lag_days} days after the ${s.cadence === 'monthly' ? 'month' : 'quarter'}`);
  const table = `<div class="rx-scroll"><table class="rx-table mtf-bk-srcs"><thead><tr><th scope="col" class="rx-l">Broker</th><th scope="col" class="rx-l">Best source</th>
      <th scope="col" class="rx-l">How often</th><th scope="col" class="rx-l">What it reports</th><th scope="col" class="rx-l">Fallback</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td class="rx-l"><b>${escHtml(r.short)}</b></td><td class="rx-wrap">${escHtml(r.sources.primary)}<div class="mtf-bk-sub">${escHtml(r.sources.where)}</div></td>
        <td class="rx-wrap">${escHtml(cad(r.sources))}</td><td class="rx-wrap">${escHtml(r.sources.metric)}</td><td class="rx-wrap">${escHtml(r.sources.fallbacks || '—')}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="rx-pb mtf-about">
    <ul>
      <li><b>Market share</b> = a broker’s figure ÷ the exchanges’ combined MTF book (NSE’s closing book + BSE’s amount financed) on the same date: the last reporting date on or before a period-end figure, or the month’s average for a monthly average. Brokers’ own published shares use their own denominators; these do not.</li>
      <li><b>No exchange publishes broker-wise books</b> since NSE’s member-wise “Client Funding” report ended in Apr 2021. Every figure is from the broker’s or its parent’s own document, linked with its page and quoted in each row’s details.</li>
      <li>ICICI Securities and Kotak Securities publish a share, not a book: their book (≈) is that share of the NSE + BSE book. Kotak’s share is a whole number (“~14 %”), so its moves show as 0 until it changes by a point.</li>
      <li>Brokers publish on different dates and not every quarter, so the total share of the brokers with a figure mixes measures and leaves brokers out; it is not the top brokers’ share of the market.</li>
    </ul>
    <p class="rx-foot">Source: <code>dashboard/data/mtf_brokers.json</code>, written ${escHtml(rxDate(doc.updated_at || ''))} by <code>scripts/mtf_pipeline.py</code> from the hand-kept register <code>scripts/broker_mtf_register.py</code>.</p>
  </div>${rxHow('Where each broker’s figures come from', table)}`;
}

function mtfBuildBrokers(el) {
  const doc = MTF.brokers;
  const ranked = mtfBrokerRows(doc);
  if (!ranked.length) { el.innerHTML = mtfEmpty('Brokers', 'mtf_brokers.json is not available.'); return; }
  const todayIso = new Date().toISOString().slice(0, 10);
  const open = new Set();
  const name = id => escHtml((doc.brokers.find(b => b.id === id) || {}).short || id);
  el.innerHTML = `<div class="rx">
    <div class="rx-bar mtf-bk-bar" role="toolbar" aria-label="Brokers tab controls">
      <div class="rx-grp"><span class="rx-lbl">Compare with</span>${rxSeg('mtfBkCmp', [['chg', 'Previous figure'], ['yoy', 'A year earlier']], MTF.bCmp, 'Compare with')}</div>
      <p class="rx-foot">Each broker’s own figure, as a share of the NSE + BSE book on its date · register of ${rxDate(doc.updated_at || '')}</p>
    </div>
    <div data-mtf="bkKpis"></div>
    ${rxPanel({ title: 'Market share league', meta: 'latest figure per broker · click a row for its source, quote and history',
      right: `<div class="rx-legend mtf-bk-legend"><span><i class="mtf-bk-key-bar"></i>share now</span><span><i class="mtf-bk-key-tick"></i><span data-mtf="bkTickLbl"></span></span><span><i class="mtf-bk-key-stale"></i>over 4 months old</span></div>`
        + '<button type="button" class="rx-btn mtf-bk-all" data-mtf="bkAll" aria-pressed="false">Show all details</button>',
      body: '<div class="rx-scroll" data-mtf="bkLeague"></div>',
      foot: 'Changes compare figures on the same measure; † spans the 1 Oct 2025 series change. ≈ derived from a published share; ~ rounded in the document. Sort by any column.' })}
    <div class="mtf-bk-pair">
      ${rxPanel({ title: 'Size vs momentum', meta: '<span data-mtf="bkQuadMeta"></span>',
        body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas('mtfBkQuadChart')}</div><p class="rx-foot rx-pb" data-mtf="bkQuadNote"></p>` })}
      ${rxPanel({ title: 'Reading these figures', body: mtfBrokerReadHTML(doc, ranked) })}
    </div>
    ${rxPanel({ title: 'Share over time', meta: '<span data-mtf="bkSmMeta"></span>',
      right: `${rxSeg('mtfBkMetric', [['share', 'Share %'], ['book', 'Book ₹ Cr']], MTF.bMetric, 'Measure')}${rxSeg('mtfBkScale', [['own', 'Own scale'], ['same', 'Same scale']], MTF.bScale, 'Y scale')}`,
      body: '<div class="mtf-bk-grid" data-mtf="bkSmall"></div>',
      foot: 'One panel per broker, in league order, on the same time axis; the dotted line is 1 Oct 2025, when brokers moved to gross reporting. Own scale shows each broker’s trend; same scale compares their size.' })}
    ${rxPanel({ title: 'Share by quarter end', meta: 'main measure · each cell tinted by its change from the quarter before (green up, red down; deeper = larger, to 1 pp)',
      body: mtfBrokerQuarterTable(doc, ranked), foot: '— no figure for that date. Hover a cell for its change.' })}
    ${rxPanel({ title: 'Sources and method', body: mtfBrokerSourcesHTML(doc, ranked) })}
  </div>`;
  const q = k => el.querySelector(`[data-mtf="${k}"]`);

  const renderKpis = () => {
    const base = mtfBrokerMoves(doc);
    if (!base) { q('bkKpis').innerHTML = ''; return; }
    const { cur } = base;
    const mv = mtfBrokerMoves(doc, MTF.bCmp);
    const kpis = [
      rxKpi('NSE + BSE book', rxCr(cur.industry_cr, 0), `${escHtml(cur.label)} · ${rxDate(cur.end)}`, { accent: true }),
      rxKpi(`With a figure for ${escHtml(cur.label)}`, `${cur.tracked_n} of ${ranked.length}`, `brokers; together ${cur.tracked_pct.toFixed(1)} % of the book, on mixed measures`),
    ];
    if (mv && mv.moves.length) {
      const gain = mv.moves[0], loss = mv.moves[mv.moves.length - 1];
      const spanTxt = `${escHtml(mv.prev.label)} → ${escHtml(mv.cur.label)}`;
      kpis.push(rxKpi(`Biggest gain, ${spanTxt}`, gain.pp > 0 ? `<span class="rx-up">▲ +${gain.pp.toFixed(2)} pp</span>` : '—',
        gain.pp > 0 ? `<b>${name(gain.id)}</b> · ${gain.from.toFixed(2)} % → ${gain.to.toFixed(2)} %` : 'no broker gained share'));
      kpis.push(rxKpi(`Biggest loss, ${spanTxt}`, loss.pp < 0 ? `<span class="rx-dn">▼ −${Math.abs(loss.pp).toFixed(2)} pp</span>` : '—',
        loss.pp < 0 ? `<b>${name(loss.id)}</b> · ${loss.from.toFixed(2)} % → ${loss.to.toFixed(2)} %` : 'no broker lost share'));
    } else {
      kpis.push(rxKpi('Biggest gain', '—', 'no quarter end to compare with'), rxKpi('Biggest loss', '—', 'no quarter end to compare with'));
    }
    q('bkKpis').innerHTML = rxKpis(kpis, 'Brokers’ MTF share');
  };
  const renderLeague = () => {
    q('bkLeague').innerHTML = mtfBrokerLeague(doc, ranked, todayIso, MTF.bSort, MTF.bCmp, open);
    q('bkTickLbl').textContent = MTF.bCmp === 'yoy' ? 'a year earlier' : 'previous figure';
  };
  const renderQuad = () => {
    q('bkQuadMeta').textContent = `share now against its change ${MTF.bCmp === 'yoy' ? 'over a year' : 'since the previous figure'} · bubble = book`;
    mtfDrawBrokerQuadrant(doc, ranked, todayIso, MTF.bCmp, q('bkQuadNote'));
  };
  const renderSmall = () => mtfDrawBrokerSmall(doc, ranked, todayIso, q('bkSmall'), q('bkSmMeta'));
  renderKpis(); renderLeague(); renderQuad(); renderSmall();
  // quarters run oldest to latest: where the table scrolls (a phone), open it on the latest
  const qWrap = q('bkQtrWrap');
  if (qWrap) qWrap.scrollLeft = qWrap.scrollWidth;

  rxOnSeg(el, 'mtfBkCmp', v => { MTF.bCmp = v; renderKpis(); renderLeague(); renderQuad(); });
  rxOnSeg(el, 'mtfBkMetric', v => { MTF.bMetric = v; renderSmall(); });
  rxOnSeg(el, 'mtfBkScale', v => { MTF.bScale = v; renderSmall(); });
  el.onclick = e => {
    const sortBtn = e.target.closest('.mtf-bk-sort');
    if (sortBtn) {
      const key = sortBtn.dataset.sort;
      MTF.bSort = { key, dir: MTF.bSort.key === key ? -MTF.bSort.dir : -1 };
      renderLeague();
      el.querySelector(`.mtf-bk-sort[data-sort="${key}"]`)?.focus();
      return;
    }
    const all = e.target.closest('[data-mtf="bkAll"]');
    if (all) {
      const show = all.getAttribute('aria-pressed') !== 'true';
      open.clear();
      if (show) ranked.forEach(r => open.add(r.id));
      all.setAttribute('aria-pressed', String(show));
      all.textContent = show ? 'Hide details' : 'Show all details';
      renderLeague();
      return;
    }
    const row = e.target.closest('tr.mtf-bk-row');
    if (!row || e.target.closest('a')) return;
    const id = row.dataset.bk;
    const isOpen = !open.has(id);
    if (isOpen) open.add(id); else open.delete(id);
    row.classList.toggle('is-open', isOpen);
    row.querySelector('.mtf-bk-more')?.setAttribute('aria-expanded', String(isOpen));
    const detail = row.nextElementSibling;
    if (detail && detail.classList.contains('mtf-bk-detail')) detail.hidden = !isOpen;
  };
}

// Register the three views (MTF pill order = MTF_VIEW_DEFS order)
MTF_VIEW_DEFS.forEach(def => registerModeView('mtf', {
  id: def.id,
  label: `${def.name} MTF`,
  pill: def.pill,
  tabs: def.tabs.map(t => ({ id: t, label: MTF_TABS[t].label, icon: MTF_TABS[t].icon })),
  titles: {
    summary: `${def.name} MTF book: summary`,
    book: `${def.name} margin trading (MTF) book`,
    periods: `${def.name} MTF book by quarter / month`,
    flows: `${def.name} MTF flows`,
    stocks: `${def.name} MTF: top securities`,
    brokers: 'Brokers’ MTF books and market share',
  },
  load: owns => mtfLoad(def, owns),
  build: mtfBuild,
  onShow: mtfShow,
  meta: mtfMeta,
}));
