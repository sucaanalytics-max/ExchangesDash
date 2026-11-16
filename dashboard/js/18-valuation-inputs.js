// dashboard/js/18-valuation-inputs.js — Valuation Inputs tab: BSE, MCX and NSE's valuation inputs in one table (the workbook's "Valuation Inputs" sheet).
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// VALUATION INPUTS TAB — under every exchange view that has the Valuation Model tab
// ========================
// One table, a column per exchange: the editable inputs (ADR estimate, QoQ ADR
// growth, P/E, method weights), saved in this browser over the shared defaults in
// dashboard/data/valuation_inputs.json, then what they feed (the ADR reference,
// the fixed inputs, the fit). Above it, each exchange's base-case target from the
// ADR-estimate triangulation, as the workbook's header. The model is
// valuationModel in js/14-valuation.js; the Valuation Model tab reads the same
// inputs when it is shown again.

// Table rows: sec = section heading; key = editable input; out = read-only figure
// (valuationInputsCell); note = the line under the label
function valuationInputsRows(qLabel, fy) {
  const y1 = valuationFYShort(fy), y0 = valuationFYShort(fy - 1);
  return [
    { sec: 'Inputs · saved in this browser' },
    { key: 'adr', label: 'ADR estimate, ₹ Cr / session', step: 0.1, note: 'Regression and Ratio in the estimate model; blank = the 45 DMA' },
    { key: 'g', label: 'QoQ ADR growth, %', step: 0.5, note: `each quarter from ${qLabel} to Q4 ${y1}, ADR model` },
    { out: 'gA', label: 'Implied annual growth', note: '(1 + QoQ)⁴ − 1' },
    { key: 'pe0', label: 'P/E bear, ×', step: 1, note: `on ${y1}E EPS` },
    { key: 'pe1', label: 'P/E base, ×', step: 1 },
    { key: 'pe2', label: 'P/E bull, ×', step: 1 },
    { key: 'w0', label: 'Weight · Regression, %', step: 5 },
    { key: 'w1', label: 'Weight · Ratio Analysis, %', step: 5 },
    { key: 'w2', label: 'Weight · ADR model, %', step: 5 },
    { out: 'wSum', label: 'Weight check', note: 'must be 100 %' },
    { sec: 'ADR reference · ₹ Cr / session at today’s rates' },
    { out: 'adr45', label: 'Current 45 DMA ADR', note: 'last 45 sessions: the 45 DMA model' },
    { out: 'qAdr', label: `${qLabel} ADR to date`, note: 'start of the ADR path' },
    { out: 'adrFY', label: `${y1} average ADR`, note: 'ADR model' },
    { out: 'vs45', label: 'ADR estimate vs 45 DMA' },
    { sec: `Fixed · valuation_inputs.json` },
    { out: 'oi', label: `Other income ${y1}, ₹ Cr` },
    { out: 'margin', label: 'PAT margin' },
    { out: 'days', label: `Sessions in ${y1}` },
    { out: 'shares', label: 'Shares outstanding, Cr' },
    { out: 'd1', label: `Discount ${y1} → ${y0}` },
    { out: 'd2', label: `Discount ${y0} → today` },
    { sec: 'Regression and ratio · published 45-session fit' },
    { out: 'a', label: 'Intercept a, ₹' },
    { out: 'b', label: 'Slope b, ₹ per ₹ Cr ADR' },
    { out: 'se', label: 'Standard error, ₹', note: 'Regression Bear / Bull = base ∓ this' },
    { out: 'n', label: 'Sessions in the fit' },
    { out: 'rMean', label: 'Price ÷ MA, mean ×' },
    { out: 'rSd', label: 'Price ÷ MA, σ ×', note: 'Ratio Bear / Bull = mean ∓ σ' },
    { out: 'cmp', label: 'CMP, ₹' },
  ];
}

