"""The NSE, BSE and MCX pipelines' run count (.new_days_count /
.new_bse_days_count / .new_mcx_days_count): the days whose published row is new,
corrected or gone, not every day the exchange's fetch returned. The workflow runs
the share analyses and the Excel sync only when it is non-zero; NSE and BSE
commit whatever changed regardless, MCX only when it is non-zero.

In shadow mode the count used to be the size of the fetch window (about a month
for NSE, 45 days for BSE), so a repeat run reported 22 / 44 "new days" with
nothing to commit (Exchange Daily Update, 4 Nov 2026). MCX's counted only new
dates, so a day's contracts, which reach mcx_commodity_daily a run after its
revenue, were not committed until the next trading day's revenue (6 Nov 2026's
waited over the weekend, and the brokers engine's as-of date with them)."""

import contextlib
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import bse_pipeline as bse
import mcx_pipeline as mcx
import nse_pipeline as nse
import trading_calendar
from test_bse_corrections import weekdays_back
from test_mcx_contracts import rev_row
from test_nse_cash_corrections import REGISTER, cm_rec, fo_rec, stored


def row(date, **kw):
    return {"date": date, "total_rev": 1.0, **kw}


class ChangedDays(unittest.TestCase):
    def test_identical_documents_change_nothing(self):
        doc = {"daily_all": [row("2026-11-03"), row("2026-11-04")]}
        self.assertEqual(trading_calendar.changed_days(doc, json.loads(json.dumps(doc))), [])

    def test_added_changed_and_removed_days(self):
        before = {"daily_all": [row("2026-11-02"), row("2026-11-03"), row("2026-11-04")]}
        after = {"daily_all": [row("2026-11-03", total_rev=2.0), row("2026-11-04"), row("2026-11-05")]}
        self.assertEqual(trading_calendar.changed_days(before, after),
                         ["2026-11-02", "2026-11-03", "2026-11-05"])

    def test_special_sessions_count_too(self):
        before = {"daily_all": [row("2026-11-03")], "special_sessions": []}
        after = {"daily_all": [row("2026-11-03")],
                 "special_sessions": [row("2026-11-08", session="muhurat")]}
        self.assertEqual(trading_calendar.changed_days(before, after), ["2026-11-08"])

    def test_compared_as_written(self):
        """A tuple in memory is a list on disk: not a change."""
        before = {"daily_all": [row("2026-11-03", parts=[1, 2])]}
        after = {"daily_all": [row("2026-11-03", parts=(1, 2))]}
        self.assertEqual(trading_calendar.changed_days(before, after), [])

    def test_no_previous_file(self):
        self.assertEqual(trading_calendar.changed_days({}, {"daily_all": [row("2026-11-03")]}), ["2026-11-03"])


def run_nse(tmp, fetched):
    saved = {k: getattr(nse, k) for k in ("DATA_DIR", "DASHBOARD_DIR", "SUPABASE_URL", "nse_session",
                                          "fetch_nse_data", "fetch_detail_months", "fetch_indiavix_map",
                                          "NSE_CASH_CORRECTIONS")}
    nse.DATA_DIR, nse.DASHBOARD_DIR, nse.SUPABASE_URL = tmp / "data", tmp / "dashboard", ""
    nse.nse_session = lambda: None
    nse.fetch_nse_data = lambda session: ({"data": [fo_rec(d) for d in fetched]},
                                          {"data": [cm_rec(d, v) for d, v in fetched.items()]})
    nse.fetch_detail_months = lambda session, months: ({}, {})
    nse.fetch_indiavix_map = lambda start, end: {}
    nse.NSE_CASH_CORRECTIONS = REGISTER
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return nse.main()
    finally:
        for k, v in saved.items():
            setattr(nse, k, v)


