/**
 * Vercel Serverless Function: /api/valuation-inputs
 *
 * The Valuation Model's editable inputs, shared by every viewer: one row per
 * exchange in Supabase `valuation_inputs` (valuation_sync_schema.sql), each the
 * sparse overrides of dashboard/data/valuation_inputs.json the inputs drawer
 * makes, e.g. {"pe1": 48, "adr": null}.
 *
 *   GET  (anyone)       → 200 {configured: true, signed_in, inputs: {bse: {…}, mcx: {…}, nse: {…}},
 *                              updated_at: {bse: iso | null, …}}
 *   PUT  (team session, /api/team-login) body {exchange, inputs, base_updated_at}
 *        → replaces that exchange's overrides, only if the row is still the one the
 *          edit was based on: base_updated_at is the updated_at the client last read
 *          for it (null when it saw no row). The table's trigger logs before and
 *          after to `valuation_inputs_log`. Answers as GET.
 *        → 409 {error: 'conflict', current: {inputs, updated_at}} when someone saved
 *          the exchange since (or a row now exists): the client lays its own changes
 *          over `current` and sends again with current.updated_at as the base
 *        → 401 signed out; 400 {error, bad: [keys]} for an unknown exchange or
 *          key, or a value the dashboard would not accept
 *
 * Validation is a copy of the dashboard's (VALUATION_EDITABLE and
 * valuationInputOk in dashboard/js/14-valuation.js; tests/test_valuation_inputs_api.py
 * checks they agree), except that a data-from date is checked only against
 * today, since the server does not know the latest data date.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (service role: the tables are closed to
 * anon), either missing → 503 {configured: false}, so the page falls back to
 * edits saved in the browser. TEAM_SESSION_SECRET (with team-login) for PUT.
 * Every answer is Cache-Control: no-store.
 */

const crypto = require('crypto');
const { NO_STORE, isSignedIn, clientIp, readBody } = require('./_team_auth');

const SUPABASE_TIMEOUT_MS = 8000;   // a slow Supabase answers 502, not a hung function
const EXCHANGES = ['bse', 'mcx', 'nse'];
const EDITABLE = ['adr', 'g', 'pe0', 'pe1', 'pe2', 'd1', 'd2', 'w0', 'w1', 'w2', 'from'];

const isNum = x => typeof x === 'number' && isFinite(x);

// A real calendar date written YYYY-MM-DD, from 1900 on
function isIsoDate(x) {
  const m = typeof x === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  return !!m && +m[1] >= 1900 && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === x;
}

// Today's date in India, YYYY-MM-DD
function istToday(now = Date.now()) {
  return new Date(now + 330 * 60000).toISOString().slice(0, 10);
}

// valuationInputOk's rules, with `today` in place of the latest data date
function inputOk(k, x, today) {
  if (k === 'adr') return x === null || (isNum(x) && x > 0);
  if (k === 'from') return x === null || (isIsoDate(x) && !(today && x > today));
  if (!isNum(x)) return false;
  if (k[0] === 'p') return x > 0;
  if (k[0] === 'w') return x >= 0;
  if (k === 'd1' || k === 'd2') return x >= 0 && x < 100;
  return x > -100;
}

// The keys of `inputs` that are not editable or hold an unusable value; [] when all is well
function validateInputs(inputs, today = istToday()) {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return ['inputs'];
  return Object.keys(inputs).filter(k => !EDITABLE.includes(k) || !inputOk(k, inputs[k], today));
}

function changedBy(req) {
  return crypto.createHash('sha256').update(clientIp(req) + (process.env.TEAM_SESSION_SECRET || '')).digest('hex').slice(0, 12);
}

