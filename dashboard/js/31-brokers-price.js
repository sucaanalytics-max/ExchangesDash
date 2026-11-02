// dashboard/js/31-brokers-price.js — Brokers → Price vs ADR: each broker's share
// price against a moving average (DMA) of its published daily ADR.
// - Price ÷ ADR-DMA over the chosen period, with its mean and ±1σ / ±2σ bands.
// - The regression of price on ADR-DMA by ExchangesDash's own method
//   (computeShareModel in js/13-regression.js: one-session lag, Newey-West t,
//   holdout, fair-value gate), for the chosen period and, in a table, every period.
// ADR is the engine's sb_daily_revenue summed per day; prices are sb_share_prices
// `close` (split- and bonus-adjusted, not dividend-adjusted: dividends have nothing
// to do with ADR). A DMA that includes a projected day is drawn but kept
// out of the bands and the fit, as computeShareModel does for modelled days.

const BRK_PRICE_DMAS = [20, 30, 45, 60];
const BRK_PRICE_PERIODS = [['3m', '3 M', 3], ['6m', '6 M', 6], ['1y', '1 Y', 12], ['2y', '2 Y', 24], ['3y', '3 Y', 36], ['5y', '5 Y', 60]];
// A period counts as covered when the first paired day is at most this many days after its start
const BRK_PRICE_SLACK_DAYS = 10;

// period: until one is picked, 1 Y or the longest period the data covers
BRK.priceView = { basis: 'cons', dma: 45, custom: false, period: '1y', picked: false };

function brkPriceBases() {
  const net = BRK_BROKER_BASIS[BRK_BROKER.id];
  return [['cons', net ? 'Consolidated (net)' : 'Consolidated'], ['broking', net ? 'Broking (net)' : 'Broking'],
    ['mtf', (BRK.daily?.rows || []).some(r => r.segment === 'mtf_nii') ? 'MTF (NII)' : 'MTF']];
}

// Daily ADR of a basis from the run's sb_daily_revenue rows. A day counts once every
// segment of the basis has a row; commodities count as zero before their first
// published day (Groww started them later). The series starts once the other
// segments are all published and ends at the last day every segment has (MTF
// stops earlier than the rest when its source is late).
function brkAdrSeries(daily, basis) {
  const mtf = daily.some(r => r.segment === 'mtf_nii') ? 'mtf_nii' : 'mtf_gross';
  const segs = basis === 'mtf' ? [mtf] : basis === 'broking' ? ['fo', 'cash', 'comm'] : ['fo', 'cash', 'comm', mtf];
  const by = Object.fromEntries(segs.map(s => [s, new Map()]));
  daily.forEach(r => { if (by[r.segment] && r.revenue_cr != null) by[r.segment].set(r.trade_date, r); });
  const days = s => [...by[s].keys()].sort();
  const required = segs.filter(s => s !== 'comm');
  if (required.some(s => !by[s].size)) return { rows: [], segs };
  const start = required.map(s => days(s)[0]).sort().pop();
  const end = segs.filter(s => by[s].size).map(s => days(s).slice(-1)[0]).sort()[0];
  const commFirst = by.comm && by.comm.size ? days('comm')[0] : null;
  const rows = [];
  [...new Set(required.flatMap(days))].sort().forEach(d => {
    if (d < start || d > end || required.some(s => !by[s].has(d))) return;
    if (commFirst && d >= commFirst && !by.comm.has(d)) return;
    const parts = segs.map(s => by[s].get(d)).filter(Boolean);
    rows.push({ date: d, revenue_cr: parts.reduce((a, r) => a + r.revenue_cr, 0), modelled: parts.some(r => r.regime !== 'actual') });
  });
  return { rows, segs, start, end };
}

// "2026-10-30" minus n months
function brkMonthsBack(iso, months) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

