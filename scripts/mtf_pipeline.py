#!/usr/bin/env python3
"""
Margin trading (MTF) disclosures from NSE and BSE.

Writes, after each daily update:
  dashboard/data/mtf_daily.json          every reporting date: NSE opening / fresh /
                                         liquidated / closing book, BSE amount
                                         financed, and their sum (₹ Cr)
  dashboard/data/mtf_stocks_latest.json  per-security book on the latest date of each
                                         exchange (₹ lakh, as published)
  dashboard/data/nse_mtf_daily.json      NSE's closing book per reporting date ({date,
                                         book_cr}, ₹ Cr): the industry MTF book that the
                                         brokers engine (abiyani-tools/brokersdashboard,
                                         src/live/refresh_market.py) reads from this repo
                                         for Angel One's and Motilal Oswal's MTF revenue
  dashboard/data/mtf_brokers.json        each broker's disclosed MTF book (the hand-kept
                                         register scripts/broker_mtf_register.py) with its
                                         share of the NSE + BSE book on the same date, and
                                         a share-by-quarter table (brokers_doc); the run
                                         also prints the brokers whose next figure is due
  dashboard/data/mtf_broker_live.json    readings of figures brokers keep updating on their
                                         web pages (the register's LIVE_FEEDS: Groww's IR
                                         page), read on each run, one per weekday; a page
                                         that fails or changes layout only warns

Sources (one file per reporting date, published the next trading day):
  NSE  nsearchives.nseindia.com/content/equities/mrg_trading_DDMMYY.zip — a CSV with
       a four-row summary (Rs. lakh) and one row per security. A few days later NSE
       may republish a date with late member submissions: the file then holds two
       blocks side by side ("As on Reporting Date" and "As on Current Date …"), and
       the right-hand, revised block is used.
  BSE  api.bseindia.com …GetMkt_Margin_TradingCSVDwnld_ng — one row per security
       (ISIN, quantity and amount financed, Rs. lakh); its sum is BSE's book. It serves
       days from 2025-10-01; earlier days come from BSE's margin archive
       (…DownloadMarginArch_ng: security code, amount financed, opening / fresh /
       liquidated / closing per security, and a totals row). A row whose identifier is
       not an ISIN (CSV) or a BSE security code (archive) is a totals row: it is kept as
       BSE's published total and checked against the sum, never counted as a security.

Each run re-reads the last RECENT_DAYS trading days (to pick up revisions; a file
whose sha256 is unchanged is skipped) and backfills up to MTF_BACKFILL older
missing days, newest first, back to HISTORY_START (1 Apr 2021, FY 2022's first day).
Trading days come from the NSE / BSE dashboard JSON, and before it starts (2023-04-03)
from trading_calendar.equity_days_pre_fy24(). An older day the exchange does not serve is
recorded under `unavailable` and asked for again only on a manual run. A stored day
read by an older parser (its `parser` below PARSER_VERSION) is re-read like a
missing one, so a parser fix reaches history.

A file an exchange served for more than one date goes under `unavailable` for each
of them: BSE's files carry no date, so which date it belongs to cannot be told.

  python scripts/mtf_pipeline.py --brokers-only
      rebuilds mtf_brokers.json from the committed mtf_daily.json and
      mtf_broker_live.json after an edit to the broker register (no network).

  python scripts/mtf_pipeline.py --compare-bse [YYYY-MM-DD …]
      fetches BSE's margin trading CSV and its margin archive for the same dates
      and prints their totals side by side (nothing is written); workflow
      mtf-sources.yml runs it.

Env:
  MTF_BACKFILL   older days to fetch per exchange per run (default 40; 600 on a
                 manual run, when EVENT=workflow_dispatch and SLOT is empty)
  SUPABASE_URL, SUPABASE_KEY   when set (repository variable ENABLE_MTF_WRITES),
                 each new or revised day's totals also go to mtf.exchange_daily
  MTF_WRITE_STOCKS=true        also write per-security rows to mtf.stock_daily
                 (off by default: ~4,000 rows a day)

The codex pipeline's public.codex_nse_mtf_daily (NSE totals, written from another
repository) is left alone.
"""

import bisect
import csv
import hashlib
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from trading_calendar import equity_days_pre_fy24

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
OUT_PATH = DATA_DIR / "mtf_daily.json"
STOCKS_PATH = DATA_DIR / "mtf_stocks_latest.json"
NSE_FEED_PATH = DATA_DIR / "nse_mtf_daily.json"
BROKERS_PATH = DATA_DIR / "mtf_brokers.json"
BROKER_LIVE_PATH = DATA_DIR / "mtf_broker_live.json"
NEW_DAYS_FILE = ROOT / ".new_mtf_days_count"

NSE_URL = "https://nsearchives.nseindia.com/content/equities/mrg_trading_{ddmmyy}.zip"
BSE_URL = ("https://api.bseindia.com/BseIndiaAPI/api/GetMkt_Margin_TradingCSVDwnld_ng/w"
           "?tradedate={dd}%2F{mm}%2F{yyyy}&iScripCd=&dtFromDate=&flag=0")
BSE_ARCHIVE_URL = ("https://api.bseindia.com/BseIndiaAPI/api/DownloadMarginArch_ng/w"
                   "?date={dd}%2F{mm}%2F{yyyy}&flag=1")
BSE_CSV_FROM = date(2025, 10, 1)    # first day BSE's margin trading CSV serves; earlier days: archive, whose
                                    # files for later days have no rows (--compare-bse, 4 Nov 2026)
SOURCE_NAMES = {"nse": "NSE CM - Margin Trading Disclosure", "bse": "BSE Margin Trading CSV"}
EXCHANGES = ("nse", "bse")

RECENT_DAYS = 10            # trading days re-read every run (NSE revises within a few days)
BACKFILL_PER_RUN = 40
MANUAL_BACKFILL = 600
HISTORY_START = date(2021, 4, 1)   # how far back the backfill goes (FY 2022). BSE's archive serves days
                                   # from at least 5 Apr 2021 (--compare-bse, 5 Nov 2026); NSE's MTF days
                                   # in codex_nse_mtf_daily start 23 Nov 2021, and an earlier day NSE
                                   # does not serve goes under `unavailable`
PARSER_VERSION = {"nse": 1, "bse": 2}   # bump when a parser fix changes stored figures; bse 2 skips
                                        # totals rows (BSE's archive files end with one)
PAUSE_S = 0.4               # between requests to the same exchange
ARITH_TOL_LAKH = 1.0        # opening + fresh − liquidated vs closing (rounding)
BSE_ARITH_SHARE = 0.005     # BSE's archive misses that by up to 0.4 % of the book on ordinary days
                            # (median 0.05 %, 473 days to Sep 2025): flag beyond 0.5 %
BSE_AMOUNT_GAP_SHARE = 0.01 # BSE's amount financed vs its closing book in the same file (6 % on 2024-07-01)
ROUNDING_LAKH = 0.005       # each published figure is rounded to 0.01 lakh, so the sum of n security
                            # rows may differ from the rounded total by up to 0.005 × (n + 1) lakh
STOP_STATUSES = (401, 403, 429)   # the exchange refuses us: ask it nothing more this run
SPIKE_SHARE = 0.25          # a one-day move this large that reverts the next day is a spike ...
SPIKE_NEIGHBOURS = 0.02     # ... when the days either side agree within this share
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")
BSE_CODE_RE = re.compile(r"^[0-9]{3,7}$")
PARTIAL_SHARE = 0.5         # a file listing under half the exchange's usual number of securities is a
                            # partial file (BSE served 11 and 326 rows against ~1,770 in early 2026)

