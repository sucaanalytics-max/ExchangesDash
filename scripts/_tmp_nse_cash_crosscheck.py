"""TEMPORARY (removed before the PR): cross-check NSE cash-market traded value
for days whose stored figure is missing or disputed, using NSE files other than
the business-growth archive (historicalOR/cm/tbg) that nse_pipeline.py reads.

Read-only: GETs from NSE, prints what it finds, writes nothing."""

import csv
import io
import json
import sys
import time
import zipfile
from collections import defaultdict
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import nse_pipeline as nse  # noqa: E402

TARGETS = ["2023-08-07", "2023-08-08", "2023-08-09", "2023-08-11", "2023-08-14",
           "2025-06-13", "2025-12-15"]
# Days whose stored value NSE's archive matched on 2026-11-02 (calibration)
CONTROLS = ["2023-08-04", "2023-08-10", "2023-08-16", "2025-06-12", "2025-06-16",
            "2025-12-11", "2025-12-12"]
ARCH = "https://nsearchives.nseindia.com"
KEYWORDS = ("traded value", "turnover", "trades", "quantity", "securities", "capital market",
            "equity", "total")


def get(session, url):
    try:
        r = session.get(url, impersonate="chrome", timeout=40)
        print(f"  GET {url} -> {r.status_code}, {len(r.content)} bytes")
        time.sleep(0.8)
        return r.content if r.status_code == 200 else None
    except Exception as e:
        print(f"  GET {url} -> ERROR {e}")
        return None


def unzip_first_csv(blob):
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return z.read(name).decode("utf-8", "replace")


def by_series(rows, series_key, value_key, value_div, qty_key, trades_key):
    agg = defaultdict(lambda: [0, 0.0, 0, 0])   # rows, value Cr, qty, trades
    for r in rows:
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        s = r.get(series_key, "?")
        try:
            agg[s][0] += 1
            agg[s][1] += float(r.get(value_key) or 0) / value_div
            agg[s][2] += int(float(r.get(qty_key) or 0))
            agg[s][3] += int(float(r.get(trades_key) or 0))
        except ValueError:
            continue
    return agg


def report(label, agg):
    total = [sum(v[i] for v in agg.values()) for i in range(4)]
    print(f"  {label}: ALL series value={total[1]:.2f} Cr qty={total[2]} trades={total[3]} rows={total[0]}")
    for s, v in sorted(agg.items(), key=lambda kv: -kv[1][1]):
        if v[1] >= 0.5:
            print(f"    {s:>4} rows={v[0]:>5} value={v[1]:>12.2f} qty={v[2]:>12} trades={v[3]:>10}")
    return {s: [round(v[1], 4), v[2], v[3], v[0]] for s, v in agg.items()}


def ma_report(session, d):
    blob = get(session, f"{ARCH}/archives/equities/mkt/MA{d:%d%m%y}.csv")
    if not blob:
        return None
    text = blob.decode("utf-8", "replace")
    lines = [ln.rstrip() for ln in text.splitlines()]
    print("  MA report, first 40 lines:")
    for ln in lines[:40]:
        print(f"    | {ln}")
    hits = [ln for ln in lines[40:] if any(k in ln.lower() for k in KEYWORDS)]
    if hits:
        print("  MA report, later keyword lines:")
        for ln in hits[:40]:
            print(f"    | {ln}")
    return lines[:40]


def udiff(session, d):
    blob = get(session, f"{ARCH}/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip")
    if not blob:
        return None
    rows = list(csv.DictReader(io.StringIO(unzip_first_csv(blob))))
    return report("UDiFF bhavcopy", by_series(rows, "SctySrs", "TtlTrfVal", 1e7, "TtlTradgVol",
                                               "TtlNbOfTxsExctd"))


def legacy(session, d):
    mon = d.strftime("%b").upper()
    blob = get(session, f"{ARCH}/content/historical/EQUITIES/{d:%Y}/{mon}/cm{d:%d}{mon}{d:%Y}bhav.csv.zip")
    if not blob:
        return None
    rows = list(csv.DictReader(io.StringIO(unzip_first_csv(blob))))
    return report("legacy bhavcopy", by_series(rows, "SERIES", "TOTTRDVAL", 1e7, "TOTTRDQTY", "TOTALTRADES"))


def bhavdata_full(session, d):
    blob = get(session, f"{ARCH}/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv")
    if not blob:
        return None
    rows = list(csv.DictReader(io.StringIO(blob.decode("utf-8", "replace"))))
    return report("sec_bhavdata_full", by_series(rows, "SERIES", "TURNOVER_LACS", 100, "TTL_TRD_QNTY",
                                                  "NO_OF_TRADES"))


def main():
    session = nse.nse_session()
    print("\n=== NSE business-growth archive (historicalOR/cm/tbg), raw records ===")
    tbg = {}
    for y, m in ((2023, 8), (2025, 6), (2025, 12)):
        try:
            for rec in nse.fetch_cm_month(session, datetime(y, m, 1)):
                d = rec.get("data", rec)
                p = nse.parse_cm_record(rec)
                tbg[p["date"]] = {k: d.get(k) for k in ("CDT_TRADES_VALUES", "CDT_NOS_OF_TRADES",
                                                        "CDT_TRADES_QTY", "CDT_NOS_OF_SECURITY_TRADES")}
        except Exception as e:
            print(f"tbg {y}-{m:02d} failed: {e}")
        time.sleep(1)
    for k in sorted(tbg):
        print(f"  tbg {k} {tbg[k]}")

    summary = {}
    for ds in TARGETS + CONTROLS:
        d = datetime.strptime(ds, "%Y-%m-%d")
        kind = "TARGET" if ds in TARGETS else "CONTROL"
        print(f"\n=== {ds} ({kind}) tbg={tbg.get(ds)} ===")
        out = {"kind": kind, "tbg": tbg.get(ds)}
        out["ma_head"] = ma_report(session, d) is not None
        out["udiff"] = udiff(session, d)
        out["legacy"] = legacy(session, d)
        out["full"] = bhavdata_full(session, d)
        summary[ds] = out

    print("\n=== SUMMARY JSON ===")
    for ds, out in summary.items():
        print("SUMMARY " + json.dumps({"date": ds, **out}, separators=(",", ":")))


if __name__ == "__main__":
    main()
