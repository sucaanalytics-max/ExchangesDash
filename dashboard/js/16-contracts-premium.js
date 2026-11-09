// dashboard/js/16-contracts-premium.js — Contracts to Premium tab (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// CONTRACTS TO PREMIUM (NSE + BSE combined) — option contracts traded per
// ₹ 1 Cr of option premium, market-wide:
//   (NSE index + stock option contracts + BSE contracts) ÷ (NSE index + stock
//   option premium + BSE options premium)
// from each exchange's daily_all. Contracts and premium are volumes, not fees,
// so the figures are the same under either Fees setting, and the exchange
// switcher does not change them: the tab shows the same view under NSE, BSE,
// NSE+BSE and All. Periods are Σ contracts ÷ Σ premium, never a mean of daily
// ratios, so a heavy expiry day weighs what it traded.
// ========================

const CP_MA_WINDOW = 20;   // trading days in the chart's rolling ratio
const CP_RANGES = [['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24], ['all', 'All', null]];
const CP_EXP_COLOR = '#D39A6E';   // RX.above: expiry-day dots, as on Brokers → F&O vs Exchanges
const CP_VIEW = { range: '1y' };
let cpBuildSeq = 0;   // latest build; an older one still loading yields to it

// One row per date on which both exchanges traded options (contracts and premium
// > 0 on each side), joined by date. `excluded` lists every other date in either
// file with the side that had no options data ('nse', 'bse' or 'both'): BSE has
// gaps before mid-May 2023. Muhurat / DR sessions are already outside daily_all.
function contractsPremiumDaily(nseRows, bseRows) {
  const nse = new Map((nseRows || []).map(r => [r.date, r]));
  const bse = new Map((bseRows || []).map(r => [r.date, r]));
  const dates = [...new Set([...nse.keys(), ...bse.keys()])].sort();
  const days = [], excluded = [];
  dates.forEach(date => {
    const n = nse.get(date), b = bse.get(date);
    const nC = n ? (n.io_contracts || 0) + (n.so_contracts || 0) : 0;
    const nP = n ? (n.io_premium || 0) + (n.so_premium || 0) : 0;
    const bC = b ? b.total_contracts || 0 : 0;
    const bP = b ? b.options_premium_turnover || 0 : 0;
    const nseOk = nC > 0 && nP > 0, bseOk = bC > 0 && bP > 0;
    if (!nseOk || !bseOk) {
      excluded.push({ date, missing: !nseOk && !bseOk ? 'both' : nseOk ? 'bse' : 'nse' });
      return;
    }
    const contracts = nC + bC, premium = nP + bP;
    days.push({ date, fy: n.fy || b.fy, fy_quarter: n.fy_quarter || b.fy_quarter, fy_month: n.fy_month || b.fy_month,
      contracts, premium, ratio: contracts / premium });
  });
  return { days, excluded };
}

// Labels `n` periods before a FY / quarter / month label, by arithmetic on the
// label (quarterSortKey / monthSortKey), so a period the data lacks shows as
// empty rather than as its neighbour. "Q1 FY 2027" − 1 → "Q4 FY 2026".
function cpFYBack(label, n) {
  const m = /^FY\s+(\d+)$/.exec(label || '');
  return m ? `FY ${+m[1] - n}` : null;
}

function cpQuarterBack(label, n) {
  const k = quarterSortKey(label || '');
  if (!k) return null;
  const idx = Math.floor(k / 10) * 4 + (k % 10 - 1) - n;
  return `Q${idx % 4 + 1} FY ${Math.floor(idx / 4)}`;
}

function cpMonthBack(label, n) {
  const k = monthSortKey(label || '');
  if (!k || !(k % 100)) return null;
  const idx = Math.floor(k / 100) * 12 + (k % 100 - 1) - n;
  const name = Object.keys(FY_MONTH_ORDER).find(mo => FY_MONTH_ORDER[mo] === idx % 12 + 1);
  return `FY ${Math.floor(idx / 12)} ${name}`;
}

// Σ contracts ÷ Σ premium of some days; null ratio without any
function cpTotals(rows) {
  const contracts = rows.reduce((a, r) => a + r.contracts, 0);
  const premium = rows.reduce((a, r) => a + r.premium, 0);
  return { days: rows.length, contracts, premium, ratio: premium > 0 ? contracts / premium : null,
    from: rows.length ? rows[0].date : null, to: rows.length ? rows[rows.length - 1].date : null };
}

// The period table, mirroring Revenue Summary: groups of rows, the first of each
// group the current period. Each row: { label, role, toDate, days, contracts,
// premium, ratio, from, to, chg }, where chg is the current period's ratio against
// this row's, (current − row) ÷ row, as Revenue Summary's % chg (null on the
// current row). Periods run to the last day on or before `today` (default: the
// last day of `daily`).
function contractsPremiumPeriods(daily, today) {
  const rows = today ? (daily || []).filter(r => r.date <= today) : (daily || []);
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const period = (field, label, role) => ({ label, role, toDate: role === 'current',
    ...cpTotals(label ? rows.filter(r => r[field] === label) : []) });
  const tail = (from, to, label, role) => ({ label, role, toDate: false,
    ...cpTotals(rows.slice(Math.max(0, rows.length + from), to == null ? rows.length : Math.max(0, rows.length + to))) });
  const groups = [
    { kind: 'fy', title: 'Financial year', rows: [
      period('fy', last.fy, 'current'),
      period('fy', cpFYBack(last.fy, 1), 'previous'),
    ] },
    { kind: 'quarter', title: 'Quarter', rows: [
      period('fy_quarter', last.fy_quarter, 'current'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 1), 'previous'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 2), 'before'),
      period('fy_quarter', cpQuarterBack(last.fy_quarter, 4), 'last_year'),
    ] },
    { kind: 'month', title: 'Month', rows: [
      period('fy_month', last.fy_month, 'current'),
      period('fy_month', cpMonthBack(last.fy_month, 1), 'previous'),
      period('fy_month', cpMonthBack(last.fy_month, 2), 'before'),
    ] },
    { kind: 'days', title: 'Trading days', rows: [
      tail(-5, null, 'Last 5 days', 'last5'),
      tail(-10, -5, 'Previous 5 days', 'prev5'),
      tail(-45, null, 'Last 45 days', 'last45'),
    ] },
  ];
  groups.forEach(g => {
    const cur = g.rows[0].ratio;
    g.rows.forEach((r, i) => { r.chg = i > 0 && cur != null && r.ratio ? (cur - r.ratio) / r.ratio : null; });
  });
  return groups;
}

