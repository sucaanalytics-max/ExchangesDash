import json
import unittest
from datetime import date, timedelta

from helpers import NODE, js_eval

import expiry_calendar as ec
from live_common import classify_day
from nse_pipeline import date_to_fy_month, date_to_fy_quarter

EXPIRY_JS = ["EXPIRY_RULES", "EXPIRY_DOW_NAMES", "expiryRuleFor", "isScheduledExpiry",
             "computeMonthExpiryDates"]


def trading_days(start, end, holidays=()):
    d, out = date.fromisoformat(start), []
    while d <= date.fromisoformat(end):
        if d.weekday() < 5 and d.isoformat() not in holidays:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


class ExpiryRules(unittest.TestCase):
    def test_rule_changes(self):
        cases = [
            ("nse", "2025-08-28", True),   # last Thursday expiry
            ("nse", "2025-08-26", False),  # Tuesday before the switch
            ("nse", "2025-09-02", True),   # first Tuesday expiry
            ("nse", "2025-09-04", False),
            ("bse", "2025-01-03", True),   # last Friday expiry
            ("bse", "2025-01-07", True),   # first Tuesday expiry
            ("bse", "2025-08-26", True),
            ("bse", "2025-09-04", True),   # first Thursday expiry
            ("bse", "2025-09-02", False),
        ]
        for ex, d, want in cases:
            with self.subTest(ex=ex, d=d):
                self.assertEqual(ec.is_scheduled_expiry(ex, date.fromisoformat(d)), want)

    def test_mcx_has_no_rule(self):
        self.assertIsNone(ec.expiry_weekday("mcx", "2026-10-13"))

    def test_holiday_moves_expiry_to_previous_trading_day(self):
        market = set(trading_days("2026-10-01", "2026-10-31", holidays={"2026-10-20"}))
        self.assertEqual(classify_day(date(2026, 10, 19), "nse", market), "expiry")
        self.assertEqual(classify_day(date(2026, 10, 16), "nse", market), "pre_expiry")
        self.assertEqual(classify_day(date(2026, 10, 27), "nse", market), "expiry")
        self.assertEqual(classify_day(date(2026, 10, 26), "nse", market), "pre_expiry")


@unittest.skipUnless(NODE, "node not installed")
class DashboardMonthEndExpiry(unittest.TestCase):
    def test_month_end_expiry_follows_rule_in_force(self):
        daily = [{"date": d} for d in trading_days("2025-07-01", "2025-10-31", holidays={"2025-10-28"})]
        got = {r["monthKey"]: r["expiryDate"]
               for r in js_eval(EXPIRY_JS, "computeMonthExpiryDates(DATA, 'nse')", daily)}
        self.assertEqual(got, {
            "2025-07": "2025-07-31",   # last Thursday
            "2025-08": "2025-08-28",   # last Thursday (audit: was 26 Aug)
            "2025-09": "2025-09-30",   # last Tuesday
            "2025-10": "2025-10-27",   # last Tuesday is a holiday → Monday
        })


COUNT_JS = EXPIRY_JS + ["computeWeekExpiryDates", "EXPIRY_DATES_CACHE", "expiryDateSet", "countExpiryDays"]
TREND_JS = COUNT_JS + ["EXP_TREND_GRANULARITIES", "MONTHS_SHORT", "weekStartOf", "periodEndDate",
                       "buildExpiryTrendSeries", "getRevFieldObj", "FY_MONTH_ORDER", "monthSortKey",
                       "quarterSortKey", "SEG_PRODUCT", "NO_FLAGS", "periodFlags", "mergeFlags", "rowsFlags"]

# NSE/BSE holidays in Apr–May 2025; Thu 1 May moves NSE's expiry back to Wed 30 Apr
HOLIDAYS_2025 = {"2025-04-10", "2025-04-14", "2025-04-18", "2025-05-01"}


def labelled(days):
    out = []
    for d in days:
        dt = date.fromisoformat(d)
        q = date_to_fy_quarter(dt)
        out.append({"date": d, "fy_month": date_to_fy_month(dt), "fy_quarter": q, "fy": q.split(" ", 1)[1]})
    return out


def month_counts(daily, exchange, months):
    expr = (f"{json.dumps(months)}.map(l => countExpiryDays(DATA.filter(r => r.fy_month === l), DATA, "
            f"'{exchange}'))")
    return js_eval(COUNT_JS, expr, daily)


