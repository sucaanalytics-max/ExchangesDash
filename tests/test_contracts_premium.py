"""Contracts to Premium tab (dashboard/js/16-contracts-premium.js), run in Node.

NSE + BSE option contracts per ₹ 1 Cr of option premium: the daily join by
date, days without both exchanges' options data left out and counted, period
figures as Σ contracts ÷ Σ premium (not a mean of daily ratios), and the
Revenue Summary's FY / quarter / month / trading-day rows, across year ends."""

import datetime as dt
import unittest

from helpers import NODE, js_eval

CP_JS = ["quarterSortKey", "FY_MONTH_ORDER", "monthSortKey", "cpFYBack", "cpQuarterBack", "cpMonthBack",
         "cpTotals", "contractsPremiumDaily", "contractsPremiumPeriods", "contractsPremiumRolling"]

MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
          "October", "November", "December"]


def labels(date):
    """The pipelines' Indian FY labels of a date (FY 2027 = Apr 2026 – Mar 2027)."""
    d = dt.date.fromisoformat(date)
    fy = d.year + 1 if d.month >= 4 else d.year
    q = (d.month - 4) % 12 // 3 + 1
    return {"fy": f"FY {fy}", "fy_quarter": f"Q{q} FY {fy}", "fy_month": f"FY {fy} {MONTHS[d.month - 1]}"}


def nse_row(date, io_c, so_c, io_p, so_p):
    # total_contracts includes futures: the tab must not use it
    return {"date": date, **labels(date), "io_contracts": io_c, "so_contracts": so_c, "io_premium": io_p,
            "so_premium": so_p, "total_contracts": io_c + so_c + 5_000_000}


def bse_row(date, contracts, premium):
    return {"date": date, **labels(date), "total_contracts": contracts, "options_premium_turnover": premium}


def weekdays(start, end):
    d, out = dt.date.fromisoformat(start), []
    while d <= dt.date.fromisoformat(end):
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def daily(nse, bse):
    return js_eval(CP_JS, "contractsPremiumDaily(DATA.nse, DATA.bse)", {"nse": nse, "bse": bse})


def periods(days, today=None):
    expr = "contractsPremiumPeriods(DATA.days, DATA.today)" if today else "contractsPremiumPeriods(DATA.days)"
    return {g["kind"]: g["rows"] for g in js_eval(CP_JS, expr, {"days": days, "today": today})}


def flat_days(dates, contracts=1000.0, premium=1.0):
    """Joined rows as contractsPremiumDaily returns them, one ratio for every day."""
    return [{"date": d, **labels(d), "contracts": contracts, "premium": premium, "ratio": contracts / premium}
            for d in dates]


@unittest.skipUnless(NODE, "node not installed")
class DailyJoin(unittest.TestCase):
    def test_combines_nse_options_and_bse_by_date(self):
        # The 2026-11-06 figures: NSE 179,829,875 / 122,506.17; BSE 22,003,167 / 17,871.34
        nse = [nse_row("2026-11-06", 168_979_263, 10_850_612, 109_964.60, 12_541.57)]
        bse = [bse_row("2026-11-06", 22_003_167, 17_871.34)]
        out = daily(nse, bse)
        self.assertEqual(out["excluded"], [])
        [day] = out["days"]
        self.assertEqual(day["contracts"], 179_829_875 + 22_003_167)
        self.assertAlmostEqual(day["premium"], 122_506.17 + 17_871.34, places=6)
        self.assertAlmostEqual(day["ratio"], (179_829_875 + 22_003_167) / (122_506.17 + 17_871.34))
        self.assertEqual(round(day["ratio"]), 1438)
        self.assertEqual((day["fy"], day["fy_quarter"], day["fy_month"]), ("FY 2027", "Q3 FY 2027", "FY 2027 November"))

    def test_joins_on_date_not_position(self):
        nse = [nse_row("2026-11-05", 100, 0, 1, 0), nse_row("2026-11-06", 300, 0, 1, 0)]
        bse = [bse_row("2026-11-06", 100, 1), bse_row("2026-11-05", 300, 1)]   # out of order
        out = daily(nse, bse)
        self.assertEqual([(d["date"], d["contracts"]) for d in out["days"]], [("2026-11-05", 400), ("2026-11-06", 400)])

    def test_days_without_both_exchanges_are_left_out_and_counted(self):
        nse = [nse_row("2023-05-11", 100, 10, 1, 0.5), nse_row("2023-05-12", 100, 10, 1, 0.5),
               nse_row("2023-05-15", 100, 10, 1, 0.5)]
        bse = [bse_row("2023-05-11", 0, 0),          # BSE's pre-relaunch gap: no options premium
               bse_row("2023-05-12", 20, 0),         # contracts but no premium
               bse_row("2023-05-15", 20, 0.5), bse_row("2023-05-16", 20, 0.5)]   # 16th: no NSE row
        out = daily(nse, bse)
        self.assertEqual([d["date"] for d in out["days"]], ["2023-05-15"])
        self.assertEqual(out["excluded"], [{"date": "2023-05-11", "missing": "bse"},
                                           {"date": "2023-05-12", "missing": "bse"},
                                           {"date": "2023-05-16", "missing": "nse"}])
        self.assertAlmostEqual(out["days"][0]["ratio"], 130 / 2.0)

    def test_missing_fields_count_as_no_data(self):
        out = daily([{"date": "2026-11-06", **labels("2026-11-06")}], [bse_row("2026-11-06", 10, 1)])
        self.assertEqual(out["days"], [])
        self.assertEqual(out["excluded"], [{"date": "2026-11-06", "missing": "nse"}])
        self.assertEqual(daily([], [])["days"], [])


