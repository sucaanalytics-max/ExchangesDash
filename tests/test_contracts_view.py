"""Revenue Summary in F&O contracts (dashboard/js/23-contracts-view.js), run in Node.

The contracts view rebuilds, in the browser, the period aggregates the page
reads: the pipelines' raw quarterly / monthly / weekly rows and the enriched
seg_summary objects, with average contracts per day (crore) in the revenue
fields. The parity tests feed one revenue fixture to the pipelines
(nse_pipeline / bse_pipeline seg_summary and recompute_*) and to the JS mirror,
so the mirror follows the pipelines' definitions, labels and rounding."""

import math
import unittest
from datetime import date, timedelta

from helpers import NODE, js_eval

import bse_pipeline as bse
import nse_pipeline as nse

CV_JS = ["quarterSortKey", "FY_MONTH_ORDER", "monthSortKey", "combineRawData", "combineEnrichedData",
         "WEEKDAYS", "CONTRACTS_PER_CRORE", "contractsNum", "contractsRound", "contractsPySum",
         "contractsWeekLabel", "contractsGroup", "contractsDailyRows", "contractsSegSummary",
         "contractsAggregates", "contractsView", "contractsViewRows", "contractsRatio", "contractsCombined"]

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
        self.assertAlmostEqual(got[0], 305 / 2)
        self.assertIsNone(got[1])
        self.assertIsNone(got[2])

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
             all: contractsRatio(contractsViewRows(c)) } };
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

    def test_combined_ratio_sums_both_exchanges(self):
        r = self.out["ratio"]
        fx = combined_fixture()
        nc = sum(x["io_contracts"] + x["so_contracts"] for x in fx["nse"]["daily_all"])
        np_ = sum(x["io_premium"] + x["so_premium"] for x in fx["nse"]["daily_all"])
        bc = sum(x["total_contracts"] for x in fx["bse"]["daily_all"])
        bp = sum(x["options_premium_turnover"] for x in fx["bse"]["daily_all"])
        self.assertAlmostEqual(r["nse"], nc / np_)
        self.assertAlmostEqual(r["bse"], bc / bp)
        self.assertAlmostEqual(r["all"], (nc + bc) / (np_ + bp))


if __name__ == "__main__":
    unittest.main()
