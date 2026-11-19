// dashboard/js/21-vix.js — India VIX panel on Revenue Summary (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// VIX → ADR SENSITIVITY and WEEK-ON-WEEK VIX — NSE, BSE, MCX and Total on
// total revenue at today's rates, whatever the exchange switcher shows.
// Elasticity β per exchange, by OLS on daily rows since VIX_FIT_FROM:
//   ln(rev_t / MA45_{t-1}) = a + weekday dummies + β · ln(VIX_t / VIXMA45_{t-1})
// MA45 is the mean revenue of the previous 45 sessions, VIXMA45 the mean VIX of
// those of them that have one; the weekday dummies absorb expiry-day
// concentration. VIX is NSE's daily_all[].vix, joined by date for BSE and MCX
// (MCX days with no NSE session are left out). MCX modelled rows are dropped.
// Projection: ADR(V) = ADR45 × (V / VIX45)^β, ADR45 being each exchange's mean
// revenue over its last 45 sessions and VIX45 NSE's mean VIX over its last 45.
// ========================

// First date a fit point may have; the sensitivity table's VIX levels; sessions
// in the revenue / VIX moving averages and in the base. (Comments stay above the
// consts: tests/helpers.js_source ends a const at its first ";\n".)
const VIX_FIT_FROM = '2025-02-01';
const VIX_LEVELS = [11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 25];
const VIX_MA = 45;

// { date: vix } over NSE rows with a VIX (> 0; the pipeline stores 0 until it is fetched).
function vixByDate(nseRows) {
  const out = {};
  (nseRows || []).forEach(r => { if (r && r.vix > 0) out[r.date] = r.vix; });
  return out;
}

// Fit points [{ date, y, x, dow }] from one exchange's daily_all (date order).
// Modelled rows are dropped first. A point needs a date ≥ `from`, a full 45-row
// window before it, VIX on its own date and revenue > 0. y uses the window's mean
// revenue, x the mean VIX of the window rows that have one (MCX trades some NSE
// holidays, which have none). dow is 0–4 for Mon–Fri; a weekend session takes
// Friday's dummy.
function vixFitSample(rows, vixMap, from = VIX_FIT_FROM) {
  const days = (rows || []).filter(r => r && !r.modelled);
  const out = [];
  days.forEach((r, i) => {
    const v = vixMap[r.date];
    if (i < VIX_MA || r.date < from || !(v > 0) || !(r.total_rev > 0)) return;
    let revSum = 0, vixSum = 0, vixN = 0;
    for (let j = i - VIX_MA; j < i; j++) {
      revSum += Number(days[j].total_rev) || 0;
      const w = vixMap[days[j].date];
      if (w > 0) { vixSum += w; vixN++; }
    }
    // VIX MA over the window rows that have VIX, not the last 45 VIX-bearing rows (accepted reading)
    const revMA = revSum / VIX_MA, vixMA = vixN ? vixSum / vixN : 0;
    if (!(revMA > 0) || !(vixMA > 0)) return;
    const wd = new Date(r.date + 'T00:00:00Z').getUTCDay();
    out.push({ date: r.date, y: Math.log(r.total_rev / revMA), x: Math.log(v / vixMA),
               dow: wd >= 1 && wd <= 5 ? wd - 1 : 4 });
  });
  return out;
}

// OLS coefficients for y ~ X (X carries its own intercept column): normal
// equations solved by Gaussian elimination with partial pivoting. null when
// X'X is singular (a pivot vanishes against the matrix's scale).
function vixOLS(X, y) {
  const k = X && X[0] ? X[0].length : 0;
  if (!k || X.length < k || y.length !== X.length) return null;
  const A = Array.from({ length: k }, () => new Array(k + 1).fill(0));
  X.forEach((row, i) => {
    for (let a = 0; a < k; a++) {
      for (let b = 0; b < k; b++) A[a][b] += row[a] * row[b];
      A[a][k] += row[a] * y[i];
    }
  });
  const scale = Math.max(1e-300, ...A.map((row, i) => Math.abs(row[i])));
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (!(Math.abs(A[p][c]) > 1e-12 * scale)) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = c + 1; r < k; r++) {
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  const b = new Array(k).fill(0);
  for (let c = k - 1; c >= 0; c--) {
    let s = A[c][k];
    for (let j = c + 1; j < k; j++) s -= A[c][j] * b[j];
    b[c] = s / A[c][c];
  }
  return b;
}

