// dashboard/js/33-brokers-pat.js — Brokers → PAT Predictor (Angel One, Groww): the PAT
// model the brokers-dashboard engine publishes after each ADR run (src/engine/pat.py
// there; table sb_pat_lines, read through /api/brokers?view=pat). Filed quarters are
// the consolidated results; later quarters, FY 2027 and FY 2028 are projected from
// the engine's ADR with the rule each row carries.
//
// Layout (AB, 10 Nov 2026): the ADR build-up (the current quarter's broking and MTF ADR,
// each × (1 + its own QoQ growth) a quarter since 13 Nov 2026), the FY 2028 PAT predictor
// (Bear / Base / Bull, which differ only in P/E), the FY27 quarterly P&L and the 3-year
// P&L. The engine publishes the inputs' defaults and the constants behind them (`inputs`
// rows, k_* / in_*); when the reader edits an input, patRecompute() re-runs the engine's
// recompute (the contract's algorithm, src/engine/pat_kit.py there) in the browser. Edits
// are kept in memory only (BRK_PAT_LIVE, which the Valuation tab reads), never saved.

// Section headers in the P&L tables, before the first line of each block
const BRK_PAT_SECTIONS = {
  trading_days: 'Drivers', broking: 'Income', mtf_book: 'Memo', finance: 'Costs', pbt: 'Profit',
};
const BRK_PAT_SUBTOTALS = new Set(['total_income', 'total_costs', 'pbt', 'pat']);
const BRK_PAT_SCENARIOS = [['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull']];
const BRK_PAT_VALUATION = ['eps', 'pe', 'price_fwd', 'price_disc', 'target_today', 'upside'];

// The recompute's line sets (CONTRACT.md "Recompute"; src/engine/pat.py REVENUE_LINES / COST_LINES)
const BRK_PAT_REV = {
  ANGELONE: ['broking', 'depository', 'distribution', 'mtf', 'treasury', 'other'],
  GROWW: ['broking', 'mtf', 'float', 'lending', 'other_operating', 'other'],
};
const BRK_PAT_COST = {
  ANGELONE: ['finance', 'fees_commission', 'employee', 'depreciation', 'other_expenses', 'impairment'],
  GROWW: ['finance', 'employee', 'depreciation', 'other_expenses'],
};
// A projected quarter's lines that do not depend on the inputs: the published values
const BRK_PAT_FIXED_Q = {
  ANGELONE: ['distribution', 'treasury', 'other', 'employee', 'depreciation', 'other_expenses', 'impairment'],
  GROWW: ['lending', 'other_operating', 'other', 'employee', 'depreciation'],
};
// FY 2028 costs that do not depend on the inputs
const BRK_PAT_FIXED_FY2 = { ANGELONE: ['employee', 'depreciation', 'other_expenses', 'impairment'], GROWW: ['employee', 'depreciation'] };
const BRK_PAT_TOTALS = ['total_income', 'total_costs', 'pbt', 'tax', 'pat'];
const BRK_PAT_TREASURY = { ANGELONE: 'treasury', GROWW: 'float' };
// The kit: inputs rows every broker needs, and each broker's own
const BRK_PAT_KIT_KEYS = ['in_qoq_growth', 'in_discount_fwd', 'in_discount_today', 'k_tax', 'k_retention', 'k_funding_rate',
  'k_mtf_yield', 'k_fy28_days', 'k_dist_growth_fy28', 'k_treasury_growth_fy28', 'k_adr_broking0', 'k_adr_mtf0', 'k_adr_cash0',
  'k_prev_finance', 'k_prev_mtf_book', 'k_prev_pat', 'k_prev_broking', 'adr_45dma'];
const BRK_PAT_KIT_BROKER = { ANGELONE: ['k_dep_share_of_cash', 'k_fee_ratio'], GROWW: ['k_oexp_ratio', 'k_prev_float'] };
// Lines that are not P&L lines (the build-up, the top block, the kit, the valuation's divisor and price)
const BRK_PAT_NOT_PL = new Set(['adr_consol', 'adr_45dma', 'op_revenue', 'treasury_rev', 'other_inc', 'shares', 'close']);

function brkPatHidden(line) { return BRK_PAT_NOT_PL.has(line) || /^(k|in)_/.test(line); }

// "Q3 FY 2027" → "Q3 FY27", "FY 2028" → "FY28"
function brkPatShort(p) { return p.replace(/ FY \d{2}(\d{2})$/, ' FY$1').replace(/^FY \d{2}(\d{2})$/, 'FY$1'); }

// ── The kit: everything patRecompute needs, read from the published rows ─────
// Returns { kit } or { missing: [what is not published] } (an older run without the new rows).
function brkPatKit(rows) {
  const pub = {}, inputs = {}, pe = {}, step = {}, rem = {}, sofar = {};
  rows.forEach(r => {
    if (r.value == null || !isFinite(r.value)) return;
    if (r.period_key === 'inputs') {
      if (r.line === 'in_pe') pe[r.scenario] = r.value;
      else inputs[r.line] = r.value;
    } else if (r.line === 'k_step') step[r.period_key] = r.value;
    else if (r.line === 'k_rem_days') rem[r.period_key] = r.value;
    else if (/^k_sofar_/.test(r.line)) (sofar[r.period_key] = sofar[r.period_key] || {})[r.line.slice(8)] = r.value;
    else if (r.scenario === '') (pub[r.period_key] = pub[r.period_key] || {})[r.line] = r.value;
  });
  const order = p => brkPeriodOrder(p);
  const fy1q = Object.keys(pub).filter(p => /^Q[1-4] FY \d{4}$/.test(p) && pub[p].pat != null).sort((a, b) => order(a) - order(b));
  const missing = [];
  if (fy1q.length !== 4 || new Set(fy1q.map(q => q.slice(-7))).size !== 1) missing.push('the four quarters of one FY');
  const fy1 = fy1q.length ? fy1q[0].slice(-7) : 'FY ?', fy2 = `FY ${+fy1.slice(3) + 1}`;
  // the rows carry no broker_id: Angel One's kit has the fees ratio, Groww's the other-expenses ratio
  const broker = inputs.k_fee_ratio != null ? 'ANGELONE' : inputs.k_oexp_ratio != null ? 'GROWW' : null;
  if (!broker) missing.push('k_fee_ratio or k_oexp_ratio');
  [...BRK_PAT_KIT_KEYS, ...(BRK_PAT_KIT_BROKER[broker] || [])].forEach(k => { if (inputs[k] == null) missing.push(k); });
  BRK_PAT_SCENARIOS.forEach(([s]) => { if (pe[s] == null) missing.push(`in_pe ${s}`); });
  // projected quarters: those with k_rem_days (one can have step −1 and no days left, the under-5-day start rule)
  const proj = Object.keys(rem).sort((a, b) => order(a) - order(b));
  proj.forEach(q => {
    if (!fy1q.includes(q)) missing.push(`k_rem_days for ${q}, outside ${fy1}`);
    if (!sofar[q]) sofar[q] = {};
    ['broking', 'mtf', 'cash'].forEach(k => { if (sofar[q][k] == null) missing.push(`k_sofar_${k} ${q}`); });
    if (rem[q] == null) missing.push(`k_rem_days ${q}`);
    if (step[q] == null) missing.push(`k_step ${q}`);
  });
  // the published lines the recompute reads: every line of a filed quarter, the fixed lines of a projected one
  const need = [...(BRK_PAT_REV[broker] || []), ...(BRK_PAT_COST[broker] || []), ...BRK_PAT_TOTALS, 'mtf_book'];
  fy1q.forEach(q => (proj.includes(q) ? BRK_PAT_FIXED_Q[broker] || [] : need).forEach(k => { if (pub[q][k] == null) missing.push(`${k} ${q}`); }));
  (BRK_PAT_FIXED_FY2[broker] || []).forEach(k => { if (pub[fy2]?.[k] == null) missing.push(`${k} ${fy2}`); });
  const fy2q = [1, 2, 3, 4].map(k => `Q${k} ${fy2}`);
  fy2q.forEach(q => { if (step[q] == null) missing.push(`k_step ${q}`); });
  if (pub[fy2]?.shares == null || pub[fy2]?.close == null) missing.push(`shares and close for ${fy2}`);
  if (!pub[fy2]) missing.push(fy2);
  // the build-up: the quarters with a published consolidated ADR (the current one to Q4 of the next FY)
  const buildup = Object.keys(pub).filter(p => /^Q/.test(p) && pub[p].adr_consol != null).sort((a, b) => order(a) - order(b));
  if (!buildup.length || pub[fy2]?.adr_consol == null) missing.push('adr_consol');
  buildup.forEach(q => { if (step[q] == null) missing.push(`k_step ${q}`); });
  if (missing.length) return { missing };
  return { kit: {
    broker, fy1, fy2, fy1q, fy2q, proj, buildup, step, rem, sofar, pub, inputs,
    shares: pub[fy2].shares, close: pub[fy2].close, fy0: pub[`FY ${+fy1.slice(3) - 1}`] ? `FY ${+fy1.slice(3) - 1}` : null,
    // gm: MTF's own QoQ growth (in_mtf_qoq_growth, 13 Nov 2026); a run published before it grew MTF at the broking rate
    defaults: { g: inputs.in_qoq_growth, gm: inputs.in_mtf_qoq_growth ?? inputs.in_qoq_growth,
      pe: BRK_PAT_SCENARIOS.map(([s]) => pe[s]), disc: inputs.in_discount_fwd, today: inputs.in_discount_today },
  } };
}

