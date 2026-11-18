// dashboard/js/19-mcx-competition.js — Competition tab under the MCX view: NSE's share of
// India's commodity derivatives against MCX, per underlying, from data/nse_commodity_daily.json
// (scripts/nse_commodity_pipeline.py: NSE's commodity bhavcopy and MCX's per-commodity rows).
// Shares are taken per underlying in ₹ (futures notional, options notional, options premium),
// never per contract, since the two exchanges' contract sizes differ. A day counts only once
// both exchanges' figures are in (MCX's per-commodity rows land the next morning), and special
// sessions stay out. NSE's commodity transaction charges are a memo figure: never part of NSE's
// revenue elsewhere on the dashboard.

const CC_URL = './data/nse_commodity_daily.json';
const CC_MAX_AGE_MS = 15 * 60 * 1000;   // re-fetch when the tab is built after this long
const CC_DATA = { doc: null, at: 0 };
const CC_VIEW = { win: '20d', und: 'all', metric: 'prem', range: '1y' };
const CC_WINDOWS = [['day', 'Latest day'], ['20d', '20 sessions'], ['mtd', 'Month'], ['qtd', 'Quarter'], ['fytd', 'FY']];
const CC_METRICS = [['prem', 'Options premium'], ['onot', 'Options notional'], ['fut', 'Futures notional']];
const CC_METRIC_TEXT = { prem: 'options premium', onot: 'options notional', fut: 'futures notional' };
const CC_RANGES = [['6m', '6 M', 6], ['1y', '1 Y', 12], ['all', 'All', null]];
const CC_CHART_UNDS = ['all', 'natgas', 'crude', 'gold', 'silver', 'electricity'];
const CC_ROLL = 20;                     // sessions in the rolling share line
let ccBuildSeq = 0;

async function ccLoad() {
  if (CC_DATA.doc && Date.now() - CC_DATA.at < CC_MAX_AGE_MS) return;
  CC_DATA.doc = (await fetchDataFile(CC_URL)).json;
  CC_DATA.at = Date.now();
}

// One metric of one underlying ('all' = every underlying) in a compact day or period:
// cells are f = [contracts, notional ₹ Cr], o = [contracts, notional ₹ Cr, premium ₹ Cr | null]
function ccVal(side, und, metric) {
  if (!side) return null;
  const pick = cells => {
    if (!cells) return 0;
    if (metric === 'fut') return cells.f ? cells.f[1] : 0;
    if (!cells.o) return 0;
    return metric === 'onot' ? cells.o[1] : cells.o[2];
  };
  if (und !== 'all') return pick(side[und]);
  let t = 0;
  for (const k of Object.keys(side)) {
    const v = pick(side[k]);
    if (v == null) return null;
    t += v;
  }
  return t;
}

function ccSum(rows, side, und, metric) {
  let t = 0;
  for (const r of rows) {
    const v = ccVal(r[side], und, metric);
    if (v == null) return null;
    t += v;
  }
  return t;
}

// NSE ÷ (NSE + MCX) over the rows' sums; null when unknown or neither traded
function ccShare(rows, und, metric) {
  const n = ccSum(rows, 'nse', und, metric), m = ccSum(rows, 'mcx', und, metric);
  if (n == null || m == null || n + m <= 0) return null;
  return n / (n + m);
}

// Days with both exchanges' figures, special sessions left out
function ccDays(doc) {
  return (doc.daily || []).filter(r => !r.session && r.mcx);
}

function ccFy(iso) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
  return m >= 4 ? y + 1 : y;
}

function ccQuarter(iso) {
  const m = +iso.slice(5, 7);
  return `${ccFy(iso)}-Q${m >= 4 ? Math.ceil((m - 3) / 3) : 4}`;
}

function ccQuarterLabel(key) {
  const [fy, q] = key.split('-');
  return `${q} FY ${fy}`;
}

function ccMonthLabel(ym) {
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
}