@unittest.skipUnless(NODE, "node not installed")
class DashboardExpiryCounts(unittest.TestCase):
    def test_month_counts_follow_holiday_shifts(self):
        daily = labelled(trading_days("2025-04-01", "2025-05-31", HOLIDAYS_2025))
        # April: 3, 9 (10th a holiday), 17, 24, 30 (1 May a holiday); May: 8, 15, 22, 29
        self.assertEqual(month_counts(daily, "nse", ["FY 2026 April", "FY 2026 May"]), [5, 4])

    def test_nse_and_bse_differ_in_september_2025(self):
        daily = labelled(trading_days("2025-09-01", "2025-09-30"))
        self.assertEqual(month_counts(daily, "nse", ["FY 2026 September"]), [5])   # five Tuesdays
        self.assertEqual(month_counts(daily, "bse", ["FY 2026 September"]), [4])   # four Thursdays

    def test_matches_python_classify_day(self):
        days = trading_days("2025-04-01", "2025-05-30", HOLIDAYS_2025)
        market = set(days)
        for ex in ("nse", "bse"):
            with self.subTest(ex=ex):
                got = js_eval(COUNT_JS, f"[...expiryDateSet(DATA, '{ex}')].sort()", [{"date": d} for d in days])
                want = [d for d in days if classify_day(date.fromisoformat(d), ex, market) == "expiry"]
                self.assertEqual(got, want)

    def test_expiry_not_yet_traded_is_not_counted(self):
        # Data ends Mon 19 Oct 2026; NSE's Tuesday expiry on the 20th has not happened
        daily = labelled(trading_days("2026-10-01", "2026-10-19", {"2026-10-02"}))
        self.assertEqual(month_counts(daily, "nse", ["FY 2027 October"]), [2])   # 6th, 13th
        self.assertEqual(month_counts(daily, "bse", ["FY 2027 October"]), [3])   # 1st, 8th, 15th

    def test_mcx_has_no_count(self):
        self.assertIsNone(js_eval(COUNT_JS, "countExpiryDays(DATA, DATA, 'mcx')", [{"date": "2026-10-13"}]))


@unittest.skipUnless(NODE, "node not installed")
class DashboardExpiryTrend(unittest.TestCase):
    """buildExpiryTrendSeries: NSE ₹30 on expiry days and ₹10 otherwise, BSE ₹15 / ₹5;
    data ends Wed 8 Oct 2025, before BSE's Thursday expiry that week."""

    @classmethod
    def setUpClass(cls):
        days = labelled(trading_days("2025-08-25", "2025-10-08"))
        nse_exp = {"2025-08-28", "2025-09-02", "2025-09-09", "2025-09-16", "2025-09-23", "2025-09-30", "2025-10-07"}
        bse_exp = {"2025-08-26", "2025-09-04", "2025-09-11", "2025-09-18", "2025-09-25", "2025-10-02"}
        cls.data = {
            "nse": {"daily_all": [dict(r, total_rev=30.0 if r["date"] in nse_exp else 10.0) for r in days]},
            "bse": {"daily_all": [dict(r, total_rev=15.0 if r["date"] in bse_exp else 5.0) for r in days]},
        }

    def series(self, gran):
        return js_eval(TREND_JS, f"buildExpiryTrendSeries(DATA.nse, DATA.bse, '{gran}', 'total')", self.data)

    def test_monthly(self):
        rows = self.series("monthly")
        self.assertEqual([r["label"] for r in rows], ["Aug 2025", "Sep 2025", "Oct 2025"])
        sep = rows[1]
        self.assertEqual((sep["nse"]["days"], sep["nse"]["expiries"], sep["bse"]["expiries"]), (22, 5, 4))
        self.assertAlmostEqual(sep["nse"]["avg"], (17 * 10 + 5 * 30) / 22)
        self.assertAlmostEqual(sep["bse"]["avg"], (18 * 5 + 4 * 15) / 22)
        self.assertEqual([r["partial"] for r in rows], [False, False, True])

    def test_quarterly(self):
        rows = self.series("quarterly")
        self.assertEqual([r["key"] for r in rows], ["Q2 FY 2026", "Q3 FY 2026"])
        self.assertEqual([(r["nse"]["expiries"], r["bse"]["expiries"]) for r in rows], [(6, 5), (1, 1)])
        self.assertTrue(rows[-1]["partial"])

    def test_weekly(self):
        rows = self.series("weekly")
        self.assertEqual(rows[0]["key"], "2025-08-25")
        self.assertEqual(rows[-1]["label"], "w/c 6 Oct")
        # The last week: NSE's Tuesday has traded, BSE's Thursday has not
        self.assertEqual((rows[-1]["nse"]["expiries"], rows[-1]["bse"]["expiries"]), (1, 0))
        self.assertTrue(rows[-1]["partial"])
        self.assertTrue(all(r["nse"]["expiries"] == 1 for r in rows))
