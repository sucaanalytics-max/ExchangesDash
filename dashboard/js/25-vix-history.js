// dashboard/js/25-vix-history.js — India VIX: 10-year mean ± σ, on Revenue Summary (Exchanges mode).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// INDIA VIX — 10-YEAR MEAN ± σ. Daily closes of the last 10 years from
// data/india_vix_history.json (scripts/india_vix_history.py: Yahoo ^INDIAVIX,
// written by the NSE job each slot), with the window's mean and sample σ as
// published there, drawn as a mean line and ±1σ / ±2σ bands. The 5- and 1-year
// views zoom the same chart: the bands stay the 10-year ones. Shown under the
// India VIX panels (21-vix.js), whatever the exchange switcher shows.
// ========================

const VIX_HIST_URL = './data/india_vix_history.json';
// [key, label, years shown]; the mean and σ are always the file's 10-year ones
const VIX_HIST_RANGES = [['10y', '10 years', 10], ['5y', '5 years', 5], ['1y', '1 year', 1]];
let vixHistBuildSeq = 0;
let VIX_HIST = { doc: null, range: '10y' };

// "2026-11-26" → the same day `years` earlier, as an ISO date (29 Feb → 28 Feb)
function vixHistYearsBefore(iso, years) {
  const y = +iso.slice(0, 4) - years, md = iso.slice(5);
  return `${y}-${md === '02-29' ? '02-28' : md}`;
}

// The file's rows, mean and σ, checked, for the last `years` of it:
// { rows: [{ date, vix, z }], mean, sd, n, from, to, latest: { date, vix, z,
// pctBelow }, bands: { m2, m1, p1, p2 } }, or null when the file is not usable
// (no rows, or a mean / σ that isn't a positive number). z = (close − mean) ÷ σ.
function vixHistModel(doc, years = 10) {
  const st = doc && doc.stats;
  const mean = st && +st.mean, sd = st && +st.sd;
  if (!doc || !Array.isArray(doc.daily) || !(mean > 0) || !(sd > 0)) return null;
  const all = doc.daily.filter(r => Array.isArray(r) && typeof r[0] === 'string' && isFinite(r[1]) && r[1] > 0)
    .map(([date, vix]) => ({ date, vix: +vix, z: (vix - mean) / sd }));
  if (!all.length) return null;
  const to = all[all.length - 1].date;
  const start = vixHistYearsBefore(to, years);
  const rows = all.filter(r => r.date > start);
  const last = all[all.length - 1];
  const pctBelow = st.latest && st.latest.date === last.date && isFinite(st.latest.pct_below)
    ? +st.latest.pct_below : all.filter(r => r.vix < last.vix).length / all.length;
  return {
    rows, mean, sd, n: Number.isFinite(+st.n) ? +st.n : all.length, from: all[0].date, to,
    latest: { date: last.date, vix: last.vix, z: last.z, pctBelow },
    bands: { m2: mean - 2 * sd, m1: mean - sd, p1: mean + sd, p2: mean + 2 * sd },
  };
}

// x-axis tick positions: the index of each year's (byYear) or month's first
// session among the sorted ISO `dates`, the first row only when it starts one
function vixHistTickIdx(dates, byYear) {
  const key = d => (byYear ? d.slice(0, 4) : d.slice(0, 7));
  return dates.reduce((out, d, i) => (i > 0 && key(d) !== key(dates[i - 1]) ? out.concat(i) : out), []);
}

// "+0.07σ" / "−1.25σ"
function vixHistZ(z) {
  return z == null || !isFinite(z) ? '—' : `${z >= 0 ? '+' : '−'}${fmtNum(Math.abs(z), 2)}σ`;
}

function vixHistLegend(m) {
  const b = m.bands, f = v => fmtNum(v, 2);
  return rxLegend([
    { label: 'India VIX (daily close)', color: 'var(--vix-accent)', kind: 'line' },
    { label: `10-year mean ${f(m.mean)}`, color: RX.ink, kind: 'dash' },
    { label: `±1σ ${f(b.m1)}–${f(b.p1)}`, color: RX.modelBand },
    { label: `±2σ ${f(b.m2)}–${f(b.p2)} (σ ${f(m.sd)})`, color: RX.modelBand2, style: `outline:1px solid ${RX.modelBand}` },
    { label: `Latest ${f(m.latest.vix)} · z ${vixHistZ(m.latest.z)}`, color: 'var(--vix-accent)', kind: 'tick' },
  ]);
}

function vixHistHowHTML(m) {
  return rxHow('How this is worked out', `<ul>
    <li><b>Data:</b> India VIX's daily close from Yahoo Finance (^INDIAVIX), the same feed as the VIX on NSE's daily rows, for the ${fmtNum(m.n, 0)} sessions from ${rxDate(m.from)} to ${rxDate(m.to)}: every close dated after the same day ten years before the latest. It is refreshed with NSE's data each run; before 16:00 IST today's unfinished bar is left out.</li>
    <li><b>Mean and σ:</b> the plain average of those closes and their sample standard deviation (n − 1, Excel's STDEV.S). The bands are mean ± 1σ and ± 2σ; z = (close − mean) ÷ σ. The 5- and 1-year views zoom in on the same 10-year mean and bands.</li>
    <li><b>Reading it:</b> VIX is skewed: it spends most days below its mean and spikes far above it (${fmtNum(Math.max(...m.rows.map(r => r.vix)), 2)} at most in the view shown), so the bands are a yardstick, not a normal range: mean − 2σ (${fmtNum(m.bands.m2, 2)}) sits below anything VIX has closed at. The latest close is above ${fmtNum(m.latest.pctBelow * 100, 0)} % of the window's closes.</li>
  </ul>`);
}

