"""scripts/intraday_prices.py without the network: turning a yfinance frame into rows,
holding back today's bars until 16:00 IST, and adding each (session, symbol) to its
month file once. A stand-in frame keeps pandas out (CI does not install it)."""

import math
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import intraday_prices as ip

NAN = math.nan


class Frame:
    """Just enough of a yfinance frame: .index (tz-aware datetimes) and column access."""

    def __init__(self, index, **cols):
        self.index = index
        self.cols = cols

    def __getitem__(self, name):
        return self.cols[name]


def utc(*a):
    return datetime(*a, tzinfo=timezone.utc)


def row(ts, symbol, close="100.00", volume="10"):
    return (ts, symbol, close, close, close, close, volume)


class BarsFromFrame(unittest.TestCase):
    def test_rows_in_ist_rounded_and_gaps_skipped(self):
        f = Frame([utc(2026, 11, 23, 3, 45), utc(2026, 11, 23, 3, 50), utc(2026, 11, 23, 3, 55)],
                  Open=[101.234, NAN, NAN], High=[102.5, NAN, 103.0], Low=[100.0, NAN, NAN],
                  Close=[101.996, NAN, 102.4], Volume=[1500.0, NAN, NAN])
        self.assertEqual(ip.bars_from_frame(f, "BSE.NS"), [
            ("2026-11-23 09:15", "BSE.NS", "101.23", "102.50", "100.00", "102.00", "1500"),
            # 09:20 has no close: skipped; 09:25 lacks open, low and volume: close and 0 stand in
            ("2026-11-23 09:25", "BSE.NS", "102.40", "103.00", "102.40", "102.40", "0"),
        ])


class FinalOnly(unittest.TestCase):
    ROWS = [row("2026-11-20 15:25", "BSE.NS"), row("2026-11-23 09:15", "BSE.NS"),
            row("2026-11-23 15:25", "BSE.NS"), row("2026-11-24 09:15", "BSE.NS")]

    def test_today_waits_for_four_pm(self):
        before = datetime(2026, 11, 23, 15, 59, tzinfo=ip.IST)
        after = datetime(2026, 11, 23, 16, 0, tzinfo=ip.IST)
        self.assertEqual([r[0] for r in ip.final_only(self.ROWS, before)], ["2026-11-20 15:25"])
        self.assertEqual([r[0] for r in ip.final_only(self.ROWS, after)],
                         ["2026-11-20 15:25", "2026-11-23 09:15", "2026-11-23 15:25"])


class Merge(unittest.TestCase):
    def test_stored_sessions_are_never_rewritten(self):
        existing = [row("2026-11-20 09:15", "BSE.NS", "100.00")]
        new = [row("2026-11-20 09:15", "BSE.NS", "999.00"),      # revised by Yahoo: ignored
               row("2026-11-20 09:20", "BSE.NS", "999.00"),      # same stored session: ignored
               row("2026-11-20 09:15", "MCX.NS", "50.00"),       # symbol missing that session: added
               row("2026-11-20 09:15", "MCX.NS", "50.00"),       # duplicate bar: once
               row("2026-11-21 09:15", "BSE.NS", "101.00")]      # new session: added
        merged, added = ip.merge(existing, new)
        self.assertEqual(added, [new[2], new[4]])
        self.assertEqual(merged, [existing[0], new[2], new[4]])

    def test_rows_sorted_by_time_then_symbol(self):
        new = [row("2026-11-20 09:20", "BSE.NS"), row("2026-11-20 09:15", "MCX.NS"),
               row("2026-11-20 09:15", "BSE.NS")]
        merged, _ = ip.merge([], new)
        self.assertEqual([(r[0], r[1]) for r in merged],
                         [("2026-11-20 09:15", "BSE.NS"), ("2026-11-20 09:15", "MCX.NS"),
                          ("2026-11-20 09:20", "BSE.NS")])


class Save(unittest.TestCase):
    def test_month_files_round_trip_and_rerun_adds_nothing(self):
        rows = [row("2026-10-30 15:25", "BSE.NS"), row("2026-11-02 09:15", "BSE.NS"),
                row("2026-11-02 09:15", "^NSEI", volume="0")]
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(len(ip.save(rows, d)), 3)
            self.assertEqual(sorted(p.name for p in Path(d).iterdir()), ["2026-10.csv", "2026-11.csv"])
            self.assertEqual((Path(d) / "2026-11.csv").read_text().splitlines()[0],
                             "ts,symbol,open,high,low,close,volume")
            self.assertEqual(ip.read_month(Path(d) / "2026-11.csv"), rows[1:])
            self.assertEqual(ip.save(rows, d), [])

    def test_dry_run_writes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(len(ip.save([row("2026-11-02 09:15", "BSE.NS")], d, dry_run=True)), 1)
            self.assertEqual(list(Path(d).iterdir()), [])

    def test_unexpected_header_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "2026-11.csv"
            p.write_text("date,ticker,price\n")
            with self.assertRaises(ValueError):
                ip.read_month(p)


class RetryPeriods(unittest.TestCase):
    def test_shorter_periods_after_the_batch(self):
        self.assertEqual(ip.retry_periods(59), [59, 30, 7])
        self.assertEqual(ip.retry_periods(7), [7])
        self.assertEqual(ip.retry_periods(3), [3])


class Symbols(unittest.TestCase):
    def test_no_duplicates(self):
        self.assertEqual(len(ip.SYMBOLS), len(set(ip.SYMBOLS)))


if __name__ == "__main__":
    unittest.main()
