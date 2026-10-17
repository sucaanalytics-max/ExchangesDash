"""
Fail if the JS expiry calendar (const EXPIRY_RULES in dashboard/app.js) drifts
from scripts/expiry_calendar.py (the Python source of truth), or if the Python
table itself is malformed: per exchange the rules must be sorted, contiguous
(no gap, no overlap), open-ended at both ends, and change only on week edges
(effective_from a Monday, effective_to a Sunday) so every week has exactly one
scheduled expiry day.

Run: python scripts/check_expiry_calendar.py
"""

import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import expiry_calendar as ec

JS_FILE = Path(__file__).parent.parent / "dashboard" / "app.js"
FIELDS = ("exchange", "effective_from", "effective_to", "weekday")


def js_rules(js: str):
    m = re.search(r"const EXPIRY_RULES\s*=\s*\[(.*?)\];", js, re.S)
    if not m:
        return None
    rules = []
    for body in re.findall(r"\{([^{}]*)\}", m.group(1)):
        rule = {}
        for key, val in re.findall(r"(\w+)\s*:\s*(null|'[^']*'|\"[^\"]*\")", body):
            rule[key] = None if val == "null" else val[1:-1]
        rules.append(rule)
    return rules


def table_problems():
    bad = []
    for r in ec.EXPIRY_RULES:
        if r["weekday"] not in ec.WEEKDAY_NAMES[:5]:
            bad.append(f"{r}: weekday must be Monday–Friday")
        if not r.get("source"):
            bad.append(f"{r['exchange']} {r['effective_from']}: missing source note")
    for ex in sorted({r["exchange"] for r in ec.EXPIRY_RULES}):
        rules = [r for r in ec.EXPIRY_RULES if r["exchange"] == ex]
        if rules[0]["effective_from"] is not None or rules[-1]["effective_to"] is not None:
            bad.append(f"{ex}: first rule must start open (None) and last must end open (None)")
        for r in rules:
            f, t = r["effective_from"], r["effective_to"]
            if f is not None and date.fromisoformat(f).weekday() != 0:
                bad.append(f"{ex}: effective_from {f} is not a Monday")
            if t is not None and date.fromisoformat(t).weekday() != 6:
                bad.append(f"{ex}: effective_to {t} is not a Sunday")
        for a, b in zip(rules, rules[1:]):
            if a["effective_to"] is None or b["effective_from"] is None or (
                    date.fromisoformat(a["effective_to"]) + timedelta(days=1)
                    != date.fromisoformat(b["effective_from"])):
                bad.append(f"{ex}: rules not contiguous at {a['effective_to']} / {b['effective_from']}")
    return bad


def main():
    bad = table_problems()
    got = js_rules(JS_FILE.read_text())
    want = [{k: r[k] for k in FIELDS} for r in ec.EXPIRY_RULES]
    if got is None:
        bad.append(f"const EXPIRY_RULES not found in {JS_FILE.name}")
    elif got != want:
        bad.append(f"{JS_FILE.name} EXPIRY_RULES != expiry_calendar.py EXPIRY_RULES")
        for i in range(max(len(got), len(want))):
            g = got[i] if i < len(got) else None
            w = want[i] if i < len(want) else None
            if g != w:
                bad.append(f"  rule {i}: app.js {g} vs python {w}")
    if bad:
        print("Expiry calendar problems:\n  " + "\n  ".join(bad))
        sys.exit(1)
    print(f"Expiry calendar consistent ({len(want)} rules checked)")


if __name__ == "__main__":
    main()
