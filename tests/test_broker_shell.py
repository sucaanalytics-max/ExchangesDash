"""View modes (dashboard/js/00-core.js): the registry broker and MTF views plug
into, and the tab / title / label lookups shared with the exchanges. The page
itself is checked in a browser; these cover the pure parts."""

import re
import unittest

from helpers import DASHBOARD, NODE, js_eval

SHELL = ["VIEW_MODES", "NAV_ICONS", "EXCHANGE_TABS", "TAB_TITLES",
         "modeOf", "isViewKey", "viewOf", "modeKeys", "viewTabId", "registerModeView",
         "registerBrokerView", "isBrokerKey", "brokerViewOf", "brokerKeys", "brokerTabId",
         "tabsFor", "titlesFor", "viewLabel"]

ANGEL = """{ id: 'angel', label: 'Angel One',
  tabs: [{ id: 'summary', label: 'Summary', icon: 'revenue' }, { id: 'pat', label: 'PAT Predictor', icon: 'nope' }],
  titles: { summary: 'Angel One: Revenue Summary' }, load: async () => {}, build: () => {} }"""

MTF_NSE = """{ id: 'nse', label: 'NSE MTF', pill: 'NSE',
  tabs: [{ id: 'book', label: 'MTF Book', icon: 'share' }], load: async () => {}, build: () => {} }"""


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


@unittest.skipUnless(NODE, "node not installed")
class MtfMode(unittest.TestCase):
    def test_modes_of_keys(self):
        out = run("return ['nse', 'nsebse', 'all', 'broker:angel', 'mtf:nse', 'mtfx', null].map(modeOf);")
        self.assertEqual(out, ["exchanges", "exchanges", "exchanges", "brokers", "mtf", "exchanges", "exchanges"])
        self.assertEqual(run("return ['nse', 'broker:angel', 'mtf:bse'].map(isViewKey);"), [False, True, True])

    def test_register_mtf_view(self):
        out = run(f"registerModeView('mtf', {MTF_NSE}); return [modeKeys('mtf'), brokerKeys(), viewOf('mtf:nse').label,"
                  " isBrokerKey('mtf:nse'), brokerViewOf('mtf:nse'), viewOf('broker:nse')];")
        self.assertEqual(out, [["mtf:nse"], [], "NSE MTF", False, None, None])

    def test_mtf_tabs_are_namespaced(self):
        out = run(f"registerModeView('mtf', {MTF_NSE}); registerBrokerView({ANGEL}); return [tabsFor('mtf:nse'),"
                  " titlesFor('mtf:nse'), viewLabel('mtf:nse'), tabsFor('broker:angel').map(t => t.id)];")
        tabs, titles, label, brokers = out
        self.assertEqual(tabs, [{"id": "mtf-nse-book", "label": "MTF Book", "icon": "share"}])
        self.assertEqual(titles, {"mtf-nse-book": "NSE MTF: MTF Book"})
        self.assertEqual(label, "NSE MTF")
        self.assertEqual(brokers, ["brk-angel-summary", "brk-angel-pat"])

    def test_same_id_in_two_modes(self):
        # ids are unique within a mode, not across modes
        out = run(f"registerModeView('mtf', {{...{ANGEL}}}); registerBrokerView({ANGEL}); return [modeKeys('mtf'), brokerKeys()];")
        self.assertEqual(out, [["mtf:angel"], ["broker:angel"]])

    def test_rejects_unknown_mode(self):
        self.assertIn("unknown mode", run(f"try {{ registerModeView('funds', {MTF_NSE}); }} catch (e) {{ return e.message; }}"))
        self.assertIn("registerModeView(\"mtf\"): duplicate", run(
            f"registerModeView('mtf', {MTF_NSE}); try {{ registerModeView('mtf', {MTF_NSE}); }} catch (e) {{ return e.message; }}"))


class Markup(unittest.TestCase):
    def test_switch_hidden_until_a_view_registers(self):
        html = (DASHBOARD / "index.html").read_text()
        switch = re.search(r'<div[^>]*id="modeSwitch"[^>]*>', html).group(0)
        self.assertIn(" hidden", switch)
        self.assertRegex(html, r'id="exchangePill"')
        self.assertRegex(html, r'id="brokerPill"')
        self.assertRegex(html, r'id="mtfPill"')
        self.assertEqual(re.findall(r'data-mode="(\w+)"', html), ["exchanges", "brokers", "mtf"])

    def test_every_mode_has_its_pill_and_button(self):
        # VIEW_MODES' pills and the switch's buttons must name the same modes
        html = (DASHBOARD / "index.html").read_text()
        core = (DASHBOARD / "js" / "00-core.js").read_text()
        modes = re.search(r"const VIEW_MODES = \{(.*?)\n\};", core, re.S).group(1)
        for mode, pill in re.findall(r"(\w+):\s*\{[^}]*pill: '(\w+)'", modes):
            self.assertIn(f'data-mode="{mode}"', html)
            self.assertIn(f'id="{pill}"', html)


if __name__ == "__main__":
    unittest.main()
