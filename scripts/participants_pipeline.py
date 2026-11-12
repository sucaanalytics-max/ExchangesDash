#!/usr/bin/env python3
"""Participant-wise trading data — FII / DII / Pro / Client / Retail … — from NSE, BSE and NSDL.

Every source is stored as published: its own categories, sub-categories, field names
and units, one JSON file per source (dashboard/data/participants_<key>.json). Nothing
is merged across sources; scripts/participants_report.py turns the stores into monthly
comparisons. Layouts confirmed against the live files on 12 Nov 2026 (and their Oct /
Nov 2023 equivalents):

  nse_fo_oi    nsearchives …/content/nsccl/fao_participant_oi_DDMMYYYY.csv
               Client / DII / FII / Pro (+ TOTAL) × Future Index/Stock Long/Short,
               Option Index/Stock Call/Put Long/Short, Total Long/Short (contracts)
  nse_fo_vol   …/fao_participant_vol_DDMMYYYY.csv, same layout, traded contracts
  nse_fii_fo   …/content/fo/fii_stats_DD-Mon-YYYY.xls: FII buy / sell (contracts, ₹ Cr)
               and end-of-day OI (contracts, ₹ Cr) by product and by index
  nse_cm_cat   …/archives/equities/cat/cat_turnover_DDMMYY.xls: CM buy / sell (₹ Cr) by
               client category (Bank, Insurance, Mutual Funds, AIF, PMS, Retail, Others;
               FPI as reported by NSDL, a day or two late); its "Historical" sheet holds
               monthly DII turnover by sub-category (Bank, DFI, Insurance, MF, NPS) from 2021
  nse_fo_cat   …/archives/fo/cat/fo_cat_turnover_DDMMYY.xls: F&O buy / sell (₹ Cr; options
               on premium) by client category; files to early 2024 also carry an older
               notional table (Mutual Funds, Proprietory Trades, Others)
  nse_fiidii   www.nseindia.com/api/fiidiiTradeReact (NSE + BSE + MSEI) and
               /api/fiidiiTradeNse (NSE): FII/FPI and DII buy / sell / net, ₹ Cr,
               provisional. Latest day only, so the series starts with this pipeline
  bse_fo_vol   api.bseindia.com …/DeriMarketDisclosureData_ng/w?datee=DD/MM/YYYY
  bse_fo_oi    …/DeriMarketTradeOpenData_ng/w?datee=DD/MM/YYYY: Client / FII / DII /
               Proprietary (+ Total) × index / stock futures long/short, index / stock
               call / put long / short, totals (contracts); served back to 2023
  bse_fo_cat   …/Mkt_DeriReports_InvCatTurnArchive_beta/w?Fromdt=&Todt=&FLAG=0: F&O
               buy / sell (₹ Cr, notional) of Proprietary, MF, Others, FII; date ranges
  bse_cash_cat …/CategoryTurnovermkt/w (BSE only: FII, DFI, Bank, MF, Client, Own,
               NRI, Insurance) and …/CategoryTurnover/w (FII and DII across BSE + NSE +
               MSEI), buy / sell / net, published in rupees and stored in ₹ Cr. The last
               three sessions only, so the series starts with this pipeline
  nsdl_fpi     www.fpi.nsdl.co.in/web/Reports/Archive.aspx (posted with a date: that
               month's days): FPI gross purchases / sales / net (₹ Cr, US$ mn) by
               Equity / Debt (General, VRR, FAR) / Hybrid / Mutual Funds / AIFs ×
               Stock Exchange / Primary market & others; FPI derivative trades by product
  nse_pulse    NSE Market Pulse (monthly PDF; list from /api/NextApi/apiStatic?
               functionName=getMarketPulseInsightData&type=marketpulse): "Share of client
               participation in <segment> (%)" — Corporates, DIIs, Foreign Investors,
               Individuals, Prop, Others — for cash, equity derivatives, futures and
               options (index and stock), currency, interest rate and commodity derivatives

Each run re-reads the latest RECENT_DAYS trading days (provisional figures get revised)
and backfills older days to HISTORY_START within a time budget, so a long backfill
spreads over runs. A day a source does not serve outside the recent window goes under
`unavailable` (asked again only on a manual run).

Usage:  python scripts/participants_pipeline.py [--check] [source ...]
        (--check reads each source's latest data and writes nothing)
        env PARTICIPANTS_FULL=true (the long backfill budget), PARTICIPANTS_BACKFILL (days per
        source), PARTICIPANTS_BUDGET_S (seconds)
"""

import csv
import hashlib
import html as htmllib
import io
import json
import os
import re
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from mtf_pipeline import FetchError, plan_dates, trading_dates, write_if_changed

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
NEW_DAYS_FILE = ROOT / ".new_participants_days_count"

HISTORY_START = date(2023, 10, 1)   # Oct / Nov 2023 is the first comparison point (3 years)
RECENT_DAYS = 5                     # trading days re-read every run
BACKFILL_PER_RUN = 60               # older days per source on a slot run
MANUAL_BACKFILL = 1000
BUDGET_S = {"slot": 8 * 60, "manual": 75 * 60}   # backfilling stops once a run has used this long
PAUSE_S = 0.25
STOP_STATUSES = (401, 403, 429)
PULSE_PER_RUN = {"slot": 2, "manual": 60}
PULSE_FROM = "2023-10"              # editions from Oct 2023 (Sep 2023 data) on

NSE = "https://www.nseindia.com"
NSE_ARCH = "https://nsearchives.nseindia.com"
BSE = "https://www.bseindia.com"
BSE_API = "https://api.bseindia.com/BseIndiaAPI/api"
NSDL_ARCHIVE = "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx"
PULSE_LIST = NSE + "/api/NextApi/apiStatic?functionName=getMarketPulseInsightData&type=marketpulse"

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
MONTH_NUM = {m.lower(): i for i, m in enumerate(MONTHS, 1)}


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def clean(s):
    """A label as published, with runs of whitespace collapsed."""
    return re.sub(r"\s+", " ", str(s if s is not None else "")).strip()


def num(s):
    """'1,234.5' / '(7.88)' / '-' / '' → float or None. Brackets are negative (NSDL)."""
    if s is None:
        return None
    if isinstance(s, (int, float)):
        return float(s)
    t = clean(s).replace(",", "").replace("Rs.", "")
    if t in ("", "-", "--", "NA", "N.A."):
        return None
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def as_int(v):
    return int(v) if v is not None and float(v).is_integer() else v


def parse_day(s):
    """'Nov 06, 2026' / 'Oct 03,2023' / '06-Nov-2026' / '01 Nov 2023' / '01/Nov/23' → date, else None."""
    try:
        return _parse_day(clean(s))
    except (KeyError, ValueError):
        return None


def _parse_day(s):
    m = re.search(r"([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})", s)
    if m:
        return date(int(m.group(3)), MONTH_NUM[m.group(1).lower()], int(m.group(2)))
    m = re.search(r"(\d{1,2})[-/\s]([A-Za-z]{3})[a-z]*[-/\s](\d{2,4})", s)
    if m:
        y = int(m.group(3))
        return date(y + 2000 if y < 100 else y, MONTH_NUM[m.group(2).lower()], int(m.group(1)))
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def decode(body):
    for enc in ("utf-8-sig", "cp1252"):
        try:
            return body.decode(enc)
        except UnicodeDecodeError:
            continue
    return body.decode("latin-1", "replace")


