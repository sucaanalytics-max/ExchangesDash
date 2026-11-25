"""Calculation helpers behind the redesigned dashboard tabs (dashboard/js), run in Node.

The Revenue Predictor's NSE path must reproduce scripts/nse_pipeline.py's ratio
model, the valuation tabs must reproduce the Excel workbook's Valuation Inputs
sheet, and the Live tab's archive scoring must read the history file as
live_common writes it."""

import json
import subprocess
import unittest

from helpers import NODE, ROOT, js_eval, js_source

import nse_pipeline as nse

PREDICTOR_JS = ["PREDICTOR_SEGMENTS", "predictorScenario"]
LIVE_JS = ["INTRADAY_CHECKPOINTS", "SESSION_MINUTES", "dayFractionAt", "quantile", "revenueAt",
           "liveModelError", "shareOfDayError"]
LIVE_CARD_JS = LIVE_JS + ["liveDefaultType", "liveDayPool", "typicalPathRange", "shareOfDayTrack", "liveModelTrack", "liveCardModel",
                          "intradayMethodLabel", "sessionClock", "SEG_PRODUCT", "NO_FLAGS", "periodFlags"]


def _nse_pnl():
    return json.loads((ROOT / "dashboard" / "data" / "nse_dashboard_data.json").read_text()).get("pnl") or []


REST_MIX_JS = ["EXPIRY_RULES", "EXPIRY_DOW_NAMES", "expiryRuleFor", "isScheduledExpiry", "EXPIRY_DATES_CACHE",
               "computeWeekExpiryDates", "expiryDateSet", "PRE_EXPIRY_DATES_CACHE", "preExpiryDateSet",
               "PREDICTOR_MIN_BUCKET", "PREDICTOR_BUCKETS", "quarterEndIso", "predictorNextIso", "predictorRestMix"]


@unittest.skipUnless(NODE, "node not installed")
class PredictorRestMix(unittest.TestCase):
    """Revenue Predictor's expiry-aware Base: the sessions left split by kind, each at its own average."""

    @staticmethod
    def _quarter():
        # Q3 FY 2027 to Fri 20 Nov 2026: NSE expiry Tuesdays earn 100, Mondays (pre-expiry) 60, other days 40
        import datetime as dt
        rows, d = [], dt.date(2026, 10, 1)
        while d <= dt.date(2026, 11, 20):
            if d.weekday() < 5:
                rev = {1: 100.0, 0: 60.0}.get(d.weekday(), 40.0)
                rows.append({"date": d.isoformat(), "opt_rev": rev, "fut_rev": 0.0, "cash_rev": 0.0})
            d += dt.timedelta(days=1)
        n = len(rows)
        adr = sum(r["opt_rev"] for r in rows) / n
        ctx = {"segs": ["opt", "fut", "cash"], "n": n, "daily": rows, "cq": {"quarter": "Q3 FY 2027"},
               "adr": {"opt": adr, "fut": 0, "cash": 0}}
        return ctx, rows

    def test_split_adds_up_and_weights_each_kind(self):
        ctx, rows = self._quarter()
        days = ctx["n"] + 29
        got = js_eval(REST_MIX_JS, "predictorRestMix('nse', DATA.ctx, DATA.days, DATA.rows)", {"ctx": ctx, "days": days, "rows": rows})
        mix = got["mix"]
        self.assertEqual(mix["e"] + mix["p"] + mix["o"], 29)
        # 23 Nov – 31 Dec: 6 Tuesdays, 6 Mondays among 29 weekdays
        self.assertEqual((mix["e"], mix["p"]), (6, 6))
        self.assertEqual(got["src"]["e"], "quarter to date")
        want = (mix["e"] * 100 + mix["p"] * 60 + mix["o"] * 40) / 29
        self.assertAlmostEqual(got["perSeg"]["opt"], want, places=9)

    def test_mcx_keeps_the_flat_pace(self):
        ctx, rows = self._quarter()
        got = js_eval(REST_MIX_JS, "predictorRestMix('mcx', DATA.ctx, DATA.days, DATA.rows)", {"ctx": ctx, "days": ctx["n"] + 29, "rows": rows})
        self.assertIsNone(got["mix"])
        self.assertAlmostEqual(got["perSeg"]["opt"], ctx["adr"]["opt"], places=9)


