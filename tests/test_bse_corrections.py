import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import bse_pipeline as bse


def stored(d, fo, cash):
    return {"date": d, "fo_rev": fo, "cash_rev": cash, "total_rev": fo + cash}


def weekdays_back(n, end):
    out, d = [], end
    while len(out) < n:
        d -= timedelta(days=1)
        if d.weekday() < 5:
            out.append(d)
    return sorted(out)


class IncompleteDays(unittest.TestCase):
    def test_missing_parts(self):
        self.assertEqual(bse.missing_parts(stored("2026-09-08", 7.0, 0)), "cash")
        self.assertEqual(bse.missing_parts(stored("2026-09-09", 0, 0.7)), "fo")
        self.assertIsNone(bse.missing_parts(stored("2026-09-10", 7.0, 0.7)))

    def test_hold_back_only_recent_days_without_cash(self):
        today = datetime(2026, 10, 19)
        rows = [stored("2026-10-16", 8, 0), stored("2026-09-08", 7, 0), stored("2026-10-15", 8, 0.7)]
        kept = bse.hold_back_missing_cash(rows, cash_dates={"2026-10-15"}, today=today)
        self.assertEqual([r["date"] for r in kept], ["2026-09-08", "2026-10-15"])

    def test_corrections_need_both_parts(self):
        existing = [stored("2026-09-08", 7, 0), stored("2026-06-15", 6, 0), stored("2026-10-01", 0, 0.6)]
        fresh = [stored("2026-09-08", 7, 0.7077), stored("2026-06-15", 6, 0), stored("2026-10-01", 9, 0.6)]
        self.assertEqual(bse.corrections(existing, fresh), {"2026-09-08", "2026-10-01"})

    def test_cash_fetch_covers_months_of_missing_days(self):
        urls = []

        class Resp:
            status_code, text = 200, ""

        class Session:
            def get(self, url, **kw):
                urls.append(url)
                return Resp()
        orig = bse._make_bse_session
        bse._make_bse_session = lambda: Session()
        try:
            bse.fetch_bse_cash_data(["2026-06-15", "2026-02-10"])
        finally:
            bse._make_bse_session = orig
        months = {u.split("?", 1)[1] for u in urls if "histoequitymonthdisplay" in u}
        self.assertIn("year=2026&month=06", months)
        self.assertIn("year=2025&month=02", months)   # Jan–Mar belong to the previous BSE FY


class ShadowModeRun(unittest.TestCase):
    """bse_pipeline.main() in shadow mode with BSE faked: a stored cash = 0 day
    is corrected once the cash file has it; a recent day without cash is held."""

    def test_end_to_end(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir(); (tmp / "dashboard" / "data").mkdir(parents=True)
        today = datetime.now()
        days = weekdays_back(30, today)
        old_gap, recent = days[0].strftime("%Y-%m-%d"), days[-1].strftime("%Y-%m-%d")

        def fo_rec(d):
            return {"date": d, "futures_turnover": 1000, "options_premium_turnover": 10000,
                    "options_notional_turnover": 1e6, "total_contracts": 10, "total_turnover": 1e6}

        def cash_rec(d):
            return {"date": d, "traded_value": 8000, "securities_traded": 1, "no_of_trades": 1, "traded_quantity": 1}

        # Existing output: every day complete except old_gap (cash missing)
        existing = []
        for dt in days[:-1]:
            d = dt.strftime("%Y-%m-%d")
            row = {k: v for k, v in bse.parse_fo_record(fo_rec(d)).items() if k != "_dt"}
            cash = bse.parse_cash_record(cash_rec(d)) if d != old_gap else {"cash_traded_value": 0, "cash_rev": 0}
            row.update({"cash_traded_value": cash["cash_traded_value"], "cash_securities": 0, "cash_trades": 0,
                        "cash_quantity": 0, "cash_rev": cash["cash_rev"]})
            row["total_rev"] = round(row["fo_rev"] + row["cash_rev"], 4)
            existing.append(row)
        (tmp / "data" / "bse_dashboard_data.json").write_text(json.dumps({"daily_all": existing}))

        requested = {}
        saved = (bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL)
        bse.DATA_DIR, bse.DASHBOARD_DIR, bse.SUPABASE_URL = tmp / "data", tmp / "dashboard", ""
        bse.fetch_bse_fo_data = lambda: [fo_rec(dt.strftime("%Y-%m-%d")) for dt in days]
        # The cash file now has old_gap but not yet the most recent day
        bse.fetch_bse_cash_data = lambda extra=(): (requested.setdefault("extra", list(extra)) and None) or \
            [cash_rec(dt.strftime("%Y-%m-%d")) for dt in days[:-1]]
        try:
            bse.main()
        finally:
            bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL = saved

        self.assertEqual(requested["extra"], [old_gap])
        out = {r["date"]: r for r in json.loads((tmp / "data" / "bse_dashboard_data.json").read_text())["daily_all"]}
        self.assertGreater(out[old_gap]["cash_rev"], 0)            # corrected
        self.assertNotIn(recent, out)                              # held back: no cash yet
        self.assertEqual(len(out), len(days) - 1)


if __name__ == "__main__":
    unittest.main()
