// dashboard/js/19-mcx-competition.js — Competition tab under the MCX view: NSE's share of
// India's commodity derivatives against MCX, per underlying, from data/nse_commodity_daily.json
// (scripts/nse_commodity_pipeline.py: NSE's commodity bhavcopy and MCX's per-commodity rows).
// Shares are taken per underlying in ₹ (futures notional, options notional, options premium),
// never per contract, since the two exchanges' contract sizes differ. A day counts only once
// both exchanges' figures are in (MCX's per-commodity rows land the next morning), and special
// sessions stay out. NSE's commodity transaction charges are a memo figure: never part of NSE's
// revenue elsewhere on the dashboard.

const CC_URL = './data/nse_commodity_daily.json';
const CC_MAX_AGE_MS = 15 * 60 * 1000;   // re-fetch when the tab is built after this long
const CC_DATA = { doc: null, at: 0 };
const CC_VIEW = { win: '20d', und: 'all', metric: 'prem', range: '1y', top: 'prem', topMonth: null, grow: 'prem' };   // topMonth null = the latest
const CC_WINDOWS = [['day', 'Latest day'], ['20d', '20 sessions'], ['mtd', 'Month'], ['qtd', 'Quarter'], ['fytd', 'FY']];
const CC_METRICS = [['prem', 'Options premium'], ['onot', 'Options notional'], ['fut', 'Futures notional']];
const CC_METRIC_TEXT = { prem: 'options premium', onot: 'options notional', fut: 'futures notional' };
const CC_RANGES = [['6m', '6 M', 6], ['1y', '1 Y', 12], ['all', 'All', null]];
const CC_CHART_UNDS = ['all', 'natgas', 'crude', 'gold', 'silver', 'electricity'];
const CC_ROLL = 20;                     // sessions in the rolling share line
// Top commodities by month: MCX's top five and every underlying NSE competes in, each with a
// fixed colour (validated for colour-blind separation), the rest as Others
const CC_TOP_UNDS = ['crude', 'gold', 'natgas', 'silver', 'copper', 'electricity'];
const CC_TOP_COLORS = { crude: '#2a78d6', gold: '#eb6834', natgas: '#1baf7a', silver: '#eda100',
  copper: '#e87ba4', electricity: '#6250d6', others: '#9A9DA4' };
const CC_TOP_METRICS = [['prem', 'Options premium'], ['rev', 'Transaction revenue'], ['con', 'Contracts']];
let ccBuildSeq = 0;

async function ccLoad() {
  if (CC_DATA.doc && Date.now() - CC_DATA.at < CC_MAX_AGE_MS) return;
  CC_DATA.doc = (await fetchDataFile(CC_URL)).json;
  CC_DATA.at = Date.now();
}

// One metric of one underlying ('all' = every underlying) in a compact day or period:
// cells are f = [contracts, notional ₹ Cr], o = [contracts, notional ₹ Cr, premium ₹ Cr | null]
function ccVal(side, und, metric) {
  if (!side) return null;
  const pick = cells => {
    if (!cells) return 0;
    if (metric === 'fut') return cells.f ? cells.f[1] : 0;
    if (!cells.o) return 0;
    return metric === 'onot' ? cells.o[1] : cells.o[2];
  };
  if (und !== 'all') return pick(side[und]);
  let t = 0;
  for (const k of Object.keys(side)) {
    const v = pick(side[k]);
    if (v == null) return null;
    t += v;
  }
  return t;
}

function ccSum(rows, side, und, metric) {
  let t = 0;
  for (const r of rows) {
    const v = ccVal(r[side], und, metric);
    if (v == null) return null;
    t += v;
  }
  return t;
}

// A day whose MCX file gives every option a premium of 0 though options traded (23 Jun 2026):
// its premium can't be compared, so premium shares and averages leave it out. The same rule
// as premium_out in scripts/nse_commodity_pipeline.py, which leaves such days out of the
// monthly and quarterly premium sums (prem_days). An unknown premium (null) is not 0.
function ccPremOk(r) {
  return !(ccVal(r.mcx, 'all', 'onot') > 0 && ccVal(r.mcx, 'all', 'prem') === 0);
}

// Sessions a period's per-session average divides by: for options premium the
// period's prem_days (files written before it existed: every session)
function ccPeriodDays(p, metric) {
  return metric === 'prem' ? (p.prem_days ?? p.days) : p.days;
}

// The rows a metric's share is taken over
function ccRowsFor(rows, metric) {
  return metric === 'prem' ? rows.filter(ccPremOk) : rows;
}

// NSE ÷ (NSE + MCX) over the rows' sums; null when unknown or neither traded
function ccShare(rows, und, metric) {
  rows = ccRowsFor(rows, metric);
  const n = ccSum(rows, 'nse', und, metric), m = ccSum(rows, 'mcx', und, metric);
  if (n == null || m == null || n + m <= 0) return null;
  return n / (n + m);
}

// Days with both exchanges' figures, special sessions left out
function ccDays(doc) {
  return (doc.daily || []).filter(r => !r.session && r.mcx);
}

function ccFy(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return m >= 4 ? y + 1 : y;
}

function ccQuarter(iso) {
  const m = +iso.slice(5, 7);
  return `${ccFy(iso)}-Q${m >= 4 ? Math.ceil((m - 3) / 3) : 4}`;
}

function ccQuarterLabel(key) {
  const [fy, q] = key.split('-');
  return `${q} FY ${fy}`;
}

function ccMonthLabel(ym) {
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
}

// The selected window and the one it is compared with
function ccWindow(days, win) {
  if (!days.length) return null;
  const last = days[days.length - 1].date;
  const by = fn => {
    const cur = fn(last), groups = [...new Set(days.map(r => fn(r.date)))];
    const prevKey = groups[groups.indexOf(cur) - 1];
    return { rows: days.filter(r => fn(r.date) === cur), prev: prevKey ? days.filter(r => fn(r.date) === prevKey) : [], key: cur, prevKey };
  };
  if (win === 'day') {
    return { rows: days.slice(-1), prev: days.slice(-2, -1), label: rxDate(last),
      prevLabel: days.length > 1 ? rxDate(days[days.length - 2].date) : '' };
  }
  if (win === '20d') {
    const rows = days.slice(-20), prev = days.slice(-40, -20);
    return { rows, prev, label: `${rxDate(rows[0].date)} – ${rxDate(last)}`, prevLabel: prev.length ? 'the 20 before' : '' };
  }
  if (win === 'mtd') {
    const w = by(d => d.slice(0, 7));
    return { ...w, label: `${ccMonthLabel(w.key)} to date`, prevLabel: w.prevKey ? ccMonthLabel(w.prevKey) : '' };
  }
  if (win === 'qtd') {
    const w = by(ccQuarter);
    return { ...w, label: `${ccQuarterLabel(w.key)} to date`, prevLabel: w.prevKey ? ccQuarterLabel(w.prevKey) : '' };
  }
  const w = by(ccFy);
  return { ...w, label: `FY ${w.key} to date`, prevLabel: w.prevKey ? `FY ${w.prevKey}` : '' };
}

// ₹ Cr with as many decimals as small figures need
function ccCr(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 0.0005) return `${v < 0 ? '−' : ''}<0.001`;   // would round to 0.000
  return fmtNum(v, a >= 1000 ? 0 : a >= 10 ? 1 : a >= 0.1 ? 2 : 3);
}

function ccPct(s) {
  if (s == null || !isFinite(s)) return '—';
  const p = s * 100;
  return `${p === 0 ? '0' : p < 0.0005 ? '<0.001' : p < 0.1 ? p.toFixed(3) : p < 1 ? p.toFixed(2) : p.toFixed(1)} %`;
}

// A change in percentage points as text, and whether it shows as a move (not rounded to 0)
function ccPpText(d) {
  const digits = Math.abs(d) < 0.1 ? 3 : 2;
  const t = Math.abs(d).toFixed(digits);
  if (+t === 0) return { text: '0 pp', moved: false };
  return { text: `${d > 0 ? '+' : '−'}${t} pp`, moved: true };
}

// Change in percentage points, coloured; `cls` adds a class to the cell
function ccPp(cur, prev, cls = '') {
  if (cur == null || prev == null) return `<td${cls ? ` class="${cls}"` : ''}>—</td>`;
  const d = (cur - prev) * 100, t = ccPpText(d);
  const c = [cls, t.moved ? (d > 0 ? 'rx-up' : 'rx-dn') : ''].filter(Boolean).join(' ');
  return `<td${c ? ` class="${c}"` : ''}>${t.text}</td>`;
}

// Monthly bars: the latest month is to date, so it is drawn lighter with an outline
function ccToDateBars(color, n) {
  return {
    backgroundColor: Array.from({ length: n }, (_, i) => (i === n - 1 ? rxAlpha(color, 0.4) : color)),
    borderColor: color,
    borderWidth: Array.from({ length: n }, (_, i) => (i === n - 1 ? 1.5 : 0)),
  };
}

// A month's tooltip title, naming the latest month as to date
function ccMonthTitle(months, i) {
  return `${ccMonthLabel(months[i].month)}${i === months.length - 1 ? ' to date' : ''}`;
}

