"""The MTF page's calculation helpers (dashboard/js/40-mtf.js), run in Node: the
series each view shows, Indian FY periods and their averages, the changes in
the KPIs, monthly flows, the dated notes on BSE's series and the top-securities
table. The page itself is checked in a browser."""

import json
import unittest
from datetime import date, timedelta

from helpers import DASHBOARD, NODE, js_eval

HELPERS = ["MTF_MONTHS", "MTF_NOTES", "MTF_RANGES", "mtfQuarterOf", "mtfPeriodOf", "mtfDaysAfter", "mtfMonthsBack",
           "mtfSeries", "mtfPointOnOrBefore", "mtfChanges", "mtfInRange", "mtfRangeIsShort", "mtfDateTick",
           "mtfPeriodRows", "mtfFlowRows", "mtfNotesBetween", "mtfTopRows"]


def js(expr, data=None):
    return js_eval(HELPERS, expr, data)


def pts(*pairs):
    return [{"date": d, "value": v} for d, v in pairs]


DOC = {
    "nse": [
        {"date": "2026-10-30", "closing_cr": 100.0, "opening_cr": 98.0, "fresh_cr": 5.0, "liquidated_cr": 3.0,
         "securities": 10, "revised": True, "flags": []},
        {"date": "2026-10-29", "closing_cr": 98.0, "opening_cr": 97.0, "fresh_cr": 4.0, "liquidated_cr": 3.0,
         "securities": 9, "revised": False, "flags": []},
        {"date": "2026-11-02", "closing_cr": 300.0, "securities": 10, "flags": ["spike"]},
    ],
    "bse": [
        {"date": "2025-09-30", "amount_financed_cr": 40.0, "opening_cr": 39.0, "fresh_cr": 2.0, "liquidated_cr": 1.0,
         "securities": 5, "file": "archive", "flags": ["arithmetic"]},
        {"date": "2025-10-01", "amount_financed_cr": 30.0, "opening_cr": None, "fresh_cr": None, "liquidated_cr": None,
         "securities": 4, "file": "csv", "flags": []},
        {"date": "2025-10-20", "amount_financed_cr": 60.0, "securities": 4, "file": "csv", "flags": ["spike"]},
        {"date": "2025-10-21", "amount_financed_cr": None, "securities": 4, "file": "csv", "flags": []},
    ],
    "combined": [
        {"date": "2026-10-30", "nse_cr": 100.0, "bse_cr": 5.0, "total_cr": 105.0},
        {"date": "2026-10-29", "nse_cr": 98.0, "bse_cr": 4.0, "total_cr": 102.0},
    ],
    "unavailable": {"nse": {}, "bse": {"2024-03-11": "partial file"}},
}


