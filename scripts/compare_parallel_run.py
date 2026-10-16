"""
Parallel-run parity check: ExchangesDash (new) vs Research-Tusk/nse-cloud-pipeline (old).

During the side-by-side period the new repo runs without Supabase credentials
(shadow mode: it fetches from the exchanges and writes JSON only), so the old
repo stays the single Supabase writer. This script compares the two repos'
committed JSON on main and checks the new repo's data for integrity problems.
Read-only; delete it once the old repo is retired.

    python3 scripts/compare_parallel_run.py            # exit 1 on any daily mismatch
    python3 scripts/compare_parallel_run.py --days 10  # compare only the last 10 dates
"""

import argparse
import json
import sys
import urllib.request
from collections import Counter
from datetime import date

NEW = "https://raw.githubusercontent.com/sucaanalytics-max/ExchangesDash/main/dashboard/data"
OLD = "https://raw.githubusercontent.com/Research-Tusk/nse-cloud-pipeline/main/dashboard/data"
EXCHANGES = ("nse", "bse", "mcx")
TOLERANCE_CR = 0.005   # revenue fields are rounded to 4 dp in ₹ Cr
# Weekend sessions that really traded (Muhurat, special live/DR sessions, Budget days)
SPECIAL_SESSIONS = {"2023-11-12", "2024-01-20", "2024-03-02", "2024-05-18", "2025-02-01", "2026-02-01"}


def fetch(base, name):
    req = urllib.request.Request(f"{base}/{name}", headers={"User-Agent": "parallel-run-check"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def rev_fields(row):
    return [k for k in row if k.endswith("_rev")]


def integrity(ex, rows):
    """Problems in one repo's daily series that would be data corruption."""
    issues = []
    dups = [d for d, c in Counter(r["date"] for r in rows).items() if c > 1]
    if dups:
        issues.append(f"duplicate dates {dups[:5]}")
    weekend = [r["date"] for r in rows
               if date.fromisoformat(r["date"]).weekday() > 4 and r["date"] not in SPECIAL_SESSIONS]
    if weekend:
        issues.append(f"weekend dates {weekend[-5:]}")
    recent = rows[-60:]
    if ex != "mcx":  # MCX has no cash segment
        zero_cash = [r["date"] for r in recent if not float(r.get("cash_rev") or 0)]
        if zero_cash:
            issues.append(f"cash_rev = 0 in last 60 days {zero_cash}")
    zero_total = [r["date"] for r in recent if not float(r.get("total_rev") or 0)]
    if zero_total:
        issues.append(f"total_rev = 0 in last 60 days {zero_total}")
    return issues


def compare_daily(ex, days):
    name = f"{ex}_dashboard_data.json"
    new_rows = fetch(NEW, name)["daily_all"]
    old_rows = fetch(OLD, name)["daily_all"]
    new_by, old_by = {r["date"]: r for r in new_rows}, {r["date"]: r for r in old_rows}
    dates = sorted(set(new_by) | set(old_by))[-days:]

    only_new = [d for d in dates if d not in old_by]
    only_old = [d for d in dates if d not in new_by]
    diffs = []
    for d in dates:
        if d in new_by and d in old_by:
            for k in rev_fields(old_by[d]):
                a, b = float(new_by[d].get(k) or 0), float(old_by[d].get(k) or 0)
                if abs(a - b) > TOLERANCE_CR:
                    diffs.append(f"{d} {k}: new {a:.4f} vs old {b:.4f}")

    ok = not (only_new or only_old or diffs)
    print(f"[{'OK ' if ok else 'DIFF'}] {ex} daily: new last {new_rows[-1]['date']} ({len(new_rows)} rows), "
          f"old last {old_rows[-1]['date']} ({len(old_rows)} rows), compared {len(dates)} dates")
    for label, items in (("only in new", only_new), ("only in old", only_old), ("value diffs", diffs)):
        if items:
            print(f"       {label}: {items[:10]}{' …' if len(items) > 10 else ''}")
    for issue in integrity(ex, new_rows):
        print(f"       new-repo integrity: {issue}")
    return ok


def compare_live(ex):
    new, old = fetch(NEW, f"{ex}_live.json"), fetch(OLD, f"{ex}_live.json")
    line = f"[INFO] {ex} live: new updated {new.get('updated_at')} | old updated {old.get('updated_at')}"
    nr, orv = new.get("revenue") or {}, old.get("revenue") or {}
    if nr or orv:
        line += (f" | trade_date new {nr.get('trade_date')} old {orv.get('trade_date')}"
                 f" | total_revenue new {nr.get('total_revenue')} old {orv.get('total_revenue')}")
    print(line)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="compare the most recent N dates (default 30)")
    args = ap.parse_args()

    ok = all([compare_daily(ex, args.days) for ex in EXCHANGES])
    for ex in EXCHANGES:
        compare_live(ex)
    print("PARITY OK" if ok else "PARITY MISMATCH — see DIFF lines above")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
