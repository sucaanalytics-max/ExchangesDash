/**
 * Vercel Serverless Function: /api/brokers
 *
 * Read-only proxy for the stockbroker ADR tables that the brokers-dashboard
 * engine publishes to its own Supabase project (not the exchange data lake).
 * Uses the project's publishable key (BROKERS_SUPABASE_KEY, anon SELECT under
 * RLS); it never writes. The dashboard shows these figures as published and
 * computes no ADR itself.
 *
 * Query params:
 *   broker = ANGELONE | GROWW | MOSL …    an active sb_brokers.broker_id (404 otherwise)
 *   mode   = live | parity         latest successful run of that mode (default live)
 *   run    = <uuid>                a specific run instead
 *   view   = summary | daily | calibration | calendar | brokers | prices | pat | valuation
 *
 * brokers     → active brokers (sb_brokers) with a short label and their latest
 *               successful live and parity runs (null when none is published)
 * Any other view for a broker with no matching run answers 200 with run: null
 * and a reason, so the page can say so instead of failing.
 *
 * summary     → run, panels, the FY / quarter / month keys, every Summary cell
 *               (sb_summary_cells) with `regime`: 'actual' when every day behind
 *               the figure is a reported-month day in sb_daily_revenue, 'estimate'
 *               when any is projected, null when the figure has no days.
 *               Also `through`: for each panel, the last trade date of its data in the
 *               run, the segment that ends there and how many trading days that trails
 *               the as-of date ({ MTF: { through: '2026-10-19', segment: 'mtf_gross',
 *               days_behind: 9 }, … }). A panel is as current as its earliest-ending
 *               segment, so Consolidated ends with MTF.
 *               And `open`: the FY, quarter and month holding the as-of date, with the
 *               F&O trading days published in each so far ({ key, days, through }).
 * daily       → sb_daily_revenue for the run (trade_date, segment, orders, ₹ Cr, regime)
 * calibration → sb_calibration for the run
 * calendar    → equity trading days per FY counted from sb_calendar (and the last date it covers)
 * prices      → the broker's daily share closes (sb_share_prices: close, split- and
 *               bonus-adjusted; adj_close, also dividend-adjusted), independent of runs;
 *               an empty list until the table exists
 * pat         → the PAT model's published lines (sb_pat_lines: FY27 quarters, FY 2027,
 *               FY 2028; P&L lines, then EPS → target price per bear / base / bull
 *               scenario, each with its rule) for the latest successful run of the
 *               mode that has them (the PAT step writes after its ADR run), or for
 *               `run`; run: null with a reason when none has, or the table is missing
 * valuation   → the valuation's published lines (sb_valuation_lines: regression, ratio and
 *               ADR values per scenario, their weighted net value and upside, the inputs
 *               with their arithmetic, and the daily series behind the charts: ADR, its
 *               45-day average, close, ratio, regression-implied price; Angel One's TTM
 *               P/E and its bands), found the same way as pat
 *
 * Example: GET /api/brokers?broker=ANGELONE&view=summary
 */

const DEFAULT_URL = 'https://everjfpbnlbcpuarnhob.supabase.co';
const PAGE = 1000;
// Edge cache for every 200; dashboard/vercel.json sets the same for /api/brokers
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Daily segments behind each Summary panel (engine: src/engine/summary_periods.py).
// A broker publishes one MTF segment: gross revenue (Angel One, Groww) or net
// interest income (Motilal Oswal, mtf_nii); a segment with no rows tags nothing.
const PANEL_SEGMENTS = {
  'Consolidated': ['fo', 'cash', 'comm', 'mtf_gross', 'mtf_nii'],
  'Broking':      ['fo', 'cash', 'comm'],
  'MTF':          ['mtf_gross', 'mtf_nii'],
  'MTF (net)':    ['mtf_net'],
  'F&O':          ['fo'],
  'Cash':         ['cash'],
  'Commodities':  ['comm'],
};
const PANEL_ORDER = ['Consolidated', 'Broking', 'MTF', 'MTF (net)', 'F&O', 'Cash', 'Commodities'];
const FY_MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// A warm function instance reuses reads for a minute (runs are published once a day)
const CACHE = new Map();
const CACHE_MS = 60 * 1000;

async function sb(path, opts = {}) {
  const hit = CACHE.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  const rows = await sbFetch(path, opts);
  CACHE.set(path, { at: Date.now(), rows });
  return rows;
}