class NseRunCount(unittest.TestCase):
    def test_counts_changed_days_not_the_fetch_window(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        (tmp / "dashboard" / "data").mkdir(parents=True)
        existing = [stored("2025-06-12", 117580.76), stored("2025-06-13", 119525.75),
                    stored("2025-06-16", 91120.68)]
        (tmp / "data" / "dashboard_data.json").write_text(json.dumps(
            {"daily_all": existing, "pnl": [], "pnl_fy": [], "cost_ratios": {}}))
        # NSE returns the stored days again plus one new day
        fetched = {"2025-06-12": 117580.76, "2025-06-13": 104981.80, "2025-06-16": 91120.68,
                   "2025-06-17": 95000.0}

        # 2025-06-13 corrected (REGISTER) and 2025-06-17 added; the other two unchanged
        self.assertEqual(run_nse(tmp, fetched), 2)
        # The same fetch again: nothing new or changed
        self.assertEqual(run_nse(tmp, fetched), 0)


def run_bse(tmp, fo, cash):
    saved = (bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL)
    bse.DATA_DIR, bse.DASHBOARD_DIR, bse.SUPABASE_URL = tmp / "data", tmp / "dashboard", ""
    bse.fetch_bse_fo_data = lambda: list(fo)
    bse.fetch_bse_cash_data = lambda extra=(): list(cash)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return bse.main()
    finally:
        bse.DATA_DIR, bse.DASHBOARD_DIR, bse.fetch_bse_fo_data, bse.fetch_bse_cash_data, bse.SUPABASE_URL = saved


class BseRunCount(unittest.TestCase):
    def test_counts_changed_days_not_the_fetch_window(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        (tmp / "dashboard" / "data").mkdir(parents=True)
        days = [d.strftime("%Y-%m-%d") for d in weekdays_back(30, datetime.now())]
        old_gap = days[0]

        def fo_rec_bse(d):
            return {"date": d, "futures_turnover": 1000, "options_premium_turnover": 10000,
                    "options_notional_turnover": 1e6, "total_contracts": 10, "total_turnover": 1e6}

        def cash_rec(d):
            return {"date": d, "traded_value": 8000, "securities_traded": 1, "no_of_trades": 1, "traded_quantity": 1}

        # Stored: every day but the latest, complete except old_gap (cash missing)
        existing = []
        for d in days[:-1]:
            r = {k: v for k, v in bse.parse_fo_record(fo_rec_bse(d)).items() if k != "_dt"}
            cash = bse.parse_cash_record(cash_rec(d)) if d != old_gap else \
                {"cash_traded_value": 0, "cash_securities": 0, "cash_trades": 0, "cash_quantity": 0, "cash_rev": 0}
            r.update(cash)
            r.pop("date", None)
            r["date"] = d
            r["total_rev"] = round(r["fo_rev"] + r["cash_rev"], 4)
            existing.append(r)
        (tmp / "data" / "bse_dashboard_data.json").write_text(json.dumps({"daily_all": existing}))
        fo = [fo_rec_bse(d) for d in days]
        cash = [cash_rec(d) for d in days]              # the latest day's cash has posted too

        # old_gap's cash completed and the latest day added; the other 28 re-fetched days unchanged
        self.assertEqual(run_bse(tmp, fo, cash), 2)
        self.assertEqual(run_bse(tmp, fo, cash), 0)


def run_mcx(tmp, revenue_days, contracts):
    """mcx_pipeline.main() with Supabase faked; returns its run count."""
    def fake_get(path, **kw):
        if path.startswith("mcx_daily_revenue"):
            return [rev_row(d) for d in revenue_days]
        return [{"trading_date": d, "contracts": c} for d, c in contracts.items()]
    saved = mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY
    mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY = fake_get, tmp / "data", tmp / "dash", "k"
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            return mcx.main()
    finally:
        mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY = saved


class McxRunCount(unittest.TestCase):
    def test_a_late_contracts_count_is_a_change(self):
        tmp = Path(tempfile.mkdtemp())
        days = ["2026-11-04", "2026-11-05", "2026-11-06"]
        # Friday evening: 6 Nov's revenue is new, its contracts not yet in the bhavcopy table
        self.assertEqual(run_mcx(tmp, days, {"2026-11-04": 20_923_946, "2026-11-05": 16_747_657}), 3)
        # Monday morning: no new revenue day, but 6 Nov's contracts have arrived
        friday = {"2026-11-04": 20_923_946, "2026-11-05": 16_747_657, "2026-11-06": 16_323_010}
        self.assertEqual(run_mcx(tmp, days, friday), 1)
        doc = json.loads((tmp / "dash" / "mcx_dashboard_data.json").read_text())
        self.assertEqual(doc["daily_all"][-1]["total_contracts"], 16_323_010)
        # The same inputs again: nothing to commit
        self.assertEqual(run_mcx(tmp, days, friday), 0)
        # A new revenue day counts as before
        self.assertEqual(run_mcx(tmp, days + ["2026-11-09"], friday), 1)


if __name__ == "__main__":
    unittest.main()
