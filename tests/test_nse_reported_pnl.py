import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import nse_pipeline as nse
import nse_reported_pnl as reported

EXPENSES = ("employee_cost", "regulatory_fees", "depreciation", "technology_expense", "sebi_settlement",
            "csr_expense", "other_expense", "sgf_contribution")


def total(row, keys):
    return sum(row.get(k) or 0 for k in keys)


class ReportedRowsAddUp(unittest.TestCase):
    """Each row must satisfy nse_pipeline's NSE P&L definitions exactly."""

    def test_identities(self):
        for r in reported.REPORTED:
            with self.subTest(quarter=r["quarter"]):
                revenue = total(r, nse.PNL_OPERATING_REVENUE + nse.PNL_NON_OPERATING_INCOME)
                self.assertAlmostEqual(revenue, r["total_revenue"], places=2)
                self.assertAlmostEqual(total(r, EXPENSES), r["total_expense"], places=2)
                self.assertAlmostEqual(r["total_revenue"] - r["total_expense"], r["ebitda"], places=2)
                pbt = r["ebitda"] + r["share_profit_associates"] + total(r, nse.PNL_EXCEPTIONAL_ITEMS)
                self.assertAlmostEqual(pbt, r["pbt"], places=2)
                self.assertAlmostEqual(r["pbt"] - r["income_tax"], r["pat"], places=2)
                self.assertAlmostEqual(r["pat"] / r["eps"], 247.5, delta=0.5)   # ₹247.50 Cr paid-up at ₹1
                self.assertNotIn("unreconciled_pbt_gap", nse.pnl_operating_view(r)["exceptional_items"])

    def test_reported_quarters_replace_manual_forecasts(self):
        stored = [{"quarter": "Q3 FY 2026", "is_predicted": False, "pat": 2408.3},
                  {"quarter": "Q4 FY 2026", "is_predicted": True, "pat": 3196.99},
                  {"quarter": "Q2 FY 2027", "is_predicted": True, "pat": 3204.9}]
        merged = {r["quarter"]: r for r in reported.apply(stored)}
        self.assertEqual(merged["Q3 FY 2026"]["pat"], 2408.3)
        self.assertEqual((merged["Q4 FY 2026"]["is_predicted"], merged["Q4 FY 2026"]["pat"]), (False, 2870.99))
        self.assertFalse(merged["Q1 FY 2027"]["is_predicted"])
        self.assertTrue(merged["Q2 FY 2027"]["is_predicted"])

    def test_forecast_rests_on_latest_reported_quarters(self):
        m = nse.nse_ratio_model(sorted(reported.apply([]), key=lambda r: nse.quarter_sort_key(r["quarter"])))
        self.assertEqual(m["base_quarters"], ["Q4 FY 2026", "Q1 FY 2027"])
        # Q1 FY27: all other income sits in investment_income, so the split still counts
        self.assertAlmostEqual(m["non_operating_income_ratio"], (392.18 / 4077 + 691.76 / 3623) / 2, places=6)


if __name__ == "__main__":
    unittest.main()
