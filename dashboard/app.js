// app.js — Unified NSE+BSE Analytics Dashboard
// Data loaded dynamically from ./data/ via fetch()

// ========================
// GLOBAL STATE
// ========================

let DATA = {};
let ENRICHED_DATA = {};
let SHARE_DATA = null;    // BSE Ltd share price analysis
let MARKET_DATA = {};     // Preloaded enriched data for all 3 exchanges
let MARKET_RAW = {};      // Preloaded raw dashboard_data.json for all 3 exchanges
let currentExchange = 'nse';
const charts = {};

// ========================
// UTILITIES
// ========================

function fmt(num, decimals = 1) {
  if (num == null || isNaN(num)) return '—';
  const n = Number(num);
  return '₹ ' + n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + ' Cr';
}

function fmtNum(num, decimals = 1) {
  if (num == null || isNaN(num)) return '—';
  return Number(num).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(num) {
  if (num == null || isNaN(num)) return '—';
  const pct = (Number(num) * 100).toFixed(1);
  return pct + ' %';
}

function fmtPctRaw(num) {
  if (num == null || isNaN(num)) return '—';
  return Number(num).toFixed(1) + ' %';
}

function fmtPctSigned(val) {
  if (val == null || isNaN(val)) return '<span class="neutral">—</span>';
  const abs = Math.abs(Number(val) * 100).toFixed(1);
  const sign = val > 0.001 ? '+' : val < -0.001 ? '−' : '';
  const cls = val > 0.001 ? 'positive' : val < -0.001 ? 'negative' : 'neutral';
  return `<span class="${cls}">${sign}${abs} %</span>`;
}

function deltaClass(val) {
  if (val > 0.001) return 'positive';
  if (val < -0.001) return 'negative';
  return 'neutral';
}

function deltaStr(val) {
  if (val == null || isNaN(val)) return '';
  const abs = Math.abs(val * 100).toFixed(1);
  const arrow = val > 0 ? '▲' : val < 0 ? '▼' : '—';
  return abs + ' % ' + arrow;
}

function fmtPrice(num) {
  if (num == null || isNaN(num)) return '—';
  return '₹ ' + Number(num).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ========================
// CHART COLORS — from CSS tokens
// ========================

function getChartColors() {
  const s = getComputedStyle(document.documentElement);
  return [
    s.getPropertyValue('--chart-1').trim(),
    s.getPropertyValue('--chart-2').trim(),
    s.getPropertyValue('--chart-3').trim(),
    s.getPropertyValue('--chart-4').trim(),
    s.getPropertyValue('--chart-5').trim(),
    s.getPropertyValue('--chart-6').trim(),
  ];
}
const CHART_COLORS = ['#2563EB', '#C0392B', '#16A34A', '#7C3AED', '#D97706', '#0891B2'];
const FONT_FAMILY = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Inter', system-ui, sans-serif";

function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function getGridColor() {
  return getTheme() === 'light' ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)';
}

function getTickColor() {
  return getTheme() === 'light' ? '#6e6e73' : '#86868b';
}

function getTooltipBg() {
  return getTheme() === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(28, 28, 30, 0.95)';
}

function getTooltipText() {
  return getTheme() === 'light' ? '#1d1d1f' : '#f5f5f7';
}

function getDonutBorderColor() {
  return getTheme() === 'light' ? '#f5f5f7' : '#1c1c1e';
}

function getScaleBorderColor() {
  return getTheme() === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)';
}

function getHeatmapRgb() {
  return '0, 113, 227';
}

function applyChartDefaults() {
  Chart.defaults.color = getTickColor();
  Chart.defaults.font.family = FONT_FAMILY;
  Chart.defaults.font.size = 11;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.padding = 14;
  Chart.defaults.plugins.tooltip.backgroundColor = getTooltipBg();
  Chart.defaults.plugins.tooltip.titleColor = getTooltipText();
  Chart.defaults.plugins.tooltip.bodyColor = getTooltipText();
  Chart.defaults.plugins.tooltip.borderColor = getTheme() === 'light' ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleFont = { size: 11, weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { size: 11 };
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.scale.grid = { color: getGridColor() };
  Chart.defaults.scale.border = { color: getScaleBorderColor() };
  Chart.defaults.elements.line.tension = 0.3;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.animation.duration = 700;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
}

applyChartDefaults();

function setCanvasHeight(id, h) {
  const c = document.getElementById(id);
  if (c) c.parentElement.style.height = h + 'px';
}

// ========================
// THEME TOGGLE
// ========================

function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  toggle.addEventListener('click', () => {
    const current = getTheme();
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    updateChartsForTheme();
  });
}

function updateChartsForTheme() {
  applyChartDefaults();
  Object.entries(charts).forEach(([key, chart]) => {
    if (!chart) return;
    if (chart.options && chart.options.scales) {
      Object.values(chart.options.scales).forEach(scale => {
        if (scale.grid) scale.grid.color = getGridColor();
        if (scale.border) scale.border.color = getScaleBorderColor();
        if (scale.ticks) scale.ticks.color = getTickColor();
      });
    }
    if (chart.options && chart.options.plugins && chart.options.plugins.tooltip) {
      chart.options.plugins.tooltip.backgroundColor = getTooltipBg();
      chart.options.plugins.tooltip.titleColor = getTooltipText();
      chart.options.plugins.tooltip.bodyColor = getTooltipText();
      chart.options.plugins.tooltip.borderColor = getTheme() === 'light' ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
    }
    if (key === 'donut' && chart.data && chart.data.datasets[0]) {
      chart.data.datasets[0].borderColor = getDonutBorderColor();
      chart.data.datasets[0].hoverBorderColor = getDonutBorderColor();
    }
    chart.update('none');
  });
  // Rebuild heatmap if NSE
  const hm = document.getElementById('heatmapContainer');
  if (currentExchange === 'nse' && hm && hm.innerHTML) {
    buildHeatmap();
  }
}

// Theme toggle removed — light mode only

// ========================
// LOADING OVERLAY
// ========================

function showLoading(exchange) {
  const overlay = document.getElementById('loadingOverlay');
  document.getElementById('loadingText').textContent = 'Loading ' + exchange.toUpperCase() + ' data...';
  overlay.classList.add('visible');
}

function hideLoading() {
  document.getElementById('loadingOverlay').classList.remove('visible');
}

// ========================
// NAV ICONS (SVG strings)
// ========================

const NAV_ICONS = {
  revenue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>',
  segment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 0 20"/><path d="M2 12h20"/></svg>',
  temporal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  prediction: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  advanced: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>',
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
};

// ========================
// TAB DEFINITIONS PER EXCHANGE
// ========================

const EXCHANGE_TABS = {
  nse: [
    { id: 'revenue',    label: 'Revenue Summary',    icon: 'revenue' },
    { id: 'prediction', label: 'PAT Prediction',      icon: 'prediction' },
    { id: 'intraday',   label: 'Live Predictor',      icon: 'temporal' },
    { id: 'share',      label: 'Regression',          icon: 'share' },
    { id: 'valuation',  label: 'Valuation Model',     icon: 'advanced' },
  ],
  bse: [
    { id: 'revenue',    label: 'Revenue Summary',     icon: 'revenue' },
    { id: 'prediction', label: 'Revenue Predictor',    icon: 'prediction' },
    { id: 'intraday',   label: 'Live Predictor',       icon: 'temporal' },
    { id: 'share',      label: 'Regression',            icon: 'share' },
    { id: 'valuation',  label: 'Valuation Model',       icon: 'advanced' },
  ],
  mcx: [
    { id: 'revenue',    label: 'Revenue Summary',     icon: 'revenue' },
    { id: 'prediction', label: 'Revenue Predictor',    icon: 'prediction' },
    { id: 'share',      label: 'Regression',            icon: 'share' },
    { id: 'valuation',  label: 'Valuation Model',       icon: 'advanced' },
  ],
  all: [
    { id: 'revenue',    label: 'Revenue Summary',     icon: 'revenue' },
  ],
  nsebse: [
    { id: 'revenue',      label: 'Revenue Summary',     icon: 'revenue' },
    { id: 'marketshare',  label: 'Market Share Trend',  icon: 'share' },
  ],
};

const TAB_TITLES = {
  nse: {
    revenue: 'Revenue Summary',
    prediction: 'PAT Prediction Engine',
    intraday: 'Live EOD Predictor',
    share: 'Share Price Analytics',
    valuation: 'NSE Valuation Model',
  },
  bse: {
    revenue: 'Revenue Summary',
    prediction: 'Revenue Predictor',
    intraday: 'Live EOD Predictor',
    share: 'Share Price Analytics',
    valuation: 'BSE Valuation Model',
  },
  mcx: {
    revenue: 'Revenue Summary',
    prediction: 'Revenue Predictor',
    share: 'Share Price Analytics',
    valuation: 'MCX Valuation Model',
  },
  all: {
    revenue: 'Combined Revenue — NSE + BSE + MCX',
  },
  nsebse: {
    revenue: 'NSE + BSE Revenue Summary',
    marketshare: 'NSE vs BSE Market Share Trend',
  },
};

// ========================
// SIDEBAR NAV BUILDER
// ========================

function buildSidebarNav(exchange) {
  const nav = document.getElementById('sidebarNav');
  const tabs = EXCHANGE_TABS[exchange];
  nav.innerHTML = tabs.map((t, i) =>
    `<button class="nav-item${i === 0 ? ' active' : ''}" data-tab="${t.id}" aria-label="${t.label}">
      ${NAV_ICONS[t.icon]}
      ${t.label}
    </button>`
  ).join('');
  attachTabListeners();
}

// ========================
// TAB NAVIGATION
// ========================

function attachTabListeners() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      const tabEl = document.getElementById('tab-' + tab);
      if (tabEl) tabEl.classList.add('active');
      const titles = TAB_TITLES[currentExchange] || {};
      document.getElementById('headerTitle').textContent = titles[tab] || tab;
      // Close mobile nav
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('open');
      // Resize charts after tab switch
      setTimeout(() => {
        Object.values(charts).forEach(c => { if (c && c.resize) c.resize(); });
        // Bar charts built while their tab was still display:none never get
        // correct geometry from Chart.js even after a later .resize() — only
        // a full destroy+recreate once the canvas has real dimensions fixes
        // it (line charts don't have this problem). Re-render on first visit.
        if (tab === 'intraday') INTRADAY_RERENDER[currentExchange]?.();
      }, 50);
    });
  });
}

// Sub-tabs — use event delegation since content is dynamic
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.sub-tab');
  if (!btn) return;
  const st = btn.dataset.subtab;
  if (!st) return;
  const container = btn.closest('.tab-content');
  // Deactivate siblings
  btn.parentElement.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // Find the correct scope for sub-content toggling
  const scope = container;
  if (!scope) return;
  scope.querySelectorAll('.sub-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById('subtab-' + st);
  if (target) target.classList.add('active');
  setTimeout(() => {
    Object.values(charts).forEach(c => { if (c && c.resize) c.resize(); });
  }, 50);
});

// Mobile nav
document.getElementById('mobileNavToggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
});
document.getElementById('sidebarOverlay').addEventListener('click', () => {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
});

// ========================
// EXCHANGE SWITCHER
// ========================

function initExchangeSwitcher() {
  document.querySelectorAll('.exchange-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const exchange = btn.dataset.exchange;
      if (exchange === currentExchange) return;
      document.querySelectorAll('.exchange-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await switchExchange(exchange);
    });
  });
}

async function switchExchange(exchange) {
  showLoading(exchange);
  // Destroy all existing charts
  Object.values(charts).forEach(c => { if (c && c.destroy) c.destroy(); });
  Object.keys(charts).forEach(k => delete charts[k]);
  currentExchange = exchange;
  // Update logo
  const logoLabels = { nse: 'NSE Analytics', bse: 'BSE Analytics', mcx: 'MCX Analytics', all: 'All Exchanges', nsebse: 'NSE+BSE' };
  document.getElementById('logoText').textContent = logoLabels[exchange] || exchange.toUpperCase() + ' Analytics';
  // Update sidebar nav
  buildSidebarNav(exchange);
  // Show/hide exchange-specific content sections
  toggleExchangeContent(exchange);
  // Load data
  await loadExchangeData(exchange);
  // Update header info
  updateHeaderInfo();
  // Build all visualizations
  rebuildAll();
  hideLoading();
  // Activate first tab
  const firstNavItem = document.querySelector('.nav-item[data-tab]');
  if (firstNavItem) firstNavItem.click();
}

function toggleExchangeContent(exchange) {
  const isNSE = exchange === 'nse';
  const isBSE = exchange === 'bse';
  const isMCX = exchange === 'mcx';

  const show = (id, visible) => {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? '' : 'none';
  };

  // NSE-only sections
  show('nseSegmentContent',   isNSE);
  show('nseTemporalContent',  isNSE);
  show('nseAdvancedContent',  isNSE);
  show('nseExecExtras',       isNSE);
  show('nsePredictionContent', isNSE);
  show('nseValuationContent', isNSE);
  show('nseIntradayContent',  isNSE);
  show('nse-share-inner',     isNSE);

  // BSE-only sections
  show('bseSegmentContent',   isBSE);
  show('bseQuarterlyContent', isBSE);
  show('bseMonthlyContent',   isBSE);
  show('bseExecExtras',       isBSE);
  show('bsePredictionContent', isBSE);
  show('bse-share-inner',     isBSE);
  show('bseIntradayContent',  isBSE);

  // MCX-only sections
  show('mcxPredictionContent', isMCX);
  show('mcx-share-inner',      isMCX);
  show('mcxValuationContent',  isMCX);

  // BSE-only (continued)
  show('bseValuationContent',  isBSE);

  // Market share panel — visible for nsebse (NSE+BSE) and all (NSE+BSE+MCX)
  show('marketSharePanel', exchange === 'nsebse' || exchange === 'all');
}

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

async function fetchLiveFile(exchange) {
  const bust = Date.now();
  for (const url of [`/api/live?exchange=${exchange}&file=live`, `./data/${exchange}_live.json?t=${bust}`]) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const live = await res.json().catch(() => null);
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

async function loadExchangeData(exchange) {
  if (exchange === 'all') {
    if (!Object.keys(MARKET_DATA).length) await preloadMarketData();
    DATA = buildCombinedRawData(['nse', 'bse', 'mcx']);
    ENRICHED_DATA = buildCombinedEnrichedData(['nse', 'bse', 'mcx']);
    SHARE_DATA = null;
    return;
  }
  if (exchange === 'nsebse') {
    if (!Object.keys(MARKET_DATA).length) await preloadMarketData();
    DATA = buildCombinedRawData(['nse', 'bse']);
    ENRICHED_DATA = buildCombinedEnrichedData(['nse', 'bse']);
    SHARE_DATA = null;
    return;
  }
  const fetches = [
    fetch(`./data/${exchange}_dashboard_data.json`),
    fetch(`./data/${exchange}_enriched_data.json`),
  ];
  const hasShareFeed = exchange === 'nse' || exchange === 'bse' || exchange === 'mcx';
  if (hasShareFeed) {
    fetches.push(fetch(`./data/${exchange}_share_analysis.json`).catch(() => null));
  }
  const results = await Promise.all(fetches);
  DATA = await results[0].json();
  // P&L quarters must be chronological for the table, chart and "latest
  // actual quarter" lookups (older pipeline output sorted them by label text).
  if (Array.isArray(DATA.pnl)) DATA.pnl.sort((a, b) => quarterSortKey(a.quarter) - quarterSortKey(b.quarter));
  ENRICHED_DATA = await results[1].json();
  if (hasShareFeed && results[2]) {
    SHARE_DATA = await results[2].json().catch(() => null);
  } else {
    SHARE_DATA = null;
  }
  if (SHARE_DATA && hasShareFeed) {
    await applyLiveStockPrice(SHARE_DATA, exchange);
  }
}

async function preloadMarketData() {
  const exchanges = ['nse', 'bse', 'mcx'];
  const [enr, raw] = await Promise.all([
    Promise.allSettled(exchanges.map(ex => fetch(`./data/${ex}_enriched_data.json`).then(r => r.json()))),
    Promise.allSettled(exchanges.map(ex => fetch(`./data/${ex}_dashboard_data.json`).then(r => r.json()))),
  ]);
  exchanges.forEach((ex, i) => {
    if (enr[i].status === 'fulfilled') MARKET_DATA[ex] = enr[i].value;
    if (raw[i].status === 'fulfilled') MARKET_RAW[ex]  = raw[i].value;
  });
}

// ── Build combined DATA.quarterly + DATA.monthly by summing across exchanges ─
// Each exchange's revenue is divided by its own trading days before summing,
// so the combined value is a true sum-of-daily-averages regardless of each
// exchange having a different number of trading days in a period.
// days=1 is stored so computeQuarterMetrics / getMAvg return the value as-is.
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
  const raws = exList.map(ex => MARKET_RAW[ex]).filter(Boolean);
  if (!raws.length) return { quarterly: [], monthly: [], daily: [], daily_all: [] };

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

  return { quarterly, monthly, daily: [], daily_all: []};
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
  const dailyAll = DATA.daily_all || DATA.daily;
  if (dailyAll && dailyAll.length > 0) {
    const lastDate = dailyAll[dailyAll.length - 1].date;
    const d = new Date(lastDate + 'T00:00:00');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const formatted = ('0' + d.getDate()).slice(-2) + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    const span = document.getElementById('lastUpdatedSpan');
    if (span) span.textContent = 'Last Updated: ' + formatted;
  }
  const cq = DATA.summary && DATA.summary.current_quarter;
  if (cq) {
    // Header plus every panel title that names the quarter being extrapolated
    document.querySelectorAll('#currentQuarterSpan, .js-current-quarter').forEach(el => { el.textContent = cq; });
  }
}

// ========================
// LATEST REVENUE BANNER
// ========================

async function updateLatestRevBanner() {
  const el = document.getElementById('latestRevBanner');
  if (!el) return;

  const bust = Date.now();
  let nse = null, bse = null;

  // 1. Try /api/revenue — fetches directly from NSE & BSE websites on demand
  try {
    const res = await fetch('/api/revenue?t=' + bust);
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
      needNse ? fetch('/api/live?exchange=nse&file=live&t=' + bust).catch(() => null) : null,
      needBse ? fetch('/api/live?exchange=bse&file=live&t=' + bust).catch(() => null) : null,
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
      needNse2 ? fetch('./data/nse_dashboard_data.json').then(r => r.json()).catch(() => null) : null,
      needBse2 ? fetch('./data/bse_dashboard_data.json').then(r => r.json()).catch(() => null) : null,
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
// REBUILD ALL
// ========================

function rebuildAll() {
  applyChartDefaults();

  buildRevenueSummary();

  if (currentExchange === 'nsebse') {
    buildMarketSharePanel(['nse', 'bse']);
    buildMarketShareTrend();
    return;
  }

  if (currentExchange === 'all') {
    buildMarketSharePanel(['nse', 'bse', 'mcx']);
    return;
  }

  if (currentExchange === 'nse') {
    buildNSEExtrapolationKPIs();
    buildNSEPredictedPnLTable();
    initNSEPATPredictor();
    initNSEPEValuation();
    initNSEPrediction();
    buildNSEValuation();
    buildNSEShareAnalysis();
    buildIntradayPredictor('nse', 'nseIntradayContent');
  } else if (currentExchange === 'bse') {
    buildBSERevenuePredictor();
    buildBSEShareAnalysis();
    buildBSEValuation();
    buildIntradayPredictor('bse', 'bseIntradayContent');
  } else if (currentExchange === 'mcx') {
    buildMCXRevenuePredictor();
    buildMCXShareAnalysis();
    buildMCXValuation();
  }
}

// ========================
// REVENUE SUMMARY — SHARED
// ========================

function getRevFieldObj(segKey) {
  // Returns field names for quarterly and monthly data
  if (segKey === 'total') return { qField: 'total_rev', mField: 'total_rev', dField: 'total_rev' };
  if (segKey === 'options') return { qField: 'opt_rev', mField: 'opt_rev', dField: 'opt_rev' };
  if (segKey === 'futures') return { qField: 'fut_rev', mField: 'fut_rev', dField: 'fut_rev' };
  if (segKey === 'cash') return { qField: 'cash_rev', mField: 'cash_rev', dField: 'cash_rev' };
  return { qField: 'total_rev', mField: 'total_rev', dField: 'total_rev' };
}

function getYoYQuarter(qLabel) {
  const m = qLabel.match(/^(Q\d) FY (\d{4})$/);
  if (!m) return null;
  return m[1] + ' FY ' + (parseInt(m[2]) - 1);
}

// ── Month-end expiry comparison (NSE & BSE only) ──────────────────────────────
// Derived purely from observed trading dates in DATA.daily_all — no separate
// holiday calendar needed. Expiry = the calendar month's last Tuesday (NSE) /
// Thursday (BSE); if that exact date isn't an actual trading day (holiday),
// walk back one calendar day at a time until landing on one that is.
function computeMonthExpiryDates(dailyAll, exchange) {
  const targetDow = exchange === 'bse' ? 4 : 2; // Thu=4, Tue=2 (Sun=0 .. Sat=6)
  const tradingDates = new Set(dailyAll.map(r => r.date));
  const monthsSet = new Set(dailyAll.map(r => r.date.slice(0, 7)));
  const lastDataDate = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const pad2 = n => String(n).padStart(2, '0');
  const toStr = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

  const results = [];
  monthsSet.forEach(monthKey => {
    const [y, m] = monthKey.split('-').map(Number);
    const lastDayNum = new Date(Date.UTC(y, m, 0)).getUTCDate(); // last calendar day of month m
    const cursor = new Date(Date.UTC(y, m - 1, lastDayNum));
    while (cursor.getUTCDay() !== targetDow) cursor.setUTCDate(cursor.getUTCDate() - 1);

    // Expiry still in the future (e.g. this month's last Tuesday hasn't happened
    // yet): skip it. Otherwise the holiday walk-back below would misread the
    // missing date as a holiday and label an ordinary earlier day as the expiry.
    if (toStr(cursor) > lastDataDate) return;

    let dateStr = toStr(cursor);
    let guard = 10; // holidays cluster at most a few days; bail out rather than loop unbounded
    while (!tradingDates.has(dateStr) && guard-- > 0) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      dateStr = toStr(cursor);
    }
    if (tradingDates.has(dateStr)) results.push({ monthKey, expiryDate: dateStr });
  });
  return results.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
}

// Same idea as computeMonthExpiryDates but scoped to each ISO week instead of
// each calendar month: that week's Tuesday (NSE) / Thursday (BSE), or the
// nearest earlier trading day if that's a holiday — bounded to not walk back
// past that week's own Monday (a holiday-shift never borrows from last week).
function computeWeekExpiryDates(dailyAll, exchange) {
  const targetDow = exchange === 'bse' ? 4 : 2; // Thu=4, Tue=2 (Sun=0 .. Sat=6)
  const tradingDates = new Set(dailyAll.map(r => r.date));
  const pad2 = n => String(n).padStart(2, '0');
  const toStr = d => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const parseUTC = s => new Date(s + 'T00:00:00Z');
  const mondayOf = d => {
    const day = d.getUTCDay();
    const diff = day === 0 ? -6 : 1 - day;
    const m = new Date(d);
    m.setUTCDate(m.getUTCDate() + diff);
    return m;
  };

  const lastDataDate = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const weeksSet = new Set();
  dailyAll.forEach(r => weeksSet.add(toStr(mondayOf(parseUTC(r.date)))));

  const results = [];
  weeksSet.forEach(weekStartStr => {
    const monday = parseUTC(weekStartStr);
    const target = new Date(monday);
    target.setUTCDate(monday.getUTCDate() + (targetDow - 1)); // Monday=1 in this offset scheme
    // Same future-expiry guard as computeMonthExpiryDates: this week's expiry
    // day may not have happened yet.
    if (toStr(target) > lastDataDate) return;
    const cursor = new Date(target);
    let dateStr = toStr(cursor);
    while (!tradingDates.has(dateStr) && cursor.getTime() >= monday.getTime()) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
      dateStr = toStr(cursor);
    }
    if (tradingDates.has(dateStr) && cursor.getTime() >= monday.getTime()) {
      results.push({ weekStart: weekStartStr, expiryDate: dateStr });
    }
  });
  return results.sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

// ── Month-end expiry lookups, by index into DATA.monthly/DATA.quarterly —
// mirrors getMAvg/getQAvg's indexing scheme so the dropdown rows can reuse
// the same mOpts/qOpts option lists and default-selection logic.
function getExpiryDateForMonthLabel(exchange, monthLabel, dailyAll) {
  const rec0 = dailyAll.find(r => r.fy_month === monthLabel);
  if (!rec0) return null;
  const monthKey = rec0.date.slice(0, 7);
  const match = computeMonthExpiryDates(dailyAll, exchange).find(e => e.monthKey === monthKey);
  return match ? match.expiryDate : null;
}

function getExpiryValueForMonthIdx(mIdx, exchange, segKey) {
  const m = DATA.monthly?.[mIdx];
  if (!m) return null;
  const dailyAll = DATA.daily_all || [];
  const expiryDate = getExpiryDateForMonthLabel(exchange, m.month, dailyAll);
  const rec = expiryDate ? dailyAll.find(r => r.date === expiryDate) : null;
  if (!rec) return null;
  const rf = getRevFieldObj(segKey);
  return { label: m.month, value: rec[rf.dField] || 0 };
}

function getExpiryValueForQuarterLabel(quarterLabel, exchange, segKey) {
  if (!quarterLabel) return null;
  const dailyAll = DATA.daily_all || [];
  const rf = getRevFieldObj(segKey);
  const byDate = new Map(dailyAll.map(r => [r.date, r]));
  const vals = computeMonthExpiryDates(dailyAll, exchange)
    .map(e => byDate.get(e.expiryDate))
    .filter(rec => rec && rec.fy_quarter === quarterLabel)
    .map(rec => rec[rf.dField] || 0);
  if (!vals.length) return null;
  return { label: quarterLabel, value: vals.reduce((s, v) => s + v, 0) / vals.length };
}

function getExpiryValueForQuarterIdx(qIdx, exchange, segKey) {
  const q = DATA.quarterly?.[qIdx];
  return q ? getExpiryValueForQuarterLabel(q.quarter, exchange, segKey) : null;
}

function renderExpiryMonthRow(rowNum, mIdx, exchange, segKey) {
  const cur   = getExpiryValueForMonthIdx(mIdx, exchange, segKey);
  const valEl = document.getElementById(`expiryMVal${rowNum}-${segKey}`);
  const chgEl = document.getElementById(`expiryMChg${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) : '—';
  if (chgEl) {
    // True calendar-adjacent previous month, independent of whatever the row above shows.
    const prev = getExpiryValueForMonthIdx(mIdx - 1, exchange, segKey);
    chgEl.innerHTML = (prev && prev.value && cur) ? wireChg((cur.value - prev.value) / prev.value) : '';
  }
}

function renderExpiryQuarterRow(rowNum, qIdx, exchange, segKey) {
  const cur   = getExpiryValueForQuarterIdx(qIdx, exchange, segKey);
  const q     = DATA.quarterly?.[qIdx];
  const valEl = document.getElementById(`expiryQVal${rowNum}-${segKey}`);
  const chgEl = document.getElementById(`expiryQChg${rowNum}-${segKey}`);
  const yoyEl = document.getElementById(`expiryQYoy${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) : '—';
  if (chgEl) {
    const prev = getExpiryValueForQuarterIdx(qIdx - 1, exchange, segKey);
    chgEl.innerHTML = (prev && prev.value && cur) ? wireChg((cur.value - prev.value) / prev.value) : '';
  }
  if (yoyEl) {
    const yoyLabel = q ? getYoYQuarter(q.quarter) : null;
    const yoyRef   = yoyLabel ? getExpiryValueForQuarterLabel(yoyLabel, exchange, segKey) : null;
    yoyEl.innerHTML = (yoyRef && yoyRef.value && cur) ? wireChg((cur.value - yoyRef.value) / yoyRef.value) : '';
  }
}

function syncExpiryM(rowNum, mIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`expiryM${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== mIdx) sel.value = mIdx;
    renderExpiryMonthRow(rowNum, mIdx, currentExchange, sk);
  });
}

function syncExpiryQ(rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`expiryQ${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderExpiryQuarterRow(rowNum, qIdx, currentExchange, sk);
  });
}

function buildExpiryComparisonHTML(exchange, segKey, mOpts, qOpts) {
  const dailyAll = DATA.daily_all || [];
  if (!dailyAll.length) return '';

  const mkSel = (id, opts) => `<select class="xl-row-sel" id="${id}">${opts}</select>`;

  // 8 + 6 independently selectable rows — values/deltas populated after
  // render by wireExpiryDropdowns() (called from buildRevenueSummary), same
  // two-pass approach the FY/Quarter/Month table already uses.
  const monthRowsHTML = Array.from({ length: 8 }, (_, r) => `
    <tr>
      <td>${mkSel(`expiryM${r}-${segKey}`, mOpts)}</td>
      <td class="wire-value" id="expiryMVal${r}-${segKey}"></td>
      <td id="expiryMChg${r}-${segKey}"></td>
    </tr>`).join('');

  const quarterRowsHTML = Array.from({ length: 6 }, (_, r) => `
    <tr>
      <td>${mkSel(`expiryQ${r}-${segKey}`, qOpts)}</td>
      <td class="wire-value" id="expiryQVal${r}-${segKey}"></td>
      <td id="expiryQChg${r}-${segKey}"></td>
      <td id="expiryQYoy${r}-${segKey}"></td>
    </tr>`).join('');

  const expiryWeekday = exchange === 'bse' ? 'Thursday' : 'Tuesday';
  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Month-End Expiry Comparison <span class="xl-seg-unit">last trading day on/before the month's last ${expiryWeekday} · ₹ Cr</span></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:var(--space-3)">
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table">
          <thead><tr><th>Month</th><th>Val (In Cr)</th><th>MoM</th></tr></thead>
          <tbody>${monthRowsHTML}</tbody>
        </table>
      </div>
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table">
          <thead><tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr></thead>
          <tbody>${quarterRowsHTML}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}

// Isolates "is month-end special" from "is this just a normal weekly expiry":
// for each month, averages that month's OTHER weekly-expiry days (excluding
// the month-end one itself) and compares against the month-end figure.
function buildWeeklyVsMonthEndHTML(exchange, segKey) {
  const rf = getRevFieldObj(segKey);
  const dailyAll = DATA.daily_all || [];
  if (!dailyAll.length) return '';
  const byDate = new Map(dailyAll.map(r => [r.date, r]));

  const monthEndByKey = new Map(computeMonthExpiryDates(dailyAll, exchange).map(e => [e.monthKey, e.expiryDate]));

  const weeksByMonth = new Map();
  computeWeekExpiryDates(dailyAll, exchange).forEach(w => {
    const mk = w.expiryDate.slice(0, 7);
    if (!weeksByMonth.has(mk)) weeksByMonth.set(mk, []);
    weeksByMonth.get(mk).push(w.expiryDate);
  });

  const rows = [];
  weeksByMonth.forEach((weekDates, monthKey) => {
    const meDate = monthEndByKey.get(monthKey);
    const meRec  = meDate ? byDate.get(meDate) : null;
    if (!meRec) return;
    const otherVals = weekDates
      .filter(d => d !== meDate)
      .map(d => byDate.get(d))
      .filter(Boolean)
      .map(r => r[rf.dField] || 0);
    if (!otherVals.length) return; // month had no other weekly expiry to compare against
    const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
    const monthEndVal = meRec[rf.dField] || 0;
    const diff = avgWeekly ? (monthEndVal - avgWeekly) / avgWeekly : null;
    rows.push({ monthKey, fy_month: meRec.fy_month, avgWeekly, monthEndVal, diff });
  });
  rows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  if (!rows.length) return '';

  const recent = rows.slice(-12);
  const rowsHTML = recent.map(r => `
    <tr>
      <td>${r.fy_month}</td>
      <td class="wire-value">${wireVal(r.avgWeekly, 2)}</td>
      <td class="wire-value">${wireVal(r.monthEndVal, 2)}</td>
      ${wireDeltaTd(r.diff)}
    </tr>`).join('');

  // Summary rows: avg of each column over the trailing N months, drawn from the
  // full `rows` history (not just the 12 displayed above) so "Last 3/6 Months"
  // stay correct even if the table's own window were ever narrowed.
  const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const summaryHTML = [3, 6, 12].map(n => {
    const window = rows.slice(-n);
    const avgWeekly = avg(window.map(r => r.avgWeekly));
    const avgMonthEnd = avg(window.map(r => r.monthEndVal));
    const diff = avgWeekly ? (avgMonthEnd - avgWeekly) / avgWeekly : null;
    return `
    <tr class="xl-r-cur">
      <td>Last ${n} Months Avg</td>
      <td class="wire-value">${wireVal(avgWeekly, 2)}</td>
      <td class="wire-value">${wireVal(avgMonthEnd, 2)}</td>
      ${wireDeltaTd(diff)}
    </tr>`;
  }).join('');

  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Weekly vs Month-End Expiry <span class="xl-seg-unit">avg of that month's other weekly expiries vs the month-end one · ₹ Cr</span></div>
    <div class="wire-table-scroll" style="margin-top:var(--space-3)">
      <table class="wire-table">
        <thead><tr><th>Month</th><th>Avg Weekly Expiry</th><th>Month-End Expiry</th><th>Difference</th></tr></thead>
        <tbody>${rowsHTML}${summaryHTML}</tbody>
      </table>
    </div>
  </div>`;
}

function computeQuarterMetrics(qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const allQ = DATA.quarterly;
  const sel = allQ[qIdx];
  const days = sel.days || sel.trading_days || 1;
  const selAvg = sel[rf.qField] / days;
  const prev = qIdx > 0 ? allQ[qIdx - 1] : null;
  const prevDays = prev ? (prev.days || prev.trading_days || 1) : 1;
  const prevAvg = prev ? prev[rf.qField] / prevDays : null;
  const qoq = prevAvg ? (selAvg - prevAvg) / prevAvg : null;

  const yoyLabel = getYoYQuarter(sel.quarter);
  const yoyQ = yoyLabel ? allQ.find(q => q.quarter === yoyLabel) : null;
  const yoyDays = yoyQ ? (yoyQ.days || yoyQ.trading_days || 1) : 1;
  const yoyAvg = yoyQ ? yoyQ[rf.qField] / yoyDays : null;
  const yoy = yoyAvg ? (selAvg - yoyAvg) / yoyAvg : null;

  return {
    label: sel.quarter,
    value: selAvg,
    prevLabel: prev ? prev.quarter : '—',
    prevValue: prevAvg,
    qoq: qoq,
    yoyLabel: yoyLabel || '—',
    yoyValue: yoyAvg,
    yoy: yoy
  };
}

function computeMonthMetrics(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const allM = DATA.monthly;
  const sel = allM[mIdx];
  const days = sel.trading_days || sel.days || 1;
  const selAvg = sel[rf.mField] / days;
  const prev = mIdx > 0 ? allM[mIdx - 1] : null;
  const prevDays = prev ? (prev.trading_days || prev.days || 1) : 1;
  const prevAvg = prev ? prev[rf.mField] / prevDays : null;
  const mom = prevAvg ? (selAvg - prevAvg) / prevAvg : null;

  // 125 trading days (~6 months at ~21 trading days/month) of actual daily
  // rows ending at the selected month's last trading day — matches the
  // pipeline's avg_6m (see seg_summary in scripts/*_pipeline.py), not an
  // average of 6 calendar-month buckets, so this agrees with the value
  // already rendered from the JSON when the dropdown lands on "now".
  const dailyAll = DATA.daily_all || [];
  const endIdx = dailyAll.reduce((last, r, i) => r.fy_month === sel.month ? i : last, -1);
  const window6m = endIdx >= 0 ? dailyAll.slice(Math.max(0, endIdx - 124), endIdx + 1) : [];
  const avg6m = window6m.length ? window6m.reduce((s, r) => s + (r[rf.dField] || 0), 0) / window6m.length : null;
  const mo6m = avg6m ? (selAvg - avg6m) / avg6m : null;

  return {
    label: sel.month,
    value: selAvg,
    prevLabel: prev ? prev.month : '—',
    prevValue: prevAvg,
    mom: mom,
    avg6mValue: avg6m,
    mo6m: mo6m
  };
}

// ── Excel-style Revenue Summary ──────────────────────────────────────────────

function xlChg(val) {
  if (val == null || isNaN(val)) return '<span class="xl-chg xl-neu">—</span>';
  const abs = Math.abs(val * 100).toFixed(1);
  const sign = val > 0.0005 ? '+' : val < -0.0005 ? '−' : '';
  const cls  = val > 0.0005 ? 'xl-pos' : val < -0.0005 ? 'xl-neg' : 'xl-neu';
  return `<span class="xl-chg ${cls}">${sign}${abs} %</span>`;
}

function xlVal(v) {
  if (v == null || isNaN(v)) return '<span class="xl-num">—</span>';
  return `<span class="xl-num">${fmt(v)}</span>`;
}

// ── Wire-table formatters — exact match to the reference's bare-number style
// (no ₹/Cr, whole-number % deltas, no leading + sign) ─────────────────────────
function wireVal(v, decimals) {
  if (v == null || isNaN(v)) return '—';
  return v.toFixed(decimals);
}

function xlValPlain(v, decimals) {
  if (v == null || isNaN(v)) return '<span class="xl-num">—</span>';
  return `<span class="xl-num">${wireVal(v, decimals)}</span>`;
}

function wireChg(val) {
  if (val == null || isNaN(val)) return '<span class="xl-chg xl-neu">—</span>';
  const pct = Math.round(val * 100);
  const cls = pct > 0 ? 'xl-pos' : pct < 0 ? 'xl-neg' : 'xl-neu';
  return `<span class="xl-chg ${cls}">${pct}%</span>`;
}

function wireDeltaTd(val) {
  if (val == null || isNaN(val)) return '<td></td>';
  const pct = Math.round(val * 100);
  const cls = pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
  return `<td class="wire-delta ${cls}">${pct}%</td>`;
}

// ── Simple avg getters (no derived comparisons) ───────────────────────────────
function getFYAvg(fyStr, segKey) {
  const rf = getRevFieldObj(segKey);
  const quarters = DATA.quarterly.filter(q => q.quarter.endsWith(fyStr));
  if (!quarters.length) return null;
  const rev  = quarters.reduce((s, q) => s + (q[rf.qField] || 0), 0);
  const days = quarters.reduce((s, q) => s + (q.days || q.trading_days || 1), 0);
  return { label: fyStr, value: rev / days };
}

function getQAvg(qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const q  = DATA.quarterly[qIdx];
  if (!q) return null;
  const days = q.days || q.trading_days || 1;
  return { label: q.quarter, value: q[rf.qField] / days };
}

function getMAvg(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const m  = DATA.monthly[mIdx];
  if (!m) return null;
  const days = m.trading_days || m.days || 1;
  return { label: m.month, value: m[rf.mField] / days };
}

function getM6mAvg(mIdx, segKey) {
  const rf   = getRevFieldObj(segKey);
  const allM = DATA.monthly;
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, mIdx - 5); i <= mIdx; i++) {
    const d = allM[i].trading_days || allM[i].days || 1;
    sum += allM[i][rf.mField] / d;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : null;
}

// ── Per-row render functions ──────────────────────────────────────────────────
// % change shown on each comparison row = (row0 - rowN) / rowN
// i.e. "current period is X% vs this row"

function renderFYRow(rowNum, fyStr, segKey) {
  const cur   = getFYAvg(fyStr, segKey);
  const valEl = document.getElementById('xlFYVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlFYChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const ref = getFYAvg(document.getElementById('xlFY0-' + segKey)?.value, segKey);
    chgEl.innerHTML = wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderQRow(rowNum, qIdx, segKey) {
  const cur   = getQAvg(qIdx, segKey);
  const valEl = document.getElementById('xlQVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlQChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const ref = getQAvg(parseInt(document.getElementById('xlQ0-' + segKey)?.value), segKey);
    chgEl.innerHTML = wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderMRow(rowNum, mIdx, segKey) {
  const cur   = getMAvg(mIdx, segKey);
  const valEl = document.getElementById('xlMVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlMChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2);
  if (chgEl) {
    if (rowNum === 0) {
      chgEl.innerHTML = '';
      // Recompute Avg 6M (always anchored to row 0's month)
      const avg = getM6mAvg(mIdx, segKey);
      const avgValEl = document.getElementById('xlMAvgVal-' + segKey);
      const avgChgEl = document.getElementById('xlMAvgChg-' + segKey);
      if (avgValEl) avgValEl.innerHTML = xlValPlain(avg, 2);
      if (avgChgEl) avgChgEl.innerHTML = wireChg(avg && cur ? (cur.value - avg) / avg : null);
      return;
    }
    const ref = getMAvg(parseInt(document.getElementById('xlM0-' + segKey)?.value), segKey);
    chgEl.innerHTML = wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

// ── Cross-segment sync functions ──────────────────────────────────────────────
const XL_SEGS = ['total', 'options', 'futures', 'cash'];

function syncXLFY(rowNum, fyStr) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlFY' + rowNum + '-' + sk);
    if (sel && sel.value !== fyStr) sel.value = fyStr;
    renderFYRow(rowNum, fyStr, sk);
    if (rowNum === 0) renderFYRow(1, document.getElementById('xlFY1-' + sk)?.value, sk);
  });
}

function syncXLQ(rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlQ' + rowNum + '-' + sk);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderQRow(rowNum, qIdx, sk);
    if (rowNum === 0) {
      [1, 2, 3].forEach(r => {
        const ri = parseInt(document.getElementById('xlQ' + r + '-' + sk)?.value);
        if (!isNaN(ri)) renderQRow(r, ri, sk);
      });
    }
  });
}

// ── Quarter wire-table (Day-of-Week × Quarter) — independently selectable
// per-weekday quarter rows. Unlike getQAvg (whole-quarter daily average from
// the pre-aggregated DATA.quarterly), this filters DATA.daily_all down to a
// single weekday within the chosen quarter, since no pre-aggregated
// per-weekday-per-quarter figure exists for arbitrary quarters (the pipeline
// only ever computed it for the fixed current/prev/YoY trio).
function getWeekdayQAvg(weekday, qIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const q  = DATA.quarterly[qIdx];
  if (!q) return null;
  const rows = (DATA.daily_all || []).filter(r => r.day === weekday && r.fy_quarter === q.quarter);
  if (!rows.length) return null;
  return rows.reduce((s, r) => s + (r[rf.dField] || 0), 0) / rows.length;
}

function renderWireQRow(weekday, rowNum, qIdx, segKey) {
  const valEl = document.getElementById(`wireQVal-${weekday}-${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = wireVal(getWeekdayQAvg(weekday, qIdx, segKey), 1);
}

function syncWireQ(weekday, rowNum, qIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById(`wireQ-${weekday}-${rowNum}-${sk}`);
    if (sel && parseInt(sel.value) !== qIdx) sel.value = qIdx;
    renderWireQRow(weekday, rowNum, qIdx, sk);
  });
}

