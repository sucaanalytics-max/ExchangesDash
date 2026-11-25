"""Daily closes of NSE stock futures and options for the listed exchanges, kept for backtests.

The exchange trading-logic tree (sell puts between bear and base, sell calls at base, futures
at bear) is backtested on real premiums by scripts/signal_tree_backtest.py, and NSE keeps no
per-contract history in a form we can query later, so each day's contracts are saved here.

Source: NSE's F&O bhavcopy in the UDiFF layout,
nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip (plain GET,
no cookies; served from at least 1 Apr 2024). FinInstrmTp STF = stock future, STO = stock
option; TtlTradgVol is contracts (lots) and TtlTrfVal is ₹ notional, for options
(strike + premium) × lot × contracts. Untraded contracts still carry ClsPric (the previous
close) and SttlmPric, NSE's theoretical settlement price.

For each symbol in SYMBOLS it keeps every future, and options of the two nearest expiries
(counting the trade date's own) with strikes within STRIKE_BAND of the underlying, in
data/options/<SYMBOL>/YYYY-MM.csv (repo root, like data/intraday/), one file per month:

    date, type (FUT / CE / PE), expiry, strike (0 for futures), open, high, low, close,
    settle, contracts, oi, underlying, lot

Prices are as traded: not adjusted for splits or bonuses (MCX's underlying read 5,828 on
1 Oct 2024); a backtest scales them by the share-price series' own adjustment. A stored day is
never rewritten. Trading days come from the NSE dashboard JSON; a day NSE has not posted
within PENDING_DAYS goes under `unavailable` in data/options/unavailable.json and is asked
again only with --retry. A symbol missing from a day's file (BSE before it joined F&O) is
simply absent that day.

    python scripts/stock_options_history.py [--from YYYY-MM-DD] [--max-days N] [--retry] [--dry-run]

In GitHub Actions it writes added_days, added_rows and latest to $GITHUB_OUTPUT.
"""
import argparse
import csv
import io
import json
import os
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "options"
UNAVAILABLE_PATH = OUT_DIR / "unavailable.json"
NSE_DATES_PATH = ROOT / "dashboard" / "data" / "nse_dashboard_data.json"
URL = ("https://nsearchives.nseindia.com/content/fo/"
       "BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip")

SYMBOLS = ("BSE", "MCX")
HISTORY_START = date(2024, 4, 1)
STRIKE_BAND = 0.25          # options with strikes within ±25 % of the underlying
OPTION_EXPIRIES = 2         # nearest expiries kept for options
MAX_DAYS = 40               # days fetched per run (newest missing first)
PENDING_DAYS = 4            # a 404 this recent is "not posted yet", older is unavailable
PAUSE_S = 0.3
STOP_STATUSES = (401, 403, 429)
COLUMNS = ["date", "type", "expiry", "strike", "open", "high", "low", "close", "settle",
           "contracts", "oi", "underlying", "lot"]
INSTRUMENT = {"STF": "FUT", "STO": None}   # STO: CE / PE from OptnTp


class FetchError(Exception):
    def __init__(self, msg, refused=False):
        super().__init__(msg)
        self.refused = refused


def _f(x):
    try:
        return float(str(x).replace(",", "").strip() or 0)
    except ValueError:
        return 0.0


def _num(x):
    """Compact text for a price: no trailing zeros."""
    v = round(_f(x), 2)
    return str(int(v)) if v == int(v) else f"{v:.2f}".rstrip("0")