// Text of a read-only cell for one exchange (d: valuationExchange's result, v: its inputs, m: its model)
function valuationInputsCell(key, d, v, m) {
  const c = d.c;
  const dash = '—';
  switch (key) {
    case 'gA': return fmtPct(Math.pow(1 + v.g / 100, 4) - 1);
    case 'wSum': {
      const s = v.w0 + v.w1 + v.w2;
      return Math.abs(s - 100) < 1e-9 ? valuationPct(s) : `<span class="rx-dn" title="The average divides by the weights used">${valuationPct(s)} ✕</span>`;
    }
    case 'oi': return fmtNum(v.oi, 0);
    case 'margin': return `${fmtNum(v.margin, 0)} %`;
    case 'days': return fmtNum(v.days, 0);
    case 'shares': return fmtNum(SHARES_OUTSTANDING_CR[d.ex].value, 2);
    case 'd1': return `${fmtNum(v.d1, 0)} %`;
    case 'd2': return `${fmtNum(v.d2, 0)} %`;
  }
  if (!c) return dash;
  switch (key) {
    case 'adr45': return fmtNum(c.adr45, 2);
    case 'qAdr': return `${fmtNum(c.qAdr, 2)} <span class="rx-vi-sub">${c.qN} sessions</span>`;
    case 'adrFY': return fmtNum(m.path.adr, 2);
    case 'vs45': return v.adr == null ? '<span class="rx-vi-sub">no estimate</span>' : rxSignedPct(v.adr / c.adr45 - 1, 1);
    case 'a': return c.fit ? fmtNum(c.fit.intercept, 1) : `<span class="rx-vi-sub" title="${escHtml(c.fitWhy)}">no fit</span>`;
    case 'b': return c.fit ? fmtNum(c.fit.slope, 2) : dash;
    case 'se': return c.fit ? fmtNum(c.fit.se, 0) : dash;
    case 'n': return c.fit ? fmtNum(c.fit.n, 0) : dash;
    case 'rMean': return c.ratio ? fmtNum(c.ratio.mean, 1) : dash;
    case 'rSd': return c.ratio ? fmtNum(c.ratio.sd, 1) : dash;
    case 'cmp': return c.cmp != null ? `${fmtNum(c.cmp, 2)} <span class="rx-vi-sub">${valuationCmpWhen(c)}</span>` : dash;
  }
  return dash;
}

// Value shown in an input: the ADR estimate to 2 decimals, blank when it is the 45 DMA
function valuationInputShown(v, key) {
  const x = v[key];
  return x == null ? '' : key === 'adr' ? String(Math.round(x * 100) / 100) : String(x);
}

function buildValuationInputs() {
  const el = document.getElementById('valuationInputsContent');
  if (!el) return;
  el.innerHTML = '<div class="rx"><div class="rx-empty"><b>Loading valuation inputs…</b>BSE, MCX and NSE data</div></div>';
  // Built when first shown: it needs every exchange's data, not only the one on show.
  // Once built, renderValuationInputs sets its own refresh.
  RX_TAB_REFRESH.valinputs = () => {
    RX_TAB_REFRESH.valinputs = null;
    renderValuationInputs(el).catch(err => {
      console.error('Valuation inputs failed:', err);
      el.innerHTML = `<div class="rx">${rxAlert('<strong>Valuation inputs could not be built.</strong> Reload the page to try again.')}</div>`;
    });
  };
}