function syncXLM(rowNum, mIdx) {
  XL_SEGS.forEach(sk => {
    const sel = document.getElementById('xlM' + rowNum + '-' + sk);
    if (sel && parseInt(sel.value) !== mIdx) sel.value = mIdx;
    renderMRow(rowNum, mIdx, sk);
    if (rowNum === 0) {
      const r1 = parseInt(document.getElementById('xlM1-' + sk)?.value);
      if (!isNaN(r1)) renderMRow(1, r1, sk);
    }
  });
}

// ── Segment block template ────────────────────────────────────────────────────
function xlSegmentBlock(segData, label, segKey, fyOpts, qOpts, mOpts) {
  const s   = segData;
  const wl5 = s.weekly.last5;
  const wp5 = s.weekly.prev5;
  const w20 = s.weekly.last20 || {};
  const w50 = s.weekly.last45;
  const dow = s.day_of_week;
  const dayFull = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  // "Last 5 Days" above is a naive trailing slice of the last 5 trading rows
  // (see seg_summary in scripts/nse_pipeline.py / bse_pipeline.py) — when a
  // holiday shifts that window back far enough, it can catch the same weekday
  // (e.g. BSE's Thursday expiry) twice, skewing the average. The center
  // "Week>>" wire-table already shows one "latest" value per weekday, so
  // averaging those 5 gives a like-for-like week (one of each weekday,
  // expiry day included exactly once) with no holiday distortion possible.
  const dowLatestAvg = dayFull.reduce((sum, d) => sum + ((dow[d] || {}).latest || 0), 0) / dayFull.length;

  const wRows = [
    `<tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}</td><td>${wireChg(wl5.wow)}</td><td>${wireChg(wl5.wo10w)}</td></tr>`,
    `<tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 45 Days</td><td>${xlValPlain(w50.value, 2)}</td><td></td><td></td></tr>`,
    `<tr><td>Mon–Fri Avg (Latest)</td><td>${xlValPlain(dowLatestAvg, 2)}</td><td></td><td></td></tr>`,
  ].join('');

  const wireDetailRow = (label, val) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const mkSel = (id, opts) => `<select class="xl-row-sel" id="${id}">${opts}</select>`;

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}</td>
      ${wireDeltaTd(dd.do3d)}
      ${wireDeltaTd(dd.do10d)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d)}`;
  }).join(wireSpacerRow);

  // Quarter wire-table: 3 independently selectable quarters per weekday
  // (was a fixed current/prev/YoY trio computed server-side — see
  // getWeekdayQAvg/renderWireQRow/syncWireQ for the client-side recompute).
  const wireQSelRow = (weekday, rowNum) => `
    <tr class="wire-detail">
      <td>${mkSel(`wireQ-${weekday}-${rowNum}-${segKey}`, qOpts)}</td>
      <td class="wire-value" id="wireQVal-${weekday}-${rowNum}-${segKey}"></td>
      <td></td><td></td>
    </tr>`;

  const qdowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}</td>
      ${wireDeltaTd(dd.qoq)}
      ${wireDeltaTd(dd.yoy)}
    </tr>
    ${wireQSelRow(d, 0)}
    ${wireQSelRow(d, 1)}
    ${wireQSelRow(d, 2)}`;
  }).join(wireSpacerRow);

  // FY: 2 independently selectable rows
  const fyRows = [0, 1].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlFY' + r + '-' + segKey, fyOpts)}</td>
      <td id="xlFYVal${r}-${segKey}"></td>
      <td id="xlFYChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('');

  // Quarter: 4 independently selectable rows (current, prev1, prev2, same-Q last year)
  const qRows = [0, 1, 2, 3].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlQ' + r + '-' + segKey, qOpts)}</td>
      <td id="xlQVal${r}-${segKey}"></td>
      <td id="xlQChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('');

  // Month: 2 selectable rows + 1 static Avg 6M row
  const mRows = [0, 1].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlM' + r + '-' + segKey, mOpts)}</td>
      <td id="xlMVal${r}-${segKey}"></td>
      <td id="xlMChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('') + `
    <tr>
      <td style="color:var(--color-text-secondary);font-size:11.5px">Avg 6 Months</td>
      <td id="xlMAvgVal-${segKey}"></td>
      <td id="xlMAvgChg-${segKey}"></td>
      <td></td>
    </tr>`;

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg</span></div>
      <div class="xl-main-row">

        <table class="xl-period-table">
          <colgroup>
            <col class="xl-col-period">
            <col class="xl-col-val">
            <col class="xl-col-chg1">
            <col class="xl-col-chg2">
          </colgroup>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Financial Year</td><td>Total</td><td>% chg</td><td></td></tr>
            ${fyRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Quarter&gt;&gt;</td><td>Val (In Cr)</td><td>% chg</td><td></td></tr>
            ${qRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Month&gt;&gt;</td><td>Val (In Cr)</td><td>% chg</td><td></td></tr>
            ${mRows}
          </tbody>

          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td>Wo 10W</td></tr>
            ${wRows}
          </tbody>
        </table>

        <div class="wire-table-scroll">
        <table class="wire-table weekday-wire-table">
          <thead>
            <tr><th>Week&gt;&gt;</th><th>Val (In Cr)</th><th>Do 3D</th><th>Do 10D</th></tr>
          </thead>
          <tbody>${dowRows}</tbody>
        </table>
        </div>

        <div class="wire-table-scroll">
        <table class="wire-table quarter-wire-table">
          <thead>
            <tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr>
          </thead>
          <tbody>${qdowRows}</tbody>
        </table>
        </div>

      </div>

      ${(currentExchange === 'nse' || currentExchange === 'bse')
        ? buildExpiryComparisonHTML(currentExchange, segKey, mOpts, qOpts) + buildWeeklyVsMonthEndHTML(currentExchange, segKey)
        : ''}

    </div>`;
}

// ── Static segment block (pre-computed data — used by Market Overview) ────────
function xlStaticSegmentBlock(st, label) {
  if (!st) return `<div class="xl-segment"><div class="xl-seg-header">${label} <span class="xl-seg-unit">— data not available</span></div></div>`;

  const fy  = st.fy || {};
  const q   = st.quarterly || {};
  const m   = st.monthly   || {};
  const wl5 = (st.weekly || {}).last5  || {};
  const wp5 = (st.weekly || {}).prev5  || {};
  const w20 = (st.weekly || {}).last20 || {};
  const w45 = (st.weekly || {}).last45 || {};
  const dow = st.day_of_week   || {};
  const dayFull  = ['Monday','Tuesday','Wednesday','Thursday','Friday'];

  const curFYLabel  = (q.current?.label  || '').match(/FY \d{4}/)?.[0] || 'Current FY';
  const prevFYLabel = (q.previous?.label || '').match(/FY \d{4}/)?.[0] || 'Prev FY';

  const fyRows = `
    <tr class="xl-r-cur"><td>${curFYLabel}</td><td>${xlValPlain(fy.current, 2)}</td><td>${wireChg(fy.yoy)}</td><td></td></tr>
    <tr><td>${prevFYLabel}</td><td>${xlValPlain(fy.previous, 2)}</td><td></td><td></td></tr>`;

  const qRows = [
    `<tr class="xl-r-cur"><td>${q.current?.label  || '—'}</td><td>${xlValPlain(q.current?.value, 2)}</td><td>${wireChg(q.current?.qoq)}</td><td></td></tr>`,
    `<tr><td>${q.previous?.label || '—'}</td><td>${xlValPlain(q.previous?.value, 2)}</td><td></td><td></td></tr>`,
    q.prev2 ? `<tr><td>${q.prev2.label}</td><td>${xlValPlain(q.prev2.value, 2)}</td><td></td><td></td></tr>` : '',
  ].join('');

  const mRows = `
    <tr class="xl-r-cur"><td>${m.current?.label  || '—'}</td><td>${xlValPlain(m.current?.value, 2)}</td><td>${wireChg(m.current?.mom)}</td><td></td></tr>
    <tr><td>${m.previous?.label || '—'}</td><td>${xlValPlain(m.previous?.value, 2)}</td><td></td><td></td></tr>
    <tr><td>${m.avg_6m?.label   || 'Avg 6 Months'}</td><td>${xlValPlain(m.avg_6m?.value, 2)}</td><td>${wireChg(m.current?.mo6m)}</td><td></td></tr>`;

  const wRows = `
    <tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}</td><td>${wireChg(wl5.wow)}</td><td>${wireChg(wl5.wo10w)}</td></tr>
    <tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}</td><td></td><td></td></tr>
    <tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}</td><td></td><td></td></tr>
    <tr><td>Last 45 Days</td><td>${xlValPlain(w45.value, 2)}</td><td></td><td></td></tr>`;

  const wireDetailRow = (label, val) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}</td>
      ${wireDeltaTd(dd.do3d)}
      ${wireDeltaTd(dd.do10d)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d)}`;
  }).join(wireSpacerRow);

  const qdowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}</td>
      ${wireDeltaTd(dd.qoq)}
      ${wireDeltaTd(dd.yoy)}
    </tr>
    ${wireDetailRow(dd.cur_q_label, dd.cur_q_avg)}
    ${wireDetailRow(dd.prev_q_label, dd.prev_q_avg)}
    ${wireDetailRow(dd.yoy_q_label, dd.yoy_q_avg)}`;
  }).join(wireSpacerRow);

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg</span></div>
      <div class="xl-main-row">
        <table class="xl-period-table">
          <colgroup>
            <col class="xl-col-period">
            <col class="xl-col-val">
            <col class="xl-col-chg1">
            <col class="xl-col-chg2">
          </colgroup>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Financial Year</td><td>Total</td><td>YoY</td><td></td></tr>
            ${fyRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Quarter&gt;&gt;</td><td>Val (In Cr)</td><td>QoQ</td><td></td></tr>
            ${qRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Month&gt;&gt;</td><td>Val (In Cr)</td><td>MoM</td><td></td></tr>
            ${mRows}
          </tbody>
          <tbody class="xl-sec">
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td>Wo 10W</td></tr>
            ${wRows}
          </tbody>
        </table>
        <div class="wire-table-scroll">
        <table class="wire-table weekday-wire-table">
          <thead>
            <tr><th>Week&gt;&gt;</th><th>Val (In Cr)</th><th>Do 3D</th><th>Do 10D</th></tr>
          </thead>
          <tbody>${dowRows}</tbody>
        </table>
        </div>
        <div class="wire-table-scroll">
        <table class="wire-table quarter-wire-table">
          <thead>
            <tr><th>Quarter</th><th>Val (In Cr)</th><th>QoQ</th><th>YoY</th></tr>
          </thead>
          <tbody>${qdowRows}</tbody>
        </table>
        </div>
      </div>
    </div>`;
}

// ── Combine summary_total objects across exchanges by summing values ──────────
function combineMarketSummaries() {
  const sts = ['nse', 'bse', 'mcx'].map(ex => MARKET_DATA[ex]?.summary_total).filter(Boolean);
  if (!sts.length) return null;

  const sum  = (...vals) => vals.reduce((a, v) => a + (v || 0), 0);
  const chg  = (cur, prev) => prev ? (cur - prev) / prev : null;

  // FY
  const fyCur  = sum(...sts.map(s => s.fy?.current));
  const fyPrev = sum(...sts.map(s => s.fy?.previous));

  // Quarter
  const qCur   = sum(...sts.map(s => s.quarterly?.current?.value));
  const qPrev  = sum(...sts.map(s => s.quarterly?.previous?.value));
  const qPrev2 = sum(...sts.map(s => s.quarterly?.prev2?.value));
  // YoY: same-quarter prior year — use the label's preceding FY if present
  const qYoyLabel = sts[0]?.quarterly?.prev2?.label;
  const qYoyVal   = qPrev2;

  // Month
  const mCur   = sum(...sts.map(s => s.monthly?.current?.value));
  const mPrev  = sum(...sts.map(s => s.monthly?.previous?.value));
  const mAvg6m = sum(...sts.map(s => s.monthly?.avg_6m?.value));

  // Week
  const w5Val  = sum(...sts.map(s => s.weekly?.last5?.value));
  const wp5Val = sum(...sts.map(s => s.weekly?.prev5?.value));
  const w20Val = sum(...sts.map(s => s.weekly?.last20?.value));
  const w45Val = sum(...sts.map(s => s.weekly?.last45?.value));

  // DoW — sum each day
  const dayFull = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
  const dow = {};
  dayFull.forEach(d => {
    const latest    = sum(...sts.map(s => s.day_of_week?.[d]?.latest));
    const avg3d     = sum(...sts.map(s => s.day_of_week?.[d]?.avg_3d));
    const avg10d    = sum(...sts.map(s => s.day_of_week?.[d]?.avg_10d));
    const prevQAvgs = sts.map(s => s.day_of_week?.[d]?.prev_q_avg).filter(v => v != null);
    const prevQAvg  = prevQAvgs.length ? sum(...prevQAvgs) : null;
    const prevQLabel = sts.map(s => s.day_of_week?.[d]?.prev_q_label).find(Boolean);

    // Per-weekday quarter comparison (current / previous / same quarter last year)
    const curQAvgs = sts.map(s => s.day_of_week?.[d]?.cur_q_avg).filter(v => v != null);
    const curQAvg  = curQAvgs.length ? sum(...curQAvgs) : null;
    const curQLabel = sts.map(s => s.day_of_week?.[d]?.cur_q_label).find(Boolean);
    const yoyQAvgs = sts.map(s => s.day_of_week?.[d]?.yoy_q_avg).filter(v => v != null);
    const yoyQAvg  = yoyQAvgs.length ? sum(...yoyQAvgs) : null;
    const yoyQLabel = sts.map(s => s.day_of_week?.[d]?.yoy_q_label).find(Boolean);

    dow[d] = {
      latest,
      avg_3d:  avg3d,
      avg_10d: avg10d,
      do3d:    chg(latest, avg3d),
      do10d:   chg(latest, avg10d),
      prev_q_label: prevQLabel,
      prev_q_avg:   prevQAvg,
      do_prev_q:    prevQAvg ? chg(latest, prevQAvg) : null,
      cur_q_label: curQLabel,
      cur_q_avg:   curQAvg,
      yoy_q_label: yoyQLabel,
      yoy_q_avg:   yoyQAvg,
      qoq: (curQAvg != null && prevQAvg) ? chg(curQAvg, prevQAvg) : null,
      yoy: (curQAvg != null && yoyQAvg) ? chg(curQAvg, yoyQAvg) : null,
    };
  });

  // Previous week
  const pw = {};
  dayFull.forEach(d => {
    const v = sum(...sts.map(s => s.previous_week?.[d]));
    pw[d] = v || null;
  });

  // Use NSE labels as the reference for period labels
  const ref = sts[0];

  return {
    fy: {
      current:  fyCur,
      previous: fyPrev,
      yoy:      chg(fyCur, fyPrev),
    },
    quarterly: {
      current:  { label: ref.quarterly?.current?.label,  value: qCur,   qoq: chg(qCur, qPrev), yoy: chg(qCur, qYoyVal) },
      previous: { label: ref.quarterly?.previous?.label, value: qPrev  },
      prev2:    qYoyLabel ? { label: qYoyLabel,            value: qPrev2 } : null,
    },
    monthly: {
      current:  { label: ref.monthly?.current?.label,  value: mCur,  mom: chg(mCur, mPrev), mo6m: chg(mCur, mAvg6m) },
      previous: { label: ref.monthly?.previous?.label, value: mPrev  },
      avg_6m:   { label: ref.monthly?.avg_6m?.label,   value: mAvg6m },
    },
    weekly: {
      last5:  { value: w5Val,  wow:  chg(w5Val, wp5Val), wo10w: chg(w5Val, w45Val) },
      prev5:  { value: wp5Val },
      last20: { value: w20Val },
      last45: { value: w45Val },
    },
    day_of_week:   dow,
    previous_week: pw,
  };
}

// ── Market Overview — all 3 exchanges combined ────────────────────────────────
function buildOverview() {
  const el = document.getElementById('overviewContent');
  if (!el) return;

  const anyData = ['nse', 'bse', 'mcx'].some(ex => MARKET_DATA[ex]?.summary_total);
  if (!anyData) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Loading market data…</div>';
    return;
  }

  const combined = combineMarketSummaries();
  if (!combined) {
    el.innerHTML = '<div style="padding:40px;text-align:center;color:var(--color-text-muted)">Data not available</div>';
    return;
  }

  el.innerHTML = xlStaticSegmentBlock(combined, 'Total — NSE + BSE + MCX');
}

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

function buildRevenueSummary() {
  const ed = ENRICHED_DATA;
  if (!ed || !ed.summary_total) return;
  if (!DATA.quarterly?.length || !DATA.monthly?.length) return;

  // Build option lists (no pre-selected — set via JS after render)
  const fySet = [];
  DATA.quarterly.forEach(q => {
    const m = q.quarter.match(/FY \d{4}/);
    if (m && !fySet.includes(m[0])) fySet.push(m[0]);
  });
  fySet.reverse(); // newest first
  const fyOpts = fySet.map(fy => `<option value="${fy}">${fy}</option>`).join('');

  const allQ  = DATA.quarterly;
  const nQ    = allQ.length;
  const qOpts = [...allQ].reverse().map((q, ri) => {
    const idx = nQ - 1 - ri;
    return `<option value="${idx}">${q.quarter}</option>`;
  }).join('');

  const allM  = DATA.monthly;
  const nM    = allM.length;
  const mOpts = [...allM].reverse().map((m, ri) => {
    const idx = nM - 1 - ri;
    return `<option value="${idx}">${m.month}</option>`;
  }).join('');

  // Inject last20 from daily data if pipeline hasn't computed it yet (e.g. NSE)
  const REV_KEYS = { total: 'total_rev', options: 'opt_rev', futures: 'fut_rev', cash: 'cash_rev' };
  const d20 = (DATA.daily || []).slice(-20);
  [
    { key: 'total',   data: ed.summary_total },
    { key: 'options', data: ed.seg_options   },
    { key: 'futures', data: ed.seg_futures   },
    { key: 'cash',    data: ed.seg_cash      },
  ].forEach(({ key, data }) => {
    if (data && data.weekly && !data.weekly.last20) {
      const rk = REV_KEYS[key];
      const avg = d20.length ? d20.reduce((s, r) => s + (r[rk] || 0), 0) / d20.length : 0;
      data.weekly.last20 = { label: 'Last 20 Trading Days', value: Math.round(avg * 10000) / 10000 };
    }
  });

  // Render each segment into its own sub-tab container
  [
    { key: 'total',   data: ed.summary_total, label: 'Total Revenue' },
    { key: 'options', data: ed.seg_options,   label: 'Options Revenue' },
    { key: 'futures', data: ed.seg_futures,   label: 'Futures Revenue' },
    { key: 'cash',    data: ed.seg_cash,      label: 'Cash Revenue' },
  ].forEach(({ key, data, label }) => {
    const el = document.getElementById('subtab-rev-' + key);
    if (!el) return;
    if (!data) { el.innerHTML = ''; return; }
    el.innerHTML = xlSegmentBlock(data, label, key, fyOpts, qOpts, mOpts);
  });

  // Default row values
  const defFY0 = fySet[0] || 'FY 2027';
  const defFY1 = fySet[1] || 'FY 2026';
  const defQ0  = nQ - 1;
  const defQ1  = Math.max(0, nQ - 2);
  const defQ2  = Math.max(0, nQ - 3);
  // Same Q number as current, one year earlier
  const curQNum = (allQ[defQ0]?.quarter || '').match(/^Q(\d)/)?.[1];
  let defQ3 = Math.max(0, nQ - 5);
  if (curQNum) {
    for (let i = defQ0 - 1; i >= 0; i--) {
      if (allQ[i].quarter.startsWith('Q' + curQNum + ' ')) { defQ3 = i; break; }
    }
  }
  const defM0 = nM - 1;
  const defM1 = Math.max(0, nM - 2);

  // Set select values then render data
  XL_SEGS.forEach(sk => {
    if (!document.getElementById('xlFY0-' + sk)) return;  // segment was skipped (null data)
    document.getElementById('xlFY0-' + sk).value = defFY0;
    document.getElementById('xlFY1-' + sk).value = defFY1;
    document.getElementById('xlQ0-'  + sk).value = defQ0;
    document.getElementById('xlQ1-'  + sk).value = defQ1;
    document.getElementById('xlQ2-'  + sk).value = defQ2;
    document.getElementById('xlQ3-'  + sk).value = defQ3;
    document.getElementById('xlM0-'  + sk).value = defM0;
    document.getElementById('xlM1-'  + sk).value = defM1;

    renderFYRow(0, defFY0, sk); renderFYRow(1, defFY1, sk);
    [defQ0, defQ1, defQ2, defQ3].forEach((qi, r) => renderQRow(r, qi, sk));
    renderMRow(0, defM0, sk); renderMRow(1, defM1, sk);

    // Quarter wire-table's 3 per-weekday selectable rows — same current/prev/
    // same-Q-last-year defaults the fixed trio used to show.
    const wireQDefaults = [defQ0, defQ1, defQ3];
    WEEKDAYS.forEach(d => {
      wireQDefaults.forEach((qi, r) => {
        const sel = document.getElementById(`wireQ-${d}-${r}-${sk}`);
        if (sel) sel.value = qi;
        renderWireQRow(d, r, qi, sk);
      });
    });

    // Wire event listeners
    [0, 1].forEach(r => {
      document.getElementById('xlFY' + r + '-' + sk).addEventListener('change', function() {
        syncXLFY(r, this.value);
      });
    });
    [0, 1, 2, 3].forEach(r => {
      document.getElementById('xlQ' + r + '-' + sk).addEventListener('change', function() {
        syncXLQ(r, parseInt(this.value));
      });
    });
    [0, 1].forEach(r => {
      document.getElementById('xlM' + r + '-' + sk).addEventListener('change', function() {
        syncXLM(r, parseInt(this.value));
      });
    });
    WEEKDAYS.forEach(d => {
      [0, 1, 2].forEach(r => {
        document.getElementById(`wireQ-${d}-${r}-${sk}`)?.addEventListener('change', function() {
          syncWireQ(d, r, parseInt(this.value));
        });
      });
    });

    // Month-End Expiry Comparison's 8 month rows + 6 quarter rows (NSE/BSE
    // only — buildExpiryComparisonHTML returns '' for MCX, so these ids
    // won't exist there and the optional-chained lookups below just no-op).
    if (currentExchange === 'nse' || currentExchange === 'bse') {
      const defaultExpiryMonthIdxs = Array.from({ length: 8 }, (_, i) => nM - 8 + i).filter(i => i >= 0);
      const defaultExpiryQuarterIdxs = Array.from({ length: 6 }, (_, i) => nQ - 6 + i).filter(i => i >= 0);
      defaultExpiryMonthIdxs.forEach((mi, r) => {
        const sel = document.getElementById(`expiryM${r}-${sk}`);
        if (!sel) return;
        sel.value = mi;
        renderExpiryMonthRow(r, mi, currentExchange, sk);
        sel.addEventListener('change', function() { syncExpiryM(r, parseInt(this.value)); });
      });
      defaultExpiryQuarterIdxs.forEach((qi, r) => {
        const sel = document.getElementById(`expiryQ${r}-${sk}`);
        if (!sel) return;
        sel.value = qi;
        renderExpiryQuarterRow(r, qi, currentExchange, sk);
        sel.addEventListener('change', function() { syncExpiryQ(r, parseInt(this.value)); });
      });
    }
  });
}

// ========================
// MARKET SHARE PANEL  (generalised — works for any set of exchanges)
// ========================

const MS_META = {
  nse: { label: 'NSE', color: '#2563eb', cls: 'ms-nse' },
  bse: { label: 'BSE', color: '#c0392b', cls: 'ms-bse' },
  mcx: { label: 'MCX', color: '#16a34a', cls: 'ms-mcx' },
};

// Map enriched segment key → raw quarterly/monthly revenue field
const MS_SEG_FIELD = {
  summary_total: 'total_rev',
  seg_options:   'opt_rev',
  seg_futures:   'fut_rev',
  seg_cash:      'cash_rev',
};

function buildMarketSharePanel(exList) {
  const el = document.getElementById('marketSharePanel');
  if (!el) return;

  for (const ex of exList) {
    if (!MARKET_DATA[ex] || !MARKET_RAW[ex]) { el.innerHTML = ''; return; }
  }

  // Use NSE as label reference (same quarters as the main revenue table dropdowns)
  const refEx  = exList.includes('nse') ? 'nse' : exList[0];
  const allQ   = MARKET_RAW[refEx].quarterly || [];
  const nQ     = allQ.length;

  const curQLabel   = allQ[nQ - 1]?.quarter || '';
  const prevQLabel  = allQ[nQ - 2]?.quarter || '';
  const prev2QLabel = allQ[nQ - 3]?.quarter || '';   // e.g. Q3 FY 2026
  const curQNum     = curQLabel.match(/^Q(\d)/)?.[1] || '';
  let   yoyQLabel   = '';
  for (let i = nQ - 2; i >= 0; i--) {
    if (allQ[i].quarter.startsWith('Q' + curQNum + ' ')) { yoyQLabel = allQ[i].quarter; break; }
  }
  const curFYLabel = curQLabel.match(/FY \d{4}/)?.[0] || '';

  // Daily avg for a specific quarter from raw data
  const qAvg = (ex, qLabel, segKey) => {
    if (!qLabel) return 0;
    const q = (MARKET_RAW[ex].quarterly || []).find(x => x.quarter === qLabel);
    if (!q) return 0;
    return (q[MS_SEG_FIELD[segKey]] || 0) / (q.days || q.trading_days || 1);
  };

  const pct  = (n, d) => d > 0 ? Math.round(n / d * 100) + ' %' : '—';
  const ed   = ex => MARKET_DATA[ex];

  const SEGS = [
    { label: 'Total',   key: 'summary_total' },
    { label: 'Options', key: 'seg_options'   },
    { label: 'Futures', key: 'seg_futures'   },
    { label: 'Cash',    key: 'seg_cash'      },
  ];

  const hdrCells = exList.map(ex =>
    `<th style="color:${MS_META[ex].color}">${MS_META[ex].label} %</th>`
  ).join('');

  const segHTML = SEGS.map(({ label: segLabel, key }) => {
    if (exList.some(ex => !ed(ex)[key])) return '';
    const refED = ed(refEx)[key];

    // Build period rows — quarterly from raw (correct per-exchange days), rest from enriched
    const periods = [
      ...(curFYLabel  ? [{ lbl: curFYLabel,   vals: exList.map(ex => ed(ex)[key]?.fy?.current         || 0) }] : []),
      ...(curQLabel   ? [{ lbl: curQLabel,    vals: exList.map(ex => qAvg(ex, curQLabel,   key)), cur: true }] : []),
      ...(prevQLabel  ? [{ lbl: prevQLabel,   vals: exList.map(ex => qAvg(ex, prevQLabel,  key)) }] : []),
      ...(prev2QLabel && prev2QLabel !== prevQLabel ? [{ lbl: prev2QLabel, vals: exList.map(ex => qAvg(ex, prev2QLabel, key)) }] : []),
      ...(yoyQLabel && yoyQLabel !== prevQLabel && yoyQLabel !== prev2QLabel ? [{ lbl: yoyQLabel, vals: exList.map(ex => qAvg(ex, yoyQLabel, key)) }] : []),
      { lbl: refED.monthly?.current?.label  || 'Cur Month',  vals: exList.map(ex => ed(ex)[key]?.monthly?.current?.value  || 0) },
      { lbl: refED.monthly?.previous?.label || 'Prev Month', vals: exList.map(ex => ed(ex)[key]?.monthly?.previous?.value || 0) },
      { lbl: 'Avg 6 Months',  vals: exList.map(ex => ed(ex)[key]?.monthly?.avg_6m?.value  || 0) },
      { lbl: 'Last 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.last5?.value    || 0) },
      { lbl: 'Prev 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.prev5?.value    || 0) },
      { lbl: 'Last 45 Days',  vals: exList.map(ex => ed(ex)[key]?.weekly?.last45?.value   || 0) },
    ];

    const rows = periods.map(({ lbl, vals, cur }) => {
      const total = vals.reduce((a, b) => a + b, 0);
      const cells = exList.map((ex, i) =>
        `<td><span class="ms-pct ${MS_META[ex].cls}">${pct(vals[i], total)}</span></td>`
      ).join('');
      return `<tr${cur ? ' class="xl-r-cur"' : ''}><td>${lbl}</td>${cells}</tr>`;
    }).join('');

    return `<div class="ms-seg">
      <div class="ms-seg-label">${segLabel}</div>
      <table class="ms-table">
        <thead><tr class="xl-col-hdr"><th>Period</th>${hdrCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }).join('');

  const title = exList.map(ex => MS_META[ex].label).join(' + ') + ' Market Share';
  el.innerHTML = `<div class="ms-panel">
    <div class="ms-header">${title} <span class="xl-seg-unit">% of combined daily avg rev</span></div>
    <div class="ms-segs-row">${segHTML}</div>
  </div>`;
}

