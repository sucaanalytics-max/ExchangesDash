#!/usr/bin/env python3
"""Monthly participant activity from the participants stores (no network).

Reads dashboard/data/participants_<key>.json (scripts/participants_pipeline.py) and writes
dashboard/data/participants_monthly.json: for each view below, each category's value per
calendar month (daily average, month-end or month sum, as the view says) and its share of the
view's total. It prints a markdown comparison of the latest month against the month before
and the same month of each earlier year — the job summary of the daily workflow.

The stores keep every source's own categories; this report reads them as published. Only
NSE's Market Pulse needs aliases, because its tables renamed categories over the years
(FPI → Foreign Investors, DII → DIIs, PRO → Prop, Individual investors → Individuals).

Usage:  python scripts/participants_report.py [YYYY-MM]   (default: the latest month with data)
"""

import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
OUT_PATH = DATA_DIR / "participants_monthly.json"
YEARS_BACK = 3


def load(key):
    try:
        return json.loads((DATA_DIR / f"participants_{key}.json").read_text())
    except (OSError, ValueError):
        return None


def expand(t):
    return {r: dict(zip(t["fields"], vals)) for r, vals in t["rows"].items()}


def find_table(tables, prefix):
    for title, t in tables.items():
        if title.lower().startswith(prefix.lower()):
            return expand(t)
    return None


def nz(*vals):
    """Sum of the values, None if any is missing."""
    if any(v is None for v in vals):
        return None
    return sum(vals)


# Views: (id, heading, source key, table title prefix, value(row) → number, aggregation, total row, unit)
#   mean  = average over the month's days (flows per day; open interest on an average day)
#   sum   = month total (net flows)
#   last  = the month's last day (open interest at month end)
def contracts_both(r):
    return nz(r.get("Total Long Contracts"), r.get("Total Short Contracts"))


def gross(buy, sell):
    return lambda r: nz(r.get(buy), r.get(sell))


def net(buy, sell):
    return lambda r: None if r.get(buy) is None or r.get(sell) is None else r[buy] - r[sell]


def first_field(*names):
    """The first of `names` a row has (NSE renamed 'Buy Value in Rs.' to 'Buy Value in Rs.Crores')."""
    def get(r):
        return next((r[n] for n in names if n in r), None)
    return get


CM_BUY = first_field("Buy Value in Rs.Crores", "Buy Value in Rs. Crores", "Buy Value in Rs.")
CM_SELL = first_field("Sell Value in Rs.Crores", "Sell Value in Rs. Crores", "Sell Value in Rs.")


def cat_gross(r):
    return nz(CM_BUY(r), CM_SELL(r))


def cat_net(r):
    b, s = CM_BUY(r), CM_SELL(r)
    return None if b is None or s is None else b - s


def V(vid, heading, source, table, value, agg, unit, total_row=None, share=False, rows=None):
    """A view: `table` is a title prefix; `rows(label)` → the label to show, or None to leave the row out."""
    return dict(id=vid, heading=heading, source=source, table=table, value=value, agg=agg, unit=unit,
                total_row=total_row, share=share, rows=rows or (lambda label: label))


def not_total(label):
    return None if label in ("TOTAL", "Total") else label


FII_PRODUCTS = ("INDEX FUTURES", "INDEX OPTIONS", "STOCK FUTURES", "STOCK OPTIONS")   # index rows break these down


def nsdl_asset(label):
    """NSDL: one row per asset class (its sub-total) and the total."""
    if label == "Total":
        return label
    return label[:-len(" · Sub-total")] if label.endswith(" · Sub-total") else None