// The next 1, 2, 2.5 or 5 × 10ⁿ at or above v (v > 0), for an axis maximum
function ccNiceCeil(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  const f = [1, 2, 2.5, 5, 10].find(s => s * p >= v - 1e-12);
  return +(f * p).toPrecision(6);
}

function ccLabel(doc, und) {
  if (und === 'all') return 'All commodities';
  const u = (doc.underlyings || []).find(x => x.key === und);
  return u ? u.label : und;
}

function ccMonthTicks(dates, max) {
  const starts = dates.reduce((a, d, i) => (i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7) ? a.concat(i) : a), []);
  const step = Math.max(1, Math.ceil(starts.length / max));
  const keep = new Set(starts.filter((_, k) => k % step === 0));
  return scale => { scale.ticks = scale.ticks.filter(t => keep.has(t.value)); };
}

// One underlying's value in a monthly period, for the top-commodities view: options premium
// (₹ Cr), transaction revenue (₹ Cr, p.ru) or contracts (futures + options); 'others' sums every
// underlying outside CC_TOP_UNDS, 'all' every underlying. null when unknown.
function ccTopVal(p, side, und, metric) {
  const cells = p[side] || {};
  const keys = und === 'all' ? Object.keys(metric === 'rev' ? (p.ru?.[side] || {}) : cells)
    : und === 'others' ? Object.keys(metric === 'rev' ? (p.ru?.[side] || {}) : cells).filter(k => !CC_TOP_UNDS.includes(k))
    : [und];
  let t = 0;
  for (const k of keys) {
    let v;
    if (metric === 'rev') {
      if (!p.ru || !p.ru[side]) return null;
      v = p.ru[side][k] || 0;
    } else if (metric === 'con') {
      const c = cells[k] || {};
      v = (c.f ? c.f[0] : 0) + (c.o ? c.o[0] : 0);
    } else {
      const c = cells[k] || {};
      v = c.o ? c.o[2] : 0;
    }
    if (v == null) return null;
    t += v;
  }
  return t;
}

// Sessions behind a period's figure: revenue counts only the days it could be split for
function ccTopDays(p, side, metric) {
  return metric === 'rev' ? (p.ru_days?.[side] ?? 0) : ccPeriodDays(p, metric);
}

// Per-session value in display units
function ccTopPer(p, side, und, metric) {
  const v = ccTopVal(p, side, und, metric), n = ccTopDays(p, side, metric);
  return v == null || !n ? null : v / n;
}

// Display unit for a chart whose largest stacked bar is `max` (per session, ₹ Cr or contracts)
function ccTopUnit(metric, max) {
  if (metric === 'con') return { k: 1e-5, axis: 'lakh contracts a session', fmt: v => `${ccCr(v)} lakh` };
  if (max < 1) return { k: 100, axis: '₹ lakh a session', fmt: v => `₹${ccCr(v)} lakh` };
  return { k: 1, axis: '₹ Cr a session', fmt: v => `₹${ccCr(v)} Cr` };
}

// Rank of `und` among every underlying an exchange traded in the period (1 = largest); null if none
function ccTopRank(p, side, und, metric) {
  const keys = Object.keys(metric === 'rev' ? (p.ru?.[side] || {}) : (p[side] || {}));
  const vals = keys.map(k => [k, ccTopVal(p, side, k, metric) || 0]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const i = vals.findIndex(([k]) => k === und);
  return i < 0 ? null : i + 1;
}

function ccTopTableHTML(doc, months, idx, metric) {
  const p = months[idx], prev = months[idx - 1];
  const money = metric !== 'con';
  const tot = side => ccTopPer(p, side, 'all', metric);
  const allM = tot('mcx'), allN = tot('nse');
  const unitM = ccTopUnit(metric, allM || 0), unitN = ccTopUnit(metric, allN || 0);
  const share = (q, und) => {
    if (!q || !money) return null;
    const n = ccTopVal(q, 'nse', und, metric), m = ccTopVal(q, 'mcx', und, metric);
    return n == null || m == null || n + m <= 0 ? null : n / (n + m);
  };
  const rank = r => (r == null ? '—' : r <= 5 ? `<b>#${r}</b>` : `#${r}`);
  const row = (und, label, cls = '') => {
    const m = ccTopPer(p, 'mcx', und, metric), n = ccTopPer(p, 'nse', und, metric);
    const solo = und !== 'all' && und !== 'others';
    const s = share(p, und);
    return `<tr${cls ? ` class="${cls}"` : ''}>
      <td class="rx-l"><i class="cc-sw" style="background:${CC_TOP_COLORS[und] || 'transparent'}"></i>${escHtml(label)}</td>
      <td>${m == null ? '—' : unitM.fmt(m * unitM.k)}</td><td>${m == null || !allM ? '—' : ccPct(m / allM)}</td><td>${solo ? rank(ccTopRank(p, 'mcx', und, metric)) : ''}</td>
      <td>${n == null ? '—' : unitN.fmt(n * unitN.k)}</td><td>${n == null || !allN ? '—' : ccPct(n / allN)}</td><td>${solo ? rank(ccTopRank(p, 'nse', und, metric)) : ''}</td>
      ${money ? `<td class="rx-hl">${ccPct(s)}</td>${ccPp(s, prev && s != null ? share(prev, und) : null)}` : ''}
    </tr>`;
  };
  const body = CC_TOP_UNDS.map(k => row(k, ccLabel(doc, k))).join('') + row('others', 'Others') + row('all', 'All commodities', 'rx-sub');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead>
      <tr><th scope="col" class="rx-l" rowspan="2">Underlying</th>
        <th scope="colgroup" colspan="3">MCX</th><th scope="colgroup" colspan="3">NSE</th>
        ${money ? '<th scope="col" rowspan="2" class="rx-hl">NSE share</th><th scope="col" rowspan="2">vs month before</th>' : ''}</tr>
      <tr><th scope="col">A session</th><th scope="col" title="Share of the exchange's own total">Mix</th><th scope="col" title="Rank among every underlying the exchange traded">Rank</th>
        <th scope="col">A session</th><th scope="col" title="Share of the exchange's own total">Mix</th><th scope="col" title="Rank among every underlying the exchange traded">Rank</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// ── MCX revenue at risk ──────────────────────────────────────────────────────────────────
// Each session, NSE's commodity futures notional and options premium priced at MCX's own rates
// that session (its reported fut_rev ÷ its futures notional, opt_rev ÷ its options premium, from
// MCX's dashboard rows) is the ceiling: what MCX would earn had every NSE trade been on MCX. NSE's
// options premium is split by when it traded: an underlying's NSE options expiry day and the NSE
// session before it (the expiry window, xo in the file; NSE's crude options expire about a week
// before MCX's and most of NSE's volume comes then) against every other session (ordinary days;
// futures always count there). The estimated loss applies an assumed share that would otherwise
// have traded on MCX to each part (CC_SUB_DEFAULTS, overridable per browser).
const CC_SUB_DEFAULTS = { ord: 100, exp: 30 };   // valuation_inputs.json exchanges.mcx.competition overrides these
const CC_SUB_KEY = 'mcx_competition_subs_v1';

// {date: Set of underlyings in their NSE options expiry window}, and whether each date's
// window is known: a day read before parser 2 has no xo, and a day's "day before" status
// needs the next session's file (so the latest day's is provisional until then)
function ccExpiryWindow(daily) {
  const win = new Map(), known = new Map();
  const ok = r => (r.parser || 1) >= 2;
  daily.forEach((r, i) => {
    const next = daily[i + 1];
    known.set(r.date, ok(r) && (!next || ok(next)));
    for (const u of r.xo || []) {
      for (const d of [r.date, i > 0 ? daily[i - 1].date : null]) {
        if (!d) continue;
        if (!win.has(d)) win.set(d, new Set());
        win.get(d).add(u);
      }
    }
  });
  return { win, known };
}

// One session: { fut, optOrd, optExp, known, mcx, mcxOpt, mcxPrem, nse } in ₹ Cr, or null when
// MCX's row, its futures notional or options premium (0 on 23 Jun 2026), or NSE's premium is missing
function ccRiskDay(r, m, ew) {
  const mFut = ccVal(r.mcx, 'all', 'fut'), mPrem = ccVal(r.mcx, 'all', 'prem');
  const nFut = ccVal(r.nse, 'all', 'fut'), nPrem = ccVal(r.nse, 'all', 'prem');
  if (!m || !(mFut > 0) || !(mPrem > 0) || nFut == null || nPrem == null) return null;
  const futRate = (m.fut_rev || 0) / mFut, optRate = (m.opt_rev || 0) / mPrem;
  const unds = (ew && ew.win.get(r.date)) || new Set();
  let expPrem = 0;
  for (const u of unds) expPrem += ccVal(r.nse, u, 'prem') || 0;
  return {
    fut: nFut * futRate, optOrd: (nPrem - expPrem) * optRate, optExp: expPrem * optRate,
    known: !!(ew && ew.known.get(r.date)), mcx: (m.fut_rev || 0) + (m.opt_rev || 0),
    mcxOpt: m.opt_rev || 0, mcxPrem: mPrem, nse: r.rev[0], nsePrem: nPrem,
  };
}

// Sums over `rows`: { days, ceil, ord, exp (null unless every day's split is known), unknown,
// mcx, mcxOpt, mcxPrem, nse, nsePrem }, ₹ Cr over the sessions counted
function ccRiskSum(rows, byDate, ew) {
  const t = { days: 0, ceil: 0, ord: 0, exp: 0, unknown: 0, mcx: 0, mcxOpt: 0, mcxPrem: 0, nse: 0, nsePrem: 0 };
  for (const r of rows) {
    const x = ccRiskDay(r, byDate.get(r.date), ew);
    if (!x) continue;
    t.days += 1;
    t.ceil += x.fut + x.optOrd + x.optExp;
    t.ord += x.fut + x.optOrd;
    t.exp += x.optExp;
    if (!x.known) t.unknown += 1;
    for (const k of ['mcx', 'mcxOpt', 'mcxPrem', 'nse', 'nsePrem']) t[k] += x[k];
  }
  if (t.unknown) { t.ord = null; t.exp = null; }
  return t;
}

// Estimated loss (₹ Cr over the sessions) at substitution shares sub = { ord, exp } in %; null
// when the split is unknown
function ccRiskLoss(t, sub) {
  return t.ord == null ? null : t.ord * sub.ord / 100 + t.exp * sub.exp / 100;
}

// A year of a per-session loss: { rev, pat, eps, value } from MCX's sessions, PAT margin (%),
// shares (Cr) and P/E; eps and value null without shares
function ccRiskYear(perDay, days, marginPct, shares, pe) {
  const rev = perDay * days, pat = rev * marginPct / 100;
  const eps = shares > 0 ? pat / shares : null;
  return { rev, pat, eps, value: eps == null ? null : eps * pe };
}

function ccRiskByMonth(days, mcxDaily, ew) {
  const byDate = new Map((mcxDaily || []).map(r => [r.date, r]));
  const groups = new Map();
  for (const r of days) {
    const k = r.date.slice(0, 7);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, rows]) => ({ month, ...ccRiskSum(rows, byDate, ew) })).filter(p => p.days > 0);
}

