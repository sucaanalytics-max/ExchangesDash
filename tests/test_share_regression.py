import json
import math
import random
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from helpers import NODE, ROOT, js_eval

import share_regression as sr

SHARE_JS = ["computeRollingMA", "computeOLS", "buildSeriesWithDMA", "SHARE_GATE",
            "shareOlsStats", "shareHoldout", "shareGateReasons", "computeShareModel"]


def weekdays(start, n):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def fixture(n=200, noise=0.0, seed=7):
    """Revenue on every weekday; prices on all but every 9th day (no quote);
    price = 100 × previous-session 5-day revenue MA + 500 (+ noise)."""
    rng = random.Random(seed)
    dates = weekdays(date(2025, 1, 1), n)
    rev = [(d, 10 + 5 * math.sin(i / 15) + 0.3 * i / n * 10) for i, d in enumerate(dates)]
    mas = sr.revenue_ma(rev, 5)
    prices = {}
    for i, d in enumerate(dates):
        if i % 9 == 4 or i == 0 or mas[i - 1] is None:
            continue
        prices[d] = round(100 * mas[i - 1] + 500 + rng.gauss(0, noise), 4)
    return rev, prices


class RegressionMaths(unittest.TestCase):
    def test_exact_line_recovered_with_one_session_lag(self):
        rev, prices = fixture()
        s = sr.fit_model(prices, rev, 5, "2025-01-01")
        self.assertAlmostEqual(s["slope"], 100, places=6)
        self.assertAlmostEqual(s["intercept"], 500, places=4)
        self.assertAlmostEqual(s["r2"], 1.0, places=9)

    def test_lag_uses_last_revenue_day_before_price_date(self):
        rev = [("2025-01-01", 1.0), ("2025-01-02", 2.0), ("2025-01-03", 3.0)]
        lag = sr.lagged_ma_for(["2025-01-02", "2025-01-03", "2025-01-06"], rev, 1)
        self.assertEqual(lag["2025-01-02"], (1.0, "2025-01-01"))
        self.assertEqual(lag["2025-01-06"], (3.0, "2025-01-03"))   # weekend: Friday's revenue
        self.assertEqual(sr.lagged_ma_for(["2025-01-03"], rev, 1, extra_lag=1)["2025-01-03"],
                         (1.0, "2025-01-01"))

    def test_ma_ignores_price_gaps(self):
        # MA runs over revenue days, so a missing price never shortens its window
        rev, prices = fixture()
        mas = dict(zip([d for d, _ in rev], sr.revenue_ma(rev, 5)))
        self.assertAlmostEqual(mas[rev[10][0]], sum(v for _, v in rev[6:11]) / 5)

    def test_newey_west_and_durbin_watson(self):
        rev, prices = fixture(noise=20)
        s = sr.fit_model(prices, rev, 5, "2025-01-01")
        self.assertEqual(s["nw_lags"], math.floor(1.3 * math.sqrt(s["n"])))
        self.assertGreater(s["t_nw"], 10)
        self.assertTrue(1.0 < s["durbin_watson"] < 3.0)   # white noise residuals ≈ 2

    def test_gate(self):
        rev, prices = fixture(n=40)
        s = sr.fit_model(prices, rev, 5, "2025-01-01")
        self.assertFalse(s["supported"])
        self.assertTrue(any("observations" in r for r in s["gate_reasons"]))
        rev, prices = fixture()
        self.assertTrue(sr.fit_model(prices, rev, 5, "2025-01-01")["supported"])
        flat = [(d, 10.0 + (i % 2) * 0.01) for i, (d, _) in enumerate(rev)]
        s = sr.fit_model(prices, flat, 5, "2025-01-01")
        self.assertTrue(any("moved only" in r for r in s["gate_reasons"]))

    def test_holdout_is_chronological(self):
        rev, prices = fixture(noise=5)
        s = sr.fit_model(prices, rev, 5, "2025-01-01")
        h = s["holdout"]
        self.assertEqual(h["n_train"] + h["n_test"], s["n"])
        self.assertEqual(h["n_test"], round(s["n"] * sr.HOLDOUT_SHARE))
        self.assertTrue(h["beats_naive"])

    def test_modelled_rows_excluded(self):
        rev, prices = fixture()
        modelled = {d for d, _ in rev[:60]}
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x", modelled=modelled)
        clean = sr.fit_model(prices, rev, 5, "2025-01-01")
        self.assertEqual(out["n_days"] + out["modelled_excluded"], clean["n"])
        self.assertTrue(all(r.get("modelled") for r in out["revenue_daily"][:5]))

    def test_unsupported_fit_publishes_no_price(self):
        rev, prices = fixture(n=40)
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x")
        self.assertIsNone(out["latest"]["price_pred"])
        self.assertFalse(out["methodology"]["fair_value_supported"])