NOTES = [
    "Reporting date = the trading day the book is for; each exchange publishes it the next trading day.",
    "NSE closing_cr = 'Net scripwise outstanding at the end of the day'; revised = NSE republished the "
    "date with late member submissions (the revised figures are used).",
    "BSE amount_financed_cr = sum of 'Amount Financed by Members' over all securities in BSE's file.",
    "combined total_cr = NSE closing_cr + BSE amount_financed_cr, only on dates both exchanges published.",
    "A value an exchange did not publish is null, never 0.",
    "detail_residual_lakh = sum of NSE's security rows − its published closing book; flag 'detail_sum' when it "
    "exceeds the rounding bound 0.005 lakh × (rows + 1).",
    "Security counts overlap between NSE and BSE (never add them), and include ETFs and funds, not only equities.",
    "Amount financed is the exchanges' disclosed MTF book, not any broker's loan book or interest income.",
    "flags are advisory: the day is still stored as published.",
    "A file listing under half an exchange's usual number of securities is a partial file: the day goes "
    "under unavailable, not into the series.",
    "BSE days before 2025-10-01 come from BSE's margin trading archive (bse.file = 'archive'), later days "
    "from its margin trading CSV (bse.file = 'csv'), which serves nothing earlier; the archive serves nothing "
    "later. On 2025-10-01, the one day both serve, the archive lists 3 more securities and Rs 31.7 Cr (1 %) more, "
    "and it already shows the drop from 2025-09-30 (Rs 4,588 to 3,126 Cr).",
    "flag 'total_mismatch' = BSE's published totals row differs from the sum of its security rows beyond "
    "rounding; flag 'spike' = a one-day move of 25 % or more that reverts the next day (left out of combined).",
    "flag 'arithmetic' = opening + fresh − liquidated misses the closing book: NSE by more than 1 lakh, BSE by "
    "more than 0.5 % of it (BSE's archive is off by up to 0.4 % on ordinary days); flag 'amount_vs_closing' = "
    "BSE's amount financed and its closing book differ by more than 1 %.",
    "A file an exchange served for more than one date goes under unavailable for each of them (BSE's files "
    "carry no date, so which date it belongs to cannot be told); they are asked for again.",
    "NSE's book steps up 7 % on 2025-10-01 (Rs 99,446 to 1,06,409 Cr; fresh exposure Rs 10,389 Cr against about "
    "Rs 6,000 Cr on ordinary days): from that day brokers report MTF to the exchanges on revised rules, which moved "
    "several of them to gross reporting (ICRA, 'Securities Broking', 24 Jun 2026, p.6: 'revised MTF reporting led to the "
    "shifting of several brokers to gross reporting, resulting in some optical growth').",
    "A BSE day re-read from a file listing fewer securities than the stored one keeps the stored copy: BSE "
    "serves smaller files for older days (its 23 and 24 Sep 2026 files listed 1,860 and 1,868 securities when "
    "published, 1,857 and 1,865 when asked again on 4 Nov). A parser upgrade still replaces the stored day.",
]

