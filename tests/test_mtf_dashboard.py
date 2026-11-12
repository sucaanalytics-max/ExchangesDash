"""The MTF page's calculation helpers (dashboard/js/40-mtf.js), run in Node: the
series each view shows, Indian FY periods and their averages, the changes in
the KPIs, monthly flows, the dated notes on the exchanges' series, the
top-securities table and the Brokers tab's rows. The page itself is checked in a
browser."""

import json
import unittest
from datetime import date, timedelta

from helpers import DASHBOARD, NODE, js_eval

HELPERS = ["MTF_MONTHS", "MTF_WEEKDAYS", "MTF_AVG6M_DAYS", "MTF_NOTES", "MTF_RANGES", "mtfQuarterOf", "mtfPeriodOf",
           "mtfDaysAfter", "mtfMonthsBack", "mtfSeries", "mtfAhead", "mtfAheadText", "rxDate", "mtfPointOnOrBefore", "mtfChanges", "mtfInRange",
           "mtfRangeIsShort", "mtfDateTick", "mtfPeriodRows", "mtfSummary", "mtfFlowRows", "mtfNotesFor", "mtfNotesBetween",
           "mtfTopRows", "MTF_BROKER_PALETTE", "MTF_MEASURE_CHIPS", "mtfBrokerPrimary", "mtfBrokerRows", "mtfBrokerStyle",
           "mtfBrokerPoints", "mtfBrokerMoves", "mtfShareText", "mtfBookText", "mtfQuarterTicks", "rxCr", "fmtNum"]


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

    def test_financial_years(self):
        out = js("['2026-03-31', '2026-04-01', '2027-03-31'].map(d => mtfPeriodOf(d, 'fy'))")
        self.assertEqual([(p["label"], p["idx"], p["start"], p["end"]) for p in out],
                         [("FY 2026", 2026, "2025-04-01", "2026-03-31"), ("FY 2027", 2027, "2026-04-01", "2027-03-31"),
                          ("FY 2027", 2027, "2026-04-01", "2027-03-31")])
        rows = js("mtfPeriodRows(DATA, 'fy')", pts(("2025-06-02", 50.0), ("2026-01-05", 70.0), ("2026-05-04", 90.0)))
        self.assertEqual([(r["label"], r["avg"], r["days"]) for r in rows], [("FY 2026", 60.0, 2), ("FY 2027", 90.0, 1)])
        self.assertAlmostEqual(rows[1]["chg"], 0.5)          # vs the FY before
        self.assertAlmostEqual(rows[1]["yoy"], 0.5)

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

    def test_exchanges_past_the_combined_end(self):
        # NSE + BSE ends on 2026-10-30; NSE runs to 2026-11-02 (its spike day doesn't count), then 2026-11-03
        doc = dict(DOC, nse=DOC["nse"] + [{"date": "2026-11-03", "closing_cr": 101.0, "flags": []}])
        out = js("({ ahead: mtfAhead(DATA), combined: mtfAheadText(DATA, 'combined'), nse: mtfAheadText(DATA, 'nse') })", doc)
        self.assertEqual(out["ahead"], [{"ex": "nse", "date": "2026-11-03"}])
        self.assertEqual(out["combined"], "NSE to 3 Nov 2026")
        self.assertEqual(out["nse"], "")                    # only the combined view stops short
        # the spike alone is not a later day; BSE's own days are older than the combined end
        self.assertEqual(js("mtfAhead(DATA)", DOC), [])
        self.assertEqual(js("mtfAhead(DATA)", dict(DOC, combined=[])), [])

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
class Summary(unittest.TestCase):
    """The Summary tab's tables, checked against the same averages worked out here."""

    # every weekday from Mon 3 Mar 2025 to Tue 3 Nov 2026, the book rising by 1 a day
    SESSIONS = [d for d in (date(2025, 3, 3) + timedelta(n) for n in range(611)) if d.weekday() < 5]
    POINTS = [(d.isoformat(), 100.0 + i) for i, d in enumerate(SESSIONS)]

    @staticmethod
    def avg(xs):
        return sum(xs) / len(xs)

    def vals(self, a, b):
        return [v for d, v in self.POINTS if a <= d <= b]

    def test_period_tables(self):
        self.assertEqual(self.POINTS[-1][0], "2026-11-03")
        out = js("mtfSummary(DATA, {q: 'Q2 FY 2027', m: 'Sep 2026'})", pts(*self.POINTS))
        self.assertEqual(out["asOf"], "2026-11-03")
        fy = out["fy"]
        self.assertEqual([r["label"] for r in fy], ["FY 2027", "FY 2026", "FY 2025"])        # newest first
        self.assertAlmostEqual(fy[0]["value"], self.avg(self.vals("2026-04-01", "2026-11-03")))
        self.assertAlmostEqual(fy[1]["value"], self.avg(self.vals("2025-04-01", "2026-03-31")))
        self.assertAlmostEqual(fy[0]["yoy"], fy[0]["value"] / fy[1]["value"] - 1)
        self.assertEqual((fy[2]["startsLate"], fy[2]["first"], fy[2]["yoy"]), (True, "2025-03-03", None))
        self.assertEqual(fy[0]["prevFirst"], "2025-04-01")

        q = out["q"]
        self.assertEqual((q["key"], q["prev"]["label"], q["ly"]["label"]), ("Q2 FY 2027", "Q1 FY 2027", "Q2 FY 2026"))
        self.assertAlmostEqual(q["sel"]["value"], self.avg(self.vals("2026-07-01", "2026-09-30")))
        self.assertAlmostEqual(q["qoq"], q["sel"]["value"] / q["prev"]["value"] - 1)
        self.assertAlmostEqual(q["yoy"], q["sel"]["value"] / self.avg(self.vals("2025-07-01", "2025-09-30")) - 1)

        m = out["m"]
        self.assertEqual([r["label"] for r in m["rows"]], ["Sep 2026", "Aug 2026", "Jul 2026", "Jun 2026", "May 2026", "Apr 2026"])
        sep, aug = self.avg(self.vals("2026-09-01", "2026-09-30")), self.avg(self.vals("2026-08-01", "2026-08-31"))
        self.assertAlmostEqual(m["rows"][0]["value"], sep)
        self.assertAlmostEqual(m["rows"][0]["mom"], sep / aug - 1)
        end = [d for d, _ in self.POINTS].index("2026-09-30")
        window = [v for _, v in self.POINTS[end - 124:end + 1]]                          # 125 days to the month's last
        self.assertEqual((m["avg6"]["days"], m["avg6"]["last"]), (125, "2026-09-30"))
        self.assertAlmostEqual(m["avg6"]["value"], self.avg(window))
        self.assertAlmostEqual(m["mo6m"], sep / self.avg(window) - 1)

        self.assertEqual((out["quarters"][0], out["quarters"][-1]), ("Q3 FY 2027", "Q4 FY 2025"))
        self.assertEqual((out["months"][0], out["months"][-1]), ("Nov 2026", "Mar 2025"))

    def test_week_and_weekday_tables(self):
        out = js("mtfSummary(DATA)", pts(*self.POINTS))
        v = [x for _, x in self.POINTS]
        w = out["w"]
        for key, xs in (("last5", v[-5:]), ("prev5", v[-10:-5]), ("last45", v[-45:]), ("last20", v[-20:])):
            self.assertAlmostEqual(w[key]["value"], self.avg(xs))
            self.assertEqual(w[key]["days"], len(xs))
        self.assertAlmostEqual(w["wow"], self.avg(v[-5:]) / self.avg(v[-10:-5]) - 1)
        self.assertAlmostEqual(w["vs45"], self.avg(v[-5:]) / self.avg(v[-45:]) - 1)
        self.assertEqual([x["day"] for x in out["d"]], ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])
        mondays = [(d, x) for d, x in self.POINTS if date.fromisoformat(d).weekday() == 0]
        mon = out["d"][0]
        self.assertEqual(mon["latest"]["last"], "2026-11-02")
        self.assertAlmostEqual(mon["avg3"]["value"], self.avg([x for _, x in mondays[-3:]]))     # the latest included
        self.assertAlmostEqual(mon["avg10"]["value"], self.avg([x for _, x in mondays[-10:]]))
        self.assertAlmostEqual(mon["do3"], mondays[-1][1] / mon["avg3"]["value"] - 1)
        self.assertEqual(out["d"][2]["latest"]["last"], "2026-10-28")                         # Wednesday

    def test_defaults_and_short_history(self):
        out = js("mtfSummary(DATA, {q: 'Q9 FY 1999', m: 'nope'})", pts(*self.POINTS))
        self.assertEqual((out["q"]["key"], out["m"]["key"]), ("Q3 FY 2027", "Nov 2026"))   # unknown → latest
        early = js("mtfSummary(DATA, {q: 'Q4 FY 2025', m: 'May 2025'})", pts(*self.POINTS))
        self.assertEqual((early["q"]["prev"], early["q"]["ly"], early["q"]["qoq"]), (None, None, None))
        self.assertEqual([r["label"] for r in early["m"]["rows"]], ["May 2025", "Apr 2025", "Mar 2025"])
        self.assertIsNone(early["m"]["rows"][-1]["mom"])
        self.assertEqual(early["m"]["avg6"]["days"], len(self.vals("2025-03-03", "2025-05-30")))   # fewer than 125
        self.assertIsNone(js("mtfSummary([])"))