def parse_bhavcopy(zip_bytes, symbols=SYMBOLS):
    """(trade date ISO, {symbol: [row dict, …]}) from one day's UDiFF F&O bhavcopy zip,
    filtered as described in the module docstring and sorted (type, expiry, strike)."""
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    raw = {s: [] for s in symbols}
    trade_date = None
    for r in csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig")):
        sym = (r.get("TckrSymb") or "").strip()
        if sym not in raw:
            continue
        tp = (r.get("FinInstrmTp") or "").strip()
        if tp not in INSTRUMENT:
            continue
        trade_date = trade_date or (r.get("TradDt") or "").strip()
        kind = INSTRUMENT[tp] or (r.get("OptnTp") or "").strip()
        if kind not in ("FUT", "CE", "PE"):
            continue
        raw[sym].append({
            "date": (r.get("TradDt") or "").strip(),
            "type": kind,
            "expiry": (r.get("XpryDt") or "").strip(),
            "strike": _num(r.get("StrkPric")) if kind != "FUT" else "0",
            "open": _num(r.get("OpnPric")), "high": _num(r.get("HghPric")),
            "low": _num(r.get("LwPric")), "close": _num(r.get("ClsPric")),
            "settle": _num(r.get("SttlmPric")),
            "contracts": str(int(_f(r.get("TtlTradgVol")))),
            "oi": str(int(_f(r.get("OpnIntrst")))),
            "underlying": _num(r.get("UndrlygPric")),
            "lot": str(int(_f(r.get("NewBrdLotQty")))),
        })
    out = {}
    for sym, rows in raw.items():
        if not rows:
            continue
        opt_exp = sorted({r["expiry"] for r in rows if r["type"] != "FUT"})[:OPTION_EXPIRIES]
        keep = []
        for r in rows:
            if r["type"] != "FUT":
                und = _f(r["underlying"])
                if r["expiry"] not in opt_exp or und <= 0:
                    continue
                if abs(_f(r["strike"]) / und - 1) > STRIKE_BAND:
                    continue
            keep.append(r)
        keep.sort(key=lambda r: ({"FUT": 0, "CE": 1, "PE": 2}[r["type"]], r["expiry"], _f(r["strike"])))
        out[sym] = keep
    return trade_date, out


def fetch(session, d):
    """Zip bytes, or None when the day is not posted (404 / not a zip). FetchError otherwise."""
    url = URL.format(ymd=d.strftime("%Y%m%d"))
    try:
        r = session.get(url, timeout=30, headers={"Referer": "https://www.nseindia.com/"})
    except Exception as e:  # curl_cffi raises its own error types
        raise FetchError(f"{type(e).__name__}: {e}") from e
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}", refused=r.status_code in STOP_STATUSES)
    body = r.content or b""
    return body if len(body) >= 64 and body.startswith(b"PK") else None


def make_session():
    from curl_cffi import requests as cffi
    return cffi.Session(impersonate="chrome")


def trading_days(start, today, path=NSE_DATES_PATH):
    """NSE's trading days from `start` to `today` (from the NSE dashboard JSON), plus the
    weekdays after its last date: those may not be in the JSON yet."""
    d = json.loads(Path(path).read_text())
    days = {r["date"] for r in d.get("daily_all") or d.get("daily") or []}
    days |= {r["date"] for r in d.get("special_sessions") or []}
    last = max(days) if days else start.isoformat()
    x = date.fromisoformat(last) + timedelta(days=1)
    while x <= today:
        if x.weekday() < 5:
            days.add(x.isoformat())
        x += timedelta(days=1)
    return sorted(s for s in days if start.isoformat() <= s <= today.isoformat())


def month_path(out_dir, sym, iso):
    return Path(out_dir) / sym / f"{iso[:7]}.csv"


def stored_days(out_dir=OUT_DIR, symbols=SYMBOLS):
    """Dates already fetched: present in any symbol's files. (A day whose file had none of the
    symbols is recorded in unavailable.json's `empty` list instead.)"""
    have = set()
    for sym in symbols:
        for p in sorted((Path(out_dir) / sym).glob("*.csv")):
            with open(p, newline="") as fh:
                have |= {r["date"] for r in csv.DictReader(fh)}
    return have


def load_unavailable(path=UNAVAILABLE_PATH):
    try:
        d = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        d = {}
    return {"unavailable": sorted(set(d.get("unavailable", []))), "empty": sorted(set(d.get("empty", [])))}


