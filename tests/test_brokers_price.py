"""Brokers → Price vs ADR (dashboard/js/31-brokers-price.js): the daily ADR series
each basis builds from the engine's sb_daily_revenue rows, run in Node."""

import unittest

from helpers import NODE, js_eval


def row(day, seg, cr, regime="actual"):
    return {"trade_date": day, "segment": seg, "revenue_cr": cr, "regime": regime}


# Commodities start before F&O / cash (Angel One), MTF stops two days early,
# and the last F&O day is projected
DAILY = (
    [row("2024-09-30", "comm", 1.0)]
    + [row(d, s, v) for d in ("2024-10-01", "2024-10-03", "2024-10-04")
       for s, v in (("fo", 10.0), ("cash", 2.0), ("comm", 1.0), ("mtf_gross", 3.0))]
    + [row(d, s, v) for d in ("2024-10-07", "2024-10-08")
       for s, v in (("fo", 11.0), ("cash", 2.0), ("comm", 1.0))]
)
DAILY[-3]["regime"] = "projected"   # F&O on 2024-10-08


def series(daily, basis):
    return js_eval(["brkAdrSeries"], f"brkAdrSeries(DATA, '{basis}')", daily)


@unittest.skipUnless(NODE, "node not installed")
class AdrSeries(unittest.TestCase):
    def test_consolidated_needs_every_segment(self):
        s = series(DAILY, "cons")
        # Starts with F&O / cash / MTF, not with the earlier commodities; stops with MTF
        self.assertEqual([r["date"] for r in s["rows"]], ["2024-10-01", "2024-10-03", "2024-10-04"])
        self.assertEqual(s["rows"][0]["revenue_cr"], 16.0)
        self.assertEqual(s["segs"], ["fo", "cash", "comm", "mtf_gross"])

    def test_broking_runs_past_mtf_and_flags_projected_days(self):
        rows = series(DAILY, "broking")["rows"]
        self.assertEqual([r["date"] for r in rows][-2:], ["2024-10-07", "2024-10-08"])
        self.assertEqual(rows[-1]["revenue_cr"], 14.0)
        self.assertEqual([r["modelled"] for r in rows][-2:], [False, True])

    def test_commodities_count_as_zero_before_they_start(self):
        late_comm = [r for r in DAILY if not (r["segment"] == "comm" and r["trade_date"] < "2024-10-04")]
        rows = series(late_comm, "broking")["rows"]
        self.assertEqual(rows[0], {"date": "2024-10-01", "revenue_cr": 12.0, "modelled": False})
        # From its first day on, a day without commodities is incomplete and left out
        no_comm_day = [r for r in late_comm if not (r["segment"] == "comm" and r["trade_date"] == "2024-10-07")]
        self.assertNotIn("2024-10-07", [r["date"] for r in series(no_comm_day, "broking")["rows"]])

    def test_mtf_uses_net_interest_income_when_published(self):
        nii = [dict(r, segment="mtf_nii") if r["segment"] == "mtf_gross" else r for r in DAILY]
        s = series(nii, "mtf")
        self.assertEqual(s["segs"], ["mtf_nii"])
        self.assertEqual([r["revenue_cr"] for r in s["rows"]], [3.0, 3.0, 3.0])


if __name__ == "__main__":
    unittest.main()