def http_get(session, url, referer=None, accept=None, method="GET", data=None, timeout=60):
    """(status, body). 404 is returned; another non-200 reply or a network error raises FetchError."""
    headers = {}
    if referer:
        headers["Referer"] = referer
        if referer.startswith(BSE):
            headers["Origin"] = BSE
    if accept:
        headers["Accept"] = accept
    try:
        if method == "POST":
            r = session.post(url, data=data, impersonate="chrome", timeout=timeout, headers=headers)
        else:
            r = session.get(url, impersonate="chrome", timeout=timeout, headers=headers)
    except Exception as e:  # curl_cffi raises its own error types
        raise FetchError(f"{type(e).__name__}: {e}") from e
    if r.status_code == 404:
        return 404, b""
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}", refused=r.status_code in STOP_STATUSES)
    return 200, r.content or b""


def sha(body):
    return hashlib.sha256(body if isinstance(body, bytes) else body.encode()).hexdigest()


def month_iter(start, end):
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)


def month_end(y, m):
    return (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)


# ═══════════════════════════════════════════════════════════════
# PARSERS (pure: bytes / text in, (date, tables) out; tables = {title: {row: {col: value}}})
# ═══════════════════════════════════════════════════════════════

def parse_nse_participant_csv(text):
    """NSE fao_participant_oi / _vol CSV → (as-on date, {title: {category: {field: contracts}}})."""
    rows = [r for r in csv.reader(io.StringIO(text)) if any(c.strip() for c in r)]
    if len(rows) < 3:
        raise ValueError("fewer than three rows")
    # NSE's title cell is quoted badly, so its "Nov 06, 2026" splits at the comma: join the pieces
    title = clean(", ".join(c.strip().strip('"') for c in rows[0] if c.strip().strip('"')))
    header = [clean(c) for c in rows[1]]
    if not header or header[0].lower() != "client type":
        raise ValueError(f"unexpected header {header[:3]}")
    table = {}
    for r in rows[2:]:
        label = clean(r[0])
        if not label:
            continue
        table[label] = {h: as_int(num(v)) for h, v in zip(header[1:], r[1:]) if h}
    as_of = parse_day(title)
    title = re.sub(r"\s+as on .*$", "", title, flags=re.I)
    return as_of, {title: table}


def _xls_sheets(body):
    import xlrd
    return xlrd.open_workbook(file_contents=body)


def _xls_date(v, datemode):
    """An Excel serial day, or a text date, → date."""
    if isinstance(v, float) and v > 30000:
        import xlrd     # only for serial days, so the parser runs without xlrd on text dates
        return xlrd.xldate.xldate_as_datetime(v, datemode).date()
    return parse_day(str(v))


def parse_fii_stats(body):
    """NSE fii_stats_DD-Mon-YYYY.xls → (date, {"FII derivatives statistics": {product: {field: v}}})."""
    book = _xls_sheets(body)
    sh = book.sheet_by_index(0)
    title = clean(sh.cell_value(0, 0))
    as_of = parse_day(title)
    top = [clean(sh.cell_value(1, c)) for c in range(sh.ncols)]
    sub = [clean(sh.cell_value(2, c)) for c in range(sh.ncols)]
    cols, last = [], ""
    for c in range(1, sh.ncols):
        last = top[c] or last
        cols.append(f"{last.title()} · {sub[c]}" if sub[c] else last.title())
    table = {}
    for r in range(3, sh.nrows):
        label = clean(sh.cell_value(r, 0))
        if not label:
            continue
        if label.lower().startswith("note"):
            break
        table[label] = {cols[c - 1]: as_int(num(sh.cell_value(r, c))) for c in range(1, sh.ncols)}
    if not table:
        raise ValueError("no product rows")
    return as_of, {"FII derivatives statistics": table}


def _row_text(cells):
    return clean(" ".join(clean(x) for x in cells if not isinstance(x, float)))


def parse_nse_cat_xls(body):
    """NSE CM / F&O category-wise turnover .xls → (date, {block title: {category: {field: ₹ Cr}}}, notes,
    monthly). A block is a 'Trade Date | Client Categories | Buy … | Sell …' header and the rows under it;
    its title is the line just above (e.g. 'Category-wise turnover', 'FPI Data as reported by NSDL'),
    else the header's category column. `monthly` is the CM file's 'Historical' sheet."""
    book = _xls_sheets(body)
    sh = book.sheet_by_index(0)
    rows = [[sh.cell_value(r, c) for c in range(sh.ncols)] for r in range(sh.nrows)]
    tables, notes, as_of, used, in_notes = {}, [], None, set(), False
    r = 0
    while r < len(rows):
        row = rows[r]
        if clean(row[0]).lower() == "trade date" and len(row) >= 4:
            header = [clean(x) for x in row]
            above = _row_text(rows[r - 1]) if r else ""
            # 'Category-wise turnover for', '… for June 12,2025', 'FPI Data as reported by NSDL on 05-12-2025':
            # the title without its date, so a block keeps one name across days
            title = clean(re.sub(r"\s+(for|on)\b(\s+\S*\d\S*.*|\s+[A-Za-z]+\s+\d.*)?$", "", above)) \
                if above and not above.lower().startswith("note") else header[1]
            used.add(r - 1)
            if title in tables:
                title = f"{title} ({header[1]})"
            table = {}
            r += 1
            # a data row names a category in the second column (a title row such as 'FPI Data as
            # reported by NSDL on' can follow the rows directly, with no blank line; a value can be '-')
            while r < len(rows) and clean(rows[r][1]) and clean(rows[r][0]).lower() != "trade date":
                cells = rows[r]
                d = _xls_date(cells[0], book.datemode)
                if d and as_of is None:
                    as_of = d
                vals = {header[c]: num(cells[c]) for c in range(2, len(header)) if header[c]}
                if d != as_of:      # e.g. NSDL's FPI row dated '06-11-2026 and 08-11-2026'
                    vals = {header[0]: d.isoformat() if d else clean(cells[0]), **vals}
                table[clean(cells[1])] = vals
                r += 1
            tables[title] = table
            in_notes = False
            continue
        text = _row_text(row)
        if text.lower().startswith("note"):
            in_notes = True
        elif text and in_notes and r not in used and not (r + 1 < len(rows) and clean(rows[r + 1][0]).lower() == "trade date"):
            notes.append(text)
        r += 1
    monthly = _parse_cat_historical(book.sheet_by_index(1)) if book.nsheets > 1 else None
    if not tables:
        raise ValueError("no category table")
    return as_of, tables, notes, monthly


