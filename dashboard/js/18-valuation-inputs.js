// dashboard/js/18-valuation-inputs.js — Valuation inputs: the drawer the Valuation Model tab opens to edit the shown exchange's inputs (the workbook's "Valuation Inputs" sheet), and the strip of BSE, MCX and NSE base-case targets.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// VALUATION INPUTS — a side drawer on the Valuation Model tab (js/14-valuation.js)
// ========================
// The editable inputs of the exchange on show (ADR estimate, QoQ ADR growth, P/E,
// method weights, the regression's data-from date), saved in this browser over the
// shared defaults in dashboard/data/valuation_inputs.json; under them, folded, what
// they feed (the ADR reference, the fixed inputs, the fit from that date). Each
// edit re-renders the Valuation Model behind the drawer. The model is
// valuationModel in js/14-valuation.js.

// Table rows: sec = section heading; key = editable input (a number, or a date with
// type 'date'); out = read-only figure (valuationInputsCell); note = the line under the label
function valuationInputsRows(qLabel, fy) {
  const y1 = valuationFYShort(fy), y0 = valuationFYShort(fy - 1);
  return [
    { sec: 'Inputs · saved in this browser' },
    { key: 'adr', label: 'ADR estimate, ₹ Cr / session', step: 0.1, note: `${qLabel}’s ADR in the estimate table: Regression, Ratio and the ADR model’s start; blank = no estimate (the 45 DMA table only)` },
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
    { out: 'qAdr', label: `${qLabel} ADR to date`, note: 'start of the 45 DMA table’s ADR path' },
    { out: 'adrFY', label: `${y1} average ADR, from ADR to date`, note: 'ADR model, 45 DMA table' },
    { out: 'adrFYEst', label: `${y1} average ADR, from the estimate`, note: 'ADR model, estimate table' },
    { out: 'vs45', label: 'ADR estimate vs 45 DMA' },
    { sec: `Fixed · valuation_inputs.json` },
    { out: 'oi', label: `Other income ${y1}, ₹ Cr` },
    { out: 'margin', label: 'PAT margin' },
    { out: 'days', label: `Sessions in ${y1}` },
    { out: 'shares', label: 'Shares outstanding, Cr' },
    { out: 'd1', label: `Discount ${y1} → ${y0}` },
    { out: 'd2', label: `Discount ${y0} → today` },
    { sec: 'Regression and ratio · 45-session fit · saved in this browser' },
    { key: 'from', type: 'date', label: 'Regression data from', note: 'revenue and prices from this date, the 45 DMA built from it; blank = the published fit (its own start, MA over all revenue)' },
    { out: 'first', label: 'First point in the fit', note: 'the close after the 45th session from the date' },
    { out: 'n', label: 'Sessions in the fit' },
    { out: 'a', label: 'Intercept a, ₹' },
    { out: 'b', label: 'Slope b, ₹ per ₹ Cr ADR' },
    { out: 'r2', label: 'R²', note: 'in-sample' },
    { out: 'se', label: 'Standard error, ₹', note: 'Regression Bear / Bull = base ∓ this' },
    { out: 'rMean', label: 'Price ÷ MA, mean ×' },
    { out: 'rSd', label: 'Price ÷ MA, σ ×', note: 'Ratio Bear / Bull = mean ∓ σ' },
    { out: 'pub', label: 'Published fit', note: 'the Regression tab’s: MA over all revenue' },
    { out: 'cmp', label: 'CMP, ₹' },
  ];
}