// { beta, r2, r2Dow, r2Vix, n } of y ~ 1 + dummies(dow 1..4) + x; r2Dow is the
// R² of the dummies alone, so r2Vix is the VIX term's own contribution. A
// weekday with no point gets no dummy. null below 60 points or if singular.
function vixFit(sample) {
  const n = (sample || []).length;
  if (n < 60) return null;
  const dows = [1, 2, 3, 4].filter(d => sample.some(p => p.dow === d));
  const y = sample.map(p => p.y);
  const Xd = sample.map(p => [1, ...dows.map(d => (p.dow === d ? 1 : 0))]);
  const Xf = sample.map((p, i) => [...Xd[i], p.x]);
  const bf = vixOLS(Xf, y), bd = vixOLS(Xd, y);
  if (!bf || !bd) return null;
  const yMean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - yMean) ** 2, 0);
  const r2 = (X, b) => {
    if (!(sst > 0)) return 0;
    const ssr = X.reduce((s, row, i) => s + (y[i] - row.reduce((t, v, j) => t + v * b[j], 0)) ** 2, 0);
    return 1 - ssr / sst;
  };
  const r2Full = r2(Xf, bf), r2Dow = r2(Xd, bd);
  return { beta: bf[bf.length - 1], r2: r2Full, r2Dow, r2Vix: r2Full - r2Dow, n };
}

// ADR45: mean total_rev of the last n non-modelled rows (null without rows).
function vixBase(rows, n = VIX_MA) {
  const last = (rows || []).filter(r => r && !r.modelled).slice(-n);
  return last.length ? last.reduce((s, r) => s + (Number(r.total_rev) || 0), 0) / last.length : null;
}

// VIX45: mean of the last n positive vix in NSE's rows (null without any).
function vixMean(nseRows, n = VIX_MA) {
  const last = (nseRows || []).map(r => r && r.vix).filter(v => v > 0).slice(-n);
  return last.length ? last.reduce((s, v) => s + v, 0) / last.length : null;
}

// Sensitivity rows, sorted by vix: the VIX_LEVELS plus today's VIX ('today') and
// VIX45 ('base'). A level within 0.05 of today or of the base is folded into that
// row; when today and the base coincide, today wins. Each row is
// { vix, kind, pctVsBase, adr: {nse, bse, mcx}, total, totalPct, outside }, the
// percentages as fractions: pctVsBase vs VIX45, totalPct vs the summed ADR45 of
// the exchanges in Total. An exchange with a null beta (no fit) has adr null and
// stays out of Total. `outside`: the vix is outside range = {min, max}, the
// VIX range of the fit sample.
function vixSensitivityRows(perEx, vix45, todayVix, range) {
  if (!(vix45 > 0)) return [];
  const today = todayVix > 0 ? todayVix : null;
  const near = (a, b) => b != null && Math.abs(a - b) <= 0.05 + 1e-9;
  const points = VIX_LEVELS.filter(v => !near(v, today) && !near(v, vix45)).map(v => ({ vix: v, kind: 'level' }));
  if (today != null) points.push({ vix: today, kind: 'today' });
  if (!near(vix45, today)) points.push({ vix: vix45, kind: 'base' });
  points.sort((a, b) => a.vix - b.vix);
  const exs = ['nse', 'bse', 'mcx'];
  const inTotal = exs.filter(ex => perEx && perEx[ex] && Number.isFinite(perEx[ex].beta) && Number.isFinite(perEx[ex].adr));
  const baseTotal = inTotal.reduce((s, ex) => s + perEx[ex].adr, 0);
  const lo = range && Number.isFinite(range.min) ? range.min : -Infinity;
  const hi = range && Number.isFinite(range.max) ? range.max : Infinity;
  return points.map(p => {
    const ratio = p.vix / vix45;
    const adr = {};
    exs.forEach(ex => { adr[ex] = inTotal.includes(ex) ? perEx[ex].adr * Math.pow(ratio, perEx[ex].beta) : null; });
    const total = inTotal.length ? inTotal.reduce((s, ex) => s + adr[ex], 0) : null;
    return { vix: p.vix, kind: p.kind, pctVsBase: ratio - 1, adr, total,
             totalPct: total != null && baseTotal > 0 ? total / baseTotal - 1 : null,
             outside: p.vix < lo || p.vix > hi };
  });
}