// Σ contracts ÷ Σ premium over the `win` days to each day (the period table's
// basis); null until `win` days are in
function contractsPremiumRolling(days, win) {
  let sc = 0, sp = 0;
  return days.map((r, i) => {
    sc += r.contracts; sp += r.premium;
    if (i >= win) { sc -= days[i - win].contracts; sp -= days[i - win].premium; }
    return i >= win - 1 && sp > 0 ? sc / sp : null;
  });
}

// Rolling 6 M / 1 Y / … start, or null for all days
function cpRangeStart(lastDate, range) {
  const months = (CP_RANGES.find(r => r[0] === range) || CP_RANGES[1])[2];
  if (months == null) return null;
  const d = new Date(lastDate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

function cpRatioText(v) { return v == null || !isFinite(v) ? '—' : fmtNum(v, 0); }
function cpContractsCr(v) { return v == null || !isFinite(v) ? '—' : fmtNum(v / 1e7, 2); }

function cpPeriodTableHTML(groups) {
  const body = groups.map(g => `<tbody>
      <tr><th scope="rowgroup" colspan="6" class="rx-l">${g.title}</th></tr>
      ${g.rows.map((r, i) => {
        const tag = r.toDate ? ` ${rxChip('to date')}` : '';
        const span = r.days ? ` title="${escHtml(rxDate(r.from) + ' to ' + rxDate(r.to))}"` : '';
        return `<tr${i === 0 ? ' class="rx-sub"' : ''}>
          <td${span}>${escHtml(r.label || '—')}${tag}</td>
          <td class="rx-hl">${cpRatioText(r.ratio)}</td>
          <td>${i === 0 ? '' : rxSignedPct(r.chg)}</td>
          <td>${r.days || '—'}</td>
          <td>${r.days ? cpContractsCr(r.contracts) : '—'}</td>
          <td>${r.days ? fmtNum(r.premium, 0) : '—'}</td>
        </tr>`;
      }).join('')}
    </tbody>`).join('');
  return `<div class="rx-scroll"><table class="rx-table">
    <thead><tr><th scope="col">Period</th>
      <th scope="col" class="rx-hl" title="Σ contracts ÷ Σ premium (₹ Cr)">Contracts per ₹ Cr</th>
      <th scope="col" title="The current period's contracts per ₹ Cr against this row's: (current − row) ÷ row">% chg</th>
      <th scope="col" title="Trading days with both exchanges' options data">Days</th>
      <th scope="col" title="NSE + BSE option contracts, crore">Contracts, Cr</th><th scope="col" title="NSE + BSE option premium">Premium, ₹ Cr</th></tr></thead>
    ${body}
  </table></div>`;
}

function cpHowHTML(excluded) {
  const bseGaps = excluded.filter(e => e.missing !== 'nse');
  return rxHow('How this is measured', `
    <p><b>Contracts per ₹ 1 Cr of premium</b> = (NSE index option contracts + NSE stock option contracts + BSE contracts) ÷ (NSE index option premium + NSE stock option premium + BSE options premium turnover), with premium in ₹ Cr. It is the inverse of the average premium paid per contract: it rises when trading moves to cheap, far-from-the-money or near-expiry options.</p>
    <ul>
      <li>NSE counts options only (index and stock options). BSE's contract count is its F&amp;O total, which includes BSE's very small futures volume.</li>
      <li>Brokers → F&amp;O vs Exchanges plots a similar ratio from NSE's total F&amp;O contracts (futures included), so its figure runs slightly higher than this one.</li>
      <li>Periods divide the period's total contracts by its total premium, not the average of daily ratios, so a heavy expiry day counts for what it traded. The chart's line is the same ratio over the last ${CP_MA_WINDOW} trading days.</li>
      <li>Only days on which both exchanges report options contracts and premium count${excluded.length ? `: ${excluded.length} day${excluded.length === 1 ? '' : 's'} left out${bseGaps.length ? `, ${bseGaps.length === excluded.length ? 'all' : bseGaps.length} with no BSE options data (${rxDate(bseGaps[0].date)} to ${rxDate(bseGaps[bseGaps.length - 1].date)})` : ''}` : ''}. Muhurat and DR-test sessions are left out, as everywhere on the dashboard.</li>
      <li>Contracts and premium are traded volumes, not fees: the Fees setting does not change any figure here, and the exchange switcher shows the same combined view.</li>
    </ul>`);
}

async function buildContractsPremium() {
  const el = document.getElementById('contractsPremiumContent');
  if (!el) return;
  const seq = ++cpBuildSeq, ex = currentExchange;
  // A single NSE or BSE view has its own file in DATA; the other comes from the shared cache
  const own = VIEW_LOADED && !DATA.components ? VIEW_LOADED.exchange : null;
  const cached = ['nse', 'bse'].filter(e => e !== own);
  if (cached.some(e => !MARKET_RAW[e])) el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>Loading NSE and BSE data…</b></div>' })}</div>`;
  await ensureFreshMarketData(cached);
  if (seq !== cpBuildSeq || currentExchange !== ex) return;   // rebuilt or switched away while loading
  const nseRaw = rawFor('nse'), bseRaw = rawFor('bse');
  if (!nseRaw?.daily_all || !bseRaw?.daily_all) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>Couldn\'t load NSE and BSE data</b>Try again in a moment.</div>' })}</div>`;
    return;
  }
  cached.forEach(e => { VIEW_BUILT_FROM[e] = marketSig(e); });
  VIEW_SOURCES.contracts = [{ ex: 'nse', date: lastTradeDate(nseRaw.daily_all) }, { ex: 'bse', date: lastTradeDate(bseRaw.daily_all) }];
  updateSnapshotNotice();

  const { days, excluded } = contractsPremiumDaily(nseRaw.daily_all, bseRaw.daily_all);
  if (!days.length) {
    el.innerHTML = `<div class="rx">${rxPanel({ title: 'Contracts to premium', body: '<div class="rx-empty"><b>No days with both NSE and BSE options data</b></div>' })}</div>`;
    return;
  }
  const groups = contractsPremiumPeriods(days);
  const last = days[days.length - 1];
  const month = groups.find(g => g.kind === 'month').rows, tail = groups.find(g => g.kind === 'days').rows;
  // Expiry days: each exchange's weekly benchmark expiry (Nifty, Sensex), as Revenue Summary counts them
  const exp = new Set([...expiryDateSet(nseRaw.daily_all, 'nse'), ...expiryDateSet(bseRaw.daily_all, 'bse')]);

  const leftOut = excluded.length
    ? `<span title="${escHtml(`Dates without options contracts and premium on both exchanges, ${rxDate(excluded[0].date)} to ${rxDate(excluded[excluded.length - 1].date)}`)}">${rxChip(`${excluded.length} day${excluded.length === 1 ? '' : 's'} left out`, 'warn')}</span>` : '';
  const kpis = rxKpis([
    rxKpi(`Latest day · ${escHtml(rxDate(last.date))}`, cpRatioText(last.ratio),
      `${cpContractsCr(last.contracts)} Cr contracts · ₹${fmtNum(last.premium, 0)} Cr premium${exp.has(last.date) ? ' · expiry day' : ''}`, { accent: true }),
    rxKpi(`Current month · ${escHtml(month[0].label)}`, cpRatioText(month[0].ratio),
      `${month[0].days} days · vs ${escHtml(month[1].label || 'previous month')} ${rxSignedPct(month[1].chg)}`),
    rxKpi('Last 45 days', cpRatioText(tail[2].ratio),
      `${escHtml(rxDate(tail[2].from))} to ${escHtml(rxDate(tail[2].to))} · last 5 days vs it ${rxSignedPct(tail[2].chg)}`),
  ], 'Contracts per ₹ Cr of premium');

  el.innerHTML = `<div class="rx">
    <div class="rx-bar" style="position:static">
      <div class="rx-grp">${rxChip('NSE + BSE combined', 'data')} ${rxChip('Not fee-dependent')} ${leftOut}</div>
      <p class="rx-foot">Option contracts per ₹ 1 Cr of option premium · data to ${escHtml(rxDate(last.date))}</p>
    </div>
    ${kpis}
    ${rxPanel({ title: 'Contracts per ₹ Cr of premium', meta: '<span data-cp="meta"></span>',
      right: rxSeg('cpRange', CP_RANGES.map(r => [r[0], r[1]]), CP_VIEW.range, 'Chart range'),
      body: `${rxCanvas('chartContractsPremium')}<div class="rx-pb" data-cp="legend"></div>`,
      foot: `Dots: single days (orange: an NSE or BSE weekly expiry, when contracts jump and premium per contract falls). Line: Σ contracts ÷ Σ premium over the last ${CP_MA_WINDOW} trading days.` })}
    ${rxPanel({ title: 'By period', meta: 'Σ contracts ÷ Σ premium · NSE + BSE options',
      body: cpPeriodTableHTML(groups),
      foot: 'Contracts in crore (10 million); premium in ₹ Cr. % chg: the current period of each kind against that row, (current − row) ÷ row; for the trading-day rows, the last 5 days against each. Hover a period for its dates.',
      how: cpHowHTML(excluded) })}
  </div>`;
  const root = el.firstElementChild;

  const roll = contractsPremiumRolling(days, CP_MA_WINDOW);
  const draw = () => {
    const start = cpRangeStart(last.date, CP_VIEW.range);
    const first = start ? Math.max(0, days.findIndex(r => r.date >= start)) : 0;
    const rows = days.slice(first), line = roll.slice(first), dates = rows.map(r => r.date);
    const meta = root.querySelector('[data-cp="meta"]');
    if (meta) meta.textContent = `${rxDate(rows[0].date)} to ${rxDate(last.date)} · ${rows.length} days`;
    rxChart('cpRatio', 'chartContractsPremium', 280, {
      type: 'line',
      data: { labels: dates.map(fmtChartDate), datasets: [
        { label: `${CP_MA_WINDOW}-day ratio`, data: line, borderColor: RX.model, borderWidth: 2.25, pointRadius: 0, tension: 0, spanGaps: false, order: 0 },
        { label: 'Day', data: rows.map(r => r.ratio), showLine: false, pointRadius: rows.length > 300 ? 1.6 : 2.2, pointHoverRadius: 4,
          pointBackgroundColor: rows.map(r => exp.has(r.date) ? CP_EXP_COLOR : RX.light), pointBorderWidth: 0, order: 1 },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: { callbacks: {
          title: items => `${rxDate(dates[items[0].dataIndex])}${exp.has(dates[items[0].dataIndex]) ? ' · expiry day' : ''}`,
          label: ctx => ` ${ctx.dataset.label}: ${cpRatioText(ctx.raw)}`,
          footer: items => { const r = rows[items[0].dataIndex]; return `${cpContractsCr(r.contracts)} Cr contracts · ₹${fmtNum(r.premium, 0)} Cr premium`; } } } },
        scales: {
          x: { grid: { display: false }, afterBuildTicks: brkMonthTicks(dates, 7), ticks: { maxTicksLimit: 7, maxRotation: 0, autoSkip: true } },
          y: { grace: '4%', title: { display: true, text: 'Contracts per ₹ Cr' }, ticks: { includeBounds: false, callback: v => fmtNum(v, 0) } },
        },
      },
    });
  };
  root.querySelector('[data-cp="legend"]').innerHTML = rxLegend([
    { label: `${CP_MA_WINDOW}-day ratio`, color: RX.model, kind: 'line' },
    { label: 'Expiry day (NSE or BSE)', color: CP_EXP_COLOR }, { label: 'Other day', color: RX.light },
  ]);
  draw();
  rxOnSeg(root, 'cpRange', v => { CP_VIEW.range = v; draw(); });
  RX_TAB_REFRESH.contracts = draw;
}