// Text of a read-only cell for one exchange (d: valuationExchange's result with its context
// fitted from the data-from date, v: its inputs, m: its model)
function valuationInputsCell(key, d, v, m) {
  const c = d.c;
  const dash = '—';
  switch (key) {
    case 'gA': return fmtPct(Math.pow(1 + v.g / 100, 4) - 1);
    case 'wSum': {
      const s = v.w0 + v.w1 + v.w2;
      return Math.abs(s - 100) < 1e-9 ? valuationPct(s) : `<span class="rx-dn" title="The weights do not add to 100 %: the average divides by the weights of the methods with a value">${valuationPct(s)} ✕</span>`;
    }
    case 'oi': return fmtNum(v.oi, 0);
    case 'margin': return valuationPct(v.margin);
    case 'days': return fmtNum(v.days, 0);
    case 'shares': return fmtNum(SHARES_OUTSTANDING_CR[d.ex].value, 2);
    case 'd1': return valuationPct(v.d1);
    case 'd2': return valuationPct(v.d2);
  }
  if (!c) return dash;
  switch (key) {
    case 'adr45': return fmtNum(c.adr45, 2);
    case 'qAdr': return `${fmtNum(c.qAdr, 2)} <span class="rx-vi-sub">${c.qN} sessions</span>`;
    case 'adrFY': return fmtNum(m.path.adr, 2);
    case 'adrFYEst': return v.adr == null ? '<span class="rx-vi-sub">no estimate</span>' : fmtNum(m.pathEst.adr, 2);
    case 'vs45': return v.adr == null ? '<span class="rx-vi-sub">no estimate</span>' : rxSignedPct(v.adr / c.adr45 - 1, 1);
    case 'first': {
      const w = c.win, note = valuationWindowNote(w);
      if (!w.firstPoint) return note ? `${dash} <span class="rx-vi-sub" title="${escHtml(note)}">date not applied</span>` : dash;
      return `${rxDate(w.firstPoint)}${note ? ` <span class="rx-vi-sub" title="${escHtml(note)}">${w.modelledOut ? `${fmtNum(w.modelledOut, 0)} modelled out` : 'date not applied'}</span>` : ''}`;
    }
    case 'n': return c.win.n ? fmtNum(c.win.n, 0) : dash;
    case 'a': return c.fit ? fmtNum(c.fit.intercept, 1) : `<span class="rx-vi-sub" title="${escHtml(c.fitWhy)}">no fit</span>`;
    case 'b': return c.fit ? fmtNum(c.fit.slope, 2) : dash;
    case 'r2': return c.fit ? fmtNum(c.fit.r2, 2) : dash;
    case 'se': return c.fit ? fmtNum(c.fit.se, 0) : dash;
    case 'pub': return c.win.pubStart && c.win.pubN ? `from ${rxDate(c.win.pubStart)} <span class="rx-vi-sub">${fmtNum(c.win.pubN, 0)} sessions</span>` : dash;
    case 'rMean': return c.ratio ? fmtNum(c.ratio.mean, 1) : dash;
    case 'rSd': return c.ratio ? fmtNum(c.ratio.sd, 1) : dash;
    case 'cmp': return c.cmp != null ? `${fmtNum(c.cmp, 2)} <span class="rx-vi-sub">${valuationCmpWhen(c)}</span>` : dash;
  }
  return dash;
}

// Value shown in an input: the ADR estimate to 2 decimals, blank when it is the 45 DMA;
// the data-from date as YYYY-MM-DD, blank for all data
function valuationInputShown(v, key) {
  const x = v[key];
  return x == null ? '' : key === 'adr' ? String(Math.round(x * 100) / 100) : String(x);
}

// The strip above the Valuation Model: each exchange's base-case target from the
// ADR-estimate triangulation, as the workbook's header (list: valuationExchange
// results, in VALUATION_EXCHANGES order; the shown exchange is accented)
function valuationTargetTiles(list, defaults, overrides, shownEx) {
  return list.map(d => {
    const name = SHARE_EXCHANGE_NAMES[d.ex];
    if (!d.c) return rxKpi(`${name} · base case target`, '—', escHtml(d.error || 'loading…'), { accent: d.ex === shownEx });
    const { v } = valuationInputsFor(defaults, overrides, d.ex, d.c.lastDate);
    const c = valuationFitted(d.c, v.from);
    const m = c ? valuationModel(c, v, SHARES_OUTSTANDING_CR[d.ex].value) : null;
    const t = m && m.est, avg = t && t.avg;
    return rxKpi(`${name} · base case target`, avg ? rxRupee(avg[1]) : '—',
      avg ? `${d.c.cmp ? `Upside ${valuationUpHTML(avg[1], d.c.cmp)} · CMP ${rxRupee(d.c.cmp)}` : 'no CMP yet'}<br>Bear ${rxRupee(avg[0])} · Bull ${rxRupee(avg[2])} · ADR ${fmtNum(t.adr, 2)}${m.estIsDma ? ' (45 DMA)' : ''}`
        : 'no method has a value', { accent: d.ex === shownEx });
  }).join('');
}

