"""Brokers → PAT Predictor (dashboard/js/33-brokers-pat.js): the in-browser recompute of the
PAT model (patRecompute, a port of the brokers engine's src/engine/pat_kit.py) against the
engine's own vectors, the load-time check, the fallback for runs without the new rows, and
the Valuation tab's re-weighting at the reader's inputs (34-brokers-valuation.js).

tests/fixtures/pat_vectors_<BROKER>.json are the engine's vectors (contract of 10 Nov 2026;
two growth inputs since 13 Nov 2026): {"rows": [sb_pat_lines rows as /api/brokers?view=pat
returns them], "cases": [{g, gm, pe, disc, today, expect: {"<period>|<line>|<scenario>":
value}}]}, written by seed/build_pat_vectors.py of abiyani-tools/brokersdashboard (whose
tests/test_pat_kit.py checks the recompute against pat.build()). g is the broking (and cash)
ADR growth a quarter, gm the MTF ADR growth."""

import json
import unittest

from helpers import NODE, ROOT, js_eval

FIXTURES = ROOT / "tests" / "fixtures"
BROKERS = ("ANGELONE", "GROWW")
PAT = ["brkPeriodOrder", "BRK_FY_MONTHS", "BRK_PAT_SCENARIOS", "BRK_PAT_REV", "BRK_PAT_COST", "BRK_PAT_FIXED_Q",
       "BRK_PAT_FIXED_FY2", "BRK_PAT_TOTALS", "BRK_PAT_TREASURY", "BRK_PAT_KIT_KEYS", "BRK_PAT_KIT_BROKER",
       "brkPatKit", "patRecompute", "brkPatTol", "brkPatCheck"]


def vectors(broker):
    return json.loads((FIXTURES / f"pat_vectors_{broker}.json").read_text())


def recompute_cases(doc):
    """[{key: recomputed}] per case, from patRecompute on the kit of doc's rows."""
    return js_eval(PAT, """(() => { const { kit, missing } = brkPatKit(DATA.rows);
      if (!kit) throw new Error('kit incomplete: ' + missing.join(', '));
      return DATA.cases.map(c => patRecompute(kit, c.g, c.pe, c.disc, c.today, c.gm)); })()""", doc)


