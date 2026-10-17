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
// days=1 is stored so computeQuarterMetrics / getMAvg return the value as-is.
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
    for (const url of [`/api/live?exchange=${ex}&file=hourly&t=${Date.now()}`, `./data/${ex}_live_hourly.json`]) {
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
  const common = [updateSnapshotNotice, updateFeeNotice, updateFeeToggle, buildFeeNote, buildRevenueSummary];
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

// ── Expiry calendar (NSE & BSE only) ─────────────────────────────────────────
// Copy of EXPIRY_RULES in scripts/expiry_calendar.py, the source of truth (the
// circular behind each rule is noted there); scripts/check_expiry_calendar.py
// fails CI if the two drift. The weekly expiry falls on `weekday`, the monthly
// on the month's last `weekday`. Dates are inclusive, null = open-ended, and
// boundaries sit on Monday/Sunday so each Mon–Sun week has one expiry day.
const EXPIRY_RULES = [
  { exchange: 'nse', effective_from: null,         effective_to: '2025-08-31', weekday: 'Thursday' },
  { exchange: 'nse', effective_from: '2025-09-01', effective_to: null,         weekday: 'Tuesday' },
  { exchange: 'bse', effective_from: null,         effective_to: '2025-01-05', weekday: 'Friday' },
  { exchange: 'bse', effective_from: '2025-01-06', effective_to: '2025-08-31', weekday: 'Tuesday' },
  { exchange: 'bse', effective_from: '2025-09-01', effective_to: null,         weekday: 'Thursday' },
];
const EXPIRY_DOW_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function expiryRuleFor(exchange, dateStr) {
  return EXPIRY_RULES.find(r => r.exchange === exchange
    && (r.effective_from === null || dateStr >= r.effective_from)
    && (r.effective_to === null || dateStr <= r.effective_to)) || null;
}

// True when dateStr ('YYYY-MM-DD') falls on the expiry weekday of the rule in
// force on that same date — so across a rule change each candidate day is
// judged by its own rule (e.g. NSE Aug 2025 → last Thursday, Sep → last Tuesday).
function isScheduledExpiry(exchange, dateStr) {
  const rule = expiryRuleFor(exchange, dateStr);
  return !!rule && EXPIRY_DOW_NAMES[new Date(dateStr + 'T00:00:00Z').getUTCDay()] === rule.weekday;
}

// Header wording for the month-end tables: "Tuesday" while one rule covers the
// data, otherwise the history, e.g. "expiry weekday (Thu → Tue from Sep 2025)".
function monthEndExpiryWeekdayLabel(exchange, dailyAll) {
  const first = dailyAll.reduce((mn, r) => (!mn || r.date < mn ? r.date : mn), '');
  const last = dailyAll.reduce((mx, r) => (r.date > mx ? r.date : mx), '');
  const rules = EXPIRY_RULES.filter(r => r.exchange === exchange
    && (r.effective_to === null || r.effective_to >= first)
    && (r.effective_from === null || r.effective_from <= last));
  if (rules.length <= 1) return rules.length ? rules[0].weekday : 'expiry weekday';
  const mon = s => new Date(s + 'T00:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const steps = rules.map((r, i) => i === 0 || !r.effective_from
    ? r.weekday.slice(0, 3)
    : `${r.weekday.slice(0, 3)} from ${mon(r.effective_from)}`);
  return `expiry weekday (${steps.join(' → ')})`;
}

// ── Month-end expiry comparison (NSE & BSE only) ──────────────────────────────
// Derived purely from observed trading dates in DATA.daily_all — no separate
// holiday calendar needed. Expiry = the calendar month's last scheduled expiry
// day per EXPIRY_RULES (last Tuesday for NSE since Sep 2025, last Thursday
// before; see the table for BSE); if that exact date isn't an actual trading
// day (holiday), walk back one calendar day at a time until landing on one that is.
function computeMonthExpiryDates(dailyAll, exchange) {
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
    // Latest day of the month that is a scheduled expiry under the rule in
    // force on that day. A month straddling a rule change therefore ends on
    // the new rule's last weekday if that falls on/after the change, else on
    // the old rule's (BSE Jan 2025: Friday rule to 5 Jan, then Tuesday → 28 Jan).
    while (cursor.getUTCDate() > 1 && !isScheduledExpiry(exchange, toStr(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (!isScheduledExpiry(exchange, toStr(cursor))) return; // no rule covers this month

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
// each calendar month: that week's scheduled expiry day per EXPIRY_RULES
// (Tuesday NSE / Thursday BSE today), or the nearest earlier trading day if
// that's a holiday — bounded to not walk back past that week's own Monday (a
// holiday-shift never borrows from last week).
function computeWeekExpiryDates(dailyAll, exchange) {
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
    // The week's scheduled expiry: the day (Mon–Fri) whose weekday matches the
    // rule in force on that day. Rule boundaries are Mondays, so exactly one
    // day qualifies; the latest is taken should a mid-week change ever qualify two.
    let target = null;
    for (let i = 4; i >= 0 && !target; i--) {
      const c = new Date(monday);
      c.setUTCDate(monday.getUTCDate() + i);
      if (isScheduledExpiry(exchange, toStr(c))) target = c;
    }
    if (!target) return;
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
  return { label: m.month, value: rec[rf.dField] || 0, flags: periodFlags(rec, segKey) };
}

function getExpiryValueForQuarterLabel(quarterLabel, exchange, segKey) {
  if (!quarterLabel) return null;
  const dailyAll = DATA.daily_all || [];
  const rf = getRevFieldObj(segKey);
  const byDate = new Map(dailyAll.map(r => [r.date, r]));
  const recs = computeMonthExpiryDates(dailyAll, exchange)
    .map(e => byDate.get(e.expiryDate))
    .filter(rec => rec && rec.fy_quarter === quarterLabel);
  const vals = recs.map(rec => rec[rf.dField] || 0);
  if (!vals.length) return null;
  return { label: quarterLabel, value: vals.reduce((s, v) => s + v, 0) / vals.length, flags: rowsFlags(recs, segKey) };
}

function getExpiryValueForQuarterIdx(qIdx, exchange, segKey) {
  const q = DATA.quarterly?.[qIdx];
  return q ? getExpiryValueForQuarterLabel(q.quarter, exchange, segKey) : null;
}

function renderExpiryMonthRow(rowNum, mIdx, exchange, segKey) {
  const cur   = getExpiryValueForMonthIdx(mIdx, exchange, segKey);
  const valEl = document.getElementById(`expiryMVal${rowNum}-${segKey}`);
  const chgEl = document.getElementById(`expiryMChg${rowNum}-${segKey}`);
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) + flagTags(cur.flags) : '—';
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
  if (valEl) valEl.innerHTML = cur ? wireVal(cur.value, 2) + flagTags(cur.flags) : '—';
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

  const expiryWeekday = monthEndExpiryWeekdayLabel(exchange, dailyAll);
  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Month-End Expiry Comparison <span class="xl-seg-unit">last trading day on/before the month's last ${expiryWeekday} · ₹ Cr</span></div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:var(--space-3)">
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table expiry-month-table">
          <thead><tr><th>Month</th><th>Val (In Cr)</th><th>MoM</th></tr></thead>
          <tbody>${monthRowsHTML}</tbody>
        </table>
      </div>
      <div class="wire-table-scroll" style="flex:1;min-width:260px">
        <table class="wire-table expiry-quarter-table">
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
    const otherRecs = weekDates
      .filter(d => d !== meDate)
      .map(d => byDate.get(d))
      .filter(Boolean);
    const otherVals = otherRecs.map(r => r[rf.dField] || 0);
    if (!otherVals.length) return; // month had no other weekly expiry to compare against
    const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
    const monthEndVal = meRec[rf.dField] || 0;
    const diff = avgWeekly ? (monthEndVal - avgWeekly) / avgWeekly : null;
    rows.push({ monthKey, fy_month: meRec.fy_month, avgWeekly, monthEndVal, diff,
      weeklyFlags: rowsFlags(otherRecs, segKey), monthEndFlags: periodFlags(meRec, segKey) });
  });
  rows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  if (!rows.length) return '';

  const recent = rows.slice(-12);
  const rowsHTML = recent.map(r => `
    <tr>
      <td>${r.fy_month}</td>
      <td class="wire-value">${wireVal(r.avgWeekly, 2)}${flagTags(r.weeklyFlags)}</td>
      <td class="wire-value">${wireVal(r.monthEndVal, 2)}${flagTags(r.monthEndFlags)}</td>
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
      <td class="wire-value">${wireVal(avgWeekly, 2)}${flagTags(mergeFlags(window.map(r => r.weeklyFlags)))}</td>
      <td class="wire-value">${wireVal(avgMonthEnd, 2)}${flagTags(mergeFlags(window.map(r => r.monthEndFlags)))}</td>
      ${wireDeltaTd(diff)}
    </tr>`;
  }).join('');

  return `
  <div style="margin-top:var(--space-4)">
    <div class="xl-seg-header">${exchange.toUpperCase()} Weekly vs Month-End Expiry <span class="xl-seg-unit">avg of that month's other weekly expiries vs the month-end one · ₹ Cr</span></div>
    <div class="wire-table-scroll" style="margin-top:var(--space-3)">
      <table class="wire-table wvm-table">
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

// ── Per-exchange sources ──────────────────────────────────────────────────────
// A combined view's daily average for any period is the sum of each
// exchange's own daily average for it (that exchange's revenue ÷ its own
// trading days). Single-exchange views have one source, DATA itself, so the
// sum is just that exchange's figure. An exchange with no rows for the
// period adds nothing (e.g. MCX alone before NSE/BSE data starts in FY 2024).
function revenueSources() {
  return DATA.components || [{ quarterly: DATA.quarterly || [], monthly: DATA.monthly || [], daily_all: DATA.daily_all || [] }];
}

function sumOverSources(perSource) {
  const vals = revenueSources().map(perSource).filter(v => v != null);
  return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
}

// ── Fee-basis and modelled-history labels ─────────────────────────────────────
// Date-effective NSE/BSE rows and periods carry fee_basis / fee_basis_by_product
// (scripts/fee_register.py); MCX rows carry `modelled` and MCX periods
// `modelled_days`. A displayed value is flagged when any row behind it was
// priced at a slab-era flat estimate (slab) or a provisional calibrated BSE cash
// rate (prov), or is modelled MCX history (modelled). Values get an "est." or
// "modelled" marker; a % change with modelled days on either side is shown as
// "—". Files without these fields (today's rates, older pipeline output) carry
// no flags, so nothing is marked.
const SEG_PRODUCT = { options: 'opt', futures: 'fut', cash: 'cash' };
const NO_FLAGS = Object.freeze({ slab: false, prov: false, modelled: false });
const FEE_EST_TITLES = {
  slab: 'Slab-era estimate: transaction fees were tiered by volume slab before 1 Oct 2024 (NSE; BSE options from 1 Nov 2023), so this figure uses a flat estimate of the blended rate (fee register).',
  prov: "Provisional: BSE cash revenue here uses a calibrated rate from BSE's last four reported quarters; it is updated when BSE reports the quarter.",
};
const MCX_MODELLED_TITLE = 'MCX revenue before 2 Sep 2024 is modelled — scaled to reported quarters, options split derived';

// Flags of one daily row or aggregate period, for a segment ('total' = any product)
function periodFlags(item, segKey) {
  if (!item) return NO_FLAGS;
  const prod = SEG_PRODUCT[segKey];
  const byProd = item.fee_basis_by_product;
  const bases = byProd ? (prod ? [byProd[prod]] : Object.values(byProd)) : (item.fee_basis ? [item.fee_basis] : []);
  const slab = bases.includes('slab_estimate');
  const prov = bases.includes('calibrated_provisional');
  const modelled = item.modelled === true || item.modelled_days > 0;
  return slab || prov || modelled ? { slab, prov, modelled } : NO_FLAGS;
}

function mergeFlags(list) {
  const out = { slab: false, prov: false, modelled: false };
  list.forEach(f => { if (f) { out.slab = out.slab || f.slab; out.prov = out.prov || f.prov; out.modelled = out.modelled || f.modelled; } });
  return out;
}

function rowsFlags(rows, segKey) { return mergeFlags((rows || []).map(r => periodFlags(r, segKey))); }

// Over every exchange behind the view (one for single-exchange views)
function sourcesFlags(perSource) { return mergeFlags(revenueSources().map(perSource)); }

function quarterFlags(label, segKey) {
  return sourcesFlags(src => periodFlags(src.quarterly.find(q => q.quarter === label), segKey));
}

function monthFlags(label, segKey) {
  return sourcesFlags(src => {
    const m = (src.monthly || []).find(x => x.month === label);
    return m ? periodFlags(m, segKey) : rowsFlags(src.daily_all.filter(r => r.fy_month === label), segKey);
  });
}

function fyFlags(fyStr, segKey) {
  return sourcesFlags(src => mergeFlags(src.quarterly.filter(q => q.quarter.endsWith(fyStr)).map(q => periodFlags(q, segKey))));
}

// Rows of each exchange's daily series from `from` to `to` (slice indices)
function tailFlags(from, to, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.slice(from, to), segKey));
}

// The 125 trading days ending at a month's last trading day (as getM6mAvg)
function m6Flags(monthLabel, segKey) {
  return sourcesFlags(src => {
    const daily = src.daily_all;
    const endIdx = daily.reduce((last, r, i) => r.fy_month === monthLabel ? i : last, -1);
    return endIdx < 0 ? NO_FLAGS : rowsFlags(daily.slice(Math.max(0, endIdx - 124), endIdx + 1), segKey);
  });
}

// A weekday's last n occurrences, or all of them within one quarter
function weekdayFlags(weekday, n, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.filter(r => r.day === weekday).slice(-n), segKey));
}

function weekdayQuarterFlags(weekday, qLabel, segKey) {
  return sourcesFlags(src => rowsFlags(src.daily_all.filter(r => r.day === weekday && r.fy_quarter === qLabel), segKey));
}

// "est." / "modelled" markers for a value with these flags ('' when none)
function flagTags(f) {
  if (!f) return '';
  let html = '';
  if (f.slab || f.prov) {
    const title = [f.slab && FEE_EST_TITLES.slab, f.prov && FEE_EST_TITLES.prov].filter(Boolean).join(' ');
    html += `<span class="fee-est" title="${title}">est.</span>`;
  }
  if (f.modelled) html += `<span class="mcx-modelled" title="${MCX_MODELLED_TITLE}">modelled</span>`;
  return html;
}

// A % change between periods, one of which contains modelled MCX days, is not shown
const CMP_MODELLED_SPAN = `<span class="xl-chg xl-neu cmp-na" title="${MCX_MODELLED_TITLE}">—</span>`;
const CMP_MODELLED_TD = `<td class="wire-delta neutral cmp-na" title="${MCX_MODELLED_TITLE}">—</td>`;

function anyModelled(...flags) { return flags.some(f => f && f.modelled); }

// ── Simple avg getters (no derived comparisons) ───────────────────────────────
function getFYAvg(fyStr, segKey) {
  const rf = getRevFieldObj(segKey);
  const value = sumOverSources(src => {
    const quarters = src.quarterly.filter(q => q.quarter.endsWith(fyStr));
    if (!quarters.length) return null;
    const rev  = quarters.reduce((s, q) => s + (q[rf.qField] || 0), 0);
    const days = quarters.reduce((s, q) => s + (q.days || q.trading_days || 1), 0);
    return rev / days;
  });
  return value == null ? null : { label: fyStr, value };
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

// "Avg 6M (125 days)": average of the last 125 trading days ending at the
// month's last trading day — the pipelines' avg_6m (seg_summary in
// scripts/*_pipeline.py), so for the latest month it equals the enriched
// value. Not an average of six calendar-month averages, which would weight a
// partial month like a full one.
const AVG_6M_LABEL = 'Avg 6M (125 days)';

function getM6mAvg(mIdx, segKey) {
  const rf = getRevFieldObj(segKey);
  const m  = DATA.monthly[mIdx];
  if (!m) return null;
  return sumOverSources(src => {
    const daily  = src.daily_all;
    const endIdx = daily.reduce((last, r, i) => r.fy_month === m.month ? i : last, -1);
    if (endIdx < 0) return null;
    const window = daily.slice(Math.max(0, endIdx - 124), endIdx + 1);
    return window.reduce((s, r) => s + (r[rf.dField] || 0), 0) / window.length;
  });
}

// ── Per-row render functions ──────────────────────────────────────────────────
// % change shown on each comparison row = (row0 - rowN) / rowN
// i.e. "current period is X% vs this row"

function renderFYRow(rowNum, fyStr, segKey) {
  const cur   = getFYAvg(fyStr, segKey);
  const flags = fyFlags(fyStr, segKey);
  const valEl = document.getElementById('xlFYVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlFYChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const refFY = document.getElementById('xlFY0-' + segKey)?.value;
    const ref = getFYAvg(refFY, segKey);
    chgEl.innerHTML = anyModelled(flags, fyFlags(refFY, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderQRow(rowNum, qIdx, segKey) {
  const cur   = getQAvg(qIdx, segKey);
  const flags = cur ? quarterFlags(cur.label, segKey) : NO_FLAGS;
  const valEl = document.getElementById('xlQVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlQChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) { chgEl.innerHTML = ''; return; }
    const ref = getQAvg(parseInt(document.getElementById('xlQ0-' + segKey)?.value), segKey);
    chgEl.innerHTML = anyModelled(flags, ref && quarterFlags(ref.label, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
  }
}

function renderMRow(rowNum, mIdx, segKey) {
  const cur   = getMAvg(mIdx, segKey);
  const flags = cur ? monthFlags(cur.label, segKey) : NO_FLAGS;
  const valEl = document.getElementById('xlMVal' + rowNum + '-' + segKey);
  const chgEl = document.getElementById('xlMChg' + rowNum + '-' + segKey);
  if (valEl) valEl.innerHTML = xlValPlain(cur?.value, 2) + flagTags(flags);
  if (chgEl) {
    if (rowNum === 0) {
      chgEl.innerHTML = '';
      // Recompute Avg 6M (125 days ending at row 0's month); its % chg is
      // row 0's month vs that average, like the pipelines' mo6m
      const avg = getM6mAvg(mIdx, segKey);
      const avgFlags = cur ? m6Flags(cur.label, segKey) : NO_FLAGS;
      const avgValEl = document.getElementById('xlMAvgVal-' + segKey);
      const avgChgEl = document.getElementById('xlMAvgChg-' + segKey);
      if (avgValEl) avgValEl.innerHTML = xlValPlain(avg, 2) + flagTags(avgFlags);
      if (avgChgEl) avgChgEl.innerHTML = anyModelled(flags, avgFlags) ? CMP_MODELLED_SPAN
        : wireChg(avg && cur ? (cur.value - avg) / avg : null);
      return;
    }
    const ref = getMAvg(parseInt(document.getElementById('xlM0-' + segKey)?.value), segKey);
    chgEl.innerHTML = anyModelled(flags, ref && monthFlags(ref.label, segKey)) ? CMP_MODELLED_SPAN
      : wireChg(ref && cur ? (ref.value - cur.value) / cur.value : null);
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
  return sumOverSources(src => {
    const rows = src.daily_all.filter(r => r.day === weekday && r.fy_quarter === q.quarter);
    if (!rows.length) return null;
    return rows.reduce((s, r) => s + (r[rf.dField] || 0), 0) / rows.length;
  });
}

function renderWireQRow(weekday, rowNum, qIdx, segKey) {
  const valEl = document.getElementById(`wireQVal-${weekday}-${rowNum}-${segKey}`);
  const q = DATA.quarterly[qIdx];
  if (valEl) valEl.innerHTML = wireVal(getWeekdayQAvg(weekday, qIdx, segKey), 1)
    + (q ? flagTags(weekdayQuarterFlags(weekday, q.quarter, segKey)) : '');
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

  // Fee-basis / modelled flags of the trailing windows behind each figure
  const fl5 = tailFlags(-5, undefined, segKey), flp5 = tailFlags(-10, -5, segKey);
  const fl20 = tailFlags(-20, undefined, segKey), fl45 = tailFlags(-45, undefined, segKey);
  const flDow = mergeFlags(dayFull.map(d => weekdayFlags(d, 1, segKey)));
  const chgOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_SPAN : wireChg(val);
  const tdOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_TD : wireDeltaTd(val);

  const wRows = [
    `<tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}${flagTags(fl5)}</td><td>${chgOrNA(wl5.wow, fl5, flp5)}</td><td>${chgOrNA(wl5.wo10w, fl45)}</td></tr>`,
    `<tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}${flagTags(flp5)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}${flagTags(fl20)}</td><td></td><td></td></tr>`,
    `<tr><td>Last 45 Days</td><td>${xlValPlain(w50.value, 2)}${flagTags(fl45)}</td><td></td><td></td></tr>`,
    `<tr><td>Mon–Fri Avg (Latest)</td><td>${xlValPlain(dowLatestAvg, 2)}${flagTags(flDow)}</td><td></td><td></td></tr>`,
  ].join('');

  const wireDetailRow = (label, val, flags) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}${flagTags(flags)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const mkSel = (id, opts) => `<select class="xl-row-sel" id="${id}">${opts}</select>`;

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const f1 = weekdayFlags(d, 1, segKey), f3 = weekdayFlags(d, 3, segKey), f10 = weekdayFlags(d, 10, segKey);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(f1)}</td>
      ${tdOrNA(dd.do3d, f3)}
      ${tdOrNA(dd.do10d, f10)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d, f3)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d, f10)}`;
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
    const fq = label => label ? weekdayQuarterFlags(d, label, segKey) : NO_FLAGS;
    const fCur = fq(dd.cur_q_label);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(weekdayFlags(d, 1, segKey))}</td>
      ${tdOrNA(dd.qoq, fCur, fq(dd.prev_q_label))}
      ${tdOrNA(dd.yoy, fCur, fq(dd.yoy_q_label))}
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

  // Month: 2 selectable rows + 1 Avg 6M (125 days) row
  const mRows = [0, 1].map(r => `
    <tr${r === 0 ? ' class="xl-r-cur"' : ''}>
      <td>${mkSel('xlM' + r + '-' + segKey, mOpts)}</td>
      <td id="xlMVal${r}-${segKey}"></td>
      <td id="xlMChg${r}-${segKey}"></td>
      <td></td>
    </tr>`).join('') + `
    <tr>
      <td style="color:var(--color-text-secondary);font-size:11.5px">${AVG_6M_LABEL}</td>
      <td id="xlMAvgVal-${segKey}"></td>
      <td id="xlMAvgChg-${segKey}"></td>
      <td></td>
    </tr>`;

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg · ${feeUnitLabel()}</span></div>
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
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td title="Last 5 days vs the last 45 days">vs 45D</td></tr>
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
// segKey (optional) labels the figures from the view's own rows (revenueSources):
// fee-basis "est." / MCX "modelled" markers, and "—" for comparisons with modelled days.
function xlStaticSegmentBlock(st, label, segKey) {
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

  // fy.current is the FY of the latest trading day (the current quarter's FY)
  // and fy.previous the FY before it, so label them FY N and FY N-1 — not by
  // the previous quarter's label, which is still FY N except in Q1.
  const curFYNum    = +((q.current?.label || m.current?.label || '').match(/FY (\d{4})/)?.[1] || 0);
  const curFYLabel  = curFYNum ? `FY ${curFYNum}`     : 'Current FY';
  const prevFYLabel = curFYNum ? `FY ${curFYNum - 1}` : 'Prev FY';

  const fl = segKey ? fn => fn() : () => NO_FLAGS;
  const byLabel = (fn, lbl) => fl(() => lbl ? fn(lbl, segKey) : NO_FLAGS);
  const chgOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_SPAN : wireChg(val);
  const tdOrNA = (val, ...flags) => anyModelled(...flags) ? CMP_MODELLED_TD : wireDeltaTd(val);
  const fFY = byLabel(fyFlags, curFYNum && curFYLabel), fPFY = byLabel(fyFlags, curFYNum && prevFYLabel);
  const fQ = byLabel(quarterFlags, q.current?.label), fPQ = byLabel(quarterFlags, q.previous?.label), fQ2 = byLabel(quarterFlags, q.prev2?.label);
  const fM = byLabel(monthFlags, m.current?.label), fPM = byLabel(monthFlags, m.previous?.label), fM6 = byLabel(m6Flags, m.current?.label);
  const fl5 = fl(() => tailFlags(-5, undefined, segKey)), flp5 = fl(() => tailFlags(-10, -5, segKey));
  const fl20 = fl(() => tailFlags(-20, undefined, segKey)), fl45 = fl(() => tailFlags(-45, undefined, segKey));

  const fyRows = `
    <tr class="xl-r-cur"><td>${curFYLabel}</td><td>${xlValPlain(fy.current, 2)}${flagTags(fFY)}</td><td>${chgOrNA(fy.yoy, fFY, fPFY)}</td><td></td></tr>
    <tr><td>${prevFYLabel}</td><td>${xlValPlain(fy.previous, 2)}${flagTags(fPFY)}</td><td></td><td></td></tr>`;

  const qRows = [
    `<tr class="xl-r-cur"><td>${q.current?.label  || '—'}</td><td>${xlValPlain(q.current?.value, 2)}${flagTags(fQ)}</td><td>${chgOrNA(q.current?.qoq, fQ, fPQ)}</td><td></td></tr>`,
    `<tr><td>${q.previous?.label || '—'}</td><td>${xlValPlain(q.previous?.value, 2)}${flagTags(fPQ)}</td><td></td><td></td></tr>`,
    q.prev2 ? `<tr><td>${q.prev2.label}</td><td>${xlValPlain(q.prev2.value, 2)}${flagTags(fQ2)}</td><td></td><td></td></tr>` : '',
  ].join('');

  const mRows = `
    <tr class="xl-r-cur"><td>${m.current?.label  || '—'}</td><td>${xlValPlain(m.current?.value, 2)}${flagTags(fM)}</td><td>${chgOrNA(m.current?.mom, fM, fPM)}</td><td></td></tr>
    <tr><td>${m.previous?.label || '—'}</td><td>${xlValPlain(m.previous?.value, 2)}${flagTags(fPM)}</td><td></td><td></td></tr>
    <tr><td>${AVG_6M_LABEL}</td><td>${xlValPlain(m.avg_6m?.value, 2)}${flagTags(fM6)}</td><td>${chgOrNA(m.current?.mo6m, fM, fM6)}</td><td></td></tr>`;

  const wRows = `
    <tr class="xl-r-cur"><td>Last 5 Days</td><td>${xlValPlain(wl5.value, 2)}${flagTags(fl5)}</td><td>${chgOrNA(wl5.wow, fl5, flp5)}</td><td>${chgOrNA(wl5.wo10w, fl45)}</td></tr>
    <tr><td>Prev 5 Days</td><td>${xlValPlain(wp5.value, 2)}${flagTags(flp5)}</td><td></td><td></td></tr>
    <tr><td>Last 20 Days</td><td>${xlValPlain(w20.value, 2)}${flagTags(fl20)}</td><td></td><td></td></tr>
    <tr><td>Last 45 Days</td><td>${xlValPlain(w45.value, 2)}${flagTags(fl45)}</td><td></td><td></td></tr>`;

  const wireDetailRow = (label, val, flags) => label
    ? `<tr class="wire-detail"><td>${label}</td><td class="wire-value">${wireVal(val, 1)}${flagTags(flags)}</td><td></td><td></td></tr>` : '';
  const wireSpacerRow = '<tr class="wire-day-spacer"><td colspan="4"></td></tr>';

  const dowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const f1 = fl(() => weekdayFlags(d, 1, segKey)), f3 = fl(() => weekdayFlags(d, 3, segKey)), f10 = fl(() => weekdayFlags(d, 10, segKey));
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(f1)}</td>
      ${tdOrNA(dd.do3d, f3)}
      ${tdOrNA(dd.do10d, f10)}
    </tr>
    ${wireDetailRow('Average of last 3 ' + d + 's', dd.avg_3d, f3)}
    ${wireDetailRow('Average of last 10 ' + d + 's', dd.avg_10d, f10)}`;
  }).join(wireSpacerRow);

  const qdowRows = dayFull.map((d) => {
    const dd = dow[d] || {};
    const fq = lbl => fl(() => lbl ? weekdayQuarterFlags(d, lbl, segKey) : NO_FLAGS);
    const fCur = fq(dd.cur_q_label), fPrev = fq(dd.prev_q_label), fYoy = fq(dd.yoy_q_label);
    return `<tr class="wire-day-main">
      <td>${d}</td>
      <td class="wire-value">${wireVal(dd.latest, 1)}${flagTags(fl(() => weekdayFlags(d, 1, segKey)))}</td>
      ${tdOrNA(dd.qoq, fCur, fPrev)}
      ${tdOrNA(dd.yoy, fCur, fYoy)}
    </tr>
    ${wireDetailRow(dd.cur_q_label, dd.cur_q_avg, fCur)}
    ${wireDetailRow(dd.prev_q_label, dd.prev_q_avg, fPrev)}
    ${wireDetailRow(dd.yoy_q_label, dd.yoy_q_avg, fYoy)}`;
  }).join(wireSpacerRow);

  return `
    <div class="xl-segment">
      <div class="xl-seg-header">${label} <span class="xl-seg-unit">₹ Cr · daily avg${segKey ? ' · ' + feeUnitLabel() : ''}</span></div>
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
            <tr class="xl-col-hdr"><td>Week&gt;&gt;</td><td>Val (In Cr)</td><td>WoW</td><td title="Last 5 days vs the last 45 days">vs 45D</td></tr>
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

  // Fee-basis / modelled flags of each exchange's rows behind a period. A share
  // row with modelled MCX days on any side is not shown (not like for like).
  const SEG_OF_MS_KEY = { summary_total: 'total', seg_options: 'options', seg_futures: 'futures', seg_cash: 'cash' };
  const raw = ex => MARKET_RAW[ex];
  const qFlags = (label, sk) => mergeFlags(exList.map(ex => periodFlags((raw(ex).quarterly || []).find(x => x.quarter === label), sk)));
  const fyFlagsMS = (label, sk) => mergeFlags(exList.map(ex => mergeFlags((raw(ex).quarterly || []).filter(x => x.quarter.endsWith(label)).map(x => periodFlags(x, sk)))));
  const mFlags = (which, key, sk) => mergeFlags(exList.map(ex => {
    const lbl = ed(ex)[key]?.monthly?.[which]?.label;
    return periodFlags((raw(ex).monthly || []).find(x => x.month === lbl), sk);
  }));
  const tFlags = (from, to, sk) => mergeFlags(exList.map(ex => rowsFlags((raw(ex).daily_all || []).slice(from, to), sk)));

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
    const sk = SEG_OF_MS_KEY[key];

    // Build period rows — quarterly from raw (correct per-exchange days), rest from enriched
    const periods = [
      ...(curFYLabel  ? [{ lbl: curFYLabel,   vals: exList.map(ex => ed(ex)[key]?.fy?.current         || 0), flags: fyFlagsMS(curFYLabel, sk) }] : []),
      ...(curQLabel   ? [{ lbl: curQLabel,    vals: exList.map(ex => qAvg(ex, curQLabel,   key)), cur: true, flags: qFlags(curQLabel, sk) }] : []),
      ...(prevQLabel  ? [{ lbl: prevQLabel,   vals: exList.map(ex => qAvg(ex, prevQLabel,  key)), flags: qFlags(prevQLabel, sk) }] : []),
      ...(prev2QLabel && prev2QLabel !== prevQLabel ? [{ lbl: prev2QLabel, vals: exList.map(ex => qAvg(ex, prev2QLabel, key)), flags: qFlags(prev2QLabel, sk) }] : []),
      ...(yoyQLabel && yoyQLabel !== prevQLabel && yoyQLabel !== prev2QLabel ? [{ lbl: yoyQLabel, vals: exList.map(ex => qAvg(ex, yoyQLabel, key)), flags: qFlags(yoyQLabel, sk) }] : []),
      { lbl: refED.monthly?.current?.label  || 'Cur Month',  vals: exList.map(ex => ed(ex)[key]?.monthly?.current?.value  || 0), flags: mFlags('current', key, sk) },
      { lbl: refED.monthly?.previous?.label || 'Prev Month', vals: exList.map(ex => ed(ex)[key]?.monthly?.previous?.value || 0), flags: mFlags('previous', key, sk) },
      { lbl: AVG_6M_LABEL,    vals: exList.map(ex => ed(ex)[key]?.monthly?.avg_6m?.value  || 0), flags: tFlags(-125, undefined, sk) },
      { lbl: 'Last 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.last5?.value    || 0), flags: tFlags(-5, undefined, sk) },
      { lbl: 'Prev 5 Days',   vals: exList.map(ex => ed(ex)[key]?.weekly?.prev5?.value    || 0), flags: tFlags(-10, -5, sk) },
      { lbl: 'Last 45 Days',  vals: exList.map(ex => ed(ex)[key]?.weekly?.last45?.value   || 0), flags: tFlags(-45, undefined, sk) },
    ];

    const rows = periods.map(({ lbl, vals, cur, flags }) => {
      const total = vals.reduce((a, b) => a + b, 0);
      const na = anyModelled(flags);
      const cells = exList.map((ex, i) => na
        ? `<td><span class="ms-pct cmp-na" title="${MCX_MODELLED_TITLE}">—</span></td>`
        : `<td><span class="ms-pct ${MS_META[ex].cls}">${pct(vals[i], total)}</span></td>`
      ).join('');
      return `<tr${cur ? ' class="xl-r-cur"' : ''}><td>${lbl}${flagTags(flags)}</td>${cells}</tr>`;
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
    <div class="ms-header">${title} <span class="xl-seg-unit">% of combined daily avg rev · ${feeUnitLabel()}</span></div>
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
        x: { ticks: { maxTicksLimit: 10, font: { size: CHART_FONT.tick } } },
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
        x: { ticks: { maxTicksLimit: 10, font: { size: CHART_FONT.tick } } },
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
  <div class="share-kpi-grid">
    ${kpi('Current NSE Options Share', fmtNum(currentShare, 1) + ' %', 'as of ' + asOfDate + ' (5D avg)', '')}
    ${kpi('Rate of Change (NSE)', fmtRatePerMonth(chosenFit.ratePerMonth), chosenLabel + ' · ' + chosenFit.fit + ' fit (R²=' + Math.round(chosenFit.ols.r2 * 100) + '%)', rateSentiment)}
    ${kpi('12M Projected NSE Share', fmtNum(projections[2].nseShare, 1) + ' %', 'assumes trend continues, capped 0–100%', '')}
    ${kpi('Model Selected', chosenLabel, reason, '')}
  </div>`;

  const fitRow = (label, fit, isChosen) => `
    <tr${isChosen ? '' : ' style="color:var(--color-text-muted)"'}>
      <td>${label} <span style="font-size:11px;color:var(--color-text-muted)">${isChosen ? '(used)' : '(informational)'}</span></td>
      <td style="text-align:center">${fit.startDate} → ${fit.endDate}</td>
      <td style="text-align:center">${fmtRatePerMonth(fit.ratePerMonth)}</td>
      <td style="text-align:center">${Math.round(fit.ols.r2 * 100)}%</td>
      <td style="text-align:center">${fit.fit}</td>
    </tr>`;

  const tableHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4);padding:0">
    <div class="chart-title">Trend Comparison — Long-Term vs Recent</div>
    <div class="table-scroll">
    <table class="data-table" style="margin:0">
      <thead><tr><th>Window</th><th style="text-align:center">Date Range</th><th style="text-align:center">Rate (NSE)</th><th style="text-align:center">R²</th><th style="text-align:center">Fit</th></tr></thead>
      <tbody>
        ${fitRow('Long-Term (252D, ~1yr)', longFit, chosen === 'long')}
        ${fitRow('Recent (60D, ~3mo)', recentFit, chosen === 'recent')}
      </tbody>
    </table>
    </div>
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
  <div class="chart-panel" style="padding:0">
    <div class="chart-title">Forward Projection</div>
    <div class="table-scroll">
    <table class="data-table" style="margin:0">
      <thead><tr><th>Horizon</th><th style="text-align:center">NSE Share</th><th style="text-align:center">BSE Share</th></tr></thead>
      <tbody>${projRows}</tbody>
    </table>
    </div>
    <p class="section-desc" style="padding:10px 14px 14px">Linear extrapolation of the ${chosen === 'recent' ? 'recent (60-day)' : 'long-term (252-day)'} trend; assumes no regime change; clipped to 0–100%.</p>
  </div>`;

  return kpiHTML + tableHTML + chartHTML + projHTML;
}

// Caption under a share-trend chart naming the months whose NSE or BSE revenue
// (date-effective files only) uses a slab-era flat estimate or a provisional
// BSE cash rate, as runs of consecutive months. '' when there are none.
function marketShareFlagNote(nseRaw, bseRaw, segKey) {
  const bseByMonth = new Map((bseRaw?.monthly || []).map(m => [m.month, m]));
  const months = (nseRaw?.monthly || []).filter(n => bseByMonth.has(n.month))
    .map(n => ({ label: n.month, f: mergeFlags([periodFlags(n, segKey), periodFlags(bseByMonth.get(n.month), segKey)]) }));
  const runs = kind => {
    const out = [];
    months.forEach((m, i) => {
      if (!m.f[kind]) return;
      if (i > 0 && months[i - 1].f[kind]) out[out.length - 1].to = m.label;
      else out.push({ from: m.label, to: m.label });
    });
    return out.map(r => r.from === r.to ? r.from : `${r.from} – ${r.to}`).join(', ');
  };
  const parts = [];
  const slab = runs('slab'), prov = runs('prov');
  if (slab) parts.push(`${flagTags({ slab: true })} ${slab}: slab-era flat fee estimates`);
  if (prov) parts.push(`${flagTags({ prov: true })} ${prov}: provisional BSE cash rate`);
  return parts.length ? `<p class="fee-chart-note">${parts.join('; ')}.</p>` : '';
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
  // Fee-basis estimates inside the trend fit's window (date-effective files only)
  const predFlags = predictor
    ? mergeFlags([nseRaw, bseRaw].map(raw => rowsFlags((raw?.daily_all || []).filter(r => r.date >= predictor.chosenFit.startDate), 'options')))
    : NO_FLAGS;

  el.innerHTML = `
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Options Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msOpt')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsOptions"></canvas></div>
    ${marketShareFlagNote(nseRaw, bseRaw, 'options')}
  </div>
  <div class="chart-panel" style="margin-bottom:var(--space-4)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:var(--space-3)">
      <div class="chart-title" style="margin-bottom:0">Total Revenue Market Share — NSE vs BSE</div>
      ${toggleHTML('msTotal')}
    </div>
    <div class="chart-wrapper"><canvas id="chartMsTotal"></canvas></div>
    ${marketShareFlagNote(nseRaw, bseRaw, 'total')}
  </div>
  <h3 style="margin:0 0 var(--space-3);font-size:var(--text-lg);font-weight:700;color:var(--color-text)">Options Share Predictor${flagTags(predFlags)}</h3>
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
        x: { ticks: { maxTicksLimit: 18, maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { ticks: { maxTicksLimit: 15, font: { size: CHART_FONT.tick } } },
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
          x: { ticks: { maxTicksLimit: 20, font: { size: CHART_FONT.tick } } },
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
// NSE: DEFAULT FORECAST (pipeline ratio model)
// ========================
// One default forecast: the pipeline's ratio model (ENRICHED_DATA
// .pnl_forecast_model / .pnl_predicted_quarters / .pnl_predictor), which the
// Revenue Predictor's Base scenario reproduces; manual nse_pnl forecast rows are
// labelled as such. EBITDA there is operating EBITDA (nse_pnl rows:
// ENRICHED_DATA.pnl_operating). An enriched file written before these fields
// existed has no P&L on the predictor, only revenue.

const NSE_EBITDA_DEF = 'Operating EBITDA = revenue from operations − operating expenses, before depreciation, excluding other (non-operating) income.';
const NSE_ONE_OFF_LABELS = { sebi_settlement: 'SEBI settlement' };

function nseForecastModel() {
  const m = ENRICHED_DATA.pnl_forecast_model;
  return m && m.name ? m : null;
}

function nseQuarterRange(qs) {
  return qs.length > 1 ? `${qs[0]} – ${qs[qs.length - 1]}` : (qs[0] || '');
}

function nseOneOffText(oneOffs) {
  return Object.entries(oneOffs || {})
    .map(([k, v]) => `${NSE_ONE_OFF_LABELS[k] || k.replace(/_/g, ' ')} ${fmt(v, 0)}`).join(', ');
}

// nse_pnl quarters that have ended (before the quarter now trading) but are
// still manual forecasts because their actuals have not been entered.
function nsePendingActualQuarters() {
  const q = DATA.quarterly || [];
  const cq = ENRICHED_DATA.pnl_predictor?.quarter || (q.length ? q[q.length - 1].quarter : null);
  if (!cq) return [];
  return (DATA.pnl || []).filter(r => r.is_predicted && quarterSortKey(r.quarter) < quarterSortKey(cq)).map(r => r.quarter);
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
          x: { ticks: { maxTicksLimit: 12, font: { size: CHART_FONT.tick } } },
          y1: { position: 'left', title: { display: true, text: 'P/N Ratio (bps)', color: CHART_COLORS[0], font: { size: CHART_FONT.title } } },
          y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'India VIX', color: CHART_COLORS[5], font: { size: CHART_FONT.title } } },
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
          x: { title: { display: true, text: 'India VIX', font: { size: CHART_FONT.title } }, ticks: { font: { size: CHART_FONT.tick } } },
          y: { title: { display: true, text: 'Total Revenue (₹ Cr)', font: { size: CHART_FONT.title } }, ticks: { callback: v => '₹' + fmtNum(v, 0) } },
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
        x: { ticks: { maxTicksLimit: 12, font: { size: CHART_FONT.tick } } },
        y1: { position: 'left', title: { display: true, text: 'Revenue (₹ Cr)', color: CHART_COLORS[0], font: { size: CHART_FONT.title } } },
        y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Contracts (Mn)', color: CHART_COLORS[4], font: { size: CHART_FONT.title } } },
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
// REVENUE PREDICTOR TAB — one scenario model per exchange
// ========================
// The quarter's transaction revenue = revenue banked so far + daily revenue
// for the sessions left × those sessions. With the daily inputs at their
// quarter-to-date averages (the Base preset) that equals the pipeline's
// extrapolation (pnl_predictor), and for NSE the P&L below it reproduces the
// pipeline's default ratio-model forecast line for line. Bear / Bull scale the
// rest-of-quarter daily revenue ±15 %. NSE carries the ratio model to PAT and
// EPS; BSE uses the Excel "Quarterly Predictor" (other income and PAT margin);
// MCX stops at revenue (no MCX P&L inputs in this repo).

const PREDICTOR_SEGMENTS = { nse: ['opt', 'fut', 'cash'], bse: ['opt', 'fut', 'cash'], mcx: ['opt', 'fut'] };
const PREDICTOR_SEG_LABEL = { opt: 'Options', fut: 'Futures', cash: 'Cash' };
const PREDICTOR_PRESET_PCT = 15;
// Inputs show 2 decimals but hold full precision until edited, so the Base
// preset is the pipeline's figure to the rupee; a value within half the last
// shown digit of its default counts as unchanged.
const PREDICTOR_TOLERANCE = 0.005;
function predictorShown(x) { return +(+x).toFixed(2); }

// BSE Excel "Quarterly Predictor" starting values (other income ₹ Cr / quarter, PAT margin %)
const BSE_QTR_PNL_DEFAULTS = { oiQ: 472.16, margin: 50 };

// "Q3 FY 2027" shifted by n quarters ("Q2 FY 2027" for -1, "Q3 FY 2026" for -4)
function shiftQuarter(label, n) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  if (!m) return null;
  const idx = +m[2] * 4 + (+m[1] - 1) + n;
  return `Q${(idx % 4) + 1} FY ${Math.floor(idx / 4)}`;
}

// "Q2 FY 2026" … "Q3 FY 2026" → "Q2–Q3 FY26"
function shortQuarterRange(qs) {
  const s = q => { const m = /^Q([1-4]) FY \d{2}(\d{2})$/.exec(q || ''); return m ? { q: 'Q' + m[1], fy: 'FY' + m[2] } : null; };
  const a = s(qs[0]), b = s(qs[qs.length - 1]);
  if (!a || !b) return qs.join(', ');
  if (qs.length === 1) return `${a.q} ${a.fy}`;
  return a.fy === b.fy ? `${a.q}–${b.q} ${a.fy}` : `${a.q} ${a.fy}–${b.q} ${b.fy}`;
}

function predictorContext(ex) {
  const q = DATA.quarterly || [];
  const p = ENRICHED_DATA.pnl_predictor || {};
  const cqLabel = p.quarter || DATA.summary?.current_quarter || (q.length ? q[q.length - 1].quarter : null);
  const cq = q.find(r => r.quarter === cqLabel) || q[q.length - 1];
  if (!cq) return null;
  const segs = PREDICTOR_SEGMENTS[ex];
  const n = cq.days || cq.trading_days || 0;
  const banked = {};
  segs.forEach(k => { banked[k] = cq[k + '_rev'] || 0; });
  const bankedTotal = segs.reduce((s, k) => s + banked[k], 0);
  const adr = {};
  segs.forEach(k => { adr[k] = n ? banked[k] / n : 0; });
  const prev = q.find(r => r.quarter === shiftQuarter(cq.quarter, -1)) || null;
  const ly = q.find(r => r.quarter === shiftQuarter(cq.quarter, -4)) || null;
  const daily = (DATA.daily_all || DATA.daily || []).filter(r => r.fy_quarter === cq.quarter);
  return {
    ex, segs, cq, n, banked, bankedTotal, adr, prev, ly, daily,
    days: p.expected_trading_days || Math.max(n, 62),
    quarters: q,
  };
}

function predictorDefaults(ex, ctx) {
  const v = { days: ctx.days };
  ctx.segs.forEach(k => { v[k] = ctx.adr[k]; });
  const m = ex === 'nse' ? nseForecastModel() : null;
  if (m) Object.assign(v, {
    oor: m.other_operating_revenue_ratio * 100,
    oi: m.non_operating_income_ratio * 100,
    opex: m.operating_expense_ratio * 100,
    dep: m.depreciation_ratio * 100,
    assoc: +m.share_profit_associates,
    tax: m.tax_rate * 100,
    shares: SHARES_OUTSTANDING_CR.nse.value,
  });
  if (ex === 'bse') Object.assign(v, BSE_QTR_PNL_DEFAULTS, { shares: SHARES_OUTSTANDING_CR.bse.value });
  return v;
}

// Scenario P&L for input values `v` (ctx from predictorContext). The NSE branch
// is scripts/nse_pipeline.py's ratio model (build_entry) with editable ratios.
function predictorScenario(ex, ctx, v) {
  const rest = Math.max(v.days - ctx.n, 0);
  const seg = {};
  let txn = 0;
  ctx.segs.forEach(k => { seg[k] = ctx.banked[k] + v[k] * rest; txn += seg[k]; });
  const out = { seg, txn, rest, adr: v.days ? txn / v.days : 0, adrRest: ctx.segs.reduce((s, k) => s + v[k], 0) };
  if (ex === 'nse' && v.oor != null) {
    out.oorV = txn * v.oor / 100;
    out.op = txn + out.oorV;
    out.oi = txn * v.oi / 100;
    out.total = out.op + out.oi;
    out.opx = out.op * v.opex / 100;
    out.ebitda = out.op - out.opx;
    out.dep = out.op * v.dep / 100;
    out.assoc = v.assoc;
    out.pbt = out.ebitda - out.dep + out.oi + out.assoc;
    out.tax = out.pbt * v.tax / 100;
    out.pat = out.pbt - out.tax;
    out.eps = v.shares ? out.pat / v.shares : null;
  } else if (ex === 'bse') {
    out.oi = v.oiQ;
    out.total = txn + v.oiQ;
    out.pat = out.total * v.margin / 100;
    out.costs = out.total - out.pat;
    out.eps = v.shares ? out.pat / v.shares : null;
  }
  return out;
}

// Input rows of the assumptions panel, by group
function predictorFields(ex, ctx) {
  const rest = Math.max(ctx.days - ctx.n, 0);
  const groups = [{
    title: `Daily revenue for the ${rest} sessions left, ₹ Cr`,
    fields: ctx.segs.map(k => ({ key: k, label: PREDICTOR_SEG_LABEL[k], step: 0.1, tag: rxChip(`QTD avg · ${ctx.n} sessions`, 'data') })),
  }, {
    title: 'Quarter',
    fields: [{ key: 'days', label: 'Trading sessions in the quarter', step: 1, tag: rxChip('Pipeline estimate') }],
  }];
  const m = ex === 'nse' ? nseForecastModel() : null;
  if (m) {
    const base = shortQuarterRange(m.base_quarters || []);
    const taxQ = shortQuarterRange(m.tax_rate_quarters || []);
    groups.push({
      title: `Ratios · actual ${base}, one-offs excluded`,
      fields: [
        { key: 'oor', label: 'Other operating revenue, % of txn revenue', step: 0.1, tag: rxChip(base) },
        { key: 'oi', label: 'Other income, % of txn revenue', step: 0.1, tag: rxChip(base) },
        { key: 'opex', label: 'Operating expenses, % of operating revenue', step: 0.1, tag: rxChip(base) },
        { key: 'dep', label: 'Depreciation, % of operating revenue', step: 0.1, tag: rxChip(base) },
        { key: 'assoc', label: 'Share of associates, ₹ Cr', step: 0.5, tag: rxChip(base) },
        { key: 'tax', label: 'Tax rate, %', step: 0.1, tag: rxChip(`${taxQ} effective`) },
        { key: 'shares', label: 'Shares outstanding, Cr', step: 0.1, tag: rxChip('PAT ÷ EPS, reported', 'data') },
      ],
    });
  }
  if (ex === 'bse') groups.push({
    title: 'Excel “Quarterly Predictor”',
    fields: [
      { key: 'oiQ', label: 'Other income, ₹ Cr for the quarter', step: 1, tag: rxChip('Excel model') },
      { key: 'margin', label: 'PAT margin, % of total income', step: 0.5, tag: rxChip('Excel model') },
      { key: 'shares', label: 'Shares outstanding, Cr', step: 0.01, tag: rxChip('Hard-coded · unverified', 'warn') },
    ],
  });
  return groups;
}

// P&L rows for NSE: [label, key, row class]; ratio rows divide `key` by `base`
const NSE_PNL_ROWS = [
  ['Transaction revenue', 'txn'], ['Other operating revenue', 'oorV'], ['Operating revenue', 'op', 'rx-sub'],
  ['Other income', 'oi'], ['Total income', 'total', 'rx-sub'], ['Operating expenses', 'opx'],
  ['Operating EBITDA', 'ebitda', 'rx-sub'], ['EBITDA margin', 'ebitda', 'rx-pct', 'op'], ['Depreciation', 'dep'],
  ['Share of associates', 'assoc'], ['PBT', 'pbt', 'rx-sub'], ['Tax', 'tax'], ['PAT', 'pat', 'rx-sub'],
  ['PAT margin', 'pat', 'rx-pct', 'total'], ['EPS, ₹', 'eps', 'rx-sub'],
];

// Reported Q-year-ago P&L in the scenario's keys (null if not an actual quarter)
function nseActualPnl(quarter) {
  const r = (DATA.pnl || []).find(x => x.quarter === quarter && !x.is_predicted);
  if (!r) return null;
  const op = (ENRICHED_DATA.pnl_operating || []).find(x => x.quarter === quarter) || {};
  const opRev = op.operating_revenue;
  return {
    txn: r.transaction_rev, oorV: opRev != null ? opRev - r.transaction_rev : null, op: opRev,
    oi: op.non_operating_income, total: r.total_revenue, opx: op.operating_expenses, ebitda: op.operating_ebitda,
    dep: op.depreciation ?? r.depreciation, assoc: r.share_profit_associates, pbt: r.pbt, tax: r.income_tax,
    pat: r.pat, eps: r.eps, oneOffs: op.one_offs || {},
  };
}

// Pipeline default forecast for a quarter, in the scenario's keys
function nseDefaultPnl(quarter) {
  const f = ENRICHED_DATA.pnl_predicted_quarters?.[quarter];
  if (!f) return null;
  return {
    txn: f.transaction_rev, oorV: f.operating_revenue - f.transaction_rev, op: f.operating_revenue,
    oi: f.non_operating_income, total: f.total_revenue, opx: f.operating_expenses, ebitda: f.operating_ebitda,
    dep: f.depreciation, assoc: f.share_profit_associates, pbt: f.pbt, tax: f.income_tax, pat: f.pat, eps: f.eps,
  };
}

function buildRevenuePredictor(ex) {
  const el = document.getElementById(`${ex}PredictionContent`);
  if (!el) return;
  const ctx = predictorContext(ex);
  if (!ctx || !ctx.n) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Revenue predictor', body: '<div class="rx-empty"><b>No sessions in the current quarter yet</b>The predictor starts after the quarter’s first trading day.</div>' })}</div>`;
    return;
  }
  const name = SHARE_EXCHANGE_NAMES[ex];
  const model = ex === 'nse' ? nseForecastModel() : null;
  const hasPnl = (ex === 'nse' && !!model) || ex === 'bse';
  const defaults = predictorDefaults(ex, ctx);
  const v = { ...defaults };
  const cqL = ctx.cq.quarter;
  const nextL = shiftQuarter(cqL, 1);
  const lyL = shiftQuarter(cqL, -4);
  const prevL = shiftQuarter(cqL, -1);
  const cqFlags = periodFlags(ctx.cq, 'total');
  const lyModelled = ctx.ly && periodFlags(ctx.ly, 'total').modelled;
  const prevModelled = ctx.prev && periodFlags(ctx.prev, 'total').modelled;
  const groups = predictorFields(ex, ctx);
  const presets = { bear: 1 - PREDICTOR_PRESET_PCT / 100, base: 1, bull: 1 + PREDICTOR_PRESET_PCT / 100 };
  const lastDate = ctx.daily.length ? ctx.daily[ctx.daily.length - 1].date : DATA.summary?.last_date;

  // NSE: quarters that have ended but still hold manual forecasts in nse_pnl
  let staleHTML = '';
  if (ex === 'nse') {
    const pending = nsePendingActualQuarters();
    if (pending.length) {
      const last = pending[pending.length - 1];
      const manual = (DATA.pnl || []).find(r => r.quarter === last);
      const traded = ctx.quarters.find(r => r.quarter === last);
      const cmp = manual && traded && manual.transaction_rev
        ? ` ${last}’s manual forecast has transaction revenue ${rxCr(manual.transaction_rev, 0)}; trading data says ${rxCr(traded.total_rev, 0)}.` : '';
      const list = pending.length === 1 ? pending[0] : pending.slice(0, -1).join(', ') + ' and ' + last;
      staleHTML = rxAlert(`<strong>Ratios rest on ${model ? shortQuarterRange(model.base_quarters) : 'older quarters'}.</strong> ${list} ${pending.length === 1 ? 'has' : 'have'} ended but nse_pnl still holds manual forecasts for ${pending.length === 1 ? 'it' : 'them'}, so the default forecast cannot use ${pending.length === 1 ? 'its' : 'their'} actuals.${cmp}`);
    }
  }

  const fieldsHTML = groups.map(g => `<div class="rx-field-group"><span class="rx-lbl">${g.title}</span>${g.fields.map(f => `
      <div class="rx-field">
        <label for="rxPred-${ex}-${f.key}">${f.label}</label>
        <input class="rx-in" id="rxPred-${ex}-${f.key}" type="number" step="${f.step}" min="0" inputmode="decimal" data-key="${f.key}" value="${predictorShown(defaults[f.key])}">
        <div class="rx-tags" data-tags="${f.key}">${f.tag}</div>
      </div>`).join('')}</div>`).join('');

  const howNSE = model ? rxHow('How the default forecast works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left. At the quarter-to-date averages this is the pipeline’s extrapolation.</li>
      <li>Other operating revenue (${fmtPct(model.other_operating_revenue_ratio)}) and other income (${fmtPct(model.non_operating_income_ratio)}) scale with transaction revenue; operating expenses (${fmtPct(model.operating_expense_ratio)}) and depreciation (${fmtPct(model.depreciation_ratio)}) scale with operating revenue; associates ${rxCr(model.share_profit_associates)}; tax at the ${shortQuarterRange(model.tax_rate_quarters)} effective rate (${fmtPct(model.tax_rate)}).</li>
      <li>Ratios come from actual ${nseQuarterRange(model.base_quarters)}${Object.keys(model.one_offs_excluded || {}).length ? `, one-offs excluded (${Object.entries(model.one_offs_excluded).map(([q, o]) => `${nseOneOffText(o)} in ${q}`).join('; ')})` : ''}. Forecasts carry no one-offs.</li>
      <li>${nextL} grows transaction revenue at the current quarter’s year-on-year per-session rate. ${NSE_EBITDA_DEF}</li>
    </ul>`) : '';
  const howBSE = rxHow('How this estimate works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left (quarter-to-date averages by default).</li>
      <li>Other income and PAT margin are the starting values of the Excel “Quarterly Predictor”; BSE’s reported P&amp;L is not in this repo, so there are no actuals to compare against.</li>
      <li>BSE cash revenue for the latest quarter is at a provisional calibrated rate until BSE reports it (marked est.).</li>
    </ul>`);
  const howMCX = rxHow('How this estimate works', `<ul>
      <li>Transaction revenue = revenue banked in the ${ctx.n} sessions so far + daily revenue × the sessions left (quarter-to-date averages by default).</li>
      <li>MCX stops at revenue: no MCX other-income or margin inputs are maintained here. MCX total revenue is futures + options; days before 2 Sep 2024 are modelled and left out of comparisons.</li>
    </ul>`);

  const pnlPanel = ex === 'nse' && model ? rxPanel({ cls: 'rx-col-wide', title: 'P&amp;L', meta: '₹ Cr · operating EBITDA excludes other income',
      right: rxLegend([{ label: 'Your scenario', color: '#EAF0FB', style: 'box-shadow:inset 0 0 0 1px #B9C9EE' }]),
      body: `<div class="rx-scroll"><table class="rx-table" data-rx="pnl"></table></div>`, foot: '<span data-rx="pnlFoot"></span>', how: howNSE })
    : ex === 'bse' ? rxPanel({ cls: 'rx-col-wide', title: 'Quarter P&amp;L', meta: '₹ Cr · Excel quarterly model',
      body: `<div class="rx-scroll"><table class="rx-table" data-rx="pnl"></table></div>`, how: howBSE })
    : rxPanel({ cls: 'rx-col-wide', title: 'Segments', meta: '₹ Cr', body: `<div class="rx-scroll"><table class="rx-table" data-rx="segs"></table></div>`, how: howMCX });
  const bridgePanel = hasPnl ? rxPanel({ cls: 'rx-col-narrow', title: 'Scenario bridge', meta: `${cqL}, ₹ Cr`,
      body: `<div class="rx-pb"><div class="rx-walk" data-rx="walk"></div><div style="margin-top:10px">${rxLegend([{ label: 'Subtotal', color: RX.ink }, { label: 'Adds', color: RX.add }, { label: 'Deducts', color: RX.deduct }])}</div></div>` })
    : rxPanel({ cls: 'rx-col-narrow', title: 'Segment mix', meta: `${cqL} scenario`, body: '<div class="rx-pb" data-rx="mix"></div>' });

  const histTitle = ex === 'nse' && model ? 'PAT by quarter' : 'Transaction revenue by quarter';
  const histMeta = ex === 'nse' && model ? '₹ Cr · reported, manual nse_pnl forecasts, and the forecast' : '₹ Cr · trading data';
  const histLegend = ex === 'nse' && model
    ? rxLegend([{ label: 'Reported', color: RX.ink }, { label: 'Manual forecast, quarter ended', kind: 'hatch', style: 'background:repeating-linear-gradient(135deg,#fff 0 3px,#8A8D94 3px 4.5px);box-shadow:inset 0 0 0 1px #8A8D94' }, { label: `${cqL} scenario`, color: RX.model }, { label: `${nextL} default`, color: '#9DB4E8' }])
    : rxLegend([{ label: 'Actual', color: RX.ink }, { label: 'Banked this quarter', color: RX.ink2 }, { label: 'Projected', color: RX.model }].concat(ex === 'mcx' ? [{ label: 'Modelled history', color: RX.light }] : []));

  el.innerHTML = `<div class="rx">
    <section class="rx-kpis" aria-label="${cqL} scenario" data-rx="kpis"></section>
    ${staleHTML}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-wide', title: 'Quarter progress', meta: `Daily transaction revenue, ₹ Cr · ${cqL} to ${fmtTradeDate(lastDate)}${flagTags(cqFlags)}`,
        right: rxLegend([{ label: 'Session', color: RX.ink }, { label: 'QTD avg', color: RX.model, kind: 'line' }].concat(ctx.prev && !prevModelled ? [{ label: `${prevL} avg`, color: RX.grey, kind: 'dash' }] : [])),
        body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`rxPredDaily-${ex}`)}<div data-rx="bullet" style="margin-top:14px"></div></div>
          <div class="rx-scroll"><table class="rx-table" data-rx="segTable"></table></div>` })}
      <section class="rx-panel rx-col-narrow" aria-label="Assumptions">
        <div class="rx-ph"><h2>Assumptions</h2><span class="rx-meta" data-rx="scenLabel"></span><div class="rx-ph-right"><button type="button" class="rx-link" data-rx="resetAll">Reset all</button></div></div>
        <div class="rx-pb" style="padding-top:10px">
          ${rxSeg('preset', [['bear', `Bear −${PREDICTOR_PRESET_PCT} %`], ['base', 'Base'], ['bull', `Bull +${PREDICTOR_PRESET_PCT} %`]], 'base', 'Scenario preset')}
          <p class="rx-foot" style="margin-top:8px">Presets scale the daily revenue for the sessions left. Editing any input makes this a custom scenario; ${ex === 'nse' ? 'the “Default” columns stay as the pipeline published them.' : 'nothing is saved.'}</p>
          ${fieldsHTML}
        </div>
      </section>
    </div>
    <div class="rx-row">${pnlPanel}${bridgePanel}</div>
    ${rxPanel({ title: histTitle, meta: histMeta, right: histLegend, body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`rxPredHist-${ex}`)}</div>` })}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);
  const prevAdr = ctx.prev && ctx.prev.days ? ctx.prev.total_rev / ctx.prev.days : null;
  const lyAdr = ctx.ly && ctx.ly.days ? ctx.ly.total_rev / ctx.ly.days : null;
  const actualLY = ex === 'nse' ? nseActualPnl(lyL) : null;
  const defCur = ex === 'nse' ? nseDefaultPnl(cqL) : null;
  const defNext = ex === 'nse' ? nseDefaultPnl(nextL) : null;

  function scenarioName() {
    const keys = Object.keys(defaults);
    const same = (o) => keys.every(k => Math.abs(Number(v[k]) - Number(o[k])) < PREDICTOR_TOLERANCE);
    for (const [name, f] of Object.entries(presets)) {
      const o = { ...defaults };
      ctx.segs.forEach(k => { o[k] = defaults[k] * f; });
      if (same(o)) return name;
    }
    return 'custom';
  }

  function renderKpis(s) {
    const qoq = ctx.prev && !prevModelled ? s.txn / ctx.prev.total_rev - 1 : null;
    const yoy = ctx.ly && !lyModelled ? s.txn / ctx.ly.total_rev - 1 : null;
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL) && !periodFlags(r, 'total').modelled).slice(-8);
    const vals = hist.map(r => r.total_rev).concat([s.txn]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const pt = (val, i) => `${(i / Math.max(vals.length - 1, 1) * 100).toFixed(1)},${(25 - (val - lo) / ((hi - lo) || 1) * 23).toFixed(1)}`;
    const spark = vals.length > 2 ? `<svg class="rx-spark" viewBox="0 0 100 26" preserveAspectRatio="none" role="img" aria-label="Transaction revenue, last ${hist.length} quarters and this quarter's scenario">
        <polyline points="${hist.map((r, i) => pt(r.total_rev, i)).join(' ')}" fill="none" stroke="${RX.ink}" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
        <polyline points="${pt(vals[vals.length - 2], vals.length - 2)} ${pt(s.txn, vals.length - 1)}" fill="none" stroke="${RX.model}" stroke-width="1.5" stroke-dasharray="3 2" vector-effect="non-scaling-stroke"/></svg>` : '';
    const chg = (c, label) => c == null ? '' : `${rxChangeHTML(c)} ${label}`;
    const items = [
      rxKpi(`Txn revenue · ${cqL}`, rxCr(s.txn), [chg(qoq, 'QoQ'), chg(yoy, 'YoY')].filter(Boolean).join(' · ') || 'no comparable quarter', { accent: true, extra: spark }),
      rxKpi('Avg daily txn revenue', rxCr(s.adr, 2), `QTD ${rxCr(ctx.bankedTotal / ctx.n, 2)} over ${ctx.n} sessions${prevAdr && !prevModelled ? ` · ${prevL} ${rxCr(prevAdr, 1)}` : ''}`),
    ];
    if (ex === 'nse' && s.pat != null) {
      const patYoY = actualLY ? s.pat / actualLY.pat - 1 : null;
      items.push(
        rxKpi('Total income', rxCr(s.total), `Other income ${rxCr(s.oi)}`),
        rxKpi('Operating EBITDA', rxCr(s.ebitda), `${fmtPct(s.ebitda / s.op)} of operating revenue`),
        rxKpi('PAT', rxCr(s.pat), `${patYoY != null ? chg(patYoY, 'YoY') + ' · ' : ''}${fmtPct(s.pat / s.total)} margin`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else if (ex === 'bse') {
      items.push(
        rxKpi('Total income', rxCr(s.total), `Other income ${rxCr(s.oi)} (Excel model)`),
        rxKpi('PAT', rxCr(s.pat), `${fmtNum(v.margin, 1)} % margin on total income`),
        rxKpi('EPS · quarter', rxRupee(s.eps, 2), `Annualised ${rxRupee(s.eps * 4, 2)} · <button type="button" class="rx-link" data-rx-goto="valuation">value it →</button>`),
      );
    } else {
      ctx.segs.forEach(k => items.push(rxKpi(`${PREDICTOR_SEG_LABEL[k]} · quarter`, rxCr(s.seg[k]), `${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'} of transaction revenue`)));
    }
    q('kpis').innerHTML = items.join('');
  }

  function renderBullet(s) {
    const refs = [s.txn, ctx.prev && !prevModelled ? ctx.prev.total_rev : 0, ctx.ly && !lyModelled ? ctx.ly.total_rev : 0];
    const max = Math.max(...refs) * 1.06 || 1;
    const pct = x => (Math.max(0, x) / max * 100).toFixed(2);
    const bank = Math.min(ctx.bankedTotal, s.txn);
    const marks = [];
    if (ctx.prev && !prevModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.prev.total_rev)}%;border-color:${RX.rev}" title="${prevL}: ${rxCr(ctx.prev.total_rev, 0)}"></div>`);
    if (ctx.ly && !lyModelled) marks.push(`<div class="rx-mark" style="left:${pct(ctx.ly.total_rev)}%;border-left-style:dotted;border-color:${RX.ink2}" title="${lyL}: ${rxCr(ctx.ly.total_rev, 0)}"></div>`);
    q('bullet').innerHTML = `
      <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 12px;margin-bottom:6px">
        <span class="rx-lbl">Quarter transaction revenue, ₹ Cr</span>
        <span style="font-size:12px;color:var(--rx-ink-2)">Banked <strong>${fmtNum(ctx.bankedTotal, 1)}</strong> + projected <strong>${fmtNum(s.txn - ctx.bankedTotal, 1)}</strong> = <strong>${fmtNum(s.txn, 1)}</strong></span>
      </div>
      <div class="rx-bullet" role="img" aria-label="Banked ${fmtNum(ctx.bankedTotal, 0)} crore plus projected ${fmtNum(s.txn - ctx.bankedTotal, 0)} crore">
        <div style="left:0;width:${pct(bank)}%;background:${RX.ink}" title="Banked: ${ctx.n} sessions, ${rxCr(ctx.bankedTotal)}"></div>
        <div class="rx-hatch" style="left:${pct(bank)}%;width:${(pct(s.txn) - pct(bank)).toFixed(2)}%" title="Projected: ${s.rest} sessions, ${rxCr(s.txn - ctx.bankedTotal)}"></div>
        ${marks.join('')}
      </div>
      <div style="margin-top:8px">${rxLegend([{ label: `Banked (${ctx.n} sessions)`, color: RX.ink }, { label: `Projected (${s.rest} sessions)`, kind: 'hatch' }]
        .concat(ctx.prev && !prevModelled ? [{ label: `${prevL} ${fmtNum(ctx.prev.total_rev, 0)}`, color: RX.rev, kind: 'tick' }] : [])
        .concat(ctx.ly && !lyModelled ? [{ label: `${lyL} ${fmtNum(ctx.ly.total_rev, 0)}`, color: RX.ink2, kind: 'tick' }] : []))}</div>`;
  }

  function renderSegTable(s) {
    const rows = ctx.segs.map(k => {
      const f = periodFlags(ctx.cq, k === 'opt' ? 'options' : k === 'fut' ? 'futures' : 'cash');
      return `<tr><td>${PREDICTOR_SEG_LABEL[k]}${flagTags(f)}</td><td>${fmtNum(ctx.banked[k], 1)}</td><td>${fmtNum(ctx.adr[k], 2)}</td><td class="rx-hl">${fmtNum(v[k], 2)}</td><td class="rx-hl">${fmtNum(s.seg[k], 1)}</td><td>${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'}</td></tr>`;
    }).join('');
    q('segTable').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">Banked</th><th scope="col">QTD / session</th><th scope="col" class="rx-hl">Rest / session</th><th scope="col" class="rx-hl">Quarter</th><th scope="col">Mix</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td>Total${flagTags(cqFlags)}</td><td>${fmtNum(ctx.bankedTotal, 1)}</td><td>${fmtNum(ctx.bankedTotal / ctx.n, 2)}</td><td class="rx-hl">${fmtNum(s.adrRest, 2)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>100 %</td></tr></tfoot>`;
  }

  function renderPnl(s) {
    if (ex === 'nse' && model) {
      const num = (o, key, base) => {
        if (!o || o[key] == null) return '—';
        if (base) return o[base] ? fmtPct(o[key] / o[base]) : '—';
        return key === 'eps' ? fmtNum(o[key], 2) : fmtNum(o[key], 1);
      };
      const body = NSE_PNL_ROWS.map(([label, key, cls, base]) => {
        let yoy = '';
        if (!base && actualLY && actualLY[key]) {
          const c = s[key] / actualLY[key] - 1;
          yoy = `<span class="${c >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(c)}</span>`;
        }
        return `<tr class="${cls || ''}"><td>${label}</td><td>${num(actualLY, key, base)}</td><td>${num(defCur, key, base)}</td><td class="rx-hl">${num(s, key, base)}</td><td>${yoy || (base ? '' : '—')}</td><td>${num(defNext, key, base)}</td></tr>`;
      }).join('');
      const scenHead = scenarioName() === 'base' ? 'Scenario<br>= default' : 'Scenario';
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th><th scope="col">${shortQuarterRange([lyL])}<br>Actual</th><th scope="col">${shortQuarterRange([cqL])}<br>Default</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])}<br>${scenHead}</th><th scope="col">Scenario<br>YoY</th><th scope="col">${shortQuarterRange([nextL])}<br>Default</th></tr></thead><tbody>${body}</tbody>`;
      const oneOff = actualLY && Object.keys(actualLY.oneOffs).length ? `${lyL} actual includes ${nseOneOffText(actualLY.oneOffs)}. ` : '';
      q('pnlFoot').textContent = actualLY ? `${oneOff}Actual operating lines are ex-one-offs where the pipeline separates them.` : `${lyL} has no reported actuals in nse_pnl yet.`;
    } else if (ex === 'bse') {
      const per = x => s.txn ? fmtPct(x / s.total) : '—';
      q('pnl').innerHTML = `<thead><tr><th scope="col">Line item</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])} scenario</th><th scope="col">% of total income</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        <tr><td>Transaction revenue${flagTags(cqFlags)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>${per(s.txn)}</td><td class="rx-src">Trading data + daily inputs</td></tr>
        <tr><td>Other income</td><td class="rx-hl">${fmtNum(s.oi, 1)}</td><td>${per(s.oi)}</td><td class="rx-src">Excel model</td></tr>
        <tr class="rx-sub"><td>Total income</td><td class="rx-hl">${fmtNum(s.total, 1)}</td><td>100 %</td><td class="rx-src"></td></tr>
        <tr><td>Costs and tax (implied)</td><td class="rx-hl">${fmtNum(s.costs, 1)}</td><td>${per(s.costs)}</td><td class="rx-src">1 − PAT margin</td></tr>
        <tr class="rx-sub"><td>PAT</td><td class="rx-hl">${fmtNum(s.pat, 1)}</td><td>${per(s.pat)}</td><td class="rx-src">PAT margin ${fmtNum(v.margin, 1)} %</td></tr>
        <tr class="rx-sub"><td>EPS, ₹</td><td class="rx-hl">${fmtNum(s.eps, 2)}</td><td></td><td class="rx-src">${fmtNum(v.shares, 2)} Cr shares</td></tr>
      </tbody>`;
    } else {
      const rows = ctx.segs.map(k => {
        const lyv = ctx.ly && !lyModelled ? ctx.ly[k + '_rev'] : null;
        const pv = ctx.prev && !prevModelled ? ctx.prev[k + '_rev'] : null;
        return `<tr><td>${PREDICTOR_SEG_LABEL[k]}</td><td>${pv == null ? '—' : fmtNum(pv, 1)}</td><td>${lyv == null ? '—' : fmtNum(lyv, 1)}</td><td class="rx-hl">${fmtNum(s.seg[k], 1)}</td><td>${pv ? rxChangeHTML(s.seg[k] / pv - 1) : '—'}</td><td>${lyv ? rxChangeHTML(s.seg[k] / lyv - 1) : '—'}</td></tr>`;
      }).join('');
      const tp = ctx.prev && !prevModelled ? ctx.prev.total_rev : null, tl = ctx.ly && !lyModelled ? ctx.ly.total_rev : null;
      q('segs').innerHTML = `<thead><tr><th scope="col">Segment</th><th scope="col">${shortQuarterRange([prevL])}</th><th scope="col">${shortQuarterRange([lyL])}</th><th scope="col" class="rx-hl">${shortQuarterRange([cqL])} scenario</th><th scope="col">QoQ</th><th scope="col">YoY</th></tr></thead>
        <tbody>${rows}</tbody><tfoot><tr><td>Total</td><td>${tp == null ? '—' : fmtNum(tp, 1)}</td><td>${tl == null ? '—' : fmtNum(tl, 1)}</td><td class="rx-hl">${fmtNum(s.txn, 1)}</td><td>${tp ? rxChangeHTML(s.txn / tp - 1) : '—'}</td><td>${tl ? rxChangeHTML(s.txn / tl - 1) : '—'}</td></tr></tfoot>`;
    }
  }

  function renderWalk(s) {
    if (!hasPnl) {
      q('mix').innerHTML = `<div style="display:flex;height:12px;gap:2px;margin:4px 0 10px">${ctx.segs.map((k, i) => `<div style="flex:${Math.max(s.seg[k], 0)} 1 0;background:${[RX.model, RX.rev, RX.ink2][i]}" title="${PREDICTOR_SEG_LABEL[k]} ${rxCr(s.seg[k])}"></div>`).join('')}</div>
        ${rxLegend(ctx.segs.map((k, i) => ({ label: `${PREDICTOR_SEG_LABEL[k]} ${s.txn ? fmtPct(s.seg[k] / s.txn) : '—'}`, color: [RX.model, RX.rev, RX.ink2][i] })))}
        <p class="rx-foot" style="margin-top:10px">${ctx.ly && !lyModelled ? `${lyL}: options ${fmtPct(ctx.ly.opt_rev / ctx.ly.total_rev)} of revenue.` : ''}</p>`;
      return;
    }
    const steps = ex === 'nse'
      ? [['Transaction rev', s.txn, 'tot'], ['Other op. revenue', s.oorV, 'add'], ['Operating rev', s.op, 'tot'], ['Op. expenses', -s.opx, 'sub'],
         ['Op. EBITDA', s.ebitda, 'tot'], ['Depreciation', -s.dep, 'sub'], ['Other income', s.oi, 'add'], ['Associates', s.assoc, 'add'],
         ['PBT', s.pbt, 'tot'], ['Tax', -s.tax, 'sub'], ['PAT', s.pat, 'tot']]
      : [['Transaction rev', s.txn, 'tot'], ['Other income', s.oi, 'add'], ['Total income', s.total, 'tot'], ['Costs and tax', -s.costs, 'sub'], ['PAT', s.pat, 'tot']];
    let run = 0, max = 0;
    const bars = steps.map(([label, val, kind]) => {
      let l, w;
      if (kind === 'tot') { l = 0; w = val; run = val; } else if (val >= 0) { l = run; w = val; run += val; } else { run += val; l = run; w = -val; }
      max = Math.max(max, l + w);
      return { label, val, kind, l, w };
    });
    max = max * 1.02 || 1;
    q('walk').innerHTML = bars.map(b => {
      const color = b.kind === 'tot' ? RX.ink : b.val >= 0 ? RX.add : RX.deduct;
      const txt = b.kind === 'tot' ? fmtNum(b.val, 0) : `${b.val >= 0 ? '+' : '−'}${fmtNum(Math.abs(b.val), 0)}`;
      return `<div class="rx-walk-row${b.kind === 'tot' ? ' is-total' : ''}"><span>${b.label}</span>
        <div class="rx-walk-trk"><div style="left:${(b.l / max * 100).toFixed(2)}%;width:${Math.max(b.w / max * 100, 0.4).toFixed(2)}%;background:${color}" title="${b.label}: ${rxCr(Math.abs(b.val))}"></div></div>
        <span class="${b.kind === 'tot' ? '' : b.val >= 0 ? 'rx-up' : 'rx-dn'}">${txt}</span></div>`;
    }).join('');
  }

  let lastScenario = null;
  function renderDaily() {
    const rows = ctx.daily;
    const qtdAvg = ctx.bankedTotal / ctx.n;
    const ds = [
      { type: 'bar', label: 'Session', data: rows.map(r => r.total_rev), backgroundColor: RX.ink, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 34, order: 2 },
      { type: 'line', label: 'QTD avg', data: rows.map(() => qtdAvg), borderColor: RX.model, borderWidth: 2, pointRadius: 0, order: 1 },
    ];
    if (prevAdr && !prevModelled) ds.push({ type: 'line', label: `${prevL} avg`, data: rows.map(() => prevAdr), borderColor: RX.grey, borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0, order: 1 });
    rxChart('predDaily', `rxPredDaily-${ex}`, 200, {
      type: 'bar',
      data: { labels: rows.map(r => fmtTradeDate(r.date)), datasets: ds },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => fmtTradeDate(rows[items[0].dataIndex].date, true),
          label: ctx2 => ` ${ctx2.dataset.label}: ${rxCr(ctx2.raw, 2)}`,
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 16 } },
          y: { beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } },
        },
      },
    });
    rxFixHeight(charts.predDaily);
  }

  function renderHist(s) {
    const canvasId = `rxPredHist-${ex}`;
    if (ex === 'nse' && model) {
      const preds = ENRICHED_DATA.pnl_predicted_quarters || {};
      const rows = (DATA.pnl || []).filter(r => !preds[r.quarter] && quarterSortKey(r.quarter) < quarterSortKey(cqL));
      const pts = rows.map(r => ({ q: r.quarter, v: r.pat, kind: r.is_predicted ? 'manual' : 'actual' }))
        .concat(Object.keys(preds).sort((a, b) => quarterSortKey(a) - quarterSortKey(b)).map(qL => ({ q: qL, v: qL === cqL ? s.pat : preds[qL].pat, kind: qL === cqL ? 'scenario' : 'default', def: preds[qL].pat })));
      const hatch = rxHatchPattern();
      const colors = pts.map(p => p.kind === 'actual' ? RX.ink : p.kind === 'manual' ? hatch : p.kind === 'scenario' ? RX.model : '#9DB4E8');
      const cfg = {
        type: 'bar',
        data: { labels: pts.map(p => shortQuarterRange([p.q])), datasets: [{ label: 'PAT', data: pts.map(p => p.v), backgroundColor: colors,
          borderColor: pts.map(p => p.kind === 'manual' ? '#8A8D94' : 'transparent'), borderWidth: pts.map(p => p.kind === 'manual' ? 1 : 0), borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44 }] },
        options: {
          plugins: { tooltip: { callbacks: {
            title: items => pts[items[0].dataIndex].q,
            label: c => {
              const p = pts[c.dataIndex];
              const kind = { actual: 'reported', manual: 'manual forecast; quarter ended without an actual', scenario: 'your scenario', default: 'default forecast' }[p.kind];
              return ` PAT ${rxCr(p.v, 0)} · ${kind}`;
            },
            footer: items => { const p = pts[items[0].dataIndex]; return p.kind === 'scenario' && Math.abs(p.v - p.def) > 0.5 ? `Default forecast ${rxCr(p.def, 0)}` : ''; },
          } } },
          scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
        },
      };
      if (charts.predHist && lastScenario === 'nse') { charts.predHist.data.datasets[0].data = pts.map(p => p.v); charts.predHist.update('none'); return; }
      rxChart('predHist', canvasId, 240, cfg);
      rxFixHeight(charts.predHist);
      lastScenario = 'nse';
      return;
    }
    const hist = ctx.quarters.filter(r => quarterSortKey(r.quarter) < quarterSortKey(cqL)).slice(-11);
    const labels = hist.map(r => r.quarter).concat([cqL]).map(l => shortQuarterRange([l]));
    const actual = hist.map(r => r.total_rev).concat([ctx.bankedTotal]);
    const proj = hist.map(() => null).concat([s.txn - ctx.bankedTotal]);
    const actualColors = hist.map(r => periodFlags(r, 'total').modelled ? RX.light : RX.ink).concat([RX.ink2]);
    if (charts.predHist && lastScenario === ex) { charts.predHist.data.datasets[1].data = proj; charts.predHist.update('none'); return; }
    rxChart('predHist', canvasId, 240, {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Actual', data: actual, backgroundColor: actualColors, stack: 'q', maxBarThickness: 44 },
        { label: 'Projected', data: proj, backgroundColor: RX.model, stack: 'q', borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 44 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => (hist[items[0].dataIndex] || ctx.cq).quarter,
          label: c => {
            if (c.raw == null) return null;
            const isCur = c.dataIndex === hist.length;
            const r = hist[c.dataIndex];
            if (!isCur) return ` ${rxCr(c.raw, 0)}${r && periodFlags(r, 'total').modelled ? ' · modelled' : ''}`;
            return c.datasetIndex === 0 ? ` Banked ${rxCr(c.raw, 0)} (${ctx.n} sessions)` : ` Projected ${rxCr(c.raw, 0)}`;
          },
        } } },
        scales: { x: { stacked: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } }, y: { stacked: true, beginAtZero: true, ticks: { callback: val => fmtNum(val, 0) } } },
      },
    });
    rxFixHeight(charts.predHist);
    lastScenario = ex;
  }

  // The Base scenario shows NSE's published default forecast as is (the JS
  // recomputation agrees to within rounding of the pipeline's stored ratios).
  function scenarioNow(name) {
    const s = predictorScenario(ex, ctx, v);
    return name === 'base' && defCur ? { ...s, ...defCur } : s;
  }

  function update() {
    const name = scenarioName();
    const s = scenarioNow(name);
    el.querySelectorAll('[data-rx-seg="preset"] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === name)));
    q('scenLabel').textContent = name === 'base' ? 'Base = quarter-to-date pace' : name === 'custom' ? 'Custom scenario' : `${name === 'bear' ? 'Bear' : 'Bull'}: rest-of-quarter revenue ${name === 'bear' ? '−' : '+'}${PREDICTOR_PRESET_PCT} %`;
    groups.forEach(g => g.fields.forEach(f => {
      const edited = Math.abs(Number(v[f.key]) - Number(defaults[f.key])) >= PREDICTOR_TOLERANCE;
      const input = el.querySelector(`#rxPred-${ex}-${f.key}`);
      input.classList.toggle('is-edited', edited);
      el.querySelector(`[data-tags="${f.key}"]`).innerHTML = f.tag + (edited ? ` ${rxChip('Edited', 'edit')} <button type="button" class="rx-link" data-reset="${f.key}">reset to ${predictorShown(defaults[f.key])}</button>` : '');
    }));
    renderKpis(s);
    renderBullet(s);
    renderSegTable(s);
    renderPnl(s);
    renderWalk(s);
    renderHist(s);
  }

  el.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const num = parseFloat(e.target.value);
    if (!isFinite(num) || num < 0) return;
    v[key] = key === 'days' ? Math.max(Math.round(num), ctx.n) : num;
    update();
  });
  el.addEventListener('change', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (key) e.target.value = predictorShown(v[key]);
  });
  el.addEventListener('click', e => {
    const r = e.target.closest('[data-reset]');
    if (r) { const k = r.dataset.reset; v[k] = defaults[k]; el.querySelector(`#rxPred-${ex}-${k}`).value = predictorShown(defaults[k]); update(); return; }
    if (e.target.closest('[data-rx="resetAll"]')) {
      Object.assign(v, defaults);
      Object.keys(defaults).forEach(k => { const i = el.querySelector(`#rxPred-${ex}-${k}`); if (i) i.value = predictorShown(defaults[k]); });
      update();
    }
  });
  rxOnSeg(el, 'preset', name => {
    const f = presets[name];
    ctx.segs.forEach(k => { v[k] = defaults[k] * f; el.querySelector(`#rxPred-${ex}-${k}`).value = predictorShown(v[k]); });
    update();
  });

  update();
  renderDaily();
  RX_TAB_REFRESH.prediction = () => { renderDaily(); charts.predHist && charts.predHist.destroy(); delete charts.predHist; lastScenario = null; renderHist(scenarioNow(scenarioName())); };
}

