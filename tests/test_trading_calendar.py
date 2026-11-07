import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import nse_pipeline as nse
import trading_calendar as tc


def row(d, rev):
    return {"date": d, "total_rev": rev}


class SpecialSessions(unittest.TestCase):
    def test_short_sessions_split_full_weekend_sessions_kept(self):
        daily = [row("2025-10-20", 50), row("2025-10-21", 7.6),   # Muhurat (a Tuesday)
                 row("2026-02-01", 102.5),                         # Budget Sunday: full session
                 row("2024-05-18", 6.6)]                           # DR test
        regular, special = tc.split_special(daily, "nse")
        self.assertEqual([r["date"] for r in regular], ["2025-10-20", "2026-02-01"])
        self.assertEqual([(r["date"], r["session"]) for r in special],
                         [("2025-10-21", "muhurat"), ("2024-05-18", "dr_test")])
        self.assertNotIn("session", daily[1])        # input untouched

    def test_exchange_scope(self):
        self.assertIsNone(tc.special_session("mcx", "2024-05-18"))   # DR tests: NSE/BSE only
        self.assertIsNotNone(tc.special_session("MCX", "2025-10-21"))
        self.assertIsNotNone(tc.special_session("nse", "2026-11-08"))

    def test_merge_restores_the_full_series(self):
        daily = [row("2025-10-20", 50), row("2025-10-21", 7.6), row("2025-10-23", 55)]
        regular, special = tc.split_special(daily, "bse")
        self.assertEqual(tc.merge_special(regular, special), daily)
        self.assertEqual(tc.merge_special(daily, special), daily)   # no duplicates

    def test_pipeline_aggregates_leave_special_sessions_out(self):
        def full(d, rev):
            from datetime import date
            dt = date.fromisoformat(d)
            return {"date": d, "day": dt.strftime("%A"), "fy_quarter": nse.date_to_fy_quarter(dt),
                    "fy_month": nse.date_to_fy_month(dt), "fy": "FY 2026",
                    "opt_rev": rev, "fut_rev": 0, "cash_rev": 0, "total_rev": rev}
        daily = [full("2025-10-20", 50), full("2025-10-21", 7.6), full("2025-10-23", 54)]
        out = nse.build_outputs(daily, [], [], {})
        q = out["quarterly"][0]
        self.assertEqual((q["days"], q["total_rev"]), (2, 104))
        self.assertEqual([r["date"] for r in out["dashboard"]["daily_all"]], ["2025-10-20", "2025-10-23"])
        self.assertEqual([r["date"] for r in out["dashboard"]["special_sessions"]], ["2025-10-21"])


class PreFy24Days(unittest.TestCase):
    """The equity days the MTF backfill uses before the revenue history begins."""

    def test_weekdays_less_holidays_plus_muhurat(self):
        from datetime import date
        days = tc.equity_days_pre_fy24()
        self.assertEqual((len(days), days[0], days[-1]), (497, "2021-04-01", "2023-03-31"))
        self.assertEqual(days, sorted(set(days)))
        for h in tc.PRE_FY24_HOLIDAYS:
            self.assertLess(date.fromisoformat(h).weekday(), 5, h)               # a holiday is a weekday
            self.assertEqual(h in days, h in tc.PRE_FY24_MUHURAT, h)              # out, unless a Muhurat day
        self.assertNotIn("2021-04-02", days)                                      # Good Friday
        self.assertNotIn("2021-04-03", days)                                      # Saturday
        self.assertIn("2022-10-24", days)                                         # Muhurat on a holiday
        # a sample of NSE's MTF reporting dates from codex_nse_mtf_daily
        for d in ("2021-11-23", "2021-12-31", "2022-03-30", "2022-11-07", "2023-03-31"):
            self.assertIn(d, days)

    def test_ends_where_the_revenue_history_begins(self):
        self.assertLess(tc.PRE_FY24_LAST, "2023-04-03")

