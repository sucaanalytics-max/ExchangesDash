// dashboard/js/02-banner-glance.js — Latest-revenue banner, phone glance view, rebuildAll.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// LATEST REVENUE BANNER
// ========================

// The banner's last resort is the latest full day at today's rates, the basis
// /api/revenue reports in. The preloaded MARKET_RAW copy serves unless it is
// the _eff variant, whose BSE cash is priced at the calibrated rate instead.
const BANNER_DASH = {};    // exchange → { json, at } at-today's-rates file
async function bannerDashData(ex) {
  if (MARKET_RAW[ex] && !MARKET_EFF[ex]) return MARKET_RAW[ex];
  const c = BANNER_DASH[ex];
  if (c && Date.now() - c.at < DATA_MAX_AGE_MS) return c.json;
  try {
    const json = (await fetchDataFile(`./data/${ex}_dashboard_data.json`)).json;
    BANNER_DASH[ex] = { json, at: Date.now() };
    return json;
  } catch (e) {
    return null;
  }
}

// /api/* responses are cached at Vercel's edge (vercel.json), so their URLs
// carry no cache-busting parameter: one function call serves every viewer.
let BANNER_AT = 0;         // ms of the banner's last refresh
async function updateLatestRevBanner() {
  const el = document.getElementById('latestRevBanner');
  if (!el) return;

  BANNER_AT = Date.now();
  let nse = null, bse = null;

  // 1. Try /api/revenue — fetches directly from NSE & BSE websites on demand
  try {
    const res = await fetch('/api/revenue');
    if (res.ok) {
      const data = await res.json();
      nse = data.nse;
      bse = data.bse;
    }
  } catch(e) { /* fall through */ }

  // 2. Fall back to /api/live (GitHub-hosted live JSON, updated every 5 min by Actions)
  const needNse = !nse || !nse.has_data;
  const needBse = !bse || !bse.has_data;
  if (needNse || needBse) {
    const [nseRes, bseRes] = await Promise.all([
      needNse ? fetch('/api/live?exchange=nse&file=live').catch(() => null) : null,
      needBse ? fetch('/api/live?exchange=bse&file=live').catch(() => null) : null,
    ]);
    if (needNse && nseRes && nseRes.ok) {
      const d = await nseRes.json().catch(() => null);
      if (d && d.revenue) nse = Object.assign({}, d.revenue, { source: d.revenue.source || 'github' });
    }
    if (needBse && bseRes && bseRes.ok) {
      const d = await bseRes.json().catch(() => null);
      if (d && d.revenue) bse = Object.assign({}, d.revenue, { source: d.revenue.source || 'github' });
    }
  }

  // 3. Final fallback — latest completed day from historical dashboard JSON
  const needNse2 = !nse || !nse.has_data;
  const needBse2 = !bse || !bse.has_data;
  if (needNse2 || needBse2) {
    const [nseDash, bseDash] = await Promise.all([
      needNse2 ? bannerDashData('nse') : null,
      needBse2 ? bannerDashData('bse') : null,
    ]);
    function lastFromDash(data) {
      if (!data) return null;
      const daily = data.daily_all || data.daily;
      if (!daily || !daily.length) return null;
      const last = daily[daily.length - 1];
      return { total_revenue: last.total_rev, trade_date: last.date, has_data: true, source: 'historical' };
    }
    if (needNse2) nse = lastFromDash(nseDash);
    if (needBse2) bse = lastFromDash(bseDash);
  }

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const days   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  function formatDate(dateStr) {
    if (!dateStr) return '';
    let d;
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      d = new Date(dateStr.slice(0, 10) + 'T00:00:00');
    } else if (/^\d{2}\/\d{2}\/\d{2}$/.test(dateStr)) {
      const parts = dateStr.split('/');
      d = new Date('20' + parts[2] + '-' + parts[1] + '-' + parts[0] + 'T00:00:00');
    } else { return dateStr; }
    if (isNaN(d.getTime())) return dateStr;
    return days[d.getDay()] + ' ' + d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  // LIVE only for a fresh reading of today's IST session: not the historical
  // fallback, not a value the poller carried forward after a failed fetch, and
  // not yesterday's totals still showing before the open or on a holiday.
  function isoTradeDate(dateStr) {
    if (!dateStr) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
    const m = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(dateStr);
    return m ? '20' + m[3] + '-' + m[2] + '-' + m[1] : null;
  }
  const todayIST = istDateOf();
  function isLiveToday(info) {
    return !!info && info.source !== 'historical' && !info.stale_since
      && isoTradeDate(info.trade_date) === todayIST;
  }

  function chip(label, info) {
    if (!info) return '';
    const isLive  = isLiveToday(info);
    const partial = isLive && !!info.options_pending;
    const liveTag = !isLive ? '' : partial
      ? '<span class="rev-banner-live rev-banner-partial" title="Cash revenue only — BSE has not posted options premium turnover for this session yet">PARTIAL</span>'
      : '<span class="rev-banner-live">LIVE</span>';
    return '<span class="rev-banner-chip">' +
      '<span class="rev-banner-label">' + label + '</span>' +
      liveTag +
      '<span class="rev-banner-value"' + (partial ? ' title="Options premium not yet posted — cash revenue only"' : '') + '>₹ ' + Number(info.total_revenue).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' Cr</span>' +
      '<span class="rev-banner-date">' + formatDate(info.trade_date) + '</span>' +
      '</span>';
  }

  const hasLive = isLiveToday(nse) || isLiveToday(bse);
  const title = hasLive ? "Today's Revenue" : 'Latest Full Day Revenue';
  el.innerHTML = '<span class="rev-banner-title">' + title + '</span>' + chip('NSE', nse) + chip('BSE', bse);
}

