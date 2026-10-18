// dashboard/js/00-core.js — Core: global state, utilities, chart colours and sizing, shared rx* tab components, loading overlay, sidebar and tab navigation, exchange switcher.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// Unified NSE+BSE+MCX Analytics Dashboard
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

// Text size for on-screen chart ticks and axis titles (the base font, legend and
// tooltip are 11 too). The off-screen report image builders keep their own
// fixed sizes, since those images are laid out for print.
const CHART_FONT = { tick: 11, title: 11 };

// Phones: a chart whose canvas is narrower than this hides its axis titles and
// puts its legend below the plot, so the plot keeps the width. Only the chart's
// own config copy is changed, and the original values come back once it is
// wider again. Charts outside a .chart-wrapper (report images) are skipped.
const COMPACT_CHART_WIDTH = 480;
let compactPluginRegistered = false;

function setCompactChartLayout(chart, width) {
  if (!width || !chart.canvas || !chart.canvas.closest('.chart-wrapper')) return;
  const narrow = width < COMPACT_CHART_WIDTH;
  if (narrow === Boolean(chart.$compactSaved)) return;
  // chart.config.options is Chart.js's per-chart copy; it carries edits made
  // here into every later update until they are undone.
  const opts = chart.config.options;
  if (narrow) {
    const saved = { titles: [], legend: null, ticks: [] };
    Object.entries(opts.scales || {}).forEach(([id, s]) => {
      if (s && s.title && s.title.display) { s.title.display = false; saved.titles.push(id); }
    });
    // Horizontal axis: no rotated labels and at most 6 of them
    const x = opts.scales && opts.scales.x;
    if (x && x.type !== 'linear' && x.type !== 'logarithmic') {
      const t = x.ticks || (x.ticks = {});
      saved.ticks.push({ id: 'x', maxRotation: t.maxRotation, maxTicksLimit: t.maxTicksLimit, autoSkip: t.autoSkip });
      t.maxRotation = 0;
      t.autoSkip = true;
      t.maxTicksLimit = Math.min(t.maxTicksLimit || Infinity, 6);
    }
    opts.plugins = opts.plugins || {};
    const legend = opts.plugins.legend || (opts.plugins.legend = {});
    if (legend.display !== false && legend.position !== 'bottom') {
      saved.legend = { had: Object.prototype.hasOwnProperty.call(legend, 'position'), position: legend.position };
      legend.position = 'bottom';
    }
    chart.$compactSaved = saved;
  } else {
    const saved = chart.$compactSaved;
    saved.titles.forEach(id => {
      const s = opts.scales && opts.scales[id];
      if (s && s.title) s.title.display = true;
    });
    saved.ticks.forEach(({ id, ...orig }) => {
      const t = opts.scales && opts.scales[id] && opts.scales[id].ticks;
      if (t) Object.entries(orig).forEach(([k, v]) => { if (v === undefined) delete t[k]; else t[k] = v; });
    });
    const legend = opts.plugins && opts.plugins.legend;
    if (saved.legend && legend) {
      if (saved.legend.had) legend.position = saved.legend.position;
      else delete legend.position;
    }
    chart.$compactSaved = null;
  }
}

// `resize` runs just before Chart.js re-lays out for a new size (including the
// first sizing when the chart attaches), so the edits apply in that same pass.
// `beforeUpdate` is only a fallback: legend changes made there show from the
// next update, because the legend reads its position earlier in the cycle.
const compactOnNarrowPlugin = {
  id: 'compactOnNarrow',
  resize(chart, args) { setCompactChartLayout(chart, args.size.width); },
  afterInit(chart) { setCompactChartLayout(chart, chart.width); },
  beforeUpdate(chart) { setCompactChartLayout(chart, chart.width); },
};

function applyChartDefaults() {
  if (!compactPluginRegistered) {
    Chart.register(compactOnNarrowPlugin);
    compactPluginRegistered = true;
  }
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
  // Merge, never replace: a replaced grid/border object drops Chart.js's other
  // scale defaults, which leaves bar elements without a base (nothing drawn).
  // Grid lines, tick marks and axis borders stay off unless a chart asks for
  // them, which is how the replaced objects used to resolve.
  Object.assign(Chart.defaults.scale.grid, { color: getGridColor(), display: false, drawTicks: false });
  Object.assign(Chart.defaults.scale.border, { color: getScaleBorderColor(), display: false });
  Chart.defaults.elements.line.tension = 0.3;
  Chart.defaults.elements.line.borderWidth = 2;
  Chart.defaults.elements.point.radius = 0;
  Chart.defaults.elements.point.hoverRadius = 5;
  Chart.defaults.animation.duration = 700;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
}