MONTHS = {m: i for i, m in enumerate(
    ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}
DATE_RE = re.compile(r"(\d{1,2})[-\s]?([A-Za-z]{3})[-\s]?(\d{4})")


class FetchError(Exception):
    """The exchange could not be asked (network, block, unexpected reply): try again next run.
    `refused` = it answered 401 / 403 / 429, so the run asks it nothing more."""

    def __init__(self, msg, refused=False):
        super().__init__(msg)
        self.refused = refused


# ═══════════════════════════════════════════════════════════════
# PARSING
# ═══════════════════════════════════════════════════════════════

def _num(s):
    if s is None:
        return None
    t = str(s).strip().replace(",", "")
    if t in ("", "-", "NA", "N.A."):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _dates_in(text):
    out = []
    for d, m, y in DATE_RE.findall(text or ""):
        if m.lower() in MONTHS:
            try:
                out.append(date(int(y), MONTHS[m.lower()], int(d)))
            except ValueError:
                pass
    return out


def _decode(raw):
    return raw.decode("utf-8-sig", errors="replace") if isinstance(raw, bytes) else raw


NSE_SUMMARY = (("opening", "beginning of the day"), ("fresh", "fresh exposure"),
               ("liquidated", "liquidated"), ("closing", "end of the day"))


def parse_nse_csv(text):
    """NSE's margin trading CSV → summary (Rs. lakh), securities and revision info.
    In the two-block (revised) layout every value is taken from the right-hand block."""
    rows = list(csv.reader(io.StringIO(_decode(text))))
    out = {"opening": None, "fresh": None, "liquidated": None, "closing": None,
           "securities": [], "revised": False, "revised_as_of": None, "title_dates": set()}
    hdr = None
    for i, row in enumerate(rows):
        cells = [c.strip() for c in row]
        low = [c.lower() for c in cells]
        if "symbol" in low:
            hdr = i
            break
        for j, c in enumerate(low):
            if "current date" in c:             # "As on Current Date 06-NOV-2025 for reporting date 03-NOV-2025"
                out["revised"] = True
                ds = _dates_in(cells[j])
                if ds:
                    out["revised_as_of"] = ds[0]
                    if len(ds) > 1:
                        out["title_dates"].add(ds[-1])
                continue
            if "revised" in c:
                out["revised"] = True
            if "report as on" in c or "reporting date" in c:
                out["title_dates"].update(_dates_in(cells[j]))
            for key, needle in NSE_SUMMARY:
                if needle in c and j + 1 < len(cells):
                    v = _num(cells[j + 1])
                    if v is not None:
                        out[key] = v            # later (right-hand) block wins
    if hdr is None:
        return out
    b = [j for j, c in enumerate(rows[hdr]) if c.strip().lower() == "symbol"][-1]
    for n, row in enumerate(rows[hdr + 1:], start=1):
        cells = list(row) + [""] * (b + 4)
        sym = cells[b].strip()
        if not sym or sym.startswith("*"):
            continue
        amt = _num(cells[b + 3])
        if amt is None:
            continue
        out["securities"].append({"symbol": sym, "name": cells[b + 1].strip(),
                                  "qty": _num(cells[b + 2]), "amount_lakh": amt, "row": n})
    return out


def read_nse_zip(body):
    """(csv text, csv sha256) from NSE's zip, or raises ValueError."""
    with zipfile.ZipFile(io.BytesIO(body)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if not names:
            raise ValueError("no CSV in the zip")
        raw = z.read(names[0])
    return _decode(raw), hashlib.sha256(raw).hexdigest()


BSE_FLOW_COLS = (("opening", "outstanding at bod"), ("fresh", "fresh exposure"),
                 ("liquidated", "liquidated"), ("closing", "outstanding position at eod"))


def parse_bse_csv(text):
    """BSE's margin trading CSV → securities (Rs. lakh). The archive layout also has
    per-security opening / fresh / liquidated / closing, summed when present."""
    rows = list(csv.reader(io.StringIO(_decode(text))))
    hdr = next((i for i, r in enumerate(rows) if any("amount financed" in c.lower() for c in r)), None)
    out = {"securities": [], "opening": None, "fresh": None, "liquidated": None, "closing": None,
           "published_total": None, "skipped_rows": 0}
    if hdr is None:
        return out
    low = [c.strip().lower() for c in rows[hdr]]

    def col(test):
        return next((j for j, c in enumerate(low) if test(c)), None)

    c_isin = col(lambda c: c == "isin")
    c_code = col(lambda c: c == "security code")
    c_name = col(lambda c: c == "security")
    c_qty = col(lambda c: "quantity financed" in c)
    c_amt = col(lambda c: "amount financed" in c)
    flows = {k: col(lambda c, n=needle: n in c) for k, needle in BSE_FLOW_COLS}
    sums = {k: 0.0 for k, j in flows.items() if j is not None}
    for n, row in enumerate(rows[hdr + 1:], start=1):
        cells = list(row) + [""] * len(low)
        sec_id = (cells[c_isin] if c_isin is not None else cells[c_code] if c_code is not None else "").strip()
        name = cells[c_name].strip() if c_name is not None else ""
        amt = _num(cells[c_amt])
        if amt is None or not (sec_id or name):
            continue                            # blank or footnote row
        if c_isin is not None:
            is_security = bool(ISIN_RE.match(sec_id))
        elif c_code is not None:
            is_security = bool(BSE_CODE_RE.match(sec_id))
        else:
            is_security = not name.lower().startswith("total")
        if not is_security:                     # a totals row ("-,-,-,…" or "Total"): BSE's own sum
            out["skipped_rows"] += 1
            if out["published_total"] is None:
                out["published_total"] = amt
            continue
        sec = {"id": sec_id, "name": name, "qty": _num(cells[c_qty]) if c_qty is not None else None,
               "amount_lakh": amt, "row": n}
        if c_isin is not None:
            sec["isin"] = sec_id
        for k, j in flows.items():
            if j is not None:
                v = _num(cells[j])
                sec[k] = v
                sums[k] += v or 0.0
        out["securities"].append(sec)
    if out["securities"]:
        for k, v in sums.items():
            out[k] = round(v, 2)
    return out


# ═══════════════════════════════════════════════════════════════
# DAY RECORDS
# ═══════════════════════════════════════════════════════════════

def _cr(lakh):
    return None if lakh is None else round(lakh / 100.0, 4)


def row_flags(secs, id_key):
    """Advisory flags on the security rows: a repeated identifier, a negative value."""
    flags = []
    ids = [s[id_key] for s in secs if s.get(id_key)]
    if len(ids) != len(set(ids)):
        flags.append("duplicate_ids")
    if any((s.get(k) or 0) < 0 for s in secs for k in ("qty", "amount_lakh", "opening", "fresh", "liquidated", "closing")):
        flags.append("negative_values")
    return flags


def nse_record(d, parsed, sha, filename, fetched_at):
    """The mtf_daily.json row for one NSE day, or (None, reason) when the file is unusable."""
    o, f, l, c = (parsed[k] for k in ("opening", "fresh", "liquidated", "closing"))
    if c is None or not parsed["securities"]:
        return None, "file has no closing book or no securities"
    if parsed["title_dates"] and d not in parsed["title_dates"]:
        shown = ", ".join(sorted(x.isoformat() for x in parsed["title_dates"]))
        return None, f"file is for {shown}, not {d.isoformat()}"
    secs = parsed["securities"]
    detail = round(sum(s["amount_lakh"] for s in secs), 2)
    residual = round(detail - c, 2)
    flags = []
    if None in (o, f, l):
        flags.append("summary_incomplete")
    elif abs(o + f - l - c) > ARITH_TOL_LAKH:
        flags.append("arithmetic")
    if abs(residual) > ROUNDING_LAKH * (len(secs) + 1) + 1e-9:
        flags.append("detail_sum")
    flags += row_flags(secs, "symbol")
    rec = {"date": d.isoformat(), "opening_cr": _cr(o), "fresh_cr": _cr(f), "liquidated_cr": _cr(l),
           "closing_cr": _cr(c), "securities": len(secs), "detail_sum_cr": _cr(detail),
           "detail_residual_lakh": residual, "revised": parsed["revised"],
           "revised_as_of": parsed["revised_as_of"].isoformat() if parsed["revised_as_of"] else None,
           "flags": flags, "file": filename, "sha256": sha, "fetched_at": fetched_at}
    return rec, None


BSE_TOTAL_FLAGS = ("arithmetic", "amount_vs_closing")


def bse_total_flags(o, f, l, c, amount):
    """Advisory flags from a BSE day's totals (Rs. lakh): 'arithmetic' when opening +
    fresh − liquidated misses the closing book by more than BSE_ARITH_SHARE of it (at
    least ARITH_TOL_LAKH), 'amount_vs_closing' when the amount financed and the closing
    book differ by more than BSE_AMOUNT_GAP_SHARE. The CSV has neither, so no flags."""
    flags = []
    if None not in (o, f, l, c) and abs(o + f - l - c) > max(ARITH_TOL_LAKH, BSE_ARITH_SHARE * abs(c)):
        flags.append("arithmetic")
    if c and amount is not None and abs(amount / c - 1) > BSE_AMOUNT_GAP_SHARE:
        flags.append("amount_vs_closing")
    return flags


def bse_record(d, parsed, sha, fetched_at, file="csv"):
    secs = parsed["securities"]
    if not secs:
        return None, "file has no securities"
    amount = round(sum(s["amount_lakh"] for s in secs), 2)
    o, f, l, c = (parsed[k] for k in ("opening", "fresh", "liquidated", "closing"))
    flags = bse_total_flags(o, f, l, c, amount)
    total = parsed.get("published_total")
    if total is not None and abs(amount - total) > ROUNDING_LAKH * (len(secs) + 1) + 1e-9:
        flags.append("total_mismatch")
    flags += row_flags(secs, "id")
    rec = {"date": d.isoformat(), "amount_financed_cr": _cr(amount), "securities": len(secs),
           "opening_cr": _cr(o), "fresh_cr": _cr(f), "liquidated_cr": _cr(l), "closing_cr": _cr(c),
           "published_total_cr": _cr(total), "flags": flags, "file": file, "parser": PARSER_VERSION["bse"],
           "sha256": sha, "fetched_at": fetched_at}
    return rec, None


# ═══════════════════════════════════════════════════════════════
# FETCHING
# ═══════════════════════════════════════════════════════════════

def fetch_nse(session, d):
    """(url, zip bytes or None, reason). None = not published (yet); FetchError = try again."""
    url = NSE_URL.format(ddmmyy=d.strftime("%d%m%y"))
    try:
        r = session.get(url, impersonate="chrome", timeout=30, headers={"Referer": "https://www.nseindia.com/"})
    except Exception as e:  # curl_cffi raises its own error types
        raise FetchError(f"{type(e).__name__}: {e}") from e
    if r.status_code == 404:
        return url, None, "not published (HTTP 404)"
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}", refused=r.status_code in STOP_STATUSES)
    body = r.content or b""
    if len(body) < 64 or not body.startswith(b"PK"):
        return url, None, f"not published ({len(body)}-byte reply, not a zip)"
    return url, body, None


def bse_url(d, source=None):
    """BSE's margin trading CSV from BSE_CSV_FROM, its margin archive before that;
    `source` ('csv' or 'archive') picks one regardless of the date."""
    source = source or ("csv" if d >= BSE_CSV_FROM else "archive")
    tmpl = BSE_URL if source == "csv" else BSE_ARCHIVE_URL
    return tmpl.format(dd=d.strftime("%d"), mm=d.strftime("%m"), yyyy=d.strftime("%Y"))


def fetch_bse(session, d, source=None):
    url = bse_url(d, source)
    try:
        r = session.get(url, impersonate="chrome", timeout=30,
                        headers={"Referer": "https://www.bseindia.com/", "Origin": "https://www.bseindia.com",
                                 "Accept": "text/csv,application/octet-stream,*/*"})
    except Exception as e:
        raise FetchError(f"{type(e).__name__}: {e}") from e
    if r.status_code == 404:
        return url, None, "not published (HTTP 404)"
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}", refused=r.status_code in STOP_STATUSES)
    body = r.content or b""
    text = _decode(body)
    if "amount financed" not in text.lower():
        if len(text.strip()) < 200:
            return url, None, f"not published ({len(body)}-byte reply)"
        raise FetchError(f"unexpected reply ({len(body)} bytes): {text[:80]!r}")
    return url, body, None


# ═══════════════════════════════════════════════════════════════
# STORE
# ═══════════════════════════════════════════════════════════════

def load_store(path=None):
    try:
        doc = json.loads(Path(path or OUT_PATH).read_text())
    except (OSError, ValueError):
        doc = {}
    store = {ex: {r["date"]: r for r in doc.get(ex, [])} for ex in EXCHANGES}
    store["unavailable"] = {ex: dict(doc.get("unavailable", {}).get(ex, {})) for ex in EXCHANGES}
    store["updated_at"] = doc.get("updated_at")
    return store


def trading_dates(exchange, data_dir=DATA_DIR):
    """Every trading date in the exchange's dashboard JSON, special sessions included,
    and before its first date the equity trading days of trading_calendar (from 1 Apr 2021)."""
    try:
        doc = json.loads((Path(data_dir) / f"{exchange}_dashboard_data.json").read_text())
    except (OSError, ValueError) as e:
        print(f"WARNING: no {exchange} trading dates ({e})")
        return []
    days = {r["date"] for r in doc.get("daily_all", [])} | {r["date"] for r in doc.get("special_sessions", [])}
    if days:
        first = min(days)
        days |= {d for d in equity_days_pre_fy24() if d < first}
    return sorted(date.fromisoformat(x) for x in days)


def history_start():
    return HISTORY_START


def current_days(records, ex):
    """Stored days read by the current parser (older ones are re-read)."""
    return {k for k, r in records.items() if r.get("parser", 1) >= PARSER_VERSION[ex]}


def plan_dates(dates, have, unavailable, recent=RECENT_DAYS, backfill=BACKFILL_PER_RUN, retry=False, start=None):
    """The recent window (always re-read), then up to `backfill` older days from
    `start` on not yet in `have` (nor marked unavailable, unless `retry`), newest first."""
    dates = sorted(d for d in dates if start is None or d >= start)
    window = dates[-recent:] if recent else []
    older = [d for d in reversed(dates[:len(dates) - len(window)])
             if d.isoformat() not in have and (retry or d.isoformat() not in unavailable)][:backfill]
    return window, older