// ── The recompute (CONTRACT.md "Recompute", ported line by line) ─────────────
// kit: brkPatKit(rows).kit; g: QoQ growth of broking (and cash) ADR; pe: [bear, base, bull];
// disc: FY28 → FY27; today: FY27 → today; gm: QoQ growth of MTF ADR (omitted: the kit's
// default). Returns { "<period>|<line>|<scenario>": value } for every line it computes (the
// projected quarters, FY27, FY28, the build-up, the top block and the valuation of FY28 and FY27).
function patRecompute(kit, g, pe, disc, today, gm) {
  const b = kit.broker, I = kit.inputs, P = kit.pub, out = {};
  if (gm == null) gm = kit.defaults.gm;
  const REV = BRK_PAT_REV[b], COST = BRK_PAT_COST[b], sum = (L, ks) => ks.reduce((a, k) => a + L[k], 0);
  const newBorrowing = (book, prevBook, retained) => { const growth = book - prevBook; return growth <= 0 ? growth : Math.max(growth - retained, 0); };
  const b0 = I.k_adr_broking0, m0 = I.k_adr_mtf0, c0 = I.k_adr_cash0, y = I.k_mtf_yield;
  const rate = I.k_funding_rate, ret = I.k_retention, tax = I.k_tax;
  // Groww's finance floor (k_finance_base, 14 Nov 2026): the latest filed quarter's finance cost, which a shrinking
  // MTF book doesn't repay; a run published without it lets the cost fall to 0 (the earlier rule)
  const base = I.k_finance_base;
  let prev = { finance: I.k_prev_finance, mtf_book: I.k_prev_mtf_book, pat: I.k_prev_pat, broking: I.k_prev_broking, float: I.k_prev_float };
  const Q = {};
  kit.proj.forEach(q => {
    const f = (1 + g) ** kit.step[q], fm = (1 + gm) ** kit.step[q], s = kit.sofar[q], rem = kit.rem[q], L = {};
    L.broking = s.broking + rem * b0 * f;
    L.mtf = s.mtf + rem * m0 * fm;
    const cash = s.cash + rem * c0 * f;
    if (b === 'ANGELONE') L.depository = I.k_dep_share_of_cash * cash;
    else L.float = prev.float * L.broking / prev.broking;
    BRK_PAT_FIXED_Q[b].forEach(k => { L[k] = P[q][k]; });
    L.total_income = sum(L, REV);
    L.mtf_book = L.mtf / (y / 4);
    L.finance = Math.max(prev.finance + rate / 4 * newBorrowing(L.mtf_book, prev.mtf_book, ret * prev.pat), base ?? 0);
    if (b === 'ANGELONE') L.fees_commission = I.k_fee_ratio * L.broking;
    else L.other_expenses = I.k_oexp_ratio * L.broking;
    L.total_costs = sum(L, COST);
    L.pbt = L.total_income - L.total_costs;
    L.tax = tax * L.pbt;
    L.pat = L.pbt - L.tax;
    Q[q] = L;
    prev = L;
  });
  // FY27 = the four quarters (filed ones as published); MTF book = their mean
  const qv = (q, k) => (Q[q] ? Q[q][k] : P[q][k]);
  const F1 = {};
  [...REV, ...COST, ...BRK_PAT_TOTALS].forEach(k => { F1[k] = kit.fy1q.reduce((a, q) => a + qv(q, k), 0); });
  F1.mtf_book = kit.fy1q.reduce((a, q) => a + qv(q, 'mtf_book'), 0) / 4;
  F1.adr_broking = b0; F1.adr_mtf = m0;
  F1.pat_margin = F1.pat / F1.total_income;
  // FY28: the four quarters continue the path; days d28
  const path = kit.fy2q.reduce((a, q) => a + (1 + g) ** kit.step[q], 0) / 4;
  const pathM = kit.fy2q.reduce((a, q) => a + (1 + gm) ** kit.step[q], 0) / 4;
  const b28 = b0 * path, m28 = m0 * pathM, d28 = I.k_fy28_days, gd = I.k_dist_growth_fy28, gt = I.k_treasury_growth_fy28;
  const F2 = { adr_broking: b28, adr_mtf: m28, broking: b28 * d28, mtf: m28 * d28 };
  if (b === 'ANGELONE') {
    F2.depository = F1.depository * F2.broking / F1.broking;
    F2.distribution = F1.distribution * (1 + gd);
    F2.treasury = F1.treasury * (1 + gt);
  } else {
    F2.lending = F1.lending * (1 + gd);
    F2.other_operating = F1.other_operating * (1 + gd);
    F2.float = F1.float * (1 + gt);
  }
  F2.other = F1.other;
  F2.total_income = sum(F2, REV);
  F2.mtf_book = F2.mtf / y;
  const nb28 = newBorrowing(F2.mtf_book, F1.mtf_book, ret * F1.pat);
  F2.finance = base != null ? Math.max(4 * qv(kit.fy1q[3], 'finance') + rate * nb28, 4 * base)   // Q4 run-rate × 4
    : Math.max(F1.finance + rate * nb28, 0);
  if (b === 'ANGELONE') F2.fees_commission = I.k_fee_ratio * F2.broking;
  else F2.other_expenses = I.k_oexp_ratio * F2.broking;
  BRK_PAT_FIXED_FY2[b].forEach(k => { F2[k] = P[kit.fy2][k]; });
  F2.total_costs = sum(F2, COST);
  F2.pbt = F2.total_income - F2.total_costs;
  F2.tax = tax * F2.pbt;
  F2.pat = F2.pbt - F2.tax;
  F2.pat_margin = F2.pat / F2.total_income;
  F2.adr_consol = b28 + m28;
  const put = (per, L) => Object.keys(L).forEach(k => { out[`${per}|${k}|`] = L[k]; });
  Object.keys(Q).forEach(q => put(q, Q[q]));
  put(kit.fy1, F1);
  put(kit.fy2, F2);
  // build-up: each quarter from the current one to Q4 FY28
  kit.buildup.forEach(q => { out[`${q}|adr_consol|`] = b0 * (1 + g) ** kit.step[q] + m0 * (1 + gm) ** kit.step[q]; });
  // top block (sums to total income)
  const tr = BRK_PAT_TREASURY[b];
  [[kit.fy0, kit.fy0 && P[kit.fy0]], [kit.fy1, F1], [kit.fy2, F2]].forEach(([per, L]) => {
    if (!L || L.broking == null) return;
    const op = L.broking + L.mtf;
    out[`${per}|op_revenue|`] = op;
    out[`${per}|treasury_rev|`] = L[tr];
    out[`${per}|other_inc|`] = L.total_income - op - L[tr];
  });
  // valuation per scenario: FY28 discounted to FY27, then to today; FY27 (the engine's
  // valuation lines for that year, not on the predictor) carries the first discount only
  [[kit.fy2, F2, true], [kit.fy1, F1, false]].forEach(([per, L, toToday]) => {
    const eps = L.pat / kit.shares;
    BRK_PAT_SCENARIOS.forEach(([s], i) => {
      const price = pe[i] * eps, disc1 = price / (1 + disc), target = toToday ? disc1 / (1 + today) : disc1;
      Object.entries({ eps, pe: pe[i], price_fwd: price, price_disc: disc1, target_today: target, upside: target / kit.close - 1 })
        .forEach(([k, v]) => { out[`${per}|${k}|${s}`] = v; });
    });
  });
  return out;
}

