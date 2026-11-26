import json
import math
import random
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from helpers import NODE, ROOT, js_eval

import share_regression as sr

SHARE_JS = ["computeRollingMA", "computeOLS", "buildSeriesWithDMA", "SHARE_GATE",
            "shareOlsStats", "shareHoldout", "shareGateReasons", "shareFitFrom", "shareLiveMa", "computeShareModel"]


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


@unittest.skipUnless(NODE, "node not installed")
class LiveQuote(unittest.TestCase):
    """A live price is paired with the MA up to the last revenue day before its date,
    as each close is, not with the latest close's (older) MA."""

    def out(self):
        rev, prices = fixture(noise=5)
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x")
        # the file's latest close is two revenue days behind the last revenue day
        last = out["series"][-1]["date"]
        out["series"] = [r for r in out["series"] if r["date"] < rev[-3][0]]
        out["latest"] = {"date": out["series"][-1]["date"], "price_actual": 1700.0, "is_live": True,
                         "live_date": "2099-01-01"}
        self.assertLess(out["latest"]["date"], last)
        return rev, out

    def test_live_pairs_with_the_ma_before_its_date(self):
        rev, out = self.out()
        m = js_eval(SHARE_JS, "computeShareModel(DATA, 5, 0)", out)
        rd = [r["revenue_cr"] for r in out["revenue_daily"]]   # as the file stores it
        want = sum(rd[-5:]) / 5                         # every revenue day is before 2099
        self.assertAlmostEqual(m["live"]["rev_ma"], want, places=9)
        self.assertAlmostEqual(m["live"]["price_pred"], m["reg"]["slope"] * want + m["reg"]["intercept"], places=1)
        self.assertNotAlmostEqual(m["live"]["rev_ma"], m["series"][-1]["rev_ma"], places=3)
        lagged = js_eval(SHARE_JS, "computeShareModel(DATA, 5, 2).live.rev_ma", out)
        self.assertAlmostEqual(lagged, sum(rd[-7:-2]) / 5, places=9)

    def test_live_date_inside_the_revenue(self):
        rev, out = self.out()
        out["latest"]["live_date"] = rev[-2][0]           # revenue up to the day before it
        ma = js_eval(SHARE_JS, "shareLiveMa(DATA, 5)", out)
        rd = [r["revenue_cr"] for r in out["revenue_daily"]]
        self.assertAlmostEqual(ma, sum(rd[-7:-2]) / 5, places=9)

    def test_no_live_quote(self):
        rev, out = self.out()
        out["latest"]["is_live"] = False
        self.assertIsNone(js_eval(SHARE_JS, "computeShareModel(DATA, 5, 0).live", out))
        out["latest"]["is_live"] = True
        del out["revenue_daily"]                          # legacy file: no daily revenue
        self.assertIsNone(js_eval(SHARE_JS, "shareLiveMa(DATA, 5)", out))


SHARE_RANGE_JS = SHARE_JS + ["shareRatioStats"]


def break_fixture(n=400, seed=11):
    """Like fixture(), but the price-revenue line changes on the 250th weekday
    (slope 100 → 60, and a lower price ÷ MA), so a fit on the later sessions
    has its own slope and ratio."""
    rng = random.Random(seed)
    dates = weekdays(date(2025, 1, 1), n)
    rev = [(d, 10 + 5 * math.sin(i / 15) + 0.3 * i / n * 10) for i, d in enumerate(dates)]
    mas = sr.revenue_ma(rev, 5)
    prices = {}
    for i, d in enumerate(dates):
        if i % 9 == 4 or i == 0 or mas[i - 1] is None:
            continue
        slope, icpt = (100, 500) if i < 250 else (60, 700)
        prices[d] = round(slope * mas[i - 1] + icpt + rng.gauss(0, 10), 4)
    return dates, rev, prices


def ratio_stats(prices, rev, window, dates):
    """Mean and population σ of close ÷ lagged revenue MA over `dates`, in Python."""
    lag = sr.lagged_ma_for(sorted(prices), rev, window)
    ratios = [prices[d] / lag[d][0] for d in dates]
    mean = sum(ratios) / len(ratios)
    return mean, math.sqrt(sum((r - mean) ** 2 for r in ratios) / len(ratios))


