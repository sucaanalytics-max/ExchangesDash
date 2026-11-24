/**
 * Vercel Serverless Function: /api/excel-refresh
 *
 * The Valuation Model tab's Excel sync panel: runs of the Excel mirror
 * (scripts/excel_mirror.py, .github/workflows/excel-mirror.yml), which writes the
 * shared inputs, the valuation results and the dashboard's data into the four
 * workbooks, daily at 01:00 IST and on demand.
 *
 *   GET  (anyone)  → 200 {configured: true, signed_in, schedule, runs: [latest 10]}
 *                    a listed run still queued or running 45 minutes after it was
 *                    requested is closed as failed first (its job never started: GitHub
 *                    keeps one pending run per concurrency group and cancels the older;
 *                    or it died without the workflow's closing step). Only then does a GET
 *                    write: an ordinary read is one Supabase request
 *                    each run {id, trigger, status, requested_at, started_at,
 *                    finished_at, error, run_url, files: [{target, status, cells,
 *                    sheets, duration_s, dry_run, inputs_written, input_cells, error}]};
 *                    errors cut short
 *   POST (team session, /api/team-login) → Refresh Excel now:
 *        1. stale runs are closed as above; then a run still queued (its job has not
 *           read the inputs yet) is returned as it is (200 {run, dispatched: false}): it
 *           will carry the latest saved inputs, so a second press would only repeat it.
 *           A run already running read the inputs when it started, so a press then
 *           queues a new run (GitHub holds it pending behind the running one). Two
 *           presses at once: the partial unique index excel_sync_runs_one_manual
 *           (valuation_sync_schema.sql) lets only one manual row be queued, so the
 *           second insert answers 409 and gets the first
 *        2. otherwise inserts an excel_sync_runs row (manual, queued) and dispatches
 *           excel-mirror.yml with {trigger: 'manual', run_id} (202 {run, dispatched: true});
 *           the workflow moves the row to running, then success / partial / failed
 *        3. a refused dispatch marks the row failed with GitHub's answer (502)
 *        → 401 signed out
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (the table is service-role only, see
 * valuation_sync_schema.sql) and GITHUB_DISPATCH_PAT (Actions: write); any
 * missing → 503 {configured: false}. TEAM_PASSWORD and TEAM_SESSION_SECRET for the session.
 * Every answer is Cache-Control: no-store (vercel.json too).
 */

const { NO_STORE, isSignedIn } = require('./_team_auth');
const { sb } = require('./valuation-inputs');
const { REPO, dispatchWorkflow } = require('./_github_dispatch');

const WORKFLOW = 'excel-mirror.yml';
const SCHEDULE = 'Daily at 01:00 IST';
// A run is at most ~20 min pending behind another plus its own 20-min job timeout
const STALE_MS = 45 * 60 * 1000;
const STALE_ERROR = 'never finished: the workflow job did not start (superseded by a newer run) or ended without a result';
const LIST = 10;
const COLUMNS = 'id,trigger,status,requested_at,started_at,finished_at,files,error,github_run_id';

