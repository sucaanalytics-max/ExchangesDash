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
