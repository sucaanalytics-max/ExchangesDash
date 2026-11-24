"""Five-minute share-price bars for the listed capital-market stocks, saved after each session.

The signal book's intraday test (do the live revenue polls lead intraday share moves?)
needs months of 5-minute prices, and Yahoo keeps 5-minute bars for only about 60 days,
so they are saved as they come. Each run reads the last --days days of bars (default 7,
so a missed run is caught up by the next; at most 59) for every symbol in SYMBOLS and
adds each (session, symbol) not yet stored to data/intraday/5m/YYYY-MM.csv, one file per
month. A stored (session, symbol) is never rewritten. Today's bars are stored only from
16:00 IST, once the session's last bar (15:25) is final.

Columns: ts (bar start, IST, "YYYY-MM-DD HH:MM"), symbol (Yahoo's), open, high, low,
close (2 dp, as traded: not adjusted for splits or dividends), volume (shares; 0 for the
indices, and Yahoo gives most stocks' 09:15 bar a volume of 0). Thinly traded stocks have
no bar for five minutes without a trade, so their sessions can have fewer than 75 bars.
Rows are sorted by ts, then symbol.

    python scripts/intraday_prices.py [--days N] [--out DIR] [--dry-run]

In GitHub Actions it writes added_sessions (distinct sessions with new rows), added_rows
and latest (the newest session added) to $GITHUB_OUTPUT for the commit message.
"""
import argparse
import csv
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, time, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))
OUT_DIR = Path(__file__).resolve().parent.parent / "data" / "intraday" / "5m"
COLUMNS = ["ts", "symbol", "open", "high", "low", "close", "volume"]
SESSION_FINAL = time(16, 0)          # IST; the last 5-minute bar starts at 15:25
MAX_DAYS = 59                        # Yahoo serves 5-minute bars for the last 60 days

# The signal book's universe (its research/data.py), in groups.
SYMBOLS = [
    # exchanges (NSE trades only on BSE)
    "BSE.NS", "MCX.NS", "NSE.BO",
    # depositories and registrars
    "CDSL.NS", "CAMS.NS", "KFINTECH.NS",
    # brokers and wealth
    "ANGELONE.NS", "GROWW.NS", "MOTILALOFS.NS", "IIFLCAPS.NS", "5PAISA.NS", "NUVAMA.NS",
    "ANANDRATHI.NS", "360ONE.NS",
    # asset managers
    "HDFCAMC.NS", "NAM-INDIA.NS", "ICICIAMC.NS", "SBIFUNDS.NS", "UTIAMC.NS", "ABSLAMC.NS",
    "CRAMC.NS",
    # benchmarks
    "^NSEI", "^NSEBANK", "^INDIAVIX",
]


def _num(x):
    """A float, or None for a missing value (NaN / None)."""
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) else x


def bars_from_frame(frame, symbol):
    """Rows (ts, symbol, open, high, low, close, volume) from one symbol's yfinance frame
    (tz-aware index; Open/High/Low/Close/Volume columns), skipping bars with no close."""
    rows = []
    cols = [frame[c] for c in ("Open", "High", "Low", "Close", "Volume")]
    for ts, o, h, lo, c, v in zip(frame.index, *cols):
        o, h, lo, c, v = (_num(x) for x in (o, h, lo, c, v))
        if c is None:
            continue
        o, h, lo = (c if x is None else x for x in (o, h, lo))
        rows.append((ts.astimezone(IST).strftime("%Y-%m-%d %H:%M"), symbol,
                     f"{o:.2f}", f"{h:.2f}", f"{lo:.2f}", f"{c:.2f}", str(int(v or 0))))
    return rows


def final_only(rows, now_ist):
    """Drop bars of a session that may still change: today's before 16:00 IST, and any later."""
    today = now_ist.strftime("%Y-%m-%d")
    cutoff = today if now_ist.time() >= SESSION_FINAL else None
    return [r for r in rows if r[0][:10] < today or (cutoff and r[0][:10] == cutoff)]


def month_path(out_dir, session):
    return Path(out_dir) / f"{session[:7]}.csv"


