// dashboard/js/24-signals.js — Results Signals tab (All view).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// RESULTS SIGNALS — each listed name's activity this quarter against the
// quarter before, beside the backtest of "hold hedged into results when the
// quarter's activity rose" from Tusk's Capital Markets Signal Book (Nov 2026).
// Activity is a daily average over the quarter's sessions (daily_all, so
// Muhurat and DR-test sessions are already out): NSE+BSE measures sum the two
// exchanges on the dates both have a value, MCX uses its actual days only
// (modelled rows dropped). A quarter still trading gives a provisional reading;
// the signal is the quarter's figure on its last session. In results season
// (the first SIG_SEASON_SESSIONS sessions of a quarter) the tab opens on the
// completed quarter, whose results are then being reported. The backtest
// figures are fixed text from the Signal Book, not recomputed here.
// ========================

// Activity measures: the exchanges whose daily rows they read and the field summed
const SIG_MEASURES = {
  adr:  { label: 'NSE+BSE revenue a day', short: 'NSE+BSE ADR', exchanges: ['nse', 'bse'], field: 'total_rev', unit: 'cr' },
  fo:   { label: 'NSE+BSE F&O contracts a day', short: 'F&O contracts', exchanges: ['nse', 'bse'], field: 'total_contracts', unit: 'contracts' },
  bse:  { label: 'BSE revenue a day', short: 'BSE revenue', exchanges: ['bse'], field: 'total_rev', unit: 'cr' },
  mcx:  { label: 'MCX revenue a day', short: 'MCX revenue', exchanges: ['mcx'], field: 'total_rev', unit: 'cr' },
  cash: { label: 'NSE cash trades a day', short: 'NSE cash trades', exchanges: ['nse'], field: 'cash_trades', unit: 'count' },
};

// KPI strip and chart, in order
const SIG_HEADLINE = ['adr', 'fo', 'bse', 'mcx'];
const SIG_COLORS = { adr: RX.model, fo: '#7A5BB5', bse: RX.rev, mcx: RX.pos };

// The names the rule applies to, with the measure read for each and the Signal Book's record.
// proxy: the measure stands in for the company's own count, which the dashboard does not have yet.
// short: down quarters lost money in the backtest, so a paper short is listed too.
const SIG_NAMES = [
  { name: 'Angel One', measure: 'fo', proxy: 'Stands in for Angel One’s own F&amp;O order count (reported monthly), which is the signal and is not in the dashboard yet.',
    record: 'Own F&amp;O orders called 17 of 23 results since 2021 (74 %)',
    rule: 'Orders up: +15.1 % a trade, 13 of 16 won · down: −5.5 %, 7 of 8 lost', short: true },
  { name: 'MCX', measure: 'mcx', record: 'Called 7 of 8 results since mid-2023 (88 %)' },
  { name: 'Motilal Oswal (MOSL)', measure: 'adr', record: 'Called 9 of 13 results since 2023 (69 %)' },
  { name: 'BSE', measure: 'bse', record: 'Called 8 of 13 results since 2023 (62 %)' },
  { name: 'Groww', measure: 'adr', record: '4 results since its Nov 2025 listing: too few to score' },
  { name: 'CDSL', measure: 'cash', proxy: 'The signal is CDSL’s new demat accounts (rank corr. +0.41 over 33 results since 2018), not in the dashboard yet; NSE cash trades are the secondary measure (+0.54 over 11 results).',
    record: 'New demat accounts: rank corr. +0.41 with the results-day move over 33 results since 2018',
    rule: 'New accounts down: −5.6 % a trade, 13 of 14 lost · up: +1.8 %', short: true },
];

// Sessions into a quarter during which the previous quarter's results are still being reported
const SIG_SEASON_SESSIONS = 30;
// The chart starts at this session: a quarter's first few averages swing with single days (an expiry)
const SIG_CHART_FROM = 5;

const SIG_STATE = { seq: 0, basis: null };

// "Q3 FY 2027" → "Q2 FY 2027"; "Q1 FY 2027" → "Q4 FY 2026"
function sigPrevQuarter(label) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  if (!m) return null;
  const q = +m[1], fy = +m[2];
  return q === 1 ? `Q4 FY ${fy - 1}` : `Q${q - 1} FY ${fy}`;
}

// A quarter's last calendar day (FY 2027 runs Apr 2026 – Mar 2027)
function sigQuarterEnd(label) {
  const m = /^Q([1-4]) FY (\d{4})$/.exec(label || '');
  if (!m) return null;
  const q = +m[1], fy = +m[2];
  return [null, `${fy - 1}-06-30`, `${fy - 1}-09-30`, `${fy - 1}-12-31`, `${fy}-03-31`][q];
}

