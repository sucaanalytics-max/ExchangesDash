"""NSE cash-turnover corrections (nse_pipeline.NSE_CASH_CORRECTIONS).

Shadow mode never rewrites a stored row, so a cash traded value confirmed wrong
by an independent NSE source is corrected explicitly: only on the listed dates,
only while the row still holds the known-wrong value, and with cash_rev /
total_rev recomputed by the usual formulas."""

import contextlib
import copy
import io
import json
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import fee_register
import nse_pipeline as nse
import trading_calendar

FO_FIELDS = ("if_turnover", "sf_turnover", "io_premium", "so_premium", "if_rev", "sf_rev",
             "fut_rev", "io_rev", "so_rev", "opt_rev", "fo_rev", "total_contracts", "total_turnover")
DETAIL = {"cash_trades": 1, "cash_securities": 1, "cash_quantity": 1,
          "if_contracts": 1, "sf_contracts": 1, "io_contracts": 1, "so_contracts": 1}


def fo_rec(date):
    """An NSE F&O archive record for ISO `date`."""
    return {"F_TIMESTAMP": datetime.strptime(date, "%Y-%m-%d").strftime("%d-%b-%Y"),
            "Index_Futures_VAL": 28174.88, "Stock_Futures_VAL": 88114.38,
            "Index_Options_VAL": 9e6, "Index_Options_PREM_VAL": 38154.08,
            "Stock_Options_VAL": 4e5, "Stock_Options_PREM_VAL": 7332.57,
            "Index_Options_PUT_CALL_RATIO": 1.0, "F&O_Total_QTY": 4, "F&O_Total_VAL": 9.5e6,
            "Index_Futures_QTY": 1, "Stock_Futures_QTY": 1, "Index_Options_QTY": 1, "Stock_Options_QTY": 1}


def cm_rec(date, value):
    return {"F_TIMESTAMP": datetime.strptime(date, "%Y-%m-%d").strftime("%d-%b-%Y"),
            "CDT_NOS_OF_SECURITY_TRADES": 2992, "CDT_NOS_OF_TRADES": 35010629,
            "CDT_TRADES_QTY": 47810.30, "CDT_TRADES_VALUES": value}


def stored(date, cash, **over):
    """A stored daily row (as the previous JSON holds it), with VIX and detail."""
    row = {k: v for k, v in nse.parse_fo_record(fo_rec(date)).items() if k != "_dt"}
    row.update(DETAIL, vix=15.0, cash_traded_value=cash, cash_rev=nse.cash_revenue(cash))
    row["total_rev"] = nse.total_revenue(row)
    row.update(over)
    return row


REGISTER = {"2025-06-13": {"stored": 119525.75, "cash_traded_value": 104981.80, "source": "test"}}


class ApplyCorrections(unittest.TestCase):
    def test_wrong_value_is_corrected(self):
        row = stored("2025-06-13", 119525.75)
        before = copy.deepcopy(row)
        out = nse.apply_cash_corrections([row, stored("2025-06-12", 117580.76)], REGISTER)
        self.assertEqual(len(out), 1)
        fixed = out[0]
        self.assertEqual(fixed["cash_traded_value"], 104981.80)
        self.assertEqual(fixed["cash_rev"], nse.cash_revenue(104981.80))
        self.assertEqual(fixed["total_rev"], round(fixed["fo_rev"] + fixed["cash_rev"], 4))
        self.assertEqual({k: fixed[k] for k in FO_FIELDS}, {k: before[k] for k in FO_FIELDS})
        self.assertEqual(fixed["cash_trades"], before["cash_trades"])   # entry carries no counts
        self.assertEqual(row, before)                                    # input not modified

    def test_idempotent_and_guarded(self):
        self.assertEqual(nse.apply_cash_corrections([stored("2025-06-13", 104981.80)], REGISTER), [])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            out = nse.apply_cash_corrections([stored("2025-06-13", 111111.11)], REGISTER)
        self.assertEqual(out, [])                                        # unexpected value: left alone
        self.assertIn("WARNING: 2025-06-13", buf.getvalue())
        self.assertEqual(nse.apply_cash_corrections([stored("2025-06-16", 119525.75)], REGISTER), [])

    def test_missing_cash_day_gets_counts_only_when_published(self):
        gap = stored("2023-08-07", 0, cash_trades=None, cash_securities=None, cash_quantity=None)
        with_counts = {"2023-08-07": {"stored": 0, "cash_traded_value": 72000.5, "cash_trades": 25000000,
                                      "cash_securities": 2450, "cash_quantity": 3900000000, "source": "test"}}
        fixed = nse.apply_cash_corrections([gap], with_counts)[0]
        self.assertEqual((fixed["cash_trades"], fixed["cash_securities"], fixed["cash_quantity"]),
                         (25000000, 2450, 3900000000))
        self.assertEqual(fixed["cash_rev"], nse.cash_revenue(72000.5))
        value_only = {"2023-08-07": {"stored": 0, "cash_traded_value": 72000.5, "source": "test"}}
        fixed = nse.apply_cash_corrections([gap], value_only)[0]
        self.assertIsNone(fixed["cash_trades"])                          # never invented as 0
        self.assertEqual(fixed["total_rev"], nse.total_revenue(fixed))


