"""Revenue Summary in F&O contracts (dashboard/js/23-contracts-view.js), run in Node.

The contracts view rebuilds, in the browser, the period aggregates the page
reads: the pipelines' raw quarterly / monthly / weekly rows and the enriched
seg_summary objects, with average contracts per day (crore) in the revenue
fields. The parity tests feed one revenue fixture to the pipelines
(nse_pipeline / bse_pipeline seg_summary and recompute_*) and to the JS mirror,
so the mirror follows the pipelines' definitions, labels and rounding."""

import copy
import functools
import json
import math
import subprocess
import unittest
from datetime import date, timedelta

from helpers import DASHBOARD, JS_FILES, NODE, js_eval

import bse_pipeline as bse
import nse_pipeline as nse

CV_JS = ["quarterSortKey", "FY_MONTH_ORDER", "monthSortKey", "combineRawData", "combineEnrichedData",
         "WEEKDAYS", "CONTRACTS_PER_CRORE", "contractsNum", "contractsRound", "contractsPySum",
         "contractsWeekLabel", "contractsGroup", "contractsDailyRows", "contractsSegSummary",
         "contractsAggregates", "contractsView", "CONTRACTS_JOINED_ROWS", "contractsViewRows", "contractsRatio",
         "contractsCombined"]

# Holidays inside the fixture, so weekdays repeat unevenly (as in real data)
HOLIDAYS = {"2025-08-15", "2025-10-02", "2025-10-21", "2025-12-25", "2026-01-26", "2026-03-31",
            "2026-04-03", "2026-05-01", "2026-08-27"}


def labels(d):
    return {"date": d.isoformat(), "day": d.strftime("%A"), "fy_quarter": nse.date_to_fy_quarter(d),
            "fy_month": nse.date_to_fy_month(d), "fy": nse.date_to_fy(d)}


def weekdays(start, n):
    d, out = date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5 and d.isoformat() not in HOLIDAYS:
            out.append(d)
        d += timedelta(days=1)
    return out


def revenue_rows(start, n):
    """Revenue rows in the pipelines' schema. Values are multiples of 1/8, so
    every sum is exact (Python 3.12's compensated sum() and a plain sum agree)
    and some quarter sums end in .x25 / .x75: ties at 2 dp, which Python rounds
    half to even."""
    out = []
    for i, d in enumerate(weekdays(start, n)):
        opt = (i * 37 % 101) / 8 + 20
        fut = (i * 11 % 23) / 8 + 1
        cash = (i * 5 % 7) / 8
        out.append({**labels(d), "opt_rev": opt, "fut_rev": fut, "cash_rev": cash, "total_rev": opt + fut + cash})
    return out


def nse_row(d, io, so, if_, sf, io_p=0.0, so_p=0.0):
    return {**labels(date.fromisoformat(d)), "io_contracts": io, "so_contracts": so, "if_contracts": if_,
            "sf_contracts": sf, "io_premium": io_p, "so_premium": so_p, "total_contracts": io + so + if_ + sf,
            "opt_rev": 99.0, "fut_rev": 9.0, "cash_rev": 9.0, "total_rev": 117.0, "fee_basis": "slab_estimate"}


def bse_row(d, contracts, premium=0.0):
    return {**labels(date.fromisoformat(d)), "total_contracts": contracts, "options_premium_turnover": premium,
            "opt_rev": 50.0, "fut_rev": 0.0, "cash_rev": 2.0, "total_rev": 52.0}


def run(expr, data=None):
    return js_eval(CV_JS, expr, data)


class Close:
    def assertClose(self, got, want, path="$"):
        """Deep equality, floats to 1e-9 (ints and floats compare as numbers)."""
        if isinstance(want, dict):
            self.assertIsInstance(got, dict, path)
            self.assertEqual(sorted(got), sorted(want), path)
            for k in want:
                self.assertClose(got[k], want[k], f"{path}.{k}")
        elif isinstance(want, list):
            self.assertIsInstance(got, list, path)
            self.assertEqual(len(got), len(want), path)
            for i, (g, w) in enumerate(zip(got, want)):
                self.assertClose(g, w, f"{path}[{i}]")
        elif isinstance(want, (int, float)) and not isinstance(want, bool):
            self.assertIsInstance(got, (int, float), path)
            self.assertTrue(math.isclose(got, want, rel_tol=0, abs_tol=1e-9), f"{path}: {got} != {want}")
        else:
            self.assertEqual(got, want, path)