// Week-on-week VIX: the last `weeks` Mon–Sun weeks (cpWeekStart) of NSE trading
// dates, newest first: { week, label, sessions, avgVix, closeVix (last session's
// VIX), chgPts, chgPct, totalAdr, totalPct, inProgress }. totalAdr is the mean of
// totalByDate (NSE + BSE + MCX total_rev, built by the caller) over the week's
// NSE sessions. Changes (fractions for %) are against the next-older week in the
// data, so the oldest row shown has them too unless no older week exists (one
// extra week is built for that, then dropped). inProgress marks the week of the
// latest NSE date while that date is before the week's Friday.
function vixWeeklyRows(nseRows, totalByDate, weeks = 8) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dm = iso => [Number(iso.slice(8, 10)), MON[Number(iso.slice(5, 7)) - 1]];
  const label = (a, b) => {
    const [d1, m1] = dm(a), [d2, m2] = dm(b);
    if (a === b) return `${d1} ${m1}`;
    return m1 === m2 ? `${d1}–${d2} ${m1}` : `${d1} ${m1} – ${d2} ${m2}`;
  };
  const mean = xs => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
  const days = (nseRows || []).filter(r => r && r.date).slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!days.length) return [];
  const byWeek = new Map();
  days.forEach(r => {
    const w = cpWeekStart(r.date);
    if (!byWeek.has(w)) byWeek.set(w, []);
    byWeek.get(w).push(r);
  });
  const latest = days[days.length - 1].date;
  const latestWeek = cpWeekStart(latest);
  const fri = new Date(latestWeek + 'T00:00:00Z');
  fri.setUTCDate(fri.getUTCDate() + 4);
  const latestFriday = fri.toISOString().slice(0, 10);
  const stats = [...byWeek.keys()].sort().reverse().slice(0, weeks + 1).map(w => {
    const ds = byWeek.get(w);
    const vix = ds.map(r => r.vix).filter(v => v > 0);
    const tot = ds.map(r => (totalByDate ? totalByDate[r.date] : undefined)).filter(Number.isFinite);
    return { week: w, label: label(ds[0].date, ds[ds.length - 1].date), sessions: ds.length,
             avgVix: mean(vix), closeVix: vix.length ? vix[vix.length - 1] : null, totalAdr: mean(tot),
             inProgress: w === latestWeek && latest < latestFriday };
  });
  return stats.map((s, i) => {
    const o = stats[i + 1];
    const vixChg = o && s.avgVix != null && o.avgVix > 0;
    return { week: s.week, label: s.label, sessions: s.sessions, avgVix: s.avgVix, closeVix: s.closeVix,
             chgPts: vixChg ? s.avgVix - o.avgVix : null, chgPct: vixChg ? s.avgVix / o.avgVix - 1 : null,
             totalAdr: s.totalAdr,
             totalPct: o && s.totalAdr != null && o.totalAdr > 0 ? s.totalAdr / o.totalAdr - 1 : null,
             inProgress: s.inProgress };
  }).slice(0, weeks);
}

// ========================
// LIVE INDIA VIX TICKER — a card after the live NSE / BSE cards (renderLiveCards,
// 10-revenue-summary.js), read from the NSE poll file those cards already hold
// (LIVE_CARD_CACHE.nse.hourly.india_vix), so it adds no fetch.
// ========================