class Register(unittest.TestCase):
    def test_entries_are_complete(self):
        for d, c in nse.NSE_CASH_CORRECTIONS.items():
            with self.subTest(date=d):
                datetime.strptime(d, "%Y-%m-%d")
                self.assertIsNone(trading_calendar.special_session("nse", d))
                self.assertTrue(c.get("source", "").strip())
                self.assertGreater(c["cash_traded_value"], 0)
                self.assertGreaterEqual(abs(c["cash_traded_value"] - c["stored"]), 0.005)
                self.assertLessEqual(set(c) - {"stored", "source"}, set(nse.CASH_CORRECTION_FIELDS))
                for k in nse.CASH_DETAIL_FIELDS:
                    if k in c:
                        self.assertIsInstance(c[k], int)
                        self.assertGreater(c[k], 0)

    def test_filled_gap_days_are_complete(self):
        """A day stored without cash gets its counts too, so the row no longer
        sends the pipeline back to re-fetch its month every run."""
        for d, c in nse.NSE_CASH_CORRECTIONS.items():
            if c["stored"] == 0:
                gap = stored(d, 0, cash_trades=None, cash_securities=None, cash_quantity=None)
                fixed = nse.apply_cash_corrections([gap])[0]
                self.assertEqual(nse.missing_detail(fixed), set(), d)
                self.assertEqual(fixed["cash_rev"], nse.cash_revenue(c["cash_traded_value"]))


class ShadowModeRun(unittest.TestCase):
    """nse_pipeline.main() without Supabase and with NSE faked: a stored row
    holding the known-wrong cash value is corrected in every output."""

    def test_end_to_end(self):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        (tmp / "dashboard" / "data").mkdir(parents=True)
        existing = [stored("2025-06-12", 117580.76), stored("2025-06-13", 119525.75),
                    stored("2025-06-16", 91120.68)]
        (tmp / "data" / "dashboard_data.json").write_text(json.dumps(
            {"daily_all": existing, "pnl": [], "pnl_fy": [], "cost_ratios": {}}))

        saved = {k: getattr(nse, k) for k in ("DATA_DIR", "DASHBOARD_DIR", "SUPABASE_URL", "nse_session",
                                              "fetch_nse_data", "fetch_detail_months",
                                              "NSE_CASH_CORRECTIONS")}
        nse.DATA_DIR, nse.DASHBOARD_DIR, nse.SUPABASE_URL = tmp / "data", tmp / "dashboard", ""
        nse.nse_session = lambda: None
        nse.fetch_nse_data = lambda session: ({"data": [fo_rec("2025-06-17")]},
                                              {"data": [cm_rec("2025-06-17", 95000.0)]})
        nse.fetch_detail_months = lambda session, months: ({}, {})
        nse.NSE_CASH_CORRECTIONS = REGISTER
        try:
            with contextlib.redirect_stdout(io.StringIO()) as log:
                nse.main()
        finally:
            for k, v in saved.items():
                setattr(nse, k, v)

        self.assertIn("Corrected 2025-06-13 cash_traded_value 119525.75 → 104981.8", log.getvalue())
        out = json.loads((tmp / "data" / "dashboard_data.json").read_text())
        row = {r["date"]: r for r in out["daily_all"]}["2025-06-13"]
        self.assertEqual(row["cash_traded_value"], 104981.80)
        self.assertEqual(row["cash_rev"], nse.cash_revenue(104981.80))
        self.assertEqual(row["total_rev"], round(row["fo_rev"] + row["cash_rev"], 4))
        june = next(m for m in out["monthly"] if m["month"] == "FY 2026 June")
        others = [r for r in existing if r["date"] != "2025-06-13"]
        expected = sum(r["cash_rev"] for r in others) + row["cash_rev"] + nse.cash_revenue(95000.0)
        self.assertAlmostEqual(june["cash_rev"], round(expected, 2), places=2)

        eff = json.loads((tmp / "dashboard" / "data" / "nse_dashboard_data_eff.json").read_text())
        erow = {r["date"]: r for r in eff["daily_all"]}["2025-06-13"]
        rate = fee_register.day_rates("NSE", "2025-06-13")["cash"][0]
        self.assertEqual(erow["cash_traded_value"], 104981.80)
        self.assertEqual(erow["cash_rev"], nse.cash_revenue(104981.80, rate))
        self.assertEqual(erow["total_rev"], round(erow["fo_rev"] + erow["cash_rev"], 4))
        today = json.loads((tmp / "dashboard" / "data" / "nse_dashboard_data.json").read_text())
        self.assertEqual({r["date"]: r for r in today["daily_all"]}["2025-06-13"]["cash_rev"],
                         row["cash_rev"])


if __name__ == "__main__":
    unittest.main()