const short = (s, n = 200) => {
  if (s == null || s === '') return null;
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// A run as the panel sees it: per-file summaries, short errors, the Actions link
function publicRun(r) {
  const files = Array.isArray(r.files) ? r.files : [];
  return {
    id: r.id, trigger: r.trigger, status: r.status,
    requested_at: r.requested_at || null, started_at: r.started_at || null, finished_at: r.finished_at || null,
    error: short(r.error),
    run_url: r.github_run_id ? `https://github.com/${REPO}/actions/runs/${r.github_run_id}` : null,
    files: files.filter(f => f && typeof f === 'object').map(f => ({
      target: String(f.target || ''), status: String(f.status || ''),
      cells: Number.isFinite(f.cells) ? f.cells : 0,
      sheets: Array.isArray(f.sheets) ? f.sheets.map(String).slice(0, 20) : [],
      duration_s: Number.isFinite(f.duration_s) ? f.duration_s : null,
      dry_run: !!f.dry_run,
      inputs_written: typeof f.inputs_written === 'boolean' ? f.inputs_written : null,
      input_cells: f.input_cells && typeof f.input_cells === 'object' && !Array.isArray(f.input_cells)
        ? Object.fromEntries(Object.entries(f.input_cells).slice(0, 10).map(([k, v]) => [String(k).slice(0, 20), !!v])) : null,
      error: short(Array.isArray(f.errors) ? f.errors.join(' | ') : f.error),
    })),
  };
}

// Closes as failed every run still queued or running STALE_MS after it was requested
async function closeStaleRuns(now = Date.now()) {
  const before = new Date(now - STALE_MS).toISOString();
  await sb(`excel_sync_runs?status=in.(queued,running)&requested_at=lt.${encodeURIComponent(before)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: 'failed', finished_at: new Date(now).toISOString(), error: STALE_ERROR }),
  });
}

// A run still queued or running STALE_MS after it was requested
const isStale = (r, now = Date.now()) => (r.status === 'queued' || r.status === 'running')
  && Date.parse(r.requested_at) < now - STALE_MS;

async function latestRuns() {
  return (await sb(`excel_sync_runs?select=${COLUMNS}&order=requested_at.desc&limit=${LIST}`)) || [];
}

// The newest run still queued, so not yet reading the inputs (stale ones are closed
// before this is asked)
async function queuedRun() {
  const rows = await sb(`excel_sync_runs?select=${COLUMNS}&status=eq.queued&order=requested_at.desc&limit=1`);
  return (rows && rows[0]) || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', NO_STORE);
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const pat = process.env.GITHUB_DISPATCH_PAT;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !pat) {
    return res.status(503).json({ error: 'The Excel mirror is not configured', configured: false });
  }
  const signedIn = isSignedIn(req);

  try {
    if (req.method === 'GET') {
      let runs = await latestRuns();
      if (runs.some(r => isStale(r))) {
        // Housekeeping: if the sweep fails, the panel still gets the runs
        try { await closeStaleRuns(); runs = await latestRuns(); } catch (e) { console.error('excel-refresh: stale-run sweep:', e.message); }
      }
      return res.status(200).json({ configured: true, signed_in: signedIn, schedule: SCHEDULE, runs: runs.map(publicRun) });
    }

    if (!signedIn) return res.status(401).json({ error: 'Sign in to refresh the Excel files' });

    await closeStaleRuns();
    const already = run => res.status(200).json({ run: publicRun(run), dispatched: false, reason: `run ${run.id} is already ${run.status}` });
    const queued = await queuedRun();
    if (queued) return already(queued);

    let rows;
    try {
      rows = await sb('excel_sync_runs', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ trigger: 'manual', status: 'queued' }),
      });
    } catch (e) {
      // 409: another press inserted its manual run first (excel_sync_runs_one_manual)
      const first = e.status === 409 ? await queuedRun() : null;
      if (first) return already(first);
      throw e;
    }
    const run = rows && rows[0];
    if (!run || run.id == null) throw new Error('insert returned no row');

    const d = await dispatchWorkflow(pat, WORKFLOW, { trigger: 'manual', run_id: String(run.id) }, 'exchangesdash-excel-refresh');
    if (!d.ok) {
      const error = `GitHub dispatch failed (${d.status ? `HTTP ${d.status}` : 'no answer'})${d.detail ? `: ${d.detail}` : ''}`;
      console.error('excel-refresh:', error);
      const failed = await sb(`excel_sync_runs?id=eq.${run.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'failed', finished_at: new Date().toISOString(), error }),
      }).catch(() => null);
      return res.status(502).json({ run: publicRun((failed && failed[0]) || { ...run, status: 'failed', error }), dispatched: false, error: short(error) });
    }
    return res.status(202).json({ run: publicRun(run), dispatched: true });
  } catch (e) {
    console.error('excel-refresh:', e.message);
    return res.status(502).json({ error: 'Supabase did not answer', configured: true });
  }
};

module.exports.publicRun = publicRun;   // tests/test_excel_refresh_api.py