applyChartDefaults();

// Chart heights. Each chart passes the height it has always had; that is its
// floor. On a wrapper at least CHART_GROW_FROM_WIDTH wide the height follows
// the width (CHART_HEIGHT_PER_WIDTH, capped at CHART_MAX_HEIGHT), so a
// full-width desktop chart is no longer a thin strip. Narrower or hidden
// (width 0) wrappers keep the floor. Charts are responsive with
// maintainAspectRatio off, so Chart.js follows the wrapper height.
const CHART_GROW_FROM_WIDTH = 640;
const CHART_HEIGHT_PER_WIDTH = 0.36;
const CHART_MAX_HEIGHT = 440;

function sizeChartWrapper(wrapper) {
  const minH = Number(wrapper.dataset.minH);
  if (!minH) return;
  const width = wrapper.clientWidth;
  // data-fixed: a strip chart that keeps its floor height at any width
  const h = width >= CHART_GROW_FROM_WIDTH && !wrapper.dataset.fixed
    ? Math.round(Math.max(minH, Math.min(CHART_MAX_HEIGHT, width * CHART_HEIGHT_PER_WIDTH)))
    : minH;
  const px = h + 'px';
  if (wrapper.style.height !== px) wrapper.style.height = px;
}

function resizeChartWrappers() {
  document.querySelectorAll('[data-min-h]').forEach(sizeChartWrapper);
}

function setCanvasHeight(id, h) {
  const c = document.getElementById(id);
  if (!c) return;
  c.parentElement.dataset.minH = h;
  sizeChartWrapper(c.parentElement);
}

let chartWrapperResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(chartWrapperResizeTimer);
  chartWrapperResizeTimer = setTimeout(resizeChartWrappers, 150);
});

// ========================
// REDESIGNED TABS — shared components (Revenue Predictor, Live Predictor,
// Regression, Valuation Model). Markup uses the .rx / .rx-* classes in
// style.css; the Revenue Summary tab keeps its own components.
// ========================

// Colour jobs, kept in sync with the .rx tokens in style.css: ink = actual or
// subtotal, model = model / forecast, rev = revenue; pos/neg only for up/down.
const RX = {
  ink: '#16181D', ink2: '#3B3E46', muted: '#62656D', grey: '#9A9DA4', light: '#C9CBCF',
  grid: '#EEEEEA', axis: '#CFCFC8',
  model: '#2B5CC8', modelBand: '#DCE5F7', modelBand2: '#F1F4FB',
  rev: '#C4621A', pos: '#176C2E', neg: '#A01822',
  above: '#D39A6E', below: '#8AA5E0',
  add: '#5E8A6B', deduct: '#C0868B',
  seq: ['#C9D6F3', '#9FB6EA', '#6F8FDB', '#3F67C9', '#1E3F8F'],
};
const RX_FONT = "'IBM Plex Sans', Arial, sans-serif";

// Called after a redesigned tab becomes visible, so its charts are drawn at
// their real size (Chart.js mis-sizes some charts built while display:none).
// Keyed by tab id; rebuildAll clears it, each builder sets its own entry.
let RX_TAB_REFRESH = {};

const RX_ICONS = {
  ok: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 15 14.5H1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6v4M8 11.8v.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  fail: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4.5M8 4.6v.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
};

function rxPanel({ title, meta = '', right = '', body = '', foot = '', how = '', cls = '', attrs = '' }) {
  return `<section class="rx-panel ${cls}" ${attrs}>
    <div class="rx-ph"><h2>${title}</h2>${meta ? `<span class="rx-meta">${meta}</span>` : ''}${right ? `<div class="rx-ph-right">${right}</div>` : ''}</div>
    ${body}${foot ? `<p class="rx-foot">${foot}</p>` : ''}${how}
  </section>`;
}

function rxKpi(label, value, sub = '', { cls = '', accent = false, extra = '' } = {}) {
  return `<div class="rx-kpi${accent ? ' rx-kpi--accent' : ''}">
    <div class="rx-lbl">${label}</div>
    <div class="rx-kpi-v ${cls}">${value}</div>
    ${sub ? `<div class="rx-kpi-s">${sub}</div>` : ''}${extra}
  </div>`;
}

function rxKpis(items, aria = '') {
  return `<section class="rx-kpis"${aria ? ` aria-label="${escHtml(aria)}"` : ''}>${items.join('')}</section>`;
}

