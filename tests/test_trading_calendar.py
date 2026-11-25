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



class QuarterSessions(unittest.TestCase):
    """quarter_sessions: a quarter's expected sessions from the holiday calendar,
    which the Revenue Predictor's pnl_predictor.expected_trading_days uses."""

    def test_q3_fy27(self):
        # NSE / BSE shut 2 Oct, 20 Oct, 10 Nov, 24 Nov, 25 Dec; MCX trades through
        # most of them (shut 2 Oct and 25 Dec)
        self.assertEqual(tc.quarter_sessions("nse", "Q3 FY 2027", 35, "2026-11-23"), (61, "holiday calendar"))
        self.assertEqual(tc.quarter_sessions("bse", "Q3 FY 2027", 35, "2026-11-23")[0], 61)
        self.assertEqual(tc.quarter_sessions("mcx", "Q3 FY 2027", 38, "2026-11-24")[0], 64)
        # on the quarter's last session nothing is left to add
        self.assertEqual(tc.quarter_sessions("nse", "Q3 FY 2027", 61, "2026-12-31")[0], 61)

    def test_past_the_published_lists_is_estimated(self):
        n, basis = tc.quarter_sessions("nse", "Q4 FY 2027", 0, "2026-12-31")
        self.assertIn("estimated from a year earlier", basis)
        # Jan–Mar 2027 has 64 weekdays; Jan–Mar 2026 shut 5 of its 64 (15 Jan,
        # 26 Jan, 3 Mar, 26 Mar, 31 Mar)
        self.assertEqual(n, 59)


@unittest.skipUnless((helpers.ROOT / "dashboard" / "data" / "nse_dashboard_data.json").exists(), "no data")
class HolidayListsMatchTheData(unittest.TestCase):
    """The holiday lists against the committed daily files: every weekday a file
    lacks from HOLIDAYS_FROM to 10 days before its last session (BSE holds days
    back up to 7) is a listed holiday and vice versa, and finished quarters come
    out at their actual session count less any weekend session."""

    @staticmethod
    def rows(ex):
        import json
        path = helpers.ROOT / "dashboard" / "data" / f"{ex}_dashboard_data.json"
        return json.loads(path.read_text())["daily_all"]

    def test_closures(self):
        from datetime import date, timedelta
        for ex in ("nse", "bse", "mcx"):
            rows = self.rows(ex)
            have = {r["date"] for r in rows}
            to = date.fromisoformat(max(have)) - timedelta(days=10)
            day, shut = date.fromisoformat(tc.HOLIDAYS_FROM), set()
            while day <= to:
                if day.weekday() < 5 and day.isoformat() not in have:
                    shut.add(day.isoformat())
                day += timedelta(days=1)
            listed = {d for d in tc.HOLIDAYS[ex] if d <= to.isoformat()}
            with self.subTest(ex=ex):
                self.assertEqual(sorted(shut - listed), [], "closed but not listed")
                self.assertEqual(sorted(listed - shut), [], "listed but traded")

    def test_finished_quarters(self):
        from datetime import date, timedelta
        from fee_register import quarter_bounds
        for ex in ("nse", "bse", "mcx"):
            rows = self.rows(ex)
            last = max(r["date"] for r in rows)
            for q in sorted({r["fy_quarter"] for r in rows if r["date"] >= tc.HOLIDAYS_FROM}):
                start, end = quarter_bounds(q)
                if start < tc.HOLIDAYS_FROM or end >= last:
                    continue
                days = [r["date"] for r in rows if r["fy_quarter"] == q]
                weekend = sum(date.fromisoformat(d).weekday() >= 5 for d in days)
                before = (date.fromisoformat(start) - timedelta(days=1)).isoformat()
                with self.subTest(ex=ex, q=q):
                    self.assertEqual(tc.quarter_sessions(ex, q, 0, before)[0] + weekend, len(days))
                    self.assertEqual(tc.quarter_sessions(ex, q, 20, days[19])[0] + weekend, len(days))