// The model for one period: { status: 'ok', model, start, view } or { status: 'short', from }
function brkPriceModel(adr, prices, dma, months) {
  if (!adr.rows.length || !prices.length) return { status: 'short', from: null };
  // A close is paired with the ADR-DMA of the session before it, so prices stop one session after the ADR does
  const lastRev = adr.rows[adr.rows.length - 1].date;
  const next = prices.find(p => p.date > lastRev);
  const px = prices.filter(p => p.date <= lastRev || (next && p.date === next.date));
  if (!px.length) return { status: 'short', from: null };
  const start = brkMonthsBack(px[px.length - 1].date, months);
  const model = computeShareModel({ series: px, regression_start: start, revenue_daily: adr.rows }, dma, 0);
  const first = model && model.series.length ? model.series[0].date : null;
  const slack = new Date(start + 'T00:00:00Z');
  slack.setUTCDate(slack.getUTCDate() + BRK_PRICE_SLACK_DAYS);
  if (!model || !first || first > slack.toISOString().slice(0, 10)) return { status: 'short', from: first };
  return { status: 'ok', model, start, view: model.series.filter(r => r.date >= start) };
}

async function buildBrokersPrice() {
  const el = brkSection('price'), summary = BRK.summary, st = BRK.priceView;
  if (!summary.run) { el.innerHTML = `<div class="brk-wrap">${brkRunBar()}${brkNoRunHTML()}</div>`; return; }
  if (!BRK.daily || !BRK.prices) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading daily ADR and share prices…</div></div>';
    let daily, prices;
    try {
      [daily, prices] = await Promise.all([BRK.daily || brkFetch('daily', BRK.mode), BRK.prices || brkFetch('prices', BRK.mode)]);
    } catch (err) { el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load prices: ${escHtml(err.message)}</div></div>`; return; }
    if (BRK.summary !== summary) return;   // the broker or run changed meanwhile
    BRK.daily = daily; BRK.prices = prices;
  }
  const view = BRK_BROKER.view, name = escHtml(BRK_BROKER.name);
  const prices = BRK.prices.prices.filter(p => p.close > 0).map(p => ({ date: p.trade_date, price: p.close }));
  if (!prices.length) {
    el.innerHTML = `<div class="brk-wrap">${brkRunBar()}<div class="chart-panel brk-norun" role="status">
      <b>No share prices published for ${name} yet.</b>
      <p>The brokers-dashboard engine stores daily closes in <code>sb_share_prices</code>; this tab fills in once it has ${name}'s (ticker ${escHtml(BRK_BROKER.id)}).</p></div></div>`;
    return;
  }
  const bases = brkPriceBases();
  const basisLabel = bases.find(b => b[0] === st.basis)[1];
  const adr = brkAdrSeries(BRK.daily.rows, st.basis);
  const dma = st.dma;
  if (!st.picked) {
    const covered = BRK_PRICE_PERIODS.filter(p => p[2] <= 12 && brkPriceModel(adr, prices, dma, p[2]).status === 'ok');
    st.period = covered.length ? covered[covered.length - 1][0] : '1y';
  }
  const res = brkPriceModel(adr, prices, dma, BRK_PRICE_PERIODS.find(p => p[0] === st.period)[2]);
  const periodLabel = BRK_PRICE_PERIODS.find(p => p[0] === st.period)[1];
  const id = s => `brk-${view}-price-${s}`;

  const controls = `<div class="brk-price-controls">
    <div><div class="rx-lbl">ADR</div>${rxSeg('brkBasis', bases, st.basis, 'ADR basis')}</div>
    <div><div class="rx-lbl">DMA, trading days</div>${rxSeg('brkDma', BRK_PRICE_DMAS.map(n => [String(n), String(n)]).concat([['custom', 'Custom']]), st.custom ? 'custom' : String(dma), 'DMA window')}
      ${st.custom ? `<input class="rx-in rx-num-in brk-dma-in" type="number" min="2" max="250" step="1" value="${dma}" aria-label="Custom DMA, trading days" data-brk-dma>` : ''}</div>
    <div><div class="rx-lbl">Period</div>${rxSeg('brkPeriod', BRK_PRICE_PERIODS.map(p => [p[0], p[1]]), st.period, 'Period')}</div>
  </div>
  <p class="rx-foot brk-price-foot">ADR: ${escHtml(basisLabel)}, the engine's published daily figures (${adr.segs.map(s => ({ fo: 'F&O', cash: 'cash', comm: 'commodities', mtf_gross: 'MTF gross', mtf_nii: 'MTF NII' })[s]).join(' + ')})${adr.end ? `, ${escHtml(fmtLongDate(adr.start))} to ${escHtml(fmtLongDate(adr.end))}` : ''}. Each close is paired with the ${dma}-day ADR average to the session before. Days in a DMA that includes a projected day are drawn faint and left out of the bands and the fit.</p>`;

  // Relationship in every period: one row per horizon
  const horizons = BRK_PRICE_PERIODS.map(([k, label, months]) => {
    const r = brkPriceModel(adr, prices, dma, months);
    if (r.status !== 'ok') return `<tr><td class="rx-l">${label}</td><td colspan="6" class="rx-l rx-foot">insufficient history${r.from ? ` (paired data from ${escHtml(fmtLongDate(r.from))})` : ''}</td></tr>`;
    const m = r.model, t = m.meth.t_stat_newey_west;
    return `<tr${k === st.period ? ' class="rx-out"' : ''}><td class="rx-l">${label}</td><td>${fmtNum(m.n, 0)}</td><td>${fmtNum(m.reg.slope, 2)}</td><td>${fmtNum(m.reg.intercept, 1)}</td>
      <td>${fmtNum(m.reg.r_squared, 2)}</td><td>${t == null ? '—' : t.toFixed(2)}</td><td class="rx-l">${m.meth.fair_value_supported ? rxChip('Supported', 'ok') : rxChip('Not supported', 'warn')}</td></tr>`;
  }).join('');
  const horizonPanel = rxPanel({ title: 'Relationship by period', meta: `price = intercept + slope × ADR-DMA${dma} · ${escHtml(basisLabel)}`,
    body: `<div class="rx-scroll"><table class="rx-table"><thead><tr><th scope="col" class="rx-l">Period</th><th scope="col">Sessions</th><th scope="col">Slope, ₹ per ₹ Cr</th><th scope="col">Intercept, ₹</th><th scope="col">R²</th><th scope="col">Newey-West t</th><th scope="col" class="rx-l">Fair value</th></tr></thead><tbody>${horizons}</tbody></table></div>`,
    foot: 'A fair value is published only when ExchangesDash\'s gate passes: ≥ 60 sessions, a positive slope with Newey-West t ≥ 2, and an ADR-DMA that moved ≥ 10 % over the period.' });

  if (res.status !== 'ok') {
    el.innerHTML = `<div class="brk-wrap">${brkRunBar()}<div class="rx">${controls}
      ${rxAlert(`<strong>Insufficient history for ${periodLabel}.</strong> ${res.from ? `Prices paired with the ${dma}-day ADR average start on ${escHtml(fmtLongDate(res.from))}` : 'There are no prices paired with this ADR'}, so this period is not covered. Pick a shorter period.`)}
      ${horizonPanel}</div></div>`;
    brkPriceListeners(el.firstElementChild);
    return;
  }

  const { model: d, start, view: rows } = res;
  const rs = shareRatioStats(rows, start);
  const last = rows[rows.length - 1];
  const ratioNow = last.price / last.rev_ma;
  const z = rs && rs.sd ? (ratioNow - rs.mean) / rs.sd : null;
  const fv = d.meth.fair_value_supported ? d.reg.slope * last.rev_ma + d.reg.intercept : null;
  el.innerHTML = `<div class="brk-wrap">${brkRunBar()}<div class="rx">${controls}
    <section class="rx-kpis" aria-label="Price vs ADR">
      ${rxKpi('Close', rxRupee(last.price, 2), escHtml(fmtLongDate(last.date)))}
      ${rxKpi(`ADR-DMA${dma}`, rxCr(last.rev_ma, 2), `${escHtml(basisLabel)} · to the session before`)}
      ${rxKpi('Price ÷ ADR-DMA', fmtNum(ratioNow, 1), rs ? `mean ${fmtNum(rs.mean, 1)} · ${z == null ? '' : `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(1)}σ`} over ${periodLabel}` : 'no in-fit days')}
      ${rxKpi(`Fair value · ${periodLabel}`, fv == null ? '—' : rxRupee(fv, 0), fv == null ? `not supported: ${escHtml(d.meth.gate_reasons[0] || 'gate failed')}` : `${rxChangeHTML(fv / last.price - 1)} vs close`, { accent: true })}
      ${rxKpi('R²', fmtNum(d.reg.r_squared, 2), `${fmtNum(d.n, 0)} sessions in the fit`)}
    </section>
    ${rxPanel({ title: 'Price ÷ ADR-DMA', meta: `${periodLabel} · mean and ±1σ / ±2σ of the in-fit days`, body: `<div class="rx-pb">${rxCanvas(id('ratio'))}<div data-brk-leg="ratio"></div></div>` })}
    <div class="rx-row">
      ${rxPanel({ cls: 'rx-col-wide', title: 'Price vs ADR-DMA', meta: escHtml(d.reg.equation.replace('Rev_MA', 'ADR_DMA')), body: `<div class="rx-pb">${rxCanvas(id('scatter'))}<div data-brk-leg="scatter"></div></div>` })}
      ${rxPanel({ cls: 'rx-col-narrow', title: 'Model checks', meta: periodLabel, body: `<div class="rx-pb">${shareChecksHTML(d)}</div>` })}
    </div>
    ${horizonPanel}
  </div></div>`;
  const root = el.firstElementChild;
  brkPriceListeners(root);

  const labels = rows.map(r => fmtChartDate(r.date));
  const dateTitle = items => rxDate(rows[items[0].dataIndex].date);
  if (rs) {
    const flat = v => rows.map(() => v);
    const band = (lbl, v, fill, bg) => ({ label: lbl, data: flat(v), borderWidth: 0, pointRadius: 0, fill, backgroundColor: bg, tension: 0 });
    rxChart(`brk-${view}-ratio`, id('ratio'), 260, {
      type: 'line',
      data: { labels, datasets: [
        band('+2σ', rs.mean + 2 * rs.sd, { target: 4 }, 'rgba(43, 92, 200, 0.07)'),
        band('+1σ', rs.mean + rs.sd, { target: 3 }, 'rgba(43, 92, 200, 0.12)'),
        { label: 'Mean', data: flat(rs.mean), borderColor: RX.muted, borderWidth: 1, borderDash: [4, 3], pointRadius: 0, fill: false },
        band('−1σ', rs.mean - rs.sd, false, 'transparent'),
        band('−2σ', rs.mean - 2 * rs.sd, false, 'transparent'),
        { label: 'Price ÷ ADR-DMA', data: rows.map(r => r.price / r.rev_ma), borderColor: RX.ink, borderWidth: 1.75, pointRadius: 0, tension: 0, fill: false,
          segment: { borderColor: c => rows[c.p1DataIndex].in_fit ? RX.ink : RX.grey, borderDash: c => rows[c.p1DataIndex].in_fit ? undefined : [3, 3] } },
      ] },
      options: {
        interaction: { mode: 'index', intersect: false },
        plugins: { tooltip: {
          filter: item => item.datasetIndex === 5,
          callbacks: {
            title: dateTitle,
            label: ctx => { const zz = (ctx.raw - rs.mean) / rs.sd; return ` Ratio ${fmtNum(ctx.raw, 1)} (${zz >= 0 ? '+' : '−'}${Math.abs(zz).toFixed(1)}σ)${rows[ctx.dataIndex].in_fit ? '' : ' · includes projected ADR'}`; },
            footer: items => `At the mean ratio: ₹${fmtNum(rs.mean * rows[items[0].dataIndex].rev_ma, 0)}`,
          },
        } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true } }, y: { ticks: { callback: v => fmtNum(v, 0) } } },
      },
    });
    root.querySelector('[data-brk-leg="ratio"]').innerHTML = rxLegend([
      { label: 'Price ÷ ADR-DMA', color: RX.ink, kind: 'line' },
      { label: 'includes projected ADR', color: RX.grey, kind: 'dash' },
      { label: `± 1σ (${fmtNum(rs.mean - rs.sd, 1)}–${fmtNum(rs.mean + rs.sd, 1)})`, color: 'rgba(43, 92, 200, 0.19)' },
      { label: `± 2σ (${fmtNum(rs.mean - 2 * rs.sd, 1)}–${fmtNum(rs.mean + 2 * rs.sd, 1)})`, color: 'rgba(43, 92, 200, 0.07)', style: 'box-shadow:inset 0 0 0 1px #DCE5F7' },
      { label: `Mean ${fmtNum(rs.mean, 1)}`, color: RX.muted, kind: 'dash' },
    ]);
  }

  const fit = rows.filter(r => r.in_fit), out = rows.filter(r => !r.in_fit);
  const xs = rows.map(r => r.rev_ma), xMin = Math.min(...xs), xMax = Math.max(...xs);
  const pt = r => ({ x: r.rev_ma, y: r.price, date: r.date });
  rxChart(`brk-${view}-scatter`, id('scatter'), 260, {
    type: 'scatter',
    data: { datasets: [
      { label: 'Session', data: fit.map(pt), pointBackgroundColor: fit.map((r, i) => RX.seq[Math.min(4, Math.floor(i / Math.max(fit.length, 1) * 5))]),
        pointBorderColor: '#FFFFFF', pointBorderWidth: 0.5, pointRadius: 3.2, pointHoverRadius: 5 },
      { label: 'Projected ADR', data: out.map(pt), pointBackgroundColor: RX.light, pointBorderColor: RX.grey, pointBorderWidth: 0.5, pointRadius: 3, pointHoverRadius: 5 },
      { label: 'Latest', data: [pt(last)], pointBackgroundColor: '#FFFFFF', pointBorderColor: RX.ink, pointBorderWidth: 2, pointRadius: 6, pointHoverRadius: 7 },
      { type: 'line', label: 'Fit', data: [{ x: xMin, y: d.reg.slope * xMin + d.reg.intercept }, { x: xMax, y: d.reg.slope * xMax + d.reg.intercept }],
        borderColor: d.meth.fair_value_supported ? RX.model : RX.grey, borderDash: [5, 3], borderWidth: 1.75, pointRadius: 0, tension: 0 },
    ] },
    options: {
      plugins: { tooltip: {
        filter: item => item.dataset.label !== 'Fit',
        callbacks: { title: items => rxDate(items[0].raw.date), label: ctx => ` ADR-DMA ₹${fmtNum(ctx.parsed.x, 2)} Cr · close ₹${fmtNum(ctx.parsed.y, 0)}` },
      } },
      scales: {
        x: { type: 'linear', grace: '4%', title: { display: true, text: `ADR-DMA${dma}, ₹ Cr / day` }, ticks: { callback: v => '₹' + fmtNum(v, 0) } },
        y: { grace: '4%', ticks: { callback: v => '₹' + fmtNum(v, 0) } },
      },
    },
  });
  root.querySelector('[data-brk-leg="scatter"]').innerHTML = rxLegend([
    { label: 'Older', color: RX.seq[0] }, { label: 'Recent', color: RX.seq[4] },
    { label: 'Projected ADR (not in fit)', color: RX.light },
    { label: `Latest (${fmtTradeDate(last.date)})`, color: '#FFFFFF', style: `border:2px solid ${RX.ink};border-radius:50%;width:11px;height:11px` },
    { label: d.meth.fair_value_supported ? 'Fit' : 'Fit (not supported)', color: d.meth.fair_value_supported ? RX.model : RX.grey, kind: 'dash' },
  ]);
}

// Controls; listeners sit on this build's wrapper, so a rebuild never stacks them
function brkPriceListeners(root) {
  const st = BRK.priceView;
  rxOnSeg(root, 'brkBasis', v => { st.basis = v; buildBrokersPrice(); });
  rxOnSeg(root, 'brkPeriod', v => { st.period = v; st.picked = true; buildBrokersPrice(); });
  rxOnSeg(root, 'brkDma', v => {
    st.custom = v === 'custom';
    if (!st.custom) st.dma = +v;
    buildBrokersPrice();
  });
  root.querySelector('[data-brk-dma]')?.addEventListener('change', e => {
    const n = Math.round(+e.target.value);
    if (n >= 2 && n <= 250) { st.dma = n; buildBrokersPrice(); }
  });
}