VIEWS = [
    V("nse_fo_vol", "NSE F&O traded contracts, long + short, daily average", "nse_fo_vol",
      "Participant wise Trading Volume", contracts_both, "mean", "contracts", "TOTAL", True),
    V("nse_fo_oi", "NSE F&O open interest, long + short, average day", "nse_fo_oi",
      "Participant wise Open Interest", contracts_both, "mean", "contracts", "TOTAL", True),
    V("bse_fo_vol", "BSE F&O traded contracts, long + short, daily average", "bse_fo_vol",
      "Participant wise Trading Volume", contracts_both, "mean", "contracts", "Total", True),
    V("bse_fo_oi", "BSE F&O open interest, long + short, average day", "bse_fo_oi",
      "Participant wise Open Interest", contracts_both, "mean", "contracts", "Total", True),
    V("nse_cm_cat_gross", "NSE cash market turnover (buy + sell) by client category, daily average", "nse_cm_cat",
      "Category-wise turnover", cat_gross, "mean", "₹ Cr", share=True),
    V("nse_cm_cat_net", "NSE cash market net buying (buy − sell) by client category, month total", "nse_cm_cat",
      "Category-wise turnover", cat_net, "sum", "₹ Cr"),
    V("nse_fo_cat_gross", "NSE F&O turnover (buy + sell; options on premium) by client category, daily average",
      "nse_fo_cat", "Client Category Wise Turnover", cat_gross, "mean", "₹ Cr", share=True),
    V("bse_fo_cat_gross", "BSE F&O turnover (buy + sell, notional) by category, daily average", "bse_fo_cat",
      "Investor categorywise turnover", gross("Buy (₹ Cr)", "Sell (₹ Cr)"), "mean", "₹ Cr", share=True),
    V("nse_fii_fo_gross", "NSE FII derivatives turnover (buy + sell value), daily average", "nse_fii_fo",
      "FII derivatives statistics", gross("Buy · Amt in Crores", "Sell · Amt in Crores"), "mean", "₹ Cr",
      rows=lambda label: label if label in FII_PRODUCTS else None),
    V("nse_fii_fo_oi", "NSE FII derivatives open interest value, month end", "nse_fii_fo",
      "FII derivatives statistics", lambda r: r.get("Open Interest At The End Of The Day · Amt in Crores"),
      "last", "₹ Cr", rows=lambda label: label if label in FII_PRODUCTS else None),
    V("nsdl_fpi_net", "FPI net investment by asset class (NSDL), month total", "nsdl_fpi", "FPI investment",
      lambda r: r.get("Net Investment (₹ Cr)"), "sum", "₹ Cr", rows=nsdl_asset),
    V("nsdl_fpi_gross", "FPI gross purchases + sales by asset class (NSDL), daily average", "nsdl_fpi",
      "FPI investment", gross("Gross Purchases (₹ Cr)", "Gross Sales (₹ Cr)"), "mean", "₹ Cr", rows=nsdl_asset),
    V("nse_fiidii_net", "FII/FPI and DII net, provisional (NSE + BSE + MSEI), month total", "nse_fiidii",
      "NSE, BSE and MSEI", lambda r: r.get("Net Value (₹ Cr)"), "sum", "₹ Cr"),
    V("bse_cash_cat_gross", "BSE cash market purchase + sale by client type, daily average", "bse_cash_cat",
      "BSE cash market", gross("Purchase (₹ Cr)", "Sale (₹ Cr)"), "mean", "₹ Cr", "Total", True),
]


def month_of(iso):
    return iso[:7]


# Spellings a source has used for one category over the years (compared without case or punctuation):
# NSE's 'RETAIL' / 'Retail', 'AIFs' / 'AIF', 'Insurance' / 'Insurance Companies'; BSE's 'FII/FPI' / 'FII'
LABEL_ALIASES = {"aifs": "aif", "insurance": "insurancecompanies", "fiifpi": "fii"}


def canon(label):
    k = re.sub(r"[^a-z]", "", label.lower())
    return LABEL_ALIASES.get(k, k)