function rxChip(text, kind = '') {
  return `<span class="rx-chip${kind ? ' rx-chip--' + kind : ''}">${text}</span>`;
}

// Segmented control; rxOnSeg wires it. `options` are [value, label] pairs.
function rxSeg(group, options, active, aria) {
  return `<div class="rx-seg" role="group" aria-label="${escHtml(aria || group)}" data-rx-seg="${group}">${options.map(([v, label]) =>
    `<button type="button" data-value="${v}" aria-pressed="${String(v) === String(active)}">${label}</button>`).join('')}</div>`;
}

function rxOnSeg(root, group, onPick) {
  const seg = root.querySelector(`[data-rx-seg="${group}"]`);
  if (!seg) return;
  seg.addEventListener('click', e => {
    const btn = e.target.closest('button[data-value]');
    if (!btn || btn.getAttribute('aria-pressed') === 'true') return;
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === btn)));
    onPick(btn.dataset.value);
  });
}

function rxCheck(state, title, sub) {
  return `<div class="rx-check rx-check--${state}">${RX_ICONS[state] || RX_ICONS.info}<div><b>${title}</b><span>${sub}</span></div></div>`;
}

function rxAlert(html, kind = 'warn') {
  return `<div class="rx-alert${kind === 'info' ? ' rx-alert--info' : ''}" role="note">${RX_ICONS[kind === 'info' ? 'info' : 'warn']}<div>${html}</div></div>`;
}

function rxHow(summary, html) {
  return `<details class="rx-how"><summary>${summary}</summary>${html}</details>`;
}

// Legend swatches: box (fill), line, dash, dot, tick, hatch
function rxLegend(items) {
  return `<div class="rx-legend">${items.map(({ label, color, kind = 'box', style = '' }) => {
    const sw = kind === 'box' ? `<i style="background:${color};${style}"></i>`
      : kind === 'hatch' ? `<i class="rx-hatch" style="${style}"></i>`
      : kind === 'tick' ? `<i class="rx-tick" style="color:${color}"></i>`
      : `<i class="rx-ln${kind === 'dash' ? ' rx-ln--dash' : kind === 'dot' ? ' rx-ln--dot' : ''}" style="color:${color}"></i>`;
    return `<span>${sw}${label}</span>`;
  }).join('')}</div>`;
}

// Signed percentage of a ratio change (0.039 → "▲ +3.9 %"), with its class
function rxChange(frac, digits = 1) {
  if (frac == null || !isFinite(frac)) return { text: '—', cls: '' };
  const up = frac >= 0;
  return { text: `${up ? '▲ +' : '▼ −'}${Math.abs(frac * 100).toFixed(digits)} %`, cls: up ? 'rx-up' : 'rx-dn' };
}

function rxChangeHTML(frac, digits = 1) {
  const c = rxChange(frac, digits);
  return `<span class="${c.cls}">${c.text}</span>`;
}

// Plain signed percent without arrow, for table cells ("+3.9 %")
function rxSignedPct(frac, digits = 1) {
  if (frac == null || !isFinite(frac)) return '—';
  return `${frac >= 0 ? '+' : '−'}${Math.abs(frac * 100).toFixed(digits)} %`;
}

function rxRupee(v, digits = 0) {
  return v == null || !isFinite(v) ? '—' : '₹' + fmtNum(v, digits);
}

function rxCr(v, digits = 1) {
  return v == null || !isFinite(v) ? '—' : '₹' + fmtNum(v, digits) + ' Cr';
}

// "2025-03-01" → "1 Mar 2025"
function rxDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '—';
  return `${+m[3]} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1]} ${m[1]}`;
}

// Chart.js config in the redesigned style: Plex type, hairline grid, dark
// tooltip, no canvas legend (panels carry an HTML legend instead).
function rxChartConfig(config) {
  const o = config.options || (config.options = {});
  const font = { family: RX_FONT, size: 11 };
  o.plugins = o.plugins || {};
  o.plugins.legend = Object.assign({ display: false }, o.plugins.legend);
  o.plugins.tooltip = Object.assign({
    backgroundColor: RX.ink, titleColor: '#FFFFFF', bodyColor: '#FFFFFF', footerColor: '#D5D7DB',
    borderColor: RX.ink, borderWidth: 0, cornerRadius: 2, padding: 8, boxPadding: 4,
    titleFont: { family: RX_FONT, size: 11.5, weight: '600' }, bodyFont: font, footerFont: { family: RX_FONT, size: 11, weight: '400' },
  }, o.plugins.tooltip);
  // Bars are not animated: Chart.js leaves a bar's animated `base` unset (bar
  // never drawn) when its chart was resized during the opening animation.
  if (o.animation === undefined) o.animation = config.type === 'bar' ? false : { duration: 250 };
  Object.values(o.scales || {}).forEach(s => {
    s.ticks = Object.assign({ color: RX.muted }, s.ticks, { font });
    s.grid = Object.assign({ display: true, drawTicks: false, color: RX.grid }, s.grid);
    s.border = Object.assign({ display: true, color: RX.axis }, s.border);
    if (s.title) s.title = Object.assign({ color: RX.muted }, s.title, { font });
  });
  return config;
}

