"""Brokers → PAT Predictor (dashboard/js/33-brokers-pat.js): the in-browser recompute of the
PAT model (patRecompute, a port of the brokers engine's src/engine/pat_kit.py) against the
engine's own vectors, the load-time check, the fallback for runs without the new rows, and
the Valuation tab's re-weighting at the reader's inputs (34-brokers-valuation.js).

tests/fixtures/pat_vectors_<BROKER>.json are the engine's vectors (contract of 10 Nov 2026):
{"rows": [sb_pat_lines rows as /api/brokers?view=pat returns them], "cases": [{g, pe, disc,
today, expect: {"<period>|<line>|<scenario>": value}}]}, written from an offline engine run
(branch feat/pat-adr-buildup of abiyani-tools/brokersdashboard) and checked there against
pat.build()."""

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
      return DATA.cases.map(c => patRecompute(kit, c.g, c.pe, c.disc, c.today)); })()""", doc)


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
        doc = vectors("ANGELONE")
        out = recompute_cases(doc)[1]
        g = doc["cases"][1]["g"]
        q3, q4 = out["Q3 FY 2027|adr_consol|"], out["Q4 FY 2027|adr_consol|"]
        self.assertAlmostEqual(q4 / q3, 1 + g, places=12)
        fy28 = [out[f"Q{k} FY 2028|adr_consol|"] for k in (1, 2, 3, 4)]
        self.assertAlmostEqual(out["FY 2028|adr_consol|"], sum(fy28) / 4, places=9)


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
        self.assertEqual(out[5], {"g": 0.03, "pe": [22, 27, 32], "disc": 0.2, "today": 0.1})


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


class Markup(unittest.TestCase):
    def test_shared_state_lives_in_the_shell(self):
        src = {n: (ROOT / "dashboard" / "js" / n).read_text() for n in ("30-brokers.js", "33-brokers-pat.js", "34-brokers-valuation.js")}
        self.assertIn("const BRK_PAT_LIVE = {};", src["30-brokers.js"])
        self.assertIn("BRK_PAT_LIVE[broker] =", src["33-brokers-pat.js"])
        self.assertIn("BRK_PAT_LIVE[BRK_BROKER.id]", src["34-brokers-valuation.js"])


if __name__ == "__main__":
    unittest.main()