def view_series(view, doc):
    """({category: {month: value}}, {month: days}, {category: {month: share %}}) for one view. A category
    a source spelt differently over time is one series, named as the source names it today."""
    per, days, names = {}, {}, {}
    for rec in (doc or {}).get("days", []):
        t = find_table(rec["tables"], view["table"])
        if not t:
            continue
        m = month_of(rec["date"])
        days[m] = days.get(m, 0) + 1
        for label, row in t.items():
            shown = label if label == view["total_row"] else view["rows"](label)
            v = view["value"](row) if shown else None
            if v is not None:
                key = canon(shown)
                names[key] = shown                 # days run oldest first: the latest spelling wins
                per.setdefault(key, {}).setdefault(m, []).append(v)
    per = {names[k]: v for k, v in per.items()}
    agg = view["agg"]
    series = {cat: {m: round(sum(v) / len(v) if agg == "mean" else sum(v) if agg == "sum" else v[-1], 2)
                    for m, v in months.items()} for cat, months in per.items()}
    shares = {}
    if view["share"]:
        tot_row = view["total_row"]
        for m in sorted({m for s in series.values() for m in s}):
            parts = {c: s[m] for c, s in series.items() if c != tot_row and s.get(m) is not None}
            tot = series.get(tot_row, {}).get(m) if tot_row else sum(parts.values())
            for c, v in parts.items():
                if tot:
                    shares.setdefault(c, {})[m] = round(100 * v / tot, 2)
    return series, days, shares


# ── Market Pulse ───────────────────────────────────────────────

PULSE_SEGMENTS = [   # (canonical name, pattern on the table title)
    ("Cash market", r"cash market|CM segment"),
    ("Equity derivatives (notional)", r"Equity Derivatives segment"),
    ("Equity futures (notional)", r"Equity futures"),
    ("Equity options (premium)", r"Equity options"),
    ("Index futures", r"Index Futures"),
    ("Stock futures", r"Stock Futures"),
    ("Index options (premium)", r"Index Options"),
    ("Stock options (premium)", r"Stock Options"),
    ("Currency derivatives", r"Currency Derivatives"),
    ("Currency futures", r"Currency Futures"),
    ("Currency options", r"Currency Options"),
    ("Interest rate futures", r"Interest Rate Futures"),
    ("Commodity derivatives", r"Commodity derivatives"),
]
PULSE_CATEGORIES = {"dii": "DIIs", "diis": "DIIs", "fpi": "Foreign Investors", "fpis": "Foreign Investors",
                    "foreign investors": "Foreign Investors", "individual investors": "Individuals",
                    "individuals": "Individuals", "pro": "Prop", "prop": "Prop", "corporates": "Corporates",
                    "others": "Others"}


def pulse_month_key(label):
    """'Aug-26' → '2026-08'."""
    m = re.match(r"([A-Z][a-z]{2})-(\d{2})$", label)
    months = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    return f"20{m.group(2)}-{months.index(m.group(1)) + 1:02d}" if m and m.group(1) in months else None


def pulse_series(doc):
    """{segment: {category: {month: share %}}}; a month's value comes from the newest edition giving it."""
    out = {}
    for ed in sorted((doc or {}).get("editions", []), key=lambda e: e["edition"]):
        for title, t in ed["tables"].items():
            seg = next((name for name, pat in PULSE_SEGMENTS if re.search(pat, title, re.I)), None)
            if not seg:
                continue
            sections = {lbl.split(" · ")[0] for lbl in t["rows"] if " · " in lbl}
            for label, vals in t["rows"].items():
                parts = label.split(" · ")
                cat = PULSE_CATEGORIES.get(parts[-1].lower(), parts[-1])
                name = seg
                if seg == "Commodity derivatives" and len(parts) > 1 and len(sections) > 1:
                    name = f"{seg}: {parts[0]}"
                for mlabel, v in vals.items():
                    key = pulse_month_key(mlabel)
                    if key and v is not None:
                        out.setdefault(name, {}).setdefault(cat, {})[key] = v
    return out


# ── Output ─────────────────────────────────────────────────────

def compare_months(latest):
    """The latest month, the one before, and the same month of each of the YEARS_BACK earlier years."""
    y, m = int(latest[:4]), int(latest[5:])
    prev = f"{y - 1}-12" if m == 1 else f"{y}-{m - 1:02d}"
    return [latest, prev] + [f"{y - k}-{m:02d}" for k in range(1, YEARS_BACK + 1)]