// ========================
// NSE vs BSE MARKET SHARE TREND (Options + Total, live chart + report)
// ========================

// Monthly NSE-vs-BSE market share — one point per calendar month (smooth, low-noise default view)
function buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw) {
  const nseM = nseRaw?.monthly || [];
  const bseByMonth = new Map((bseRaw?.monthly || []).map(m => [m.month, m]));
  const rows = [];
  nseM.forEach(n => {
    const b = bseByMonth.get(n.month);
    if (!b) return;
    const totalSum = (n.total_rev || 0) + (b.total_rev || 0);
    const optSum   = (n.opt_rev   || 0) + (b.opt_rev   || 0);
    rows.push({
      label: n.month,
      totalShareNSE: totalSum ? (n.total_rev || 0) / totalSum * 100 : null,
      totalShareBSE: totalSum ? (b.total_rev || 0) / totalSum * 100 : null,
      optShareNSE:   optSum   ? (n.opt_rev   || 0) / optSum   * 100 : null,
      optShareBSE:   optSum   ? (b.opt_rev   || 0) / optSum   * 100 : null,
    });
  });
  return rows;
}

// Rolling N-day NSE-vs-BSE market share — daily granularity smoothed by a trailing window,
// so the line reads as a trend rather than a dense daily zigzag.
function buildNSEBSERollingShareSeries(nseRaw, bseRaw, windowSize) {
  const nseDaily = (nseRaw?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const bseByDate = new Map((bseRaw?.daily_all || []).map(r => [r.date, r]));
  const merged = [];
  nseDaily.forEach(n => {
    const b = bseByDate.get(n.date);
    if (!b) return;
    merged.push({
      date: n.date,
      nseTotalRev: n.total_rev || 0, bseTotalRev: b.total_rev || 0,
      nseOptRev:   n.opt_rev   || 0, bseOptRev:   b.opt_rev   || 0,
    });
  });

  const rows = merged.map((r, i) => {
    const slice = merged.slice(Math.max(0, i - windowSize + 1), i + 1);
    const nseTotalSum = slice.reduce((s, x) => s + x.nseTotalRev, 0);
    const bseTotalSum = slice.reduce((s, x) => s + x.bseTotalRev, 0);
    const nseOptSum   = slice.reduce((s, x) => s + x.nseOptRev, 0);
    const bseOptSum   = slice.reduce((s, x) => s + x.bseOptRev, 0);
    const totalSum = nseTotalSum + bseTotalSum;
    const optSum   = nseOptSum + bseOptSum;
    return {
      label: fmtChartDate(r.date),
      totalShareNSE: totalSum ? nseTotalSum / totalSum * 100 : null,
      totalShareBSE: totalSum ? bseTotalSum / totalSum * 100 : null,
      optShareNSE:   optSum   ? nseOptSum   / optSum   * 100 : null,
      optShareBSE:   optSum   ? bseOptSum   / optSum   * 100 : null,
    };
  });

  // Drop the leading partial-window rows — they're averaged over fewer than windowSize days
  return rows.slice(windowSize - 1);
}

// Full-history daily NSE-vs-BSE options share (no windowing) — feeds the trend predictor below.
function buildOptionsShareDailySeries(nseRaw, bseRaw) {
  const nseDaily = (nseRaw?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const bseByDate = new Map((bseRaw?.daily_all || []).map(r => [r.date, r]));
  const rows = [];
  nseDaily.forEach(n => {
    const b = bseByDate.get(n.date);
    if (!b) return;
    const optSum = (n.opt_rev || 0) + (b.opt_rev || 0);
    if (!optSum) return;
    rows.push({ date: n.date, optShareNSE: (n.opt_rev || 0) / optSum * 100 });
  });
  return rows;
}

// Predicts NSE's options-market-share trend by fitting a long-term (~1yr) and a recent (~3mo)
// OLS regression over a lightly-smoothed daily share series, then picking whichever is more
// decision-relevant: higher R² by default, ties broken toward recency, overridden to the recent
// window if it shows a genuine regime change (opposite sign, much steeper, still a moderate+ fit).
function computeOptionsSharePredictor(nseRaw, bseRaw) {
  const daily = buildOptionsShareDailySeries(nseRaw, bseRaw);
  if (daily.length < 20) return null;

  const SMOOTH_WINDOW = 5, LONG_WINDOW = 252, RECENT_WINDOW = 60, TRADING_DAYS_PER_MONTH = 21;

  const smoothedVals = computeRollingMA(daily.map(r => r.optShareNSE), SMOOTH_WINDOW);
  const smoothed = daily.map((r, i) => smoothedVals[i] != null ? { date: r.date, share: smoothedVals[i] } : null).filter(Boolean);
  if (smoothed.length < 20) return null;

  function fitWindow(windowSize) {
    const rows = smoothed.slice(-windowSize);
    if (rows.length < 10) return null;
    const ols = computeOLS(rows.map((_, i) => i), rows.map(r => r.share));
    return {
      rows, ols,
      startDate: rows[0].date, endDate: rows[rows.length - 1].date,
      n: rows.length,
      ratePerMonth: ols.slope * TRADING_DAYS_PER_MONTH,
      fit: ols.r2 > 0.7 ? 'strong' : ols.r2 > 0.4 ? 'moderate' : 'weak',
    };
  }

  const longFit   = fitWindow(Math.min(LONG_WINDOW, smoothed.length));
  const recentFit = fitWindow(Math.min(RECENT_WINDOW, smoothed.length));
  if (!longFit || !recentFit) return null;

  const R2_TIE_TOLERANCE = 0.03, REGIME_SLOPE_RATIO = 1.5, REGIME_MIN_R2 = 0.4;
  const signFlip = recentFit.ols.slope !== 0 && Math.sign(recentFit.ols.slope) !== Math.sign(longFit.ols.slope);
  const regimeChange = signFlip
    && Math.abs(recentFit.ols.slope) > Math.abs(longFit.ols.slope) * REGIME_SLOPE_RATIO
    && recentFit.ols.r2 >= REGIME_MIN_R2;

  let chosen, reason;
  if (regimeChange) {
    chosen = 'recent'; reason = 'Regime change detected — recent trend has reversed and accelerated vs. the long-term trend';
  } else if (recentFit.ols.r2 >= longFit.ols.r2 - R2_TIE_TOLERANCE) {
    chosen = 'recent'; reason = recentFit.ols.r2 > longFit.ols.r2 ? 'Higher R² fit' : 'Comparable fit — recency preferred';
  } else {
    chosen = 'long'; reason = 'Higher R² fit';
  }
  const chosenFit = chosen === 'recent' ? recentFit : longFit;
  const lastIndex = chosenFit.rows.length - 1;

  function project(months) {
    const idx = lastIndex + months * TRADING_DAYS_PER_MONTH;
    const raw = chosenFit.ols.slope * idx + chosenFit.ols.intercept;
    return Math.max(0, Math.min(100, raw));
  }

  return {
    longFit, recentFit, chosen, reason, chosenFit,
    currentShare: smoothed[smoothed.length - 1].share,
    asOfDate: smoothed[smoothed.length - 1].date,
    smoothed,
    projections: [3, 6, 12].map(m => ({ months: m, nseShare: project(m) })),
  };
}

const MS_GRANULARITIES = [
  { key: 'monthly', label: 'Monthly' },
  { key: '20d',     label: '20-Day Rolling' },
  { key: '45d',     label: '45-Day Rolling' },
];

function getMarketShareRows(nseRaw, bseRaw, granularity) {
  if (granularity === '20d') return buildNSEBSERollingShareSeries(nseRaw, bseRaw, 20);
  if (granularity === '45d') return buildNSEBSERollingShareSeries(nseRaw, bseRaw, 45);
  return buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw);
}

function buildMarketShareChart(canvasId, rows, field) {
  if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
  if (!rows.length) return;
  const nseKey = field === 'total' ? 'totalShareNSE' : 'optShareNSE';
  const bseKey = field === 'total' ? 'totalShareBSE' : 'optShareBSE';
  setCanvasHeight(canvasId, 280);
  charts[canvasId] = new Chart(document.getElementById(canvasId), {
    type: 'line',
    data: {
      labels: rows.map(r => r.label),
      datasets: [
        { label: 'NSE %', data: rows.map(r => r[nseKey]), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        { label: 'BSE %', data: rows.map(r => r[bseKey]), borderColor: MS_META.bse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.raw.toFixed(1) + ' %' } } },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { min: 0, max: 100, ticks: { callback: v => v + ' %' } },
      }
    }
  });
}

// Renders the predictor chart: 5D-smoothed NSE share history, both fitted trend lines drawn over
// their own windows, and the chosen model's line extended 3/6/12 months into the future.
function chartOptionsSharePredictor(canvasId, predictor) {
  if (charts[canvasId]) { charts[canvasId].destroy(); charts[canvasId] = null; }
  if (!predictor) return;
  const { smoothed, longFit, recentFit, chosenFit } = predictor;
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  setCanvasHeight(canvasId, 300);

  const TRADING_DAYS_PER_MONTH = 21;
  const historyLabels = smoothed.map(r => fmtChartDate(r.date));
  const futureLabels = ['+3M', '+6M', '+12M'];
  const labels = historyLabels.concat(futureLabels);
  const pad = arr => arr.concat(new Array(futureLabels.length).fill(null));

  function overlaySeries(fit) {
    const n = smoothed.length;
    const arr = new Array(n).fill(null);
    const offset = n - fit.rows.length;
    fit.rows.forEach((_, i) => { arr[offset + i] = fit.ols.slope * i + fit.ols.intercept; });
    return pad(arr);
  }

  const lastIndexInChosen = chosenFit.rows.length - 1;
  const futurePoints = [3, 6, 12].map(m => {
    const idx = lastIndexInChosen + m * TRADING_DAYS_PER_MONTH;
    return Math.max(0, Math.min(100, chosenFit.ols.slope * idx + chosenFit.ols.intercept));
  });
  const projectionSeries = new Array(historyLabels.length - 1).fill(null)
    .concat([smoothed[smoothed.length - 1].share], futurePoints);

  charts[canvasId] = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'NSE Options Share (5D avg)', data: pad(smoothed.map(r => r.share)), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.15 },
        { label: 'Long-Term Trend (252D)', data: overlaySeries(longFit), borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
        { label: 'Recent Trend (60D)', data: overlaySeries(recentFit), borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 },
        { label: 'Projection', data: projectionSeries, borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, borderDash: [2, 2], pointRadius: 2 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + (ctx.raw == null ? '—' : ctx.raw.toFixed(1) + ' %') } } },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { min: 0, max: 100, ticks: { callback: v => v + ' %' } },
      }
    }
  });
}

function fmtRatePerMonth(v) {
  const sign = v > 0.001 ? '+' : v < -0.001 ? '−' : '';
  return sign + Math.abs(v).toFixed(2) + ' pp/mo';
}

// Builds the KPI row + trend-comparison table + chart panel + projection table for the predictor.
function optionsSharePredictorHTML(predictor) {
  if (!predictor) {
    return `<div class="chart-panel" style="text-align:center;padding:40px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600">Not enough overlapping history to fit an options-share trend</div>
    </div>`;
  }
  const { longFit, recentFit, chosen, reason, chosenFit, currentShare, asOfDate, projections } = predictor;
  const rateSentiment = chosenFit.ratePerMonth > 0.05 ? 'positive' : chosenFit.ratePerMonth < -0.05 ? 'negative' : '';
  const chosenLabel = chosen === 'recent' ? 'Recent (60D)' : 'Long-Term (252D)';

  const kpiHTML = `
  <div class="share-kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);margin-bottom:var(--space-4)">
    ${kpi('Current NSE Options Share', fmtNum(currentShare, 1) + ' %', 'as of ' + asOfDate + ' (5D avg)', '')}
    ${kpi('Rate of Change (NSE)', fmtRatePerMonth(chosenFit.ratePerMonth), chosenLabel + ' · ' + chosenFit.fit + ' fit (R²=' + Math.round(chosenFit.ols.r2 * 100) + '%)', rateSentiment)}
    ${kpi('12M Projected NSE Share', fmtNum(projections[2].nseShare, 1) + ' %', 'assumes trend continues, capped 0–100%', '')}
    ${kpi('Model Selected', chosenLabel, reason, '')}
  </div>`;

  const fitRow = (label, fit, isChosen) => `
    <tr${isChosen ? '' : ' style="color:var(--color-text-muted)"'}>
      <td>${label} <span style="font-size:10px;color:var(--color-text-muted)">${isChosen ? '(used)' : '(informational)'}</span></td>
      <td style="text-align:center">${fit.startDate} → ${fit.endDate}</td>
      <td style="text-align:center">${fmtRatePerMonth(fit.ratePerMonth)}</td>
      <td style="text-align:center">${Math.round(fit.ols.r2 * 100)}%</td>
      <td style="text-align:center">${fit.fit}</td>
    </tr>`;

  const tableHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:0;overflow-x:auto">
    <div class="chart-title">Trend Comparison — Long-Term vs Recent</div>
    <table class="data-table" style="margin:0">
      <thead><tr><th>Window</th><th style="text-align:center">Date Range</th><th style="text-align:center">Rate (NSE)</th><th style="text-align:center">R²</th><th style="text-align:center">Fit</th></tr></thead>
      <tbody>
        ${fitRow('Long-Term (252D, ~1yr)', longFit, chosen === 'long')}
        ${fitRow('Recent (60D, ~3mo)', recentFit, chosen === 'recent')}
      </tbody>
    </table>
  </div>`;

  const chartHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">Options Share Predictor — NSE vs BSE</div>
    <div class="chart-wrapper"><canvas id="chartOptionsSharePredictor"></canvas></div>
  </div>`;

  const projRows = projections.map(p => `
    <tr>
      <td>+${p.months} Months</td>
      <td style="text-align:center">${fmtNum(p.nseShare, 1)} %</td>
      <td style="text-align:center">${fmtNum(100 - p.nseShare, 1)} %</td>
    </tr>`).join('');

  const projHTML = `
  <div class="chart-panel" style="padding:0;overflow-x:auto">
    <div class="chart-title">Forward Projection</div>
    <table class="data-table" style="margin:0">
      <thead><tr><th>Horizon</th><th style="text-align:center">NSE Share</th><th style="text-align:center">BSE Share</th></tr></thead>
      <tbody>${projRows}</tbody>
    </table>
    <p class="section-desc" style="padding:10px 14px 14px">Linear extrapolation of the ${chosen === 'recent' ? 'recent (60-day)' : 'long-term (252-day)'} trend; assumes no regime change; clipped to 0–100%.</p>
  </div>`;

  return kpiHTML + tableHTML + chartHTML + projHTML;
}

function buildMarketShareTrend() {
  const el = document.getElementById('marketShareTrendContent');
  if (!el) return;

  const nseRaw = MARKET_RAW.nse, bseRaw = MARKET_RAW.bse;
  if (!getMarketShareRows(nseRaw, bseRaw, 'monthly').length) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:40px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600">No overlapping NSE/BSE data available</div>
    </div>`;
    return;
  }

  const toggleHTML = prefix => `<div class="share-range-toggle">${MS_GRANULARITIES.map(g =>
    `<button class="share-range-btn ${prefix}-gran-btn${g.key === 'monthly' ? ' active' : ''}" data-gran="${g.key}">${g.label}</button>`
  ).join('')}</div>`;

  const predictor = computeOptionsSharePredictor(nseRaw, bseRaw);

  el.innerHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Options Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msOpt')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsOptions"></canvas></div>
  </div>
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Total Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msTotal')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsTotal"></canvas></div>
  </div>
  <h3 style="margin:0 0 var(--space-3);font-size:var(--text-lg);font-weight:700;color:var(--color-text)">Options Share Predictor</h3>
  ${optionsSharePredictorHTML(predictor)}`;

  let optGran = 'monthly', totalGran = 'monthly';
  const refreshOpt   = () => buildMarketShareChart('chartMsOptions', getMarketShareRows(nseRaw, bseRaw, optGran), 'opt');
  const refreshTotal = () => buildMarketShareChart('chartMsTotal',   getMarketShareRows(nseRaw, bseRaw, totalGran), 'total');
  refreshOpt();
  refreshTotal();
  chartOptionsSharePredictor('chartOptionsSharePredictor', predictor);

  el.querySelectorAll('.msOpt-gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.msOpt-gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      optGran = btn.dataset.gran;
      refreshOpt();
    });
  });
  el.querySelectorAll('.msTotal-gran-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.msTotal-gran-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      totalGran = btn.dataset.gran;
      refreshTotal();
    });
  });
}

