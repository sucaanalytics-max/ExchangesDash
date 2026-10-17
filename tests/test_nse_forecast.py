import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import nse_pipeline as nse


class _Table:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_):
        return self

    def execute(self):
        return type("R", (), {"data": self.rows})()


class _Supabase:
    def __init__(self, rows):
        self.rows = rows

    def table(self, _name):
        return _Table(self.rows)


class PnlOrder(unittest.TestCase):
    """C1: the forecast's 'latest actual' quarters must be the chronologically
    latest, not the last in label-text order (Q4 FY25 used to beat Q3 FY26)."""

    def test_fetch_pnl_sorts_chronologically(self):
        rows = [{"quarter": q} for q in ("Q4 FY 2025", "Q3 FY 2026", "Q1 FY 2026", "Q2 FY 2026")]
        got = [r["quarter"] for r in nse.fetch_pnl(_Supabase(rows))]
        self.assertEqual(got, ["Q4 FY 2025", "Q1 FY 2026", "Q2 FY 2026", "Q3 FY 2026"])

    def test_ratio_model_uses_last_two_actuals(self):
        def q(label, txn, predicted=False):
            row = {k: 0 for k in nse.PNL_NON_OPERATING_INCOME}
            row.update({"quarter": label, "is_predicted": predicted, "transaction_rev": txn,
                        "total_revenue": txn, "total_expense": txn * 0.3, "depreciation": 0,
                        "pbt": txn * 0.7, "pat": txn * 0.5, "income_tax": txn * 0.2, "eps": 1})
            return row
        hist = [q("Q1 FY 2026", 100), q("Q2 FY 2026", 200), q("Q3 FY 2026", 300),
                q("Q4 FY 2026", 999, predicted=True)]
        m = nse.nse_ratio_model(hist)
        self.assertEqual(m["base_quarters"], ["Q2 FY 2026", "Q3 FY 2026"])