async function sbFetch(path, { all = false } = {}) {
  const base = process.env.BROKERS_SUPABASE_URL || DEFAULT_URL;
  const key = process.env.BROKERS_SUPABASE_KEY;
  if (!key) throw Object.assign(new Error('BROKERS_SUPABASE_KEY is not set'), { status: 500 });
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${base}/rest/v1/${path}`, {
      headers: { apikey: key, Accept: 'application/json', Range: `${from}-${from + PAGE - 1}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw Object.assign(new Error(`Supabase returned ${res.status} for ${path.split('?')[0]}`), { status: 502, supabaseStatus: res.status });
    const rows = await res.json();
    out.push(...rows);
    if (!all || rows.length < PAGE) return out;
  }
}

// ── Periods of a trade date, labelled like the engine ("FY 2027", "Q2 FY 2027", "FY 2027 September")
function periodsOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const fy = m >= 4 ? y + 1 : y;
  const fyIdx = (m + 8) % 12;                       // April = 0 … March = 11
  return { FY: `FY ${fy}`, Q: `Q${Math.floor(fyIdx / 3) + 1} FY ${fy}`, M: `FY ${fy} ${FY_MONTHS[fyIdx]}`, fyIdx, fy };
}

// Chronological sort key of a period label; null for labels that are not one period
function periodKey(label) {
  let m;
  if ((m = /^Q([1-4]) FY (\d{4})$/.exec(label))) return +m[2] * 100 + (+m[1] - 1) * 3;
  if ((m = /^FY (\d{4}) ([A-Z][a-z]+)$/.exec(label)) && FY_MONTHS.includes(m[2])) return +m[1] * 100 + FY_MONTHS.indexOf(m[2]);
  if ((m = /^FY (\d{4})$/.exec(label))) return +m[1] * 100;
  return null;
}

// Regime of a cell from the days behind it: for one period, its days; for the
// 6-month average, the six months to the selected month; for the as-of tables,
// the trailing trading days or weekdays the row label names.
function regimeFinder(dailyRecent, projected) {
  const proj = {};                                    // segment → Set of projected dates
  projected.forEach(r => (proj[r.segment] = proj[r.segment] || new Set()).add(r.trade_date));
  const projPeriods = {};                             // segment → Set of period labels with a projected day
  projected.forEach(r => {
    const s = projPeriods[r.segment] = projPeriods[r.segment] || new Set();
    const p = periodsOf(r.trade_date);
    s.add(p.FY); s.add(p.Q); s.add(p.M);
  });
  const dates = {};                                   // segment → trading dates ascending (recent window)
  dailyRecent.forEach(r => (dates[r.segment] = dates[r.segment] || []).push(r.trade_date));
  Object.values(dates).forEach(d => d.sort());

  const anyProjected = (segs, test) => segs.some(s => test(s));
  return function regime(cell) {
    if (cell.value == null) return null;
    const segs = PANEL_SEGMENTS[cell.panel] || [];
    const label = cell.row_label.split(' | ')[0];
    if (cell.period_type !== 'asof') {
      if (periodKey(label) != null) return anyProjected(segs, s => projPeriods[s]?.has(label)) ? 'estimate' : 'actual';
      if (/^Avg of last 6 months$/i.test(label)) {
        const k = periodKey(cell.period_key);
        const months = [];
        for (let i = 0; i < 6; i++) {
          const idx = (k % 100) - i, fy = Math.floor(k / 100) + Math.floor(idx / 12);
          months.push(`FY ${fy} ${FY_MONTHS[((idx % 12) + 12) % 12]}`);
        }
        return anyProjected(segs, s => months.some(mo => projPeriods[s]?.has(mo))) ? 'estimate' : 'actual';
      }
      return null;
    }
    const asOf = cell.period_key;
    const windowOf = (s) => {
      const d = (dates[s] || []).filter(x => x <= asOf);
      let m;
      if ((m = /^Last (\d+) trading days$/i.exec(label))) return d.slice(-m[1]);
      if ((m = /^Previous (\d+) trading days$/i.exec(label))) return d.slice(-2 * m[1], -m[1]);
      const wd = WEEKDAYS.findIndex(w => label === w || label.endsWith(' ' + w + 's'));
      if (wd < 0) return null;
      const n = label === WEEKDAYS[wd] ? 1 : +((/last (\d+)/i.exec(label) || [])[1] || 1);
      return d.filter(x => new Date(x + 'T00:00:00Z').getUTCDay() === wd).slice(-n);
    };
    let known = false;
    const est = segs.some(s => {
      const w = windowOf(s);
      if (!w || !w.length) return false;
      known = true;
      return w.some(x => proj[s]?.has(x));
    });
    return est ? 'estimate' : known ? 'actual' : null;
  };
}