@unittest.skipUnless(NODE, "node not installed")
class EngineVectors(unittest.TestCase):
    def test_every_case_matches_the_engine(self):
        for broker in BROKERS:
            doc = vectors(broker)
            published = {f"{r['period_key']}|{r['line']}|{r['scenario']}": r["value"] for r in doc["rows"]}
            got = recompute_cases(doc)
            self.assertGreaterEqual(len(doc["cases"]), 4)
            for case, out in zip(doc["cases"], got):
                for key, want in case["expect"].items():
                    with self.subTest(broker=broker, g=case["g"], pe=case["pe"], key=key):
                        # a line the recompute leaves alone is the published one (filed, or independent of the inputs)
                        have = out[key] if key in out else published[key]
                        self.assertAlmostEqual(have, want, delta=1e-6 * max(1.0, abs(want)))

    def test_every_line_that_moves_is_recomputed(self):
        # any expected line that differs between cases must come from patRecompute, not the published row
        for broker in BROKERS:
            doc = vectors(broker)
            got = recompute_cases(doc)
            keys = set(doc["cases"][0]["expect"])
            moving = {k for k in keys if len({round(c["expect"][k], 9) for c in doc["cases"]}) > 1}
            self.assertTrue(moving)
            self.assertEqual(moving - set(got[0]), set(), broker)

    def test_groww_finance_floor(self):
        # k_finance_base (engine, 14 Nov 2026): Groww's finance cost never falls below its latest filed quarter, and
        # FY28 is 4 × Q4 FY27 plus new borrowing, not below 4 × the floor; a run without the row keeps the old rule
        doc = vectors("GROWW")
        base = next(r["value"] for r in doc["rows"] if r["line"] == "k_finance_base")
        for out in recompute_cases(doc):
            for q in ("Q3 FY 2027", "Q4 FY 2027"):
                self.assertGreaterEqual(out[f"{q}|finance|"], base - 1e-9)
            self.assertGreaterEqual(out["FY 2028|finance|"], 4 * base - 1e-9)
        old = dict(doc, rows=[r for r in doc["rows"] if r["line"] != "k_finance_base"])
        got = recompute_cases(old)[0]
        self.assertLess(got["Q3 FY 2027|finance|"], base)          # the shrinking MTF book repays it, as before
        self.assertNotIn("k_finance_base", {r["line"] for r in vectors("ANGELONE")["rows"]})

    def test_top_block_sums_to_total_income(self):
        for broker in BROKERS:
            out = recompute_cases(vectors(broker))[2]       # a case off the defaults
            for fy in ("FY 2026", "FY 2027", "FY 2028"):
                parts = sum(out[f"{fy}|{k}|"] for k in ("op_revenue", "treasury_rev", "other_inc"))
                self.assertAlmostEqual(parts, out[f"{fy}|total_income|"] if f"{fy}|total_income|" in out else
                                       next(r["value"] for r in vectors(broker)["rows"]
                                            if r["period_key"] == fy and r["line"] == "total_income"), places=6)
            # FY28 operating revenue = FY28 average consolidated ADR × trading days = broking + MTF
            self.assertAlmostEqual(out["FY 2028|op_revenue|"], out["FY 2028|broking|"] + out["FY 2028|mtf|"], places=6)

    def test_build_up_compounds_quarterly(self):
        # broking at (1 + g) and MTF at (1 + gm) a quarter, each from its own start ADR
        for broker in BROKERS:
            doc = vectors(broker)
            inp = {r["line"]: r["value"] for r in doc["rows"] if r["period_key"] == "inputs"}
            b0, m0 = inp["k_adr_broking0"], inp["k_adr_mtf0"]
            for case, out in zip(doc["cases"], recompute_cases(doc)):
                g, gm = case["g"], case["gm"]
                self.assertAlmostEqual(out["Q3 FY 2027|adr_consol|"], b0 + m0, places=9)
                self.assertAlmostEqual(out["Q4 FY 2027|adr_consol|"], b0 * (1 + g) + m0 * (1 + gm), places=9)
                fy28 = [out[f"Q{k} FY 2028|adr_consol|"] for k in (1, 2, 3, 4)]
                self.assertAlmostEqual(out["FY 2028|adr_consol|"], sum(fy28) / 4, places=9)
                self.assertAlmostEqual(out["FY 2028|adr_mtf|"], m0 * sum((1 + gm) ** k for k in (2, 3, 4, 5)) / 4, places=9)
                self.assertAlmostEqual(out["FY 2028|adr_broking|"], b0 * sum((1 + g) ** k for k in (2, 3, 4, 5)) / 4, places=9)

    def test_mtf_growth_leaves_broking_alone(self):
        doc = vectors("GROWW")
        cases, out = doc["cases"], recompute_cases(doc)
        d = next(i for i, c in enumerate(cases) if c["name"] == "defaults")
        # a case at the default broking rate with faster MTF growth than the default
        m = next(i for i, c in enumerate(cases) if c["g"] == cases[d]["g"] and c["gm"] > cases[d]["gm"] + 0.01)
        base, mtf = out[d], out[m]
        for k in ("FY 2028|broking|", "FY 2028|adr_broking|", "Q4 FY 2027|broking|"):
            self.assertAlmostEqual(base[k], mtf[k], places=9)
        self.assertGreater(mtf["FY 2028|mtf|"], base["FY 2028|mtf|"] + 100)
        self.assertGreater(mtf["FY 2028|pat|"], base["FY 2028|pat|"])

    def test_omitted_gm_is_the_published_default(self):
        doc = vectors("GROWW")
        a, b = js_eval(PAT, """(() => { const { kit } = brkPatKit(DATA.rows);
          return [patRecompute(kit, 0.02, [20, 25, 30], 0.2, 0.1)['FY 2028|mtf|'],
                  patRecompute(kit, 0.02, [20, 25, 30], 0.2, 0.1, kit.defaults.gm)['FY 2028|mtf|']]; })()""", doc)
        self.assertAlmostEqual(a, b, places=9)