// What the ticker shows: { kind, last, change, pctChange, when, source, age }.
// From the poll's india_vix, as the live cards read their polls (liveStatus): in
// market hours (Mon–Fri 09:15–16:00 IST) a read from today is 'live' when fresh
// and 'stale' when older than LIVE_STALE_MINUTES or flagged failed (stale_since);
// a read from today taken before 09:15 IST while it is still before 09:15 (the
// poller starts at 08:55, in the pre-open) is 'preopen';
// anything else, stale_since or not, is 'close' (the last reading of an earlier
// or finished session, so a failed Friday poll does not say "delayed" all
// weekend). `when` is the
// poll's as_of (UTC). Without a reading, or when NSE's daily rows hold a newer
// close, it is the latest positive vix in nseRows: kind 'close', `when` its date,
// change against the close before it. pctChange is in percent (4.16 = 4.16 %),
// as the poller writes it. null when there is no VIX at all.
function vixTickerModel(liveVix, nseRows, now = Date.now()) {
  const daily = (nseRows || []).filter(r => r && r.vix > 0);
  const lastRow = daily.length ? daily[daily.length - 1] : null;
  const istDate = ms => new Date(ms + 330 * 60000).toISOString().slice(0, 10);
  const t = liveVix ? Date.parse(liveVix.as_of) : NaN;
  const liveLast = liveVix ? Number(liveVix.last) : NaN;
  if (liveLast > 0 && !(lastRow && isFinite(t) && istDate(t) < lastRow.date)) {
    const ist = new Date(now + 330 * 60000);
    const wd = ist.getUTCDay(), mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const weekday = wd >= 1 && wd <= 5;
    const open = weekday && mins >= 555 && mins < 960;
    const age = isFinite(t) ? Math.round((now - t) / 60000) : null;
    const today = isFinite(t) && istDate(t) === istDate(now);
    const fresh = !liveVix.stale_since && age != null && age <= LIVE_STALE_MINUTES;
    const kind = open && today ? (fresh ? 'live' : 'stale') : weekday && today && mins < 555 ? 'preopen' : 'close';
    const num = v => (v == null || !isFinite(Number(v)) ? null : Number(v));
    return { kind, last: liveLast, change: num(liveVix.change), pctChange: num(liveVix.pct_change),
             when: liveVix.as_of || null, source: liveVix.source || null, age };
  }
  if (!lastRow) return null;
  const prev = daily.length > 1 ? daily[daily.length - 2].vix : null;
  return { kind: 'close', last: lastRow.vix, change: prev ? lastRow.vix - prev : null,
           pctChange: prev ? (lastRow.vix / prev - 1) * 100 : null, when: lastRow.date, source: 'daily', age: null };
}

// "HH:MM" IST of a UTC timestamp, and its IST date
function vixIstParts(ts) {
  const ms = Date.parse(ts);
  if (!isFinite(ms)) return { date: null, time: '' };
  const s = new Date(ms + 330 * 60000).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 16) };
}

