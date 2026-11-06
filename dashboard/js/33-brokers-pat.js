// dashboard/js/33-brokers-pat.js — Brokers → PAT Predictor (Angel One, Groww): the PAT
// model the brokers-dashboard engine publishes after each ADR run (src/engine/pat.py
// there; table sb_pat_lines, read through /api/brokers?view=pat). Filed quarters are
// the consolidated results; later quarters, FY 2027 and FY 2028 are projected from
// the engine's ADR with the rule each row carries. This file lays the lines out and
// computes nothing beyond the ratios between two published figures that it labels.

// Section headers in the P&L table, before the first line of each block
const BRK_PAT_SECTIONS = {
  trading_days: 'Drivers', broking: 'Income', mtf_book: 'Memo', finance: 'Costs', pbt: 'Profit',
};
const BRK_PAT_SUBTOTALS = new Set(['total_income', 'total_costs', 'pbt', 'pat']);
const BRK_PAT_SCENARIOS = [['bear', 'Bear'], ['base', 'Base'], ['bull', 'Bull']];
const BRK_PAT_VALUATION = ['eps', 'pe', 'price_fwd', 'price_disc', 'target_today', 'upside'];

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

// A column's tag: F = a filed quarter, P = projected (in whole or in part)
function brkPatTag(regime) {
  return regime === 'actual'
    ? '<span class="brk-tag brk-tag--act" title="Filed: the quarter\'s consolidated results">F</span>'
    : '<span class="brk-tag brk-tag--est" title="Projected by the PAT model (a full year includes any filed quarters)">P</span>';
}

function brkPatRegime(idx, col) {
  const r = (idx.pat || {})[col] || Object.values(idx).map(l => l[col]).find(Boolean);
  return r ? r.regime : null;
}