// Off-screen chart-to-image rendering for the downloadable reports (mirrors buildAllRegressionChartImgs)
// Reports use the monthly view — smooth and compact, matching a periodic snapshot.
function buildMarketShareChartImgs(nseRaw, bseRaw) {
  const rows = buildNSEBSEMonthlyShareSeries(nseRaw, bseRaw);
  if (!rows.length) return [];

  const mkDef = (label, nseKey, bseKey) => ({
    label, w: 700, h: 300,
    config: {
      type: 'line',
      data: {
        labels: rows.map(r => r.label),
        datasets: [
          { label: 'NSE %', data: rows.map(r => r[nseKey]), borderColor: MS_META.nse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'BSE %', data: rows.map(r => r[bseKey]), borderColor: MS_META.bse.color, backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
        ]
      },
      options: {
        animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
        scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } }, y: { min: 0, max: 100, ticks: { callback: v => v + ' %', font: { size: 9 } } } }
      }
    }
  });

  const defs = [
    mkDef('Options Revenue Market Share — NSE vs BSE (Monthly)', 'optShareNSE', 'optShareBSE'),
    mkDef('Total Revenue Market Share — NSE vs BSE (Monthly)', 'totalShareNSE', 'totalShareBSE'),
  ];

  return defs.map(def => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${def.w}px;height:${def.h}px;`;
    const canvas = document.createElement('canvas');
    canvas.width = def.w; canvas.height = def.h;
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    const tempChart = new Chart(canvas, def.config);
    const img = tempChart.toBase64Image();
    tempChart.destroy();
    document.body.removeChild(wrap);
    return { label: def.label, img };
  });
}

// ========================
// NSE: TEMPORAL ANALYSIS
// ========================

function buildNSETemporalCharts() {
  // Day-of-week
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const dowData = days.map(d => (DATA.dow_avg || {})[d] || { avg_total: 0, avg_options: 0, avg_futures: 0, avg_cash: 0 });

  setCanvasHeight('chartDOW', 280);
  charts.dow = new Chart(document.getElementById('chartDOW'), {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        { label: 'Options', data: dowData.map(x => x.avg_options), backgroundColor: CHART_COLORS[0], stack: 's', borderRadius: 2 },
        { label: 'Futures', data: dowData.map(x => x.avg_futures), backgroundColor: CHART_COLORS[1], stack: 's', borderRadius: 2 },
        { label: 'Cash', data: dowData.map(x => x.avg_cash), backgroundColor: CHART_COLORS[3], stack: 's', borderRadius: 2 },
      ]
    },
    options: {
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw),
            footer: items => 'Total Avg: ' + fmt(items.reduce((s, i) => s + i.raw, 0))
          }
        }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Monthly revenue
  const m = DATA.monthly;
  setCanvasHeight('chartMonthlyRev', 280);
  charts.monthlyRev = new Chart(document.getElementById('chartMonthlyRev'), {
    type: 'line',
    data: {
      labels: m.map(x => x.month),
      datasets: [{
        label: 'Monthly Revenue',
        data: m.map(x => x.total_rev),
        borderColor: CHART_COLORS[0],
        backgroundColor: CHART_COLORS[0] + '15',
        fill: true,
        pointRadius: 2,
      }]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 18, maxRotation: 45, font: { size: 9 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Daily with 10-day MA
  const d = DATA.daily;
  const dailyLabels = d.map(x => {
    const dt = new Date(x.date);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });
  const dailyRev = d.map(x => x.total_rev);
  const ma10 = dailyRev.map((_, i) => {
    if (i < 9) return null;
    let sum = 0;
    for (let j = i - 9; j <= i; j++) sum += dailyRev[j];
    return sum / 10;
  });

  setCanvasHeight('chartDailyMA', 280);
  charts.dailyMA = new Chart(document.getElementById('chartDailyMA'), {
    type: 'line',
    data: {
      labels: dailyLabels,
      datasets: [
        { label: 'Daily Revenue', data: dailyRev, borderColor: CHART_COLORS[0] + '60', borderWidth: 1, pointRadius: 1 },
        { label: '10-day MA', data: ma10, borderColor: CHART_COLORS[5], borderWidth: 2.5 },
      ]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 15, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });

  // Quarterly table
  buildNSEQuarterlyTable();
}

// ========================
// NSE: QUARTER COMPARISON
// ========================

function initNSEQuarterCompare() {
  const quarters = [...new Set(DATA.daily.map(d => d.fy_quarter))];
  const sel1 = document.getElementById('qtrSelect1');
  const sel2 = document.getElementById('qtrSelect2');
  sel1.innerHTML = '';
  sel2.innerHTML = '<option value="">None</option>';

  const reversedQ = [...quarters].reverse();
  reversedQ.forEach(q => {
    sel1.innerHTML += `<option value="${q}">${q}</option>`;
    sel2.innerHTML += `<option value="${q}">${q}</option>`;
  });
  sel1.value = reversedQ[0];

  function renderQtrCompare() {
    if (charts.qtrCompare) charts.qtrCompare.destroy();
    const q1 = sel1.value;
    const q2 = sel2.value;
    if (!q1) return;

    const q1Data = DATA.daily.filter(d => d.fy_quarter === q1);
    const maxDays = q1Data.length;
    const labels = q1Data.map((_, i) => 'Day ' + (i + 1));
    const datasets = [{
      label: q1,
      data: q1Data.map(d => d.total_rev),
      borderColor: CHART_COLORS[0],
      backgroundColor: CHART_COLORS[0] + '15',
      fill: true, borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
    }];

    if (q2) {
      const q2Data = DATA.daily.filter(d => d.fy_quarter === q2);
      if (q2Data.length > maxDays) {
        for (let i = maxDays; i < q2Data.length; i++) labels.push('Day ' + (i + 1));
      }
      datasets.push({
        label: q2,
        data: q2Data.map(d => d.total_rev),
        borderColor: CHART_COLORS[1],
        backgroundColor: CHART_COLORS[1] + '15',
        fill: true, borderWidth: 2, borderDash: [5, 3], pointRadius: 2, pointHoverRadius: 5,
      });
    }

    charts.qtrCompare = new Chart(document.getElementById('chartQtrCompare'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: {
          tooltip: {
            callbacks: {
              title: items => items[0].label,
              label: ctx => {
                const qData = ctx.dataset.label === q1
                  ? DATA.daily.filter(d => d.fy_quarter === q1)
                  : DATA.daily.filter(d => d.fy_quarter === q2);
                const actualDate = qData[ctx.dataIndex] ? qData[ctx.dataIndex].date : '';
                return ctx.dataset.label + ': ' + fmt(ctx.raw) + (actualDate ? ' (' + actualDate + ')' : '');
              }
            }
          }
        },
        scales: {
          x: { ticks: { maxTicksLimit: 20, font: { size: 10 } } },
          y: { ticks: { callback: v => '\u20b9' + fmtNum(v, 0) + ' Cr' } }
        }
      }
    });
  }

  sel1.addEventListener('change', renderQtrCompare);
  sel2.addEventListener('change', renderQtrCompare);
  renderQtrCompare();
}

// ========================
// NSE: PAT PREDICTION ENGINE
// ========================

function buildNSEExtrapolationKPIs() {
  const p = ENRICHED_DATA.pnl_predictor;
  if (!p) return;
  const otherIncome = p.total_revenue_predicted - p.transaction_rev_extrapolated;

  const kpis = [
    { label: 'Daily Avg Txn Rev', value: fmt(p.daily_avg_rev) },
    { label: 'Trading Days (Actual / Expected)', value: `${p.q4_fy2026_trading_days_so_far || p.trading_days_so_far} / ${p.q4_fy2025_total_trading_days || p.expected_trading_days}` },
    { label: 'Extrapolated Qtr Txn Rev', value: fmt(p.transaction_rev_extrapolated) },
    { label: `Other Income (${fmtPct(p.other_income_ratio)} of Txn Rev)`, value: fmt(otherIncome) },
    { label: 'Total Revenue (Predicted)', value: fmt(p.total_revenue_predicted), highlight: true },
    { label: 'Predicted PAT', value: fmt(p.pat_predicted), highlight: true },
  ];

  document.getElementById('extrapKpis').innerHTML = kpis.map(k => `
    <div class="extrap-card${k.highlight ? ' highlight' : ''}">
      <div class="extrap-label">${k.label}</div>
      <div class="extrap-value">${k.value}</div>
    </div>
  `).join('');
}

function buildNSEPredictedPnLTable() {
  const quarters = ENRICHED_DATA.pnl_predicted_quarters;
  if (!quarters) return;
  let html = '<thead><tr><th>Quarter</th><th>Txn Rev</th><th>Other Income</th><th>Total Rev</th><th>Total Exp</th><th>EBITDA</th><th>EBITDA %</th><th>PAT</th><th>PAT %</th><th>EPS</th></tr></thead><tbody>';

  let isFirst = true;
  for (const [qName, q] of Object.entries(quarters)) {
    const otherIncome = q.total_revenue - q.transaction_rev;
    const tag = isFirst ? ' <span style="color:var(--color-warning);font-size:10px;font-weight:600">CURRENT</span>' : '';
    const cls = isFirst ? '' : 'predicted';
    html += `<tr class="${cls}">
      <td>${qName}${tag}</td>
      <td>${fmt(q.transaction_rev)}</td>
      <td>${fmt(otherIncome)}</td>
      <td>${fmt(q.total_revenue)}</td>
      <td>${fmt(q.total_expense)}</td>
      <td>${fmt(q.ebitda)}</td>
      <td>${fmtPct(q.ebitda_margin)}</td>
      <td style="font-weight:600">${fmt(q.pat)}</td>
      <td>${fmtPct(q.pat_margin)}</td>
      <td>₹ ${fmtNum(q.eps)}</td>
    </tr>`;
    isFirst = false;
  }
  html += '</tbody>';
  document.getElementById('tablePredictedPnL').innerHTML = html;
}

function initNSEPATPredictor() {
  const p = ENRICHED_DATA.pnl_predictor;
  if (!p || !DATA.cost_ratios) return;
  const lastCostQ = Object.keys(DATA.cost_ratios).pop();
  const cr = DATA.cost_ratios[lastCostQ];

  const dailyRevInput = document.getElementById('inputDailyRev');
  const tradingDaysInput = document.getElementById('inputTradingDays');
  const otherIncomeInput = document.getElementById('inputOtherIncomeRatio');
  const taxInput = document.getElementById('inputTaxRate');
  const sharesInput = document.getElementById('inputShares');

  dailyRevInput.value = p.daily_avg_rev.toFixed(1);
  otherIncomeInput.value = (p.other_income_ratio * 100).toFixed(1);

  document.getElementById('predictorHint').textContent =
    'Current ' + (p.quarter || (DATA.summary && DATA.summary.current_quarter) || 'quarter') + ' avg: ₹ ' + p.daily_avg_rev.toFixed(2) + ' Cr/day';

  const costParams = {
    emp_pct: cr.employee_pct || 0.044,
    reg_pct: cr.regulatory_pct || 0.045,
    tech_pct: cr.technology_pct || 0.07,
    dep_pct: cr.depreciation_pct || 0.035,
    csr_other_pct: 0.035,
  };

  function computePredictor() {
    const dailyRev = Number(dailyRevInput.value) || 0;
    const tradingDays = Number(tradingDaysInput.value) || 62;
    const otherIncomeRatio = (Number(otherIncomeInput.value) || 0) / 100;
    const taxRate = (Number(taxInput.value) || 25.2) / 100;
    const shares = Number(sharesInput.value) || 247.5;

    if (dailyRev <= 0) {
      document.getElementById('predictorOutput').innerHTML = '';
      document.getElementById('predictorPEResults').innerHTML = '';
      return;
    }

    const qtrTxnRev = dailyRev * tradingDays;
    const otherIncome = qtrTxnRev * otherIncomeRatio;
    const totalRev = qtrTxnRev + otherIncome;

    const empCost = totalRev * costParams.emp_pct;
    const regCost = totalRev * costParams.reg_pct;
    const techCost = totalRev * costParams.tech_pct;
    const depCost = totalRev * costParams.dep_pct;
    const csrOther = totalRev * costParams.csr_other_pct;
    const totalExp = empCost + regCost + techCost + depCost + csrOther;

    const pbt = totalRev - totalExp;
    const tax = pbt * taxRate;
    const pat = pbt - tax;

    const qtrEPS = pat / shares;
    const annualEPS = qtrEPS * 4;

    document.getElementById('predictorOutput').innerHTML = `
      <div class="pred-card">
        <div class="pred-label">Qtr Txn Revenue</div>
        <div class="pred-value">${fmt(qtrTxnRev)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${fmt(dailyRev)}/day × ${tradingDays} days</div>
      </div>
      <div class="pred-card">
        <div class="pred-label">Other Income</div>
        <div class="pred-value">${fmt(otherIncome)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${(otherIncomeRatio * 100).toFixed(1)}% of Txn Rev</div>
      </div>
      <div class="pred-card">
        <div class="pred-label">Total Revenue</div>
        <div class="pred-value">${fmt(totalRev)}</div>
      </div>
      <div class="pred-card">
        <div class="pred-label">Total Expenses</div>
        <div class="pred-value">${fmt(totalExp)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${fmtPct(totalExp / totalRev)} of revenue</div>
      </div>
      <div class="pred-card highlight">
        <div class="pred-label">Quarterly PAT</div>
        <div class="pred-value" style="color:var(--color-success)">${fmt(pat)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${fmtPct(pat / totalRev)} margin</div>
      </div>
      <div class="pred-card">
        <div class="pred-label">EPS (Quarterly)</div>
        <div class="pred-value">₹ ${qtrEPS.toFixed(2)}</div>
        <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">Annualized: ₹ ${annualEPS.toFixed(2)}</div>
      </div>
    `;

    updatePredictorPE(annualEPS);
  }

  function updatePredictorPE(annualEPS) {
    if (!annualEPS || annualEPS <= 0) {
      document.getElementById('predictorPEResults').innerHTML = '';
      return;
    }
    const bearPE = Number(document.getElementById('predBearPE').value) || 25;
    const basePE = Number(document.getElementById('predBasePE').value) || 35;
    const bullPE = Number(document.getElementById('predBullPE').value) || 45;

    document.getElementById('predictorPEResults').innerHTML = `
      <div class="pe-card bear">
        <div class="pe-scenario-label">Bear Case</div>
        <div class="pe-subtitle">${bearPE}x PE × ₹${annualEPS.toFixed(2)} EPS</div>
        <div class="pe-price">${fmtPrice(bearPE * annualEPS)}</div>
      </div>
      <div class="pe-card base">
        <div class="pe-scenario-label">Base Case</div>
        <div class="pe-subtitle">${basePE}x PE × ₹${annualEPS.toFixed(2)} EPS</div>
        <div class="pe-price">${fmtPrice(basePE * annualEPS)}</div>
      </div>
      <div class="pe-card bull">
        <div class="pe-scenario-label">Bull Case</div>
        <div class="pe-subtitle">${bullPE}x PE × ₹${annualEPS.toFixed(2)} EPS</div>
        <div class="pe-price">${fmtPrice(bullPE * annualEPS)}</div>
      </div>
    `;
  }

  [dailyRevInput, tradingDaysInput, otherIncomeInput, taxInput, sharesInput].forEach(el => {
    el.addEventListener('input', computePredictor);
  });
  ['predBearPE', 'predBasePE', 'predBullPE'].forEach(id => {
    document.getElementById(id).addEventListener('input', computePredictor);
  });
  computePredictor();
}

function initNSEPEValuation() {
  const bearInput = document.getElementById('peBear');
  const baseInput = document.getElementById('peBase');
  const bullInput = document.getElementById('peBull');

  function updatePEResults() {
    const quarters = ENRICHED_DATA.pnl_predicted_quarters;
    if (!quarters) return;
    // The quarter being extrapolated (first entry = current quarter)
    const cqName = ENRICHED_DATA.pnl_predictor?.quarter || Object.keys(quarters)[0];
    const cqData = quarters[cqName];
    if (!cqData || !cqData.eps) return;

    const quarterlyEPS = cqData.eps;
    const annualizedEPS = quarterlyEPS * 4;

    const bearPE = Number(bearInput.value) || 25;
    const basePE = Number(baseInput.value) || 35;
    const bullPE = Number(bullInput.value) || 45;

    document.getElementById('peResults').innerHTML = `
      <div class="pe-card bear">
        <div class="pe-scenario-label">Bear Case</div>
        <div class="pe-subtitle">${bearPE}x PE</div>
        <div class="pe-price">${fmtPrice(bearPE * annualizedEPS)}</div>
      </div>
      <div class="pe-card base">
        <div class="pe-scenario-label">Base Case</div>
        <div class="pe-subtitle">${basePE}x PE</div>
        <div class="pe-price">${fmtPrice(basePE * annualizedEPS)}</div>
      </div>
      <div class="pe-card bull">
        <div class="pe-scenario-label">Bull Case</div>
        <div class="pe-subtitle">${bullPE}x PE</div>
        <div class="pe-price">${fmtPrice(bullPE * annualizedEPS)}</div>
      </div>
    `;
  }

  bearInput.addEventListener('input', updatePEResults);
  baseInput.addEventListener('input', updatePEResults);
  bullInput.addEventListener('input', updatePEResults);
  updatePEResults();
}

let predState = {};

function initNSEPrediction() {
  if (!DATA.pnl || !DATA.cost_ratios) return;
  const actualPnl = DATA.pnl.filter(p => !p.is_predicted);
  const lastActual = actualPnl[actualPnl.length - 1];
  const lastQ = lastActual.quarter;
  const cr = DATA.cost_ratios[lastQ] || Object.values(DATA.cost_ratios)[Object.values(DATA.cost_ratios).length - 1];

  const cq = DATA.quarterly[DATA.quarterly.length - 1];
  const days = cq.days || 62;
  const annualFactor = 62 / Math.max(days, 1);

  predState = {
    optRev: Math.round(cq.opt_rev * annualFactor),
    futRev: Math.round(cq.fut_rev * annualFactor),
    cashRev: Math.round(cq.cash_rev * annualFactor),
    empPct: (cr.employee_pct * 100) || 4.0,
    regPct: (cr.regulatory_pct * 100) || 4.5,
    techPct: (cr.technology_pct * 100) || 7.0,
    depPct: (cr.depreciation_pct * 100) || 3.5,
    otherIncome: (cr.other_income_ratio * 100) || 45,
  };

  setSlider('sliderOpt', 'valOpt', predState.optRev, v => fmt(v));
  setSlider('sliderFut', 'valFut', predState.futRev, v => fmt(v));
  setSlider('sliderCash', 'valCash', predState.cashRev, v => fmt(v));
  setSlider('sliderEmp', 'valEmp', predState.empPct, v => v.toFixed(1) + '%');
  setSlider('sliderReg', 'valReg', predState.regPct, v => v.toFixed(1) + '%');
  setSlider('sliderTech', 'valTech', predState.techPct, v => v.toFixed(1) + '%');
  setSlider('sliderDep', 'valDep', predState.depPct, v => v.toFixed(1) + '%');
  setSlider('sliderOther', 'valOther', predState.otherIncome, v => v.toFixed(0) + '%');

  const sliders = ['sliderOpt', 'sliderFut', 'sliderCash', 'sliderEmp', 'sliderReg', 'sliderTech', 'sliderDep', 'sliderOther'];
  sliders.forEach(id => {
    document.getElementById(id).addEventListener('input', () => updateNSEPrediction());
  });

  document.querySelectorAll('.scenario-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scenario-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyNSEScenario(btn.dataset.scenario);
    });
  });

  updateNSEPrediction();
  buildNSEPnLTable();
  buildNSEPATHistoryChart();
}

function setSlider(sliderId, valId, value, formatter) {
  const sl = document.getElementById(sliderId);
  const vl = document.getElementById(valId);
  if (!sl || !vl) return;
  sl.value = value;
  vl.textContent = formatter(value);
  sl.addEventListener('input', () => {
    vl.textContent = formatter(Number(sl.value));
  });
}

function applyNSEScenario(scenario) {
  const cq = DATA.quarterly[DATA.quarterly.length - 1];
  const days = cq.days || 62;
  const annualFactor = 62 / Math.max(days, 1);
  let factor = 1;
  if (scenario === 'bear') factor = 0.85;
  if (scenario === 'bull') factor = 1.15;

  document.getElementById('sliderOpt').value = Math.round(cq.opt_rev * annualFactor * factor);
  document.getElementById('sliderFut').value = Math.round(cq.fut_rev * annualFactor * factor);
  document.getElementById('sliderCash').value = Math.round(cq.cash_rev * annualFactor * factor);

  document.getElementById('valOpt').textContent = fmt(Number(document.getElementById('sliderOpt').value));
  document.getElementById('valFut').textContent = fmt(Number(document.getElementById('sliderFut').value));
  document.getElementById('valCash').textContent = fmt(Number(document.getElementById('sliderCash').value));

  updateNSEPrediction();
}

function updateNSEPrediction() {
  const optRev = Number(document.getElementById('sliderOpt').value);
  const futRev = Number(document.getElementById('sliderFut').value);
  const cashRev = Number(document.getElementById('sliderCash').value);
  const empPct = Number(document.getElementById('sliderEmp').value) / 100;
  const regPct = Number(document.getElementById('sliderReg').value) / 100;
  const techPct = Number(document.getElementById('sliderTech').value) / 100;
  const depPct = Number(document.getElementById('sliderDep').value) / 100;
  const otherIncome = Number(document.getElementById('sliderOther').value) / 100;

  const transactionRev = optRev + futRev + cashRev;
  const otherRev = transactionRev * otherIncome;
  const totalRev = transactionRev + otherRev;

  const empCost = totalRev * empPct;
  const regCost = totalRev * regPct;
  const techCost = totalRev * techPct;
  const depCost = totalRev * depPct;
  const csrOther = totalRev * 0.035;
  const totalExp = empCost + regCost + techCost + depCost + csrOther;

  const ebitda = totalRev - totalExp + depCost;
  const ebitdaMargin = ebitda / totalRev;
  const pbt = totalRev - totalExp;
  const tax = pbt * 0.252;
  const pat = pbt - tax;
  const patMargin = pat / totalRev;

  const container = document.getElementById('predResult');
  container.innerHTML = `
    <div class="pred-card">
      <div class="pred-label">Total Revenue</div>
      <div class="pred-value">${fmt(totalRev)}</div>
    </div>
    <div class="pred-card">
      <div class="pred-label">EBITDA</div>
      <div class="pred-value">${fmt(ebitda)}</div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${fmtPct(ebitdaMargin)} margin</div>
    </div>
    <div class="pred-card highlight">
      <div class="pred-label">Predicted PAT</div>
      <div class="pred-value" style="color:var(--color-primary-hover)">${fmt(pat)}</div>
      <div style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:4px">${fmtPct(patMargin)} margin</div>
    </div>
    <div class="pred-card">
      <div class="pred-label">EPS (est.)</div>
      <div class="pred-value">₹ ${(pat / 247.5).toFixed(2)}</div>
      <div style="font-size:var(--text-xs);color:var(--color-text-faint);margin-top:4px">~247.5 Cr shares</div>
    </div>
  `;

  buildNSEWaterfallChart(transactionRev, otherRev, totalRev, totalExp, empCost, regCost, techCost, depCost, csrOther, ebitda, pbt, tax, pat);
}

function buildNSEWaterfallChart(txnRev, otherRev, totalRev, totalExp, emp, reg, tech, dep, csrOther, ebitda, pbt, tax, pat) {
  if (charts.waterfall) charts.waterfall.destroy();
  setCanvasHeight('chartWaterfall', 300);

  const labels = ['Txn Rev', 'Other Income', 'Total Rev', 'Employee', 'Regulatory', 'Technology', 'Depreciation', 'Other Exp', 'PBT', 'Tax', 'PAT'];
  let running = 0;
  const floatingData = [];
  const colors = [];

  floatingData.push([0, txnRev]); colors.push(CHART_COLORS[0]);
  floatingData.push([txnRev, txnRev + otherRev]); colors.push(CHART_COLORS[3]);
  floatingData.push([0, totalRev]); colors.push(CHART_COLORS[0]);
  running = totalRev;
  floatingData.push([running - emp, running]); running -= emp; colors.push(CHART_COLORS[4]);
  floatingData.push([running - reg, running]); running -= reg; colors.push(CHART_COLORS[4]);
  floatingData.push([running - tech, running]); running -= tech; colors.push(CHART_COLORS[4]);
  floatingData.push([running - dep, running]); running -= dep; colors.push(CHART_COLORS[4]);
  floatingData.push([running - csrOther, running]); running -= csrOther; colors.push(CHART_COLORS[4]);
  floatingData.push([0, pbt]); colors.push(CHART_COLORS[5]);
  floatingData.push([pat, pbt]); colors.push(CHART_COLORS[1]);
  floatingData.push([0, pat]); colors.push('#30d158');

  charts.waterfall = new Chart(document.getElementById('chartWaterfall'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'P&L Waterfall',
        data: floatingData,
        backgroundColor: colors,
        borderRadius: 3,
        borderSkipped: false,
      }]
    },
    options: {
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              const range = ctx.raw;
              const value = Math.abs(range[1] - range[0]);
              return ctx.label + ': ' + fmt(value);
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 9 } } },
        y: { beginAtZero: true, ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });
}

function buildNSEPATHistoryChart() {
  const p = DATA.pnl;
  if (!p || p.length === 0) return;
  setCanvasHeight('chartPATHistory', 300);

  const allLabels = p.map(x => {
    const parts = x.quarter.split(' ');
    return parts[0] + " '" + parts[2].slice(2);
  });
  const barColors = p.map(x => x.is_predicted ? CHART_COLORS[5] : CHART_COLORS[0]);
  const patValues = p.map(x => x.pat);

  if (charts.patHistory) charts.patHistory.destroy();
  charts.patHistory = new Chart(document.getElementById('chartPATHistory'), {
    type: 'bar',
    data: {
      labels: allLabels,
      datasets: [{
        label: 'PAT',
        data: patValues,
        backgroundColor: barColors,
        borderColor: barColors,
        borderWidth: 1,
        borderRadius: 3,
      }]
    },
    options: {
      plugins: {
        legend: {
          display: true,
          labels: {
            generateLabels: function() {
              return [
                { text: 'Actual PAT', fillStyle: CHART_COLORS[0], strokeStyle: CHART_COLORS[0], lineWidth: 0, hidden: false },
                { text: 'Predicted PAT', fillStyle: CHART_COLORS[5], strokeStyle: CHART_COLORS[5], lineWidth: 0, hidden: false },
              ];
            }
          }
        },
        tooltip: {
          callbacks: {
            label: ctx => {
              const isPred = DATA.pnl[ctx.dataIndex].is_predicted;
              return (isPred ? 'Predicted: ' : 'Actual: ') + fmt(ctx.raw);
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });
}

function buildNSEPnLTable() {
  const p = DATA.pnl;
  if (!p) return;
  let html = '<thead><tr><th>Quarter</th><th>Txn Rev</th><th>Total Rev</th><th>Total Exp</th><th>EBITDA</th><th>EBITDA %</th><th>PAT</th><th>PAT %</th><th>EPS</th></tr></thead><tbody>';
  for (const q of p) {
    const cls = q.is_predicted ? 'predicted' : '';
    html += `<tr class="${cls}">
      <td>${q.quarter}</td>
      <td>${fmt(q.transaction_rev)}</td>
      <td>${fmt(q.total_revenue)}</td>
      <td>${fmt(q.total_expense)}</td>
      <td>${fmt(q.ebitda)}</td>
      <td>${fmtPct(q.ebitda_margin)}</td>
      <td style="font-weight:600">${fmt(q.pat)}</td>
      <td>${fmtPct(q.pat_margin)}</td>
      <td>₹ ${fmtNum(q.eps)}</td>
    </tr>`;
  }
  html += '</tbody>';
  document.getElementById('tablePnL').innerHTML = html;
}

// ========================
// NSE: ADVANCED ANALYTICS
// ========================

function buildNSEAdvancedCharts() {
  const d = DATA.daily;
  const hasVix = d.some(x => x.vix > 0);
  const labels = d.map(x => {
    const dt = new Date(x.date);
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  });

  // PN ratio vs VIX
  setCanvasHeight('chartPNVix', 300);
  if (hasVix) {
    charts.pnVix = new Chart(document.getElementById('chartPNVix'), {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'P/N Ratio (bps)',
            data: d.map(x => x.pn_ratio * 10000),
            borderColor: CHART_COLORS[0],
            yAxisID: 'y1',
            borderWidth: 1.5,
            pointRadius: 1,
          },
          {
            label: 'India VIX',
            data: d.map(x => x.vix),
            borderColor: CHART_COLORS[5],
            yAxisID: 'y2',
            borderWidth: 2,
            borderDash: [4, 3],
            pointRadius: 0,
          },
        ]
      },
      options: {
        scales: {
          x: { ticks: { maxTicksLimit: 12, font: { size: 10 } } },
          y1: { position: 'left', title: { display: true, text: 'P/N Ratio (bps)', color: CHART_COLORS[0], font: { size: 10 } } },
          y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'India VIX', color: CHART_COLORS[5], font: { size: 10 } } },
        }
      }
    });
  }

  // Scatter
  setCanvasHeight('chartScatter', 300);
  if (hasVix) {
    charts.scatter = new Chart(document.getElementById('chartScatter'), {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'Daily Revenue vs VIX',
          data: d.map(x => ({ x: x.vix, y: x.total_rev })),
          backgroundColor: CHART_COLORS[0] + '80',
          pointRadius: 4,
          pointHoverRadius: 6,
        }]
      },
      options: {
        scales: {
          x: { title: { display: true, text: 'India VIX', font: { size: 10 } }, ticks: { font: { size: 10 } } },
          y: { title: { display: true, text: 'Total Revenue (₹ Cr)', font: { size: 10 } }, ticks: { callback: v => '₹' + fmtNum(v, 0) } },
        },
        plugins: {
          tooltip: { callbacks: { label: ctx => 'VIX: ' + fmtNum(ctx.raw.x, 1) + ', Rev: ' + fmt(ctx.raw.y) } }
        }
      }
    });
  }

  // Contracts vs Revenue
  setCanvasHeight('chartContracts', 300);
  charts.contracts = new Chart(document.getElementById('chartContracts'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Total Revenue',
          data: d.map(x => x.total_rev),
          borderColor: CHART_COLORS[0],
          yAxisID: 'y1',
          borderWidth: 1.5,
        },
        {
          label: 'Contracts (Mn)',
          data: d.map(x => x.total_contracts / 1e6),
          borderColor: CHART_COLORS[4],
          yAxisID: 'y2',
          borderWidth: 1.5,
          borderDash: [4, 3],
        },
      ]
    },
    options: {
      scales: {
        x: { ticks: { maxTicksLimit: 12, font: { size: 10 } } },
        y1: { position: 'left', title: { display: true, text: 'Revenue (₹ Cr)', color: CHART_COLORS[0], font: { size: 10 } } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Contracts (Mn)', color: CHART_COLORS[4], font: { size: 10 } } },
      }
    }
  });

  buildHeatmap();
}

function buildHeatmap() {
  const q = DATA.quarterly;
  const fys = {};
  q.forEach(item => {
    const parts = item.quarter.split(' ');
    const qNum = parts[0];
    const fy = parts[1] + ' ' + parts[2];
    if (!fys[fy]) fys[fy] = {};
    fys[fy][qNum] = item;
  });

  const allVals = q.map(x => x.total_rev);
  const minRev = Math.min(...allVals);
  const maxRev = Math.max(...allVals);
  const rgb = getHeatmapRgb();

  let html = '<table class="data-table"><thead><tr><th>FY</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr></thead><tbody>';
  Object.keys(fys).forEach(fy => {
    html += `<tr><td>${fy}</td>`;
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(qn => {
      const item = fys[fy][qn];
      if (item) {
        const intensity = (item.total_rev - minRev) / (maxRev - minRev);
        const bg = `rgba(${rgb}, ${(0.1 + intensity * 0.5).toFixed(2)})`;
        html += `<td style="background:${bg};font-weight:600">${fmt(item.total_rev)}</td>`;
      } else {
        html += `<td style="color:var(--color-text-faint)">—</td>`;
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  document.getElementById('heatmapContainer').innerHTML = html;
}

// ========================
// BSE: REVENUE PREDICTOR
// ========================

function buildBSERevenuePredictor() {
  const p = ENRICHED_DATA.pnl_predictor;
  if (!p) return;
  const otherIncome = p.total_revenue_predicted - p.transaction_rev_extrapolated;
  const progressPct = ((p.trading_days_so_far / p.expected_trading_days) * 100).toFixed(0);

  const kpis = [
    { label: 'Daily Avg Transaction Rev', value: fmt(p.daily_avg_rev) },
    { label: 'Trading Days (Actual / Expected)', value: `${p.trading_days_so_far} / ${p.expected_trading_days}` },
    { label: 'Extrapolated Qtr Transaction Rev', value: fmt(p.transaction_rev_extrapolated) },
    { label: `Other Income (~${fmtPct(p.other_income_ratio)} of Txn)`, value: fmt(otherIncome) },
  ];

  document.getElementById('bsePredictorKpis').innerHTML = kpis.map(k => `
    <div class="extrap-card${k.highlight ? ' highlight' : ''}">
      <div class="extrap-label">${k.label}</div>
      <div class="extrap-value">${k.value}</div>
    </div>
  `).join('') + `
    <div class="extrap-card highlight" style="grid-column: 1 / -1">
      <div class="extrap-label">Total Estimated Quarterly Revenue</div>
      <div class="extrap-value" style="font-size:var(--text-xl)">${fmt(p.total_revenue_predicted)}</div>
    </div>
  `;

  document.getElementById('bseProgressBarFill').style.width = progressPct + '%';
  document.getElementById('bseProgressLabel').textContent =
    `Quarter Progress: ${p.trading_days_so_far} of ${p.expected_trading_days} trading days completed (${progressPct}%)`;

  // Composition table
  const q = DATA.quarterly;
  const cq = q[q.length - 1];
  const cqDays = cq.days || cq.trading_days || 1;
  const optPct = cq.total_rev > 0 ? (cq.opt_rev / cq.total_rev * 100).toFixed(1) : 0;
  const cashPct = cq.total_rev > 0 ? (cq.cash_rev / cq.total_rev * 100).toFixed(1) : 0;
  const futPct = cq.total_rev > 0 ? (cq.fut_rev / cq.total_rev * 100).toFixed(1) : 0;

  let compositionHTML = `<thead><tr><th>Segment</th><th>Current Qtr Rev</th><th>% of Total</th><th>Days</th><th>Daily Avg</th></tr></thead><tbody>`;
  compositionHTML += `<tr><td>Options</td><td>${fmt(cq.opt_rev)}</td><td>${optPct}%</td><td>${cqDays}</td><td>${fmt(cq.opt_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr><td>Futures</td><td>${fmt(cq.fut_rev)}</td><td>${futPct}%</td><td>${cqDays}</td><td>${fmt(cq.fut_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr><td>Cash</td><td>${fmt(cq.cash_rev)}</td><td>${cashPct}%</td><td>${cqDays}</td><td>${fmt(cq.cash_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr style="font-weight:600"><td>Total</td><td>${fmt(cq.total_rev)}</td><td>100%</td><td>${cqDays}</td><td>${fmt(cq.total_rev / cqDays)}</td></tr>`;
  compositionHTML += `</tbody>`;
  document.getElementById('tableBseRevComposition').innerHTML = compositionHTML;
}

function buildMCXRevenuePredictor() {
  const p = ENRICHED_DATA.pnl_predictor;
  if (!p) return;
  const otherIncome = p.total_revenue_predicted - p.transaction_rev_extrapolated;
  const progressPct = ((p.trading_days_so_far / p.expected_trading_days) * 100).toFixed(0);

  const kpis = [
    { label: 'Daily Avg Transaction Rev', value: fmt(p.daily_avg_rev) },
    { label: 'Trading Days (Actual / Expected)', value: `${p.trading_days_so_far} / ${p.expected_trading_days}` },
    { label: 'Extrapolated Qtr Transaction Rev', value: fmt(p.transaction_rev_extrapolated) },
    { label: `Other Income (~${fmtPct(p.other_income_ratio)} of Txn)`, value: fmt(otherIncome) },
  ];

  document.getElementById('mcxPredictorKpis').innerHTML = kpis.map(k => `
    <div class="extrap-card${k.highlight ? ' highlight' : ''}">
      <div class="extrap-label">${k.label}</div>
      <div class="extrap-value">${k.value}</div>
    </div>
  `).join('') + `
    <div class="extrap-card highlight" style="grid-column: 1 / -1">
      <div class="extrap-label">Total Estimated Quarterly Revenue</div>
      <div class="extrap-value" style="font-size:var(--text-xl)">${fmt(p.total_revenue_predicted)}</div>
    </div>
  `;

  document.getElementById('mcxProgressBarFill').style.width = progressPct + '%';
  document.getElementById('mcxProgressLabel').textContent =
    `Quarter Progress: ${p.trading_days_so_far} of ${p.expected_trading_days} trading days completed (${progressPct}%)`;

  const q = DATA.quarterly;
  const cq = q[q.length - 1];
  const cqDays = cq.days || cq.trading_days || 1;
  const optPct  = cq.total_rev > 0 ? (cq.opt_rev  / cq.total_rev * 100).toFixed(1) : 0;
  const cashPct = cq.total_rev > 0 ? (cq.cash_rev / cq.total_rev * 100).toFixed(1) : 0;
  const futPct  = cq.total_rev > 0 ? (cq.fut_rev  / cq.total_rev * 100).toFixed(1) : 0;

  let compositionHTML = `<thead><tr><th>Segment</th><th>Current Qtr Rev</th><th>% of Total</th><th>Days</th><th>Daily Avg</th></tr></thead><tbody>`;
  compositionHTML += `<tr><td>Options</td><td>${fmt(cq.opt_rev)}</td><td>${optPct}%</td><td>${cqDays}</td><td>${fmt(cq.opt_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr><td>Futures</td><td>${fmt(cq.fut_rev)}</td><td>${futPct}%</td><td>${cqDays}</td><td>${fmt(cq.fut_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr><td>Cash</td><td>${fmt(cq.cash_rev)}</td><td>${cashPct}%</td><td>${cqDays}</td><td>${fmt(cq.cash_rev / cqDays)}</td></tr>`;
  compositionHTML += `<tr style="font-weight:600"><td>Total</td><td>${fmt(cq.total_rev)}</td><td>100%</td><td>${cqDays}</td><td>${fmt(cq.total_rev / cqDays)}</td></tr>`;
  compositionHTML += `</tbody>`;
  document.getElementById('tableMcxRevComposition').innerHTML = compositionHTML;
}

// ========================
// BSE: QUARTERLY ANALYSIS
// ========================

// ========================
// NSE QUARTERLY CHARTS (mirrors BSE quarterly analysis)
// ========================

function buildNSEQuarterlyCharts() {
  const q = DATA.quarterly;
  const shortLabels = q.map(x => { const p = x.quarter.split(' '); return p[0] + " '" + p[2].slice(2); });

  setCanvasHeight('chartNseQuarterlyRev', 300);
  charts.nseQuarterlyRev = new Chart(document.getElementById('chartNseQuarterlyRev'), {
    type: 'bar',
    data: {
      labels: shortLabels,
      datasets: [
        { label: 'Cash',    data: q.map(x => x.cash_rev), backgroundColor: CHART_COLORS[3], borderRadius: 2, stack: 'stack', order: 3 },
        { label: 'Futures', data: q.map(x => x.fut_rev),  backgroundColor: CHART_COLORS[1], borderRadius: 2, stack: 'stack', order: 2 },
        { label: 'Options', data: q.map(x => x.opt_rev),  backgroundColor: CHART_COLORS[0], borderRadius: 2, stack: 'stack', order: 1 },
      ]
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw),
            footer: items => 'Total: ' + fmt(items.reduce((s, i) => s + i.raw, 0))
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { stacked: true, ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  setCanvasHeight('chartNseQuarterlyLine', 300);
  charts.nseQuarterlyLine = new Chart(document.getElementById('chartNseQuarterlyLine'), {
    type: 'line',
    data: {
      labels: shortLabels,
      datasets: [{
        label: 'Total Revenue',
        data: q.map(x => x.total_rev),
        borderColor: CHART_COLORS[0],
        backgroundColor: CHART_COLORS[0] + '20',
        fill: true,
        pointRadius: 3,
        pointHoverRadius: 6,
      }]
    },
    options: {
      plugins: { tooltip: { callbacks: { label: ctx => 'Total Revenue: ' + fmt(ctx.raw) } } },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });
}

// ========================
// NSE MONTHLY ANALYSIS (mirrors BSE monthly analysis)
// ========================

function buildNSEMonthlyAnalysis() {
  const m = DATA.monthly;
  const last12 = m.slice(-12);
  const labels = last12.map(x => {
    const parts = x.month.split(' ');
    return parts[parts.length - 1].slice(0, 3) + " '" + parts[1].slice(2);
  });

  setCanvasHeight('chartNseMonthlyRev', 300);
  charts.nseMonthlyRev = new Chart(document.getElementById('chartNseMonthlyRev'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Revenue',
        data: last12.map(x => x.total_rev),
        backgroundColor: CHART_COLORS[0] + '80',
        borderColor: CHART_COLORS[0],
        borderWidth: 1,
        borderRadius: 2
      }]
    },
    options: {
      plugins: { tooltip: { callbacks: { label: ctx => 'Total Revenue: ' + fmt(ctx.raw) } } },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  setCanvasHeight('chartNseMonthlySegment', 300);
  charts.nseMonthlySegment = new Chart(document.getElementById('chartNseMonthlySegment'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Cash',    data: last12.map(x => x.cash_rev), backgroundColor: CHART_COLORS[3], borderRadius: 2, stack: 's', order: 3 },
        { label: 'Futures', data: last12.map(x => x.fut_rev),  backgroundColor: CHART_COLORS[1], borderRadius: 2, stack: 's', order: 2 },
        { label: 'Options', data: last12.map(x => x.opt_rev),  backgroundColor: CHART_COLORS[0], borderRadius: 2, stack: 's', order: 1 },
      ]
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw),
            footer: items => 'Total: ' + fmt(items.reduce((s, i) => s + i.raw, 0))
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { stacked: true, ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Monthly table — all months
  let html = '<thead><tr><th>Month</th><th>Options</th><th>Futures</th><th>Cash</th><th>Total</th><th>Days</th><th>Daily Avg</th><th>MoM</th></tr></thead><tbody>';
  for (let i = 0; i < m.length; i++) {
    const r = m[i];
    const rDays = r.trading_days || r.days || 1;
    const dailyAvg = r.total_rev / rDays;
    const prev = i > 0 ? m[i - 1] : null;
    const prevDays = prev ? (prev.trading_days || prev.days || 1) : 1;
    const prevAvg = prev ? prev.total_rev / prevDays : null;
    const mom = prevAvg ? (dailyAvg - prevAvg) / prevAvg : null;
    html += `<tr>
      <td>${r.month}</td>
      <td>${fmt(r.opt_rev)}</td>
      <td>${fmt(r.fut_rev)}</td>
      <td>${fmt(r.cash_rev)}</td>
      <td style="font-weight:600">${fmt(r.total_rev)}</td>
      <td>${rDays}</td>
      <td>${fmt(dailyAvg)}</td>
      <td>${fmtPctSigned(mom)}</td>
    </tr>`;
  }
  html += '</tbody>';
  document.getElementById('tableNseMonthly').innerHTML = html;
}

// ========================
// BSE: MONTHLY ANALYSIS
// ========================

function buildBSEMonthlyAnalysis() {
  const m = DATA.monthly;
  const last12 = m.slice(-12);
  const labels = last12.map(x => {
    const parts = x.month.split(' ');
    return parts[parts.length - 1].slice(0, 3) + " '" + parts[1].slice(2);
  });

  // Monthly revenue trend
  setCanvasHeight('chartBseMonthlyRev', 300);
  charts.bseMonthlyRev = new Chart(document.getElementById('chartBseMonthlyRev'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Total Revenue',
        data: last12.map(x => x.total_rev),
        backgroundColor: CHART_COLORS[0] + '80',
        borderColor: CHART_COLORS[0],
        borderWidth: 1,
        borderRadius: 2
      }]
    },
    options: {
      plugins: { tooltip: { callbacks: { label: ctx => 'Total Revenue: ' + fmt(ctx.raw) } } },
      scales: {
        x: { ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Monthly segment chart
  setCanvasHeight('chartBseMonthlySegment', 300);
  charts.bseMonthlySegment = new Chart(document.getElementById('chartBseMonthlySegment'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Cash', data: last12.map(x => x.cash_rev), backgroundColor: CHART_COLORS[3], borderRadius: 2, stack: 's', order: 3 },
        { label: 'Futures', data: last12.map(x => x.fut_rev), backgroundColor: CHART_COLORS[1], borderRadius: 2, stack: 's', order: 2 },
        { label: 'Options', data: last12.map(x => x.opt_rev), backgroundColor: CHART_COLORS[0], borderRadius: 2, stack: 's', order: 1 },
      ]
    },
    options: {
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + fmt(ctx.raw),
            footer: items => 'Total: ' + fmt(items.reduce((s, i) => s + i.raw, 0))
          }
        }
      },
      scales: {
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: 10 } } },
        y: { stacked: true, ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // Monthly Table
  let html = '<thead><tr><th>Month</th><th>Options</th><th>Futures</th><th>Cash</th><th>Total</th><th>Days</th><th>Daily Avg</th><th>MoM</th></tr></thead><tbody>';
  for (let i = 0; i < m.length; i++) {
    const r = m[i];
    const rDays = r.trading_days || r.days || 1;
    const dailyAvg = r.total_rev / rDays;
    const prev = i > 0 ? m[i - 1] : null;
    const prevDays = prev ? (prev.trading_days || prev.days || 1) : 1;
    const prevAvg = prev ? prev.total_rev / prevDays : null;
    const mom = prevAvg ? (dailyAvg - prevAvg) / prevAvg : null;

    html += `<tr>
      <td>${r.month}</td>
      <td>${fmt(r.opt_rev)}</td>
      <td>${fmt(r.fut_rev)}</td>
      <td>${fmt(r.cash_rev)}</td>
      <td style="font-weight:600">${fmt(r.total_rev)}</td>
      <td>${rDays}</td>
      <td>${fmt(dailyAvg)}</td>
      <td>${fmtPctSigned(mom)}</td>
    </tr>`;
  }
  html += '</tbody>';
  document.getElementById('tableBseMonthly').innerHTML = html;
}

// ========================
// BSE SHARE ANALYTICS
// ========================

function computeRollingMA(arr, window) {
  return arr.map((_, i) =>
    i < window - 1 ? null : arr.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0) / window
  );
}

function computeOLS(xs, ys) {
  const n     = xs.length;
  const xMean = xs.reduce((a, b) => a + b) / n;
  const yMean = ys.reduce((a, b) => a + b) / n;
  const num   = xs.reduce((s, x, i) => s + (x - xMean) * (ys[i] - yMean), 0);
  const den   = xs.reduce((s, x) => s + (x - xMean) ** 2, 0);
  const slope = num / den;
  const intercept = yMean - slope * xMean;
  const ss_res = xs.reduce((s, x, i) => s + (ys[i] - (slope * x + intercept)) ** 2, 0);
  const ss_tot = ys.reduce((s, y) => s + (y - yMean) ** 2, 0);
  const r2 = 1 - ss_res / ss_tot;
  return { slope, intercept, r2, r: Math.sqrt(Math.abs(r2)) * (slope >= 0 ? 1 : -1) };
}

// `lag` (trading days, default 0) pairs each date's price with the revenue MA
// from `lag` trading days earlier — i.e. tests whether revenue trends lead
// price with a delay, rather than the same-day comparison.
// `prefix` = extra revenue-only rows that PRECEDE rawSeries (NSE: the price series
// starts at its 2026-09-24 listing, but the revenue MA needs the history before it).
// They feed the moving average / lag lookback only; the returned series is rawSeries.
function buildSeriesWithDMA(rawSeries, dmaWindow, regStart, lag = 0, prefix = []) {
  const offset = prefix.length;
  const mas = computeRollingMA(prefix.concat(rawSeries).map(r => r.revenue_cr), dmaWindow);
  const withMA = rawSeries.map((r, i) => {
    const maIdx = offset + i - lag;
    const ma = maIdx >= 0 ? mas[maIdx] : null;
    return ma != null ? { ...r, rev_ma: ma } : null;
  }).filter(Boolean);
  if (!withMA.length) return null;
  const regRows = withMA.filter(r => r.date >= regStart);
  if (regRows.length < 5) return null;
  const ols = computeOLS(regRows.map(r => r.rev_ma), regRows.map(r => r.price));
  const series = withMA.map(r => ({
    ...r,
    price_pred: Math.round((ols.slope * r.rev_ma + ols.intercept) * 100) / 100,
  }));
  return {
    series,
    reg: {
      slope:     ols.slope,
      intercept: ols.intercept,
      r_squared: ols.r2,
      pearson_r: ols.r,
      equation:  `Price = ${ols.slope.toFixed(2)} × Rev_MA${dmaWindow}${lag ? `[lag ${lag}d]` : ''} + ${ols.intercept.toFixed(2)}`,
      fit:       ols.r2 > 0.7 ? 'strong' : ols.r2 > 0.4 ? 'moderate' : 'weak',
    },
  };
}

// KPI grid + regression-equation panel for the BSE/MCX share-price regression
// sections — factored out so switching the DMA window (10/20/45) can refresh
// R², Pearson r, the equation, and the predicted price together, instead of
// only the charts while these stayed pinned to the initial window's values.
function shareRegressionInfoHTML(reg, predPrice, actualPrice, isLive, asOfDate, activeDma, regStart, nDays, ticker, activeLag) {
  const r2pct   = Math.round(reg.r_squared * 100);
  const errDiff = predPrice - actualPrice;
  const errPct  = actualPrice ? (errDiff / actualPrice * 100) : 0;
  const lagPart = activeLag ? ` &nbsp;|&nbsp; Lag: ${activeLag} days (revenue leads)` : '';

  const kpiHTML = `
  <div class="share-kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);margin-bottom:var(--space-4)">
    ${kpi('Model R²',        r2pct + '%',              reg.fit + ' fit',    r2pct > 60 ? 'positive' : r2pct > 30 ? 'neutral' : 'negative')}
    ${kpi('Pearson r',       reg.pearson_r.toFixed(2), 'revenue ↔ price',   '')}
    ${kpi('Predicted Price', '₹' + fmtNum(predPrice, 0), 'model estimate', '')}
    ${kpi(isLive ? 'Actual Price 🟢 Live' : 'Actual Price', '₹' + fmtNum(actualPrice, 0), (errDiff >= 0 ? '+' : '') + fmtNum(errDiff, 0) + ' vs model', errDiff >= 0 ? 'positive' : 'negative')}
  </div>`;

  const eqHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:20px 24px">
    <div class="chart-title">Regression Equation</div>
    <div style="font-size:20px;font-weight:700;color:var(--color-text);margin:12px 0 8px;font-family:var(--font-mono,monospace)">${reg.equation}</div>
    <div style="font-size:12px;color:var(--color-text-muted);display:flex;gap:24px;flex-wrap:wrap">
      <span>R² = ${reg.r_squared.toFixed(3)} &nbsp;|&nbsp; r = ${reg.pearson_r.toFixed(3)} &nbsp;|&nbsp; n = ${nDays} trading days</span>
      <span>MA window: ${activeDma} days${lagPart} &nbsp;|&nbsp; Regression from: ${regStart} &nbsp;|&nbsp; Ticker: ${ticker}</span>
      <span>Prediction error: ${errPct.toFixed(2)} % &nbsp;|&nbsp; As of: ${asOfDate}</span>
    </div>
  </div>`;

  return kpiHTML + eqHTML;
}

// Latest row of a DMA-window series — falls back to the last entry if the
// exact as-of date isn't present (shouldn't normally happen).
function latestShareRow(series, asOfDate) {
  return series.find(r => r.date === asOfDate) || series[series.length - 1];
}

function filterShareSeries(ser, range, regStart) {
  const last = new Date(ser[ser.length - 1].date);
  let cutoff;
  const d = new Date(last);
  switch (range) {
    case '1m':      d.setMonth(d.getMonth() - 1);      cutoff = d.toISOString().slice(0, 10); break;
    case '3m':      d.setMonth(d.getMonth() - 3);      cutoff = d.toISOString().slice(0, 10); break;
    case '6m':      d.setMonth(d.getMonth() - 6);      cutoff = d.toISOString().slice(0, 10); break;
    case '1y':      d.setFullYear(d.getFullYear() - 1); cutoff = d.toISOString().slice(0, 10); break;
    case '2y':      d.setFullYear(d.getFullYear() - 2); cutoff = d.toISOString().slice(0, 10); break;
    case 'nov2024':
    default:        cutoff = regStart;
  }
  return ser.filter(r => r.date >= cutoff);
}

function buildBSECharts(viewSer, reg, maWin) {
  ['bseSharePrice', 'bseRevMaVsPrice', 'bseRatioSD', 'bseShareScatter'].forEach(k => {
    if (charts[k]) { charts[k].destroy(); charts[k] = null; }
  });
  if (!viewSer.length) return;

  const labels  = viewSer.map(r => fmtChartDate(r.date));
  const actuals = viewSer.map(r => r.price);
  const preds   = viewSer.map(r => r.price_pred);
  const revMA   = viewSer.map(r => r.rev_ma);
  const revRaw  = viewSer.map(r => r.revenue_cr);

  // ── Chart 1: Price actual vs predicted ──
  setCanvasHeight('chartBseSharePrice', 280);
  charts.bseSharePrice = new Chart(document.getElementById('chartBseSharePrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual Price',    data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2,   pointRadius: 0, tension: 0.2 },
        { label: 'Model Prediction', data: preds,  borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [5, 3] },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0) } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });

  // ── Chart 2: Dual-axis — Rev MA vs Share Price ──
  setCanvasHeight('chartBseRevMaVsPrice', 300);
  charts.bseRevMaVsPrice = new Chart(document.getElementById('chartBseRevMaVsPrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: maWin + '-Day MA Revenue (₹ Cr)', data: revMA,   borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yRev' },
        { label: 'BSE Share Price (₹)',             data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yPrice' },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.yAxisID === 'yRev'
              ? ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 2) + ' Cr'
              : ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0)
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        yRev: {
          type: 'linear', position: 'left',
          title: { display: true, text: maWin + '-Day MA Rev (₹ Cr)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 1) + ' Cr', font: { size: 10 } },
        },
        yPrice: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'Share Price (₹)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 10 } },
          grid: { drawOnChartArea: false },
        },
      }
    }
  });

  // ── Chart 4: Price ÷ RevMA Ratio — Mean ± SD (recalculated for this range) ──
  const ratios = viewSer.map(r => r.price / r.rev_ma);
  const n      = ratios.length;
  const mean   = ratios.reduce((a, b) => a + b, 0) / n;
  const std    = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const flat   = val => viewSer.map(() => val);

  const sdBandOuter = CHART_COLORS[0] + '18';
  const sdBandInner = CHART_COLORS[0] + '30';
  const sdLineOuter = CHART_COLORS[0] + '55';
  const sdLineInner = CHART_COLORS[0] + '80';

  setCanvasHeight('chartBseRatioSD', 300);
  charts.bseRatioSD = new Chart(document.getElementById('chartBseRatioSD'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '+2σ',          data: flat(mean + 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 4 }, backgroundColor: sdBandOuter },
        { label: '+1σ',          data: flat(mean + std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 3 }, backgroundColor: sdBandInner },
        { label: 'Mean',         data: flat(mean),           borderColor: CHART_COLORS[4], borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−1σ',          data: flat(mean - std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−2σ',          data: flat(mean - 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: 'Price / Rev MA', data: ratios, borderColor: CHART_COLORS[1], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw.toFixed(1);
              if (ctx.dataset.label === 'Price / Rev MA') {
                const zVal = (ctx.raw - mean) / std;
                return `Ratio: ${v}  (${zVal >= 0 ? '+' : ''}${zVal.toFixed(1)}σ)`;
              }
              const target = ctx.raw * revMA[ctx.dataIndex];
              return `${ctx.dataset.label}: ${v}  →  ₹${fmtNum(target, 0)} target`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: {
          ticks: { font: { size: 10 }, callback: v => v.toFixed(0) },
          title: { display: true, text: 'Price ÷ Rev MA' + maWin, font: { size: 10 } },
        }
      }
    }
  });

  // ── Chart 5: Scatter (Revenue MA → Price) ──
  const scatterData = viewSer.map(r => ({ x: r.rev_ma, y: r.price }));
  const xVals = viewSer.map(r => r.rev_ma);
  const xMin  = Math.min(...xVals);
  const xMax  = Math.max(...xVals);
  const regLine = [
    { x: xMin, y: reg.slope * xMin + reg.intercept },
    { x: xMax, y: reg.slope * xMax + reg.intercept },
  ];

  setCanvasHeight('chartBseShareScatter', 260);
  charts.bseShareScatter = new Chart(document.getElementById('chartBseShareScatter'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Price vs Rev MA',  data: scatterData, backgroundColor: CHART_COLORS[0] + '88', pointRadius: 3 },
        { label: 'Regression Line', data: regLine, type: 'line', borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 0 },
      ]
    },
    options: {
      plugins: {
        tooltip: { callbacks: { label: ctx => `Rev MA${maWin}: ₹${fmtNum(ctx.parsed.x, 1)} Cr | Price: ₹${fmtNum(ctx.parsed.y, 0)}` } }
      },
      scales: {
        x: { title: { display: true, text: maWin + '-Day MA Revenue (₹ Cr)' }, ticks: { callback: v => '₹' + fmtNum(v, 1) } },
        y: { title: { display: true, text: 'BSE Share Price (₹)' },            ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });
}

function buildBSEShareAnalysis() {
  const el = document.getElementById('bse-share-inner');
  if (!el) return;

  if (!SHARE_DATA) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:48px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Share analytics data not available</div>
      <div style="font-size:12px">Run scripts/bse_share_analysis.py to generate bse_share_analysis.json</div>
    </div>`;
    return;
  }

  const reg      = SHARE_DATA.regression;
  const lat      = SHARE_DATA.latest;
  const ser      = SHARE_DATA.series || [];
  const maWin    = SHARE_DATA.ma_window;
  const regStart = SHARE_DATA.regression_start || '2025-03-01';

  const infoHTML = shareRegressionInfoHTML(
    reg, lat.price_pred, lat.price_actual, lat.is_live, lat.date,
    maWin, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, 0
  );

  const regLabel = new Date(regStart + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' }) + '+';
  const ranges = [
    { key: '1m',      label: '1M' },
    { key: '3m',      label: '3M' },
    { key: '6m',      label: '6M' },
    { key: 'nov2024', label: regLabel },
    { key: '1y',      label: '1Y' },
    { key: '2y',      label: '2Y' },
  ];
  const rangeToggleHTML = `
  <div class="share-range-toggle">
    ${ranges.map(r => `<button class="share-range-btn bse-range-btn${r.key === 'nov2024' ? ' active' : ''}" data-range="${r.key}">${r.label}</button>`).join('')}
  </div>`;

  const dmaToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">DMA</span>
    ${[10, 20, 45].map(w => `<button class="share-range-btn bse-dma-btn${w === 45 ? ' active' : ''}" data-dma="${w}">${w}D</button>`).join('')}
  </div>`;

  const lagToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">Lag</span>
    ${[0, 45, 60, 90].map(l => `<button class="share-range-btn bse-lag-btn${l === 0 ? ' active' : ''}" data-lag="${l}">${l === 0 ? 'None' : l + 'D'}</button>`).join('')}
  </div>`;

  const chartsHTML = `
  <div style="margin-top:var(--space-4)">
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title">BSE Share Price: Actual vs Model</div>
      <div class="chart-wrapper"><canvas id="chartBseSharePrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="bseDmaChartTitle">${maWin}-Day MA Revenue vs BSE Share Price</div>
      <div class="chart-wrapper"><canvas id="chartBseRevMaVsPrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="bseRatioChartTitle">Price ÷ Rev MA${maWin} Ratio — Mean ± SD</div>
      <div class="chart-wrapper"><canvas id="chartBseRatioSD"></canvas></div>
    </div>
    <div class="chart-panel">
      <div class="chart-title">Revenue → Price Scatter</div>
      <div class="chart-wrapper" style="max-height:300px"><canvas id="chartBseShareScatter"></canvas></div>
    </div>
  </div>`;

  const sectionHTML = `
  <div style="margin-top:var(--space-5)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:1px solid var(--color-border)">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted)">Charts</span>
        ${dmaToggleHTML}
        ${lagToggleHTML}
      </div>
      ${rangeToggleHTML}
    </div>
    ${chartsHTML}
  </div>`;

  el.innerHTML = `<div id="bseShareInfo">${infoHTML}</div>` + sectionHTML;

  let bseActiveDma   = 45;
  let bseActiveLag   = 0;
  let bseActiveRange = 'nov2024';
  const bseDmaCache  = { '45_0': { series: ser, reg } };

  function getBseDmaData(w, lag) {
    const key = `${w}_${lag}`;
    if (!bseDmaCache[key]) bseDmaCache[key] = buildSeriesWithDMA(ser, w, regStart, lag);
    return bseDmaCache[key];
  }

  function refreshBSECharts() {
    const d = getBseDmaData(bseActiveDma, bseActiveLag);
    if (!d) return;
    buildBSECharts(filterShareSeries(d.series, bseActiveRange, regStart), d.reg, bseActiveDma);
    const lagSuffix = bseActiveLag ? ` (lag ${bseActiveLag}d)` : '';
    const t1 = document.getElementById('bseDmaChartTitle');
    if (t1) t1.textContent = `${bseActiveDma}-Day MA Revenue vs BSE Share Price${lagSuffix}`;
    const t2 = document.getElementById('bseRatioChartTitle');
    if (t2) t2.textContent = `Price ÷ Rev MA${bseActiveDma} Ratio — Mean ± SD${lagSuffix}`;
    const infoEl = document.getElementById('bseShareInfo');
    if (infoEl) {
      const latestRow = latestShareRow(d.series, lat.date);
      infoEl.innerHTML = shareRegressionInfoHTML(
        d.reg, latestRow.price_pred, lat.is_live ? lat.price_actual : latestRow.price, lat.is_live, lat.date,
        bseActiveDma, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, bseActiveLag
      );
    }
  }

  // Initial render
  refreshBSECharts();

  el.querySelectorAll('.bse-dma-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.bse-dma-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bseActiveDma = parseInt(btn.dataset.dma);
      refreshBSECharts();
    });
  });

  el.querySelectorAll('.bse-lag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.bse-lag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bseActiveLag = parseInt(btn.dataset.lag);
      refreshBSECharts();
    });
  });

  el.querySelectorAll('.bse-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.bse-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bseActiveRange = btn.dataset.range;
      refreshBSECharts();
    });
  });
}

// ========================
// BSE VALUATION MODEL — mirrors Excel "BSE" sheet, 7-part layout
// ========================

const BSE_VALUATION_DEFAULTS = {
  fy27TotalTradingDays:    247,
  adrGrowthBearPct:         -5,    // D30/E30/F30 in Excel — independent per scenario
  adrGrowthBasePct:          0,
  adrGrowthBullPct:          5,
  otherIncomeAnnualCr: 2055.39,
  patMarginAnnualPct:       52,
  peBear:                   40,
  peBase:                   45,
  peBull:                   50,
  discountPct:              18,
  sharesOutstandingCr:   40.73,

  q1TotalTradingDays:       61,
  otherIncomeQuarterlyCr: 472.16,
  patMarginQuarterlyPct:    50,
};

// Indian FY convention: Apr-Jun=Q1, Jul-Sep=Q2, Oct-Dec=Q3, Jan-Mar=Q4, FY named for the March-ending year
function currentFYQuarterLabel(d) {
  const month = d.getMonth(); // 0 = Jan
  const year  = d.getFullYear();
  const fyYear = month >= 3 ? year + 1 : year;
  const q = month >= 3 && month <= 5 ? 1 : month >= 6 && month <= 8 ? 2 : month >= 9 && month <= 11 ? 3 : 4;
  return { fy: `FY ${fyYear}`, quarter: `Q${q} FY ${fyYear}` };
}

function fmtChartDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  return d.toLocaleString('en-IN', { month: 'short', year: '2-digit' }).replace(' ', '-');
}
const BSE_VALUATION_STORAGE_KEY = 'bseValuationAssumptions_v1';

function loadBSEValuationAssumptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(BSE_VALUATION_STORAGE_KEY) || '{}');
    return { ...BSE_VALUATION_DEFAULTS, ...saved };
  } catch {
    return { ...BSE_VALUATION_DEFAULTS };
  }
}

function saveBSEValuationAssumptions(a) {
  try { localStorage.setItem(BSE_VALUATION_STORAGE_KEY, JSON.stringify(a)); } catch {}
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function bseDailySeries(rawData) {
  return (rawData?.daily_all || []).slice().sort((a, b) => a.date.localeCompare(b.date));
}

// Combined NSE+BSE total-market ADR and BSE's share of it, over a given set of BSE trading rows
function combinedMarketADRForRows(bseRows, nseSeries) {
  const nseByDate = new Map(nseSeries.map(r => [r.date, r.total_rev]));
  let bseSum = 0, totalSum = 0;
  bseRows.forEach(r => {
    const nseRev = nseByDate.get(r.date) || 0;
    bseSum   += r.total_rev || 0;
    totalSum += (r.total_rev || 0) + nseRev;
  });
  return { totalMarketADR: totalSum / (bseRows.length || 1), bseShare: totalSum ? bseSum / totalSum : 0 };
}

function combinedMarketADR(bseSeries, nseSeries, n) {
  return combinedMarketADRForRows(bseSeries.slice(-n), nseSeries);
}

// Method 1 extrapolates remaining days using the 45-day average BSE market share;
// Method 2 extrapolates remaining days using the 20-day average BSE market share.
function computeBSEAnnualPredictor(a, mkt) {
  const growth = { bear: a.adrGrowthBearPct / 100, base: a.adrGrowthBasePct / 100, bull: a.adrGrowthBullPct / 100 };
  const cmp = SHARE_DATA?.latest?.price_actual ?? null;
  const remainingDays = a.fy27TotalTradingDays - mkt.daysElapsed;
  const scenarios = {};
  ['bear', 'base', 'bull'].forEach(key => {
    const projectedTotalMarketADR = mkt.totalMarketADR45 * (1 + growth[key]);
    const targetADRMethod1 = ((mkt.bseADRFYTodate * mkt.daysElapsed) + (projectedTotalMarketADR * mkt.bseShare45 * remainingDays)) / a.fy27TotalTradingDays;
    // Used downstream, matches Excel row 37
    const targetADRMethod2 = ((mkt.bseADRFYTodate * mkt.daysElapsed) + (projectedTotalMarketADR * mkt.bseShare20 * remainingDays)) / a.fy27TotalTradingDays;
    const totalIncome = targetADRMethod2 * a.fy27TotalTradingDays + a.otherIncomeAnnualCr;
    const pat          = totalIncome * a.patMarginAnnualPct / 100;
    const eps           = pat / a.sharesOutstandingCr;
    const pe            = key === 'bear' ? a.peBear : key === 'bull' ? a.peBull : a.peBase;
    const priceTarget   = eps * pe;
    const targetPrice   = priceTarget / (1 + a.discountPct / 100);
    const upside        = cmp ? targetPrice / cmp - 1 : null;
    scenarios[key] = {
      growthPct: growth[key] * 100, projectedTotalMarketADR,
      targetADRMethod1, targetADRMethod2, totalIncome, pat, eps, pe, priceTarget, targetPrice, upside,
    };
  });
  return scenarios;
}

function computeBSEQuarterlyPredictor(a, mkt) {
  const remainingDays = Math.max(a.q1TotalTradingDays - mkt.qDaysElapsed, 0);
  // Used downstream, matches Excel's quarterly block
  const method1ADR = ((mkt.bseADRQtdToDate * mkt.qDaysElapsed) + (mkt.totalMarketADR45 * mkt.bseShare45 * remainingDays)) / (a.q1TotalTradingDays || 1);
  const method2ADR = ((mkt.bseADRQtdToDate * mkt.qDaysElapsed) + (mkt.totalMarketADR20 * mkt.bseShare20 * remainingDays)) / (a.q1TotalTradingDays || 1);
  const transactionRev = method1ADR * a.q1TotalTradingDays;
  const totalRevenue   = transactionRev + a.otherIncomeQuarterlyCr;
  const pat            = totalRevenue * a.patMarginQuarterlyPct / 100;
  return { method1ADR, method2ADR, transactionRev, otherIncome: a.otherIncomeQuarterlyCr, totalRevenue, pat };
}

function computeBSETriangulatedTarget(a, annualBase, analystTargets) {
  const cmp = SHARE_DATA?.latest?.price_actual ?? null;
  const regressionTarget = SHARE_DATA?.latest?.price_pred ?? null;
  const adrModel = annualBase?.targetPrice ?? null;
  const analystAvgRaw = analystTargets.length
    ? analystTargets.reduce((s, t) => s + t.target_price, 0) / analystTargets.length
    : null;
  const analystTarget = analystAvgRaw != null ? analystAvgRaw / (1 + a.discountPct / 100) : null;
  const values  = [adrModel, regressionTarget, analystTarget].filter(v => v != null);
  const average = values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
  const upside  = (average != null && cmp) ? average / cmp - 1 : null;
  return { cmp, adrModel, regressionTarget, analystAvgRaw, analystTarget, average, upside };
}

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

function bseAssumptionRow(label, key, value, suffix, step) {
  return `<div class="param-row">
    <label>${label}</label>
    <input type="number" step="${step ?? '0.1'}" class="param-input" data-bse-assump="${key}" value="${value}">
    ${suffix ? `<span class="param-suffix">${suffix}</span>` : ''}
  </div>`;
}

// Inline <input> for use directly inside an Excel-replica table cell — centered, unit-free
function bseCellInput(key, value, step) {
  return `<input type="number" step="${step ?? '0.1'}" class="param-input" style="width:80px;text-align:center" data-bse-assump="${key}" value="${value}">`;
}

function bseContextRow(label, valueHtml) {
  return `<tr><td>${label}</td><td style="text-align:center;font-variant-numeric:tabular-nums">${valueHtml}</td></tr>`;
}

// ── Quick Valuation (45-Day ADR → EPS → PE target) — shared by BSE & MCX ──────
// ADR always defaults to the trailing 45-day average revenue on load/refresh and
// is deliberately excluded from persistence; PAT margin, other income, and PE
// ratio persist per exchange via localStorage.
// NOTE: MCX has no prior valuation baseline in this codebase (unlike BSE's
// Excel-sourced figures) — its PAT margin/other income/PE defaults below are
// round-number placeholders, not real financial figures. Shares outstanding for
// both exchanges is sourced from yfinance (sharesOutstanding for BSE.NS/MCX.NS).
// NSE's 247.5 Cr is not a fresh guess — it's the implied share count (PAT/EPS)
// already baked into this codebase's own NSE PAT Prediction Engine data
// (dashboard/data/nse_dashboard_data.json's pnl/pnl_predicted_quarters), stable
// at ~247.4-247.7 Cr across every quarter checked.
const QUICK_VAL_SHARES_CR = { bse: 40.73, mcx: 25.45, nse: 247.5 };
const QUICK_VAL_DEFAULTS = {
  bse: { patMarginPct: 52, otherIncomeMode: 'fixed', otherIncomeCr: 2055.39, peBear: 40, peBase: 45, peBull: 50, tradingDays: 247 },
  // MCX runs a fuller trading calendar than the equity exchanges (fewer holidays) —
  // 243/251/257 trading days in FY24/FY25/FY26 respectively, a rising trend, so the
  // most recent completed year (257) is used rather than NSE/BSE's ~247.
  mcx: { patMarginPct: 50, otherIncomeMode: 'fixed', otherIncomeCr: 0,        peBear: 25, peBase: 30, peBull: 35, tradingDays: 257 },
  // NSE's other income is modeled as a % of total revenue (incl. other income)
  // rather than a fixed ₹Cr figure, per the user's explicit assumption. (NSE
  // listed 2026-09-24, so it now has a CMP like BSE/MCX.)
  nse: { patMarginPct: 55, otherIncomeMode: 'pctOfTotal', otherIncomePct: 30, peBear: 25, peBase: 35, peBull: 45, tradingDays: 247 },
};
const QUICK_VAL_SCENARIOS = ['bear', 'base', 'bull'];

function quickValStorageKey(exchange) { return `quickValuation_${exchange}_v1`; }

function loadQuickValAssumptions(exchange, defaultAdr) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(quickValStorageKey(exchange)) || '{}'); } catch {}
  // adr is intentionally excluded from what's restored — always the fresh 45-day average
  return { ...QUICK_VAL_DEFAULTS[exchange], ...saved, adr: defaultAdr };
}

function saveQuickValAssumptions(exchange, a) {
  const { adr, ...persisted } = a; // never persist adr
  try { localStorage.setItem(quickValStorageKey(exchange), JSON.stringify(persisted)); } catch {}
}

function computeQuickValuation(exchange, a, cmp) {
  const annualRevenue = a.adr * a.tradingDays;
  let otherIncomeCr, totalIncome;
  if (a.otherIncomeMode === 'pctOfTotal') {
    // otherIncome = pct% of (annualRevenue + otherIncome), solved algebraically:
    // otherIncome = annualRevenue * pct/(100-pct)
    const pct = Math.min(a.otherIncomePct, 99.9);
    otherIncomeCr = annualRevenue * (pct / (100 - pct));
    totalIncome   = annualRevenue + otherIncomeCr;
  } else {
    otherIncomeCr = a.otherIncomeCr;
    totalIncome   = annualRevenue + otherIncomeCr;
  }
  const pat            = totalIncome * a.patMarginPct / 100;
  const shares          = QUICK_VAL_SHARES_CR[exchange];
  const eps              = shares ? pat / shares : null;
  const scenarios = {};
  QUICK_VAL_SCENARIOS.forEach(key => {
    const pe          = a['pe' + key[0].toUpperCase() + key.slice(1)]; // peBear/peBase/peBull
    const targetPrice = eps != null ? eps * pe : null;
    const upside       = (targetPrice != null && cmp) ? targetPrice / cmp - 1 : null;
    scenarios[key] = { pe, targetPrice, upside };
  });
  return { annualRevenue, otherIncomeCr, totalIncome, pat, eps, cmp, scenarios };
}

function qvCellInput(exchange, key, value, step) {
  return `<input type="number" step="${step ?? '0.1'}" class="param-input" style="width:90px;text-align:center" data-qv-exch="${exchange}" data-qv-key="${key}" value="${value}">`;
}

// Renders the Quick Valuation panel into `el` and wires up its inputs.
// `dailySeries` = the exchange's sorted daily rows (drives the ADR default).
// `cmp` = current market price for the upside readout, may be null.
//
// ADR default = a projected full-year average for the current FY: actual
// reported revenue for trading days elapsed so far this FY, plus the trailing
// 45-day average revenue applied to the remaining trading days (per
// `tradingDays`), all divided by `tradingDays`. Only trading revenue is
// projected this way — Other Income keeps its existing (fixed or %-of-total)
// logic untouched.
function buildQuickValuationPanel(el, exchange, dailySeries, cmp) {
  if (!el) return;
  let a = loadQuickValAssumptions(exchange, 0); // peek tradingDays; adr set below

  const last45 = dailySeries.slice(-45);
  const adr45 = last45.length ? last45.reduce((s, r) => s + (r.total_rev || 0), 0) / last45.length : 0;

  const curFY = currentFYQuarterLabel(new Date()).fy;
  const fyRowsToDate = dailySeries.filter(r => r.fy === curFY);
  const daysElapsed = fyRowsToDate.length;
  const revenueToDate = fyRowsToDate.reduce((s, r) => s + (r.total_rev || 0), 0);
  const daysRemaining = Math.max(a.tradingDays - daysElapsed, 0);
  const projectedAnnualRevenue = revenueToDate + adr45 * daysRemaining;
  const defaultAdr = a.tradingDays ? projectedAnnualRevenue / a.tradingDays : adr45;

  a.adr = defaultAdr;
  let result = computeQuickValuation(exchange, a, cmp);

  const pctMode = a.otherIncomeMode === 'pctOfTotal';

  function updateOutputs() {
    const set = (id, html) => { const node = document.getElementById(id); if (node) node.innerHTML = html; };
    set(`qv-${exchange}-annualRevenue`, fmt(result.annualRevenue));
    if (pctMode) set(`qv-${exchange}-otherIncomeComputed`, fmt(result.otherIncomeCr));
    set(`qv-${exchange}-totalIncome`,   fmt(result.totalIncome));
    set(`qv-${exchange}-pat`,           fmt(result.pat));
    set(`qv-${exchange}-eps`,           result.eps != null ? '₹' + fmtNum(result.eps, 2) : '—');
    set(`qv-${exchange}-cmp`,           result.cmp != null ? fmtPrice(result.cmp) : '— (no price yet)');
    QUICK_VAL_SCENARIOS.forEach(key => {
      const s = result.scenarios[key];
      set(`qv-${exchange}-target-${key}`, s.targetPrice != null ? fmtPrice(s.targetPrice) : '—');
      set(`qv-${exchange}-upside-${key}`, fmtPctSigned(s.upside));
    });
  }

  const scenarioCols = QUICK_VAL_SCENARIOS.map(key => `
    <td style="text-align:center">${qvCellInput(exchange, 'pe' + key[0].toUpperCase() + key.slice(1), a['pe' + key[0].toUpperCase() + key.slice(1)], '1')}</td>`).join('');
  const targetCols = QUICK_VAL_SCENARIOS.map(key => `<td id="qv-${exchange}-target-${key}" style="text-align:center"></td>`).join('');
  const upsideCols = QUICK_VAL_SCENARIOS.map(key => `<td id="qv-${exchange}-upside-${key}" style="text-align:center"></td>`).join('');

  const otherIncomeRows = pctMode
    ? bseContextRow('Other Income (% of Total Revenue)', qvCellInput(exchange, 'otherIncomePct', a.otherIncomePct, '1'))
      + bseContextRow('Other Income, implied (₹ Cr)', `<span id="qv-${exchange}-otherIncomeComputed"></span>`)
    : bseContextRow('Other Income (₹ Cr)', qvCellInput(exchange, 'otherIncomeCr', a.otherIncomeCr, '1'));

  // EPS (and everything downstream of it) is built off the full projected FY
  // income, not a trailing/current-date run rate — so the target price is a
  // full-year-forward (FYxxE) target, not a spot fair value. Label it as such.
  const fyShort = curFY.match(/\d{4}/)[0].slice(-2);
  const fyeLabel = `FY${fyShort}E`;

  el.innerHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">Quick Valuation — ${curFY} Projected ADR <span class="chart-badge">Default</span></div>
    <p class="section-desc">ADR defaults to a projected full-year average for ${curFY} every time this page loads — actual reported revenue for the ${daysElapsed} trading day${daysElapsed === 1 ? '' : 's'} elapsed so far, plus the trailing 45-day average applied to the ${daysRemaining} remaining trading day${daysRemaining === 1 ? '' : 's'} (of ${a.tradingDays} assumed for the year). Edit it freely, it just won't be remembered on refresh. PAT margin, other income, PE ratios, and CMP-derived targets are saved.${pctMode ? ' Other income here is solved so it equals the given % of total revenue (transaction revenue + other income), not a flat add-on.' : ''}</p>
    <div style="overflow-x:auto;margin-bottom:var(--space-3)">
      <table class="data-table">
        <tbody>
          ${bseContextRow(`Average Daily Revenue — ${curFY} Projected (₹ Cr)`, qvCellInput(exchange, 'adr', fmtNum(a.adr, 2), '0.01'))}
          ${bseContextRow('Trading Days / Year', a.tradingDays)}
          ${bseContextRow('Annual Transaction Revenue (₹ Cr)', `<span id="qv-${exchange}-annualRevenue"></span>`)}
          ${otherIncomeRows}
          ${bseContextRow('Total Income (₹ Cr)', `<span id="qv-${exchange}-totalIncome"></span>`)}
          ${bseContextRow('PAT Margin (%)', qvCellInput(exchange, 'patMarginPct', a.patMarginPct, '0.5'))}
          ${bseContextRow('<strong>PAT (₹ Cr)</strong>', `<strong><span id="qv-${exchange}-pat"></span></strong>`)}
          ${bseContextRow(`<strong>Expected EPS — ${fyeLabel} (₹)</strong>`, `<strong><span id="qv-${exchange}-eps"></span></strong>`)}
          ${bseContextRow('CMP — Current Price Estimate (₹)', `<span id="qv-${exchange}-cmp"></span>`)}
        </tbody>
      </table>
    </div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Metric</th><th style="text-align:center">Bear</th><th style="text-align:center">Base</th><th style="text-align:center">Bull</th></tr></thead>
        <tbody>
          <tr><td>PE Ratio (x)</td>${scenarioCols}</tr>
          <tr style="font-weight:600"><td>Target Share Price — ${fyeLabel}<span style="font-weight:400;font-size:10px;color:var(--color-text-muted)"> (full-year forward, not spot)</span></td>${targetCols}</tr>
          <tr><td>Upside vs CMP</td>${upsideCols}</tr>
        </tbody>
      </table>
    </div>
  </div>`;

  updateOutputs();

  el.querySelectorAll(`[data-qv-exch="${exchange}"]`).forEach(input => {
    input.addEventListener('input', () => {
      a[input.dataset.qvKey] = parseFloat(input.value) || 0;
      result = computeQuickValuation(exchange, a, cmp);
      updateOutputs();
      saveQuickValAssumptions(exchange, a);
    });
  });
}

async function buildBSEValuation() {
  const el = document.getElementById('bseValuationContent');
  if (!el) return;

  if (!SHARE_DATA) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:48px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600">Valuation model needs share analysis data</div>
      <div style="font-size:12px;margin-top:6px">Run scripts/bse_share_analysis.py to generate bse_share_analysis.json</div>
    </div>`;
    return;
  }
  if (!MARKET_RAW.nse || !MARKET_RAW.bse) await preloadMarketData();

  const bseSeries = bseDailySeries(DATA);
  const nseSeries = bseDailySeries(MARKET_RAW.nse || {});
  const analystTargets = await loadBSEAnalystTargets();
  if (!bseSeries.length) { el.innerHTML = ''; return; }

  // Current FY/quarter is derived from today's real date, not the latest data row —
  // a quarter with data through its last trading day is a COMPLETED quarter, not the one in progress.
  const today    = currentFYQuarterLabel(new Date());
  const latestFY = today.fy;
  const latestQ  = today.quarter;
  const fyRows   = bseSeries.filter(r => r.fy === latestFY);
  const qRows    = bseSeries.filter(r => r.fy_quarter === latestQ);
  const avg      = (rows) => rows.length ? rows.reduce((s, r) => s + (r.total_rev || 0), 0) / rows.length : 0;
  const mktFY    = combinedMarketADRForRows(fyRows, nseSeries);
  const mkt45    = combinedMarketADR(bseSeries, nseSeries, 45);
  const mkt20    = combinedMarketADR(bseSeries, nseSeries, 20);

  const mkt = {
    daysElapsed:         fyRows.length,
    bseADRFYTodate:      avg(fyRows),
    bseADR45:            avg(bseSeries.slice(-45)),
    bseADR20:            avg(bseSeries.slice(-20)),
    totalMarketADRFY:    mktFY.totalMarketADR,
    totalMarketADR45:    mkt45.totalMarketADR,
    totalMarketADR20:    mkt20.totalMarketADR,
    bseShareFY:          mktFY.bseShare,
    bseShare45:          mkt45.bseShare,
    bseShare20:          mkt20.bseShare,
    qDaysElapsed:        qRows.length,
    bseADRQtdToDate:     avg(qRows),
  };

  let assumptions = loadBSEValuationAssumptions();
  let annual, quarterly, tri;
  function recompute() {
    annual    = computeBSEAnnualPredictor(assumptions, mkt);
    quarterly = computeBSEQuarterlyPredictor(assumptions, mkt);
    tri       = computeBSETriangulatedTarget(assumptions, annual.base, analystTargets);
  }
  recompute();

  function updateOutputs() {
    const set = (id, html) => { const e = document.getElementById(id); if (e) e.innerHTML = html; };
    set('triAdrModel',   tri.adrModel        != null ? fmtPrice(tri.adrModel)        : '—');
    set('triRegression', tri.regressionTarget != null ? fmtPrice(tri.regressionTarget) : '—');
    set('triAnalyst',    tri.analystTarget    != null ? fmtPrice(tri.analystTarget)    : '—');
    set('triAverage',    tri.average          != null ? fmtPrice(tri.average)          : '—');
    set('triCmp',        tri.cmp              != null ? fmtPrice(tri.cmp)              : '—');
    set('triUpside',     fmtPctSigned(tri.upside));

    set('annCtxDaysElapsed', `${mkt.daysElapsed} of ${assumptions.fy27TotalTradingDays}`);
    ['bear', 'base', 'bull'].forEach(k => {
      const s = annual[k];
      set(`annProjADR-${k}`, fmtNum(s.projectedTotalMarketADR, 2));
      set(`annM1-${k}`,      fmtNum(s.targetADRMethod1, 2));
      set(`annM2-${k}`,      fmtNum(s.targetADRMethod2, 2));
      set(`annIncome-${k}`,  fmt(s.totalIncome));
      set(`annPat-${k}`,     fmt(s.pat));
      set(`annEps-${k}`,     '₹' + fmtNum(s.eps, 2));
      set(`annPriceT-${k}`,  fmtPrice(s.priceTarget));
      set(`annTarget-${k}`,  fmtPrice(s.targetPrice));
      set(`annUpside-${k}`,  fmtPctSigned(s.upside));
    });

    set('qtrCtxDaysElapsed', `${mkt.qDaysElapsed} of ${assumptions.q1TotalTradingDays}`);
    set('qtrM1',       fmtNum(quarterly.method1ADR, 2));
    set('qtrM2',       fmtNum(quarterly.method2ADR, 2));
    set('qtrTxnRev',   fmt(quarterly.transactionRev));
    set('qtrTotalRev', fmt(quarterly.totalRevenue));
    set('qtrPat',      fmt(quarterly.pat));
  }

  const analystRows = analystTargets.map(t => `
    <tr>
      <td>${t.broker}</td>
      <td>${t.rating}</td>
      <td>₹ ${fmtNum(t.target_price, 0)}</td>
      <td>${t.date}</td>
      <td style="color:var(--color-text-muted);font-size:11.5px">${t.methodology}</td>
    </tr>`).join('');

  el.innerHTML = `
  <div id="bseQuickValPanel"></div>
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">1 · Triangulated Target Price <span class="chart-badge">Live</span></div>
    <p class="section-desc">Average of the ADR (Annual Predictor Base case), 45-day regression, and analyst-consensus target prices, shown against CMP.</p>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:var(--space-3);margin-top:var(--space-3)">
      ${kpi('ADR Model', `<span id="triAdrModel"></span>`, 'Annual Predictor · Base', '')}
      ${kpi('Regression', `<span id="triRegression"></span>`, '45-day DMA model', '')}
      ${kpi('Analyst Target', `<span id="triAnalyst"></span>`, `avg of ${analystTargets.length} brokers, discounted`, '')}
      ${kpi('Average Target', `<span id="triAverage"></span>`, `<span id="triUpside"></span> vs CMP`, '')}
      ${kpi('CMP', `<span id="triCmp"></span>`, SHARE_DATA?.latest?.is_live ? '🟢 live' : 'latest close', '')}
    </div>
  </div>

  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">2 &amp; 3 · Annual Predictor — ${latestFY} <span class="chart-badge">Bear / Base / Bull</span></div>
    <p class="section-desc">Same layout and formulas as the Excel "Annual Predictor" block. Editable cells are inputs — everything else recomputes automatically.</p>
    <div style="overflow-x:auto;margin-bottom:var(--space-3)">
      <table class="data-table">
        <tbody>
          ${bseContextRow('FY Total Trading Days', bseCellInput('fy27TotalTradingDays', assumptions.fy27TotalTradingDays, '1'))}
          ${bseContextRow('FY Trading Days Elapsed', `<span id="annCtxDaysElapsed"></span>`)}
          ${bseContextRow('Shares Outstanding (Cr)', bseCellInput('sharesOutstandingCr', assumptions.sharesOutstandingCr, '0.01'))}
          ${bseContextRow('Total Market ADR — FY to Date (₹ Cr/day)', fmtNum(mkt.totalMarketADRFY, 2))}
          ${bseContextRow('Total Market ADR — Last 45 Days (₹ Cr/day)', fmtNum(mkt.totalMarketADR45, 2))}
          ${bseContextRow('Total Market ADR — Last 20 Days (₹ Cr/day)', fmtNum(mkt.totalMarketADR20, 2))}
          ${bseContextRow('BSE Market Share — FY to Date', fmtPctRaw(mkt.bseShareFY * 100))}
          ${bseContextRow('BSE Market Share — Last 45 Days', fmtPctRaw(mkt.bseShare45 * 100))}
          ${bseContextRow('BSE Market Share — Last 20 Days', fmtPctRaw(mkt.bseShare20 * 100))}
          ${bseContextRow('BSE ADR — FY to Date (₹ Cr/day)', fmtNum(mkt.bseADRFYTodate, 2))}
          ${bseContextRow('BSE ADR — Last 45 Days (₹ Cr/day)', fmtNum(mkt.bseADR45, 2))}
          ${bseContextRow('BSE ADR — Last 20 Days (₹ Cr/day)', fmtNum(mkt.bseADR20, 2))}
        </tbody>
      </table>
    </div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Metric</th><th style="text-align:center">Bear</th><th style="text-align:center">Base</th><th style="text-align:center">Bull</th></tr></thead>
        <tbody>
          <tr>
            <td>Total Market ADR Growth (%)</td>
            <td style="text-align:center">${bseCellInput('adrGrowthBearPct', assumptions.adrGrowthBearPct, '0.5')}</td>
            <td style="text-align:center">${bseCellInput('adrGrowthBasePct', assumptions.adrGrowthBasePct, '0.5')}</td>
            <td style="text-align:center">${bseCellInput('adrGrowthBullPct', assumptions.adrGrowthBullPct, '0.5')}</td>
          </tr>
          <tr><td>Projected Total Market ADR (₹ Cr/day)</td><td id="annProjADR-bear" style="text-align:center"></td><td id="annProjADR-base" style="text-align:center"></td><td id="annProjADR-bull" style="text-align:center"></td></tr>
          <tr style="color:var(--color-text-muted)"><td>BSE Target ADR (₹ Cr/day) — Method 1, 45-day share <span style="font-size:10px">(informational)</span></td><td id="annM1-bear" style="text-align:center"></td><td id="annM1-base" style="text-align:center"></td><td id="annM1-bull" style="text-align:center"></td></tr>
          <tr><td>BSE Target ADR (₹ Cr/day) — Method 2, 20-day share <span style="font-size:10px;color:var(--color-text-muted)">(used)</span></td><td id="annM2-bear" style="text-align:center"></td><td id="annM2-base" style="text-align:center"></td><td id="annM2-bull" style="text-align:center"></td></tr>
          <tr>
            <td>Other Income — Annual (₹ Cr, same for all scenarios)</td>
            <td colspan="3" style="text-align:center">${bseCellInput('otherIncomeAnnualCr', assumptions.otherIncomeAnnualCr, '1')}</td>
          </tr>
          <tr><td>Total Income</td><td id="annIncome-bear" style="text-align:center"></td><td id="annIncome-base" style="text-align:center"></td><td id="annIncome-bull" style="text-align:center"></td></tr>
          <tr>
            <td>PAT Margin (%, same for all scenarios)</td>
            <td colspan="3" style="text-align:center">${bseCellInput('patMarginAnnualPct', assumptions.patMarginAnnualPct, '0.5')}</td>
          </tr>
          <tr><td>PAT</td><td id="annPat-bear" style="text-align:center"></td><td id="annPat-base" style="text-align:center"></td><td id="annPat-bull" style="text-align:center"></td></tr>
          <tr><td>EPS</td><td id="annEps-bear" style="text-align:center"></td><td id="annEps-base" style="text-align:center"></td><td id="annEps-bull" style="text-align:center"></td></tr>
          <tr>
            <td>PE (x)</td>
            <td style="text-align:center">${bseCellInput('peBear', assumptions.peBear, '1')}</td>
            <td style="text-align:center">${bseCellInput('peBase', assumptions.peBase, '1')}</td>
            <td style="text-align:center">${bseCellInput('peBull', assumptions.peBull, '1')}</td>
          </tr>
          <tr><td>Price Target ${latestFY}</td><td id="annPriceT-bear" style="text-align:center"></td><td id="annPriceT-base" style="text-align:center"></td><td id="annPriceT-bull" style="text-align:center"></td></tr>
          <tr>
            <td>Discount Rate (%, same for all scenarios)</td>
            <td colspan="3" style="text-align:center">${bseCellInput('discountPct', assumptions.discountPct, '0.5')}</td>
          </tr>
          <tr style="font-weight:600"><td>Target Price</td><td id="annTarget-bear" style="text-align:center"></td><td id="annTarget-base" style="text-align:center"></td><td id="annTarget-bull" style="text-align:center"></td></tr>
          <tr><td>Upside vs CMP</td><td id="annUpside-bear" style="text-align:center"></td><td id="annUpside-base" style="text-align:center"></td><td id="annUpside-bull" style="text-align:center"></td></tr>
        </tbody>
      </table>
    </div>
    <button class="share-range-btn" id="bseValuationReset" style="margin-top:var(--space-3)">Reset to Excel defaults</button>
  </div>

  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">4 · Quarterly Predictor — ${latestQ}</div>
    <p class="section-desc">Same layout as Excel's "Quarterly Predictor" — stops at PAT, doesn't carry through to EPS/PE.</p>
    <div style="overflow-x:auto">
      <table class="data-table">
        <tbody>
          ${bseContextRow('Quarter Total Trading Days', bseCellInput('q1TotalTradingDays', assumptions.q1TotalTradingDays, '1'))}
          ${bseContextRow('Quarter Trading Days Elapsed', `<span id="qtrCtxDaysElapsed"></span>`)}
          ${bseContextRow('BSE Target ADR (₹ Cr/day) — Method 1, 45-day share <span style="font-size:10px;color:var(--color-text-muted)">(used)</span>', `<span id="qtrM1"></span>`)}
          ${bseContextRow('BSE Target ADR (₹ Cr/day) — Method 2, 20-day share <span style="font-size:10px;color:var(--color-text-muted)">(informational)</span>', `<span id="qtrM2"></span>`)}
          ${bseContextRow('Transaction Revenue (₹ Cr)', `<span id="qtrTxnRev"></span>`)}
          ${bseContextRow('Other Income — Quarter (₹ Cr)', bseCellInput('otherIncomeQuarterlyCr', assumptions.otherIncomeQuarterlyCr, '1'))}
          ${bseContextRow('Total Revenue (₹ Cr)', `<span id="qtrTotalRev"></span>`)}
          ${bseContextRow('PAT Margin — Quarter (%)', bseCellInput('patMarginQuarterlyPct', assumptions.patMarginQuarterlyPct, '0.5'))}
          ${bseContextRow('<strong>PAT (₹ Cr)</strong>', `<strong><span id="qtrPat"></span></strong>`)}
        </tbody>
      </table>
    </div>
  </div>

  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">1 (cont.) · Analyst Targets</div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Broker</th><th>Rating</th><th>Target</th><th>Date</th><th>Methodology</th></tr></thead>
        <tbody>${analystRows || '<tr><td colspan="5" style="color:var(--color-text-muted)">No analyst targets on file — add to dashboard/data/bse_analyst_targets.json</td></tr>'}</tbody>
      </table>
    </div>
  </div>

  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">5 · Revenue Trend Tables</div>
    <p class="section-desc">FY / Quarterly / Monthly / Weekly, YoY / QoQ / MoM / WoW — see also the Revenue Summary tab.</p>
    <div id="bseValTrendTables"></div>
  </div>

  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">6 &amp; 7 · 10-Day vs 45-Day DMA Revenue</div>
    <p class="section-desc">See the Regression tab for the 45/20/10-day DMA regression, Price÷DMA ratio bands, and scatter charts.</p>
    <div class="chart-wrapper"><canvas id="chartBse10v45"></canvas></div>
  </div>

  <div class="chart-panel">
    <div class="chart-title">6 (cont.) · Log-Scale DMA Revenue vs Share Price</div>
    <div class="chart-grid chart-grid-2">
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--color-text-muted);margin-bottom:6px">Jun 2023 onwards</div>
        <div class="chart-wrapper"><canvas id="chartBseLogLog1"></canvas></div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--color-text-muted);margin-bottom:6px">Apr 2024 onwards</div>
        <div class="chart-wrapper"><canvas id="chartBseLogLog2"></canvas></div>
      </div>
    </div>
  </div>`;

  updateOutputs();
  buildQuickValuationPanel(el.querySelector('#bseQuickValPanel'), 'bse', bseSeries, tri.cmp);
  el.querySelector('#bseValTrendTables').innerHTML =
    xlStaticSegmentBlock(ENRICHED_DATA.summary_total, 'Total') +
    xlStaticSegmentBlock(ENRICHED_DATA.seg_options, 'Options') +
    xlStaticSegmentBlock(ENRICHED_DATA.seg_cash, 'Cash');

  const debouncedSave = debounce(() => saveBSEValuationAssumptions(assumptions), 500);
  el.querySelectorAll('[data-bse-assump]').forEach(input => {
    input.addEventListener('input', () => {
      assumptions[input.dataset.bseAssump] = parseFloat(input.value) || 0;
      recompute();
      updateOutputs();
      debouncedSave();
    });
  });
  const resetBtn = document.getElementById('bseValuationReset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    assumptions = { ...BSE_VALUATION_DEFAULTS };
    saveBSEValuationAssumptions(assumptions);
    buildBSEValuation();
  });

  buildBSEDMADiagnosticCharts(bseSeries);
}

function buildBSEDMADiagnosticCharts(bseSeries) {
  const regStart = SHARE_DATA.regression_start || '2025-03-01';
  const d10 = buildSeriesWithDMA(SHARE_DATA.series, 10, regStart);
  const d45 = buildSeriesWithDMA(SHARE_DATA.series, 45, regStart);
  if (!d10 || !d45) return;

  ['bse10v45', 'bseLogLog1', 'bseLogLog2'].forEach(k => {
    if (charts[k]) { charts[k].destroy(); charts[k] = null; }
  });

  // ── 10-vs-45 DMA revenue overlay ──
  const byDate10 = new Map(d10.series.map(r => [r.date, r.rev_ma]));
  const merged = d45.series.filter(r => byDate10.has(r.date));
  setCanvasHeight('chartBse10v45', 280);
  charts.bse10v45 = new Chart(document.getElementById('chartBse10v45'), {
    type: 'line',
    data: {
      labels: merged.map(r => fmtChartDate(r.date)),
      datasets: [
        { label: '45-Day MA Revenue', data: merged.map(r => r.rev_ma), borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.25 },
        { label: '10-Day MA Revenue', data: merged.map(r => byDate10.get(r.date)), borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.25 },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 2) + ' Cr' } } },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) + ' Cr' } }
      }
    }
  });

  // ── Log-scale DMA Revenue vs Price, two eras ──
  const eras = [
    { key: 'bseLogLog1', canvasId: 'chartBseLogLog1', start: '2023-06-01' },
    { key: 'bseLogLog2', canvasId: 'chartBseLogLog2', start: '2024-04-01' },
  ];
  eras.forEach(era => {
    const ser = d45.series.filter(r => r.date >= era.start);
    if (!ser.length) return;
    setCanvasHeight(era.canvasId, 260);
    charts[era.key] = new Chart(document.getElementById(era.canvasId), {
      type: 'line',
      data: {
        labels: ser.map(r => fmtChartDate(r.date)),
        datasets: [
          { label: '45-Day MA Revenue (₹ Cr)', data: ser.map(r => r.rev_ma), borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'yRev' },
          { label: 'Share Price (₹)', data: ser.map(r => r.price), borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, yAxisID: 'yPrice' },
        ]
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { ticks: { maxTicksLimit: 8, font: { size: 9 } } },
          yRev:   { type: 'logarithmic', position: 'left',  ticks: { font: { size: 9 }, callback: v => fmtNum(v, 0) } },
          yPrice: { type: 'logarithmic', position: 'right', ticks: { font: { size: 9 }, callback: v => fmtNum(v, 0) }, grid: { drawOnChartArea: false } },
        }
      }
    });
  });
}

function buildMCXCharts(viewSer, reg, maWin) {
  ['mcxSharePrice', 'mcxRevMaVsPrice', 'mcxRatioSD', 'mcxShareScatter'].forEach(k => {
    if (charts[k]) { charts[k].destroy(); charts[k] = null; }
  });
  if (!viewSer.length) return;

  const labels  = viewSer.map(r => fmtChartDate(r.date));
  const actuals = viewSer.map(r => r.price);
  const preds   = viewSer.map(r => r.price_pred);
  const revMA   = viewSer.map(r => r.rev_ma);
  const revRaw  = viewSer.map(r => r.revenue_cr);

  setCanvasHeight('chartMcxSharePrice', 280);
  charts.mcxSharePrice = new Chart(document.getElementById('chartMcxSharePrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual Price',    data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2,   pointRadius: 0, tension: 0.2 },
        { label: 'Model Prediction', data: preds,  borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [5, 3] },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0) } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });

  setCanvasHeight('chartMcxRevMaVsPrice', 300);
  charts.mcxRevMaVsPrice = new Chart(document.getElementById('chartMcxRevMaVsPrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: maWin + '-Day MA Revenue (₹ Cr)', data: revMA,   borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yRev' },
        { label: 'MCX Share Price (₹)',             data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yPrice' },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.yAxisID === 'yRev'
              ? ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 2) + ' Cr'
              : ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0)
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        yRev: {
          type: 'linear', position: 'left',
          title: { display: true, text: maWin + '-Day MA Rev (₹ Cr)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 1) + ' Cr', font: { size: 10 } },
        },
        yPrice: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'Share Price (₹)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 10 } },
          grid: { drawOnChartArea: false },
        },
      }
    }
  });

  const ratios = viewSer.map(r => r.price / r.rev_ma);
  const n      = ratios.length;
  const mean   = ratios.reduce((a, b) => a + b, 0) / n;
  const std    = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const flat   = val => viewSer.map(() => val);
  const sdBandOuter = CHART_COLORS[0] + '18';
  const sdBandInner = CHART_COLORS[0] + '30';
  const sdLineOuter = CHART_COLORS[0] + '55';
  const sdLineInner = CHART_COLORS[0] + '80';

  setCanvasHeight('chartMcxRatioSD', 300);
  charts.mcxRatioSD = new Chart(document.getElementById('chartMcxRatioSD'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '+2σ',          data: flat(mean + 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 4 }, backgroundColor: sdBandOuter },
        { label: '+1σ',          data: flat(mean + std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 3 }, backgroundColor: sdBandInner },
        { label: 'Mean',         data: flat(mean),           borderColor: CHART_COLORS[4], borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−1σ',          data: flat(mean - std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−2σ',          data: flat(mean - 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: 'Price / Rev MA', data: ratios, borderColor: CHART_COLORS[1], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw.toFixed(1);
              if (ctx.dataset.label === 'Price / Rev MA') {
                const zVal = (ctx.raw - mean) / std;
                return `Ratio: ${v}  (${zVal >= 0 ? '+' : ''}${zVal.toFixed(1)}σ)`;
              }
              const target = ctx.raw * revMA[ctx.dataIndex];
              return `${ctx.dataset.label}: ${v}  →  ₹${fmtNum(target, 0)} target`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: {
          ticks: { font: { size: 10 }, callback: v => v.toFixed(0) },
          title: { display: true, text: 'Price ÷ Rev MA' + maWin, font: { size: 10 } },
        }
      }
    }
  });

  const scatterData = viewSer.map(r => ({ x: r.rev_ma, y: r.price }));
  const xVals = viewSer.map(r => r.rev_ma);
  const xMin  = Math.min(...xVals);
  const xMax  = Math.max(...xVals);
  const regLine = [
    { x: xMin, y: reg.slope * xMin + reg.intercept },
    { x: xMax, y: reg.slope * xMax + reg.intercept },
  ];

  setCanvasHeight('chartMcxShareScatter', 260);
  charts.mcxShareScatter = new Chart(document.getElementById('chartMcxShareScatter'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Price vs Rev MA',  data: scatterData, backgroundColor: CHART_COLORS[0] + '88', pointRadius: 3 },
        { label: 'Regression Line', data: regLine, type: 'line', borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 0 },
      ]
    },
    options: {
      plugins: {
        tooltip: { callbacks: { label: ctx => `Rev MA${maWin}: ₹${fmtNum(ctx.parsed.x, 1)} Cr | Price: ₹${fmtNum(ctx.parsed.y, 0)}` } }
      },
      scales: {
        x: { title: { display: true, text: maWin + '-Day MA Revenue (₹ Cr)' }, ticks: { callback: v => '₹' + fmtNum(v, 1) } },
        y: { title: { display: true, text: 'MCX Share Price (₹)' },            ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });
}

function buildMCXShareAnalysis() {
  const el = document.getElementById('mcx-share-inner');
  if (!el) return;

  if (!SHARE_DATA) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:48px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Share analytics data not available</div>
      <div style="font-size:12px">Run scripts/mcx_share_analysis.py to generate mcx_share_analysis.json</div>
    </div>`;
    return;
  }

  const reg      = SHARE_DATA.regression;
  const lat      = SHARE_DATA.latest;
  const ser      = SHARE_DATA.series || [];
  const maWin    = SHARE_DATA.ma_window;
  const regStart = SHARE_DATA.regression_start || '2025-01-01';

  const infoHTML = shareRegressionInfoHTML(
    reg, lat.price_pred, lat.price_actual, lat.is_live, lat.date,
    maWin, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, 0
  );

  const regLabel = new Date(regStart + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' }) + '+';
  const ranges = [
    { key: '1m',      label: '1M' },
    { key: '3m',      label: '3M' },
    { key: '6m',      label: '6M' },
    { key: 'nov2024', label: regLabel },
    { key: '1y',      label: '1Y' },
    { key: '2y',      label: '2Y' },
  ];
  const rangeToggleHTML = `
  <div class="share-range-toggle">
    ${ranges.map(r => `<button class="share-range-btn mcx-range-btn${r.key === 'nov2024' ? ' active' : ''}" data-range="${r.key}">${r.label}</button>`).join('')}
  </div>`;

  const dmaToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">DMA</span>
    ${[10, 20, 45].map(w => `<button class="share-range-btn mcx-dma-btn${w === 45 ? ' active' : ''}" data-dma="${w}">${w}D</button>`).join('')}
  </div>`;

  const lagToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">Lag</span>
    ${[0, 45, 60, 90].map(l => `<button class="share-range-btn mcx-lag-btn${l === 0 ? ' active' : ''}" data-lag="${l}">${l === 0 ? 'None' : l + 'D'}</button>`).join('')}
  </div>`;

  const chartsHTML = `
  <div style="margin-top:var(--space-4)">
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title">MCX Share Price: Actual vs Model</div>
      <div class="chart-wrapper"><canvas id="chartMcxSharePrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="mcxDmaChartTitle">${maWin}-Day MA Revenue vs MCX Share Price</div>
      <div class="chart-wrapper"><canvas id="chartMcxRevMaVsPrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="mcxRatioChartTitle">Price ÷ Rev MA${maWin} Ratio — Mean ± SD</div>
      <div class="chart-wrapper"><canvas id="chartMcxRatioSD"></canvas></div>
    </div>
    <div class="chart-panel">
      <div class="chart-title">Revenue → Price Scatter</div>
      <div class="chart-wrapper" style="max-height:300px"><canvas id="chartMcxShareScatter"></canvas></div>
    </div>
  </div>`;

  const sectionHTML = `
  <div style="margin-top:var(--space-5)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:1px solid var(--color-border)">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted)">Charts</span>
        ${dmaToggleHTML}
        ${lagToggleHTML}
      </div>
      ${rangeToggleHTML}
    </div>
    ${chartsHTML}
  </div>`;

  el.innerHTML = `<div id="mcxShareInfo">${infoHTML}</div>` + sectionHTML;

  let mcxActiveDma   = 45;
  let mcxActiveLag   = 0;
  let mcxActiveRange = 'nov2024';
  const mcxDmaCache  = { '45_0': { series: ser, reg } };

  function getMcxDmaData(w, lag) {
    const key = `${w}_${lag}`;
    if (!mcxDmaCache[key]) mcxDmaCache[key] = buildSeriesWithDMA(ser, w, regStart, lag);
    return mcxDmaCache[key];
  }

  function refreshMCXCharts() {
    const d = getMcxDmaData(mcxActiveDma, mcxActiveLag);
    if (!d) return;
    buildMCXCharts(filterShareSeries(d.series, mcxActiveRange, regStart), d.reg, mcxActiveDma);
    const lagSuffix = mcxActiveLag ? ` (lag ${mcxActiveLag}d)` : '';
    const t1 = document.getElementById('mcxDmaChartTitle');
    if (t1) t1.textContent = `${mcxActiveDma}-Day MA Revenue vs MCX Share Price${lagSuffix}`;
    const t2 = document.getElementById('mcxRatioChartTitle');
    if (t2) t2.textContent = `Price ÷ Rev MA${mcxActiveDma} Ratio — Mean ± SD${lagSuffix}`;
    const infoEl = document.getElementById('mcxShareInfo');
    if (infoEl) {
      const latestRow = latestShareRow(d.series, lat.date);
      infoEl.innerHTML = shareRegressionInfoHTML(
        d.reg, latestRow.price_pred, lat.is_live ? lat.price_actual : latestRow.price, lat.is_live, lat.date,
        mcxActiveDma, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, mcxActiveLag
      );
    }
  }

  refreshMCXCharts();

  el.querySelectorAll('.mcx-dma-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.mcx-dma-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mcxActiveDma = parseInt(btn.dataset.dma);
      refreshMCXCharts();
    });
  });

  el.querySelectorAll('.mcx-lag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.mcx-lag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mcxActiveLag = parseInt(btn.dataset.lag);
      refreshMCXCharts();
    });
  });

  el.querySelectorAll('.mcx-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.mcx-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mcxActiveRange = btn.dataset.range;
      refreshMCXCharts();
    });
  });
}