// Diagonal hatch fill for Chart.js bars (manual forecasts)
function rxHatchPattern() {
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const g = c.getContext('2d');
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, 6, 6);
  g.strokeStyle = '#8A8D94';
  g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(-1, 7); g.lineTo(7, -1); g.stroke();
  return g.createPattern(c, 'repeat');
}

// Buttons that jump to another tab (e.g. "value it →" on the predictor)
document.addEventListener('click', e => {
  const go = e.target.closest('[data-rx-goto]');
  if (!go) return;
  const nav = document.querySelector(`.nav-item[data-tab="${go.dataset.rxGoto}"]`);
  if (nav) nav.click();
});

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
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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
        x: { stacked: true, ticks: { maxRotation: 45, font: { size: CHART_FONT.tick } } },
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

// Mirror of scripts/share_regression.py (keep the two in step; tests/
// test_share_regression.py checks they agree). The revenue MA runs over every
// revenue trading day (`revenue_daily`), and a close on date d is paired with
// the MA ending on the last revenue day before d, shifted back `extraLag`
// revenue days. Slope errors are Newey-West (bandwidth 1.3·√n); the last 20 %
// of the window is an out-of-sample test against holding the last training
// price; a fair value is published only when the gate passes.
const SHARE_GATE = { minN: 60, minT: 2, minSpread: 0.10, holdoutShare: 0.20, minHoldout: 10 };