@unittest.skipUnless(NODE, "node not installed")
class RangeRefit(unittest.TestCase):
    """computeShareModel's `fitStart` (the Regression tab's Range): a later start
    re-fits on those sessions only, an earlier one is held at regression_start,
    and without it the published fit is unchanged."""

    def model(self, out, fit_start=None, window=5, lag=0):
        arg = "undefined" if fit_start is None else json.dumps(fit_start)
        return js_eval(SHARE_RANGE_JS, f"computeShareModel(DATA, {window}, {lag}, {arg})", out)

    def test_no_fit_start_is_the_published_fit(self):
        dates, rev, prices = break_fixture()
        for modelled in (None, {d for d, _ in rev[:30]}):
            out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                                  window=5, ma_windows=[5], updated_at="x", modelled=modelled)
            with self.subTest(modelled=bool(modelled)):
                three = js_eval(SHARE_RANGE_JS, "[computeShareModel(DATA, 5, 0), computeShareModel(DATA, 5, 0, undefined),"
                                " computeShareModel(DATA, 5, 0, DATA.regression_start)].map(m => JSON.stringify(m))", out)
                self.assertEqual(three[0], three[1])
                self.assertEqual(three[0], three[2])

    def test_start_before_regression_start_is_clamped(self):
        dates, rev, prices = break_fixture()
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start=dates[100],
                              window=5, ma_windows=[5], updated_at="x")
        self.assertEqual(self.model(out, dates[20]), self.model(out))
        self.assertEqual(self.model(out, "2020-01-01"), self.model(out))
        self.assertEqual(js_eval(SHARE_RANGE_JS, f"shareFitFrom('{dates[100]}', '{dates[20]}')"), dates[100])

    def test_later_start_refits_on_those_sessions(self):
        dates, rev, prices = break_fixture()
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x")
        later = dates[260]
        full, js = self.model(out), self.model(out, later)
        py = sr.fit_model(prices, rev, 5, later)          # the same fit, computed independently
        self.assertLess(js["n"], full["n"])
        self.assertEqual(js["n"], py["n"])
        self.assertAlmostEqual(js["reg"]["slope"], py["slope"], places=3)
        self.assertAlmostEqual(js["reg"]["intercept"], py["intercept"], places=1)
        self.assertAlmostEqual(js["reg"]["r_squared"], py["r2"], places=4)
        self.assertAlmostEqual(js["meth"]["t_stat_newey_west"], py["t_nw"], places=1)
        self.assertAlmostEqual(js["meth"]["durbin_watson"], py["durbin_watson"], places=2)
        self.assertAlmostEqual(js["meth"]["holdout"]["mape_pct"], py["holdout"]["mape"], places=1)
        self.assertEqual(js["meth"]["fair_value_supported"], py["supported"])
        self.assertAlmostEqual(js["reg"]["slope"], 60, delta=5)          # the post-break line, not the blend
        self.assertGreater(abs(js["reg"]["slope"] - full["reg"]["slope"]), 5)
        # In-fit rows are exactly the later sessions, and the fair value uses the new line
        self.assertEqual([r["date"] for r in js["series"] if r["in_fit"]], py["dates"])
        last = js["series"][-1]
        self.assertAlmostEqual(last["price_pred"], py["slope"] * last["rev_ma"] + py["intercept"], delta=0.02)
        # Price ÷ MA mean and σ over the re-fitted rows
        mean, sd = ratio_stats(prices, rev, 5, py["dates"])
        rs = js_eval(SHARE_RANGE_JS, f"shareRatioStats(computeShareModel(DATA, 5, 0, '{later}').series, '{later}')", out)
        full_rs = js_eval(SHARE_RANGE_JS, "shareRatioStats(computeShareModel(DATA, 5, 0).series, DATA.regression_start)", out)
        self.assertAlmostEqual(rs["mean"], mean, delta=0.01)
        self.assertAlmostEqual(rs["sd"], sd, delta=0.01)
        self.assertGreater(abs(rs["mean"] - full_rs["mean"]), 1)

    def test_modelled_rows_stay_out_of_a_refit(self):
        # Modelled history runs past the range start: those rows stay out, as in the published fit
        dates, rev, prices = break_fixture()
        modelled = {d for d, _ in rev[:80]}
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x", modelled=modelled)
        ref = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start=dates[60],
                              window=5, ma_windows=[5], updated_at="x", modelled=modelled)
        js = self.model(out, dates[60])
        self.assertEqual(js["n"], ref["n_days"])
        self.assertAlmostEqual(js["reg"]["slope"], ref["regression"]["slope"], places=3)
        self.assertTrue(all(r["date"] > dates[83] for r in js["series"] if r["in_fit"]))

    def test_too_few_sessions_gives_no_model(self):
        dates, rev, prices = break_fixture()
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=5, ma_windows=[5], updated_at="x")
        self.assertIsNone(self.model(out, dates[-8]))