@unittest.skipUnless(NODE, "node not installed")
class Notes(unittest.TestCase):
    def test_breaks_between(self):
        dates = "ns => ns.map(n => n.date)"
        self.assertEqual(js(f"({dates})(mtfNotesBetween('bse', '2025-09-01', '2025-12-31'))"), ["2025-10-01"])
        # every exchange's notes apply to the combined view: BSE's two and NSE's switch to gross reporting
        self.assertEqual(js(f"({dates})(mtfNotesBetween('combined', null, null))"), ["2024-03-12", "2025-10-01", "2025-10-01"])
        self.assertEqual(js(f"({dates})(mtfNotesBetween('bse', '2025-10-01', null))"), [])     # from is exclusive
        self.assertEqual(js(f"({dates})(mtfNotesBetween('nse', null, null))"), ["2025-10-01"])
        self.assertEqual(js("mtfNotesBetween('nse', null, null)[0].ex"), "nse")
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


BROKERS = {
    "brokers": [
        {"id": "a", "short": "A", "name": "A Ltd", "type": "bank", "parent": None, "primary": {"measure": "share", "basis": "period_end"},
         "sources": {}, "series": [
             {"as_of": "2026-06-30", "measure": "share", "basis": "period_end", "share_pct": 16.5, "book_cr": 231.0, "derived": True},
             {"as_of": "2026-06-30", "measure": "net", "basis": "period_end", "share_pct": 13.0, "book_cr": 182.0},
             {"as_of": "2026-09-30", "measure": "share", "basis": "period_end", "share_pct": 16.1, "book_cr": 241.5, "derived": True},
         ]},
        {"id": "b", "short": "B", "name": "B Ltd", "type": "discount", "parent": None, "primary": {"measure": "net", "basis": "period_end"},
         "sources": {}, "series": [
             {"as_of": "2026-06-30", "measure": "net", "basis": "period_end", "share_pct": 2.0, "book_cr": 28.0},
             {"as_of": "2026-09-30", "measure": "net", "basis": "period_end", "share_pct": 2.7, "book_cr": 40.5},
             {"as_of": "2026-10-31", "measure": "net", "basis": "month_avg", "share_pct": 2.8, "book_cr": 41.0},
         ]},
        {"id": "c", "short": "C", "name": "C Ltd", "type": "full_service", "parent": None, "primary": {"measure": "unstated", "basis": "period_end"},
         "sources": {}, "series": []},
        {"id": "d", "short": "D", "name": "D Ltd", "type": "discount", "parent": None,
         "primary": {"measure": "client_funding", "basis": "period_end"}, "sources": {}, "series": [
             {"as_of": "2026-06-30", "measure": "net", "basis": "period_end", "share_pct": 1.0, "book_cr": 14.0},
             {"as_of": "2026-09-30", "measure": "client_funding", "basis": "period_end", "share_pct": 1.2, "book_cr": 19.0},
             {"as_of": "2026-09-30", "measure": "net", "basis": "period_end", "share_pct": 1.1, "book_cr": 17.5},
             {"as_of": "2026-10-31", "measure": "client_funding", "basis": "month_avg", "share_pct": 1.3, "book_cr": 20.0},
         ]},
    ] + [{"id": f"x{i}", "short": f"X{i}", "name": "", "type": "bank", "parent": None,
          "primary": {"measure": "gross", "basis": "period_end"}, "sources": {}, "series": []} for i in range(7)],
    "quarters": [
        {"end": "2026-03-31", "label": "Q4 FY 2026", "shares": {}, "tracked_n": 0},
        {"end": "2026-06-30", "label": "Q1 FY 2027", "shares": {"a": 16.5, "b": 2.0}, "tracked_n": 2},
        {"end": "2026-09-30", "label": "Q2 FY 2027", "shares": {"a": 16.1, "b": 2.7}, "tracked_n": 2},
        {"end": "2026-12-31", "label": "Q3 FY 2027", "shares": {}, "tracked_n": 0},
    ],
}


