"""
Fail if the JS take rates in dashboard/api/revenue.js drift from
scripts/take_rates.py (the Python source of truth).

Run: python scripts/check_take_rates.py
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import take_rates as tr

JS_FILE = Path(__file__).parent.parent / "dashboard" / "api" / "revenue.js"

EXPECTED = {
    "TR_FUT_NSE":  tr.NSE_TR_FUT,
    "TR_OPT_NSE":  tr.NSE_TR_OPT,
    "TR_CASH_NSE": tr.NSE_TR_CASH,
    "TR_OPT_BSE":  tr.BSE_TR_OPT,
    "TR_CASH_BSE": tr.BSE_TR_CASH,
}


def main():
    js = JS_FILE.read_text()
    bad = []
    for name, want in EXPECTED.items():
        m = re.search(rf"const {name}\s*=\s*([\d.]+)\s*/\s*100\s*\*\s*2\s*;", js)
        if not m:
            bad.append(f"{name}: not found in {JS_FILE.name}")
            continue
        got = float(m.group(1)) / 100 * 2
        if abs(got - want) > 1e-12:
            bad.append(f"{name}: revenue.js {got:.4e} != take_rates.py {want:.4e}")
    if bad:
        print("Take-rate drift:\n  " + "\n  ".join(bad))
        sys.exit(1)
    print(f"Take rates consistent ({len(EXPECTED)} checked)")


if __name__ == "__main__":
    main()