@unittest.skipUnless(NODE, "node not installed")
class SegSummaryParity(Close, unittest.TestCase):
    """contractsSegSummary(rows, field, dp) is seg_summary(rows, field). The two
    pipelines differ only in recompute_quarterly / recompute_monthly rounding
    their sums (NSE 2 dp, BSE 4 dp), which seg_summary's quarter and month
    averages read; dp selects it."""

    FIXTURES = {
        # The brief's ~140 days: two FY quarters and month boundaries, across FY 2026 → FY 2027
        "140 days": ("2026-02-02", 140),
        # Long enough for the same quarter a year earlier (YoY), and > 125 days
        "320 days": ("2025-07-01", 320),
        # Fewer than 10 rows: the short-history branches
        "7 days": ("2026-06-29", 7),
    }

    def check(self, pipeline, dp):
        for name, (start, n) in self.FIXTURES.items():
            rows = revenue_rows(start, n)
            for field in ("total_rev", "opt_rev", "fut_rev"):
                with self.subTest(fixture=name, field=field):
                    want = pipeline.seg_summary(rows, field)
                    got = run(f"contractsSegSummary(DATA, '{field}', {dp})", rows)
                    self.assertClose(got, want)

    def test_parity_with_nse_seg_summary(self):
        self.check(nse, 2)

    def test_parity_with_bse_seg_summary(self):
        self.check(bse, 4)

    def test_fixture_has_two_dp_ties(self):
        # Guards the fixture: Python rounds these half to even, JS toFixed would not
        sums = [sum(r["total_rev"] for r in revenue_rows("2025-07-01", 320) if r["fy_month"] == m["month"])
                for m in nse.recompute_monthly(revenue_rows("2025-07-01", 320))]
        self.assertTrue(any(round(s * 1000) % 10 == 5 for s in sums))

    def test_empty_rows(self):
        self.assertClose(run("contractsSegSummary([], 'total_rev')"), nse.seg_summary([], "total_rev"))

    def test_round_matches_python(self):
        vals = [0.125, 0.375, 2.5, -0.125, 1.005, 2.675, 123.45675, 0.00005, 1e-20, 7.0, -3.14159]
        for dp in (2, 4):
            with self.subTest(dp=dp):
                got = run(f"DATA.map(v => contractsRound(v, {dp}))", vals)
                self.assertEqual(got, [round(v, dp) for v in vals])

    def test_sum_matches_python(self):
        vals = [0.1] * 10 + [1e16, 1.0, -1e16] + [1 / 3] * 7
        self.assertEqual(run("contractsPySum(DATA)", vals), sum(vals))
        self.assertEqual(run("contractsPySum([])"), 0)


@unittest.skipUnless(NODE, "node not installed")
class AggregatesParity(Close, unittest.TestCase):
    PAGE_FIELDS = ("total_rev", "opt_rev", "fut_rev", "cash_rev", "days")

    def test_parity_aggregates(self):
        rows = revenue_rows("2025-07-01", 320)
        for pipeline, dp in ((nse, 2), (bse, 4)):
            got = run(f"contractsAggregates(DATA, {dp})", rows)
            for kind, label, py in (("quarterly", "quarter", pipeline.recompute_quarterly(rows)),
                                    ("monthly", "month", pipeline.recompute_monthly(rows)),
                                    ("weekly", "week", pipeline.recompute_weekly(rows)[-15:])):
                with self.subTest(pipeline=pipeline.__name__, kind=kind):
                    want = [{k: r[k] for k in (label,) + self.PAGE_FIELDS} for r in py]
                    self.assertClose([{k: r[k] for k in (label,) + self.PAGE_FIELDS} for r in got[kind]], want)
            # The dashboard file's daily (last 120) and daily_all
            built = pipeline.build_outputs(rows, [], [], {}) if pipeline is nse else pipeline.build_outputs(rows)
            dash = built["dashboard"]
            self.assertEqual([r["date"] for r in got["daily"]], [r["date"] for r in dash["daily"]])
            self.assertEqual([r["date"] for r in got["daily_all"]], [r["date"] for r in dash["daily_all"]])
            self.assertEqual(len(got["weekly"]), len(dash["weekly"]))

    def test_null_field_stays_null(self):
        # BSE futures and every exchange's cash: no figure, not a sum of 0
        rows = run("contractsAggregates(contractsDailyRows(DATA, 'bse'))",
                   [bse_row("2026-07-01", 2e7), bse_row("2026-07-02", 3e7)])
        q = rows["quarterly"][0]
        self.assertIsNone(q["fut_rev"])
        self.assertIsNone(q["cash_rev"])
        self.assertAlmostEqual(q["opt_rev"], 5.0)
        self.assertEqual(q["days"], 2)


@unittest.skipUnless(NODE, "node not installed")
class DailyRows(unittest.TestCase):
    def test_nse_fields(self):
        r = run("contractsDailyRows(DATA, 'nse')", [nse_row("2026-07-01", 3e7, 1e7, 2e6, 3e6, 1000.0, 250.0)])[0]
        self.assertAlmostEqual(r["opt_rev"], 4.0)
        self.assertAlmostEqual(r["fut_rev"], 0.5)
        self.assertAlmostEqual(r["total_rev"], 4.5)
        self.assertIsNone(r["cash_rev"])
        self.assertEqual(r["opt_contracts"], 4e7)
        self.assertAlmostEqual(r["opt_premium"], 1250.0)
        for k in ("date", "day", "fy", "fy_quarter", "fy_month"):
            self.assertEqual(r[k], labels(date(2026, 7, 1))[k])
        # Contracts are not fees: no fee-basis label travels with them
        self.assertNotIn("fee_basis", r)

    def test_bse_options_only(self):
        r = run("contractsDailyRows(DATA, 'bse')", [bse_row("2026-07-01", 2.5e7, 2000.0)])[0]
        self.assertAlmostEqual(r["opt_rev"], 2.5)
        self.assertAlmostEqual(r["total_rev"], 2.5)
        self.assertIsNone(r["fut_rev"])
        self.assertIsNone(r["cash_rev"])
        self.assertEqual(r["opt_contracts"], 2.5e7)
        self.assertAlmostEqual(r["opt_premium"], 2000.0)

    def test_bse_rows_without_contracts_dropped(self):
        # BSE before 2023-04-19: total_contracts 0, or absent / null
        rows = [bse_row("2023-04-03", 0, 0), {**bse_row("2023-04-05", 0), "total_contracts": None},
                {k: v for k, v in bse_row("2023-04-06", 0).items() if k != "total_contracts"},
                bse_row("2023-04-19", 1, 0.0), bse_row("2023-05-15", 828, 0.06)]
        got = run("contractsDailyRows(DATA, 'bse').map(r => r.date)", rows)
        self.assertEqual(got, ["2023-04-19", "2023-05-15"])

    def test_nse_rows_without_segment_contracts_dropped(self):
        rows = [nse_row("2026-07-01", 3e7, 1e7, 2e6, 3e6), {**nse_row("2026-07-02", 3e7, 1e7, 2e6, 3e6), "so_contracts": None},
                {k: v for k, v in nse_row("2026-07-03", 3e7, 1e7, 2e6, 3e6).items() if k != "if_contracts"},
                nse_row("2026-07-06", 0, 0, 0, 0)]
        self.assertEqual(run("contractsDailyRows(DATA, 'nse').map(r => r.date)", rows), ["2026-07-01"])

    def test_other_exchanges_have_no_contracts_view(self):
        self.assertEqual(run("contractsDailyRows(DATA, 'mcx')", [bse_row("2026-07-01", 2e7)]), [])