// ========================
// GLANCE VIEW (phones)
// ========================
// The default screen at ≤640 px: one card stack per exchange (today's live
// revenue and its age, predicted end of day, last 5 days vs the 5 before,
// quarter to date with QoQ / YoY, a weekday strip, share price against the
// regression fair value), with its own exchange switch and a link to the full
// dashboard. It reads the preloaded MARKET_DATA / MARKET_RAW caches and the
// live files, so it never waits for the full view's tabs to build. A viewer
// who picks "Full view" keeps it on later visits (localStorage).
const GLANCE_STORAGE_KEY = 'exchangesdash.view';
const GLANCE_MEDIA = window.matchMedia ? window.matchMedia('(max-width: 640px)') : { matches: false };
const GLANCE_SHARE = {};   // exchange → { json, at } share file with the live quote applied
let GLANCE_EX = 'nse';
let GLANCE_SEQ = 0;        // drops a render that a newer one has overtaken

function glancePref() {
  try { return localStorage.getItem(GLANCE_STORAGE_KEY); } catch (e) { return null; }
}

function setGlancePref(v) {
  try { localStorage.setItem(GLANCE_STORAGE_KEY, v); } catch (e) { /* storage blocked: not remembered */ }
}

function glanceActive() { return document.body.classList.contains('glance-mode'); }

function enterGlance(remember) {
  if (remember) setGlancePref('glance');
  if (COMBINED_VIEWS[currentExchange] == null) GLANCE_EX = currentExchange;
  document.body.classList.add('glance-mode');
  document.getElementById('glanceView').hidden = false;
  document.getElementById('headerTitle').textContent = 'At a glance';
  updateHeaderExchange(GLANCE_EX);
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.glance === '1'));
  document.getElementById('sidebar').classList.remove('open');
  renderGlance();
}

// Leaves the glance for the full dashboard; with `remember`, later visits open
// on the full view too. A tab chosen from the menu leaves it without that.
async function exitGlance(remember) {
  if (!glanceActive()) return;
  if (remember) setGlancePref('full');
  document.body.classList.remove('glance-mode');
  document.getElementById('glanceView').hidden = true;
  if (GLANCE_EX !== currentExchange) {
    document.querySelectorAll('.exchange-btn').forEach(b => b.classList.toggle('active', b.dataset.exchange === GLANCE_EX));
    await switchExchange(GLANCE_EX);
  } else {
    updateHeaderExchange(currentExchange);
    const active = document.querySelector('.nav-item.active[data-tab]') || document.querySelector('.nav-item[data-tab]');
    if (active) active.click();
  }
}