// ========================
// NSE SHARE ANALYTICS — cloned from the MCX block above (same layout/behaviour).
// NSE listed 2026-09-24; see renderNSECollecting for the pre-regression state.
// ========================

// NSE listed on 2026-09-24, so there is no price history to regress against yet.
// Until nse_share_analysis.json reaches status="ready" (min_days_required trading
// days) this shows collection progress plus the raw price / revenue-MA rows.
function renderNSECollecting(el) {
  const s      = SHARE_DATA;
  const n      = s.n_days || 0;
  const need   = s.min_days_required || 20;
  const lat    = s.latest || {};
  const pct    = Math.min(100, Math.round(n / need * 100));
  const sinceListing = s.first_price && lat.price_actual ? (lat.price_actual / s.first_price - 1) : null;

  const rows = [...(s.series || [])].reverse().map(r => `
    <tr>
      <td>${r.date}</td>
      <td class="wire-value">₹${fmtNum(r.price, 2)}</td>
      <td class="wire-value">${fmtNum(r.revenue_cr, 2)}</td>
      <td class="wire-value">${fmtNum(r.rev_ma, 2)}</td>
    </tr>`).join('');

  el.innerHTML = `
  <div class="share-kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);margin-bottom:var(--space-4)">
    ${kpi('Days Collected', `${n} / ${need}`, 'regression starts at ' + need + ' trading days', '')}
    ${kpi(lat.is_live ? 'Share Price 🟢 Live' : 'Share Price', '₹' + fmtNum(lat.price_actual, 2), 'ticker ' + s.ticker, '')}
    ${kpi('Since Listing', sinceListing == null ? '—' : fmtPctSigned(sinceListing), 'vs first close ₹' + fmtNum(s.first_price, 2), sinceListing == null ? '' : (sinceListing >= 0 ? 'positive' : 'negative'))}
    ${kpi('Listed On', s.listing_date, 'NSE (National Stock Exchange of India)', '')}
  </div>
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:20px 24px">
    <div class="chart-title">Collecting price history</div>
    <p class="section-desc">NSE shares only started trading on ${s.listing_date}, so there aren't enough price observations to fit a revenue → price regression yet. Daily closes are being collected automatically; once ${need} trading days are available the regression, charts and predicted price appear here on their own (using the 45-day revenue moving average, same as BSE and MCX).</p>
    <div style="height:10px;border-radius:5px;background:var(--color-border);overflow:hidden;margin-top:12px">
      <div style="height:100%;width:${pct}%;background:${CHART_COLORS[0]}"></div>
    </div>
    <div style="font-size:11px;color:var(--color-text-muted);margin-top:6px">${n} of ${need} trading days · ${pct}%</div>
  </div>
  <div class="chart-panel">
    <div class="chart-title">Daily closes since listing</div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Close</th><th>Revenue (₹ Cr)</th><th>45D Rev MA (₹ Cr)</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="color:var(--color-text-muted)">No overlapping price / revenue days yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

function buildNSECharts(viewSer, reg, maWin) {
  ['nseSharePrice', 'nseRevMaVsPrice', 'nseRatioSD', 'nseShareScatter'].forEach(k => {
    if (charts[k]) { charts[k].destroy(); charts[k] = null; }
  });
  if (!viewSer.length) return;

  const labels  = viewSer.map(r => fmtChartDate(r.date));
  const actuals = viewSer.map(r => r.price);
  const preds   = viewSer.map(r => r.price_pred);
  const revMA   = viewSer.map(r => r.rev_ma);
  const revRaw  = viewSer.map(r => r.revenue_cr);

  setCanvasHeight('chartNseSharePrice', 280);
  charts.nseSharePrice = new Chart(document.getElementById('chartNseSharePrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Actual Price',    data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2,   pointRadius: 0, tension: 0.2 },
        { label: 'Model Prediction', data: preds,  borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [5, 3] },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0) } } },
      scales: {
        x: { ticks: { maxTicksLimit: 8, font: { size: 10 } } },
        y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });

  setCanvasHeight('chartNseRevMaVsPrice', 300);
  charts.nseRevMaVsPrice = new Chart(document.getElementById('chartNseRevMaVsPrice'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: maWin + '-Day MA Revenue (₹ Cr)', data: revMA,   borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yRev' },
        { label: 'NSE Share Price (₹)',             data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yPrice' },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.yAxisID === 'yRev'
              ? ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 2) + ' Cr'
              : ctx.dataset.label + ': ₹' + fmtNum(ctx.raw, 0)
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        yRev: {
          type: 'linear', position: 'left',
          title: { display: true, text: maWin + '-Day MA Rev (₹ Cr)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 1) + ' Cr', font: { size: 10 } },
        },
        yPrice: {
          type: 'linear', position: 'right',
          title: { display: true, text: 'Share Price (₹)', font: { size: 10 } },
          ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 10 } },
          grid: { drawOnChartArea: false },
        },
      }
    }
  });

  const ratios = viewSer.map(r => r.price / r.rev_ma);
  const n      = ratios.length;
  const mean   = ratios.reduce((a, b) => a + b, 0) / n;
  const std    = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const flat   = val => viewSer.map(() => val);
  const sdBandOuter = CHART_COLORS[0] + '18';
  const sdBandInner = CHART_COLORS[0] + '30';
  const sdLineOuter = CHART_COLORS[0] + '55';
  const sdLineInner = CHART_COLORS[0] + '80';

  setCanvasHeight('chartNseRatioSD', 300);
  charts.nseRatioSD = new Chart(document.getElementById('chartNseRatioSD'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '+2σ',          data: flat(mean + 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 4 }, backgroundColor: sdBandOuter },
        { label: '+1σ',          data: flat(mean + std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 3 }, backgroundColor: sdBandInner },
        { label: 'Mean',         data: flat(mean),           borderColor: CHART_COLORS[4], borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−1σ',          data: flat(mean - std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: '−2σ',          data: flat(mean - 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
        { label: 'Price / Rev MA', data: ratios, borderColor: CHART_COLORS[1], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        tooltip: {
          callbacks: {
            label: ctx => {
              const v = ctx.raw.toFixed(1);
              if (ctx.dataset.label === 'Price / Rev MA') {
                const zVal = (ctx.raw - mean) / std;
                return `Ratio: ${v}  (${zVal >= 0 ? '+' : ''}${zVal.toFixed(1)}σ)`;
              }
              const target = ctx.raw * revMA[ctx.dataIndex];
              return `${ctx.dataset.label}: ${v}  →  ₹${fmtNum(target, 0)} target`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: {
          ticks: { font: { size: 10 }, callback: v => v.toFixed(0) },
          title: { display: true, text: 'Price ÷ Rev MA' + maWin, font: { size: 10 } },
        }
      }
    }
  });

  const scatterData = viewSer.map(r => ({ x: r.rev_ma, y: r.price }));
  const xVals = viewSer.map(r => r.rev_ma);
  const xMin  = Math.min(...xVals);
  const xMax  = Math.max(...xVals);
  const regLine = [
    { x: xMin, y: reg.slope * xMin + reg.intercept },
    { x: xMax, y: reg.slope * xMax + reg.intercept },
  ];

  setCanvasHeight('chartNseShareScatter', 260);
  charts.nseShareScatter = new Chart(document.getElementById('chartNseShareScatter'), {
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Price vs Rev MA',  data: scatterData, backgroundColor: CHART_COLORS[0] + '88', pointRadius: 3 },
        { label: 'Regression Line', data: regLine, type: 'line', borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 0 },
      ]
    },
    options: {
      plugins: {
        tooltip: { callbacks: { label: ctx => `Rev MA${maWin}: ₹${fmtNum(ctx.parsed.x, 1)} Cr | Price: ₹${fmtNum(ctx.parsed.y, 0)}` } }
      },
      scales: {
        x: { title: { display: true, text: maWin + '-Day MA Revenue (₹ Cr)' }, ticks: { callback: v => '₹' + fmtNum(v, 1) } },
        y: { title: { display: true, text: 'NSE Share Price (₹)' },            ticks: { callback: v => '₹' + fmtNum(v, 0) } }
      }
    }
  });
}

function buildNSEShareAnalysis() {
  const el = document.getElementById('nse-share-inner');
  if (!el) return;

  if (!SHARE_DATA) {
    el.innerHTML = `<div class="chart-panel" style="text-align:center;padding:48px;color:var(--color-text-muted)">
      <div style="font-size:14px;font-weight:600;margin-bottom:8px">Share analytics data not available</div>
      <div style="font-size:12px">Run scripts/nse_share_analysis.py to generate nse_share_analysis.json</div>
    </div>`;
    return;
  }

  // Fewer than SHARE_DATA.min_days_required trading days since listing: show
  // collection progress instead of a (statistically meaningless) fit.
  if (SHARE_DATA.status === 'collecting' || !SHARE_DATA.regression) {
    renderNSECollecting(el);
    return;
  }

  const reg      = SHARE_DATA.regression;
  const lat      = SHARE_DATA.latest;
  const ser      = SHARE_DATA.series || [];
  const maWin    = SHARE_DATA.ma_window;
  const regStart = SHARE_DATA.regression_start || '2026-09-24';

  const infoHTML = shareRegressionInfoHTML(
    reg, lat.price_pred, lat.price_actual, lat.is_live, lat.date,
    maWin, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, 0
  );

  const regLabel = new Date(regStart + 'T00:00:00').toLocaleString('en-IN', { month: 'short', year: 'numeric' }) + '+';
  const ranges = [
    { key: '1m',      label: '1M' },
    { key: '3m',      label: '3M' },
    { key: '6m',      label: '6M' },
    { key: 'nov2024', label: regLabel },
  ];
  const rangeToggleHTML = `
  <div class="share-range-toggle">
    ${ranges.map(r => `<button class="share-range-btn nse-range-btn${r.key === 'nov2024' ? ' active' : ''}" data-range="${r.key}">${r.label}</button>`).join('')}
  </div>`;

  const dmaToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">DMA</span>
    ${[10, 20, 45].map(w => `<button class="share-range-btn nse-dma-btn${w === 45 ? ' active' : ''}" data-dma="${w}">${w}D</button>`).join('')}
  </div>`;

  const lagToggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">Lag</span>
    ${[0, 45, 60, 90].map(l => `<button class="share-range-btn nse-lag-btn${l === 0 ? ' active' : ''}" data-lag="${l}">${l === 0 ? 'None' : l + 'D'}</button>`).join('')}
  </div>`;

  const chartsHTML = `
  <div style="margin-top:var(--space-4)">
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title">NSE Share Price: Actual vs Model</div>
      <div class="chart-wrapper"><canvas id="chartNseSharePrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="nseDmaChartTitle">${maWin}-Day MA Revenue vs NSE Share Price</div>
      <div class="chart-wrapper"><canvas id="chartNseRevMaVsPrice"></canvas></div>
    </div>
    <div class="chart-panel" style="margin-bottom:var(--space-4)">
      <div class="chart-title" id="nseRatioChartTitle">Price ÷ Rev MA${maWin} Ratio — Mean ± SD</div>
      <div class="chart-wrapper"><canvas id="chartNseRatioSD"></canvas></div>
    </div>
    <div class="chart-panel">
      <div class="chart-title">Revenue → Price Scatter</div>
      <div class="chart-wrapper" style="max-height:300px"><canvas id="chartNseShareScatter"></canvas></div>
    </div>
  </div>`;

  const sectionHTML = `
  <div style="margin-top:var(--space-5)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-4);padding-bottom:var(--space-2);border-bottom:1px solid var(--color-border)">
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--color-text-muted)">Charts</span>
        ${dmaToggleHTML}
        ${lagToggleHTML}
      </div>
      ${rangeToggleHTML}
    </div>
    ${chartsHTML}
  </div>`;

  const limitedBanner = SHARE_DATA.limited_data ? `
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:12px 18px;border-left:3px solid var(--color-warning, #d97706);font-size:12px;color:var(--color-text-muted)">
    <strong style="color:var(--color-text)">Limited data.</strong> NSE listed on ${SHARE_DATA.listing_date}; this fit uses only ${SHARE_DATA.n_days} trading days of price history. Treat R² and the predicted price as indicative until ~60 days accumulate — the model refits automatically every day.
  </div>` : '';

  el.innerHTML = limitedBanner + `<div id="nseShareInfo">${infoHTML}</div>` + sectionHTML;

  let nseActiveDma   = 45;
  let nseActiveLag   = 0;
  let nseActiveRange = 'nov2024';
  const nseDmaCache  = { '45_0': { series: ser, reg } };

  function getNseDmaData(w, lag) {
    const key = `${w}_${lag}`;
    if (!nseDmaCache[key]) nseDmaCache[key] = buildSeriesWithDMA(ser, w, regStart, lag, SHARE_DATA.revenue_prefix || []);
    return nseDmaCache[key];
  }

  function refreshNSECharts() {
    const d = getNseDmaData(nseActiveDma, nseActiveLag);
    if (!d) return;
    buildNSECharts(filterShareSeries(d.series, nseActiveRange, regStart), d.reg, nseActiveDma);
    const lagSuffix = nseActiveLag ? ` (lag ${nseActiveLag}d)` : '';
    const t1 = document.getElementById('nseDmaChartTitle');
    if (t1) t1.textContent = `${nseActiveDma}-Day MA Revenue vs NSE Share Price${lagSuffix}`;
    const t2 = document.getElementById('nseRatioChartTitle');
    if (t2) t2.textContent = `Price ÷ Rev MA${nseActiveDma} Ratio — Mean ± SD${lagSuffix}`;
    const infoEl = document.getElementById('nseShareInfo');
    if (infoEl) {
      const latestRow = latestShareRow(d.series, lat.date);
      infoEl.innerHTML = shareRegressionInfoHTML(
        d.reg, latestRow.price_pred, lat.is_live ? lat.price_actual : latestRow.price, lat.is_live, lat.date,
        nseActiveDma, regStart, SHARE_DATA.n_days, SHARE_DATA.ticker, nseActiveLag
      );
    }
  }

  refreshNSECharts();

  el.querySelectorAll('.nse-dma-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.nse-dma-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      nseActiveDma = parseInt(btn.dataset.dma);
      refreshNSECharts();
    });
  });

  el.querySelectorAll('.nse-lag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.nse-lag-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      nseActiveLag = parseInt(btn.dataset.lag);
      refreshNSECharts();
    });
  });

  el.querySelectorAll('.nse-range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.nse-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      nseActiveRange = btn.dataset.range;
      refreshNSECharts();
    });
  });
}

// ========================
// LIVE EOD PREDICTOR (NSE + BSE) — revenue-so-far -> predicted EOD from the
// live poller's intraday samples, plus the historical "% of EOD revenue
// reached by hour N" curve derived from dashboard/data/{exchange}_hourly_history.json.
// MCX has no live turnover feed, so this is NSE/BSE only.
// ========================

// (label, minutes elapsed since 9:15 market open) — mirrors scripts/live_common.py's REFERENCE_CHECKPOINTS.
// Final checkpoint is 16:00 (4:00 PM), not the old 15:30 close — SEBI's Closing
// Auction Session (effective 2026-08-03) moved the cash segment's effective
// close to 4:00 PM (CAS 3:15-3:35pm, post-close session 3:50-4:00pm).
const INTRADAY_CHECKPOINTS = [
  ['10:00', 45], ['11:00', 105], ['12:00', 165], ['13:00', 225],
  ['14:00', 285], ['15:00', 345], ['16:00', 405],
];

// Per-exchange "re-render my bar charts" callback, invoked by the tab click
// handler the first time the Live Predictor tab becomes visible — see the
// comment at that call site for why this is necessary.
const INTRADAY_RERENDER = {};

function fmtElapsed(mins) {
  if (mins == null) return '—';
  const h = Math.floor(Math.abs(mins) / 60), m = Math.abs(mins) % 60;
  return `${mins < 0 ? '-' : ''}${h}h ${m}m`;
}

function intradayMethodLabel(method) {
  if (!method || method === 'none') return '—';
  if (method === 'linear') return 'Linear (not enough history yet)';
  const m = /^historical\/(\w+?)(?:\/wd(\d))?$/.exec(method);
  if (!m) return method;
  const typeLabel = { expiry: 'Expiry days', pre_expiry: 'Pre-expiry days', normal: 'Normal days', overall: 'All days' }[m[1]] || m[1];
  return m[2] != null ? `Historical (${typeLabel}, same weekday)` : `Historical (${typeLabel})`;
}

async function fetchIntradayJSON(exchange, file) {
  try {
    const res = await fetch(`/api/live?exchange=${exchange}&file=${file}&t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  }
}