@unittest.skipUnless(NODE, "node not installed")
class Ratio(unittest.TestCase):
    def test_ratio_is_sum_over_sum(self):
        two = [bse_row("2026-07-01", 100, 1.0), bse_row("2026-07-02", 300, 3.0)]
        self.assertAlmostEqual(run("contractsRatio(contractsDailyRows(DATA, 'bse'))", two), 100.0)
        three = two + [bse_row("2026-07-03", 50, 2.0)]
        # Σ contracts ÷ Σ premium = 450 / 6, not the mean of daily ratios (100, 100, 25)
        self.assertAlmostEqual(run("contractsRatio(contractsDailyRows(DATA, 'bse'))", three), 75.0)

    def test_ratio_filter_and_no_premium(self):
        rows = [bse_row("2026-06-30", 100, 1.0), bse_row("2026-07-01", 300, 2.0), bse_row("2026-07-02", 5, 0.0)]
        got = run("[contractsRatio(contractsDailyRows(DATA, 'bse'), r => r.fy_quarter === 'Q2 FY 2027'),"
                  " contractsRatio(contractsDailyRows(DATA, 'bse'), r => r.date === '2026-07-02'),"
                  " contractsRatio([], null)]", rows)
        # The 2026-07-02 day has no premium: its contracts stay out of the sum too
        self.assertAlmostEqual(got[0], 300 / 2)
        self.assertIsNone(got[1])
        self.assertIsNone(got[2])

    def test_ratio_skips_days_without_premium(self):
        # A day with contracts but no premium would inflate Σ contracts ÷ Σ premium
        rows = [bse_row("2026-07-01", 100, 1.0), bse_row("2026-07-02", 300, 0.0), bse_row("2026-07-03", 50, -1.0)]
        self.assertAlmostEqual(run("contractsRatio(contractsDailyRows(DATA, 'bse'))", rows), 100.0)

    def test_nse_ratio_uses_option_contracts_and_premium_only(self):
        rows = [nse_row("2026-07-01", 3000, 1000, 5e6, 5e6, 3.0, 1.0)]
        self.assertAlmostEqual(run("contractsRatio(contractsDailyRows(DATA, 'nse'))", rows), 1000.0)


def combined_fixture():
    """NSE in Q4 FY 2026 and Q1 FY 2027; BSE only in Q1 FY 2027 (as before 2023-04-19)."""
    nse_days = [d.isoformat() for d in weekdays("2026-03-02", 45)]
    nse_rows = [nse_row(d, 3e7 + i * 1e5, 1e7, 2e6, 3e6 + i * 1e4, 2000.0, 500.0) for i, d in enumerate(nse_days)]
    bse_rows = [bse_row(d, 0, 0) for d in nse_days if d < "2026-04-01"]
    bse_rows += [bse_row(d, 5e7 + i * 2e5, 3000.0) for i, d in enumerate(x for x in nse_days if x >= "2026-04-01")]
    return {"nse": {"daily_all": nse_rows}, "bse": {"daily_all": bse_rows}}


COMBINED = """(() => {
  const n = contractsView(DATA.nse, 'nse'), b = contractsView(DATA.bse, 'bse');
  const c = contractsCombined(n, b);
  const bad = [];
  const walk = (o, p) => {
    if (typeof o === 'number' && !isFinite(o)) bad.push(p);
    else if (o && typeof o === 'object') Object.keys(o).forEach(k => walk(o[k], p + '.' + k));
  };
  walk(c, '$');
  return { n, b, c, bad,
    ratio: { nse: contractsRatio(contractsViewRows(n)), bse: contractsRatio(contractsViewRows(b)),
             all: contractsRatio(contractsViewRows(c)) },
    joined: contractsViewRows(c).map(r => r.date) };
})()"""