function vixTickerHTML(m) {
  if (!m) return '';
  const name = '<span class="lvc-name">INDIA VIX</span>';
  const at = m.source === 'daily' ? { date: m.when, time: '' } : vixIstParts(m.when);
  const src = m.source === 'yfinance' ? ' (Yahoo Finance fallback)' : m.source === 'nse' ? ' (NSE)' : '';
  const pill = m.kind === 'live' ? `<span class="lvc-pill lvc-pill--live"><i></i>Live ${at.time}</span>`
    : m.kind === 'stale' ? `<span class="lvc-pill lvc-pill--stale" title="Last read ${escHtml(fmtTradeDate(at.date, true))} ${at.time} IST"><i></i>Delayed${m.age != null ? ` · ${m.age} min` : ''}</span>`
      : m.kind === 'preopen' ? `<span class="lvc-pill" title="Read in the pre-open, before trading starts at 09:15 IST"><i></i>Pre-open ${at.time}</span>`
      : `<span class="lvc-pill"><i></i>Last close · ${escHtml(fmtTradeDate(at.date, true))}</span>`;
  const up = m.change != null && m.change >= 0;
  const chg = m.change == null ? ''
    : `<span class="vix-chg ${up ? 'vix-chg--up' : 'vix-chg--dn'}">${up ? '▲' : '▼'}${fmtNum(Math.abs(m.change), 2)}${m.pctChange != null ? ` (${fmtNum(Math.abs(m.pctChange), 2)} %)` : ''}</span>`;
  const foot = m.source === 'daily' ? `daily close ${escHtml(fmtTradeDate(at.date))} · ${m.change != null ? 'vs the close before' : 'no earlier close'}`
    : `${m.kind === 'close' ? 'last read' : 'as of'} ${at.time} IST${src} · vs previous close`;
  return `<div class="lvc lvc--vix" id="vixTicker" title="India VIX: NSE's index of expected 30-day Nifty volatility. Read with the NSE live poll (about every 5 min); the VIX sensitivity table below uses it as today's VIX">
    <div class="lvc-top">${name}${pill}</div>
    <div class="lvc-nums"><span class="lvc-big">${fmtNum(m.last, 2)}</span>${chg}</div>
    <div class="lvc-foot"><span>${foot}</span></div>
  </div>`;
}

// The ticker's reading from the cached NSE poll file and NSE's daily rows
function vixTickerNow() {
  return vixTickerModel(LIVE_CARD_CACHE.nse?.hourly?.india_vix, rawFor('nse')?.daily_all);
}

// ========================
// VIX PANEL — the sensitivity and week-on-week VIX tables in #vixPanel, below
// the Revenue Summary sub-tabs. The same in every exchange view: NSE, BSE and
// MCX are loaded whatever the switcher shows (the shown exchange is DATA, the
// others come from the shared cache, as on Contracts to Premium).
// ========================
const VIX_EXCHANGES = ['nse', 'bse', 'mcx'];
let vixBuildSeq = 0;      // latest build; an older one still loading yields to it
let VIX_PANEL = null;     // { model, today } the panel was last drawn from (today: vixTodayKey)

// Fits, bases, the fit sample's VIX range and the weekly rows from each
// exchange's daily_all (null where an exchange is missing).
function vixPanelModel(rowsByEx) {
  const nse = rowsByEx.nse || [];
  const vmap = vixByDate(nse);
  const perEx = {};
  let min = Infinity, max = -Infinity;
  VIX_EXCHANGES.forEach(ex => {
    const rows = rowsByEx[ex];
    if (!rows || !rows.length) { perEx[ex] = null; return; }
    const sample = vixFitSample(rows, vmap);
    sample.forEach(p => { const v = vmap[p.date]; if (v < min) min = v; if (v > max) max = v; });
    const fit = vixFit(sample);
    const actual = rows.filter(r => r && !r.modelled);
    perEx[ex] = { adr: vixBase(rows), beta: fit ? fit.beta : null, fit, n: sample.length,
                  lastDate: actual.length ? actual[actual.length - 1].date : null };
  });
  // Total by date over days every exchange has reached, so one exchange's later
  // file does not drop the others out of the newest day
  const have = VIX_EXCHANGES.filter(ex => perEx[ex]);
  const upTo = have.map(ex => perEx[ex].lastDate).filter(Boolean).sort()[0] || '';
  const totalByDate = {};
  have.forEach(ex => rowsByEx[ex].forEach(r => {
    if (!r || r.modelled || !(r.date <= upTo)) return;
    totalByDate[r.date] = (totalByDate[r.date] || 0) + (Number(r.total_rev) || 0);
  }));
  return { perEx, vix45: vixMean(nse), range: min <= max ? { min, max } : null,
           weekly: vixWeeklyRows(nse, totalByDate), upTo,
           nseLast: nse.length ? nse[nse.length - 1].date : null };
}

