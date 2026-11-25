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


class OtherTransactionCharges(unittest.TestCase):
    """NSE's MF, currency and NSEIX charges are in reported transaction_rev but
    not in the daily equity files; the forecast carries them per session."""

    @staticmethod
    def _pnl(label, txn):
        row = {k: 0 for k in nse.PNL_NON_OPERATING_INCOME}
        row.update({"quarter": label, "is_predicted": False, "transaction_rev": txn,
                    "total_revenue": txn * 1.4, "total_expense": txn * 0.3, "depreciation": 10,
                    "pbt": txn, "pat": txn * 0.75, "income_tax": txn * 0.25, "eps": txn * 0.75 / 247.5})
        return row

    @staticmethod
    def _days(label, month, n, rev):
        # 2026 dates: today's fee rules, so reprice_date_effective keeps total_rev
        return [{"date": f"2026-{month:02d}-{i + 1:02d}", "fy_quarter": label, "total_rev": rev} for i in range(n)]

    def test_per_session_average_of_the_base_quarters(self):
        pnl = [self._pnl("Q1 FY 2027", 60 * 50 + 42), self._pnl("Q2 FY 2027", 65 * 40 + 50)]
        daily = self._days("Q1 FY 2027", 4, 20, 50) + self._days("Q1 FY 2027", 5, 20, 50) + self._days("Q1 FY 2027", 6, 20, 50) \
            + self._days("Q2 FY 2027", 7, 22, 40) + self._days("Q2 FY 2027", 8, 21, 40) + self._days("Q2 FY 2027", 9, 22, 40)
        got = nse.nse_other_txn_charges(pnl, daily)
        self.assertEqual([q["quarter"] for q in got["quarters"]], ["Q1 FY 2027", "Q2 FY 2027"])
        self.assertAlmostEqual(got["per_day"], round((42 / 60 + 50 / 65) / 2, 4), places=4)

    def test_negative_gap_or_missing_days_gives_none(self):
        pnl = [self._pnl("Q1 FY 2027", 900), self._pnl("Q2 FY 2027", 2650)]
        daily = self._days("Q1 FY 2027", 4, 20, 50) + self._days("Q2 FY 2027", 7, 22, 40)
        self.assertIsNone(nse.nse_other_txn_charges(pnl, daily))     # Q1 reported below the daily sum
        self.assertIsNone(nse.nse_other_txn_charges(pnl[1:] + [self._pnl("Q3 FY 2027", 1)], daily[:5]))

    def test_next_quarter_grows_only_the_daily_part(self):
        pnl = [self._pnl("Q1 FY 2026", 3000), self._pnl("Q2 FY 2026", 3100)]
        quarterly = [{"quarter": q, "days": 60, "total_rev": r} for q, r in
                     (("Q4 FY 2025", 2900), ("Q1 FY 2026", 3000), ("Q2 FY 2026", 3100), ("Q3 FY 2026", 3200), ("Q4 FY 2026", 3300))]
        pred = {"transaction_rev_extrapolated": 3345.0, "other_txn_rev": 45.0}
        got = nse.compute_predicted_quarters(pred, pnl, quarterly)
        cur, nxt = got["Q4 FY 2026"], got["Q1 FY 2027"]
        self.assertEqual((cur["transaction_rev"], cur["segments_rev"], cur["other_txn_rev"]), (3345.0, 3300.0, 45.0))
        yoy = 3300 / 2900 - 1   # Q4 FY 2026 vs Q4 FY 2025, per day
        self.assertAlmostEqual(nxt["transaction_rev"], round(3300 * (1 + yoy) + 45, 2), places=2)
        self.assertEqual(nxt["other_txn_rev"], 45.0)