def fmt(v, unit):
    if v is None:
        return "—"
    if unit == "%":
        return f"{v:.1f}"
    return f"{v:,.0f}"


def change(a, b, agg):
    """% change of a level; absolute change of a month total (net flows change sign)."""
    if a is None or b is None:
        return "—"
    if agg == "sum":
        return f"{a - b:+,.0f}"
    return "—" if b == 0 else f"{100 * (a / b - 1):+.1f} %"


def label_month(m, days=None):
    d = date(int(m[:4]), int(m[5:]), 1)
    return f"{d:%b %Y}" + (f" ({days}d)" if days else "")


def markdown(doc, latest):
    months = compare_months(latest)
    out = [f"## Participant activity — {label_month(latest)} vs {label_month(months[1])} and "
           f"{', '.join(label_month(m) for m in months[2:])}", "",
           "Daily averages unless the heading says month total or month end. "
           f"{label_month(latest)} is month to date. Shares are of the view's total.", ""]
    for vid, v in doc["views"].items():
        series, days, shares, agg = v["series"], v["days"], v["shares"], v["aggregation"]
        if not any(s.get(latest) is not None for s in series.values()):
            continue
        out += [f"### {v['heading']} ({v['unit']})", "",
                "| Category | " + " | ".join(label_month(m, days.get(m)) for m in months) + " | MoM | YoY |",
                "|---|" + "---:|" * (len(months) + 2)]
        for c, s in series.items():
            share = shares.get(c, {})
            row = [fmt(s.get(m), v["unit"]) + (f" ({share[m]:.1f} %)" if share.get(m) is not None else "")
                   for m in months]
            out.append(f"| {c} | " + " | ".join(row) + f" | {change(s.get(months[0]), s.get(months[1]), agg)} | "
                       f"{change(s.get(months[0]), s.get(months[2]), agg)} |")
        out.append("")
    pulse = doc.get("pulse") or {}
    if pulse:
        last = max(m for seg in pulse.values() for cat in seg.values() for m in cat)
        pm = compare_months(last)
        out += [f"### NSE Market Pulse: share of turnover by client category (%), {label_month(last)} "
                "(published monthly, a month behind)", "",
                "| Segment | Category | " + " | ".join(label_month(m) for m in pm) + " |",
                "|---|---|" + "---:|" * len(pm)]
        for seg in ("Cash market", "Equity futures (notional)", "Equity options (premium)", "Index options (premium)",
                    "Stock futures", "Equity derivatives (notional)"):
            for cat, s in (pulse.get(seg) or {}).items():
                out.append(f"| {seg} | {cat} | " + " | ".join(fmt(s.get(m), "%") for m in pm) + " |")
        out.append("")
    return "\n".join(out)


def build(now_iso):
    views = {}
    for view in VIEWS:
        series, days, shares = view_series(view, load(view["source"]))
        views[view["id"]] = {"heading": view["heading"], "source": view["source"], "aggregation": view["agg"],
                             "unit": view["unit"], "days": dict(sorted(days.items())), "series": series,
                             "shares": shares}
    return {"updated_at": now_iso,
            "notes": ["Monthly views of the participants stores (scripts/participants_report.py). "
                      "Aggregation: mean = average per day of the month, sum = month total, last = month end.",
                      "Market Pulse categories are aliased across editions (FPI → Foreign Investors, DII → DIIs, "
                      "PRO → Prop, Individual investors → Individuals)."],
            "views": views, "pulse": pulse_series(load("nse_pulse"))}


def latest_month(doc):
    months = [m for v in doc["views"].values() for m in v["days"]]
    return max(months) if months else None


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    from mtf_pipeline import write_if_changed
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    doc = build(now_iso)
    write_if_changed(OUT_PATH, doc)
    latest = argv[0] if argv else latest_month(doc)
    if not latest:
        print("No participant data yet.")
        return 0
    md = markdown(doc, latest)
    print(md)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(md + "\n")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