// Averages each checkpoint's fraction across whichever days actually have it
// (a day with only its closing poll contributes nothing here — see live_common.py).
function avgCheckpointFractions(days) {
  const acc = {};
  days.forEach(day => {
    Object.entries(day.checkpoints || {}).forEach(([label, cp]) => {
      if (cp && cp.fraction != null) (acc[label] = acc[label] || []).push(cp.fraction);
    });
  });
  const out = {};
  Object.entries(acc).forEach(([label, vals]) => { out[label] = vals.reduce((a, b) => a + b, 0) / vals.length; });
  return out;
}

async function buildIntradayPredictor(exchange, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  const [hourly, history] = await Promise.all([
    fetchIntradayJSON(exchange, 'hourly'),
    fetchIntradayJSON(exchange, 'history'),
  ]);

  const days    = (history && history.days) || [];
  const exLabel = exchange.toUpperCase();

  // ── Live KPI row ──
  const samples = (hourly && hourly.samples) || [];
  const latest  = samples.length ? samples[samples.length - 1] : null;

  const liveHTML = latest ? `
  <div class="share-kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);margin-bottom:var(--space-4)">
    ${kpi('Revenue So Far Today', '₹' + fmtNum(latest.total_revenue, 2) + ' Cr',
          `as of ${(latest.captured_ist || '').slice(11, 16)} IST (+${fmtElapsed(latest.elapsed_minutes)})`, '')}
    ${kpi('Predicted EOD Revenue', latest.predicted_eod != null ? '₹' + fmtNum(latest.predicted_eod, 2) + ' Cr' : '—',
          intradayMethodLabel(latest.pred_method), 'positive')}
    ${kpi('Day Type', (hourly.day_type || '—').replace('_', '-'), hourly.weekday_name || '', '')}
    ${kpi('Polls Landed Today', String(samples.length), samples.length === 1 ? 'sample' : 'samples', '')}
  </div>` : `
  <div class="chart-panel" style="text-align:center;padding:32px;color:var(--color-text-muted);margin-bottom:var(--space-4)">
    <div style="font-size:14px;font-weight:600">No live poll recorded yet today</div>
    <div style="font-size:12px;margin-top:6px">GitHub Actions polls every few minutes during market hours, though not on a precise schedule — check back shortly.</div>
  </div>`;

  // ── Historical "% of EOD revenue by hour" curve ──
  const byType = {
    all:        days,
    normal:     days.filter(d => d.day_type === 'normal'),
    expiry:     days.filter(d => d.day_type === 'expiry'),
    pre_expiry: days.filter(d => d.day_type === 'pre_expiry'),
  };
  const typeOptions = [
    { key: 'all',        label: 'All Days' },
    { key: 'normal',     label: 'Normal' },
    { key: 'expiry',     label: 'Expiry' },
    { key: 'pre_expiry', label: 'Pre-Expiry' },
  ];
  const toggleHTML = `
  <div class="share-dma-toggle">
    <span class="share-dma-label">Days</span>
    ${typeOptions.map(t => `<button class="share-range-btn intraday-daytype-btn-${exchange}${t.key === 'all' ? ' active' : ''}" data-daytype="${t.key}">${t.label} (${byType[t.key].length})</button>`).join('')}
  </div>`;

  const tableRows = days.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20).map(d => `
    <tr>
      <td>${d.date}</td>
      <td>${d.weekday_name}</td>
      <td style="text-transform:capitalize">${(d.day_type || '').replace('_', '-')}</td>
      <td style="text-align:right">₹${fmtNum(d.eod_revenue, 2)} Cr</td>
      <td style="text-align:right">${d.n_samples}</td>
    </tr>`).join('');

  el.innerHTML = `
  ${liveHTML}
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">${exLabel} — Trading Activity by Period of Day</div>
    <p class="section-desc">% of EOD revenue earned within each window, not cumulative — this is what tells you which part of the day is busiest. Based on ${days.length} archived trading day${days.length === 1 ? '' : 's'}; only days with a real intraday poll besides the closing figure contribute (see below).</p>
    <div style="margin-bottom:var(--space-3)">${toggleHTML}</div>
    <div id="barsIntradayPeriod${exLabel}"></div>
  </div>
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div class="chart-title">${exLabel} — % of EOD Revenue Reached, by Time of Day (Cumulative)</div>
    <p class="section-desc">The running total behind the chart above — e.g. "by 12:00 we're typically at X% of the day's revenue."</p>
    <div class="chart-wrapper"><canvas id="chartIntraday${exLabel}"></canvas></div>
  </div>
  <div class="chart-panel">
    <div class="chart-title">Archived Days (most recent 20)</div>
    <div style="overflow-x:auto">
      <table class="data-table">
        <thead><tr><th>Date</th><th>Weekday</th><th>Day Type</th><th style="text-align:right">EOD Revenue</th><th style="text-align:right">Samples</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="5" style="text-align:center;color:var(--color-text-muted)">No archived days yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;

  // Fixed windows the cumulative checkpoints imply — first one starts at market
  // open (9:15), so it's the only one with a known, non-computed left edge (0%).
  const PERIODS = [
    { label: 'Open–10:00', fromMin: 0,   toMin: 45  },
    { label: '10:00–11:00', fromMin: 45,  toMin: 105 },
    { label: '11:00–12:00', fromMin: 105, toMin: 165 },
    { label: '12:00–13:00', fromMin: 165, toMin: 225 },
    { label: '13:00–14:00', fromMin: 225, toMin: 285 },
    { label: '14:00–15:00', fromMin: 285, toMin: 345 },
    { label: '15:00–16:00', fromMin: 345, toMin: 405 },
  ];
  const minToFrac = (fracs, mins) => mins === 0 ? 0 : (fracs[INTRADAY_CHECKPOINTS.find(([, m]) => m === mins)[0]] ?? null);

  function periodDeltas(fracs) {
    return PERIODS.map(p => {
      const a = minToFrac(fracs, p.fromMin), b = minToFrac(fracs, p.toMin);
      return (a != null && b != null) ? Math.round((b - a) * 1000) / 10 : null;
    });
  }

  // Plain CSS bars instead of a Chart.js bar chart — this dashboard's Chart.js
  // setup (see applyChartDefaults' Chart.defaults.scale.grid/border overrides)
  // reliably breaks bar-element geometry (rect() ends up called with a null
  // y/height, painting nothing) while leaving line charts unaffected; simple
  // divs sidestep that entirely for this 7-category comparison.
  function renderPeriodBars(daytype) {
    const fracs = avgCheckpointFractions(byType[daytype] || []);
    const values = periodDeltas(fracs);
    const maxVal = Math.max(1, ...values.filter(v => v != null));
    const rowsHTML = PERIODS.map((p, i) => {
      const v = values[i];
      const widthPct = v != null ? Math.max(2, (v / maxVal) * 100) : 0;
      return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
        <div style="width:110px;flex-shrink:0;font-size:11px;color:var(--color-text-muted)">${p.label}</div>
        <div style="flex:1;background:var(--color-border);border-radius:3px;overflow:hidden;height:22px">
          ${v != null ? `<div style="width:${widthPct}%;height:100%;background:${CHART_COLORS[1]};border-radius:3px"></div>` : ''}
        </div>
        <div style="width:56px;flex-shrink:0;text-align:right;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums">${v != null ? v.toFixed(1) + '%' : '—'}</div>
      </div>`;
    }).join('');
    const barsEl = document.getElementById(`barsIntradayPeriod${exLabel}`);
    if (barsEl) barsEl.innerHTML = rowsHTML;
  }

  function renderCumulativeChart(daytype) {
    const fracs = avgCheckpointFractions(byType[daytype] || []);
    const cumKey = `intraday${exLabel}`;
    if (charts[cumKey]) { charts[cumKey].destroy(); charts[cumKey] = null; }
    const cumLabels = INTRADAY_CHECKPOINTS.map(([label]) => label);
    const cumValues = INTRADAY_CHECKPOINTS.map(([label]) => fracs[label] != null ? Math.round(fracs[label] * 1000) / 10 : null);

    setCanvasHeight(`chartIntraday${exLabel}`, 240);
    charts[cumKey] = new Chart(document.getElementById(`chartIntraday${exLabel}`), {
      type: 'line',
      data: {
        labels: cumLabels,
        datasets: [{
          label: '% of EOD revenue', data: cumValues,
          borderColor: CHART_COLORS[0], backgroundColor: CHART_COLORS[0] + '22',
          borderWidth: 2, pointRadius: 4, tension: 0.25, fill: true, spanGaps: true,
        }],
      },
      options: {
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.raw != null ? `${ctx.raw.toFixed(1)}% of EOD revenue by ${ctx.label}` : 'No data for this checkpoint' } },
        },
        scales: {
          y: { min: 0, max: 100, ticks: { callback: v => v + '%' }, title: { display: true, text: '% of EOD Revenue' } },
          x: { title: { display: true, text: 'Time of Day (IST)' } },
        },
      },
    });
  }

  function renderAll(daytype) {
    renderPeriodBars(daytype);
    renderCumulativeChart(daytype);
  }

  let activeDaytype = 'all';
  renderAll(activeDaytype);
  // The cumulative line chart is still Chart.js-based, and (like every other
  // chart in this app) can end up built while its tab is still display:none —
  // line charts don't get the bar bug above, but do need a resize once
  // visible; the CSS bars need no such recovery.
  INTRADAY_RERENDER[exchange] = () => renderCumulativeChart(activeDaytype);

  el.querySelectorAll(`.intraday-daytype-btn-${exchange}`).forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll(`.intraday-daytype-btn-${exchange}`).forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeDaytype = btn.dataset.daytype;
      renderAll(activeDaytype);
    });
  });
}