// A measure's daily series, [{ date, quarter, value }] ascending. A measure on
// two exchanges sums them on the dates both have a value; modelled rows and
// rows without the field (a count the exchange did not publish) are left out.
function sigSeries(rowsByEx, measure) {
  const m = SIG_MEASURES[measure];
  const maps = m.exchanges.map(ex => {
    const map = new Map();
    (rowsByEx[ex] || []).forEach(r => {
      if (!r || !r.date || r.modelled) return;
      const v = r[m.field];
      if (v == null || v === '' || !isFinite(v)) return;
      map.set(r.date, { v: +v, q: r.fy_quarter });
    });
    return map;
  });
  const [first, ...rest] = maps;
  const out = [];
  for (const [date, a] of first) {
    if (rest.some(mp => !mp.has(date))) continue;
    out.push({ date, quarter: a.q, value: rest.reduce((s, mp) => s + mp.get(date).v, a.v) });
  }
  return out.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
}

// `quarter`'s daily average against the quarter before's: { quarter, prev, days,
// prevDays, avg, prevAvg, chg, from, to }, or null when `quarter` has no sessions
function sigQuarterChange(series, quarter) {
  const cur = series.filter(r => r.quarter === quarter);
  if (!cur.length) return null;
  const prev = sigPrevQuarter(quarter);
  const before = series.filter(r => r.quarter === prev);
  const avg = rows => rows.length ? rows.reduce((s, r) => s + r.value, 0) / rows.length : null;
  const a = avg(cur), b = avg(before);
  return { quarter, prev, days: cur.length, prevDays: before.length, avg: a, prevAvg: b,
    chg: a != null && b ? a / b - 1 : null, from: cur[0].date, to: cur[cur.length - 1].date };
}

// The quarter's running daily average against the quarter before's average, session by session
function sigRunning(series, qc) {
  if (!qc || !qc.prevAvg) return [];
  let sum = 0;
  return series.filter(r => r.quarter === qc.quarter).map((r, i) => {
    sum += r.value;
    return { date: r.date, session: i + 1, chg: sum / (i + 1) / qc.prevAvg - 1 };
  });
}

// Which quarter the tab opens on: the completed one while its results are being
// reported (the first SIG_SEASON_SESSIONS sessions of the next), else the current one
function sigDefaultBasis(currentDays) {
  return currentDays < SIG_SEASON_SESSIONS ? 'completed' : 'current';
}

function sigValueText(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  if (unit === 'cr') return rxCr(v, 1);
  if (unit === 'contracts') return `${fmtNum(v / 1e7, 2)} Cr`;
  return `${fmtNum(v / 1e5, 1)} lakh`;
}

function sigReadingHTML(qc, name) {
  if (!qc || qc.chg == null) return rxChip('No reading');
  return qc.chg > 0 ? rxChip('Up: hold into results', 'ok')
    : rxChip(name.short ? 'Down: skip; paper short' : 'Down: skip', 'bad');
}

