"""Shared test helpers: put scripts/ on the path and run app.js functions in Node.

app.js is a browser script (DOM, Chart.js), so it cannot be loaded whole.
js_eval() lifts the named top-level functions / consts out of it and runs them
in a bare Node VM, which is enough for the pure calculation helpers."""

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

APP_JS = (ROOT / "dashboard" / "app.js").read_text()
NODE = shutil.which("node")


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


def js_source(name):
    """Source of a top-level `function name(` or `const name =` in app.js."""
    m = re.search(rf"^(?:async )?function {name}\(", APP_JS, re.M)
    if m:
        return APP_JS[m.start():_block_end(APP_JS, APP_JS.index(")", m.end()))]
    m = re.search(rf"^const {name}\s*=", APP_JS, re.M)
    if m:
        end = APP_JS.index(";\n", m.end())
        return APP_JS[m.start():end + 1]
    raise KeyError(f"{name} not found in app.js")


def js_eval(names, expr, data=None):
    """Evaluate `expr` (JS) after defining `names` from app.js; `data` is
    available as DATA. Returns the JSON-decoded result."""
    code = "\n".join(js_source(n) for n in names)
    script = (f"const DATA = {json.dumps(data)};\n{code}\n"
              f"process.stdout.write(JSON.stringify(({expr})));")
    out = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(out.stderr)
    return json.loads(out.stdout)
