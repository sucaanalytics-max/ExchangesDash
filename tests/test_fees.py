import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import fee_register as fr
import take_rates as tr


class FeeRegister(unittest.TestCase):
    def test_register_is_valid(self):
        self.assertEqual(fr.validate(), [])

    def test_nse_rates_change_on_2026_03_01(self):
        self.assertEqual(fr.rule("NSE", "opt", "2026-02-28")["rate_per_cr_per_side"], 3503)
        self.assertEqual(fr.rule("NSE", "opt", "2026-03-01")["rate_per_cr_per_side"], 3553)
        self.assertEqual(fr.rate("NSE", "cash", "2026-03-01"), (fr.fraction(307), "flat"))

    def test_slab_era_is_an_estimate(self):
        self.assertEqual(fr.rate("NSE", "opt", "2024-06-03")[1], "slab_estimate")
        self.assertEqual(fr.rate("NSE", "opt", "2024-10-01")[1], "flat")

    def test_bse_cash_calibrated_then_provisional(self):
        r = fr.rule("BSE", "cash", "2026-05-15")              # Q1 FY 2027, reported
        self.assertEqual((r["rate_per_cr_per_side"], r["basis"]), (557, "calibrated"))
        r = fr.rule("BSE", "cash", "2026-10-15")              # Q3 FY 2027, not reported yet
        self.assertEqual((r["rate_per_cr_per_side"], r["basis"]),
                         (fr.BSE_CASH_PROVISIONAL_RATE, "calibrated_provisional"))

    def test_take_rates_are_todays_statutory_rates(self):
        self.assertEqual(tr.NSE_TR_OPT, fr.current_statutory_rate("NSE", "opt"))
        self.assertEqual(tr.BSE_TR_CASH, fr.current_statutory_rate("BSE", "cash"))
        self.assertAlmostEqual(fr.fraction(183), 0.0000366)   # 0.00183 % per side, two sides
