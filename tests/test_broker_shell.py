"""Brokers mode (dashboard/js/00-core.js): the registry broker views plug into,
and the tab / title / label lookups shared with the exchanges. The page itself
is checked in a browser; these cover the pure parts."""

import re
import unittest

from helpers import DASHBOARD, NODE, js_eval

SHELL = ["BROKER_KEY_PREFIX", "BROKER_VIEWS", "NAV_ICONS", "EXCHANGE_TABS", "TAB_TITLES",
         "isBrokerKey", "brokerViewOf", "brokerKeys", "brokerTabId", "registerBrokerView",
         "tabsFor", "titlesFor", "viewLabel"]

ANGEL = """{ id: 'angel', label: 'Angel One',
  tabs: [{ id: 'summary', label: 'Summary', icon: 'revenue' }, { id: 'pat', label: 'PAT Predictor', icon: 'nope' }],
  titles: { summary: 'Angel One: Revenue Summary' }, load: async () => {}, build: () => {} }"""


def run(expr):
    return js_eval(SHELL, f"(() => {{ {expr} }})()")


def error_of(view):
    return run(f"try {{ registerBrokerView({view}); return null; }} catch (e) {{ return e.message; }}")


@unittest.skipUnless(NODE, "node not installed")
class Registry(unittest.TestCase):
    def test_register_and_keys(self):
        out = run(f"registerBrokerView({ANGEL}); return [brokerKeys(), isBrokerKey('broker:angel'),"
                  " isBrokerKey('nse'), brokerViewOf('broker:angel').label, brokerViewOf('broker:none')];")
        self.assertEqual(out, [["broker:angel"], True, False, "Angel One", None])

    def test_rejects_bad_views(self):
        self.assertIn("duplicate", run(f"registerBrokerView({ANGEL}); try {{ registerBrokerView({ANGEL}); }}"
                                        " catch (e) { return e.message; } return null;"))
        self.assertIn("id must match", error_of("{ id: 'Angel One', label: 'x', tabs: [{id: 'a', label: 'A'}],"
                                                " load() {}, build() {} }"))
        self.assertIn("label", error_of("{ id: 'a', tabs: [{id: 'a', label: 'A'}], load() {}, build() {} }"))
        self.assertIn("at least one tab", error_of("{ id: 'a', label: 'A', tabs: [], load() {}, build() {} }"))
        self.assertIn("repeats tab", error_of("{ id: 'a', label: 'A', tabs: [{id: 't', label: 'T'},"
                                              " {id: 't', label: 'U'}], load() {}, build() {} }"))
        self.assertIn("load() and build()", error_of("{ id: 'a', label: 'A', tabs: [{id: 't', label: 'T'}] }"))
        self.assertIn("expects an object", error_of("null"))


@unittest.skipUnless(NODE, "node not installed")
class Lookups(unittest.TestCase):
    def test_exchange_tabs_unchanged(self):
        out = run("return [tabsFor('nse'), EXCHANGE_TABS.nse, titlesFor('bse').revenue, tabsFor('nope')];")
        self.assertEqual(out[0], out[1])
        self.assertEqual(out[2], "Revenue Summary")
        self.assertEqual(out[3], [])

    def test_broker_tabs_are_namespaced(self):
        out = run(f"registerBrokerView({ANGEL}); return [tabsFor('broker:angel'), titlesFor('broker:angel')];")
        tabs, titles = out
        self.assertEqual([t["id"] for t in tabs], ["brk-angel-summary", "brk-angel-pat"])
        self.assertEqual([t["icon"] for t in tabs], ["revenue", "revenue"])     # unknown icon falls back
        self.assertEqual(titles, {"brk-angel-summary": "Angel One: Revenue Summary",
                                  "brk-angel-pat": "Angel One: PAT Predictor"})

    def test_local_tab_id_from_sidebar_id(self):
        # attachTabListeners hands onShow the view's own tab id
        self.assertEqual(run("const t = brokerTabId('angel', 'pat'); return t.slice(brokerTabId('angel', '').length);"),
                         "pat")

    def test_labels(self):
        out = run(f"registerBrokerView({ANGEL}); return ['nse', 'all', 'nsebse', 'broker:angel'].map(viewLabel);")
        self.assertEqual(out, ["NSE", "All Exchanges", "NSE+BSE", "Angel One"])


class Markup(unittest.TestCase):
    def test_switch_hidden_until_a_broker_registers(self):
        html = (DASHBOARD / "index.html").read_text()
        switch = re.search(r'<div[^>]*id="modeSwitch"[^>]*>', html).group(0)
        self.assertIn(" hidden", switch)
        self.assertRegex(html, r'id="exchangePill"')
        self.assertRegex(html, r'id="brokerPill"')
        self.assertEqual(re.findall(r'data-mode="(\w+)"', html), ["exchanges", "brokers"])


if __name__ == "__main__":
    unittest.main()
