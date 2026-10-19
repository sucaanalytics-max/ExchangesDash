// dashboard/js/01-data.js — Data loading: data files, fee mode, market caches, header info.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// DATA LOADING
// ========================

// Overrides SHARE_DATA.latest.price_actual with an intraday quote from the
// live poller ({exchange}_live.json), when it is for a newer day than the
// daily batch's latest close — otherwise the batch close stands.
// Poller timestamps are UTC; older files omit the "Z", which JS would
// otherwise read as the viewer's local time.
function parseUtcTs(ts) {
  if (typeof ts === 'string' && !/(Z|[+-]\d{2}:?\d{2})$/i.test(ts)) ts += 'Z';
  return new Date(ts);
}

function istDateOf(ts) {
  const d = ts ? parseUtcTs(ts) : new Date();
  return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// "2026-10-16" → "16 Oct", or "Fri 16 Oct" with weekday. Reads the trade date
// as a calendar date, independent of the viewer's time zone.
function fmtTradeDate(iso, withWeekday) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const day = d.getUTCDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return withWeekday ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()] + ' ' + day : day;
}

async function fetchLiveFile(exchange) {
  const bust = Date.now();
  for (const url of [`/api/live?exchange=${exchange}&file=live`, `./data/${exchange}_live.json?t=${bust}`]) {
    try {
      // The live reading is an extra on each view: a slow source must not hold it up
      const live = await fetchWithTimeout(url, 8000, res => (res.ok ? res.json().catch(() => null) : null));
      if (live) return live;
    } catch (e) { /* try the next source */ }
  }
  return null;
}

async function applyLiveStockPrice(shareData, exchange) {
  try {
    const live = await fetchLiveFile(exchange);
    const sp = live?.stock_price;
    if (!sp || sp.last_price == null || !shareData.latest) return;

    const liveDate = istDateOf(live.updated_at);
    if (!liveDate || liveDate <= shareData.latest.date) return;  // batch already has that day's close
    const istHHMM = parseUtcTs(live.updated_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    if (istHHMM < '09:15') return;  // pre-open poll: the quote is still the previous close

    shareData.latest.price_prev_close = shareData.latest.price_actual;
    shareData.latest.price_actual = sp.last_price;
    shareData.latest.is_live = true;
    shareData.latest.live_date = liveDate;
    shareData.latest.live_updated_at = live.updated_at;
    shareData.latest.live_pct_change = sp.pct_change;
    if (shareData.latest.price_pred != null && sp.last_price) {
      shareData.latest.error_pct = Math.round(
        Math.abs(shareData.latest.price_pred - sp.last_price) / sp.last_price * 1000
      ) / 10;
    }
    // `series` is deliberately left as daily closes: it feeds the moving
    // averages and the regression fit, and an intraday quote is neither.
  } catch (e) {
    // Live price is a nice-to-have — silently fall back to the batch close on any failure
  }
}

// ── Data freshness ───────────────────────────────────────────────────────────
// Bots commit each exchange's JSON separately, so one session can otherwise
// hold snapshots of different ages. Whenever a view is shown, any dataset it
// uses that was fetched more than DATA_MAX_AGE_MS ago is fetched again, and the
// view is rebuilt only if the content actually changed. One check runs at a
// time and each dataset is re-fetched at most once per window, so rapid tab
// switching cannot cause a refetch storm.
const DATA_MAX_AGE_MS = 10 * 60 * 1000;
const COMBINED_VIEWS = { all: ['nse', 'bse', 'mcx'], nsebse: ['nse', 'bse'] };
const MARKET_SIG = {};         // exchange → { enr, raw } fingerprints of the cached files
const MARKET_CHECKED_AT = {};  // exchange → ms of the last fetch into MARKET_DATA/MARKET_RAW
const MARKET_INFLIGHT = {};    // exchange → that fetch while it runs, shared by callers
let VIEW_LOADED = null;        // { exchange, sig, checkedAt } of the single-exchange DATA
let VIEW_BUILT_FROM = {};      // cached exchange → fingerprint the current view was built from

// Cheap content fingerprint (length + FNV-1a), so a refetch can tell whether a file changed.
function textSignature(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return text.length + ':' + (h >>> 0).toString(16);
}

// Concurrent requests for one file share a download (init fetches the NSE
// files for both the view and the cache); each caller parses its own copy.
const TEXT_INFLIGHT = {};
// A stalled request fails after this long rather than keeping the overlay up
const FETCH_TIMEOUT_MS = 45 * 1000;

// fetch() that rejects once `ms` pass without the body arriving
function fetchWithTimeout(url, ms, read) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), ms);
  return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
    .then(read)
    .finally(() => clearTimeout(timer));
}