@unittest.skipUnless(NODE, "node not installed")
class LoadCheck(unittest.TestCase):
    def test_defaults_reproduce_the_published_lines(self):
        for broker in BROKERS:
            self.assertEqual(js_eval(PAT, "brkPatCheck(brkPatKit(DATA.rows).kit, DATA.rows)", vectors(broker)), [], broker)

    def test_a_differing_line_is_named(self):
        doc = vectors("GROWW")
        for r in doc["rows"]:
            if r["period_key"] == "FY 2028" and r["line"] == "pat":
                r["value"] += 1.0
        bad = js_eval(PAT, "brkPatCheck(brkPatKit(DATA.rows).kit, DATA.rows)", doc)
        self.assertEqual([b["key"] for b in bad], ["FY 2028|pat|"])

    def test_tolerances(self):
        self.assertEqual(js_eval(PAT, "['Rs Cr', 'Rs', 'Rs Cr / day', 'fraction', 'x'].map(brkPatTol)"),
                         [0.01, 0.01, 0.01, 1e-6, 1e-6])


@unittest.skipUnless(NODE, "node not installed")
class OlderRuns(unittest.TestCase):
    def test_run_without_the_new_rows_falls_back(self):
        doc = vectors("ANGELONE")
        old = [r for r in doc["rows"] if r["period_key"] != "inputs" and not r["line"].startswith("k_")
               and r["line"] not in ("adr_consol", "op_revenue", "treasury_rev", "other_inc") and r["period_key"] != "FY 2026"]
        out = js_eval(PAT, "brkPatKit(DATA)", old)
        self.assertNotIn("kit", out)
        self.assertIn("in_qoq_growth", out["missing"])
        self.assertIn("k_step Q1 FY 2028", out["missing"])

    def test_one_missing_input_is_reported(self):
        doc = vectors("GROWW")
        rows = [r for r in doc["rows"] if not (r["line"] == "in_pe" and r["scenario"] == "bull") and r["line"] != "k_prev_float"]
        out = js_eval(PAT, "brkPatKit(DATA)", rows)
        self.assertEqual(sorted(out["missing"]), ["in_pe bull", "k_prev_float"])

    def test_quarter_with_no_days_left(self):
        # the engine's start rule with fewer than 5 days in the current quarter: the quarter before it is still
        # projected, at step -1 with 0 remaining days (its figures are the engine's days so far)
        doc = vectors("ANGELONE")
        pub = {(r["period_key"], r["line"]): r["value"] for r in doc["rows"] if r["scenario"] == ""}
        q = "Q2 FY 2027"
        extra = {"k_step": -1, "k_rem_days": 0, "k_sofar_broking": pub[(q, "broking")], "k_sofar_mtf": pub[(q, "mtf")],
                 "k_sofar_cash": 100.0}
        doc["rows"] += [{"period_key": q, "line": k, "scenario": "", "label": k, "value": v, "unit": "n",
                         "regime": "projected", "rule": None, "sort_order": 1200} for k, v in extra.items()]
        out = js_eval(PAT, """(() => { const { kit } = brkPatKit(DATA.rows); const a = patRecompute(kit, 0.01, [20, 25, 30], 0.2, 0.1),
            b = patRecompute(kit, 0.09, [20, 25, 30], 0.2, 0.1);
            return [kit.proj, kit.buildup[0], a['Q2 FY 2027|broking|'], b['Q2 FY 2027|broking|'], 'Q2 FY 2027|adr_consol|' in a,
                    Object.values(a).every(Number.isFinite)]; })()""", doc)
        self.assertEqual(out[0], ["Q2 FY 2027", "Q3 FY 2027", "Q4 FY 2027"])
        self.assertEqual(out[1], "Q3 FY 2027")
        self.assertEqual(out[2], out[3])           # no days left: independent of g
        self.assertAlmostEqual(out[2], pub[(q, "broking")])
        self.assertFalse(out[4])
        self.assertTrue(out[5])

    def test_kit_reads_the_defaults(self):
        out = js_eval(PAT, "(({ kit }) => [kit.broker, kit.fy1, kit.fy2, kit.fy0, kit.proj, kit.defaults])(brkPatKit(DATA.rows))",
                      vectors("ANGELONE"))
        self.assertEqual(out[:5], ["ANGELONE", "FY 2027", "FY 2028", "FY 2026", ["Q3 FY 2027", "Q4 FY 2027"]])
        self.assertEqual(out[5], {"g": 0.03, "gm": 0.03, "pe": [22, 27, 32], "disc": 0.2, "today": 0.1})

    def test_run_without_mtf_growth_row_grows_mtf_at_the_broking_rate(self):
        doc = vectors("GROWW")
        rows = [r for r in doc["rows"] if r["line"] != "in_mtf_qoq_growth"]
        out = js_eval(PAT, "(({ kit }) => kit.defaults)(brkPatKit(DATA))", rows)
        self.assertEqual(out["gm"], out["g"])