function shareOlsStats(X, Y) {
  const n = X.length;
  const xm = X.reduce((a, b) => a + b, 0) / n;
  const ym = Y.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (X[i] - xm) ** 2; sxy += (X[i] - xm) * (Y[i] - ym); syy += (Y[i] - ym) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = ym - slope * xm;
  const resid = X.map((x, i) => Y[i] - (slope * x + intercept));
  const ssRes = resid.reduce((s, u) => s + u * u, 0);
  const L = Math.floor(1.3 * Math.sqrt(n));
  const g = X.map((x, i) => (x - xm) * resid[i]);
  let S = g.reduce((s, v) => s + v * v, 0);
  for (let l = 1; l <= L; l++) {
    let c = 0;
    for (let t = l; t < n; t++) c += g[t] * g[t - l];
    S += 2 * (1 - l / (L + 1)) * c;
  }
  const seNw = Math.sqrt(Math.max(S, 0)) / sxx;
  let dwNum = 0;
  for (let t = 1; t < n; t++) dwNum += (resid[t] - resid[t - 1]) ** 2;
  return {
    slope, intercept, n,
    r2: 1 - ssRes / syy,
    r: sxy / Math.sqrt(sxx * syy),
    seNw, tNw: seNw > 0 ? slope / seNw : null, nwLags: L,
    dw: ssRes > 0 ? dwNum / ssRes : null,
  };
}

