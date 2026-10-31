"""MCX total contracts per day, from mcx_commodity_daily (bhavcopy rows per
commodity and instrument), carried on every daily row and special session."""

import json
import tempfile
import unittest
from pathlib import Path

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import mcx_pipeline as mcx


def rev_row(d, fut=3.0, opt=5.0):
    return {"trading_date": d, "fut_rev_cr": fut, "opt_rev_cr": opt, "total_rev_cr": fut + opt,
            "source": "mcx_relay_eod", "is_actual": True}


class Contracts(unittest.TestCase):
    def test_sums_every_commodity_and_instrument(self):
        rows = [{"trading_date": "2026-10-21", "contracts": 18_000_000},
                {"trading_date": "2026-10-21", "contracts": 289_605},
                {"trading_date": "2026-10-19", "contracts": 12_615_403},
                {"trading_date": "2026-05-27", "contracts": 0},
                {"trading_date": "2026-05-27", "contracts": None}]
        self.assertEqual(mcx.contracts_by_date(rows),
                         {"2026-10-21": 18_289_605, "2026-10-19": 12_615_403})   # zero day left out

    def test_fetch_pages_on_the_primary_key(self):
        seen = {}
        orig = mcx._sb_get
        mcx._sb_get = lambda path, **kw: seen.update(path=path, **kw) or []
        try:
            mcx.fetch_mcx_contracts()
        finally:
            mcx._sb_get = orig
        self.assertIn("order=trading_date.asc,commodity.asc,instrument_type.asc", seen["path"])
        self.assertIn("select=trading_date,contracts", seen["path"])
        self.assertGreater(seen["max_rows"], 100_000)

    def test_rows_without_a_count_get_none(self):
        daily = mcx.attach_contracts(mcx.transform_rows([rev_row("2026-10-19"), rev_row("2026-10-20")]),
                                     {"2026-10-19": 12_615_403})
        self.assertEqual([d["total_contracts"] for d in daily], [12_615_403, None])

    def test_previous_file_fallback(self):
        tmp = Path(tempfile.mkdtemp()) / "mcx_dashboard_data.json"
        tmp.write_text(json.dumps({
            "daily_all": [{"date": "2026-10-19", "total_contracts": 12_615_403},
                          {"date": "2026-10-20", "total_contracts": None}],
            "special_sessions": [{"date": "2025-10-21", "total_contracts": 900_000}]}))
        self.assertEqual(mcx.previous_contracts(tmp), {"2026-10-19": 12_615_403, "2025-10-21": 900_000})
        self.assertEqual(mcx.previous_contracts(tmp.parent / "missing.json"), {})


class MainRun(unittest.TestCase):
    """mcx_pipeline.main() with Supabase faked: total_contracts reaches
    daily_all and special_sessions; revenue is unchanged."""

    def run_main(self, contracts_rows, previous=None):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "data").mkdir()
        (tmp / "dash").mkdir()
        if previous:
            (tmp / "dash" / "mcx_dashboard_data.json").write_text(json.dumps(previous))

        def fake_get(path, **kw):
            if path.startswith("mcx_daily_revenue"):
                return [rev_row("2025-10-21", 0.1, 0.2), rev_row("2026-10-19"), rev_row("2026-10-21")]
            if contracts_rows is None:
                raise OSError("down")
            return contracts_rows
        saved = mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY
        mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY = fake_get, tmp / "data", tmp / "dash", "k"
        try:
            mcx.main()
        finally:
            mcx._sb_get, mcx.DATA_DIR, mcx.DASHBOARD_DIR, mcx.MCX_SUPABASE_KEY = saved
        return json.loads((tmp / "dash" / "mcx_dashboard_data.json").read_text())

    def test_contracts_published(self):
        doc = self.run_main([{"trading_date": "2025-10-21", "contracts": 900_000},
                             {"trading_date": "2026-10-19", "contracts": 12_615_403},
                             {"trading_date": "2026-10-21", "contracts": 18_289_605}])
        self.assertEqual({d["date"]: d["total_contracts"] for d in doc["daily_all"]},
                         {"2026-10-19": 12_615_403, "2026-10-21": 18_289_605})
        self.assertEqual(doc["special_sessions"][0]["total_contracts"], 900_000)
        self.assertEqual(doc["daily_all"][0]["total_rev"], 8.0)

    def test_fetch_failure_keeps_previous_counts(self):
        prev = {"daily_all": [{"date": "2026-10-19", "total_contracts": 12_615_403}], "summary": {}}
        doc = self.run_main(None, previous=prev)
        self.assertEqual({d["date"]: d["total_contracts"] for d in doc["daily_all"]},
                         {"2026-10-19": 12_615_403, "2026-10-21": None})


if __name__ == "__main__":
    unittest.main()