def combined_rows(nse, bse):
    out = []
    for d in sorted(set(nse) & set(bse)):
        n, b = nse[d].get("closing_cr"), bse[d].get("amount_financed_cr")
        if n is None or b is None or "spike" in nse[d].get("flags", []) + bse[d].get("flags", []):
            continue
        out.append({"date": d, "nse_cr": n, "bse_cr": b, "total_cr": round(n + b, 4)})
    return out


def build_doc(store, updated_at):
    nse, bse = store["nse"], store["bse"]
    comb = combined_rows(nse, bse)
    return {
        "updated_at": updated_at,
        "unit": "INR crore",
        "notes": NOTES,
        "sources": {"nse": NSE_URL.replace("{ddmmyy}", "DDMMYY"),
                    "bse": BSE_URL.replace("{dd}", "DD").replace("{mm}", "MM").replace("{yyyy}", "YYYY"),
                    "bse_archive": BSE_ARCHIVE_URL.replace("{dd}", "DD").replace("{mm}", "MM")
                    .replace("{yyyy}", "YYYY")},
        "latest": {"nse": max(nse) if nse else None, "bse": max(bse) if bse else None,
                   "combined": comb[-1]["date"] if comb else None},
        "nse": [nse[d] for d in sorted(nse)],
        "bse": [bse[d] for d in sorted(bse)],
        "combined": comb,
        "unavailable": {ex: dict(sorted(store["unavailable"][ex].items())) for ex in EXCHANGES},
    }


def nse_feed_doc(store, updated_at):
    """nse_mtf_daily.json: NSE's closing book per reporting date, oldest first, in the
    shape the brokers engine reads ({daily: [{date, book_cr}]}; its refresh_market maps
    book_cr to sb_market_daily mtf_industry/book_cr). The same days as the dashboard's
    NSE series: a spike day is left out, an unavailable day never stored."""
    rows = [{"date": d, "book_cr": rec["closing_cr"]} for d, rec in sorted(store["nse"].items())
            if rec.get("closing_cr") is not None and "spike" not in (rec.get("flags") or [])]
    return {
        "updated_at": updated_at,
        "unit": "INR crore",
        "source": NSE_URL.replace("{ddmmyy}", "DDMMYY"),
        "note": "NSE 'Net scripwise outstanding at the end of the day' (closing_cr in mtf_daily.json; NSE's revised "
                "figures once it republishes a date), keyed on the reporting date. Written by scripts/mtf_pipeline.py.",
        "daily": rows,
    }


def dumps(obj, level=0):
    """JSON with every element of a list of objects / lists on its own line, so a
    new day is a one-line diff."""
    pad, inner = " " * level, " " * (level + 1)
    if isinstance(obj, dict) and obj:
        items = [f"{inner}{json.dumps(k, ensure_ascii=False)}: {dumps(v, level + 1)}" for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list) and obj and all(isinstance(x, (dict, list)) for x in obj):
        return "[\n" + ",\n".join(inner + json.dumps(x, ensure_ascii=False, allow_nan=False) for x in obj) \
            + "\n" + pad + "]"
    return json.dumps(obj, ensure_ascii=False, allow_nan=False)


def write_if_changed(path, doc, stamp_key="updated_at"):
    """Write `doc` unless only its timestamp differs from what is on disk. True if written."""
    path = Path(path)
    try:
        old = json.loads(path.read_text())
    except (OSError, ValueError):
        old = None
    if old is not None:
        a, b = dict(old), dict(doc)
        a.pop(stamp_key, None)
        b.pop(stamp_key, None)
        if a == b:
            return False
    path.write_text(dumps(doc) + "\n")
    return True