// Replaces charts[key] with a new chart on canvas `id` (height floor minH)
function rxChart(key, id, minH, config) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  setCanvasHeight(id, minH);
  charts[key] = new Chart(canvas, rxChartConfig(config));
  return charts[key];
}

// Keeps a chart at its floor height at any width (strip and secondary charts)
function rxFixHeight(chart) {
  if (!chart || !chart.canvas) return;
  chart.canvas.parentElement.dataset.fixed = '1';
  sizeChartWrapper(chart.canvas.parentElement);
}

function rxCanvas(id, cls = '') {
  return `<div class="chart-wrapper ${cls}"><canvas id="${id}"></canvas></div>`;
}

// Date `n` weekdays after `iso` (holidays not counted)
function rxAddWeekdays(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
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
  clearLoadError();
  overlay.classList.add('visible');
}

function hideLoading() {
  clearLoadError();
  document.getElementById('loadingOverlay').classList.remove('visible');
}

function clearLoadError() {
  document.getElementById('loadingOverlay').classList.remove('is-error');
  const actions = document.getElementById('loadingActions');
  actions.hidden = true;
  actions.innerHTML = '';
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
    { id: 'prediction', label: 'Revenue Predictor',   icon: 'prediction' },
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
    prediction: 'Revenue Predictor',
    intraday: 'Live Predictor',
    share: 'Regression',
    valuation: 'Valuation Model',
  },
  bse: {
    revenue: 'Revenue Summary',
    prediction: 'Revenue Predictor',
    intraday: 'Live Predictor',
    share: 'Regression',
    valuation: 'Valuation Model',
  },
  mcx: {
    revenue: 'Revenue Summary',
    prediction: 'Revenue Predictor',
    share: 'Regression',
    valuation: 'Valuation Model',
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
  // Phones only (CSS hides it above 640 px): back to the glance view
  const glance = `<button class="nav-item nav-item--glance" data-glance="1" aria-label="At a glance">
      ${NAV_ICONS.temporal}
      At a glance
    </button>`;
  nav.innerHTML = glance + tabs.map((t, i) =>
    `<button class="nav-item${i === 0 ? ' active' : ''}" data-tab="${t.id}" aria-label="${t.label}">
      ${NAV_ICONS[t.icon]}
      ${t.label}
    </button>`
  ).join('');
  nav.querySelector('[data-glance]').addEventListener('click', () => {
    document.getElementById('sidebarOverlay').classList.remove('open');
    enterGlance(true);
  });
  attachTabListeners();
}

// ========================
// TAB NAVIGATION
// ========================

function attachTabListeners() {
  document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
    btn.addEventListener('click', e => {
      const tab = btn.dataset.tab;
      // A tab the viewer picks from the menu leaves the glance view; the
      // programmatic first-tab click after a load keeps it.
      if (e.isTrusted && glanceActive()) {
        document.body.classList.remove('glance-mode');
        document.getElementById('glanceView').hidden = true;
        updateHeaderExchange(currentExchange);
      }
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
      const tabEl = document.getElementById('tab-' + tab);
      if (tabEl) tabEl.classList.add('active');
      const titles = TAB_TITLES[currentExchange] || {};
      document.getElementById('headerTitle').textContent = titles[tab] || tab;
      if (glanceActive()) {
        document.getElementById('headerTitle').textContent = 'At a glance';
        updateHeaderExchange(GLANCE_EX);
        btn.classList.remove('active');
        document.querySelector('.nav-item[data-glance]')?.classList.add('active');
      }
      // Flag mixed snapshots / missing date-effective files for this view, then
      // refetch anything it uses that has gone stale
      updateSnapshotNotice();
      updateFeeNotice();
      checkDataFreshness();
      // Close mobile nav
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('open');
      // Resize charts after tab switch: wrappers first (charts built while
      // hidden only got their minimum height), then the charts
      setTimeout(() => {
        resizeChartWrappers();
        Object.values(charts).forEach(c => { if (c && c.resize) c.resize(); });
        // Redesigned tabs redraw their charts now that the canvas has its real size
        RX_TAB_REFRESH[tab]?.();
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
    resizeChartWrappers();
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
      // In the glance view a single exchange only changes the glance's own switch
      if (glanceActive() && !COMBINED_VIEWS[exchange]) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebarOverlay').classList.remove('open');
        GLANCE_EX = exchange;
        updateHeaderExchange(exchange);
        renderGlance();
        return;
      }
      if (glanceActive()) {
        document.body.classList.remove('glance-mode');
        document.getElementById('glanceView').hidden = true;
      }
      if (exchange === currentExchange) return;
      document.querySelectorAll('.exchange-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      await switchExchange(exchange);
    });
  });
}

