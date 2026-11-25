"""Shared test helpers: put scripts/ on the path and run dashboard JS functions in Node.

The dashboard JS (dashboard/js/*.js) is browser script (DOM, Chart.js), so it
cannot be loaded whole. js_eval() lifts the named top-level functions / consts
out of it and runs them in a bare Node VM, which is enough for the pure
calculation helpers. The loader lives in scripts/dashboard_js.py, which the
Excel mirror (scripts/valuation_outputs.py) uses too."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from dashboard_js import (  # noqa: E402  (re-exported for the tests: __all__)
    APP_JS, DASHBOARD, JS_FILES, NODE, _block_end, js_closure, js_eval, js_source,
)

__all__ = ["APP_JS", "DASHBOARD", "JS_FILES", "NODE", "ROOT", "_block_end", "js_closure", "js_eval", "js_source"]