def read_month(path):
    path = Path(path)
    if not path.exists():
        return []
    with path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header != COLUMNS:
            raise ValueError(f"{path}: unexpected header {header}")
        return [tuple(r) for r in reader if r]


def merge(existing, new):
    """Existing rows plus the new rows of every (session, symbol) not stored yet.
    Returns (all rows sorted by ts then symbol, rows added)."""
    stored = {(r[0][:10], r[1]) for r in existing}
    added, bars = [], set()
    for r in new:
        if (r[0][:10], r[1]) in stored or (r[0], r[1]) in bars:
            continue
        bars.add((r[0], r[1]))
        added.append(r)
    return sorted(list(existing) + added, key=lambda r: (r[0], r[1])), added


def write_month(path, rows):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(COLUMNS)
        w.writerows(rows)
    tmp.replace(path)


def retry_periods(days):
    """Periods to ask a symbol for on its own after the batch missed it, longest first:
    Yahoo refuses some symbols a period that, counted its way, starts over 60 days back
    (NSE.BO at 59 days in Nov 2026, when its listing was 61 days old)."""
    return sorted({days, min(days, 30), min(days, 7)}, reverse=True)


def fetch(symbols, days):
    """{symbol: rows} from Yahoo's 5-minute bars over the last `days` days. A symbol the
    batch download misses is asked for again on its own, at retry_periods(days)."""
    import yfinance as yf

    def download(syms, days=days):
        df = yf.download(syms, period=f"{days}d", interval="5m", group_by="ticker",
                         auto_adjust=False, prepost=False, progress=False, threads=True)
        out = {}
        for s in syms:
            try:
                sub = df[s] if len(syms) > 1 or s in df.columns.get_level_values(0) else df
            except (KeyError, AttributeError):
                continue
            rows = bars_from_frame(sub, s)
            if rows:
                out[s] = rows
        return out

    got = download(list(symbols))
    for s in [s for s in symbols if s not in got]:
        for d in retry_periods(days):
            try:
                got.update(download([s], d))
            except Exception as exc:  # one bad symbol must not stop the rest
                print(f"  {s} ({d}d): {exc}", file=sys.stderr)
            if s in got:
                if d < days:
                    print(f"  {s}: only {d} days served")
                break
    return got


def save(rows, out_dir, dry_run=False):
    """Merge rows into their month files. Returns the rows added."""
    by_month = defaultdict(list)
    for r in rows:
        by_month[month_path(out_dir, r[0])].append(r)
    added_all = []
    for path, new in sorted(by_month.items()):
        merged, added = merge(read_month(path), new)
        if added and not dry_run:
            write_month(path, merged)
        added_all += added
    return added_all


def summarise(added):
    per = defaultdict(lambda: defaultdict(int))
    for r in added:
        per[r[0][:10]][r[1]] += 1
    for session in sorted(per):
        syms = per[session]
        print(f"  {session}: {len(syms)} symbols, {sum(syms.values())} bars")
    return sorted(per)


def write_outputs(**kv):
    path = os.environ.get("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=7, help=f"days of bars to read (1–{MAX_DAYS})")
    ap.add_argument("--out", default=str(OUT_DIR), help="folder for the month files")
    ap.add_argument("--dry-run", action="store_true", help="read and report, write nothing")
    a = ap.parse_args(argv)
    days = max(1, min(a.days, MAX_DAYS))
    now = datetime.now(IST)

    got = fetch(SYMBOLS, days)
    missing = [s for s in SYMBOLS if s not in got]
    print(f"Read {days} days of 5-minute bars: {len(got)} of {len(SYMBOLS)} symbols"
          + (f"; none for {', '.join(missing)}" if missing else ""))
    if not got:
        print("::error::Yahoo returned no bars for any symbol", file=sys.stderr)
        return 1

    rows = final_only([r for s in got for r in got[s]], now)
    added = save(rows, a.out, a.dry_run)
    sessions = summarise(added)
    print(f"{'Would add' if a.dry_run else 'Added'} {len(added)} bars over {len(sessions)} session(s)"
          f" to {a.out}")
    write_outputs(added_sessions=len(sessions), added_rows=len(added),
                  latest=sessions[-1] if sessions else "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