// Each panel's last data day, from each segment's last day (`last`: segment →
// 'YYYY-MM-DD', none past the as-of date). A panel is as current as its
// earliest-ending segment; segments the broker doesn't publish are skipped.
// days_behind counts the run's trading days (days with F&O or cash rows in
// `recent`, the window up to the as-of date) after that day; null when the
// day falls before the window, so the count would be short.
function panelsThrough(last, recent) {
  const sessions = [...new Set(recent.filter(r => r.segment === 'fo' || r.segment === 'cash').map(r => r.trade_date))].sort();
  const out = {};
  PANEL_ORDER.forEach(panel => {
    const segs = PANEL_SEGMENTS[panel].filter(s => last[s]).sort((a, b) => last[a].localeCompare(last[b]));
    if (!segs.length) return;
    const through = last[segs[0]];
    out[panel] = { through, segment: segs[0],
      days_behind: sessions.length && through >= sessions[0] ? sessions.filter(d => d > through).length : null };
  });
  return out;
}

// The FY, quarter and month that hold the run's as-of date are still open: their figures
// cover only the trading days to that date. { FY|Q|M: { key, days, through } }, where days
// counts the equity trading days published for F&O (every broker has it) in that period.
function openPeriods(asOf, foDates) {
  const now = periodsOf(asOf), out = {};
  ['FY', 'Q', 'M'].forEach(t => {
    const d = foDates.filter(x => x <= asOf && periodsOf(x)[t] === now[t]).sort();
    out[t] = { key: now[t], days: d.length, through: d.length ? d[d.length - 1] : null };
  });
  return out;
}

// Each segment's last day up to the as-of date: from the recent window, or, for a
// segment with no day in it, its own latest row (none: the broker doesn't publish it)
async function segmentLastDays(run, recent) {
  const last = {};
  recent.forEach(r => { if (!(last[r.segment] >= r.trade_date)) last[r.segment] = r.trade_date; });
  const missing = [...new Set(Object.values(PANEL_SEGMENTS).flat())].filter(s => !last[s]);
  const found = await Promise.all(missing.map(s =>
    sb(`sb_daily_revenue?select=trade_date&run_id=eq.${run.run_id}&segment=eq.${s}&trade_date=lte.${run.as_of_date}&order=trade_date.desc&limit=1`)));
  found.forEach((rows, i) => { if (rows[0]) last[missing[i]] = rows[0].trade_date; });
  return last;
}

async function findRun(broker, mode, runId) {
  const filter = runId ? `run_id=eq.${runId}` : `mode=eq.${mode}&status=eq.success&order=started_at.desc&limit=1`;
  const rows = await sb(`sb_runs?select=run_id,broker_id,mode,as_of_date,started_at,finished_at,status,parity_pass,code_version,notes&broker_id=eq.${encodeURIComponent(broker)}&${filter}`);
  return rows[0] || null;
}

async function summary(run) {
  const r = run.run_id;
  const asOf = run.as_of_date;
  const since = new Date(Date.parse(asOf + 'T00:00:00Z') - 120 * 86400000).toISOString().slice(0, 10);
  const fyStart = `${periodsOf(asOf).fy - 1}-04-01`;
  const [cells, projected, recent, foDays] = await Promise.all([
    sb(`sb_summary_cells?select=panel,period_type,period_key,table_name,row_label,value,comparison,comp_value,note&run_id=eq.${r}`, { all: true }),
    sb(`sb_daily_revenue?select=trade_date,segment&run_id=eq.${r}&regime=neq.actual`, { all: true }),
    sb(`sb_daily_revenue?select=trade_date,segment&run_id=eq.${r}&trade_date=gte.${since}&trade_date=lte.${asOf}`, { all: true }),
    sb(`sb_daily_revenue?select=trade_date&run_id=eq.${r}&segment=eq.fo&trade_date=gte.${fyStart}&trade_date=lte.${asOf}&order=trade_date`, { all: true }),
  ]);
  const regime = regimeFinder(recent, projected);
  const num = v => (v == null ? null : Number(v));
  const out = cells.map(c => {
    const cell = { ...c, value: num(c.value), comp_value: num(c.comp_value) };
    cell.regime = regime(cell);
    return cell;
  });
  const keys = { FY: new Set(), Q: new Set(), M: new Set() };
  out.forEach(c => keys[c.period_type]?.add(c.period_key));
  const sorted = s => [...s].sort((a, b) => periodKey(b) - periodKey(a));
  const panels = PANEL_ORDER.filter(p => out.some(c => c.panel === p));
  const through = panelsThrough(await segmentLastDays(run, recent), recent);
  return { run, panels, periods: { FY: sorted(keys.FY), Q: sorted(keys.Q), M: sorted(keys.M) },
    open: openPeriods(asOf, foDays.map(x => x.trade_date)), cells: out, through };
}