function shareHoldout(X, Y) {
  const n = X.length;
  const nTest = Math.max(SHARE_GATE.minHoldout, Math.round(n * SHARE_GATE.holdoutShare));
  const nTrain = n - nTest;
  if (nTrain < 20) return null;
  const fit = shareOlsStats(X.slice(0, nTrain), Y.slice(0, nTrain));
  const last = Y[nTrain - 1];
  let ape = 0, apeNaive = 0;
  for (let i = nTrain; i < n; i++) {
    ape      += Math.abs(fit.slope * X[i] + fit.intercept - Y[i]) / Y[i];
    apeNaive += Math.abs(last - Y[i]) / Y[i];
  }
  const mape = ape / nTest * 100, mapeNaive = apeNaive / nTest * 100;
  return { n_train: nTrain, n_test: nTest, mape_pct: mape, naive_mape_pct: mapeNaive, beats_naive: mape < mapeNaive };
}

function shareGateReasons(st, X) {
  const reasons = [];
  if (st.n < SHARE_GATE.minN) reasons.push(`only ${st.n} observations (needs ${SHARE_GATE.minN})`);
  if (st.slope <= 0) reasons.push('slope is not positive');
  else if (st.tNw == null || st.tNw < SHARE_GATE.minT)
    reasons.push(st.tNw == null ? 'slope not significant'
      : `slope not significant (Newey-West t = ${st.tNw.toFixed(2)}, needs ${SHARE_GATE.minT})`);
  const xm = X.reduce((a, b) => a + b, 0) / X.length;
  const spread = xm ? (Math.max(...X) - Math.min(...X)) / xm : 0;
  if (spread < SHARE_GATE.minSpread)
    reasons.push(`revenue MA moved only ${Math.round(spread * 100)}% over the window (needs ${Math.round(SHARE_GATE.minSpread * 100)}%)`);
  return reasons;
}

// Model for one DMA window / extra lag. Files written before the Phase 5
// method (no `revenue_daily`) fall back to the old same-day fit.
function computeShareModel(shareData, dmaWindow, extraLag = 0) {
  const prices = shareData.series || [];
  const regStart = shareData.regression_start;
  const rev = shareData.revenue_daily;
  if (!rev) {
    const legacy = buildSeriesWithDMA(prices, dmaWindow, regStart, extraLag, shareData.revenue_prefix || []);
    return legacy && { ...legacy, n: shareData.n_days, meth: null };
  }
  const revDates = rev.map(r => r.date);
  const mas = computeRollingMA(rev.map(r => r.revenue_cr), dmaWindow);
  const tainted = [];
  let run = 0;
  rev.forEach((r, i) => {
    run += r.modelled ? 1 : 0;
    if (i >= dmaWindow) run -= rev[i - dmaWindow].modelled ? 1 : 0;
    tainted.push(run > 0);
  });
  const rows = [];
  let j = 0;
  for (const p of prices) {
    while (j < revDates.length && revDates[j] < p.date) j++;
    const idx = j - 1 - extraLag;
    if (idx < 0 || mas[idx] == null) continue;
    rows.push({ ...p, rev_ma: mas[idx], _fit: p.date >= regStart && !tainted[idx] });
  }
  const fitRows = rows.filter(r => r._fit);
  if (fitRows.length < 10) return null;
  const X = fitRows.map(r => r.rev_ma), Y = fitRows.map(r => r.price);
  const st = shareOlsStats(X, Y);
  const reasons = shareGateReasons(st, X);
  const supported = reasons.length === 0;
  const series = rows.map(({ _fit, ...r }) => ({
    ...r,
    in_fit: _fit,
    price_pred: supported ? Math.round((st.slope * r.rev_ma + st.intercept) * 100) / 100 : null,
  }));
  const maMin = Math.min(...X), maMax = Math.max(...X);
  const maMean = X.reduce((a, b) => a + b, 0) / X.length;
  return {
    series,
    n: st.n,
    reg: {
      slope: st.slope, intercept: st.intercept, r_squared: st.r2, pearson_r: st.r,
      equation: `Price = ${st.slope.toFixed(2)} × Rev_MA${dmaWindow}[t-${1 + extraLag}] + ${st.intercept.toFixed(2)}`,
      fit: st.r2 > 0.7 ? 'strong' : st.r2 > 0.4 ? 'moderate' : 'weak',
    },
    meth: {
      revenue_lag_days: 1 + extraLag,
      t_stat_newey_west: st.tNw, newey_west_lags: st.nwLags, durbin_watson: st.dw,
      holdout: shareHoldout(X, Y), fair_value_supported: supported, gate_reasons: reasons,
      ma_min: maMin, ma_max: maMax, ma_spread: maMean ? (maMax - maMin) / maMean : 0,
    },
  };
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
    case 'fit':
    default:        cutoff = regStart;
  }
  return ser.filter(r => r.date >= cutoff);
}

// ========================
// REGRESSION TAB — share price vs the revenue moving average, one builder
// for NSE, BSE and MCX. The answer (price vs fair value, and the price ÷ MA
// ratio vs its history) comes first, then the significance checks, then the
// charts for the window / lag / range picked in the sticky bar.
// ========================

const SHARE_EXCHANGE_NAMES = { nse: 'NSE', bse: 'BSE', mcx: 'MCX' };
const SHARE_MA_WINDOWS = [10, 20, 45];
const SHARE_LAGS = [0, 45, 60, 90];

// "2026-12-17" → "mid-Dec 2026"
function rxRoughDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return '—';
  const part = +m[3] <= 10 ? 'early' : +m[3] <= 20 ? 'mid' : 'late';
  return `${part}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1]} ${m[1]}`;
}

