// dashboard/js/40-mtf.js — MTF mode: the exchanges' margin trading (MTF) books.
// Reads dashboard/data/mtf_daily.json and mtf_stocks_latest.json, which
// scripts/mtf_pipeline.py writes after each daily NSE / BSE run. Three views in
// the MTF pill (registerModeView('mtf', …), VIEW MODES in 00-core.js): NSE+BSE,
// NSE and BSE, each with the tabs in MTF_TABS. The pipeline publishes the
// figures; this file sums them into periods and lays them out.

const MTF_DAILY_URL = './data/mtf_daily.json';
const MTF_STOCKS_URL = './data/mtf_stocks_latest.json';
const MTF_MAX_AGE_MS = 15 * 60 * 1000;   // re-fetch the files when a view loads after this long

// Sidebar tabs: label and NAV_ICONS key
const MTF_TABS = {
  book:    { label: 'MTF Book', icon: 'share' },
  periods: { label: 'By Quarter', icon: 'revenue' },
  flows:   { label: 'Flows', icon: 'prediction' },
  stocks:  { label: 'Top Securities', icon: 'advanced' },
};

// The views: pill order, exchange series, and their tabs (BSE's flows stop at
// Sep 2025; there are none to combine)
const MTF_VIEW_DEFS = [
  { id: 'combined', name: 'NSE + BSE', pill: 'NSE+BSE', tabs: ['book', 'periods', 'stocks'] },
  { id: 'nse', name: 'NSE', pill: 'NSE', tabs: ['book', 'periods', 'flows', 'stocks'] },
  { id: 'bse', name: 'BSE', pill: 'BSE', tabs: ['book', 'periods', 'flows', 'stocks'] },
];

// Dated notes on the exchanges' own series. kind 'break': the series changes
// level or source on that date, so a change measured across it compares
// different bases; 'excluded': the day is left out of the series.
const MTF_NOTES = [
  { ex: 'bse', date: '2024-03-12', kind: 'break',
    text: 'BSE’s own series steps up 56 % between 7 Mar 2024 (₹1,712 Cr) and 12 Mar 2024 (₹2,675 Cr) and stays there; '
      + 'BSE’s 11 Mar 2024 file is partial (458 securities, ₹22 Cr) and left out.' },
  { ex: 'bse', date: '2025-10-01', kind: 'break',
    text: 'BSE’s book falls 33 % on 1 Oct 2025 (₹4,588 Cr on 30 Sep, ₹3,094 Cr on 1 Oct). The drop is BSE’s own: its old '
      + 'archive, whose last day is 1 Oct, falls the same way (to ₹3,126 Cr). From that day BSE publishes a new file, which has no fresh / '
      + 'liquidated flows and runs 0.05–0.7 % below an independent copy of BSE’s data (1 % below the archive on 1 Oct, the one day both exist).' },
  { ex: 'bse', date: '2025-10-20', kind: 'excluded',
    text: 'BSE’s 20 Oct 2025 file doubles the book (₹6,379 Cr against ₹3,199 and ₹3,194 Cr either side); the day is left out.' },
];

const MTF_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// The files (loaded once, re-fetched after MTF_MAX_AGE_MS), the view on show,
// and the toggles, which persist across views
let MTF = { doc: null, stocks: null, at: 0, view: 'combined', range: '1y', gran: 'quarter', built: {} };

// ═══════════════════════════════════════════════════════════════
// PURE HELPERS (tests/test_mtf_dashboard.py runs these in Node)
// ═══════════════════════════════════════════════════════════════

// Indian FY quarter of an ISO date, from the string (no Date: no time-zone shift)
function mtfQuarterOf(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return `Q${m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4} FY ${m >= 4 ? y + 1 : y}`;
}

// A period's label, running index (consecutive periods differ by 1) and calendar
// bounds; gran 'quarter' (Indian FY) or 'month'
function mtfPeriodOf(iso, gran) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  const pad = n => String(n).padStart(2, '0');
  const lastDay = (yy, mm) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  if (gran === 'month') {
    return { label: `${MTF_MONTHS[m - 1]} ${y}`, idx: y * 12 + m - 1,
      start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  }
  const label = mtfQuarterOf(iso);
  const q = +label[1], fy = +label.slice(-4);
  const sm = (q * 3 + 1) % 12 || 12, sy = q === 4 ? fy : fy - 1;   // Q1 Apr, Q2 Jul, Q3 Oct (fy - 1); Q4 Jan (fy)
  const em = sm + 2;
  return { label, idx: fy * 4 + q - 1, start: `${sy}-${pad(sm)}-01`, end: `${sy}-${pad(em)}-${pad(lastDay(sy, em))}` };
}

// Calendar days from ISO date `a` to `b`
function mtfDaysAfter(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }

// ISO date `n` months before `iso`, the day clamped to the month's length
function mtfMonthsBack(iso, n) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7), d = +iso.slice(8, 10);
  const idx = y * 12 + (m - 1) - n;
  const yy = Math.floor(idx / 12), mm = idx % 12 + 1;
  const dd = Math.min(d, new Date(Date.UTC(yy, mm, 0)).getUTCDate());
  return `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Points of a view, oldest first: { date, value (₹ Cr), securities, … }.
// NSE: the closing book; BSE: the amount financed; combined: their sum on dates
// both published (nse, bse parts). Spike days are left out (combined already
// leaves them out); days under `unavailable` never reach the series.
function mtfSeries(doc, view) {
  if (!doc) return [];
  const keep = r => !(r.flags || []).includes('spike');
  let pts;
  if (view === 'combined') {
    pts = (doc.combined || []).map(r => ({ date: r.date, value: r.total_cr, nse: r.nse_cr, bse: r.bse_cr }));
  } else if (view === 'nse') {
    pts = (doc.nse || []).filter(keep).map(r => ({ date: r.date, value: r.closing_cr, securities: r.securities,
      opening: r.opening_cr, fresh: r.fresh_cr, liquidated: r.liquidated_cr, revised: !!r.revised }));
  } else {
    pts = (doc.bse || []).filter(keep).map(r => ({ date: r.date, value: r.amount_financed_cr, securities: r.securities,
      opening: r.opening_cr, fresh: r.fresh_cr, liquidated: r.liquidated_cr, file: r.file }));
  }
  return pts.filter(p => p.value != null && isFinite(p.value)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The last point on or before `iso`, or null
function mtfPointOnOrBefore(points, iso) {
  let hit = null;
  for (const p of points) {
    if (p.date > iso) break;
    hit = p;
  }
  return hit;
}

// Latest book and its change over one session, one month and one year (the
// comparison is the last session on or before the same date a month / year
// earlier). chg = value / then − 1.
function mtfChanges(points) {
  if (!points.length) return null;
  const last = points[points.length - 1];
  const vs = p => (p && p.value ? { date: p.date, value: p.value, chg: last.value / p.value - 1 } : null);
  return {
    date: last.date, value: last.value, point: last,
    d1: vs(points.length > 1 ? points[points.length - 2] : null),
    m1: vs(mtfPointOnOrBefore(points, mtfMonthsBack(last.date, 1))),
    y1: vs(mtfPointOnOrBefore(points, mtfMonthsBack(last.date, 12))),
  };
}

// Per period (oldest first): days, average and end book, its first / last
// dates, change of the average vs the previous period and the same period a
// year earlier, partial = the period runs past the latest point, and
// startsLate = the series begins more than a week into the period. Combined
// points also give the NSE and BSE averages.
function mtfPeriodRows(points, gran) {
  const byIdx = new Map();
  points.forEach(p => {
    const per = mtfPeriodOf(p.date, gran);
    let r = byIdx.get(per.idx);
    if (!r) {
      r = { label: per.label, idx: per.idx, start: per.start, end: per.end, days: 0, sum: 0, nseSum: 0, bseSum: 0, first: p.date };
      byIdx.set(per.idx, r);
    }
    r.days += 1;
    r.sum += p.value;
    if (p.nse != null) r.nseSum += p.nse;
    if (p.bse != null) r.bseSum += p.bse;
    r.last = p.date;
    r.endValue = p.value;
  });
  const rows = [...byIdx.values()].sort((a, b) => a.idx - b.idx);
  const yearBack = gran === 'month' ? 12 : 4;
  const lastDate = points.length ? points[points.length - 1].date : null;
  const firstDate = points.length ? points[0].date : null;
  return rows.map(r => {
    const prev = byIdx.get(r.idx - 1), ly = byIdx.get(r.idx - yearBack);
    const avg = r.sum / r.days;
    const out = {
      label: r.label, idx: r.idx, start: r.start, end: r.end, first: r.first, last: r.last, days: r.days,
      avg, endValue: r.endValue,
      chg: prev ? avg / (prev.sum / prev.days) - 1 : null, prevFirst: prev ? prev.first : null,
      yoy: ly ? avg / (ly.sum / ly.days) - 1 : null, lyFirst: ly ? ly.first : null,
      partial: r.last === lastDate && r.last < r.end,
      startsLate: r.first === firstDate && mtfDaysAfter(r.start, r.first) > 7,
    };
    if (points.length && points[0].nse !== undefined) {
      out.nseAvg = r.nseSum / r.days;
      out.bseAvg = r.bseSum / r.days;
    }
    return out;
  });
}

// Monthly fresh exposure, liquidated exposure and net (fresh − liquidated), in
// ₹ Cr, from the days that publish them (BSE: its archive, to Sep 2025);
// partial / startsLate as in mtfPeriodRows
function mtfFlowRows(points) {
  const byIdx = new Map();
  const withFlows = points.filter(p => p.fresh != null && p.liquidated != null && (p.file === undefined || p.file === 'archive'));
  const lastDate = points.length ? points[points.length - 1].date : null;
  const firstDate = withFlows.length ? withFlows[0].date : null;
  withFlows.forEach(p => {
    const per = mtfPeriodOf(p.date, 'month');
    let r = byIdx.get(per.idx);
    if (!r) { r = { label: per.label, idx: per.idx, start: per.start, end: per.end, days: 0, fresh: 0, liquidated: 0, first: p.date }; byIdx.set(per.idx, r); }
    r.days += 1;
    r.fresh += p.fresh;
    r.liquidated += p.liquidated;
    r.last = p.date;
    r.endValue = p.value;
  });
  return [...byIdx.values()].sort((a, b) => a.idx - b.idx).map(r => ({ ...r, net: r.fresh - r.liquidated,
    partial: r.last === lastDate && r.last < r.end, startsLate: r.first === firstDate && mtfDaysAfter(r.start, r.first) > 7 }));
}

// The dated notes of a kind for a view whose dates fall in (from, to]; BSE's
// notes also apply to the combined view
function mtfNotesBetween(view, from, to, kind = 'break') {
  return MTF_NOTES.filter(n => n.kind === kind && (n.ex === view || (view === 'combined' && n.ex === 'bse'))
    && (!from || n.date > from) && (!to || n.date <= to));
}

// Top securities of an exchange's latest day: rows sorted by amount financed,
// with each one's share of the day's total, the top-10 share and the count
function mtfTopRows(stocks, ex, n = 15) {
  const block = stocks && stocks[ex];
  const cols = stocks && stocks.columns && stocks.columns[ex];
  if (!block || !Array.isArray(block.rows) || !cols) return null;
  const at = name => cols.indexOf(name);
  const iId = at(ex === 'nse' ? 'symbol' : 'id'), iName = at('name'), iQty = at('qty_financed'), iAmt = at('amount_lakh');
  const all = block.rows.map(r => ({ id: r[iId], name: r[iName], qty: r[iQty], cr: (r[iAmt] || 0) / 100 }))
    .sort((a, b) => b.cr - a.cr);
  const total = all.reduce((s, r) => s + r.cr, 0);
  const share = r => (total ? r.cr / total : null);
  return {
    date: block.date, count: all.length, total,
    top10: total ? all.slice(0, 10).reduce((s, r) => s + r.cr, 0) / total : null,
    rows: all.slice(0, n).map((r, i) => ({ ...r, rank: i + 1, share: share(r) })),
  };
}

// ═══════════════════════════════════════════════════════════════
// VIEW: load, build, show
// ═══════════════════════════════════════════════════════════════

function mtfDef(id) { return MTF_VIEW_DEFS.find(d => d.id === id) || MTF_VIEW_DEFS[0]; }

function mtfSection(tab) { return viewSection(VIEW_MODES.mtf.prefix + MTF.view, tab); }

async function mtfLoad(def, owns = () => true) {
  if (!MTF.doc || Date.now() - MTF.at > MTF_MAX_AGE_MS) {
    const [daily, stocks] = await Promise.all([
      fetchDataFile(MTF_DAILY_URL),
      fetchDataFile(MTF_STOCKS_URL).catch(err => { console.warn('MTF securities file not loaded:', err); return null; }),
    ]);
    if (!owns()) return;
    MTF.doc = daily.json;
    MTF.stocks = stocks ? stocks.json : null;
    MTF.at = Date.now();
  }
  if (!owns()) return;
  MTF.view = def.id;
}

// build(): clear the tabs of every MTF view (an earlier view's sections stay in
// the page, and must not keep canvases or toggles); each tab of this view
// builds when shown (charts need their size)
function mtfBuild() {
  MTF.built = {};
  MTF_VIEW_DEFS.forEach(d => d.tabs.forEach(t => {
    const el = viewSection(VIEW_MODES.mtf.prefix + d.id, t);
    if (el) el.innerHTML = '';
  }));
}

function mtfShow(tab) {
  if (MTF.built[tab]) return;
  const el = mtfSection(tab);
  if (!el) return;
  const builders = { book: mtfBuildBook, periods: mtfBuildPeriods, flows: mtfBuildFlows, stocks: mtfBuildStocks };
  try {
    builders[tab]?.(el);
    MTF.built[tab] = true;
  } catch (err) {
    console.error(`MTF ${tab} failed:`, err);
    el.innerHTML = `<div class="rx">${rxPanel({ title: MTF_TABS[tab]?.label || tab,
      body: '<div class="rx-empty"><b>This section could not be drawn</b>The data file may be updating; reload in a moment.</div>' })}</div>`;
  }
}

function mtfMeta() {
  const pts = mtfSeries(MTF.doc, MTF.view);
  const last = pts.length ? pts[pts.length - 1].date : null;
  return last
    ? { quarter: mtfQuarterOf(last), updated: `MTF to ${fmtLongDate(last)}`,
        updatedTitle: `Reporting date of the latest book; mtf_daily.json written ${MTF.doc.updated_at || '—'}` }
    : { quarter: '—', updated: 'no MTF data' };
}

// ═══════════════════════════════════════════════════════════════
// TABS
// ═══════════════════════════════════════════════════════════════

const MTF_COLORS = { nse: RX.model, bse: RX.rev, combined: RX.ink };
const MTF_RANGES = [['6m', '6M', 6], ['1y', '1Y', 12], ['3y', '3Y', 36]];

function mtfEmpty(title, why) {
  return `<div class="rx">${rxPanel({ title, body: `<div class="rx-empty"><b>No data yet</b>${why}</div>` })}</div>`;
}

// "1 month: ▲ +3.2 %" sub-line of a KPI; a comparison that crosses a BSE
// series change says so
function mtfVsLine(view, c, label) {
  if (!c) return `${label}: no earlier session`;
  const crosses = mtfNotesBetween(view, c.date, null).length;
  return `vs ${rxDate(c.date)} · ${rxCr(c.value, 0)}${crosses ? ' · crosses a BSE series change' : ''}`;
}

function mtfKpis(view, pts) {
  const ch = mtfChanges(pts);
  if (!ch) return '';
  const chg = (c, label) => rxKpi(label, c ? rxChangeHTML(c.chg) : '—', mtfVsLine(view, c, label));
  if (view === 'combined') {
    const p = ch.point;
    return rxKpis([
      rxKpi('NSE + BSE book', rxCr(ch.value, 0), `Reporting date ${rxDate(ch.date)}`, { accent: true }),
      rxKpi('NSE', rxCr(p.nse, 0), `${fmtPct(p.nse / ch.value)} of the combined book`),
      rxKpi('BSE', rxCr(p.bse, 0), `${fmtPct(p.bse / ch.value)} of the combined book`),
      chg(ch.m1, '1 month'),
      chg(ch.y1, '1 year'),
    ], 'Latest MTF book');
  }
  return rxKpis([
    rxKpi(`${mtfDef(view).name} book`, rxCr(ch.value, 0), `Reporting date ${rxDate(ch.date)}`, { accent: true }),
    chg(ch.d1, '1 session'),
    chg(ch.m1, '1 month'),
    chg(ch.y1, '1 year'),
    rxKpi('Securities', fmtNum(ch.point.securities, 0), 'with a funded position'),
  ], 'Latest MTF book');
}

// Points in the selected range, ending at the latest
function mtfInRange(pts, range) {
  if (!pts.length) return pts;
  const months = (MTF_RANGES.find(r => r[0] === range) || MTF_RANGES[1])[2];
  const from = mtfMonthsBack(pts[pts.length - 1].date, months);
  return pts.filter(p => p.date > from);
}

function mtfDateTick(labels) {
  return function (val) {
    const iso = labels[val];
    return iso ? `${MTF_MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(2, 4)}` : '';
  };
}

function mtfBuildBook(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const pts = mtfSeries(MTF.doc, view);
  if (!pts.length) { el.innerHTML = mtfEmpty('MTF book', 'mtf_daily.json has no days for this view.'); return; }
  const last = pts[pts.length - 1];
  const legend = view === 'combined'
    ? rxLegend([{ label: 'NSE', color: MTF_COLORS.nse }, { label: 'BSE', color: MTF_COLORS.bse }])
    : rxLegend([{ label: `${def.name} book`, color: MTF_COLORS[view], kind: 'line' }]);
  const recent = pts.slice(-10).reverse();
  const recentHead = view === 'combined'
    ? '<th scope="col">Reporting date</th><th scope="col">NSE</th><th scope="col">BSE</th><th scope="col">NSE + BSE</th><th scope="col">Change</th>'
    : `<th scope="col">Reporting date</th><th scope="col">Book</th><th scope="col">Change</th><th scope="col">Securities</th>${
      view === 'nse' ? '<th scope="col">Fresh</th><th scope="col">Liquidated</th><th scope="col" class="rx-l">Note</th>' : ''}`;
  const recentRows = recent.map((p, i) => {
    const prev = pts[pts.length - 2 - i];
    const chg = prev ? rxChangeHTML(p.value / prev.value - 1, 2) : '—';
    if (view === 'combined') {
      return `<tr><td>${fmtTradeDate(p.date, true)}</td><td>${fmtNum(p.nse, 0)}</td><td>${fmtNum(p.bse, 0)}</td><td class="rx-strong">${fmtNum(p.value, 0)}</td><td>${chg}</td></tr>`;
    }
    return `<tr><td>${fmtTradeDate(p.date, true)}</td><td class="rx-strong">${fmtNum(p.value, 0)}</td><td>${chg}</td><td>${fmtNum(p.securities, 0)}</td>${
      view === 'nse' ? `<td>${fmtNum(p.fresh, 0)}</td><td>${fmtNum(p.liquidated, 0)}</td><td class="rx-l">${p.revised ? rxChip('revised', 'data') : ''}</td>` : ''}</tr>`;
  }).join('');

  el.innerHTML = `<div class="rx">
    ${mtfKpis(view, pts)}
    ${rxPanel({ title: view === 'combined' ? 'NSE + BSE MTF book' : `${def.name} MTF book`,
      meta: `₹ Cr by reporting date · to ${rxDate(last.date)}`,
      right: `${legend}${rxSeg('mtfRange', MTF_RANGES.map(r => [r[0], r[1]]), MTF.range, 'Chart range')}`,
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfBookChart-${view}`)}</div><div data-mtf="bookNotes"></div>` })}
    ${view === 'combined' ? rxPanel({ title: 'BSE share of the combined book', meta: '% of NSE + BSE, by reporting date',
      body: `<div class="rx-pb" style="padding-bottom:10px">${rxCanvas(`mtfShareChart-${view}`)}</div>` }) : ''}
    ${rxPanel({ title: 'Latest reporting days', meta: '₹ Cr',
      body: `<div class="rx-scroll"><table class="rx-table"><thead><tr>${recentHead}</tr></thead><tbody>${recentRows}</tbody></table></div>` })}
    ${rxPanel({ title: 'About these figures', body: mtfAboutHTML(view) })}
  </div>`;

  const draw = () => {
    const shown = mtfInRange(pts, MTF.range);
    const labels = shown.map(p => p.date);
    const notes = mtfNotesBetween(view, shown.length ? shown[0].date : null, null);
    el.querySelector('[data-mtf="bookNotes"]').innerHTML = notes.length
      ? `<div class="rx-chart-note mtf-notes">${notes.map(n => rxAlert(`<strong>${rxDate(n.date)}.</strong> ${n.text}`, 'info')).join('')}</div>` : '';
    const tooltip = { callbacks: {
      title: items => fmtTradeDate(labels[items[0].dataIndex], true) + ' ' + labels[items[0].dataIndex].slice(0, 4),
      label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}`,
      footer: items => (view === 'combined' ? `NSE + BSE: ${rxCr(shown[items[0].dataIndex].value, 0)}` : ''),
    } };
    const datasets = view === 'combined'
      ? [{ label: 'NSE', data: shown.map(p => p.nse), borderColor: MTF_COLORS.nse, backgroundColor: 'rgba(43,92,200,0.18)', fill: 'origin', stack: 'b' },
         { label: 'BSE', data: shown.map(p => p.bse), borderColor: MTF_COLORS.bse, backgroundColor: 'rgba(196,98,26,0.35)', fill: '-1', stack: 'b' }]
      : [{ label: `${def.name} book`, data: shown.map(p => p.value), borderColor: MTF_COLORS[view], backgroundColor: 'transparent', fill: false }];
    datasets.forEach(d => Object.assign(d, { borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 }));
    rxChart('mtfBook', `mtfBookChart-${view}`, 260, {
      type: 'line',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback: mtfDateTick(labels) } },
          y: { stacked: view === 'combined', beginAtZero: view === 'combined', ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    if (view === 'combined') {
      rxChart('mtfShare', `mtfShareChart-${view}`, 160, {
        type: 'line',
        data: { labels, datasets: [{ label: 'BSE share', data: shown.map(p => (p.value ? p.bse / p.value * 100 : null)),
          borderColor: MTF_COLORS.bse, borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, tension: 0 }] },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { callbacks: { title: tooltip.callbacks.title, label: c => ` BSE share: ${c.raw.toFixed(2)} %` } } },
          scales: {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 10, callback: mtfDateTick(labels) } },
            y: { ticks: { callback: v => v.toFixed(1) + ' %' } },
          },
        },
      });
      rxFixHeight(charts.mtfShare);
    }
  };
  draw();
  rxOnSeg(el, 'mtfRange', v => { MTF.range = v; draw(); });
}