@unittest.skipUnless(NODE, "node not installed")
class Periods(unittest.TestCase):
    def test_sum_over_sum_not_mean_of_daily_ratios(self):
        # An expiry-like day (many cheap contracts) and a quiet day in one month
        days = [{"date": "2026-11-05", **labels("2026-11-05"), "contracts": 3000.0, "premium": 1.0, "ratio": 3000.0},
                {"date": "2026-11-06", **labels("2026-11-06"), "contracts": 1000.0, "premium": 3.0, "ratio": 1000 / 3}]
        month = periods(days)["month"][0]
        self.assertEqual(month["label"], "FY 2027 November")
        self.assertEqual((month["days"], month["contracts"], month["premium"]), (2, 4000.0, 4.0))
        self.assertAlmostEqual(month["ratio"], 1000.0)                      # Σ ÷ Σ
        self.assertNotAlmostEqual(month["ratio"], (3000 + 1000 / 3) / 2)   # not the mean of ratios

    def test_rows_and_changes(self):
        # Ratio 1,000 through Q2 FY 2027, then 1,200 from October 2026
        days = flat_days(weekdays("2025-07-01", "2026-09-30")) + flat_days(weekdays("2026-10-01", "2026-11-06"), 1200.0)
        p = periods(days)
        self.assertEqual([r["label"] for r in p["fy"]], ["FY 2027", "FY 2026"])
        self.assertEqual([r["label"] for r in p["quarter"]], ["Q3 FY 2027", "Q2 FY 2027", "Q1 FY 2027", "Q3 FY 2026"])
        self.assertEqual([r["label"] for r in p["month"]], ["FY 2027 November", "FY 2027 October", "FY 2027 September"])
        self.assertEqual([r["role"] for r in p["quarter"]], ["current", "previous", "before", "last_year"])
        self.assertEqual([r["toDate"] for r in p["quarter"]], [True, False, False, False])
        self.assertAlmostEqual(p["quarter"][0]["ratio"], 1200.0)
        self.assertIsNone(p["quarter"][0]["chg"])
        # % chg = (current − row) ÷ row, as Revenue Summary
        self.assertAlmostEqual(p["quarter"][1]["chg"], 0.2)
        self.assertAlmostEqual(p["quarter"][3]["chg"], 0.2)
        self.assertAlmostEqual(p["month"][1]["chg"], 0.0)                  # October also at 1,200
        self.assertAlmostEqual(p["month"][2]["chg"], 0.2)
        # FY 2027 to date: Apr–Sep at 1,000, Oct–6 Nov at 1,200, weighted by premium
        fy = [d for d in days if d["fy"] == "FY 2027"]
        self.assertAlmostEqual(p["fy"][0]["ratio"], sum(d["contracts"] for d in fy) / sum(d["premium"] for d in fy))
        self.assertEqual(p["fy"][0]["days"], len(fy))
        self.assertEqual(p["fy"][0]["from"], "2026-04-01")
        self.assertEqual(p["fy"][0]["to"], "2026-11-06")
        self.assertEqual(p["fy"][1]["days"], len([d for d in days if d["fy"] == "FY 2026"]))

    def test_quarter_and_month_wrap_across_the_fy_end(self):
        days = flat_days(weekdays("2025-01-01", "2026-04-10"))
        p = periods(days)
        self.assertEqual([r["label"] for r in p["fy"]], ["FY 2027", "FY 2026"])
        self.assertEqual([r["label"] for r in p["quarter"]], ["Q1 FY 2027", "Q4 FY 2026", "Q3 FY 2026", "Q1 FY 2026"])
        self.assertEqual([r["label"] for r in p["month"]], ["FY 2027 April", "FY 2026 March", "FY 2026 February"])
        q4 = p["quarter"][1]
        self.assertEqual((q4["from"], q4["to"]), ("2026-01-01", "2026-03-31"))   # Jan–Mar of the FY-ending year
        self.assertEqual(p["quarter"][3]["from"], "2025-04-01")

    def test_calendar_year_end_stays_in_the_fy(self):
        p = periods(flat_days(weekdays("2026-09-01", "2027-01-08")))
        self.assertEqual([r["label"] for r in p["quarter"]], ["Q4 FY 2027", "Q3 FY 2027", "Q2 FY 2027", "Q4 FY 2026"])
        self.assertEqual([r["label"] for r in p["month"]], ["FY 2027 January", "FY 2027 December", "FY 2027 November"])
        self.assertEqual([r["label"] for r in p["fy"]], ["FY 2027", "FY 2026"])

    def test_a_period_missing_from_the_data_is_empty_not_its_neighbour(self):
        # No days at all in Q4 FY 2026: the previous quarter row is empty
        days = flat_days(weekdays("2025-10-01", "2025-12-31")) + flat_days(weekdays("2026-04-01", "2026-04-30"))
        p = periods(days)
        prev = p["quarter"][1]
        self.assertEqual(prev["label"], "Q4 FY 2026")
        self.assertEqual(prev["days"], 0)
        self.assertIsNone(prev["ratio"])
        self.assertIsNone(prev["chg"])
        self.assertEqual(p["quarter"][2]["label"], "Q3 FY 2026")
        self.assertGreater(p["quarter"][2]["days"], 0)

    def test_trading_day_windows(self):
        dates = weekdays("2026-08-03", "2026-11-06")
        days = [{"date": d, **labels(d), "contracts": float(1000 + i), "premium": 1.0, "ratio": float(1000 + i)}
                for i, d in enumerate(dates)]
        n = len(days)
        w = periods(days)["days"]
        self.assertEqual([r["label"] for r in w], ["Last 5 days", "Previous 5 days", "Last 45 days"])
        self.assertEqual([r["days"] for r in w], [5, 5, 45])
        self.assertEqual((w[0]["from"], w[0]["to"]), (dates[-5], dates[-1]))
        self.assertEqual((w[1]["from"], w[1]["to"]), (dates[-10], dates[-6]))
        self.assertAlmostEqual(w[0]["ratio"], 1000 + (n - 3))   # mean of the last five (premium 1 each)
        self.assertAlmostEqual(w[1]["ratio"], 1000 + (n - 8))
        self.assertAlmostEqual(w[2]["ratio"], 1000 + (n - 23))
        self.assertAlmostEqual(w[1]["chg"], (w[0]["ratio"] - w[1]["ratio"]) / w[1]["ratio"])
        self.assertAlmostEqual(w[2]["chg"], (w[0]["ratio"] - w[2]["ratio"]) / w[2]["ratio"])

    def test_today_anchors_the_periods(self):
        days = flat_days(weekdays("2026-08-03", "2026-11-06"))
        p = periods(days, "2026-09-30")
        self.assertEqual(p["quarter"][0]["label"], "Q2 FY 2027")
        self.assertEqual(p["month"][0]["label"], "FY 2027 September")
        self.assertEqual(p["days"][0]["to"], "2026-09-30")
        self.assertEqual(js_eval(CP_JS, "contractsPremiumPeriods([])"), [])

    def test_short_history(self):
        days = flat_days(weekdays("2026-11-02", "2026-11-06"))
        w = periods(days)["days"]
        self.assertEqual([r["days"] for r in w], [5, 0, 5])
        self.assertIsNone(w[1]["ratio"])
        self.assertIsNone(w[1]["chg"])


@unittest.skipUnless(NODE, "node not installed")
class Rolling(unittest.TestCase):
    def test_ratio_of_sums_over_the_window(self):
        days = [{"contracts": c, "premium": p} for c, p in [(100, 1), (300, 1), (100, 2), (600, 1)]]
        out = js_eval(CP_JS, "contractsPremiumRolling(DATA, 2)", days)
        self.assertIsNone(out[0])
        self.assertAlmostEqual(out[1], 400 / 2)
        self.assertAlmostEqual(out[2], 400 / 3)
        self.assertAlmostEqual(out[3], 700 / 3)


if __name__ == "__main__":
    unittest.main()
