// dashboard/js/14-valuation.js — Valuation Model tab: shares outstanding, the triangulated valuation model and its inputs.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// SHARES OUTSTANDING — the one place share counts live
// ========================

// Crore shares, the default for every EPS on the Revenue Predictor and
// Valuation Model tabs. Nothing fetches share
// counts — yfinance supplies prices only — so these are static, and each view
// shows the value with its source and as-of note. as_of is null where the repo
// records no date; source says how far the figure can be trusted.
// BSE's 40.79 is the 407.88m shares PL Capital's initiation (18 Jun 2026)
// lists; Motilal Oswal's 1QFY27 update (4 Aug 2026) rounds the same count to
// 408m. It replaced 40.73, which the Excel workbook read from a
// Bloomberg/FactSet plugin with no recorded date (see
// docs/superpowers/specs/2026-07-02-bse-excel-valuation-replication-design.md).
// NSE's 247.5 is its paid-up equity capital (₹247.50 Cr at ₹1 face value) in
// the audited Q1 FY27 results; reported PAT ÷ EPS gives 247.4–247.6 every quarter.
// chip/kind: the input's provenance tag on the Predictor and Valuation tabs.
const SHARES_OUTSTANDING_CR = {
  bse: { value: 40.79, as_of: '2026-06-18', source: 'PL Capital initiation, 18 Jun 2026 (407.88m); MOSL 1QFY27 update, 4 Aug 2026 (408m)', chip: 'Broker reports · Jun 2026', kind: 'data' },
  mcx: { value: 25.45, as_of: null, source: 'hard-coded, unverified', chip: 'Hard-coded · unverified', kind: 'warn' },
  nse: { value: 247.5, as_of: '2026-06-30', source: 'paid-up equity capital ₹247.50 Cr at ₹1 face value, audited Q1 FY27 results (30 Jul 2026)', chip: 'Results filing · Jun 2026', kind: 'data' },
};

function sharesChip(ex) {
  const s = SHARES_OUTSTANDING_CR[ex];
  return `<span class="rx-chip rx-chip--${s.kind}" title="${escHtml(s.source)}">${s.chip}</span>`;
}

// ========================
// ANALYST TARGETS (BSE) — dashboard/data/bse_analyst_targets.json, hand-edited
// ========================

let BSE_ANALYST_TARGETS_CACHE = null;

async function loadBSEAnalystTargets() {
  if (BSE_ANALYST_TARGETS_CACHE) return BSE_ANALYST_TARGETS_CACHE;
  try {
    const r = await fetch('./data/bse_analyst_targets.json');
    const j = await r.json();
    BSE_ANALYST_TARGETS_CACHE = j.targets || [];
  } catch {
    BSE_ANALYST_TARGETS_CACHE = [];
  }
  return BSE_ANALYST_TARGETS_CACHE;
}

// Broker targets older than this are flagged as stale wherever they are shown.
const ANALYST_TARGET_STALE_DAYS = 90;

// "May 2026", "May–Aug 2026" or "Dec 2025–Aug 2026": the span of the broker notes' dates.
function analystMonths(oldest, newest) {
  const [lo, hi] = [rxDate(oldest).replace(/^\d+ /, ''), rxDate(newest || oldest).replace(/^\d+ /, '')];
  if (lo === hi) return lo;
  const [loM, loY] = lo.split(' ');
  return loY === hi.split(' ')[1] ? `${loM}–${hi}` : `${lo}–${hi}`;
}

