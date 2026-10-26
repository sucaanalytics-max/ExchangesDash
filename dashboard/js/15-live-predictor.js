// dashboard/js/15-live-predictor.js — Live Predictor tab.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

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

// "Xh Ym of 6h 45m" through the session; the pollers run on to 16:30, so a
// poll at or after the 16:00 close reads as the full session
function fmtSessionProgress(mins) {
  return mins != null && mins >= SESSION_MINUTES ? 'full session (6h 45m)' : `${fmtElapsed(mins)} of 6h 45m`;
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
    const res = await fetch(`/api/live?exchange=${exchange}&file=${file}`);
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

// Archived day: the live model's prediction at checkpoint `label` vs the close
// (null when no poll landed shortly before it, or the day predates the field)
function liveModelError(day, label) {
  const cp = day.checkpoints && day.checkpoints[label];
  return cp && cp.predicted_eod != null && day.eod_revenue ? cp.predicted_eod / day.eod_revenue - 1 : null;
}

// Archived day: revenue at `label` ÷ the median share of the close that
// `others` had reached by then, vs the close
function shareOfDayError(day, label, others) {
  const cp = INTRADAY_CHECKPOINTS.find(c => c[0] === label);
  const med = cp ? quantile(others.map(o => dayFractionAt(o, cp[1])).filter(x => x != null), 0.5) : null;
  const rev = day.checkpoints && day.checkpoints[label] && day.checkpoints[label].revenue;
  return med && rev != null && day.eod_revenue ? (rev / med) / day.eod_revenue - 1 : null;
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

// Day type the band starts on: the session's own type once 3 complete archived
// sessions of it exist, else every day
function liveDefaultType(complete, dayType) {
  return complete.filter(d => d.day_type === dayType).length >= 3 ? dayType : 'all';
}

// Archived sessions a band is built from: complete days of `type` when there
// are at least 3 of them, else every complete day (`exclude` left out)
function liveDayPool(complete, type, exclude) {
  const pool = complete.filter(d => d !== exclude);
  const same = type === 'all' ? pool : pool.filter(d => d.day_type === type);
  return same.length >= 3 ? same : pool;
}

// Typical-path range of the close: revenue so far ÷ the 90th and 10th
// percentile of the share of the close `pool` had reached `at` minutes in
function typicalPathRange(revenue, at, pool) {
  const fr = pool.map(d => dayFractionAt(d, at)).filter(x => x > 0);
  if (revenue == null || !fr.length) return null;
  return { lo: revenue / quantile(fr, 0.9), hi: revenue / quantile(fr, 0.1), n: fr.length };
}

// Whether the session `date` has its official close in the view's daily rows.
// Live figures are then compared with that close at today's rates, the polls'
// basis (todayRatesData), never with the view's rows: under "As charged" BSE
// cash there is priced at the calibrated rate. Until then nothing extra loads.
function liveCloseKnown(viewRows, date) {
  return !!date && (viewRows || []).some(r => r.date === date);
}

// Everything a Revenue Summary live card shows for one exchange, from its poll
// file, its archive and the daily rows at today's rates holding the official
// close (same figures as this tab's KPIs). `status` defaults to liveStatus().
function liveCardModel(hourly, history, dailyAll, status) {
  if (!hourly) return { kind: 'unavailable' };
  const samples = (hourly.samples || []).filter(s => s.elapsed_minutes > 0 && s.total_revenue != null);
  const latest = samples.length ? samples[samples.length - 1] : null;
  const st = status || liveStatus(hourly, latest);
  const sessDate = hourly.date || null;
  const base = { sessDate, isToday: st.isToday };
  if (!latest) return { ...base, kind: 'none' };

  const at = latest.elapsed_minutes;
  const complete = ((history && history.days) || []).filter(d => dayFractionAt(d, SESSION_MINUTES) != null);
  const range = typicalPathRange(latest.total_revenue, at, liveDayPool(complete, liveDefaultType(complete, hourly.day_type || 'normal')));
  const closeRow = sessDate ? (dailyAll || []).find(r => r.date === sessDate) : null;
  const actual = closeRow && (!st.isToday || st.kind === 'closed') ? closeRow.total_rev : null;
  const booked = latest.total_revenue, pred = latest.predicted_eod ?? null;
  const outsideRange = range && pred != null ? (pred > range.hi ? 'above' : pred < range.lo ? 'below' : null) : null;

  // Bar: booked revenue (the actual close once known) on a scale just past the furthest mark
  const end = actual ?? booked;
  const scale = Math.max(end, pred || 0, actual == null && range ? range.hi : 0) * 1.06;
  const pct = v => v == null || !scale ? null : v / scale * 100;
  return {
    ...base,
    kind: st.kind, age: st.age,
    time: (latest.captured_ist || '').slice(11, 16),
    elapsed: at,
    booked, pred, method: intradayMethodLabel(latest.pred_method),
    segs: [['Options', latest.options_revenue], ['Futures', latest.futures_revenue], ['Cash', latest.cash_revenue]].filter(s => s[1] != null),
    range: actual == null ? range : null,
    rangeAt: sessionClock(at),
    outsideRange: actual == null ? outsideRange : null,
    actual, actualFlags: closeRow ? periodFlags(closeRow, 'total') : NO_FLAGS,
    predError: actual && pred != null ? pred / actual - 1 : null,
    pctOfClose: actual == null && pred ? booked / pred : null,
    bar: {
      fill: pct(end),
      lo: actual == null && range ? pct(range.lo) : null,
      hi: actual == null && range ? pct(range.hi) : null,
      mark: pct(pred),
    },
  };
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
  const state = { type: liveDefaultType(complete, dayType) };
  // Benchmark for the predicted close: archived days of the same type (the
  // poller's closes, at today's rates), else the quarter-to-date average
  const sameType = complete.filter(d => d.day_type === dayType && d.date !== sessDate);
  // The official close and the QTD average are read at today's rates, the
  // polls' basis, whatever the Fees toggle; that file loads only when needed
  const closeKnown = liveCloseKnown(DATA.daily_all, sessDate);
  const todayData = closeKnown || sameType.length < 3 ? await todayRatesData(ex) : null;
  if (currentExchange !== ex) return;
  const closeRow = closeKnown ? ((todayData && todayData.daily_all) || []).find(r => r.date === sessDate) : null;
  const actualClose = closeRow && !st.isToday ? closeRow.total_rev : (closeRow && st.kind === 'closed' ? closeRow.total_rev : null);
  const pred = latest?.predicted_eod ?? null;
  const q = (todayData && todayData.quarterly) || [];
  const cq = q.length ? q[q.length - 1] : null;
  const qtdAvg = cq && cq.days ? cq.total_rev / cq.days : null;
  const refAvg = sameType.length >= 3
    ? { value: sameType.reduce((a, d) => a + d.eod_revenue, 0) / sameType.length, label: `${dayType.replace('_', '-')}-day avg` }
    : qtdAvg ? { value: qtdAvg, label: "QTD avg at today's rates" } : null;
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
    ${rxPanel({ title: 'How early estimates have done', meta: 'archived sessions · error vs the actual close',
      body: '<div class="rx-scroll"><table class="rx-table" data-rx="arch"></table></div>',
      foot: '<span data-rx="archNote"></span>' })}
  </div>`;
  const qx = k => el.querySelector(`[data-rx="${k}"]`);

  const typeDays = (t, exclude) => liveDayPool(complete, t, exclude);

  function renderKpis(band) {
    const at = latest.elapsed_minutes;
    const rng = typicalPathRange(latest.total_revenue, at, typeDays(state.type));
    const when = `${(latest.captured_ist || '').slice(11, 16)} IST · ${fmtSessionProgress(at)}`;
    const items = [
      rxKpi(st.isToday && st.kind !== 'closed' ? 'Revenue so far' : 'Revenue at last poll', rxCr(latest.total_revenue, 2), when),
      rxKpi(st.isToday && st.kind !== 'closed' ? 'Predicted close, 16:00' : 'Predicted close at last poll', rxCr(pred, 2),
        `${refAvg && pred ? rxChangeHTML(pred / refAvg.value - 1) + ` vs ${refAvg.label} ${rxCr(refAvg.value, 1)} · ` : ''}${intradayMethodLabel(latest.pred_method)}`, { accent: true }),
    ];
    if (actualClose != null) {
      items.push(rxKpi(`Actual close · today's rates${flagTags(periodFlags(closeRow, 'total'))}`, rxCr(actualClose, 2), pred ? `Last prediction was ${rxSignedPct(pred / actualClose - 1)} off` : fmtTradeDate(sessDate, true)));
    } else {
      items.push(rxKpi('Typical-path range', rng ? `₹${fmtNum(rng.lo, 1)} – ${fmtNum(rng.hi, 1)} Cr` : '—',
        rng ? `revenue so far ÷ 10th–90th pct. share reached by ${sessionClock(at)} · n = ${rng.n}` : 'needs complete archived sessions'));
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
    const labels = ['12:00', '14:00'];
    const rows = complete.slice(-8).reverse().map(d => ({
      d,
      model: labels.map(l => liveModelError(d, l)),
      share: labels.map(l => shareOfDayError(d, l, typeDays(d.day_type, d))),
    }));
    const hasModel = rows.some(r => r.model.some(e => e != null));
    const cell = e => e == null ? '<td>—</td>' : `<td class="${Math.abs(e) >= 0.05 ? 'rx-warn' : ''}">${rxSignedPct(e)}</td>`;
    // A column with fewer scored sessions than the table says so (n)
    const mae = vals => { const v = vals.filter(x => x != null); return v.length ? fmtPct(v.reduce((a, b) => a + Math.abs(b), 0) / v.length) + (v.length < rows.length ? ` <span class="rx-foot">n ${v.length}</span>` : '') : '—'; };
    const cols = (hasModel ? labels.map(l => `<th scope="col">Live model ${l}</th>`) : [])
      .concat(labels.map(l => `<th scope="col">${hasModel ? 'Share-of-day ' : 'Error at '}${l}</th>`)).join('');
    const vals = r => (hasModel ? r.model : []).concat(r.share);
    const nCols = (hasModel ? 2 : 0) + 2;
    qx('arch').innerHTML = rows.length
      ? `<thead><tr><th scope="col">Trade date</th><th scope="col" class="rx-l">Day</th><th scope="col" class="rx-l">Type</th><th scope="col">Close, ₹ Cr</th><th scope="col">Polls</th>${cols}</tr></thead>
        <tbody>${rows.map(r => `<tr><td>${rxDate(r.d.date)}</td><td class="rx-l">${(r.d.weekday_name || '').slice(0, 3)}</td><td class="rx-l">${rxChip(r.d.day_type.replace('_', '-'), r.d.day_type === 'normal' ? '' : 'warn')}</td><td>${fmtNum(r.d.eod_revenue, 2)}</td><td>${r.d.n_samples ?? '—'}</td>${vals(r).map(cell).join('')}</tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="5">Mean absolute error, ${rows.length} sessions</td>${Array.from({ length: nCols }, (_, i) => `<td>${mae(rows.map(r => vals(r)[i]))}</td>`).join('')}</tr></tfoot>`
      : '<tbody><tr><td class="rx-l">No complete archived sessions yet</td></tr></tbody>';
    qx('archNote').textContent = (hasModel
      ? 'Live model = what the dashboard predicted at the last poll before each hour (at most 30 minutes earlier); sessions archived before predictions were recorded show —. '
      : 'The live model’s predictions are recorded for sessions archived from now on; until then this scores the simple method only. ')
      + 'Share-of-day = revenue at the hour ÷ the median share of the close other sessions of that type had reached. Amber: off by 5 % or more.';
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

