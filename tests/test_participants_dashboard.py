"""The Participants tab's calculation helpers (dashboard/js/17-participants.js), run in Node:
month comparison rows and changes, daily shares against a published total or the sum of the
categories, chart ranges, number formats and category colours. The page itself is checked in a
browser."""

import unittest

from helpers import NODE, js_eval

HELPERS = ["MONTHS_SHORT", "RX", "PT_RANGES", "PT_COLOR_RULES", "PT_PALETTE", "ptColor", "ptTint", "ptColors", "ptMonthLabel",
           "ptCompareMonths", "ptChange", "ptLatestMonth", "ptCompareRows", "ptDailyShares", "ptRangeStart",
           "ptValueOnOrBefore", "ptFmt", "ptChangeText", "ptFindCat", "rxSignedPct", "fmtNum"]


def js(expr, data=None):
    return js_eval(HELPERS, expr, data)


VIEW = {
    "aggregation": "mean", "unit": "contracts", "total_row": "TOTAL",
    "days": {"2025-11": 19, "2026-10": 20, "2026-11": 8},
    "series": {"TOTAL": {"2025-11": 400.0, "2026-10": 500.0, "2026-11": 550.0},
               "FII": {"2025-11": 100.0, "2026-10": 100.0, "2026-11": 110.0}},
    "shares": {"FII": {"2025-11": 25.0, "2026-10": 20.0, "2026-11": 20.0}},
}


@unittest.skipUnless(NODE, "node not installed")
class Months(unittest.TestCase):
    def test_compare_months_and_labels(self):
        self.assertEqual(js("ptCompareMonths('2026-01')"), ["2026-01", "2025-12", "2025-01", "2024-01", "2023-01"])
        self.assertEqual(js("ptMonthLabel('2026-11')"), "Nov 2026")
        self.assertEqual(js("ptLatestMonth(DATA)", VIEW), "2026-11")
        self.assertIsNone(js("ptLatestMonth(null)"))

    def test_changes(self):
        self.assertAlmostEqual(js("ptChange(110, 100, 'mean')"), 0.1)
        self.assertEqual(js("ptChange(-5, 20, 'sum')"), -25)            # net flows: absolute change
        self.assertIsNone(js("ptChange(5, null, 'mean')"))
        self.assertEqual(js("[ptChangeText(-25, 'sum'), ptChangeText(0.1, 'mean'), ptChangeText(null, 'mean')]"),
                         ["−25", "+10.0 %", "—"])

    def test_compare_rows(self):
        out = js("ptCompareRows(DATA, '2026-11')", VIEW)
        self.assertEqual(out["days"], [8, 20, 19, 0, 0])
        self.assertEqual([r["cat"] for r in out["rows"]], ["FII", "TOTAL"])   # the total row last
        fii = out["rows"][0]
        self.assertEqual(fii["vals"][:3], [110.0, 100.0, 100.0])
        self.assertEqual(fii["shares"][:3], [20.0, 20.0, 25.0])
        self.assertAlmostEqual(fii["mom"], 0.1)
        self.assertAlmostEqual(fii["yoy"], 0.1)
        self.assertTrue(out["rows"][1]["total"])


@unittest.skipUnless(NODE, "node not installed")
class Daily(unittest.TestCase):
    def test_shares_against_the_published_total_or_the_sum(self):
        daily = {"dates": ["2026-11-02", "2026-11-03"],
                 "series": {"FII": [25, 30], "Pro": [75, None], "TOTAL": [100, 120]}}
        out = js("ptDailyShares(DATA, 'TOTAL')", daily)
        self.assertEqual(out, {"FII": [25, 25], "Pro": [75, None]})
        out = js("ptDailyShares(DATA, null)", {"dates": daily["dates"], "series": {"FII": [25, 30], "Pro": [75, 90]}})
        self.assertEqual(out, {"FII": [25, 25], "Pro": [75, 75]})

    def test_ranges_and_lookups(self):
        self.assertEqual(js("ptRangeStart('2026-11-11', '1y')"), "2025-11-11")
        self.assertEqual(js("ptRangeStart('2026-11-11', '6m')"), "2026-05-11")
        self.assertIsNone(js("ptRangeStart('2026-11-11', 'all')"))
        hit = js("ptValueOnOrBefore(['2025-11-07','2025-11-10','2025-11-12'], [1, null, 3], '2025-11-11')")
        self.assertEqual(hit, {"date": "2025-11-07", "value": 1})        # a missing value is skipped

    def test_formats_and_colours(self):
        self.assertEqual(js("[ptFmt(47528390, 'contracts'), ptFmt(5385098, 'contracts'), ptFmt(9045, 'contracts'),"
                            " ptFmt(75392.4, '₹ Cr'), ptFmt(null, '₹ Cr')]"),
                         ["4.75 Cr", "53.9 L", "9,045", "75,392", "—"])
        self.assertEqual(js("[ptColor('FII'), ptColor('FII/FPI'), ptColor('Foreign Investors'), ptColor('FPI')]"),
                         ["#2B5CC8"] * 4)                                # FII is one blue everywhere
        self.assertEqual(js("[ptColor('DIIs'), ptColor('Mutual Funds'), ptColor('Proprietary'), ptColor('CLIENT*')]"),
                         ["#176C2E", "#176C2E", "#C4621A", "#7A5BB5"])
        self.assertEqual(js("ptFindCat({Client: {}, 'FII / FPI': {}}, /^fii/i)"), "FII / FPI")

    def test_chart_colours_follow_the_category(self):
        # BSE's F&O mix lists FII fourth: it keeps FII's blue, not the fourth palette colour
        self.assertEqual(js("ptColors(['Proprietary', 'Others', 'FII / FPI', 'Mutual Funds'])"),
                         ["#C4621A", js("RX.grey"), "#2B5CC8", "#176C2E"])
        # several DII parts in one chart: DII green, then lighter tints of it
        out = js("ptColors(['Bank', 'Insurance Companies', 'Mutual Funds', 'FPI'])")
        self.assertEqual(out[0], "#176C2E")
        self.assertEqual(out[3], "#2B5CC8")
        self.assertEqual(len(set(out)), 4)
        self.assertEqual(js("ptTint('#000000', 1)"), "#333333")


if __name__ == "__main__":
    unittest.main()