@unittest.skipUnless(NODE, "node not installed")
class DashboardMirror(unittest.TestCase):
    """computeShareModel (dashboard/js/13-regression.js) must reproduce share_regression.py."""

    def check(self, out, window=5, lag=0, modelled=False):
        js = js_eval(SHARE_JS, f"computeShareModel(DATA, {window}, {lag})", out)
        meth = out["methodology"]
        self.assertAlmostEqual(js["reg"]["slope"], out["regression"]["slope"], places=3)
        self.assertAlmostEqual(js["reg"]["intercept"], out["regression"]["intercept"], places=1)
        self.assertAlmostEqual(js["reg"]["r_squared"], out["regression"]["r_squared"], places=4)
        self.assertEqual(js["n"], out["n_days"])
        self.assertAlmostEqual(js["meth"]["t_stat_newey_west"], meth["t_stat_newey_west"], places=1)
        self.assertAlmostEqual(js["meth"]["durbin_watson"], meth["durbin_watson"], places=2)
        self.assertEqual(js["meth"]["fair_value_supported"], meth["fair_value_supported"])
        if meth["holdout"]:
            self.assertAlmostEqual(js["meth"]["holdout"]["mape_pct"], meth["holdout"]["mape_pct"], places=1)
        last_js = js["series"][-1]["price_pred"]
        last_py = out["latest"]["price_pred"]
        if last_py is None:
            self.assertIsNone(last_js)
        else:
            self.assertAlmostEqual(last_js, last_py, places=1)

    def test_fixture(self):
        rev, prices = fixture(noise=15)
        modelled = {d for d, _ in rev[:30]}
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x", modelled=modelled)
        self.check(out)

    def test_committed_files(self):
        """The real share files, when they are already in the Phase 5 format."""
        for ex in ("bse", "mcx", "nse"):
            out = json.loads((ROOT / "dashboard" / "data" / f"{ex}_share_analysis.json").read_text())
            if "revenue_daily" not in out or not out.get("regression"):
                continue
            with self.subTest(ex=ex):
                self.check(out, window=out["ma_window"])



class WriteIfChanged(unittest.TestCase):
    """A rerun on unchanged prices must leave the file alone, so the workflow
    commits nothing; any change to the analysis itself must be written."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "data" / "x_share_analysis.json"
        self.out = {"updated_at": "2026-10-17T16:38:58Z", "status": "ready",
                    "series": [{"date": "2026-10-16", "price": 271.67, "price_pred": 876.01}],
                    "latest": {"price_pred": 876.01}}

    def tearDown(self):
        self.tmp.cleanup()

    def rerun(self, **changes):
        out = json.loads(json.dumps(self.out))
        out["updated_at"] = "2026-10-18T11:27:59Z"
        for key, value in changes.items():
            out[key] = value
        return out

    def test_first_write_creates_the_file(self):
        self.assertTrue(sr.write_if_changed(self.path, self.out))
        self.assertEqual(json.loads(self.path.read_text()), self.out)

    def test_only_updated_at_changed_is_not_written(self):
        sr.write_if_changed(self.path, self.out)
        before = self.path.read_text()
        self.assertFalse(sr.write_if_changed(self.path, self.rerun()))
        self.assertEqual(self.path.read_text(), before)

    def test_analysis_change_is_written(self):
        for changes in ({"latest": {"price_pred": 876.02}},
                        {"series": self.out["series"] + [{"date": "2026-10-19", "price": 272.0, "price_pred": None}]},
                        {"status": "collecting"}):
            with self.subTest(changes=list(changes)):
                sr.write_if_changed(self.path, self.out)
                self.assertTrue(sr.write_if_changed(self.path, self.rerun(**changes)))
                self.assertEqual(json.loads(self.path.read_text())["updated_at"], "2026-10-18T11:27:59Z")

    def test_unreadable_file_is_replaced(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("{not json")
        self.assertTrue(sr.write_if_changed(self.path, self.out))

    def test_nan_still_fails_loudly(self):
        with self.assertRaises(ValueError):
            sr.write_if_changed(self.path, {"x": float("nan")})
        self.assertFalse(self.path.exists())


if __name__ == "__main__":
    unittest.main()
