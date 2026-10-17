import json
import tempfile
import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)
from datetime import datetime
from pathlib import Path

import live_common as lc


def day(d, eod):
    return {"date": d, "eod_revenue": eod, "checkpoints": {}}


class SessionGuards(unittest.TestCase):
    def test_trade_date_forms(self):
        for raw in ("2026-10-16T15:30:00", "16/10/26", "16/10/2026", "16-Oct-2026", "16-Oct-26 15:30"):
            with self.subTest(raw=raw):
                self.assertEqual(lc.normalize_trade_date(raw), "2026-10-16")
        self.assertIsNone(lc.normalize_trade_date("garbage"))

    def test_market_session_window(self):
        self.assertFalse(lc.in_market_session(datetime(2026, 10, 19, 8, 54)))
        self.assertTrue(lc.in_market_session(datetime(2026, 10, 19, 8, 55)))
        self.assertTrue(lc.in_market_session(datetime(2026, 10, 19, 16, 30)))
        self.assertFalse(lc.in_market_session(datetime(2026, 10, 19, 16, 31)))
        self.assertFalse(lc.in_market_session(datetime(2026, 10, 17, 11, 0)))   # Saturday


class HistoryCleaning(unittest.TestCase):
    def test_drops_weekends_repeats_and_closed_days(self):
        days = [day("2026-09-25", 50.0), day("2026-09-26", 50.0),   # Saturday repeat
                day("2026-09-29", 55.0), day("2026-09-30", 55.0),   # stale repeat
                day("2026-10-01", 60.0), day("2026-10-02", 61.0),   # 2 Oct: holiday, not in daily data
                day("2026-10-05", 58.0)]
        trading = {"2026-09-25", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-05"}
        kept = [d["date"] for d in lc._clean_days(days, trading)]
        self.assertEqual(kept, ["2026-09-25", "2026-09-29", "2026-10-01", "2026-10-05"])


class Snapshots(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.hourly = self.tmp / "nse_live_hourly.json"
        self.history = self.tmp / "nse_hourly_history.json"

    def snap(self, trade_date, when, total):
        rev = {"has_data": True, "trade_date": trade_date, "total_revenue": total,
               "cash_revenue": 1, "options_revenue": total - 2, "futures_revenue": 1}
        lc.save_hourly_snapshot(rev, when, self.hourly, self.history, "nse")

    def test_previous_session_and_preopen_samples_are_skipped(self):
        self.snap("16-Oct-2026", datetime(2026, 10, 19, 9, 5), 60.0)    # API still on Friday
        self.assertFalse(self.hourly.exists())
        self.snap("19-Oct-2026", datetime(2026, 10, 19, 9, 10), 1.0)    # before the 9:15 open
        self.assertFalse(self.hourly.exists())
        self.snap("19-Oct-2026", datetime(2026, 10, 19, 10, 15), 12.0)
        data = json.loads(self.hourly.read_text())
        self.assertEqual(data["date"], "2026-10-19")
        self.assertEqual([s["elapsed_minutes"] for s in data["samples"]], [60])

    def test_new_day_archives_previous_one(self):
        self.snap("19-Oct-2026", datetime(2026, 10, 19, 10, 15), 12.0)
        self.snap("19-Oct-2026", datetime(2026, 10, 19, 15, 55), 50.0)
        self.snap("20-Oct-2026", datetime(2026, 10, 20, 9, 30), 4.0)
        hist = json.loads(self.history.read_text())["days"]
        self.assertEqual([d["date"] for d in hist], ["2026-10-19"])
        self.assertEqual(hist[0]["eod_revenue"], 50.0)

    def test_linear_forecast_without_history(self):
        pred, method = lc.predict_eod_live(135, 20.0, self.history)
        self.assertEqual(method, "linear")
        self.assertAlmostEqual(pred, round(20.0 * lc.MARKET_TOTAL_MIN / 135, 2))
