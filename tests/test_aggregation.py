import unittest
from datetime import date, timedelta

from helpers import NODE, js_eval

import nse_pipeline as nse

LABELS = ["Q1 FY 2025", "Q4 FY 2026", "Q2 FY 2024", "Q3 FY 2027", "Q1 FY 2027", "Q4 FY 2024"]
CHRONO = ["Q2 FY 2024", "Q4 FY 2024", "Q1 FY 2025", "Q4 FY 2026", "Q1 FY 2027", "Q3 FY 2027"]


def rows(start, n, rev=lambda i: 10.0):
    d, out = date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            i = len(out)
            out.append({"date": d.isoformat(), "day": d.strftime("%A"),
                        "fy_quarter": nse.date_to_fy_quarter(d), "fy_month": nse.date_to_fy_month(d),
                        "fy": nse.date_to_fy_quarter(d).split(" ", 1)[1],
                        "opt_rev": rev(i) * 0.8, "fut_rev": rev(i) * 0.1, "cash_rev": rev(i) * 0.1,
                        "total_rev": rev(i)})
        d += timedelta(days=1)
    return out


class FiscalPeriods(unittest.TestCase):
    def test_fy_quarter_labels(self):
        self.assertEqual(nse.date_to_fy_quarter(date(2026, 10, 15)), "Q3 FY 2027")
        self.assertEqual(nse.date_to_fy_quarter(date(2026, 3, 31)), "Q4 FY 2026")
        self.assertEqual(nse.date_to_fy_quarter(date(2026, 4, 1)), "Q1 FY 2027")
        self.assertEqual(nse.date_to_fy_month(date(2027, 1, 5)), "FY 2027 January")

    def test_quarters_sort_chronologically(self):
        self.assertEqual(sorted(LABELS, key=nse.quarter_sort_key), CHRONO)
        self.assertEqual(nse._next_quarter("Q4 FY 2026"), "Q1 FY 2027")

    @unittest.skipUnless(NODE, "node not installed")
    def test_dashboard_sorts_quarters_the_same_way(self):
        got = js_eval(["quarterSortKey"], "[...DATA].sort((a, b) => quarterSortKey(a) - quarterSortKey(b))", LABELS)
        self.assertEqual(got, CHRONO)


class Aggregates(unittest.TestCase):
    def test_quarterly_totals_and_days(self):
        daily = rows("2026-06-25", 10, rev=lambda i: float(i + 1))
        q = {x["quarter"]: x for x in nse.recompute_quarterly(daily)}
        june = [r for r in daily if r["date"] < "2026-07-01"]
        self.assertEqual(q["Q1 FY 2027"]["days"], len(june))
        self.assertAlmostEqual(q["Q1 FY 2027"]["total_rev"], sum(r["total_rev"] for r in june), places=2)
        self.assertEqual(q["Q2 FY 2027"]["days"], 10 - len(june))

    def test_six_month_average_is_last_125_trading_days(self):
        daily = rows("2026-01-01", 200, rev=lambda i: float(i))
        s = nse.seg_summary(daily, "total_rev")
        self.assertAlmostEqual(s["monthly"]["avg_6m"]["value"],
                               sum(range(75, 200)) / 125, places=4)