async function sb(path, opts = {}) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${base}/rest/v1/${path}`, {
    ...opts,
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!r.ok) {
    let detail = '';
    try { detail = await r.text(); } catch (e) { /* no body */ }
    const err = new Error(`Supabase ${r.status}${detail ? `: ${String(detail).slice(0, 200)}` : ''}`);
    err.status = r.status;
    throw err;
  }
  // return=minimal writes (201) and 204s have no body: null, not a JSON error
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

// Every exchange's overrides and last change, from the table's rows
async function readAll(signedIn) {
  const rows = await sb('valuation_inputs?select=exchange,inputs,updated_at') || [];
  const inputs = {}, updated = {};
  EXCHANGES.forEach(ex => { inputs[ex] = {}; updated[ex] = null; });
  rows.forEach(r => {
    if (!EXCHANGES.includes(r.exchange)) return;
    inputs[r.exchange] = r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs) ? r.inputs : {};
    updated[r.exchange] = r.updated_at || null;
  });
  return { configured: true, signed_in: signedIn, inputs, updated_at: updated };
}

// One exchange's stored overrides and updated_at ({inputs: {}, updated_at: null} without a row)
async function readOne(exchange) {
  const rows = await sb(`valuation_inputs?select=inputs,updated_at&exchange=eq.${exchange}`) || [];
  const r = rows[0];
  const inputs = r && r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs) ? r.inputs : {};
  return { inputs, updated_at: (r && r.updated_at) || null };
}

// The updated_at a write stores: now, but always later than the base it replaces, so each
// successful write moves the row to a stamp no earlier edit was based on (instances' clocks
// may differ by a few ms)
function nextStamp(base, now = Date.now()) {
  const b = Date.parse(base);
  return new Date(isFinite(b) ? Math.max(now, b + 1) : now).toISOString();
}

// A usable base_updated_at: null / absent (no row seen) or a timestamp
function baseOk(base) {
  return base == null || (typeof base === 'string' && base.length <= 40 && isFinite(Date.parse(base)));
}

// Replaces one exchange's overrides if the row is still at `base` (no row, when base is
// null): a conditional PATCH, or an insert that does nothing when a row exists. Resolves to
// null when written, else the row as it now is (the conflict). The table's trigger
// (valuation_inputs_log_change in valuation_sync_schema.sql) logs before and after in the
// same transaction.
async function writeOne(req, exchange, inputs, base) {
  const by = changedBy(req);
  let rows;
  if (base) {
    rows = await sb(`valuation_inputs?exchange=eq.${exchange}&updated_at=eq.${encodeURIComponent(base)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ inputs, updated_at: nextStamp(base), updated_by: by }),
    });
  } else {
    rows = await sb('valuation_inputs?on_conflict=exchange', {
      method: 'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify([{ exchange, inputs, updated_at: nextStamp(null), updated_by: by }]),
    });
  }
  return Array.isArray(rows) && rows.length ? null : readOne(exchange);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', NO_STORE);
  if (req.method !== 'GET' && req.method !== 'PUT') {
    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(503).json({ error: 'Shared valuation inputs are not configured', configured: false });
  }
  const signedIn = isSignedIn(req);

  try {
    if (req.method === 'GET') return res.status(200).json(await readAll(signedIn));

    if (!signedIn) return res.status(401).json({ error: 'Sign in to edit the valuation inputs' });
    const body = readBody(req.body);
    const bad = [];
    if (!EXCHANGES.includes(body.exchange)) bad.push('exchange');
    bad.push(...validateInputs(body.inputs));
    if (!baseOk(body.base_updated_at)) bad.push('base_updated_at');
    if (bad.length) return res.status(400).json({ error: `Not accepted: ${bad.join(', ')}`, bad });

    const current = await writeOne(req, body.exchange, body.inputs, body.base_updated_at || null);
    if (current) return res.status(409).json({ error: 'conflict', configured: true, signed_in: true, current });
    return res.status(200).json(await readAll(true));
  } catch (e) {
    console.error('valuation-inputs:', e.message);
    return res.status(502).json({ error: 'Supabase did not answer', configured: true });
  }
};

module.exports.SUPABASE_TIMEOUT_MS = SUPABASE_TIMEOUT_MS;   // tests/test_valuation_inputs_api.py
module.exports.nextStamp = nextStamp;               // tests/test_valuation_inputs_api.py
module.exports.sb = sb;                           // tests/test_valuation_inputs_api.py
module.exports.validateInputs = validateInputs;   // tests/test_valuation_inputs_api.py
module.exports.EXCHANGES = EXCHANGES;             // tests/test_valuation_inputs_api.py
module.exports.EDITABLE = EDITABLE;               // tests/test_valuation_inputs_api.py
