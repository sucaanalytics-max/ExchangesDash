// dashboard/js/16-contracts-premium.js — Contracts to Premium tab (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// CONTRACTS TO PREMIUM (NSE + BSE combined) — option contracts traded per
// ₹ 1 Cr of option premium, market-wide:
//   (NSE index + stock option contracts + BSE contracts) ÷ (NSE index + stock
//   option premium + BSE options premium)
// from each exchange's daily_all. Contracts and premium are volumes, not fees,
// so the figures are the same under either Fees setting, and the exchange
// switcher does not change them: the tab shows the same view under NSE, BSE,
// NSE+BSE and All. Periods are Σ contracts ÷ Σ premium, never a mean of daily
// ratios, so a heavy expiry day weighs what it traded.
// ========================

const CP_MA_WINDOW = 20;   // trading days in the chart's rolling ratio
const CP_RANGES = [['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24], ['all', 'All', null]];
const CP_EXP_COLOR = '#D39A6E';   // RX.above: expiry-day dots, as on Brokers → F&O vs Exchanges
const CP_VIEW = { range: '1y', expRange: '1y', expMetric: 'contracts' };
let cpBuildSeq = 0;   // latest build; an older one still loading yields to it

// One row per date on which both exchanges traded options (contracts and premium
// > 0 on each side), joined by date. `excluded` lists every other date in either
// file with the side that had no options data ('nse', 'bse' or 'both'): BSE has
// gaps before mid-May 2023. Muhurat / DR sessions are already outside daily_all.
function contractsPremiumDaily(nseRows, bseRows) {
  const nse = new Map((nseRows || []).map(r => [r.date, r]));
  const bse = new Map((bseRows || []).map(r => [r.date, r]));
  const dates = [...new Set([...nse.keys(), ...bse.keys()])].sort();
  const days = [], excluded = [];
  dates.forEach(date => {
    const n = nse.get(date), b = bse.get(date);
    const nC = n ? (n.io_contracts || 0) + (n.so_contracts || 0) : 0;
    const nP = n ? (n.io_premium || 0) + (n.so_premium || 0) : 0;
    const bC = b ? b.total_contracts || 0 : 0;
    const bP = b ? b.options_premium_turnover || 0 : 0;
    const nseOk = nC > 0 && nP > 0, bseOk = bC > 0 && bP > 0;
    if (!nseOk || !bseOk) {
      excluded.push({ date, missing: !nseOk && !bseOk ? 'both' : nseOk ? 'bse' : 'nse' });
      return;
    }
    const contracts = nC + bC, premium = nP + bP;
    days.push({ date, fy: n.fy || b.fy, fy_quarter: n.fy_quarter || b.fy_quarter, fy_month: n.fy_month || b.fy_month,
      contracts, premium, ratio: contracts / premium });
  });
  return { days, excluded };
}

// Labels `n` periods before a FY / quarter / month label, by arithmetic on the
// label (quarterSortKey / monthSortKey), so a period the data lacks shows as
// empty rather than as its neighbour. "Q1 FY 2027" − 1 → "Q4 FY 2026".
function cpFYBack(label, n) {
  const m = /^FY\s+(\d+)$/.exec(label || '');
  return m ? `FY ${+m[1] - n}` : null;
}

function cpQuarterBack(label, n) {
  const k = quarterSortKey(label || '');
  if (!k) return null;
  const idx = Math.floor(k / 10) * 4 + (k % 10 - 1) - n;
  return `Q${idx % 4 + 1} FY ${Math.floor(idx / 4)}`;
}

function cpMonthBack(label, n) {
  const k = monthSortKey(label || '');
  if (!k || !(k % 100)) return null;
  const idx = Math.floor(k / 100) * 12 + (k % 100 - 1) - n;
  const name = Object.keys(FY_MONTH_ORDER).find(mo => FY_MONTH_ORDER[mo] === idx % 12 + 1);
  return `FY ${Math.floor(idx / 12)} ${name}`;
}

// Σ contracts ÷ Σ premium of some days; null ratio without any
function cpTotals(rows) {
  const contracts = rows.reduce((a, r) => a + r.contracts, 0);
  const premium = rows.reduce((a, r) => a + r.premium, 0);
  return { days: rows.length, contracts, premium, ratio: premium > 0 ? contracts / premium : null,
    from: rows.length ? rows[0].date : null, to: rows.length ? rows[rows.length - 1].date : null };
}

// The period table, mirroring Revenue Summary: groups of rows, the first of each
// group the current period. Each row: { label, role, toDate, days, contracts,
// premium, ratio, from, to, chg }, where chg is the current period's ratio against
// this row's, (current − row) ÷ row, as Revenue Summary's % chg (null on the
// current row). Periods run to the last day on or before `today` (default: the
// last day of `daily`).
function contractsPremiumPeriods(daily, today) {
  const rows = today ? (daily || []).filter(r => r.date <= today) : (daily || []);
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const period = (field, label, role) => ({ label, role, toDate: role === 'current',
    ...cpTotals(label ? rows.filter(r => r[field] === label) : []) });
  const tail = (from, to, label, role) => ({ label, role, toDate: false,
    ...cpTotals(rows.slice(Math.max(0, rows.length + from), to == null ? rows.length : Math.max(0, rows.length + to))) });
  const groups = [
    { kind: 'fy', title: 'Financial year', rows: [
      period('fy', last.fy, 'current'),
      period('fy', cpFYBack(last.fy, 1), 'previous'),
    ] },
    { kind: 'quarter', title: 'Quarter', rows: [
      period('fy_quarter', last.fy_quarter, 'current'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 1), 'previous'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 2), 'before'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 4), 'last_year'),
    ] },
    { kind: 'month', title: 'Month', rows: [
      period('fy_month', last.fy_month, 'current'),
      period('fy_month', cpMonthBack(last.fy_month, 1), 'previous'),
      period('fy_month', cpMonthBack(last.fy_month, 2), 'before'),
    ] },
    { kind: 'days', title: 'Trading days', rows: [
      tail(-5, null, 'Last 5 days', 'last5'),
      tail(-10, -5, 'Previous 5 days', 'prev5'),
      tail(-45, null, 'Last 45 days', 'last45'),
    ] },
  ];
  groups.forEach(g => {
    const cur = g.rows[0].ratio;
    g.rows.forEach((r, i) => { r.chg = i > 0 && cur != null && r.ratio ? (cur - r.ratio) / r.ratio : null; });
  });
  return groups;
}