function renderVixHistPanel(el) {
  const yrs = (VIX_HIST_RANGES.find(r => r[0] === VIX_HIST.range) || VIX_HIST_RANGES[0])[2];
  const m = vixHistModel(VIX_HIST.doc, yrs);
  const title = 'India VIX: 10-year mean ± SD';   // h2 is set in capitals: σ would become Σ
  if (!m) {
    el.innerHTML = rxPanel({ title, body: '<div class="rx-empty"><b>No India VIX history</b>The 10-year file couldn\'t be read.</div>' });
    return;
  }
  const L = m.latest;
  el.innerHTML = rxPanel({
    title,
    meta: `daily closes · mean and σ over all ${fmtNum(m.n, 0)}, ${escHtml(rxDate(m.from))} – ${escHtml(rxDate(m.to))}${yrs < 10 ? ` · showing the last ${yrs === 1 ? 'year' : `${yrs} years`}` : ''}`,
    right: rxChip(`Latest ${fmtNum(L.vix, 2)} · ${escHtml(rxDate(L.date))}`, 'data') + ' '
      + rxChip(`z ${vixHistZ(L.z)}`, Math.abs(L.z) >= 1 ? 'warn' : '') + ' '
      + rxChip(`mean ${fmtNum(m.mean, 2)} · σ ${fmtNum(m.sd, 2)}`)
      + rxSeg('vixHistRange', VIX_HIST_RANGES.map(([k, label]) => [k, label]), VIX_HIST.range, 'Years shown'),
    body: `<div class="rx-pb">${vixHistLegend(m)}${rxCanvas('vixHistChart')}</div>`,
    how: vixHistHowHTML(m),
    attrs: 'id="vixHistPanelInner"',
  });
  rxOnSeg(el, 'vixHistRange', v => { VIX_HIST.range = v; renderVixHistPanel(el); });
  const rows = m.rows, n = rows.length, b = m.bands;
  const flat = v => rows.map(() => v);
  // `order`: a higher order is drawn first (underneath): ±2σ, ±1σ, mean, then VIX on top
  const band = (label, data, fill, color, order) => ({ label, data, borderWidth: 0, pointRadius: 0, pointHitRadius: 0, fill, backgroundColor: color, pointHoverRadius: 0, band: true, order });
  const yearTicks = yrs > 1;
  const tickIdx = vixHistTickIdx(rows.map(r => r.date), yearTicks);
  rxChart('vixHist', 'vixHistChart', 300, {
    type: 'line',
    data: {
      labels: rows.map(r => r.date),
      datasets: [
        // ±2σ band (outer, lighter), then ±1σ on top of it; each upper edge fills to its lower edge
        band('+2σ', flat(b.p2), 1, RX.modelBand2, 4), band('−2σ', flat(b.m2), false, RX.modelBand2, 4),
        band('+1σ', flat(b.p1), 3, RX.modelBand, 3), band('−1σ', flat(b.m1), false, RX.modelBand, 3),
        { label: 'Mean', data: flat(m.mean), borderColor: RX.ink, borderWidth: 1.25, borderDash: [5, 4], pointRadius: 0, pointHitRadius: 0, pointHoverRadius: 0, band: true, order: 2 },
        { label: 'India VIX', data: rows.map(r => r.vix), borderColor: getComputedStyle(document.documentElement).getPropertyValue('--vix-accent').trim() || '#6B4FBB',
          borderWidth: yrs > 1 ? 1.1 : 1.6, tension: 0,
          pointRadius: rows.map((r, i) => (i === n - 1 ? 3.5 : 0)), pointHoverRadius: 3.5, pointBackgroundColor: RX.ink, order: 1 },
      ],
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { tooltip: {
        filter: it => !it.dataset.band,
        callbacks: {
          title: items => rxDate(rows[items[0].dataIndex].date),
          label: ctx => ` India VIX ${fmtNum(ctx.raw, 2)} · z ${vixHistZ(rows[ctx.dataIndex].z)}`,
          footer: () => `10-year mean ${fmtNum(m.mean, 2)} · σ ${fmtNum(m.sd, 2)}`,
        },
      } },
      scales: {
        // a tick at each year's (1 year: month's) first session, thinned on narrow charts
        x: { grid: { display: false }, afterBuildTicks: s => { s.ticks = tickIdx.map(value => ({ value })); },
          ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 10,
            callback(v) { const d = this.getLabelForValue(v); return yearTicks ? d.slice(0, 4) : fmtChartDate(d); } } },
        y: { min: 0, ticks: { callback: v => fmtNum(v, 0) } },
      },
    },
  });
}

async function buildVixHistoryPanel() {
  const el = document.getElementById('vixHistoryPanel');
  if (!el || isViewKey(currentExchange)) return;
  const seq = ++vixHistBuildSeq;
  let doc = null;
  try { doc = (await fetchDataFile(VIX_HIST_URL)).json; } catch (err) { console.warn('India VIX history not loaded:', err); }
  if (seq !== vixHistBuildSeq) return;   // a later build took over while loading
  VIX_HIST.doc = doc;
  renderVixHistPanel(el);
}