// This browser's substitution shares over the defaults ({ ord, exp } in %, 0–100)
function ccSubs(defaults) {
  const out = { ...defaults };
  try {
    const o = JSON.parse(localStorage.getItem(CC_SUB_KEY) || 'null') || {};
    for (const k of ['ord', 'exp']) if (typeof o[k] === 'number' && o[k] >= 0 && o[k] <= 100) out[k] = o[k];
  } catch (e) { /* storage blocked or unreadable: the defaults */ }
  return out;
}

function ccSubsSave(sub, defaults) {
  try {
    const o = {};
    for (const k of ['ord', 'exp']) if (sub[k] !== defaults[k]) o[k] = sub[k];
    if (Object.keys(o).length) localStorage.setItem(CC_SUB_KEY, JSON.stringify(o));
    else localStorage.removeItem(CC_SUB_KEY);
  } catch (e) { /* storage blocked: not remembered */ }
}

// ── Market growth or share shift ─────────────────────────────────────────────────────────
// Measures: [key, label, underlying, metric]; per-session averages in ₹ Cr
const CC_GROW_MEASURES = [['prem', 'Options premium', 'all', 'prem'], ['crude', 'Crude options premium', 'crude', 'prem'],
  ['fut', 'Futures notional', 'all', 'fut']];

// Shift-share of MCX's change between two sets of sessions (per-session averages):
// MCX = market × (1 − NSE share), so MCX's change = market effect (the market's change at
// the old share) + share effect (the share NSE gained, at the new market size). The share
// effect is the most NSE could have taken from MCX: it treats all of NSE's gain as MCX's loss.
// null when either side has no sessions or no market.
function ccShiftShare(rows0, rows1, und, metric) {
  rows0 = ccRowsFor(rows0, metric); rows1 = ccRowsFor(rows1, metric);
  if (!rows0.length || !rows1.length) return null;
  const avg = (rows, side) => { const v = ccSum(rows, side, und, metric); return v == null ? null : v / rows.length; };
  const n0 = avg(rows0, 'nse'), m0 = avg(rows0, 'mcx'), n1 = avg(rows1, 'nse'), m1 = avg(rows1, 'mcx');
  if ([n0, m0, n1, m1].some(v => v == null) || !(n0 + m0 > 0) || !(n1 + m1 > 0)) return null;
  return ccShiftFrom(n0, m0, n1, m1);
}

function ccShiftFrom(n0, m0, n1, m1) {
  const M0 = n0 + m0, M1 = n1 + m1, s0 = n0 / M0, s1 = n1 / M1;
  return { n0, m0, n1, m1, M0, M1, s0, s1, mkt: (M1 - M0) * (1 - s0), shr: -M1 * (s1 - s0) };
}

// Each month against the same month a year earlier (per-session averages over the period's
// sessions; options premium over prem_days): [{ month, base, ss }], months with a year-earlier month only
function ccShiftYoY(months, und, metric) {
  const by = new Map(months.map(p => [p.month, p]));
  const per = (p, side) => { const v = ccVal(p[side], und, metric), n = ccPeriodDays(p, metric); return v == null || !n ? null : v / n; };
  const out = [];
  for (const p of months) {
    const base = by.get(`${+p.month.slice(0, 4) - 1}${p.month.slice(4)}`);
    if (!base || !p.mcx || !base.mcx) continue;
    const v = [per(base, 'nse'), per(base, 'mcx'), per(p, 'nse'), per(p, 'mcx')];
    if (v.some(x => x == null) || !(v[1] > 0) || !(v[0] + v[1] > 0)) continue;
    out.push({ month: p.month, base: base.month, ss: ccShiftFrom(...v) });
  }
  return out;
}

// NSE's options expiries on `und` (xo) and MCX's volume around them: for each expiry in `days`
// (sessions with both exchanges' figures), MCX's premium on the expiry day and the session before
// as a multiple of its median over up to `span` sessions either side (the two left out), NSE's
// premium those days as a share of that median, and the same multiple for `placebo` (an MCX
// commodity NSE barely trades), to tell a busy day for everything from one for `und` alone.
function ccExpiryEvents(days, und = 'crude', placebo = 'gold', span = 7) {
  const prem = (r, side, u) => ccVal(r[side], u, 'prem');
  const median = a => { const b = a.filter(x => x != null && x > 0).sort((x, y) => x - y); return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : null; };
  const out = [];
  days.forEach((r, i) => {
    if (!(r.xo || []).includes(und) || i < 1 || !ccPremOk(r) || !ccPremOk(days[i - 1])) return;
    const ctrl = days.slice(Math.max(0, i - 1 - span), i - 1).concat(days.slice(i + 1, i + 1 + span)).filter(ccPremOk);
    const base = median(ctrl.map(x => prem(x, 'mcx', und))), pb = median(ctrl.map(x => prem(x, 'mcx', placebo)));
    if (!base) return;
    const at = x => ({ mcx: prem(x, 'mcx', und) / base, nse: prem(x, 'nse', und) / base,
      placebo: pb ? prem(x, 'mcx', placebo) / pb : null });
    out.push({ date: r.date, before: at(days[i - 1]), expiry: at(r), ctrl: ctrl.length });
  });
  return out;
}

function ccPanelEmpty(msg) {
  return rxPanel({ title: 'Competition', body: `<div class="rx-empty"><b>${msg}</b></div>` });
}