// Tolerance of the load-time check (contract: 0.01 Rs Cr / 0.01 Rs / 1e-6 for fractions)
function brkPatTol(unit) { return unit === 'fraction' || unit === 'x' || unit === 'n' ? 1e-6 : 0.01; }

// Recompute at the published defaults and compare with every published row it covers.
// Returns the lines that differ: [{ key, label, unit, published, recomputed }].
function brkPatCheck(kit, rows) {
  const d = kit.defaults, re = patRecompute(kit, d.g, d.pe, d.disc, d.today, d.gm), bad = [];
  rows.forEach(r => {
    const key = `${r.period_key}|${r.line}|${r.scenario}`;
    if (!(key in re) || r.value == null) return;
    const x = re[key];
    if (!isFinite(x) || Math.abs(x - r.value) > brkPatTol(r.unit)) bad.push({ key, label: r.label || r.line, unit: r.unit, published: r.value, recomputed: x });
  });
  return bad;
}

function brkPatFmt(row) {
  if (!row || row.value == null || !isFinite(row.value)) return '—';
  const v = row.value;
  switch (row.unit) {
    case 'days': return fmtNum(v, 1);
    case 'Rs Cr / day': return fmtNum(v, 2);
    case 'fraction': return row.line === 'upside' ? rxSignedPct(v) : `${fmtNum(v * 100, 1)} %`;
    case 'x': return `${fmtNum(v, 1)}×`;
    case 'Rs': return fmtNum(v, 2);
    case 'crore shares': return fmtNum(v, 2);
    default: return fmtNum(v, 1);
  }
}

// A cell's text in a given format (data-f on the cell)
function brkPatCell(v, f) {
  if (v == null || !isFinite(v)) return '—';
  switch (f) {
    case 'cr0': return fmtNum(v, 0);
    case 'adr': return fmtNum(v, 2);
    case 'days': return fmtNum(v, 1);
    case 'days0': return fmtNum(v, 0);
    case 'pct': return `${fmtNum(v * 100, 1)} %`;
    case 'pct0': return `${fmtNum(v * 100, 0)} %`;
    case 'up': return rxSignedPct(v);
    case 'x': return `${fmtNum(v, 1)}×`;
    case 'rs0': return '₹' + fmtNum(v, 0);
    case 'rs2': return fmtNum(v, 2);
    default: return fmtNum(v, 1);
  }
}

// The cell format of a published row in the P&L tables
function brkPatF(unit) {
  return unit === 'days' ? 'days' : unit === 'Rs Cr / day' ? 'adr' : unit === 'fraction' ? 'pct' : unit === 'x' ? 'x' : unit === 'Rs' ? 'rs2' : 'cr1';
}

// A column's tag: F = a filed quarter, P = projected (in whole or in part)
function brkPatTag(regime) {
  return regime === 'actual'
    ? '<span class="brk-tag brk-tag--act" title="Filed: the consolidated results">F</span>'
    : '<span class="brk-tag brk-tag--est" title="Projected by the PAT model (a full year includes any filed quarters)">P</span>';
}

function brkPatRegime(idx, col) {
  const r = (idx.pat || {})[col] || Object.values(idx).map(l => l[col]).find(Boolean);
  return r ? r.regime : null;
}

// Columns: the quarters, then the FY totals ("Q1 FY 2027" … "FY 2027", "FY 2028")
function brkPatColumns(rows) {
  const keys = [...new Set(rows.map(r => r.period_key))];
  const by = re => keys.filter(k => re.test(k)).sort((a, b) => brkPeriodOrder(a) - brkPeriodOrder(b));
  return [...by(/^Q[1-4] FY \d{4}$/), ...by(/^FY \d{4}$/)];
}

// { line: { period: row } } for one scenario ('' for the P&L lines)
function brkPatIndex(rows, scenario = '') {
  const out = {};
  rows.filter(r => r.scenario === scenario).forEach(r => { (out[r.line] = out[r.line] || {})[r.period_key] = r; });
  return out;
}