function vixFitChip(ex, p) {
  const name = ex.toUpperCase();
  if (!p) return rxChip(`${name}: no data`, 'warn');
  if (!p.fit) return rxChip(`${name}: no fit (${p.n} days, needs 60)`, 'warn');
  const f = p.fit;
  return `<span class="vix-fit" title="${escHtml(`${name}: elasticity of revenue to VIX, ${f.n} days since ${rxDate(VIX_FIT_FROM)}. R² ${fmtNum(f.r2, 2)} with weekday dummies, ${fmtNum(f.r2Dow, 2)} with the dummies alone; the VIX term adds ${fmtNum(f.r2Vix, 2)}.`)}">${rxChip(`${name} β ${fmtNum(f.beta, 2)} · n ${f.n} · R² (VIX) ${fmtNum(f.r2Vix, 2)}`, 'data')}</span>`;
}

// The sensitivity table's <tbody> rows ('' when NSE's rows hold no VIX)
function vixSensitivityBodyHTML(model, ticker) {
  const { perEx, vix45, range } = model;
  const rows = vixSensitivityRows(perEx, vix45, ticker ? ticker.last : null, range);
  if (!rows.length) return '';
  const cr = v => (v == null || !isFinite(v) ? '—' : fmtNum(v, 2));
  const todayTag = !ticker ? '' : ticker.kind === 'close'
    ? `latest close${ticker.source === 'daily' ? ` · ${escHtml(fmtTradeDate(ticker.when))}` : ''}`
    : ticker.kind === 'preopen' ? 'pre-open' : 'today';
  return rows.map(r => {
    const cls = [r.kind === 'today' ? 'vix-today' : r.kind === 'base' ? 'vix-base' : '', r.outside ? 'vix-outside' : ''].filter(Boolean).join(' ');
    const label = r.kind === 'today' ? `${fmtNum(r.vix, 2)} <span class="vix-tag">${todayTag}</span>`
      : r.kind === 'base' ? `${fmtNum(r.vix, 2)} <span class="vix-tag">45-day avg (base)</span>` : fmtNum(r.vix, 0);
    return `<tr${cls ? ` class="${cls}"` : ''}${r.outside ? ' title="Outside the VIX range of the fit sample: the projection extrapolates"' : ''}>
      <td>${label}</td><td class="vix-pv">${r.kind === 'base' ? '—' : rxSignedPct(r.pctVsBase)}</td>
      ${VIX_EXCHANGES.map(ex => `<td>${cr(r.adr[ex])}</td>`).join('')}
      <td class="rx-strong">${cr(r.total)}</td><td>${r.kind === 'base' ? '—' : rxSignedPct(r.totalPct)}</td></tr>`;
  }).join('');
}