async function glanceShare(ex) {
  const c = GLANCE_SHARE[ex];
  if (c && Date.now() - c.at < DATA_MAX_AGE_MS) return c.json;
  try {
    const json = (await fetchDataFile(`./data/${ex}_share_analysis.json`)).json;
    await applyLiveStockPrice(json, ex);
    GLANCE_SHARE[ex] = { json, at: Date.now() };
    return json;
  } catch (e) {
    return null;
  }
}

async function glanceLiveFiles(ex) {
  if (ex !== 'nse' && ex !== 'bse') return { live: null, hourly: null };
  const hourly = async () => {
    for (const url of [`/api/live?exchange=${ex}&file=hourly`, `./data/${ex}_live_hourly.json`]) {
      try {
        const res = await fetch(url);
        if (res.ok) return await res.json();
      } catch (e) { /* next source */ }
    }
    return null;
  };
  const [live, hr] = await Promise.all([fetchLiveFile(ex), hourly()]);
  return { live, hourly: hr };
}

function glanceAge(ts) {
  const mins = Math.round((Date.now() - parseUtcTs(ts).getTime()) / 60000);
  if (!isFinite(mins) || mins < 0) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return h < 24 ? `${h} h ${mins % 60} min ago` : `${Math.floor(h / 24)} d ago`;
}

function glanceBadge(v, na) {
  if (na || v == null || isNaN(v)) return '<span class="glance-chg glance-chg--na">—</span>';
  const cls = v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : 'flat';
  return `<span class="glance-chg glance-chg--${cls}">${(v > 0.0001 ? '+' : '') + (v * 100).toFixed(1)}%</span>`;
}

function glanceCard(title, body, extraClass = '') {
  return `<section class="glance-card${extraClass}"><h2 class="glance-card-title">${title}</h2>${body}</section>`;
}