// Phones/tablets hide the sidebar, so the header carries a badge naming the
// current exchange (same label as its switcher button).
function updateHeaderExchange(exchange) {
  const badge = document.getElementById('headerExchange');
  const btn = document.querySelector(`.exchange-btn[data-exchange="${exchange}"]`);
  if (badge) badge.textContent = btn ? btn.textContent.trim() : exchange.toUpperCase();
}

let switchSeq = 0;          // latest exchange load; an older one still in flight yields to it
let shownExchange = null;  // last exchange whose views were built, for "Back to …" after a failed load

// Loads an exchange and builds its views. A switch made while this one is
// still loading takes over (the older load never touches the page). If the
// data cannot be loaded, the overlay says so and offers Retry, and a way back
// to the exchange shown before, instead of spinning forever. Resolves to true
// once the views are built.
async function switchExchange(exchange) {
  const seq = ++switchSeq;
  const owns = () => seq === switchSeq;
  showLoading(exchange);
  // Destroy all existing charts
  Object.values(charts).forEach(c => { if (c && c.destroy) c.destroy(); });
  Object.keys(charts).forEach(k => delete charts[k]);
  currentExchange = exchange;
  // Update logo
  const logoLabels = { nse: 'NSE Analytics', bse: 'BSE Analytics', mcx: 'MCX Analytics', all: 'All Exchanges', nsebse: 'NSE+BSE' };
  document.getElementById('logoText').textContent = logoLabels[exchange] || exchange.toUpperCase() + ' Analytics';
  document.querySelectorAll('.exchange-btn').forEach(b => b.classList.toggle('active', b.dataset.exchange === exchange));
  updateHeaderExchange(exchange);
  // Update sidebar nav
  buildSidebarNav(exchange);
  // Show/hide exchange-specific content sections
  toggleExchangeContent(exchange);
  try {
    if (!await loadExchangeData(exchange, owns)) return false;
  } catch (err) {
    console.error(`Loading ${exchange} failed:`, err);
    if (owns()) showLoadError(exchange, err);
    return false;
  }
  // Update header info
  updateHeaderInfo();
  // Build all visualizations
  rebuildAll();
  shownExchange = exchange;
  hideLoading();
  // Activate first tab
  const firstNavItem = document.querySelector('.nav-item[data-tab]');
  if (firstNavItem) firstNavItem.click();
  return true;
}

// The loading overlay's failure state: what failed, Retry, and (after a
// switch) Back to the exchange shown before.
function showLoadError(exchange, err) {
  const overlay = document.getElementById('loadingOverlay');
  const name = exchange === 'all' ? 'All Exchanges' : exchange === 'nsebse' ? 'NSE+BSE' : exchange.toUpperCase();
  const status = err && err.status ? ` (HTTP ${err.status})` : '';
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  document.getElementById('loadingText').textContent = offline
    ? `Couldn't load ${name} data: you appear to be offline.`
    : `Couldn't load ${name} data${status}. The data files may be updating; try again in a moment.`;
  const actions = document.getElementById('loadingActions');
  const back = shownExchange && shownExchange !== exchange ? shownExchange : null;
  actions.innerHTML = `<button type="button" class="loading-btn loading-btn--primary" data-act="retry">Retry</button>`
    + (back ? `<button type="button" class="loading-btn" data-act="back">Back to ${back === 'all' ? 'All Exchanges' : back === 'nsebse' ? 'NSE+BSE' : back.toUpperCase()}</button>` : '');
  actions.hidden = false;
  actions.querySelector('[data-act="retry"]').onclick = () => switchExchange(exchange);
  if (back) actions.querySelector('[data-act="back"]').onclick = () => switchExchange(back);
  overlay.classList.add('visible', 'is-error');
  actions.querySelector('[data-act="retry"]').focus();
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