// The "About these figures" text: sources, conventions, the days left out and
// the dated notes on the series
function mtfAboutHTML(view) {
  const doc = MTF.doc || {};
  const exs = view === 'combined' ? ['nse', 'bse'] : [view];
  const src = {
    nse: '<b>NSE</b>: “Net scripwise outstanding at the end of the day” from NSE’s daily margin trading file (<code>mrg_trading_DDMMYY.zip</code>). '
      + 'NSE republishes a day a few days later with late member submissions; the revised figures are used (marked “revised”).',
    bse: '<b>BSE</b>: the sum of “Amount financed by members” over the securities in BSE’s margin trading file; days before 1 Oct 2025 come from BSE’s margin trading archive.',
  };
  const left = [];
  exs.forEach(ex => {
    (doc[ex] || []).filter(r => (r.flags || []).includes('spike')).forEach(r => left.push(`${ex.toUpperCase()} ${rxDate(r.date)}: a one-day jump that reverts`));
    Object.entries((doc.unavailable || {})[ex] || {}).forEach(([d, why]) => left.push(`${ex.toUpperCase()} ${rxDate(d)}: ${escHtml(why)}`));
  });
  const notes = MTF_NOTES.filter(n => exs.includes(n.ex) && n.kind === 'break');
  return `<div class="rx-pb mtf-about">
    <ul>
      ${exs.map(ex => `<li>${src[ex]}</li>`).join('')}
      ${view === 'combined' ? '<li><b>NSE + BSE</b>: the sum on dates both exchanges published. Many securities trade on both, so the security counts are not added.</li>' : ''}
      <li>Each day is the <b>reporting date</b>, the trading day the book is for. Exchanges publish it the next trading day, so the latest date trails the market by a session.</li>
      <li>This is the exchanges’ disclosed MTF book across all members, not any one broker’s loan book or interest income.</li>
      ${left.length ? `<li><b>Left out</b>: ${left.join('; ')}.</li>` : ''}
    </ul>
    ${notes.length ? `<p class="rx-lbl" style="margin:10px 0 4px">Series changes</p><ul>${notes.map(n => `<li><b>${rxDate(n.date)}</b>: ${n.text}</li>`).join('')}</ul>` : ''}
    <p class="rx-foot">Source: <code>dashboard/data/mtf_daily.json</code>, written ${escHtml(rxDate(doc.updated_at || ''))} by <code>scripts/mtf_pipeline.py</code>.</p>
  </div>`;
}

