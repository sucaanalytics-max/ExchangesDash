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
 *   view   = summary | daily | calibration | calendar | brokers | prices
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
 * daily       → sb_daily_revenue for the run (trade_date, segment, orders, ₹ Cr, regime)
 * calibration → sb_calibration for the run
 * calendar    → equity trading days per FY counted from sb_calendar (and the last date it covers)
 * prices      → the broker's daily share closes (sb_share_prices: close, split- and
 *               bonus-adjusted; adj_close, also dividend-adjusted), independent of runs;
 *               an empty list until the table exists
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

async function findRun(broker, mode, runId) {
  const filter = runId ? `run_id=eq.${runId}` : `mode=eq.${mode}&status=eq.success&order=started_at.desc&limit=1`;
  const rows = await sb(`sb_runs?select=run_id,broker_id,mode,as_of_date,started_at,finished_at,status,parity_pass,code_version,notes&broker_id=eq.${encodeURIComponent(broker)}&${filter}`);
  return rows[0] || null;
}

async function summary(run) {
  const r = run.run_id;
  const asOf = run.as_of_date;
  const since = new Date(Date.parse(asOf + 'T00:00:00Z') - 120 * 86400000).toISOString().slice(0, 10);
  const [cells, projected, recent] = await Promise.all([
    sb(`sb_summary_cells?select=panel,period_type,period_key,table_name,row_label,value,comparison,comp_value,note&run_id=eq.${r}`, { all: true }),
    sb(`sb_daily_revenue?select=trade_date,segment&run_id=eq.${r}&regime=neq.actual`, { all: true }),
    sb(`sb_daily_revenue?select=trade_date,segment&run_id=eq.${r}&trade_date=gte.${since}&trade_date=lte.${asOf}`, { all: true }),
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
  return { run, panels, periods: { FY: sorted(keys.FY), Q: sorted(keys.Q), M: sorted(keys.M) }, cells: out };
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
    || !['summary', 'daily', 'calibration', 'calendar', 'brokers', 'prices'].includes(view) || (runId && !UUID.test(runId))) {
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