function fetchText(url) {
  if (!TEXT_INFLIGHT[url]) {
    TEXT_INFLIGHT[url] = fetchWithTimeout(url, FETCH_TIMEOUT_MS, res => {
      if (!res.ok) {
        const err = new Error(`${url}: HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res.text();
    }).finally(() => { delete TEXT_INFLIGHT[url]; });
  }
  return TEXT_INFLIGHT[url];
}

async function fetchDataFile(url) {
  const text = await fetchText(url);
  return { json: JSON.parse(text), sig: textSignature(text) };
}

function marketSig(ex) {
  const s = MARKET_SIG[ex];
  return s ? `${s.enr || ''}|${s.raw || ''}` : '';
}

// ── Fee basis: as charged (date-effective) or at today's rates ───────────────
// NSE and BSE revenue comes in two variants (CLAUDE.md, "Business rules"):
// {ex}_{dashboard,enriched}_data.json prices every day at today's statutory
// fees; {ex}_…_data_eff.json prices each day at the fees in force that day
// (scripts/fee_register.py) and tags each row and period with fee_basis.
// "As charged" (the default) loads the _eff pair; until the pipeline has
// written it (404, or no fee_mode) the view falls back to today's rates and a
// notice says so. MCX has no turnover to re-price: always source values.
const FEE_MODE_STORAGE_KEY = 'feeMode_v1';
let FEE_MODE = loadFeeMode();   // 'charged' | 'today'
let feeModeSeq = 0;             // latest toggle; an older reload still in flight yields to it
const MARKET_MODE = {};         // exchange → fee mode its MARKET_DATA/MARKET_RAW were fetched in
const MARKET_EFF = {};          // exchange → true when those cached files are the _eff variant
const EFF_MISSING_AT = {};      // exchange → ms when its _eff pair was last found missing

function loadFeeMode() {
  try { return localStorage.getItem(FEE_MODE_STORAGE_KEY) === 'today' ? 'today' : 'charged'; } catch (e) { return 'charged'; }
}

function saveFeeMode(mode) {
  try { localStorage.setItem(FEE_MODE_STORAGE_KEY, mode); } catch (e) { /* storage blocked: not remembered */ }
}

function hasFeeVariant(ex) { return ex === 'nse' || ex === 'bse'; }

// The variant an exchange's files are fetched in: NSE/BSE follow the toggle, MCX never changes
function feeModeFor(ex) { return hasFeeVariant(ex) ? FEE_MODE : 'source'; }

// An exchange's dashboard + enriched files in the current fee mode, as settled
// results ({ status, value }), plus whether they are the date-effective pair.
// Both files come from the same variant: a half-generated _eff pair is not used.
// A missing pair is probed again at most once per DATA_MAX_AGE_MS.
async function fetchRevenueFiles(ex) {
  const mode = feeModeFor(ex);
  const pair = suffix => Promise.allSettled([
    fetchDataFile(`./data/${ex}_dashboard_data${suffix}.json`),
    fetchDataFile(`./data/${ex}_enriched_data${suffix}.json`),
  ]);
  if (mode === 'charged' && !(Date.now() - (EFF_MISSING_AT[ex] || 0) < DATA_MAX_AGE_MS)) {
    const [raw, enr] = await pair('_eff');
    const dateEffective = r => r.status === 'fulfilled' && r.value.json && r.value.json.fee_mode === 'date_effective';
    if (dateEffective(raw) && dateEffective(enr)) {
      delete EFF_MISSING_AT[ex];
      return { raw, enr, eff: true, mode };
    }
    EFF_MISSING_AT[ex] = Date.now();
  }
  const [raw, enr] = await pair('');
  return { raw, enr, eff: false, mode };
}

// Fetches one exchange's dashboard, enriched and share-analysis files without
// touching global state, so a freshness check can compare before committing.
async function fetchExchangeFiles(exchange) {
  const hasShareFeed = exchange === 'nse' || exchange === 'bse' || exchange === 'mcx';
  const checkedAt = Date.now();
  const [rev, share] = await Promise.all([
    fetchRevenueFiles(exchange),
    hasShareFeed ? fetchDataFile(`./data/${exchange}_share_analysis.json`).catch(() => null) : null,
  ]);
  if (rev.raw.status !== 'fulfilled') throw rev.raw.reason;
  if (rev.enr.status !== 'fulfilled') throw rev.enr.reason;
  const raw = rev.raw.value, enr = rev.enr.value;
  return { exchange, raw: raw.json, enr: enr.json, share: share ? share.json : null, sig: [raw.sig, enr.sig, share ? share.sig : ''].join('|'), checkedAt, mode: rev.mode, eff: rev.eff };
}

async function commitExchangeFiles(f) {
  DATA = f.raw;
  // P&L quarters must be chronological for the table, chart and "latest
  // actual quarter" lookups (older pipeline output sorted them by label text).
  if (Array.isArray(DATA.pnl)) DATA.pnl.sort((a, b) => quarterSortKey(a.quarter) - quarterSortKey(b.quarter));
  ENRICHED_DATA = f.enr;
  SHARE_DATA = f.share;
  VIEW_LOADED = { exchange: f.exchange, sig: f.sig, checkedAt: f.checkedAt, mode: f.mode, eff: f.eff };
  if (SHARE_DATA) {
    await applyLiveStockPrice(SHARE_DATA, f.exchange);
  }
}

// Fills DATA / ENRICHED_DATA / SHARE_DATA for an exchange. With `owns`, a load
// overtaken by a newer one while fetching leaves them alone and resolves to
// false. Rejects if the exchange's revenue files cannot be loaded.
async function loadExchangeData(exchange, owns = () => true) {
  const combined = COMBINED_VIEWS[exchange];
  if (combined) {
    await ensureFreshMarketData(combined);
    if (!owns()) return false;
    // preloadMarketData drops a failed fetch silently; the views need every exchange
    const missing = combined.filter(ex => !MARKET_RAW[ex] || !MARKET_DATA[ex]);
    if (missing.length) throw new Error(`no data for ${missing.join(', ')}`);
    VIEW_BUILT_FROM = {};
    DATA = buildCombinedRawData(combined);
    ENRICHED_DATA = buildCombinedEnrichedData(combined);
    SHARE_DATA = null;
    VIEW_LOADED = null;
    combined.forEach(ex => { VIEW_BUILT_FROM[ex] = marketSig(ex); });
    return true;
  }
  const files = await fetchExchangeFiles(exchange);
  if (!owns()) return false;
  VIEW_BUILT_FROM = {};
  await commitExchangeFiles(files);
  return owns();
}

// Fills MARKET_DATA / MARKET_RAW (the cache the combined views and the BSE
// valuation read) for the given exchanges. Resolves to the exchanges whose
// content changed. Concurrent callers share one fetch per exchange.
// The cache holds NSE/BSE in one fee mode at a time: a fetch is keyed by
// exchange and mode, and one that finishes after the mode has changed is dropped.
function preloadMarketData(exchanges = ['nse', 'bse', 'mcx']) {
  return Promise.all(exchanges.map(ex => {
    const mode = feeModeFor(ex);
    const key = ex + '|' + mode;
    if (!MARKET_INFLIGHT[key]) {
      MARKET_CHECKED_AT[ex] = Date.now();
      MARKET_INFLIGHT[key] = fetchRevenueFiles(ex).then(({ raw, enr, eff }) => {
        if (mode !== feeModeFor(ex)) return null;  // toggled meanwhile; that mode's fetch fills the cache
        if (enr.status !== 'fulfilled' && raw.status !== 'fulfilled') return null;
        const modeChanged = MARKET_MODE[ex] !== mode;
        if (modeChanged) {  // never leave one file of the other variant behind
          delete MARKET_DATA[ex];
          delete MARKET_RAW[ex];
          delete MARKET_SIG[ex];
        }
        const before = marketSig(ex);
        const sig = MARKET_SIG[ex] || (MARKET_SIG[ex] = {});
        if (enr.status === 'fulfilled') { MARKET_DATA[ex] = enr.value.json; sig.enr = enr.value.sig; }
        if (raw.status === 'fulfilled') { MARKET_RAW[ex]  = raw.value.json; sig.raw = raw.value.sig; }
        MARKET_MODE[ex] = mode;
        MARKET_EFF[ex] = eff;
        return marketSig(ex) !== before || modeChanged ? ex : null;
      }).finally(() => { delete MARKET_INFLIGHT[key]; });
    }
    return MARKET_INFLIGHT[key];
  })).then(changed => changed.filter(Boolean));
}

// Fetches the cached exchanges that are missing, stale, in the other fee mode
// or already being fetched.
function ensureFreshMarketData(exchanges) {
  const now = Date.now();
  const due = exchanges.filter(ex => MARKET_INFLIGHT[ex + '|' + feeModeFor(ex)] || !MARKET_RAW[ex] || !MARKET_DATA[ex]
    || MARKET_MODE[ex] !== feeModeFor(ex)
    || !MARKET_CHECKED_AT[ex] || now - MARKET_CHECKED_AT[ex] > DATA_MAX_AGE_MS);
  return due.length ? preloadMarketData(due) : Promise.resolve([]);
}

let freshnessRun = null;

// Runs when a view is shown: refetches whatever the current view uses that is
// older than DATA_MAX_AGE_MS, and rebuilds the view if any of it changed.
function checkDataFreshness() {
  if (freshnessRun) return freshnessRun;
  freshnessRun = (async () => {
    const ex = currentExchange;
    const now = Date.now();
    const isStale = t => !t || now - t > DATA_MAX_AGE_MS;
    const cached = Object.keys(VIEW_BUILT_FROM);
    const dueCached = cached.filter(e => isStale(MARKET_CHECKED_AT[e]));
    const viewDue = !!VIEW_LOADED && VIEW_LOADED.exchange === ex && isStale(VIEW_LOADED.checkedAt);
    if (!dueCached.length && !viewDue) return;
    if (viewDue) VIEW_LOADED.checkedAt = now;  // one attempt per window, even if it fails
    const [, files] = await Promise.all([
      dueCached.length ? preloadMarketData(dueCached) : null,
      viewDue ? fetchExchangeFiles(ex).catch(() => null) : null,
    ]);
    if (currentExchange !== ex) return;  // switched meanwhile; that switch loaded its own data
    // A fetch made before a fee-mode toggle is left to the toggle's own reload
    const fresh = files && VIEW_LOADED && files.mode === VIEW_LOADED.mode && files.mode === feeModeFor(ex)
      && files.sig !== VIEW_LOADED.sig ? files : null;
    const cacheMoved = cached.some(e => marketSig(e) !== VIEW_BUILT_FROM[e]);
    if (fresh || cacheMoved) await rebuildCurrentView(fresh);
  })().catch(err => console.warn('Data freshness check failed:', err))
    .finally(() => { freshnessRun = null; });
  return freshnessRun;
}

// Rebuilds the current exchange's views from refreshed data, keeping the open tab.
async function rebuildCurrentView(fresh) {
  const ex = currentExchange;
  const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
  showLoading(ex);
  try {
    if (fresh) await commitExchangeFiles(fresh);
    else if (COMBINED_VIEWS[ex]) await loadExchangeData(ex);
    if (currentExchange !== ex) return;  // an exchange switch took over (and owns the overlay)
    Object.values(charts).forEach(c => { if (c && c.destroy) c.destroy(); });
    Object.keys(charts).forEach(k => delete charts[k]);
    updateHeaderInfo();
    rebuildAll();
  } finally {
    if (currentExchange === ex) hideLoading();
  }
  if (currentExchange !== ex) return;
  const tabBtn = activeTab && document.querySelector(`.nav-item[data-tab="${activeTab}"]`);
  if (tabBtn) tabBtn.click();
}

// ── Mismatched snapshots ──────────────────────────────────────────────────────
// Latest trade date of each exchange behind the views that combine several
// exchanges, keyed by tab id and reset on every rebuild. When they differ, a
// notice under the header says which exchange's data runs through which date.
let VIEW_SOURCES = {};

function lastTradeDate(rows) {
  return rows && rows.length ? rows[rows.length - 1].date : null;
}

function updateSnapshotNotice() {
  const el = document.getElementById('snapshotNotice');
  if (!el) return;
  const tab = document.querySelector('.nav-item.active')?.dataset.tab;
  const src = (VIEW_SOURCES[tab] || []).filter(s => s.date);
  const dates = [...new Set(src.map(s => s.date))].sort();
  if (dates.length < 2) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const order = ['nse', 'bse', 'mcx'];
  const oneYear = new Set(dates.map(d => d.slice(0, 4))).size === 1;
  const parts = dates.map((d, i) => {
    const exs = src.filter(s => s.date === d).map(s => s.ex)
      .sort((a, b) => order.indexOf(a) - order.indexOf(b)).map(e => e.toUpperCase()).join('/');
    return `${exs}${i === 0 ? ' data' : ''} through ${fmtTradeDate(d)}${oneYear ? '' : ' ' + d.slice(0, 4)}`;
  });
  el.innerHTML = `<strong>Data dates differ:</strong> ${parts.join('; ')}. Combined figures mix these snapshots.`;
  el.hidden = false;
}

// ── Fee toggle, fee notice and the fee-basis definitions note ─────────────────
const FEE_BASIS_SHORT = { charged: 'as charged', today: "at today's rates", source: 'source values' };
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2024-10-01" → "1 Oct 2024"
function fmtLongDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${+m[3]} ${MONTHS_SHORT[+m[2] - 1]} ${m[1]}` : (iso || '');
}

function viewExchanges() { return COMBINED_VIEWS[currentExchange] || [currentExchange]; }

// The dashboard file behind `ex` in the current view (single view: DATA; else the cache)
function rawFor(ex) {
  return !DATA.components && VIEW_LOADED && VIEW_LOADED.exchange === ex ? DATA : MARKET_RAW[ex];
}

// What the figures shown for `ex` are priced at: 'charged', 'today' or 'source' (MCX)
function feeBasisOf(ex) {
  if (!hasFeeVariant(ex)) return 'source';
  const eff = !DATA.components && VIEW_LOADED && VIEW_LOADED.exchange === ex ? VIEW_LOADED.eff : MARKET_EFF[ex];
  return eff ? 'charged' : 'today';
}

// Short unit label for table headers, e.g. "as charged" or "NSE/BSE as charged · MCX source values"
function feeUnitLabel() {
  const groups = {};
  viewExchanges().forEach(ex => { (groups[feeBasisOf(ex)] = groups[feeBasisOf(ex)] || []).push(ex.toUpperCase()); });
  const kinds = Object.keys(groups);
  return kinds.length === 1 ? FEE_BASIS_SHORT[kinds[0]]
    : kinds.map(k => `${groups[k].join('/')} ${FEE_BASIS_SHORT[k]}`).join(' · ');
}

// NSE/BSE sources of the current view: [{ ex, eff }]. The BSE valuation also
// reads NSE's rows (market ADR and share).
function viewFeeSources() {
  const tab = document.querySelector('.nav-item.active')?.dataset.tab;
  const list = viewExchanges().filter(hasFeeVariant);
  if (currentExchange === 'bse' && tab === 'valuation' && MARKET_RAW.nse) list.push('nse');
  return list.map(ex => ({ ex, eff: feeBasisOf(ex) === 'charged' }));
}

// "As charged" selected but the date-effective files are not there yet
function updateFeeNotice() {
  const el = document.getElementById('feeNotice');
  if (!el) return;
  const sources = viewFeeSources();
  const missing = FEE_MODE === 'charged' ? sources.filter(s => !s.eff) : [];
  if (!missing.length) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const names = missing.map(s => s.ex.toUpperCase()).join(' and ');
  el.textContent = missing.length === sources.length
    ? 'Date-effective data not generated yet — showing today\'s rates.'
    : `${names} date-effective data not generated yet — ${names} figures use today's rates.`;
  el.hidden = false;
}

// Date spans of an exchange's fee rules with this basis, from its loaded
// fee_rules: e.g. "NSE until 30 Sep 2024", "BSE options 1 Nov 2023 – 30 Sep 2024".
function feeRuleSpans(ex, basis) {
  const raw = rawFor(ex);
  const rules = (raw?.fee_rules || []).filter(r => r.basis === basis);
  if (!rules.length) return [];
  const firstDate = raw.daily_all?.[0]?.date || '';
  const allProducts = new Set((raw.fee_rules || []).map(r => r.product));
  const spans = {};
  rules.forEach(r => {
    const s = spans[r.product] || (spans[r.product] = { from: r.effective_from, to: r.effective_to });
    if (r.effective_from === null || (s.from !== null && r.effective_from < s.from)) s.from = r.effective_from;
    if (r.effective_to === null || (s.to !== null && r.effective_to > s.to)) s.to = r.effective_to;
  });
  const groups = {};
  Object.entries(spans).forEach(([prod, s]) => {
    const when = s.from === null || s.from <= firstDate
      ? (s.to ? `until ${fmtLongDate(s.to)}` : '')
      : (s.to ? `${fmtLongDate(s.from)} – ${fmtLongDate(s.to)}` : `from ${fmtLongDate(s.from)}`);
    (groups[when] = groups[when] || []).push(prod);
  });
  const names = { opt: 'options', fut: 'futures', cash: 'cash' };
  return Object.entries(groups).map(([when, prods]) => {
    const what = prods.length === allProducts.size ? '' : ' ' + prods.map(p => names[p] || p).join(' and ');
    return `${ex.toUpperCase()}${what}${when ? ' ' + when : ''}`;
  });
}

// One short note under the Revenue Summary: which fee basis the figures use,
// the method, and what the "est." / "modelled" markers mean.
function buildFeeNote() {
  const el = document.getElementById('feeModeNote');
  if (!el) return;
  const exs = viewExchanges();
  const multi = exs.length > 1;
  const names = list => list.map(e => e.toUpperCase()).join(' and ');
  const parts = [];
  const charged = exs.filter(ex => feeBasisOf(ex) === 'charged');
  const today = exs.filter(ex => feeBasisOf(ex) === 'today');
  if (charged.length) {
    parts.push(`<strong>${multi ? names(charged) + ' fees' : 'Fees'} as charged:</strong> each trading day is priced at the transaction fees in force that day, from the fee register (exchange circulars${charged.includes('bse') ? '; BSE cash at per-quarter rates calibrated to BSE\'s reported cash transaction income' : ''}).`);
    const slab = charged.flatMap(ex => feeRuleSpans(ex, 'slab_estimate'));
    const prov = charged.flatMap(ex => feeRuleSpans(ex, 'calibrated_provisional'));
    const est = [];
    if (slab.length) est.push(`${flagTags({ slab: true })} marks a slab-era flat estimate of tiered fees (${slab.join('; ')})`);
    if (prov.length) est.push(`${flagTags({ prov: true })} marks a provisional calibrated rate (${prov.join('; ')}), updated when BSE reports the quarter`);
    if (est.length) parts.push(est.join('; ') + '.');
  }
  if (today.length) {
    parts.push(`<strong>${multi ? names(today) + ' fees' : 'Fees'} at today's rates:</strong> every trading day is priced at today's statutory transaction fees from the fee register, so periods differ by volume alone.`);
  }
  if (exs.includes('mcx')) {
    parts.push('MCX figures are source values (there is no turnover to re-price), so the fee setting does not change them.');
    const mh = rawFor('mcx')?.modelled_history;
    if (mh && mh.days > 0) {
      parts.push(`${flagTags({ modelled: true })} marks MCX history ${fmtLongDate(mh.first_date)} – ${fmtLongDate(mh.last_date)}, which is modelled (scaled to reported quarters, options split derived) and left out of YoY, QoQ, segment-mix and market-share comparisons, shown as —.`);
    }
  }
  // Muhurat / DR test sessions (scripts/trading_calendar.py): left out of every
  // average and day count, listed here with their revenue
  const special = exs.flatMap(ex => (rawFor(ex)?.special_sessions || []).map(r => ({ ex, r })));
  if (special.length) {
    const label = { muhurat: 'Muhurat', dr_test: 'DR test' };
    const byDate = {};
    special.forEach(({ ex, r }) => {
      const k = r.date + '|' + r.session;
      (byDate[k] = byDate[k] || []).push(`${multi ? ex.toUpperCase() + ' ' : ''}₹${fmtNum(r.total_rev, 2)} Cr`);
    });
    const items = Object.keys(byDate).sort().map(k => {
      const [d, s] = k.split('|');
      return `${label[s] || s} ${fmtLongDate(d)} (${byDate[k].join(', ')})`;
    });
    parts.push(`<strong>Special sessions</strong> are short sessions left out of averages, day counts and weekday figures: ${items.join('; ')}.`);
  }
  el.innerHTML = parts.join(' ');
  el.hidden = !parts.length;
}

function initFeeToggle() {
  document.querySelectorAll('#feeToggle [data-fee-mode]').forEach(btn => {
    btn.addEventListener('click', () => setFeeMode(btn.dataset.feeMode));
  });
  const compact = document.getElementById('feeCompact');
  if (compact) compact.addEventListener('click', () => setFeeMode(FEE_MODE === 'charged' ? 'today' : 'charged'));
  updateFeeToggle();
}

function updateFeeToggle() {
  const box = document.getElementById('feeToggle');
  if (!box) return;
  box.querySelectorAll('[data-fee-mode]').forEach(btn => {
    const on = btn.dataset.feeMode === FEE_MODE;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const isCharged = FEE_MODE === 'charged';
  const val = document.getElementById('feeCompactVal');
  if (val) val.textContent = isCharged ? 'As chg' : 'Today';
  const compact = document.getElementById('feeCompact');
  const na = currentExchange === 'mcx';
  const naNote = na ? ' MCX revenue is shown as source values; this setting applies to NSE and BSE.' : '';
  if (compact) {
    compact.setAttribute('aria-label', `Fees: ${isCharged ? 'as charged' : "at today's rates"}. Switch to ${isCharged ? "today's rates" : 'as charged'}.`);
    compact.title = `Fees: ${isCharged ? 'as charged (each day at the fees then in force)' : "at today's rates"} — tap to switch.${naNote}`;
  }
  box.classList.toggle('fee-toggle--na', na);
  box.title = na ? naNote.trim() : '';
}

async function setFeeMode(mode) {
  if ((mode !== 'charged' && mode !== 'today') || mode === FEE_MODE) return;
  const prev = FEE_MODE;
  FEE_MODE = mode;
  saveFeeMode(mode);
  updateFeeToggle();
  if (await reloadForFeeMode() === false && FEE_MODE === mode) {
    // The new mode's files could not be loaded: the view still shows the old
    // mode, so the toggle goes back to match it
    FEE_MODE = prev;
    saveFeeMode(prev);
    updateFeeToggle();
  }
}

// Reloads the current view's NSE/BSE files in the new fee mode and rebuilds it,
// keeping the open tab and sub-tab. MCX alone has nothing to reload. A newer
// toggle or an exchange switch made meanwhile takes over. Resolves to false
// if the files could not be loaded (the view is left as it was).
async function reloadForFeeMode() {
  const seq = ++feeModeSeq;
  const ex = currentExchange;
  if (!viewExchanges().some(hasFeeVariant)) return;
  const owns = () => seq === feeModeSeq && currentExchange === ex;
  const activeTab = document.querySelector('.nav-item.active')?.dataset.tab;
  showLoading(ex);
  try {
    let files = null;
    if (COMBINED_VIEWS[ex]) {
      await ensureFreshMarketData(COMBINED_VIEWS[ex]);
      if (owns() && COMBINED_VIEWS[ex].some(e => MARKET_MODE[e] !== feeModeFor(e))) throw new Error('fee-mode files unavailable');
    } else {
      files = await fetchExchangeFiles(ex);
    }
    if (!owns()) return;
    if (files) {
      VIEW_BUILT_FROM = {};  // as loadExchangeData: views reading the cache record it again
      await commitExchangeFiles(files);
    } else {
      await loadExchangeData(ex);  // combined: builds from the cache just filled
    }
    if (!owns()) return;
    Object.values(charts).forEach(c => { if (c && c.destroy) c.destroy(); });
    Object.keys(charts).forEach(k => delete charts[k]);
    updateHeaderInfo();
    rebuildAll();
  } catch (err) {
    console.warn('Fee mode reload failed:', err);
    if (owns()) return false;
  } finally {
    if (owns()) hideLoading();
  }
  if (!owns()) return;
  const tabBtn = activeTab && document.querySelector(`.nav-item[data-tab="${activeTab}"]`);
  if (tabBtn) tabBtn.click();
}

// ── Build combined DATA.quarterly + DATA.monthly by summing across exchanges ─
// Each exchange's revenue is divided by its own trading days before summing,
// so the combined value is a true sum-of-daily-averages regardless of each
// exchange having a different number of trading days in a period.
// days=1 is stored so getMAvg returns the value as-is.
// Longer or differently cut periods (FY, weekday × quarter, 125 days) are not
// averages of these rows: they are summed per exchange from DATA.components.
// "Q2 FY 2027" → chronological sort key. Indian FY: Q1=Apr-Jun, Q2=Jul-Sep,
// Q3=Oct-Dec, Q4=Jan-Mar (of the FY-ending year) — Q1..Q4 within "FY N" already
// climbs in the right order, so year*10+quarter sorts correctly across years too.
function quarterSortKey(label) {
  const m = /^Q(\d)\s+FY\s+(\d+)$/.exec(label);
  return m ? parseInt(m[2], 10) * 10 + parseInt(m[1], 10) : 0;
}

// "FY 2027 August" → chronological sort key. Indian FY starts in April.
const FY_MONTH_ORDER = {
  April: 1, May: 2, June: 3, July: 4, August: 5, September: 6,
  October: 7, November: 8, December: 9, January: 10, February: 11, March: 12,
};
function monthSortKey(label) {
  const m = /^FY\s+(\d+)\s+(\w+)$/.exec(label);
  return m ? parseInt(m[1], 10) * 100 + (FY_MONTH_ORDER[m[2]] || 0) : 0;
}

function buildCombinedRawData(exList) {
  const present = exList.filter(ex => MARKET_RAW[ex]);
  const raws = present.map(ex => MARKET_RAW[ex]);
  if (!raws.length) return { quarterly: [], monthly: [], daily: [], daily_all: [], components: [] };

  const segFields = ['total_rev', 'opt_rev', 'fut_rev', 'cash_rev'];

  // Collect all unique quarter/month keys across all exchanges
  const qKeys = new Set(), mKeys = new Set();
  raws.forEach(raw => {
    (raw.quarterly || []).forEach(q => qKeys.add(q.quarter));
    (raw.monthly   || []).forEach(m => mKeys.add(m.month));
  });

  // For each period: sum (rev / own_days) across exchanges → combined daily avg, days=1
  // NOTE: chronological sort, not the default alphabetical .sort() — "Q4 FY 2026"
  // would otherwise string-sort after "Q1 FY 2027", scrambling the "latest N
  // periods" logic downstream (buildRevenueSummary's defQ0..defQ3).
  const quarterly = [...qKeys].sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).map(key => {
    const out = { quarter: key, days: 1 };
    segFields.forEach(f => {
      out[f] = raws.reduce((sum, raw) => {
        const q = (raw.quarterly || []).find(x => x.quarter === key);
        if (!q) return sum;
        return sum + (q[f] || 0) / (q.days || q.trading_days || 1);
      }, 0);
    });
    return out;
  });

  const monthly = [...mKeys].sort((a, b) => monthSortKey(a) - monthSortKey(b)).map(key => {
    const out = { month: key, trading_days: 1, days: 1 };
    segFields.forEach(f => {
      out[f] = raws.reduce((sum, raw) => {
        const m = (raw.monthly || []).find(x => x.month === key);
        if (!m) return sum;
        return sum + (m[f] || 0) / (m.trading_days || m.days || 1);
      }, 0);
    });
    return out;
  });

  // Each exchange's own rows, for the figures that cannot be read off the
  // summed rows above: FY, weekday × quarter and 125-day averages (see
  // revenueSources), the header's last trading date, and the fee-basis /
  // modelled-history labels (periodFlags), which travel with each exchange.
  const components = present.map(ex => ({
    exchange:  ex,
    quarterly: MARKET_RAW[ex].quarterly || [],
    monthly:   MARKET_RAW[ex].monthly || [],
    daily_all: MARKET_RAW[ex].daily_all || [],
  }));

  return { quarterly, monthly, daily: [], daily_all: [], components };
}

// ── Build combined ENRICHED_DATA from pre-loaded enriched JSONs ───────────────
function buildCombinedEnrichedData(exList) {
  const combineOneSeg = (segKey) => {
    const sts = exList.map(ex => MARKET_DATA[ex]?.[segKey]).filter(Boolean);
    if (!sts.length) return null;
    const sum  = (...vals) => vals.reduce((a, v) => a + (v || 0), 0);
    const chg  = (cur, prev) => prev ? (cur - prev) / prev : null;
    const fyCur  = sum(...sts.map(s => s.fy?.current));
    const fyPrev = sum(...sts.map(s => s.fy?.previous));
    const qCur   = sum(...sts.map(s => s.quarterly?.current?.value));
    const qPrev  = sum(...sts.map(s => s.quarterly?.previous?.value));
    const qPrev2 = sum(...sts.map(s => s.quarterly?.prev2?.value));
    const mCur   = sum(...sts.map(s => s.monthly?.current?.value));
    const mPrev  = sum(...sts.map(s => s.monthly?.previous?.value));
    const mAvg6m = sum(...sts.map(s => s.monthly?.avg_6m?.value));
    const w5     = sum(...sts.map(s => s.weekly?.last5?.value));
    const wp5    = sum(...sts.map(s => s.weekly?.prev5?.value));
    const w20    = sum(...sts.map(s => s.weekly?.last20?.value));
    const w45    = sum(...sts.map(s => s.weekly?.last45?.value));
    const dayFull = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
    const dow = {}, pw = {};
    dayFull.forEach(d => {
      const lat = sum(...sts.map(s => s.day_of_week?.[d]?.latest));
      const a3  = sum(...sts.map(s => s.day_of_week?.[d]?.avg_3d));
      const a10 = sum(...sts.map(s => s.day_of_week?.[d]?.avg_10d));
      const prevQAvgs = sts.map(s => s.day_of_week?.[d]?.prev_q_avg).filter(v => v != null);
      const prevQAvg  = prevQAvgs.length ? sum(...prevQAvgs) : null;
      const curQAvgs = sts.map(s => s.day_of_week?.[d]?.cur_q_avg).filter(v => v != null);
      const curQAvg  = curQAvgs.length ? sum(...curQAvgs) : null;
      const yoyQAvgs = sts.map(s => s.day_of_week?.[d]?.yoy_q_avg).filter(v => v != null);
      const yoyQAvg  = yoyQAvgs.length ? sum(...yoyQAvgs) : null;
      dow[d] = {
        latest: lat, avg_3d: a3, avg_10d: a10, do3d: chg(lat, a3), do10d: chg(lat, a10),
        prev_q_label: sts.map(s => s.day_of_week?.[d]?.prev_q_label).find(Boolean),
        prev_q_avg:   prevQAvg,
        do_prev_q:    prevQAvg ? chg(lat, prevQAvg) : null,
        cur_q_label: sts.map(s => s.day_of_week?.[d]?.cur_q_label).find(Boolean),
        cur_q_avg:   curQAvg,
        yoy_q_label: sts.map(s => s.day_of_week?.[d]?.yoy_q_label).find(Boolean),
        yoy_q_avg:   yoyQAvg,
        qoq: (curQAvg != null && prevQAvg) ? chg(curQAvg, prevQAvg) : null,
        yoy: (curQAvg != null && yoyQAvg) ? chg(curQAvg, yoyQAvg) : null,
      };
      pw[d]  = sum(...sts.map(s => s.previous_week?.[d])) || null;
    });
    const ref = sts[0];
    return {
      fy:        { current: fyCur,  previous: fyPrev,  yoy: chg(fyCur, fyPrev) },
      quarterly: { current: { label: ref.quarterly?.current?.label,  value: qCur,  qoq: chg(qCur, qPrev), yoy: chg(qCur, qPrev2) }, previous: { label: ref.quarterly?.previous?.label, value: qPrev }, prev2: ref.quarterly?.prev2 ? { label: ref.quarterly.prev2.label, value: qPrev2 } : null },
      monthly:   { current: { label: ref.monthly?.current?.label,    value: mCur,  mom: chg(mCur, mPrev), mo6m: chg(mCur, mAvg6m) }, previous: { label: ref.monthly?.previous?.label, value: mPrev }, avg_6m: { label: ref.monthly?.avg_6m?.label, value: mAvg6m } },
      weekly:    { last5: { value: w5, wow: chg(w5, wp5), wo10w: chg(w5, w45) }, prev5: { value: wp5 }, last20: { value: w20 }, last45: { value: w45 } },
      day_of_week:   dow,
      previous_week: pw,
    };
  };
  return {
    summary_total: combineOneSeg('summary_total'),
    seg_options:   combineOneSeg('seg_options'),
    seg_futures:   combineOneSeg('seg_futures'),
    seg_cash:      combineOneSeg('seg_cash'),
  };
}

// ========================
// HEADER INFO UPDATE
// ========================

function updateHeaderInfo() {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const fmtDay = iso => {
    const d = new Date(iso + 'T00:00:00');
    return ('0' + d.getDate()).slice(-2) + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  };
  // Phones hide the year (.lu-year) to leave room in the header
  const fmtDayHTML = iso => fmtDay(iso).replace(/ (\d{4})$/, '<span class="lu-year"> $1</span>');
  const span = document.getElementById('lastUpdatedSpan');
  if (DATA.components) {
    // Combined view: show the earliest of the exchanges' last trading dates,
    // so one exchange lagging behind the others is not hidden.
    const lasts = DATA.components
      .map(c => ({ ex: c.exchange.toUpperCase(), date: c.daily_all.length ? c.daily_all[c.daily_all.length - 1].date : null }))
      .filter(c => c.date);
    if (span && lasts.length) {
      const earliest = lasts.reduce((mn, c) => (c.date < mn ? c.date : mn), lasts[0].date);
      const differ = lasts.some(c => c.date !== earliest);
      span.innerHTML = '<span class="lu-label">Last Updated: </span>' + fmtDayHTML(earliest);
      span.title = (differ ? 'Earliest of the exchanges\' last trading dates — ' : 'Last trading date — ')
        + lasts.map(c => `${c.ex} ${fmtDay(c.date)}`).join(', ');
    }
  } else {
    const dailyAll = DATA.daily_all || DATA.daily;
    if (span && dailyAll && dailyAll.length > 0) {
      span.innerHTML = '<span class="lu-label">Last Updated: </span>' + fmtDayHTML(dailyAll[dailyAll.length - 1].date);
      span.removeAttribute('title');
    }
  }
  const cq = DATA.summary && DATA.summary.current_quarter;
  if (cq) {
    // Header plus every panel title that names the quarter being extrapolated
    document.querySelectorAll('#currentQuarterSpan, .js-current-quarter').forEach(el => { el.textContent = cq; });
  }
}
