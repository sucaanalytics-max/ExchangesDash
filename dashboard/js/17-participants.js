// dashboard/js/17-participants.js — Participants tab under the NSE and BSE views: who trades
// (FII / FPI, DII and its parts, Pro / Prop, Client / Retail …), from data/participants_monthly.json
// and participants_daily.json. scripts/participants_report.py writes both from the stores of
// scripts/participants_pipeline.py, one per source with its categories as published; the NSE tab
// shows NSE's sources, the BSE tab BSE's, and both NSDL's market-wide FPI flows.

const PT_MONTHLY_URL = './data/participants_monthly.json';
const PT_DAILY_URL = './data/participants_daily.json';
const PT_MAX_AGE_MS = 15 * 60 * 1000;   // re-fetch when the tab is built after this long
const PT_RANGES = [['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24], ['all', 'All', null]];
const PT_MIX_MONTHS = 24;               // months in the category-mix chart
const PT_VIEW = { range: '1y', fo: 'oi', fpi: 'month', pulse: 'Cash market', cmp: {} };
const PT_DATA = { monthly: null, daily: null, at: 0 };
let ptBuildSeq = 0;

// Per exchange: the views in the month comparison (participants_report.py VIEWS ids), the F&O
// participant views, the category-mix chart and whether NSE's Market Pulse shares are shown
const PT_LAYOUT = {
  nse: {
    name: 'NSE',
    cmp: [['nse_fo_oi', 'F&O open interest'], ['nse_fo_vol', 'F&O contracts'], ['nse_fii_fo_gross', 'FII derivatives'],
      ['nse_cm_cat_gross', 'Cash turnover'], ['nse_cm_cat_net', 'Cash net buying'], ['nse_fo_cat_gross', 'F&O turnover'],
      ['nsdl_fpi_net', 'FPI net (NSDL)']],
    fo: { oi: 'nse_fo_oi', vol: 'nse_fo_vol' },
    mix: { view: 'nse_cm_cat_gross', title: 'Cash market turnover by client category',
      meta: '₹ Cr per day, monthly average · buy + sell', source: 'NSE CM category-wise turnover' },
    kpi3: { view: 'nse_cm_cat_net', cat: /^mutual/i, label: 'Mutual funds net buying, NSE cash', sum: true },
    pulse: true,
  },
  bse: {
    name: 'BSE',
    cmp: [['bse_fo_oi', 'F&O open interest'], ['bse_fo_vol', 'F&O contracts'], ['bse_fo_cat_gross', 'F&O turnover'],
      ['bse_cash_cat_gross', 'Cash turnover'], ['nse_fiidii_net', 'FII / DII net'], ['nsdl_fpi_net', 'FPI net (NSDL)']],
    fo: { oi: 'bse_fo_oi', vol: 'bse_fo_vol' },
    mix: { view: 'bse_fo_cat_gross', title: 'F&O turnover by category',
      meta: '₹ Cr per day (notional), monthly average · buy + sell', source: 'BSE investor categorywise turnover' },
    kpi3: { view: 'bse_fo_cat_gross', cat: /^fii/i, label: 'FII share of BSE F&O turnover', share: true },
    pulse: false,
  },
};
const PT_PULSE_SEGMENTS = ['Cash market', 'Equity futures (notional)', 'Equity options (premium)', 'Index options (premium)',
  'Stock futures', 'Stock options (premium)'];

// Colours by what a category is, so FII is the same blue on every chart
const PT_COLOR_RULES = [
  [/^(fii|fpi|foreign)/i, RX.model], [/^(diis?|mutual|insurance|banks?|aifs?|pms|dfis?|mf)\b/i, RX.pos],
  [/^(pro|prop|own)/i, RX.rev], [/^(client|retail|individual)/i, '#7A5BB5'], [/^nri/i, '#B07CC6'],
  [/^corporate/i, '#2E8C8C'], [/^other/i, RX.grey],
];
const PT_PALETTE = ['#2B5CC8', '#176C2E', '#C4621A', '#7A5BB5', '#2E8C8C', '#A01822', '#D39A6E', '#8AA5E0', '#5E8A6B', '#9A9DA4'];

function ptColor(cat, i = 0) {
  const hit = PT_COLOR_RULES.find(([re]) => re.test(cat));
  return hit ? hit[1] : PT_PALETTE[i % PT_PALETTE.length];
}

// A lighter tint of a #RRGGBB colour (k = 0 leaves it as is)
function ptTint(hex, k) {
  const f = Math.min(0.75, 0.2 * k);
  return '#' + [1, 3, 5].map(j => Math.round(parseInt(hex.slice(j, j + 2), 16) * (1 - f) + 255 * f)
    .toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Colours for the categories of one chart: each category's own (ptColor), with categories of
// the same kind (Bank, Insurance, Mutual Funds … all DII green) in successively lighter tints
function ptColors(cats) {
  const seen = {};
  return cats.map((c, i) => {
    const base = ptColor(c, i);
    seen[base] = (seen[base] ?? -1) + 1;
    return ptTint(base, seen[base]);
  });
}

// "2026-11" → "Nov 2026"
function ptMonthLabel(m) {
  const [y, mm] = String(m).split('-');
  return `${MONTHS_SHORT[+mm - 1]} ${y}`;
}

// The latest month, the one before, and the same month of each of the three years before
function ptCompareMonths(latest) {
  const y = +latest.slice(0, 4), m = +latest.slice(5, 7);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [latest, prev, ...[1, 2, 3].map(k => `${y - k}-${String(m).padStart(2, '0')}`)];
}

// % change of a level; the absolute change of a month total (net flows change sign)
function ptChange(a, b, agg) {
  if (a == null || b == null) return null;
  if (agg === 'sum') return a - b;
  return b ? a / b - 1 : null;
}

function ptLatestMonth(view) {
  const ms = Object.keys(view?.days || {}).sort();
  return ms.length ? ms[ms.length - 1] : null;
}

// One view's month comparison: each category's value and share in the latest month, the month
// before and the same month of earlier years, with its month-on-month and year-on-year change
function ptCompareRows(view, latest) {
  const months = ptCompareMonths(latest);
  const rows = Object.entries(view.series || {}).map(([cat, s]) => ({
    cat, total: cat === view.total_row,
    vals: months.map(m => s[m] ?? null),
    shares: months.map(m => view.shares?.[cat]?.[m] ?? null),
    mom: ptChange(s[months[0]], s[months[1]], view.aggregation),
    yoy: ptChange(s[months[0]], s[months[2]], view.aggregation),
  }));
  rows.sort((a, b) => (a.total - b.total));   // the total row last
  return { months, days: months.map(m => view.days?.[m] || 0), rows };
}

// Each category's share (%) of the day's total: the total row when the source publishes one
// (NSE's TOTAL, BSE's Total), else the sum of the categories
function ptDailyShares(daily, totalRow) {
  const cats = Object.keys(daily.series).filter(c => c !== totalRow);
  const tot = daily.dates.map((_, i) => (totalRow && daily.series[totalRow]
    ? daily.series[totalRow][i]
    : cats.reduce((a, c) => a + (daily.series[c][i] || 0), 0)));
  const out = {};
  cats.forEach(c => {
    out[c] = daily.series[c].map((v, i) => (v == null || !tot[i] ? null : Math.round(10000 * v / tot[i]) / 100));
  });
  return out;
}

// First date to show for a range ('6m', '1y', '2y', 'all') ending at lastDate; null for all
function ptRangeStart(lastDate, range) {
  const r = PT_RANGES.find(x => x[0] === range);
  if (!r || r[2] == null) return null;
  const d = new Date(lastDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - r[2]);
  return d.toISOString().slice(0, 10);
}

// The value on the last date on or before iso (dates ascending)
function ptValueOnOrBefore(dates, vals, iso) {
  let hit = null;
  for (let i = 0; i < dates.length && dates[i] <= iso; i++) if (vals[i] != null) hit = { date: dates[i], value: vals[i] };
  return hit;
}

function ptFmt(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  if (unit === 'contracts') {
    const a = Math.abs(v);
    return a >= 1e7 ? `${fmtNum(v / 1e7, 2)} Cr` : a >= 1e5 ? `${fmtNum(v / 1e5, 1)} L` : fmtNum(v, 0);
  }
  return fmtNum(v, 0);
}

function ptChangeText(c, agg) {
  if (c == null || !isFinite(c)) return '—';
  return agg === 'sum' ? `${c >= 0 ? '+' : '−'}${fmtNum(Math.abs(c), 0)}` : rxSignedPct(c);
}

function ptFindCat(series, re) {
  return Object.keys(series || {}).find(c => re.test(c)) || null;
}

// The monthly file is required; without the daily one (not yet written, or a failed fetch) the
// tab shows its monthly views and asks for the daily file again next time
async function ptLoad() {
  if (PT_DATA.monthly && PT_DATA.daily && Date.now() - PT_DATA.at < PT_MAX_AGE_MS) return;
  const [m, d] = await Promise.all([fetchDataFile(PT_MONTHLY_URL), fetchDataFile(PT_DAILY_URL).catch(() => null)]);
  PT_DATA.monthly = m.json;
  PT_DATA.daily = d ? d.json : null;
  PT_DATA.at = Date.now();
}

function ptCompareTableHTML(view, latest) {
  const { months, days, rows } = ptCompareRows(view, latest);
  const sum = view.aggregation === 'sum';
  const head = months.map((m, i) => `<th scope="col"${i === 0 ? ' class="rx-hl"' : ''} title="${days[i]} trading day${days[i] === 1 ? '' : 's'}">${ptMonthLabel(m)}${i === 0 && days[i] ? `<br><span class="rx-meta">${days[i]} days</span>` : ''}</th>`).join('');
  const body = rows.map(r => `<tr${r.total ? ' class="rx-sub"' : ''}>
      <td class="rx-l">${r.total ? '<b>' : ''}<i class="pt-dot" style="background:${r.total ? RX.ink : ptColor(r.cat)}"></i>${escHtml(r.cat)}${r.total ? '</b>' : ''}</td>
      ${r.vals.map((v, i) => `<td${i === 0 ? ' class="rx-hl"' : ''}>${ptFmt(v, view.unit)}${r.shares[i] != null ? `<span class="pt-share">${fmtNum(r.shares[i], 1)} %</span>` : ''}</td>`).join('')}
      <td>${ptChangeText(r.mom, view.aggregation)}</td><td>${ptChangeText(r.yoy, view.aggregation)}</td>
    </tr>`).join('');
  return `<div class="rx-scroll"><table class="rx-table pt-table">
      <thead><tr><th scope="col" class="rx-l">Category</th>${head}
        <th scope="col" title="${sum ? 'Change in the month total' : '% change'} against the month before">MoM</th>
        <th scope="col" title="${sum ? 'Change in the month total' : '% change'} against the same month a year before">YoY</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="rx-foot">${escHtml(view.heading)} (${escHtml(view.unit)}).${sum ? ' MoM and YoY are changes in the month total.' : ' Grey figures: share of the view\'s total.'} ${ptMonthLabel(months[0])} is month to date.</p>`;
}

function ptPanelEmpty(title, msg) {
  return rxPanel({ title, body: `<div class="rx-empty"><b>${msg}</b></div>` });
}

async function buildParticipants(ex) {
  const el = document.getElementById('participantsContent');
  if (!el) return;
  const lay = PT_LAYOUT[ex];
  if (!lay) { el.innerHTML = ''; return; }
  const seq = ++ptBuildSeq;
  if (!PT_DATA.monthly) el.innerHTML = `<div class="rx">${ptPanelEmpty('Participants', 'Loading participant data…')}</div>`;
  try {
    await ptLoad();
  } catch (err) {
    console.error('Participants data failed to load:', err);
    if (seq === ptBuildSeq) el.innerHTML = `<div class="rx">${ptPanelEmpty('Participants', 'Couldn\'t load participant data. Try again in a moment.')}</div>`;
    return;
  }
  if (seq !== ptBuildSeq || currentExchange !== ex) return;   // rebuilt or switched away while loading
  const M = PT_DATA.monthly.views || {}, D = PT_DATA.daily?.views || {};
  const oiDaily = D[lay.fo.oi]?.dates?.length ? D[lay.fo.oi] : null, volView = M[lay.fo.vol];
  const latest = ptLatestMonth(volView);
  if (!latest) {
    el.innerHTML = `<div class="rx">${ptPanelEmpty('Participants', 'No participant data yet')}</div>`;
    return;
  }
  const lastDate = oiDaily ? oiDaily.dates[oiDaily.dates.length - 1] : null;
  const noDaily = 'Daily figures arrive with the next participants run.';
  if (!D.nsdl_fpi_net?.dates?.length) PT_VIEW.fpi = 'month';

  // ── KPIs ───────────────────────────────────────────────────
  const oiShares = oiDaily ? ptDailyShares(oiDaily, M[lay.fo.oi]?.total_row) : {};
  const fiiOi = ptFindCat(oiShares, /^fii/i);
  const oiNow = fiiOi ? oiShares[fiiOi][oiShares[fiiOi].length - 1] : null;
  const yearAgo = lastDate ? ptRangeStart(lastDate, '1y') : null;
  const oiThen = fiiOi && lastDate ? ptValueOnOrBefore(oiDaily.dates, oiShares[fiiOi], yearAgo) : null;
  const fiiVol = ptFindCat(volView.shares, /^fii/i);
  const volMonths = ptCompareMonths(latest);
  const fpi = M.nsdl_fpi_net?.series?.Equity || {};
  const fpiLatest = ptLatestMonth(M.nsdl_fpi_net);
  const k3 = M[lay.kpi3.view], k3cat = k3 ? ptFindCat(k3.series, lay.kpi3.cat) : null;
  const k3months = k3 ? ptCompareMonths(ptLatestMonth(k3)) : [];
  const k3val = !k3cat ? null : lay.kpi3.share ? k3.shares?.[k3cat]?.[k3months[0]] : k3.series[k3cat][k3months[0]];
  const k3prev = !k3cat ? null : lay.kpi3.share ? k3.shares?.[k3cat]?.[k3months[1]] : k3.series[k3cat][k3months[1]];
  const pct = v => (v == null ? '—' : `${fmtNum(v, 1)} %`);
  const crSigned = v => (v == null ? '—' : `${v >= 0 ? '+' : '−'}₹${fmtNum(Math.abs(v), 0)} Cr`);
  const kpis = rxKpis([
    rxKpi(`FII share of ${lay.name} F&O open interest${lastDate ? ` · ${escHtml(rxDate(lastDate))}` : ''}`, pct(oiNow),
      oiThen ? `${pct(oiThen.value)} a year before (${escHtml(rxDate(oiThen.date))})` : (lastDate ? '' : noDaily), { accent: true }),
    rxKpi(`FII share of ${lay.name} F&O contracts · ${escHtml(ptMonthLabel(latest))}`, pct(fiiVol && volView.shares[fiiVol][volMonths[0]]),
      fiiVol ? `${pct(volView.shares[fiiVol][volMonths[1]])} in ${escHtml(ptMonthLabel(volMonths[1]))} · ${pct(volView.shares[fiiVol][volMonths[2]])} a year before` : ''),
    rxKpi(`FPI net equity buying (NSDL) · ${fpiLatest ? escHtml(ptMonthLabel(fpiLatest)) : '—'}`, crSigned(fpiLatest ? fpi[fpiLatest] : null),
      fpiLatest ? `${crSigned(fpi[ptCompareMonths(fpiLatest)[1]])} in ${escHtml(ptMonthLabel(ptCompareMonths(fpiLatest)[1]))} · month to date` : ''),
    rxKpi(`${escHtml(lay.kpi3.label)} · ${k3months[0] ? escHtml(ptMonthLabel(k3months[0])) : '—'}`,
      lay.kpi3.share ? pct(k3val) : crSigned(k3val),
      k3months[1] ? `${lay.kpi3.share ? pct(k3prev) : crSigned(k3prev)} in ${escHtml(ptMonthLabel(k3months[1]))}` : ''),
  ], 'Participant activity');

  // ── Panels ─────────────────────────────────────────────────
  const cmpOptions = lay.cmp.filter(([id]) => M[id] && ptLatestMonth(M[id]));
  const cmpPick = cmpOptions.some(([id]) => id === PT_VIEW.cmp[ex]) ? PT_VIEW.cmp[ex] : cmpOptions[0][0];
  const pulse = PT_DATA.monthly.pulse || {};
  const pulseSegs = PT_PULSE_SEGMENTS.filter(s => pulse[s]);
  if (!pulseSegs.includes(PT_VIEW.pulse) && pulseSegs.length) PT_VIEW.pulse = pulseSegs[0];

  el.innerHTML = `<div class="rx">
    <div class="rx-bar" style="position:static">
      <div class="rx-grp">${rxChip(`${lay.name} + NSDL`, 'data')} ${rxChip('Categories as each source publishes them')}</div>
      <p class="rx-foot">Participant-wise trading data to ${lastDate ? escHtml(rxDate(lastDate)) : escHtml(ptMonthLabel(latest))} · FPI flows market-wide (NSDL)</p>
    </div>
    ${kpis}
    ${rxPanel({ title: 'Month by month', meta: 'latest month against the month before and the same month of earlier years',
      right: rxSeg('ptCmp', cmpOptions, cmpPick, 'View'),
      body: `<div class="rx-pb" data-pt="cmp"></div>` })}
    ${rxPanel({ title: `${lay.name} F&O: share by participant`, meta: '<span data-pt="fometa"></span>',
      right: `${rxSeg('ptFo', [['oi', 'Open interest'], ['vol', 'Contracts traded']], PT_VIEW.fo, 'Measure')} ${rxSeg('ptRange', PT_RANGES.map(r => [r[0], r[1]]), PT_VIEW.range, 'Chart range')}`,
      body: oiDaily ? `${rxCanvas('chartPtFo')}<div class="rx-pb" data-pt="folegend"></div>` : `<div class="rx-empty"><b>${noDaily}</b></div>`,
      foot: 'Each participant\'s long + short contracts as a share of the total, by day. Contracts traded are smoothed over 10 trading days; open interest is each day\'s.' })}
    ${rxPanel({ title: 'FPI net investment in equity (NSDL)', meta: '<span data-pt="fpimeta"></span>',
      right: D.nsdl_fpi_net?.dates?.length ? rxSeg('ptFpi', [['month', 'Monthly'], ['day', 'Daily']], PT_VIEW.fpi, 'Period') : '',
      body: `${rxCanvas('chartPtFpi')}`,
      foot: 'Final FPI figures from custodians\' reports (NSDL), equity via stock exchanges and primary market; ₹ Cr. The latest month is to date.' })}
    ${rxPanel({ title: escHtml(lay.mix.title), meta: escHtml(lay.mix.meta),
      body: `${rxCanvas('chartPtMix')}<div class="rx-pb" data-pt="mixlegend"></div>`,
      foot: `${escHtml(lay.mix.source)}, last ${PT_MIX_MONTHS} months; categories as published (spellings matched across years). Hover a month for each category's share.` })}
    ${lay.pulse && pulseSegs.length ? rxPanel({ title: 'NSE Market Pulse: share of turnover by client category', meta: 'monthly, % · NSE\'s groupings',
      right: rxSeg('ptPulse', pulseSegs.map(s => [s, s.replace(/ \(.*\)$/, '')]), PT_VIEW.pulse, 'Segment'),
      body: `${rxCanvas('chartPtPulse')}<div class="rx-pb" data-pt="pulselegend"></div>`,
      foot: 'From NSE\'s monthly Market Pulse (a month behind). Older editions\' FPI, DII, PRO and Individual investors are shown as Foreign Investors, DIIs, Prop and Individuals.' }) : ''}
  </div>`;
  const root = el.firstElementChild;

  const drawCmp = () => {
    const v = M[PT_VIEW.cmp[ex] || cmpPick];
    root.querySelector('[data-pt="cmp"]').innerHTML = v ? ptCompareTableHTML(v, ptLatestMonth(v)) : '';
  };
  PT_VIEW.cmp[ex] = cmpPick;

  const drawFo = () => {
    const id = PT_VIEW.fo === 'oi' ? lay.fo.oi : lay.fo.vol;
    const daily = D[id], view = M[id];
    if (!daily?.dates?.length || !lastDate) {
      root.querySelector('[data-pt="fometa"]').textContent = 'by day';
      return;
    }
    const shares = ptDailyShares(daily, view?.total_row);
    const start = ptRangeStart(lastDate, PT_VIEW.range);
    const first = start ? Math.max(0, daily.dates.findIndex(d => d >= start)) : 0;
    const dates = daily.dates.slice(first);
    const smooth = PT_VIEW.fo === 'vol' ? 10 : 1;
    const cats = Object.keys(shares);
    const datasets = cats.map((c, i) => {
      const all = shares[c];
      const vals = all.map((_, j) => {
        if (smooth === 1) return all[j];
        const win = all.slice(Math.max(0, j - smooth + 1), j + 1).filter(x => x != null);
        return win.length ? Math.round(100 * win.reduce((a, b) => a + b, 0) / win.length) / 100 : null;
      }).slice(first);
      return { label: c, data: vals, borderColor: ptColor(c, i), backgroundColor: ptColor(c, i), borderWidth: 1.75, pointRadius: 0, tension: 0, spanGaps: true };
    });
    root.querySelector('[data-pt="fometa"]').textContent = `${rxDate(dates[0])} to ${rxDate(dates[dates.length - 1])} · % of total`;
    root.querySelector('[data-pt="folegend"]').innerHTML = rxLegend(cats.map((c, i) => ({ label: escHtml(c), color: ptColor(c, i), kind: 'line' })));
    rxChart('ptFo', 'chartPtFo', 280, {
      type: 'line',
      data: { labels: dates.map(fmtChartDate), datasets },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { title: items => rxDate(dates[items[0].dataIndex]),
          label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : fmtNum(ctx.raw, 1) + ' %'}` } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: brkMonthTicks(dates, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: '% of total' }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
  };

  const drawFpi = () => {
    let labels, vals, titles, meta;
    if (PT_VIEW.fpi === 'month') {
      const months = Object.keys(fpi).sort();
      labels = months.map(ptMonthLabel); vals = months.map(m => fpi[m]); titles = labels;
      meta = `${labels[0]} to ${labels[labels.length - 1]} · month totals`;
    } else {
      const daily = D.nsdl_fpi_net;
      const start = ptRangeStart(daily.dates[daily.dates.length - 1], PT_VIEW.range);
      const first = start ? Math.max(0, daily.dates.findIndex(d => d >= start)) : 0;
      const dates = daily.dates.slice(first);
      labels = dates.map(fmtChartDate); vals = (daily.series.Equity || []).slice(first); titles = dates.map(rxDate);
      meta = `${rxDate(dates[0])} to ${rxDate(dates[dates.length - 1])} · by reporting date (range as above)`;
    }
    root.querySelector('[data-pt="fpimeta"]').textContent = meta;
    rxChart('ptFpi', 'chartPtFpi', 240, {
      type: 'bar',
      data: { labels, datasets: [{ label: 'FPI net equity', data: vals, backgroundColor: vals.map(v => (v >= 0 ? RX.pos : RX.neg)), borderWidth: 0 }] },
      options: {
        plugins: { tooltip: { callbacks: { title: items => titles[items[0].dataIndex], label: ctx => ` Net: ${crSigned(ctx.raw)}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
          y: { title: { display: true, text: '₹ Cr' }, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
  };

  const drawMix = () => {
    const v = M[lay.mix.view];
    if (!v) return;
    const months = Object.keys(v.days).sort().slice(-PT_MIX_MONTHS);
    const cats = Object.keys(v.series).filter(c => c !== v.total_row && months.some(m => v.series[c][m] != null));
    const colors = ptColors(cats);
    root.querySelector('[data-pt="mixlegend"]').innerHTML = rxLegend(cats.map((c, i) => ({ label: escHtml(c), color: colors[i] })));
    rxChart('ptMix', 'chartPtMix', 260, {
      type: 'bar',
      data: { labels: months.map(ptMonthLabel), datasets: cats.map((c, i) => ({
        label: c, data: months.map(m => v.series[c][m] ?? null), backgroundColor: colors[i], borderWidth: 0, stack: 'mix' })) },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: ctx => {
          const share = v.shares?.[ctx.dataset.label]?.[months[ctx.dataIndex]];
          return ` ${ctx.dataset.label}: ₹${fmtNum(ctx.raw, 0)} Cr${share != null ? ` (${fmtNum(share, 1)} %)` : ''}`;
        } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { stacked: true, title: { display: true, text: '₹ Cr per day' }, ticks: { callback: x => fmtNum(x, 0) } },
        },
      },
    });
  };

  const drawPulse = () => {
    const seg = pulse[PT_VIEW.pulse];
    if (!seg) return;
    const cats = Object.keys(seg);
    const months = [...new Set(cats.flatMap(c => Object.keys(seg[c])))].filter(m => /^\d{4}-\d{2}$/.test(m)).sort();
    root.querySelector('[data-pt="pulselegend"]').innerHTML = rxLegend(cats.map((c, i) => ({ label: escHtml(c), color: ptColor(c, i), kind: 'line' })));
    rxChart('ptPulse', 'chartPtPulse', 260, {
      type: 'line',
      data: { labels: months.map(ptMonthLabel), datasets: cats.map((c, i) => ({
        label: c, data: months.map(m => seg[c][m] ?? null), borderColor: ptColor(c, i), backgroundColor: ptColor(c, i),
        borderWidth: 1.75, pointRadius: 2, tension: 0, spanGaps: true })) },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : fmtNum(ctx.raw, 1) + ' %'}` } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 10, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: '% of turnover' }, ticks: { callback: x => `${x} %` } },
        },
      },
    });
  };

  const drawAll = () => { drawFo(); drawFpi(); drawMix(); if (lay.pulse) drawPulse(); };
  drawCmp();
  drawAll();
  rxOnSeg(root, 'ptCmp', v => { PT_VIEW.cmp[ex] = v; drawCmp(); });
  rxOnSeg(root, 'ptFo', v => { PT_VIEW.fo = v; drawFo(); });
  rxOnSeg(root, 'ptRange', v => { PT_VIEW.range = v; drawFo(); if (PT_VIEW.fpi === 'day') drawFpi(); });
  rxOnSeg(root, 'ptFpi', v => { PT_VIEW.fpi = v; drawFpi(); });
  rxOnSeg(root, 'ptPulse', v => { PT_VIEW.pulse = v; drawPulse(); });
  RX_TAB_REFRESH.participants = drawAll;
}