# buildShareAnalysis against a minimal DOM: each [data-rx] slot is one node,
# rxOnSeg's click handlers are kept so a Range click can be replayed, and
# Chart.js drawing is stubbed out.
TAB_JS = SHARE_RANGE_JS + [
    "latestShareRow", "SHARE_RANGE_MONTHS", "shareRangeStart", "filterShareSeries", "SHARE_EXCHANGE_NAMES",
    "SHARE_MA_WINDOWS", "SHARE_LAGS", "shareRanges", "shareChecksHTML", "shareHeroHTML", "buildShareAnalysis",
    "rxPanel", "rxChip", "rxSeg", "rxOnSeg", "rxCheck", "rxAlert", "rxHow", "rxLegend", "rxSignedPct", "rxRupee",
    "rxDate", "rxCanvas", "escHtml", "fmtNum", "fmtChartDate", "RX", "RX_ICONS", "charts"]
TAB_HARNESS = r"""(() => {
  const nodes = {}, clicks = {}, blocks = [0, 1, 2].map(() => ({ style: {} }));
  const node = k => nodes[k] || (nodes[k] = { innerHTML: '', textContent: '', hidden: false, style: {},
    addEventListener: (t, f) => { clicks[k] = f; }, querySelectorAll: () => [] });
  const root = { set innerHTML(v) {}, querySelector: sel => node(sel),
    querySelectorAll: sel => sel === '[data-rx-chartblock]' ? blocks : [node(sel)] };
  globalThis.document = { getElementById: () => root };
  globalThis.SHARE_DATA = DATA;
  globalThis.RX_TAB_REFRESH = {};
  globalThis.rxChart = () => null;
  globalThis.rxFixHeight = () => {};
  globalThis.fmtTradeDate = iso => iso;
  const pick = v => clicks['[data-rx-seg="range"]']({ target: { closest: () => ({ getAttribute: () => 'false', dataset: { value: v } }) } });
  const shot = () => ({ hero: node('[data-rx="hero"]').innerHTML, checks: node('[data-rx="checks"]').innerHTML,
    r2: node('[data-rx="r2"]').innerHTML, charts: blocks.map(b => b.style.display || '') });
  buildShareAnalysis('bse');
  const out = { fit: shot() };
  for (const v of RANGES) { pick(v); out[v] = shot(); }
  return out;
})()"""


@unittest.skipUnless(NODE, "node not installed")
class RangeRefitTab(unittest.TestCase):
    def run_tab(self, out, ranges):
        return js_eval(TAB_JS, f"(globalThis.RANGES = {json.dumps(ranges)}, {TAB_HARNESS})", out)

    def test_range_click_refits_every_figure(self):
        dates, rev, prices = break_fixture()
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start=dates[150],
                              window=5, ma_windows=[5], updated_at="x")
        out["ma_window"] = 10          # a window the tab offers
        tab = self.run_tab(out, ["3m", "1y", "fit"])
        self.assertIn("fitted over", tab["fit"]["hero"])
        self.assertNotIn("stays the full-window fit", tab["fit"]["hero"])
        three = tab["3m"]
        self.assertNotEqual(three["hero"], tab["fit"]["hero"])
        self.assertNotEqual(three["checks"], tab["fit"]["checks"])
        self.assertIn("Re-fitted on the last 3 months", three["hero"])
        self.assertIn("stays the full-window fit", three["hero"])
        self.assertIn("this range", three["r2"])
        # 1 Y reaches back past regression_start: the fit is held there, and says so
        self.assertIn("the regression start", tab["1y"]["hero"])
        # Back on the published window, the first render returns exactly
        self.assertEqual(tab["fit"]["hero"], self.run_tab(out, [])["fit"]["hero"])

    def test_range_with_too_few_sessions(self):
        # No quotes for most of the last three months (a suspension): 3 M cannot be fitted
        dates, rev, prices = break_fixture()
        cutoff = (date.fromisoformat(dates[-1]) - timedelta(days=88)).isoformat()
        kept = [d for d in sorted(prices) if d >= cutoff][-4:]
        prices = {d: p for d, p in prices.items() if d < cutoff or d in kept}
        out = sr.build_output(ticker="T", prices=prices, rev_rows=rev, reg_start="2025-01-01",
                              window=10, ma_windows=[10], updated_at="x")
        tab = self.run_tab(out, ["3m", "fit"])
        self.assertIn("Too few sessions in this range", tab["3m"]["hero"])
        self.assertEqual(tab["3m"]["checks"], "")
        self.assertEqual(tab["3m"]["charts"], ["none"] * 3)
        self.assertIn("—", tab["3m"]["r2"])
        # The controls still work: picking the full window brings the model and charts back
        self.assertIn("fitted over", tab["fit"]["hero"])
        self.assertEqual(tab["fit"]["charts"], [""] * 3)



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


