// dashboard/js/30-brokers.js — Brokers view: stockbroker ADR (Angel One, Groww, Motilal Oswal), read
// through /api/brokers from the brokers-dashboard engine's published runs.
// The engine computes every figure; this file only lays out what it published
// (sb_summary_cells, sb_daily_revenue, sb_calibration) and computes nothing.
// Each broker is one view in the Brokers pill (registerBrokerView, BROKERS MODE
// in 00-core.js; docs/BROKERS_INTEGRATION.md), registered at the end of this file.

// The broker views: pill id, sb_brokers.broker_id, label, and whether it has a PAT
// Predictor tab
const BRK_VIEWS = [
  { view: 'angel', broker: 'ANGELONE', label: 'Angel One', pat: true },
  { view: 'groww', broker: 'GROWW', label: 'Groww', pat: true },
  { view: 'mosl', broker: 'MOSL', label: 'Motilal Oswal', pat: false },
];
// The broker on show: set by its view's load()
let BRK_BROKER = { id: 'ANGELONE', name: 'Angel One', view: 'angel' };

// Panels in the order of the workbook's Summary sheet (two per row), then the
// engine's extra MTF (net) panel
const BRK_PANEL_ORDER = ['Consolidated', 'Broking', 'MTF', 'F&O', 'Cash', 'Commodities', 'MTF (net)'];
const BRK_PANEL_TITLES = { 'Consolidated': 'Consolidated ADR', 'MTF': 'MTF (gross)' };
// Panels that add several segments (their data ends with the earliest-ending one)
const BRK_COMBINED_PANELS = new Set(['Consolidated', 'Broking']);
const BRK_SEGMENT_LABELS = { fo: 'F&O', cash: 'Cash', comm: 'Commodities', mtf_gross: 'MTF', mtf_nii: 'MTF', mtf_net: 'MTF (net)' };

// Brokers whose figures measure something other than Angel One's and Groww's gross
// brokerage: a note on every tab, panel titles that say so, and per-panel notes
const BRK_BROKER_BASIS = {
  MOSL: {
    note: 'Net brokerage: Motilal Oswal\'s retail + PWM net brokerage on cash, F&O and commodities, excluding institutional broking and currency (currency is about 0.3 % of net brokerage from FY 2025, and 3.5–8 % in FY 2024). Angel One\'s and Groww\'s figures are gross, so compare them with care.',
    titles: { 'Broking': 'Broking · net brokerage (retail + PWM)', 'Consolidated': 'Consolidated ADR · net brokerage + MTF NII',
      'MTF': 'MTF · net interest income' },
    panels: { 'MTF': 'Assumption: MTF net interest income uses a typed yield of 12.94 %. Motilal Oswal does not publish its MTF yield.' },
  },
};