@unittest.skipUnless(NODE, "node not installed")
class Periods(unittest.TestCase):
    def test_quarter_labels_follow_the_indian_fy(self):
        out = js("['2026-03-31', '2026-04-01', '2026-06-30', '2026-07-01', '2026-10-15', '2027-01-02'].map(mtfQuarterOf)")
        self.assertEqual(out, ["Q4 FY 2026", "Q1 FY 2027", "Q1 FY 2027", "Q2 FY 2027", "Q3 FY 2027", "Q4 FY 2027"])

    def test_period_bounds_and_running_index(self):
        out = js("['2026-11-03', '2027-02-10', '2027-04-01'].map(d => mtfPeriodOf(d, 'quarter'))")
        self.assertEqual([(p["label"], p["start"], p["end"]) for p in out],
                         [("Q3 FY 2027", "2026-10-01", "2026-12-31"), ("Q4 FY 2027", "2027-01-01", "2027-03-31"),
                          ("Q1 FY 2028", "2027-04-01", "2027-06-30")])
        self.assertEqual([out[1]["idx"] - out[0]["idx"], out[2]["idx"] - out[1]["idx"]], [1, 1])
        month = js("['2024-02-10', '2024-12-31', '2025-01-01'].map(d => mtfPeriodOf(d, 'month'))")
        self.assertEqual([(p["label"], p["end"]) for p in month],
                         [("Feb 2024", "2024-02-29"), ("Dec 2024", "2024-12-31"), ("Jan 2025", "2025-01-31")])
        self.assertEqual(month[2]["idx"] - month[1]["idx"], 1)

    def test_months_back_clamps_the_day(self):
        out = js("[['2026-03-31', 1], ['2024-03-31', 1], ['2026-01-15', 1], ['2026-11-03', 12], ['2026-11-03', 36]]"
                 ".map(([d, n]) => mtfMonthsBack(d, n))")
        self.assertEqual(out, ["2026-02-28", "2024-02-29", "2025-12-15", "2025-11-03", "2023-11-03"])

    def test_period_rows(self):
        points = pts(("2025-10-15", 50.0), ("2026-07-01", 80.0), ("2026-09-30", 100.0),
                     ("2026-10-01", 110.0), ("2026-11-03", 130.0))
        rows = js("mtfPeriodRows(DATA, 'quarter')", points)
        self.assertEqual([r["label"] for r in rows], ["Q3 FY 2026", "Q2 FY 2027", "Q3 FY 2027"])
        q2, q3 = rows[1], rows[2]
        self.assertEqual((q2["days"], q2["avg"], q2["endValue"], q2["partial"]), (2, 90.0, 100.0, False))
        self.assertEqual((q3["days"], q3["avg"], q3["endValue"], q3["partial"]), (2, 120.0, 130.0, True))
        self.assertAlmostEqual(q3["chg"], 120 / 90 - 1)
        self.assertAlmostEqual(q3["yoy"], 120 / 50 - 1)
        self.assertEqual((q3["prevFirst"], q3["lyFirst"]), ("2026-07-01", "2025-10-15"))
        self.assertIsNone(q2["yoy"])            # no Q2 FY 2026
        self.assertIsNone(rows[0]["chg"])       # Q2 FY 2026 is missing, so no QoQ
        # a period whose last point is its last calendar day is complete
        done = js("mtfPeriodRows(DATA, 'quarter')", points[:3])
        self.assertFalse(done[-1]["partial"])
        # the series starts 15 days into Q3 FY 2026: that quarter starts late, the others do not
        self.assertEqual([r["startsLate"] for r in rows], [True, False, False])
        self.assertFalse(js("mtfPeriodRows(DATA, 'quarter')[0].startsLate", pts(("2025-10-06", 1.0))))

    def test_period_rows_split_combined(self):
        rows = js("mtfPeriodRows(DATA, 'month')", [{"date": "2026-10-29", "value": 102.0, "nse": 98.0, "bse": 4.0},
                                                   {"date": "2026-10-30", "value": 105.0, "nse": 100.0, "bse": 5.0}])
        self.assertEqual(len(rows), 1)
        self.assertEqual((rows[0]["label"], rows[0]["avg"], rows[0]["nseAvg"], rows[0]["bseAvg"]),
                         ("Oct 2026", 103.5, 99.0, 4.5))
        self.assertNotIn("nseAvg", js("mtfPeriodRows(DATA, 'month')[0]", pts(("2026-10-29", 1.0))))