function vixSensitivityHTML(model, ticker) {
  const body = vixSensitivityBodyHTML(model, ticker);
  if (!body) return '<div class="rx-empty"><b>No India VIX in NSE\'s daily data</b></div>';
  return `<div class="rx-scroll"><table class="rx-table vix-sens">
    <thead><tr><th>VIX</th><th class="vix-pv">% vs 45-day avg VIX</th><th>NSE</th><th>BSE</th><th>MCX</th><th>Total <span class="vix-unit">₹ Cr/day</span></th><th>Total %</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function vixWeeklyHTML(weekly) {
  if (!weekly.length) return '<div class="rx-empty"><b>No NSE sessions</b></div>';
  const v = x => (x == null ? '—' : fmtNum(x, 2));
  const pts = x => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${fmtNum(Math.abs(x), 2)}`);
  const cls = x => (x == null ? '' : x >= 0 ? ' class="rx-up"' : ' class="rx-dn"');
  const body = weekly.map(w => `<tr${w.inProgress ? ' class="vix-wip"' : ''}>
      <td>${escHtml(w.label)}${w.inProgress ? ` ${rxChip('in progress')}` : ''}</td><td class="vix-nar">${w.sessions}</td>
      <td>${v(w.avgVix)}</td><td>${v(w.closeVix)}</td>
      <td class="vix-nar${w.chgPts == null ? '' : w.chgPts >= 0 ? ' rx-up' : ' rx-dn'}">${pts(w.chgPts)}</td><td${cls(w.chgPct)}>${rxSignedPct(w.chgPct)}</td>
      <td class="rx-strong">${v(w.totalAdr)}</td><td${cls(w.totalPct)}>${rxSignedPct(w.totalPct)}</td></tr>`).join('');
  return `<div class="rx-scroll"><table class="rx-table vix-weekly">
    <thead><tr><th>Week</th><th class="vix-nar">Sessions</th><th>Avg VIX</th><th>Week-end VIX</th><th class="vix-nar">WoW pts</th><th>VIX WoW %</th><th>Total ADR <span class="vix-unit">₹ Cr</span></th><th>ADR WoW %</th></tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function vixHowHTML(model) {
  const r = model.range;
  return rxHow('How this is worked out', `<ul>
    <li><b>Short term:</b> each row is the average daily revenue to expect over the next few weeks if India VIX holds at that level, scaled from the last 45 sessions: ADR(V) = ADR45 × (V ÷ VIX45)<sup>β</sup>. ADR45 is each exchange's mean daily revenue over its last 45 sessions; VIX45 is NSE's mean VIX over its last 45.</li>
    <li><b>Why VIX moves revenue:</b> options are billed on premium, and premiums rise with volatility, so a higher VIX lifts options revenue (and trading activity with it).</li>
    <li><b>MCX:</b> trades commodities, so India VIX (Nifty volatility) explains little of it: its β is small and its R² (VIX) near zero.</li>
    <li><b>Fit:</b> per exchange by least squares on daily rows from ${rxDate(VIX_FIT_FROM)} (after SEBI's F&amp;O curbs): ln(revenue ÷ previous 45-session mean) on weekday dummies (expiry-day concentration) and ln(VIX ÷ previous 45-session mean VIX). β is the elasticity; R² (VIX) is what the VIX term adds over the weekday dummies alone. VIX is NSE's daily close, joined by date; BSE and MCX days with no NSE session are left out, and MCX's modelled rows (before 2 Sep 2024) are never used.</li>
    <li><b>Basis:</b> total revenue at today's statutory rates for NSE and BSE, MCX as reported (fut + opt), whatever the exchange switcher shows.${r ? ` Grey rows lie outside the ${fmtNum(r.min, 2)}–${fmtNum(r.max, 2)} VIX range of the fit sample, so they extrapolate.` : ''}</li>
    <li><b>Week-on-week:</b> Mon–Sun weeks of NSE sessions, daily closes only (the live VIX is not mixed in). Week-end VIX is the latest session's VIX in that week; changes are against the week before. Total ADR is NSE + BSE + MCX on the same basis, averaged over the week's NSE sessions.</li>
  </ul>`);
}

// The sensitivity panel's footnote (the only other part that depends on the ticker)
function vixSensitivityFoot(model, ticker) {
  const { perEx } = model;
  const missing = VIX_EXCHANGES.filter(ex => !perEx[ex] || !perEx[ex].fit);
  const tickerNote = !ticker ? 'no India VIX reading, so no today row'
    : ticker.kind === 'close' ? `today's row uses the latest close, ${fmtNum(ticker.last, 2)}`
      : `today's row uses the ${ticker.kind === 'live' ? 'live' : ticker.kind === 'preopen' ? 'pre-open' : 'last (delayed)'} reading, ${fmtNum(ticker.last, 2)}`;
  return `Highlighted: ${tickerNote}. Total % is against the summed 45-session ADR${missing.length ? `; ${missing.map(e => e.toUpperCase()).join(', ')} without a fit ${missing.length === 1 ? 'is' : 'are'} left out of Total` : ''}.`;
}