// Comparison columns of each Summary table: [stored comparison name, column header, tooltip]
const BRK_TABLES = {
  FY: { table: 'Financial Year', head: 'Financial Year', val: 'Total', comps: [['YoY', 'YoY', 'vs the previous financial year']] },
  Q:  { table: 'Quarter', head: 'Quarter>>', val: 'Val (In Cr)', comps: [['QoQ', 'QoQ', 'vs the previous quarter'], ['YoY', 'YoY', 'vs the same quarter last year']] },
  M:  { table: 'Month', head: 'Month>>', val: 'Val (In Cr)', comps: [['MoM', 'MoM', 'vs the previous month'], ['Mo 6M', 'vs 6M', 'vs the average of the last 6 months']] },
  W:  { table: 'Week', head: 'Week>>', val: 'Val (In Cr)', comps: [['WoW', 'WoW', 'Last 5 trading days vs the 5 before'], ['vs last 45 days', 'vs 45D', 'Last 5 trading days vs the last 45']] },
  D:  { table: 'Weekday', head: 'Week>>', val: 'Val (In Cr)', comps: [['vs avg of last 3', 'Do 3D', 'vs the average of the last 3 such weekdays'], ['vs avg of last 10', 'Do 10D', 'vs the average of the last 10 such weekdays']] },
};
const BRK_WEEK_ORDER = [/^Last 5 /i, /^Previous 5 /i, /^Last 45 /i, /^Last 20 /i];
const BRK_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const BRK_FY_MONTHS = ['April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'January', 'February', 'March'];

const BRK_TAG_TITLES = {
  actual: () => `Actual: every day behind this figure is in a period ${BRK_BROKER.name} has reported (calibrated to its disclosures)`,
  estimate: () => 'Estimate: includes days after the last reported period, projected from exchange data',
};

// Daily ADR chart segments (Consolidated = F&O + Cash + Commodities + MTF). A broker
// publishes one of the MTF segments: gross revenue, or net interest income (MOSL).
const BRK_DAILY_SEGMENTS = [
  { key: 'fo', label: 'F&O' }, { key: 'cash', label: 'Cash' },
  { key: 'comm', label: 'Commodities' }, { key: 'mtf_gross', label: 'MTF (gross)' }, { key: 'mtf_nii', label: 'MTF (NII)' },
];
const BRK_CALIB_SEGMENTS = { fo: 'F&O', cash: 'Cash', comm: 'Commodities', mtf: 'MTF' };

// The views show each broker's latest live run (sb_runs mode 'live')
let BRK = { mode: 'live', brokers: null, summary: null, daily: null, calib: null, sel: {}, range: 120 };

// The PAT Predictor's inputs as the reader edited them, per broker id: { run, inp, edited, targets
// { bear, base, bull } (FY 2028 target price today), desc }. Set by js/33-brokers-pat.js while an input
// differs from the published default, read by the Valuation tab's ADR method (js/34). Memory only.
const BRK_PAT_LIVE = {};

// Never add query parameters beyond these: /api/* is cached at Vercel's edge
function brkFetch(view, mode, broker = BRK_BROKER.id) {
  return fetchDataFile(`/api/brokers?broker=${broker}&mode=${mode}&view=${view}`).then(r => r.json);
}

// The section of a tab of the broker on show (created by the shell)
function brkSection(tab) { return brokerSection(BRK_BROKER.view, tab); }

// A view's load(): the broker list once (to check the broker is active in
// sb_brokers), then the Summary of its latest live run; daily and
// calibration load when their tab is shown. A broker without a published run
// comes back with summary.run === null. Nothing changes once owns() is false.
async function brkLoad(def, mode, owns = () => true) {
  const brokers = BRK.brokers || (await brkFetch('brokers', mode, def.broker)).brokers;
  const b = brokers.find(x => x.broker_id === def.broker);
  if (!b) throw new Error(`${def.label} is not an active broker in sb_brokers`);
  const summary = await brkFetch('summary', mode, def.broker);
  if (!owns()) return;
  BRK_BROKER = { id: def.broker, name: b.label, view: def.view };
  BRK = { ...BRK, brokers, mode, summary, daily: null, calib: null, prices: null, sel: summary.run ? {
    FY: brkDefaultKey(summary, 'FY'), Q: brkDefaultKey(summary, 'Q'), M: brkDefaultKey(summary, 'M') } : {} };
}

// A period still open at the run's as-of date with fewer trading days than this is not
// shown first: the Summary opens on the period before it (the selector still offers it)
const BRK_MIN_OPEN_DAYS = 5;

// The period a Summary table opens on: the latest, unless that one is still open with
// fewer than BRK_MIN_OPEN_DAYS trading days (e.g. a month one day old)
function brkDefaultKey(summary, type) {
  const keys = summary.periods[type] || [], open = summary.open?.[type];
  if (open && keys[0] === open.key && open.days < BRK_MIN_OPEN_DAYS && keys.length > 1) return keys[1];
  return keys[0];
}

// " (1 day)" after a period still open at the as-of date; '' otherwise
function brkOpenSuffix(type, key) {
  const open = BRK.summary.open?.[type];
  return open && open.key === key ? ` (${open.days} day${open.days === 1 ? '' : 's'})` : '';
}

// The note on a period still open at the as-of date: how many trading days its figures cover
function brkOpenNote(type, key) {
  const open = BRK.summary.open?.[type];
  if (!open || open.key !== key || !open.through) return null;
  return `${key} is still open: this run is as of ${fmtLongDate(open.through)}, ${open.days} trading day${open.days === 1 ? '' : 's'} `
    + 'into it. Its figures are averages over the days published so far; the periods it is compared with are complete.';
}

// The tab of the broker view on show ('summary', 'daily', …), from the sidebar
function brkActiveTab() {
  const id = document.querySelector('.nav-item.active')?.dataset.tab || '';
  const prefix = brokerTabId(BRK_BROKER.view, '');
  return id.startsWith(prefix) ? id.slice(prefix.length) : 'summary';
}

// A view's build(): the Summary now; the other tabs build when shown (brkShow)
function brkBuild() {
  buildBrokersSummary();
  ['daily', 'calib', 'price', 'fo', 'pat', 'val'].forEach(t => { const el = brkSection(t); if (el) el.innerHTML = ''; });
}

// A view's onShow(tab)
function brkShow(tab) {
  if (tab === 'daily') buildBrokersDaily();
  else if (tab === 'calib') buildBrokersCalibration();
  else if (tab === 'price') buildBrokersPrice();   // js/31-brokers-price.js
  else if (tab === 'fo') buildBrokersFo();         // js/32-brokers-fo-drivers.js
  else if (tab === 'pat') buildBrokersPat();       // js/33-brokers-pat.js
  else if (tab === 'val') buildBrokersValuation(); // js/34-brokers-valuation.js
}

// A view's meta(): header quarter and "Last Updated"
function brkMeta() {
  const run = BRK.summary?.run;
  const mtf = BRK.summary.through?.MTF;
  return run ? { quarter: BRK.summary.periods.Q[0] || '—', updated: fmtLongDate(run.as_of_date),
    updatedTitle: `As of the published ${run.mode} run ${run.run_id.slice(0, 8)}, ${run.started_at}${mtf ? `; MTF through ${fmtLongDate(mtf.through)}` : ''}` }
    : { quarter: '—', updated: `no ${BRK.mode} run yet`, updatedTitle: BRK.summary?.reason || '' };
}

// Shown on every tab of a broker with no published run yet
function brkNoRunHTML() {
  const name = escHtml(BRK_BROKER.name);
  return `<div class="chart-panel brk-norun" role="status">
    <b>No ${BRK.mode} run published for ${name} yet.</b>
    <p>${name}'s ADR appears here once the brokers-dashboard engine publishes a ${BRK.mode} run for it
    (<code>sb_runs</code>, broker <code>${escHtml(BRK_BROKER.id)}</code>). Nothing is estimated on this page in the meantime.</p>
  </div>`;
}

// ── Period labels ────────────────────────────────────────────────────────────
// Chronological order of the engine's labels ("FY 2027", "Q2 FY 2027", "FY 2027 September"); null otherwise
function brkPeriodOrder(label) {
  let m;
  if ((m = /^Q([1-4]) FY (\d{4})$/.exec(label))) return +m[2] * 100 + (+m[1] - 1) * 3;
  if ((m = /^FY (\d{4}) ([A-Z][a-z]+)$/.exec(label)) && BRK_FY_MONTHS.includes(m[2])) return +m[1] * 100 + BRK_FY_MONTHS.indexOf(m[2]);
  if ((m = /^FY (\d{4})$/.exec(label))) return +m[1] * 100;
  return null;
}

// ── Cell formatting (workbook formats: values #,##0.00, changes 0.0%) ─────────
function brkVal(v) {
  return v == null || isNaN(v) ? '<span class="xl-num">—</span>'
    : `<span class="xl-num">${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
}

function brkChgClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu'; }
function brkPct(v) { return `${(v * 100).toFixed(1)}%`; }

function brkTag(regime) {
  if (!regime) return '';
  return regime === 'estimate'
    ? `<span class="brk-tag brk-tag--est" title="${escHtml(BRK_TAG_TITLES.estimate())}">E</span>`
    : `<span class="brk-tag brk-tag--act" title="${escHtml(BRK_TAG_TITLES.actual())}">A</span>`;
}

// Groups a table's cells into rows: "Q2 FY 2027" and "Q2 FY 2027 | YoY" are one
// row with two comparison columns. Notes are numbered per panel.
function brkRows(cells, notes) {
  const rows = new Map();
  cells.forEach(c => {
    const label = c.row_label.split(' | ')[0];
    const row = rows.get(label) || { label, value: null, regime: null, comps: {}, notes: [] };
    if (c.value != null) { row.value = c.value; row.regime = row.regime === 'estimate' ? 'estimate' : c.regime; }
    if (c.comparison) row.comps[c.comparison] = c.comp_value;
    if (c.note) {
      let n = notes.indexOf(c.note);
      if (n < 0) n = notes.push(c.note) - 1;
      if (!row.notes.includes(n)) row.notes.push(n);
    }
    rows.set(label, row);
  });
  return [...rows.values()];
}

function brkNoteRefs(row, notes) {
  return row.notes.map(n => `<span class="brk-note-ref" title="${escHtml(notes[n])}">${n + 1}</span>`).join('');
}

function brkValueCell(row, notes) {
  return `${brkVal(row.value)}${brkTag(row.regime)}${brkNoteRefs(row, notes)}`;
}

function brkCompXL(row, comp) {
  if (!(comp in row.comps)) return '<td></td>';
  const v = row.comps[comp];
  if (v == null) return '<td><span class="xl-chg xl-neu">—</span></td>';
  return `<td><span class="xl-chg xl-${brkChgClass(v)}">${brkPct(v)}</span></td>`;
}

function brkCompWire(row, comp) {
  if (!(comp in row.comps)) return '<td></td>';
  const v = row.comps[comp];
  if (v == null) return '<td class="wire-delta neutral">—</td>';
  const cls = { pos: 'positive', neg: 'negative', neu: 'neutral' }[brkChgClass(v)];
  return `<td class="wire-delta ${cls}">${brkPct(v)}</td>`;
}

// ── Summary ──────────────────────────────────────────────────────────────────
function brkPanelKeys(panel, type) {
  const keys = new Set(BRK.summary.cells.filter(c => c.panel === panel && c.period_type === type).map(c => c.period_key));
  return BRK.summary.periods[type].filter(k => keys.has(k));
}

// The period a panel shows: the selected one, or the panel's latest when it
// has none for the selection (a panel's data can end earlier than the others')
function brkPanelKey(panel, type) {
  const keys = brkPanelKeys(panel, type);
  return keys.includes(BRK.sel[type]) ? BRK.sel[type] : keys[0];
}

function brkPeriodSection(panel, type, notes) {
  const spec = BRK_TABLES[type];
  const key = brkPanelKey(panel, type);
  const header = `<tr class="xl-col-hdr"><td>${spec.head}</td><td>${spec.val}</td>${spec.comps.map(c => `<td title="${c[2]}">${c[1]}</td>`).join('')}${spec.comps.length < 2 ? '<td></td>' : ''}</tr>`;
  if (!key) return `<tbody class="xl-sec">${header}<tr><td colspan="4" class="brk-empty">Not published for this run</td></tr></tbody>`;
  const cells = BRK.summary.cells.filter(c => c.panel === panel && c.period_type === type && c.period_key === key && c.table_name === spec.table);
  const rows = brkRows(cells, notes).sort((a, b) => {
    if (a.label === key) return -1;
    if (b.label === key) return 1;
    const oa = brkPeriodOrder(a.label), ob = brkPeriodOrder(b.label);
    return (ob ?? -1) - (oa ?? -1);
  });
  const openNote = brkOpenNote(type, key), cur = rows.find(r => r.label === key);
  if (openNote && cur) {
    let n = notes.indexOf(openNote);
    if (n < 0) n = notes.push(openNote) - 1;
    if (!cur.notes.includes(n)) cur.notes.push(n);
  }
  // The day count goes on an open period in the list only: once selected, its note says it (the select is too narrow)
  const opts = brkPanelKeys(panel, type).map(k => `<option value="${escHtml(k)}"${k === key ? ' selected' : ''}>${escHtml(k === key ? k : k + brkOpenSuffix(type, k))}</option>`).join('');
  const body = rows.map(r => {
    const cur = r.label === key;
    const label = cur ? `<select class="xl-row-sel brk-sel" data-type="${type}" aria-label="${spec.table}">${opts}</select>`
      : `<span${brkPeriodOrder(r.label) == null ? ' style="color:var(--color-text-secondary)"' : ''}>${escHtml(r.label)}</span>`;
    return `<tr${cur ? ' class="xl-r-cur"' : ''}><td>${label}</td><td>${brkValueCell(r, notes)}</td>${spec.comps.map(c => brkCompXL(r, c[0])).join('')}${spec.comps.length < 2 ? '<td></td>' : ''}</tr>`;
  }).join('');
  return `<tbody class="xl-sec">${header}${body}</tbody>`;
}

function brkWeekSection(panel, notes) {
  const spec = BRK_TABLES.W;
  const cells = BRK.summary.cells.filter(c => c.panel === panel && c.period_type === 'asof' && c.table_name === spec.table);
  const rank = r => { const i = BRK_WEEK_ORDER.findIndex(re => re.test(r.label)); return i < 0 ? 99 : i; };
  const rows = brkRows(cells, notes).sort((a, b) => rank(a) - rank(b));
  const header = `<tr class="xl-col-hdr"><td>${spec.head}</td><td>${spec.val}</td>${spec.comps.map(c => `<td title="${c[2]}">${c[1]}</td>`).join('')}</tr>`;
  const body = rows.map((r, i) => `<tr${i === 0 ? ' class="xl-r-cur"' : ''}><td>${escHtml(r.label)}</td><td>${brkValueCell(r, notes)}</td>${spec.comps.map(c => brkCompXL(r, c[0])).join('')}</tr>`).join('');
  return `<tbody class="xl-sec">${header}${body}</tbody>`;
}

function brkWeekdayTable(panel, notes) {
  const spec = BRK_TABLES.D;
  const rows = brkRows(BRK.summary.cells.filter(c => c.panel === panel && c.period_type === 'asof' && c.table_name === spec.table), notes);
  const find = label => rows.find(r => r.label.toLowerCase() === label.toLowerCase());
  const body = BRK_WEEKDAYS.map(d => {
    const day = find(d);
    if (!day) return '';
    const detail = n => {
      const r = find(`Average of last ${n} ${d}s`);
      return r ? `<tr class="wire-detail"><td>${escHtml(r.label)}</td><td class="wire-value">${brkValueCell(r, notes)}</td><td></td><td></td></tr>` : '';
    };
    return `<tr class="wire-day-main"><td>${d}</td><td class="wire-value">${brkValueCell(day, notes)}</td>${spec.comps.map(c => brkCompWire(day, c[0])).join('')}</tr>${detail(3)}${detail(10)}`;
  }).filter(Boolean).join('<tr class="wire-day-spacer"><td colspan="4"></td></tr>');
  return `<div class="wire-table-scroll"><table class="wire-table weekday-wire-table">
    <colgroup><col><col><col><col></colgroup>
    <thead><tr><th>${spec.head}</th><th>${spec.val}</th>${spec.comps.map(c => `<th title="${c[2]}">${c[1]}</th>`).join('')}</tr></thead>
    <tbody>${body}</tbody></table></div>`;
}

function brkPanelHTML(panel) {
  const notes = [];
  const period = `<table class="xl-period-table">
      <colgroup><col class="xl-col-period"><col class="xl-col-val"><col class="xl-col-chg1"><col class="xl-col-chg2"></colgroup>
      ${brkPeriodSection(panel, 'FY', notes)}${brkPeriodSection(panel, 'Q', notes)}${brkPeriodSection(panel, 'M', notes)}${brkWeekSection(panel, notes)}
    </table>`;
  const weekday = brkWeekdayTable(panel, notes);
  const noteList = notes.length ? `<ol class="brk-notes">${notes.map(n => `<li>${escHtml(n)}</li>`).join('')}</ol>` : '';
  const basis = BRK_BROKER_BASIS[BRK_BROKER.id];
  const title = basis?.titles[panel] || BRK_PANEL_TITLES[panel] || panel;
  const lag = brkLag(panel);
  const lagWhen = lag && `${fmtLongDate(lag.through)}, ${brkBehind(lag)} before the run's as-of date, ${fmtLongDate(BRK.summary.run.as_of_date)}`;
  const combined = lag && BRK_COMBINED_PANELS.has(panel);
  const lagSeg = combined ? BRK_SEGMENT_LABELS[lag.segment] || lag.segment || 'Data' : 'Data';
  const lagTip = lag && (combined
    ? `Its ${lagSeg} data ends on ${lagWhen}. Its figures add those days to later days of its other segments.`
    : `This panel's data ends on ${lagWhen}.`);
  return `<div class="xl-segment brk-panel" data-panel="${escHtml(panel)}">
    <div class="xl-seg-header">${escHtml(title)} <span class="xl-seg-unit">₹ Cr · daily avg · ${BRK_BROKER.name}</span>${lag
      ? `<span class="brk-lag-badge" title="${escHtml(lagTip)}">${escHtml(lagSeg)} through ${escHtml(fmtLongDate(lag.through))}</span>` : ''}</div>
    ${basis?.panels[panel] ? `<p class="brk-basis brk-basis--panel">${escHtml(basis.panels[panel])}</p>` : ''}
    <div class="xl-main-row">${period}${weekday}</div>
    ${noteList}
  </div>`;
}

// ── Data through ─────────────────────────────────────────────────────────────
// A panel's last data day in the run (summary `through` from /api/brokers) when
// it trails the run's as-of date by a trading day or more; null when current.
// The engine published runs whose MTF stopped days before the other segments.
function brkLag(panel) {
  const t = BRK.summary?.through?.[panel], asOf = BRK.summary?.run?.as_of_date;
  return t && asOf && t.through < asOf && t.days_behind !== 0 ? t : null;
}

function brkBehind(t) {
  return t.days_behind == null ? 'over 120 days' : `${t.days_behind} trading day${t.days_behind === 1 ? '' : 's'}`;
}

// "MTF through …" for the run bar, and a note when MTF trails the as-of date
function brkMtfThrough() {
  const t = BRK.summary?.through?.MTF, run = BRK.summary?.run;
  if (!t || !run) return { item: '', note: '' };
  const day = escHtml(fmtLongDate(t.through)), lag = brkLag('MTF');
  if (!lag) return { item: ` · MTF through <b>${day}</b>`, note: '' };
  const asOf = escHtml(fmtLongDate(run.as_of_date));
  return {
    item: ` · <span class="brk-lag">MTF through <b>${day}</b> (${brkBehind(lag)} behind)</span>`,
    note: `<p class="brk-lag-note" role="note">This run's MTF data ends on ${day}, ${brkBehind(lag)} before its as-of date, ${asOf}. MTF figures, including the last 5 trading days, end on ${day}; Consolidated adds them to Broking figures that run to ${asOf}.</p>`,
  };
}

// afterBuildTicks for a daily category axis labelled by month (fmtChartDate): ticks only on
// each month's first trading day in `dates` (ISO, ascending), every n-th month so at most
// `max` remain. Chart.js labels ticks before it skips them, so with plain autoSkip two
// surviving ticks can fall in one month and show the same "Jun-26". The first date only
// starts a month here if it is not the tail of an earlier one, so it never crowds the next.
function brkMonthTicks(dates, max) {
  const starts = dates.reduce((a, d, i) => (i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7) ? a.concat(i) : a), []);
  const step = Math.max(1, Math.ceil(starts.length / max));
  const keep = new Set(starts.filter((_, k) => k % step === 0));
  return scale => { scale.ticks = scale.ticks.filter(t => keep.has(t.value)); };
}