// Today: the live reading when it is a fresh sample of today's IST session,
// else the latest full day from the daily file.
function glanceTodayCard(ex, live, hourly, raw) {
  const rev = live && live.revenue;
  const todayIST = istDateOf();
  const tradeDate = rev && (normalizeTradeDateJS(rev.trade_date));
  const isLive = !!rev && rev.has_data && !rev.stale_since && tradeDate === todayIST;
  const daily = (raw && raw.daily_all) || [];
  const last = daily[daily.length - 1];
  if (!isLive) {
    if (!last) return '';
    return glanceCard('Latest full day', `
      <div class="glance-big">₹${fmtNum(last.total_rev, 1)}<span class="glance-unit"> Cr</span></div>
      <div class="glance-sub">${fmtTradeDate(last.date, true)} · end-of-day file${ex === 'mcx' ? '' : ' · market closed or not yet open'}</div>`);
  }
  const hhmm = parseUtcTs(live.updated_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
  const samples = hourly && hourly.date === todayIST ? (hourly.samples || []) : [];
  const lastS = samples[samples.length - 1];
  const pred = lastS && lastS.predicted_eod;
  const method = lastS && lastS.pred_method ? (lastS.pred_method.startsWith('historical') ? 'from past sessions\' intraday curves' : 'straight-line') : '';
  const partial = rev.options_pending ? '<div class="glance-note">Partial: BSE has not posted options premium yet — cash only.</div>' : '';
  return glanceCard(`Today <span class="glance-live">LIVE</span>`, `
      <div class="glance-big">₹${fmtNum(rev.total_revenue, 1)}<span class="glance-unit"> Cr</span></div>
      <div class="glance-sub">as of ${hhmm} IST · ${glanceAge(live.updated_at)}</div>
      ${partial}
      <div class="glance-row"><span>Predicted end of day</span><strong>${pred != null ? '₹' + fmtNum(pred, 1) + ' Cr' : '—'}</strong></div>
      ${pred != null ? `<div class="glance-sub">${method}</div>` : ''}`);
}

// '16-Oct-2026 14:30' / '16/10/26' / '2026-10-16' → '2026-10-16'
function normalizeTradeDateJS(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  let m = /^(\d{2})\/(\d{2})\/(\d{2,4})/.exec(s);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2] + '-' + m[1];
  m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(s);
  if (m) {
    const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase()) + 1;
    return mon ? `${m[3]}-${String(mon).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  }
  return null;
}

function glanceShareCard(ex, share) {
  if (!share || !share.latest) return '';
  const lat = share.latest;
  const priceSub = lat.is_live
    ? `live ${parseUtcTs(lat.live_updated_at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST`
    : `close ${fmtTradeDate(lat.date)}`;
  let fv;
  if (share.status === 'collecting') {
    fv = `<div class="glance-sub">Regression fair value after ${share.min_days_required} trading days (${share.n_days} so far)</div>`;
  } else if (lat.price_pred == null) {
    const why = share.methodology && share.methodology.gate_reasons && share.methodology.gate_reasons[0];
    fv = `<div class="glance-row"><span>Fair value</span><strong>withheld</strong></div>${why ? `<div class="glance-sub">${why}</div>` : ''}`;
  } else {
    const up = lat.price_pred / lat.price_actual - 1;
    const h = share.methodology && share.methodology.holdout;
    fv = `<div class="glance-row"><span>Regression fair value</span><strong>₹${fmtNum(lat.price_pred, 0)}</strong></div>
      <div class="glance-row"><span>Upside</span>${glanceBadge(up)}</div>
      ${h && !h.beats_naive ? '<div class="glance-note">Out of sample this model has not beaten “price unchanged”.</div>' : ''}`;
  }
  return glanceCard(`Share price · ${share.ticker}`, `
    <div class="glance-big">₹${fmtNum(lat.price_actual, 0)}</div>
    <div class="glance-sub">${priceSub}${lat.is_live && lat.live_pct_change != null ? ' · ' + (lat.live_pct_change >= 0 ? '+' : '') + Number(lat.live_pct_change).toFixed(2) + '% today' : ''}</div>
    ${fv}`);
}

async function renderGlance() {
  const el = document.getElementById('glanceView');
  if (!el || !glanceActive()) return;
  const seq = ++GLANCE_SEQ;
  const ex = GLANCE_EX;
  const switcher = `
    <div class="glance-top">
      <div class="glance-switch" role="group" aria-label="Exchange">
        ${['nse', 'bse', 'mcx'].map(e => `<button type="button" class="glance-ex${e === ex ? ' active' : ''}" data-glance-ex="${e}" aria-pressed="${e === ex}">${e.toUpperCase()}</button>`).join('')}
      </div>
      <button type="button" class="glance-full" data-glance-full>Full view →</button>
    </div>`;
  if (!MARKET_DATA[ex] || !MARKET_RAW[ex]) el.innerHTML = switcher + '<div class="glance-loading">Loading…</div>';
  attachGlanceHandlers(el);

  await preloadMarketData([ex]);
  const [share, lf] = await Promise.all([glanceShare(ex), glanceLiveFiles(ex)]);
  if (seq !== GLANCE_SEQ || !glanceActive()) return;
  const enr = MARKET_DATA[ex], raw = MARKET_RAW[ex];
  if (!enr || !raw) {
    el.innerHTML = switcher + '<div class="glance-card glance-card--error">Could not load this exchange\'s data. <button type="button" class="glance-retry" data-glance-retry>Retry</button></div>';
    attachGlanceHandlers(el);
    return;
  }

  const F = reportFlagsFor(raw);
  const tg = f => reportTags(f, false);
  const s = enr.summary_total || {};
  const l5 = s.weekly?.last5 || {}, p5 = s.weekly?.prev5 || {};
  const qc = s.quarterly?.current || {}, qp = s.quarterly?.previous || {}, q2 = s.quarterly?.prev2 || {};
  const qRow = (raw.quarterly || []).find(q => q.quarter === qc.label);
  const f5 = F.tail(-5, undefined, 'total'), fp5 = F.tail(-10, -5, 'total');
  const fqc = F.q(qc.label, 'total'), fqp = F.q(qp.label, 'total'), fq2 = F.q(q2.label, 'total');

  const weekCard = glanceCard('Last 5 trading days', `
    <div class="glance-big">₹${fmtNum(l5.value, 1)}<span class="glance-unit"> Cr/day</span>${tg(f5)}</div>
    <div class="glance-row"><span>Previous 5 days</span><strong>₹${fmtNum(p5.value, 1)}${tg(fp5)}</strong></div>
    <div class="glance-row"><span>Change</span>${glanceBadge(l5.wow, anyModelled(f5, fp5))}</div>`);

  const qtdCard = glanceCard(`Quarter to date · ${qc.label || '—'}`, `
    <div class="glance-big">₹${fmtNum(qc.value, 1)}<span class="glance-unit"> Cr/day</span>${tg(fqc)}</div>
    <div class="glance-sub">${qRow ? (qRow.days || qRow.trading_days) + ' trading days' : ''}</div>
    <div class="glance-row"><span>vs ${qp.label || 'previous quarter'} (QoQ)</span>${glanceBadge(qc.qoq, anyModelled(fqc, fqp))}</div>
    <div class="glance-row"><span>vs ${q2.label || 'a year earlier'} (YoY)</span>${glanceBadge(qc.yoy, anyModelled(fqc, fq2))}</div>`);

  const dow = s.day_of_week || {};
  const strip = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(d => {
    const v = dow[d] || {};
    const f3 = F.weekday(d, 3, 'total');
    return `<div class="glance-dow-cell"><div class="glance-dow-day">${d.slice(0, 3)}</div>
      <div class="glance-dow-val">${fmtNum(v.latest, 1)}</div>${glanceBadge(v.do3d, anyModelled(f3))}</div>`;
  }).join('');
  const dowCard = glanceCard('Day of week · latest ₹ Cr, vs last 3', `<div class="glance-dow">${strip}</div>`);

  const feeLine = hasFeeVariant(ex)
    ? (MARKET_EFF[ex] ? 'Fees as charged (rates in force each day).' : 'Fees at today\'s rates.')
    : 'MCX: source values.';

  el.innerHTML = switcher
    + glanceTodayCard(ex, lf.live, lf.hourly, raw)
    + weekCard + qtdCard + dowCard
    + glanceShareCard(ex, share)
    + `<p class="glance-foot">${feeLine} Data to ${fmtTradeDate((raw.daily_all || []).slice(-1)[0]?.date, true)}. <button type="button" class="glance-link" data-glance-full>Open the full dashboard</button></p>`;
  attachGlanceHandlers(el);
}

function attachGlanceHandlers(el) {
  el.querySelectorAll('[data-glance-ex]').forEach(b => b.addEventListener('click', () => {
    GLANCE_EX = b.dataset.glanceEx;
    updateHeaderExchange(GLANCE_EX);
    renderGlance();
  }));
  el.querySelectorAll('[data-glance-full]').forEach(b => b.addEventListener('click', () => exitGlance(true)));
  el.querySelectorAll('[data-glance-retry]').forEach(b => b.addEventListener('click', () => renderGlance()));
}

// ========================
// REBUILD ALL
// ========================

function rebuildAll() {
  applyChartDefaults();
  RX_TAB_REFRESH = {};

  // Combined views read every exchange's rows through DATA.components
  VIEW_SOURCES = {};
  if (DATA.components) {
    const sources = DATA.components.map(c => ({ ex: c.exchange, date: lastTradeDate(c.daily_all) }));
    (EXCHANGE_TABS[currentExchange] || []).forEach(t => { VIEW_SOURCES[t.id] = sources; });
  }
  const common = [updateSnapshotNotice, updateFeeNotice, updateFeeToggle, buildFeeNote, buildRevenueSummary, buildLiveCards];
  const byExchange = {
    nsebse: [() => buildMarketSharePanel(['nse', 'bse']), buildMarketShareTrend],
    all:    [() => buildMarketSharePanel(['nse', 'bse', 'mcx'])],
    nse:    [() => buildRevenuePredictor('nse'), () => buildValuation('nse'), () => buildShareAnalysis('nse'),
             () => buildLivePredictor('nse')],
    bse:    [() => buildRevenuePredictor('bse'), () => buildShareAnalysis('bse'), () => buildValuation('bse'),
             () => buildLivePredictor('bse')],
    mcx:    [() => buildRevenuePredictor('mcx'), () => buildShareAnalysis('mcx'), () => buildValuation('mcx')],
  };
  runSections(common.concat(byExchange[currentExchange] || []));
}

// Runs each section builder on its own: one that throws (an unexpected gap in
// a data file) leaves that section empty and is logged, instead of stopping
// every section after it and leaving the loading overlay up.
function runSections(builders) {
  builders.forEach(build => {
    try {
      build();
    } catch (err) {
      console.error(`Section ${build.name || 'builder'} failed:`, err);
    }
  });
}