// PAT lines (sb_pat_lines) of the latest successful run of the mode that has them:
// the PAT step publishes after its ADR run, so the newest run can have none yet
const PAT_COLS = 'period_key,line,scenario,label,value,unit,regime,rule,sort_order';
async function patLines(broker, mode, runId) {
  const runs = await sb(`sb_runs?select=run_id,broker_id,mode,as_of_date,started_at,finished_at,status&broker_id=eq.${encodeURIComponent(broker)}&`
    + (runId ? `run_id=eq.${runId}` : `mode=eq.${mode}&status=eq.success&order=started_at.desc&limit=10`));
  for (const run of runs) {
    let rows;
    try {
      rows = await sb(`sb_pat_lines?select=${PAT_COLS}&run_id=eq.${run.run_id}&broker_id=eq.${encodeURIComponent(broker)}&order=sort_order`, { all: true });
    } catch (err) {
      if (err.supabaseStatus !== 404) throw err;   // the table does not exist yet
      return { run: null, rows: [], reason: 'The PAT model has not been published yet (table sb_pat_lines not created)' };
    }
    if (rows.length) return { run, rows: rows.map(r => ({ ...r, value: r.value == null ? null : Number(r.value) })) };
  }
  return { run: null, rows: [], reason: `No PAT lines published for ${runId ? 'run ' + runId : 'the latest ' + mode + ' runs'} yet` };
}

// Valuation lines (sb_valuation_lines), found like the PAT lines: the valuation is
// written by the same step, right after them
const VAL_COLS = 'section,period_key,line,scenario,label,value,unit,rule,sort_order';
async function valuationLines(broker, mode, runId) {
  const runs = await sb(`sb_runs?select=run_id,broker_id,mode,as_of_date,started_at,finished_at,status&broker_id=eq.${encodeURIComponent(broker)}&`
    + (runId ? `run_id=eq.${runId}` : `mode=eq.${mode}&status=eq.success&order=started_at.desc&limit=10`));
  for (const run of runs) {
    let rows;
    try {
      rows = await sb(`sb_valuation_lines?select=${VAL_COLS}&run_id=eq.${run.run_id}&broker_id=eq.${encodeURIComponent(broker)}&order=section,sort_order,period_key`, { all: true });
    } catch (err) {
      if (err.supabaseStatus !== 404) throw err;   // the table does not exist yet
      return { run: null, rows: [], reason: 'The valuation has not been published yet (table sb_valuation_lines not created)' };
    }
    if (rows.length) return { run, rows: rows.map(r => ({ ...r, value: r.value == null ? null : Number(r.value) })) };
  }
  return { run: null, rows: [], reason: `No valuation published for ${runId ? 'run ' + runId : 'the latest ' + mode + ' runs'} yet` };
}

// "Billionbrains Garage Ventures Ltd (Groww)" → "Groww"; "Angel One Ltd" → "Angel One"
const SHORT_NAMES = { MOSL: 'Motilal Oswal' };
function shortName(name, id) {
  if (SHORT_NAMES[id]) return SHORT_NAMES[id];
  const m = /\(([^)]+)\)\s*$/.exec(name || '');
  return m ? m[1] : (name || id).replace(/\s+(Ltd|Limited)\.?$/i, '');
}

// Active brokers (sb_brokers) with their latest successful live and parity runs
async function brokers() {
  const [rows, runs] = await Promise.all([
    sb('sb_brokers?select=broker_id,name,nse_symbol,active&active=is.true&order=broker_id'),
    sb('sb_runs?select=broker_id,mode,run_id,as_of_date,started_at&status=eq.success&order=started_at.desc', { all: true }),
  ]);
  return rows.map(b => {
    const latest = mode => runs.find(r => r.broker_id === b.broker_id && r.mode === mode) || null;
    return { broker_id: b.broker_id, name: b.name, label: shortName(b.name, b.broker_id), nse_symbol: b.nse_symbol,
      runs: { live: latest('live'), parity: latest('parity') } };
  });
}