// NSE listed on 2026-09-24 (ticker NSE.BO), so CMP comes from the same share
// feed as BSE/MCX. Before the first price posts it is null and upside shows "—".
function buildNSEValuation() {
  const el = document.getElementById('nseValuationContent');
  if (!el) return;

  const nseSeries = bseDailySeries(DATA);
  if (!nseSeries.length) { el.innerHTML = ''; return; }

  el.innerHTML = `<div id="nseQuickValPanel"></div>`;
  buildQuickValuationPanel(el.querySelector('#nseQuickValPanel'), 'nse', nseSeries, SHARE_DATA?.latest?.price_actual ?? null);
}

function buildMCXValuation() {
  const el = document.getElementById('mcxValuationContent');
  if (!el) return;

  const mcxSeries = bseDailySeries(DATA);
  if (!mcxSeries.length) { el.innerHTML = ''; return; }
  const cmp = SHARE_DATA?.latest?.price_actual ?? null;

  el.innerHTML = `<div id="mcxQuickValPanel"></div>`;
  buildQuickValuationPanel(el.querySelector('#mcxQuickValPanel'), 'mcx', mcxSeries, cmp);
}

function kpi(title, value, sub, sentiment) {
  const col = sentiment === 'positive' ? 'var(--color-positive)'
            : sentiment === 'negative' ? 'var(--color-negative)'
            : 'var(--color-text)';
  return `<div class="chart-panel" style="padding:16px 20px">
    <div style="font-size:11px;color:var(--color-text-muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">${title}</div>
    <div style="font-size:28px;font-weight:700;color:${col};line-height:1">${value}</div>
    <div style="font-size:11px;color:var(--color-text-muted);margin-top:6px">${sub}</div>
  </div>`;
}

// ========================
// INIT
// ========================

async function init() {
  showLoading('nse');
  initExchangeSwitcher();
  buildSidebarNav('nse');
  toggleExchangeContent('nse');
  preloadMarketData().then(() => { if (currentExchange === 'all' || currentExchange === 'nsebse') rebuildAll(); });
  await loadExchangeData('nse');
  updateHeaderInfo();
  rebuildAll();
  hideLoading();
  updateLatestRevBanner();
  setInterval(updateLatestRevBanner, 5 * 60 * 1000);
  // Activate first tab
  const firstNavItem = document.querySelector('.nav-item[data-tab]');
  if (firstNavItem) firstNavItem.click();
}


// ========================
// SHARED REPORT HELPERS
// ========================

