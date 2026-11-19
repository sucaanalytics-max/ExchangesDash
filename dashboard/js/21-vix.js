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
// NSE sessions. Changes (fractions for %) are against the next-older row shown,
// so the oldest row's are null. inProgress marks the week of the latest NSE date
// while that date is before the week's Friday.
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
  const stats = [...byWeek.keys()].sort().reverse().slice(0, weeks).map(w => {
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
  });
}