// Σ contracts ÷ Σ premium over the `win` days to each day (the period table's
// basis); null until `win` days are in
function contractsPremiumRolling(days, win) {
  let sc = 0, sp = 0;
  return days.map((r, i) => {
    sc += r.contracts; sp += r.premium;
    if (i >= win) { sc -= days[i - win].contracts; sp -= days[i - win].premium; }
    return i >= win - 1 && sp > 0 ? sc / sp : null;
  });
}

// Rolling 6 M / 1 Y / … start, or null for all days
function cpRangeStart(lastDate, range) {
  const months = (CP_RANGES.find(r => r[0] === range) || CP_RANGES[1])[2];
  if (months == null) return null;
  const d = new Date(lastDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// ========================
// EXPIRY DAYS VS OTHER DAYS — per exchange, each weekly benchmark expiry
// (expiryDateSet: Nifty on NSE, Sensex on BSE, moved back for a holiday)
// against that exchange's other trading days. The expiry multiple is the
// average expiry day ÷ the average other day, for contracts and for premium:
// it nets out the market's overall level (volatility, sentiment), so it shows
// what a rule that bites near the expiry close does to expiry-day trading.
//
// Expiring F&O contracts settle on a price SEBI sets by date: the cash market's
// VWAP over the last 30 minutes, then the closing auction session's (CAS) price
// from 3 Aug 2026 (circular of 16 Jan 2026), then the 30-minute VWAP again from
// 7 Dec 2026 (circular of 15 Oct 2026; CAS stays, 3:30–3:40 pm, cash only).
// ========================

const CP_SETTLEMENT_SWITCHES = [
  { date: '2026-08-03', label: 'CAS settlement starts' },
  { date: '2026-12-07', label: 'VWAP settlement again' },
];
// Both exchanges' expiry weekdays as of today (NSE Tuesday, BSE Thursday) start here
const CP_EXPIRY_WEEKDAYS_FROM = '2025-09-01';
// Trading days in the table's "last N days" rows, and weeks in the chart's rolling multiple
const CP_EXP_WINDOW = 40;
const CP_EXP_ROLL_WEEKS = 4;
const CP_EXP_EXCHANGES = [
  { ex: 'nse', name: 'NSE', color: RX.model },
  { ex: 'bse', name: 'BSE', color: RX.rev },
];

// One exchange's option days: { date, contracts, premium, expiry }. NSE: index +
// stock options; BSE: its contract total (F&O, futures negligible) and options
// premium. Days without both contracts and premium are left out.
function expirySplitDaily(rows, exchange, expirySet) {
  return (rows || []).map(r => {
    const contracts = exchange === 'nse' ? (r.io_contracts || 0) + (r.so_contracts || 0) : r.total_contracts || 0;
    const premium = exchange === 'nse' ? (r.io_premium || 0) + (r.so_premium || 0) : r.options_premium_turnover || 0;
    return { date: r.date, contracts, premium, expiry: expirySet.has(r.date) };
  }).filter(d => d.contracts > 0 && d.premium > 0).sort((a, b) => a.date.localeCompare(b.date));
}

// Averages of expiry and other days among `days`, and their multiples (null
// without days of either kind)
function expirySplitStats(days) {
  const sum = (L, k) => L.reduce((a, d) => a + d[k], 0);
  const e = days.filter(d => d.expiry), o = days.filter(d => !d.expiry);
  const avg = (L, k) => L.length ? sum(L, k) / L.length : null;
  const expC = avg(e, 'contracts'), othC = avg(o, 'contracts'), expP = avg(e, 'premium'), othP = avg(o, 'premium');
  return { expDays: e.length, othDays: o.length, expC, othC, expP, othP,
    cMult: expC != null && othC ? expC / othC : null, pMult: expP != null && othP ? expP / othP : null,
    from: days.length ? days[0].date : null, to: days.length ? days[days.length - 1].date : null };
}

// The table's windows: since today's expiry weekdays until CAS, the last N days
// before CAS, CAS settlement, VWAP again, and the last N days. `chg` is each
// row's contracts multiple against the last N days before CAS.
function expirySplitPeriods(days, win = CP_EXP_WINDOW) {
  const [cas, vwap] = CP_SETTLEMENT_SWITCHES.map(s => s.date);
  const between = (from, to) => days.filter(d => (!from || d.date >= from) && (!to || d.date < to));
  const preCas = between(null, cas);
  const rows = [
    { key: 'pre', label: `Before CAS, from ${rxDate(CP_EXPIRY_WEEKDAYS_FROM)}`, ...expirySplitStats(between(CP_EXPIRY_WEEKDAYS_FROM, cas)) },
    { key: 'preN', label: `Last ${win} days before CAS`, ...expirySplitStats(preCas.slice(-win)) },
    { key: 'cas', label: 'CAS settlement', ...expirySplitStats(between(cas, vwap)) },
    { key: 'vwap', label: `VWAP again, from ${rxDate(vwap)}`, ...expirySplitStats(between(vwap, null)) },
    { key: 'lastN', label: `Last ${win} days`, ...expirySplitStats(days.slice(-win)) },
  ];
  const base = rows[1].cMult;
  rows.forEach(r => { r.chg = r.key !== 'preN' && base && r.cMult != null ? (r.cMult - base) / base : null; });
  return rows;
}

// Monday of an ISO date's week
function cpWeekStart(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

// Weekly expiry multiples over the last `weeks` weeks that held an expiry day:
// [{ week, expiryDate, cMult, pMult }], each the window's average expiry day ÷
// its average other day; null until `weeks` weeks are in or without other days.
function expiryWeeklyMultiples(days, weeks = CP_EXP_ROLL_WEEKS) {
  const byWeek = new Map();
  days.forEach(d => {
    const w = cpWeekStart(d.date);
    if (!byWeek.has(w)) byWeek.set(w, { week: w, expiryDate: null, e: { n: 0, c: 0, p: 0 }, o: { n: 0, c: 0, p: 0 } });
    const b = byWeek.get(w), s = d.expiry ? b.e : b.o;
    if (d.expiry) b.expiryDate = d.date;
    s.n++; s.c += d.contracts; s.p += d.premium;
  });
  const list = [...byWeek.values()].filter(b => b.e.n).sort((a, b) => a.week.localeCompare(b.week));
  return list.map((b, i) => {
    if (i < weeks - 1) return { week: b.week, expiryDate: b.expiryDate, cMult: null, pMult: null };
    const win = list.slice(i - weeks + 1, i + 1);
    const t = k => win.reduce((a, w) => ({ n: a.n + w[k].n, c: a.c + w[k].c, p: a.p + w[k].p }), { n: 0, c: 0, p: 0 });
    const e = t('e'), o = t('o');
    return { week: b.week, expiryDate: b.expiryDate,
      cMult: o.n && o.c ? (e.c / e.n) / (o.c / o.n) : null, pMult: o.n && o.p ? (e.p / e.n) / (o.p / o.n) : null };
  });
}

function cpMultText(v) { return v == null || !isFinite(v) ? '—' : fmtNum(v, 2) + '×'; }

function cpExpiryTableHTML(byEx) {
  const body = byEx.map(({ name, rows }) => `<tbody>
      <tr><th scope="rowgroup" colspan="9" class="rx-l">${name}</th></tr>
      ${rows.map(r => {
        const has = r.expDays && r.othDays;
        const span = r.from ? ` title="${escHtml(rxDate(r.from) + ' to ' + rxDate(r.to))}"` : '';
        const tag = r.key === 'vwap' && !r.from ? ` ${rxChip('no days yet')}` : r.key === 'preN' ? ` ${rxChip('baseline')}` : '';
        return `<tr${r.key === 'lastN' ? ' class="rx-sub"' : ''}>
          <td${span}>${escHtml(r.label)}${tag}</td>
          <td>${r.from ? `${r.expDays} / ${r.othDays}` : '—'}</td>
          <td>${r.expDays ? cpContractsCr(r.expC) : '—'}</td>
          <td>${r.othDays ? cpContractsCr(r.othC) : '—'}</td>
          <td class="rx-hl">${has ? cpMultText(r.cMult) : '—'}</td>
          <td>${rxSignedPct(r.chg)}</td>
          <td>${r.expDays ? fmtNum(r.expP, 0) : '—'}</td>
          <td>${r.othDays ? fmtNum(r.othP, 0) : '—'}</td>
          <td>${has ? cpMultText(r.pMult) : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>`).join('');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead><tr><th scope="col" rowspan="2">Window</th>
      <th scope="col" rowspan="2" title="Expiry days / other trading days">Days</th>
      <th scope="colgroup" colspan="4" title="Option contracts on the average day, crore">Contracts, Cr</th>
      <th scope="colgroup" colspan="3" title="Option premium on the average day, ₹ Cr">Premium, ₹ Cr</th></tr>
      <tr><th scope="col" title="Option contracts on the average expiry day, crore">Expiry day</th>
      <th scope="col" title="Option contracts on the average other day, crore">Other day</th>
      <th scope="col" class="rx-hl" title="Average expiry-day contracts ÷ average other-day contracts">Multiple</th>
      <th scope="col" title="This row's contracts multiple against the last ${CP_EXP_WINDOW} days before CAS">vs baseline</th>
      <th scope="col" title="Option premium on the average expiry day, ₹ Cr">Expiry day</th>
      <th scope="col" title="Option premium on the average other day, ₹ Cr">Other day</th>
      <th scope="col" title="Average expiry-day premium ÷ average other-day premium">Multiple</th></tr></thead>
    ${body}
  </table></div>`;
}

function cpExpiryHowHTML() {
  return rxHow('How this is measured', `
    <p>For each exchange, its <b>expiry days</b> are its weekly benchmark expiries (Nifty on NSE, Sensex on BSE: the weekday in force, moved to the previous trading day of the same week for a holiday), as Revenue Summary counts them; every other trading day is an <b>other day</b>. The <b>multiple</b> is the average expiry day ÷ the average other day, for contracts and for premium. Comparing the two kinds of day on the same exchange over the same weeks nets out the market's overall level (volatility, sentiment), so the multiple moves with what happens near the expiry close.</p>
    <ul>
      <li>Expiring F&amp;O contracts settled on the cash market's 30-minute VWAP until 31 Jul 2026, on the closing auction (CAS) price from 3 Aug 2026 (SEBI circular of 16 Jan 2026), and settle on the 30-minute VWAP again from 7 Dec 2026 (circular of 15 Oct 2026; the auction stays as a 3:30–3:40 pm cash session, and expiring index options stop at 3:30 pm).</li>
      <li>The baseline is the last ${CP_EXP_WINDOW} trading days before CAS. The longer pre-CAS row starts on ${rxDate(CP_EXPIRY_WEEKDAYS_FROM)}, when today's expiry weekdays (NSE Tuesday, BSE Thursday) began.</li>
      <li>A contracts multiple that rises while the premium multiple does not means the added expiry-day trading is in cheap, near-expiry options: more contracts and orders (what brokers charge on) for little premium (what exchanges bill).</li>
      <li>The chart's lines are the multiple over the last ${CP_EXP_ROLL_WEEKS} weeks with an expiry, one point per week. Month-end expiries are larger, so single weeks are noisy.</li>
      <li>NSE counts index and stock options; BSE's count is its F&amp;O total, whose futures are negligible. Muhurat and DR-test sessions are left out.</li>
    </ul>`);
}

// Dashed vertical lines at given category-axis labels (the settlement switches)
const CP_SWITCH_LINE = {
  id: 'cpSwitchLine',
  afterDatasetsDraw(chart, args, opts) {
    const x = chart.scales.x, area = chart.chartArea, ctx = chart.ctx;
    ((opts && opts.indices) || []).forEach(i => {
      if (!x || i == null || i < x.min || i > x.max) return;
      const px = x.getPixelForValue(i);
      ctx.save();
      ctx.strokeStyle = RX.grey; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, area.top); ctx.lineTo(px, area.bottom); ctx.stroke();
      ctx.restore();
    });
  },
};

function cpRatioText(v) { return v == null || !isFinite(v) ? '—' : fmtNum(v, 0); }
function cpContractsCr(v) { return v == null || !isFinite(v) ? '—' : fmtNum(v / 1e7, 2); }

function cpPeriodTableHTML(groups) {
  const body = groups.map(g => `<tbody>
      <tr><th scope="rowgroup" colspan="6" class="rx-l">${g.title}</th></tr>
      ${g.rows.map((r, i) => {
        const tag = r.toDate ? ` ${rxChip('to date')}` : '';
        const span = r.days ? ` title="${escHtml(rxDate(r.from) + ' to ' + rxDate(r.to))}"` : '';
        return `<tr${i === 0 ? ' class="rx-sub"' : ''}>
          <td${span}>${escHtml(r.label || '—')}${tag}</td>
          <td class="rx-hl">${cpRatioText(r.ratio)}</td>
          <td>${i === 0 ? '' : rxSignedPct(r.chg)}</td>
          <td>${r.days || '—'}</td>
          <td>${r.days ? cpContractsCr(r.contracts) : '—'}</td>
          <td>${r.days ? fmtNum(r.premium, 0) : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>`).join('');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead><tr><th scope="col">Period</th>
      <th scope="col" class="rx-hl" title="Σ contracts ÷ Σ premium (₹ Cr)">Contracts per ₹ Cr</th>
      <th scope="col" title="The current period's contracts per ₹ Cr against this row's: (current − row) ÷ row">% chg</th>
      <th scope="col" title="Trading days with both exchanges' options data">Days</th>
      <th scope="col" title="NSE + BSE option contracts, crore">Contracts, Cr</th><th scope="col" title="NSE + BSE option premium">Premium, ₹ Cr</th></tr></thead>
    ${body}
  </table></div>`;
}

function cpHowHTML(excluded) {
  const bseGaps = excluded.filter(e => e.missing !== 'nse');
  return rxHow('How this is measured', `
    <p><b>Contracts per ₹ 1 Cr of premium</b> = (NSE index option contracts + NSE stock option contracts + BSE contracts) ÷ (NSE index option premium + NSE stock option premium + BSE options premium turnover), with premium in ₹ Cr. It is the inverse of the average premium paid per contract: it rises when trading moves to cheap, far-from-the-money or near-expiry options.</p>
    <ul>
      <li>NSE counts options only (index and stock options). BSE's contract count is its F&amp;O total, which includes BSE's very small futures volume.</li>
      <li>Brokers → F&amp;O vs Exchanges plots a similar ratio from NSE's total F&amp;O contracts (futures included), so its figure runs slightly higher than this one.</li>
      <li>Periods divide the period's total contracts by its total premium, not the average of daily ratios, so a heavy expiry day counts for what it traded. The chart's line is the same ratio over the last ${CP_MA_WINDOW} trading days.</li>
      <li>Only days on which both exchanges report options contracts and premium count${excluded.length ? `: ${excluded.length} day${excluded.length === 1 ? '' : 's'} left out${bseGaps.length ? `, ${bseGaps.length === excluded.length ? 'all' : bseGaps.length} with no BSE options data (${rxDate(bseGaps[0].date)} to ${rxDate(bseGaps[bseGaps.length - 1].date)})` : ''}` : ''}. Muhurat and DR-test sessions are left out, as everywhere on the dashboard.</li>
      <li>Contracts and premium are traded volumes, not fees: the Fees setting does not change any figure here, and the exchange switcher shows the same combined view.</li>
    </ul>`);
}

async function buildContractsPremium() {
  const el = document.getElementById('contractsPremiumContent');
  if (!el) return;
  const seq = ++cpBuildSeq, ex = currentExchange;
  // A single NSE or BSE view has its own file in DATA; the other comes from the shared cache
  const own = VIEW_LOADED && !DATA.components ? VIEW_LOADED.exchange : null;
  const cached = ['nse', 'bse'].filter(e => e !== own);
  if (cached.some(e => !MARKET_RAW[e])) el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>Loading NSE and BSE data…</b></div>' })}</div>`;
  await ensureFreshMarketData(cached);
  if (seq !== cpBuildSeq || currentExchange !== ex) return;   // rebuilt or switched away while loading
  const nseRaw = rawFor('nse'), bseRaw = rawFor('bse');
  if (!nseRaw?.daily_all || !bseRaw?.daily_all) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>Couldn\'t load NSE and BSE data</b>Try again in a moment.</div>' })}</div>`;
    return;
  }
  cached.forEach(e => { VIEW_BUILT_FROM[e] = marketSig(e); });
  VIEW_SOURCES.contracts = [{ ex: 'nse', date: lastTradeDate(nseRaw.daily_all) }, { ex: 'bse', date: lastTradeDate(bseRaw.daily_all) }];
  updateSnapshotNotice();

  const { days, excluded } = contractsPremiumDaily(nseRaw.daily_all, bseRaw.daily_all);
  if (!days.length) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>No days with both NSE and BSE options data</b></div>' })}</div>`;
    return;
  }
  const groups = contractsPremiumPeriods(days);
  const last = days[days.length - 1];
  const month = groups.find(g => g.kind === 'month').rows, tail = groups.find(g => g.kind === 'days').rows;
  // Expiry days: each exchange's weekly benchmark expiry (Nifty, Sensex), as Revenue Summary counts them
  const exp = new Set([...expiryDateSet(nseRaw.daily_all, 'nse'), ...expiryDateSet(bseRaw.daily_all, 'bse')]);

  const expDaily = CP_EXP_EXCHANGES.map(e => ({ ...e, days: expirySplitDaily(rawFor(e.ex).daily_all, e.ex, expiryDateSet(rawFor(e.ex).daily_all, e.ex)) }));
  const expByEx = expDaily.map(e => ({ name: e.name, rows: expirySplitPeriods(e.days) }));

  const leftOut = excluded.length
    ? `<span title="${escHtml(`Dates without options contracts and premium on both exchanges, ${rxDate(excluded[0].date)} to ${rxDate(excluded[excluded.length - 1].date)}`)}">${rxChip(`${excluded.length} day${excluded.length === 1 ? '' : 's'} left out`, 'warn')}</span>` : '';
  const kpis = rxKpis([
    rxKpi(`Latest day · ${escHtml(rxDate(last.date))}`, cpRatioText(last.ratio),
      `${cpContractsCr(last.contracts)} Cr contracts · ₹${fmtNum(last.premium, 0)} Cr premium${exp.has(last.date) ? ' · expiry day' : ''}`, { accent: true }),
    rxKpi(`Current month · ${escHtml(month[0].label)}`, cpRatioText(month[0].ratio),
      `${month[0].days} days · vs ${escHtml(month[1].label || 'previous month')} ${rxSignedPct(month[1].chg)}`),
    rxKpi('Last 45 days', cpRatioText(tail[2].ratio),
      `${escHtml(rxDate(tail[2].from))} to ${escHtml(rxDate(tail[2].to))} · last 5 days vs it ${rxSignedPct(tail[2].chg)}`),
  ], 'Contracts per ₹ Cr of premium');

  el.innerHTML = `<div class="rx">
    <div class="rx-bar" style="position:static">
      <div class="rx-grp">${rxChip('NSE + BSE combined', 'data')} ${rxChip('Not fee-dependent')} ${leftOut}</div>
      <p class="rx-foot">Option contracts per ₹ 1 Cr of option premium · data to ${escHtml(rxDate(last.date))}</p>
    </div>
    ${kpis}
    ${rxPanel({ title: 'Contracts per ₹ Cr of premium', meta: '<span data-cp="meta"></span>',
      right: rxSeg('cpRange', CP_RANGES.map(r => [r[0], r[1]]), CP_VIEW.range, 'Chart range'),
      body: `${rxCanvas('chartContractsPremium')}<div class="rx-pb" data-cp="legend"></div>`,
      foot: `Dots: single days (orange: an NSE or BSE weekly expiry, when contracts jump and premium per contract falls). Line: Σ contracts ÷ Σ premium over the last ${CP_MA_WINDOW} trading days.` })}
    ${rxPanel({ title: 'By period', meta: 'Σ contracts ÷ Σ premium · NSE + BSE options',
      body: cpPeriodTableHTML(groups),
      foot: 'Contracts in crore (10 million); premium in ₹ Cr. % chg: the current period of each kind against that row, (current − row) ÷ row; for the trading-day rows, the last 5 days against each. Hover a period for its dates.',
      how: cpHowHTML(excluded) })}
    ${rxPanel({ title: 'Expiry days vs other days', meta: '<span data-cp="expMeta"></span>',
      right: `${rxSeg('cpExpMetric', [['contracts', 'Contracts'], ['premium', 'Premium']], CP_VIEW.expMetric, 'Chart measure')} ${rxSeg('cpExpRange', CP_RANGES.map(r => [r[0], r[1]]), CP_VIEW.expRange, 'Chart range')}`,
      body: `${rxCanvas('chartExpiryMultiple')}<div class="rx-pb" data-cp="expLegend"></div>`,
      foot: `Average expiry day ÷ average other day on the same exchange, over the last ${CP_EXP_ROLL_WEEKS} weeks with an expiry. Dashed lines: ${CP_SETTLEMENT_SWITCHES.map(s => `${escHtml(rxDate(s.date))}, ${escHtml(s.label)}`).join('; ')}.` })}
    ${rxPanel({ title: 'Expiry-day multiple by settlement window', meta: 'per exchange · average expiry day ÷ average other day',
      body: cpExpiryTableHTML(expByEx),
      foot: `Contracts in crore (10 million); premium in ₹ Cr. vs baseline: the row's contracts multiple against the last ${CP_EXP_WINDOW} trading days before CAS. Hover a window for its dates.`,
      how: cpExpiryHowHTML() })}
  </div>`;
  const root = el.firstElementChild;

  const roll = contractsPremiumRolling(days, CP_MA_WINDOW);
  const draw = () => {
    const start = cpRangeStart(last.date, CP_VIEW.range);
    const first = start ? Math.max(0, days.findIndex(r => r.date >= start)) : 0;
    const rows = days.slice(first), line = roll.slice(first), dates = rows.map(r => r.date);
    const meta = root.querySelector('[data-cp="meta"]');
    if (meta) meta.textContent = `${rxDate(rows[0].date)} to ${rxDate(last.date)} · ${rows.length} days`;
    rxChart('cpRatio', 'chartContractsPremium', 280, {
      type: 'line',
      data: { labels: dates.map(fmtChartDate), datasets: [
        { label: `${CP_MA_WINDOW}-day ratio`, data: line, borderColor: RX.model, borderWidth: 2.25, pointRadius: 0, tension: 0, spanGaps: false, order: 0 },
        { label: 'Day', data: rows.map(r => r.ratio), showLine: false, pointRadius: rows.length > 300 ? 1.6 : 2.2, pointHoverRadius: 4,
          pointBackgroundColor: rows.map(r => exp.has(r.date) ? CP_EXP_COLOR : RX.light), pointBorderWidth: 0, order: 1 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => `${rxDate(dates[items[0].dataIndex])}${exp.has(dates[items[0].dataIndex]) ? ' · expiry day' : ''}`,
          label: ctx => ` ${ctx.dataset.label}: ${cpRatioText(ctx.raw)}`,
          footer: items => { const r = rows[items[0].dataIndex]; return `${cpContractsCr(r.contracts)} Cr contracts · ₹${fmtNum(r.premium, 0)} Cr premium`; } } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: brkMonthTicks(dates, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { grace: '4%', title: { display: true, text: 'Contracts per ₹ Cr' }, ticks: { includeBounds: false, callback: v => fmtNum(v, 0) } },
        },
      },
    });
  };
  root.querySelector('[data-cp="legend"]').innerHTML = rxLegend([
    { label: `${CP_MA_WINDOW}-day ratio`, color: RX.model, kind: 'line' },
    { label: 'Expiry day (NSE or BSE)', color: CP_EXP_COLOR }, { label: 'Other day', color: RX.light },
  ]);
  // Expiry multiple chart: one point per week (its Monday), NSE and BSE aligned by week
  const weekly = expDaily.map(e => ({ ...e, mult: new Map(expiryWeeklyMultiples(e.days).map(w => [w.week, w])) }));
  const allWeeks = [...new Set(weekly.flatMap(e => [...e.mult.keys()]))].sort();
  const drawExp = () => {
    const start = cpRangeStart(last.date, CP_VIEW.expRange);
    const weeks = allWeeks.filter(w => !start || w >= start);
    const key = CP_VIEW.expMetric === 'premium' ? 'pMult' : 'cMult';
    const meta = root.querySelector('[data-cp="expMeta"]');
    if (meta) meta.textContent = weeks.length ? `weeks of ${rxDate(weeks[0])} to ${rxDate(weeks[weeks.length - 1])} · ${CP_VIEW.expMetric}` : '';
    const switchIdx = CP_SETTLEMENT_SWITCHES.map(s => { const i = weeks.findIndex(w => w >= cpWeekStart(s.date)); return i > 0 ? i : null; });
    rxChart('cpExpiry', 'chartExpiryMultiple', 260, {
      type: 'line',
      data: { labels: weeks.map(fmtChartDate), datasets: weekly.map(e => ({
        label: e.name, data: weeks.map(w => (e.mult.get(w) || {})[key] ?? null),
        borderColor: e.color, backgroundColor: e.color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0, spanGaps: true })) },
      plugins: [CP_SWITCH_LINE],
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          cpSwitchLine: { indices: switchIdx },
          tooltip: { callbacks: {
            title: items => `Week of ${rxDate(weeks[items[0].dataIndex])}`,
            label: ctx => { const w = weekly[ctx.datasetIndex].mult.get(weeks[ctx.dataIndex]);
              return ` ${ctx.dataset.label}: ${cpMultText(ctx.raw)}${w && w.expiryDate ? ` · expiry ${rxDate(w.expiryDate)}` : ''}`; } } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: brkMonthTicks(weeks, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { grace: '6%', title: { display: true, text: `Expiry day ÷ other day, ${CP_VIEW.expMetric}` }, ticks: { includeBounds: false, callback: v => fmtNum(v, 1) + '×' } },
        },
      },
    });
  };
  root.querySelector('[data-cp="expLegend"]').innerHTML = rxLegend([
    ...weekly.map(e => ({ label: `${e.name} (${e.ex === 'nse' ? 'Nifty' : 'Sensex'} expiry)`, color: e.color, kind: 'line' })),
    { label: 'Settlement rule changes', color: RX.grey, kind: 'dash' },
  ]);
  draw();
  drawExp();
  rxOnSeg(root, 'cpRange', v => { CP_VIEW.range = v; draw(); });
  rxOnSeg(root, 'cpExpRange', v => { CP_VIEW.expRange = v; drawExp(); });
  rxOnSeg(root, 'cpExpMetric', v => { CP_VIEW.expMetric = v; drawExp(); });
  RX_TAB_REFRESH.contracts = () => { draw(); drawExp(); };
}