@unittest.skipUnless(NODE, "node not installed")
class ValuationReweight(unittest.TestCase):
    NAMES = ["BRK_VAL_METHODS", "BRK_VAL_SCEN", "brkValReweight"]

    def test_net_and_upside_with_the_adr_leg_replaced(self):
        values = {"regression": {"bear": 290, "base": 310, "bull": 330}, "ratio": {"bear": 300, "base": 345, "bull": 390},
                  "adr": {"bear": 1, "base": 1, "bull": 1}}
        out = js_eval(self.NAMES, "brkValReweight(DATA.v, DATA.w, DATA.adr, 338)",
                      {"v": values, "w": {"regression": 0.2, "ratio": 0.3, "adr": 0.5},
                       "adr": {"bear": 316, "base": 388, "bull": 460}})
        self.assertAlmostEqual(out["net"]["base"], 0.2 * 310 + 0.3 * 345 + 0.5 * 388)
        self.assertAlmostEqual(out["upside"]["bull"], (0.2 * 330 + 0.3 * 390 + 0.5 * 460) / 338 - 1)
        self.assertEqual(out["adr"], {"bear": 316, "base": 388, "bull": 460})


@unittest.skipUnless(NODE, "node not installed")
class ValuationWeights(unittest.TestCase):
    """The reader's method weights (brkValScale), then brkValReweight on them."""
    NAMES = ["BRK_VAL_METHODS", "BRK_VAL_SCEN", "brkValReweight", "brkValScale"]
    VALUES = {"regression": {"bear": 290, "base": 310, "bull": 330}, "ratio": {"bear": 300, "base": 345, "bull": 390},
              "adr": {"bear": 316, "base": 388, "bull": 460}}

    def test_weights_that_add_up_are_kept(self):
        out = js_eval(self.NAMES, "brkValScale({ regression: 0.5, ratio: 0.25, adr: 0.25 })")
        self.assertAlmostEqual(out["sum"], 1)
        self.assertEqual(out["scaled"], {"regression": 0.5, "ratio": 0.25, "adr": 0.25})

    def test_weights_are_scaled_to_add_up_to_one(self):
        out = js_eval(self.NAMES, "brkValScale({ regression: 0.6, ratio: 0.3, adr: 0.3 })")
        self.assertAlmostEqual(out["sum"], 1.2)
        self.assertAlmostEqual(out["scaled"]["regression"], 0.5)
        self.assertAlmostEqual(sum(out["scaled"].values()), 1)

    def test_all_zero_has_no_weighted_value(self):
        self.assertIsNone(js_eval(self.NAMES, "brkValScale({ regression: 0, ratio: 0, adr: 0 })")["scaled"])

    def test_net_value_at_the_readers_weights(self):
        out = js_eval(self.NAMES, "brkValReweight(DATA.v, brkValScale(DATA.w).scaled, DATA.v.adr, 338)",
                      {"v": self.VALUES, "w": {"regression": 0, "ratio": 0.5, "adr": 0.5}})
        self.assertAlmostEqual(out["net"]["base"], 0.5 * 345 + 0.5 * 388)
        self.assertAlmostEqual(out["upside"]["bear"], (0.5 * 300 + 0.5 * 316) / 338 - 1)


