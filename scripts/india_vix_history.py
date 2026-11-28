#!/usr/bin/env python3
"""India VIX daily closes over the last 10 years, with their mean and standard
deviation, for Revenue Summary's "India VIX: 10-year mean ± σ" panel
(dashboard/js/25-vix-history.js).

Source: Yahoo Finance ^INDIAVIX (yfinance), the same feed nse_pipeline.py uses
for each NSE row's `vix`, which only reaches back to the start of the NSE daily
files (Apr 2023). Run by the nse-update job in exchange-update.yml after the NSE
pipeline, every slot; the file is rewritten only when its closes change.

Window: closes dated after the same calendar day WINDOW_YEARS before the latest
close (2016-11-26 < date <= 2026-11-26). Before 16:00 IST today's bar is a last
traded price, not a close, and is left out (share_regression.drop_unfinished_session).
Mean and σ are over every close in the window; σ is the sample standard
deviation (n − 1, Excel's STDEV.S). z = (close − mean) ÷ σ.

Output: dashboard/data/india_vix_history.json
  {source, window_years, from, to, stats: {n, mean, sd, latest: {date, vix, z,
   pct_below}}, daily: [[date, close], …]}   (one row per line)
A failed or short fetch keeps the file as it is (exit 0; the job goes on).
"""

import json
import math
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import share_regression as sr

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "data" / "india_vix_history.json"
TICKER = "^INDIAVIX"
WINDOW_YEARS = 10
# A 10-year window holds about 2,450 sessions; fewer than this means Yahoo
# served a partial history, which must not replace a good file
MIN_ROWS = 2000


def years_before(d, years):
    """The same calendar day `years` earlier (29 Feb → 28 Feb)."""
    try:
        return d.replace(year=d.year - years)
    except ValueError:
        return d.replace(year=d.year - years, day=28)


def clean_closes(pairs):
    """{date: close} from (date string, close) pairs: closes that are finite and
    > 0, rounded to 4 places; a later pair for the same date wins."""
    out = {}
    for d, v in pairs:
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v) and v > 0:
            out[str(d)[:10]] = round(v, 4)
    return out


def trim_window(closes, years=WINDOW_YEARS):
    """Sorted [(date, close)] dated after the same day `years` before the latest."""
    if not closes:
        return []
    latest = date.fromisoformat(max(closes))
    start = years_before(latest, years).isoformat()
    return sorted((d, v) for d, v in closes.items() if d > start)


def vix_stats(rows):
    """{n, mean, sd, latest: {date, vix, z, pct_below}} over sorted [(date, close)].
    sd is the sample standard deviation (n − 1); z and pct_below (the share of
    the window's closes below the latest) are None where they can't be worked
    out (fewer than 2 closes, or σ 0)."""
    vals = [v for _, v in rows]
    n = len(vals)
    if not n:
        return {"n": 0, "mean": None, "sd": None, "latest": None}
    mean = sum(vals) / n
    sd = math.sqrt(sum((v - mean) ** 2 for v in vals) / (n - 1)) if n > 1 else None
    d, last = rows[-1]
    z = (last - mean) / sd if sd else None
    pct_below = sum(1 for v in vals if v < last) / n
    return {
        "n": n,
        "mean": round(mean, 4),
        "sd": None if sd is None else round(sd, 4),
        "latest": {"date": d, "vix": last, "z": None if z is None else round(z, 4),
                   "pct_below": round(pct_below, 4)},
    }


def build_doc(rows, years=WINDOW_YEARS):
    return {
        "source": f"Yahoo Finance {TICKER} (yfinance), daily close",
        "window_years": years,
        "from": rows[0][0] if rows else None,
        "to": rows[-1][0] if rows else None,
        "stats": vix_stats(rows),
        "daily": [[d, v] for d, v in rows],
    }


def dumps_doc(doc):
    """JSON with each daily row on its own line, so a day's update is a small diff."""
    head = {k: v for k, v in doc.items() if k != "daily"}
    lines = ",\n".join("  " + json.dumps(r, separators=(",", ":")) for r in doc["daily"])
    body = json.dumps(head, indent=1, allow_nan=False)
    return body[:-2] + ',\n "daily": [\n' + lines + "\n ]\n}\n"


def fetch_closes(now=None):
    """{date: close} for ^INDIAVIX from a little over WINDOW_YEARS ago, today's
    unfinished bar left out."""
    import yfinance as yf
    now = now or datetime.now(timezone.utc)
    start = years_before(now.date(), WINDOW_YEARS) - timedelta(days=10)
    hist = yf.Ticker(TICKER).history(start=start.isoformat(), interval="1d", auto_adjust=False)
    closes = clean_closes((str(idx.date()), row["Close"]) for idx, row in hist.iterrows())
    closes, dropped = sr.drop_unfinished_session(closes, now)
    if dropped:
        print(f"Left out today's unfinished bar (before 16:00 IST): {dropped}")
    return closes


def main(out=OUT):
    try:
        closes = fetch_closes()
    except Exception as e:  # network, Yahoo, yfinance: never fail the NSE job
        print(f"::warning::India VIX history not updated: {e}")
        return 0
    rows = trim_window(closes)
    if len(rows) < MIN_ROWS:
        print(f"::warning::India VIX history not updated: only {len(rows)} closes from Yahoo (need {MIN_ROWS})")
        return 0
    doc = build_doc(rows)
    if out.exists():
        try:
            old = json.loads(out.read_text())
        except ValueError:
            old = None
        if old and (old.get("to") or "") > doc["to"]:
            print(f"::warning::India VIX history not updated: Yahoo's latest close {doc['to']} is older than the file's {old['to']}")
            return 0
        if old == json.loads(dumps_doc(doc)):
            print(f"India VIX history unchanged ({doc['from']} → {doc['to']}, {len(rows)} closes)")
            return 0
    out.write_text(dumps_doc(doc))
    s = doc["stats"]
    print(f"India VIX history: {len(rows)} closes {doc['from']} → {doc['to']}; mean {s['mean']:.2f}, "
          f"σ {s['sd']:.2f}; latest {s['latest']['vix']:.2f} (z {s['latest']['z']:+.2f})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