async function buildBrokersPat() {
  const el = brkSection('pat'), summary = BRK.summary;
  if (!BRK.pat || BRK.patFor !== summary) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading the PAT model…</div></div>';
    let pat;
    const slow = () => { if (BRK.summary === summary) el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Still loading the PAT model… asked the server again.</div></div>'; };
    try { pat = await brkFetchPatient('pat', BRK.mode, slow); } catch (err) {
      el.innerHTML = `<div class="brk-wrap"><div class="brk-empty">Couldn't load the PAT model: ${escHtml(err.message)}</div></div>`;
      return;
    }
    if (BRK.summary !== summary) return;   // the broker or run changed meanwhile
    BRK.pat = pat; BRK.patFor = summary;
  }
  const pat = BRK.pat, name = escHtml(BRK_BROKER.name);
  if (!pat.run || !pat.rows.length) {
    el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="chart-panel brk-norun" role="status">
      <b>No PAT model published for ${name} yet.</b>
      <p>${escHtml(pat.reason || '')}. The brokers-dashboard engine publishes it to <code>sb_pat_lines</code> after each ${escHtml(BRK.mode)} ADR run; nothing is estimated on this page in the meantime.</p></div></div>`;
    return;
  }
  const { kit, missing } = brkPatKit(pat.rows);
  if (!kit) {
    delete BRK_PAT_LIVE[BRK_BROKER.id];
    brkPatLegacy(el, pat, summary, missing);
    return;
  }
  brkPatPredictor(el, pat, summary, kit);
}

// The run note at the top of the tab
function brkPatRunNote(pat, summary, extra) {
  const sameRun = summary.run && summary.run.run_id === pat.run.run_id;
  return `run <code title="${escHtml(pat.run.run_id)}">${escHtml(pat.run.run_id.slice(0, 8))}</code>, as of ${escHtml(fmtLongDate(pat.run.as_of_date))}${sameRun ? '' : ', an earlier run than the ADR tabs show: the PAT step has not published for the latest run yet'}${extra || ''}`;
}

// ── The predictor layout: build-up, PAT predictor, quarterly and 3-year P&L ──
function brkPatPredictor(el, pat, summary, kit) {
  const rows = pat.rows, name = escHtml(BRK_BROKER.name), broker = BRK_BROKER.id, runId = pat.run.run_id;
  const pubRow = {};
  rows.forEach(r => { pubRow[`${r.period_key}|${r.line}|${r.scenario}`] = r; });
  const D = kit.defaults;
  const bad = brkPatCheck(kit, rows), locked = bad.length > 0;
  // the reader's inputs: kept in memory for this broker's run (the Valuation tab reads them too)
  let live = BRK_PAT_LIVE[broker];
  if (!live || live.run !== runId || locked) live = null;
  const copy = x => ({ g: x.g, gm: x.gm ?? x.g, pe: [...x.pe], disc: x.disc, today: x.today });
  const st = live ? copy(live.inp) : copy(D);
  const fy1 = kit.fy1, fy2 = kit.fy2, s1 = brkPatShort(fy1), s2 = brkPatShort(fy2);
  const pl = brkPatIndex(rows.filter(r => !brkPatHidden(r.line)));
  const regimeOf = col => brkPatRegime(pl, col);

  // ── (a) ADR build-up ──
  const buildQs = kit.buildup;
  const cur = buildQs[0], curRule = pubRow[`${cur}|adr_consol|`]?.rule;
  const pv = (key, f, cls = '') => `<td class="${cls}" data-pv="${escHtml(key)}" data-f="${f}"></td>`;
  // a build-up cell the page computes from the kit (broking, MTF and the MTF book per quarter; not published lines)
  const bu = (q, what, f, cls = '') => `<td class="${cls}" data-bu="${escHtml(q)}|${what}" data-f="${f}"></td>`;
  const growIn = (k, what) => `<input class="rx-in rx-num-in rx-xl-in" type="number" step="0.5" inputmode="decimal" data-pin="${k}" aria-label="QoQ growth of ${what} ADR, % a quarter">`;
  const I0 = kit.inputs, bookDays = I0.k_fy28_days, y = I0.k_mtf_yield;
  const bookOf = adr => adr * bookDays / y;       // the MTF book an MTF ADR implies (₹ Cr): ADR × trading days ÷ yield
  const buildup = rxPanel({
    title: 'ADR build-up', meta: `₹ Cr / day · two inputs: the QoQ growth of broking ADR and of MTF ADR`,
    body: `<div class="rx-pb rx-scroll"><table class="rx-table rx-xl brk-pat-build" aria-label="ADR build-up: broking, MTF and consolidated">
      <thead><tr><th scope="col" class="rx-xl-lab rx-xl-t">Period</th><th scope="col" class="rx-xl-t">Broking ADR</th><th scope="col" class="rx-xl-t">MTF ADR</th>
        <th scope="col" class="rx-xl-t" title="The MTF book the MTF ADR implies: MTF ADR × ${fmtNum(bookDays, 0)} trading days ÷ ${fmtNum(y * 100, 2)} % yield">MTF book ₹ Cr</th><th scope="col" class="rx-xl-t rx-xl-r">Consolidated ADR</th></tr></thead>
      <tbody>
        <tr class="rx-xl-bold"><td class="rx-xl-lab">QoQ growth</td>
          <td class="rx-xl-key-in">${growIn('g', 'broking')}<span class="rx-xl-unit">%</span> <span class="brk-pat-note" title="Annualised: (1 + g)^4 − 1">(<span data-pd="annual-g"></span> a yr)</span></td>
          <td class="rx-xl-key-in">${growIn('gm', 'MTF')}<span class="rx-xl-unit">%</span> <span class="brk-pat-note" title="Annualised: (1 + g)^4 − 1">(<span data-pd="annual-gm"></span> a yr)</span></td>
          <td class="brk-pat-note" data-pd="book-add" title="MTF book added in the first quarter after the current one"></td><td class="rx-xl-r"></td></tr>
        <tr class="brk-pat-ref"><td class="rx-xl-lab">Current 45 DMA</td><td></td><td></td><td></td>${pv('inputs|adr_45dma|', 'adr', 'rx-xl-r')}</tr>
        ${buildQs.map((q, i) => `<tr${i === 0 ? ' class="rx-xl-bold"' : ''}><td class="rx-xl-lab">${escHtml(brkPatShort(q))}${i === 0 ? ' <span class="brk-pat-est">(estimate)</span>' : ''}</td>${bu(q, 'b', 'adr')}${bu(q, 'm', 'adr')}${bu(q, 'book', 'cr0')}${pv(`${q}|adr_consol|`, 'adr', 'rx-xl-r')}</tr>`).join('')}
        <tr class="rx-xl-bold brk-pat-avg"><td class="rx-xl-lab rx-xl-t rx-xl-b">${escHtml(s2)} Avg</td>${pv(`${fy2}|adr_broking|`, 'adr', 'rx-xl-t rx-xl-b')}${pv(`${fy2}|adr_mtf|`, 'adr', 'rx-xl-t rx-xl-b')}${bu(fy2, 'book', 'cr0', 'rx-xl-t rx-xl-b')}${pv(`${fy2}|adr_consol|`, 'adr', 'rx-xl-t rx-xl-b rx-xl-r')}</tr>
        <tr class="brk-pat-ref"><td class="rx-xl-lab">Growth from current 45 DMA</td><td></td><td></td><td></td><td class="rx-xl-r" data-pd="vs45"></td></tr>
      </tbody></table></div>`,
    foot: `${escHtml(brkPatShort(cur))} (estimate) is the quarter's ADR so far: broking ${fmtNum(I0.k_adr_broking0, 2)} and MTF gross ${fmtNum(I0.k_adr_mtf0, 2)} a day${curRule ? ` (${escHtml(curRule)})` : ''}. Each later quarter's broking ADR = that × (1 + broking growth) a quarter, its MTF ADR = that × (1 + MTF growth); consolidated = the two together. ${escHtml(s2)} Avg = the average of its four quarters, which sets ${escHtml(s2)}'s operating revenue below. MTF book = MTF ADR × ${fmtNum(bookDays, 0)} days ÷ ${fmtNum(y * 100, 2)} % yield (the P&L's MTF book is MTF income ÷ yield per period, so it differs slightly). The 45 DMA (${escHtml(pubRow['inputs|adr_45dma|']?.rule || 'mean of the last 45 engine days of broking + MTF')}) is for reference only.`,
  });

  // ── (b) PAT predictor ──
  const heads = BRK_PAT_SCENARIOS.map(([s, l], i) => `<th scope="col" class="rx-xl-h rx-xl-${s} rx-xl-t${i === 2 ? ' rx-xl-r' : ''}">${l}</th>`).join('');
  const same = (key, f) => BRK_PAT_SCENARIOS.map((_, i) => pv(key, f, i === 2 ? 'rx-xl-r' : '')).join('');
  const per = (line, f) => BRK_PAT_SCENARIOS.map(([s], i) => pv(`${fy2}|${line}|${s}`, f, i === 2 ? 'rx-xl-r' : '')).join('');
  const prow = (label, cells, cls = '', note = '') => `<tr${cls ? ` class="${cls}"` : ''}><td class="rx-xl-lab"${note ? ` title="${escHtml(note)}"` : ''}>${label}</td>${cells}</tr>`;
  const peIn = i => `<td class="rx-xl-key${i === 2 ? ' rx-xl-r' : ''}"><input class="rx-in rx-num-in rx-xl-in" type="number" step="1" min="0" inputmode="decimal" data-pin="pe${i}" aria-label="P/E, ${BRK_PAT_SCENARIOS[i][1]}"></td>`;
  const tre = BRK_BROKER.id === 'GROWW' ? 'float income' : 'other interest income (treasury)';
  const predictor = rxPanel({
    title: `PAT predictor ${escHtml(fy2)}`, meta: '₹ Cr · per-share figures in ₹ · the scenarios differ only in P/E',
    body: `<div class="brk-pat-pred">
      <div class="rx-scroll brk-pat-pred-t"><table class="rx-table rx-xl brk-pat-xl" aria-label="PAT predictor ${escHtml(fy2)}, Bear / Base / Bull">
        <thead><tr><th scope="col" class="rx-xl-lab rx-xl-t">${escHtml(s2.replace('FY', 'FY20'))}</th>${heads}</tr></thead>
        <tbody>
          ${prow('Operating ADR', same(`${fy2}|adr_consol|`, 'adr'), '', `${s2} Avg in the build-up above`)}
          ${prow('Trading days', same(`${fy2}|trading_days|`, 'days0'))}
          ${prow('Operating Revenue', same(`${fy2}|op_revenue|`, 'cr0'), '', 'Operating ADR × trading days = broking + MTF in the P&L')}
          ${prow('Treasury Revenue', same(`${fy2}|treasury_rev|`, 'cr0'), '', `The P&L's ${tre}`)}
          ${prow('Other Income', same(`${fy2}|other_inc|`, 'cr0'), '', 'Total income − operating − treasury')}
          ${prow('Total Income', same(`${fy2}|total_income|`, 'cr0'), 'rx-xl-bold brk-pat-shade')}
          ${prow(`Total costs (${escHtml(s2)} cost structure)`, same(`${fy2}|total_costs|`, 'cr0'))}
          ${prow('PAT', same(`${fy2}|pat|`, 'cr0'), 'rx-xl-bold rx-xl-green')}
          ${prow('PAT Margin (on net revenue)', same(`${fy2}|pat_margin|`, 'pct0'), '', 'PAT ÷ total income')}
          <tr><td class="rx-xl-lab">PE</td>${[0, 1, 2].map(peIn).join('')}</tr>
          ${prow(`${escHtml(s2)} Price`, per('price_fwd', 'rs0'), '', 'P/E × EPS')}
          ${prow('Discounted', per('price_disc', 'rs0'), '', `÷ (1 + discount ${s2} → ${s1})`)}
          ${prow('Target price today', per('target_today', 'rs0'), 'rx-xl-bold rx-xl-peach', `÷ (1 + discount ${s1} → today)`)}
          <tr class="brk-pat-up"><td class="rx-xl-lab rx-xl-b">Upside</td>${BRK_PAT_SCENARIOS.map(([s], i) => pv(`${fy2}|upside|${s}`, 'up', `rx-xl-b${i === 2 ? ' rx-xl-r' : ''}`)).join('')}</tr>
        </tbody></table></div>
      <aside class="brk-pat-inputs" aria-label="Inputs">
        <div class="rx-lbl">Inputs</div>
        <div class="rx-field"><label for="brkPatDisc-${BRK_BROKER.view}">Discount ${escHtml(s2)} → ${escHtml(s1)}</label>
          <input id="brkPatDisc-${BRK_BROKER.view}" class="rx-in rx-xl-in" type="number" step="0.5" inputmode="decimal" data-pin="disc"><div class="rx-tags"><span class="rx-foot">% a year</span></div></div>
        <div class="rx-field"><label for="brkPatToday-${BRK_BROKER.view}">Discount ${escHtml(s1)} → today</label>
          <input id="brkPatToday-${BRK_BROKER.view}" class="rx-in rx-xl-in" type="number" step="0.5" inputmode="decimal" data-pin="today"><div class="rx-tags"><span class="rx-foot">%</span></div></div>
        <p class="rx-foot">Broking and MTF QoQ growth: in the build-up · P/E: in the PE row. EPS = PAT ÷ <span data-pv="${escHtml(fy2)}|shares|" data-f="rs2"></span> Cr shares = ₹<span data-pv="${escHtml(fy2)}|eps|base" data-f="rs2"></span>; close ₹<span data-pv="${escHtml(fy2)}|close|" data-f="rs2"></span>.</p>
        <button type="button" class="rx-btn" data-pat-reset>Reset to published</button>
        <p class="rx-foot brk-pat-state" data-pat-state role="status" aria-live="polite"></p>
      </aside></div>`,
    foot: `Operating revenue = ${escHtml(s2)} Avg ADR × trading days, the same figure as broking + MTF in the 3-year P&L. Total costs follow the P&L's cost build-up (finance cost on the MTF book${BRK_BROKER.id === 'GROWW' ? ', not below the latest filed quarter' : ''}, fees or other expenses as a share of broking). Upside is the target today vs the close.`,
  });

  // ── (c), (d) P&L tables ──
  const lines = [...new Set(rows.filter(r => r.scenario === '' && !brkPatHidden(r.line) && r.period_key !== 'inputs')
    .sort((a, b) => a.sort_order - b.sort_order).map(r => r.line))];
  const ruleKey = (c, line) => `${c}|${line}|`;
  const plTable = (cols, firstFy) => {
    const ls = lines.filter(l => cols.some(c => pl[l]?.[c]));
    let lastSec = null;
    const body = ls.map(line => {
      const any = Object.values(pl[line])[0];
      const sec = BRK_PAT_SECTIONS[line] && BRK_PAT_SECTIONS[line] !== lastSec ? `<tr class="brk-pat-sec"><td colspan="${cols.length + 1}">${(lastSec = BRK_PAT_SECTIONS[line])}</td></tr>` : '';
      const cls = [BRK_PAT_SUBTOTALS.has(line) ? 'rx-sub' : '', line === 'mtf_book' ? 'brk-pat-memo' : ''].filter(Boolean).join(' ');
      const unit = any.unit === 'Rs Cr / day' ? ' <span class="rx-foot">₹ Cr / day</span>' : any.unit === 'days' ? ' <span class="rx-foot">days</span>' : '';
      return `${sec}<tr${cls ? ` class="${cls}"` : ''}><td class="rx-l">${escHtml(any.label)}${unit}</td>${cols.map(c => {
        const r = pl[line][c];
        const k = `${c === firstFy ? 'brk-pat-fy' : ''}${r?.regime === 'projected' ? ' brk-pat-proj' : ''}`.trim();
        return r ? `<td class="${k}" data-pv="${escHtml(ruleKey(c, line))}" data-f="${brkPatF(r.unit)}"></td>` : `<td class="${k}">—</td>`;
      }).join('')}</tr>`;
    }).join('');
    return `<div class="rx-scroll"><table class="rx-table brk-pat-pl">
      <thead><tr><th scope="col" class="rx-l">Line</th>${cols.map(c => `<th scope="col" class="${c === firstFy ? 'brk-pat-fy' : ''}">${escHtml(brkPatShort(c) + (/^FY/.test(c) && regimeOf(c) !== 'actual' ? 'E' : ''))} ${brkPatTag(regimeOf(c))}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody></table></div>`;
  };
  const tagFoot = `<span class="brk-tag brk-tag--act">F</span> Filed: ${escHtml(BRK_BROKER.name)}'s consolidated results · <span class="brk-tag brk-tag--est">P</span> Projected by the model. Hover a figure for its rule.`;
  const years = [kit.fy0, fy1, fy2].filter(Boolean);
  const projCols = [...kit.fy1q, ...years].filter(c => regimeOf(c) === 'projected' && lines.some(l => pl[l]?.[c]?.rule));
  const rules = rxHow('Rules behind the projections', `<div class="rx-scroll"><table class="rx-table brk-pat-rules">
    <thead><tr><th scope="col" class="rx-l">Line</th>${projCols.map(c => `<th scope="col" class="rx-l">${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${lines.filter(l => projCols.some(c => pl[l]?.[c]?.rule)).map(l => `<tr><td class="rx-l">${escHtml(Object.values(pl[l])[0].label)}</td>${projCols.map(c => `<td class="rx-l rx-wrap" data-pr="${escHtml(ruleKey(c, l))}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="rx-foot">Shares: ${escHtml(pl.shares?.[fy2]?.rule || pubRow[`${fy2}|shares|`]?.rule || '—')}. Share price: ${escHtml(pubRow[`${fy2}|close|`]?.rule || '—')}. The assumptions (growth rates, cost rules, P/E, discount rates) are rows of <code>sb_assumptions</code> in the brokers-dashboard project, each naming its workbook cell.</p>`);
  const quarterly = rxPanel({ title: `Quarterly P&L ${escHtml(fy1)}`, meta: '₹ Cr unless marked', body: plTable(kit.fy1q, null), foot: tagFoot });
  const threeYear = rxPanel({ title: `3-year P&L`, meta: `${escHtml(years.join(' · '))} · ₹ Cr unless marked`, body: plTable(years, fy1),
    foot: `${tagFoot} ${kit.fy0 ? `${escHtml(kit.fy0)} is the sum of its four filed quarters (MTF book: their average). ` : ''}The ${escHtml(s1)} column's ADR is the one the projection starts from (the current quarter's so far), the ${escHtml(s2)} column's its average for that year.`,
    how: rules });

  const checkNote = locked ? rxAlert(`<strong>The inputs are switched off: recomputing at the published defaults does not give the published figures.</strong> ${bad.slice(0, 4).map(x => `${escHtml(x.key.replace(/\|$/, '').replace(/\|/g, ' · '))}: published ${fmtNum(x.published, 4)}, recomputed ${fmtNum(x.recomputed, 4)}`).join('; ')}${bad.length > 4 ? `; and ${bad.length - 4} more` : ''}. The figures below are the engine's as published.`) : '';
  el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="rx brk-pat">
    ${rxAlert(`<strong>PAT model, as the engine published it</strong> (${brkPatRunNote(pat, summary)}). ${kit.proj.length ? `${escHtml(kit.fy1q.filter(q => !kit.proj.includes(q)).join(' and ') || 'No quarter')} ${kit.fy1q.length - kit.proj.length === 1 ? 'is' : 'are'} ${name}'s filed results; the rest is projected from the engine's ADR. ` : ''}${locked ? '' : 'Change the broking or MTF QoQ growth, a P/E or a discount rate and the page recomputes the build-up, the predictor, both P&Ls and the Valuation tab\'s ADR method with the engine\'s own rules. Your edits stay on this page and are not saved.'}`, 'info')}
    ${checkNote}
    ${buildup}
    ${predictor}
    ${quarterly}
    ${threeYear}
  </div></div>`;
  const root = el.firstElementChild;
  const ins = [...root.querySelectorAll('[data-pin]')];
  const shown = x => String(+(x * 100).toFixed(4));
  const get = (o, k) => (k === 'g' ? o.g : k === 'gm' ? o.gm : k === 'disc' ? o.disc : k === 'today' ? o.today : o.pe[+k.slice(2)]);
  const setInputs = () => ins.forEach(i => {
    const k = i.dataset.pin, x = get(st, k);
    i.value = /^pe/.test(k) ? String(x) : shown(x);
  });
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-9;
  const sameInp = (a, b) => ['g', 'gm', 'disc', 'today', 'pe0', 'pe1', 'pe2'].every(k => near(get(a, k), get(b, k)));
  const isEdited = () => !sameInp(st, D);
  const pct1 = x => `${fmtNum(x * 100, 1)} %`;
  const growthText = o => `broking ${pct1(o.g)} and MTF ${pct1(o.gm)} QoQ`;
  const inputsText = o => `${growthText(o)}, P/E ${o.pe.map(x => fmtNum(x, 1)).join(' / ')}×, discounts ${pct1(o.disc)} and ${pct1(o.today)}`;

  const paint = () => {
    const edited = !locked && isEdited();
    const re = edited ? patRecompute(kit, st.g, st.pe, st.disc, st.today, st.gm) : null;
    const why = key => {
      const valLine = /\|(eps|price_fwd|price_disc|target_today|upside)\|/.test(key);
      return `recalculated on this page at ${valLine ? inputsText(st) : growthText(st)}`;
    };
    const value = key => {
      const r = pubRow[key];
      if (re && key in re) {
        const changed = !r || Math.abs(re[key] - r.value) > brkPatTol(r?.unit);
        return { v: re[key], rule: changed ? why(key) : r?.rule, changed };
      }
      return { v: r ? r.value : null, rule: r?.rule, changed: false };
    };
    root.querySelectorAll('[data-pv]').forEach(td => {
      const x = value(td.dataset.pv);
      td.textContent = brkPatCell(x.v, td.dataset.f);
      td.classList.toggle('brk-pat-chg', x.changed);
      if (td.tagName === 'TD') { if (x.rule) td.title = x.rule; else td.removeAttribute('title'); }
      if (td.dataset.f === 'up') { td.classList.toggle('rx-up', x.v >= 0); td.classList.toggle('rx-dn', x.v < 0); }
    });
    root.querySelectorAll('[data-pr]').forEach(td => {
      const x = value(td.dataset.pr);
      td.textContent = x.rule || '';
      td.classList.toggle('brk-pat-chg', x.changed);
    });
    // the build-up's broking, MTF and MTF book per quarter, at the inputs shown (the published ones while locked)
    const at = locked ? D : st;
    const bAt = q => I0.k_adr_broking0 * (1 + at.g) ** kit.step[q], mAt = q => I0.k_adr_mtf0 * (1 + at.gm) ** kit.step[q];
    root.querySelectorAll('[data-bu]').forEach(td => {
      const [q, what] = td.dataset.bu.split('|');
      const v = q === fy2 ? bookOf(value(`${fy2}|adr_mtf|`).v) : what === 'b' ? bAt(q) : what === 'm' ? mAt(q) : bookOf(mAt(q));
      td.textContent = brkPatCell(v, td.dataset.f);
      td.classList.toggle('brk-pat-chg', edited && !(what === 'b' ? near(at.g, D.g) : near(at.gm, D.gm)));
      td.title = what === 'b' ? `broking ${fmtNum(I0.k_adr_broking0, 3)} × (1 + ${pct1(at.g)})^${kit.step[q] ?? ''}`
        : what === 'm' ? `MTF ${fmtNum(I0.k_adr_mtf0, 3)} × (1 + ${pct1(at.gm)})^${kit.step[q] ?? ''}`
          : `MTF ADR × ${fmtNum(bookDays, 0)} days ÷ ${fmtNum(y * 100, 2)} % yield`;
    });
    const annual = (k, g) => { const n = root.querySelector(`[data-pd="annual-${k}"]`); if (n) n.textContent = `${fmtNum(((1 + g) ** 4 - 1) * 100, 0)} %`; };
    annual('g', at.g); annual('gm', at.gm);
    const add = root.querySelector('[data-pd="book-add"]');
    if (add) add.textContent = `+₹${fmtNum(bookOf(I0.k_adr_mtf0) * at.gm, 0)} Cr next qtr`;
    const vs45 = root.querySelector('[data-pd="vs45"]');
    if (vs45) {
      const avg = value(`${fy2}|adr_consol|`).v, dma = value('inputs|adr_45dma|').v;
      vs45.textContent = avg != null && dma ? `${fmtNum((avg / dma - 1) * 100, 0)} %` : '—';
    }
    ins.forEach(i => {
      const k = i.dataset.pin;
      i.classList.toggle('is-edited', !near(get(st, k), get(D, k)));
      i.disabled = locked;
      if (locked) i.title = 'Switched off: the published figures could not be reproduced (see the note above)';
    });
    root.querySelector('[data-pat-reset]').disabled = locked || !edited;
    root.querySelector('[data-pat-state]').textContent = locked ? 'Inputs switched off.'
      : edited ? `Showing your inputs (${growthText(st)}); recalculated lines are tinted. The Valuation tab's ADR method uses them too.`
        : 'Showing the published figures.';
    // the Valuation tab's ADR method reads this
    if (edited) BRK_PAT_LIVE[broker] = { run: runId, inp: { ...st, pe: [...st.pe] }, edited: true,
      targets: Object.fromEntries(BRK_PAT_SCENARIOS.map(([s]) => [s, re[`${fy2}|target_today|${s}`]])),
      desc: inputsText(st) };
    else delete BRK_PAT_LIVE[broker];
  };
  setInputs();
  paint();
  if (locked) return;
  root.addEventListener('input', e => {
    const i = e.target.closest('[data-pin]');
    if (!i) return;
    const x = parseFloat(i.value);
    if (!isFinite(x)) return;                      // half-typed: keep the last good value
    const k = i.dataset.pin;
    if (k === 'g' || k === 'gm' || k === 'disc' || k === 'today') { if (x <= -100) return; st[k] = x / 100; }
    else st.pe[+k.slice(2)] = x;
    paint();
  });
  root.querySelector('[data-pat-reset]').addEventListener('click', () => {
    Object.assign(st, copy(D));
    setInputs();
    paint();
  });
}

// ── The earlier layout, for a run published before the build-up rows ────────
function brkPatLegacy(el, pat, summary, missing) {
  const rows = pat.rows.filter(r => !brkPatHidden(r.line) || r.line === 'shares' || r.line === 'close').filter(r => r.period_key !== 'inputs');
  const cols = brkPatColumns(rows).filter(c => !/^Q/.test(c) || rows.some(r => r.period_key === c && r.line === 'pat')), pl = brkPatIndex(rows);
  const name = escHtml(BRK_BROKER.name);
  const val = Object.fromEntries(BRK_PAT_SCENARIOS.map(([s]) => [s, brkPatIndex(rows, s)]));
  const fys = cols.filter(c => /^FY/.test(c) && pl.pat?.[c]), qs = cols.filter(c => /^Q/.test(c));
  const vfys = fys.filter(fy => val.base.eps?.[fy]);
  const fy1 = vfys[0] || fys[0], fy2 = vfys[vfys.length - 1] || fys[fys.length - 1];
  const short = fy => fy.replace(/^FY \d{2}(\d{2})$/, 'FY$1');
  const v = (line, col, s = '') => { const r = (s ? val[s][line] : pl[line])?.[col]; return r && isFinite(r.value) ? r.value : null; };
  const filed = qs.filter(q => pl.pat?.[q]?.regime === 'actual');
  const closeRow = pl.close?.[fy2];
  const closeOn = /close on (\d{4}-\d{2}-\d{2})/.exec(closeRow?.rule || '');

  // ── KPIs ──
  const patGrowth = v('pat', fy1) ? v('pat', fy2) / v('pat', fy1) - 1 : null;
  const kpis = [
    rxKpi(`PAT ${short(fy1)}E`, rxCr(v('pat', fy1), 0),
      filed.length ? `${filed.map(q => q.slice(0, 2)).join(' + ')} filed, the rest projected` : 'projected'),
    rxKpi(`PAT ${short(fy2)}E`, rxCr(v('pat', fy2), 0), patGrowth == null ? '' : `${rxChangeHTML(patGrowth)} vs ${short(fy1)}E`),
    rxKpi(`Broking ADR ${short(fy2)}E`, `${rxCr(v('adr_broking', fy2), 2)}<small> / day</small>`,
      v('adr_broking', fy1) == null ? '' : `from ${fmtNum(v('adr_broking', fy1), 2)} a day today (${short(fy1)} base)`),
    rxKpi('Share price', rxRupee(v('close', fy2), 2), closeOn ? `close on ${escHtml(fmtLongDate(closeOn[1]))}` : ''),
    rxKpi(`Base target today (${short(fy2)})`, rxRupee(v('target_today', fy2, 'base'), 0),
      v('upside', fy2, 'base') == null ? '' : `${rxChangeHTML(v('upside', fy2, 'base'))} vs the close`, { accent: true }),
  ].join('');

  // ── Valuation: EPS → target price, per scenario, for each FY ──
  const vRow = line => {
    const lbl = (val.base[line]?.[fy2] || val.base[line]?.[fy1])?.label || line;
    return `<tr class="${line === 'target_today' ? 'rx-sub' : ''}"><td class="rx-l">${escHtml(lbl)}</td>${vfys.map(fy => BRK_PAT_SCENARIOS.map(([s]) => {
      const r = val[s][line]?.[fy];
      const cls = line === 'upside' && r ? (r.value >= 0 ? 'rx-up' : 'rx-dn') : '';
      return `<td class="${cls}${s === 'bear' ? ' brk-pat-fy' : ''}">${brkPatFmt(r)}</td>`;
    }).join('')).join('')}</tr>`;
  };
  // The discounts, read back from the published prices (shown, not used)
  const disc = fy => {
    const p = v('price_fwd', fy, 'base'), d = v('price_disc', fy, 'base'), t = v('target_today', fy, 'base');
    let txt = `${short(fy)}: P/E × EPS`;
    if (p && d) txt += ` ÷ (1 + ${fmtNum((p / d - 1) * 100, 1)} %)`;
    if (d && t && Math.abs(d / t - 1) > 1e-9) txt += ` ÷ (1 + ${fmtNum((d / t - 1) * 100, 1)} %) for the extra year`;
    return txt;
  };
  const valuation = rxPanel({
    title: 'Valuation', meta: `EPS on ${fmtNum(v('shares', fy2), 2)} Cr shares · target prices in ₹`,
    body: `<div class="rx-scroll"><table class="rx-table brk-pat-val">
      <thead><tr><th scope="col" rowspan="2" class="rx-l">Line</th>${vfys.map(fy => `<th scope="colgroup" colspan="3" class="rx-c brk-pat-fy">${escHtml(fy)}E</th>`).join('')}</tr>
        <tr>${vfys.map(() => BRK_PAT_SCENARIOS.map(([s, l]) => `<th scope="col" class="${s === 'bear' ? 'brk-pat-fy' : ''}">${l}</th>`).join('')).join('')}</tr></thead>
      <tbody>${BRK_PAT_VALUATION.filter(l => val.base[l]).map(vRow).join('')}</tbody></table></div>`,
    foot: `Target today = ${vfys.map(disc).join(' · ')}. Upside is the target today vs the close. The scenarios differ only in P/E.`,
  });

  // ── P&L: filed and projected quarters, then the years ──
  const lines = [...new Set(rows.filter(r => r.scenario === '' && !['shares', 'close'].includes(r.line))
    .sort((a, b) => a.sort_order - b.sort_order).map(r => r.line))];
  const firstFy = fys[0];
  const plBody = lines.map(line => {
    const any = Object.values(pl[line])[0];
    const sec = BRK_PAT_SECTIONS[line] ? `<tr class="brk-pat-sec"><td colspan="${cols.length + 1}">${BRK_PAT_SECTIONS[line]}</td></tr>` : '';
    const cls = [BRK_PAT_SUBTOTALS.has(line) ? 'rx-sub' : '', line === 'mtf_book' ? 'brk-pat-memo' : ''].filter(Boolean).join(' ');
    return `${sec}<tr${cls ? ` class="${cls}"` : ''}><td class="rx-l">${escHtml(any.label)}${any.unit === 'Rs Cr / day' ? ' <span class="rx-foot">₹ Cr / day</span>' : any.unit === 'days' ? ' <span class="rx-foot">days</span>' : ''}</td>${cols.map(c => {
      const r = pl[line][c];
      return `<td class="${c === firstFy ? 'brk-pat-fy' : ''}${r?.regime === 'projected' ? ' brk-pat-proj' : ''}"${r?.rule ? ` title="${escHtml(r.rule)}"` : ''}>${brkPatFmt(r)}</td>`;
    }).join('')}</tr>`;
  }).join('');

  // ── The rules behind every projected figure (the same text as the hover titles) ──
  const projCols = cols.filter(c => brkPatRegime(pl, c) === 'projected' && lines.some(l => pl[l][c]?.rule));
  const rules = rxHow('Rules behind the projections', `<div class="rx-scroll"><table class="rx-table brk-pat-rules">
    <thead><tr><th scope="col" class="rx-l">Line</th>${projCols.map(c => `<th scope="col" class="rx-l">${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${lines.filter(l => projCols.some(c => pl[l][c]?.rule)).map(l => `<tr><td class="rx-l">${escHtml(Object.values(pl[l])[0].label)}</td>${projCols.map(c => `<td class="rx-l rx-wrap">${escHtml(pl[l][c]?.rule || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="rx-foot">Shares: ${escHtml(pl.shares?.[fy2]?.rule || '—')}. Share price: ${escHtml(closeRow?.rule || '—')}. The assumptions (growth rates, cost rules, P/E bands, discount rates) are rows of <code>sb_assumptions</code> in the brokers-dashboard project, each naming its workbook cell.</p>`);
  const plTable = rxPanel({
    title: 'P&L build', meta: '₹ Cr unless marked · hover a projected figure for its rule',
    body: `<div class="rx-scroll"><table class="rx-table brk-pat-pl">
      <thead><tr><th scope="col" class="rx-l">Line</th>${cols.map(c => `<th scope="col" class="${c === firstFy ? 'brk-pat-fy' : ''}">${escHtml(c.replace(/ FY \d{2}(\d{2})$/, ' FY$1').replace(/^FY \d{2}(\d{2})$/, 'FY$1E'))} ${brkPatTag(brkPatRegime(pl, c))}</th>`).join('')}</tr></thead>
      <tbody>${plBody}</tbody></table></div>`,
    foot: `<span class="brk-tag brk-tag--act">F</span> Filed: the quarter's consolidated results (${escHtml(BRK_BROKER.name)}'s filings) · <span class="brk-tag brk-tag--est">P</span> Projected by the model. Trading days and ADR: a projected quarter's days include those already traded; the ${short(fy1)} column shows the ADR the projection starts from (today's), the ${short(fy2)} column its average for that year.`,
    how: rules,
  });

  el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="rx">
    ${rxAlert(`<strong>Earlier layout.</strong> This run of the PAT model was published without the rows the ADR build-up and the editable PAT predictor need (${escHtml(missing.slice(0, 6).join(', '))}${missing.length > 6 ? ', …' : ''}), so the page shows it as before, with no inputs, until the engine's updated PAT step publishes a run with them.`)}
    ${rxAlert(`<strong>PAT model, as the engine published it.</strong> ${filed.length ? `${escHtml(filed.join(' and '))} are ${name}'s filed consolidated results; ` : ''}the rest of ${escHtml(fy1)} and ${escHtml(fy2)} are projected from the engine's ADR (${brkPatRunNote(pat, summary)}). This page computes nothing.`, 'info')}
    <section class="rx-kpis" aria-label="PAT summary">${kpis}</section>
    ${valuation}
    ${plTable}
  </div></div>`;
}