@unittest.skipUnless(NODE, "node not installed")
class PredictorMirrorsPipeline(unittest.TestCase):
    """Base scenario = scripts/nse_pipeline.py compute_predicted_quarters, line for line."""

    def test_nse_scenario_matches_ratio_model(self):
        hist = _nse_pnl()
        model = nse.nse_ratio_model(hist)
        if not model:
            self.skipTest("committed nse_pnl has no two actual quarters with a revenue split")
        txn = 3500.0
        py = nse.compute_predicted_quarters({"transaction_rev_extrapolated": txn}, hist,
                                            [{"quarter": "Q3 FY 2027", "days": 11, "total_rev": 620.0}])["Q3 FY 2027"]
        # 11 sessions banked (₹620 Cr), 51 left at a daily rate that lands the quarter on `txn`
        rest_adr = (txn - 620.0) / 51
        ctx = {"segs": ["opt", "fut", "cash"], "n": 11, "banked": {"opt": 500.0, "fut": 40.0, "cash": 80.0}}
        v = {"opt": rest_adr * 0.8, "fut": rest_adr * 0.05, "cash": rest_adr * 0.15, "days": 62,
             "oor": model["other_operating_revenue_ratio"] * 100, "oi": model["non_operating_income_ratio"] * 100,
             "opex": model["operating_expense_ratio"] * 100, "dep": model["depreciation_ratio"] * 100,
             "assoc": model["share_profit_associates"], "tax": model["tax_rate"] * 100,
             "shares": 1 / model["eps_per_pat"]}
        js = js_eval(PREDICTOR_JS, "predictorScenario('nse', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        self.assertAlmostEqual(js["txn"], txn, places=6)
        pairs = {"op": "operating_revenue", "oi": "non_operating_income", "total": "total_revenue",
                 "opx": "operating_expenses", "ebitda": "operating_ebitda", "dep": "depreciation",
                 "pbt": "pbt", "tax": "income_tax", "pat": "pat", "eps": "eps"}
        for k, pk in pairs.items():
            with self.subTest(line=k):
                self.assertAlmostEqual(js[k], py[pk], delta=0.011)

    def test_nse_other_txn_charges_mirror(self):
        # MF, currency and NSEIX charges per session (pipeline nse_other_txn_charges)
        hist = _nse_pnl()
        model = nse.nse_ratio_model(hist)
        if not model:
            self.skipTest("committed nse_pnl has no two actual quarters with a revenue split")
        seg_txn, otx = 3500.0, 0.74
        py = nse.compute_predicted_quarters({"transaction_rev_extrapolated": seg_txn + otx * 62, "other_txn_rev": otx * 62},
                                            hist, [{"quarter": "Q3 FY 2027", "days": 11, "total_rev": 620.0}])["Q3 FY 2027"]
        rest_adr = (seg_txn - 620.0) / 51
        ctx = {"segs": ["opt", "fut", "cash"], "n": 11, "banked": {"opt": 500.0, "fut": 40.0, "cash": 80.0}}
        v = {"opt": rest_adr * 0.8, "fut": rest_adr * 0.05, "cash": rest_adr * 0.15, "days": 62, "otx": otx,
             "oor": model["other_operating_revenue_ratio"] * 100, "oi": model["non_operating_income_ratio"] * 100,
             "opex": model["operating_expense_ratio"] * 100, "dep": model["depreciation_ratio"] * 100,
             "assoc": model["share_profit_associates"], "tax": model["tax_rate"] * 100,
             "shares": 1 / model["eps_per_pat"]}
        js = js_eval(PREDICTOR_JS, "predictorScenario('nse', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        self.assertAlmostEqual(js["txn"], py["segments_rev"], delta=0.011)
        self.assertAlmostEqual(js["otx"], py["other_txn_rev"], delta=0.011)
        self.assertAlmostEqual(js["txnRep"], py["transaction_rev"], delta=0.011)
        for k, pk in {"op": "operating_revenue", "oi": "non_operating_income", "pbt": "pbt", "pat": "pat", "eps": "eps"}.items():
            with self.subTest(line=k):
                self.assertAlmostEqual(js[k], py[pk], delta=0.011)

    def test_base_rate_is_the_extrapolation(self):
        # Rest-of-quarter rate = quarter-to-date average → banked + avg × left = avg × all sessions
        ctx = {"segs": ["opt", "fut"], "n": 11, "banked": {"opt": 106.6, "fut": 23.3}}
        v = {"opt": 106.6 / 11, "fut": 23.3 / 11, "days": 62}
        js = js_eval(PREDICTOR_JS, "predictorScenario('mcx', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        self.assertAlmostEqual(js["txn"], (106.6 + 23.3) / 11 * 62, places=6)
        self.assertEqual(js["rest"], 51)
        self.assertNotIn("pat", js)   # MCX stops at revenue

    def test_bse_excel_quarterly_model(self):
        ctx = {"segs": ["opt", "fut", "cash"], "n": 11, "banked": {"opt": 253.3, "fut": 0, "cash": 15.1}}
        v = {"opt": 23.0, "fut": 0, "cash": 1.4, "days": 62, "oiQ": 472.16, "margin": 50, "shares": 40.73}
        js = js_eval(PREDICTOR_JS, "predictorScenario('bse', DATA.ctx, DATA.v)", {"ctx": ctx, "v": v})
        txn = 253.3 + 15.1 + (23.0 + 1.4) * 51
        self.assertAlmostEqual(js["total"], txn + 472.16, places=6)
        self.assertAlmostEqual(js["pat"], (txn + 472.16) * 0.5, places=6)
        self.assertAlmostEqual(js["eps"], (txn + 472.16) * 0.5 / 40.73, places=6)


VALUATION_JS = ["valuationNum", "valuationIsoDate", "VALUATION_EXCHANGES", "VALUATION_METHODS", "VALUATION_EDITABLE", "VALUATION_STORAGE_KEY",
                "valuationDefaultsFrom", "valuationSameInput", "valuationInputOk", "readValuationOverrides",
                "valuationInputsFor", "setValuationOverride", "valuationAdrPath", "valuationAdrModel",
                "valuationRegression", "valuationRatio", "valuationTriangulate", "valuationModel"]
SHARE_FIT_JS = ["computeRollingMA", "SHARE_GATE", "shareOlsStats", "shareHoldout", "shareGateReasons", "shareFitFrom",
                "computeShareModel", "shareRatioStats", "shareResidualSE"]


def js_eval_async(names, body, data=None):
    """Like js_eval, for an async function body (`return` its result)."""
    code = "\n".join(js_source(n) for n in names)
    script = (f"const DATA = {json.dumps(data)};\n{code}\n"
              f"(async () => {{ {body} }})().then(r => process.stdout.write(JSON.stringify(r)));")
    out = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)


def _valuation_inputs_file():
    return json.loads((ROOT / "dashboard" / "data" / "valuation_inputs.json").read_text())


@unittest.skipUnless(NODE, "node not installed")
class ValuationGoldenNumbers(unittest.TestCase):
    """The workbook's Valuation Inputs sheet on 16 Nov 2026 (20261027_Exchanges_Dashboard.xlsx), through the
    functions both valuation tabs use. Only the regression's Bear / Bull differ from the workbook (its ±10 % /
    ±15 % of ADR became ∓ the fit's standard error), so those are checked against the SE, not the sheet."""

    # Per exchange: the data context (current quarter Q3 FY27) and the workbook's share count
    CTX = {
        "bse": {"start": {"q": 3, "fy": 2027}, "qAdr": 24.04403842241379, "adr45": 21.209128133333333,
                "fit": {"intercept": 1021.435, "slope": 129.8708, "se": 300.0},
                "ratio": {"mean": 207.7025, "sd": 32.5025}, "shares": 40.7884},
        "mcx": {"start": {"q": 3, "fy": 2027}, "qAdr": 12.990660073806458, "adr45": 13.250145474008885,
                "fit": {"intercept": 409.2378, "slope": 211.1479, "se": 250.0},
                "ratio": {"mean": 269.5959, "sd": 40.8922}, "shares": 25.4514},
        "nse": {"start": {"q": 3, "fy": 2027}, "qAdr": 65.17492719186208, "adr45": 59.4777,
                "fit": None, "ratio": None, "shares": 247.5},
    }

    def model(self, ex, overrides=None):
        expr = """(() => {
          const d = valuationDefaultsFrom(DATA.file);
          const { v } = valuationInputsFor(d, DATA.o, DATA.ex);
          return { v, m: valuationModel(DATA.c, v, DATA.c.shares) };
        })()"""
        return js_eval(VALUATION_JS, expr, {"ex": ex, "c": self.CTX[ex], "o": overrides or {}, "file": _valuation_inputs_file()})

    def close(self, got, want, delta=0.01):
        for i, (g, w) in enumerate(zip(got, want)):
            with self.subTest(i=i):
                self.assertAlmostEqual(g, w, delta=delta)

    def test_bse(self):
        r = self.model("bse")
        m = r["m"]
        self.close([p["adr"] for p in m["path"]["path"]], [24.04403842, 25.2462, 26.5086, 27.8340, 29.2257, 30.6870], 0.0001)
        self.assertEqual([p["label"] for p in m["path"]["path"]], ["Q3 FY27", "Q4 FY27", "Q1 FY28", "Q2 FY28", "Q3 FY28", "Q4 FY28"])
        a = m["adrModel"]
        self.assertAlmostEqual(a["adrFY"], 28.5637935609276, places=9)
        self.assertAlmostEqual(a["total"], 9418.9552, delta=0.0001)
        self.assertAlmostEqual(a["eps"], 117.7704, delta=0.0001)
        self.close(a["fwd"], [4710.82, 5299.67, 5888.52])
        self.close(a["now"], [3662.584193770785, 4120.407217992134, 4578.230242213482])
        # Estimate 24: the sheet's rows C29:F31 (regression base only)
        est = m["est"]
        self.assertEqual(est["adr"], 24)
        self.assertAlmostEqual(est["vals"]["reg"][1], 4138.333464120598, delta=0.01)
        self.close(est["vals"]["ratio"], [4204.800373273975, 4984.860064430118, 5764.91975558626])
        self.close(est["vals"]["adr"], a["now"], 1e-9)
        self.assertAlmostEqual(est["avg"][1], 4214.9193133937415, delta=0.01)   # E32
        # 45 DMA 21.2091
        dma = m["dma"]
        self.assertAlmostEqual(dma["vals"]["reg"][1], 3775.88, delta=0.01)
        self.close(dma["vals"]["ratio"], [3715.84, 4405.19, 5094.54])
        self.assertAlmostEqual(dma["avg"][1], 3993.8485000809187, delta=0.01)   # E33
        self.assertEqual(dma["used"], ["reg", "ratio", "adr"])
        self.assertEqual((dma["dropped"], dma["wTotal"]), ([], 100))

    def test_mcx(self):
        m = self.model("mcx")["m"]
        a = m["adrModel"]
        self.assertAlmostEqual(a["adrFY"], 16.508825517190388, places=9)
        self.assertAlmostEqual(a["oi"], 291.2605 + 175.329, places=9)
        self.close(a["now"], [3373.803705375013, 3785.2431816402586, 4196.682657905504])
        self.assertAlmostEqual(m["est"]["vals"]["reg"][1], 3365.3088401338523, delta=0.01)
        self.close(m["est"]["vals"]["ratio"], [3201.8517549597004, 3774.343242046283, 4346.8347291328655])
        self.assertAlmostEqual(m["est"]["avg"][1], 3696.8963375013877, delta=0.01)   # E39
        self.assertAlmostEqual(m["dma"]["vals"]["reg"][1], 3206.98, delta=0.01)
        self.close(m["dma"]["vals"]["ratio"], [3030.36, 3572.19, 4114.01])
        self.assertAlmostEqual(m["dma"]["avg"][1], 3584.3671954182473, delta=0.01)   # E40

    def test_nse_is_the_adr_model_alone(self):
        r = self.model("nse")
        m, v = r["m"], r["v"]
        a = m["adrModel"]
        self.assertIsNone(v["adr"])   # the sheet's "n/a": the estimate model takes the 45 DMA
        self.assertTrue(m["estIsDma"])
        self.assertEqual(m["est"]["adr"], self.CTX["nse"]["adr45"])
        self.assertAlmostEqual(a["adrFY"], 77.42639289419103, places=9)
        self.assertAlmostEqual(a["total"], 25656.999044865184, delta=0.001)
        self.assertAlmostEqual(a["eps"], 60.125492711199215, delta=1e-6)
        self.close(a["now"], [1963.3577156510391, 2197.0907770380677, 2430.8238384250967])
        for t in (m["dma"], m["est"]):
            self.assertEqual((t["used"], t["dropped"]), (["adr"], []))   # weights 0 / 0 / 100: nothing rescaled
            self.close(t["avg"], a["now"], 1e-9)

    def test_regression_bear_bull_are_the_standard_error(self):
        m = self.model("bse")["m"]
        fit = self.CTX["bse"]["fit"]
        for t in (m["dma"], m["est"]):
            reg = t["vals"]["reg"]
            base = fit["intercept"] + fit["slope"] * t["adr"]
            self.close(reg, [base - 300, base, base + 300], 1e-9)
            # the same as moving the ADR by ∓ SE ÷ slope
            self.assertAlmostEqual(reg[2], fit["intercept"] + fit["slope"] * (t["adr"] + 300 / fit["slope"]), places=6)

    def test_edits_move_only_their_methods(self):
        """The ADR estimate moves Regression and Ratio in the estimate model only; QoQ growth and P/E the ADR model."""
        base = self.model("bse")["m"]
        est = self.model("bse", {"bse": {"adr": 26}})["m"]
        self.assertEqual(est["dma"], base["dma"])
        self.assertEqual(est["adrModel"], base["adrModel"])
        self.assertAlmostEqual(est["est"]["vals"]["reg"][1], 1021.435 + 129.8708 * 26, places=6)
        grown = self.model("bse", {"bse": {"g": 6, "pe1": 50}})["m"]
        self.assertGreater(grown["adrModel"]["adrFY"], base["adrModel"]["adrFY"])
        self.assertAlmostEqual(grown["adrModel"]["fwd"][1], grown["adrModel"]["eps"] * 50, places=6)
        self.assertEqual(grown["dma"]["vals"]["reg"], base["dma"]["vals"]["reg"])


@unittest.skipUnless(NODE, "node not installed")
class ValuationWeights(unittest.TestCase):
    VALS = {"reg": [3000, 3500, 4000], "ratio": [3800, 4400, 5000], "adr": [3600, 4100, 4600]}

    def tri(self, vals, w):
        return js_eval(VALUATION_JS, "valuationTriangulate(DATA.vals, DATA.w)", {"vals": vals, "w": w})

    def test_weighted_average(self):
        t = self.tri(self.VALS, [45, 10, 45])
        self.assertAlmostEqual(t["avg"][1], 0.45 * 3500 + 0.10 * 4400 + 0.45 * 4100, places=9)
        self.assertEqual((t["wUsed"], t["wTotal"], t["dropped"]), (100, 100, []))

    def test_missing_method_is_dropped_and_weights_rescaled(self):
        t = self.tri({**self.VALS, "reg": None}, [45, 10, 45])
        self.assertEqual((t["used"], t["dropped"], t["wUsed"]), (["ratio", "adr"], ["reg"], 55))
        for i in range(3):
            self.assertAlmostEqual(t["avg"][i], (10 * self.VALS["ratio"][i] + 45 * self.VALS["adr"][i]) / 55, places=9)
        # A zero-weighted method without a value is not "dropped": nothing to rescale
        nse = self.tri({"reg": None, "ratio": None, "adr": self.VALS["adr"]}, [0, 0, 100])
        self.assertEqual((nse["dropped"], nse["avg"]), ([], self.VALS["adr"]))
        self.assertIsNone(self.tri({"reg": None, "ratio": None, "adr": None}, [45, 10, 45])["avg"])

    def test_weights_not_adding_to_100_are_rescaled(self):
        # One rule: Σ weight × value ÷ Σ weight over the methods with a value, so weights of
        # 40/10/40 give the same scale as 44.4/11.1/44.4, and a method dropping out later
        # does not move the scale either
        t = self.tri(self.VALS, [40, 10, 40])
        self.assertEqual((t["wTotal"], t["wUsed"]), (90, 90))
        self.assertAlmostEqual(t["avg"][1], (40 * 3500 + 10 * 4400 + 40 * 4100) / 90, places=9)
        dropped = self.tri({**self.VALS, "reg": None}, [40, 10, 40])
        self.assertAlmostEqual(dropped["avg"][1], (10 * 4400 + 40 * 4100) / 50, places=9)
        self.assertNotIn("share", t)

    def test_unusable_inputs_are_ignored(self):
        defaults = {"ex": {"bse": {"adr": 24, "g": 5, "pe0": 40, "pe1": 45, "pe2": 50, "w0": 45, "w1": 10, "w2": 45}}}
        bad = {"bse": {"adr": -3, "g": -100, "pe0": 0, "pe1": -45, "w0": -5, "w1": "x", "w2": 60}}
        got = js_eval(VALUATION_JS, "valuationInputsFor(DATA.d, DATA.o, 'bse')", {"d": defaults, "o": bad})
        self.assertEqual(got["edited"], ["w2"])
        self.assertEqual(got["v"]["w2"], 60)
        self.assertEqual((got["v"]["adr"], got["v"]["g"], got["v"]["pe0"], got["v"]["w0"]), (24, 5, 40, 45))


@unittest.skipUnless(NODE, "node not installed")
class ValuationInputs(unittest.TestCase):
    """Shared defaults (dashboard/data/valuation_inputs.json, the only copy) under this browser's edits."""

    def test_file_parses(self):
        parsed = js_eval(VALUATION_JS, "valuationDefaultsFrom(DATA)", _valuation_inputs_file())
        self.assertEqual(parsed["fy"], 2028)
        self.assertEqual(parsed["ex"]["bse"], {"adr": 24, "g": 5, "pe0": 40, "pe1": 45, "pe2": 50, "w0": 45, "w1": 10,
                                               "w2": 45, "from": "2025-01-01", "oi": 2363.6982, "margin": 51, "days": 247,
                                               "d1": 18, "d2": 9})
        # Regression data from: BSE 1 Jan 2025, MCX 1 Nov 2024, NSE all data
        self.assertEqual([parsed["ex"][ex]["from"] for ex in ("bse", "mcx", "nse")], ["2025-01-01", "2024-11-01", None])
        self.assertEqual((parsed["ex"]["mcx"]["oi"], parsed["ex"]["nse"]["oi"]), (466.5895, 6532.68))   # ₹467 / 6,533 Cr
        self.assertIsNone(parsed["ex"]["nse"]["adr"])
        for ex, w in parsed["ex"].items():
            with self.subTest(ex=ex):
                self.assertEqual(w["w0"] + w["w1"] + w["w2"], 100)

    def test_unusable_file_is_rejected(self):
        f = _valuation_inputs_file()
        broken = json.loads(json.dumps(f))
        broken["exchanges"]["mcx"]["fixed"]["sessions"] = "258"
        no_ex = {k: v for k, v in f.items() if k != "exchanges"}
        bad_date = json.loads(json.dumps(f))
        bad_date["exchanges"]["bse"]["editable"]["regression_from"] = "2025-02-30"
        num_date = json.loads(json.dumps(f))
        num_date["exchanges"]["mcx"]["editable"]["regression_from"] = 20250101   # a number, not a date
        got = js_eval(VALUATION_JS, "[valuationDefaultsFrom(DATA[0]), valuationDefaultsFrom(DATA[1]), valuationDefaultsFrom(DATA[2]),"
                                    " valuationDefaultsFrom(DATA[3]), valuationDefaultsFrom(null)]", [broken, no_ex, bad_date, num_date])
        self.assertEqual(got, [None, None, None, None, None])

    def test_saved_edits_override_the_defaults(self):
        expr = """(() => {
          const store = { valuation_inputs_v1: JSON.stringify({
            bse: { pe1: 48, adr: null, w0: 'x', days: 300 },    // a bad value and a fixed key are ignored
            mcx: { g: 7, adr: -3 },                              // equal to the default; a non-positive ADR
          }) };
          globalThis.localStorage = { getItem: k => (k in store ? store[k] : null) };
          const d = valuationDefaultsFrom(DATA.file);
          const o = readValuationOverrides();
          const out = { bse: valuationInputsFor(d, o, 'bse'), mcx: valuationInputsFor(d, o, 'mcx'), nse: valuationInputsFor(d, o, 'nse') };
          // Typing the default back removes the edit; a new value adds one
          const o2 = setValuationOverride(setValuationOverride(o, d, 'bse', 'pe1', 45), d, 'nse', 'adr', 70);
          store.valuation_inputs_v1 = '{not json';
          const unreadable = readValuationOverrides();
          globalThis.localStorage = { getItem() { throw new Error('blocked'); } };
          return { ...out, o2, unreadable, blocked: readValuationOverrides() };
        })()"""
        got = js_eval(VALUATION_JS, expr, {"file": _valuation_inputs_file()})
        bse, mcx, nse = got["bse"], got["mcx"], got["nse"]
        self.assertEqual((bse["v"]["pe1"], bse["v"]["adr"], bse["v"]["w0"], bse["v"]["days"]), (48, None, 45, 247))
        self.assertEqual(bse["edited"], ["adr", "pe1"])
        self.assertEqual((mcx["v"]["g"], mcx["v"]["adr"], mcx["edited"]), (7, 14, []))
        self.assertEqual(nse["edited"], [])
        self.assertEqual(got["o2"]["bse"], {"adr": None, "w0": "x", "days": 300})
        self.assertEqual(got["o2"]["nse"], {"adr": 70})
        self.assertEqual((got["unreadable"], got["blocked"]), ({}, {}))

    def test_defaults_report_a_failed_file(self):
        names = VALUATION_JS + ["loadValuationDefaults"]
        body = """
          globalThis.VALUATION_DEFAULTS_CACHE = null;   // a `let` in the dashboard
          const out = {};
          globalThis.fetchDataFile = async () => { throw new Error('./data/valuation_inputs.json: HTTP 404'); };
          out.failed = await loadValuationDefaults();
          globalThis.fetchDataFile = async () => ({ json: { fy: 2028 } });
          out.bad = await loadValuationDefaults();
          globalThis.fetchDataFile = async () => ({ json: DATA });
          out.ok = await loadValuationDefaults();
          globalThis.fetchDataFile = async () => { throw new Error('not fetched again'); };
          out.cached = await loadValuationDefaults();
          return out;"""
        got = js_eval_async(names, body, _valuation_inputs_file())
        self.assertEqual(got["failed"], {"error": "./data/valuation_inputs.json: HTTP 404"})   # no built-in copy
        self.assertEqual(got["bad"], {"error": "a value is missing or not a number"})
        self.assertIsNone(got["ok"]["error"])
        self.assertEqual(got["ok"]["ex"]["bse"]["pe1"], 45)
        self.assertEqual(got["cached"], got["ok"])   # a loaded file is kept; a failure is retried


@unittest.skipUnless(NODE, "node not installed")
class ValuationData(unittest.TestCase):
    """What the model reads from the daily rows and the share file."""

    def test_residual_standard_error(self):
        rows = [{"date": f"2026-01-{d:02d}", "rev_ma": x, "price": p, "in_fit": f}
                for d, x, p, f in ((5, 10, 1100, False), (6, 10, 1010, True), (7, 20, 1190, True),
                                   (8, 30, 1420, True), (9, 40, 1580, True), (12, 50, 1500, False))]
        fit = {"intercept": 1000.0, "slope": 15.0}
        got = js_eval(SHARE_FIT_JS, "[shareResidualSE(DATA.r, DATA.f, '2026-01-01'), shareResidualSE(DATA.r.slice(0, 3), DATA.f),"
                                    " shareResidualSE(DATA.r, null)]", {"r": rows, "f": fit})
        resid = [1010 - 1150, 1190 - 1300, 1420 - 1450, 1580 - 1600]   # in-fit rows only
        self.assertAlmostEqual(got[0]["se"], (sum(e * e for e in resid) / (4 - 2)) ** 0.5, places=9)
        self.assertEqual(got[0]["n"], 4)
        self.assertIsNone(got[1])   # two fit rows: no standard error
        self.assertIsNone(got[2])

    def test_context_from_the_daily_rows(self):
        rows = [{"date": f"2026-09-{d:02d}", "fy_quarter": "Q2 FY 2027", "total_rev": 10.0} for d in range(1, 21)]
        rows += [{"date": f"2026-10-{d:02d}", "fy_quarter": "Q3 FY 2027", "total_rev": 20.0 + d} for d in range(1, 31)]
        share = {"regression": {"slope": 1, "intercept": 1}, "status": "collecting", "n_days": 35,
                 "min_days_required": 60, "regression_start": "2026-09-24", "ticker": "NSE.BO",
                 "latest": {"date": "2026-10-30", "price_actual": 2000.0}}
        names = SHARE_FIT_JS + VALUATION_JS + ["parseFYQuarter", "SEG_PRODUCT", "NO_FLAGS", "periodFlags", "mergeFlags",
                                               "rowsFlags", "valuationFitFields", "valuationContextFor"]
        got = js_eval(names, "[valuationContextFor({ daily_all: DATA.rows.slice().reverse() }, DATA.share),"
                             " valuationContextFor({ daily_all: DATA.rows }, null), valuationContextFor({ daily_all: [] }, null),"
                             " valuationFitFields(DATA.share, '2026-10-01').win.fromIgnored]",
                      {"rows": rows, "share": share})
        c, no_share, empty, ignored = got
        # A data-from date set while the share file is collecting is reported, not dropped silently
        self.assertEqual((c["win"]["fromIgnored"], ignored), ("", "collecting"))
        self.assertEqual((c["start"], c["qN"], c["lastDate"]), ({"q": 3, "fy": 2027}, 30, "2026-10-30"))
        self.assertAlmostEqual(c["qAdr"], sum(20 + d for d in range(1, 31)) / 30, places=9)
        self.assertAlmostEqual(c["adr45"], (15 * 10 + sum(20 + d for d in range(1, 31))) / 45, places=9)
        self.assertEqual((c["fit"], c["ratio"], c["cmp"]), (None, None, 2000.0))
        self.assertEqual((c["fitWhy"], c["ratioWhy"]), ("35 of 60 sessions collected since listing",) * 2)
        self.assertEqual((no_share["fitWhy"], no_share["ratioWhy"]), ("no share-price file",) * 2)
        self.assertIsNone(empty)

    def test_excel_block_cells(self):
        expr = """(() => {
          const d = valuationDefaultsFrom(DATA.file).ex.bse;
          const a = valuationAdrModel(d, 28.5637935609276, 40.7884);
          return { rows: valuationExcelRows(2028, d.d1, d.d2).map(r => r.label), cells: valuationExcelCells(a, d, 3920) };
        })()"""
        got = js_eval(VALUATION_JS + ["fmtNum", "rxSignedPct", "valuationExcelRows", "valuationExcelCells"], expr, {"file": _valuation_inputs_file()})
        self.assertEqual(got["rows"], ["ADR FY 28", "Other Income", "Total Income", "PAT Margin", "EPS", "PE",
                                       "Price Target FY 28", "Upside", "Discount 18 %", "Target Price FY 27",
                                       "Discount 9 %", "Target Price Current"])
        c = got["cells"]
        self.assertEqual((c["adrFY"][0], c["oi"][0], c["total"][0], c["margin"][0], c["eps"][0]),
                         ("28.56", "2,364", "9,419", "51 %", "117.77"))
        self.assertEqual(c["fwd"], ["4,711", "5,300", "5,889"])
        self.assertEqual(c["up"], ["+20 %", "+35 %", "+50 %"])   # FY28 targets vs CMP 3,920
        self.assertEqual((c["d1"][1], c["d2"][1]), ("÷ 1.18", "÷ 1.09"))
        self.assertEqual(c["now"], ["3,663", "4,120", "4,578"])



def _share_file(ex):
    return json.loads((ROOT / "dashboard" / "data" / f"{ex}_share_analysis.json").read_text())


def _ols(xs, ys):
    n = len(xs)
    xm, ym = sum(xs) / n, sum(ys) / n
    sxy = sum((x - xm) * (y - ym) for x, y in zip(xs, ys))
    sxx = sum((x - xm) ** 2 for x in xs)
    slope = sxy / sxx
    return slope, ym - slope * xm


def _excel_window(share, frm, w=45):
    """The workbook's data set from `frm`, worked out independently: revenue and prices from
    `frm`, the w-session MA over that revenue only, each close paired with the MA up to the
    previous revenue session, sessions whose MA includes modelled revenue left out."""
    rev = [r for r in share["revenue_daily"] if r["date"] >= frm]
    pts = []
    for p in share["series"]:
        if p["date"] < frm:
            continue
        idx = sum(1 for r in rev if r["date"] < p["date"]) - 1
        if idx < w - 1:
            continue
        window = rev[idx - w + 1:idx + 1]
        if any(r.get("modelled") for r in window):
            continue
        pts.append((p["date"], sum(r["revenue_cr"] for r in window) / w, p["price"]))
    return pts


VALUATION_FIT_JS = SHARE_FIT_JS + VALUATION_JS + ["valuationFitFields", "valuationFitted", "rxDate", "fmtNum",
                                                  "valuationWindowText", "valuationWindowNote"]


@unittest.skipUnless(NODE, "node not installed")
class ValuationDataFrom(unittest.TestCase):
    """The valuation's regression re-fitted from each exchange's "Regression data from" date, as the
    workbook does: the data set starts on that date and the 45 DMA is built only from it."""

    @staticmethod
    def synthetic():
        # 200 calendar days of revenue: the first 60 at a level far from the rest, so an MA that
        # reached back before `from` would differ; prices follow the MA with a deterministic wobble
        import datetime
        d0 = datetime.date(2025, 1, 1)
        dates = [(d0 + datetime.timedelta(days=i)).isoformat() for i in range(200)]
        rev = [{"date": d, "revenue_cr": (50.0 if i < 60 else 10 + 0.08 * i + (i % 7) * 0.3)} for i, d in enumerate(dates)]
        series = []
        for i, d in enumerate(dates):
            if i < 45:
                continue
            ma = sum(r["revenue_cr"] for r in rev[i - 45:i]) / 45
            series.append({"date": d, "price": round(300 + 120 * ma + ((i * 37) % 11 - 5) * 8, 2)})
        return {"ticker": "TEST.NS", "ma_window": 45, "regression_start": "2025-01-01", "regression": {"slope": 1},
                "revenue_daily": rev, "series": series, "latest": {"date": dates[-1], "price_actual": series[-1]["price"]}}

    def test_from_restricts_the_ma_to_the_data_set(self):
        share = self.synthetic()
        frm = "2025-03-02"   # day 60: the level change
        got = js_eval(VALUATION_FIT_JS, "[valuationFitFields(DATA, '2025-03-02'), valuationFitFields(DATA, null)]", share)
        f, pub = got
        pts = _excel_window(share, frm)
        rev = [r["date"] for r in share["revenue_daily"] if r["date"] >= frm]
        # First point: the close after the 45th session from `from` (previous-session pairing)
        self.assertEqual(f["win"]["firstPoint"], pts[0][0])
        self.assertEqual(pts[0][0], rev[45])
        self.assertEqual((f["win"]["from"], f["win"]["fitStart"], f["win"]["n"]), (frm, frm, len(pts)))
        slope, intercept = _ols([x for _, x, _ in pts], [y for _, _, y in pts])
        self.assertIsNotNone(f["fit"], f["fitWhy"])
        self.assertEqual(f["fit"]["n"], len(pts))
        self.assertAlmostEqual(f["fit"]["slope"], slope, places=6)
        self.assertAlmostEqual(f["fit"]["intercept"], intercept, places=6)
        se = (sum((y - intercept - slope * x) ** 2 for _, x, y in pts) / (len(pts) - 2)) ** 0.5
        self.assertAlmostEqual(f["fit"]["se"], se, places=6)
        ratios = [y / x for _, x, y in pts]
        mean = sum(ratios) / len(ratios)
        self.assertAlmostEqual(f["ratio"]["mean"], mean, places=9)
        self.assertAlmostEqual(f["ratio"]["sd"], (sum((r - mean) ** 2 for r in ratios) / len(ratios)) ** 0.5, places=9)
        # The published path (MA over every revenue day) is a different fit with more sessions
        self.assertGreater(pub["win"]["n"], f["win"]["n"])
        self.assertNotAlmostEqual(pub["fit"]["slope"], f["fit"]["slope"], places=3)
        self.assertEqual((f["win"]["pubStart"], f["win"]["pubN"]), ("2025-01-01", pub["win"]["n"]))

    def test_null_is_the_published_fit(self):
        share = self.synthetic()
        expr = """(() => {
          const m = computeShareModel(DATA, 45);
          const se = shareResidualSE(m.series, m.reg, DATA.regression_start);
          const c = { share: DATA };
          return { f: valuationFitFields(DATA, null), same: valuationFitted(c, null) === c,
                   want: { intercept: m.reg.intercept, slope: m.reg.slope, se: se.se, n: se.n, r2: m.reg.r_squared },
                   ratio: shareRatioStats(m.series, DATA.regression_start) };
        })()"""
        got = js_eval(VALUATION_FIT_JS, expr, share)
        self.assertEqual(got["f"]["fit"], got["want"])
        self.assertEqual(got["f"]["ratio"], got["ratio"])
        self.assertEqual((got["f"]["win"]["from"], got["f"]["win"]["fitStart"]), (None, "2025-01-01"))
        self.assertTrue(got["same"])

    def test_gate_still_decides(self):
        # From late in the file: too few sessions for a fair value, so Regression has none and says why
        share = self.synthetic()
        got = js_eval(VALUATION_FIT_JS, "[valuationFitFields(DATA, '2025-05-01'), valuationFitFields(DATA, '2025-07-10')]", share)
        short, none = got
        self.assertIsNone(short["fit"])
        self.assertIn("observations (needs 60)", short["fitWhy"])
        self.assertIsNotNone(short["ratio"])
        self.assertIsNone(none["fit"])
        self.assertIsNone(none["ratio"])
        self.assertIn("fewer than 10 sessions", none["fitWhy"])

    def test_real_files(self):
        """BSE from 1 Jan 2025: first point 5 Mar 2025 (419 sessions on the file of 13 Nov 2026);
        MCX from 1 Nov 2024: early Jan 2025, none modelled; MCX from Jun 2024 leaves modelled MAs out."""
        bse, mcx = _share_file("bse"), _share_file("mcx")
        expr = """(() => {
          const pick = f => ({ fit: f.fit, why: f.fitWhy, win: f.win, ratio: f.ratio, text: valuationWindowText(f.win), note: valuationWindowNote(f.win) });
          return [pick(valuationFitFields(DATA.bse, '2025-01-01')), pick(valuationFitFields(DATA.mcx, '2024-11-01')),
                  pick(valuationFitFields(DATA.mcx, '2024-06-01'))];
        })()"""
        b, m, early = js_eval(VALUATION_FIT_JS, expr, {"bse": bse, "mcx": mcx})
        pts = _excel_window(bse, "2025-01-01")
        self.assertEqual(b["win"]["firstPoint"], "2025-03-05")
        self.assertEqual(b["win"]["n"], len(pts))
        if bse["latest"]["date"] == "2026-11-13":
            self.assertEqual(b["win"]["n"], 419)
        self.assertEqual(b["text"], f"data from 1 Jan 2025 · first point 5 Mar 2025 · {len(pts)} sessions")
        if b["fit"]:
            slope, intercept = _ols([x for _, x, _ in pts], [y for _, _, y in pts])
            self.assertAlmostEqual(b["fit"]["slope"], slope, places=6)
            self.assertAlmostEqual(b["fit"]["intercept"], intercept, places=4)
        self.assertTrue("2025-01-01" <= m["win"]["firstPoint"] <= "2025-01-10", m["win"]["firstPoint"])
        self.assertEqual((m["win"]["n"], m["win"]["modelledOut"], m["note"]), (len(_excel_window(mcx, "2024-11-01")), 0, ""))
        # Modelled MCX revenue (before 2 Sep 2024) stays out of the fit, and the note says so
        pts_e = _excel_window(mcx, "2024-06-01")
        self.assertEqual(early["win"]["n"], len(pts_e))
        self.assertGreater(early["win"]["modelledOut"], 0)
        self.assertEqual(early["win"]["modelledTo"], "2024-08-30")
        self.assertIn("modelled revenue", early["note"])
        self.assertGreater(early["win"]["firstPoint"], "2024-09-01")

    def test_date_input_validation(self):
        expr = """[
          ['2025-01-01', null, '2026-11-13', '2027-01-01', '2025-02-30', '2025-1-1', 'garbage', 20250101, '', undefined,
           '0002-01-01', '0202-01-01', '1899-12-31']   // years part typed into a date input
            .map(x => valuationInputOk('from', x, '2026-11-13')),
          valuationInputOk('from', '2027-01-01'),
          valuationInputsFor(DATA.d, DATA.o, 'bse', '2026-11-13'), valuationInputsFor(DATA.d, DATA.o, 'mcx', '2026-11-13'),
          valuationInputsFor(DATA.d, DATA.o, 'nse', '2026-11-13'),
        ]"""
        defaults = {"ex": {ex: {"adr": None, "g": 5, "pe0": 40, "pe1": 45, "pe2": 50, "w0": 45, "w1": 10, "w2": 45, "from": f}
                           for ex, f in (("bse", "2025-01-01"), ("mcx", "2024-11-01"), ("nse", None))}}
        saved = {"bse": {"from": "2025-02-30"}, "mcx": {"from": "2024-06-03"}, "nse": {"from": "2027-01-01"}}
        ok, no_latest, bse, mcx, nse = js_eval(VALUATION_JS, expr, {"d": defaults, "o": saved})
        self.assertEqual(ok, [True, True, True, False, False, False, False, False, False, False, False, False, False])
        self.assertTrue(no_latest)
        self.assertEqual((bse["v"]["from"], bse["edited"]), ("2025-01-01", []))   # not a date: ignored
        self.assertEqual((mcx["v"]["from"], mcx["edited"]), ("2024-06-03", ["from"]))
        self.assertEqual((nse["v"]["from"], nse["edited"]), (None, []))            # after the latest data: ignored
        # Clearing a date is an edit (all data); typing the default back removes it
        got = js_eval(VALUATION_JS, """(() => {
          const o = setValuationOverride({}, DATA, 'bse', 'from', null);
          return [o, setValuationOverride(o, DATA, 'bse', 'from', '2025-01-01'), valuationInputsFor(DATA, o, 'bse')];
        })()""", defaults)
        self.assertEqual(got[0], {"bse": {"from": None}})
        self.assertEqual(got[1], {})
        self.assertEqual((got[2]["v"]["from"], got[2]["edited"]), (None, ["from"]))

def _day(eod, revs, preds=None):
    cps = {}
    for i, label in enumerate(["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"]):
        cps[label] = {"revenue": revs[i], "fraction": revs[i] / eod}
        if preds and label in preds:
            cps[label]["predicted_eod"] = preds[label]
    return {"date": "2026-10-15", "day_type": "normal", "eod_revenue": eod, "checkpoints": cps}


@unittest.skipUnless(NODE, "node not installed")
class LiveArchiveScoring(unittest.TestCase):
    DAY = _day(50.0, [10, 18, 25, 31, 38, 45, 50], {"12:00": 55.0})

    def test_fraction_interpolates_between_checkpoints(self):
        js = js_eval(LIVE_JS, "[dayFractionAt(DATA, 0), dayFractionAt(DATA, 75), dayFractionAt(DATA, 405)]", self.DAY)
        self.assertEqual(js[0], 0)
        self.assertAlmostEqual(js[1], (10 + 8 * 30 / 60) / 50, places=9)   # halfway 10:00 → 11:00
        self.assertEqual(js[2], 1)

    def test_missing_checkpoint_gives_no_fraction(self):
        d = json.loads(json.dumps(self.DAY))
        d["checkpoints"]["13:00"]["fraction"] = None
        self.assertIsNone(js_eval(LIVE_JS, "dayFractionAt(DATA, 300)", d))

    def test_model_and_share_of_day_errors(self):
        others = [_day(40.0, [8, 15, 20, 25, 30, 36, 40]), _day(60.0, [12, 21, 30, 37, 45, 54, 60])]
        js = js_eval(LIVE_JS, "[liveModelError(DATA.d, '12:00'), liveModelError(DATA.d, '14:00'), shareOfDayError(DATA.d, '12:00', DATA.o)]",
                     {"d": self.DAY, "o": others})
        self.assertAlmostEqual(js[0], 55 / 50 - 1, places=9)
        self.assertIsNone(js[1])                                      # no prediction recorded at 14:00
        self.assertAlmostEqual(js[2], (25 / 0.5) / 50 - 1, places=9)  # both others at 50 % by 12:00

    def test_session_progress_stops_at_the_close(self):
        got = js_eval(LIVE_JS + ["fmtElapsed", "fmtSessionProgress"],
                      "[fmtSessionProgress(305), fmtSessionProgress(405), fmtSessionProgress(435)]")
        self.assertEqual(got, ["5h 5m of 6h 45m", "full session (6h 45m)", "full session (6h 45m)"])

    def test_revenue_between_polls(self):
        polls = [{"elapsed_minutes": 30, "total_revenue": 6}, {"elapsed_minutes": 90, "total_revenue": 18}]
        js = js_eval(LIVE_JS, "[revenueAt(DATA, 15), revenueAt(DATA, 60), revenueAt(DATA, 120)]", polls)
        self.assertEqual(js, [3, 12, None])


def _path_day(frac_14, day_type="normal", date="2026-10-15"):
    """Archived day closing at 100 that had reached `frac_14` of it by 14:00 (285 min)."""
    d = _day(100.0, [5, 10, 15, 20, frac_14 * 100, 95, 100])
    d.update(day_type=day_type, date=date)
    return d


@unittest.skipUnless(NODE, "node not installed")
class LiveCards(unittest.TestCase):
    """Revenue Summary live cards: the Live Predictor's range and day pool, and the card model."""

    NORMAL = [_path_day(0.5), _path_day(0.6), _path_day(0.7)]
    EXPIRY = [_path_day(0.8, "expiry"), _path_day(0.9, "expiry")]
    POLL = {"captured_ist": "2026-10-26T14:00:00", "elapsed_minutes": 285, "total_revenue": 43.0,
            "options_revenue": 40.0, "futures_revenue": 1.0, "cash_revenue": 2.0,
            "predicted_eod": 70.0, "pred_method": "historical/normal/wd0"}
    LIVE = {"kind": "live", "isToday": True, "age": 3}
    CLOSED = {"kind": "closed", "isToday": True, "age": 200}

    def card(self, poll=None, status=None, daily=None, samples=None):
        hourly = {"date": "2026-10-26", "day_type": "normal",
                  "samples": samples if samples is not None else [{"elapsed_minutes": 0, "total_revenue": 5.0}, poll or self.POLL]}
        data = {"h": hourly, "hist": {"days": self.NORMAL + self.EXPIRY}, "daily": daily or [], "st": status or self.LIVE}
        return js_eval(LIVE_CARD_JS, "liveCardModel(DATA.h, DATA.hist, DATA.daily, DATA.st)", data)

    def test_range_is_revenue_over_share_quantiles(self):
        got = js_eval(LIVE_CARD_JS, "typicalPathRange(43, 285, DATA)", self.NORMAL + self.EXPIRY)
        # shares at 14:00: .5 .6 .7 .8 .9 → 90th pct .86, 10th pct .54
        self.assertAlmostEqual(got["lo"], 43 / 0.86, places=9)
        self.assertAlmostEqual(got["hi"], 43 / 0.54, places=9)
        # the headline estimate: revenue ÷ the median share (.7)
        self.assertAlmostEqual(got["mid"], 43 / 0.7, places=9)
        self.assertTrue(got["lo"] <= got["mid"] <= got["hi"])
        self.assertEqual(got["n"], 5)
        self.assertIsNone(js_eval(LIVE_CARD_JS, "typicalPathRange(43, 285, [])"))

    def test_day_pool_and_default_type(self):
        days = self.NORMAL + self.EXPIRY
        expr = ("[liveDayPool(DATA, 'normal').length, liveDayPool(DATA, 'expiry').length, liveDayPool(DATA, 'all').length,"
                " liveDayPool(DATA, 'normal', DATA[0]).length, liveDefaultType(DATA, 'normal'), liveDefaultType(DATA, 'expiry')]")
        # 3 normal days; 2 expiry days fall back to all 5; leaving one normal day out leaves 2, so all 4 others
        self.assertEqual(js_eval(LIVE_CARD_JS, expr, days), [3, 5, 5, 4, "normal", "all"])

    def test_live_card(self):
        c = self.card()
        lo, hi = 43 / (0.6 + 0.8 * 0.1), 43 / (0.5 + 0.2 * 0.1)   # normal days only: shares .5 .6 .7
        mid = 43 / 0.6                                              # the share-of-day estimate (median share)
        self.assertEqual((c["kind"], c["time"], c["booked"]), ("live", "14:00", 43.0))
        self.assertAlmostEqual(c["pred"], mid, places=9)
        self.assertEqual((c["predSource"], c["predModel"], c["poolType"]), ("share", 70.0, "normal"))
        self.assertEqual(c["modelMethod"], "Normal days, same weekday")
        self.assertAlmostEqual(c["range"]["lo"], lo, places=9)
        self.assertAlmostEqual(c["range"]["hi"], hi, places=9)
        self.assertEqual(c["range"]["n"], 3)
        self.assertIsNone(c["outsideRange"])
        self.assertAlmostEqual(c["pctOfClose"], 43 / mid, places=9)
        scale = max(43, mid, hi) * 1.06
        self.assertAlmostEqual(c["bar"]["fill"], 43 / scale * 100, places=9)
        self.assertAlmostEqual(c["bar"]["mark"], mid / scale * 100, places=9)
        self.assertAlmostEqual(c["bar"]["lo"], lo / scale * 100, places=9)
        self.assertEqual([s[0] for s in c["segs"]], ["Options", "Futures", "Cash"])

    def test_prediction_outside_range(self):
        self.assertEqual(self.card(dict(self.POLL, predicted_eod=90.0))["outsideRange"], "above")
        self.assertEqual(self.card(dict(self.POLL, predicted_eod=55.0))["outsideRange"], "below")

    def test_closed_session_before_and_after_the_official_close(self):
        before = self.card(status=self.CLOSED)
        self.assertEqual(before["kind"], "closed")
        self.assertIsNone(before["actual"])
        self.assertIsNotNone(before["range"])
        after = self.card(status=self.CLOSED, daily=[{"date": "2026-10-26", "total_rev": 75.0}])
        self.assertEqual(after["actual"], 75.0)
        self.assertAlmostEqual(after["predError"], (43 / 0.6) / 75 - 1, places=9)
        self.assertIsNone(after["range"])
        self.assertIsNone(after["pctOfClose"])
        self.assertIsNone(after["bar"]["lo"])
        self.assertAlmostEqual(after["bar"]["fill"], 75 / (75 * 1.06) * 100, places=9)
        # While the session is live, a same-day row does not count as its close
        self.assertIsNone(self.card(daily=[{"date": "2026-10-26", "total_rev": 75.0}])["actual"])

    def test_no_range_once_the_session_is_complete(self):
        # The pollers run to 16:30: from the 16:00 close every share is 1, so the range would collapse
        done = self.card(dict(self.POLL, captured_ist="2026-10-26T16:30:00", elapsed_minutes=435), status=self.CLOSED)
        self.assertTrue(done["sessionDone"])
        self.assertIsNone(done["range"])
        self.assertIsNone(done["outsideRange"])
        self.assertIsNone(done["bar"]["lo"])
        # past 16:00 every session has reached its close: the estimate is the booked figure
        self.assertEqual((done["booked"], done["pred"], done["predModel"]), (43.0, 43.0, 70.0))
        self.assertAlmostEqual(done["pctOfClose"], 1.0, places=9)
        self.assertFalse(self.card(status=self.CLOSED)["sessionDone"])   # polls stopped at 14:00: range kept

    def test_live_model_headline_without_history(self):
        hourly = {"date": "2026-10-26", "day_type": "normal", "samples": [self.POLL]}
        c = js_eval(LIVE_CARD_JS, "liveCardModel(DATA.h, {days: []}, [], DATA.st)", {"h": hourly, "st": self.LIVE})
        self.assertEqual((c["predSource"], c["pred"]), ("model", 70.0))

    def test_share_of_day_track(self):
        # each normal day has only 2 others of its type, so its pool is every other day:
        # .5 vs median(.6 .7 .8 .9) = .75, .6 vs median(.5 .7 .8 .9) = .75, .7 vs median(.5 .6 .8 .9) = .7
        got = js_eval(LIVE_CARD_JS, "shareOfDayTrack(DATA, 285, 'normal')", self.NORMAL + self.EXPIRY)
        self.assertEqual(got["n"], 3)
        self.assertAlmostEqual(got["mae"], (abs(.5 / .75 - 1) + abs(.6 / .75 - 1) + 0) / 3, places=9)
        self.assertIsNone(js_eval(LIVE_CARD_JS, "shareOfDayTrack([], 285, 'normal')"))

    def test_no_polls_and_no_feed(self):
        self.assertEqual(self.card(samples=[{"elapsed_minutes": 0, "total_revenue": 5.0}])["kind"], "none")
        self.assertEqual(js_eval(LIVE_CARD_JS, "liveCardModel(null, null, [])")["kind"], "unavailable")

    def test_close_known_from_the_views_rows(self):
        rows = [{"date": "2026-10-22"}, {"date": "2026-10-23"}]
        got = js_eval(LIVE_CARD_JS + ["liveCloseKnown"],
                      "[liveCloseKnown(DATA, '2026-10-23'), liveCloseKnown(DATA, '2026-10-26'), liveCloseKnown(DATA, null), liveCloseKnown(undefined, '2026-10-23')]", rows)
        self.assertEqual(got, [True, False, False, False])

    def test_actual_close_is_at_todays_rates(self):
        # BSE 23 Oct: ₹10.30 Cr at today's rates (the polls' basis) vs ₹10.81 Cr as charged
        data = {"h": {"date": "2026-10-23", "day_type": "normal", "samples": [self.POLL]},
                "hist": {"days": self.NORMAL}, "today": [{"date": "2026-10-23", "total_rev": 10.30}]}
        expr = ("(LIVE_CARD_CACHE.bse = { hourly: DATA.h, history: DATA.hist, closeRows: DATA.today },"
                " liveCardFor('bse'))")
        c = js_eval(LIVE_CARD_JS + ["liveStatus", "LIVE_STALE_MINUTES", "istDateOf", "parseUtcTs",
                                    "LIVE_CARD_CACHE", "liveCardFor"], expr, data)
        self.assertEqual(c["actual"], 10.30)
        self.assertAlmostEqual(c["predError"], (43 / 0.6) / 10.30 - 1, places=9)   # the share-of-day estimate vs the close

    def banner(self, ex, card):
        return js_eval(["bannerReadingFromCard"], f"bannerReadingFromCard('{ex}', DATA)", card)

    def test_banner_shows_the_cards_reading(self):
        live = self.banner("nse", self.card())
        self.assertEqual((live["total_revenue"], live["trade_date"], live["time"], live["live"], live["source"]),
                         (43.0, "2026-10-26", "14:00", True, "poll"))
        self.assertFalse(live["options_pending"])
        closed = self.banner("nse", self.card(status=self.CLOSED))
        self.assertEqual((closed["total_revenue"], closed["live"]), (43.0, False))
        actual = self.banner("nse", self.card(status=self.CLOSED, daily=[{"date": "2026-10-26", "total_rev": 75.0}]))
        self.assertEqual((actual["total_revenue"], actual["source"]), (75.0, "historical"))
        cash_only = self.banner("bse", self.card(dict(self.POLL, options_revenue=0.0, cash_revenue=0.4)))
        self.assertTrue(cash_only["options_pending"])

    def test_banner_reads_directly_without_a_current_poll(self):
        for card in (self.card(status={"kind": "stale", "isToday": True, "age": 40}),
                     self.card(samples=[]), {"kind": "unavailable"}):
            with self.subTest(kind=card["kind"]):
                self.assertIsNone(self.banner("nse", card))
        # …and falls back to the delayed poll when the direct read fails
        delayed = js_eval(["bannerReadingFromCard"], "bannerReadingFromCard('nse', DATA, true)",
                          self.card(status={"kind": "stale", "isToday": True, "age": 40}))
        self.assertEqual((delayed["total_revenue"], delayed["live"], delayed["time"]), (43.0, False, "14:00"))

    def test_trade_date_forms(self):
        forms = ["2026-10-16T15:30:00", "16/10/26", "16/10/2026", "16-10-26", "16-10-2026", "16-Oct-2026"]
        got = js_eval(["normalizeTradeDateJS"], "DATA.map(normalizeTradeDateJS)", forms)
        self.assertEqual(got, ["2026-10-16"] * len(forms))


@unittest.skipUnless(NODE, "node not installed")
class QuarterLabels(unittest.TestCase):
    def test_shift_and_short_range(self):
        js = js_eval(["shiftQuarter", "shortQuarterRange"],
                     "[shiftQuarter('Q3 FY 2027', -1), shiftQuarter('Q1 FY 2027', -1), shiftQuarter('Q3 FY 2027', -4), shiftQuarter('Q4 FY 2027', 1),"
                     " shortQuarterRange(['Q2 FY 2026', 'Q3 FY 2026']), shortQuarterRange(['Q4 FY 2026', 'Q1 FY 2027']), shortQuarterRange(['Q3 FY 2026'])]")
        self.assertEqual(js, ["Q2 FY 2027", "Q4 FY 2026", "Q3 FY 2026", "Q1 FY 2028",
                              "Q2–Q3 FY26", "Q4 FY26–Q1 FY27", "Q3 FY26"])

    def test_analyst_note_month_span(self):
        js = js_eval(["rxDate", "analystMonths"],
                     "[analystMonths('2026-05-08', '2026-05-18'), analystMonths('2026-05-08', '2026-08-04'),"
                     " analystMonths('2025-12-02', '2026-08-04'), analystMonths('2026-05-08', null)]")
        self.assertEqual(js, ["May 2026", "May–Aug 2026", "Dec 2025–Aug 2026", "May 2026"])


@unittest.skipUnless(NODE, "node not installed")
class RevenueSummaryMonths(unittest.TestCase):
    """Revenue Summary shows three months (current, previous, the month before) ahead
    of Avg 6M; the market-share panel's third month comes from the raw monthly rows."""

    def test_default_months_are_latest_three_across_year_boundaries(self):
        # Ends in January (calendar wrap: Jan, Dec, Nov) and, one month later, in April (FY wrap)
        months = ["FY 2026 October", "FY 2026 November", "FY 2026 December", "FY 2026 January",
                  "FY 2026 February", "FY 2026 March", "FY 2027 April"]
        expr = "[4, 7, 2, 1].map(n => defaultMonthIdxs(n).map(i => DATA[i]))"
        got = js_eval(["defaultMonthIdxs"], expr, months)
        self.assertEqual(got[0], ["FY 2026 January", "FY 2026 December", "FY 2026 November"])
        self.assertEqual(got[1], ["FY 2027 April", "FY 2026 March", "FY 2026 February"])
        # Too few months: the missing rows repeat the oldest, as the second row always did
        self.assertEqual(got[2], ["FY 2026 November", "FY 2026 October", "FY 2026 October"])
        self.assertEqual(got[3], ["FY 2026 October"] * 3)

    def _raw(self, daily_by_month, modelled=()):
        """Raw dashboard file: daily rows and the pipelines' monthly sums of them."""
        daily, monthly = [], []
        for month, revs in daily_by_month.items():
            rows = [{"fy_month": month, "total_rev": t, "opt_rev": t * 0.8, "fut_rev": t * 0.2}
                    for t in revs]
            daily += rows
            row = {"month": month, "days": len(rows),
                   **{f: sum(r[f] for r in rows) for f in ("total_rev", "opt_rev", "fut_rev")}}
            if month in modelled:
                row["modelled_days"] = len(rows)
            monthly.append(row)
        return {"daily_all": daily, "monthly": monthly}

    def test_market_share_third_month_is_raw_daily_average(self):
        raw = self._raw({"FY 2026 November": [10.0, 12.0, 17.0], "FY 2026 December": [20.0, 22.0],
                         "FY 2026 January": [30.0]})
        enr = {"monthly": {"current": {"label": "FY 2026 January"}, "previous": {"label": "FY 2026 December"}}}
        got = js_eval(["MS_SEG_FIELD", "msMonthBefore"],
                      "['summary_total', 'seg_options'].map(k => msMonthBefore(DATA.raw, DATA.enr, k))",
                      {"raw": raw, "enr": enr})
        nov = [r for r in raw["daily_all"] if r["fy_month"] == "FY 2026 November"]
        for res, field in zip(got, ("total_rev", "opt_rev")):
            self.assertEqual(res["label"], "FY 2026 November")
            self.assertAlmostEqual(res["value"], sum(r[field] for r in nov) / len(nov))
        # Nothing before the previous month (or no previous label): no third row
        short = self._raw({"FY 2026 December": [20.0], "FY 2026 January": [30.0]})
        self.assertIsNone(js_eval(["MS_SEG_FIELD", "msMonthBefore"],
                                  "msMonthBefore(DATA.raw, DATA.enr, 'summary_total')",
                                  {"raw": short, "enr": enr}))
        self.assertIsNone(js_eval(["MS_SEG_FIELD", "msMonthBefore"],
                                  "msMonthBefore(DATA.raw, {}, 'summary_total')", {"raw": raw}))

    def test_market_share_third_month_keeps_mcx_modelled_flag(self):
        raw = self._raw({"FY 2025 June": [5.0], "FY 2025 July": [6.0], "FY 2025 August": [7.0]},
                        modelled={"FY 2025 June"})
        enr = {"monthly": {"previous": {"label": "FY 2025 July"}}}
        got = js_eval(["MS_SEG_FIELD", "msMonthBefore", "SEG_PRODUCT", "NO_FLAGS", "periodFlags"],
                      "periodFlags(msMonthBefore(DATA.raw, DATA.enr, 'summary_total').row, 'total').modelled",
                      {"raw": raw, "enr": enr})
        self.assertTrue(got)


LAST_FIVE_JS = ["EXPIRY_RULES", "EXPIRY_DOW_NAMES", "expiryRuleFor", "isScheduledExpiry", "computeWeekExpiryDates",
                "EXPIRY_DATES_CACHE", "expiryDateSet", "getRevFieldObj", "WEEKDAYS", "MONTHS_SHORT", "fmtNum",
                "L5_DAY_MS", "l5DayAfter", "lastFiveBreakdown", "l5Date", "l5MixNote", "lastFiveTitle"]


class LastFiveDays(unittest.TestCase):
    """The "Last 5 Days" hover: BSE, 2–11 Nov 2026, Tue 10 Nov a holiday, so the window
    holds two Wednesdays (pre-expiry before the Thursday expiry) and no Tuesday."""
    ROWS = [("2026-11-02", "Monday", 9.14), ("2026-11-03", "Tuesday", 9.25), ("2026-11-04", "Wednesday", 36.37),
            ("2026-11-05", "Thursday", 53.79), ("2026-11-06", "Friday", 12.80), ("2026-11-09", "Monday", 11.06),
            ("2026-11-11", "Wednesday", 36.63)]

    def run_js(self, exchange="bse"):
        daily = [{"date": d, "day": w, "total_rev": v, "opt_rev": v / 2} for d, w, v in self.ROWS]
        expr = f"""(() => {{
          const b = lastFiveBreakdown('total', [{{ exchange: '{exchange}', daily_all: DATA.daily }}]);
          return {{ b: b[0], opt: lastFiveBreakdown('options', [{{ exchange: '{exchange}', daily_all: DATA.daily }}])[0],
                   title: lastFiveTitle(b) }};
        }})()"""
        return js_eval(LAST_FIVE_JS, expr, {"daily": daily})

    def test_sessions_tags_and_weekday_mix(self):
        js = self.run_js()
        b = js["b"]
        self.assertEqual([s["date"] for s in b["last5"]],
                         ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-11"])
        # Wed 11 is the latest row: pre-expiry because Thu 12 is BSE's scheduled expiry
        self.assertEqual([s["tag"] for s in b["last5"]], ["pre-expiry", "expiry", "", "", "pre-expiry"])
        self.assertEqual(b["repeats"], [{"day": "Wednesday", "n": 2}])
        self.assertEqual(b["missing"], ["Tuesday"])
        self.assertEqual(b["holidays"], ["2026-11-10"])
        self.assertAlmostEqual(b["avgLast5"], (36.37 + 53.79 + 12.80 + 11.06 + 36.63) / 5, places=9)

    def test_latest_weekdays_average(self):
        """One of each weekday: the latest Monday … Friday, as the "Mon–Fri Avg (Latest)" row."""
        js = self.run_js()
        b = js["b"]
        self.assertEqual([s["date"] for s in b["latest"]],
                         ["2026-11-09", "2026-11-03", "2026-11-11", "2026-11-05", "2026-11-06"])
        self.assertAlmostEqual(b["avgLatest"], (11.06 + 9.25 + 36.63 + 53.79 + 12.80) / 5, places=9)
        self.assertAlmostEqual(js["opt"]["avgLatest"], b["avgLatest"] / 2, places=9)   # segment field

    def test_title_text(self):
        title = self.run_js()["title"]
        self.assertIn("Wed 11 Nov · 36.63 (pre-expiry)", title)
        self.assertIn("Wednesday twice, no Tuesday (10 Nov holiday)", title)
        self.assertIn("avg ₹24.71 Cr", title)

    def test_no_tags_without_an_expiry_rule(self):
        b = self.run_js("mcx")["b"]
        self.assertEqual({s["tag"] for s in b["last5"]}, {""})


if __name__ == "__main__":
    unittest.main()
