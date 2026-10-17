import unittest
from datetime import date, timedelta

from helpers import NODE, js_eval

import expiry_calendar as ec
from live_common import classify_day

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