@unittest.skipUnless(NODE, "node not installed")
class Combined(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = run(COMBINED, combined_fixture())

    def test_view_shape(self):
        n, b = self.out["n"], self.out["b"]
        for v in (n, b):
            self.assertEqual(sorted(v["data"]), ["daily", "daily_all", "monthly", "quarterly", "weekly"])
            self.assertIsNone(v["enriched"]["seg_cash"])
            self.assertIn("quarterly", v["enriched"]["summary_total"])
        self.assertIsNotNone(n["enriched"]["seg_futures"])
        # BSE has no futures contracts: no summary, so its Futures tab shows "—", never 0
        self.assertIsNone(b["enriched"]["seg_futures"])
        self.assertEqual(b["data"]["quarterly"][0]["quarter"], "Q1 FY 2027")

    def test_combined_futures_nse_only(self):
        n, c = self.out["n"], self.out["c"]
        self.assertTrue(c["fut_note"])
        self.assertTrue(c["data"]["fut_note"])
        for q in c["data"]["quarterly"]:
            nq = next(x for x in n["data"]["quarterly"] if x["quarter"] == q["quarter"])
            self.assertAlmostEqual(q["fut_rev"], nq["fut_rev"] / nq["days"])
            self.assertEqual(q["days"], 1)
        nf, cf = n["enriched"]["seg_futures"], c["enriched"]["seg_futures"]
        self.assertAlmostEqual(cf["quarterly"]["current"]["value"], nf["quarterly"]["current"]["value"])
        self.assertAlmostEqual(cf["monthly"]["avg_6m"]["value"], nf["monthly"]["avg_6m"]["value"])
        self.assertAlmostEqual(cf["fy"]["current"], nf["fy"]["current"])
        self.assertEqual([x["exchange"] for x in c["data"]["components"]], ["nse", "bse"])

    def test_combined_sums_options(self):
        n, b, c = self.out["n"], self.out["b"], self.out["c"]
        q = next(x for x in c["data"]["quarterly"] if x["quarter"] == "Q1 FY 2027")
        nq = next(x for x in n["data"]["quarterly"] if x["quarter"] == "Q1 FY 2027")
        bq = b["data"]["quarterly"][0]
        self.assertAlmostEqual(q["opt_rev"], nq["opt_rev"] / nq["days"] + bq["opt_rev"] / bq["days"])
        self.assertAlmostEqual(c["enriched"]["seg_options"]["weekly"]["last5"]["value"],
                               n["enriched"]["seg_options"]["weekly"]["last5"]["value"]
                               + b["enriched"]["seg_options"]["weekly"]["last5"]["value"])

    def test_combined_without_bse_period(self):
        c, n = self.out["c"], self.out["n"]
        self.assertEqual(self.out["bad"], [])
        q = next(x for x in c["data"]["quarterly"] if x["quarter"] == "Q4 FY 2026")
        nq = next(x for x in n["data"]["quarterly"] if x["quarter"] == "Q4 FY 2026")
        for f in ("total_rev", "opt_rev", "fut_rev"):
            self.assertTrue(math.isfinite(q[f]), f)
            self.assertAlmostEqual(q[f], nq[f] / nq["days"])

    def test_combined_ratio_joins_dates_both_exchanges_have(self):
        # As the Contracts to Premium tab: NSE+BSE sums both exchanges over the
        # dates on which both traded options, not over every row of either
        r = self.out["ratio"]
        fx = combined_fixture()
        nc = sum(x["io_contracts"] + x["so_contracts"] for x in fx["nse"]["daily_all"])
        np_ = sum(x["io_premium"] + x["so_premium"] for x in fx["nse"]["daily_all"])
        bc = sum(x["total_contracts"] for x in fx["bse"]["daily_all"])
        bp = sum(x["options_premium_turnover"] for x in fx["bse"]["daily_all"])
        self.assertAlmostEqual(r["nse"], nc / np_)
        self.assertAlmostEqual(r["bse"], bc / bp)
        both = {x["date"] for x in fx["bse"]["daily_all"] if x["total_contracts"] > 0}
        jc = sum(x["io_contracts"] + x["so_contracts"] for x in fx["nse"]["daily_all"] if x["date"] in both)
        jp = sum(x["io_premium"] + x["so_premium"] for x in fx["nse"]["daily_all"] if x["date"] in both)
        self.assertAlmostEqual(r["all"], (jc + bc) / (jp + bp))
        self.assertNotAlmostEqual(r["all"], (nc + bc) / (np_ + bp))
        self.assertEqual(self.out["joined"][0], min(both))
        self.assertEqual(len(self.out["joined"]), len(both))


# ── The ₹ ADR | Contracts toggle ─────────────────────────────────────────────
MODE_JS = ["CONTRACTS_VIEW_EXCHANGES", "CONTRACTS_MODE_KEY", "CONTRACTS_STATE", "contractsStoredMode",
           "contractsModeActive"]
UNIT_JS = MODE_JS + ["fmtNum", "REV_UNITS", "revUnit"]
VIEWS = ["nse", "bse", "nsebse", "mcx", "all", "broker:angel", "mtf:nse"]


def with_storage(stored, body, throws=False):
    """JS that stubs sessionStorage (holding `stored` under the toggle's key) and runs `body`."""
    get = "() => { throw new Error('blocked'); }" if throws else f"k => k === CONTRACTS_MODE_KEY ? {json.dumps(stored)} : null"
    return f"""(() => {{
  const writes = [];
  globalThis.sessionStorage = {{ getItem: {get}, setItem: (k, v) => {{ if ({json.dumps(throws)}) throw new Error('blocked'); writes.push([k, v]); }} }};
  {body}
}})()"""


@unittest.skipUnless(NODE, "node not installed")
class Toggle(unittest.TestCase):
    def active(self, stored, views=VIEWS, throws=False):
        body = "return DATA.map(ex => { globalThis.currentExchange = ex; return contractsModeActive(); });"
        return js_eval(MODE_JS, with_storage(stored, body, throws), views)

    def test_mode_active_only_in_nse_bse_views(self):
        self.assertEqual(self.active("contracts"), [True, True, True, False, False, False, False])

    def test_mode_defaults_to_adr(self):
        self.assertEqual(self.active(None), [False] * len(VIEWS))
        self.assertEqual(self.active("adr"), [False] * len(VIEWS))
        self.assertEqual(self.active("anything"), [False] * len(VIEWS))

    def test_blocked_storage_is_adr(self):
        self.assertEqual(self.active("contracts", throws=True), [False] * len(VIEWS))

    def test_switching_back_restores_contracts(self):
        # Contracts in NSE, revenue in MCX (toggle hidden), Contracts again back in NSE
        self.assertEqual(self.active("contracts", ["nse", "mcx", "all", "nse", "nsebse"]), [True, False, False, True, True])

    def test_set_mode_persists_and_rebuilds(self):
        body = """globalThis.currentExchange = 'bse';
  let rebuilt = 0;
  globalThis.rebuildRevenueSummaryPage = () => { rebuilt += 1; };
  const before = contractsModeActive();
  setContractsMode(true);
  const on = contractsModeActive();
  setContractsMode(false);
  return { before, on, off: contractsModeActive(), writes, rebuilt };"""
        got = js_eval(MODE_JS + ["setContractsMode"], with_storage(None, body))
        self.assertEqual(got, {"before": False, "on": True, "off": False, "rebuilt": 2,
                               "writes": [["revSummaryUnit", "contracts"], ["revSummaryUnit", "adr"]]})

    def test_set_mode_without_storage_still_switches(self):
        body = """globalThis.currentExchange = 'nse';
  globalThis.rebuildRevenueSummaryPage = () => {};
  setContractsMode(true);
  return contractsModeActive();"""
        self.assertTrue(js_eval(MODE_JS + ["setContractsMode"], with_storage(None, body, throws=True)))

    def test_rev_unit_labels(self):
        body = """globalThis.currentExchange = DATA;
  const u = revUnit();
  return { key: u.key, unit: u.unit, short: u.short, noun: u.noun, wireDp: u.wireDp, amount: u.amount(1234.5) };"""
        adr = js_eval(UNIT_JS, with_storage(None, body), "nse")
        # Today's texts, exactly
        self.assertEqual(adr, {"key": "adr", "unit": "₹ Cr", "short": "In Cr", "noun": "Revenue", "wireDp": 1,
                               "amount": "₹1,234.50 Cr"})
        con = js_eval(UNIT_JS, with_storage("contracts", body), "nsebse")
        self.assertEqual(con, {"key": "contracts", "unit": "Cr contracts", "short": "Cr ctr", "noun": "Contracts",
                               "wireDp": 2, "amount": "1,234.50 Cr contracts"})
        # Forced to ADR where the toggle is hidden
        self.assertEqual(js_eval(UNIT_JS, with_storage("contracts", body), "mcx")["key"], "adr")


@unittest.skipUnless(NODE, "node not installed")
class ViewCache(unittest.TestCase):
    def test_same_raw_and_signature_reuse_the_view(self):
        expr = """(() => {
  globalThis.VIEW_LOADED = null;   // not the loaded view: the signature is marketSig's
  let raw = DATA, sig = 's1';
  globalThis.rawFor = () => raw;
  globalThis.marketSig = () => sig;
  const a = contractsViewFor('nse'), b = contractsViewFor('nse');
  sig = 's2';
  const c = contractsViewFor('nse'), d = contractsViewFor('nse');
  raw = JSON.parse(JSON.stringify(raw));
  const e = contractsViewFor('nse');
  return { hit: a === b, newSig: c !== b, hitAgain: c === d, newRaw: e !== d, rows: a.data.daily_all.length };
})()"""
        rows = [nse_row(d.isoformat(), 3e7, 1e7, 2e6, 3e6, 2000.0, 500.0) for d in weekdays("2026-04-01", 6)]
        got = js_eval(CV_JS + ["CONTRACTS_STATE", "contractsViewFor"], expr, {"daily_all": rows})
        self.assertEqual(got, {"hit": True, "newSig": True, "hitAgain": True, "newRaw": True, "rows": 6})


# ── The page, rendered in Node with a minimal DOM ────────────────────────────
# Runs every dashboard file in index.html order (as test_dashboard_js does),
# then swaps in a fake document whose elements are the ids found in the HTML
# the page writes, sets the data globals and builds the Revenue Summary (and,
# in the combined views, the market-share panel). Each step's snapshot maps
# element id → innerHTML, plus the toggle's and the Cash sub-tab's state.
PAGE_JS = r"""
const vm = require('vm'), fs = require('fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const stub = new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub,
  apply: () => stub, construct: () => stub, set: () => true,
});
const els = new Map();
function el(id) {
  const cls = new Set();
  return {
    id, _html: '', value: '', hidden: false, style: {}, dataset: {},
    classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle() {} },
    addEventListener() {}, setAttribute() {}, getAttribute: () => null, click() {},
    querySelector: () => null, querySelectorAll: () => [],
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = String(v);
      for (const m of this._html.matchAll(/\bid="([^"]+)"/g)) if (!els.has(m[1])) els.set(m[1], el(m[1]));
    },
  };
}
const ROOTS = ['subtab-rev-total', 'subtab-rev-options', 'subtab-rev-futures', 'subtab-rev-cash', 'marketSharePanel',
  'revUnitToggle'];
ROOTS.forEach(id => els.set(id, el(id)));
const buttons = {};
['rev-total', 'rev-options', 'rev-futures', 'rev-cash'].forEach(k => { buttons[k] = el('btn-' + k); });
buttons['rev-cash'].classList.add('active');
buttons['rev-total'].click = () => { buttons['rev-cash'].classList.remove('active'); buttons['rev-total'].classList.add('active'); };
const subTabs = el('revSubTabs');
subTabs.querySelector = sel => buttons[(/data-subtab="([^"]+)"/.exec(sel) || [])[1]] || null;
els.set('revSubTabs', subTabs);
const fakeDocument = { body: stub, documentElement: stub, getElementById: id => els.get(id) || null,
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => stub };
const store = {};
if (input.stored) store.revSummaryUnit = input.stored;
const ctx = { console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask() {},
  sessionStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } } };
for (const name of ['document', 'Chart', 'localStorage', 'navigator', 'location', 'history', 'matchMedia',
    'getComputedStyle', 'fetch', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'ResizeObserver',
    'IntersectionObserver', 'MutationObserver', 'AbortController', 'URL', 'URLSearchParams', 'Blob', 'FileReader',
    'Image', 'HTMLElement', 'Event', 'CustomEvent', 'alert', 'print', 'open', 'scrollTo', 'innerWidth',
    'innerHeight', 'devicePixelRatio', 'performance'])
  ctx[name] = stub;
ctx.window = ctx.self = ctx;
vm.createContext(ctx);
input.files.forEach((f, i) => {
  let src = fs.readFileSync(f, 'utf8');
  if (i === input.files.length - 1) src = src.trimEnd().split('\n').slice(0, -1).join('\n');   // not startDashboard()
  new vm.Script(src, { filename: f }).runInContext(ctx);
});
ctx.document = fakeDocument;
ctx.__in = input;
new vm.Script(`
  MARKET_RAW = __in.raw; MARKET_DATA = __in.enr; currentExchange = __in.view;
  if (COMBINED_VIEWS[__in.view]) {
    DATA = buildCombinedRawData(COMBINED_VIEWS[__in.view]);
    ENRICHED_DATA = buildCombinedEnrichedData(COMBINED_VIEWS[__in.view]);
    VIEW_LOADED = null;
  } else {
    DATA = JSON.parse(JSON.stringify(__in.raw[__in.view]));
    ENRICHED_DATA = JSON.parse(JSON.stringify(__in.enr[__in.view]));
    VIEW_LOADED = { exchange: __in.view, sig: 'sig', checkedAt: 0 };
  }
  __in.dataBefore = JSON.stringify([DATA, MARKET_RAW]);
`).runInContext(ctx);
const snaps = input.steps.map(step => {
  new vm.Script(step).runInContext(ctx);
  // Elements still on the page: the static containers and the ids in their current HTML
  const live = new Set(ROOTS), queue = [...ROOTS];
  while (queue.length) {
    for (const m of els.get(queue.pop())._html.matchAll(/\bid="([^"]+)"/g)) {
      if (!live.has(m[1])) { live.add(m[1]); queue.push(m[1]); }
    }
  }
  const html = {};
  [...live].sort().forEach(id => { if (els.get(id)._html) html[id] = els.get(id)._html; });
  return { html, toggleHidden: els.get('revUnitToggle').hidden, cashHidden: buttons['rev-cash'].hidden,
    cashActive: buttons['rev-cash'].classList.contains('active'),
    dataUnchanged: new vm.Script('JSON.stringify([DATA, MARKET_RAW]) === __in.dataBefore').runInContext(ctx) };
});
process.stdout.write(JSON.stringify(snaps));
"""

BUILD = ("buildRevenueSummary(); if (COMBINED_VIEWS[currentExchange]) "
         "buildMarketSharePanel(COMBINED_VIEWS[currentExchange]);")


@functools.lru_cache(maxsize=None)
def page_fixture():
    """NSE and BSE files from the pipelines (build_outputs) on 320 days with
    contract figures; BSE's first 20 days have none (as BSE before 2023-04-19).
    Built on first use (only the Node page tests need it), then shared: callers copy before changing it."""
    nse_rows, bse_rows = [], []
    for i, r in enumerate(revenue_rows("2025-07-01", 320)):
        nse_rows.append({**r, "io_contracts": 3e7 + i * 1e5, "so_contracts": 1e7 + i % 7 * 1e5,
                         "if_contracts": 2e6 + i % 5 * 1e4, "sf_contracts": 3e6,
                         "io_premium": 9000.0 + i % 11 * 100, "so_premium": 2000.0})
        has = i >= 20
        bse_rows.append({**r, "total_contracts": 2e7 + i * 5e4 if has else 0,
                         "options_premium_turnover": 4000.0 + i % 13 * 50 if has else 0.0})
    n, b = nse.build_outputs(nse_rows, [], [], {}), bse.build_outputs(bse_rows)
    return {"raw": {"nse": n["dashboard"], "bse": b["dashboard"]},
            "enr": {"nse": n["enriched"], "bse": b["enriched"]}}, nse_rows, bse_rows


def render(view, stored=None, steps=(BUILD,), fx=None):
    """Snapshots after each step; `fx` replaces the page fixture's files ({ raw, enr })."""
    fx = fx or page_fixture()[0]
    payload = {**fx, "files": [str(DASHBOARD / f) for f in JS_FILES], "view": view, "stored": stored,
               "steps": list(steps)}
    out = subprocess.run([NODE, "-e", PAGE_JS], input=json.dumps(payload), capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def num(html):
    """The figure in a cell's <span class="xl-num">…</span>"""
    return html.split('<span class="xl-num">', 1)[1].split("<", 1)[0]


def quarter_rows(rows, label):
    return [r for r in rows if r["fy_quarter"] == label]


@unittest.skipUnless(NODE, "node not installed")
class Page(unittest.TestCase):
    def test_adr_unchanged_after_toggling_back(self):
        # ₹ ADR is the default; Contracts on, then off again renders today's page
        for view in ("nse", "bse", "nsebse"):
            with self.subTest(view=view):
                adr, on, off = render(view, steps=(BUILD, "setContractsMode(true);", "setContractsMode(false);"))
                for snap in (adr, off):
                    snap["html"].pop("revUnitToggle")
                self.assertEqual(off["html"], adr["html"])
                self.assertNotEqual(on["html"]["subtab-rev-total"], adr["html"]["subtab-rev-total"])
                self.assertIn("₹ Cr · daily avg", adr["html"]["subtab-rev-total"])
                self.assertNotIn("xl-has-ratio", adr["html"]["subtab-rev-total"])
                self.assertFalse(adr["cashHidden"])
                for snap in (adr, on, off):
                    self.assertTrue(snap["dataUnchanged"])

    def test_nse_contracts_values_and_ratio(self):
        snap = render("nse", "contracts")[0]
        h = snap["html"]
        _, nse_rows, _ = page_fixture()
        label = nse_rows[-1]["fy_quarter"]
        q = quarter_rows(nse_rows, label)
        total = sum(r["io_contracts"] + r["so_contracts"] + r["if_contracts"] + r["sf_contracts"] for r in q) / 1e7 / len(q)
        opt = sum(r["io_contracts"] + r["so_contracts"] for r in q)
        prem = sum(r["io_premium"] + r["so_premium"] for r in q)
        self.assertEqual(num(h["xlQVal0-total"]), f"{total:.2f}")
        self.assertEqual(num(h["xlQRat0-total"]), f"{round(opt / prem):,}")
        self.assertEqual(num(h["xlQRat0-options"]), f"{round(opt / prem):,}")
        # Ratio only beside Total and Options; Futures has none
        self.assertIn("xl-has-ratio", h["subtab-rev-total"])
        self.assertNotIn("xlQRat0-futures", h)
        self.assertNotIn("xl-has-ratio", h["subtab-rev-futures"])
        # Contracts wording, no fee basis, no ₹ Cr unit
        self.assertIn("Total Contracts", h["subtab-rev-total"])
        self.assertIn("Cr contracts · daily avg", h["subtab-rev-total"])
        self.assertNotIn("₹ Cr ·", h["subtab-rev-total"])
        self.assertNotIn("(In Cr)", h["subtab-rev-total"])
        self.assertNotIn("avg ₹", h["subtab-rev-total"])   # the "Last 5 Days" hover
        self.assertIn(" Cr contracts):", h["subtab-rev-total"])
        self.assertNotIn("today's rates", h["subtab-rev-total"])
        # Cash hidden; it was the open sub-tab, so Total takes over
        self.assertNotIn("subtab-rev-cash", h)
        self.assertTrue(snap["cashHidden"])
        self.assertFalse(snap["cashActive"])
        self.assertFalse(snap["toggleHidden"])
        self.assertIn('data-value="contracts" aria-pressed="true"', h["revUnitToggle"])
        self.assertTrue(snap["dataUnchanged"])

    def test_week_rows_ratio(self):
        h = render("nse", "contracts")[0]["html"]["subtab-rev-total"]
        _, nse_rows, _ = page_fixture()
        last5 = nse_rows[-5:]
        want = sum(r["io_contracts"] + r["so_contracts"] for r in last5) / sum(r["io_premium"] + r["so_premium"] for r in last5)
        row = h.split("Last 5 Days", 1)[1].split("</tr>", 1)[0]
        self.assertIn(f'<td class="xl-ratio"><span class="xl-num">{round(want):,}</span></td>', row)

    def test_bse_contracts_futures_shows_dash(self):
        h = render("bse", "contracts")[0]["html"]
        self.assertIn("Futures Contracts", h["subtab-rev-futures"])
        self.assertIn("—", h["subtab-rev-futures"])
        self.assertNotIn("xlQVal0-futures", h)
        _, _, bse_rows = page_fixture()
        label = bse_rows[-1]["fy_quarter"]
        q = [r for r in quarter_rows(bse_rows, label) if r["total_contracts"] > 0]
        self.assertEqual(num(h["xlQVal0-options"]), f"{sum(r['total_contracts'] for r in q) / 1e7 / len(q):.2f}")
        # The expiry blocks render contracts too
        self.assertIn("Cr contracts", h["subtab-rev-options"].split("Month-End Expiry Comparison", 1)[1])

    def test_nsebse_contracts_panel_note_and_ratio(self):
        snap = render("nsebse", "contracts")[0]
        h = snap["html"]
        self.assertIn("NSE only", h["subtab-rev-futures"])
        panel = h["marketSharePanel"]
        self.assertIn("F&amp;O contracts", panel)
        self.assertNotIn("today's rates", panel)
        # BSE has no futures: the Futures share table is left out, never 0 %
        self.assertNotIn('ms-seg-label">Futures', panel)
        self.assertIn('ms-seg-label">Options', panel)
        # Ratio over the dates both exchanges traded options (BSE's start here)
        _, nse_rows, bse_rows = page_fixture()
        fy = nse_rows[-1]["fy"]
        both = {r["date"] for r in bse_rows if r["total_contracts"] > 0 and r["fy"] == fy}
        c = sum(r["io_contracts"] + r["so_contracts"] for r in nse_rows if r["date"] in both) \
            + sum(r["total_contracts"] for r in bse_rows if r["date"] in both)
        p = sum(r["io_premium"] + r["so_premium"] for r in nse_rows if r["date"] in both) \
            + sum(r["options_premium_turnover"] for r in bse_rows if r["date"] in both)
        self.assertEqual(num(h["xlFYRat0-total"]), f"{round(c / p):,}")
        self.assertTrue(snap["dataUnchanged"])

    def test_nsebse_contracts_futures_are_nse_only(self):
        # BSE has no futures contracts: Futures' expiry counts and "Last 5 Days" hover show NSE alone
        h = render("nsebse", "contracts")[0]["html"]
        fut, opt = h["subtab-rev-futures"], h["subtab-rev-options"]
        for cell in ("xlFYExp0-futures", "xlQExp0-futures", "xlMExp0-futures", "xlMAvgExp-futures"):
            self.assertNotIn("exp-sep", h[cell], cell)                   # "4", not "N4·B4"
            self.assertRegex(h[cell], r'^<span class="exp-count" title="\d+ expiry days? in \d+ trading days?">\d+</span>$')
        self.assertNotIn("exp-sep", fut)                                 # trailing rows too
        self.assertNotIn("BSE —", fut)
        self.assertNotIn("NSE + BSE", fut)
        self.assertNotIn("NSE —", fut)                                   # one exchange: no per-exchange blocks
        # Options are both exchanges'
        self.assertIn("exp-sep", h["xlQExp0-options"])
        self.assertIn("BSE —", opt)
        self.assertIn("NSE + BSE", opt)

    def test_contracts_without_contract_rows_says_so(self):
        # A file without contract fields: Contracts replaces the revenue tables with a message
        fx = copy.deepcopy(page_fixture()[0])
        for r in fx["raw"]["nse"]["daily_all"]:
            for k in ("io_contracts", "so_contracts", "if_contracts", "sf_contracts"):
                r.pop(k, None)
        adr, on, off = render("nse", steps=(BUILD, "setContractsMode(true);", "setContractsMode(false);"), fx=fx)
        self.assertIn("₹ Cr · daily avg", adr["html"]["subtab-rev-total"])
        for key in ("total", "options", "futures"):
            self.assertIn("No F&amp;O contract data in this file", on["html"]["subtab-rev-" + key])
        self.assertNotIn("xlQVal0-total", on["html"])
        self.assertNotIn("₹ Cr", on["html"]["subtab-rev-total"])
        self.assertFalse(on["toggleHidden"])                             # the way back to ₹ ADR stays
        self.assertTrue(on["cashHidden"])
        self.assertIn("₹ Cr · daily avg", off["html"]["subtab-rev-total"])
        self.assertTrue(on["dataUnchanged"])

    def test_contracts_stored_but_all_view_renders_revenue(self):
        # The All view (a combined view other than NSE+BSE) hides the toggle and renders revenue
        snap = render("nsebse", "contracts", steps=("currentExchange = 'all';" + BUILD,))[0]
        self.assertTrue(snap["toggleHidden"])
        self.assertFalse(snap["cashHidden"])
        self.assertIn("₹ Cr · daily avg", snap["html"]["subtab-rev-total"])
        self.assertNotIn("xl-has-ratio", snap["html"]["subtab-rev-total"])

    def test_contracts_stored_but_mcx_view_renders_revenue(self):
        # A single-exchange view without contracts (MCX; NSE's files stand in for its own)
        fx = copy.deepcopy(page_fixture()[0])
        fx["raw"]["mcx"], fx["enr"]["mcx"] = fx["raw"]["nse"], fx["enr"]["nse"]
        snap = render("mcx", "contracts", fx=fx)[0]
        self.assertTrue(snap["toggleHidden"])
        self.assertFalse(snap["cashHidden"])
        self.assertIn("₹ Cr · daily avg", snap["html"]["subtab-rev-total"])
        self.assertIn("xlQVal0-total", snap["html"])
        self.assertNotIn("xl-has-ratio", snap["html"]["subtab-rev-total"])
        self.assertNotIn("Contracts", snap["html"]["subtab-rev-total"])


if __name__ == "__main__":
    unittest.main()