@unittest.skipUnless(NODE, "node not installed")
class Series(unittest.TestCase):
    def test_views(self):
        out = js("({ nse: mtfSeries(DATA, 'nse'), bse: mtfSeries(DATA, 'bse'), combined: mtfSeries(DATA, 'combined'),"
                 " none: mtfSeries(null, 'nse') })", DOC)
        self.assertEqual([(p["date"], p["value"]) for p in out["nse"]], [("2026-10-29", 98.0), ("2026-10-30", 100.0)])
        self.assertTrue(out["nse"][1]["revised"])
        # spike left out, a day without a figure left out, the CSV day kept without flows
        self.assertEqual([(p["date"], p["value"], p["file"]) for p in out["bse"]],
                         [("2025-09-30", 40.0, "archive"), ("2025-10-01", 30.0, "csv")])
        self.assertEqual([(p["date"], p["value"], p["nse"], p["bse"]) for p in out["combined"]],
                         [("2026-10-29", 102.0, 98.0, 4.0), ("2026-10-30", 105.0, 100.0, 5.0)])
        self.assertEqual(out["none"], [])

    def test_changes(self):
        # 3 Nov vs the last session on or before 3 Oct (a Saturday: 1 Oct) and 3 Nov a year earlier
        points = pts(("2025-10-31", 50.0), ("2025-11-03", 60.0), ("2026-10-01", 90.0), ("2026-10-05", 95.0),
                     ("2026-10-30", 99.0), ("2026-11-03", 120.0))
        out = js("mtfChanges(DATA)", points)
        self.assertEqual((out["date"], out["value"]), ("2026-11-03", 120.0))
        self.assertEqual(out["d1"]["date"], "2026-10-30")
        self.assertEqual(out["m1"]["date"], "2026-10-01")
        self.assertEqual(out["y1"]["date"], "2025-11-03")
        self.assertAlmostEqual(out["y1"]["chg"], 1.0)
        short = js("mtfChanges(DATA)", pts(("2026-11-03", 10.0)))
        self.assertEqual((short["d1"], short["m1"], short["y1"]), (None, None, None))
        self.assertIsNone(js("mtfChanges([])"))

    def test_chart_ranges(self):
        self.assertEqual(js("MTF_RANGES.map(r => r[1])"), ["10D", "20D", "45D", "3M", "6M", "1Y", "3Y"])
        # a day from the year before, then 120 weekday sessions from 1 Jun to 13 Nov 2026
        sessions = [d.isoformat() for d in (date(2026, 6, 1) + timedelta(n) for n in range(170)) if d.weekday() < 5][:120]
        days = ["2025-10-01"] + sessions
        self.assertEqual(days[-1], "2026-11-13")
        points = pts(*[(d, float(i)) for i, d in enumerate(days)])
        sizes = js("['10d', '20d', '45d', '3m', '6m', '1y', '3y', 'nope'].map(k => mtfInRange(DATA, k).length)", points)
        # day ranges count sessions; month ranges run from the same date n months back (exclusive) to the latest;
        # an unknown key reads as 1Y
        self.assertEqual(sizes, [10, 20, 45, 66, 120, 120, 121, 120])
        self.assertEqual(js("mtfInRange(DATA, '10d').map(p => p.date)", points), days[-10:])
        self.assertEqual(js("mtfInRange(DATA, '3m')[0].date", points), "2026-08-14")
        self.assertEqual(js("mtfInRange(DATA, '45d').length", points[:5]), 5)   # fewer sessions than the range
        self.assertEqual(js("mtfInRange([], '10d')"), [])
        self.assertEqual(js("['10d', '20d', '45d', '3m', '6m', '1y', '3y'].map(mtfRangeIsShort)"),
                         [True, True, True, True, False, False, False])
        self.assertEqual(js("[mtfDateTick(['2026-10-05'], true)(0), mtfDateTick(['2026-10-05'], false)(0),"
                            " mtfDateTick([], true)(0)]"), ["5 Oct", "Oct 26", ""])

    def test_flows(self):
        nse = js("mtfFlowRows(mtfSeries(DATA, 'nse'))", DOC)
        self.assertEqual([(r["label"], r["days"], r["fresh"], r["liquidated"], r["net"], r["endValue"]) for r in nse],
                         [("Oct 2026", 2, 9.0, 6.0, 3.0, 100.0)])
        self.assertEqual((nse[0]["partial"], nse[0]["startsLate"]), (True, True))   # 29–30 Oct only
        flows = [{"date": d, "value": 1.0, "fresh": 1.0, "liquidated": 0.5}
                 for d in ("2026-09-01", "2026-09-30", "2026-10-01", "2026-10-02")]
        rows = js("mtfFlowRows(DATA)", flows)
        self.assertEqual([(r["label"], r["partial"], r["startsLate"]) for r in rows],
                         [("Sep 2026", False, False), ("Oct 2026", True, False)])
        bse = js("mtfFlowRows(mtfSeries(DATA, 'bse'))", DOC)
        self.assertEqual([(r["label"], r["fresh"]) for r in bse], [("Sep 2025", 2.0)])   # CSV days carry no flows