@unittest.skipUnless(NODE, "node not installed")
class ValuationAdrInput(unittest.TestCase):
    """The ADR the regression and ratio methods use (brkValAtAdr, AB 14 Nov 2026), on Groww's published 'all' fit of
    run 90c0d655 (as of 12 Nov 2026): at the published current ADR it gives the engine's own figures."""
    NAMES = ["brkValAtAdr", "BRK_VAL_METHODS", "BRK_VAL_SCEN", "brkValReweight"]
    FIT = {"slope": 4.229642796825565, "intercept": 104.32483843062298, "band": 0.1,
           "mean": 9.491947493027286, "sd": 0.8657462447032565}
    ADR0 = 22.931837906451413
    PUBLISHED = {"regression": {"bear": 191.61897314771727, "base": 201.31832144961663, "bull": 211.017669751516},
                 "ratio": {"bear": 197.81464877499548, "base": 217.6678013266496, "bull": 237.5209538783037}}

    def test_published_adr_gives_the_published_figures(self):
        out = js_eval(self.NAMES, "brkValAtAdr(DATA.fit, DATA.adr)", {"fit": self.FIT, "adr": self.ADR0})
        for m, want in self.PUBLISHED.items():
            for s, x in want.items():
                self.assertAlmostEqual(out[m][s], x, places=9, msg=(m, s))

    def test_another_adr(self):
        out = js_eval(self.NAMES, "brkValAtAdr(DATA.fit, 26)", {"fit": self.FIT})
        f = self.FIT
        self.assertAlmostEqual(out["regression"]["base"], f["slope"] * 26 + f["intercept"])
        self.assertAlmostEqual(out["regression"]["bear"], f["slope"] * 26 * 0.9 + f["intercept"])
        self.assertAlmostEqual(out["ratio"]["bull"], (f["mean"] + f["sd"]) * 26)

    def test_net_value_at_the_readers_adr(self):
        # regression and ratio at ADR 26, the ADR leg as published, the published weights 20 / 30 / 50 %
        out = js_eval(self.NAMES, """(() => { const at = { ...DATA.v, ...brkValAtAdr(DATA.fit, 26) };
          return brkValReweight(at, { regression: 0.2, ratio: 0.3, adr: 0.5 }, at.adr, 224.95); })()""",
                      {"fit": self.FIT, "v": {**self.PUBLISHED, "adr": {"bear": 300, "base": 350, "bull": 400}}})
        f = self.FIT
        want = 0.2 * (f["slope"] * 26 + f["intercept"]) + 0.3 * f["mean"] * 26 + 0.5 * 350
        self.assertAlmostEqual(out["net"]["base"], want)
        self.assertAlmostEqual(out["upside"]["base"], want / 224.95 - 1)

    def test_on_load_check_passes_on_the_published_run(self):
        # the formula reproduces the published regression and ratio lines at the published ADR: the input is offered
        S = {m: {s: {"value": x} for s, x in v.items()} for m, v in self.PUBLISHED.items()}
        names = ["brkValAdrCheck"] + self.NAMES
        self.assertEqual(js_eval(names, "brkValAdrCheck(DATA.fit, DATA.adr, DATA.S)", {"fit": self.FIT, "adr": self.ADR0, "S": S}), [])

    def test_on_load_check_catches_an_engine_formula_change(self):
        # e.g. the engine applying the band to the whole regression price: bear / bull differ, so no input
        S = {m: {s: {"value": x} for s, x in v.items()} for m, v in self.PUBLISHED.items()}
        f, a = self.FIT, self.ADR0
        S["regression"]["bear"]["value"] = (f["slope"] * a + f["intercept"]) * 0.9
        S["regression"]["bull"]["value"] = (f["slope"] * a + f["intercept"]) * 1.1
        names = ["brkValAdrCheck"] + self.NAMES
        self.assertEqual(js_eval(names, "brkValAdrCheck(DATA.fit, DATA.adr, DATA.S)", {"fit": f, "adr": a, "S": S}),
                         ["regression bear", "regression bull"])
        # a missing published line counts as a mismatch too
        del S["ratio"]["base"]
        self.assertIn("ratio base", js_eval(names, "brkValAdrCheck(DATA.fit, DATA.adr, DATA.S)", {"fit": f, "adr": a, "S": S}))

    def test_the_quarter_comes_from_the_as_of_date(self):
        q = lambda d: js_eval(["brkValQuarter"], f"brkValQuarter({d!r})")
        self.assertEqual(q("2026-11-13"), "Q3 FY27")
        self.assertEqual(q("2026-04-01"), "Q1 FY27")
        self.assertEqual(q("2026-06-30"), "Q1 FY27")
        self.assertEqual(q("2026-03-31"), "Q4 FY26")
        self.assertEqual(q("2027-01-05"), "Q4 FY27")
        self.assertEqual(q(""), "")

    def test_the_45dma_basis_is_the_latest_published_45dma(self):
        # the series' last day can lack a 45-DMA (no price yet): the basis is the latest day that has one
        days = [{"date": "2026-11-11", "dma": 21.4}, {"date": "2026-11-12", "dma": 21.52}, {"date": "2026-11-13", "dma": None}]
        self.assertEqual(js_eval(["brkValLatestDma"], "brkValLatestDma(DATA)", days), {"date": "2026-11-12", "dma": 21.52})
        self.assertIsNone(js_eval(["brkValLatestDma"], "brkValLatestDma([])"))
        # regression and ratio at the 45-DMA, from the same fit
        out = js_eval(self.NAMES, "brkValAtAdr(DATA.fit, 21.52)", {"fit": self.FIT})
        self.assertAlmostEqual(out["regression"]["base"], self.FIT["slope"] * 21.52 + self.FIT["intercept"])
        self.assertAlmostEqual(out["ratio"]["bear"], (self.FIT["mean"] - self.FIT["sd"]) * 21.52)


