// dashboard/js/13-regression.js — Regression tab and the share-regression maths (computeShareModel mirrors scripts/share_regression.py).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

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