// "to 3 Nov 2026" / "from 6 Nov 2023" after a period the file covers only in part
function mtfPartChip(r) {
  return r.partial ? ` <span class="rx-chip">to ${rxDate(r.last)}</span>`
    : r.startsLate ? ` <span class="rx-chip">from ${rxDate(r.first)}</span>` : '';
}

// A † after a change measured across a BSE series change
function mtfBreakMark(view, from, to) {
  const n = from ? mtfNotesBetween(view, from, to) : [];
  return n.length ? `<sup class="mtf-dagger" title="${escHtml(n.map(x => rxDate(x.date)).join(', '))}: BSE series change in between">†</sup>` : '';
}

function mtfBuildPeriods(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const pts = mtfSeries(MTF.doc, view);
  if (!pts.length) { el.innerHTML = mtfEmpty('By quarter', 'mtf_daily.json has no days for this view.'); return; }
  el.innerHTML = `<div class="rx">
    ${rxPanel({ title: `${def.name} average daily MTF book`, meta: '<span data-mtf="perMeta"></span>',
      right: `<span data-mtf="perLegend"></span>${rxSeg('mtfGran', [['quarter', 'Quarter'], ['month', 'Month']], MTF.gran, 'Period')}`,
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfPeriodChart-${view}`)}</div>
        <div class="rx-scroll"><table class="rx-table" data-mtf="perTable"></table></div>
        <p class="rx-foot rx-pb" data-mtf="perFoot"></p>` })}
  </div>`;
  const q = k => el.querySelector(`[data-mtf="${k}"]`);
  const draw = () => {
    const gran = MTF.gran;
    const rows = mtfPeriodRows(pts, gran);
    const unit = gran === 'month' ? 'month' : 'quarter';
    q('perMeta').textContent = `₹ Cr, average over each ${unit}’s reporting days${gran === 'month' ? '' : ' (Indian FY quarters)'}`;
    q('perLegend').innerHTML = view === 'combined'
      ? rxLegend([{ label: 'NSE', color: MTF_COLORS.nse }, { label: 'BSE', color: MTF_COLORS.bse }])
      : rxLegend([{ label: 'Average book', color: MTF_COLORS[view] }, { label: 'To date', color: '#BFC9DD' }]);
    const shown = gran === 'month' ? rows.slice(-24) : rows;
    const labels = shown.map(r => r.label + (r.partial || r.startsLate ? '*' : ''));
    const datasets = view === 'combined'
      ? [{ label: 'NSE', data: shown.map(r => r.nseAvg), backgroundColor: shown.map(r => (r.partial ? '#A9BDE8' : MTF_COLORS.nse)), stack: 'a' },
         { label: 'BSE', data: shown.map(r => r.bseAvg), backgroundColor: shown.map(r => (r.partial ? '#E3B48F' : MTF_COLORS.bse)), stack: 'a' }]
      : [{ label: 'Average book', data: shown.map(r => r.avg), backgroundColor: shown.map(r => (r.partial ? '#BFC9DD' : MTF_COLORS[view])) }];
    datasets.forEach(d => Object.assign(d, { borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 40 }));
    rxChart('mtfPeriods', `mtfPeriodChart-${view}`, 220, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => { const r = shown[items[0].dataIndex]; return `${r.label}${r.partial ? ` (to ${rxDate(r.last)})` : r.startsLate ? ` (from ${rxDate(r.first)})` : ''}`; },
          label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}`,
          footer: items => { const r = shown[items[0].dataIndex]; return `${r.days} reporting days${view === 'combined' ? ` · total ${rxCr(r.avg, 0)}` : ''}`; },
        } } },
        scales: {
          x: { stacked: view === 'combined', grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
          y: { stacked: view === 'combined', beginAtZero: true, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
    const chgHead = gran === 'month' ? 'MoM' : 'QoQ';
    const extraHead = view === 'combined' ? '<th scope="col">NSE avg</th><th scope="col">BSE avg</th><th scope="col">BSE share</th>' : '';
    const body = rows.slice().reverse().map(r => {
      const label = `${r.label}${mtfPartChip(r)}`;
      const extra = view === 'combined'
        ? `<td>${fmtNum(r.nseAvg, 0)}</td><td>${fmtNum(r.bseAvg, 0)}</td><td>${fmtPct(r.bseAvg / r.avg)}</td>` : '';
      return `<tr><td>${label}</td><td>${r.days}</td><td class="rx-strong">${fmtNum(r.avg, 0)}</td><td>${fmtNum(r.endValue, 0)}</td>
        <td>${r.chg == null ? '—' : rxChangeHTML(r.chg) + mtfBreakMark(view, r.prevFirst, r.last)}</td>
        <td>${r.yoy == null ? '—' : rxChangeHTML(r.yoy) + mtfBreakMark(view, r.lyFirst, r.last)}</td>${extra}</tr>`;
    }).join('');
    q('perTable').innerHTML = `<thead><tr><th scope="col">${gran === 'month' ? 'Month' : 'Quarter'}</th><th scope="col">Days</th>
      <th scope="col">Average book</th><th scope="col">End of period</th><th scope="col">${chgHead}</th><th scope="col">YoY</th>${extraHead}</tr></thead>
      <tbody>${body}</tbody>`;
    const breaks = mtfNotesBetween(view, null, null);
    q('perFoot').innerHTML = `Changes compare average daily books. * : part of the ${unit} (“to …”: so far; “from …”: the first day in the file).`
      + (breaks.length ? ` † The comparison spans a change in BSE’s own series (${breaks.map(n => rxDate(n.date)).join(', ')}; see the MTF Book tab).` : '')
      + (gran === 'month' ? ' The chart shows the last 24 months; the table all of them.' : '');
  };
  draw();
  rxOnSeg(el, 'mtfGran', v => { MTF.gran = v; draw(); });
}

function mtfBuildFlows(el) {
  const view = MTF.view;
  const def = mtfDef(view);
  const rows = mtfFlowRows(mtfSeries(MTF.doc, view));
  if (!rows.length) { el.innerHTML = mtfEmpty('Flows', `${def.name}’s files carry no fresh / liquidated exposure.`); return; }
  const shown = rows.slice(-24);
  const lastRow = rows.filter(r => !r.partial).pop() || rows[rows.length - 1];   // KPIs: the last complete month
  const bseNote = view === 'bse'
    ? rxAlert('BSE’s margin trading file from 1 Oct 2025 publishes only the amount financed, so BSE’s flows stop at '
      + `${escHtml(lastRow.label)}. They come from BSE’s margin trading archive, whose opening + fresh − liquidated does not always equal its closing book (a few ₹ Cr on most days).`, 'info')
    : '';
  el.innerHTML = `<div class="rx">
    ${rxKpis([
      rxKpi(`Fresh exposure · ${escHtml(lastRow.label)}`, rxCr(lastRow.fresh, 0), `${lastRow.days} reporting days`),
      rxKpi(`Liquidated · ${escHtml(lastRow.label)}`, rxCr(lastRow.liquidated, 0), `to ${rxDate(lastRow.last)}`),
      rxKpi(`Net · ${escHtml(lastRow.label)}`, `<span class="${lastRow.net >= 0 ? 'rx-up' : 'rx-dn'}">${lastRow.net >= 0 ? '+' : '−'}${rxCr(Math.abs(lastRow.net), 0)}</span>`, 'fresh − liquidated'),
      rxKpi('Book at month end', rxCr(lastRow.endValue, 0), `${rxDate(lastRow.last)}`),
    ], 'Latest month of flows')}
    ${bseNote}
    ${rxPanel({ title: `${def.name} MTF flows by month`, meta: '₹ Cr, summed over each month’s reporting days',
      right: rxLegend([{ label: 'Fresh exposure', color: RX.model }, { label: 'Liquidated', color: RX.deduct }, { label: 'Net', color: RX.ink, kind: 'line' }]),
      body: `<div class="rx-pb" style="padding-bottom:6px">${rxCanvas(`mtfFlowChart-${view}`)}</div>
        <div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col">Month</th><th scope="col">Days</th><th scope="col">Fresh</th>
          <th scope="col">Liquidated</th><th scope="col">Net</th><th scope="col">Month-end book</th></tr></thead>
          <tbody>${rows.slice().reverse().map(r => `<tr><td>${escHtml(r.label)}${mtfPartChip(r)}</td><td>${r.days}</td><td>${fmtNum(r.fresh, 0)}</td><td>${fmtNum(r.liquidated, 0)}</td>
            <td class="${r.net >= 0 ? 'rx-up' : 'rx-dn'}">${r.net >= 0 ? '+' : '−'}${fmtNum(Math.abs(r.net), 0)}</td><td>${fmtNum(r.endValue, 0)}</td></tr>`).join('')}</tbody></table></div>
        <p class="rx-foot rx-pb">* : part of the month (“to …”: so far; “from …”: the first day in the file). The chart shows the last 24 months with flows; the table all of them. Net is fresh exposure less liquidated exposure; the book also moves with revisions and members’ corrections.</p>` })}
  </div>`;
  rxChart('mtfFlows', `mtfFlowChart-${view}`, 240, {
    type: 'bar',
    data: { labels: shown.map(r => r.label + (r.partial || r.startsLate ? '*' : '')), datasets: [
      { type: 'line', label: 'Net', data: shown.map(r => r.net), borderColor: RX.ink, borderWidth: 1.6, pointRadius: 2, tension: 0, order: 0 },
      { label: 'Fresh exposure', data: shown.map(r => r.fresh), backgroundColor: RX.model, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 22, order: 1 },
      { label: 'Liquidated', data: shown.map(r => r.liquidated), backgroundColor: RX.deduct, borderRadius: { topLeft: 2, topRight: 2 }, maxBarThickness: 22, order: 1 },
    ] },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${rxCr(c.raw, 0)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true } },
        y: { ticks: { callback: v => fmtNum(v, 0) } },
      },
    },
  });
}

// withId: a Symbol / ISIN column (left out where two tables share a row)
function mtfStocksTable(top, ex, n, withId = true) {
  const idHead = ex === 'nse' ? 'Symbol' : 'ISIN';
  return `<div class="rx-scroll"><table class="rx-table mtf-stocks"><thead><tr><th scope="col">#</th><th scope="col" class="rx-l">Security</th>
    ${withId ? `<th scope="col" class="rx-l mtf-id">${idHead}</th>` : ''}<th scope="col">Amount financed</th><th scope="col">Share</th><th scope="col">Quantity</th></tr></thead>
    <tbody>${top.rows.slice(0, n).map(r => `<tr><td>${r.rank}</td><td class="rx-l mtf-name" title="${escHtml(r.id || '')}">${escHtml(r.name || r.id || '—')}</td>${
      withId ? `<td class="rx-l rx-mono mtf-id">${escHtml(r.id || '')}</td>` : ''}
      <td class="rx-strong">${rxCr(r.cr, 1)}</td><td>${fmtPct(r.share)}</td><td>${fmtNum(r.qty, 0)}</td></tr>`).join('')}</tbody></table></div>`;
}

function mtfBuildStocks(el) {
  const view = MTF.view;
  const exs = view === 'combined' ? ['nse', 'bse'] : [view];
  const tops = exs.map(ex => ({ ex, top: mtfTopRows(MTF.stocks, ex, 15) }));
  if (tops.every(t => !t.top)) { el.innerHTML = mtfEmpty('Top securities', 'mtf_stocks_latest.json is not available.'); return; }
  const foot = 'Latest reporting day only: the per-security history is not kept in this file. Many securities trade on both exchanges, so the two lists are not added.';
  if (view === 'combined') {
    el.innerHTML = `<div class="rx">
      <div class="rx-row">${tops.map(({ ex, top }) => rxPanel({ cls: 'rx-col-half', title: `${ex.toUpperCase()}: top 10 securities`,
        meta: top ? `${rxDate(top.date)} · top 10 = ${fmtPct(top.top10)} of ${rxCr(top.total, 0)}` : 'not available',
        body: top ? mtfStocksTable(top, ex, 10, false) : '<div class="rx-empty">Not in the file.</div>' })).join('')}</div>
      <p class="rx-foot">${foot}</p>
    </div>`;
    return;
  }
  const top = tops[0].top;
  if (!top) { el.innerHTML = mtfEmpty('Top securities', `mtf_stocks_latest.json has no ${view.toUpperCase()} day.`); return; }
  const lead = top.rows[0];
  el.innerHTML = `<div class="rx">
    ${rxKpis([
      rxKpi('Securities', fmtNum(top.count, 0), `with a funded position on ${rxDate(top.date)}`, { accent: true }),
      rxKpi('Top 10 share', fmtPct(top.top10), `of ${rxCr(top.total, 0)}`),
      rxKpi('Largest', lead ? escHtml(lead.name || lead.id) : '—', lead ? `${rxCr(lead.cr, 0)} · ${fmtPct(lead.share)}` : ''),
    ], 'Concentration')}
    ${rxPanel({ title: `${view.toUpperCase()}: top 15 securities by amount financed`, meta: `${rxDate(top.date)} · ₹ Cr, quantity in shares`,
      body: mtfStocksTable(top, view, 15), foot: foot.split('. ')[0] + '.' })}
  </div>`;
}

// Register the three views (MTF pill order = MTF_VIEW_DEFS order)
MTF_VIEW_DEFS.forEach(def => registerModeView('mtf', {
  id: def.id,
  label: `${def.name} MTF`,
  pill: def.pill,
  tabs: def.tabs.map(t => ({ id: t, label: MTF_TABS[t].label, icon: MTF_TABS[t].icon })),
  titles: {
    book: `${def.name} margin trading (MTF) book`,
    periods: `${def.name} MTF book by quarter / month`,
    flows: `${def.name} MTF flows`,
    stocks: `${def.name} MTF: top securities`,
  },
  load: owns => mtfLoad(def, owns),
  build: mtfBuild,
  onShow: mtfShow,
  meta: mtfMeta,
}));