async function renderValuationInputs(el) {
  const shownEx = currentExchange;
  const [defaults, ...list] = await Promise.all([loadValuationDefaults(), ...VALUATION_EXCHANGES.map(valuationExchange)]);
  if (currentExchange !== shownEx) return;
  const byEx = Object.fromEntries(list.map(d => [d.ex, d]));
  // Mixed snapshots: the notice under the header names each exchange's latest date
  VIEW_SOURCES.valinputs = list.filter(d => d.c).map(d => ({ ex: d.ex, date: d.c.lastDate }));
  updateSnapshotNotice();
  let overrides = readValuationOverrides();
  const anyC = list.find(d => d.c)?.c;
  const qLabel = anyC ? `Q${anyC.start.q} ${valuationFYShort(anyC.start.fy)}` : 'This quarter';
  const rows = valuationInputsRows(qLabel, anyC ? anyC.start.fy + 1 : defaults.fy);
  const name = ex => SHARE_EXCHANGE_NAMES[ex];
  const failed = list.filter(d => !d.c);

  const head = `<tr><th scope="col">Input</th>${VALUATION_EXCHANGES.map(ex => `<th scope="col" class="rx-vi-ex">
      <span class="rx-vi-exname">${name(ex)}</span>
      <span class="rx-vi-exact" data-vi-edited="${ex}"></span></th>`).join('')}</tr>`;
  const body = rows.map(r => {
    if (r.sec) return `<tr class="rx-vi-sec"><td colspan="${VALUATION_EXCHANGES.length + 1}">${r.sec}</td></tr>`;
    const label = `<td class="rx-vi-lab">${r.label}${r.note ? `<span class="rx-vi-note">${r.note}</span>` : ''}</td>`;
    const cells = VALUATION_EXCHANGES.map(ex => r.key
      ? `<td class="rx-vi-in"><input class="rx-in rx-num-in" type="number" step="${r.step}" inputmode="decimal" data-vi="${ex}:${r.key}" aria-label="${name(ex)} ${escHtml(r.label)}"></td>`
      : `<td data-vi-out="${ex}:${r.out}"></td>`).join('');
    return `<tr${r.key ? ' class="rx-vi-edit"' : ''}>${label}${cells}</tr>`;
  }).join('');

  el.innerHTML = `<div class="rx">
    ${valuationDefaultsNotes(defaults, anyC)}
    ${failed.length ? rxAlert(`<strong>${failed.map(d => name(d.ex)).join(' and ')} not loaded</strong> (${failed.map(d => escHtml(d.error)).join('; ')}): ${failed.length > 1 ? 'their' : 'its'} figures show —. The inputs can still be edited.`) : ''}
    <section class="rx-kpis rx-vi-strip" aria-label="Base case targets" data-vi="strip"></section>
    ${rxPanel({ title: 'Valuation inputs', meta: 'BSE, MCX and NSE · edits are saved in this browser over the shared defaults',
      body: `<div class="rx-scroll"><table class="rx-table rx-vi">
        <thead>${head}</thead><tbody>${body}</tbody></table></div>`,
      foot: 'Light-blue boxes are inputs; an amber edge marks one edited from the shared default (dashboard/data/valuation_inputs.json, from the workbook’s Valuation Inputs sheet and its BSE, MCX and NSE sheets), and Reset restores an exchange’s defaults. Other income, PAT margin, sessions and the discounts are fixed. Every ADR is at today’s rates, the basis the fits are built on. The Valuation Model tab shows each exchange’s two triangulations and how they are built.',
      how: rxHow('How the targets are built', `<ul>
        <li><strong>ADR model</strong> (both triangulations): the current quarter’s ADR to date, grown by QoQ growth each quarter to Q4 of the next FY; that FY’s average × sessions + other income → × PAT margin ÷ shares = EPS; × P/E Bear / Base / Bull, then discounted to this FY’s end and to today.</li>
        <li><strong>Regression</strong>: the published 45-session fit, a + b × ADR; Bear / Bull are base ∓ its standard error of estimate.</li>
        <li><strong>Ratio Analysis</strong>: price ÷ 45-session revenue MA over the fit window, (mean ∓ σ) × ADR.</li>
        <li><strong>Triangulated · 45 DMA</strong> feeds Regression and Ratio the last 45 sessions’ ADR; <strong>Triangulated · ADR estimate</strong> feeds them the ADR estimate above. Each is Σ weight × target; a method without a value (no fit yet) drops out and the others’ weights are rescaled.</li></ul>`) })}
  </div>`;

  const q = sel => el.querySelector(sel);
  const shownIn = (ex, key) => q(`input[data-vi="${ex}:${key}"]`);

  function update() {
    const tiles = [];
    VALUATION_EXCHANGES.forEach(ex => {
      const d = byEx[ex];
      const { v, edited } = valuationInputsFor(defaults, overrides, ex);
      const m = d.c ? valuationModel(d.c, v, SHARES_OUTSTANDING_CR[ex].value) : null;
      rows.filter(r => r.out).forEach(r => {
        const n = q(`[data-vi-out="${ex}:${r.out}"]`);
        if (n) n.innerHTML = valuationInputsCell(r.out, d, v, m);
      });
      VALUATION_EDITABLE.forEach(k => {
        const i = shownIn(ex, k);
        if (!i) return;
        i.classList.toggle('is-edited', edited.includes(k));
        if (document.activeElement !== i) i.value = valuationInputShown(v, k);
        if (k === 'adr') i.placeholder = d.c ? fmtNum(d.c.adr45, 2) : '45 DMA';
      });
      q(`[data-vi-edited="${ex}"]`).innerHTML = edited.length
        ? `${rxChip('Edited', 'edit')} <button type="button" class="rx-link" data-vi-reset="${ex}" aria-label="Reset ${name(ex)} inputs to the defaults">Reset</button>` : '';
      const t = m && m.est, avg = t && t.avg;
      tiles.push(rxKpi(`${name(ex)} · base case target`, avg ? rxRupee(avg[1]) : '—',
        avg ? `${d.c.cmp ? `Upside ${valuationUpHTML(avg[1], d.c.cmp)} · CMP ${rxRupee(d.c.cmp)}` : 'no CMP yet'}<br>Bear ${rxRupee(avg[0])} · Bull ${rxRupee(avg[2])} · ADR ${fmtNum(t.adr, 2)}${m.estIsDma ? ' (45 DMA)' : ''}`
          : escHtml(d.error || 'no method has a value'), { accent: ex === shownEx }));
    });
    q('[data-vi="strip"]').innerHTML = tiles.join('');
  }

  const onInput = e => {
    const i = e.target.closest && e.target.closest('input[data-vi]');
    if (!i) return;
    const [ex, key] = i.dataset.vi.split(':');
    const text = i.value.trim();
    const value = text === '' && key === 'adr' ? null : parseFloat(text);   // blank ADR: the 45 DMA
    if (!valuationInputOk(key, value)) return;
    overrides = setValuationOverride(overrides, defaults, ex, key, value);
    writeValuationOverrides(overrides);
    update();
  };
  // Leaving a field shows the value in use (an unusable entry reverts)
  const onChange = e => {
    const i = e.target.closest && e.target.closest('input[data-vi]');
    if (!i) return;
    const [ex, key] = i.dataset.vi.split(':');
    i.value = valuationInputShown(valuationInputsFor(defaults, overrides, ex).v, key);
  };
  const onClick = e => {
    const b = e.target.closest && e.target.closest('[data-vi-reset]');
    if (!b) return;
    overrides = { ...overrides };
    delete overrides[b.dataset.viReset];
    writeValuationOverrides(overrides);
    update();
  };
  // The container outlives each render (exchange switches, freshness rebuilds), so drop the
  // previous render's listeners before adding this one's
  if (el._viOff) el._viOff();
  el.addEventListener('input', onInput);
  el.addEventListener('change', onChange);
  el.addEventListener('click', onClick);
  el._viOff = () => {
    el.removeEventListener('input', onInput);
    el.removeEventListener('change', onChange);
    el.removeEventListener('click', onClick);
  };
  // Shown again: pick up edits saved meanwhile (another browser tab)
  RX_TAB_REFRESH.valinputs = () => { overrides = readValuationOverrides(); update(); };
  update();
}