function renderVixPanel(el, model, ticker) {
  const { perEx, upTo, nseLast } = model;
  const chips = VIX_EXCHANGES.map(ex => vixFitChip(ex, perEx[ex])).join(' ');
  const sens = rxPanel({
    title: 'India VIX → average daily revenue',
    meta: `₹ Cr/day at today's rates · NSE, BSE, MCX and Total · base: last 45 sessions`,
    right: chips,
    body: vixSensitivityHTML(model, ticker),
    foot: vixSensitivityFoot(model, ticker),
    how: vixHowHTML(model),
    attrs: 'id="vixSensPanel"',
  });
  const weekly = rxPanel({
    title: 'Week-on-week India VIX',
    meta: `last 8 weeks of NSE sessions · daily closes${nseLast ? ` to ${escHtml(rxDate(nseLast))}` : ''}`,
    body: vixWeeklyHTML(model.weekly),
    foot: `Total ADR: NSE + BSE + MCX ₹ Cr/day at today's rates${upTo && nseLast && upTo < nseLast ? `, through ${escHtml(rxDate(upTo))} (the latest day every exchange has)` : ''}, averaged over NSE sessions only (MCX days on NSE holidays are left out), so it can differ slightly from the week-on-week average daily revenue Total above.`,
    attrs: 'id="vixWeeklyPanel"',
  });
  el.innerHTML = sens + weekly;
  VIX_PANEL = { model, today: vixTodayKey(ticker) };
}

// What the today row depends on: the ticker's VIX and how it is labelled
function vixTodayKey(t) {
  return t ? `${t.last}|${t.kind}|${t.source === 'daily' ? t.when : ''}` : '';
}

// Updates the today row when the ticker's reading has changed (the live cards'
// cycle calls this, every poll in market hours), without reloading anything.
// Only the sensitivity table's rows and footnote are rewritten, in place, so an
// open "How this is worked out" and the tables' horizontal scroll survive the
// tick; the week-on-week table uses daily closes only and is left alone.
function vixPanelSyncToday() {
  const el = document.getElementById('vixPanel');
  if (!el || !VIX_PANEL || !el.firstChild) return;
  const ticker = vixTickerNow();
  const key = vixTodayKey(ticker);
  if (key === VIX_PANEL.today) return;
  const panel = el.querySelector('#vixSensPanel');
  const tbody = panel && panel.querySelector('tbody');
  const foot = panel && panel.querySelector(':scope > .rx-foot');
  const body = tbody && foot ? vixSensitivityBodyHTML(VIX_PANEL.model, ticker) : '';
  if (!body) { renderVixPanel(el, VIX_PANEL.model, ticker); return; }
  tbody.innerHTML = body;
  foot.innerHTML = vixSensitivityFoot(VIX_PANEL.model, ticker);
  VIX_PANEL.today = key;
}

async function buildVixPanel() {
  const el = document.getElementById('vixPanel');
  if (!el || isViewKey(currentExchange)) return;
  const seq = ++vixBuildSeq;
  // A single-exchange view has its own file in DATA; the others come from the shared cache
  const own = VIEW_LOADED && !DATA.components ? VIEW_LOADED.exchange : null;
  const cached = VIX_EXCHANGES.filter(e => e !== own);
  if (!el.firstChild && cached.some(e => !MARKET_RAW[e])) {
    el.innerHTML = rxPanel({ title: 'India VIX → average daily revenue', body: '<div class="rx-empty"><b>Loading NSE, BSE and MCX data…</b></div>' });
  }
  await ensureFreshMarketData(cached);
  if (seq !== vixBuildSeq) return;   // a later build took over while loading
  const rowsByEx = Object.fromEntries(VIX_EXCHANGES.map(e => [e, rawFor(e)?.daily_all || null]));
  if (!rowsByEx.nse) {
    el.innerHTML = rxPanel({ title: 'India VIX → average daily revenue', body: '<div class="rx-empty"><b>Couldn\'t load NSE data</b>Try again in a moment.</div>' });
    VIX_PANEL = null;
    return;
  }
  cached.filter(e => MARKET_RAW[e]).forEach(e => { VIEW_BUILT_FROM[e] = marketSig(e); });
  renderVixPanel(el, vixPanelModel(rowsByEx), vixTickerNow());
  renderLiveCards();   // the ticker's daily fallback may only now have NSE's rows
}
