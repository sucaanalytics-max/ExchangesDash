"""The phone glance's Revenue Summary (rsPhoneSummary in dashboard/js/10-revenue-summary.js,
drawn by glanceSummaryCard in 02-banner-glance.js) against the desktop block, run in Node.

The phone shows the desktop table at its default rows, so every figure and % chg it
reports must equal the cell the desktop renders from the same files."""

import copy
import math
from decimal import ROUND_HALF_UP, Decimal
import json
import re
import unittest

from helpers import NODE
from test_contracts_view import BUILD, num, page_fixture, render

SEGS = ("total", "options", "futures", "cash")


def phone_step(ex):
    model = ", ".join(f"{s}: rsPhoneSummary('{ex}', MARKET_RAW.{ex}, MARKET_DATA.{ex}, '{s}')" for s in SEGS)
    return BUILD + f" document.getElementById('marketSharePanel').innerHTML = JSON.stringify({{{model}}});"


def pct(v):
    """wireChg's figure: whole-number % (as JS Math.round)"""
    return None if v is None else f"{int(math.floor(v * 100 + 0.5))}%"


def fixed(v, dp):
    """JS toFixed: the float's exact value, halves rounded up"""
    return str(Decimal(v).quantize(Decimal(1).scaleb(-dp), rounding=ROUND_HALF_UP))


def chg_text(cell):
    m = re.search(r'class="xl-chg[^"]*"[^>]*>([^<]*)<', cell)
    return m.group(1) if m else None


def week_value(html, label):
    m = re.search(re.escape(label) + r'.*?</td><td><span class="xl-num">([^<]*)<', html, re.S)
    return m.group(1)


def day_value(html, day):
    m = re.search(r"<td>" + day + r'</td>\s*<td class="wire-value">([^<]*)<', html)
    return m.group(1)


def run(ex, fx=None):
    snap = render(ex, steps=(phone_step(ex),), fx=fx)[0]
    return snap["html"], json.loads(snap["html"]["marketSharePanel"])


@unittest.skipUnless(NODE, "node not installed")
class Parity(unittest.TestCase):
    def check(self, ex, fx=None):
        html, model = run(ex, fx)
        for seg in SEGS:
            m = model[seg]
            with self.subTest(ex=ex, seg=seg):
                self.assertIsNotNone(m)
                for key, rows in (("FY", m["fy"]), ("Q", m["q"]), ("M", m["m"][:3])):
                    for r, row in enumerate(rows):
                        self.assertEqual(fixed(row['value'], 2), num(html[f"xl{key}Val{r}-{seg}"]), (key, r))
                        if r:
                            want = "—" if row.get("na") else pct(row["chg"])
                            self.assertEqual(want, chg_text(html[f"xl{key}Chg{r}-{seg}"]), (key, r))
                avg = m["m"][3]
                self.assertEqual(fixed(avg['value'], 2), num(html[f"xlMAvgVal-{seg}"]))
                self.assertEqual("—" if avg["na"] else pct(avg["chg"]), chg_text(html[f"xlMAvgChg-{seg}"]))
                tab = html[f"subtab-rev-{seg}"]
                for row in m["week"]:
                    self.assertEqual(fixed(row['value'], 2), week_value(tab, row["label"]), row["label"])
                for d in m["days"]:
                    self.assertEqual(fixed(d['latest'], 1), day_value(tab, d["day"]), d["day"])
        return model

    def test_nse_matches_desktop(self):
        model = self.check("nse")
        self.assertEqual([r["label"] for r in model["total"]["q"]][0], page_fixture()[0]["raw"]["nse"]["quarterly"][-1]["quarter"])
        self.assertEqual(len(model["total"]["q"]), 4)
        self.assertEqual(model["total"]["m"][3]["label"], "Avg 6M (125 days)")

    def test_bse_matches_desktop(self):
        self.check("bse")

    def test_modelled_quarter_comparison_is_blank(self):
        # A year-ago quarter with modelled days (as MCX before 2 Sep 2024): "—" on both
        fx = copy.deepcopy(page_fixture()[0])
        raw = fx["raw"]["nse"]
        defs_yoy = None
        cur = raw["quarterly"][-1]["quarter"]
        qnum = cur.split()[0]
        for q in reversed(raw["quarterly"][:-1]):
            if q["quarter"].startswith(qnum + " "):
                defs_yoy = q
                break
        self.assertIsNotNone(defs_yoy)
        defs_yoy["modelled_days"] = 5
        model = self.check("nse", fx)
        yoy = model["total"]["q"][3]
        self.assertTrue(yoy["na"])
        self.assertIsNone(yoy["chg"])
        self.assertTrue(yoy["flags"]["modelled"])

    def test_missing_segment_is_null(self):
        fx = copy.deepcopy(page_fixture()[0])
        fx["enr"]["nse"]["seg_cash"] = None
        _, model = run("nse", fx)
        self.assertIsNone(model["cash"])
        self.assertIsNotNone(model["total"])


if __name__ == "__main__":
    unittest.main()