function sigTableHTML(qcs) {
  const rows = SIG_NAMES.map(n => {
    const m = SIG_MEASURES[n.measure], qc = qcs[n.measure];
    const measure = `${escHtml(m.label)}${n.proxy ? ` <span title="${escHtml(n.proxy.replace(/&amp;/g, '&'))}">${rxChip('proxy', 'warn')}</span>` : ''}`;
    return `<tr>
      <td><b>${escHtml(n.name)}</b></td>
      <td class="rx-hl ${qc && qc.chg > 0 ? 'rx-up' : qc && qc.chg < 0 ? 'rx-dn' : ''}">${qc ? rxSignedPct(qc.chg) : '—'}</td>
      <td class="rx-l">${sigReadingHTML(qc, n)}</td>
      <td>${qc ? sigValueText(qc.prevAvg, m.unit) : '—'}</td>
      <td>${qc ? sigValueText(qc.avg, m.unit) : '—'}</td>
      <td class="rx-l">${measure}</td>
      <td class="rx-wrap">${n.record}${n.rule ? `<br><span class="rx-src">${n.rule}</span>` : ''}</td>
    </tr>`;
  }).join('');
  const any = Object.values(qcs).find(Boolean);
  return `<div class="rx-scroll"><table class="rx-table">
    <thead><tr><th scope="col">Company</th>
      <th scope="col" class="rx-hl" title="(this quarter − the quarter before) ÷ the quarter before, on daily averages">Change</th>
      <th scope="col" class="rx-l">Reading</th>
      <th scope="col" title="Daily average over the quarter before">${escHtml(any ? any.prev : 'Previous quarter')}</th>
      <th scope="col" title="Daily average over the quarter's sessions so far">${escHtml(any ? any.quarter : 'Quarter')}</th>
      <th scope="col" class="rx-l">Activity measure</th><th scope="col" class="rx-l">Backtest record</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function sigHowHTML() {
  return rxHow('How this is read', `
    <p><b>The rule.</b> Hold the stock and short Nifty futures at its rolling 250-day beta from the close 10 sessions before its results to the close of the session after, only when the quarter's activity rose against the quarter before. Since 2023, on the exchange-activity names (BSE, MCX, MOSL, Groww): <b>+6.1 % a trade after costs, 73 % won, t 3.2, 30 trades</b>. A quarter's NSE+BSE revenue change called the direction of the results-day move in 64 % of 50 results since 2023 (rank corr. +0.48).</p>
    <ul>
      <li><b>A regime, not a law.</b> Rebuilt back to 2017, BSE's and MCX's activity did not call their results before mid-2023 (40 results, direction right 40 %). The link dates from when F&amp;O transaction revenue came to dominate both exchanges' earnings; stop using it if it fails for two seasons running.</li>
      <li><b>Angel One and CDSL</b> are read on their own counts in the backtest (F&amp;O orders; new demat accounts), which are not in this dashboard yet, so their rows show a proxy. For both, down quarters lost money, so a paper short is listed when the reading is down.</li>
      <li><b>Provisional until the quarter ends.</b> The signal is the quarter's daily average on its last session; a reading partway through can still turn. Results dates are not in the dashboard: confirm each board meeting before the entry date.</li>
      <li>Daily averages are over the quarter's sessions; NSE+BSE measures use the dates both exchanges have, MCX its actual (not modelled) days, and Muhurat and DR-test sessions are left out. NSE and BSE revenue is at today's rates, as everywhere on the dashboard.</li>
      <li>Source of the backtest figures: Tusk's Capital Markets Signal Book (November 2026). They are fixed text, not recomputed from these files.</li>
    </ul>`);
}

async function buildSignals() {
  const el = document.getElementById('signalsContent');
  if (!el) return;
  const seq = ++SIG_STATE.seq, ex = currentExchange;
  // A single-exchange view has its own file in DATA; the rest come from the shared cache
  const own = VIEW_LOADED && !DATA.components ? VIEW_LOADED.exchange : null;
  const cached = ['nse', 'bse', 'mcx'].filter(e => e !== own);
  if (cached.some(e => !MARKET_RAW[e])) el.innerHTML = `<div class="rx">${rxPanel({ title: 'Results signals', body: '<div class="rx-empty"><b>Loading NSE, BSE and MCX data…</b></div>' })}</div>`;
  await ensureFreshMarketData(cached);
  if (seq !== SIG_STATE.seq || currentExchange !== ex) return;   // rebuilt or switched away while loading
  const rowsByEx = {};
  ['nse', 'bse', 'mcx'].forEach(e => { rowsByEx[e] = (rawFor(e) || {}).daily_all || null; });
  if (!rowsByEx.nse || !rowsByEx.bse) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Results signals', body: '<div class="rx-empty"><b>Couldn\'t load NSE and BSE data</b>Try again in a moment.</div>' })}</div>`;
    return;
  }
  cached.forEach(e => { VIEW_BUILT_FROM[e] = marketSig(e); });
  VIEW_SOURCES.signals = ['nse', 'bse', 'mcx'].filter(e => rowsByEx[e]).map(e => ({ ex: e, date: lastTradeDate(rowsByEx[e]) }));
  updateSnapshotNotice();

  const series = {};
  Object.keys(SIG_MEASURES).forEach(k => { series[k] = sigSeries(rowsByEx, k); });
  const adr = series.adr;
  if (!adr.length) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Results signals', body: '<div class="rx-empty"><b>No sessions with both NSE and BSE data</b></div>' })}</div>`;
    return;
  }
  const latestQ = adr[adr.length - 1].quarter;
  const completedQ = sigPrevQuarter(latestQ);
  if (!SIG_STATE.basis) SIG_STATE.basis = sigDefaultBasis(adr.filter(r => r.quarter === latestQ).length);

  const render = () => {
    const quarter = SIG_STATE.basis === 'completed' ? completedQ : latestQ;
    const provisional = quarter === latestQ;
    const qcs = {};
    Object.keys(SIG_MEASURES).forEach(k => { qcs[k] = sigQuarterChange(series[k], quarter); });
    const head = qcs.adr;
    const end = sigQuarterEnd(quarter);
    const kpis = rxKpis(SIG_HEADLINE.map((k, i) => {
      const qc = qcs[k], m = SIG_MEASURES[k];
      return rxKpi(escHtml(m.short), qc ? rxChangeHTML(qc.chg) : '—',
        qc ? `${sigValueText(qc.avg, m.unit)} a day vs ${sigValueText(qc.prevAvg, m.unit)} in ${escHtml(qc.prev)} · ${qc.days} sessions` : 'no sessions',
        { accent: i === 0 });
    }), `${quarter} against ${sigPrevQuarter(quarter)}`);
    const status = provisional
      ? `${rxChip(`${escHtml(quarter)} to date`, 'data')} ${rxChip(`provisional until ${escHtml(rxDate(end))}`, 'warn')}`
      : `${rxChip(`${escHtml(quarter)}, complete`, 'data')} ${rxChip('results season', 'ok')}`;
    el.innerHTML = `<div class="rx">
      <div class="rx-bar" style="position:static">
        <div class="rx-grp">${status}</div>
        ${rxSeg('sigBasis', [['current', `${escHtml(latestQ)} to date`], ['completed', `${escHtml(completedQ)} (complete)`]], SIG_STATE.basis, 'Quarter')}
        <p class="rx-foot">Activity a day, ${escHtml(quarter)} against ${escHtml(head ? head.prev : sigPrevQuarter(quarter))} · data to ${escHtml(rxDate(head ? head.to : ''))}</p>
      </div>
      ${kpis}
      ${rxPanel({ title: 'Hold into results when activity rose', meta: `${escHtml(quarter)} against ${escHtml(sigPrevQuarter(quarter))} · daily averages`,
        body: sigTableHTML(qcs),
        foot: 'Up: hold the stock hedged with Nifty futures from 10 sessions before results to the session after. Down: skip; for Angel One and CDSL, whose down quarters lost money, also note a paper short. Hover a proxy chip for what the signal really counts.',
        how: sigHowHTML() })}
      ${rxPanel({ title: 'The quarter so far against the quarter before', meta: '<span data-sig="meta"></span>',
        body: `${rxCanvas('chartSignalsRunning')}<div class="rx-pb" data-sig="legend"></div>`,
        foot: `Each line: the quarter's daily average up to that session, against the quarter before's daily average, from the ${SIG_CHART_FROM}th session (the first few swing with single days, such as an expiry). Where a line ends above zero, the quarter is running ahead.` })}
    </div>`;
    const root = el.firstElementChild;
    rxOnSeg(root, 'sigBasis', v => { SIG_STATE.basis = v; render(); });

    const all = SIG_HEADLINE.map(k => ({ k, rows: sigRunning(series[k], qcs[k]) })).filter(l => l.rows.length);
    const n = Math.max(0, ...all.map(l => l.rows.length));
    // From SIG_CHART_FROM once the quarter has that many sessions
    const from = n >= SIG_CHART_FROM ? SIG_CHART_FROM : 1;
    const lines = all.map(l => ({ k: l.k, rows: l.rows.filter(r => r.session >= from) }));
    const meta = root.querySelector('[data-sig="meta"]');
    if (meta) meta.textContent = `${quarter} · sessions ${from} to ${n}`;
    root.querySelector('[data-sig="legend"]').innerHTML = rxLegend(lines.map(l => ({ label: SIG_MEASURES[l.k].short, color: SIG_COLORS[l.k], kind: 'line' })));
    const draw = () => {
      rxChart('sigRunning', 'chartSignalsRunning', 260, {
        type: 'line',
        data: { labels: Array.from({ length: n - from + 1 }, (_, i) => String(i + from)), datasets: lines.map(l => ({
          label: SIG_MEASURES[l.k].short, data: l.rows.map(r => r.chg * 100),
          borderColor: SIG_COLORS[l.k], backgroundColor: SIG_COLORS[l.k], borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0 })) },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: { tooltip: { callbacks: {
            title: items => `Session ${items[0].dataIndex + from}`,
            label: ctx => { const r = lines[ctx.datasetIndex].rows[ctx.dataIndex];
              return r ? ` ${ctx.dataset.label}: ${rxSignedPct(r.chg)} · to ${rxDate(r.date)}` : ''; } } } },
          scales: {
            x: { grid: { display: false }, title: { display: true, text: `Sessions into ${quarter}` }, ticks: { maxTicksLimit: 8, maxRotation: 0, autoSkip: true } },
            y: { grace: '6%', title: { display: true, text: `% against ${sigPrevQuarter(quarter)}` }, ticks: { includeBounds: false, callback: v => `${v > 0 ? '+' : ''}${fmtNum(v, 0)} %` } },
          },
        },
      });
    };
    draw();
    RX_TAB_REFRESH.signals = draw;
  };
  render();
}