// The selected window and the one it is compared with
function ccWindow(days, win) {
  if (!days.length) return null;
  const last = days[days.length - 1].date;
  const by = fn => {
    const cur = fn(last), groups = [...new Set(days.map(r => fn(r.date)))];
    const prevKey = groups[groups.indexOf(cur) - 1];
    return { rows: days.filter(r => fn(r.date) === cur), prev: prevKey ? days.filter(r => fn(r.date) === prevKey) : [], key: cur, prevKey };
  };
  if (win === 'day') {
    return { rows: days.slice(-1), prev: days.slice(-2, -1), label: rxDate(last),
      prevLabel: days.length > 1 ? rxDate(days[days.length - 2].date) : '' };
  }
  if (win === '20d') {
    const rows = days.slice(-20), prev = days.slice(-40, -20);
    return { rows, prev, label: `${rxDate(rows[0].date)} – ${rxDate(last)}`, prevLabel: prev.length ? 'the 20 before' : '' };
  }
  if (win === 'mtd') {
    const w = by(d => d.slice(0, 7));
    return { ...w, label: `${ccMonthLabel(w.key)} to date`, prevLabel: w.prevKey ? ccMonthLabel(w.prevKey) : '' };
  }
  if (win === 'qtd') {
    const w = by(ccQuarter);
    return { ...w, label: `${ccQuarterLabel(w.key)} to date`, prevLabel: w.prevKey ? ccQuarterLabel(w.prevKey) : '' };
  }
  const w = by(ccFy);
  return { ...w, label: `FY ${w.key} to date`, prevLabel: w.prevKey ? `FY ${w.prevKey}` : '' };
}

// ₹ Cr with as many decimals as small figures need
function ccCr(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v === 0) return '0';
  const a = Math.abs(v);
  return fmtNum(v, a >= 1000 ? 0 : a >= 10 ? 1 : a >= 0.1 ? 2 : 3);
}

function ccPct(s) {
  if (s == null || !isFinite(s)) return '—';
  const p = s * 100;
  return `${p === 0 ? '0' : p < 0.1 ? p.toFixed(3) : p < 1 ? p.toFixed(2) : p.toFixed(1)} %`;
}

// Change in percentage points, coloured
function ccPp(cur, prev) {
  if (cur == null || prev == null) return '<td>—</td>';
  const d = (cur - prev) * 100;
  if (d === 0) return '<td>0 pp</td>';
  const digits = Math.abs(d) < 0.1 ? 3 : 2;
  return `<td class="${d > 0 ? 'rx-up' : d < 0 ? 'rx-dn' : ''}">${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)} pp</td>`;
}

function ccLabel(doc, und) {
  if (und === 'all') return 'All commodities';
  const u = (doc.underlyings || []).find(x => x.key === und);
  return u ? u.label : und;
}

function ccMonthTicks(dates, max) {
  const starts = dates.reduce((a, d, i) => (i > 0 && d.slice(0, 7) !== dates[i - 1].slice(0, 7) ? a.concat(i) : a), []);
  const step = Math.max(1, Math.ceil(starts.length / max));
  const keep = new Set(starts.filter((_, k) => k % step === 0));
  return scale => { scale.ticks = scale.ticks.filter(t => keep.has(t.value)); };
}

function ccPanelEmpty(msg) {
  return rxPanel({ title: 'Competition', body: `<div class="rx-empty"><b>${msg}</b></div>` });
}