@unittest.skipUnless(NODE, "node not installed")
class ValuationPeWindows(unittest.TestCase):
    """Which P/E bands the Valuation tab draws (brkValPeWindows)."""
    NAMES = ["brkValPeWindows"]
    ANGEL = {k: {} for k in ("all", "3m", "6m", "1y", "2y", "3y", "apr25")}
    GROWW = {k: {} for k in ("all", "3m", "6m")}   # listed Nov 2025: no 1y yet, no 3y / since Apr 2025

    def test_all_shows_the_workbook_windows_where_covered(self):
        self.assertEqual(js_eval(self.NAMES, "brkValPeWindows('all', DATA)", self.ANGEL), ["3y", "apr25"])

    def test_all_falls_back_to_the_whole_series(self):
        self.assertEqual(js_eval(self.NAMES, "brkValPeWindows('all', DATA)", self.GROWW), ["all"])

    def test_a_window_shows_its_own_band_or_none(self):
        self.assertEqual(js_eval(self.NAMES, "brkValPeWindows('6m', DATA)", self.GROWW), ["6m"])
        self.assertEqual(js_eval(self.NAMES, "brkValPeWindows('2y', DATA)", self.GROWW), [])
        self.assertEqual(js_eval(self.NAMES, "brkValPeWindows('all', DATA)", {}), [])


