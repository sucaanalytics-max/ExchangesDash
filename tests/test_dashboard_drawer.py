"""The side drawer (openRxDrawer in dashboard/js/00-core.js): closed must mean gone.

The drawer is shown with `display: flex`, which overrides the `hidden` attribute
the close sets, so without an explicit `[hidden] { display: none }` the closed
drawer stays on the page, transparent, over the right of the screen, and
swallows clicks there (the Valuation Model's and Revenue Predictor's input
buttons stopped working after the first drawer was closed, 20 Nov 2026)."""

import re
import unittest

from helpers import DASHBOARD

CSS = (DASHBOARD / "style.css").read_text()
CORE = (DASHBOARD / "js" / "00-core.js").read_text()


class DrawerClosedIsGone(unittest.TestCase):
    def test_hidden_drawer_and_scrim_are_not_displayed(self):
        rule = re.search(r"([^{}]*\.rx-drawer\.rx\[hidden\][^{}]*)\{([^}]*)\}", CSS)
        self.assertIsNotNone(rule, "style.css needs a .rx-drawer.rx[hidden] rule")
        self.assertIn(".rx-drawer-scrim[hidden]", rule.group(1))
        self.assertRegex(rule.group(2), r"display:\s*none")

    def test_closed_drawer_takes_no_clicks(self):
        rule = re.search(r"\.rx-drawer\.rx:not\(\.is-open\)[^{}]*\{([^}]*)\}", CSS)
        self.assertIsNotNone(rule)
        self.assertRegex(rule.group(1), r"pointer-events:\s*none")

    def test_close_hides_both(self):
        close = CORE[CORE.index("function closeRxDrawer()"):]
        close = close[:close.index("\n}\n")]
        self.assertIn("d.box.hidden = true", close)
        self.assertIn("d.scrim.hidden = true", close)


if __name__ == "__main__":
    unittest.main()