// Opens the drawer on one exchange's inputs. ctx: { ex, defaults, data (its
// valuationExchange result), onChange (re-renders the Valuation Model) }
function openValuationDrawer(ctx) {
  const { ex, defaults, data, onChange } = ctx;
  const name = SHARE_EXCHANGE_NAMES[ex];
  const latest = () => data.c && data.c.lastDate;
  const anyC = data.c;
  const qLabel = anyC ? `Q${anyC.start.q} ${valuationFYShort(anyC.start.fy)}` : 'This quarter';
  const rows = valuationInputsRows(qLabel, anyC ? anyC.start.fy + 1 : defaults.fy);
  let overrides = readValuationOverrides();

  // Sections: inputs and the data-from date in view; reference figures folded
  const input = r => r.type === 'date'
    ? `<input class="rx-in rx-date-in" type="date"${anyC ? `${anyC.dataFirst ? ` min="${anyC.dataFirst}"` : ''} max="${anyC.lastDate}"` : ''} data-vd="${r.key}" aria-label="${escHtml(r.label)}">`
    : `<input class="rx-in rx-num-in" type="number" step="${r.step}" inputmode="decimal" data-vd="${r.key}" aria-label="${escHtml(r.label)}">`;
  const row = r => `<div class="rx-drawer-row"><span class="rx-dl">${r.label}${r.note ? `<small>${r.note}</small>` : ''}</span>
      <span class="rx-dv">${r.key ? input(r) : `<span data-vd-out="${r.out}"></span>`}</span></div>`;
  const groups = [];
  rows.forEach(r => { if (r.sec) groups.push({ sec: r.sec, rows: [] }); else groups[groups.length - 1].rows.push(r); });
  const body = groups.map((g, gi) => {
    const shown = g.rows.filter(r => gi === 0 || r.key);
    const folded = g.rows.filter(r => gi !== 0 && !r.key);
    const title = gi === 3 ? 'Regression and ratio fit' : g.sec;
    return (shown.length ? `<div class="rx-drawer-sec">${gi === 3 ? 'Regression data from · saved in this browser' : g.sec}</div>${shown.map(row).join('')}` : '')
      + (folded.length ? `<details class="rx-how"><summary>${title}</summary>${folded.map(row).join('')}</details>` : '');
  }).join('');

  const el = openRxDrawer({
    title: `${name} valuation inputs`,
    body: `<p class="rx-drawer-note">Saved in this browser over the shared defaults; the tables behind update as you type. Light-blue boxes are inputs; an amber edge marks one edited from the default.</p>
      ${body}
      <div class="rx-drawer-acts"><span data-vd-edited></span></div>`,
  });
  const q = sel => el.querySelector(sel);

  function update() {
    const { v, edited } = valuationInputsFor(defaults, overrides, ex, latest());
    const c = valuationFitted(data.c, v.from);
    const m = c ? valuationModel(c, v, SHARES_OUTSTANDING_CR[ex].value) : null;
    rows.filter(r => r.out).forEach(r => {
      const n = q(`[data-vd-out="${r.out}"]`);
      if (n) n.innerHTML = valuationInputsCell(r.out, { ...data, c }, v, m);
    });
    VALUATION_EDITABLE.forEach(k => {
      const i = q(`input[data-vd="${k}"]`);
      if (!i) return;
      i.classList.toggle('is-edited', edited.includes(k));
      if (document.activeElement !== i) i.value = valuationInputShown(v, k);
      if (k === 'adr') i.placeholder = data.c ? fmtNum(data.c.adr45, 2) : '45 DMA';
    });
    q('[data-vd-edited]').innerHTML = edited.length
      ? `${rxChip(`Edited: ${edited.map(k => VALUATION_INPUT_LABELS[k]).join(', ')}`, 'edit')} <button type="button" class="rx-btn" data-vd-reset>Reset ${name} to the defaults</button>`
      : '<span class="rx-foot">All inputs at the shared defaults.</span>';
  }
  const save = () => { writeValuationOverrides(overrides); update(); if (onChange) onChange(); };
  const showInUse = i => { i.value = valuationInputShown(valuationInputsFor(defaults, overrides, ex, latest()).v, i.dataset.vd); };

  el.addEventListener('input', e => {
    const i = e.target.closest && e.target.closest('input[data-vd]');
    if (!i) return;
    const key = i.dataset.vd, text = i.value.trim();
    let value;
    if (key === 'from') {
      if (i.validity && i.validity.badInput) return;   // a date half typed: wait for the rest
      value = text === '' ? null : text;                 // blank: all data
    } else {
      if (text === '') return;   // cleared to retype, or not a number yet: decided when the field is left
      value = parseFloat(text);
    }
    if (!valuationInputOk(key, value, latest())) return;
    overrides = setValuationOverride(overrides, defaults, ex, key, value);
    save();
  });
  // Leaving a field shows the value in use (an unusable entry reverts); an ADR box left
  // empty means the 45 DMA. A date input also fires change after each keystroke while it
  // is edited (Chromium), so a half-typed date is left alone until focus leaves.
  el.addEventListener('change', e => {
    const i = e.target.closest && e.target.closest('input[data-vd]');
    if (!i || i.type === 'date') return;
    if (i.dataset.vd === 'adr' && i.value.trim() === '' && !(i.validity && i.validity.badInput)) {
      overrides = setValuationOverride(overrides, defaults, ex, 'adr', null);
      save();
    }
    showInUse(i);
  });
  el.addEventListener('focusout', e => {
    const i = e.target.closest && e.target.closest('input[data-vd]');
    if (i && i.type === 'date') showInUse(i);
  });
  el.addEventListener('click', e => {
    if (!(e.target.closest && e.target.closest('[data-vd-reset]'))) return;
    overrides = { ...overrides };
    delete overrides[ex];
    save();
    el.querySelectorAll('input[data-vd]').forEach(showInUse);
  });
  update();
}