// The A / E legend describes the tags on the Summary, Daily ADR and Calibration
// tabs; tabs without those tags (Price vs ADR, F&O vs Exchanges, PAT) pass legend: false
function brkRunBar({ legend = true } = {}) {
  const run = BRK.summary.run;
  const published = run?.started_at ? fmtLongDate(run.started_at.slice(0, 10)) + ' ' + run.started_at.slice(11, 16) + ' UTC' : '—';
  const mtf = brkMtfThrough();
  return `<div class="brk-runbar">
    ${run ? `<span><b>${escHtml(BRK_BROKER.name)}</b> · as of <b>${escHtml(fmtLongDate(run.as_of_date))}</b>${mtf.item}</span>
    <span>run <code title="${escHtml(run.run_id)}">${escHtml(run.run_id.slice(0, 8))}</code> · published ${escHtml(published)}</span>
    ${legend ? `<span class="brk-legend"><span class="brk-tag brk-tag--act">A</span> Actual: every day in a period ${escHtml(BRK_BROKER.name)} has reported · <span class="brk-tag brk-tag--est">E</span> Estimate: includes projected days after the last reported period · numbered notes say why a figure is missing · all figures are the engine's published values</span>` : ''}`
    : `<span><b>${escHtml(BRK_BROKER.name)}</b> · no ${BRK.mode} run published yet</span>`}
    ${mtf.note}
    ${BRK_BROKER_BASIS[BRK_BROKER.id] ? `<p class="brk-basis" role="note">${escHtml(BRK_BROKER_BASIS[BRK_BROKER.id].note)}</p>` : ''}
  </div>`;
}