function ccTableHTML(doc, w) {
  const n = w.rows.length || 1;
  const premRows = ccRowsFor(w.rows, 'prem'), nPrem = premRows.length;   // premium averages skip days MCX's premium is 0
  const keys = ['all'].concat((doc.underlyings || []).map(u => u.key));
  const rows = keys.filter(k => {
    if (k === 'all') return true;
    return ['fut', 'onot'].some(m => (ccSum(w.rows, 'nse', k, m) || 0) + (ccSum(w.rows, 'mcx', k, m) || 0) > 0);
  }).map(k => {
    const cell = (m, side, rows, cnt) => { if (!cnt) return null; const s = ccSum(rows, side, k, m); return s == null ? null : s / cnt; };
    // An underlying MCX has no contract on (Brent) has no share to show
    const u = (doc.underlyings || []).find(x => x.key === k);
    const nseOnly = !!u && !u.mcx.length && !!u.nse.length;
    const sh = m => (nseOnly ? null : ccShare(w.rows, k, m));
    const fs = sh('fut'), ps = sh('prem'), os = sh('onot');
    const nseAny = (ccSum(w.rows, 'nse', k, 'fut') || 0) + (ccSum(w.rows, 'nse', k, 'onot') || 0) > 0;
    const mcxOnly = k !== 'all' && !nseOnly && !nseAny;
    const tag = k === 'all' ? '' : nseOnly ? ` ${rxChip('NSE only')}` : mcxOnly ? ` ${rxChip('MCX only')}` : '';
    const cls = k === 'all' ? 'rx-sub' : mcxOnly ? 'cc-nse-none' : '';
    // NSE's cells carry cc-n, so an MCX-only row can mute them (its zeros are real, NSE didn't trade)
    return `<tr${cls ? ` class="${cls}"` : ''}>
      <td class="rx-l">${escHtml(ccLabel(doc, k))}${tag}</td>
      <td class="cc-n">${ccCr(cell('fut', 'nse', w.rows, n))}</td><td>${ccCr(cell('fut', 'mcx', w.rows, n))}</td>
      <td class="rx-hl cc-n">${ccPct(fs)}</td>${ccPp(fs, w.prev.length && fs != null ? ccShare(w.prev, k, 'fut') : null, 'cc-n')}
      <td class="cc-n">${ccCr(cell('prem', 'nse', premRows, nPrem))}</td><td>${ccCr(cell('prem', 'mcx', premRows, nPrem))}</td>
      <td class="rx-hl cc-n">${ccPct(ps)}</td>${ccPp(ps, w.prev.length && ps != null ? ccShare(w.prev, k, 'prem') : null, 'cc-n')}
      <td class="cc-n">${ccPct(os)}</td>
    </tr>`;
  }).join('');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead>
      <tr><th scope="col" class="rx-l" rowspan="2">Underlying</th>
        <th scope="colgroup" colspan="4">Futures, notional ₹ Cr a day</th>
        <th scope="colgroup" colspan="4">Options, premium ₹ Cr a day</th>
        <th scope="col" rowspan="2" title="NSE's share of options notional (strike + premium) × quantity">Options<br>notional share</th></tr>
      <tr><th scope="col">NSE</th><th scope="col">MCX</th><th scope="col" class="rx-hl">NSE share</th><th scope="col" title="Change in NSE's share against ${escHtml(w.prevLabel || 'the window before')}">vs before</th>
        <th scope="col">NSE</th><th scope="col">MCX</th><th scope="col" class="rx-hl">NSE share</th><th scope="col" title="Change in NSE's share against ${escHtml(w.prevLabel || 'the window before')}">vs before</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

async function buildMcxCompetition() {
  const el = document.getElementById('competitionContent');
  if (!el) return;
  const seq = ++ccBuildSeq;
  if (!CC_DATA.doc) el.innerHTML = `<div class="rx">${ccPanelEmpty('Loading NSE and MCX commodity data…')}</div>`;
  try {
    await ccLoad();
  } catch (err) {
    console.error('Commodity competition data failed to load:', err);
    if (seq === ccBuildSeq) el.innerHTML = `<div class="rx">${ccPanelEmpty('Couldn\'t load the commodity data. Try again in a moment.')}</div>`;
    return;
  }
  if (seq !== ccBuildSeq || currentExchange !== 'mcx') return;   // rebuilt or switched away while loading
  const doc = CC_DATA.doc;
  const days = ccDays(doc);
  if (!days.length) {
    el.innerHTML = `<div class="rx">${ccPanelEmpty('No days with both NSE\'s and MCX\'s commodity figures yet')}</div>`;
    return;
  }
  const latestAll = doc.daily[doc.daily.length - 1];
  const pending = latestAll && !latestAll.mcx ? latestAll.date : null;
  const unavailable = Object.keys(doc.unavailable || {});
  const checked = (doc.daily || []).filter(r => r.checks && r.checks.length);
  const fyRows = days.filter(r => ccFy(r.date) === ccFy(days[days.length - 1].date));
  const revFy = fyRows.reduce((a, r) => a + r.rev[0], 0), revFyEff = fyRows.reduce((a, r) => a + r.rev[1], 0);
  const premOut = days.filter(r => !ccPremOk(r)).map(r => rxDate(r.date));
  const premNote = premOut.length ? ` Options premium shares and averages leave out ${premOut.join(', ')}, when MCX's file gives every option a premium of 0.` : '';

  el.innerHTML = `<div class="rx">
    <div class="rx-ph-right" style="margin-bottom:12px">${rxSeg('ccWin', CC_WINDOWS, CC_VIEW.win, 'Window')}</div>
    <div data-cc="kpis"></div>
    ${rxPanel({ title: 'NSE against MCX, by underlying', meta: '<span data-cc="winmeta"></span>',
      body: '<div data-cc="table"></div>',
      foot: 'Averages per session over the window. NSE share = NSE ÷ (NSE + MCX), in ₹, on the underlying (contract sizes differ).',
      how: rxHow('How the table is worked out', `<p>"vs before" is the change in percentage points against the window before (the session before, the 20 sessions before, the month, quarter or FY before). `
        + 'MCX only: NSE had no trades in that underlying over the window, so its figures (grey) are zero. '
        + 'MCX\'s indices and agri contracts count in "All commodities"; NSE lists neither. NSE\'s Brent crude has no MCX contract, so no share.' + premNote + '</p>') })}
    ${rxPanel({ title: 'NSE share by day', meta: '<span data-cc="daymeta"></span>',
      right: rxSeg('ccRange', CC_RANGES.map(([v, l]) => [v, l]), CC_VIEW.range, 'Range'),
      body: `<div class="rx-pb" style="padding-bottom:4px">
          <div class="cc-ctl">${rxSeg('ccUnd', CC_CHART_UNDS.map(k => [k, escHtml(ccLabel(doc, k))]), CC_VIEW.und, 'Underlying')}
          ${rxSeg('ccMetric', CC_METRICS, CC_VIEW.metric, 'Measure')}</div>
          ${rxLegend([{ label: 'Each session', color: RX.light, kind: 'dot' }, { label: `${CC_ROLL}-session share`, color: RX.model, kind: 'line' }])}
          ${rxCanvas('chartCcDaily')}</div>`,
      foot: 'Since the December 2025 contract (9 Dec 2025) NSE\'s crude-oil options expire around the 7th–10th of the month, about a week before MCX\'s (to November 2025 they expired on the 14th–17th, close to MCX\'s). Most of NSE\'s options volume comes on its own expiry day and the day before, so the daily share spikes once a month; the 20-session line evens that out. '
        + 'The scale follows the 20-session line: sessions above the scale are drawn as triangles on the top edge, with their share in the tooltip. '
        + (doc.notes || []).map(n => `${rxDate(n.date)}: ${escHtml(n.label)}.`).join(' ') + premNote })}
    ${rxPanel({ title: 'NSE share by month', meta: '<span data-cc="monmeta"></span>', body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas('chartCcMonthly')}</div>` })}
    ${rxPanel({ title: 'MCX revenue at risk from NSE', meta: '<span data-cc="riskmeta"></span>',
      body: `<div class="rx-pb">
          <p class="cc-risk-read" data-cc="riskread"></p>
          <div data-cc="riskkpis"></div>
          <div class="cc-risk-in" data-cc="riskin">
            <span class="cc-risk-in-h">Assumed share of NSE's volume that would otherwise trade on MCX</span>
            <label>Ordinary days <input class="rx-in" type="number" min="0" max="100" step="5" inputmode="decimal" data-sub="ord" aria-label="Ordinary days, % that would trade on MCX"> %</label>
            <label>NSE expiry window <input class="rx-in" type="number" min="0" max="100" step="5" inputmode="decimal" data-sub="exp" aria-label="NSE expiry window, % that would trade on MCX"> %</label>
            <button type="button" class="cc-risk-reset" data-cc="riskreset">Reset</button>
          </div>
          ${rxLegend([{ label: 'Ordinary days', color: RX.rev }, { label: 'NSE expiry day and the day before', color: rxAlpha(RX.rev, 0.35) },
            { label: 'Split not yet known', color: RX.light }, { label: 'Estimated loss', color: RX.ink, kind: 'line' },
            { label: 'MCX revenue, ₹ Cr a day (right)', color: RX.model, kind: 'dash' }])}
          ${rxCanvas('chartCcRisk')}</div>`,
      foot: 'Ceiling: NSE\'s commodity futures notional and options premium, priced each session at MCX\'s own rates (its reported futures revenue ÷ its futures notional, options revenue ÷ its options premium: about ₹210 and ₹4,180 per crore a side), against MCX\'s reported transaction revenue over the same sessions. It assumes every NSE trade would otherwise have traded on MCX, at MCX\'s fees. '
        + 'The split: an underlying\'s NSE options premium on its NSE options expiry day and the session before (crude\'s falls about a week before MCX\'s expiry, and carries most of NSE\'s options volume) against every other session; futures count as ordinary days. The latest day counts as ordinary until the next session\'s file shows whether it was the day before an expiry. '
        + 'Estimated loss: the ceiling\'s parts at the assumed shares above, which are judgements, not data. MCX\'s own volume shows no consistent dip on NSE\'s expiry days, so much of that window\'s volume looks like new trading. '
        + 'A year: the loss a session × MCX\'s sessions, PAT margin, shares and base P/E from the Valuation Inputs; value is EPS × P/E, undiscounted. '
        + 'MCX\'s revenue has kept rising meanwhile (dashed line): a loss here is growth MCX did not get, not a fall. The latest month (outlined) is to date; a month with an NSE expiry but only part of its sessions overstates the share.' })}
    ${rxPanel({ title: 'Is the market growing, or is MCX losing share?', meta: '<span data-cc="growmeta"></span>',
      right: rxSeg('ccGrow', CC_GROW_MEASURES.map(([v, l]) => [v, l]), CC_VIEW.grow, 'Measure'),
      body: `<div class="rx-pb">
          <div data-cc="growkpis"></div>
          <h3 class="cc-top-h cc-grow-h">MCX against the same month a year earlier</h3>
          ${rxLegend([{ label: 'From the market\'s growth', color: RX.model }, { label: 'From share NSE gained (at most)', color: RX.neg },
            { label: 'MCX\'s change', color: RX.ink, kind: 'dot' }])}
          ${rxCanvas('chartCcGrow')}
          <h3 class="cc-top-h cc-grow-h">MCX's crude options on NSE's crude expiry days</h3>
          <div data-cc="growexp"></div>
        </div>`,
      foot: 'MCX = market × (1 − NSE share), so MCX\'s change splits into the market\'s change at the old share and the share NSE gained at the new market size. That second part is the most NSE could have taken from MCX: it counts all of NSE\'s gain as MCX\'s loss, though some of NSE\'s volume is new trading. Per-session averages; the year-on-year chart\'s latest month (lighter) is to date. '
        + 'Expiry days: MCX\'s crude options premium on NSE\'s crude options expiry day and the session before, as a multiple of its median over the 7 sessions either side; NSE\'s premium those days as a share of the same median; and MCX\'s gold options (which NSE barely trades) the same way, so a day busy for every commodity can be told from one busy for crude. Below 1× with NSE high would mean trading moving from MCX to NSE; at or above 1× it is new trading. '
        + 'Crude volatility moves both exchanges, and there is no way to see the market without NSE, so this shows the size of each effect, not the cause.' })}
    ${rxPanel({ title: 'Top commodities by month, MCX and NSE', meta: '<span data-cc="topmeta"></span>',
      right: rxSeg('ccTop', CC_TOP_METRICS, CC_VIEW.top, 'Measure'),
      body: `<div class="rx-pb">
          ${rxLegend(CC_TOP_UNDS.map(k => ({ label: escHtml(ccLabel(doc, k)), color: CC_TOP_COLORS[k] })).concat([{ label: 'Others', color: CC_TOP_COLORS.others }]))}
          <div class="cc-top-grid">
            <div><h3 class="cc-top-h">MCX <span class="rx-meta" data-cc="topunitM"></span></h3>${rxCanvas('chartCcTopMcx')}</div>
            <div><h3 class="cc-top-h">NSE <span class="rx-meta" data-cc="topunitN"></span></h3>${rxCanvas('chartCcTopNse')}</div>
          </div>
          <div class="cc-top-bar"><label class="cc-top-pick">Month <select class="rx-in cc-top-sel" data-cc="topsel" aria-label="Month shown in the table"></select></label>
            <h3 class="cc-top-h" data-cc="toptitle"></h3></div>
        </div>
        <div data-cc="toptable"></div>`,
      foot: 'Averages per session in each month (the latest month is to date), over sessions with both exchanges\' figures; each chart has its own scale, since NSE\'s volumes are a small fraction of MCX\'s. '
        + 'Pick a month, or click it on either chart, to show it in the table; the other months fade. Rank is among every underlying the exchange traded that month (top five in bold); mix is the share of the exchange\'s own total. '
        + 'Transaction revenue is at today\'s rates: NSE\'s priced on its commodity charges (above); MCX\'s is its reported futures and options transaction revenue for each day, split across underlyings by their share of futures notional and options premium. '
        + 'Contracts are each exchange\'s own count (futures and options), not comparable across exchanges, as contract sizes differ, so they carry no NSE share. '
        + 'Others: MCX\'s zinc, aluminium, lead, nickel, steel, agri and indices; NSE\'s Brent crude.' })}
    ${rxPanel({ title: 'NSE commodity transaction charges (memo)',
      meta: `FY ${ccFy(days[days.length - 1].date)} to date: ₹${fmtNum(revFy * 100, 1)} lakh at today's rates`,
      body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas('chartCcRev')}</div>`,
      foot: `Futures ₹10 per crore of traded value and options ₹100 per crore of premium, each side (NSE/FA/61380); electricity futures were free from 14 Jul to 31 Dec 2025 (NSE/FA/69100), so FY to date at the rules then in force is ₹${fmtNum(revFyEff * 100, 1)} lakh. `
        + 'Monthly totals; the latest month (lighter) is to date. '
        + 'Not part of NSE\'s revenue anywhere else on the dashboard: it is about ₹0.001–0.1 Cr a day.' })}
    ${rxHow('Sources and method', `<p>NSE: the daily commodity bhavcopy (UDiFF), one row per contract; ${escHtml(doc.source?.premium || '')}. MCX: its bhavcopy per commodity (Supabase <code>mcx_commodity_daily</code>), notional and premium as published.</p>
      <p>Underlyings: ${(doc.underlyings || []).filter(u => u.nse.length || u.mcx.length).map(u => `<b>${escHtml(u.label)}</b> NSE ${escHtml(u.nse.join(', ') || '—')} · MCX ${escHtml(u.mcx.join(', ') || '—')}`).join('; ')}.</p>
      <p>${days.length} sessions with both exchanges' figures, from ${rxDate(days[0].date)}${pending ? `; ${rxDate(pending)} waits for MCX's per-commodity rows` : ''}.
      ${unavailable.length ? `${unavailable.length} MCX trading day(s) NSE has not posted a file for: ${unavailable.slice(-5).map(rxDate).join(', ')}${unavailable.length > 5 ? ' …' : ''}.` : ''}
      ${checked.length ? `${checked.length} day(s) with a data note, e.g. ${rxDate(checked[checked.length - 1].date)}: ${escHtml(checked[checked.length - 1].checks[0])}.` : ''}</p>`)}
  </div>`;
  const root = el.firstElementChild;
  const q = s => root.querySelector(`[data-cc="${s}"]`);

  const drawTable = () => {
    const w = ccWindow(days, CC_VIEW.win);
    q('winmeta').textContent = `${w.label} · ${w.rows.length} session${w.rows.length === 1 ? '' : 's'}${w.prevLabel ? ` · against ${w.prevLabel}` : ''}`;
    q('table').innerHTML = ccTableHTML(doc, w);
    const kp = (m, label) => {
      const s = ccShare(w.rows, 'all', m), p = w.prev.length ? ccShare(w.prev, 'all', m) : null;
      const d = s != null && p != null ? (s - p) * 100 : null;
      return rxKpi(label, ccPct(s), d == null ? '' : `${ccPpText(d).text} against ${escHtml(w.prevLabel)}`);
    };
    const n = w.rows.length;
    // Premium a day over the same sessions as the table's premium columns (ccRowsFor)
    const premRows = ccRowsFor(w.rows, 'prem');
    const sumPrem = premRows.length ? ccSum(premRows, 'nse', 'all', 'prem') : null;   // null when a premium is unknown
    const nseFut = ccSum(w.rows, 'nse', 'all', 'fut') / n, nsePrem = sumPrem == null ? null : sumPrem / premRows.length;
    // Premium and notional are different measures, so they are shown side by side, never added
    q('kpis').innerHTML = rxKpis([
      kp('prem', 'NSE share of options premium'),
      kp('onot', 'NSE share of options notional'),
      kp('fut', 'NSE share of futures notional'),
      rxKpi('NSE options premium a day', nsePrem == null ? '—' : `₹${ccCr(nsePrem)} Cr`, `Futures notional ₹${ccCr(nseFut)} Cr a day`),
    ], 'NSE share of commodity derivatives');
  };

  const drawDaily = () => {
    const und = CC_VIEW.und, metric = CC_VIEW.metric;
    const months = CC_RANGES.find(r => r[0] === CC_VIEW.range)[2];
    const last = days[days.length - 1].date;
    let start = null;
    if (months) {
      const d = new Date(last + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - months);
      start = d.toISOString().slice(0, 10);
    }
    const first = start ? Math.max(0, days.findIndex(r => r.date >= start)) : 0;
    const shown = days.slice(first);
    const dates = shown.map(r => r.date);
    const daily = shown.map(r => { const s = ccShare([r], und, metric); return s == null ? null : s * 100; });
    const roll = shown.map((_, i) => {
      const j = first + i;
      if (j + 1 < CC_ROLL) return null;
      const s = ccShare(days.slice(j + 1 - CC_ROLL, j + 1), und, metric);
      return s == null ? null : s * 100;
    });
    // Scale to the 20-session line (the figure to read), not to the expiry-day spikes: 3× its
    // peak, rounded up; sessions above that are drawn on the top edge
    const rollMax = Math.max(0, ...roll.filter(v => v != null));
    const dayMax = Math.max(0, ...daily.filter(v => v != null));
    const cap = rollMax > 0 ? Math.min(100, ccNiceCeil(rollMax * 3)) : null;
    const over = cap == null ? [] : daily.map(v => v != null && v > cap);
    const nOver = over.filter(Boolean).length;
    const plotted = cap == null ? daily : daily.map(v => (v != null && v > cap ? cap : v));
    q('daymeta').textContent = `${ccLabel(doc, und)} · ${CC_METRIC_TEXT[metric]} · ${rxDate(dates[0])} to ${rxDate(last)}`
      + (nOver ? ` · ${nOver} session${nOver === 1 ? '' : 's'} above ${ccPct(cap / 100)} (up to ${ccPct(dayMax / 100)}) on the top edge` : '');
    rxChart('ccDaily', 'chartCcDaily', 260, {
      type: 'line',
      data: { labels: dates.map(fmtChartDate), datasets: [
        { label: 'Session', data: plotted, showLine: false, clip: 6,
          pointStyle: ctx => (over[ctx.dataIndex] ? 'triangle' : 'circle'),
          pointRadius: ctx => (over[ctx.dataIndex] ? 4 : 2), pointHoverRadius: 5,
          pointBackgroundColor: ctx => (over[ctx.dataIndex] ? RX.grey : RX.light), pointBorderWidth: 0 },
        { label: `${CC_ROLL}-session`, data: roll, borderColor: RX.model, borderWidth: 2, pointRadius: 0, tension: 0, spanGaps: true },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => rxDate(dates[items[0].dataIndex]),
          // the session's own share, not the capped height it is drawn at
          label: ctx => {
            const v = ctx.datasetIndex === 0 ? daily[ctx.dataIndex] : ctx.raw;
            return ` ${ctx.dataset.label}: ${v == null ? '—' : ccPct(v / 100)}${ctx.datasetIndex === 0 && over[ctx.dataIndex] ? ' (above the scale)' : ''}`;
          },
          footer: items => {
            const r = shown[items[0].dataIndex];
            if (metric === 'prem' && !ccPremOk(r)) return 'Left out: MCX\'s file gives every option a premium of 0';
            return `NSE ₹${ccCr(ccVal(r.nse, und, metric))} Cr · MCX ₹${ccCr(ccVal(r.mcx, und, metric))} Cr`;
          } } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: ccMonthTicks(dates, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { min: 0, ...(cap == null ? {} : { max: cap }), title: { display: true, text: 'NSE share, %' },
            ticks: { callback: v => `${+v.toFixed(3)} %` } },
        },
      },
    });
  };

  const drawMonthly = () => {
    const und = CC_VIEW.und, metric = CC_VIEW.metric;
    const months = (doc.monthly || []).filter(p => p.days > 0);
    const vals = months.map(p => { const s = ccShare([p], und, metric); return s == null ? null : s * 100; });
    q('monmeta').textContent = `${ccLabel(doc, und)} · ${CC_METRIC_TEXT[metric]} · sessions with both exchanges' figures; the latest month (lighter) is to date`;
    rxChart('ccMonthly', 'chartCcMonthly', 220, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [{ label: 'NSE share', data: vals, ...ccToDateBars(RX.model, months.length) }] },
      options: {
        plugins: { tooltip: { callbacks: {
          title: items => ccMonthTitle(months, items[0].dataIndex),
          label: ctx => ` NSE share: ${ccPct(ctx.raw / 100)}`,
          footer: items => {
            const p = months[items[0].dataIndex];
            const nd = ccPeriodDays(p, metric);
            const out = nd < p.days ? ` (${p.days - nd} left out: MCX's premium 0)` : '';
            return `${nd} sessions${out} · NSE ₹${ccCr(ccVal(p.nse, und, metric) / nd)} Cr a day · MCX ₹${ccCr(ccVal(p.mcx, und, metric) / nd)} Cr a day`;
          } } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: 'NSE share, %' }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
  };

  const ew = ccExpiryWindow(doc.daily || []);
  const mcxByDate = () => new Map((rawFor('mcx')?.daily || []).map(r => [r.date, r]));
  const subDefaults = { ...CC_SUB_DEFAULTS };
  let sub = ccSubs(subDefaults), val = null;   // val: MCX's valuation inputs, once loaded
  // MCX's options rate a side (₹ per crore of premium) against NSE's, over the window's sessions
  const nseOptRate = (doc.fee_rules || []).find(r => r.product === 'com_opt' && !r.effective_to)?.rate_per_cr_per_side;

  const drawRiskKpis = () => {
    const w = ccWindow(days, CC_VIEW.win);
    const byDate = mcxByDate();
    const t = ccRiskSum(w.rows, byDate, ew), tp = w.prev.length ? ccRiskSum(w.prev, byDate, ew) : null;
    if (!t.days) {
      q('riskkpis').innerHTML = '';
      q('riskread').textContent = byDate.size ? 'No session in this window with both exchanges\' figures and MCX\'s revenue' : 'Needs MCX\'s daily revenue, which has not loaded';
      return;
    }
    const n = t.days, frac = x => (t.mcx > 0 && x != null ? x / t.mcx : null);
    const loss = ccRiskLoss(t, sub);
    const vsPrev = (cur, prev) => {
      if (cur == null || prev == null || !w.prevLabel) return '';
      const d = (cur - prev) * 100;
      return ` · ${ccPpText(d).text} against ${escHtml(w.prevLabel)}`;
    };
    const pPrev = tp && tp.days && tp.mcx > 0 ? tp.ceil / tp.mcx : null;
    const lossPrev = tp && tp.days && tp.mcx > 0 ? ccRiskLoss(tp, sub) : null;
    const splitNote = t.unknown ? `Split known once ${t.unknown} session${t.unknown === 1 ? '' : 's'} are re-read with NSE's options expiries` : '';
    const row1 = [
      rxKpi('NSE volume at MCX\'s fees (ceiling)', `₹${ccCr(t.ceil / n)} Cr <small>a day</small>`,
        `${ccPct(frac(t.ceil))} of MCX's ₹${ccCr(t.mcx / n)} Cr${vsPrev(frac(t.ceil), pPrev)}`),
      rxKpi('Ordinary days', t.ord == null ? '—' : `₹${ccCr(t.ord / n)} Cr <small>a day</small>`,
        t.ord == null ? splitNote : `${ccPct(frac(t.ord))} of MCX's revenue · futures and options`),
      rxKpi('NSE expiry window', t.exp == null ? '—' : `₹${ccCr(t.exp / n)} Cr <small>a day</small>`,
        t.exp == null ? splitNote : `${ccPct(frac(t.exp))} of MCX's revenue · expiry day and the day before`),
      rxKpi('Estimated loss', loss == null ? '—' : `₹${ccCr(loss / n)} Cr <small>a day</small>`,
        loss == null ? splitNote : `${ccPct(frac(loss))} of MCX's revenue at ${sub.ord} % / ${sub.exp} %${vsPrev(frac(loss), lossPrev != null ? lossPrev / tp.mcx : null)}`,
        { accent: true }),
    ];
    let row2 = '';
    if (loss != null && val) {
      const shares = SHARES_OUTSTANDING_CR.mcx?.value;
      const y = ccRiskYear(loss / n, val.days, val.margin, shares, val.pe1);
      const totalRev = (t.mcx / n) * val.days;
      row2 = rxKpis([
        rxKpi('Estimated loss a year', `₹${fmtNum(y.rev, 0)} Cr`, `${val.days} sessions · ${ccPct(totalRev > 0 ? y.rev / totalRev : null)} of MCX's transaction revenue at this pace`),
        rxKpi('PAT a year', `₹${fmtNum(y.pat, 0)} Cr`, `at MCX's ${fmtNum(val.margin, 0)} % PAT margin`),
        rxKpi('EPS', y.eps == null ? '—' : `₹${fmtNum(y.eps, 2)}`, `${fmtNum(shares, 2)} Cr shares ${sharesChip('mcx')}`),
        rxKpi('Value a share', y.value == null ? '—' : `₹${fmtNum(y.value, 0)}`, `EPS × base P/E ${fmtNum(val.pe1, 0)}, undiscounted`),
      ], 'MCX\'s estimated loss a year');
    }
    q('riskkpis').innerHTML = rxKpis(row1, 'MCX revenue at risk from NSE') + row2;
    // The reading: NSE's share, what it earns, and what the same volume is worth at MCX's fees
    const share = ccShare(w.rows, 'all', 'prem');
    const mcxSide = t.mcxPrem > 0 ? t.mcxOpt / t.mcxPrem * 1e7 / 2 : null;   // ₹ per crore of premium, a side
    const nseRows = (rawFor('nse')?.daily_all || []).filter(r => w.rows.some(x => x.date === r.date));
    const nseRev = nseRows.length ? nseRows.reduce((a, r) => a + (r.total_rev || 0), 0) / nseRows.length : null;
    q('riskread').innerHTML = `${escHtml(w.label)}: NSE took <b>${ccPct(share)}</b> of commodity options premium and earned `
      + `<b>₹${fmtNum(t.nse / n * 100, 2)} lakh</b> a day${nseRev ? ` (${ccPct(t.nse / n / nseRev)} of NSE's own revenue)` : ''}. `
      + `${mcxSide && nseOptRate ? `MCX charges about ₹${fmtNum(mcxSide, 0)} per crore of premium a side against NSE's ₹${fmtNum(nseOptRate, 0)} (${fmtNum(mcxSide / nseOptRate, 0)}×), so ` : ''}`
      + `at MCX's fees the same volume is <b>₹${ccCr(t.ceil / n)} Cr</b> a day, ${ccPct(frac(t.ceil))} of MCX's revenue.`;
  };

  const drawRisk = () => {
    drawRiskKpis();
    const months = ccRiskByMonth(days, rawFor('mcx')?.daily, ew);
    if (!months.length) {
      q('riskmeta').textContent = 'Needs MCX\'s daily revenue, which has not loaded';
      if (charts.ccRisk) { charts.ccRisk.destroy(); delete charts.ccRisk; }
      return;
    }
    q('riskmeta').textContent = `${ccWindow(days, CC_VIEW.win).label} · chart by month, % of MCX's revenue`;
    const nM = months.length, lastI = nM - 1;
    const pct = (p, x) => (p.mcx > 0 && x != null ? (x / p.mcx) * 100 : null);
    const outline = color => ({ borderColor: color, borderWidth: months.map((_, i) => (i === lastI ? 1.5 : 0)) });
    rxChart('ccRisk', 'chartCcRisk', 240, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [
        { label: 'Ordinary days', data: months.map(p => pct(p, p.ord)), stack: 'r', yAxisID: 'y',
          backgroundColor: months.map((_, i) => (i === lastI ? rxAlpha(RX.rev, 0.55) : RX.rev)), ...outline(RX.rev) },
        { label: 'NSE expiry window', data: months.map(p => pct(p, p.exp)), stack: 'r', yAxisID: 'y',
          backgroundColor: rxAlpha(RX.rev, 0.35), ...outline(RX.rev) },
        { label: 'Split not yet known', data: months.map(p => (p.ord == null ? pct(p, p.ceil) : null)), stack: 'r', yAxisID: 'y',
          backgroundColor: RX.light, ...outline(RX.grey) },
        { type: 'line', label: 'Estimated loss', data: months.map(p => pct(p, ccRiskLoss(p, sub))), yAxisID: 'y', stack: 'loss',
          borderColor: RX.ink, backgroundColor: RX.ink, borderWidth: 2, pointRadius: 2, tension: 0, spanGaps: false, order: -1 },
        { type: 'line', label: 'MCX revenue', data: months.map(p => p.mcx / p.days), yAxisID: 'y2',
          borderColor: RX.model, backgroundColor: RX.model, borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, tension: 0, order: -2 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { filter: item => item.raw != null, callbacks: {
          title: items => ccMonthTitle(months, items[0].dataIndex),
          label: ctx => {
            if (ctx.dataset.yAxisID === 'y2') return ` MCX revenue: ₹${ccCr(ctx.raw)} Cr a day`;
            const p = months[ctx.dataIndex];
            const amt = [p.ord, p.exp, p.ceil, ccRiskLoss(p, sub)][ctx.datasetIndex];
            return ` ${ctx.dataset.label}: ${ccPct(ctx.raw / 100)} of MCX's revenue (₹${ccCr(amt / p.days)} Cr a day)`;
          },
          footer: items => {
            const p = months[items[0].dataIndex];
            return [`Ceiling: ₹${ccCr(p.ceil / p.days)} Cr a day, ${ccPct(p.mcx > 0 ? p.ceil / p.mcx : null)}`,
              `NSE's own charges: ₹${ccCr(p.nse / p.days)} Cr a day · ${p.days} sessions`];
          } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, min: 0, title: { display: true, text: '% of MCX\'s revenue' }, ticks: { callback: v => `${v} %` } },
          y2: { position: 'right', min: 0, grid: { display: false }, title: { display: true, text: 'MCX, ₹ Cr a day' } },
        },
      },
    });
  };

  // Assumption inputs: shown values, edited state, and redraw on change
  const showSubs = () => root.querySelectorAll('[data-sub]').forEach(inp => {
    const k = inp.dataset.sub;
    if (document.activeElement !== inp) inp.value = sub[k];
    inp.classList.toggle('is-edited', sub[k] !== subDefaults[k]);
  });
  root.querySelectorAll('[data-sub]').forEach(inp => inp.addEventListener('input', () => {
    const x = parseFloat(inp.value);
    if (!(x >= 0 && x <= 100)) return;
    sub = { ...sub, [inp.dataset.sub]: x };
    ccSubsSave(sub, subDefaults);
    showSubs();
    drawRisk();
  }));
  q('riskreset').addEventListener('click', () => { sub = { ...subDefaults }; ccSubsSave(sub, subDefaults); showSubs(); drawRisk(); });
  showSubs();
  // MCX's valuation inputs (sessions, PAT margin, base P/E, with the shared edits) and the
  // shared substitution defaults; the year's figures appear once they load
  Promise.all([loadValuationDefaults(), loadSharedValuationInputs()]).then(([defaults]) => {
    if (!defaults || defaults.error || seq !== ccBuildSeq) return;
    for (const k of ['ord', 'exp']) if (defaults.comp && defaults.comp[k] != null) subDefaults[k] = defaults.comp[k];
    sub = ccSubs(subDefaults);
    val = valuationInputsFor(defaults, readValuationOverrides(), 'mcx').v;
    showSubs();
    drawRisk();
  }).catch(() => { /* no year figures */ });

  const drawRev = () => {
    const months = (doc.monthly || []).filter(p => p.days > 0);
    rxChart('ccRev', 'chartCcRev', 200, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [
        { label: 'At today\'s rates', data: months.map(p => p.rev[0] * 100), ...ccToDateBars(RX.rev, months.length) },
      ] },
      options: {
        plugins: { tooltip: { callbacks: {
          title: items => ccMonthTitle(months, items[0].dataIndex),
          label: ctx => ` ₹${fmtNum(ctx.raw, 2)} lakh at today's rates`,
          footer: items => {
            const p = months[items[0].dataIndex];
            return `₹${fmtNum(p.rev[1] * 100, 2)} lakh at the rules then in force · ${p.days} sessions`;
          } } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: '₹ lakh' }, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
  };

  const drawTop = () => {
    const metric = CC_VIEW.top;
    const months = (doc.monthly || []).filter(p => p.days > 0);
    const metricText = CC_TOP_METRICS.find(m => m[0] === metric)[1].toLowerCase();
    if (!months.length) return;
    const sel = q('topsel');
    if (metric === 'rev' && !months.some(p => p.ru)) {
      q('topmeta').textContent = 'Revenue per underlying arrives with the next data update';
      q('toptable').innerHTML = '';
      q('toptitle').textContent = '';
      sel.parentElement.hidden = true;
      ['ccTopMcx', 'ccTopNse'].forEach(k => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } });
      return;
    }
    sel.parentElement.hidden = false;
    let idx = months.findIndex(p => p.month === CC_VIEW.topMonth);
    if (idx < 0) idx = months.length - 1;
    // The month picker, latest first; the selected month's bars stay solid, the others fade
    sel.innerHTML = months.map((p, i) => `<option value="${p.month}"${i === idx ? ' selected' : ''}>${ccMonthLabel(p.month)}${i === months.length - 1 ? ' to date' : ''}</option>`).reverse().join('');
    const series = CC_TOP_UNDS.concat(['others']);   // crude, the largest, at the base of each bar
    const draw = (side, key, canvas, unitEl) => {
      const per = months.map(p => ccTopPer(p, side, 'all', metric) || 0);
      const unit = ccTopUnit(metric, Math.max(0, ...per));
      q(unitEl).textContent = unit.axis;
      const sets = series.map(und => ({
        label: und === 'others' ? 'Others' : ccLabel(doc, und),
        und,
        data: months.map(p => { const v = ccTopPer(p, side, und, metric); return v == null ? null : v * unit.k; }),
        backgroundColor: ctx => (ctx.dataIndex === idx ? CC_TOP_COLORS[und] : rxAlpha(CC_TOP_COLORS[und], 0.35)),
        borderColor: '#FFFFFF', borderWidth: { top: 1 }, borderSkipped: 'bottom',
        stack: 's',
      })).filter(ds => ds.data.some(v => v));
      rxChart(key, canvas, 240, {
        type: 'bar',
        data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: sets },
        options: {
          interaction: { mode: 'index', intersect: false },
          onHover: (evt, els, chart) => { chart.canvas.style.cursor = els.length ? 'pointer' : ''; },
          onClick: (evt, els, chart) => {
            const hit = chart.getElementsAtEventForMode(evt, 'index', { intersect: false }, false)[0];
            if (!hit) return;
            CC_VIEW.topMonth = months[hit.index].month;
            drawTop();
          },
          plugins: { tooltip: {
            itemSort: (a, b) => (b.raw || 0) - (a.raw || 0),
            filter: item => item.raw > 0,
            callbacks: {
              title: items => ccMonthTitle(months, items[0].dataIndex),
              label: ctx => {
                const total = per[ctx.dataIndex] * unit.k;
                return ` ${ctx.dataset.label}: ${unit.fmt(ctx.raw)}${total ? ` · ${ccPct(ctx.raw / total)}` : ''}`;
              },
              footer: items => {
                const p = months[items[0].dataIndex];
                return `All: ${unit.fmt(per[items[0].dataIndex] * unit.k)} a session · ${ccTopDays(p, side, metric)} sessions`;
              },
            } } },
          scales: {
            x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 9, maxRotation: 0, autoSkip: true } },
            y: { stacked: true, min: 0, ticks: { callback: v => (v === 0 ? '0' : fmtNum(v, v >= 10 ? 0 : v >= 1 ? 1 : 2)) } },
          },
        },
      });
    };
    draw('mcx', 'ccTopMcx', 'chartCcTopMcx', 'topunitM');
    draw('nse', 'ccTopNse', 'chartCcTopNse', 'topunitN');
    const p = months[idx];
    q('topmeta').textContent = `${metricText} · ${ccMonthLabel(months[0].month)} to ${ccMonthLabel(months[months.length - 1].month)}`;
    // The heading names the month too (it is also in the picker), so it reads on its own
    q('toptitle').textContent = `${ccMonthLabel(p.month)}${idx === months.length - 1 ? ' to date' : ''}, ${metricText} a session${idx > 0 && metric !== 'con' ? ` · NSE share against ${ccMonthLabel(months[idx - 1].month)}` : ''}`;
    q('toptable').innerHTML = ccTopTableHTML(doc, months, idx, metric);
  };

  const growPct = (x, base) => (x == null || !(base > 0) ? null : x / base);
  const growSign = f => (f == null || !isFinite(f) ? '—' : `${f >= 0 ? '+' : '−'}${fmtNum(Math.abs(f) * 100, 1)} %`);
  const drawGrowKpis = () => {
    const [, label, und, metric] = CC_GROW_MEASURES.find(m => m[0] === CC_VIEW.grow);
    const w = ccWindow(days, CC_VIEW.win);
    q('growmeta').textContent = `${label} · ${w.label}${w.prevLabel ? ` against ${w.prevLabel}` : ''}`;
    const ss = w.prev.length ? ccShiftShare(w.prev, w.rows, und, metric) : null;
    if (!ss) { q('growkpis').innerHTML = rxKpis([rxKpi('Market (NSE + MCX)', '—', 'Needs a window before this one')]); return; }
    const nseGain = ss.n1 - ss.n0, mktGain = ss.M1 - ss.M0;
    q('growkpis').innerHTML = rxKpis([
      rxKpi('Market (NSE + MCX)', `₹${ccCr(ss.M1)} Cr <small>a day</small>`, `${growSign(growPct(mktGain, ss.M0))} against ${escHtml(w.prevLabel)}`),
      rxKpi('MCX', `₹${ccCr(ss.m1)} Cr <small>a day</small>`, `${growSign(growPct(ss.m1 - ss.m0, ss.m0))} · NSE share ${ccPct(ss.s0)} → ${ccPct(ss.s1)}`),
      rxKpi('From the market\'s growth', `${ss.mkt >= 0 ? '+' : '−'}₹${ccCr(Math.abs(ss.mkt))} Cr`, `${growSign(growPct(ss.mkt, ss.m0))} of MCX's level before`, { accent: true }),
      rxKpi('From share NSE gained (at most)', `${ss.shr >= 0 ? '+' : '−'}₹${ccCr(Math.abs(ss.shr))} Cr`, `${growSign(growPct(ss.shr, ss.m0))} of MCX's level before`),
      rxKpi('NSE\'s part of the market\'s change', mktGain > 0 ? ccPct(nseGain / mktGain) : '—',
        mktGain > 0 ? `NSE ₹${ccCr(ss.n0)} → ₹${ccCr(ss.n1)} Cr a day` : 'The market did not grow'),
    ], 'Market growth against share shift');
  };

  const drawGrow = () => {
    drawGrowKpis();
    const [, label, und, metric] = CC_GROW_MEASURES.find(m => m[0] === CC_VIEW.grow);
    const months = (doc.monthly || []).filter(p => p.days > 0);
    const yoy = ccShiftYoY(months, und, metric);
    const n = yoy.length, lastI = n - 1, isToDate = n && yoy[lastI].month === months[months.length - 1].month;
    const fade = c => yoy.map((_, i) => (isToDate && i === lastI ? rxAlpha(c, 0.45) : c));
    rxChart('ccGrow', 'chartCcGrow', 240, {
      type: 'bar',
      data: { labels: yoy.map(y => ccMonthLabel(y.month)), datasets: [
        { label: 'From the market\'s growth', data: yoy.map(y => y.ss.mkt / y.ss.m0 * 100), backgroundColor: fade(RX.model), stack: 's' },
        { label: 'From share NSE gained', data: yoy.map(y => y.ss.shr / y.ss.m0 * 100), backgroundColor: fade(RX.neg), stack: 's' },
        { type: 'line', label: 'MCX\'s change', data: yoy.map(y => (y.ss.m1 / y.ss.m0 - 1) * 100), stack: 'net', showLine: false,
          pointRadius: 4, pointHoverRadius: 5, pointBackgroundColor: RX.ink, borderColor: RX.ink, order: -1 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => `${ccMonthLabel(yoy[items[0].dataIndex].month)}${isToDate && items[0].dataIndex === lastI ? ' to date' : ''} against ${ccMonthLabel(yoy[items[0].dataIndex].base)}`,
          label: ctx => ` ${ctx.dataset.label}: ${growSign(ctx.raw / 100)}`,
          footer: items => {
            const y = yoy[items[0].dataIndex].ss;
            return [`Market ₹${ccCr(y.M0)} → ₹${ccCr(y.M1)} Cr a day (${growSign(y.M1 / y.M0 - 1)})`,
              `NSE share ${ccPct(y.s0)} → ${ccPct(y.s1)}`];
          } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, title: { display: true, text: `% of MCX's ${label.toLowerCase()} a year earlier` }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
    // The expiry-day check (crude); needs xo, from parser 2
    const ev = ccExpiryEvents(days).slice(-8);
    if (!ev.length) {
      q('growexp').innerHTML = '<p class="rx-foot">Shown once NSE\'s options expiry dates are in the data (the pipeline\'s re-read of past days).</p>';
      return;
    }
    const x = v => (v == null || !isFinite(v) ? '—' : `${fmtNum(v, 2)}×`);
    const cls = v => (v == null ? '' : v < 0.9 ? ' class="rx-dn"' : v > 1.1 ? ' class="rx-up"' : '');
    const med = k => { const a = ev.flatMap(e => [e.before[k], e.expiry[k]]).filter(v => v != null).sort((a2, b) => a2 - b); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
    const row = e => `<tr><td class="rx-l">${rxDate(e.date)}</td>
      <td${cls(e.before.mcx)}>${x(e.before.mcx)}</td><td${cls(e.expiry.mcx)}>${x(e.expiry.mcx)}</td>
      <td>${ccPct(e.before.nse)}</td><td>${ccPct(e.expiry.nse)}</td>
      <td>${x(e.before.placebo)}</td><td>${x(e.expiry.placebo)}</td></tr>`;
    q('growexp').innerHTML = `<div class="rx-scroll"><table class="rx-table">
      <thead><tr><th scope="col" class="rx-l" rowspan="2">NSE crude expiry</th>
        <th scope="colgroup" colspan="2">MCX crude, × nearby</th><th scope="colgroup" colspan="2">NSE crude, % of MCX's nearby</th><th scope="colgroup" colspan="2">MCX gold, × nearby</th></tr>
        <tr><th scope="col">Day before</th><th scope="col">Expiry day</th><th scope="col">Day before</th><th scope="col">Expiry day</th><th scope="col">Day before</th><th scope="col">Expiry day</th></tr></thead>
      <tbody>${ev.map(row).join('')}
        <tr class="rx-sub"><td class="rx-l">Median, both days</td><td colspan="2">${x(med('mcx'))}</td><td colspan="2">${ccPct(med('nse'))}</td><td colspan="2">${x(med('placebo'))}</td></tr></tbody>
    </table></div>`;
  };

  const drawCharts = () => { drawDaily(); drawMonthly(); drawRisk(); drawGrow(); drawTop(); drawRev(); };
  drawTable();
  drawCharts();
  rxOnSeg(root, 'ccWin', v => { CC_VIEW.win = v; drawTable(); drawRiskKpis(); drawGrowKpis(); q('riskmeta').textContent = `${ccWindow(days, CC_VIEW.win).label} · chart by month, % of MCX's revenue`; });
  rxOnSeg(root, 'ccUnd', v => { CC_VIEW.und = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccMetric', v => { CC_VIEW.metric = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccRange', v => { CC_VIEW.range = v; drawDaily(); });
  rxOnSeg(root, 'ccTop', v => { CC_VIEW.top = v; drawTop(); });
  rxOnSeg(root, 'ccGrow', v => { CC_VIEW.grow = v; drawGrow(); });
  q('topsel').addEventListener('change', e => { CC_VIEW.topMonth = e.target.value; drawTop(); });
  RX_TAB_REFRESH.competition = drawCharts;
}

// Under NSE's Revenue Summary: NSE's commodity charges this quarter, as a memo line kept out
// of every NSE total (NSE's revenue files hold equity F&O and cash only)
async function buildNseCommodityMemo() {
  const el = document.getElementById('nseCommodityMemo');
  if (!el) return;
  el.hidden = true;
  if (currentExchange !== 'nse') return;
  try {
    await ccLoad();
  } catch (err) {
    console.error('NSE commodity memo failed to load:', err);
    return;
  }
  if (currentExchange !== 'nse') return;
  const doc = CC_DATA.doc;
  const rows = (doc.daily || []).filter(r => !r.session);
  if (!rows.length) return;
  const last = rows[rows.length - 1].date, qk = ccQuarter(last);
  const q = rows.filter(r => ccQuarter(r.date) === qk);
  const rev = q.reduce((a, r) => a + r.rev[0], 0);
  el.textContent = `Memo, not in these totals: NSE's commodity derivatives transaction charges, ${ccQuarterLabel(qk)} to ${rxDate(last)}: `
    + `₹${fmtNum(rev * 100, 1)} lakh over ${q.length} session${q.length === 1 ? '' : 's'} (₹${fmtNum(rev * 100 / q.length, 2)} lakh a session), at today's rates. `
    + 'NSE\'s share of commodity volume against MCX is on the MCX view\'s Competition tab.';
  el.hidden = false;
}
