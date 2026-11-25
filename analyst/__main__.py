"""python3 -m analyst list | check [--local] [--ref REF] | export NAME OUT.csv [--local] [--ref REF]"""

import argparse
import csv
import sys

from .loader import REGISTRY, datasets, snapshot


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python3 -m analyst")
    ap.add_argument("command", choices=["list", "check", "export"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--ref", default=None, help="branch, SHA or YYYY-MM-DD (as of 23:59 IST)")
    ap.add_argument("--local", action="store_true", help="read this clone instead of GitHub")
    a = ap.parse_args(argv)

    if a.command == "list":
        for name, desc in datasets().items():
            print(f"{name:32} {desc}")
        return 0

    snap = snapshot(a.ref, "local" if a.local else "github")
    print(snap, file=sys.stderr)
    if a.command == "check":
        names = list(REGISTRY) + ["intraday_5m"] + [f"options:{s}" for s in snap.options_symbols()]
        bad = 0
        for name in names:
            try:
                ds = snap.load(name)
            except FileNotFoundError as exc:
                optional = REGISTRY.get(name, {}).get("optional")
                print(f"{'skip' if optional else 'MISSING':8} {name}: {exc}")
                bad += 0 if optional else 1
                continue
            m = ds.meta
            print(f"{'ok':8} {name:32} {m['rows']:>8} rows  {m['first_date'] or '':>10} … {m['last_date'] or '':10}")
        return 1 if bad else 0

    if not (a.name and a.out):
        ap.error("export needs NAME and OUT.csv")
    ds = snap.load(a.name)
    with open(a.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=ds.columns)
        w.writeheader()
        for r in ds.rows:
            w.writerow({k: (";".join(map(str, v)) if isinstance(v, list) else v) for k, v in r.items()})
    print(f"{len(ds)} rows → {a.out} (commit {ds.meta['commit'][:8]})", file=sys.stderr)
    for c in ds.meta["caveats"]:
        print(f"  caveat: {c}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