function ccTableHTML(doc, w) {
  const n = w.rows.length || 1;
  const keys = ['all'].concat((doc.underlyings || []).map(u => u.key));
  const rows = keys.filter(k => {
    if (k === 'all') return true;
    return ['fut', 'onot'].some(m => (ccSum(w.rows, 'nse', k, m) || 0) + (ccSum(w.rows, 'mcx', k, m) || 0) > 0);
  }).map(k => {
    const cell = (m, side, rows, cnt) => { const s = ccSum(rows, side, k, m); return s == null ? null : s / cnt; };
    // An underlying MCX has no contract on (Brent) has no share to show
    const u = (doc.underlyings || []).find(x => x.key === k);
    const nseOnly = !!u && !u.mcx.length && !!u.nse.length;
    const sh = m => (nseOnly ? null : ccShare(w.rows, k, m));
    const fs = sh('fut'), ps = sh('prem'), os = sh('onot');
    const nseAny = (ccSum(w.rows, 'nse', k, 'fut') || 0) + (ccSum(w.rows, 'nse', k, 'onot') || 0) > 0;
    const tag = k === 'all' ? '' : nseOnly ? ' <span class="rx-meta">NSE only</span>' : !nseAny ? ' <span class="rx-meta">MCX only</span>' : '';
    return `<tr${k === 'all' ? ' class="rx-sub"' : ''}>
      <td class="rx-l">${escHtml(ccLabel(doc, k))}${tag}</td>
      <td>${ccCr(cell('fut', 'nse', w.rows, n))}</td><td>${ccCr(cell('fut', 'mcx', w.rows, n))}</td>
      <td class="rx-hl">${ccPct(fs)}</td>${ccPp(fs, w.prev.length && fs != null ? ccShare(w.prev, k, 'fut') : null)}
      <td>${ccCr(cell('prem', 'nse', w.rows, n))}</td><td>${ccCr(cell('prem', 'mcx', w.rows, n))}</td>
      <td class="rx-hl">${ccPct(ps)}</td>${ccPp(ps, w.prev.length && ps != null ? ccShare(w.prev, k, 'prem') : null)}
      <td>${ccPct(os)}</td>
    </tr>`;
  }).join('');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead>
      <tr><th scope="col" class="rx-l" rowspan="2">Underlying</th>
        <th scope="colgroup" colspan="4">Futures, notional ₹ Cr a day</th>
        <th scope="colgroup" colspan="4">Options, premium ₹ Cr a day</th>
        <th scope="col" rowspan="2" title="NSE's share of options notional (strike + premium) × quantity">Options<br>notional share</th></tr>
      <tr><th scope="col">NSE</th><th scope="col">MCX</th><th scope="col" class="rx-hl">NSE share</th><th scope="col" title="Change in NSE's share against ${escHtml(w.prevLabel || 'the window before')}">vs before</th>
        <th scope="col">NSE</th><th scope="col">MCX</th><th scope="col" class="rx-hl">NSE share</th><th scope="col" title="Change in NSE's share against ${escHtml(w.prevLabel || 'the window before')}">vs before</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

async function buildMcxCompetition() {
  const el = document.getElementById('competitionContent');
  if (!el) return;
  const seq = ++ccBuildSeq;
  if (!CC_DATA.doc) el.innerHTML = `<div class="rx">${ccPanelEmpty('Loading NSE and MCX commodity data…')}</div>`;
  try {
    await ccLoad();
  } catch (err) {
    console.error('Commodity competition data failed to load:', err);
    if (seq === ccBuildSeq) el.innerHTML = `<div class="rx">${ccPanelEmpty('Couldn\'t load the commodity data. Try again in a moment.')}</div>`;
    return;
  }
  if (seq !== ccBuildSeq || currentExchange !== 'mcx') return;   // rebuilt or switched away while loading
  const doc = CC_DATA.doc;
  const days = ccDays(doc);
  if (!days.length) {
    el.innerHTML = `<div class="rx">${ccPanelEmpty('No days with both NSE\'s and MCX\'s commodity figures yet')}</div>`;
    return;
  }
  const latestAll = doc.daily[doc.daily.length - 1];
  const pending = latestAll && !latestAll.mcx ? latestAll.date : null;
  const unavailable = Object.keys(doc.unavailable || {});
  const checked = (doc.daily || []).filter(r => r.checks && r.checks.length);
  const fyRows = days.filter(r => ccFy(r.date) === ccFy(days[days.length - 1].date));
  const revFy = fyRows.reduce((a, r) => a + r.rev[0], 0), revFyEff = fyRows.reduce((a, r) => a + r.rev[1], 0);

  el.innerHTML = `<div class="rx">
    <div class="rx-ph-right" style="margin-bottom:12px">${rxSeg('ccWin', CC_WINDOWS, CC_VIEW.win, 'Window')}</div>
    <div data-cc="kpis"></div>
    ${rxPanel({ title: 'NSE against MCX, by underlying', meta: '<span data-cc="winmeta"></span>',
      body: '<div data-cc="table"></div>',
      foot: 'Averages per session over the window. NSE share = NSE ÷ (NSE + MCX), in ₹, on the underlying (contract sizes differ). '
        + '"vs before" is the change in percentage points against the window before (the session before, the 20 sessions before, the month, quarter or FY before). '
        + 'MCX\'s indices and agri contracts count in "All commodities"; NSE lists neither. NSE\'s Brent crude has no MCX contract, so no share.' })}
    ${rxPanel({ title: 'NSE share by day', meta: '<span data-cc="daymeta"></span>',
      right: rxSeg('ccRange', CC_RANGES.map(([v, l]) => [v, l]), CC_VIEW.range, 'Range'),
      body: `<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">${rxSeg('ccUnd', CC_CHART_UNDS.map(k => [k, escHtml(ccLabel(doc, k))]), CC_VIEW.und, 'Underlying')}
          ${rxSeg('ccMetric', CC_METRICS, CC_VIEW.metric, 'Measure')}</div>
        ${rxLegend([{ label: 'Each session', color: RX.light, kind: 'dot' }, { label: `${CC_ROLL}-session share`, color: RX.model, kind: 'line' }])}
        ${rxCanvas('chartCcDaily')}`,
      foot: 'NSE\'s crude and natural-gas options expire a day before MCX\'s, and most of its options volume comes on its own expiry day and the day before, so the daily share spikes once a month; the 20-session line evens that out. '
        + (doc.notes || []).map(n => `${rxDate(n.date)}: ${escHtml(n.label)}.`).join(' ') })}
    ${rxPanel({ title: 'NSE share by month', meta: '<span data-cc="monmeta"></span>', body: rxCanvas('chartCcMonthly') })}
    ${rxPanel({ title: 'NSE commodity transaction charges (memo)',
      meta: `FY ${ccFy(days[days.length - 1].date)} to date: ₹${fmtNum(revFy * 100, 1)} lakh at today's rates`,
      body: rxCanvas('chartCcRev'),
      foot: `Futures ₹10 per crore of traded value and options ₹100 per crore of premium, each side (NSE/FA/61380); electricity futures were free from 14 Jul to 31 Dec 2025 (NSE/FA/69100), so FY to date at the rules then in force is ₹${fmtNum(revFyEff * 100, 1)} lakh. `
        + 'Not part of NSE\'s revenue anywhere else on the dashboard: it is about ₹0.001–0.1 Cr a day.' })}
    ${rxHow('Sources and method', `<p>NSE: the daily commodity bhavcopy (UDiFF), one row per contract; ${escHtml(doc.source?.premium || '')}. MCX: its bhavcopy per commodity (Supabase <code>mcx_commodity_daily</code>), notional and premium as published.</p>
      <p>Underlyings: ${(doc.underlyings || []).filter(u => u.nse.length || u.mcx.length).map(u => `<b>${escHtml(u.label)}</b> NSE ${escHtml(u.nse.join(', ') || '—')} · MCX ${escHtml(u.mcx.join(', ') || '—')}`).join('; ')}.</p>
      <p>${days.length} sessions with both exchanges' figures, from ${rxDate(days[0].date)}${pending ? `; ${rxDate(pending)} waits for MCX's per-commodity rows` : ''}.
      ${unavailable.length ? `${unavailable.length} MCX trading day(s) NSE has not posted a file for: ${unavailable.slice(-5).map(rxDate).join(', ')}${unavailable.length > 5 ? ' …' : ''}.` : ''}
      ${checked.length ? `${checked.length} day(s) with a data note, e.g. ${rxDate(checked[checked.length - 1].date)}: ${escHtml(checked[checked.length - 1].checks[0])}.` : ''}</p>`)}
  </div>`;
  const root = el.firstElementChild;
  const q = s => root.querySelector(`[data-cc="${s}"]`);

  const drawTable = () => {
    const w = ccWindow(days, CC_VIEW.win);
    q('winmeta').textContent = `${w.label} · ${w.rows.length} session${w.rows.length === 1 ? '' : 's'}${w.prevLabel ? ` · against ${w.prevLabel}` : ''}`;
    q('table').innerHTML = ccTableHTML(doc, w);
    const kp = (m, label) => {
      const s = ccShare(w.rows, 'all', m), p = w.prev.length ? ccShare(w.prev, 'all', m) : null;
      const d = s != null && p != null ? (s - p) * 100 : null;
      return rxKpi(label, ccPct(s), d == null ? '' : `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 0.1 ? 3 : 2)} pp against ${escHtml(w.prevLabel)}`);
    };
    const n = w.rows.length;
    const sumPrem = ccSum(w.rows, 'nse', 'all', 'prem');   // null when a premium is unknown
    const nseFut = ccSum(w.rows, 'nse', 'all', 'fut') / n, nsePrem = sumPrem == null ? null : sumPrem / n;
    q('kpis').innerHTML = rxKpis([
      kp('prem', 'NSE share of options premium'),
      kp('onot', 'NSE share of options notional'),
      kp('fut', 'NSE share of futures notional'),
      rxKpi('NSE commodity a day', nsePrem == null ? '—' : `₹${ccCr(nseFut + nsePrem)} Cr`, `₹${ccCr(nseFut)} Cr futures notional + ₹${ccCr(nsePrem)} Cr options premium`),
    ], 'NSE share of commodity derivatives');
  };

  const drawDaily = () => {
    const und = CC_VIEW.und, metric = CC_VIEW.metric;
    const months = CC_RANGES.find(r => r[0] === CC_VIEW.range)[2];
    const last = days[days.length - 1].date;
    let start = null;
    if (months) {
      const d = new Date(last + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() - months);
      start = d.toISOString().slice(0, 10);
    }
    const first = start ? Math.max(0, days.findIndex(r => r.date >= start)) : 0;
    const shown = days.slice(first);
    const dates = shown.map(r => r.date);
    const daily = shown.map(r => { const s = ccShare([r], und, metric); return s == null ? null : s * 100; });
    const roll = shown.map((_, i) => {
      const j = first + i;
      if (j + 1 < CC_ROLL) return null;
      const s = ccShare(days.slice(j + 1 - CC_ROLL, j + 1), und, metric);
      return s == null ? null : s * 100;
    });
    q('daymeta').textContent = `${ccLabel(doc, und)} · ${CC_METRIC_TEXT[metric]} · ${rxDate(dates[0])} to ${rxDate(last)}`;
    rxChart('ccDaily', 'chartCcDaily', 260, {
      type: 'line',
      data: { labels: dates.map(fmtChartDate), datasets: [
        { label: 'Session', data: daily, showLine: false, pointRadius: 2, pointHoverRadius: 4, pointBackgroundColor: RX.light, pointBorderWidth: 0 },
        { label: `${CC_ROLL}-session`, data: roll, borderColor: RX.model, borderWidth: 2, pointRadius: 0, tension: 0, spanGaps: true },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => rxDate(dates[items[0].dataIndex]),
          label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '—' : ccPct(ctx.raw / 100)}`,
          footer: items => {
            const r = shown[items[0].dataIndex];
            return `NSE ₹${ccCr(ccVal(r.nse, und, metric))} Cr · MCX ₹${ccCr(ccVal(r.mcx, und, metric))} Cr`;
          } } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: ccMonthTicks(dates, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: 'NSE share, %' }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
  };

  const drawMonthly = () => {
    const und = CC_VIEW.und, metric = CC_VIEW.metric;
    const months = (doc.monthly || []).filter(p => p.days > 0);
    const vals = months.map(p => { const s = ccShare([p], und, metric); return s == null ? null : s * 100; });
    q('monmeta').textContent = `${ccLabel(doc, und)} · ${CC_METRIC_TEXT[metric]} · sessions with both exchanges' figures; the latest month is to date`;
    rxChart('ccMonthly', 'chartCcMonthly', 220, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [{ label: 'NSE share', data: vals, backgroundColor: RX.model, borderWidth: 0 }] },
      options: {
        plugins: { tooltip: { callbacks: {
          label: ctx => ` NSE share: ${ccPct(ctx.raw / 100)}`,
          footer: items => {
            const p = months[items[0].dataIndex];
            return `${p.days} sessions · NSE ₹${ccCr(ccVal(p.nse, und, metric) / p.days)} Cr a day · MCX ₹${ccCr(ccVal(p.mcx, und, metric) / p.days)} Cr a day`;
          } } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: 'NSE share, %' }, ticks: { callback: v => `${v} %` } },
        },
      },
    });
  };

  const drawRev = () => {
    const months = (doc.monthly || []).filter(p => p.days > 0);
    rxChart('ccRev', 'chartCcRev', 200, {
      type: 'bar',
      data: { labels: months.map(p => ccMonthLabel(p.month)), datasets: [
        { label: 'At today\'s rates', data: months.map(p => p.rev[0] * 100), backgroundColor: RX.rev, borderWidth: 0 },
      ] },
      options: {
        plugins: { tooltip: { callbacks: {
          label: ctx => ` ₹${fmtNum(ctx.raw, 2)} lakh at today's rates`,
          footer: items => {
            const p = months[items[0].dataIndex];
            return `₹${fmtNum(p.rev[1] * 100, 2)} lakh at the rules then in force · ${p.days} sessions`;
          } } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true } },
          y: { min: 0, title: { display: true, text: '₹ lakh' }, ticks: { callback: v => fmtNum(v, 0) } },
        },
      },
    });
  };

  const drawCharts = () => { drawDaily(); drawMonthly(); drawRev(); };
  drawTable();
  drawCharts();
  rxOnSeg(root, 'ccWin', v => { CC_VIEW.win = v; drawTable(); });
  rxOnSeg(root, 'ccUnd', v => { CC_VIEW.und = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccMetric', v => { CC_VIEW.metric = v; drawDaily(); drawMonthly(); });
  rxOnSeg(root, 'ccRange', v => { CC_VIEW.range = v; drawDaily(); });
  RX_TAB_REFRESH.competition = drawCharts;
}

// Under NSE's Revenue Summary: NSE's commodity charges this quarter, as a memo line kept out
// of every NSE total (NSE's revenue files hold equity F&O and cash only)
async function buildNseCommodityMemo() {
  const el = document.getElementById('nseCommodityMemo');
  if (!el) return;
  el.hidden = true;
  if (currentExchange !== 'nse') return;
  try {
    await ccLoad();
  } catch (err) {
    console.error('NSE commodity memo failed to load:', err);
    return;
  }
  if (currentExchange !== 'nse') return;
  const doc = CC_DATA.doc;
  const rows = (doc.daily || []).filter(r => !r.session);
  if (!rows.length) return;
  const last = rows[rows.length - 1].date, qk = ccQuarter(last);
  const q = rows.filter(r => ccQuarter(r.date) === qk);
  const rev = q.reduce((a, r) => a + r.rev[0], 0);
  el.textContent = `Memo, not in these totals: NSE's commodity derivatives transaction charges, ${ccQuarterLabel(qk)} to ${rxDate(last)}: `
    + `₹${fmtNum(rev * 100, 1)} lakh over ${q.length} session${q.length === 1 ? '' : 's'} (₹${fmtNum(rev * 100 / q.length, 2)} lakh a session), at today's rates. `
    + 'NSE\'s share of commodity volume against MCX is on the MCX view\'s Competition tab.';
  el.hidden = false;
}
