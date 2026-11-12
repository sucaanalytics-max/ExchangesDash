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

// ── Fee basis: today's rates ─────────────────────────────────────────────────
// NSE and BSE revenue is shown at today's statutory fees (CLAUDE.md, "Business
// rules"): {ex}_{dashboard,enriched}_data.json price every day at the current
// fee register, so periods differ by volume alone. The pipelines still write the
// date-effective {ex}_…_data_eff.json pair; the dashboard no longer reads it.
// MCX has no turnover to re-price: always source values.
function hasFeeVariant(ex) { return ex === 'nse' || ex === 'bse'; }

// An exchange's dashboard + enriched files, as settled results ({ status, value }).
async function fetchRevenueFiles(ex) {
  const [raw, enr] = await Promise.allSettled([
    fetchDataFile(`./data/${ex}_dashboard_data.json`),
    fetchDataFile(`./data/${ex}_enriched_data.json`),
  ]);
  return { raw, enr };
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
  return { exchange, raw: raw.json, enr: enr.json, share: share ? share.json : null, sig: [raw.sig, enr.sig, share ? share.sig : ''].join('|'), checkedAt };
}

async function commitExchangeFiles(f) {
  DATA = f.raw;
  // P&L quarters must be chronological for the table, chart and "latest
  // actual quarter" lookups (older pipeline output sorted them by label text).
  if (Array.isArray(DATA.pnl)) DATA.pnl.sort((a, b) => quarterSortKey(a.quarter) - quarterSortKey(b.quarter));
  ENRICHED_DATA = f.enr;
  SHARE_DATA = f.share;
  VIEW_LOADED = { exchange: f.exchange, sig: f.sig, checkedAt: f.checkedAt };
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
function preloadMarketData(exchanges = ['nse', 'bse', 'mcx']) {
  return Promise.all(exchanges.map(ex => {
    const key = ex;
    if (!MARKET_INFLIGHT[key]) {
      MARKET_CHECKED_AT[ex] = Date.now();
      MARKET_INFLIGHT[key] = fetchRevenueFiles(ex).then(({ raw, enr }) => {
        if (enr.status !== 'fulfilled' && raw.status !== 'fulfilled') return null;
        const before = marketSig(ex);
        const sig = MARKET_SIG[ex] || (MARKET_SIG[ex] = {});
        if (enr.status === 'fulfilled') { MARKET_DATA[ex] = enr.value.json; sig.enr = enr.value.sig; }
        if (raw.status === 'fulfilled') { MARKET_RAW[ex]  = raw.value.json; sig.raw = raw.value.sig; }
        return marketSig(ex) !== before ? ex : null;
      }).finally(() => { delete MARKET_INFLIGHT[key]; });
    }
    return MARKET_INFLIGHT[key];
  })).then(changed => changed.filter(Boolean));
}

// Fetches the cached exchanges that are missing, stale or already being fetched.
function ensureFreshMarketData(exchanges) {
  const now = Date.now();
  const due = exchanges.filter(ex => MARKET_INFLIGHT[ex] || !MARKET_RAW[ex] || !MARKET_DATA[ex]
    || !MARKET_CHECKED_AT[ex] || now - MARKET_CHECKED_AT[ex] > DATA_MAX_AGE_MS);
  return due.length ? preloadMarketData(due) : Promise.resolve([]);
}

let freshnessRun = null;

// Runs when a view is shown: refetches whatever the current view uses that is
// older than DATA_MAX_AGE_MS, and rebuilds the view if any of it changed.
function checkDataFreshness() {
  if (isViewKey(currentExchange)) return Promise.resolve();   // broker and MTF views load their own data
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
    const fresh = files && VIEW_LOADED && files.sig !== VIEW_LOADED.sig ? files : null;
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
  if (isViewKey(currentExchange)) { el.hidden = true; el.textContent = ''; return; }
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

// ── Fee-basis labels and the definitions note ─────────────────────────────────────────────────
const FEE_BASIS_SHORT = { today: "at today's rates", source: 'source values' };
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

// What the figures shown for `ex` are priced at: 'today' (NSE/BSE) or 'source' (MCX)
function feeBasisOf(ex) {
  return hasFeeVariant(ex) ? 'today' : 'source';
}

// Short unit label for table headers, e.g. "at today's rates" or "NSE/BSE at today's rates · MCX source values"
function feeUnitLabel() {
  const groups = {};
  viewExchanges().forEach(ex => { (groups[feeBasisOf(ex)] = groups[feeBasisOf(ex)] || []).push(ex.toUpperCase()); });
  const kinds = Object.keys(groups);
  return kinds.length === 1 ? FEE_BASIS_SHORT[kinds[0]]
    : kinds.map(k => `${groups[k].join('/')} ${FEE_BASIS_SHORT[k]}`).join(' · ');
}

// One short note under the Revenue Summary: the fee basis, the method, and
// what the "modelled" marker means.
function buildFeeNote() {
  const el = document.getElementById('feeModeNote');
  if (!el) return;
  const exs = viewExchanges();
  const multi = exs.length > 1;
  const names = list => list.map(e => e.toUpperCase()).join(' and ');
  const parts = [];
  const today = exs.filter(ex => feeBasisOf(ex) === 'today');
  if (today.length) {
    parts.push(`<strong>${multi ? names(today) + ' fees' : 'Fees'} at today's rates:</strong> every trading day is priced at today's statutory transaction fees from the fee register, so periods differ by volume alone.`);
  }
  if (exs.includes('mcx')) {
    parts.push('MCX figures are source values (there is no turnover to re-price), so they are not re-priced at today\'s fees.');
    const mh = rawFor('mcx')?.modelled_history;
    if (mh && mh.days > 0) {
      parts.push(`${flagTags({ modelled: true })} marks MCX history ${fmtLongDate(mh.first_date)} – ${fmtLongDate(mh.last_date)}, which is modelled (scaled to reported quarters, options split derived) and left out of YoY, QoQ, segment-mix and market-share comparisons, shown as —.`);
    }
  }
  // Expiry-day counts (expiryCountHTML in 10-revenue-summary.js)
  if (exs.includes('nse') || exs.includes('bse')) {
    parts.push(`<strong>Expiries</strong> counts the period's expiry days: each exchange's weekly index expiry (NSE Nifty, BSE Sensex) on the weekday then in force, moved to the previous trading day for a holiday; this week's counts once it has traded.${multi ? ' N = NSE, B = BSE; amber marks counts that differ, where the daily averages are not like for like.' : ''} Before 20 Nov 2024 both exchanges also had other weekly index expiries, not counted; BSE counts before the Sensex relaunch (15 May 2023) are notional.`);
  }
  // The live cards beside the segment tabs (buildLiveCards in 10-revenue-summary.js)
  parts.push('<strong>Live cards</strong> show NSE and BSE total revenue booked so far today at today\'s statutory fees, from the live polls (about every 5 min, 09:15–16:00 IST), with the predicted close and the typical-path range as on the Live Predictor tab; outside market hours they show the last session, and its actual close once the evening data is in, also at today\'s fees. The revenue banner at the top shows the same figure, with the time of the poll.');
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