def _parse_cat_historical(sh):
    """The CM file's 'Historical' sheet: {title, columns, months: {"YYYY-MM": {"<group> · <field>": v}}}."""
    if sh.nrows < 4:
        return None
    title = clean(sh.cell_value(0, 0))
    groups, last = [], ""
    for c in range(sh.ncols):
        last = clean(sh.cell_value(1, c)) or last
        groups.append(last)
    fields = [clean(sh.cell_value(2, c)) for c in range(sh.ncols)]
    cols = [f"{g} · {f}" if g and f and g != f else (g or f) for g, f in zip(groups, fields)]
    months = {}
    for r in range(3, sh.nrows):
        label = clean(sh.cell_value(r, 0))
        m = re.match(r"([A-Za-z]+)\s*'?\s*(\d{2})$", label.replace("’", "'"))
        if not m or m.group(1)[:3].lower() not in MONTH_NUM:
            continue
        key = f"20{m.group(2)}-{MONTH_NUM[m.group(1)[:3].lower()]:02d}"
        months[key] = {cols[c]: (round(num(sh.cell_value(r, c)), 4) if num(sh.cell_value(r, c)) is not None else None)
                       for c in range(1, sh.ncols) if cols[c]}
    return {"title": title, "columns": cols[1:], "months": months} if months else None


def parse_nse_fiidii(doc, scope):
    """NSE fiidiiTradeReact / fiidiiTradeNse JSON → {date: {scope: {category: {field: ₹ Cr}}}}."""
    out = {}
    for row in doc or []:
        d = parse_day(row.get("date", ""))
        if not d:
            continue
        out.setdefault(d, {}).setdefault(scope, {})[clean(row.get("category"))] = {
            "Buy Value (₹ Cr)": num(row.get("buyValue")), "Sell Value (₹ Cr)": num(row.get("sellValue")),
            "Net Value (₹ Cr)": num(row.get("netValue"))}
    return out


BSE_PARTICIPANT_FIELDS = {   # BSE API field → the page's own column labels
    "IND_FUT_LONG": "Index Futures Long", "IND_FUT_SHORT": "Index Futures Short",
    "STK_FUT_LONG": "Stock Futures Long", "STK_FUT_SHORT": "Stock Futures Short",
    "IND_CL_LNG_CNTRCTS": "Index Options Call Long", "IND_PT_LNG_CNTRCTS": "Index Options Put Long",
    "IND_CL_SHRT_CNTRCTS": "Index Options Call Short", "IND_PT_SHRT_CNTRCTS": "Index Options Put Short",
    "STK_CL_LNG_CNTRCTS": "Stock Options Call Long", "STK_PT_LNG_CNTRCTS": "Stock Options Put Long",
    "STK_CL_SHRT_CNTRCTS": "Stock Options Call Short", "STK_PT_SHRT_CNTRCTS": "Stock Options Put Short",
    "TOT_LNG_CNTRCTS": "Total Long Contracts", "TOT_SHRT_CNTRCTS": "Total Short Contracts",
}


def parse_bse_participant(doc, title):
    """BSE DeriMarketDisclosureData_ng / DeriMarketTradeOpenData_ng → (date, {title: {client type: {field: n}}})."""
    rows = (doc or {}).get("Table") or []
    if not rows:
        return None, {}
    table, as_of = {}, None
    for row in rows:
        as_of = as_of or parse_day(str(row.get("RD_DATE", "")))
        table[clean(row.get("CLIENT_TYPE"))] = {label: as_int(num(row.get(k))) for k, label in BSE_PARTICIPANT_FIELDS.items()}
    return as_of, {title: table}


def parse_bse_fo_cat(doc):
    """BSE InvCatTurnArchive → {date: {title: {category: {"Buy (₹ Cr)", "Sell (₹ Cr)"}}}}."""
    out = {}
    for row in (doc or {}).get("table") or (doc or {}).get("Table") or []:
        d = parse_day(row.get("DT_TM", ""))
        if not d:
            continue
        cats = {}
        for key, v in row.items():
            m = re.match(r"(.+)_(buy|sell)$", key, re.I)
            if m:
                label = {"Prop": "Proprietary", "MF": "Mutual Funds", "FII": "FII / FPI"}.get(m.group(1), m.group(1))
                cats.setdefault(label, {})[f"{m.group(2).title()} (₹ Cr)"] = num(v)
        out[d] = {"Investor categorywise turnover, equity derivatives": cats}
    return out


def parse_bse_cash_cat(mkt, combined):
    """BSE CategoryTurnovermkt (BSE only) and CategoryTurnover (BSE + NSE + MSEI) → {date: tables}.
    Daily rows only (ORDERFLAG 1D); rupees → ₹ Cr."""
    out = {}

    def take(rows, title, label_of):
        for row in rows or []:
            if row.get("ORDERFLAG") != "1D":
                continue
            d = parse_day(str(row.get("REPORTING_DATE", "")))
            if not d:
                continue
            cats = {}
            for key, v in row.items():
                m = re.match(r"CLIENT_TYPE_(.+)$", key)
                if not m or v is None:
                    continue
                suf = m.group(1)
                cats[label_of(clean(v))] = {
                    f: (round(row[k] / 1e7, 4) if row.get(k) is not None else None)
                    for f, k in (("Purchase (₹ Cr)", f"PURCHASE_{suf}"), ("Sale (₹ Cr)", f"SALE_{suf}"),
                                 ("Net (₹ Cr)", f"NET_{suf}"))}
            if "BUY_TOTAL" in row:
                cats["Total"] = {f: (round(row[k] / 1e7, 4) if row.get(k) is not None else None)
                                 for f, k in (("Purchase (₹ Cr)", "BUY_TOTAL"), ("Sale (₹ Cr)", "SELL_TOTAL"),
                                              ("Net (₹ Cr)", "NET_TOTAL"))}
            out.setdefault(d, {})[title] = cats

    take((mkt or {}).get("Table"), "BSE cash market, by client type",
         lambda v: {"OWN": "Own (Proprietary)", "INS": "Insurance"}.get(v, v))
    take((combined or {}).get("Table"), "FII / FPI and DII, BSE + NSE + MSEI",
         lambda v: {"FII_BSENSE": "FII / FPI", "DII_BSENSE": "DII"}.get(v, v))
    return out


