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

    def test_merge_cash_into_stored_old_day(self):
        """A stored F&O day outside the 45-day F&O window (2026-06-15) is
        completed from its month's cash re-fetch; its F&O fields stay."""
        fo = {k: v for k, v in bse.parse_fo_record(
            {"date": "2026-06-15", "futures_turnover": 0, "options_premium_turnover": 12080.9,
             "options_notional_turnover": 1e7, "total_contracts": 23783776, "total_turnover": 1e7}).items()
            if k != "_dt"}
        stored_row = dict(fo, cash_traded_value=0, cash_securities=0, cash_trades=0, cash_quantity=0,
                          cash_rev=0, total_rev=fo["fo_rev"])
        cash = bse.parse_cash_record({"date": "15/06/2026", "traded_value": 9000.5, "securities_traded": 4800,
                                      "no_of_trades": 4083815, "traded_quantity": 900000000})
        complete = dict(stored_row, date="2026-06-12", cash_rev=0.7, total_rev=fo["fo_rev"] + 0.7)
        merged = bse.merge_cash_into_stored([stored_row, complete],
                                            {"2026-06-15": cash, "2026-06-12": cash})
        self.assertEqual(len(merged), 1)                     # complete day untouched
        m = merged[0]
        self.assertEqual(m["cash_trades"], 4083815)
        self.assertEqual(m["cash_rev"], bse.cash_revenue(9000.5))
        self.assertEqual(m["total_rev"], round(fo["fo_rev"] + m["cash_rev"], 4))
        for k in ("options_premium_turnover", "opt_rev", "fo_rev", "total_contracts"):
            self.assertEqual(m[k], stored_row[k])
        self.assertEqual(stored_row["cash_rev"], 0)          # input not modified
        no_cash = dict(cash, cash_traded_value=0, cash_rev=0)
        self.assertEqual(bse.merge_cash_into_stored([stored_row], {"2026-06-15": no_cash}), [])

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

    def test_gap_older_than_the_fo_window(self):
        """The stored day missing cash is older than the F&O fetch (45 days),
        so the fresh fetch has its cash but no F&O row: it is still corrected."""
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir(); (tmp / "dashboard" / "data").mkdir(parents=True)
        days = weekdays_back(80, datetime.now())
        window = days[-30:]                                        # what the F&O fetch returns
        old_gap = days[0].strftime("%Y-%m-%d")

        def fo_rec(d):
            return {"date": d, "futures_turnover": 1000, "options_premium_turnover": 10000,
                    "options_notional_turnover": 1e6, "total_contracts": 10, "total_turnover": 1e6}

        def cash_rec(d):
            return {"date": d, "traded_value": 8000, "securities_traded": 2, "no_of_trades": 3, "traded_quantity": 4}

        existing = []
        for dt in days[:-30]:
            d = dt.strftime("%Y-%m-%d")
            row = {k: v for k, v in bse.parse_fo_record(fo_rec(d)).items() if k != "_dt"}
            cash = bse.parse_cash_record(cash_rec(d)) if d != old_gap else \
                {"cash_traded_value": 0, "cash_securities": 0, "cash_trades": 0, "cash_quantity": 0, "cash_rev": 0}
            row.update(cash)
            row.pop("date", None); row["date"] = d
            row["total_rev"] = round(row["fo_rev"] + row["cash_rev"], 4)
            existing.append(row)
        (tmp / "data" / "bse_dashboard_data.json").write_text(json.dumps({"daily_all": existing}))
        before = {r["date"]: r for r in existing}

        saved = (bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL)
        bse.DATA_DIR, bse.DASHBOARD_DIR, bse.SUPABASE_URL = tmp / "data", tmp / "dashboard", ""
        bse.fetch_bse_fo_data = lambda: [fo_rec(dt.strftime("%Y-%m-%d")) for dt in window]
        bse.fetch_bse_cash_data = lambda extra=(): [cash_rec(dt.strftime("%Y-%m-%d"))
                                                    for dt in window + [days[0]]]
        try:
            bse.main()
        finally:
            bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL = saved

        out = {r["date"]: r for r in json.loads((tmp / "data" / "bse_dashboard_data.json").read_text())["daily_all"]}
        fixed = out[old_gap]
        self.assertEqual(fixed["cash_rev"], bse.cash_revenue(8000))
        self.assertEqual(fixed["cash_trades"], 3)
        self.assertEqual(fixed["fo_rev"], before[old_gap]["fo_rev"])
        self.assertEqual(fixed["total_rev"], round(fixed["fo_rev"] + fixed["cash_rev"], 4))
        self.assertEqual(len(out), len(days))


if __name__ == "__main__":
    unittest.main()