@unittest.skipUnless(NODE, "node not installed")
class Notes(unittest.TestCase):
    def test_breaks_between(self):
        dates = "ns => ns.map(n => n.date)"
        self.assertEqual(js(f"({dates})(mtfNotesBetween('bse', '2025-09-01', '2025-12-31'))"), ["2025-10-01"])
        self.assertEqual(js(f"({dates})(mtfNotesBetween('combined', null, null))"), ["2024-03-12", "2025-10-01"])
        self.assertEqual(js(f"({dates})(mtfNotesBetween('bse', '2025-10-01', null))"), [])     # from is exclusive
        self.assertEqual(js(f"({dates})(mtfNotesBetween('nse', null, null))"), [])
        self.assertEqual(js(f"({dates})(mtfNotesBetween('bse', null, null, 'excluded'))"), ["2025-10-20"])

    def test_notes_are_dated_and_sorted(self):
        notes = js("MTF_NOTES")
        self.assertEqual([n["date"] for n in notes], sorted(n["date"] for n in notes))
        for n in notes:
            self.assertIn(n["ex"], ("nse", "bse"))
            self.assertIn(n["kind"], ("break", "excluded"))
            self.assertRegex(n["date"], r"^\d{4}-\d{2}-\d{2}$")


@unittest.skipUnless(NODE, "node not installed")
class TopSecurities(unittest.TestCase):
    STOCKS = {
        "columns": {"nse": ["symbol", "name", "qty_financed", "amount_lakh"], "bse": ["id", "name", "qty_financed", "amount_lakh"]},
        "nse": {"date": "2026-11-03", "rows": [["B", "Bee", 10, 100.0], ["A", "Ay", 5, 300.0]]
                + [[f"S{i}", f"S{i}", 1, 10.0] for i in range(10)]},
        "bse": {"date": "2026-11-02", "rows": [["INE000000001", "One", 1, 50.0]]},
    }

    def test_sorted_with_shares(self):
        out = js("mtfTopRows(DATA, 'nse', 3)", self.STOCKS)
        self.assertEqual((out["date"], out["count"]), ("2026-11-03", 12))
        self.assertAlmostEqual(out["total"], 5.0)                       # ₹ lakh → ₹ Cr
        self.assertEqual([(r["rank"], r["id"], r["cr"]) for r in out["rows"]], [(1, "A", 3.0), (2, "B", 1.0), (3, "S0", 0.1)])
        self.assertAlmostEqual(out["rows"][0]["share"], 0.6)
        self.assertAlmostEqual(out["top10"], (3.0 + 1.0 + 8 * 0.1) / 5.0)
        self.assertEqual(js("mtfTopRows(DATA, 'bse').rows[0].id", self.STOCKS), "INE000000001")
        self.assertIsNone(js("mtfTopRows(DATA, 'mcx')", self.STOCKS))
        self.assertIsNone(js("mtfTopRows(null, 'nse')"))


@unittest.skipUnless(NODE, "node not installed")
class Views(unittest.TestCase):
    def test_view_tabs_exist(self):
        out = js_eval(["MTF_TABS", "MTF_VIEW_DEFS", "NAV_ICONS"],
                      "({ defs: MTF_VIEW_DEFS, tabs: MTF_TABS, icons: Object.keys(NAV_ICONS) })")
        self.assertEqual([d["id"] for d in out["defs"]], ["combined", "nse", "bse"])
        for d in out["defs"]:
            for t in d["tabs"]:
                self.assertIn(t, out["tabs"])
                self.assertIn(out["tabs"][t]["icon"], out["icons"])
        self.assertNotIn("flows", out["defs"][0]["tabs"])    # nothing to combine

    def test_committed_file_reads(self):
        path = DASHBOARD / "data" / "mtf_daily.json"
        if not path.exists():
            self.skipTest("no committed mtf_daily.json")
        doc = json.loads(path.read_text())
        out = js("['nse', 'bse', 'combined'].map(v => { const s = mtfSeries(DATA, v);"
                 " return { n: s.length, sorted: s.every((p, i) => !i || s[i - 1].date < p.date),"
                 " sums: s.every(p => v !== 'combined' || Math.abs(p.nse + p.bse - p.value) < 0.01),"
                 " quarters: mtfPeriodRows(s, 'quarter').length }; })", doc)
        for view in out:
            self.assertGreater(view["n"], 0)
            self.assertTrue(view["sorted"])
            self.assertTrue(view["sums"])
            self.assertGreater(view["quarters"], 0)


if __name__ == "__main__":
    unittest.main()