def typical_count(records):
    """Median number of securities over an exchange's stored days (None when there are none)."""
    counts = sorted(r["securities"] for r in records.values() if r.get("securities"))
    return counts[len(counts) // 2] if counts else None


def partial_reason(n, typical):
    if typical and n < PARTIAL_SHARE * typical:
        return f"partial file ({n} securities; usually about {typical})"
    return None


def drop_partial_days(store):
    """Move stored days whose file listed too few securities to `unavailable`, so a
    partial file never stands for the exchange's book (or enters `combined`)."""
    dropped = []
    for ex in EXCHANGES:
        typical = typical_count(store[ex])
        for key, rec in sorted(store[ex].items()):
            why = partial_reason(rec.get("securities") or 0, typical)
            if why:
                store["unavailable"][ex][key] = why
                del store[ex][key]
                dropped.append((ex, key, why))
    return dropped


def drop_duplicate_files(store):
    """Move stored days whose file (sha256) is also stored under another date of the
    same exchange to `unavailable`: one file cannot be the book of two days, and BSE's
    files carry no date to tell which of them it belongs to (BSE served one file for
    2026-01-14 and 2026-01-16). They are asked for again: recent days every run, older
    ones on a manual run."""
    dropped = []
    for ex in EXCHANGES:
        by_sha = {}
        for key, rec in store[ex].items():
            if rec.get("sha256"):
                by_sha.setdefault(rec["sha256"], []).append(key)
        for keys in by_sha.values():
            if len(keys) < 2:
                continue
            for key in sorted(keys):
                others = ", ".join(k for k in sorted(keys) if k != key)
                why = f"same file as {others} (one file cannot be the book of two days)"
                store["unavailable"][ex][key] = why
                del store[ex][key]
                dropped.append((ex, key, why))
    return dropped


def recheck_bse_flags(store):
    """Recompute BSE_TOTAL_FLAGS on every stored BSE day from its stored totals, so a
    change to the tolerances reaches history without re-reading files. Returns the
    days whose flags changed."""
    lakh = lambda v: None if v is None else v * 100.0  # noqa: E731
    changed = []
    for key, rec in sorted(store["bse"].items()):
        old = rec.get("flags", [])
        new = bse_total_flags(*(lakh(rec.get(k)) for k in ("opening_cr", "fresh_cr", "liquidated_cr", "closing_cr")),
                              lakh(rec.get("amount_financed_cr")))
        flags = [f for f in old if f not in BSE_TOTAL_FLAGS] + new
        if sorted(flags) != sorted(old):
            rec["flags"] = flags
            changed.append(key)
    return changed


BOOK_KEY = {"nse": "closing_cr", "bse": "amount_financed_cr"}


def flag_spikes(store):
    """Flag a stored day whose book moves SPIKE_SHARE or more against the days either
    side while those two agree within SPIKE_NEIGHBOURS: a one-day jump that reverts is a
    file error, not a market move. Recomputed from scratch every run."""
    flagged = []
    for ex in EXCHANGES:
        days = sorted(store[ex])
        for key in days:
            store[ex][key]["flags"] = [f for f in store[ex][key].get("flags", []) if f != "spike"]
        for i in range(1, len(days) - 1):
            prev, cur, nxt = (store[ex][days[j]].get(BOOK_KEY[ex]) for j in (i - 1, i, i + 1))
            if not (prev and cur and nxt) or abs(prev / nxt - 1) > SPIKE_NEIGHBOURS:
                continue
            if abs(cur / ((prev + nxt) / 2) - 1) >= SPIKE_SHARE:
                store[ex][days[i]]["flags"].append("spike")
                flagged.append((ex, days[i], cur, prev, nxt))
    return flagged


def smaller_bse_reread(old, rec):
    """True when a re-read BSE file lists fewer securities than the stored day read by
    the current parser: BSE serves smaller files for older days (securities drop out
    when a day is asked for again later), so the fuller copy stored first is kept. A
    parser upgrade (stored `parser` older) or an equal or larger file replaces it."""
    return bool(old and rec and old.get("sha256") != rec.get("sha256")
                and old.get("parser", 1) >= PARSER_VERSION["bse"]
                and (rec.get("securities") or 0) < (old.get("securities") or 0))


def apply_day(store, ex, d, rec, reason, in_window):
    """Fold one fetch into the store. Returns True if the stored record is new or changed."""
    key = d.isoformat()
    if rec is None:
        if not in_window and key not in store[ex]:
            store["unavailable"][ex][key] = reason
        return False
    store["unavailable"][ex].pop(key, None)
    old = store[ex].get(key)
    if old and old.get("sha256") == rec["sha256"] and old.get("parser", 1) >= rec.get("parser", 1):
        return False
    store[ex][key] = rec
    return True


# ═══════════════════════════════════════════════════════════════
# SUPABASE (mtf schema, optional)
# ═══════════════════════════════════════════════════════════════

class MtfSupabase:
    """Writes each new or revised day to mtf.exchange_daily (and, with
    MTF_WRITE_STOCKS, mtf.stock_daily): the current row for (date, exchange,
    source) is retired (is_current = false) and the new one inserted with the next
    revision. Unchanged files (same sha256 in metadata) are skipped."""

    def __init__(self, url, key, write_stocks=False, rest=None):
        self.url, self.key, self.write_stocks = url.rstrip("/"), key, write_stocks
        self.rest = rest or self._rest

    def _rest(self, method, table, params=None, body=None):
        q = ("?" + urllib.parse.urlencode(params, safe=",.()", quote_via=urllib.parse.quote)) if params else ""
        req = urllib.request.Request(
            f"{self.url}/rest/v1/{table}{q}", method=method,
            data=None if body is None else json.dumps(body, allow_nan=False).encode(),
            headers={"apikey": self.key, "Authorization": f"Bearer {self.key}",
                     "Content-Type": "application/json", "Accept": "application/json",
                     "Accept-Profile": "mtf", "Content-Profile": "mtf", "Prefer": "return=minimal"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def write_day(self, ex, rec, parsed, source_url):
        src = SOURCE_NAMES[ex]
        keys = {"reporting_date": f"eq.{rec['date']}", "exchange": f"eq.{ex.upper()}",
                "source_name": f"eq.{src}", "is_current": "is.true"}
        cur = self.rest("GET", "exchange_daily", {"select": "id,revision,metadata", **keys}) or []
        if cur and (cur[0].get("metadata") or {}).get("sha256") == rec["sha256"]:
            return "unchanged"
        revision = (cur[0]["revision"] + 1) if cur else 1
        if cur:
            self.rest("PATCH", "exchange_daily", keys, {"is_current": False})
            if self.write_stocks:
                self.rest("PATCH", "stock_daily", keys, {"is_current": False})
        lakh = lambda k: None if rec.get(k) is None else round(rec[k] * 100, 2)  # noqa: E731
        amount = lakh("detail_sum_cr") if ex == "nse" else lakh("amount_financed_cr")
        closing = lakh("closing_cr") if rec.get("closing_cr") is not None else amount
        meta = {"sha256": rec["sha256"], "flags": rec["flags"], "pipeline": "ExchangesDash/scripts/mtf_pipeline.py"}
        if ex == "nse":
            meta.update(revised=rec["revised"], revised_as_of=rec["revised_as_of"], file=rec["file"])
        self.rest("POST", "exchange_daily", None, [{
            "reporting_date": rec["date"], "exchange": ex.upper(),
            "beginning_outstanding_lakh": lakh("opening_cr"), "fresh_exposure_lakh": lakh("fresh_cr"),
            "liquidated_exposure_lakh": lakh("liquidated_cr"), "end_outstanding_lakh": closing,
            "amount_financed_lakh": amount, "securities_count": rec["securities"],
            "source_tier": "official_exchange", "source_name": src, "source_url": source_url,
            "revision": revision, "is_current": True, "metadata": meta}])
        if self.write_stocks:
            rows = [self._stock_row(ex, rec, s, src, revision) for s in parsed["securities"]]
            for i in range(0, len(rows), 500):
                self.rest("POST", "stock_daily", None, rows[i:i + 500])
        return f"revision {revision}"

    @staticmethod
    def _stock_row(ex, rec, s, src, revision):
        row = {"reporting_date": rec["date"], "exchange": ex.upper(),
               "exchange_security_id": s["symbol"] if ex == "nse" else (s["id"] or s["name"]),
               "symbol": s["symbol"] if ex == "nse" else None, "security_name": s["name"],
               "isin": s.get("isin") or None, "quantity_financed": s["qty"],
               "amount_financed_lakh": s["amount_lakh"],
               "end_outstanding_lakh": s.get("closing") if s.get("closing") is not None else s["amount_lakh"],
               "beginning_outstanding_lakh": s.get("opening"), "fresh_exposure_lakh": s.get("fresh"),
               "liquidated_exposure_lakh": s.get("liquidated"), "source_tier": "official_exchange",
               "source_name": src, "source_row_number": s["row"], "revision": revision, "is_current": True,
               "metadata": {"sha256": rec["sha256"]}}
        return row


# ═══════════════════════════════════════════════════════════════
# RUN
# ═══════════════════════════════════════════════════════════════

def stocks_doc(latest, updated_at):
    """mtf_stocks_latest.json: the latest day of each exchange, per security, largest first."""
    out = {"updated_at": updated_at, "unit": "INR lakh",
           "columns": {"nse": ["symbol", "name", "qty_financed", "amount_lakh"],
                       "bse": ["id", "name", "qty_financed", "amount_lakh"]}}
    for ex in EXCHANGES:
        day = latest.get(ex)
        if not day:
            out[ex] = None
            continue
        d, parsed = day
        secs = sorted(parsed["securities"], key=lambda s: -s["amount_lakh"])
        first = "symbol" if ex == "nse" else "id"
        out[ex] = {"date": d, "rows": [[s[first], s["name"], s["qty"], s["amount_lakh"]] for s in secs]}
    return out


def run_exchange(ex, session, fetch, store, dates, backfill, now_iso, db=None, pause=time.sleep, retry=False,
                 start=None):
    """Fetch the planned days of one exchange into `store`. Returns (changed dates,
    error count, ok count, latest (date, parsed) seen)."""
    window, older = plan_dates(dates, current_days(store[ex], ex), store["unavailable"][ex],
                               backfill=backfill, retry=retry, start=start)
    in_window = {d.isoformat() for d in window}
    changed, errors, ok, latest = [], 0, 0, None
    print(f"{ex.upper()}: re-reading {len(window)} recent day(s), backfilling {len(older)}")
    for i, d in enumerate(list(reversed(window)) + older):
        if i:
            pause(PAUSE_S)
        try:
            url, body, reason = fetch(session, d)
        except FetchError as e:
            errors += 1
            print(f"  {d}: ERROR {e}")
            if e.refused:
                print(f"  {ex.upper()} refused the request: asking it nothing more this run")
                break
            continue
        rec, parsed = None, None
        if body is not None:
            try:
                if ex == "nse":
                    text, sha = read_nse_zip(body)
                    parsed = parse_nse_csv(text)
                    rec, reason = nse_record(d, parsed, sha, url.rsplit("/", 1)[-1], now_iso)
                else:
                    sha = hashlib.sha256(body).hexdigest()
                    parsed = parse_bse_csv(body)
                    rec, reason = bse_record(d, parsed, sha, now_iso,
                                             "archive" if "DownloadMarginArch" in url else "csv")
            except (ValueError, zipfile.BadZipFile) as e:
                rec, reason = None, f"unreadable file: {e}"
        if rec is not None:
            why = partial_reason(rec["securities"], typical_count(store[ex]))
            if why:
                rec, reason = None, why
        ok += 1
        if ex == "bse" and rec is not None and smaller_bse_reread(store[ex].get(d.isoformat()), rec):
            old = store[ex][d.isoformat()]
            print(f"  {d}: BSE served a smaller file ({rec['securities']} securities vs {old['securities']} stored)"
                  " — kept the stored copy")
            continue
        if rec is None:
            print(f"  {d}: {reason}")
        if rec is not None and (latest is None or d.isoformat() > latest[0]):
            latest = (d.isoformat(), parsed)
        if apply_day(store, ex, d, rec, reason, d.isoformat() in in_window):
            changed.append(d.isoformat())
            tag = " (revised)" if rec.get("revised") else ""
            book = rec.get("closing_cr") or rec.get("amount_financed_cr")
            print(f"  {d}: stored ₹{book:,.0f} Cr, {rec['securities']} securities{tag}"
                  + (f" — check: {', '.join(rec['flags'])}" if rec["flags"] else ""))
            if db is not None:
                try:
                    print(f"    supabase: {db.write_day(ex, rec, parsed, url)}")
                except (urllib.error.URLError, OSError, ValueError) as e:
                    detail = e.read().decode(errors="replace")[:200] if isinstance(e, urllib.error.HTTPError) else ""
                    print(f"    supabase: write FAILED ({e}) {detail}")
    return changed, errors, ok, latest


def main():
    if sys.argv[1:2] == ["--brokers-only"]:
        return brokers_main()
    from nse_pipeline import nse_session
    from bse_pipeline import _make_bse_session

    if sys.argv[1:2] == ["--compare-bse"]:
        return compare_bse_main(sys.argv[2:], _make_bse_session)

    manual = os.environ.get("EVENT") == "workflow_dispatch" and not os.environ.get("SLOT")
    backfill = int(os.environ.get("MTF_BACKFILL") or (MANUAL_BACKFILL if manual else BACKFILL_PER_RUN))
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    store = load_store()
    url, key = os.environ.get("SUPABASE_URL", ""), os.environ.get("SUPABASE_KEY", "")
    db = MtfSupabase(url, key, os.environ.get("MTF_WRITE_STOCKS") == "true") if url and key else None
    print(f"MTF pipeline — backfill {backfill}/exchange, Supabase {'on' if db else 'off'}")

    sessions = {"nse": nse_session, "bse": _make_bse_session}
    fetchers = {"nse": fetch_nse, "bse": fetch_bse}
    changed_total, failed, latest = 0, [], {}
    for ex in EXCHANGES:
        try:
            session = sessions[ex]()
        except Exception as e:  # warm-up failed: the exchange is unreachable this run
            print(f"{ex.upper()}: session failed ({type(e).__name__}: {e})")
            failed.append(ex)
            continue
        changed, errors, ok, last = run_exchange(ex, session, fetchers[ex], store, trading_dates(ex),
                                                 backfill, now_iso, db, retry=manual, start=history_start())
        changed_total += len(changed)
        if errors and not ok:
            failed.append(ex)
        if last and (not store[ex] or last[0] == max(store[ex])):
            latest[ex] = last

    for ex, key, why in drop_partial_days(store) + drop_duplicate_files(store):
        changed_total += 1
        print(f"{ex.upper()} {key}: {why} — moved to unavailable")
    reflagged = recheck_bse_flags(store)
    if reflagged:
        print(f"BSE: flags recomputed on {len(reflagged)} stored day(s)")
    latest = {ex: v for ex, v in latest.items() if v[0] in store[ex]}
    for ex, key, cur, prev, nxt in flag_spikes(store):
        print(f"{ex.upper()} {key}: spike (₹{cur:,.0f} Cr against ₹{prev:,.0f} / ₹{nxt:,.0f} Cr either side)"
              " — flagged, left out of combined")
    doc = build_doc(store, now_iso)
    wrote = write_if_changed(OUT_PATH, doc)
    write_if_changed(NSE_FEED_PATH, nse_feed_doc(store, now_iso))
    try:
        refresh_live(now_iso)
    except Exception as e:  # a broker's web page must never stop the exchanges' data
        print(f"::warning::live broker figures not read ({type(e).__name__}: {e})")
    try:
        write_brokers(doc["combined"], now_iso)
    except Exception as e:  # the register must never stop the exchanges' data
        print(f"::warning::mtf_brokers.json not written ({type(e).__name__}: {e})")
    if latest:
        old = load_json(STOCKS_PATH)
        doc = stocks_doc(latest, now_iso)
        for ex in EXCHANGES:                    # keep an exchange this run did not re-read
            if doc[ex] is None and old:
                doc[ex] = old.get(ex)
        write_if_changed(STOCKS_PATH, doc)
    NEW_DAYS_FILE.write_text(str(changed_total))
    print(f"\n{changed_total} new or revised day(s); mtf_daily.json {'written' if wrote else 'unchanged'}")
    for ex in failed:
        print(f"::error::MTF {ex.upper()}: every request failed this run — no {ex.upper()} data fetched")
    return 1 if failed else 0


# ═══════════════════════════════════════════════════════════════
# BSE SOURCE COMPARISON (--compare-bse)
# ═══════════════════════════════════════════════════════════════

# Default dates: the archive's last CSV-less day, the CSV's first days, the doubled
# day, the file BSE served for two dates, and days either side of later level steps
COMPARE_DATES = ("2025-09-30", "2025-10-01", "2025-10-06", "2025-10-17", "2025-10-20", "2026-01-14", "2026-01-16",
                 "2026-04-21", "2026-05-15", "2026-09-23", "2026-09-24")


def compare_bse_day(session, d, fetch=fetch_bse):
    """One date from both of BSE's sources: per source, its URL kind, reply and totals."""
    out = {}
    for source in ("csv", "archive"):
        row = {"source": source}
        try:
            _, body, reason = fetch(session, d, source)
        except FetchError as e:
            row["error"] = str(e)
            out[source] = row
            if e.refused:
                row["refused"] = True
            continue
        if body is None:
            row["error"] = reason
        else:
            parsed = parse_bse_csv(body)
            secs = parsed["securities"]
            row.update(sha=hashlib.sha256(body).hexdigest()[:10], securities=len(secs),
                       amount_cr=_cr(round(sum(s["amount_lakh"] for s in secs), 2)) if secs else None,
                       closing_cr=_cr(parsed["closing"]), published_total_cr=_cr(parsed["published_total"]),
                       flows=parsed["fresh"] is not None)
        out[source] = row
    return out


def compare_table(results, stored):
    """Markdown table of compare_bse_day results, with the stored day for reference."""
    def cell(row, k, fmt="{:,.2f}"):
        v = row.get(k)
        return "—" if v is None else fmt.format(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v)
    lines = ["| Date | Stored (file) | CSV securities | CSV ₹ Cr | Archive securities | Archive amount ₹ Cr "
             "| Archive closing ₹ Cr | Archive − CSV | Same file |",
             "|---|---|---|---|---|---|---|---|---|"]
    for key, res in results:
        c, a = res["csv"], res["archive"]
        rec = stored.get(key)
        st = f"{rec['amount_financed_cr']:,.2f} ({rec.get('file', '?')})" if rec else "—"
        diff = (f"{a['amount_cr'] - c['amount_cr']:+,.2f} ({a['amount_cr'] / c['amount_cr'] - 1:+.2%})"
                if c.get("amount_cr") and a.get("amount_cr") else "—")
        lines.append(f"| {key} | {st} | {c.get('error') or cell(c, 'securities', '{:,}')} | {cell(c, 'amount_cr')} "
                     f"| {a.get('error') or cell(a, 'securities', '{:,}')} | {cell(a, 'amount_cr')} "
                     f"| {cell(a, 'closing_cr')} | {diff} | {'yes' if c.get('sha') and c.get('sha') == a.get('sha') else 'no'} |")
    return "\n".join(lines)


def compare_bse_main(args, make_session, fetch=fetch_bse, pause=time.sleep):
    """--compare-bse [dates]: both sources for each date, printed (and added to the job
    summary on GitHub Actions). Read-only; exits 0 unless BSE could not be reached."""
    keys = []
    for a in args:
        try:
            keys.append(date.fromisoformat(a.strip()).isoformat())
        except ValueError:
            print(f"::warning::skipping {a!r}: not a YYYY-MM-DD date")
    keys = keys or list(COMPARE_DATES)
    stored = load_store()["bse"]
    if keys == list(COMPARE_DATES) and stored:
        keys.append(max(stored))
    try:
        session = make_session()
    except Exception as e:
        print(f"::error::BSE session failed ({type(e).__name__}: {e})")
        return 1
    results = []
    for i, key in enumerate(dict.fromkeys(keys)):
        if i:
            pause(PAUSE_S)
        res = compare_bse_day(session, date.fromisoformat(key), fetch)
        results.append((key, res))
        if any(r.get("refused") for r in res.values()):
            print("BSE refused the request: asking it nothing more")
            break
    table = compare_table(results, stored)
    print(table)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as fh:
            fh.write("## BSE margin trading: CSV vs archive\n\n" + table + "\n")
    reached = any("sha" in r for _, res in results for r in res.values())
    return 0 if reached else 1


def load_json(path):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


# ═══════════════════════════════════════════════════════════════
# BROKERS: each broker's disclosed MTF book against the exchanges' book
# (register: scripts/broker_mtf_register.py; output: mtf_brokers.json)
# ═══════════════════════════════════════════════════════════════

BROKER_INDUSTRY_GAP_DAYS = 7     # a period-end figure takes the combined book on the last reporting date on or
                                 # before it, at most this many days earlier (a holiday or weekend quarter end)
BROKER_QUARTERS = 8              # quarter ends in the share-by-quarter table
BROKER_YOY_DAYS = (300, 430)     # "a year earlier" = the same-measure figure nearest 365 days back in this window

BROKER_MEASURES = {
    "share": "a market share the filing states; the book is that share of the exchanges' book on the date",
    "gross": "the gross MTF book, the basis the exchanges' book is on",
    "net": "net of client cash collateral, or the balance-sheet loan line: usually 80-87 % of gross, so the share "
           "understates",
    "client_funding": "MTF plus interest-bearing trade receivables (no MTF-only figure is published), so the share "
                      "overstates",
    "unstated": "the document calls it the MTF book without saying gross or net",
}

BROKER_NOTES = [
    "share_pct = the broker's figure / the exchanges' combined MTF book (NSE closing book + BSE amount financed, "
    "mtf_daily.json) on the same date: the last reporting date on or before a period-end figure (within 7 days), or "
    "the month's average for a monthly average. Shares the brokers publish use their own denominators; these don't.",
    "A row with measure 'share' is a share the filing states (ICICI Bank, Kotak Bank); its book_cr is derived "
    "(share x the exchanges' book) and marked derived.",
    "chg / yoy compare a figure with the broker's previous figure (or the one about a year earlier) of the same "
    "measure and basis only.",
    "From 1 Oct 2025 brokers report MTF to the exchanges on revised (gross) rules: NSE's book steps up 7 % that day, "
    "so changes across it compare different bases.",
    "Figures come from each broker's or parent's own documents (url, page, quote); none from aggregators.",
]


def fy_quarter_label(iso):
    """'Q2 FY 2027' for 2026-09-30 (Indian FY, Apr-Mar)."""
    y, m = int(iso[:4]), int(iso[5:7])
    return f"Q{(m - 4) % 12 // 3 + 1} FY {y + 1 if m >= 4 else y}"


def quarter_ends_to(last_iso, n):
    """The n quarter ends (31 Mar, 30 Jun, 30 Sep, 31 Dec) on or before last_iso, oldest first."""
    ends = []
    y = int(last_iso[:4])
    while len(ends) < n:
        for md in ("12-31", "09-30", "06-30", "03-31"):
            d = f"{y}-{md}"
            if d <= last_iso and len(ends) < n:
                ends.append(d)
        y -= 1
    return ends[::-1]


def industry_lookup(combined):
    """at(as_of, basis) -> (combined book ₹ Cr, the reporting date used or None for an average), or (None, None)."""
    dates = [r["date"] for r in combined]
    vals = [r["total_cr"] for r in combined]

    def at(as_of, basis):
        if not dates:
            return None, None
        d0 = date.fromisoformat(as_of)
        if basis == "month_avg":
            if (d0 - date.fromisoformat(dates[-1])).days > BROKER_INDUSTRY_GAP_DAYS:
                return None, None            # the month is not over in the exchanges' series yet
            xs = [v for d, v in zip(dates, vals) if d[:7] == as_of[:7]]
            return (round(sum(xs) / len(xs), 2), None) if xs else (None, None)
        i = bisect.bisect_right(dates, as_of) - 1
        if i < 0 or (d0 - date.fromisoformat(dates[i])).days > BROKER_INDUSTRY_GAP_DAYS:
            return None, None
        return vals[i], dates[i]
    return at


def _broker_change(a, b):
    """b's change from a (same broker, measure and basis)."""
    out = {"from": a["as_of"], "days": (date.fromisoformat(b["as_of"]) - date.fromisoformat(a["as_of"])).days}
    if a.get("book_cr") and b.get("book_cr") is not None:
        out["book_cr"] = round(b["book_cr"] - a["book_cr"], 1)
        out["book_pct"] = round(b["book_cr"] / a["book_cr"] - 1, 4)
    if a.get("share_pct") is not None and b.get("share_pct") is not None:
        out["share_pp"] = round(b["share_pct"] - a["share_pct"], 3)
    return out


def broker_series(rows, at):
    """A broker's figures (register rows, any order) priced against the exchanges' book, oldest first."""
    pts = []
    for d in sorted(rows, key=lambda r: (r["as_of"], r["measure"], r["basis"])):
        ind, ind_date = at(d["as_of"], d["basis"])
        p = {"as_of": d["as_of"], "measure": d["measure"], "basis": d["basis"]}
        if d.get("share_pct") is not None:
            p["share_pct"] = d["share_pct"]
            p["book_cr"] = round(d["share_pct"] / 100 * ind, 1) if ind else None
            p["derived"] = True
        else:
            p["book_cr"] = d["book_cr"]
            p["share_pct"] = round(d["book_cr"] / ind * 100, 3) if ind else None
        p["industry_cr"] = round(ind, 2) if ind else None
        p["industry_date"] = ind_date
        for k in ("precision", "rounded", "note"):
            if d.get(k) is not None:
                p[k] = d[k]
        p.update({"source": d["source"], "url": d["url"], "page": d.get("page"), "quote": d["quote"]})
        pts.append(p)
    chains = {}
    for p in pts:
        chain = chains.setdefault((p["measure"], p["basis"]), [])
        p["chg"] = _broker_change(chain[-1], p) if chain else None
        d0 = date.fromisoformat(p["as_of"])
        back = [(abs((d0 - date.fromisoformat(q["as_of"])).days - 365), q) for q in chain
                if BROKER_YOY_DAYS[0] <= (d0 - date.fromisoformat(q["as_of"])).days <= BROKER_YOY_DAYS[1]]
        p["yoy"] = _broker_change(min(back, key=lambda t: t[0])[1], p) if back else None
        chain.append(p)
    return pts


def live_rows(readings, feeds=None):
    """The MTF job's stored readings ({broker: [{date, book_cr, quote, url}]}) as register-style
    rows under basis 'live', with the feed's measure, source and note (broker_mtf_register.LIVE_FEEDS)."""
    import broker_mtf_register as reg
    feeds = reg.LIVE_FEEDS if feeds is None else feeds
    out = []
    for bid, rows in (readings or {}).items():
        f = feeds.get(bid)
        if not f:
            continue
        for r in rows:
            out.append({"broker": bid, "as_of": r["date"], "book_cr": r["book_cr"], "measure": f["measure"],
                        "basis": "live", "rounded": True, "source": f["source"], "url": r.get("url") or f["url"],
                        "page": None, "quote": r["quote"], "note": f["note"]})
    return out


def brokers_doc(combined, updated_at, brokers=None, disclosures=None, live=None, feeds=None):
    """mtf_brokers.json: each broker's register figures (and the MTF job's live readings, `live`)
    priced against the exchanges' combined book, plus a share-by-quarter table on each broker's
    primary measure. Nothing in it depends on today's date, so it changes only when the register,
    a live reading or the exchanges' book does."""
    import broker_mtf_register as reg
    brokers = reg.BROKERS if brokers is None else brokers
    disclosures = reg.DISCLOSURES if disclosures is None else disclosures
    at = industry_lookup(combined)
    rows = list(disclosures) + live_rows(live, feeds)
    out = []
    for bid, b in brokers.items():
        series = broker_series([d for d in rows if d["broker"] == bid], at)
        out.append({"id": bid, "name": b["name"], "short": b["short"], "type": b["type"], "parent": b.get("parent"),
                    "primary": b["primary"], "sources": b["sources"], "series": series})
    quarters = []
    if combined:
        for qe in quarter_ends_to(combined[-1]["date"], BROKER_QUARTERS):
            ind, ind_date = at(qe, "period_end")
            shares = {}
            for b in out:
                pm = b["primary"]
                hit = next((p for p in b["series"] if p["as_of"] == qe and p["measure"] == pm["measure"]
                            and p["basis"] == pm["basis"] and p.get("share_pct") is not None), None)
                if hit:
                    shares[b["id"]] = hit["share_pct"]
            quarters.append({"end": qe, "label": fy_quarter_label(qe), "industry_cr": ind, "industry_date": ind_date,
                             "shares": shares, "tracked_n": len(shares),
                             "tracked_pct": round(sum(shares.values()), 3) if shares else None})
    return {
        "updated_at": updated_at,
        "unit": "INR crore",
        "notes": BROKER_NOTES,
        "measures": BROKER_MEASURES,
        "industry_latest": ({"date": combined[-1]["date"], "total_cr": combined[-1]["total_cr"]} if combined else None),
        "brokers": out,
        "quarters": quarters,
    }


def _month_end(y, m):
    """The last day of month m of year y (m may run past 12)."""
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    return date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)


def brokers_due(today, brokers=None, disclosures=None):
    """Brokers whose next figure should be out by `today` (a date) but is not in the register:
    [(id, latest as_of, next period end or None, due date)]. For the run's log and summary only."""
    import broker_mtf_register as reg
    brokers = reg.BROKERS if brokers is None else brokers
    disclosures = reg.DISCLOSURES if disclosures is None else disclosures
    out = []
    for bid, b in brokers.items():
        dates = [d["as_of"] for d in disclosures if d["broker"] == bid]
        if not dates:
            continue
        last = date.fromisoformat(max(dates))
        src = b["sources"]
        if src["cadence"] == "irregular":
            nxt = None
            due = last + timedelta(days=src["lag_days"])
        else:
            step = 1 if src["cadence"] == "monthly" else 3
            end = _month_end(last.year, -(-last.month // step) * step)   # the period end on or after the figure
            nxt = _month_end(last.year, -(-last.month // step) * step + step) if end == last else end
            due = nxt + timedelta(days=src["lag_days"])
        if today > due:
            out.append((bid, last.isoformat(), nxt.isoformat() if nxt else None, due.isoformat()))
    return out


def report_brokers_due(today, summary_path=None):
    """Print (and add to the job summary) the brokers whose next MTF figure is due."""
    import broker_mtf_register as reg
    due = brokers_due(today)
    if not due:
        print("Broker MTF register: no figure due")
        return due
    lines = []
    for bid, last, nxt, when in due:
        what = f"the figure for the period ending {nxt}" if nxt else "a newer figure"
        lines.append(f"{reg.BROKERS[bid]['short']}: {what} was due by about {when} "
                     f"({reg.BROKERS[bid]['sources']['primary']}); latest in the register: {last}")
    print("Broker MTF register: due\n  " + "\n  ".join(lines))
    if summary_path:
        with open(summary_path, "a") as fh:
            fh.write("## Broker MTF register: figures due\n\nAdd them to `scripts/broker_mtf_register.py` "
                     "(see `.claude/skills/broker-mtf/SKILL.md`).\n\n" + "\n".join(f"- {x}" for x in lines) + "\n")
    return due


def write_brokers(combined, updated_at):
    """Write mtf_brokers.json (register + the stored live readings) if anything but its timestamp
    changed; report the figures due. True if written."""
    live = (load_json(BROKER_LIVE_PATH) or {}).get("readings")
    wrote = write_if_changed(BROKERS_PATH, brokers_doc(combined, updated_at, live=live))
    report_brokers_due(date.today(), os.environ.get("GITHUB_STEP_SUMMARY"))
    return wrote


# ── Live feeds: figures a broker keeps updating on a web page (broker_mtf_register.LIVE_FEEDS),
# read on every MTF run into mtf_broker_live.json, one reading per weekday

BROKER_LIVE_MAX_JUMP = 0.30      # a reading this far from the previous day's is not stored (a misread page)
BROKER_LIVE_NOTE = ("Readings of figures brokers keep updating on their web pages (scripts/broker_mtf_register.py "
                    "LIVE_FEEDS), one per weekday page date (a later run that day replaces it), written by "
                    "scripts/mtf_pipeline.py on each MTF run; mtf_brokers.json lists them under basis 'live'.")
GROWW_DATE_RE = re.compile(r"Our Metrics as of (\d{1,2} [A-Za-z]{3} \d{4})")
GROWW_MTF_RE = re.compile(r"MTF Net Book\s*₹\s*([\d,]+(?:\.\d+)?)\s*Bn")
GROWW_DISCLAIMER_RE = re.compile(r"MTF Net Book, MF Assets and Stock Assets are platform-level figures[^.]*\.")


def _page_text(page):
    """A web page's visible text, whitespace collapsed."""
    t = re.sub(r"<script.*?</script>|<style.*?</style>", " ", page, flags=re.S | re.I)
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t))).strip()


def parse_groww_ir(page):
    """Groww's investor relations page → {date, book_cr, quote}, or None when the date, the MTF Net Book
    or its 'platform-level' disclaimer is missing (a changed page is not read)."""
    text = _page_text(page or "")
    d, b, disc = GROWW_DATE_RE.search(text), GROWW_MTF_RE.search(text), GROWW_DISCLAIMER_RE.search(text)
    days = _dates_in(d.group(1)) if d else []
    if not (days and b and disc):
        return None
    return {"date": days[0].isoformat(), "book_cr": round(float(b.group(1).replace(",", "")) * 100, 2),
            "quote": f"{d.group(0)} … {b.group(0)} … {disc.group(0)}"}


LIVE_PARSERS = {"groww_ir": parse_groww_ir}


def fetch_live(feed, get=None):
    """One feed's current reading ({date, book_cr, quote, url}), or None with a warning printed."""
    if get is None:
        from curl_cffi import requests as cffi_requests
        get = lambda url: cffi_requests.get(url, impersonate="chrome", timeout=30)  # noqa: E731
    try:
        resp = get(feed["url"])
    except Exception as e:  # network, block: try again next run
        print(f"::warning::{feed['url']} not read ({type(e).__name__}: {e})")
        return None
    if getattr(resp, "status_code", None) != 200:
        print(f"::warning::{feed['url']} answered HTTP {getattr(resp, 'status_code', '?')}")
        return None
    reading = LIVE_PARSERS[feed["parser"]](resp.text)
    if not reading:
        print(f"::warning::{feed['url']}: the MTF figure, its date or its disclaimer is missing; page changed?")
        return None
    return {**reading, "url": feed["url"]}


def update_live_store(readings, broker, reading, fetched_at, max_jump=BROKER_LIVE_MAX_JUMP):
    """Add `reading` to readings[broker] (oldest first, one per page date): (changed, why)."""
    rows = readings.setdefault(broker, [])
    if date.fromisoformat(reading["date"]).weekday() >= 5:
        return False, "weekend page date (the book does not move)"
    same = next((r for r in rows if r["date"] == reading["date"]), None)
    if same and same["book_cr"] == reading["book_cr"]:
        return False, "unchanged"
    before = [r for r in rows if r["date"] < reading["date"]]
    if before and before[-1]["book_cr"] and abs(reading["book_cr"] / before[-1]["book_cr"] - 1) > max_jump:
        return False, (f"{reading['book_cr']:,.0f} Cr is {reading['book_cr'] / before[-1]['book_cr'] - 1:+.0%} on "
                       f"{before[-1]['date']}: not stored")
    rec = {"date": reading["date"], "book_cr": reading["book_cr"], "quote": reading["quote"], "url": reading["url"],
           "fetched_at": fetched_at}
    rows[:] = sorted([r for r in rows if r["date"] != reading["date"]] + [rec], key=lambda r: r["date"])
    return True, "stored"


def refresh_live(now_iso, get=None, feeds=None):
    """Read every live feed and store the readings in mtf_broker_live.json. A feed that fails keeps its stored
    readings (a warning, never an error)."""
    import broker_mtf_register as reg
    feeds = reg.LIVE_FEEDS if feeds is None else feeds
    doc = load_json(BROKER_LIVE_PATH) or {}
    readings = doc.get("readings") or {}
    for bid, feed in feeds.items():
        reading = fetch_live(feed, get)
        if reading:
            changed, why = update_live_store(readings, bid, reading, now_iso)
            print(f"Live {bid}: {reading['date']} ₹{reading['book_cr']:,.2f} Cr: {why}")
            if why.endswith("not stored"):
                print(f"::warning::live {bid}: {why}")
    write_if_changed(BROKER_LIVE_PATH, {"updated_at": now_iso, "note": BROKER_LIVE_NOTE, "readings": readings})
    return readings


def brokers_main():
    """--brokers-only: rebuild mtf_brokers.json from the committed mtf_daily.json (no network)."""
    import broker_mtf_register as reg
    problems = reg.validate()
    if problems:
        print("broker_mtf_register.py is invalid:\n  " + "\n  ".join(problems))
        return 1
    doc = load_json(OUT_PATH) or {}
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    wrote = write_brokers(doc.get("combined") or [], now_iso)
    print(f"mtf_brokers.json {'written' if wrote else 'unchanged'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