function buildAllRegressionChartImgs(shareData, exchangeName) {
  const reg      = shareData.regression || {};
  const maW      = shareData.ma_window || 45;
  const regStart = shareData.regression_start || '';
  const series   = (shareData.series || []).filter(r => r.date >= regStart);
  if (!series.length) return [];

  const labels  = series.map(r => fmtChartDate(r.date));
  const actuals = series.map(r => r.price);
  const preds   = series.map(r => r.price_pred);
  const revMA   = series.map(r => r.rev_ma);
  const slope   = reg.slope, intercept = reg.intercept;

  const ratios = series.map(r => r.price / r.rev_ma);
  const rN     = ratios.length;
  const mean   = ratios.reduce((a, b) => a + b, 0) / rN;
  const std    = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / rN);
  const flat   = v => series.map(() => v);

  const scatterPts = series.map(r => ({ x: r.rev_ma, y: r.price }));
  const xVals      = scatterPts.map(p => p.x);
  const xMin = Math.min(...xVals), xMax = Math.max(...xVals);
  const regLine = [{ x: xMin, y: slope * xMin + intercept }, { x: xMax, y: slope * xMax + intercept }];

  const sdBandOuter = CHART_COLORS[0] + '18';
  const sdBandInner = CHART_COLORS[0] + '30';
  const sdLineOuter = CHART_COLORS[0] + '55';
  const sdLineInner = CHART_COLORS[0] + '80';

  const chartDefs = [
    {
      label: 'Share Price: Actual vs Model',
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: 'Actual Price',     data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2 },
          { label: 'Model Prediction', data: preds,   borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderDash: [5, 3] },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: { x: { ticks: { maxTicksLimit: 8, font: { size: 9 } } }, y: { ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } } } } }
      }
    },
    {
      label: `Rev MA${maW} vs ${exchangeName} Share Price`,
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: maW + '-Day MA Revenue (₹ Cr)', data: revMA,   borderColor: CHART_COLORS[4], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yRev' },
          { label: exchangeName + ' Share Price (₹)', data: actuals, borderColor: CHART_COLORS[0], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'yPrice' },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: {
            x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } },
            yRev:   { type: 'linear', position: 'left',  title: { display: true, text: maW + '-Day MA Rev (₹ Cr)', font: { size: 9 } }, ticks: { callback: v => '₹' + fmtNum(v, 1) + ' Cr', font: { size: 9 } } },
            yPrice: { type: 'linear', position: 'right', title: { display: true, text: 'Share Price (₹)', font: { size: 9 } }, ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } }, grid: { drawOnChartArea: false } },
          }
        }
      }
    },
    {
      label: `Price ÷ Rev MA${maW} Ratio — Mean ± SD`,
      w: 700, h: 260,
      config: {
        type: 'line',
        data: { labels, datasets: [
          { label: '+2σ',            data: flat(mean + 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 4 }, backgroundColor: sdBandOuter },
          { label: '+1σ',            data: flat(mean + std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: { target: 3 }, backgroundColor: sdBandInner },
          { label: 'Mean',           data: flat(mean),           borderColor: CHART_COLORS[4], borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: '−1σ',            data: flat(mean - std),     borderColor: sdLineInner, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: '−2σ',            data: flat(mean - 2 * std), borderColor: sdLineOuter, borderWidth: 1, borderDash: [4, 4], pointRadius: 0, fill: false, backgroundColor: 'transparent' },
          { label: 'Price / Rev MA', data: ratios, borderColor: CHART_COLORS[1], backgroundColor: 'transparent', borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: { x: { ticks: { maxTicksLimit: 10, font: { size: 9 } } }, y: { ticks: { callback: v => v.toFixed(0), font: { size: 9 } }, title: { display: true, text: 'Price ÷ Rev MA' + maW, font: { size: 9 } } } } }
      }
    },
    {
      label: `Price vs ${maW}-Day Revenue MA — Scatter`,
      w: 700, h: 300,
      config: {
        type: 'scatter',
        data: { datasets: [
          { label: 'Price vs Rev MA', data: scatterPts, backgroundColor: CHART_COLORS[0] + '88', pointRadius: 3 },
          { label: 'Regression Line', data: regLine, type: 'line', borderColor: CHART_COLORS[2], backgroundColor: 'transparent', borderWidth: 2, borderDash: [5, 3], pointRadius: 0 },
        ]},
        options: { animation: false, plugins: { legend: { labels: { font: { size: 10 } } } },
          scales: {
            x: { title: { display: true, text: maW + '-Day MA Revenue (₹ Cr)', font: { size: 10 } }, ticks: { callback: v => '₹' + fmtNum(v, 1), font: { size: 9 } } },
            y: { title: { display: true, text: exchangeName + ' Share Price (₹)', font: { size: 10 } }, ticks: { callback: v => '₹' + fmtNum(v, 0), font: { size: 9 } } },
          }
        }
      }
    },
  ];

  return chartDefs.map(def => {
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${def.w}px;height:${def.h}px;`;
    const canvas = document.createElement('canvas');
    canvas.width = def.w; canvas.height = def.h;
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    const tempChart = new Chart(canvas, def.config);
    const img = tempChart.toBase64Image();
    tempChart.destroy();
    document.body.removeChild(wrap);
    return { label: def.label, img };
  });
}

// ========================
// WEEKLY REPORT PDF DOWNLOAD
// ========================

async function downloadWeeklyReport() {
  const btn = document.getElementById('btnDownloadReport');
  if (btn) { btn.textContent = 'Building…'; btn.disabled = true; }

  try {
    const [nseEnrich, bseEnrich, mcxEnrich, nseDash, bseDash, bseShare, mcxShare, nseShare] = await Promise.all([
      fetch('./data/nse_enriched_data.json').then(r => r.json()),
      fetch('./data/bse_enriched_data.json').then(r => r.json()),
      fetch('./data/mcx_enriched_data.json').then(r => r.json()).catch(() => null),
      fetch('./data/nse_dashboard_data.json').then(r => r.json()),
      fetch('./data/bse_dashboard_data.json').then(r => r.json()),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/nse_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);

    // ── Week range from latest NSE daily date ──
    const nseDaily = nseDash.daily_all || nseDash.daily || [];
    const latestDateStr = nseDaily.length > 0 ? nseDaily[nseDaily.length - 1].date : null;
    function getWeekRange(dateStr) {
      if (!dateStr) return 'N/A';
      const d = new Date(dateStr + 'T00:00:00');
      const day = d.getDay();
      const daysToMon = day === 0 ? -6 : 1 - day;
      const mon = new Date(d); mon.setDate(d.getDate() + daysToMon);
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
      function ordinal(n) { const s=['th','st','nd','rd'],v=n%100; return n+(s[(v-20)%10]||s[v]||s[0]); }
      const monMonth = mon.toLocaleString('en-IN', { month: 'short' });
      const friStr = ordinal(fri.getDate()) + ' ' + fri.toLocaleString('en-IN', { month: 'short', year: 'numeric' });
      if (mon.getMonth() !== fri.getMonth()) return `${ordinal(mon.getDate())} ${monMonth} – ${friStr}`;
      return `${ordinal(mon.getDate())} – ${friStr}`;
    }
    const weekRange = getWeekRange(latestDateStr);
    const genTime = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function n(num) { if (num == null || isNaN(num)) return '—'; return fmtNum(num); }
    function prFmt(val) {
      if (val == null || isNaN(val)) return '—';
      const pct = (val * 100).toFixed(1);
      if (val > 0.0001) return `<span class="pr-pos">+${pct}%</span>`;
      if (val < -0.0001) return `<span class="pr-neg">${pct}%</span>`;
      return '<span class="pr-neu">0.0%</span>';
    }

    function buildTotalRevenueTable(enriched) {
      const s = enriched.summary_total;
      if (!s) return '';
      const wl5 = s.weekly.last5 || {};
      const wp5 = s.weekly.prev5 || {};
      const w20r = s.weekly.last20 || {};
      const w50 = s.weekly.last45 || {};
      const mc = s.monthly.current || {};
      const mp = s.monthly.previous || {};
      const m6 = s.monthly.avg_6m || {};
      const qc = s.quarterly.current || {};
      const qp = s.quarterly.previous || {};
      const q2 = s.quarterly.prev2 || {};
      return `<div class="pr-sub-header">Total Revenue (Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Metric</th><th>₹ Cr</th><th>% Change</th></tr></thead>
        <tbody>
          <tr class="pr-group-label"><td colspan="3">Weekly</td></tr>
          <tr><td>L5 – This Week</td><td>${n(wl5.value)}</td><td>${prFmt(wl5.wow)}</td></tr>
          <tr><td>Prev5 – Last Week</td><td>${n(wp5.value)}</td><td>—</td></tr>
          <tr><td>L20 – 20-Day Avg</td><td>${n(w20r.value)}</td><td>—</td></tr>
          <tr><td>L45 – 45-Day Avg</td><td>${n(w50.value)}</td><td>${prFmt(wl5.wo10w)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Monthly</td></tr>
          <tr><td>${mc.label || 'Current Month'}</td><td>${n(mc.value)}</td><td>${prFmt(mc.mom)}</td></tr>
          <tr><td>${mp.label || 'Prev Month'}</td><td>${n(mp.value)}</td><td>—</td></tr>
          <tr><td>6-Month Avg</td><td>${n(m6.value)}</td><td>${prFmt(mc.mo6m)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Quarterly</td></tr>
          <tr><td>${qc.label || 'Current Q'}</td><td>${n(qc.value)}</td><td>${prFmt(qc.qoq)}</td></tr>
          <tr><td>${qp.label || 'Prev Q'}</td><td>${n(qp.value)}</td><td>—</td></tr>
          <tr><td>${q2.label || 'YoY Q'}</td><td>${n(q2.value)}</td><td>${prFmt(qc.yoy)}</td></tr>
        </tbody>
      </table>`;
    }

    function buildDowTable(enriched) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const rows = dayNames.map(day => {
        const dd = dow[day] || {};
        return `<tr><td>${day}</td><td>${n(dd.latest)}</td><td>${n(dd.avg_3d)}</td><td>${prFmt(dd.do3d)}</td><td>${n(dd.avg_10d)}</td><td>${prFmt(dd.do10d)}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Day-of-Week Performance</div>
      <table class="pr-table">
        <thead><tr><th>Day</th><th>This Week (₹ Cr)</th><th>L3 Avg</th><th>Do3D</th><th>L10 Avg</th><th>Do10D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    function buildSegmentTable(enriched) {
      const segs = [
        { label: 'Options', data: enriched.seg_options },
        { label: 'Futures', data: enriched.seg_futures },
        { label: 'Cash',    data: enriched.seg_cash },
      ];
      const rows = segs.map(seg => {
        const l5 = ((seg.data || {}).weekly || {}).last5 || {};
        return `<tr><td>${seg.label}</td><td>${n(l5.value)}</td><td>${prFmt(l5.wow)}</td><td>${prFmt(l5.wo10w)}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Segment Revenue (L5 Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Segment</th><th>L5 Avg</th><th>WoW</th><th>Wo10W</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    // Compact expiry comparison for the printed report — Total revenue only
    // (the report has no segment sub-tabs), fewer rows than the on-screen
    // version. Reuses computeMonthExpiryDates/computeWeekExpiryDates/
    // getYoYQuarter/quarterSortKey, all defined at module scope.
    function buildExpiryReportTable(dashData, exchange) {
      const dailyAll = dashData.daily_all || dashData.daily || [];
      if (!dailyAll.length) return '';
      const byDate = new Map(dailyAll.map(r => [r.date, r]));

      const monthExpiries = computeMonthExpiryDates(dailyAll, exchange)
        .map(({ monthKey, expiryDate }) => {
          const rec = byDate.get(expiryDate);
          return rec ? { monthKey, expiryDate, fy_month: rec.fy_month, fy_quarter: rec.fy_quarter, value: rec.total_rev || 0 } : null;
        })
        .filter(Boolean);
      if (!monthExpiries.length) return '';

      const monthly = monthExpiries.slice(-6);
      const monthlyRows = monthly.map((e, i) => {
        const prev = i > 0 ? monthly[i - 1] : null;
        const mom = prev && prev.value ? (e.value - prev.value) / prev.value : null;
        return `<tr><td>${e.fy_month}</td><td>${n(e.value)}</td><td>${prFmt(mom)}</td></tr>`;
      }).join('');

      const byQuarter = new Map();
      monthExpiries.forEach(e => {
        if (!byQuarter.has(e.fy_quarter)) byQuarter.set(e.fy_quarter, []);
        byQuarter.get(e.fy_quarter).push(e.value);
      });
      const qAvg = q => {
        const v = byQuarter.get(q);
        return v && v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
      };
      const quarters = [...byQuarter.keys()].sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).slice(-4);
      const quarterlyRows = quarters.map((q, i) => {
        const cur     = qAvg(q);
        const prevVal = i > 0 ? qAvg(quarters[i - 1]) : null;
        const yoyVal  = qAvg(getYoYQuarter(q));
        const qoq = prevVal ? (cur - prevVal) / prevVal : null;
        const yoy = yoyVal ? (cur - yoyVal) / yoyVal : null;
        return `<tr><td>${q}</td><td>${n(cur)}</td><td>${prFmt(qoq)}</td><td>${prFmt(yoy)}</td></tr>`;
      }).join('');

      const monthEndByKey = new Map(monthExpiries.map(e => [e.monthKey, e]));
      const weeksByMonth = new Map();
      computeWeekExpiryDates(dailyAll, exchange).forEach(w => {
        const mk = w.expiryDate.slice(0, 7);
        if (!weeksByMonth.has(mk)) weeksByMonth.set(mk, []);
        weeksByMonth.get(mk).push(w.expiryDate);
      });
      const wvmRows = [];
      weeksByMonth.forEach((dates, mk) => {
        const me = monthEndByKey.get(mk);
        if (!me) return;
        const otherVals = dates
          .filter(d => d !== me.expiryDate)
          .map(d => byDate.get(d))
          .filter(Boolean)
          .map(r => r.total_rev || 0);
        if (!otherVals.length) return;
        const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
        const diff = avgWeekly ? (me.value - avgWeekly) / avgWeekly : null;
        wvmRows.push({ monthKey: mk, fy_month: me.fy_month, avgWeekly, monthEnd: me.value, diff });
      });
      wvmRows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
      const wvmRecent = wvmRows.slice(-12);
      const wvmRowsHTML = wvmRecent.map(r =>
        `<tr><td>${r.fy_month}</td><td>${n(r.avgWeekly)}</td><td>${n(r.monthEnd)}</td><td>${prFmt(r.diff)}</td></tr>`
      ).join('');

      // Same trailing-average summary rows as the on-screen Weekly vs Month-End
      // Expiry table, drawn from the full wvmRows history (not just the 12
      // displayed above) so they stay correct if that window is ever narrowed.
      const avgOf = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
      const wvmSummaryHTML = [3, 6, 12].map(nMonths => {
        const w = wvmRows.slice(-nMonths);
        const avgWeekly = avgOf(w.map(r => r.avgWeekly));
        const avgMonthEnd = avgOf(w.map(r => r.monthEnd));
        const diff = avgWeekly ? (avgMonthEnd - avgWeekly) / avgWeekly : null;
        return `<tr style="font-weight:700"><td>Last ${nMonths} Months Avg</td><td>${n(avgWeekly)}</td><td>${n(avgMonthEnd)}</td><td>${prFmt(diff)}</td></tr>`;
      }).join('');

      const expiryWeekday = exchange === 'bse' ? 'Thursday' : 'Tuesday';
      return `
      <div class="pr-sub-header">Month-End Expiry Comparison (Total Rev, ₹ Cr) — last trading day on/before month's last ${expiryWeekday}</div>
      <table class="pr-table" style="margin-bottom:8px">
        <thead><tr><th>Month</th><th>₹ Cr</th><th>MoM</th></tr></thead>
        <tbody>${monthlyRows}</tbody>
      </table>
      <table class="pr-table" style="margin-bottom:8px">
        <thead><tr><th>Quarter</th><th>₹ Cr</th><th>QoQ</th><th>YoY</th></tr></thead>
        <tbody>${quarterlyRows}</tbody>
      </table>
      <div class="pr-sub-header">Weekly vs Month-End Expiry (Total Rev, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Month</th><th>Avg Weekly Expiry</th><th>Month-End Expiry</th><th>Difference</th></tr></thead>
        <tbody>${wvmRowsHTML}${wvmSummaryHTML}</tbody>
      </table>`;
    }

    function buildExchangeSection(label, enriched, includeSegments, dashData, exchangeKey) {
      return `<div class="pr-section">
        <div class="pr-section-header">${label}</div>
        <div class="pr-section-body">
          ${buildTotalRevenueTable(enriched)}
          ${buildDowTable(enriched)}
          ${includeSegments ? buildSegmentTable(enriched) : ''}
          ${dashData && exchangeKey ? buildExpiryReportTable(dashData, exchangeKey) : ''}
        </div>
      </div>`;
    }

    function buildRegressionSection(shareData, exchangeName) {
      if (!shareData) return '';
      const reg      = shareData.regression || {};
      const lat      = shareData.latest || {};
      const maW      = shareData.ma_window || 45;
      const regStart = shareData.regression_start || '';

      const statsHTML = `
      <div class="pr-regression-stats">
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">R²</div><div class="pr-reg-stat-value">${reg.r_squared != null ? reg.r_squared.toFixed(4) : '—'}</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">Pearson r</div><div class="pr-reg-stat-value">${reg.pearson_r != null ? reg.pearson_r.toFixed(4) : '—'}</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">MA Window</div><div class="pr-reg-stat-value">${maW}-day</div></div>
        <div class="pr-reg-stat"><div class="pr-reg-stat-label">Fit Quality</div><div class="pr-reg-stat-value" style="text-transform:capitalize">${reg.fit || '—'}</div></div>
      </div>
      <div class="pr-reg-equation">${reg.equation || '—'}</div>
      <table class="pr-table" style="max-width:360px;margin-bottom:10px">
        <thead><tr><th>Latest (${lat.date || '—'})</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td>Actual Price</td><td>₹${lat.price_actual != null ? fmtNum(lat.price_actual, 0) : '—'}</td></tr>
          <tr><td>Model Predicted</td><td>₹${lat.price_pred != null ? fmtNum(lat.price_pred, 0) : '—'}</td></tr>
          <tr><td>Error %</td><td>${lat.error_pct != null ? lat.error_pct + '%' : '—'}</td></tr>
          <tr><td>Rev MA${maW} (₹ Cr)</td><td>${lat.rev_ma != null ? fmtNum(lat.rev_ma, 2) : '—'}</td></tr>
          <tr><td>Regression from</td><td>${regStart}</td></tr>
          <tr><td>N (trading days)</td><td>${shareData.n_days || '—'}</td></tr>
        </tbody>
      </table>`;

      const chartResults = buildAllRegressionChartImgs(shareData, exchangeName);
      const chartsHTML = chartResults.map((c, i) => {
        // Scatter (last chart) spans full width
        const span = i === chartResults.length - 1 ? ' style="grid-column:1/-1"' : '';
        return `<div class="pr-chart-item"${span}><div class="pr-chart-label">${c.label}</div><img src="${c.img}" alt="${c.label}"></div>`;
      }).join('');

      return `<div class="pr-section">
        <div class="pr-section-header">${exchangeName} Share Price Regression</div>
        <div class="pr-section-body">
          ${statsHTML}
          <div class="pr-chart-grid">${chartsHTML}</div>
        </div>
      </div>`;
    }

    // NSE listed 2026-09-24: until nse_share_analysis.json reaches status="ready"
    // (20 trading days) there is no fit to print, so show collection progress.
    function buildNSEShareSection(shareData) {
      if (!shareData) return '';
      const ready = shareData.status === 'ready' && shareData.regression;
      if (ready) {
        const note = shareData.limited_data
          ? `<div class="pr-summary" style="margin:0 10px 8px">Limited data: only ${shareData.n_days} trading days since the ${shareData.listing_date} listing — treat the fit as indicative.</div>`
          : '';
        return buildRegressionSection(shareData, 'NSE').replace(/(<div class="pr-section-body">)/, '$1' + note);
      }
      const lat   = shareData.latest || {};
      const first = shareData.first_price;
      const since = first && lat.price_actual ? ((lat.price_actual / first - 1) * 100).toFixed(1) + '%' : '—';
      return `<div class="pr-section">
        <div class="pr-section-header">NSE Share Price Regression</div>
        <div class="pr-section-body">
          <div class="pr-regression-stats">
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Days Collected</div><div class="pr-reg-stat-value">${shareData.n_days} / ${shareData.min_days_required}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Latest Close</div><div class="pr-reg-stat-value">₹${lat.price_actual != null ? fmtNum(lat.price_actual, 2) : '—'}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Since Listing</div><div class="pr-reg-stat-value">${since}</div></div>
            <div class="pr-reg-stat"><div class="pr-reg-stat-label">Listed On</div><div class="pr-reg-stat-value">${shareData.listing_date}</div></div>
          </div>
          <div class="pr-summary">NSE listed on ${shareData.listing_date}. The revenue → share price regression starts automatically once ${shareData.min_days_required} trading days of price history are available; prices are being collected daily.</div>
        </div>
      </div>`;
    }

    function buildMarketShareSection() {
      const chartResults = buildMarketShareChartImgs(nseDash, bseDash);
      if (!chartResults.length) return '';
      const chartsHTML = chartResults.map(c =>
        `<div class="pr-chart-item" style="grid-column:1/-1"><div class="pr-chart-label">${c.label}</div><img src="${c.img}" alt="${c.label}"></div>`
      ).join('');
      return `<div class="pr-section">
        <div class="pr-section-header">NSE vs BSE Market Share Trend</div>
        <div class="pr-section-body">
          <div class="pr-chart-grid">${chartsHTML}</div>
        </div>
      </div>`;
    }

    const html = `<div class="pr-wrapper">
      <div class="pr-header">
        <span class="pr-title">NSE/BSE Weekly Update – Week of ${weekRange}</span>
        <span class="pr-subtitle">Generated: ${genTime}</span>
      </div>
      ${buildExchangeSection('NSE Update', nseEnrich, true, nseDash, 'nse')}
      ${buildNSEShareSection(nseShare)}
      ${buildExchangeSection('BSE Update', bseEnrich, false, bseDash, 'bse')}
      ${buildRegressionSection(bseShare, 'BSE')}
      ${buildMarketShareSection()}
      ${mcxEnrich ? buildExchangeSection('MCX Update', mcxEnrich, true) : ''}
      ${buildRegressionSection(mcxShare, 'MCX')}
      <div class="pr-footer">NSE/BSE/MCX Analytics Dashboard — Auto-generated report</div>
    </div>`;

    const el = document.getElementById('print-report');
    el.innerHTML = html;
    el.style.display = 'block';
    setTimeout(() => { window.print(); el.style.display = 'none'; }, 150);
  } finally {
    if (btn) { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Report'; btn.disabled = false; }
  }
}

// ========================
// MOBILE REPORT DOWNLOAD
// ========================

async function downloadMobileReport() {
  const btn = document.getElementById('btnMobileReport');
  if (btn) { btn.textContent = 'Building…'; btn.disabled = true; }

  try {
    const [nseEnrich, bseEnrich, mcxEnrich, nseDash, bseDash, bseShare, mcxShare] = await Promise.all([
      fetch('./data/nse_enriched_data.json').then(r => r.json()),
      fetch('./data/bse_enriched_data.json').then(r => r.json()),
      fetch('./data/mcx_enriched_data.json').then(r => r.json()).catch(() => null),
      fetch('./data/nse_dashboard_data.json').then(r => r.json()),
      fetch('./data/bse_dashboard_data.json').then(r => r.json()),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);

    const nseDaily = nseDash.daily_all || nseDash.daily || [];
    const latestDateStr = nseDaily.length > 0 ? nseDaily[nseDaily.length - 1].date : '';
    const genTime = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    function n(v) { return (v == null || isNaN(v)) ? '—' : fmtNum(v); }
    function pct(v, decimals) {
      if (v == null || isNaN(v)) return '—';
      const p = (v * 100).toFixed(decimals != null ? decimals : 1);
      return (v > 0.0001 ? '+' : '') + p + '%';
    }
    // Highlighted pill for a % change — green background for positive, red for negative
    function pctBadge(v, decimals) {
      if (v == null || isNaN(v)) return '<span style="color:#9ca3af">—</span>';
      const isPos = v > 0.0001, isNeg = v < -0.0001;
      const bg = isPos ? '#dcfce7' : isNeg ? '#fee2e2' : '#f3f4f6';
      const fg = isPos ? '#15803d' : isNeg ? '#b91c1c' : '#6b7280';
      return `<span style="display:inline-block;background:${bg};color:${fg};padding:1px 7px;border-radius:5px;font-weight:700;white-space:nowrap">${pct(v, decimals)}</span>`;
    }

    // ── KPI card for weekly/quarterly headline ──
    function kpiCard(label, value, change, changeLabel) {
      const chgStr = change != null ? `<div style="margin-top:4px">${pctBadge(change)} <span style="font-size:10px;color:#9ca3af">${changeLabel || ''}</span></div>` : '';
      return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;flex:1;min-width:130px">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</div>
        <div style="font-size:20px;font-weight:700;color:#111;letter-spacing:-.02em">₹${n(value)}<span style="font-size:11px;font-weight:400;color:#6b7280"> Cr</span></div>
        ${chgStr}
      </div>`;
    }

    // ── DoW table rows ──
    function dowRows(enriched) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
      return days.map(d => {
        const dd = dow[d] || {};
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#374151">${d.slice(0,3)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(dd.latest)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${pctBadge(dd.do3d)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280">${n(dd.avg_10d)}</td>
        </tr>`;
      }).join('');
    }

    function exchangeSection(name, color, enriched) {
      const s   = enriched.summary_total || {};
      const wl5 = s.weekly?.last5 || {};
      const wp5 = s.weekly?.prev5 || {};
      const w20 = s.weekly?.last20 || {};
      const w45 = s.weekly?.last45 || {};
      const qc  = s.quarterly?.current || {};
      const qp  = s.quarterly?.previous || {};
      const mc  = s.monthly?.current || {};
      const m6  = s.monthly?.avg_6m || {};

      const segs = [
        { label: 'Options', d: enriched.seg_options },
        { label: 'Futures', d: enriched.seg_futures },
        { label: 'Cash',    d: enriched.seg_cash },
      ];
      const segRows = segs.map(sg => {
        const l5 = sg.d?.weekly?.last5 || {};
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;color:#374151">${sg.label}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(l5.value)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${pctBadge(l5.wow)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${pctBadge(l5.wo10w)}</td>
        </tr>`;
      }).join('');

      return `
      <div style="margin-bottom:20px">
        <div style="background:${color};color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">${name}</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px 14px 6px">

          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard('This Week (L5)', wl5.value, wl5.wow, 'WoW')}
            ${kpiCard('Last Week (P5)', wp5.value, null)}
            ${kpiCard('20-Day Avg', w20.value, null)}
            ${kpiCard('45-Day Avg', w45.value, wl5.wo10w, 'Wo45')}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard(qc.label || 'Current Q', qc.value, qc.qoq, 'QoQ')}
            ${kpiCard(qp.label || 'Prev Q', qp.value, qc.yoy, 'YoY')}
            ${kpiCard(mc.label || 'Current Month', mc.value, mc.mom, 'MoM')}
          </div>

          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.05em;margin:10px 0 6px">Day of Week (₹ Cr daily avg)</div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f9fafb">
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Day</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Latest</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Do3D</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">10D Avg</th>
              </tr></thead>
              <tbody>${dowRows(enriched)}</tbody>
            </table>
          </div>

          ${segs[0].d ? `
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.05em;margin:12px 0 6px">Segments (L5 Daily Avg)</div>
          <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:12px">
              <thead><tr style="background:#f9fafb">
                <th style="padding:6px 10px;text-align:left;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Segment</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">₹ Cr</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">WoW</th>
                <th style="padding:6px 10px;text-align:right;font-size:10px;color:#9ca3af;font-weight:600;text-transform:uppercase">Wo45</th>
              </tr></thead>
              <tbody>${segRows}</tbody>
            </table>
          </div>` : ''}

        </div>
      </div>`;
    }

    function regressionSection(shareData, exchangeName, color) {
      if (!shareData) return '';
      const reg = shareData.regression || {};
      const lat = shareData.latest || {};
      const maW = shareData.ma_window || 45;

      // Build charts at mobile width (380px)
      const origDefs = shareData;
      const chartResults = buildAllRegressionChartImgs(shareData, exchangeName);

      const statPills = [
        { l: 'R²',         v: reg.r_squared?.toFixed(4) || '—' },
        { l: 'Pearson r',  v: reg.pearson_r?.toFixed(4)  || '—' },
        { l: 'MA Window',  v: maW + '-day' },
        { l: 'Fit',        v: reg.fit || '—' },
      ].map(s => `<div style="background:#f0f4f0;border-radius:6px;padding:8px 10px;flex:1;min-width:70px;text-align:center">
        <div style="font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em">${s.l}</div>
        <div style="font-size:13px;font-weight:700;color:#1a1a1a;text-transform:capitalize">${s.v}</div>
      </div>`).join('');

      const latRows = [
        ['Date', lat.date || '—'],
        ['Actual Price', lat.price_actual != null ? '₹' + fmtNum(lat.price_actual, 0) : '—'],
        ['Predicted',    lat.price_pred   != null ? '₹' + fmtNum(lat.price_pred,   0) : '—'],
        ['Error %',      lat.error_pct != null ? lat.error_pct + '%' : '—'],
        ['Rev MA' + maW, lat.rev_ma    != null ? '₹' + fmtNum(lat.rev_ma, 2) + ' Cr' : '—'],
      ].map(([l, v]) => `<tr>
        <td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;color:#6b7280;font-size:12px">${l}</td>
        <td style="padding:7px 12px;border-bottom:1px solid #f3f4f6;font-weight:600;text-align:right;font-size:12px">${v}</td>
      </tr>`).join('');

      const chartImgs = chartResults.map(c =>
        `<div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.04em;margin-bottom:4px">${c.label}</div>
          <img src="${c.img}" alt="${c.label}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
        </div>`
      ).join('');

      return `
      <div style="margin-bottom:20px">
        <div style="background:${color};color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">${exchangeName} Share Price Regression</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px">
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">${statPills}</div>
          <div style="font-size:10px;font-family:monospace;background:#f0f4f0;border-left:3px solid ${color};padding:6px 10px;border-radius:0 4px 4px 0;color:#374151;margin-bottom:12px">${reg.equation || '—'}</div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:14px"><tbody>${latRows}</tbody></table>
          ${chartImgs}
        </div>
      </div>`;
    }

    function marketShareSection() {
      const chartResults = buildMarketShareChartImgs(nseDash, bseDash);
      if (!chartResults.length) return '';
      const chartImgs = chartResults.map(c =>
        `<div style="margin-bottom:10px">
          <div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#6b7280;letter-spacing:.04em;margin-bottom:4px">${c.label}</div>
          <img src="${c.img}" alt="${c.label}" style="width:100%;border-radius:6px;border:1px solid #e5e7eb">
        </div>`
      ).join('');
      return `
      <div style="margin-bottom:20px">
        <div style="background:#374151;color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">NSE vs BSE Market Share Trend</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px">
          ${chartImgs}
        </div>
      </div>`;
    }

    const body = `
      ${exchangeSection('NSE Update', '#1d4ed8', nseEnrich)}
      ${exchangeSection('BSE Update', '#0f766e', bseEnrich)}
      ${regressionSection(bseShare, 'BSE', '#0f766e')}
      ${marketShareSection()}
      ${mcxEnrich ? exchangeSection('MCX Update', '#7c3aed', mcxEnrich) : ''}
      ${regressionSection(mcxShare, 'MCX', '#7c3aed')}
    `;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
<title>NSE/BSE Weekly Report — ${latestDateStr}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         background: #f3f4f6; color: #111; padding: 12px; max-width: 480px; margin: 0 auto; }
  @media (min-width: 480px) { body { padding: 20px; } }
</style>
</head>
<body>
<div style="background:#1e3a2f;color:#fff;border-radius:12px;padding:16px 18px;margin-bottom:16px">
  <div style="font-size:18px;font-weight:800;letter-spacing:-.02em;margin-bottom:4px">NSE/BSE Weekly Update</div>
  <div style="font-size:12px;color:#86efac">As of ${latestDateStr} &nbsp;·&nbsp; Generated ${genTime}</div>
</div>
${body}
<div style="text-align:center;font-size:10px;color:#9ca3af;margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb">
  NSE/BSE/MCX Analytics Dashboard — Auto-generated report
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `nse-bse-report-${latestDateStr || 'latest'}.html`;
    a.click();
    URL.revokeObjectURL(url);

  } finally {
    if (btn) { btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Mobile'; btn.disabled = false; }
  }
}

init();
