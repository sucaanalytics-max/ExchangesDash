"""Run the dashboard's own pure JS functions in Node, outside a browser.

The dashboard JS (dashboard/js/*.js) is browser script (DOM, Chart.js), so it
cannot be loaded whole. js_source() lifts one named top-level function or const
out of it, js_closure() adds every top-level function / const that a set of
names reaches, and js_eval() runs an expression over them in a bare Node VM,
which is enough for the pure calculation helpers.

Used by the tests (tests/helpers.py) and by scripts/valuation_outputs.py, which
computes the Valuation Model tab's figures for the Excel mirror with the same
code the browser runs, so the two cannot drift."""

import json
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DASHBOARD = ROOT / "dashboard"
# index.html is the one place that lists the dashboard's scripts and their order.
# Any tag whose src is js/<name>.js counts, whatever its other attributes or quotes.
JS_FILES = re.findall(r"""<script\b[^>]*\bsrc=["'](?:\./)?(js/[^"'?#]+\.js)(?:[?#][^"']*)?["']""", (DASHBOARD / "index.html").read_text())
APP_JS = "\n".join((DASHBOARD / f).read_text() for f in JS_FILES)
NODE = shutil.which("node")

_TOP_LEVEL = re.compile(r"^(?:async )?function ([A-Za-z_$][\w$]*)\(|^const ([A-Za-z_$][\w$]*)\s*=", re.M)
_IDENT = re.compile(r"[A-Za-z_$][\w$]*")


def _block_end(src, start):
    """Index just past the brace block that opens at or after `start`."""
    i = src.index("{", start)
    depth = 0
    while True:
        c = src[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1


def _find(name):
    """(start, end) of a top-level `function name(` or `const name =` in APP_JS."""
    m = re.search(rf"^(?:async )?function {re.escape(name)}\(", APP_JS, re.M)
    if m:
        return m.start(), _block_end(APP_JS, APP_JS.index(")", m.end()))
    m = re.search(rf"^const {re.escape(name)}\s*=", APP_JS, re.M)
    if m:
        return m.start(), APP_JS.index(";\n", m.end()) + 1
    raise KeyError(f"{name} not found in dashboard/js")


def js_source(name):
    """Source of a top-level `function name(` or `const name =` in the dashboard JS."""
    start, end = _find(name)
    return APP_JS[start:end]


def js_closure(names):
    """`names` plus every top-level function / const of the dashboard JS their source
    mentions, transitively, in source order (so a const that reads another at load
    sees it defined). A name mentioned only in a comment or string is included too,
    which is harmless: a definition does nothing until it is called."""
    top = {m.group(1) or m.group(2) for m in _TOP_LEVEL.finditer(APP_JS)}
    seen, todo = set(), list(names)
    while todo:
        n = todo.pop()
        if n in seen:
            continue
        seen.add(n)
        todo.extend(i for i in set(_IDENT.findall(js_source(n))) if i in top and i not in seen)
    return sorted(seen, key=lambda n: _find(n)[0])


def js_eval(names, expr, data=None, closure=False):
    """Evaluate `expr` (JS) after defining `names` from the dashboard JS (with
    closure=True, everything they reach too); `data` is available as DATA.
    Returns the JSON-decoded result."""
    if closure:
        names = js_closure(names)
    code = "\n".join(js_source(n) for n in names)
    script = (f"const DATA = {json.dumps(data)};\n{code}\n"
              f"process.stdout.write(JSON.stringify(({expr})));")
    if not NODE:
        raise RuntimeError("node is not installed")
    out = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)