def write_day(out_dir, sym, iso, rows):
    """Adds one day's rows to its month file; a day already there is left as it is.
    Returns the rows added."""
    p = month_path(out_dir, sym, iso)
    existing = []
    if p.exists():
        with open(p, newline="") as fh:
            existing = list(csv.DictReader(fh))
    if any(r["date"] == iso for r in existing):
        return 0
    allrows = existing + rows
    allrows.sort(key=lambda r: (r["date"], {"FUT": 0, "CE": 1, "PE": 2}[r["type"]], r["expiry"], _f(r["strike"])))
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(allrows)
    tmp.replace(p)
    return len(rows)


def plan(days, have, unav, retry=False, max_days=MAX_DAYS):
    """Missing days, newest first, at most max_days."""
    skip = set(have) | set(unav["empty"]) | (set() if retry else set(unav["unavailable"]))
    return [d for d in reversed(days) if d not in skip][:max_days]


def run(session, todo, today, out_dir=OUT_DIR, unav=None, symbols=SYMBOLS, pause=time.sleep):
    """Fetches each planned day; returns (added_days, added_rows, latest, unav, refused)."""
    unav = unav or {"unavailable": [], "empty": []}
    added_days, added_rows, latest, refused = 0, 0, None, False
    for iso in todo:
        d = date.fromisoformat(iso)
        try:
            body = fetch(session, d)
        except FetchError as e:
            print(f"  {iso}: {e}")
            if e.refused:
                print("  NSE refused the request — stopping this run")
                refused = True
                break
            continue
        finally:
            pause(PAUSE_S)
        if body is None:
            if (today - d).days > PENDING_DAYS:
                unav["unavailable"] = sorted(set(unav["unavailable"]) | {iso})
                print(f"  {iso}: not posted — marked unavailable")
            else:
                print(f"  {iso}: not posted yet")
            continue
        trade_date, by_sym = parse_bhavcopy(body, symbols)
        if trade_date and trade_date != iso:
            print(f"  {iso}: the file is for {trade_date} — left out")
            unav["unavailable"] = sorted(set(unav["unavailable"]) | {iso})
            continue
        unav["unavailable"] = [x for x in unav["unavailable"] if x != iso]
        if not by_sym:
            unav["empty"] = sorted(set(unav["empty"]) | {iso})
            print(f"  {iso}: none of {', '.join(symbols)} in the file")
            continue
        n = sum(write_day(out_dir, s, iso, rows) for s, rows in by_sym.items())
        added_days += 1
        added_rows += n
        latest = max(latest or iso, iso)
        print(f"  {iso}: " + ", ".join(f"{s} {len(r)}" for s, r in sorted(by_sym.items())))
    return added_days, added_rows, latest, unav, refused


def save_unavailable(unav, path=UNAVAILABLE_PATH):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps({
        "note": "unavailable: trading days NSE served no F&O bhavcopy for (asked again with --retry); "
                "empty: days whose file had none of the symbols (e.g. BSE before it joined F&O, "
                "when MCX was also missing)",
        **unav}, indent=1) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="start", default=HISTORY_START.isoformat())
    ap.add_argument("--max-days", type=int, default=MAX_DAYS)
    ap.add_argument("--retry", action="store_true", help="ask again for days marked unavailable")
    ap.add_argument("--dry-run", action="store_true", help="list the days it would fetch")
    a = ap.parse_args(argv)
    today = datetime.now(timezone(timedelta(hours=5, minutes=30))).date()
    days = trading_days(date.fromisoformat(a.start), today)
    unav = load_unavailable()
    todo = plan(days, stored_days(), unav, a.retry, a.max_days)
    print(f"Stock options history: {len(todo)} day(s) to fetch for {', '.join(SYMBOLS)}")
    if a.dry_run:
        print("  " + " ".join(todo))
        return 0
    added_days, added_rows, latest, unav, refused = run(make_session(), todo, today, unav=unav)
    save_unavailable(unav)
    print(f"Added {added_rows} rows over {added_days} day(s); newest {latest or 'none'}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as fh:
            fh.write(f"added_days={added_days}\nadded_rows={added_rows}\nlatest={latest or ''}\n")
    return 1 if refused and not added_days else 0


if __name__ == "__main__":
    sys.exit(main())
