// dashboard/js/18-valuation-inputs.js — Valuation inputs: the drawer the Valuation Model tab opens to edit the shown exchange's inputs (the workbook's "Valuation Inputs" sheet), and the strip of BSE, MCX and NSE base-case targets.
// index.html loads dashboard/js/*.js in name order as classic scripts sharing one global scope.

// ========================
// VALUATION INPUTS — a side drawer on the Valuation Model tab (js/14-valuation.js)
// ========================
// The editable inputs of the exchange on show (ADR estimate, QoQ ADR growth, P/E,
// discount rates, method weights, the regression's data-from date), over the defaults in
// dashboard/data/valuation_inputs.json; under them, folded, what they feed (the ADR
// reference, the fixed inputs, the fit from that date). Each edit re-renders the
// Valuation Model behind the drawer. The model is valuationModel in js/14-valuation.js.
// The edits are shared by every viewer (/api/valuation-inputs, the SHARED INPUTS store
// in js/14-valuation.js): read-only until a team member signs in with the shared
// password, then saved for everyone a second after typing stops. Without the API
// they are saved in this browser only, as the drawer says; signed in later, the drawer
// offers to publish them (or discard them) when they differ from the shared inputs.

// Table rows: sec = section heading; key = editable input (a number, or a date with
// type 'date'); out = read-only figure (valuationInputsCell); note = the line under the label
function valuationInputsRows(qLabel, fy) {
  const y1 = valuationFYShort(fy), y0 = valuationFYShort(fy - 1);
  return [
    { sec: 'Inputs · <span data-vd-where>saved in this browser</span>' },
    { key: 'dma', type: 'choice', options: VALUATION_DMA_WINDOWS.map(w => [w, `${w} D`]), label: 'DMA table · ADR', note: 'Regression and Ratio at the last 45, 20 or 10 sessions' },
    { key: 'g', label: 'DMA table · QoQ ADR growth, %', step: 0.5, note: `ADR model: ${qLabel} ADR to date grown each quarter to Q4 ${y1}` },
    { out: 'gA', label: 'Implied annual growth', note: '(1 + QoQ)⁴ − 1' },
    { key: 'eb', type: 'choice', options: VALUATION_EST_BASES.map(b => [b, b === 'custom' ? 'Custom' : `${b.slice(3)} D`]), label: 'Estimate table · ADR', note: 'the 45, 20 or 10 DMA, or the custom ADR below' },
    { key: 'adr', label: 'Custom ADR, ₹ Cr / session', step: 0.1, note: 'typing one selects Custom' },
    { key: 'g2', label: 'Estimate table · QoQ ADR growth, %', step: 0.5, note: `ADR model: the estimate ADR grown each quarter to Q4 ${y1}` },
    { out: 'gA2', label: 'Implied annual growth', note: '(1 + QoQ)⁴ − 1' },
    { key: 'pe0', label: 'P/E bear, ×', step: 1, note: `on ${y1}E EPS` },
    { key: 'pe1', label: 'P/E base, ×', step: 1 },
    { key: 'pe2', label: 'P/E bull, ×', step: 1 },
    { key: 'd1', label: `Discount ${y1} → ${y0} end, %`, step: 0.25, note: 'ADR model targets' },
    { key: 'd2', label: `Discount ${y0} end → today, %`, step: 0.25 },
    { key: 'w0', label: 'Weight · Regression, %', step: 5 },
    { key: 'w1', label: 'Weight · Ratio Analysis, %', step: 5 },
    { key: 'w2', label: 'Weight · ADR model, %', step: 5 },
    { out: 'wSum', label: 'Weight check', note: 'must be 100 %' },
    { sec: 'ADR reference · ₹ Cr / session at today’s rates' },
    { out: 'adr45', label: '45 DMA ADR', note: 'last 45 sessions' },
    { out: 'adr20', label: '20 DMA ADR', note: 'last 20 sessions' },
    { out: 'adr10', label: '10 DMA ADR', note: 'last 10 sessions' },
    { out: 'qAdr', label: `${qLabel} ADR to date`, note: 'start of the DMA table’s ADR path' },
    { out: 'adrFY', label: `${y1} average ADR, DMA table`, note: 'ADR model' },
    { out: 'adrFY2', label: `${y1} average ADR, estimate table`, note: 'ADR model' },
    { out: 'vs45', label: 'Estimate ADR vs 45 DMA' },
    { sec: `Fixed · valuation_inputs.json` },
    { out: 'oi', label: `Other income ${y1}, ₹ Cr` },
    { out: 'margin', label: 'PAT margin' },
    { out: 'days', label: `Sessions in ${y1}` },
    { out: 'shares', label: 'Shares outstanding, Cr' },
    { sec: 'Regression and ratio · 45-session fit' },
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
    case 'gA2': return fmtPct(Math.pow(1 + v.g2 / 100, 4) - 1);
    case 'wSum': {
      const s = v.w0 + v.w1 + v.w2;
      return Math.abs(s - 100) < 1e-9 ? valuationPct(s) : `<span class="rx-dn" title="The weights do not add to 100 %: the average divides by the weights of the methods with a value">${valuationPct(s)} ✕</span>`;
    }
    case 'oi': return fmtNum(v.oi, 0);
    case 'margin': return `${fmtNum(v.margin, 0)} %`;
    case 'days': return fmtNum(v.days, 0);
    case 'shares': return fmtNum(SHARES_OUTSTANDING_CR[d.ex].value, 2);
  }
  if (!c) return dash;
  switch (key) {
    case 'adr45': case 'adr20': case 'adr10': {
      const w = +key.slice(3);
      return fmtNum(valuationDmaAdr(c, w), 2) + (c.nN && c.nN[w] < w ? ` <span class="rx-vi-sub">${c.nN[w]} sessions</span>` : '');
    }
    case 'qAdr': return `${fmtNum(c.qAdr, 2)} <span class="rx-vi-sub">${c.qN} sessions</span>`;
    case 'adrFY': return fmtNum(m.dma.path.adr, 2);
    case 'adrFY2': return fmtNum(m.est.path.adr, 2);
    case 'vs45': return m.est.basis.blank ? '<span class="rx-vi-sub">no custom ADR: the 45 DMA</span>' : rxSignedPct(m.est.adr / c.adr45 - 1, 1);
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

// Value shown in an input: the custom ADR to 2 decimals, blank when none is typed;
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
      avg ? `${d.c.cmp ? `Upside ${valuationUpHTML(avg[1], d.c.cmp)} · CMP ${rxRupee(d.c.cmp)}` : 'no CMP yet'}<br>Bear ${rxRupee(avg[0])} · Bull ${rxRupee(avg[2])} · ADR ${fmtNum(t.adr, 2)}${t.basis.custom && !t.basis.blank ? '' : ` (${t.basis.label})`}`
        : 'no method has a value', { accent: d.ex === shownEx });
  }).join('');
}