function buildBrokersSummary() {
  const el = brkSection('summary');
  if (!BRK.summary.run) { el.innerHTML = `<div class="brk-wrap">${brkRunBar()}${brkNoRunHTML()}</div>`; return; }
  const panels = BRK_PANEL_ORDER.filter(p => BRK.summary.panels.includes(p));
  el.innerHTML = `<div class="brk-wrap">${brkRunBar()}<div class="brk-grid">${panels.map(brkPanelHTML).join('')}</div></div>`;
}

// Period selects stay in step across panels, like the exchange Revenue Summary's rows
document.addEventListener('change', e => {
  const sel = e.target.closest('.brk-sel');
  if (!sel) return;
  BRK.sel[sel.dataset.type] = sel.value;
  buildBrokersSummary();
});

// ── Daily ADR ────────────────────────────────────────────────────────────────
async function buildBrokersDaily() {
  const el = brkSection('daily'), summary = BRK.summary;
  if (!summary.run) { el.innerHTML = `<div class="brk-wrap">${brkRunBar()}${brkNoRunHTML()}</div>`; return; }
  if (!BRK.daily) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading daily revenue…</div></div>';
    let daily;
    try { daily = await brkFetch('daily', BRK.mode); }
    catch (err) { el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load daily revenue: ${escHtml(err.message)}</div></div>`; return; }
    if (BRK.summary !== summary) return;   // the broker or run changed meanwhile
    BRK.daily = daily;
  }
  const chartKey = `brk-${BRK_BROKER.view}-daily`;
  const rows = BRK.daily.rows;
  const dates = [...new Set(rows.map(r => r.trade_date))].sort();
  const shown = BRK.range ? dates.slice(-BRK.range) : dates;
  const byKey = new Map(rows.map(r => [r.segment + '|' + r.trade_date, r]));
  const rangeBtn = (n, label) => `<button type="button" data-brk-range="${n}" class="${BRK.range === n ? 'active' : ''}">${label}</button>`;
  const last = dates.slice(-10).reverse();
  const cell = (seg, d) => { const r = byKey.get(seg + '|' + d); return r ? `${brkVal(r.revenue_cr)}${brkTag(r.regime === 'actual' ? 'actual' : 'estimate')}` : '—'; };
  const hasNet = rows.some(r => r.segment === 'mtf_net');   // MTF (net) is Angel One only
  const segs = BRK_DAILY_SEGMENTS.filter(s => !s.key.startsWith('mtf_') || rows.some(r => r.segment === s.key));
  el.innerHTML = `<div class="brk-wrap">${brkRunBar()}
    <div class="chart-panel">
      <div class="brk-controls">Daily revenue by segment, ₹ Cr (lighter bars: projected days) <span class="brk-mode">${rangeBtn(60, '60D')}${rangeBtn(120, '120D')}${rangeBtn(250, '1Y')}${rangeBtn(0, 'All')}</span></div>
      <div class="brk-chart"><canvas id="${chartKey}"></canvas></div>
    </div>
    <div class="chart-panel brk-table-scroll" style="margin-top:var(--space-4)">
      <table class="brk-table"><thead><tr><th>Trade date</th>${segs.map(s => `<th>${s.label}</th>`).join('')}${hasNet ? '<th>MTF (net)</th>' : ''}</tr></thead>
      <tbody>${last.map(d => `<tr><td>${escHtml(fmtLongDate(d))}</td>${segs.map(s => `<td>${cell(s.key, d)}</td>`).join('')}${hasNet ? `<td>${cell('mtf_net', d)}</td>` : ''}</tr>`).join('')}</tbody></table>
    </div></div>`;
  charts[chartKey]?.destroy();
  charts[chartKey] = new Chart(document.getElementById(chartKey), {
    type: 'bar',
    data: {
      labels: shown.map(fmtChartDate),
      datasets: segs.map((s, i) => ({
        label: s.label,
        data: shown.map(d => byKey.get(s.key + '|' + d)?.revenue_cr ?? null),
        backgroundColor: shown.map(d => CHART_COLORS[i] + (byKey.get(s.key + '|' + d)?.regime === 'actual' ? 'dd' : '55')),
        stack: 'adr',
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { labels: { font: { family: FONT_FAMILY, size: 11 }, color: getTickColor() } },
        tooltip: { mode: 'index', intersect: false, backgroundColor: getTooltipBg(), titleColor: '#111', bodyColor: '#333', borderColor: getGridColor(), borderWidth: 1 } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: getTickColor(), maxTicksLimit: 12, font: { family: FONT_FAMILY, size: 10 } } },
        y: { stacked: true, grid: { color: getGridColor() }, ticks: { color: getTickColor(), font: { family: FONT_FAMILY, size: 10 } }, title: { display: true, text: '₹ Cr', color: getTickColor() } },
      },
    },
  });
}

document.addEventListener('click', e => {
  const btn = e.target.closest('[data-brk-range]');
  if (!btn) return;
  BRK.range = +btn.dataset.brkRange;
  buildBrokersDaily();
});

// ── Calibration ──────────────────────────────────────────────────────────────
function brkCalibValue(param, v) {
  if (v == null) return '—';
  if (/^(share|fo_pct|comm_pct)$/.test(param)) return `${(v * 100).toFixed(2)}%`;
  return Math.abs(v) >= 100 ? v.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : v.toLocaleString('en-IN', { maximumFractionDigits: 4 });
}

async function buildBrokersCalibration() {
  const el = brkSection('calib'), summary = BRK.summary;
  if (!summary.run) { el.innerHTML = `<div class="brk-wrap">${brkRunBar()}${brkNoRunHTML()}</div>`; return; }
  if (!BRK.calib) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading calibration…</div></div>';
    let calib;
    try { calib = await brkFetch('calibration', BRK.mode); }
    catch (err) { el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load calibration: ${escHtml(err.message)}</div></div>`; return; }
    if (BRK.summary !== summary) return;
    BRK.calib = calib;
  }
  const rows = BRK.calib.rows;
  const blocks = Object.keys(BRK_CALIB_SEGMENTS).map(seg => {
    const segRows = rows.filter(r => r.segment === seg);
    if (!segRows.length) return '';
    return ['Q', 'M'].map(type => {
      const tRows = segRows.filter(r => r.period_type === type);
      if (!tRows.length) return '';
      const periods = [...new Set(tRows.map(r => r.period_key))].sort((a, b) => brkPeriodOrder(b) - brkPeriodOrder(a)).slice(0, 8);
      const params = [...new Set(tRows.map(r => r.param))];
      const at = (p, k) => tRows.find(r => r.param === p && r.period_key === k);
      return `<div class="chart-panel brk-calib-seg brk-table-scroll">
        <div class="xl-seg-header" style="margin:-1px -1px 8px">${BRK_CALIB_SEGMENTS[seg]} <span class="xl-seg-unit">${type === 'Q' ? 'by quarter' : 'by month'} · latest 8 periods</span></div>
        <table class="brk-table"><thead><tr><th>Parameter</th>${periods.map(k => `<th>${escHtml(k)}</th>`).join('')}</tr></thead>
        <tbody>${params.map(p => `<tr><td>${escHtml(p)}</td>${periods.map(k => {
          const r = at(p, k);
          if (!r) return '<td></td>';
          const title = [r.rule, r.source_periods && 'from ' + r.source_periods].filter(Boolean).join(' · ');
          return `<td title="${escHtml(title)}">${brkCalibValue(p, r.value)}${brkTag(r.regime === 'actual' ? 'actual' : 'estimate')}</td>`;
        }).join('')}</tr>`).join('')}</tbody></table></div>`;
    }).join('');
  }).join('');
  el.innerHTML = `<div class="brk-wrap">${brkRunBar()}${blocks || '<div class="brk-empty">No calibration published for this run</div>'}</div>`;
}

// ── Registration: one view per broker in the Brokers pill ─────────────────────
BRK_VIEWS.forEach(def => registerBrokerView({
  id: def.view,
  label: def.label,
  tabs: [
    { id: 'summary', label: 'ADR Summary', icon: 'revenue' },
    { id: 'daily', label: 'Daily ADR', icon: 'prediction' },
    { id: 'calib', label: 'Calibration', icon: 'advanced' },
    { id: 'price', label: 'Price vs ADR', icon: 'share' },
    { id: 'fo', label: 'F&O vs Exchanges', icon: 'temporal' },
    ...(def.pat ? [{ id: 'pat', label: 'PAT Predictor', icon: 'prediction' }, { id: 'val', label: 'Valuation', icon: 'revenue' }] : []),
  ],
  titles: { summary: `${def.label}: ADR Summary`, daily: `${def.label}: Daily ADR`, calib: `${def.label}: Calibration`, price: `${def.label}: Share price vs ADR`, fo: `${def.label}: F&O vs exchange revenue`, pat: `${def.label}: PAT Predictor`, val: `${def.label}: Valuation` },
  load: owns => brkLoad(def, BRK.mode, owns),
  build: brkBuild,
  onShow: brkShow,
  meta: brkMeta,
}));
