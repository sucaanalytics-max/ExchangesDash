"""The Valuation Model tab's figures, per exchange, computed without a browser.

For the Excel mirror (scripts/excel_mirror.py), so the workbooks show exactly the
figures the dashboard shows. Nothing here re-implements the maths: it runs the
dashboard's own functions from dashboard/js/14-valuation.js (and what they call in
13-regression.js and 00-core.js) in Node through scripts/dashboard_js.py, on the
same inputs the tab reads:
  - {ex}_dashboard_data.json, the at-today's-rates file (todayRatesData / DATA on
    the tab), never the date-effective `_eff` variant
  - {ex}_share_analysis.json, whose latest close is the CMP when there is no live
    quote (glanceShare without applyLiveStockPrice's intraday quote)
  - valuation_inputs.json (the defaults) with the shared overrides on top
    (Supabase valuation_inputs, the same sparse {"pe1": 48, ...} the API serves)

The path is the tab's: valuationContextFor → valuationInputsFor → valuationFitted →
valuationModel (valuationAdrPath, valuationAdrModel, valuationRegression,
valuationRatio, valuationTriangulate). The headline target is the ADR-estimate
triangulation's weighted average, as the tab's target strip shows it.

Usage: python scripts/valuation_outputs.py [--overrides overrides.json]
prints the result as JSON (overrides default to none: the committed defaults).
"""

import argparse
import json
import sys
from pathlib import Path

from dashboard_js import DASHBOARD, js_eval

EXCHANGES = ("bse", "mcx", "nse")
DATA_DIR = DASHBOARD / "data"

# The entry points; js_eval(closure=True) adds everything they call
JS_NAMES = ["valuationDefaultsFrom", "valuationContextFor", "valuationInputsFor", "valuationFitted",
            "valuationModel", "valuationCleanOverrides", "SHARES_OUTSTANDING_CR", "VALUATION_INPUT_LABELS"]

# Runs over DATA = {inputs, raw: {ex: json}, share: {ex: json|null}, overrides}
JS_EXPR = r"""(() => {
  const defaults = valuationDefaultsFrom(DATA.inputs);
  if (!defaults) throw new Error('valuation_inputs.json: a value is missing or not a number');
  const tri = (t, cmp) => ({
    adr: t.adr, regression: t.vals.reg, ratio: t.vals.ratio, adr_model: t.vals.adr,
    avg: t.avg, used: t.used, dropped: t.dropped, w_used: t.wUsed, w_total: t.wTotal,
    upside: t.avg && cmp ? t.avg.map(x => x / cmp - 1) : null,
  });
  const exchanges = {};
  for (const ex of VALUATION_EXCHANGES) {
    const raw = DATA.raw[ex], share = DATA.share[ex] || null;
    const c0 = raw ? valuationContextFor(raw, share) : null;
    if (!c0) { exchanges[ex] = { error: !raw ? 'daily data did not load' : 'no daily rows' }; continue; }
    const overrides = DATA.overrides || {};
    const { v, edited } = valuationInputsFor(defaults, overrides, ex, c0.lastDate);
    const c = valuationFitted(c0, v.from);
    const shares = SHARES_OUTSTANDING_CR[ex].value;
    const m = valuationModel(c, v, shares);
    const a = m.adrModel, win = c.win;
    exchanges[ex] = {
      inputs: v, defaults: defaults.ex[ex], edited, overrides: valuationCleanOverrides(overrides[ex]),
      shares_cr: shares,
      context: { q_label: c.qLabel, q_adr: c.qAdr, q_n: c.qN, adr45: c.adr45, n45: c.n45, last_date: c.lastDate, flags: c.flags },
      adr_path: { quarters: m.path.path.map(p => ({ label: p.label, q: p.q, fy: p.fy, adr: p.adr })), fy: m.path.fy, adr: m.path.adr },
      adr_model: { adr_fy: a.adrFY, txn: a.txn, oi: a.oi, total: a.total, margin: a.margin, pat: a.pat, eps: a.eps, pe: a.pe,
                   fy_next_end: a.fwd, fy_end: a.mid, today: a.now },
      dma: tri(m.dma, c.cmp), est: tri(m.est, c.cmp), est_is_dma: m.estIsDma,
      target: { values: m.est.avg, upside: m.est.avg && c.cmp ? m.est.avg.map(x => x / c.cmp - 1) : null },
      cmp: c.cmp, cmp_date: c.cmpDate, cmp_live: c.cmpLive, ticker: c.ticker,
      fit: c.fit, fit_why: c.fitWhy, ratio: c.ratio, ratio_why: c.ratioWhy,
      window: { from: win.from, from_ignored: win.fromIgnored, ma_window: win.maWindow, fit_start: win.fitStart,
                first_point: win.firstPoint, n: win.n, modelled_out: win.modelledOut, published_start: win.pubStart, published_n: win.pubN },
      data_from: win.from || win.fitStart,
      fy_mismatch: c.start.fy + 1 !== defaults.fy,
    };
  }
  return { fy: defaults.fy, labels: VALUATION_INPUT_LABELS, exchanges };
})()"""


def _read_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def load_data(data_dir=DATA_DIR):
    """The committed files the tab reads: {inputs, raw: {ex: json|None}, share: {ex: json|None}}."""
    d = Path(data_dir)
    inputs = _read_json(d / "valuation_inputs.json")
    if inputs is None:
        raise FileNotFoundError(f"{d / 'valuation_inputs.json'} did not load")
    return {
        "inputs": inputs,
        "raw": {ex: _read_json(d / f"{ex}_dashboard_data.json") for ex in EXCHANGES},
        "share": {ex: _read_json(d / f"{ex}_share_analysis.json") for ex in EXCHANGES},
    }


def _slim_raw(raw):
    """Only what valuationContextFor reads: the daily rows' date, quarter, revenue and fee flags."""
    if not raw:
        return raw
    keep = ("date", "fy_quarter", "total_rev", "fee_basis", "fee_basis_by_product", "modelled")
    return {"daily_all": [{k: r[k] for k in keep if k in r} for r in raw.get("daily_all") or []]}


def compute(inputs, raw, share, overrides=None):
    """Per exchange, what the Valuation Model tab shows, from valuation_inputs.json
    (`inputs`), the dashboard files (`raw`), the share files (`share`) and the shared
    overrides ({ex: {key: value}}; unusable keys and values are ignored, as on the tab).

    Returns {fy, labels, exchanges: {ex: {...} | {error}}}; per exchange: inputs (the
    effective inputs), defaults, edited, overrides, shares_cr, context, adr_path, adr_model
    (bear/base/bull at next-FY end, this FY's end and today), dma and est (the two
    triangulations: regression, ratio and ADR model rows, weighted average, upside),
    target (the headline: the estimate triangulation), cmp / cmp_date / cmp_live, fit,
    ratio, window, data_from."""
    data = {"inputs": inputs, "raw": {ex: _slim_raw(raw.get(ex)) for ex in EXCHANGES},
            "share": {ex: share.get(ex) for ex in EXCHANGES}, "overrides": overrides or {}}
    return js_eval(JS_NAMES, JS_EXPR, data, closure=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--overrides", help="JSON file of shared overrides, {ex: {key: value}}")
    ap.add_argument("--data-dir", default=str(DATA_DIR))
    args = ap.parse_args(argv)
    overrides = json.loads(Path(args.overrides).read_text()) if args.overrides else {}
    data = load_data(args.data_dir)
    json.dump(compute(data["inputs"], data["raw"], data["share"], overrides), sys.stdout, indent=1)
    print()


if __name__ == "__main__":
    main()
