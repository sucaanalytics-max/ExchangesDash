import importlib.util
import json
import sys
import tempfile
import types
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

# The poller imports curl_cffi at module level; tests never touch the network.
if importlib.util.find_spec("curl_cffi") is None:
    stub = types.ModuleType("curl_cffi")
    stub.requests = types.SimpleNamespace()
    sys.modules["curl_cffi"] = stub

import nse_live_poller as poller

PAYLOAD = {"data": [
    {"index": "NIFTY 50", "last": 25235.6},
    {"index": "INDIA VIX", "last": 15.52, "previousClose": 14.9, "variation": 0.62, "percentChange": 4.16},
]}


class IndiaVix(unittest.TestCase):
    def test_parse_reads_india_vix_entry(self):
        ts = "2026-11-19T04:20:25Z"
        self.assertEqual(
            poller.parse_india_vix(PAYLOAD, ts),
            {"last": 15.52, "previous_close": 14.9, "change": 0.62, "pct_change": 4.16,
             "as_of": ts, "source": "nse"},
        )

    def test_parse_missing_entry_is_none(self):
        ts = "2026-11-19T04:20:25Z"
        self.assertIsNone(poller.parse_india_vix({"data": [{"index": "NIFTY 50", "last": 1}]}, ts))
        self.assertIsNone(poller.parse_india_vix({"data": [{"index": "INDIA VIX", "last": "-"}]}, ts))

    def test_keep_last_marks_stale(self):
        prev = {"updated_at": "T0", "india_vix": {"last": 15}}
        self.assertEqual(poller.keep_last_vix(None, prev, "T1")["stale_since"], "T0")
        prev["india_vix"]["stale_since"] = "T-1"
        self.assertEqual(poller.keep_last_vix(None, prev, "T1")["stale_since"], "T-1")
        new = {"last": 16}
        self.assertIs(poller.keep_last_vix(new, prev, "T1"), new)
        self.assertIsNone(poller.keep_last_vix(None, {}, "T1"))

    def test_attach_preserves_samples(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "hourly.json"
            f.write_text(json.dumps({"date": "2026-11-19", "samples": [{"x": 1}]}))
            self.assertTrue(poller.attach_india_vix(f, {"last": 15.5}))
            data = json.loads(f.read_text())
            self.assertEqual(data["india_vix"], {"last": 15.5})
            self.assertEqual(data["samples"], [{"x": 1}])
            self.assertEqual(data["date"], "2026-11-19")
            missing = Path(d) / "nope.json"
            self.assertFalse(poller.attach_india_vix(missing, {"last": 15.5}))
            self.assertFalse(missing.exists())
            self.assertFalse(poller.attach_india_vix(f, None))

    def test_yfinance_nan_is_not_written(self):
        class Session:
            def get(self, *a, **k):
                raise RuntimeError("nse down")

        def stub(last, prev):
            ticker = lambda sym: types.SimpleNamespace(
                fast_info=types.SimpleNamespace(last_price=last, previous_close=prev))
            return types.SimpleNamespace(Ticker=ticker)

        nan = float("nan")
        with mock.patch.dict(sys.modules, {"yfinance": stub(nan, 15.0)}):
            self.assertIsNone(poller.fetch_india_vix(Session(), "T"))
        with mock.patch.dict(sys.modules, {"yfinance": stub(15.5, nan)}):
            vix = poller.fetch_india_vix(Session(), "T")
        self.assertEqual(vix["last"], 15.5)
        self.assertIsNone(vix["previous_close"])
        self.assertIsNone(vix["change"])
        self.assertIsNone(vix["pct_change"])


class ApplyVix(unittest.TestCase):
    DATES = [f"2026-11-{d:02d}" for d in range(1, 16)]

    def rows(self):
        out = []
        for i, d in enumerate(self.DATES):
            v = 0 if i < 3 else (15.52 if i >= 13 else 14.0 + i / 100)
            out.append({"date": d, "vix": v})
        return out

    def fetch_map(self, bad=None):
        m = {d: 11.0 for d in self.DATES}
        m[self.DATES[14]] = 16.1
        return m

    def test_fills_zeros_and_rechecks_last_ten(self):
        import nse_pipeline as nse
        rows = self.rows()
        old = [r["vix"] for r in rows]
        calls = []

        def fetch(a, b):
            calls.append((a, b))
            return self.fetch_map()

        changed = nse.apply_vix(rows, fetch=fetch)
        self.assertEqual(calls, [(self.DATES[0], self.DATES[14])])
        for i in range(0, 3):
            self.assertEqual(rows[i]["vix"], 11.0)
        for i in (3, 4):
            self.assertEqual(rows[i]["vix"], old[i])
        for i in range(5, 14):
            self.assertEqual(rows[i]["vix"], 11.0)
        self.assertEqual(rows[14]["vix"], 16.1)
        self.assertEqual(changed, self.DATES[0:3] + self.DATES[5:15])

    def test_empty_fetch_changes_nothing(self):
        import nse_pipeline as nse
        rows = self.rows()
        before = [dict(r) for r in rows]
        self.assertEqual(nse.apply_vix(rows, fetch=lambda a, b: {}), [])
        self.assertEqual(rows, before)

    def test_missing_date_keeps_value(self):
        import nse_pipeline as nse
        rows = self.rows()
        m = self.fetch_map()
        del m[self.DATES[7]]
        nse.apply_vix(rows, fetch=lambda a, b: m)
        self.assertEqual(rows[7]["vix"], 14.0 + 7 / 100)

    def test_never_writes_zero_over_value(self):
        import nse_pipeline as nse
        rows = self.rows()
        m = self.fetch_map()
        m[self.DATES[8]] = 0
        nse.apply_vix(rows, fetch=lambda a, b: m)
        self.assertEqual(rows[8]["vix"], 14.0 + 8 / 100)

    def test_no_fetch_when_all_recent_match(self):
        import nse_pipeline as nse
        rows = [{"date": d, "vix": 12.0} for d in self.DATES]
        m = {d: 12.0 for d in self.DATES}
        self.assertEqual(nse.apply_vix(rows, fetch=lambda a, b: m), [])


if __name__ == "__main__":
    unittest.main()