class SpecialSessionPrices(unittest.TestCase):
    """A Muhurat / DR-test close stays out of the fit and its session count, for the
    exchanges that held the session only."""

    def test_dropped_per_exchange(self):
        prices = {"2025-10-20": 10.0, "2025-10-21": 11.0, "2024-03-02": 12.0, "2026-11-09": 13.0}
        kept, dropped = sr.drop_special_sessions(prices, "nse")
        self.assertEqual(dropped, ["2024-03-02", "2025-10-21"])          # Muhurat and DR test
        self.assertEqual(kept, {"2025-10-20": 10.0, "2026-11-09": 13.0})
        kept, dropped = sr.drop_special_sessions(prices, "mcx")        # MCX held no DR test
        self.assertEqual(dropped, ["2025-10-21"])
        self.assertIn("2024-03-02", kept)
        self.assertEqual(prices["2025-10-21"], 11.0)                    # input left alone


class UnfinishedSessionPrices(unittest.TestCase):
    """A run before 16:00 IST must not store yfinance's in-progress bar for today as
    that day's close (25 Nov 2026: the 11:52 IST manual run stored mid-session prices)."""

    PRICES = {"2026-11-21": 3700.0, "2026-11-24": 3790.0, "2026-11-25": 3828.0}

    @staticmethod
    def at(hh, mm, day=25):          # IST wall clock on 25 Nov 2026, as an aware UTC datetime
        return datetime(2026, 11, day, hh, mm, tzinfo=sr.IST).astimezone(timezone.utc)

    def test_before_close_drops_today(self):
        for hh, mm in [(0, 0), (9, 15), (11, 52), (15, 59)]:
            kept, dropped = sr.drop_unfinished_session(self.PRICES, now=self.at(hh, mm))
            self.assertEqual(dropped, ["2026-11-25"], (hh, mm))
            self.assertEqual(kept, {"2026-11-21": 3700.0, "2026-11-24": 3790.0})
        self.assertIn("2026-11-25", self.PRICES)                        # input left alone

    def test_from_close_keeps_today(self):
        for hh, mm in [(16, 0), (16, 1), (23, 59)]:
            kept, dropped = sr.drop_unfinished_session(self.PRICES, now=self.at(hh, mm))
            self.assertEqual((kept, dropped), (self.PRICES, []), (hh, mm))

    def test_today_is_the_ist_date(self):
        # 20:00 UTC on 24 Nov is 01:30 IST on 25 Nov: 25 Nov's session hasn't opened.
        kept, dropped = sr.drop_unfinished_session(
            self.PRICES, now=datetime(2026, 11, 24, 20, 0, tzinfo=timezone.utc))
        self.assertEqual(dropped, ["2026-11-25"])
        # 10:30 UTC on 25 Nov is 16:00 IST: closed.
        kept, dropped = sr.drop_unfinished_session(
            self.PRICES, now=datetime(2026, 11, 25, 10, 30, tzinfo=timezone.utc))
        self.assertEqual(dropped, [])

    def test_earlier_dates_always_kept(self):
        prices = {"2026-11-21": 3700.0, "2026-11-24": 3790.0}      # no row for today yet
        for hh, mm in [(10, 0), (17, 0)]:
            kept, dropped = sr.drop_unfinished_session(prices, now=self.at(hh, mm))
            self.assertEqual((kept, dropped), (prices, []))
        kept, dropped = sr.drop_unfinished_session(self.PRICES, now=self.at(10, 0, day=26))
        self.assertEqual((kept, dropped), (self.PRICES, []))           # 25 Nov is yesterday


class BseRevenueMerge(unittest.TestCase):
    """bse_share_analysis.merge_revenue: the pipeline wins, the seed fills gaps, and
    a Muhurat / DR-test session the pipeline moved to special_sessions never comes
    back from the seed into the revenue MA."""

    def test_special_sessions_stay_out(self):
        import bse_share_analysis as bsa
        seed = {"2025-10-20": {"revenue_cr": 9.0}, "2025-10-21": {"revenue_cr": 2.33},   # 21 Oct 2025: Muhurat
                "2025-10-23": {"revenue_cr": 7.0}, "2024-03-02": {"revenue_cr": 0.3},    # 2 Mar 2024: DR test
                "2025-10-24": {"revenue_cr": None}}
        pipeline = {"2025-10-20": 20.0, "2025-10-23": 21.0}
        self.assertEqual(bsa.merge_revenue(seed, pipeline), [("2025-10-20", 20.0), ("2025-10-23", 21.0)])
        self.assertEqual(bsa.merge_revenue({"2025-10-22": {"revenue_cr": 5.0}}, pipeline),
                         [("2025-10-20", 20.0), ("2025-10-22", 5.0), ("2025-10-23", 21.0)])


if __name__ == "__main__":
    unittest.main()
