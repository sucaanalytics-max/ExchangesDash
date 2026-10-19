"""dashboard/js/*.js: index.html loads every file, in name order, as classic
scripts sharing one global scope. Splitting the dashboard into files adds two
ways to break it at load that a per-file parse cannot see: top-level code that
reads a name a later file declares (a ReferenceError: hoisting only works
within one file), and the same top-level name declared in two files (a
SyntaxError for const/let/class; for function the later file silently wins)."""

import json
import re
import subprocess
import unittest

from helpers import DASHBOARD, JS_FILES, NODE

START_CALL = "startDashboard();"

# Runs the files in one vm context in index.html order, as the browser does.
# Host APIs are recursive no-op stubs, so only the files' own top-level code
# runs; timers never fire and the final startDashboard() call is left out, so
# init() does not run against the stubs.
LOAD_IN_ORDER_JS = r"""
const vm = require('vm'), fs = require('fs');
const stub = new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => '' : k === 'then' ? undefined : stub,
  apply: () => stub, construct: () => stub, set: () => true,
});
const ctx = { console, setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, clearInterval() {},
  requestAnimationFrame: () => 0, cancelAnimationFrame() {}, queueMicrotask() {} };
for (const name of ['document', 'Chart', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
    'matchMedia', 'getComputedStyle', 'fetch', 'addEventListener', 'removeEventListener', 'dispatchEvent',
    'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'AbortController', 'URL', 'URLSearchParams',
    'Blob', 'FileReader', 'Image', 'HTMLElement', 'Event', 'CustomEvent', 'alert', 'print', 'open', 'scrollTo',
    'innerWidth', 'innerHeight', 'devicePixelRatio', 'performance'])
  ctx[name] = stub;
ctx.window = ctx.self = ctx;
vm.createContext(ctx);
const [files, startCall] = JSON.parse(process.argv[1]);
for (const [i, f] of files.entries()) {
  let src = fs.readFileSync(f, 'utf8');
  if (i === files.length - 1) {
    const lines = src.trimEnd().split('\n');
    if (lines.pop() !== startCall) { console.log(`${f}: its last line must be ${startCall}`); process.exit(1); }
    src = lines.join('\n');
  }
  try { new vm.Script(src, { filename: f }).runInContext(ctx); }
  catch (e) { console.log(`${f}: ${e.name}: ${e.message}`); process.exit(1); }
}
"""

TOP_LEVEL_NAME = re.compile(r"^(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)", re.M)


def top_level_names(text):
    # Top-level declarations start in column 0 (nested code is indented)
    return TOP_LEVEL_NAME.findall(text)


class DashboardScripts(unittest.TestCase):
    def test_index_html_loads_every_file_in_name_order(self):
        on_disk = sorted(f"js/{p.name}" for p in (DASHBOARD / "js").glob("*.js"))
        self.assertEqual(JS_FILES, on_disk)
        # The dashboard starts at the end of the last file, once everything is declared
        self.assertEqual(JS_FILES[-1], "js/99-init.js")
        self.assertEqual((DASHBOARD / JS_FILES[-1]).read_text().rstrip().splitlines()[-1], START_CALL)
        self.assertFalse((DASHBOARD / "app.js").exists())

    @unittest.skipUnless(NODE, "node not installed")
    def test_each_file_parses(self):
        for f in JS_FILES:
            with self.subTest(file=f):
                out = subprocess.run(
                    [NODE, "-e", "new (require('vm').Script)(require('fs').readFileSync(process.argv[1], 'utf8'), {filename: process.argv[1]})",
                     str(DASHBOARD / f)], capture_output=True, text=True)
                self.assertEqual(out.returncode, 0, out.stderr)

    def test_no_top_level_name_declared_twice(self):
        seen, dupes = {}, []
        for f in JS_FILES:
            for name in top_level_names((DASHBOARD / f).read_text()):
                if name in seen:
                    dupes.append(f"{name}: {seen[name]} and {f}")
                seen.setdefault(name, f)
        self.assertEqual(dupes, [], "the same top-level name is declared twice; the browser keeps one of them")
        self.assertGreater(len(seen), 300)   # the scan found the declarations

    @unittest.skipUnless(NODE, "node not installed")
    def test_files_load_in_order(self):
        files = [str(DASHBOARD / f) for f in JS_FILES]
        out = subprocess.run([NODE, "-e", LOAD_IN_ORDER_JS, json.dumps([files, START_CALL])],
                             capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, "load-time error in index.html order (top-level code may only use "
                         f"what earlier files declare):\n{out.stdout}{out.stderr}")


if __name__ == "__main__":
    unittest.main()