@unittest.skipUnless(NODE, "node not installed")
class Brokers(unittest.TestCase):
    def test_rows_follow_the_primary_measure(self):
        rows = js("mtfBrokerRows(DATA)", BROKERS)
        self.assertEqual([r["id"] for r in rows][:4], ["a", "b", "d", "c"])  # largest latest book first; none last
        a, b, c = rows[0], rows[1], rows[3]
        self.assertEqual((a["latest"]["as_of"], a["latest"]["measure"]), ("2026-09-30", "share"))
        self.assertEqual([p["as_of"] for p in a["history"]], ["2026-06-30"])  # the net figure is not its series
        self.assertEqual(a["alts"], [])                                       # its net figure is older than the latest share
        self.assertEqual([p["basis"] for p in b["alts"]], ["month_avg"])      # newer monthly average shown beside it
        self.assertIsNone(c["latest"])
        d = next(r for r in rows if r["id"] == "d")
        # every other measure's latest figure that is at least as recent, newest first; the older net one is not
        self.assertEqual([(p["as_of"], p["measure"], p["basis"]) for p in d["alts"]],
                         [("2026-10-31", "client_funding", "month_avg"), ("2026-09-30", "net", "period_end")])
        self.assertEqual(js("mtfBrokerRows(null)"), [])

    def test_fixed_styles(self):
        out = js("['a', 'b', 'x3', 'x4'].map(id => mtfBrokerStyle(DATA, id))", BROKERS)
        self.assertEqual([o["slot"] for o in out], [0, 1, 7, 8])
        self.assertEqual(out[0]["color"], js("MTF_BROKER_PALETTE[0]"))
        self.assertEqual(out[2]["dash"], [])
        self.assertEqual(out[3]["color"], out[0]["color"])                   # the ninth reuses slot 1, dashed
        self.assertTrue(out[3]["dash"])

    def test_moves_between_last_disclosed_quarters(self):
        out = js("mtfBrokerMoves(DATA)", BROKERS)
        self.assertEqual((out["prev"]["end"], out["cur"]["end"]), ("2026-06-30", "2026-09-30"))   # empty Q3 skipped
        self.assertEqual([m["id"] for m in out["moves"]], ["b", "a"])                              # gains first
        self.assertAlmostEqual(out["moves"][0]["pp"], 0.7)
        self.assertAlmostEqual(out["moves"][1]["pp"], -0.4)
        self.assertIsNone(js("mtfBrokerMoves({quarters: []})"))

    def test_points_and_text(self):
        pts = js("mtfBrokerPoints(DATA.brokers[1], 'book').map(q => [q.x, q.y])", BROKERS)
        self.assertEqual(pts, [[1782777600000, 28.0], [1790726400000, 40.5]])    # 30 Jun, 30 Sep 2026 UTC; month avg left out
        self.assertEqual(js("mtfShareText({share_pct: 14, precision: 'integer', measure: 'share'})"), "~14 %")
        self.assertEqual(js("mtfShareText({share_pct: 16.1, measure: 'share'})"), "16.1 %")
        self.assertEqual(js("mtfShareText({share_pct: 6.6142, measure: 'unstated'})"), "6.61 %")
        self.assertEqual(js("mtfShareText(null)"), "—")
        self.assertEqual(js("mtfBookText({book_cr: 25553.4, derived: true})"), "≈ ₹25,553 Cr")
        self.assertEqual(js("mtfBookText({book_cr: 9600, rounded: true})"), "~₹9,600 Cr")
        self.assertEqual(js("mtfBookText({book_cr: null})"), "—")

    def test_quarter_ticks(self):
        ticks = js("mtfQuarterTicks(Date.UTC(2025, 11, 15), Date.UTC(2026, 9, 1)).map(v => new Date(v).toISOString().slice(0, 10))")
        self.assertEqual(ticks, ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"])


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
        # brokers' shares are of the NSE + BSE book: the tab is in that view only
        self.assertEqual([d["id"] for d in out["defs"] if "brokers" in d["tabs"]], ["combined"])

    def test_committed_brokers_file_reads(self):
        path = DASHBOARD / "data" / "mtf_brokers.json"
        if not path.exists():
            self.skipTest("no committed mtf_brokers.json")
        doc = json.loads(path.read_text())
        out = js("(() => { const rows = mtfBrokerRows(DATA); return { n: rows.length, ids: rows.map(r => r.id),"
                 " latest: rows.filter(r => r.latest).length, shares: rows.filter(r => r.latest && r.latest.share_pct != null).length,"
                 " q: (DATA.quarters || []).length }; })()", doc)
        self.assertEqual(out["n"], len(doc["brokers"]))
        self.assertEqual(len(set(out["ids"])), out["n"])
        self.assertEqual(out["latest"], out["n"])              # every broker has a figure on its main measure
        self.assertEqual(out["shares"], out["n"])              # ... priced against the NSE + BSE book
        self.assertEqual(out["q"], 8)

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
