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
const CC_VIEW = { win: '20d', und: 'all', metric: 'prem', range: '1y', top: 'prem', topMonth: null };   // topMonth null = the latest
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
// its premium can't be compared, so premium shares and averages leave it out
function ccPremOk(r) {
  return !(ccVal(r.mcx, 'all', 'onot') > 0 && !ccVal(r.mcx, 'all', 'prem'));
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

// Change in percentage points, coloured
function ccPp(cur, prev) {
  if (cur == null || prev == null) return '<td>—</td>';
  const d = (cur - prev) * 100, t = ccPpText(d);
  return `<td${t.moved ? ` class="${d > 0 ? 'rx-up' : 'rx-dn'}"` : ''}>${t.text}</td>`;
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
  return metric === 'rev' ? (p.ru_days?.[side] ?? 0) : p.days;
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
    const tag = k === 'all' ? '' : nseOnly ? ` ${rxChip('NSE only')}` : !nseAny ? ` ${rxChip('MCX only')}` : '';
    return `<tr${k === 'all' ? ' class="rx-sub"' : ''}>
      <td class="rx-l">${escHtml(ccLabel(doc, k))}${tag}</td>
      <td>${ccCr(cell('fut', 'nse', w.rows, n))}</td><td>${ccCr(cell('fut', 'mcx', w.rows, n))}</td>
      <td class="rx-hl">${ccPct(fs)}</td>${ccPp(fs, w.prev.length && fs != null ? ccShare(w.prev, k, 'fut') : null)}
      <td>${ccCr(cell('prem', 'nse', premRows, nPrem))}</td><td>${ccCr(cell('prem', 'mcx', premRows, nPrem))}</td>
      <td class="rx-hl">${ccPct(ps)}</td>${ccPp(ps, w.prev.length && ps != null ? ccShare(w.prev, k, 'prem') : null)}
      <td>${ccPct(os)}</td>
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
      foot: 'Averages per session over the window. NSE share = NSE ÷ (NSE + MCX), in ₹, on the underlying (contract sizes differ). '
        + '"vs before" is the change in percentage points against the window before (the session before, the 20 sessions before, the month, quarter or FY before). '
        + 'MCX\'s indices and agri contracts count in "All commodities"; NSE lists neither. NSE\'s Brent crude has no MCX contract, so no share.' + premNote })}
    ${rxPanel({ title: 'NSE share by day', meta: '<span data-cc="daymeta"></span>',
      right: rxSeg('ccRange', CC_RANGES.map(([v, l]) => [v, l]), CC_VIEW.range, 'Range'),
      body: `<div class="rx-pb" style="padding-bottom:4px">
          <div class="cc-ctl">${rxSeg('ccUnd', CC_CHART_UNDS.map(k => [k, escHtml(ccLabel(doc, k))]), CC_VIEW.und, 'Underlying')}
          ${rxSeg('ccMetric', CC_METRICS, CC_VIEW.metric, 'Measure')}</div>
          ${rxLegend([{ label: 'Each session', color: RX.light, kind: 'dot' }, { label: `${CC_ROLL}-session share`, color: RX.model, kind: 'line' }])}
          ${rxCanvas('chartCcDaily')}</div>`,
      foot: 'NSE\'s crude and natural-gas options expire a day before MCX\'s, and most of its options volume comes on its own expiry day and the day before, so the daily share spikes once a month; the 20-session line evens that out. '
        + 'The scale follows the 20-session line: sessions above the scale are drawn as triangles on the top edge, with their share in the tooltip. '
        + (doc.notes || []).map(n => `${rxDate(n.date)}: ${escHtml(n.label)}.`).join(' ') + premNote })}
    ${rxPanel({ title: 'NSE share by month', meta: '<span data-cc="monmeta"></span>', body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas('chartCcMonthly')}</div>` })}
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
    const sumPrem = ccSum(w.rows, 'nse', 'all', 'prem');   // null when a premium is unknown
    const nseFut = ccSum(w.rows, 'nse', 'all', 'fut') / n, nsePrem = sumPrem == null ? null : sumPrem / n;
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
    q('monmeta').textContent = `${ccLabel(doc, und)} · ${CC_METRIC_TEXT[metric]} · sessions with both exchanges' figures; the latest month is to date`;
    rxChart('ccMonthly', 'chartCcMonthly', 220, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [{ label: 'NSE share', data: vals, backgroundColor: RX.model, borderWidth: 0 }] },
      options: {
        plugins: { tooltip: { callbacks: {
          label: ctx => ` NSE share: ${ccPct(ctx.raw / 100)}`,
          footer: items => {
            const p = months[items[0].dataIndex];
            return `${p.days} sessions · NSE ₹${ccCr(ccVal(p.nse, und, metric) / p.days)} Cr a day · MCX ₹${ccCr(ccVal(p.mcx, und, metric) / p.days)} Cr a day`;
          } } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: 'NSE share, %' }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
  };

  const drawRev = () => {
    const months = (doc.monthly || []).filter(p => p.days > 0);
    rxChart('ccRev', 'chartCcRev', 200, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [
        { label: 'At today\'s rates', data: months.map(p => p.rev[0] * 100), backgroundColor: RX.rev, borderWidth: 0 },
      ] },
      options: {
        plugins: { tooltip: { callbacks: {
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
        backgroundColor: ctx => (ctx.dataIndex === idx ? CC_TOP_COLORS[und] : `${CC_TOP_COLORS[und]}59`),
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
    // the month itself is in the picker beside it
    q('toptitle').textContent = `${metricText[0].toUpperCase()}${metricText.slice(1)} a session${idx > 0 && metric !== 'con' ? ` · NSE share against ${ccMonthLabel(months[idx - 1].month)}` : ''}`;
    q('toptable').innerHTML = ccTopTableHTML(doc, months, idx, metric);
  };

  const drawCharts = () => { drawDaily(); drawMonthly(); drawTop(); drawRev(); };
  drawTable();
  drawCharts();
  rxOnSeg(root, 'ccWin', v => { CC_VIEW.win = v; drawTable(); });
  rxOnSeg(root, 'ccUnd', v => { CC_VIEW.und = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccMetric', v => { CC_VIEW.metric = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccRange', v => { CC_VIEW.range = v; drawDaily(); });
  rxOnSeg(root, 'ccTop', v => { CC_VIEW.top = v; drawTop(); });
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