// Range buttons: the fit window plus the fixed spans the series is long enough for
function shareRanges(series, regStart) {
  const first = series.length ? series[0].date : regStart;
  const last = series.length ? series[series.length - 1].date : regStart;
  const back = (months) => { const d = new Date(last + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
  const out = [['3m', '3 M', 3], ['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24]]
    .filter(([, , months]) => back(months) >= first || months <= 3)
    .map(([k, label]) => [k, label]);
  const m = /^(\d{4})-(\d{2})/.exec(regStart || '');
  const fitLabel = m ? `Since ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2] - 1]} ${m[1].slice(2)}` : 'Fit window';
  return out.concat([['fit', fitLabel]]);
}

// Mean and population σ of price ÷ revenue MA over the rows used in the fit
function shareRatioStats(series, regStart) {
  const fit = series.filter(r => (r.in_fit === undefined ? r.date >= regStart : r.in_fit) && r.rev_ma > 0 && r.price > 0);
  if (fit.length < 2) return null;
  const ratios = fit.map(r => r.price / r.rev_ma);
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
  return { mean, sd };
}

function shareChecksHTML(d) {
  const m = d.meth;
  if (!m) return rxAlert('This share file predates the significance checks (Newey-West t, Durbin-Watson, holdout), so none are shown.', 'info');
  const n = d.n, t = m.t_stat_newey_west, h = m.holdout, dw = m.durbin_watson;
  const items = [];
  items.push(n >= SHARE_GATE.minN
    ? rxCheck('ok', `${fmtNum(n, 0)} sessions`, `needs ≥ ${SHARE_GATE.minN}`)
    : rxCheck('fail', `${fmtNum(n, 0)} sessions`, `needs ≥ ${SHARE_GATE.minN} before a fair value is published`));
  if (d.reg.slope <= 0) items.push(rxCheck('fail', 'Slope not positive', 'price does not rise with revenue in this fit'));
  else if (t == null || t < SHARE_GATE.minT) items.push(rxCheck('fail', `Newey-West t = ${t == null ? '—' : t.toFixed(2)}`, `slope not significant (needs ≥ ${SHARE_GATE.minT})`));
  else items.push(rxCheck('ok', `Newey-West t = ${t.toFixed(2)}`, `slope significant (needs ≥ ${SHARE_GATE.minT}), ${m.newey_west_lags} lags`));
  if (m.ma_spread != null) {
    const moved = `₹${fmtNum(m.ma_min, 1)}–${fmtNum(m.ma_max, 1)} Cr`;
    items.push(m.ma_spread >= SHARE_GATE.minSpread
      ? rxCheck('ok', `Revenue MA ${moved}`, `moved ${Math.round(m.ma_spread * 100)} % over the fit (needs ≥ ${Math.round(SHARE_GATE.minSpread * 100)} %)`)
      : rxCheck('fail', `Revenue MA ${moved}`, `moved only ${Math.round(m.ma_spread * 100)} % (needs ≥ ${Math.round(SHARE_GATE.minSpread * 100)} %)`));
  }
  if (!h) items.push(rxCheck('warn', 'No holdout test', 'too few sessions to hold any back'));
  else items.push(h.beats_naive
    ? rxCheck('ok', `Holdout ${h.mape_pct.toFixed(1)} % vs ${h.naive_mape_pct.toFixed(1)} %`, `beats “price unchanged” over the last ${h.n_test} sessions`)
    : rxCheck('warn', `Holdout ${h.mape_pct.toFixed(1)} % vs ${h.naive_mape_pct.toFixed(1)} %`, `loses to “price unchanged” over the last ${h.n_test} sessions`));
  if (dw != null) items.push(dw < 1
    ? rxCheck('warn', `Durbin-Watson ${dw.toFixed(2)}`, 'errors strongly autocorrelated: gaps from fair value persist for weeks')
    : dw < 1.5
      ? rxCheck('warn', `Durbin-Watson ${dw.toFixed(2)}`, 'some autocorrelation in the errors')
      : rxCheck('ok', `Durbin-Watson ${dw.toFixed(2)}`, 'errors close to independent'));
  return `<section class="rx-checks" aria-label="Model checks">${items.join('')}</section>`;
}

function shareHeroHTML(ex, s, d, regStart, w, lag) {
  const lat = s.latest || {};
  const row = latestShareRow(d.series, lat.date);
  const price = lat.is_live ? lat.price_actual : row.price;
  const fv = row.price_pred;
  const m = d.meth, h = m && m.holdout;
  const priceWhen = lat.is_live ? `${s.ticker} live ${rxChip('Live', 'ok')}` : `${s.ticker} close ${rxDate(lat.date)}`;
  const lagTxt = 1 + lag === 1 ? 'one session' : `${1 + lag} sessions`;
  const eq = `Price = ${d.reg.slope.toFixed(2)} × RevMA${w}[t−${1 + lag}] ${d.reg.intercept >= 0 ? '+' : '−'} ${fmtNum(Math.abs(d.reg.intercept), 2)}`;

  let main;
  if (fv != null && price) {
    const gap = price / fv - 1;
    const word = gap >= 0 ? 'above' : 'below';
    let ctx = '';
    if (h && !h.beats_naive) ctx = `The model loses to “price unchanged” out of sample (${h.mape_pct.toFixed(1)} % vs ${h.naive_mape_pct.toFixed(1)} % error): read the gap as context, not a signal.`;
    else if (h && Math.abs(gap * 100) < h.mape_pct) ctx = `Inside the model’s ${h.mape_pct.toFixed(1)} % out-of-sample error, so not a signal on its own.`;
    else if (h) ctx = `Wider than the model’s ${h.mape_pct.toFixed(1)} % out-of-sample error.`;
    main = `<div class="rx-lbl">Price vs revenue fair value</div>
      <div class="rx-hero-v">${rxRupee(price)} <small>vs fair value</small> ${rxRupee(fv)}</div>
      <div class="rx-hero-line">Price is <strong>${Math.abs(gap * 100).toFixed(1)} % ${word}</strong> the model. <span class="rx-foot" style="font-size:13px">${ctx}</span></div>`;
  } else {
    const why = m && m.gate_reasons && m.gate_reasons.length ? m.gate_reasons.join('; ') : 'the fit does not pass the significance checks';
    main = `<div class="rx-lbl">Price vs revenue fair value</div>
      <div class="rx-hero-v">${rxRupee(price)} <small>· fair value withheld</small></div>
      <div class="rx-hero-line">No fair value for this window: ${escHtml(why)}.</div>`;
  }
  main += `<div class="rx-mono">${eq}</div>
    <p class="rx-foot" style="margin-top:3px">n ${fmtNum(d.n, 0)} sessions · fitted from ${rxDate(regStart)} · revenue lagged ${lagTxt} · R² ${d.reg.r_squared.toFixed(2)}, r ${d.reg.pearson_r.toFixed(2)} (in-sample) · ${priceWhen}</p>`;

  const rs = shareRatioStats(d.series, regStart);
  let side = '';
  if (rs && rs.sd > 0 && row.rev_ma > 0) {
    const ratio = price / row.rev_ma;
    const z = (ratio - rs.mean) / rs.sd;
    const where = z <= -1 ? 'low against' : z >= 1 ? 'high against' : 'near';
    const pin = Math.max(0, Math.min(100, (z + 2) / 4 * 100));
    side = `<div class="rx-lbl">Price ÷ revenue MA${w}</div>
      <div class="rx-hero-v">${fmtNum(ratio, 0)} <small>mean ${fmtNum(rs.mean, 0)} · σ ${fmtNum(rs.sd, 1)}</small></div>
      <div class="rx-hero-line">${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)} σ: <strong>${where}</strong> its fit-window average</div>
      <div class="rx-gauge" role="img" aria-label="Ratio at ${z >= 0 ? 'plus' : 'minus'} ${Math.abs(z).toFixed(1)} standard deviations, on a scale from minus 2 to plus 2">
        <div class="rx-gauge-track"><div style="background:#C9D6F3"></div><div style="background:#EAF0FB"></div><div style="background:#EAF0FB"></div><div style="background:#C9D6F3"></div></div>
        <div class="rx-gauge-mid"></div>
        <div class="rx-gauge-pin" style="left:${pin.toFixed(1)}%"></div>
      </div>
      <div class="rx-gauge-axis"><span>−2σ ${fmtNum(rs.mean - 2 * rs.sd, 0)}</span><span>mean</span><span>+2σ ${fmtNum(rs.mean + 2 * rs.sd, 0)}</span></div>
      <p class="rx-foot" style="margin-top:6px">At the average ratio the price would be ${rxRupee(rs.mean * row.rev_ma)} (MA ₹${fmtNum(row.rev_ma, 2)} Cr).</p>`;
  }

  const how = rxHow('How this model works', `<ul>
    <li>Each close is paired with the ${w}-session average of daily transaction revenue up to the previous session${lag ? `, shifted back a further ${lag} sessions` : ''}. The average runs over every revenue day, so missing quotes do not shorten it.</li>
    <li>The fit is ordinary least squares over the sessions from ${rxDate(regStart)}${ex === 'mcx' ? '; modelled MCX revenue (before 2 Sep 2024) is left out' : ''}. R² and r describe that same window (in-sample).</li>
    <li>Slope significance uses Newey-West standard errors (bandwidth 1.3·√n), which allow for the autocorrelation Durbin-Watson measures.</li>
    <li>Holdout: the model is refitted on the first 80 % of the window and scored on the last 20 % against “price unchanged”.</li>
    <li>A fair value is shown only with ≥ ${SHARE_GATE.minN} sessions, a positive slope with t ≥ ${SHARE_GATE.minT}, and a revenue MA that moved ≥ ${Math.round(SHARE_GATE.minSpread * 100)} %.</li>
  </ul>`);

  return `<section class="rx-panel"><div class="rx-hero"><div class="rx-hero-main">${main}</div>${side ? `<div class="rx-hero-side">${side}</div>` : ''}</div>${how}</section>`;
}

function buildShareAnalysis(ex) {
  const el = document.getElementById(`${ex}-share-inner`);
  if (!el) return;
  const s = SHARE_DATA;
  if (!s) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Share price regression',
      body: `<div class="rx-empty"><b>Share analysis not available</b>scripts/${ex}_share_analysis.py writes dashboard/data/${ex}_share_analysis.json after each daily run.</div>` })}</div>`;
    return;
  }
  if (s.status === 'collecting' || !s.regression) { renderShareCollecting(el, ex); return; }

  const name = SHARE_EXCHANGE_NAMES[ex];
  const regStart = s.regression_start;
  const state = { dma: SHARE_MA_WINDOWS.includes(s.ma_window) ? s.ma_window : 45, lag: 0, range: 'fit' };
  const cache = {};
  const model = (w, lag) => {
    const k = w + '_' + lag;
    if (!(k in cache)) cache[k] = computeShareModel(s, w, lag);
    return cache[k];
  };
  const id = k => `rxShare${k}-${ex}`;

  el.innerHTML = `<div class="rx">
    ${s.limited_data ? rxAlert(`<strong>Limited data.</strong> ${name} listed on ${rxDate(s.listing_date)}; this fit uses ${s.n_days} sessions of price history and refits every day.`) : ''}
    <div data-rx="hero"></div>
    <div data-rx="checks"></div>
    <div class="rx-bar" role="toolbar" aria-label="Model and chart controls">
      <div class="rx-grp"><span class="rx-lbl">MA window</span>${rxSeg('dma', SHARE_MA_WINDOWS.map(w => [w, w + ' D']), state.dma, 'Revenue moving-average window')}</div>
      <div class="rx-grp"><span class="rx-lbl">Extra lag</span>${rxSeg('lag', SHARE_LAGS.map(l => [l, l ? l + ' D' : 'None']), state.lag, 'Extra revenue lag')}</div>
      <div class="rx-grp"><span class="rx-lbl">Range</span>${rxSeg('range', shareRanges(s.series || [], regStart), state.range, 'Chart range')}</div>
      <p class="rx-foot" data-rx="r2"></p>
    </div>
    ${rxPanel({ title: 'Share price: actual vs model', meta: `₹ · <span data-rx="span"></span>`,
      right: `<span data-rx="legPrice"></span>`,
      body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas(id('Price'))}<div data-rx="residWrap">${rxCanvas(id('Resid'))}</div></div>`,
      foot: `<span data-rx="residNote"></span>` })}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-half', title: `Price ÷ revenue MA<span data-rx="w"></span>`, meta: 'mean ± 1σ and ± 2σ over the fit window',
        body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas(id('Ratio'))}</div><div class="rx-chart-note" data-rx="legRatio"></div>` })}
      ${rxPanel({ cls: 'rx-col-half', title: `Revenue MA<span data-rx="w"></span> → price`, meta: 'each session, shaded by date',
        body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas(id('Scatter'))}</div><div class="rx-chart-note" data-rx="legScatter"></div>` })}
    </div>
    ${rxPanel({ title: `Price and revenue MA<span data-rx="w"></span>, indexed`, meta: 'start of range = 100 · one axis, so the two lines compare like for like',
      right: `<span data-rx="legIndex"></span>`,
      body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(id('Index'))}</div>` })}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);
  const setAll = (k, html) => el.querySelectorAll(`[data-rx="${k}"]`).forEach(n => { n.innerHTML = html; });

  function renderText() {
    const d = model(state.dma, state.lag);
    setAll('w', String(state.dma));
    if (!d) {
      q('hero').innerHTML = rxAlert(`Too few overlapping price and revenue sessions to fit a ${state.dma}-session MA${state.lag ? ` with a ${state.lag}-session lag` : ''}.`);
      q('checks').innerHTML = '';
      return null;
    }
    q('hero').innerHTML = shareHeroHTML(ex, s, d, regStart, state.dma, state.lag);
    q('checks').innerHTML = shareChecksHTML(d);
    const r2 = SHARE_MA_WINDOWS.map(w => {
      const m = model(w, state.lag);
      const v = m ? m.reg.r_squared.toFixed(2) : '—';
      return w === state.dma ? `<strong class="rx-strong">${w} D ${v}</strong>` : `${w} D ${v}`;
    }).join(' · ');
    q('r2').innerHTML = `R² by window (in-sample): ${r2}`;
    return d;
  }

  function renderCharts() {
    const d = model(state.dma, state.lag);
    ['shPrice', 'shResid', 'shRatio', 'shScatter', 'shIndex'].forEach(k => { if (charts[k]) { charts[k].destroy(); delete charts[k]; } });
    if (!d || !d.series.length) return;
    const lat = s.latest || {};
    const view = filterShareSeries(d.series, state.range, regStart);
    if (!view.length) return;
    const w = state.dma;
    const hasFv = view.some(r => r.price_pred != null);
    const labels = view.map(r => fmtChartDate(r.date));
    const dateTitle = items => rxDate(view[items[0].dataIndex].date);
    q('span').textContent = `${rxDate(view[0].date)} – ${rxDate(view[view.length - 1].date)}`;

    q('legPrice').innerHTML = rxLegend([{ label: 'Close', color: RX.ink, kind: 'line' }]
      .concat(hasFv ? [{ label: 'Model (fair value)', color: RX.model, kind: 'dash' }, { label: 'Close above model', color: RX.above }, { label: 'Below', color: RX.below }] : []));
    rxChart('shPrice', id('Price'), 300, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Close', data: view.map(r => r.price), borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0 },
        { label: 'Model', data: view.map(r => r.price_pred), borderColor: RX.model, borderWidth: 1.75, borderDash: [5, 3], pointRadius: 0, tension: 0 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: dateTitle,
          label: ctx => ctx.raw == null ? null : ` ${ctx.dataset.label}: ₹${fmtNum(ctx.raw, 0)}`,
          footer: items => { const r = view[items[0].dataIndex]; return r.price_pred ? `Close vs model ${rxSignedPct(r.price / r.price_pred - 1)}` : ''; },
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
          y: { ticks: { callback: v => '₹' + fmtNum(v, 0) } },
        },
      },
    });

    const residWrap = q('residWrap');
    residWrap.hidden = !hasFv;
    q('residNote').textContent = hasFv
      ? 'Lower strip: close ÷ model − 1. Long runs on one side are the Durbin-Watson warning made visible.'
      : 'No model line: the fair value is withheld for this window (see the checks above).';
    if (hasFv) {
      const gaps = view.map(r => r.price_pred ? (r.price / r.price_pred - 1) * 100 : null);
      const lim = Math.max(10, Math.ceil(Math.max(...gaps.filter(g => g != null).map(Math.abs)) / 10) * 10);
      rxChart('shResid', id('Resid'), 84, {
        type: 'line',
        data: { labels, datasets: [{ label: 'Close vs model', data: gaps, borderWidth: 0, pointRadius: 0, tension: 0,
          fill: { target: 'origin', above: RX.above, below: RX.below } }] },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { callbacks: { title: dateTitle, label: ctx => ctx.raw == null ? null : ` Close vs model: ${ctx.raw >= 0 ? '+' : '−'}${Math.abs(ctx.raw).toFixed(1)} %` } } },
          scales: {
            x: { display: false },
            y: { min: -lim, max: lim, ticks: { stepSize: lim, callback: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' %' } },
          },
        },
      });
      rxFixHeight(charts.shResid);
    }

    const rs = shareRatioStats(d.series, regStart);
    if (rs) {
      const ratios = view.map(r => r.price / r.rev_ma);
      const flat = v => view.map(() => v);
      const band = (lbl, v, fill, bg) => ({ label: lbl, data: flat(v), borderWidth: 0, pointRadius: 0, fill, backgroundColor: bg, tension: 0 });
      rxChart('shRatio', id('Ratio'), 260, {
        type: 'line',
        data: { labels, datasets: [
          band('+2σ', rs.mean + 2 * rs.sd, { target: 4 }, 'rgba(43, 92, 200, 0.07)'),
          band('+1σ', rs.mean + rs.sd, { target: 3 }, 'rgba(43, 92, 200, 0.12)'),
          { label: 'Mean', data: flat(rs.mean), borderColor: RX.muted, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false },
          band('−1σ', rs.mean - rs.sd, false, 'transparent'),
          band('−2σ', rs.mean - 2 * rs.sd, false, 'transparent'),
          { label: 'Price ÷ MA', data: ratios, borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0, fill: false },
        ] },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: {
            filter: item => item.datasetIndex === 5,
            callbacks: {
              title: dateTitle,
              label: ctx => { const z = (ctx.raw - rs.mean) / rs.sd; return ` Ratio ${fmtNum(ctx.raw, 0)} (${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ)`; },
              footer: items => `At the mean ratio: ₹${fmtNum(rs.mean * view[items[0].dataIndex].rev_ma, 0)}`,
            },
          } },
          scales: {
            x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true } },
            y: { ticks: { callback: v => fmtNum(v, 0) } },
          },
        },
      });
      q('legRatio').innerHTML = rxLegend([
        { label: 'Price ÷ MA', color: RX.ink, kind: 'line' },
        { label: `± 1σ (${fmtNum(rs.mean - rs.sd, 0)}–${fmtNum(rs.mean + rs.sd, 0)})`, color: 'rgba(43, 92, 200, 0.19)' },
        { label: `± 2σ (${fmtNum(rs.mean - 2 * rs.sd, 0)}–${fmtNum(rs.mean + 2 * rs.sd, 0)})`, color: 'rgba(43, 92, 200, 0.07)', style: 'box-shadow:inset 0 0 0 1px #DCE5F7' },
        { label: `Mean ${fmtNum(rs.mean, 0)}`, color: RX.muted, kind: 'dash' },
      ]);
    }

    const last = view[view.length - 1];
    const lastPrice = last.date === lat.date && lat.is_live ? lat.price_actual : last.price;
    const pts = view.slice(0, -1);
    const xs = view.map(r => r.rev_ma);
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const scatterSets = [
      { type: 'scatter', label: 'Session', data: pts.map(r => ({ x: r.rev_ma, y: r.price, date: r.date })),
        pointBackgroundColor: pts.map((r, i) => RX.seq[Math.min(4, Math.floor(i / Math.max(pts.length, 1) * 5))]),
        pointBorderColor: '#FFFFFF', pointBorderWidth: 0.5, pointRadius: 3.2, pointHoverRadius: 5 },
      { type: 'scatter', label: 'Latest', data: [{ x: last.rev_ma, y: lastPrice, date: last.date }],
        pointBackgroundColor: '#FFFFFF', pointBorderColor: RX.ink, pointBorderWidth: 2, pointRadius: 6, pointHoverRadius: 7 },
    ];
    if (hasFv) scatterSets.push({ type: 'line', label: 'Fit', data: [{ x: xMin, y: d.reg.slope * xMin + d.reg.intercept }, { x: xMax, y: d.reg.slope * xMax + d.reg.intercept }],
      borderColor: RX.model, borderDash: [5, 3], borderWidth: 1.75, pointRadius: 0, tension: 0 });
    rxChart('shScatter', id('Scatter'), 260, {
      type: 'scatter',
      data: { datasets: scatterSets },
      options: {
        plugins: { tooltip: {
          filter: item => item.dataset.label !== 'Fit',
          callbacks: {
            title: items => rxDate(items[0].raw.date),
            label: ctx => ` MA ₹${fmtNum(ctx.parsed.x, 2)} Cr · close ₹${fmtNum(ctx.parsed.y, 0)}`,
          },
        } },
        scales: {
          x: { type: 'linear', grace: '4%', title: { display: true, text: `Revenue MA${w}, ₹ Cr / day` }, ticks: { callback: v => '₹' + fmtNum(v, 0) } },
          y: { grace: '4%', ticks: { callback: v => '₹' + fmtNum(v, 0) } },
        },
      },
    });
    q('legScatter').innerHTML = rxLegend([
      { label: 'Older', color: RX.seq[0] }, { label: 'Recent', color: RX.seq[4] },
      { label: `Latest (${fmtTradeDate(last.date)})`, color: '#FFFFFF', style: `border:2px solid ${RX.ink};border-radius:50%;width:11px;height:11px` },
    ].concat(hasFv ? [{ label: 'Fit', color: RX.model, kind: 'dash' }] : []));

    const p0 = view[0].price, m0 = view[0].rev_ma;
    const pIdx = view.map(r => r.price / p0 * 100), mIdx = view.map(r => r.rev_ma / m0 * 100);
    rxChart('shIndex', id('Index'), 240, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Share price', data: pIdx, borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0 },
        { label: `Revenue MA${w}`, data: mIdx, borderColor: RX.rev, borderWidth: 1.75, pointRadius: 0, tension: 0 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: dateTitle,
          label: ctx => {
            const r = view[ctx.dataIndex];
            return ctx.datasetIndex === 0 ? ` Price ${fmtNum(ctx.raw, 0)} (₹${fmtNum(r.price, 0)})` : ` Revenue MA ${fmtNum(ctx.raw, 0)} (₹${fmtNum(r.rev_ma, 2)} Cr)`;
          },
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
          y: { ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    rxFixHeight(charts.shIndex);
    q('legIndex').innerHTML = rxLegend([
      { label: `Share price ${fmtNum(pIdx[pIdx.length - 1], 0)}`, color: RX.ink, kind: 'line' },
      { label: `Revenue MA${w} ${fmtNum(mIdx[mIdx.length - 1], 0)}`, color: RX.rev, kind: 'line' },
    ]);
  }

  rxOnSeg(el, 'dma', v => { state.dma = +v; renderText(); renderCharts(); });
  rxOnSeg(el, 'lag', v => { state.lag = +v; renderText(); renderCharts(); });
  rxOnSeg(el, 'range', v => { state.range = v; renderCharts(); });
  renderText();
  renderCharts();
  RX_TAB_REFRESH.share = renderCharts;
}

// Before a newly listed share has SHARE_GATE.minN sessions (NSE listed
// 2026-09-24) there is nothing to fit: show collection progress, how price
// and the revenue MA have moved since listing, and the raw rows.
function renderShareCollecting(el, ex) {
  const s = SHARE_DATA;
  const name = SHARE_EXCHANGE_NAMES[ex];
  const n = s.n_days || 0;
  const need = s.min_days_required || SHARE_GATE.minN;
  const lat = s.latest || {};
  const left = Math.max(need - n, 0);
  const eta = rxAddWeekdays(lat.date, left);
  const since = s.first_price && lat.price_actual ? lat.price_actual / s.first_price - 1 : null;
  const pct = Math.min(100, Math.round(n / need * 100));
  const ser = s.series || [];
  const w = s.ma_window || 45;

  const rows = [...ser].reverse().map(r => `<tr><td>${rxDate(r.date)}</td><td>₹${fmtNum(r.price, 2)}</td><td>${fmtNum(r.revenue_cr, 2)}</td><td>${fmtNum(r.rev_ma, 2)}</td></tr>`).join('');
  el.innerHTML = `<div class="rx">
    ${rxKpis([
      rxKpi('Sessions collected', `${n} <small>/ ${need}</small>`, `${pct} % of the minimum for a fit`, { extra: `<div class="rx-progress" role="img" aria-label="${n} of ${need} sessions"><div style="width:${pct}%"></div></div>` }),
      rxKpi('Share price', rxRupee(lat.price_actual, 2), `${s.ticker} · ${lat.is_live ? 'live' : 'close ' + rxDate(lat.date)}`),
      rxKpi('Since listing', rxChangeHTML(since), `first close ₹${fmtNum(s.first_price, 2)} on ${rxDate(s.listing_date)}`),
      rxKpi('Regression unlocks', left ? '≈ ' + rxRoughDate(eta) : 'Next run', left ? `${left} more sessions, holidays aside` : 'enough sessions collected'),
    ], 'Collection progress')}
    ${rxAlert(`<strong>No fit yet.</strong> ${name} shares started trading on ${rxDate(s.listing_date)}. With ${n} sessions a regression would not pass the significance checks, so the fair value, checks and charts appear here on their own once ${need} sessions are in (same method as BSE and MCX).`, 'info')}
    ${rxPanel({ title: `Price and revenue MA${w} since listing, indexed`, meta: 'listing day = 100 · not fitted',
      right: rxLegend([{ label: 'Share price', color: RX.ink, kind: 'line' }, { label: `Revenue MA${w} to previous session`, color: RX.rev, kind: 'line' }]),
      body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`rxShareCollect-${ex}`)}</div>` })}
    ${rxPanel({ title: 'Daily closes since listing', meta: `${n} sessions`,
      body: `<div class="rx-scroll" style="max-height:360px;overflow-y:auto"><table class="rx-table"><thead><tr><th scope="col">Date</th><th scope="col">Close</th><th scope="col">Revenue, ₹ Cr</th><th scope="col">MA${w} to prev. session, ₹ Cr</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="rx-l">No overlapping price and revenue days yet</td></tr>'}</tbody></table></div>` })}
  </div>`;

  function renderChart() {
    if (!ser.length) return;
    const p0 = ser[0].price, m0 = ser[0].rev_ma;
    rxChart('shCollect', `rxShareCollect-${ex}`, 240, {
      type: 'line',
      data: { labels: ser.map(r => fmtTradeDate(r.date)), datasets: [
        { label: 'Share price', data: ser.map(r => r.price / p0 * 100), borderColor: RX.ink, borderWidth: 1.75, pointRadius: 2, pointBackgroundColor: RX.ink, tension: 0 },
        { label: 'Revenue MA', data: ser.map(r => r.rev_ma / m0 * 100), borderColor: RX.rev, borderWidth: 1.75, pointRadius: 2, pointBackgroundColor: RX.rev, tension: 0 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => rxDate(ser[items[0].dataIndex].date),
          label: ctx => { const r = ser[ctx.dataIndex]; return ctx.datasetIndex === 0 ? ` Price ${fmtNum(ctx.raw, 1)} (₹${fmtNum(r.price, 2)})` : ` Revenue MA ${fmtNum(ctx.raw, 1)} (₹${fmtNum(r.rev_ma, 2)} Cr)`; },
        } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
          y: { ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
  }
  renderChart();
  rxFixHeight(charts.shCollect);
  RX_TAB_REFRESH.share = () => { renderChart(); rxFixHeight(charts.shCollect); };
}

// ========================
// SHARES OUTSTANDING — the one place share counts live
// ========================

// Crore shares, the default for every EPS on the Revenue Predictor and
// Valuation Model tabs (editable there). Nothing fetches share
// counts — yfinance supplies prices only — so these are static, and each view
// shows the value with its source and as-of note. as_of is null where the repo
// records no date; source says how far the figure can be trusted.
// BSE's 40.73 is also the Excel model's Annual Predictor starting value; the
// workbook it mirrors read shares from a Bloomberg/FactSet plugin (see
// docs/superpowers/specs/2026-07-02-bse-excel-valuation-replication-design.md),
// but neither the figure nor its date is recorded anywhere checkable.
// NSE's 247.5 is the share count implied by reported PAT ÷ EPS in
// nse_dashboard_data.json's pnl: 247.4–247.6 Cr in every reported quarter.
const SHARES_OUTSTANDING_CR = {
  bse: { value: 40.73, as_of: null, source: 'hard-coded, unverified' },
  mcx: { value: 25.45, as_of: null, source: 'hard-coded, unverified' },
  nse: { value: 247.5, as_of: 'Q3 FY 2026', source: 'implied by reported PAT ÷ EPS in the NSE P&L data (247.4–247.6 Cr each reported quarter since Q3 FY 2024)' },
};

// Escapes text for HTML content and double-quoted attributes.
function escHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ========================
// VALUATION HELPERS
// ========================

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
// VALUATION MODEL TAB — one model per exchange
// ========================
// FY average daily revenue (ADR) → transaction revenue → + other income →
// × PAT margin → PAT → ÷ shares → FY EPS → × P/E → FY-end target, optionally
// discounted to today. Bear / Base / Bull differ by rest-of-year ADR growth and
// P/E. The base ADR is either the FY projection (FY revenue to date + trailing
// 45-session average for the sessions left) or, for BSE, the Excel "Annual
// Predictor" method (BSE's FY revenue to date + NSE+BSE market ADR × BSE's
// 20-session share for the sessions left). Inputs are saved per exchange.

const VALUATION_DEFAULTS = {
  // Excel "BSE" sheet starting values (Annual Predictor and Quick Valuation)
  bse: { src: 'mkt', g0: -5, g1: 0, g2: 5, days: 247, oiMode: 'fixed', oi: 2055.39, margin: 52, pe0: 40, pe1: 45, pe2: 50, disc: 18 },
  // Owner assumptions: other income as a % of total income, no discounting
  nse: { src: 'proj', g0: 0, g1: 0, g2: 0, days: 247, oiMode: 'pct', oi: 30, margin: 55, pe0: 25, pe1: 35, pe2: 45, disc: 0 },
  // Placeholders (no MCX valuation baseline exists); MCX trades ~257 sessions a year
  mcx: { src: 'proj', g0: 0, g1: 0, g2: 0, days: 257, oiMode: 'fixed', oi: 0, margin: 50, pe0: 25, pe1: 30, pe2: 35, disc: 0 },
};
const VALUATION_SOURCE = {
  bse: { kind: '', label: 'Excel model' },
  nse: { kind: '', label: 'Owner assumption' },
  mcx: { kind: 'warn', label: 'Placeholder' },
};
const VALUATION_SCENARIOS = ['bear', 'base', 'bull'];
const valuationStorageKey = ex => `valuation_${ex}_v2`;

// Saved inputs; on first use, carries over values saved by the earlier Quick
// Valuation panel (quickValuation_{ex}_v1) and BSE Annual Predictor
// (bseValuationAssumptions_v1).
function loadValuationInputs(ex) {
  const d = { ...VALUATION_DEFAULTS[ex], shares: SHARES_OUTSTANDING_CR[ex].value };
  const read = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const saved = read(valuationStorageKey(ex));
  if (saved) return { ...d, ...saved };
  const out = { ...d };
  const qv = read(`quickValuation_${ex}_v1`);
  if (qv) {
    if (qv.patMarginPct != null) out.margin = qv.patMarginPct;
    if (d.oiMode === 'pct' && qv.otherIncomePct != null) out.oi = qv.otherIncomePct;
    if (d.oiMode === 'fixed' && qv.otherIncomeCr != null) out.oi = qv.otherIncomeCr;
    ['Bear', 'Base', 'Bull'].forEach((s, i) => { if (qv['pe' + s] != null) out['pe' + i] = qv['pe' + s]; });
  }
  const bv = ex === 'bse' ? read('bseValuationAssumptions_v1') : null;
  if (bv) {
    ['Bear', 'Base', 'Bull'].forEach((s, i) => { if (bv[`adrGrowth${s}Pct`] != null) out['g' + i] = bv[`adrGrowth${s}Pct`]; });
    if (bv.discountPct != null) out.disc = bv.discountPct;
    if (bv.sharesOutstandingCr != null) out.shares = bv.sharesOutstandingCr;
    if (bv.fy27TotalTradingDays != null) out.days = bv.fy27TotalTradingDays;
  }
  return out;
}

function saveValuationInputs(ex, v) {
  try { localStorage.setItem(valuationStorageKey(ex), JSON.stringify(v)); } catch (e) { /* storage blocked: not remembered */ }
}

// FY revenue to date, trailing averages and (BSE) market-share inputs
function valuationContext(ex, series, nseSeries) {
  const fy = currentFYQuarterLabel(new Date()).fy;
  const fyRows = series.filter(r => r.fy === fy);
  const sum = rows => rows.reduce((s, r) => s + (r.total_rev || 0), 0);
  const avg = rows => rows.length ? sum(rows) / rows.length : 0;
  const prevFY = 'FY ' + (Number(fy.match(/\d{4}/)[0]) - 1);
  const ctx = {
    fy, fyShort: `FY${fy.slice(-2)}`, fyRows, elapsed: fyRows.length, revToDate: sum(fyRows), adr45: avg(series.slice(-45)),
    prevFY, prevFYDays: series.filter(r => r.fy === prevFY).length,
    flags: mergeFlags([rowsFlags(fyRows, 'total'), rowsFlags(series.slice(-45), 'total')]),
  };
  if (ex === 'bse' && nseSeries && nseSeries.length) {
    const fyM = combinedMarketADRForRows(fyRows, nseSeries);
    const m45 = combinedMarketADR(series, nseSeries, 45);
    const m20 = combinedMarketADR(series, nseSeries, 20);
    ctx.mkt = {
      adrFY: avg(fyRows), adr45: avg(series.slice(-45)), adr20: avg(series.slice(-20)),
      totalFY: fyM.totalMarketADR, total45: m45.totalMarketADR, total20: m20.totalMarketADR,
      shareFY: fyM.bseShare, share45: m45.bseShare, share20: m20.bseShare,
    };
  }
  return ctx;
}

// One scenario: g = rest-of-year ADR growth %, pe = multiple
function valuationScenario(ctx, v, g, pe, cmp) {
  const rest = Math.max(v.days - ctx.elapsed, 0);
  const restAdr = v.src === 'mkt' && ctx.mkt ? ctx.mkt.total45 * ctx.mkt.share20 : ctx.adr45;
  const adr = v.days ? (ctx.revToDate + restAdr * (1 + g / 100) * rest) / v.days : 0;
  return valuationFromAdr(adr, v, pe, cmp);
}

function valuationFromAdr(adr, v, pe, cmp) {
  const txn = adr * v.days;
  const pct = Math.min(v.oi, 99.9);
  const oi = v.oiMode === 'pct' ? txn * pct / (100 - pct) : v.oi;
  const total = txn + oi;
  const pat = total * v.margin / 100;
  const eps = v.shares ? pat / v.shares : null;
  const fwd = eps != null ? eps * pe : null;
  const now = fwd != null ? fwd / (1 + v.disc / 100) : null;
  return { adr, txn, oi, total, pat, eps, pe, fwd, now, upFwd: fwd && cmp ? fwd / cmp - 1 : null, upNow: now && cmp ? now / cmp - 1 : null };
}

// Rounded axis bounds and tick step for a ₹ range
function niceRange(lo, hi, ticks = 6) {
  const span = Math.max(hi - lo, 1);
  const raw = span / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
  return { lo: Math.floor(lo / step) * step, hi: Math.ceil(hi / step) * step, step };
}

async function buildValuation(ex) {
  const el = document.getElementById(`${ex}ValuationContent`);
  if (!el) return;
  const series = bseDailySeries(DATA);
  if (!series.length) { el.innerHTML = ''; return; }
  let nseSeries = null, analysts = [];
  if (ex === 'bse') {
    await ensureFreshMarketData(['nse']);
    nseSeries = bseDailySeries(MARKET_RAW.nse || {});
    analysts = await loadBSEAnalystTargets();
    if (currentExchange !== ex) return;  // switched away while loading
    // This view combines BSE's own rows with NSE's from the shared cache
    VIEW_BUILT_FROM.nse = marketSig('nse');
    VIEW_SOURCES.valuation = [{ ex: 'bse', date: lastTradeDate(series) }, { ex: 'nse', date: lastTradeDate(nseSeries) }];
    updateSnapshotNotice();
    updateFeeNotice();
  }

  const ctx = valuationContext(ex, series, nseSeries);
  const name = SHARE_EXCHANGE_NAMES[ex];
  const defaults = { ...VALUATION_DEFAULTS[ex], shares: SHARES_OUTSTANDING_CR[ex].value };
  const v = loadValuationInputs(ex);
  if (v.src === 'mkt' && !ctx.mkt) v.src = 'proj';
  const state = { basis: v.disc > 0 ? 'now' : 'fwd' };
  const lat = SHARE_DATA?.latest || {};
  const cmp = lat.price_actual ?? null;
  const prov = VALUATION_SOURCE[ex];
  const shareSrc = SHARES_OUTSTANDING_CR[ex];

  // Market-based ranges for the football field (from the share feed)
  const shareSer = SHARE_DATA?.series || [];
  const lastShareDate = shareSer.length ? shareSer[shareSer.length - 1].date : null;
  const yearAgo = lastShareDate ? (() => { const d = new Date(lastShareDate + 'T00:00:00Z'); d.setUTCFullYear(d.getUTCFullYear() - 1); return d.toISOString().slice(0, 10); })() : null;
  const yr = shareSer.filter(r => r.date >= yearAgo && r.price > 0).map(r => r.price);
  const sinceListing = SHARE_DATA?.listing_date && shareSer.length && shareSer[0].date >= yearAgo;
  const fv = lat.price_pred ?? null;
  const meth = SHARE_DATA?.methodology || null;
  const mape = meth?.holdout?.mape_pct ?? null;
  const shareModel = SHARE_DATA?.regression && SHARE_DATA.status !== 'collecting' ? computeShareModel(SHARE_DATA, SHARE_DATA.ma_window || 45) : null;
  const ratio = shareModel ? shareRatioStats(shareModel.series, SHARE_DATA.regression_start) : null;
  const lastMa = shareModel ? latestShareRow(shareModel.series, lat.date)?.rev_ma : null;
  const brokerAvg = analysts.length ? analysts.reduce((s, t) => s + t.target_price, 0) / analysts.length : null;
  const oldest = analysts.reduce((mn, t) => (t.date && (!mn || t.date < mn) ? t.date : mn), null);
  const oldestAge = daysSinceIso(oldest);

  const cmpWhen = cmp == null ? 'no price yet' : lat.is_live ? 'live quote' : `close ${fmtTradeDate(lat.date)}`;
  const fyE = `${ctx.fyShort}E`;
  const chip = (kind, label) => rxChip(label, kind);
  const srcChip = () => chip(prov.kind, prov.label);
  const fieldChip = {
    g: () => ex === 'bse' ? chip('', 'Excel model') : chip('', 'No growth assumed'),
    days: () => chip(ctx.prevFYDays && v.days === ctx.prevFYDays ? 'data' : '', ctx.prevFYDays ? `${ctx.prevFY.replace(' ', '')} had ${ctx.prevFYDays}` : 'Assumption'),
    oi: srcChip, margin: srcChip, pe: srcChip,
    shares: () => shareSrc.source === 'hard-coded, unverified' ? chip('warn', 'Hard-coded · unverified') : chip('data', 'PAT ÷ EPS, reported'),
    disc: () => ex === 'bse' ? chip('', 'Excel model') : chip('', 'Not discounted'),
  };
  const edited = keys => keys.some(k => Math.abs(Number(v[k]) - Number(defaults[k])) > 1e-9);
  const editedChip = keys => edited(keys) ? ' ' + rxChip('Edited', 'edit') : '';

  const inp = (key, step, aria, w = '') => `<input class="rx-in rx-num-in" type="number" step="${step}" inputmode="decimal" data-key="${key}" aria-label="${escHtml(aria)}" value="${v[key]}"${w ? ` style="width:${w}"` : ''}>`;

  const adrSrcOptions = [['proj', 'FY projection']].concat(ctx.mkt ? [['mkt', 'Market × BSE share (Excel)']] : []);
  const mkt = ctx.mkt;
  const mktTable = mkt ? `<div class="rx-scroll" style="margin-top:6px"><table class="rx-table"><thead><tr><th scope="col">Market input</th><th scope="col">FY to date</th><th scope="col">Last 45</th><th scope="col">Last 20</th></tr></thead><tbody>
      <tr><td>NSE + BSE ADR, ₹ Cr</td><td>${fmtNum(mkt.totalFY, 2)}</td><td>${fmtNum(mkt.total45, 2)}</td><td>${fmtNum(mkt.total20, 2)}</td></tr>
      <tr><td>BSE share</td><td>${fmtPct(mkt.shareFY)}</td><td>${fmtPct(mkt.share45)}</td><td>${fmtPct(mkt.share20)}</td></tr>
      <tr><td>BSE ADR, ₹ Cr</td><td>${fmtNum(mkt.adrFY, 2)}</td><td>${fmtNum(mkt.adr45, 2)}</td><td>${fmtNum(mkt.adr20, 2)}</td></tr></tbody></table></div>` : '';

  el.innerHTML = `<div class="rx">
    ${ex === 'mcx' ? rxAlert('<strong>Placeholder inputs.</strong> There is no MCX valuation baseline in this repo: PAT margin, other income and P/E multiples are round-number placeholders, so these targets are illustrative until you set them.') : ''}
    <section class="rx-kpis" aria-label="Valuation summary" data-rx="kpis"></section>
    ${rxPanel({ title: 'Valuation range by method', meta: '₹ per share · bars span the range, tick = base or centre',
      right: rxLegend([{ label: 'This model', color: RX.model }, { label: 'Market-based', color: RX.grey }, { label: cmp != null ? `CMP ${rxRupee(cmp)}` : 'CMP', color: RX.neg, kind: 'tick' }]),
      body: '<div class="rx-pb"><div class="rx-ff" data-rx="ff"></div></div>', foot: '<span data-rx="ffNote"></span>' })}
    <div class="rx-row">
      <section class="rx-panel rx-col-wide" aria-label="Assumptions">
        <div class="rx-ph"><h2>Assumptions</h2><span class="rx-meta">One model, three scenarios · saved in this browser</span>
          <div class="rx-ph-right"><span class="rx-lbl">Targets as</span>${rxSeg('basis', [['fwd', `${ctx.fyShort} end`], ['now', 'Today (discounted)']], state.basis, 'Target basis')}<button type="button" class="rx-link" data-rx="reset">Reset to defaults</button></div></div>
        <div class="rx-pb" style="padding-bottom:6px">
          <div style="display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center"><span class="rx-lbl">Base ADR from</span>${rxSeg('src', adrSrcOptions, v.src, 'Base ADR method')}</div>
          <p class="rx-foot" data-rx="srcNote" style="margin-top:6px"></p>
        </div>
        <div class="rx-scroll"><table class="rx-table">
          <thead><tr><th scope="col">Line</th><th scope="col">Bear</th><th scope="col">Base</th><th scope="col">Bull</th><th scope="col" class="rx-l">Source</th></tr></thead>
          <tbody>
            <tr><td>ADR growth, rest of year, %</td><td>${inp('g0', 1, 'Bear ADR growth')}</td><td>${inp('g1', 1, 'Base ADR growth')}</td><td>${inp('g2', 1, 'Bull ADR growth')}</td><td class="rx-src" data-src="g"></td></tr>
            <tr><td>ADR, ₹ Cr / session${flagTags(ctx.flags)}</td><td data-out="adr-0"></td><td data-out="adr-1"></td><td data-out="adr-2"></td><td class="rx-src">${chip('data', `${ctx.elapsed} sessions actual`)}</td></tr>
            <tr><td>Trading sessions in ${ctx.fy}</td><td colspan="3" class="rx-c">${inp('days', 1, 'Trading sessions in the year')}</td><td class="rx-src" data-src="days"></td></tr>
            <tr><td>Transaction revenue, ₹ Cr</td><td data-out="txn-0"></td><td data-out="txn-1"></td><td data-out="txn-2"></td><td class="rx-src"></td></tr>
            <tr><td>${v.oiMode === 'pct' ? 'Other income, % of total income' : 'Other income, ₹ Cr'}</td><td colspan="3" class="rx-c">${inp('oi', 1, 'Other income', '96px')}</td><td class="rx-src" data-src="oi"></td></tr>
            ${v.oiMode === 'pct' ? '<tr><td>Other income, ₹ Cr</td><td data-out="oi-0"></td><td data-out="oi-1"></td><td data-out="oi-2"></td><td class="rx-src">solved from the %</td></tr>' : ''}
            <tr class="rx-sub"><td>Total income, ₹ Cr</td><td data-out="total-0"></td><td data-out="total-1"></td><td data-out="total-2"></td><td class="rx-src"></td></tr>
            <tr><td>PAT margin, %</td><td colspan="3" class="rx-c">${inp('margin', 0.5, 'PAT margin')}</td><td class="rx-src" data-src="margin"></td></tr>
            <tr class="rx-sub"><td>PAT, ₹ Cr</td><td data-out="pat-0"></td><td data-out="pat-1"></td><td data-out="pat-2"></td><td class="rx-src"></td></tr>
            <tr><td>Shares, Cr</td><td colspan="3" class="rx-c">${inp('shares', 0.01, 'Shares outstanding')}</td><td class="rx-src" data-src="shares"></td></tr>
            <tr class="rx-sub"><td>EPS ${fyE}, ₹</td><td data-out="eps-0"></td><td data-out="eps-1"></td><td data-out="eps-2"></td><td class="rx-src"></td></tr>
            <tr><td>P/E, ×</td><td>${inp('pe0', 1, 'Bear P/E')}</td><td>${inp('pe1', 1, 'Base P/E')}</td><td>${inp('pe2', 1, 'Bull P/E')}</td><td class="rx-src" data-src="pe"></td></tr>
            <tr class="rx-sub"><td>Target at ${ctx.fyShort} end, ₹</td><td data-out="fwd-0"></td><td data-out="fwd-1"></td><td data-out="fwd-2"></td><td class="rx-src">EPS × P/E</td></tr>
            <tr><td>Discount to today, %</td><td colspan="3" class="rx-c">${inp('disc', 0.5, 'Discount rate')}</td><td class="rx-src" data-src="disc"></td></tr>
            <tr class="rx-sub"><td>Target today, ₹</td><td data-out="now-0"></td><td data-out="now-1"></td><td data-out="now-2"></td><td class="rx-src">÷ (1 + discount)</td></tr>
            <tr class="rx-out"><td>Upside vs CMP · <span data-rx="basisName"></span></td><td data-out="up-0"></td><td data-out="up-1"></td><td data-out="up-2"></td><td class="rx-src">CMP ${cmp != null ? rxRupee(cmp) : '—'}, ${cmpWhen}</td></tr>
          </tbody>
        </table></div>
        ${rxHow('How this model works', `<ul>
          <li><strong>FY projection:</strong> ${ctx.fy} revenue to date (${ctx.elapsed} sessions, ${rxCr(ctx.revToDate, 0)}) plus the trailing 45-session average (${rxCr(ctx.adr45, 2)}) for the sessions left, divided by the sessions in the year.</li>
          ${ctx.mkt ? `<li><strong>Market × BSE share (Excel “Annual Predictor”):</strong> the sessions left earn the NSE + BSE 45-session market ADR × BSE’s 20-session share (${rxCr(mkt.total45 * mkt.share20, 2)} a session).</li>` : ''}
          <li>Scenario growth applies to the sessions left only; P/E differs by scenario. Other income${v.oiMode === 'pct' ? ' is solved so it is the given % of total income (transaction revenue + other income)' : ' is a fixed annual figure'}.</li>
          <li>The ${ctx.fyShort}-end target is EPS × P/E on the full-year ${fyE} EPS, not a spot fair value; “Today” discounts it by the discount rate.</li>
        </ul>${mktTable}`)}
      </section>
      ${rxPanel({ cls: 'rx-col-narrow', title: 'Sensitivity', meta: '<span data-rx="sensMeta"></span>',
        body: `<div class="rx-pb rx-scroll"><table class="rx-table rx-sens" data-rx="sens"></table>
          <div style="margin-top:10px">${rxLegend([{ label: 'Downside', color: '#E9B48C' }, { label: '', color: '#F5D9C4' }, { label: '±5 %', color: '#F1F1EE' }, { label: '', color: '#CBD8F4' }, { label: 'Upside', color: '#9DB4E8' }])}</div>
          <p class="rx-foot" style="margin-top:6px">Outlined: base case. Other inputs as set.</p></div>` })}
    </div>
    ${ex === 'bse' ? rxPanel({ title: 'Analyst targets', meta: 'bse_analyst_targets.json · 12-month targets',
      right: oldestAge != null && oldestAge > ANALYST_TARGET_STALE_DAYS ? rxChip(`Oldest ${oldestAge} days old`, 'warn') : '',
      body: `<div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col">Broker</th><th scope="col">Target</th><th scope="col">vs CMP</th><th scope="col" class="rx-l">Rating</th><th scope="col">Date</th><th scope="col">Age</th><th scope="col" class="rx-l">Method</th><th scope="col" class="rx-l">Source</th></tr></thead><tbody>
        ${analysts.length ? analysts.slice().sort((a, b) => b.target_price - a.target_price).map(t => {
          const age = daysSinceIso(t.date);
          const url = safeHttpUrl(t.source_url);
          return `<tr><td>${escHtml(t.broker)}</td><td>${rxRupee(t.target_price)}</td><td>${cmp ? rxChangeHTML(t.target_price / cmp - 1) : '—'}</td><td class="rx-l">${escHtml(t.rating || '')}</td><td>${rxDate(t.date)}</td><td>${age == null ? '—' : rxChip(`${age} d`, age > ANALYST_TARGET_STALE_DAYS ? 'warn' : '')}</td><td class="rx-wrap">${escHtml(t.methodology || '')}</td><td class="rx-l">${url ? `<a class="rx-link" href="${url}" target="_blank" rel="noopener noreferrer">Report ↗</a>` : '<span class="rx-foot">not on file</span>'}</td></tr>`;
        }).join('') : '<tr><td colspan="8" class="rx-l">No analyst targets on file: add them to dashboard/data/bse_analyst_targets.json</td></tr>'}
      </tbody></table></div>`,
      foot: `Notes older than ${ANALYST_TARGET_STALE_DAYS} days are flagged. Revenue trend tables are on <button type="button" class="rx-link" data-rx-goto="revenue">Revenue Summary</button>; the moving-average charts on <button type="button" class="rx-link" data-rx-goto="share">Regression</button>.` }) : ''}
  </div>`;

  const q = k => el.querySelector(`[data-rx="${k}"]`);

  function compute() {
    return VALUATION_SCENARIOS.map((s, i) => valuationScenario(ctx, v, v['g' + i], v['pe' + i], cmp));
  }

  function render() {
    const sc = compute();
    const base = sc[1];
    const pick = s => state.basis === 'now' ? s.now : s.fwd;
    const up = s => state.basis === 'now' ? s.upNow : s.upFwd;
    const basisName = state.basis === 'now' ? 'today' : `${ctx.fyShort} end`;
    q('basisName').textContent = basisName;
    q('srcNote').textContent = v.src === 'mkt' && ctx.mkt
      ? `${ctx.elapsed} sessions actual (${rxCr(ctx.revToDate, 0)}), then ${rxCr(ctx.mkt.total45 * ctx.mkt.share20, 2)} a session: market ADR ${fmtNum(ctx.mkt.total45, 2)} × BSE 20-session share ${fmtPct(ctx.mkt.share20)}.`
      : `${ctx.elapsed} sessions actual (${rxCr(ctx.revToDate, 0)}), then the trailing 45-session average ${rxCr(ctx.adr45, 2)} a session.`;

    // Assumption table outputs
    sc.forEach((s, i) => {
      const set = (k, html) => { const n = el.querySelector(`[data-out="${k}-${i}"]`); if (n) n.innerHTML = html; };
      set('adr', fmtNum(s.adr, 2)); set('txn', fmtNum(s.txn, 0)); set('oi', fmtNum(s.oi, 0)); set('total', fmtNum(s.total, 0));
      set('pat', fmtNum(s.pat, 0)); set('eps', fmtNum(s.eps, 2)); set('fwd', fmtNum(s.fwd, 0)); set('now', fmtNum(s.now, 0));
      set('up', up(s) == null ? '—' : `<span class="${up(s) >= 0 ? 'rx-up' : 'rx-dn'}">${rxSignedPct(up(s))}</span>`);
    });
    Object.entries({ g: ['g0', 'g1', 'g2'], days: ['days'], oi: ['oi'], margin: ['margin'], shares: ['shares'], pe: ['pe0', 'pe1', 'pe2'], disc: ['disc'] })
      .forEach(([k, keys]) => { const n = el.querySelector(`[data-src="${k}"]`); if (n) n.innerHTML = fieldChip[k]() + editedChip(keys); });
    el.querySelectorAll('input[data-key]').forEach(i => i.classList.toggle('is-edited', Math.abs(Number(v[i.dataset.key]) - Number(defaults[i.dataset.key])) > 1e-9));

    // KPIs
    const blendParts = [base.now, fv, brokerAvg != null ? brokerAvg / (1 + v.disc / 100) : null].filter(x => x != null && isFinite(x));
    const blend = blendParts.length ? blendParts.reduce((a, b) => a + b, 0) / blendParts.length : null;
    const range = yr.length ? `${sinceListing ? 'since listing' : '52-week'} ${rxRupee(Math.min(...yr))} – ${fmtNum(Math.max(...yr), 0)}` : cmpWhen;
    q('kpis').innerHTML = [
      rxKpi('CMP', cmp != null ? rxRupee(cmp) : '—', `${cmpWhen}${yr.length ? ' · ' + range : ''}`),
      rxKpi(`EPS ${fyE} · base`, rxRupee(base.eps, 2), `PAT ${rxCr(base.pat, 0)} on ${fmtNum(v.shares, 2)} Cr shares`),
      rxKpi('P/E at CMP', cmp && base.eps ? `${fmtNum(cmp / base.eps, 1)}×` : '—', `vs base multiple ${fmtNum(v.pe1, 0)}×`),
      rxKpi(`Base target · ${basisName}`, rxRupee(pick(base)), up(base) == null ? 'no CMP yet' : `${rxChangeHTML(up(base))} vs CMP`, { accent: true }),
      blendParts.length > 1
        ? rxKpi('Blended target · today', rxRupee(blend), cmp ? `${rxChangeHTML(blend / cmp - 1)} · avg of ${['model (today)', fv != null ? 'regression' : null, brokerAvg != null ? 'analysts (discounted)' : null].filter(Boolean).join(', ')}` : 'needs a CMP')
        : rxKpi('Blended target · today', '—', 'needs a regression fair value or analyst targets beside the model'),
    ].join('');

    // Football field
    const rows = [{ label: 'P/E × EPS', note: `this model · ${basisName}`, lo: pick(sc[0]), mid: pick(base), hi: pick(sc[2]), color: RX.model, midLabel: 'base' }];
    if (fv != null) rows.push({ label: 'Regression fair value', note: mape != null ? `${rxRupee(fv)} ± ${mape.toFixed(1)} % holdout error${meth?.holdout && !meth.holdout.beats_naive ? ' · loses to “price unchanged”' : ''}` : 'published fair value', lo: mape != null ? fv * (1 - mape / 100) : fv, mid: fv, hi: mape != null ? fv * (1 + mape / 100) : fv, color: RX.grey, midLabel: 'fair value' });
    else rows.push({ label: 'Regression fair value', note: SHARE_DATA?.status === 'collecting' ? `${SHARE_DATA.n_days} of ${SHARE_DATA.min_days_required} sessions collected` : 'withheld: fit not significant', na: true });
    if (ratio && lastMa) rows.push({ label: 'Price ÷ revenue MA band', note: `mean ± 1σ × MA ₹${fmtNum(lastMa, 2)} Cr`, lo: (ratio.mean - ratio.sd) * lastMa, mid: ratio.mean * lastMa, hi: (ratio.mean + ratio.sd) * lastMa, color: RX.grey, midLabel: 'mean' });
    if (analysts.length) {
      const tp = analysts.map(t => t.target_price);
      rows.push({ label: 'Analyst targets', note: `${analysts.length} brokers, 12-month${oldest ? ` · ${rxDate(oldest).replace(/^\d+ /, '')}` : ''}`, lo: Math.min(...tp), mid: brokerAvg, hi: Math.max(...tp), color: RX.grey, midLabel: 'mean' });
    }
    if (yr.length) rows.push({ label: sinceListing ? 'Range since listing' : '52-week range', note: `${SHARE_DATA.ticker} closes`, lo: Math.min(...yr), mid: cmp, hi: Math.max(...yr), color: RX.light, midLabel: 'CMP' });
    const vals = rows.filter(r => !r.na).flatMap(r => [r.lo, r.hi]).concat(cmp != null ? [cmp] : []).filter(x => x != null && isFinite(x));
    const nr = niceRange(Math.min(...vals) * 0.97, Math.max(...vals) * 1.03, 6);
    const pos = x => ((Math.max(nr.lo, Math.min(nr.hi, x)) - nr.lo) / (nr.hi - nr.lo) * 100).toFixed(2);
    const cmpLine = cmp != null ? `<div class="rx-ff-cmp" style="left:${pos(cmp)}%" title="CMP ${rxRupee(cmp)}"></div>` : '';
    const ticks = [];
    for (let t = nr.lo; t <= nr.hi + 1e-9; t += nr.step) ticks.push(t);
    q('ff').innerHTML = rows.map(r => `
      <div class="rx-ff-lab">${r.label}<span>${r.note}</span></div>
      <div class="rx-ff-trk">${r.na ? '<span class="rx-ff-na">not available</span>' : `
        <div class="rx-ff-bar" style="left:${pos(r.lo)}%;width:${Math.max(pos(r.hi) - pos(r.lo), 0.6).toFixed(2)}%;background:${r.color}" title="${r.label}: ${rxRupee(r.lo)} – ${rxRupee(r.hi)}"></div>
        ${r.mid != null ? `<div class="rx-ff-tick" style="left:${pos(r.mid)}%"></div>` : ''}`}${cmpLine}</div>
      <div class="rx-ff-val">${r.na ? '<span>—</span>' : `<strong>${rxRupee(r.lo)} – ${fmtNum(r.hi, 0)}</strong><span>${r.midLabel} ${rxRupee(r.mid)}</span>`}</div>`).join('') + `
      <div class="rx-ff-axis-pad"></div><div class="rx-ff-axis">${ticks.map(t => `<span style="left:${pos(t)}%">${rxRupee(t)}</span>`).join('')}</div><div class="rx-ff-axis-pad"></div>`;
    q('ffNote').innerHTML = `The model row follows “Targets as”. ${fv != null ? 'Regression and ratio rows use the published 45-session fit; see the Regression tab.' : ''} ${analysts.length && oldestAge > ANALYST_TARGET_STALE_DAYS ? `Analyst targets are raw 12-month figures and up to ${oldestAge} days old.` : ''}`;

    // Sensitivity: P/E rows × ADR columns around the base case
    const peStep = 5, adrStep = niceRange(0, base.adr * 0.2, 4).step;
    const pes = [-2, -1, 0, 1, 2].map(k => v.pe1 + k * peStep).filter(x => x > 0);
    const adrs = [-2, -1, 0, 1, 2].map(k => base.adr + k * adrStep).filter(x => x > 0);
    const shade = u => u == null ? '#F1F1EE' : u <= -0.15 ? '#E9B48C' : u <= -0.05 ? '#F5D9C4' : u < 0.05 ? '#F1F1EE' : u < 0.15 ? '#CBD8F4' : '#9DB4E8';
    q('sensMeta').textContent = `Target ${basisName}, ₹ · P/E × ADR (₹ Cr / session)`;
    q('sens').innerHTML = `<thead><tr><th scope="col">P/E · ADR</th>${adrs.map((a, j) => `<th scope="col">${fmtNum(a, adrStep < 1 ? 2 : 1)}${j === 2 ? '<br><span class="rx-foot">base</span>' : ''}</th>`).join('')}</tr></thead><tbody>${pes.map(pe => `<tr><th scope="row">${fmtNum(pe, 0)}×</th>${adrs.map((a, j) => {
      const r = valuationFromAdr(a, v, pe, cmp);
      const u = up(r);
      return `<td class="${pe === v.pe1 && j === 2 ? 'is-base' : ''}" style="background:${shade(u)}">${rxRupee(pick(r))}<small>${u == null ? '' : rxSignedPct(u, 0)}</small></td>`;
    }).join('')}</tr>`).join('')}</tbody>`;
  }

  const save = debounce(() => saveValuationInputs(ex, v), 400);
  el.addEventListener('input', e => {
    const key = e.target.dataset && e.target.dataset.key;
    if (!key) return;
    const num = parseFloat(e.target.value);
    if (!isFinite(num)) return;
    v[key] = num;
    render();
    save();
  });
  el.addEventListener('change', e => { const key = e.target.dataset && e.target.dataset.key; if (key) e.target.value = v[key]; });
  q('reset').addEventListener('click', () => {
    Object.assign(v, defaults);
    if (v.src === 'mkt' && !ctx.mkt) v.src = 'proj';
    el.querySelectorAll('input[data-key]').forEach(i => { i.value = v[i.dataset.key]; });
    el.querySelectorAll('[data-rx-seg="src"] button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === v.src)));
    try { localStorage.removeItem(valuationStorageKey(ex)); } catch (e) { /* storage blocked */ }
    render();
  });
  rxOnSeg(el, 'basis', b => { state.basis = b; render(); });
  rxOnSeg(el, 'src', s => { v.src = s; render(); save(); });
  render();
}

// ========================
// LIVE PREDICTOR (NSE + BSE) — revenue so far → predicted close from the live
// poller's intraday samples ({exchange}_live_hourly.json), set against how
// archived sessions built up through the day ({exchange}_hourly_history.json).
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
const SESSION_MINUTES = 405;
// A poll older than this during market hours marks the feed as delayed
const LIVE_STALE_MINUTES = 20;
// Predictions from the first minutes after the open are not charted
const LIVE_PRED_SETTLE_MIN = 10;
const LIVE_DAY_TYPES = [['all', 'All days'], ['normal', 'Normal'], ['expiry', 'Expiry'], ['pre_expiry', 'Pre-expiry']];
const LIVE_WINDOWS = [
  ['09:15–10:00', 0, 45], ['10:00–11:00', 45, 105], ['11:00–12:00', 105, 165], ['12:00–13:00', 165, 225],
  ['13:00–14:00', 225, 285], ['14:00–15:00', 285, 345], ['15:00–16:00', 345, 405],
];

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
  return m[2] != null ? `${typeLabel}, same weekday` : typeLabel;
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

// "HH:MM" for minutes after the 09:15 open
function sessionClock(m) {
  const t = 555 + Math.round(m);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// Share of the close an archived day had reached `m` minutes after the open,
// interpolated between its hourly checkpoints (null if a checkpoint is missing)
function dayFractionAt(day, m) {
  const pts = [[0, 0]];
  for (const [label, min] of INTRADAY_CHECKPOINTS) {
    const cp = day.checkpoints && day.checkpoints[label];
    if (!cp || cp.fraction == null) return null;
    pts.push([min, cp.fraction]);
  }
  for (let i = 1; i < pts.length; i++) {
    if (m <= pts[i][0]) return pts[i - 1][1] + (m - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0]) * (pts[i][1] - pts[i - 1][1]);
  }
  return 1;
}

function quantile(vals, p) {
  const xs = vals.slice().sort((a, b) => a - b);
  if (!xs.length) return null;
  const k = (xs.length - 1) * p, f = Math.floor(k), c = Math.min(f + 1, xs.length - 1);
  return xs[f] + (xs[c] - xs[f]) * (k - f);
}

// Revenue at minute m from a list of {elapsed_minutes, total_revenue} polls
function revenueAt(samples, m) {
  if (!samples.length || m > samples[samples.length - 1].elapsed_minutes) return null;
  let prev = { elapsed_minutes: 0, total_revenue: 0 };
  for (const s of samples) {
    if (m <= s.elapsed_minutes) {
      const span = s.elapsed_minutes - prev.elapsed_minutes;
      return span ? prev.total_revenue + (m - prev.elapsed_minutes) / span * (s.total_revenue - prev.total_revenue) : s.total_revenue;
    }
    prev = s;
  }
  return prev.total_revenue;
}

// Feed state from the poll file: live, delayed, or closed (with the session shown)
function liveStatus(hourly, latest) {
  const now = new Date(Date.now() + 330 * 60000);   // IST wall clock as UTC fields
  const wd = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const open = wd >= 1 && wd <= 5 && mins >= 555 && mins < 960;
  const isToday = !!hourly?.date && hourly.date === istDateOf();
  let age = null;
  if (latest && latest.captured_ist) {
    const t = Date.parse(latest.captured_ist + 'Z');
    if (isFinite(t)) age = Math.round((now.getTime() - t) / 60000);
  }
  if (isToday && open && age != null && age <= LIVE_STALE_MINUTES) return { kind: 'live', isToday, age };
  if (isToday && open) return { kind: 'stale', isToday, age };
  return { kind: 'closed', isToday, age };
}

async function buildLivePredictor(ex) {
  const el = document.getElementById(`${ex}IntradayContent`);
  if (!el) return;
  const [hourly, history] = await Promise.all([fetchIntradayJSON(ex, 'hourly'), fetchIntradayJSON(ex, 'history')]);
  if (currentExchange !== ex) return;  // switched away while loading

  const days = ((history && history.days) || []).slice().sort((a, b) => a.date.localeCompare(b.date));
  const complete = days.filter(d => dayFractionAt(d, SESSION_MINUTES) != null);
  // Only polls after the 09:15 open describe the session: pre-open polls repeat the previous session's totals
  const samples = ((hourly && hourly.samples) || []).filter(s => s.elapsed_minutes > 0 && s.total_revenue != null);
  const latest = samples.length ? samples[samples.length - 1] : null;
  const st = liveStatus(hourly, latest);
  const sessDate = hourly?.date || null;
  const sessLong = sessDate ? fmtTradeDate(sessDate, true) : '';
  const dayType = hourly?.day_type || 'normal';
  const countOf = k => k === 'all' ? complete.length : complete.filter(d => d.day_type === k).length;
  const state = { type: countOf(dayType) >= 3 ? dayType : 'all' };
  // The session's official close, once the daily pipeline has it
  const closeRow = sessDate ? (DATA.daily_all || []).find(r => r.date === sessDate) : null;
  const actualClose = closeRow && !st.isToday ? closeRow.total_rev : (closeRow && st.kind === 'closed' ? closeRow.total_rev : null);
  const pred = latest?.predicted_eod ?? null;
  const q = DATA.quarterly || [];
  const cq = q.length ? q[q.length - 1] : null;
  const qtdAvg = cq && cq.days ? cq.total_rev / cq.days : null;
  // Benchmark for the predicted close: archived days of the same type, else the quarter-to-date average
  const sameType = complete.filter(d => d.day_type === dayType && d.date !== sessDate);
  const refAvg = sameType.length >= 3
    ? { value: sameType.reduce((a, d) => a + d.eod_revenue, 0) / sameType.length, label: `${dayType.replace('_', '-')}-day avg` }
    : qtdAvg ? { value: qtdAvg, label: 'QTD avg' } : null;
  const name = SHARE_EXCHANGE_NAMES[ex];

  const statusHTML = st.kind === 'live'
    ? `<span class="rx-status rx-status--live" role="status"><span class="rx-dot" aria-hidden="true"></span>Live · last poll ${(latest.captured_ist || '').slice(11, 16)} IST</span>`
    : st.kind === 'stale'
      ? `<span class="rx-status rx-status--stale" role="status"><span class="rx-dot" aria-hidden="true"></span>Delayed · last poll ${latest ? (latest.captured_ist || '').slice(11, 16) + ' IST' : 'none yet today'}${st.age != null ? ` (${st.age} min ago)` : ''}</span>`
      : `<span class="rx-status" role="status"><span class="rx-dot" aria-hidden="true"></span>Market closed${sessLong ? ` · showing ${sessLong}` : ''}</span>`;

  if (!samples.length) {
    el.innerHTML = `<div class="rx">
      <div class="rx-bar" style="position:static">${statusHTML}<p class="rx-foot">${name} · live polls run about every 5 minutes, 09:15–16:00 IST on trading days</p></div>
      ${rxPanel({ title: 'Live predictor', body: `<div class="rx-empty"><b>No poll since the 09:15 open${sessLong ? ` on ${sessLong}` : ''}</b>GitHub Actions polls every few minutes during market hours, though not on a precise schedule. The prediction appears with the first poll.</div>` })}
    </div>`;
    return;
  }

  const segs = [['Options', latest.options_revenue, RX.model], ['Cash', latest.cash_revenue, RX.rev], ['Futures', latest.futures_revenue, RX.ink2]].filter(s => s[1] != null);
  const segTotal = segs.reduce((a, s) => a + s[1], 0);

  el.innerHTML = `<div class="rx">
    <div class="rx-bar" style="position:static">${statusHTML}<p class="rx-foot" style="margin-left:0">${name} · trade date ${sessLong} · ${dayType.replace('_', '-')} day · ${samples.length} polls since 09:15</p></div>
    <section class="rx-kpis" data-rx="kpis" aria-label="Session so far"></section>
    ${rxPanel({ title: 'Cumulative revenue through the session', meta: '₹ Cr, 09:15–16:00 IST',
      right: rxSeg('type', LIVE_DAY_TYPES.map(([k, l]) => [k, `${l} (${countOf(k)})`]), state.type, 'Archived days the band is built from'),
      body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas(`rxLiveCum-${ex}`)}</div><div class="rx-chart-note" data-rx="legCum"></div>`,
      foot: '<span data-rx="cumNote"></span>' })}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-wide', title: 'Where the day’s revenue comes from', meta: 'by hour window',
        body: '<div class="rx-scroll"><table class="rx-table" data-rx="wins"></table></div>', foot: '<span data-rx="winNote"></span>' })}
      ${rxPanel({ cls: 'rx-col-narrow', title: 'Prediction through the day', meta: 'predicted close at each poll, ₹ Cr',
        body: `<div class="rx-pb" style="padding-bottom:4px">${rxCanvas(`rxLivePred-${ex}`)}</div>`, foot: '<span data-rx="predNote"></span>' })}
    </div>
    ${rxPanel({ title: 'How early estimates have done', meta: 'archived sessions · estimate = revenue at the hour ÷ the median share other days of that type had reached',
      body: '<div class="rx-scroll"><table class="rx-table" data-rx="arch"></table></div>',
      foot: 'Amber: off by 5 % or more. The live model’s own predictions are not archived yet, so this scores the simple share-of-day method on past sessions; logging each poll’s prediction would let it score the live model.' })}
  </div>`;
  const qx = k => el.querySelector(`[data-rx="${k}"]`);

  function typeDays(t, exclude) {
    const pool = complete.filter(d => d !== exclude);
    const same = t === 'all' ? pool : pool.filter(d => d.day_type === t);
    return same.length >= 3 ? same : pool;
  }

  function renderKpis(band) {
    const at = latest.elapsed_minutes;
    const fr = typeDays(state.type).map(d => dayFractionAt(d, at)).filter(x => x > 0);
    const lo = fr.length ? latest.total_revenue / quantile(fr, 0.9) : null;
    const hi = fr.length ? latest.total_revenue / quantile(fr, 0.1) : null;
    const when = `${(latest.captured_ist || '').slice(11, 16)} IST · ${fmtElapsed(at)} of 6h 45m`;
    const items = [
      rxKpi(st.isToday && st.kind !== 'closed' ? 'Revenue so far' : 'Revenue at last poll', rxCr(latest.total_revenue, 2), when),
      rxKpi(st.isToday && st.kind !== 'closed' ? 'Predicted close, 16:00' : 'Predicted close at last poll', rxCr(pred, 2),
        `${refAvg && pred ? rxChangeHTML(pred / refAvg.value - 1) + ` vs ${refAvg.label} ${rxCr(refAvg.value, 1)} · ` : ''}${intradayMethodLabel(latest.pred_method)}`, { accent: true }),
    ];
    if (actualClose != null) {
      items.push(rxKpi(`Actual close · trading data${flagTags(periodFlags(closeRow, 'total'))}`, rxCr(actualClose, 2), pred ? `Last prediction was ${rxSignedPct(pred / actualClose - 1)} off` : fmtTradeDate(sessDate, true)));
    } else {
      items.push(rxKpi('Typical-path range', lo != null ? `₹${fmtNum(lo, 1)} – ${fmtNum(hi, 1)} Cr` : '—',
        lo != null ? `revenue so far ÷ 10th–90th pct. share reached by ${sessionClock(at)} · n = ${fr.length}` : 'needs complete archived sessions'));
    }
    const mixBar = `<div style="display:flex;height:10px;gap:2px;margin:9px 0 7px" role="img" aria-label="${segs.map(s => `${s[0]} ${fmtNum(s[1], 2)} crore`).join(', ')}">${segs.map(s => `<div style="flex:${Math.max(s[1], 0)} 1 0;background:${s[2]}" title="${s[0]} ${rxCr(s[1], 2)}"></div>`).join('')}</div>`;
    items.push(rxKpi('Segment mix so far', mixBar, segs.map(s => `${s[0]} ${segTotal ? fmtPct(s[1] / segTotal) : '—'}`).join(' · ')));
    qx('kpis').innerHTML = items.join('');
  }

  function renderCum() {
    const pool = typeDays(state.type);
    const endValue = actualClose ?? pred;
    const grid = [];
    for (let m = 0; m <= SESSION_MINUTES; m += 15) grid.push(m);
    if (grid[grid.length - 1] !== SESSION_MINUTES) grid.push(SESSION_MINUTES);
    const bandAt = p => grid.map(m => ({ x: m, y: endValue ? quantile(pool.map(d => dayFractionAt(d, m)), p) * endValue : null }));
    // Comparison line: the latest earlier session of the same day type
    const prevDay = complete.filter(d => d.date < (sessDate || '9999') && d.day_type === dayType).slice(-1)[0];
    const ds = [
      { label: '90th pct.', data: bandAt(0.9), borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: 'rgba(43, 92, 200, 0.14)', tension: 0 },
      { label: '10th pct.', data: bandAt(0.1), borderWidth: 0, pointRadius: 0, fill: false, tension: 0 },
    ];
    if (prevDay) ds.push({ label: `Last ${dayType.replace('_', '-')} day, ${fmtTradeDate(prevDay.date, true)}`, data: [{ x: 0, y: 0 }].concat(INTRADAY_CHECKPOINTS.map(([l, m]) => ({ x: m, y: prevDay.checkpoints[l].revenue }))),
      borderColor: RX.grey, borderWidth: 1.5, pointRadius: 0, tension: 0 });
    const proj = [{ x: latest.elapsed_minutes, y: latest.total_revenue }, { x: SESSION_MINUTES, y: endValue }];
    if (endValue != null) ds.push({ label: actualClose != null ? 'To the close' : 'Projection', data: proj, borderColor: RX.model, borderWidth: 2, borderDash: [2, 4], pointRadius: [0, 4], pointBackgroundColor: RX.model, tension: 0 });
    ds.push({ label: sessLong || 'Session', data: [{ x: 0, y: 0 }].concat(samples.map(s => ({ x: s.elapsed_minutes, y: s.total_revenue }))), borderColor: RX.ink, borderWidth: 2, pointRadius: 0, tension: 0 });
    rxChart('liveCum', `rxLiveCum-${ex}`, 300, {
      type: 'line',
      data: { datasets: ds },
      options: {
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: { tooltip: {
          filter: item => item.dataset.label !== '10th pct.' && item.dataset.label !== '90th pct.',
          callbacks: {
            title: items => sessionClock(items[0].parsed.x),
            label: c => ` ${c.dataset.label}: ${rxCr(c.parsed.y, 2)}`,
            footer: items => {
              const m = items[0].parsed.x;
              const lo = bandAt(0.1).find(p => p.x >= m), hi = bandAt(0.9).find(p => p.x >= m);
              return lo && hi && lo.y != null ? `Typical path at ${sessionClock(lo.x)}: ₹${fmtNum(lo.y, 1)}–${fmtNum(hi.y, 1)} Cr` : '';
            },
          },
        } },
        scales: {
          x: { type: 'linear', min: 0, max: SESSION_MINUTES, grid: { display: false },
            afterBuildTicks: axis => { axis.ticks = [0].concat(INTRADAY_CHECKPOINTS.map(c => c[1])).map(v => ({ value: v })); },
            ticks: { callback: v => sessionClock(v), maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    const typeName = (LIVE_DAY_TYPES.find(t => t[0] === state.type) || [])[1] || 'All days';
    qx('legCum').innerHTML = rxLegend([
      { label: sessLong || 'Session', color: RX.ink, kind: 'line' },
      { label: actualClose != null ? `To the actual close ${rxCr(actualClose, 2)}` : `Projection to ${rxCr(pred, 2)}`, color: RX.model, kind: 'dot' },
      { label: `${typeName} path, 10th–90th pct.`, color: 'rgba(43, 92, 200, 0.22)' },
    ].concat(prevDay ? [{ label: `Last ${dayType.replace('_', '-')} day, ${fmtTradeDate(prevDay.date, true)}`, color: RX.grey, kind: 'line' }] : []));
    qx('cumNote').textContent = `Band = the share of the close that ${pool.length} complete ${state.type === 'all' || pool.length !== countOf(state.type) ? 'archived' : typeName.toLowerCase()} sessions had reached by each time × ${actualClose != null ? 'the actual close' : 'the predicted close'}, so it shows where the session would sit if it closes there.`;
  }

  function renderWindows() {
    const pool = typeDays(state.type);
    const endValue = actualClose ?? pred;
    const last = latest.elapsed_minutes;
    let ahead = null;
    const rows = LIVE_WINDOWS.map(([label, a, b]) => {
      const typ = pool.length ? (quantile(pool.map(d => dayFractionAt(d, b) - dayFractionAt(d, a)), 0.5)) : null;
      const ra = revenueAt(samples, a) ?? (a === 0 ? 0 : null);
      const partial = last < b && last > a;
      const rb = partial ? latest.total_revenue : revenueAt(samples, b);
      const today = ra != null && rb != null ? rb - ra : null;
      const share = today != null && endValue ? today / endValue : null;
      const diff = share != null && typ != null && !partial ? share - typ : null;
      if (diff != null && Math.abs(diff) > 0.03 && ahead == null) ahead = { label, diff };
      return `<tr><td>${label}</td><td class="rx-l" style="width:34%"><div class="rx-meter" style="width:${typ != null ? (typ / 0.2 * 100).toFixed(1) : 0}%;max-width:100%"></div></td><td>${typ != null ? fmtPct(typ) : '—'}</td><td>${today != null ? fmtNum(today, 2) + (partial ? ` <span class="rx-foot">to ${sessionClock(last)}</span>` : '') : '—'}</td><td class="${diff == null ? '' : diff > 0.03 ? 'rx-up' : diff < -0.03 ? 'rx-dn' : ''}">${share != null ? fmtPct(share) : '—'}</td></tr>`;
    }).join('');
    qx('wins').innerHTML = `<thead><tr><th scope="col">Window</th><th scope="col" class="rx-l">Typical share of the close</th><th scope="col">Typical</th><th scope="col">${st.isToday ? 'Today' : fmtTradeDate(sessDate)}, ₹ Cr</th><th scope="col">% of ${actualClose != null ? 'close' : 'predicted close'}</th></tr></thead><tbody>${rows}</tbody>`;
    qx('winNote').textContent = ahead
      ? `${ahead.label} ran ${ahead.diff > 0 ? 'busier' : 'quieter'} than usual: ${Math.abs(ahead.diff * 100).toFixed(1)} points ${ahead.diff > 0 ? 'above' : 'below'} its typical share. Green / red marks windows more than 3 points off.`
      : 'Every finished window is within 3 points of its typical share so far.';
  }

  function renderPred() {
    // The first minutes' predictions extrapolate a handful of trades; leave them out
    const pts = samples.filter(s => s.predicted_eod != null && s.elapsed_minutes >= LIVE_PRED_SETTLE_MIN).map(s => ({ x: s.elapsed_minutes, y: s.predicted_eod }));
    const ds = [{ label: 'Predicted close', data: pts, borderColor: RX.model, borderWidth: 2, pointRadius: 0, tension: 0 }];
    if (actualClose != null) ds.push({ label: 'Actual close', data: [{ x: 0, y: actualClose }, { x: SESSION_MINUTES, y: actualClose }], borderColor: RX.ink, borderWidth: 1.5, borderDash: [5, 3], pointRadius: 0 });
    rxChart('livePred', `rxLivePred-${ex}`, 200, {
      type: 'line',
      data: { datasets: ds },
      options: {
        parsing: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        plugins: { tooltip: { callbacks: { title: items => sessionClock(items[0].parsed.x), label: c => ` ${c.dataset.label}: ${rxCr(c.parsed.y, 2)}` } } },
        scales: {
          x: { type: 'linear', min: 0, max: SESSION_MINUTES, grid: { display: false },
            afterBuildTicks: axis => { axis.ticks = [0, 105, 225, 345].map(v => ({ value: v })); },
            ticks: { callback: v => sessionClock(v), maxRotation: 0 } },
          y: { ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    rxFixHeight(charts.livePred);
    const early = pts.filter(p => p.x <= 60).map(p => p.y), late = pts.filter(p => p.x >= 180).map(p => p.y);
    const parts = [];
    if (early.length > 1) parts.push(`${sessionClock(LIVE_PRED_SETTLE_MIN)}–10:15: ₹${fmtNum(Math.min(...early), 1)}–${fmtNum(Math.max(...early), 1)} Cr.`);
    if (late.length > 1) parts.push(`From 12:15: ₹${fmtNum(Math.min(...late), 1)}–${fmtNum(Math.max(...late), 1)} Cr.`);
    if (actualClose != null) parts.push(`Dashed: actual close ${rxCr(actualClose, 2)}.`);
    qx('predNote').textContent = parts.join(' ') || 'Too few polls yet.';
  }

  function renderArchive() {
    const rows = complete.slice(-8).reverse().map(d => {
      const err = label => {
        const m = INTRADAY_CHECKPOINTS.find(c => c[0] === label)[1];
        const med = quantile(typeDays(d.day_type, d).map(o => dayFractionAt(o, m)), 0.5);
        const rev = d.checkpoints[label]?.revenue;
        return med && rev != null && d.eod_revenue ? (rev / med) / d.eod_revenue - 1 : null;
      };
      return { d, e12: err('12:00'), e14: err('14:00') };
    });
    const cell = e => e == null ? '<td>—</td>' : `<td class="${Math.abs(e) >= 0.05 ? 'rx-warn' : ''}">${rxSignedPct(e)}</td>`;
    const mae = k => { const v = rows.map(r => r[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + Math.abs(b), 0) / v.length : null; };
    qx('arch').innerHTML = rows.length
      ? `<thead><tr><th scope="col">Trade date</th><th scope="col" class="rx-l">Day</th><th scope="col" class="rx-l">Type</th><th scope="col">Close, ₹ Cr</th><th scope="col">Polls</th><th scope="col">Error at 12:00</th><th scope="col">Error at 14:00</th></tr></thead>
        <tbody>${rows.map(({ d, e12, e14 }) => `<tr><td>${rxDate(d.date)}</td><td class="rx-l">${(d.weekday_name || '').slice(0, 3)}</td><td class="rx-l">${rxChip(d.day_type.replace('_', '-'), d.day_type === 'normal' ? '' : 'warn')}</td><td>${fmtNum(d.eod_revenue, 2)}</td><td>${d.n_samples ?? '—'}</td>${cell(e12)}${cell(e14)}</tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">Mean absolute error, ${rows.length} sessions</td><td>${mae('e12') == null ? '—' : fmtPct(mae('e12'))}</td><td>${mae('e14') == null ? '—' : fmtPct(mae('e14'))}</td></tr></tfoot>`
      : '<tbody><tr><td class="rx-l">No complete archived sessions yet</td></tr></tbody>';
  }

  function renderAll() { renderKpis(); renderCum(); renderWindows(); renderPred(); renderArchive(); }
  rxOnSeg(el, 'type', t => { state.type = t; renderAll(); });
  renderAll();
  RX_TAB_REFRESH.intraday = () => { renderCum(); renderPred(); };
}

// The live tab refreshes itself while it is open during market hours
setInterval(() => {
  const tab = document.querySelector('.nav-item.active')?.dataset.tab;
  if (tab !== 'intraday' || document.hidden || !(currentExchange === 'nse' || currentExchange === 'bse')) return;
  const now = new Date(Date.now() + 330 * 60000);
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && mins >= 550 && mins <= 975) buildLivePredictor(currentExchange);
}, 5 * 60 * 1000);

// Shared KPI tile; styles live in style.css (.kpi-tile*).
function kpi(title, value, sub, sentiment) {
  const tone = sentiment === 'positive' ? ' kpi-tile-value--positive'
             : sentiment === 'negative' ? ' kpi-tile-value--negative'
             : '';
  return `<div class="chart-panel kpi-tile">
    <div class="kpi-tile-label">${title}</div>
    <div class="kpi-tile-value${tone}">${value}</div>
    <div class="kpi-tile-sub">${sub}</div>
  </div>`;
}

// ========================
// INIT
// ========================

async function init() {
  showLoading('nse');
  initExchangeSwitcher();
  initFeeToggle();
  updateHeaderExchange('nse');
  buildSidebarNav('nse');
  toggleExchangeContent('nse');
  if (GLANCE_MEDIA.matches && glancePref() !== 'full') enterGlance(false);
  if (GLANCE_MEDIA.addEventListener) GLANCE_MEDIA.addEventListener('change', m => { if (!m.matches) exitGlance(false); });
  setInterval(() => { if (glanceActive() && !document.hidden) renderGlance(); }, 5 * 60 * 1000);
  preloadMarketData().then(() => {
    if ((currentExchange === 'all' || currentExchange === 'nsebse') && shownExchange === currentExchange) rebuildAll();
  });
  // Loads NSE and opens its first tab; a failure shows the overlay's Retry
  await switchExchange('nse');
  updateLatestRevBanner();
  setInterval(updateLatestRevBanner, 5 * 60 * 1000);
}


// ========================
// SHARED REPORT HELPERS
// ========================

// Revenue files for the downloadable reports: the current fee mode, with the
// same fallback as the views. NSE/BSE are required, MCX optional.
async function fetchReportRevenue(ex, required) {
  const rev = await fetchRevenueFiles(ex);
  const val = r => (r.status === 'fulfilled' ? r.value.json : null);
  if (required && !val(rev.raw)) throw rev.raw.reason;
  if (required && !val(rev.enr)) throw rev.enr.reason;
  return { dash: val(rev.raw), enr: val(rev.enr), eff: rev.eff };
}

// Fee-basis / modelled flags of one exchange's rows, for the report tables
function reportFlagsFor(dash) {
  const daily = dash?.daily_all || [];
  return {
    q:       (label, sk) => periodFlags((dash?.quarterly || []).find(x => x.quarter === label), sk),
    m:       (label, sk) => periodFlags((dash?.monthly || []).find(x => x.month === label), sk),
    tail:    (from, to, sk) => rowsFlags(daily.slice(from, to), sk),
    weekday: (day, n, sk) => rowsFlags(daily.filter(r => r.day === day).slice(-n), sk),
  };
}

// Printed markers (tooltips do not print): the weekly report styles them with
// .pr-flag; the standalone mobile report needs inline styles.
function reportTags(f, inline) {
  if (!f) return '';
  const tag = (text, color, cls) => inline
    ? `<span style="display:inline-block;margin-left:3px;padding:0 3px;border:1px solid ${color};border-radius:3px;color:${color};font-size:9px;font-weight:700;line-height:1.3;vertical-align:1px">${text}</span>`
    : `<span class="pr-flag${cls}">${text}</span>`;
  return (f.slab || f.prov ? tag('est.', '#A56000', '') : '') + (f.modelled ? tag('modelled', '#6D28D9', ' pr-flag--modelled') : '');
}

// One line under a report's title: the fee basis of its NSE/BSE figures and
// what the markers mean.
function reportFeeLine(nseEff, bseEff, mcxDash) {
  const parts = [];
  const charged = [nseEff && 'NSE', bseEff && 'BSE'].filter(Boolean);
  const today = [!nseEff && 'NSE', !bseEff && 'BSE'].filter(Boolean);
  if (charged.length) parts.push(`${charged.join('/')} fees as charged: each trading day at the transaction fees then in force (fee register); est. = slab-era flat estimate or provisional calibrated BSE cash rate.`);
  if (today.length) parts.push(`${today.join('/')} fees at today's rates: every trading day at today's statutory transaction fees (fee register)${FEE_MODE === 'charged' ? ' — date-effective data not generated yet' : ''}.`);
  parts.push('MCX: source values.');
  const mh = mcxDash?.modelled_history;
  if (mh && mh.days > 0) parts.push(`modelled = MCX history ${fmtLongDate(mh.first_date)} – ${fmtLongDate(mh.last_date)}, excluded from comparisons (—).`);
  return parts.join(' ');
}

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

// Header REPORT / MOBILE buttons: while a report builds, show "Building…" in
// the label (hidden on phones, where the button is icon-only) and restore it after.
function setReportBtnBusy(btn, busy) {
  if (!btn) return;
  const label = btn.querySelector('.btn-label');
  if (label) {
    if (busy) { btn.dataset.label = label.textContent; label.textContent = 'Building…'; }
    else if (btn.dataset.label) label.textContent = btn.dataset.label;
  }
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

async function downloadWeeklyReport() {
  const btn = document.getElementById('btnDownloadReport');
  setReportBtnBusy(btn, true);

  try {
    // NSE/BSE in the current fee mode (as the views); MCX is source values
    const [nseRev, bseRev, mcxRev, bseShare, mcxShare, nseShare] = await Promise.all([
      fetchReportRevenue('nse', true),
      fetchReportRevenue('bse', true),
      fetchReportRevenue('mcx', false).catch(() => ({ dash: null, enr: null })),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/nse_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);
    const [nseEnrich, bseEnrich, mcxEnrich] = [nseRev.enr, bseRev.enr, mcxRev.enr];
    const [nseDash, bseDash, mcxDash] = [nseRev.dash, bseRev.dash, mcxRev.dash];

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
    // Markers, and "—" for a comparison with modelled MCX days on either side
    const tg = f => reportTags(f);
    const prChg = (val, ...flags) => anyModelled(...flags) ? '—' : prFmt(val);

    function buildTotalRevenueTable(enriched, F) {
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
      const f5 = F.tail(-5, undefined, 'total'), fp5 = F.tail(-10, -5, 'total');
      const f20 = F.tail(-20, undefined, 'total'), f45 = F.tail(-45, undefined, 'total');
      const fmc = F.m(mc.label, 'total'), fmp = F.m(mp.label, 'total'), fm6 = F.tail(-125, undefined, 'total');
      const fqc = F.q(qc.label, 'total'), fqp = F.q(qp.label, 'total'), fq2 = F.q(q2.label, 'total');
      return `<div class="pr-sub-header">Total Revenue (Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Metric</th><th>₹ Cr</th><th>% Change</th></tr></thead>
        <tbody>
          <tr class="pr-group-label"><td colspan="3">Weekly</td></tr>
          <tr><td>L5 – This Week</td><td>${n(wl5.value)}${tg(f5)}</td><td>${prChg(wl5.wow, f5, fp5)}</td></tr>
          <tr><td>Prev5 – Last Week</td><td>${n(wp5.value)}${tg(fp5)}</td><td>—</td></tr>
          <tr><td>L20 – 20-Day Avg</td><td>${n(w20r.value)}${tg(f20)}</td><td>—</td></tr>
          <tr><td>L45 – 45-Day Avg</td><td>${n(w50.value)}${tg(f45)}</td><td>${prChg(wl5.wo10w, f45)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Monthly</td></tr>
          <tr><td>${mc.label || 'Current Month'}</td><td>${n(mc.value)}${tg(fmc)}</td><td>${prChg(mc.mom, fmc, fmp)}</td></tr>
          <tr><td>${mp.label || 'Prev Month'}</td><td>${n(mp.value)}${tg(fmp)}</td><td>—</td></tr>
          <tr><td>${AVG_6M_LABEL}</td><td>${n(m6.value)}${tg(fm6)}</td><td>${prChg(mc.mo6m, fmc, fm6)}</td></tr>
          <tr class="pr-separator"><td colspan="3"></td></tr>
          <tr class="pr-group-label"><td colspan="3">Quarterly</td></tr>
          <tr><td>${qc.label || 'Current Q'}</td><td>${n(qc.value)}${tg(fqc)}</td><td>${prChg(qc.qoq, fqc, fqp)}</td></tr>
          <tr><td>${qp.label || 'Prev Q'}</td><td>${n(qp.value)}${tg(fqp)}</td><td>—</td></tr>
          <tr><td>${q2.label || 'YoY Q'}</td><td>${n(q2.value)}${tg(fq2)}</td><td>${prChg(qc.yoy, fqc, fq2)}</td></tr>
        </tbody>
      </table>`;
    }

    function buildDowTable(enriched, F) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
      const rows = dayNames.map(day => {
        const dd = dow[day] || {};
        const f1 = F.weekday(day, 1, 'total'), f3 = F.weekday(day, 3, 'total'), f10 = F.weekday(day, 10, 'total');
        return `<tr><td>${day}</td><td>${n(dd.latest)}${tg(f1)}</td><td>${n(dd.avg_3d)}${tg(f3)}</td><td>${prChg(dd.do3d, f3)}</td><td>${n(dd.avg_10d)}${tg(f10)}</td><td>${prChg(dd.do10d, f10)}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Day-of-Week Performance</div>
      <table class="pr-table">
        <thead><tr><th>Day</th><th>This Week (₹ Cr)</th><th>L3 Avg</th><th>Do3D</th><th>L10 Avg</th><th>Do10D</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    }

    function buildSegmentTable(enriched, F) {
      const segs = [
        { label: 'Options', data: enriched.seg_options, sk: 'options' },
        { label: 'Futures', data: enriched.seg_futures, sk: 'futures' },
        { label: 'Cash',    data: enriched.seg_cash,    sk: 'cash' },
      ];
      const rows = segs.map(seg => {
        const l5 = ((seg.data || {}).weekly || {}).last5 || {};
        const f5 = F.tail(-5, undefined, seg.sk);
        return `<tr><td>${seg.label}</td><td>${n(l5.value)}${tg(f5)}</td><td>${prChg(l5.wow, f5, F.tail(-10, -5, seg.sk))}</td><td>${prChg(l5.wo10w, F.tail(-45, undefined, seg.sk))}</td></tr>`;
      }).join('');
      return `<div class="pr-sub-header">Segment Revenue (L5 Daily Avg, ₹ Cr)</div>
      <table class="pr-table">
        <thead><tr><th>Segment</th><th>L5 Avg</th><th>WoW</th><th>vs 45D</th></tr></thead>
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
          return rec ? { monthKey, expiryDate, fy_month: rec.fy_month, fy_quarter: rec.fy_quarter, value: rec.total_rev || 0, flags: periodFlags(rec, 'total') } : null;
        })
        .filter(Boolean);
      if (!monthExpiries.length) return '';

      const monthly = monthExpiries.slice(-6);
      const monthlyRows = monthly.map((e, i) => {
        const prev = i > 0 ? monthly[i - 1] : null;
        const mom = prev && prev.value ? (e.value - prev.value) / prev.value : null;
        return `<tr><td>${e.fy_month}</td><td>${n(e.value)}${tg(e.flags)}</td><td>${prFmt(mom)}</td></tr>`;
      }).join('');

      const byQuarter = new Map(), flagsByQuarter = new Map();
      monthExpiries.forEach(e => {
        if (!byQuarter.has(e.fy_quarter)) { byQuarter.set(e.fy_quarter, []); flagsByQuarter.set(e.fy_quarter, []); }
        byQuarter.get(e.fy_quarter).push(e.value);
        flagsByQuarter.get(e.fy_quarter).push(e.flags);
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
        return `<tr><td>${q}</td><td>${n(cur)}${tg(mergeFlags(flagsByQuarter.get(q) || []))}</td><td>${prFmt(qoq)}</td><td>${prFmt(yoy)}</td></tr>`;
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
        const otherRecs = dates
          .filter(d => d !== me.expiryDate)
          .map(d => byDate.get(d))
          .filter(Boolean);
        const otherVals = otherRecs.map(r => r.total_rev || 0);
        if (!otherVals.length) return;
        const avgWeekly = otherVals.reduce((s, v) => s + v, 0) / otherVals.length;
        const diff = avgWeekly ? (me.value - avgWeekly) / avgWeekly : null;
        wvmRows.push({ monthKey: mk, fy_month: me.fy_month, avgWeekly, monthEnd: me.value, diff,
          weeklyFlags: rowsFlags(otherRecs, 'total'), monthEndFlags: me.flags });
      });
      wvmRows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
      const wvmRecent = wvmRows.slice(-12);
      const wvmRowsHTML = wvmRecent.map(r =>
        `<tr><td>${r.fy_month}</td><td>${n(r.avgWeekly)}${tg(r.weeklyFlags)}</td><td>${n(r.monthEnd)}${tg(r.monthEndFlags)}</td><td>${prFmt(r.diff)}</td></tr>`
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
        return `<tr style="font-weight:700"><td>Last ${nMonths} Months Avg</td><td>${n(avgWeekly)}${tg(mergeFlags(w.map(r => r.weeklyFlags)))}</td><td>${n(avgMonthEnd)}${tg(mergeFlags(w.map(r => r.monthEndFlags)))}</td><td>${prFmt(diff)}</td></tr>`;
      }).join('');

      const expiryWeekday = monthEndExpiryWeekdayLabel(exchange, dailyAll);
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

    // flagDash: the exchange's dashboard file, for the fee-basis / modelled markers
    function buildExchangeSection(label, enriched, includeSegments, dashData, exchangeKey, flagDash) {
      const F = reportFlagsFor(flagDash || dashData);
      return `<div class="pr-section">
        <div class="pr-section-header">${label}</div>
        <div class="pr-section-body">
          ${buildTotalRevenueTable(enriched, F)}
          ${buildDowTable(enriched, F)}
          ${includeSegments ? buildSegmentTable(enriched, F) : ''}
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
      <p class="pr-fee-line">${reportFeeLine(nseRev.eff, bseRev.eff, mcxDash)}</p>
      ${buildExchangeSection('NSE Update', nseEnrich, true, nseDash, 'nse')}
      ${buildNSEShareSection(nseShare)}
      ${buildExchangeSection('BSE Update', bseEnrich, false, bseDash, 'bse')}
      ${buildRegressionSection(bseShare, 'BSE')}
      ${buildMarketShareSection()}
      ${mcxEnrich ? buildExchangeSection('MCX Update', mcxEnrich, true, null, null, mcxDash) : ''}
      ${buildRegressionSection(mcxShare, 'MCX')}
      <div class="pr-footer">NSE/BSE/MCX Analytics Dashboard — Auto-generated report</div>
    </div>`;

    const el = document.getElementById('print-report');
    el.innerHTML = html;
    el.style.display = 'block';
    setTimeout(() => { window.print(); el.style.display = 'none'; }, 150);
  } finally {
    setReportBtnBusy(btn, false);
  }
}

// ========================
// MOBILE REPORT DOWNLOAD
// ========================

async function downloadMobileReport() {
  const btn = document.getElementById('btnMobileReport');
  setReportBtnBusy(btn, true);

  try {
    // NSE/BSE in the current fee mode (as the views); MCX is source values
    const [nseRev, bseRev, mcxRev, bseShare, mcxShare] = await Promise.all([
      fetchReportRevenue('nse', true),
      fetchReportRevenue('bse', true),
      fetchReportRevenue('mcx', false).catch(() => ({ dash: null, enr: null })),
      fetch('./data/bse_share_analysis.json').then(r => r.json()).catch(() => null),
      fetch('./data/mcx_share_analysis.json').then(r => r.json()).catch(() => null),
    ]);
    const [nseEnrich, bseEnrich, mcxEnrich] = [nseRev.enr, bseRev.enr, mcxRev.enr];
    const [nseDash, bseDash, mcxDash] = [nseRev.dash, bseRev.dash, mcxRev.dash];

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

    // Markers, and "—" for a comparison with modelled MCX days on either side
    const tg = f => reportTags(f, true);
    const badgeOrNA = (val, ...flags) => pctBadge(anyModelled(...flags) ? null : val);

    // ── KPI card for weekly/quarterly headline ──
    // flags: the figure's fee-basis / modelled flags; cmpNA: its comparison is
    // against modelled MCX days, so "—" replaces the % change
    function kpiCard(label, value, change, changeLabel, flags, cmpNA) {
      const chgStr = cmpNA
        ? `<div style="margin-top:4px">${pctBadge(null)} <span style="font-size:10px;color:#9ca3af">${changeLabel || ''}</span></div>`
        : change != null ? `<div style="margin-top:4px">${pctBadge(change)} <span style="font-size:10px;color:#9ca3af">${changeLabel || ''}</span></div>` : '';
      return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;flex:1;min-width:130px">
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}${tg(flags)}</div>
        <div style="font-size:20px;font-weight:700;color:#111;letter-spacing:-.02em">₹${n(value)}<span style="font-size:11px;font-weight:400;color:#6b7280"> Cr</span></div>
        ${chgStr}
      </div>`;
    }

    // ── DoW table rows ──
    function dowRows(enriched, F) {
      const dow = (enriched.summary_total || {}).day_of_week || {};
      const days = ['Monday','Tuesday','Wednesday','Thursday','Friday'];
      return days.map(d => {
        const dd = dow[d] || {};
        const f3 = F.weekday(d, 3, 'total');
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;font-weight:600;color:#374151">${d.slice(0,3)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(dd.latest)}${tg(F.weekday(d, 1, 'total'))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(dd.do3d, f3)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right;color:#6b7280">${n(dd.avg_10d)}${tg(F.weekday(d, 10, 'total'))}</td>
        </tr>`;
      }).join('');
    }

    // dash: the exchange's dashboard file, for the fee-basis / modelled markers
    function exchangeSection(name, color, enriched, dash) {
      const F = reportFlagsFor(dash);
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
        { label: 'Options', d: enriched.seg_options, sk: 'options' },
        { label: 'Futures', d: enriched.seg_futures, sk: 'futures' },
        { label: 'Cash',    d: enriched.seg_cash,    sk: 'cash' },
      ];
      const segRows = segs.map(sg => {
        const l5 = sg.d?.weekly?.last5 || {};
        const f5 = F.tail(-5, undefined, sg.sk);
        return `<tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;color:#374151">${sg.label}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">₹${n(l5.value)}${tg(f5)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(l5.wow, f5, F.tail(-10, -5, sg.sk))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f3f4f6;text-align:right">${badgeOrNA(l5.wo10w, F.tail(-45, undefined, sg.sk))}</td>
        </tr>`;
      }).join('');
      const f5 = F.tail(-5, undefined, 'total'), fp5 = F.tail(-10, -5, 'total');
      const f20 = F.tail(-20, undefined, 'total'), f45 = F.tail(-45, undefined, 'total');
      const fqc = F.q(qc.label, 'total'), fqp = F.q(qp.label, 'total'), fq2 = F.q(s.quarterly?.prev2?.label, 'total');
      const fmc = F.m(mc.label, 'total'), fmp = F.m(s.monthly?.previous?.label, 'total');

      return `
      <div style="margin-bottom:20px">
        <div style="background:${color};color:#fff;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:10px 16px;border-radius:10px 10px 0 0">${name}</div>
        <div style="background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 10px 10px;padding:14px 14px 6px">

          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard('This Week (L5)', wl5.value, wl5.wow, 'WoW', f5, anyModelled(f5, fp5))}
            ${kpiCard('Last Week (P5)', wp5.value, null, '', fp5)}
            ${kpiCard('20-Day Avg', w20.value, null, '', f20)}
            ${kpiCard('45-Day Avg', w45.value, wl5.wo10w, 'Wo45', f45, anyModelled(f45))}
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px">
            ${kpiCard(qc.label || 'Current Q', qc.value, qc.qoq, 'QoQ', fqc, anyModelled(fqc, fqp))}
            ${kpiCard(qp.label || 'Prev Q', qp.value, null, '', fqp)}
            ${kpiCard(s.quarterly?.prev2?.label || 'Year-ago Q', s.quarterly?.prev2?.value, qc.yoy, 'YoY (current Q)', fq2, anyModelled(fqc, fq2))}
            ${kpiCard(mc.label || 'Current Month', mc.value, mc.mom, 'MoM', fmc, anyModelled(fmc, fmp))}
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
              <tbody>${dowRows(enriched, F)}</tbody>
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
      ${exchangeSection('NSE Update', '#1d4ed8', nseEnrich, nseDash)}
      ${exchangeSection('BSE Update', '#0f766e', bseEnrich, bseDash)}
      ${regressionSection(bseShare, 'BSE', '#0f766e')}
      ${marketShareSection()}
      ${mcxEnrich ? exchangeSection('MCX Update', '#7c3aed', mcxEnrich, mcxDash) : ''}
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
  <div style="font-size:10.5px;color:#d1fae5;margin-top:6px;line-height:1.4">${reportFeeLine(nseRev.eff, bseRev.eff, mcxDash)}</div>
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
    setReportBtnBusy(btn, false);
  }
}

init();