async function buildBrokersPat() {
  const el = brkSection('pat'), summary = BRK.summary;
  if (!BRK.pat || BRK.patFor !== summary) {
    el.innerHTML = '<div class="brk-wrap"><div class="brk-empty">Loading the PAT model…</div></div>';
    let pat;
    try { pat = await brkFetch('pat', BRK.mode); } catch (err) {
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

  const rows = pat.rows, cols = brkPatColumns(rows), pl = brkPatIndex(rows);
  const val = Object.fromEntries(BRK_PAT_SCENARIOS.map(([s]) => [s, brkPatIndex(rows, s)]));
  const fys = cols.filter(c => /^FY/.test(c)), qs = cols.filter(c => /^Q/.test(c));
  const fy1 = fys[0], fy2 = fys[fys.length - 1];
  const short = fy => fy.replace(/^FY \d{2}(\d{2})$/, 'FY$1');
  const v = (line, col, s = '') => { const r = (s ? val[s][line] : pl[line])?.[col]; return r && isFinite(r.value) ? r.value : null; };
  const filed = qs.filter(q => pl.pat?.[q]?.regime === 'actual');
  const closeRow = pl.close?.[fy2];
  const closeOn = /close on (\d{4}-\d{2}-\d{2})/.exec(closeRow?.rule || '');
  const sameRun = summary.run && summary.run.run_id === pat.run.run_id;

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
    return `<tr class="${line === 'target_today' ? 'rx-sub' : ''}"><td class="rx-l">${escHtml(lbl)}</td>${fys.map(fy => BRK_PAT_SCENARIOS.map(([s]) => {
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
      <thead><tr><th scope="col" rowspan="2" class="rx-l">Line</th>${fys.map(fy => `<th scope="colgroup" colspan="3" class="rx-c brk-pat-fy">${escHtml(fy)}E</th>`).join('')}</tr>
        <tr>${fys.map(() => BRK_PAT_SCENARIOS.map(([s, l]) => `<th scope="col" class="${s === 'bear' ? 'brk-pat-fy' : ''}">${l}</th>`).join('')).join('')}</tr></thead>
      <tbody>${BRK_PAT_VALUATION.filter(l => val.base[l]).map(vRow).join('')}</tbody></table></div>`,
    foot: `Target today = ${fys.map(disc).join(' · ')}. Upside is the target today vs the close. The scenarios differ only in P/E.`,
  });

  // ── P&L: filed and projected quarters, then the years ──
  const lines = [...new Set(rows.filter(r => r.scenario === '' && !['shares', 'close'].includes(r.line))
    .sort((a, b) => a.sort_order - b.sort_order).map(r => r.line))];
  const plBody = lines.map(line => {
    const any = Object.values(pl[line])[0];
    const sec = BRK_PAT_SECTIONS[line] ? `<tr class="brk-pat-sec"><td colspan="${cols.length + 1}">${BRK_PAT_SECTIONS[line]}</td></tr>` : '';
    const cls = [BRK_PAT_SUBTOTALS.has(line) ? 'rx-sub' : '', line === 'mtf_book' ? 'brk-pat-memo' : ''].filter(Boolean).join(' ');
    return `${sec}<tr${cls ? ` class="${cls}"` : ''}><td class="rx-l">${escHtml(any.label)}${any.unit === 'Rs Cr / day' ? ' <span class="rx-foot">₹ Cr / day</span>' : any.unit === 'days' ? ' <span class="rx-foot">days</span>' : ''}</td>${cols.map(c => {
      const r = pl[line][c];
      return `<td class="${c === fys[0] ? 'brk-pat-fy' : ''}${r?.regime === 'projected' ? ' brk-pat-proj' : ''}"${r?.rule ? ` title="${escHtml(r.rule)}"` : ''}>${brkPatFmt(r)}</td>`;
    }).join('')}</tr>`;
  }).join('');
  const plTable = () => rxPanel({
    title: 'P&L build', meta: '₹ Cr unless marked · hover a projected figure for its rule',
    body: `<div class="rx-scroll"><table class="rx-table brk-pat-pl">
      <thead><tr><th scope="col" class="rx-l">Line</th>${cols.map(c => `<th scope="col" class="${c === fys[0] ? 'brk-pat-fy' : ''}">${escHtml(c.replace(/ FY \d{2}(\d{2})$/, ' FY$1').replace(/^FY \d{2}(\d{2})$/, 'FY$1E'))} ${brkPatTag(brkPatRegime(pl, c))}</th>`).join('')}</tr></thead>
      <tbody>${plBody}</tbody></table></div>`,
    foot: `<span class="brk-tag brk-tag--act">F</span> Filed: the quarter's consolidated results (${escHtml(BRK_BROKER.name)}'s filings) · <span class="brk-tag brk-tag--est">P</span> Projected by the model. Trading days and ADR: a projected quarter's days include those already traded; the ${short(fy1)} column shows the ADR the projection starts from (today's), the ${short(fy2)} column its average for that year.`,
    how: rules,
  });

  // ── The rules behind every projected figure (the same text as the hover titles) ──
  const projCols = cols.filter(c => brkPatRegime(pl, c) === 'projected' && lines.some(l => pl[l][c]?.rule));
  const rules = rxHow('Rules behind the projections', `<div class="rx-scroll"><table class="rx-table brk-pat-rules">
    <thead><tr><th scope="col" class="rx-l">Line</th>${projCols.map(c => `<th scope="col" class="rx-l">${escHtml(c)}</th>`).join('')}</tr></thead>
    <tbody>${lines.filter(l => projCols.some(c => pl[l][c]?.rule)).map(l => `<tr><td class="rx-l">${escHtml(Object.values(pl[l])[0].label)}</td>${projCols.map(c => `<td class="rx-l rx-wrap">${escHtml(pl[l][c]?.rule || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="rx-foot">Shares: ${escHtml(pl.shares?.[fy2]?.rule || '—')}. Share price: ${escHtml(closeRow?.rule || '—')}. The assumptions (growth rates, cost rules, P/E bands, discount rates) are rows of <code>sb_assumptions</code> in the brokers-dashboard project, each naming its workbook cell.</p>`);

  el.innerHTML = `<div class="brk-wrap">${summary.run ? brkRunBar({ legend: false }) : ''}<div class="rx">
    ${rxAlert(`<strong>PAT model, as the engine published it.</strong> ${filed.length ? `${escHtml(filed.join(' and '))} are ${name}'s filed consolidated results; ` : ''}the rest of ${escHtml(fy1)} and ${escHtml(fy2)} are projected from the engine's ADR (run <code title="${escHtml(pat.run.run_id)}">${escHtml(pat.run.run_id.slice(0, 8))}</code>, as of ${escHtml(fmtLongDate(pat.run.as_of_date))})${sameRun ? '' : ', an earlier run than the ADR tabs show: the PAT step has not published for the latest run yet'}. This page computes nothing.`, 'info')}
    <section class="rx-kpis" aria-label="PAT summary">${kpis}</section>
    ${valuation}
    ${plTable()}
  </div></div>`;
}