// Whole days from an ISO date ("2026-05-08") to today's IST date.
function daysSinceIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  const t = /^(\d{4})-(\d{2})-(\d{2})/.exec(istDateOf() || '');
  if (!m || !t) return null;
  return Math.round((Date.UTC(+t[1], +t[2] - 1, +t[3]) - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
}

// http(s) URL from a hand-edited file, attribute-escaped; anything else → null.
function safeHttpUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  try {
    const url = new URL(u);
    return /^https?:$/.test(url.protocol) ? url.href.replace(/"/g, '%22') : null;
  } catch { return null; }
}

// ========================
// VALUATION MODEL — the workbook's "Valuation Inputs" sheet and its BSE / MCX / NSE sheets
// ========================
// Per exchange, two triangulated targets for today, Bear / Base / Bull, each the
// weighted average of three methods:
//   Regression: intercept + slope × ADR on a 45-session fit; Bear / Bull ∓ that
//     fit's standard error of estimate.
//   Ratio Analysis: price ÷ 45-session revenue MA over the fit window, mean ∓ 1σ, × ADR.
// Both are fitted on the data from each exchange's "Regression data from" date, as the
// workbook does: revenue and prices start on that date, so the 45 DMA is built only from
// revenue on or after it and the first point is the close after its 45th session (blank:
// the published fit the Regression tab shows, MA over every revenue day). The date moves
// the valuation only, not the Regression tab, the banner or the share files.
//   ADR model: the current quarter's ADR to date grown QoQ to Q4 of the next FY,
//     that FY's four-quarter average × sessions + other income → × PAT margin ÷
//     shares → EPS × P/E → next-FY-end target, ÷ (1 + 18 %) to this FY's end and
//     ÷ (1 + 9 %) to today.
// The two triangulations differ only in the ADR fed to Regression and Ratio: the
// current 45-session ADR, or the ADR estimate typed in the inputs drawer
// (blank = the 45-session ADR). The ADR model row is the same in both. Every ADR
// is at today's rates, the basis the fits are built on (the whole dashboard is).
// Inputs: the shared defaults in dashboard/data/valuation_inputs.json (hand-edited;
// without it the tabs say so and show no targets), with the edits from the inputs
// drawer (js/18-valuation-inputs.js) on top: shared by every viewer through
// /api/valuation-inputs (team members edit), or this browser's own without it
// (SHARED INPUTS below).


// The workbook's column order
const VALUATION_EXCHANGES = ['bse', 'mcx', 'nse'];
// Row keys and labels of the 3 × 3 tables, in the order of the weights w0 / w1 / w2
const VALUATION_METHODS = [['reg', 'Regression'], ['ratio', 'Ratio Analysis'], ['adr', 'ADR model']];
// The inputs the drawer edits, in its order; the rest (oi, margin, days) are fixed.
// d1 / d2: the discount rates, % (next-FY-end target → this FY's end → today; their
// defaults are valuation_inputs.json's two global rates, edited per exchange).
// from: the "Regression data from" date (ISO, null = all the share file's data).
const VALUATION_EDITABLE = ['adr', 'g', 'pe0', 'pe1', 'pe2', 'd1', 'd2', 'w0', 'w1', 'w2', 'from'];
const VALUATION_INPUT_LABELS = {
  adr: 'ADR estimate', g: 'QoQ ADR growth', pe0: 'P/E bear', pe1: 'P/E base', pe2: 'P/E bull',
  d1: 'Discount to FY end', d2: 'Discount to today',
  w0: 'Regression weight', w1: 'Ratio weight', w2: 'ADR model weight', from: 'Regression data from',
};
const VALUATION_STORAGE_KEY = 'valuation_inputs_v1';

const valuationNum = x => typeof x === 'number' && isFinite(x);
// A real calendar date written YYYY-MM-DD, from 1900 on (a year being typed into a date
// input passes through 0002, 0020, 0202 …, which are not saved)
function valuationIsoDate(x) {
  const m = typeof x === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(x);
  return !!m && +m[1] >= 1900 && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === x;
}

// valuation_inputs.json → { fy, ex: { bse: { adr, g, pe0, pe1, pe2, w0, w1, w2, from, oi, margin, days, d1, d2 }, … } }
// (adr null = use the 45-session ADR; from null = all data); null when any value is missing or not a number
function valuationDefaultsFrom(json) {
  if (!json || !json.exchanges || !valuationNum(json.fy) || !valuationNum(json.discount_to_fy_end_pct) || !valuationNum(json.discount_to_today_pct)) return null;
  const out = {};
  for (const ex of VALUATION_EXCHANGES) {
    const e = json.exchanges[ex] || {}, ed = e.editable || {}, fx = e.fixed || {}, pe = ed.pe || {}, w = ed.weights_pct || {};
    const v = {
      adr: ed.adr_estimate_cr ?? null, g: ed.qoq_growth_pct, pe0: pe.bear, pe1: pe.base, pe2: pe.bull,
      w0: w.regression, w1: w.ratio, w2: w.adr_model, from: ed.regression_from ?? null,
      oi: fx.other_income_cr, margin: fx.pat_margin_pct, days: fx.sessions,
      d1: json.discount_to_fy_end_pct, d2: json.discount_to_today_pct,
    };
    if (!Object.entries(v).every(([k, x]) => (k === 'from' ? valuationInputOk(k, x) : valuationNum(x) || (k === 'adr' && x === null)))) return null;
    out[ex] = v;
  }
  // The Competition tab's assumed shares of NSE's volume that would otherwise trade on MCX
  // (19-mcx-competition.js), optional: absent or out of range = its own defaults
  const c = json.exchanges.mcx?.competition || {};
  const pct = x => (valuationNum(x) && x >= 0 && x <= 100 ? x : undefined);
  const comp = { ord: pct(c.sub_ordinary_pct), exp: pct(c.sub_expiry_pct) };
  return { fy: json.fy, ex: out, comp };
}

let VALUATION_DEFAULTS_CACHE = null;

// The shared defaults: { fy, ex, error: null }, or { error } saying why
// valuation_inputs.json did not load (a failed load is retried on the next call)
async function loadValuationDefaults() {
  if (VALUATION_DEFAULTS_CACHE) return VALUATION_DEFAULTS_CACHE;
  try {
    const d = valuationDefaultsFrom((await fetchDataFile('./data/valuation_inputs.json')).json);
    if (d) return (VALUATION_DEFAULTS_CACHE = { ...d, error: null });
    return { error: 'a value is missing or not a number' };
  } catch (e) {
    return { error: (e && e.message) || 'not loaded' };
  }
}

// The alert both tabs show without the shared defaults
function valuationDefaultsMissing(defaults) {
  return `<div class="rx">${rxAlert(`<strong>Valuation inputs not loaded</strong> (dashboard/data/valuation_inputs.json: ${escHtml(defaults.error)}), so there are no targets. Reload the page to try again.`)}</div>`;
}

// ========================
// SHARED INPUTS — /api/valuation-inputs (Supabase), falling back to this browser
// ========================
// The edits over the defaults, { bse: { pe1: 48, adr: null }, … } (only the keys typed
// over), are shared by every viewer: GET /api/valuation-inputs is public, and a team
// member signed in with the shared password (/api/team-login) saves them with PUT,
// debounced, since the drawer saves on every keystroke. Until the API first answers
// the page renders from the last shared read this browser saw (localStorage
// VALUATION_SHARED_CACHE_KEY), then re-renders. Without the API (not configured,
// down, or a local static server) edits are saved in this browser only
// (VALUATION_STORAGE_KEY, never touched by the shared store), and a signed-in team
// member can later publish them from the drawer.
//   mode: 'pending' until the API answers, then 'shared' or 'local'
//   pending: exchanges edited here whose PUT has not yet succeeded (kept while one is
//     in flight, so a GET answering meanwhile cannot put the old value back)
//   edits: per exchange, a count of edits, so a PUT's success clears pending only when
//     nothing was typed after it was sent
//   writes: bumped when a PUT is sent and when it answers; a GET that saw it change
//     while in flight is stale and ignored
//   status.state: 'idle' | 'saving' | 'saved' | 'error' (with status.at, status.error)
//   version: bumped whenever the inputs in use change, so views re-render once
const VALUATION_SHARED = {
  mode: 'pending', inputs: {}, updatedAt: {}, signedIn: false, loading: null, version: 0,
  pending: {}, edits: {}, writes: 0, timer: null, saving: null,
  status: { state: 'idle', at: null, error: null }, listeners: new Set(),
};
const VALUATION_SAVE_DELAY_MS = 1000;
const VALUATION_SHARED_CACHE_KEY = 'valuation_inputs_shared_v1';

// x when it is a plain object, else {}
function valuationPlainObject(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : {};
}

// This browser's own edits (this-browser mode)
function readLocalValuationOverrides() {
  try {
    return valuationPlainObject(JSON.parse(localStorage.getItem(VALUATION_STORAGE_KEY) || 'null'));
  } catch (e) { return {}; }   // storage blocked or unreadable: no edits
}

function writeLocalValuationOverrides(o) {
  try { localStorage.setItem(VALUATION_STORAGE_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked: not remembered */ }
}

// The last shared inputs this browser read (null when it has none)
function readSharedValuationCache() {
  try {
    const o = JSON.parse(localStorage.getItem(VALUATION_SHARED_CACHE_KEY) || 'null');
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) { return null; }
}

function writeSharedValuationCache(o) {
  try { localStorage.setItem(VALUATION_SHARED_CACHE_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked */ }
}

// The overrides in use: the shared ones once the API has answered; before that the last
// shared read, or this browser's edits when it has never read any; without the API, this browser's
function readValuationOverrides() {
  const S = VALUATION_SHARED;
  if (S.mode === 'shared') return S.inputs;
  if (S.mode === 'pending') return readSharedValuationCache() || readLocalValuationOverrides();
  return readLocalValuationOverrides();
}

// Whether this viewer may change the inputs: always in this-browser mode, signed in when shared
// (and not while the first answer is awaited, when it is not yet known which)
function valuationCanEdit() {
  const S = VALUATION_SHARED;
  return S.mode === 'local' || (S.mode === 'shared' && S.signedIn);
}

// Saves the overrides: shared and signed in, in use at once and sent after a pause in typing;
// this-browser mode, in localStorage. false (nothing saved) when this viewer may not edit,
// or the first answer is still awaited.
function writeValuationOverrides(o) {
  const S = VALUATION_SHARED;
  if (!valuationCanEdit()) return false;
  if (S.mode === 'local') { writeLocalValuationOverrides(o); return true; }
  const changed = valuationChangedExchanges(S.inputs, o);
  S.inputs = o;
  writeSharedValuationCache(o);
  if (!changed.length) return true;
  changed.forEach(ex => { S.pending[ex] = true; S.edits[ex] = (S.edits[ex] || 0) + 1; });
  S.version++;
  valuationScheduleSave();
  return true;
}

// Same overrides for one exchange, whatever the key order
function valuationSameOverrides(a, b) {
  const key = o => JSON.stringify(Object.keys(valuationPlainObject(o)).sort().map(k => [k, o[k]]));
  return key(a) === key(b);
}

// Exchanges whose overrides differ between a and b
function valuationChangedExchanges(a, b) {
  return VALUATION_EXCHANGES.filter(ex => !valuationSameOverrides(valuationPlainObject(a)[ex], valuationPlainObject(b)[ex]));
}

// One exchange's overrides with only editable keys holding usable values (the API refuses
// the rest; the data-from date is not checked against the latest data date here)
function valuationCleanOverrides(o) {
  const out = {}, src = valuationPlainObject(o);
  VALUATION_EDITABLE.forEach(k => {   // in the drawer's order
    if (k in src && valuationInputOk(k, src[k])) out[k] = src[k];
  });
  return out;
}

// This browser's own edits that the shared inputs lack, { bse: ['pe1'], … }: per exchange,
// the keys this browser set whose value differs from the shared one in use (the shared
// override, else the default when `defaults` is given). Keys only the shared inputs hold
// are not differences: publishing merges this browser's keys onto them.
function valuationUnpublishedKeys(local, shared, defaults) {
  const out = {};
  VALUATION_EXCHANGES.forEach(ex => {
    const o = valuationCleanOverrides(valuationPlainObject(local)[ex]);
    const sh = valuationPlainObject(valuationPlainObject(shared)[ex]);
    const d = defaults && defaults.ex && defaults.ex[ex];
    const keys = Object.keys(o).filter(k => {
      const cur = k in sh ? sh[k] : d ? d[k] : undefined;
      return cur === undefined || !valuationSameInput(o[k], cur);
    });
    if (keys.length) out[ex] = keys;
  });
  return out;
}

// The exchanges valuationUnpublishedKeys finds
function valuationUnpublished(local, shared, defaults) {
  return Object.keys(valuationUnpublishedKeys(local, shared, defaults));
}

// A shared read with this viewer's unsaved edits kept: the exchanges in `pending` keep
// `local`'s overrides; the rest take the server's. Exchanges without overrides are left out.
function valuationMergeShared(server, local, pending) {
  const out = {};
  VALUATION_EXCHANGES.forEach(ex => {
    const src = pending && pending[ex] ? local : server;
    const o = valuationPlainObject(valuationPlainObject(src)[ex]);
    if (Object.keys(o).length) out[ex] = o;
  });
  return out;
}

function valuationSharedNotify() {
  VALUATION_SHARED.listeners.forEach(f => { try { f(); } catch (e) { console.error(e); } });
}

// Takes an API answer ({ configured: true, signed_in, inputs, updated_at }) into the store
function valuationApplyShared(j) {
  const S = VALUATION_SHARED;
  const next = valuationMergeShared(valuationPlainObject(j.inputs), S.inputs, S.pending);
  if (S.mode !== 'shared' || valuationChangedExchanges(S.inputs, next).length) S.version++;
  S.mode = 'shared';
  S.inputs = next;
  S.updatedAt = valuationPlainObject(j.updated_at);
  S.signedIn = !!j.signed_in;
  writeSharedValuationCache(next);
}

// Loads the shared inputs; one request at a time (a call while one is in flight shares it).
// Never rejects: without an answer the page keeps (or falls back to) this browser's edits.
// An answer is ignored when a save was sent or answered while it was in flight: it may
// predate that save.
function loadSharedValuationInputs() {
  const S = VALUATION_SHARED;
  if (S.loading) return S.loading;
  S.loading = (async () => {
    const writes = S.writes;
    try {
      const r = await fetch('/api/valuation-inputs', { cache: 'no-store', credentials: 'same-origin' });
      const j = await r.json();
      if (!r.ok || !j || j.configured !== true || !j.inputs) throw new Error(`HTTP ${r.status}`);
      if (S.mode !== 'shared' || (S.writes === writes && !S.saving)) valuationApplyShared(j);
    } catch (e) {
      if (S.mode === 'pending') { S.mode = 'local'; S.version++; }   // a later failure keeps the last shared read
    } finally {
      S.loading = null;
      valuationSharedNotify();
    }
  })();
  return S.loading;
}

// Sends the pending edits after VALUATION_SAVE_DELAY_MS without another
function valuationScheduleSave() {
  const S = VALUATION_SHARED;
  clearTimeout(S.timer);
  S.status = { state: 'saving', at: S.status.at, error: null };
  S.timer = setTimeout(() => { S.timer = null; valuationFlushSaves(); }, VALUATION_SAVE_DELAY_MS);
  valuationSharedNotify();
}

// One exchange's PUT. It stays pending unless the PUT succeeds with nothing typed since it
// was sent; S.writes moves when it is sent and when it answers (loadSharedValuationInputs).
// Resolves to null when saved, else the reason.
async function valuationPutOne(ex, opts = {}) {
  const S = VALUATION_SHARED;
  const sent = S.edits[ex] || 0;
  S.writes++;
  try {
    const r = await fetch('/api/valuation-inputs', {
      method: 'PUT', credentials: 'same-origin', keepalive: !!opts.keepalive,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange: ex, inputs: valuationPlainObject(S.inputs[ex]) }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { /* no body */ }
    if (r.status === 401) { S.signedIn = false; throw new Error('Signed out: sign in again to save'); }
    if (!r.ok || !j || !j.inputs) throw new Error((j && j.error) || `HTTP ${r.status}`);
    if ((S.edits[ex] || 0) === sent) delete S.pending[ex];
    valuationApplyShared(j);
    return null;
  } catch (e) {
    return (e && e.message) || 'not saved';
  } finally {
    S.writes++;
  }
}

// One save pass: a PUT for each exchange in `list`, all sent at once; S.saving while it runs.
// Resolves to true when every one saved.
function valuationSavePass(list, opts = {}) {
  const S = VALUATION_SHARED;
  S.status = { state: 'saving', at: S.status.at, error: null };
  valuationSharedNotify();
  S.saving = (async () => {
    let error = null;
    try {
      const errs = await Promise.all(list.map(ex => valuationPutOne(ex, opts)));
      error = errs.find(Boolean) || null;
    } finally {
      S.status = error ? { state: 'error', at: S.status.at, error } : { state: 'saved', at: new Date(), error: null };
      S.saving = null;
      valuationSharedNotify();
    }
    return !error;
  })();
  return S.saving;
}

// Saves every pending edit now (also the drawer's Retry, publishing and sign-out), waiting
// for a pass already out and sending what was typed meanwhile. Resolves once nothing is
// pending or saving (true), or a pass of its own fails (false: the edits stay pending).
async function valuationFlushSaves(opts = {}) {
  const S = VALUATION_SHARED;
  clearTimeout(S.timer);
  S.timer = null;
  for (;;) {
    if (S.saving) { await S.saving; continue; }
    const list = VALUATION_EXCHANGES.filter(ex => S.pending[ex]);
    if (!list.length) return true;
    if (!(await valuationSavePass(list, opts))) return false;
  }
}

// Leaving the page: a keepalive PUT for every pending exchange, all issued at once before
// the page goes (not chained behind a save already out, which may not finish).
function valuationSendOnLeave() {
  const S = VALUATION_SHARED;
  clearTimeout(S.timer);
  S.timer = null;
  const list = VALUATION_EXCHANGES.filter(ex => S.pending[ex]);
  if (!list.length) return;
  Promise.all(list.map(ex => valuationPutOne(ex, { keepalive: true }))).then(errs => {
    const error = errs.find(Boolean);
    S.status = error ? { state: 'error', at: S.status.at, error } : { state: 'saved', at: new Date(), error: null };
    valuationSharedNotify();
  });
}

// Registers valuationSendOnLeave for pagehide and for the page being hidden (on phones
// often the last chance). Called once from init (99-init.js).
function valuationSaveOnLeave() {
  window.addEventListener('pagehide', valuationSendOnLeave);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') valuationSendOnLeave(); });
}

// Publishes this browser's own edits (valuationUnpublishedKeys) to the shared inputs: per
// exchange, this browser's keys merged onto the shared ones (never removing a shared key),
// a key equal to its default dropped (defaults: loadValuationDefaults' result, optional),
// one PUT each. Each exchange saved leaves this browser's store. Resolves to the exchanges
// still unsaved.
async function valuationPublishLocal(defaults) {
  const S = VALUATION_SHARED;
  const local = readLocalValuationOverrides();
  const list = valuationUnpublished(local, S.inputs, defaults);
  if (!list.length || S.mode !== 'shared' || !valuationCanEdit()) return list;
  const next = { ...S.inputs };
  list.forEach(ex => {
    const merged = { ...valuationPlainObject(S.inputs[ex]), ...valuationCleanOverrides(local[ex]) };
    const d = defaults && defaults.ex && defaults.ex[ex];
    if (d) Object.keys(merged).forEach(k => { if (k in d && valuationSameInput(merged[k], d[k])) delete merged[k]; });
    if (Object.keys(merged).length) next[ex] = merged; else delete next[ex];
  });
  writeValuationOverrides(next);
  await valuationFlushSaves();
  const left = list.filter(ex => S.pending[ex]);
  const keep = readLocalValuationOverrides();
  list.filter(ex => !S.pending[ex]).forEach(ex => { delete keep[ex]; });
  if (Object.keys(keep).length) writeLocalValuationOverrides(keep);
  else { try { localStorage.removeItem(VALUATION_STORAGE_KEY); } catch (e) { /* storage blocked */ } }
  valuationSharedNotify();
  return left;
}

// Clears this browser's own edits after the viewer confirms; true when cleared
function valuationDiscardLocal() {
  if (!confirm('Discard the valuation edits saved in this browser? The shared inputs are not changed.')) return false;
  try { localStorage.removeItem(VALUATION_STORAGE_KEY); } catch (e) { /* storage blocked */ }
  valuationSharedNotify();
  return true;
}

// Team sign-in for the shared inputs: POST /api/team-login, then asks whether it took.
// Resolves to null when signed in, else the reason to show.
async function valuationTeamSignIn(password) {
  try {
    const r = await fetch('/api/team-login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (r.status !== 204) {
      let j = null;
      try { j = await r.json(); } catch (e) { /* no body */ }
      return r.status === 503 ? 'Team sign-in is not set up yet.' : (j && j.error) || `Sign-in failed (HTTP ${r.status}).`;
    }
    const c = await fetch('/api/team-login', { cache: 'no-store', credentials: 'same-origin' });
    const j = await c.json();
    VALUATION_SHARED.signedIn = !!(j && j.signed_in);
    valuationSharedNotify();
    return VALUATION_SHARED.signedIn ? null : 'Signed in, but this browser did not keep the session (cookies blocked?).';
  } catch (e) {
    return 'Could not reach the sign-in service.';
  }
}

// Signs out after saving any edit still waiting. false (still signed in) when a save failed,
// unless opts.force, which drops the unsaved edits and shows the shared inputs again.
async function valuationTeamSignOut(opts = {}) {
  const S = VALUATION_SHARED;
  if (S.timer || S.saving || Object.keys(S.pending).length) await valuationFlushSaves();
  if (Object.keys(S.pending).length) {
    if (!opts.force) return false;
    S.pending = {};   // the shared inputs come back with the reload below
  }
  try { await fetch('/api/team-login?logout=1', { method: 'POST', credentials: 'same-origin' }); } catch (e) { /* signed out here anyway */ }
  S.signedIn = false;
  S.status = { state: 'idle', at: null, error: null };
  valuationSharedNotify();
  if (opts.force) loadSharedValuationInputs();
  return true;
}

const valuationSameInput = (a, b) => (a === null || b === null || typeof a === 'string' || typeof b === 'string') ? a === b : Math.abs(a - b) < 1e-9;

// A usable value for an editable input: a blank (null) or positive ADR estimate, a P/E above
// zero, a weight of zero or more, a discount rate of zero or more and below 100 %, QoQ
// growth above −100 %, a blank (null) data-from date or a real YYYY-MM-DD date not after
// `latest` (the latest data date, when known)
function valuationInputOk(k, x, latest) {
  if (k === 'adr') return x === null || (valuationNum(x) && x > 0);
  if (k === 'from') return x === null || (valuationIsoDate(x) && !(latest && x > latest));
  if (!valuationNum(x)) return false;
  if (k[0] === 'p') return x > 0;
  if (k[0] === 'w') return x >= 0;
  if (k === 'd1' || k === 'd2') return x >= 0 && x < 100;
  return x > -100;
}

// The inputs in use for one exchange: { v: defaults with the edits (readValuationOverrides) on top,
// edited: the keys that differ from the defaults }. Unusable saved values are ignored
// (latest: the latest data date, which a data-from date may not pass).
function valuationInputsFor(defaults, overrides, ex, latest) {
  const d = defaults.ex[ex], o = (overrides && overrides[ex]) || {};
  const v = { ...d }, edited = [];
  VALUATION_EDITABLE.forEach(k => {
    if (!(k in o)) return;
    const x = o[k];
    if (!valuationInputOk(k, x, latest)) return;
    if (valuationSameInput(x, d[k])) return;
    v[k] = x;
    edited.push(k);
  });
  return { v, edited };
}

// Overrides with one exchange's input set to `value` (null = a blank ADR estimate or
// data-from date); a value equal to the default removes the edit
function setValuationOverride(overrides, defaults, ex, key, value) {
  const out = { ...overrides, [ex]: { ...(overrides[ex] || {}) } };
  if (valuationSameInput(value, defaults.ex[ex][key])) delete out[ex][key];
  else out[ex][key] = value;
  if (!Object.keys(out[ex]).length) delete out[ex];
  return out;
}

// "Q3 FY 2027" → { q: 3, fy: 2027 }
function parseFYQuarter(label) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  return m ? { q: +m[1], fy: +m[2] } : null;
}

// Quarter-by-quarter ADR from the start quarter (its ADR to date) to Q4 of the next FY,
// compounding qoqPct a quarter, and that FY's average of its four quarters
function valuationAdrPath(start, startAdr, qoqPct) {
  const path = [];
  let { q, fy } = start, adr = startAdr;
  while (fy <= start.fy + 1) {
    path.push({ q, fy, label: `Q${q} FY${String(fy).slice(-2)}`, adr });
    adr *= 1 + qoqPct / 100;
    if (++q > 4) { q = 1; fy++; }
  }
  const next = path.filter(p => p.fy === start.fy + 1);
  return { path, fy: start.fy + 1, adr: next.reduce((s, p) => s + p.adr, 0) / next.length };
}

// The ADR model, the workbook's valuation block: next-FY ADR × sessions + other income →
// × PAT margin ÷ shares (Cr) → EPS × P/E → next-FY-end target (fwd), ÷ (1 + d1) to this
// FY's end (mid), ÷ (1 + d2) to today (now); per scenario [bear, base, bull]. EPS and the
// targets are null without a share count.
function valuationAdrModel(v, adrFY, shares) {
  const txn = adrFY * v.days;
  const total = txn + v.oi;
  const pat = total * v.margin / 100;
  const eps = shares > 0 ? pat / shares : null;
  const pe = [v.pe0, v.pe1, v.pe2];
  const fwd = pe.map(p => eps != null ? eps * p : null);
  const mid = fwd.map(f => f != null ? f / (1 + v.d1 / 100) : null);
  const now = mid.map(f => f != null ? f / (1 + v.d2 / 100) : null);
  return { adrFY, txn, oi: v.oi, total, margin: v.margin, pat, eps, pe, fwd, mid, now };
}

// Regression at an ADR, [bear, base, bull]: intercept + slope × ADR, ∓ the fit's standard
// error of estimate (the same as moving ADR by ∓ se ÷ slope); null without a fit
function valuationRegression(fit, adr) {
  if (!fit || !valuationNum(fit.se) || !valuationNum(adr)) return null;
  const base = fit.intercept + fit.slope * adr;
  return [base - fit.se, base, base + fit.se];
}

// Ratio Analysis at an ADR, [bear, base, bull]: (mean ∓ σ of price ÷ MA) × ADR; null without history
function valuationRatio(ratio, adr) {
  if (!ratio || !valuationNum(adr)) return null;
  return [ratio.mean - ratio.sd, ratio.mean, ratio.mean + ratio.sd].map(k => k * adr);
}

// Weighted average per scenario. vals: { reg, ratio, adr }, each [bear, base, bull] or null;
// w: weights in %, [regression, ratio, ADR model]. One rule throughout: Σ weight × value ÷
// Σ weight over the methods that have a value. With weights adding to 100 % and every method
// present that is the workbook's SUMPRODUCT; a method without a value drops out, and weights
// that do not add to 100 % are flagged, without either moving the average's scale.
function valuationTriangulate(vals, w) {
  const methods = VALUATION_METHODS.map(([k], i) => ({ k, w: w[i], vals: vals[k] }));
  const used = methods.filter(m => m.vals && m.w > 0);
  const wUsed = used.reduce((s, m) => s + m.w, 0);
  return {
    avg: wUsed > 0 ? [0, 1, 2].map(i => used.reduce((s, m) => s + m.w * m.vals[i], 0) / wUsed) : null,
    used: used.map(m => m.k),
    dropped: methods.filter(m => !m.vals && m.w > 0).map(m => m.k),
    wUsed, wTotal: w.reduce((s, x) => s + x, 0),
  };
}

// Both triangulations for one exchange. c: the data (valuationContextFor) — start quarter,
// its ADR to date (qAdr), the 45-session ADR (adr45), the fit { intercept, slope, se } and
// ratio { mean, sd } (either null); v: the inputs (valuationInputsFor); shares in Cr.
function valuationModel(c, v, shares) {
  const path = valuationAdrPath(c.start, c.qAdr, v.g);
  const adrModel = valuationAdrModel(v, path.adr, shares);
  const tri = adr => {
    const vals = { reg: valuationRegression(c.fit, adr), ratio: valuationRatio(c.ratio, adr), adr: adrModel.eps != null ? adrModel.now : null };
    return { adr, vals, ...valuationTriangulate(vals, [v.w0, v.w1, v.w2]) };
  };
  return { path, adrModel, dma: tri(c.adr45), est: tri(v.adr ?? c.adr45), estIsDma: v.adr == null };
}

// The regression and ratio the valuation uses, fitted on the share file's data from `from`
// (ISO date; null = the published fit, as the Regression tab shows it). With a date, the
// data set starts there as in the workbook: revenue and prices before it are dropped, so
// the 45-session MA is built only from revenue on or after `from` (none for its first 44
// sessions) and the fit starts at `from`; computeShareModel still leaves out sessions whose
// MA includes modelled revenue (MCX before 2 Sep 2024). The fit is used only when the
// Regression tab's gate passes for that window; the ratio once there is a fit window.
// Returns { fit, fitWhy, ratio, ratioWhy, win }: win describes the window (data-from date,
// fit start, first point, sessions in the fit, sessions left out as modelled) and the
// published fit's start and size for comparison.
function valuationFitFields(share, from) {
  const noModel = !share ? 'no share-price file'
    : share.status === 'collecting' ? `${share.n_days} of ${share.min_days_required} sessions collected since listing` : 'no share-price fit';
  const canFit = !!share && !!share.regression && share.status !== 'collecting';
  const w = (share && share.ma_window) || 45;
  const published = canFit ? computeShareModel(share, w) : null;
  // A data-from date needs the daily revenue (files from before Phase 5 have none)
  const useFrom = !!from && canFit && !!share.revenue_daily;
  const model = !useFrom ? published : computeShareModel({
    ...share, regression_start: from,
    revenue_daily: share.revenue_daily.filter(r => r.date >= from),
    series: (share.series || []).filter(r => r.date >= from),
  }, w);
  const regStart = useFrom ? from : (share && share.regression_start) || null;
  const supported = !!model && (model.meth ? model.meth.fair_value_supported : !useFrom && share.latest?.price_pred != null);
  const se = supported ? shareResidualSE(model.series, model.reg, regStart) : null;
  const ratio = model ? shareRatioStats(model.series, regStart) : null;
  const inFit = r => (r.in_fit === undefined ? r.date >= regStart : r.in_fit);
  const fitRows = model ? model.series.filter(inFit) : [];
  const modelledOut = model ? model.series.filter(r => r.date >= regStart && !inFit(r)).length : 0;
  const modelled = ((share && share.revenue_daily) || []).filter(r => r.modelled).map(r => r.date);
  const pubRows = published ? published.series.filter(r => (r.in_fit === undefined ? r.date >= share.regression_start : r.in_fit)) : [];
  return {
    fit: se ? { intercept: model.reg.intercept, slope: model.reg.slope, se: se.se, n: se.n, r2: model.reg.r_squared } : null,
    fitWhy: !model ? (canFit && useFrom ? `fewer than 10 sessions with a full ${w}-session MA from ${rxDate(from)}` : noModel)
      : !supported ? `fit withheld: ${(model.meth?.gate_reasons || ['not significant']).join('; ')}`
      : !se ? 'too few sessions in the fit' : '',
    ratio, ratioWhy: !model ? (canFit && useFrom ? `fewer than 10 sessions with a full ${w}-session MA from ${rxDate(from)}` : noModel) : !ratio ? 'no price ÷ MA history' : '',
    win: {
      from: useFrom ? from : null, maWindow: w,
      // Why a data-from date is not applied ('' when it is, or none is set)
      fromIgnored: !from || useFrom ? '' : canFit ? 'no daily revenue' : share && share.status === 'collecting' ? 'collecting' : 'no fit',
      fitStart: regStart, firstPoint: fitRows.length ? fitRows[0].date : null, n: fitRows.length,
      modelledOut, modelledTo: modelledOut && modelled.length ? modelled[modelled.length - 1] : null,
      pubStart: (share && share.regression_start) || null, pubN: pubRows.length,
    },
  };
}

// What the model reads from an exchange's daily rows (at today's rates) and its share file:
// the latest quarter's ADR to date, the last 45 sessions' ADR, the published 45-session fit
// with its standard error (only when the Regression tab publishes a fair value) and the
// price ÷ MA ratio (once the fit is past collecting); CMP. null without daily rows.
// valuationFitted re-fits it from a data-from date.
function valuationContextFor(raw, share) {
  const rows = ((raw && raw.daily_all) || []).filter(r => valuationNum(r.total_rev)).slice().sort((a, b) => a.date.localeCompare(b.date));
  const last = rows[rows.length - 1];
  const start = last && parseFYQuarter(last.fy_quarter);
  if (!start) return null;
  const qRows = rows.filter(r => r.fy_quarter === last.fy_quarter), r45 = rows.slice(-45);
  const mean = rs => rs.reduce((s, r) => s + r.total_rev, 0) / rs.length;
  const lat = (share && share.latest) || {};
  const rev = (share && share.revenue_daily) || [];
  return {
    start, qLabel: last.fy_quarter, qAdr: mean(qRows), qN: qRows.length, adr45: mean(r45), n45: r45.length, lastDate: last.date,
    flags: mergeFlags([rowsFlags(qRows, 'total'), rowsFlags(r45, 'total')]),
    ...valuationFitFields(share, null),
    fitStart: (share && share.regression_start) || null, ticker: (share && share.ticker) || '',
    dataFirst: rev.length ? rev[0].date : null,
    cmp: lat.price_actual ?? null, cmpLive: !!lat.is_live, cmpDate: lat.date || null,
    share: share || null,
  };
}

// The context with its regression and ratio fitted on the data from `from` (the exchange's
// "Regression data from" input; null = the published fit). Kept per date on the context.
function valuationFitted(c, from) {
  if (!c || !from || !c.share) return c;
  const memo = c._fitted || (c._fitted = {});
  return memo[from] || (memo[from] = { ...c, ...valuationFitFields(c.share, from), _fitted: null });
}

// ── Data for any exchange, whichever is on show ─────────────────────────────
function valuationOnShow(ex) {
  return !!VIEW_LOADED && VIEW_LOADED.exchange === ex && !!DATA && !DATA.components;
}

// The exchange's share file with the live quote applied to its CMP (the glance view's
// loader and cache for an exchange not on show); null if it fails to load
function valuationShareData(ex) {
  return valuationOnShow(ex) ? Promise.resolve(SHARE_DATA) : glanceShare(ex);
}

// { ex, c: valuationContextFor's result or null, error } for one exchange
async function valuationExchange(ex) {
  const [raw, share] = await Promise.all([valuationOnShow(ex) ? DATA : todayRatesData(ex), valuationShareData(ex)]);
  const c = raw ? valuationContextFor(raw, share) : null;
  return { ex, c, error: !raw ? 'daily data did not load' : !c ? 'no daily rows' : null };
}

// ── Shared pieces of the two tabs ───────────────────────────────────────────
const valuationFYShort = fy => `FY${String(fy).slice(-2)}`;
// A weight or other whole-number percentage, with a decimal only when it has one
const valuationPct = x => `${fmtNum(x, Number.isInteger(x) ? 0 : 1)} %`;

// Warning about the defaults: fixed inputs for another year
function valuationDefaultsNotes(defaults, c) {
  const notes = [];
  if (c && c.start.fy + 1 !== defaults.fy) notes.push(rxAlert(`<strong>Fixed inputs are for ${valuationFYShort(defaults.fy)}</strong>, but the ADR path now runs to ${valuationFYShort(c.start.fy + 1)}: update other income, PAT margin and sessions in dashboard/data/valuation_inputs.json.`));
  return notes.join('');
}

// "close 13 Nov" / "live quote" / "no price yet"
function valuationCmpWhen(c) {
  return c.cmp == null ? 'no price yet' : c.cmpLive ? 'live quote' : `close ${fmtTradeDate(c.cmpDate)}`;
}

function valuationUpHTML(x, cmp, digits = 1) {
  return x == null || !cmp ? '—' : `<span class="${x / cmp - 1 >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(x / cmp - 1, digits)}</span>`;
}

// The fit window in words: "data from 1 Jan 2025 · first point 5 Mar 2025 · 419 sessions",
// or for the published fit "all data · fit from 1 Mar 2025 · first point … · … sessions"
function valuationWindowText(win) {
  const head = win.from ? `data from ${rxDate(win.from)}` : `all data · fit from ${rxDate(win.fitStart)}`;
  return win.n ? `${head} · first point ${rxDate(win.firstPoint)} · ${fmtNum(win.n, 0)} sessions` : head;
}

// What the window leaves out: sessions whose MA includes modelled revenue, or a data-from
// date the share file cannot apply; '' when nothing
function valuationWindowNote(win) {
  const notes = [];
  if (win.modelledOut) notes.push(`${fmtNum(win.modelledOut, 0)} sessions left out: their ${win.maWindow}-session MA includes modelled revenue (to ${rxDate(win.modelledTo)}).`);
  if (win.fromIgnored === 'no daily revenue') notes.push('The share file has no daily revenue, so the data-from date is not applied: the published fit is used.');
  else if (win.fromIgnored === 'collecting') notes.push('Still collecting sessions since listing: the data-from date applies once the fit is published.');
  else if (win.fromIgnored) notes.push('The share file has no fit, so the data-from date is not applied.');
  return notes.join(' ');
}

// Why a triangulation's average leaves methods out, or rescales the weights
function valuationTriNote(t, c) {
  const names = { reg: 'Regression', ratio: 'Ratio Analysis', adr: 'ADR model' };
  const why = { reg: c.fitWhy || 'no fit', ratio: c.ratioWhy || 'no price ÷ MA history', adr: 'needs a share count' };
  const notes = t.dropped.map(k => `${names[k]} has no value (${escHtml(why[k])}), so its weight is shared by the others.`);
  const unweighted = VALUATION_METHODS.map(([k]) => k).filter(k => !t.vals[k] && !t.dropped.includes(k));
  if (unweighted.length) notes.push(`${unweighted.map(k => `${names[k]}: ${escHtml(why[k])}`).join('; ')} (weight 0).`);
  if (Math.abs(t.wTotal - 100) > 1e-9) notes.push(`The weights entered add to ${valuationPct(t.wTotal)}, not 100 %; the average divides by the weights of the methods with a value.`);
  if (!t.used.length) notes.push('No method with a weight has a value.');
  return notes.join(' ');
}

// ========================
// VALUATION MODEL TAB — the selected exchange's two triangulations, then the workings
// ========================

// One 3 × 3 table: Regression / Ratio Analysis / ADR model × Bear / Base / Bull, each
// method's weight, the weighted average and its upside vs CMP
function valuationTriTable(t, v, cmp, aria) {
  const n0 = x => valuationNum(x) ? fmtNum(x, 0) : '—';
  const heads = ['Bear', 'Base', 'Bull'].map((s, i) => `<th scope="col" class="rx-xl-h rx-xl-${s.toLowerCase()} rx-xl-t${i === 2 ? ' rx-xl-r' : ''}">${s}</th>`).join('');
  const w = [v.w0, v.w1, v.w2];
  const body = VALUATION_METHODS.map(([k, label], i) => {
    const vals = t.vals[k];
    const wNote = t.dropped.includes(k) ? ' title="No value: its weight is shared by the others"' : '';
    return `<tr${k === 'ratio' ? ' class="rx-xl-peach"' : ''}><td class="rx-xl-lab">${label}</td>${[0, 1, 2].map(j =>
      `<td${j === 2 ? ' class="rx-xl-r"' : ''}>${vals ? n0(vals[j]) : '—'}</td>`).join('')}<td class="rx-xl-w${t.dropped.includes(k) ? ' rx-val-wx' : ''}"${wNote}>${valuationPct(w[i])}</td></tr>`;
  }).join('');
  const avg = t.avg || [null, null, null];
  return `<table class="rx-table rx-xl rx-val-tri" aria-label="${escHtml(aria)}">
    <thead><tr><th scope="col" class="rx-xl-lab rx-xl-h rx-xl-sum rx-xl-t">₹ per share, today</th>${heads}<th scope="col" class="rx-xl-w">Weight</th></tr></thead>
    <tbody>${body}
      <tr class="rx-xl-lilac rx-xl-bold"><td class="rx-xl-lab rx-xl-t">Weighted average</td>${[0, 1, 2].map(j => `<td class="rx-xl-t${j === 2 ? ' rx-xl-r' : ''}">${n0(avg[j])}</td>`).join('')}<td class="rx-xl-w">${valuationPct(t.wTotal)}</td></tr>
      <tr><td class="rx-xl-lab rx-xl-b">Upside vs CMP</td>${[0, 1, 2].map(j => `<td class="rx-xl-b${j === 2 ? ' rx-xl-r' : ''}">${valuationUpHTML(avg[j], cmp)}</td>`).join('')}<td class="rx-xl-w"></td></tr>
    </tbody></table>`;
}

// The ADR model block's rows, in the workbook's layout: block 0 = ADR to upside, 1 = to this
// FY's end, 2 = to today (each boxed); fy is the next FY (2028 → "FY 28")
function valuationExcelRows(fy, d1, d2) {
  const y1 = `FY ${String(fy).slice(-2)}`, y0 = `FY ${String(fy - 1).slice(-2)}`;
  return [
    { key: 'adrFY', label: `ADR ${y1}`, block: 0, bold: true },
    { key: 'oi', label: 'Other Income', block: 0 },
    { key: 'total', label: 'Total Income', block: 0 },
    { key: 'margin', label: 'PAT Margin', block: 0 },
    { key: 'eps', label: 'EPS', block: 0 },
    { key: 'pe', label: 'PE', block: 0, tint: 'green' },
    { key: 'fwd', label: `Price Target ${y1}`, block: 0, bold: true, boxed: true },
    { key: 'up', label: 'Upside', block: 0, tint: 'peach' },
    { key: 'd1', label: `Discount ${valuationPct(d1)}`, block: 1 },
    { key: 'mid', label: `Target Price ${y0}`, block: 1, bold: true },
    { key: 'd2', label: `Discount ${valuationPct(d2)}`, block: 2 },
    { key: 'now', label: 'Target Price Current', block: 2, bold: true },
  ];
}

// Cell text, [bear, base, bull] per row key, from valuationAdrModel's result: ADR to 2
// decimals, ₹ whole, EPS 2 decimals, margin whole %, upside (next-FY-end target vs CMP) whole %
function valuationExcelCells(a, v, cmp) {
  const n0 = x => valuationNum(x) ? fmtNum(x, 0) : '—';
  const each = f => [0, 1, 2].map(f);
  return {
    adrFY: each(() => fmtNum(a.adrFY, 2)),
    oi: each(() => n0(a.oi)),
    total: each(() => n0(a.total)),
    margin: each(() => `${fmtNum(a.margin, 0)} %`),
    eps: each(() => valuationNum(a.eps) ? fmtNum(a.eps, 2) : '—'),
    pe: each(i => `${fmtNum(a.pe[i], 0)}×`),
    fwd: each(i => n0(a.fwd[i])),
    up: each(i => a.fwd[i] != null && cmp ? rxSignedPct(a.fwd[i] / cmp - 1, 0) : '—'),
    d1: each(() => `÷ ${fmtNum(1 + v.d1 / 100, Number.isInteger(v.d1) ? 2 : 3)}`),
    mid: each(i => n0(a.mid[i])),
    d2: each(() => `÷ ${fmtNum(1 + v.d2 / 100, Number.isInteger(v.d2) ? 2 : 3)}`),
    now: each(i => n0(a.now[i])),
  };
}

function valuationExcelTable(m, v, cmp) {
  const rows = valuationExcelRows(m.path.fy, v.d1, v.d2);
  const cells = valuationExcelCells(m.adrModel, v, cmp);
  // the box edges a row's cells carry: top of a later block, bottom of a block or of a boxed row
  const edge = i => {
    const r = rows[i], prev = rows[i - 1], next = rows[i + 1];
    return (prev && prev.block !== r.block ? ' rx-xl-t' : '') + (!next || next.block !== r.block || next.boxed || r.boxed ? ' rx-xl-b' : '');
  };
  const heads = ['Bear', 'Base', 'Bull'].map((s, i) => `<th scope="col" class="rx-xl-h rx-xl-${s.toLowerCase()} rx-xl-t${i === 2 ? ' rx-xl-r' : ''}">${s}</th>`).join('');
  const body = rows.map((r, i) => {
    const e = edge(i);
    const cls = [r.tint ? `rx-xl-${r.tint}` : '', r.bold ? 'rx-xl-bold' : '', r.boxed ? 'rx-xl-boxed' : ''].filter(Boolean).join(' ');
    const tds = cells[r.key].map((txt, j) => {
      const c = `${e}${j === 2 ? ' rx-xl-r' : ''}`.trim();
      const html = r.key === 'up' && txt !== '—' ? `<span class="${txt[0] === '+' ? 'rx-up' : 'rx-dn'}">${txt}</span>` : txt;
      return `<td${c ? ` class="${c}"` : ''}>${html}</td>`;
    }).join('');
    const gap = e.includes('rx-xl-t') ? '<tr class="rx-xl-gap" aria-hidden="true"><td colspan="4"></td></tr>' : '';
    return `${gap}<tr${cls ? ` class="${cls}"` : ''}><td class="rx-xl-lab${e}">${r.label}</td>${tds}</tr>`;
  }).join('');
  return `<table class="rx-table rx-xl rx-val-tri" aria-label="ADR model ${valuationFYShort(m.path.fy)}, Bear / Base / Bull">
    <thead><tr><th scope="col" class="rx-xl-lab rx-xl-t">CMP ${rxRupee(cmp)}</th>${heads}</tr></thead><tbody>${body}</tbody></table>`;
}

function valuationTabHTML(ex, defaults, c0, analysts, open) {
  const { v, edited } = valuationInputsFor(defaults, readValuationOverrides(), ex, c0.lastDate);
  const c = valuationFitted(c0, v.from);   // regression and ratio on the data from the chosen date
  const shares = SHARES_OUTSTANDING_CR[ex].value;
  const m = valuationModel(c, v, shares);
  const fy1 = valuationFYShort(m.path.fy), qShort = `Q${c.start.q} ${valuationFYShort(c.start.fy)}`;
  const cmp = c.cmp;
  const cmpWhen = valuationCmpWhen(c);
  const adrTxt = x => fmtNum(x, 2);
  const vs45 = v.adr != null && c.adr45 ? ` · ${rxSignedPct(v.adr / c.adr45 - 1, 1)} vs 45 DMA` : '';
  const editedChip = edited.length ? rxChip(`Edited: ${edited.map(k => VALUATION_INPUT_LABELS[k]).join(', ')}`, 'edit') : '';
  const triPanel = (t, title, meta, aria, cls = 'rx-col-half') => rxPanel({
    cls, title, meta,
    body: `<div class="rx-pb rx-scroll">${valuationTriTable(t, v, cmp, aria)}</div>`,
    foot: valuationTriNote(t, c) || `Weighted average = Σ weight × target ÷ Σ weight, over the methods with a value.`,
  });
  // No ADR estimate: the estimate triangulation would repeat the 45 DMA one, so show it once
  const tris = m.estIsDma
    ? `<div class="rx-row">
    ${triPanel(m.dma, `Triangulated · 45 DMA (ADR ${adrTxt(c.adr45)})`,
      `last ${c.n45} sessions${flagTags(c.flags)} · no ADR estimate set, so there is no second table · <button type="button" class="rx-link" data-val-edit>set one in the inputs</button>`,
      '45 DMA triangulation', 'rx-col-full')}
  </div>`
    : `<div class="rx-row">
    ${triPanel(m.dma, `Triangulated · 45 DMA (ADR ${adrTxt(c.adr45)})`, `last ${c.n45} sessions${flagTags(c.flags)}`, '45 DMA triangulation')}
    ${triPanel(m.est, `Triangulated · ADR estimate (ADR ${adrTxt(m.est.adr)})`, `your estimate${vs45}`, 'ADR estimate triangulation')}
  </div>`;

  // Workings: the ADR model block, the ADR path, the regression and ratio figures
  const fit = c.fit, ratio = c.ratio, win = c.win, winNote = valuationWindowNote(win);
  const pathRows = m.path.path.map((p, i) => `<tr><td>${p.label}${i === 0 ? ` · to date${flagTags(c.flags)}` : ''}</td><td>${adrTxt(p.adr)}</td><td class="rx-src">${i === 0 ? `${c.qN} sessions` : `× ${fmtNum(1 + v.g / 100, 2)}`}</td></tr>`).join('');
  const regAt = (label, adr) => {
    const r = valuationRegression(fit, adr), k = valuationRatio(ratio, adr);
    return `<tr><td>${label}</td><td>${adrTxt(adr)}</td><td>${r ? `${fmtNum(r[0], 0)} / ${fmtNum(r[1], 0)} / ${fmtNum(r[2], 0)}` : '—'}</td><td>${k ? `${fmtNum(k[0], 0)} / ${fmtNum(k[1], 0)} / ${fmtNum(k[2], 0)}` : '—'}</td></tr>`;
  };
  const how = `<details class="rx-panel rx-val-how"${open ? ' open' : ''}>
    <summary class="rx-ph"><h2>How the figures are built</h2><span class="rx-meta">ADR model ${fy1}E, ADR path, regression and ratio</span></summary>
    <div class="rx-pb"><div class="rx-row">
      <div class="rx-col-half">
        <h3 class="rx-lbl rx-val-h3">ADR model · ${fy1}E · same in both tables</h3>
        <div class="rx-scroll">${valuationExcelTable(m, v, cmp)}</div>
        <p class="rx-foot rx-val-p">ADR ₹ Cr / session × ${fmtNum(v.days, 0)} sessions + other income ₹${fmtNum(v.oi, 0)} Cr = total income; × PAT margin ÷ ${fmtNum(shares, 2)} Cr shares ${sharesChip(ex)} = EPS; × P/E = the ${fy1}-end target, discounted ${valuationPct(v.d1)} to ${valuationFYShort(m.path.fy - 1)} end and ${valuationPct(v.d2)} to today. Upside: the ${fy1}-end target vs CMP (${cmpWhen}).</p>
      </div>
      <div class="rx-col-half">
        <h3 class="rx-lbl rx-val-h3">ADR path · ₹ Cr / session at today’s rates</h3>
        <div class="rx-scroll"><table class="rx-table">
          <thead><tr><th scope="col">Quarter</th><th scope="col">ADR</th><th scope="col" class="rx-l">From</th></tr></thead>
          <tbody>${pathRows}
            <tr class="rx-sub"><td>${fy1} average</td><td>${adrTxt(m.path.adr)}</td><td class="rx-src">mean of its four quarters</td></tr>
          </tbody></table></div>
        <p class="rx-foot rx-val-p">${qShort} ADR to date, grown ${fmtNum(v.g, 1)} % a quarter (${fmtPct(Math.pow(1 + v.g / 100, 4) - 1)} a year).</p>
        <h3 class="rx-lbl rx-val-h3">Regression and ratio · ${win.from ? `${win.maWindow}-session fit, data from ${rxDate(win.from)}` : `published ${win.maWindow}-session fit`}</h3>
        <div class="rx-scroll"><table class="rx-table rx-wrap-lab">
          <tbody>
            <tr><td>Fit</td><td class="rx-wrap">${fit ? `${escHtml(c.ticker)} · price = ₹${fmtNum(fit.intercept, 1)} + ${fmtNum(fit.slope, 2)} × ADR · R² ${fmtNum(fit.r2, 2)}<br>` : `<span class="rx-foot">${escHtml(c.fitWhy)}</span><br>`}${valuationWindowText(win)}${winNote ? `<br><span class="rx-foot">${escHtml(winNote)}</span>` : ''}${win.from ? `<br><span class="rx-foot">Published fit (Regression tab): from ${rxDate(win.pubStart)}, ${fmtNum(win.pubN, 0)} sessions, MA over all revenue</span>` : ''}</td></tr>
            <tr><td>Standard error of estimate</td><td class="rx-wrap">${fit ? `₹${fmtNum(fit.se, 0)}: Bear / Bull = base ∓ ₹${fmtNum(fit.se, 0)}, the same as moving ADR by ∓ ${fmtNum(fit.se / fit.slope, 2)} Cr` : '—'}</td></tr>
            <tr><td>Price ÷ revenue MA</td><td class="rx-wrap">${ratio ? `mean ${fmtNum(ratio.mean, 1)}×, σ ${fmtNum(ratio.sd, 1)}×: Bear / Base / Bull = (mean − σ / mean / mean + σ) × ADR` : `<span class="rx-foot">${escHtml(c.ratioWhy)}</span>`}</td></tr>
          </tbody></table></div>
        <div class="rx-scroll" style="margin-top:8px"><table class="rx-table">
          <thead><tr><th scope="col">ADR from</th><th scope="col">ADR</th><th scope="col">Regression</th><th scope="col">Ratio</th></tr></thead>
          <tbody>${regAt('45 DMA', c.adr45)}${regAt(m.estIsDma ? 'Estimate (= 45 DMA)' : 'Estimate', m.est.adr)}</tbody></table></div>
        <p class="rx-foot rx-val-p">Bear / Base / Bull, ₹ per share, not discounted.</p>
      </div>
    </div></div>
  </details>`;

  let analystHTML = '';
  if (ex === 'bse') {
    const oldest = analysts.reduce((mn, t) => (t.date && (!mn || t.date < mn) ? t.date : mn), null);
    const newest = analysts.reduce((mx, t) => (t.date && (!mx || t.date > mx) ? t.date : mx), null);
    const oldestAge = daysSinceIso(oldest);
    const avg = analysts.length ? analysts.reduce((s, t) => s + t.target_price, 0) / analysts.length : null;
    analystHTML = rxPanel({ title: 'Analyst targets', meta: `bse_analyst_targets.json · 12-month targets${oldest ? ` · ${analystMonths(oldest, newest)}` : ''}${avg != null ? ` · mean ${rxRupee(avg)}` : ''}`,
      right: oldestAge != null && oldestAge > ANALYST_TARGET_STALE_DAYS ? rxChip(`Oldest ${oldestAge} days old`, 'warn') : '',
      body: `<div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col">Broker</th><th scope="col">Target</th><th scope="col">vs CMP</th><th scope="col" class="rx-l">Rating</th><th scope="col">Date</th><th scope="col">Age</th><th scope="col" class="rx-l">Method</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        ${analysts.length ? analysts.slice().sort((a, b) => b.target_price - a.target_price).map(t => {
          const age = daysSinceIso(t.date);
          const url = safeHttpUrl(t.source_url);
          return `<tr><td>${escHtml(t.broker)}</td><td>${rxRupee(t.target_price)}</td><td>${cmp ? rxChangeHTML(t.target_price / cmp - 1) : '—'}</td><td class="rx-l">${escHtml(t.rating || '')}</td><td>${rxDate(t.date)}</td><td>${age == null ? '—' : rxChip(`${age} d`, age > ANALYST_TARGET_STALE_DAYS ? 'warn' : '')}</td><td class="rx-wrap">${escHtml(t.methodology || '')}</td><td class="rx-l">${url ? `<a class="rx-link" href="${url}" target="_blank" rel="noopener noreferrer">Report ↗</a>` : '<span class="rx-foot">not on file</span>'}</td></tr>`;
        }).join('') : '<tr><td colspan="8" class="rx-l">No analyst targets on file: add them to dashboard/data/bse_analyst_targets.json</td></tr>'}
      </tbody></table></div>`,
      foot: `Notes older than ${ANALYST_TARGET_STALE_DAYS} days are flagged. Analyst targets are their 12-month prices, not discounted.` });
  }

  return `<div class="rx">
    ${valuationDefaultsNotes(defaults, c)}
    <div class="rx-val-bar">
      <span><strong>${SHARE_EXCHANGE_NAMES[ex]}</strong> · CMP ${rxRupee(cmp, 2)} <span class="rx-foot">${cmpWhen}</span></span>
      <span class="rx-foot">Targets ₹ per share for today · ADR ₹ Cr / session at today’s rates, the fits’ basis</span>
      ${editedChip}
      <button type="button" class="rx-btn rx-btn--primary" data-val-edit aria-haspopup="dialog">Edit ${SHARE_EXCHANGE_NAMES[ex]} inputs</button>
    </div>
    <section class="rx-kpis rx-vi-strip" aria-label="Base case targets, BSE, MCX and NSE" data-val-strip></section>
    ${tris}
    ${how}
    ${analystHTML}
    ${excelSyncPanelHTML(EXCEL_SYNC, VALUATION_SHARED.signedIn)}
  </div>`;
}

let VALUATION_BUILD_SEQ = 0;   // latest Valuation tab build; an older one still loading yields to it

async function buildValuation(ex) {
  const el = document.getElementById(`${ex}ValuationContent`);
  if (!el) return;
  const seq = ++VALUATION_BUILD_SEQ;
  const shared = loadSharedValuationInputs();   // rendered from this browser's copy until it answers
  const [defaults, data, analysts] = await Promise.all([
    loadValuationDefaults(), valuationExchange(ex), ex === 'bse' ? loadBSEAnalystTargets() : [],
  ]);
  if (seq !== VALUATION_BUILD_SEQ || currentExchange !== ex) return;  // rebuilt or switched away while loading
  if (defaults.error) {
    el.innerHTML = valuationDefaultsMissing(defaults);
    return;
  }
  if (!data.c) {
    el.innerHTML = `<div class="rx">${rxAlert(`<strong>No valuation:</strong> ${escHtml(data.error || 'no data')}.`)}</div>`;
    return;
  }
  // The strip of all three exchanges' targets: the others load from the shared cache
  let others = null;
  const fillStrip = () => {
    const strip = el.querySelector('[data-val-strip]');
    if (!strip) return;
    const list = VALUATION_EXCHANGES.map(e => e === ex ? data : (others && others.find(o => o.ex === e)) || { ex: e, c: null, error: 'loading…' });
    strip.innerHTML = valuationTargetTiles(list, defaults, readValuationOverrides(), ex);
  };
  // Inputs are edited in the drawer (js/18-valuation-inputs.js): each edit re-renders this
  let shownVersion = null;
  const render = () => {
    shownVersion = VALUATION_SHARED.version;
    const open = !!el.querySelector('details.rx-val-how[open]');
    el.innerHTML = valuationTabHTML(ex, defaults, data.c, analysts, open);
    fillStrip();
  };
  render();
  excelSyncLoad(60 * 1000);   // the Excel sync panel's run log (js/24-excel-sync.js)
  RX_TAB_REFRESH.valuation = render;
  el._valCtx = { ex, defaults, data, onChange: render };
  if (!el._valEditBound) {
    el._valEditBound = true;
    el.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('[data-val-edit]') && el._valCtx) openValuationDrawer(el._valCtx);
      if (e.target.closest && e.target.closest('[data-xs-refresh]')) excelSyncRefresh();
    });
  }
  // The shared inputs, once they answer, if they differ from what was drawn
  shared.then(() => {
    if (seq === VALUATION_BUILD_SEQ && currentExchange === ex && shownVersion !== VALUATION_SHARED.version) render();
  });
  const rest = VALUATION_EXCHANGES.filter(e => e !== ex);
  await ensureFreshMarketData(rest.filter(e => !valuationOnShow(e)));
  const got = await Promise.all(rest.map(valuationExchange));
  if (seq !== VALUATION_BUILD_SEQ || currentExchange !== ex) return;
  others = got;
  fillStrip();
}