module.exports = async function handler(req, res) {
  const broker = String(req.query.broker || 'ANGELONE').toUpperCase();
  const mode = String(req.query.mode || 'live').toLowerCase();
  const view = String(req.query.view || 'summary').toLowerCase();
  const runId = req.query.run ? String(req.query.run).toLowerCase() : null;
  if (!/^[A-Z0-9_]{2,32}$/.test(broker) || !['live', 'parity'].includes(mode)
    || !['summary', 'daily', 'calibration', 'calendar', 'brokers', 'prices', 'pat', 'valuation'].includes(view) || (runId && !UUID.test(runId))) {
    return res.status(400).json({ error: 'Invalid broker, mode, view or run param' });
  }
  try {
    const list = await brokers();
    res.setHeader('Content-Type', 'application/json');
    if (view === 'brokers') {
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.status(200).json({ brokers: list });
    }
    const known = list.find(b => b.broker_id === broker);
    if (!known) return res.status(404).json({ error: `Unknown or inactive broker ${broker}`, code: 'unknown_broker' });
    if (view === 'prices') {
      let rows = [];
      try {
        rows = await sb(`sb_share_prices?select=trade_date,ticker,close,adj_close&broker_id=eq.${broker}&order=trade_date`, { all: true });
      } catch (err) {
        if (err.supabaseStatus !== 404) throw err;   // the table does not exist yet
      }
      const num = v => (v == null ? null : Number(v));
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.status(200).json({ broker: known, prices: rows.map(r => ({ ...r, close: num(r.close), adj_close: num(r.adj_close) })) });
    }
    if (view === 'pat') {
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.status(200).json({ broker: known, ...await patLines(broker, mode, runId) });
    }
    if (view === 'valuation') {
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.status(200).json({ broker: known, ...await valuationLines(broker, mode, runId) });
    }
    const run = await findRun(broker, mode, runId);
    // A broker can be listed before its first run is published (facts awaiting
    // review): say so in a 200, so the page can show it rather than fail
    if (!run) {
      res.setHeader('Cache-Control', CACHE_CONTROL);
      return res.status(200).json({ broker: known, run: null, reason: `No successful ${runId ? 'run ' + runId : mode + ' run'} published for ${known.label} yet` });
    }
    let body;
    if (view === 'summary') body = { broker: known, ...await summary(run) };
    else if (view === 'daily') {
      body = { run, rows: (await sb(`sb_daily_revenue?select=trade_date,segment,orders_mn,revenue_cr,regime&run_id=eq.${run.run_id}&order=trade_date`, { all: true }))
        .map(r => ({ ...r, orders_mn: r.orders_mn == null ? null : Number(r.orders_mn), revenue_cr: r.revenue_cr == null ? null : Number(r.revenue_cr) })) };
    } else if (view === 'calendar') {
      // Equity trading days per FY as far as sb_calendar runs (PAT Predictor context)
      const days = {}, last = {};
      (await sb('sb_calendar?select=trade_date,fy,is_equity_day&order=trade_date', { all: true })).forEach(r => {
        if (r.is_equity_day) days[r.fy] = (days[r.fy] || 0) + 1;
        last[r.fy] = r.trade_date;
      });
      body = { run, fy: Object.keys(days).sort().map(fy => ({ fy, equity_days: days[fy], through: last[fy] })) };
    } else {
      body = { run, rows: (await sb(`sb_calibration?select=segment,period_type,period_key,param,value,regime,rule,source_periods&run_id=eq.${run.run_id}`, { all: true }))
        .map(r => ({ ...r, value: r.value == null ? null : Number(r.value) })) };
    }
    res.setHeader('Cache-Control', CACHE_CONTROL);
    return res.status(200).json(body);
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message });
  }
};

module.exports.panelsThrough = panelsThrough;   // tests/test_brokers_api.py
module.exports.patLines = patLines;           // tests/test_brokers_api.py
module.exports.valuationLines = valuationLines; // tests/test_brokers_api.py
module.exports.openPeriods = openPeriods;       // tests/test_brokers_open_periods.py