// Where the edits are kept, for the drawer's headings, and the line under its title
function valuationWhere(mode) {
  return mode === 'shared' ? 'shared' : mode === 'local' ? 'saved in this browser' : 'loading…';
}

// IST clock time of a Date or ISO timestamp, "14:05"
function valuationClock(t) {
  return new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

// This browser's own edits the shared inputs lack, as the drawer lists them:
// "BSE (P/E base 51 vs shared 48), NSE (…)"; '' when there are none
function valuationUnpublishedText(local, shared, defaults) {
  const diff = valuationUnpublishedKeys(local, shared, defaults);
  const val = x => x === null ? 'blank' : typeof x === 'number' ? String(Math.round(x * 100) / 100) : String(x);
  return Object.entries(diff).map(([ex, keys]) => {
    const sh = valuationPlainObject(valuationPlainObject(shared)[ex]), d = defaults && defaults.ex && defaults.ex[ex];
    const parts = keys.map(k => {
      const cur = k in sh ? sh[k] : d ? d[k] : undefined;
      return `${VALUATION_INPUT_LABELS[k]} ${val(local[ex][k])} vs ${cur === undefined ? 'the default' : `shared ${val(cur)}`}`;
    });
    return `${SHARE_EXCHANGE_NAMES[ex]} (${parts.slice(0, 3).join('; ')}${parts.length > 3 ? '; …' : ''})`;
  }).join(', ');
}

// The drawer's access line: who may edit and, signed in, the save status (VALUATION_SHARED)
// kind: 'pending' | 'local' | 'out' (shared, signed out) | 'in' (shared, signed in)
function valuationAccessKind(S) {
  return S.mode === 'shared' ? (S.signedIn ? 'in' : 'out') : S.mode;
}

function valuationSaveStatusHTML(S, ex) {
  const st = S.status;
  if (st.state === 'saving' || Object.keys(S.pending).length && st.state !== 'error') return 'Saving…';
  if (st.state === 'error') return `<span class="rx-dn" title="${escHtml(st.error || '')}">Couldn’t save</span> <button type="button" class="rx-link" data-vd-retry>Retry</button>`;
  if (st.state === 'saved' && st.at) return `Saved · ${valuationClock(st.at)}`;
  const at = S.updatedAt && S.updatedAt[ex];
  return at ? `Last changed ${new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}` : '';
}

// Opens the drawer on one exchange's inputs. ctx: { ex, defaults, data (its
// valuationExchange result), onChange (re-renders the Valuation Model) }; focus: a selector for
// the control to focus when it opens (default: the first)
function openValuationDrawer(ctx, focus = null) {
  const { ex, defaults, data, onChange } = ctx;
  const name = SHARE_EXCHANGE_NAMES[ex];
  const latest = () => data.c && data.c.lastDate;
  const anyC = data.c;
  const qLabel = anyC ? `Q${anyC.start.q} ${valuationFYShort(anyC.start.fy)}` : 'This quarter';
  const rows = valuationInputsRows(qLabel, anyC ? anyC.start.fy + 1 : defaults.fy);
  let overrides = readValuationOverrides();

  // Sections: inputs and the data-from date in view; reference figures folded
  const input = r => r.type === 'choice'
    ? `<div class="rx-seg" role="group" aria-label="${escHtml(r.label)}" data-vd-choice="${r.key}">${r.options.map(([val, label]) =>
        `<button type="button" data-value="${val}" aria-pressed="false">${label}</button>`).join('')}</div>`
    : r.type === 'date'
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
    return (shown.length ? `<div class="rx-drawer-sec">${gi === 3 ? 'Regression data from · <span data-vd-where>saved in this browser</span>' : g.sec}</div>${shown.map(row).join('')}` : '')
      + (folded.length ? `<details class="rx-how"><summary>${title}</summary>${folded.map(row).join('')}</details>` : '');
  }).join('');

  const S = VALUATION_SHARED;
  let shownKind = null, seenVersion = S.version;
  const listener = () => refresh();
  const el = openRxDrawer({
    title: `${name} valuation inputs`,
    focus,
    body: `<p class="rx-drawer-note" data-vd-note></p>
      <div class="rx-vi-access" data-vd-access></div>
      <div class="rx-vi-access rx-vi-unpub" data-vd-notice role="status" aria-live="polite"></div>
      <div class="rx-vi-access rx-vi-unpub" data-vd-unpub></div>
      ${body}
      <div class="rx-drawer-acts"><span data-vd-edited></span><span data-vd-out-link></span></div>`,
    onClose: () => S.listeners.delete(listener),
  });
  const q = sel => el.querySelector(sel);

  // Who may edit: the note, the access line (sign-in, or the save status), the inputs'
  // disabled state. The access line is redrawn only when its kind changes, so a
  // password being typed survives a status update.
  function access() {
    const kind = valuationAccessKind(S), can = valuationCanEdit();
    el.querySelectorAll('[data-vd-where]').forEach(n => { n.textContent = valuationWhere(S.mode); });
    el.querySelectorAll('input[data-vd], [data-vd-choice] button').forEach(i => { i.disabled = !can; });
    if (kind !== shownKind) {
      shownKind = kind;
      q('[data-vd-note]').textContent = kind === 'local'
        ? 'Saved in this browser over the shared defaults; the tables behind update as you type. Light-blue boxes are inputs; an amber edge marks one edited from the default.'
        : 'Shared by everyone who opens the dashboard, over the defaults in valuation_inputs.json; the tables behind update as you type. Light-blue boxes are inputs; an amber edge marks one edited from the default.';
      q('[data-vd-access]').innerHTML = {
        pending: '<span class="rx-foot">Loading the shared inputs…</span>',
        local: '<span class="rx-vi-msg">Edits are saved in this browser only (shared inputs unavailable).</span>',
        out: `<span class="rx-vi-msg">Read-only: sign in with the team password to change the shared inputs.</span>
          <button type="button" class="rx-btn rx-btn--primary" data-vd-signin>Sign in to edit</button>
          <form class="rx-vi-login" data-vd-login hidden>
            <label class="rx-vi-pw"><span>Team password</span><input type="password" class="rx-in" autocomplete="current-password" data-vd-pw required></label>
            <button type="submit" class="rx-btn rx-btn--primary">Sign in</button>
            <button type="button" class="rx-link" data-vd-cancel>Cancel</button>
            <span class="rx-vi-err" data-vd-err role="alert"></span>
          </form>`,
        in: '<span class="rx-vi-msg">Signed in: your edits save for everyone.</span> <span class="rx-vi-status" data-vd-status role="status" aria-live="polite"></span>',
      }[kind];
      q('[data-vd-out-link]').innerHTML = kind === 'in' ? '<button type="button" class="rx-link" data-vd-signout>Sign out</button>' : '';
    }
    const st = q('[data-vd-status]');
    if (st) st.innerHTML = valuationSaveStatusHTML(S, ex);
    // A colleague's change merged into ours (a 409), or unsaved edits dropped at sign-out
    const notice = S.notice && S.notice.until > Date.now() ? S.notice.text : '';
    const nb = q('[data-vd-notice]');
    if (nb.textContent !== notice) nb.textContent = notice;
    // Edits this browser kept on its own (made before sharing or without the API) that the
    // shared inputs lack: signed in, listed and offered for publishing; signed out, a note
    // with Discard (valuationLocalEditsNote)
    const text = kind === 'in' ? valuationUnpublishedText(readLocalValuationOverrides(), S.inputs, defaults) : '';
    const html = kind === 'in'
      ? (text ? `<span class="rx-vi-msg">This browser has its own edits for ${escHtml(text)}.</span>
          <button type="button" class="rx-btn" data-vd-publish>Publish this browser’s edits</button>
          <button type="button" class="rx-link" data-vd-discard>Discard</button>` : '')
      : kind === 'out' ? valuationLocalEditsNote(defaults, 'data-vd-discard') : '';
    const box = q('[data-vd-unpub]');
    if (box.dataset.html !== html) {
      box.dataset.html = html;
      box.innerHTML = html;
    }
  }

  // The store changed (a load, a save, sign-in or out): show its inputs and access, and
  // re-render the tab behind when the inputs in use changed
  function refresh() {
    if (!el.isConnected) { S.listeners.delete(listener); return; }
    if (saving) return;   // save() shows its own write
    overrides = readValuationOverrides();
    update();
    access();
    if (seenVersion !== S.version) { seenVersion = S.version; if (onChange) onChange(); }
  }

  function update() {
    const { v, edited } = valuationInputsFor(defaults, overrides, ex, latest());
    const c = valuationFitted(data.c, v.from);
    const m = c ? valuationModel(c, v, SHARES_OUTSTANDING_CR[ex].value) : null;
    rows.filter(r => r.out).forEach(r => {
      const n = q(`[data-vd-out="${r.out}"]`);
      if (n) n.innerHTML = valuationInputsCell(r.out, { ...data, c }, v, m);
    });
    VALUATION_EDITABLE.forEach(k => {
      const seg = q(`[data-vd-choice="${k}"]`);
      if (seg) {
        seg.classList.toggle('is-edited', edited.includes(k));
        seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === String(v[k]))));
        return;
      }
      const i = q(`input[data-vd="${k}"]`);
      if (!i) return;
      i.classList.toggle('is-edited', edited.includes(k));
      if (document.activeElement !== i) i.value = valuationInputShown(v, k);
      if (k === 'adr') i.placeholder = 'none';
    });
    q('[data-vd-edited]').innerHTML = edited.length
      ? `${rxChip(`Edited: ${edited.map(k => VALUATION_INPUT_LABELS[k]).join(', ')}`, 'edit')} <button type="button" class="rx-btn" data-vd-reset${valuationCanEdit() ? '' : ' disabled title="Sign in to edit"'}>Reset ${name} to the defaults</button>`
      : '<span class="rx-foot">All inputs at the defaults.</span>';
  }
  // A refused write (signed out) shows the inputs in use again
  let saving = false;
  const save = () => {
    saving = true;
    try {
      if (!writeValuationOverrides(overrides)) overrides = readValuationOverrides();
    } finally { saving = false; }
    seenVersion = S.version;
    update();
    access();
    if (onChange) onChange();
  };
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
    if (!valuationCanEdit() || !valuationInputOk(key, value, latest())) return;
    // From the inputs in use now, not this drawer's copy: a colleague's change merged since
    // (a 409) must not come back as an edit of ours
    overrides = setValuationOverride(readValuationOverrides(), defaults, ex, key, value);
    // A custom ADR typed selects Custom for the estimate table
    if (key === 'adr') overrides = setValuationOverride(overrides, defaults, ex, 'eb', 'custom');
    save();
  });
  // A choice (DMA window, estimate basis): saved on click
  el.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-vd-choice] button[data-value]');
    if (!b || b.getAttribute('aria-pressed') === 'true' || !valuationCanEdit()) return;
    const key = b.closest('[data-vd-choice]').dataset.vdChoice;
    const value = key === 'dma' ? +b.dataset.value : b.dataset.value;
    if (!valuationInputOk(key, value, latest())) return;
    overrides = setValuationOverride(readValuationOverrides(), defaults, ex, key, value);
    save();
  });
  // Leaving a field shows the value in use (an unusable entry reverts); a custom ADR box
  // left empty clears it (Custom then stands in with the 45 DMA). A date input also fires change after each keystroke while it
  // is edited (Chromium), so a half-typed date is left alone until focus leaves.
  el.addEventListener('change', e => {
    const i = e.target.closest && e.target.closest('input[data-vd]');
    if (!i || i.type === 'date') return;
    if (i.dataset.vd === 'adr' && valuationCanEdit() && i.value.trim() === '' && !(i.validity && i.validity.badInput)) {
      overrides = setValuationOverride(readValuationOverrides(), defaults, ex, 'adr', null);
      save();
    }
    showInUse(i);
  });
  el.addEventListener('focusout', e => {
    const i = e.target.closest && e.target.closest('input[data-vd]');
    if (i && i.type === 'date') showInUse(i);
  });
  // Sign in / out and Retry
  el.addEventListener('submit', async e => {
    const form = e.target.closest && e.target.closest('[data-vd-login]');
    if (!form) return;
    e.preventDefault();
    const pw = q('[data-vd-pw]'), err = q('[data-vd-err]'), btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    err.textContent = '';
    const why = await valuationTeamSignIn(pw.value);
    if (!el.isConnected) return;
    btn.disabled = false;
    if (why) { err.textContent = why; pw.select(); return; }
    if (Object.keys(S.pending).length) valuationFlushSaves();   // edits a failed save left waiting
    const first = q('input[data-vd]');
    if (first) first.focus();
  });
  el.addEventListener('click', e => {
    const t = e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest('[data-vd-signin]')) {
      const form = q('[data-vd-login]');
      form.hidden = false;
      t.closest('[data-vd-signin]').hidden = true;
      q('[data-vd-pw]').focus();
      return;
    }
    if (t.closest('[data-vd-cancel]')) {
      q('[data-vd-login]').hidden = true;
      q('[data-vd-signin]').hidden = false;
      q('[data-vd-signin]').focus();
      return;
    }
    if (t.closest('[data-vd-signout]')) {
      // Unsaved edits are sent first; when that fails, signing out drops them, so ask
      valuationTeamSignOut().then(done => {
        if (!done && confirm('Some edits could not be saved and will be lost if you sign out. Sign out anyway?')) valuationTeamSignOut({ force: true });
      });
      return;
    }
    if (t.closest('[data-vd-publish]')) {
      const b = t.closest('[data-vd-publish]');
      b.disabled = true;
      valuationPublishLocal(defaults).finally(() => { if (b.isConnected) b.disabled = false; });
      return;
    }
    if (t.closest('[data-vd-discard]')) { valuationDiscardLocal(); return; }
    if (t.closest('[data-vd-retry]')) { valuationFlushSaves(); return; }
  });
  el.addEventListener('click', e => {
    if (!(e.target.closest && e.target.closest('[data-vd-reset]')) || !valuationCanEdit()) return;
    overrides = { ...readValuationOverrides() };
    delete overrides[ex];
    save();
    el.querySelectorAll('input[data-vd]').forEach(showInUse);
  });
  update();
  access();
  S.listeners.add(listener);
  loadSharedValuationInputs();   // the latest shared inputs and sign-in state; refresh() shows them
}