def _html_rows(html_text):
    rows = []
    for tr in re.findall(r"<tr.*?</tr>", html_text, flags=re.S | re.I):
        cells = [clean(htmllib.unescape(re.sub(r"<[^>]+>", " ", c)))
                 for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", tr, flags=re.S | re.I)]
        if any(cells):
            rows.append(cells)
    return rows


NSDL_ROUTES = ("Stock Exchange", "Primary market & others", "Sub-total", "Equity schemes", "Debt schemes",
               "Hybrid schemes", "Solution oriented schemes", "Other schemes")


def parse_nsdl(html_text):
    """NSDL FPI daily trends (Latest / Archive pages) → {date: tables}: 'FPI investment' rows
    '<asset class> · <route>' with gross purchases / sales / net (₹ Cr, US$ mn) and the day's
    USD/INR rate; 'FPI derivative trades' rows by product with buy / sell / OI (contracts, ₹ Cr)."""
    out = {}
    day, asset, inv_cols = None, None, None
    deriv_mode, deriv_day = False, None
    for cells in _html_rows(html_text):
        joined = " ".join(cells)
        if cells[0].startswith("Reporting Date") and "Derivative" in joined:
            deriv_mode = True
            continue
        if cells[0].startswith("Reporting Date"):
            deriv_mode = False
            inv_cols = cells
            continue
        if deriv_mode:
            if cells[0].startswith("No. of Contracts"):
                continue
            if cells[0].lower().startswith("total for"):    # month / year totals, as above
                deriv_day = None
                continue
            d = parse_day(cells[0]) if re.match(r"\d{2}-[A-Za-z]{3}-\d{4}", cells[0]) else None
            if d:
                deriv_day, cells = d, cells[1:]
            if deriv_day is None or len(cells) < 7:
                continue
            fields = ("Buy · No. of Contracts", "Buy · Amount in Crore", "Sell · No. of Contracts",
                      "Sell · Amount in Crore", "Open Interest · No. of Contracts", "Open Interest · Amount in Crore")
            out.setdefault(deriv_day, {}).setdefault("FPI derivative trades", {})[cells[0]] = {
                f: as_int(num(v)) for f, v in zip(fields, cells[1:7])}
            continue
        if inv_cols is None:
            continue
        if cells[0].lower().startswith("total for"):
            # the archive page ends with month and year totals ('Total for November', 'Total for 2026'):
            # not a day; they are sums of the days above
            day = asset = None
            continue
        if re.match(r"\d{2}-[A-Za-z]{3}-\d{4}$", cells[0]):
            day, cells = parse_day(cells[0]), cells[1:]
            rate = next((num(c.replace("Rs.", "")) for c in cells if c.startswith("Rs.")), None)
            if rate:
                out.setdefault(day, {}).setdefault("Conversion", {})["1 USD to INR"] = {"Rate (₹)": rate}
            cells = [c for c in cells if not c.startswith("Rs.")]
        if day is None:
            continue
        if cells[0] == "Total":
            asset_label, route = "Total", ""
            vals = cells[1:5]
        elif cells[0] in NSDL_ROUTES:
            asset_label, route, vals = asset, cells[0], cells[1:5]
        else:
            asset, asset_label, route, vals = cells[0], cells[0], cells[1] if len(cells) > 1 else "", cells[2:6]
        if asset_label is None or len(vals) < 4:
            continue
        label = f"{asset_label} · {route}" if route else asset_label
        out.setdefault(day, {}).setdefault("FPI investment", {})[label] = {
            "Gross Purchases (₹ Cr)": num(vals[0]), "Gross Sales (₹ Cr)": num(vals[1]),
            "Net Investment (₹ Cr)": num(vals[2]), "Net Investment (US$ mn)": num(vals[3])}
    return out


PULSE_TABLE = re.compile(r"^Table \d*:\s*(.+?\(%\)(?: in (?:\d{4}|FY\d{2}))?)\s*$")
PULSE_PARSER = 3            # bump when a fix changes what an edition parses to: stored editions are re-read
PULSE_HEADER = re.compile(r"^C\s?lient category\b")
BARE_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
PULSE_MONTH = re.compile(r"^[A-Z][a-z]{2}-\d{2}$")   # 'Man-25' (sic, Jun 2025 edition) is kept; the report drops it
DECIMAL = re.compile(r"^\(?-?\d[\d,]*\.\d+\)?$")
PERIOD_TOKEN = re.compile(r"^(FY\d{2}(TD)?|CY\d{2}(TD)?|[A-Z][a-z]{2}-\d{2}|\(bps\)|MoM|YoY|Change|chg|to)$")


def parse_pulse_text(text):
    """Text of Market Pulse pages → {table title: {"months": [..], "rows": {category: {month: share}}}}.

    A table is a 'Client category' header under a 'Table N: … (%)' title. Titles vary by edition
    ('Share of client participation in NSE cash market segment (%)', the January review's '… (%) in 2025',
    the April review's 'Monthly trend of category-wise share in … in FY25 (%)'). The monthly columns are
    the month labels leading the header (bare 'Jan … Dec' take the title's year); each row's first
    that-many one-decimal numbers are its shares, since the bps changes are whole numbers. A label on
    a line of its own, or wrapped onto the next ('Individual' / 'investors'), is joined; a line without
    numbers above rows ('Cash Segment', 'Commodity Futures') names the rows under it."""
    out = {}
    lines = [clean(x) for x in text.splitlines()]
    latest = None            # the previous table's latest month: dates a following bare 'Apr … Mar' header
    i = 0
    while i < len(lines):
        if not PULSE_HEADER.match(lines[i]):
            i += 1
            continue
        title_m = next((PULSE_TABLE.match(lines[j]) for j in range(i - 1, max(i - 5, -1), -1)
                        if PULSE_TABLE.match(lines[j])), None)
        if not title_m or "...." in title_m.group(1):
            i += 1
            continue
        title = title_m.group(1).replace("’", "'")
        # bare 'Jan … Dec' columns take the title's year ('… in 2024 (%)', '… (%) in 2025'); 'Apr … Mar'
        # in an FY review ('… in FY25 (%)') run April of the year before to March
        year = re.search(r"\bin (\d{4})\b", title)
        fy = re.search(r"\bin FY(\d{2})\b", title)
        months = []
        for t in PULSE_HEADER.sub("", lines[i]).split():
            if PULSE_MONTH.match(t):
                months.append(t)
            elif t in BARE_MONTHS and year:
                months.append(f"{t}-{year.group(1)[2:]}")
            elif t in BARE_MONTHS and fy:
                yy = int(fy.group(1)) - (1 if BARE_MONTHS.index(t) >= 3 else 0)
                months.append(f"{t}-{yy:02d}")
            elif t in BARE_MONTHS:
                months.append(t)            # dated below from the table before
            else:
                break
        if months and not PULSE_MONTH.match(months[-1]):
            months = _date_bare_months(months, latest)
        rows, section, pending = {}, None, None
        j = i + 1
        while j < len(lines) and not lines[j].startswith("Source:") and not PULSE_TABLE.match(lines[j]):
            line = lines[j]
            if PULSE_HEADER.match(line):
                # a second header inside a table (the April 2026 edition prints a bare 'Apr … Mar' header
                # between the real one and the rows) is neither a section nor a label; a new table
                # starts at its own title, which ends this one
                j += 1
                continue
            toks = line.split()
            first_num = next((k for k, t in enumerate(toks)
                              if DECIMAL.match(t) or re.match(r"^\(?-?\d", t) or t == "NA"), None)
            if months and first_num is not None:
                label = " ".join(toks[:first_num]) or pending
                pending = None
                if not label and j + 1 < len(lines) and re.match(r"^[A-Za-z][A-Za-z ()-]*$", lines[j + 1]) \
                        and not PULSE_TABLE.match(lines[j + 1]) and not lines[j + 1].startswith("Source"):
                    label = lines[j + 1]     # the FY26 tables print each label under its numbers
                    j += 1
                shares = [num(t) if t != "NA" else None for t in toks[first_num:] if DECIMAL.match(t) or t == "NA"]
                if label and len(shares) >= len(months):
                    if j + 1 < len(lines) and re.match(r"^[a-z][a-z ]*$", lines[j + 1]):
                        label = f"{label} {lines[j + 1]}"
                        j += 1
                    key = f"{section} · {label}" if section else label
                    rows[key] = {mth: v for mth, v in zip(months, shares[:len(months)]) if v is not None}
            elif months and toks and not line.startswith(("(bps)", "MoM", "Notes")) \
                    and not all(PERIOD_TOKEN.match(t) for t in toks):
                if j + 1 < len(lines) and re.match(r"^\(?-?\d", lines[j + 1]):
                    pending = line
                elif not re.match(r"^[a-z]", line):
                    section = line
            j += 1
        if rows:
            if title in out:                 # one title over a monthly and a full-year table (April 2026)
                for label, vals in rows.items():
                    out[title]["rows"].setdefault(label, {}).update(vals)
                out[title]["months"] += [m for m in months if m not in out[title]["months"]]
            else:
                out[title] = {"months": months, "rows": rows}
            dated = [m for m in months if PULSE_MONTH.match(m) and m[:3] in BARE_MONTHS]
            if dated:                        # monthly tables lead with the latest month, annual ones end with it
                latest = max(dated, key=lambda m: (int(m[4:]), BARE_MONTHS.index(m[:3])))
        i = j
    return out


def _date_bare_months(months, latest):
    """Bare month names ('Apr' … 'Mar') with no year in the title: the run ends at `latest` (the
    previous table's latest month, e.g. 'Mar-26'), counting back across year ends. None without it."""
    if not latest or not PULSE_MONTH.match(latest):
        return []
    m_end, y = BARE_MONTHS.index(latest[:3]), int(latest[4:])
    out, idx = [], m_end
    for name in reversed(months):
        k = BARE_MONTHS.index(name) if name in BARE_MONTHS else None
        if k is None:
            return []
        if k > idx:                          # crossed back over a January
            y -= 1
        idx = k
        out.append(f"{name}-{y:02d}")
    return list(reversed(out))


def pulse_pages(pdf):
    """Indices of the pages that can hold the client-category tables: the table of contents gives their
    printed page numbers, and the first table's actual page the offset to PDF pages (14 in the Nov-Dec
    2023 edition, 1 in later ones). Every page when the contents can't be read."""
    printed = []
    for k in range(min(30, len(pdf.pages))):
        text = pdf.pages[k].extract_text() or ""
        printed += [int(n) for n in re.findall(
            r"(?:client participation|category-wise share) in .+?\(%\)(?: in \d{4})?\s*\.{3,}\s*(\d+)", text)]
    if not printed:
        return list(range(len(pdf.pages)))
    first = min(printed)
    offset = None
    for off in sorted(range(-3, 41), key=abs):
        k = first + off
        page = (pdf.pages[k].extract_text() or "") if 0 <= k < len(pdf.pages) else ""
        if re.search(r"^C\s?lient category", page, re.M) and "...." not in page:
            offset = off
            break
    if offset is None:
        return list(range(len(pdf.pages)))
    # the contents wrap long titles (the FY review's 'Share of client participation in Stock Options
    # (Premium Turnover) of NSE in FY25 (%) … 261' is the only one read whole), so take the band of
    # pages around the tables found rather than only their listed pages
    lo, hi = min(printed) + offset - 25, max(printed) + offset + 30
    return [k for k in range(max(lo, 0), min(hi, len(pdf.pages)))]


def parse_pulse_pdf(body):
    import pdfplumber
    with pdfplumber.open(io.BytesIO(body)) as pdf:
        text = "\n".join(pdf.pages[k].extract_text() or "" for k in pulse_pages(pdf))
    return parse_pulse_text(text)


# ═══════════════════════════════════════════════════════════════
# SOURCES
# ═══════════════════════════════════════════════════════════════

def _nse_file(url_fn, parse_fn):
    def fetch(session, d):
        url = url_fn(d)
        st, body = http_get(session, url, referer=NSE + "/")
        if st == 404 or len(body) < 64:
            return url, None, "not published (HTTP 404)" if st == 404 else f"not published ({len(body)}-byte reply)"
        return url, body, None

    def parse(d, body):
        return parse_fn(body)
    return fetch, parse


def _parse_participant_csv(body):
    as_of, tables = parse_nse_participant_csv(decode(body))
    return as_of, tables, {}


def _parse_fii_stats(body):
    as_of, tables = parse_fii_stats(body)
    return as_of, tables, {}


def _parse_cat(body):
    as_of, tables, notes, monthly = parse_nse_cat_xls(body)
    return as_of, tables, {"notes": notes, "monthly": monthly}


def _bse_participant(path, title):
    def fetch(session, d):
        url = f"{BSE_API}/{path}/w?datee={d:%d/%m/%Y}"
        st, body = http_get(session, url, referer=BSE + "/", accept="application/json, text/plain, */*")
        if st == 404 or len(body) < 10:
            return url, None, "not published (empty reply)"
        return url, body, None

    def parse(d, body):
        as_of, tables = parse_bse_participant(json.loads(decode(body)), title)
        return as_of, tables, {}
    return fetch, parse


SOURCES = {
    "nse_fo_oi": dict(
        name="NSE F&O - Participant wise Open Interest", unit="day", cal="nse", session="nse",
        url=NSE_ARCH + "/content/nsccl/fao_participant_oi_DDMMYYYY.csv",
        io=_nse_file(lambda d: f"{NSE_ARCH}/content/nsccl/fao_participant_oi_{d:%d%m%Y}.csv", _parse_participant_csv)),
    "nse_fo_vol": dict(
        name="NSE F&O - Participant wise Trading Volumes", unit="day", cal="nse", session="nse",
        url=NSE_ARCH + "/content/nsccl/fao_participant_vol_DDMMYYYY.csv",
        io=_nse_file(lambda d: f"{NSE_ARCH}/content/nsccl/fao_participant_vol_{d:%d%m%Y}.csv", _parse_participant_csv)),
    "nse_fii_fo": dict(
        name="NSE F&O - FII derivatives statistics", unit="day", cal="nse", session="nse",
        url=NSE_ARCH + "/content/fo/fii_stats_DD-Mon-YYYY.xls",
        io=_nse_file(lambda d: f"{NSE_ARCH}/content/fo/fii_stats_{d.day:02d}-{MONTHS[d.month - 1]}-{d.year}.xls",
                     _parse_fii_stats)),
    "nse_cm_cat": dict(
        name="NSE CM - Category-wise Turnover", unit="day", cal="nse", session="nse", date_inside=True,
        url=NSE_ARCH + "/archives/equities/cat/cat_turnover_DDMMYY.xls",
        io=_nse_file(lambda d: f"{NSE_ARCH}/archives/equities/cat/cat_turnover_{d:%d%m%y}.xls", _parse_cat)),
    "nse_fo_cat": dict(
        name="NSE F&O - Category-Wise Turnover", unit="day", cal="nse", session="nse", date_inside=True,
        url=NSE_ARCH + "/archives/fo/cat/fo_cat_turnover_DDMMYY.xls",
        io=_nse_file(lambda d: f"{NSE_ARCH}/archives/fo/cat/fo_cat_turnover_{d:%d%m%y}.xls", _parse_cat)),
    "bse_fo_vol": dict(
        name="BSE Derivatives - Participant wise Trading Volume", unit="day", cal="bse", session="bse",
        url=BSE_API + "/DeriMarketDisclosureData_ng/w?datee=DD/MM/YYYY",
        io=_bse_participant("DeriMarketDisclosureData_ng", "Participant wise Trading Volume (contracts)")),
    "bse_fo_oi": dict(
        name="BSE Derivatives - Participant wise Open Interest", unit="day", cal="bse", session="bse",
        url=BSE_API + "/DeriMarketTradeOpenData_ng/w?datee=DD/MM/YYYY",
        io=_bse_participant("DeriMarketTradeOpenData_ng", "Participant wise Open Interest (contracts)")),
    "bse_fo_cat": dict(
        name="BSE Derivatives - Investor Categorywise Turnover", unit="month", session="bse",
        url=BSE_API + "/Mkt_DeriReports_InvCatTurnArchive_beta/w?Fromdt=DD/MM/YYYY&Todt=DD/MM/YYYY&FLAG=0"),
    "nsdl_fpi": dict(
        name="NSDL - Daily Trends in FPI Investments", unit="month", session="plain", url=NSDL_ARCHIVE),
    "nse_fiidii": dict(
        name="NSE - FII/FPI & DII trading activity (provisional)", unit="latest", session="nse",
        url=NSE + "/api/fiidiiTradeReact and /api/fiidiiTradeNse"),
    "bse_cash_cat": dict(
        name="BSE Equity - Investor Categorywise Turnover", unit="latest", session="bse",
        url=BSE_API + "/CategoryTurnovermkt/w and /CategoryTurnover/w"),
    "nse_pulse": dict(
        name="NSE Market Pulse - Share of client participation by segment", unit="edition", session="nse",
        url=PULSE_LIST),
}

NOTES = {
    "nse_fo_oi": ["Open interest in contracts at the end of the day; long = short in the TOTAL row."],
    "nse_fo_vol": ["Traded contracts for the day; each trade counts on its buy (long) and sell (short) side."],
    "nse_fii_fo": ["Options buy / sell value = strike price × quantity; futures = traded price × quantity. End-of-day"
                   " value: options = underlying close × quantity, futures = settlement price × quantity (NSE's notes)."],
    "nse_cm_cat": ["Categories as NSE publishes them; 'Retail' includes HUF, individuals / proprietorships, NRI and "
                   "partnerships / LLPs; 'Others' includes corporates, trusts, DFIs other than banks and insurers, NPS, "
                   "NBFCs and PRO trades. FPI figures come from NSDL and trail by a day or two (NSE's notes).",
                   "`monthly` is the file's 'Historical' sheet: DII turnover by sub-category, by month."],
    "nse_fo_cat": ["Options turnover is premium value. Until early 2024 the file also carried an older table on "
                   "notional value (Mutual Funds, Proprietory Trades, Others)."],
    "bse_fo_vol": ["'Client' covers every category other than FII / FPI, DII and Proprietary (BSE's note)."],
    "bse_fo_oi": ["'Client' covers every category other than FII / FPI, DII and Proprietary (BSE's note)."],
    "bse_fo_cat": ["Buy / sell value in ₹ Cr on notional basis; '-' (none reported) is stored as null."],
    "nsdl_fpi": ["Final FPI figures, compiled from custodians' reports (NSDL); brackets in the source are negative."],
    "nse_fiidii": ["Provisional, compiled by the exchanges from trading members' reports on the trading day."],
    "bse_cash_cat": ["BSE publishes the last three sessions only; 'Client' is BSE's residual client category and "
                     "'Own' its proprietary trades. Rupee figures are stored in ₹ Cr."],
    "nse_pulse": ["Each category's share (%) of the segment's single-side turnover for the month; one edition per "
                  "month gives the latest month, the month before and, from 2025, the same month a year earlier. "
                  "Categories as NSE groups them (Corporates, DIIs, Foreign Investors, Individuals, Prop, Others)."],
}


# ═══════════════════════════════════════════════════════════════
# STORE
# ═══════════════════════════════════════════════════════════════

def store_path(key):
    return DATA_DIR / f"participants_{key}.json"


def load_store(key):
    try:
        doc = json.loads(store_path(key).read_text())
    except (OSError, ValueError):
        doc = {}
    return {
        "days": {r["date"]: r for r in doc.get("days", [])},
        "unavailable": dict(doc.get("unavailable", {})),
        "months_read": dict(doc.get("months_read", {})),
        "editions": {e["edition"]: e for e in doc.get("editions", [])},
        "extra": {k: doc[k] for k in ("monthly",) if k in doc},
        "notes_published": doc.get("notes_published"),
    }


def build_doc(key, st, now_iso):
    src = SOURCES[key]
    doc = {"updated_at": now_iso, "source": {"key": key, "name": src["name"], "url": src["url"]},
           "notes": NOTES.get(key, [])}
    if st.get("notes_published"):
        doc["notes_published"] = st["notes_published"]
    if src["unit"] == "edition":
        doc["editions"] = [st["editions"][k] for k in sorted(st["editions"])]
    else:
        doc["days"] = [st["days"][k] for k in sorted(st["days"])]
        if st["unavailable"]:
            doc["unavailable"] = dict(sorted(st["unavailable"].items()))
        if st["months_read"]:
            doc["months_read"] = dict(sorted(st["months_read"].items()))
    doc.update(st.get("extra", {}))
    return doc


def compact(tables):
    """{title: {row: {field: v}}} → {title: {"fields": [...], "rows": {row: [v, ...]}}}: field names
    once per table rather than on every row (the stores are several hundred days long)."""
    out = {}
    for title, rows in tables.items():
        fields = []
        for vals in rows.values():
            fields += [f for f in vals if f not in fields]
        out[title] = {"fields": fields, "rows": {r: [vals.get(f) for f in fields] for r, vals in rows.items()}}
    return out


def expand(tables):
    """The inverse of compact()."""
    return {title: {r: dict(zip(t["fields"], vals)) for r, vals in t["rows"].items()} for title, t in tables.items()}


def put_day(st, d, tables, body_sha, now_iso, parser=1):
    """Store one day's tables (compacted). True if new or changed (tables compared, not timestamps)."""
    key = d.isoformat()
    st["unavailable"].pop(key, None)
    packed = compact(tables)
    old = st["days"].get(key)
    if old and old.get("tables") == packed:
        return False
    rec = {"date": key, "tables": packed, "fetched_at": now_iso, "parser": parser}
    if body_sha:
        rec["sha256"] = body_sha
    st["days"][key] = rec
    return True


# ═══════════════════════════════════════════════════════════════
# RUNNERS
# ═══════════════════════════════════════════════════════════════

class Run:
    def __init__(self, manual, backfill, budget_s, now_iso, pause=time.sleep, clock=time.monotonic):
        self.manual, self.backfill, self.now_iso = manual, backfill, now_iso
        self.pause, self.clock = pause, clock
        self.deadline = clock() + budget_s

    def out_of_time(self):
        return self.clock() > self.deadline


def run_days(key, session, st, dates, run, start=HISTORY_START):
    """A per-day source: re-read the recent window, then backfill older days while time lasts.
    Returns (changed, errors, ok)."""
    fetch, parse = SOURCES[key]["io"]
    have = set(st["days"])
    window, older = plan_dates(dates, have, st["unavailable"], recent=RECENT_DAYS, backfill=run.backfill,
                               retry=run.manual, start=start)
    in_window = {d.isoformat() for d in window}
    changed, errors, ok = 0, 0, 0
    print(f"{key}: re-reading {len(window)} recent day(s), up to {len(older)} older")
    for i, d in enumerate(list(reversed(window)) + older):
        if d.isoformat() not in in_window and run.out_of_time():
            print(f"  time budget used: backfill continues next run ({len(older)} planned)")
            break
        if i:
            run.pause(PAUSE_S)
        try:
            url, body, reason = fetch(session, d)
        except FetchError as e:
            errors += 1
            print(f"  {d}: ERROR {e}")
            if e.refused:
                print(f"  {key}: refused — asking nothing more this run")
                break
            continue
        ok += 1
        if body is None:
            if d.isoformat() not in in_window:
                st["unavailable"][d.isoformat()] = reason
            continue
        try:
            as_of, tables, extra = parse(d, body)
        except Exception as e:  # a layout change must not stop the run
            st["unavailable"][d.isoformat()] = f"unreadable file: {type(e).__name__}: {e}"
            print(f"  {d}: unreadable ({e})")
            continue
        if as_of and as_of != d:
            # NSE's CM category file is not always named for its trade date (cat_turnover_111126.xls
            # held 9 Nov 2026, after the 10 Nov holiday): such sources are keyed on the date inside
            if SOURCES[key].get("date_inside") and as_of <= d and as_of >= start:
                if put_day(st, as_of, tables, sha(body), run.now_iso):
                    changed += 1
                continue
            if d.isoformat() not in in_window:
                st["unavailable"][d.isoformat()] = f"file is for {as_of}, not {d}"
            continue
        if not tables or not any(tables.values()):
            if d.isoformat() not in in_window:
                st["unavailable"][d.isoformat()] = "no rows"
            continue
        if extra.get("monthly") and d.isoformat() >= max(st["days"] or [""]):
            st["extra"]["monthly"] = extra["monthly"]
        if extra.get("notes") and d.isoformat() >= max(st["days"] or [""]):
            st["notes_published"] = extra["notes"]
        if put_day(st, d, tables, sha(body), run.now_iso):
            changed += 1
    return changed, errors, ok


def fetch_bse_fo_cat_month(session, y, m, today):
    end = min(month_end(y, m), today)
    url = (f"{BSE_API}/Mkt_DeriReports_InvCatTurnArchive_beta/w?Fromdt=01/{m:02d}/{y}"
           f"&Todt={end:%d/%m/%Y}&FLAG=0")
    st, body = http_get(session, url, referer=BSE + "/", accept="application/json, text/plain, */*")
    return url, body, parse_bse_fo_cat(json.loads(decode(body))) if st == 200 and body else {}


def fetch_nsdl_month(session, y, m, today):
    """POST NSDL's archive form (fresh ASP.NET state each time) with the month's last day, or
    today: the page lists that month's days up to it."""
    st, body = http_get(session, NSDL_ARCHIVE)
    form = dict(re.findall(r'<input[^>]*name="(__[A-Z]+)"[^>]*value="([^"]*)"', decode(body)))
    if "__VIEWSTATE" not in form:
        raise ValueError("NSDL archive page has no form state")
    end = min(month_end(y, m), today)
    d = f"{end.day:02d}-{MONTHS[end.month - 1]}-{end.year}"
    data = dict(form, __EVENTTARGET="btnSubmit1", __EVENTARGUMENT="", txtDate=d, hdnDate=d,
                hdnFlag="", HdnValexceldata="")
    st, body = http_get(session, NSDL_ARCHIVE, referer=NSDL_ARCHIVE, method="POST", data=data, timeout=90)
    days = parse_nsdl(decode(body)) if st == 200 else {}
    return NSDL_ARCHIVE + f"?txtDate={d}", body, {k: v for k, v in days.items() if (k.year, k.month) == (y, m)}


def run_months(key, session, st, run, today):
    """A source read a month at a time: the current and previous month every run, older months once."""
    fetcher = {"bse_fo_cat": fetch_bse_fo_cat_month, "nsdl_fpi": fetch_nsdl_month}[key]
    months = list(month_iter(HISTORY_START, today))
    recent = months[-2:]
    older = [ym for ym in reversed(months[:-2]) if f"{ym[0]}-{ym[1]:02d}" not in st["months_read"]]
    changed, errors, ok = 0, 0, 0
    print(f"{key}: re-reading {len(recent)} recent month(s), up to {len(older)} older")
    for i, (y, m) in enumerate(list(reversed(recent)) + older):
        if (y, m) not in recent and run.out_of_time():
            print("  time budget used: backfill continues next run")
            break
        if i:
            run.pause(PAUSE_S)
        try:
            url, body, days = fetcher(session, y, m, today)
        except FetchError as e:
            errors += 1
            print(f"  {y}-{m:02d}: ERROR {e}")
            if e.refused:
                break
            continue
        except ValueError as e:
            errors += 1
            print(f"  {y}-{m:02d}: unreadable ({e})")
            continue
        ok += 1
        for d, tables in sorted(days.items()):
            if d >= HISTORY_START and put_day(st, d, tables, None, run.now_iso):
                changed += 1
        if (y, m) not in recent:
            st["months_read"][f"{y}-{m:02d}"] = len(days)
        print(f"  {y}-{m:02d}: {len(days)} day(s)")
    return changed, errors, ok


def run_latest(key, session, st, run):
    """A source that only serves its latest session(s)."""
    try:
        if key == "nse_fiidii":
            days = {}
            for scope, path in (("NSE, BSE and MSEI", "/api/fiidiiTradeReact"), ("NSE", "/api/fiidiiTradeNse")):
                stt, body = http_get(session, NSE + path, referer=NSE + "/reports/fii-dii",
                                     accept="application/json")
                for d, tables in parse_nse_fiidii(json.loads(decode(body)) if body else [], scope).items():
                    days.setdefault(d, {}).update(tables)
                run.pause(PAUSE_S)
        else:
            replies = []
            for path in ("CategoryTurnovermkt", "CategoryTurnover"):
                stt, body = http_get(session, f"{BSE_API}/{path}/w", referer=BSE + "/", accept="application/json")
                replies.append(json.loads(decode(body)) if body else {})
                run.pause(PAUSE_S)
            days = parse_bse_cash_cat(*replies)
    except (FetchError, ValueError) as e:
        print(f"{key}: ERROR {e}")
        return 0, 1, 0
    changed = 0
    for d, tables in sorted(days.items()):
        old = st["days"].get(d.isoformat(), {}).get("tables", {})
        merged = {**expand(old), **tables}   # one scope may be missing from a reply
        if put_day(st, d, merged, None, run.now_iso):
            changed += 1
    print(f"{key}: {len(days)} day(s) in the reply, {changed} new or changed")
    return changed, 0, 1


def run_pulse(st, session, run, limit):
    """Market Pulse editions not yet read (newest first), up to `limit` a run."""
    try:
        stt, body = http_get(session, PULSE_LIST, referer=NSE + "/research/publications-reports-nse-market-pulse",
                             accept="application/json")
        listing = json.loads(decode(body))
    except (FetchError, ValueError) as e:
        print(f"nse_pulse: listing failed ({e})")
        return 0, 1, 0
    editions = []
    for item in listing:
        url, card = item.get("CTA_URL") or "", (item.get("CARD_PAGE_DATE") or "")[:10]
        if not url.lower().endswith(".pdf") or not card:
            continue
        # the card date is the last day of the month the edition covers (UTC, a day early)
        cd = date.fromisoformat(card) + timedelta(days=1)
        edition = f"{cd.year}-{cd.month:02d}"
        if edition >= PULSE_FROM:
            editions.append((edition, url, clean(item.get("TITLE"))))
    missing = [e for e in sorted(editions, reverse=True) if e[0] not in st["editions"]][:limit]
    stale = [e for e in sorted(editions, reverse=True)
             if e[0] in st["editions"] and st["editions"][e[0]].get("parser", 1) < PULSE_PARSER][:max(limit, 12)]
    todo = missing + stale
    print(f"nse_pulse: {len(editions)} editions listed, reading {len(missing)} new and {len(stale)} by an older parser")
    changed, errors, ok = 0, 0, 0
    for edition, url, title in todo:
        if run.out_of_time() and changed:
            break
        try:
            stt, pdf = http_get(session, url, referer=NSE + "/", timeout=180)
            if stt != 200 or not pdf.startswith(b"%PDF"):
                raise ValueError(f"not a PDF ({stt}, {len(pdf)} bytes)")
            tables = parse_pulse_pdf(pdf)
        except (FetchError, ValueError) as e:
            errors += 1
            print(f"  {edition}: {e}")
            continue
        except Exception as e:  # pdfplumber can raise many kinds of errors on a malformed PDF
            errors += 1
            print(f"  {edition}: unreadable PDF ({type(e).__name__}: {e})")
            continue
        ok += 1
        checks = pulse_checks(tables)
        st["editions"][edition] = {"edition": edition, "title": title, "url": url, "sha256": sha(pdf),
                                   "fetched_at": run.now_iso, "parser": PULSE_PARSER, "tables": tables,
                                   "checks": checks}
        changed += 1
        print(f"  {edition}: {len(tables)} table(s)" + (f" — check: {'; '.join(checks)}" if checks else ""))
        run.pause(PAUSE_S)
    return changed, errors, ok


def pulse_checks(tables):
    """Month columns whose category shares don't add up to 100 % (± 1.5) — a misread row."""
    out = []
    for title, t in tables.items():
        sections = {}
        for label, vals in t["rows"].items():
            sec = label.split(" · ")[0] if " · " in label else ""
            sections.setdefault(sec, []).append(vals)
        for sec, rows in sections.items():
            for mth in t["months"]:
                vals = [r.get(mth) for r in rows if r.get(mth) is not None]
                if vals and abs(sum(vals) - 100) > 1.5:
                    out.append(f"{title}{' / ' + sec if sec else ''} {mth}: {sum(vals):.1f} %")
    return out


# ═══════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════

def make_sessions():
    from nse_pipeline import nse_session
    from bse_pipeline import _make_bse_session
    from curl_cffi import requests as cffi_requests
    return {"nse": nse_session, "bse": _make_bse_session, "plain": cffi_requests.Session}


def check(keys):
    """Read-only: each source's latest data through the real fetchers and parsers; nothing is
    written. For participants-sources.yml (on a pull request, GitHub's runners reach every host)."""
    makers, sessions, failed = make_sessions(), {}, []
    today = datetime.now(timezone.utc).date()
    run = Run(False, 0, 600, "check", pause=lambda s: None)
    for key in keys:
        src = SOURCES[key]
        try:
            session = sessions.setdefault(src["session"], makers[src["session"]]())
            st = {"days": {}, "unavailable": {}, "months_read": {}, "editions": {}, "extra": {}}
            if src["unit"] == "day":
                fetch, parse = src["io"]
                for d in reversed(trading_dates(src["cal"])[-4:]):
                    url, body, reason = fetch(session, d)
                    if body is not None:
                        as_of, tables, _ = parse(d, body)
                        put_day(st, as_of or d, tables, None, "check")
                        break
            elif src["unit"] == "month":
                p_url, body, days = {"bse_fo_cat": fetch_bse_fo_cat_month, "nsdl_fpi": fetch_nsdl_month}[key](
                    session, today.year, today.month, today)
                for d, tables in days.items():
                    put_day(st, d, tables, None, "check")
            elif src["unit"] == "latest":
                run_latest(key, session, st, run)
            else:
                run_pulse(st, session, run, 1)
            items = st["editions"] or st["days"]
            if not items:
                raise ValueError("nothing read")
            last = items[max(items)]
            tables = last["tables"]
            print(f"OK   {key}: {len(items)} item(s), latest {max(items)}")
            for title, t in tables.items():
                rows = t["rows"]
                print(f"       {title}: {len(rows)} row(s) {list(rows)[:8]}"
                      + (f", fields {t['fields'][:6]}" if "fields" in t else f", months {t.get('months')}"))
        except Exception as e:  # report every source, whatever goes wrong
            failed.append(key)
            print(f"FAIL {key}: {type(e).__name__}: {e}")
    print(f"\n{len(keys) - len(failed)} of {len(keys)} sources read")
    return 1 if failed else 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    keys = [k for k in argv if k in SOURCES] or list(SOURCES)
    if "--check" in argv:
        return check(keys)
    # the long budget only when asked for (a manual run with exchange 'participants'): manual
    # 'all' runs are frequent and must not spend an hour here
    manual = os.environ.get("PARTICIPANTS_FULL") == "true"
    backfill = int(os.environ.get("PARTICIPANTS_BACKFILL") or (MANUAL_BACKFILL if manual else BACKFILL_PER_RUN))
    budget = float(os.environ.get("PARTICIPANTS_BUDGET_S") or BUDGET_S["manual" if manual else "slot"])
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    today = datetime.now(timezone.utc).date()
    run = Run(manual, backfill, budget, now_iso)
    print(f"Participants pipeline — {'manual' if manual else 'slot'} run, backfill {backfill}/source, "
          f"budget {budget / 60:.0f} min, sources {keys}")

    makers, sessions = make_sessions(), {}
    total, failed = 0, []
    for key in keys:
        src = SOURCES[key]
        try:
            if src["session"] not in sessions:
                sessions[src["session"]] = makers[src["session"]]()
            session = sessions[src["session"]]
        except Exception as e:
            print(f"{key}: session failed ({type(e).__name__}: {e})")
            failed.append(key)
            continue
        st = load_store(key)
        if src["unit"] == "day":
            changed, errors, ok = run_days(key, session, st, trading_dates(src["cal"]), run)
        elif src["unit"] == "month":
            changed, errors, ok = run_months(key, session, st, run, today)
        elif src["unit"] == "latest":
            changed, errors, ok = run_latest(key, session, st, run)
        else:
            changed, errors, ok = run_pulse(st, session, run, PULSE_PER_RUN["manual" if manual else "slot"])
        total += changed
        if errors and not ok:
            failed.append(key)
        write_if_changed(store_path(key), build_doc(key, st, now_iso))
    NEW_DAYS_FILE.write_text(str(total))
    print(f"\n{total} new or revised day(s) / edition(s)")
    for key in failed:
        print(f"::error::Participants {key}: every request failed this run")
    return 1 if failed and len(failed) == len(keys) else 0


if __name__ == "__main__":
    sys.exit(main())