class Markup(unittest.TestCase):
    def test_shared_state_lives_in_the_shell(self):
        src = {n: (ROOT / "dashboard" / "js" / n).read_text() for n in ("30-brokers.js", "33-brokers-pat.js", "34-brokers-valuation.js")}
        self.assertIn("const BRK_PAT_LIVE = {};", src["30-brokers.js"])
        self.assertIn("BRK_PAT_LIVE[broker] =", src["33-brokers-pat.js"])
        self.assertIn("BRK_PAT_LIVE[BRK_BROKER.id]", src["34-brokers-valuation.js"])

    def test_valuation_weights_are_inputs(self):
        src = (ROOT / "dashboard" / "js" / "34-brokers-valuation.js").read_text()
        self.assertIn('data-vw="${m}"', src)          # one input per method
        self.assertIn("data-val-reset", src)           # back to the published weights
        self.assertIn("const BRK_VAL_W = {};", src)    # memory only, per broker and run

    def test_valuation_adr_is_an_input(self):
        src = (ROOT / "dashboard" / "js" / "34-brokers-valuation.js").read_text()
        self.assertIn("data-vadr", src)                 # the ADR for regression and ratio
        self.assertIn("data-val-adr-default", src)      # back to the published current quarter's ADR
        self.assertIn('data-vm="${m}|${s}"', src)       # the regression and ratio cells it recalculates
        self.assertIn("const BRK_VAL_ADR = {};", src)   # memory only, per broker and run

    def test_valuation_adr_basis_toggle_sits_above_the_valuation(self):
        src = (ROOT / "dashboard" / "js" / "34-brokers-valuation.js").read_text()
        self.assertIn('data-rx-seg="brkValAdrBasis"', src)          # 45-DMA | quarter average
        self.assertIn("rxOnSeg(root, 'brkValAdrBasis'", src)       # a pick fills the input with that basis
        self.assertIn("${adrPanel}${triangulation}", src)          # its own panel, right above the valuation

    def test_valuation_adr_review_points(self):
        # PR #93 review, 16 Nov 2026
        src = (ROOT / "dashboard" / "js" / "34-brokers-valuation.js").read_text()
        doc = (ROOT / "docs" / "BROKERS_INTEGRATION.md").read_text()
        self.assertIn("brkValAtAdr", doc)                                  # 1: listed as an exception
        self.assertIn("brkValAdrCheck(fit, adr0, S)", src)                 # 2: checked on load ...
        self.assertIn("const ast = wst && !adrOff.length", src)            #    ... and no input when it fails
        self.assertIn("!sameAdr(ast.adr, adr0)", src)                      # 3: compared at the 2 decimals shown
        self.assertIn("root.addEventListener('change'", src)               # 4: the value in use back on blur
        self.assertIn("const wUse = edited ? scaled : W;", src)            # 5: an ADR-only edit keeps the weights
        self.assertIn('data-vk="adr-v"', src)                              # 6: the ADR tile shows the ADR in use
        self.assertNotIn("× the current ADR.", src)                        #    and the foot says which
        self.assertIn("brkValQuarter(val.run.as_of_date)", src)            # 7: the quarter from the as-of date

    def test_each_valuation_chart_has_its_own_timeline(self):
        src = (ROOT / "dashboard" / "js" / "34-brokers-valuation.js").read_text()
        self.assertIn('data-val-cw="${name}"', src)       # one Timeline per chart
        self.assertIn("st.win = k; st.chart = {};", src)  # the Timeline above sets them all
        self.assertIn("drawChart(sel.dataset.valCw, sel.value)", src)   # a pick redraws only its chart


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(NODE, "node not installed")
class BrokerValuationPriceToBook(unittest.TestCase):
    """Motilal Oswal's P/B lines (AB, 19 Nov 2026): brkValIndex reads them, brkValPbWin picks the period."""
    NAMES = ["quarterSortKey", "brkValIndex", "BRK_VAL_WINDOWS", "BRK_PB_WINDOWS", "BRK_PB_DEFAULT", "brkValPbWin"]
    ROWS = [
        {"section": "pb_bands", "period_key": "3y", "line": "pb_mean", "value": 3.96, "rule": "2023-11-20 to 2026-11-18, 744 days"},
        {"section": "pb_bands", "period_key": "3y", "line": "pb_sd", "value": 0.71, "rule": ""},
        {"section": "pb_bands", "period_key": "1y", "line": "pb_mean", "value": 3.92, "rule": ""},
        {"section": "pb_book", "period_key": "Q2 FY 2027", "line": "bvps", "value": 257.73, "rule": ""},
        {"section": "pb_book", "period_key": "Q4 FY 2026", "line": "bvps", "value": 211.09, "rule": ""},
        {"section": "pb", "period_key": "2026-11-18", "line": "pb", "value": 4.77, "rule": "close …"},
        {"section": "pb", "period_key": "2026-11-18", "line": "bvps", "value": 257.73, "rule": ""},
        {"section": "pb", "period_key": "2026-11-17", "line": "pb", "value": 4.81, "rule": "close …"},
    ]

    def test_index(self):
        out = js_eval(self.NAMES, "(() => { const X = brkValIndex(DATA); return [X.pb, Object.keys(X.pbBands).sort(), X.book.map(b => b.quarter), Object.keys(X.sum)]; })()", self.ROWS)
        self.assertEqual([r["date"] for r in out[0]], ["2026-11-17", "2026-11-18"])
        self.assertEqual(out[0][1]["bvps"], 257.73)
        self.assertEqual(out[1], ["1y", "3y"])
        self.assertEqual(out[2], ["Q4 FY 2026", "Q2 FY 2027"])
        self.assertEqual(out[3], [])          # no ADR valuation: the tab shows only the P/B

    def test_period(self):
        self.assertEqual(js_eval(self.NAMES, "brkValPbWin(undefined, { '1y': {}, '3y': {} })"), "3y")
        self.assertEqual(js_eval(self.NAMES, "brkValPbWin('1y', { '1y': {}, '3y': {} })"), "1y")
        self.assertEqual(js_eval(self.NAMES, "brkValPbWin('3m', { '6m': {}, '1y': {} })"), "1y")
        self.assertIsNone(js_eval(self.NAMES, "brkValPbWin('3y', {})"))
