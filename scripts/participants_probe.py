#!/usr/bin/env python3
"""Read-only probe of the participant-wise data sources (FII / DII / Pro / Client …).

Fetches one recent and one old sample of every candidate source and prints what
came back, so the participants pipeline's parsers can be written against the
real files. It is run by .github/workflows/participants-sources.yml, because the
exchanges' hosts are reachable from GitHub's runners but not from every
development sandbox. Nothing is written to the repository: raw replies go to
probe/ (uploaded as the workflow's artifact) and a digest goes to stdout.

Usage:  python scripts/participants_probe.py [YYYY-MM-DD ...]
        (dates default to the latest NSE trading days and two from Oct/Nov 2023)
"""

import io
import json
import re
import sys
import time
from datetime import date, datetime
from html import unescape
from pathlib import Path
from urllib.parse import urljoin

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "probe"
PAUSE_S = 0.6
MAX_LINES = 40

NSE = "https://www.nseindia.com"
NSE_ARCH = "https://nsearchives.nseindia.com"
BSE = "https://www.bseindia.com"
BSE_API = "https://api.bseindia.com"
NSDL = "https://www.fpi.nsdl.co.in"

# Market Pulse PDFs whose URLs were seen published (web search, Nov 2026), to test
# the table extraction while the listing is being found
PULSE_KNOWN = [
    NSE_ARCH + "//web/mediaattachment/2026-09/Market_Pulse_September_2026_Final.pdf",
    NSE_ARCH + "//web/mediaattachment/2026-08/Market_Pulse_July_2026.pdf",
    NSE_ARCH + "/web/sites/default/files/inline-files/Market%20Pulse_December_2024.pdf",
]


def say(*a):
    print(*a, flush=True)


def head(title):
    say("\n" + "=" * 100 + f"\n## {title}\n" + "=" * 100)


def decode(body):
    for enc in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            return body.decode(enc)
        except UnicodeDecodeError:
            continue
    return body.decode("latin-1", "replace")


def safe_name(url):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("://", 1)[-1])[-150:]


def get(session, url, referer=None, accept=None, save=True):
    """GET url; print status, type and size; save the body under probe/. Returns (status, body)."""
    headers = {}
    if referer:
        headers["Referer"] = referer
        if referer.startswith(BSE):
            headers["Origin"] = BSE
    if accept:
        headers["Accept"] = accept
    time.sleep(PAUSE_S)
    try:
        r = session.get(url, impersonate="chrome", timeout=40, headers=headers)
    except Exception as e:  # curl_cffi raises its own types
        say(f"GET {url}\n  ERROR {type(e).__name__}: {e}")
        return None, b""
    body = r.content or b""
    ctype = r.headers.get("content-type", "")
    say(f"GET {url}\n  HTTP {r.status_code} · {ctype} · {len(body):,} bytes")
    if save and body:
        OUT.mkdir(exist_ok=True)
        (OUT / safe_name(url)).write_bytes(body)
    return r.status_code, body


def show_text(body, n=MAX_LINES, width=400):
    text = decode(body)
    lines = text.splitlines()
    for line in lines[:n]:
        say("  | " + line[:width])
    if len(lines) > n:
        say(f"  | … {len(lines) - n} more lines")


def show_json(body, n=MAX_LINES):
    try:
        doc = json.loads(decode(body))
    except ValueError:
        say("  (not JSON)")
        show_text(body, 15)
        return None
    dumped = json.dumps(doc, indent=1, ensure_ascii=False)
    show_text(dumped.encode(), n)
    return doc


def show_xls(body):
    """Old-style .xls (BIFF): xlrd if present; .xlsx: openpyxl; else the first bytes."""
    if body[:4] == b"PK\x03\x04":
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(body), read_only=True, data_only=True)
            for ws in wb.worksheets[:3]:
                say(f"  sheet {ws.title!r}")
                for i, row in enumerate(ws.iter_rows(values_only=True)):
                    if i >= MAX_LINES:
                        break
                    say("  | " + " ¦ ".join("" if v is None else str(v) for v in row))
            return
        except Exception as e:
            say(f"  openpyxl failed: {e}")
    try:
        import xlrd
        book = xlrd.open_workbook(file_contents=body)
        for sh in book.sheets()[:3]:
            say(f"  sheet {sh.name!r} {sh.nrows}×{sh.ncols}")
            for i in range(min(sh.nrows, MAX_LINES)):
                say("  | " + " ¦ ".join(str(v) for v in sh.row_values(i)))
        return
    except Exception as e:
        say(f"  xlrd failed or missing: {e}")
    if b"<table" in body[:5000].lower() or b"<html" in body[:500].lower():
        say("  (an HTML table served as .xls)")
        show_html_tables(body)
        return
    say(f"  first bytes: {body[:64]!r}")


def strip_tags(s):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", s))).strip()


def show_html_tables(body, max_tables=6, max_rows=25):
    html = decode(body)
    tables = re.findall(r"<table.*?</table>", html, flags=re.S | re.I)
    say(f"  {len(tables)} table(s)")
    for t, table in enumerate(tables[:max_tables]):
        rows = re.findall(r"<tr.*?</tr>", table, flags=re.S | re.I)
        say(f"  -- table {t + 1}: {len(rows)} rows")
        for row in rows[:max_rows]:
            cells = [strip_tags(c) for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, flags=re.S | re.I)]
            if any(cells):
                say("  | " + " ¦ ".join(cells)[:400])


def page_digest(body, base):
    """Form fields, links to files, API endpoints and scripts referenced by an HTML page."""
    html = decode(body)
    title = re.search(r"<title>(.*?)</title>", html, flags=re.S | re.I)
    say(f"  title: {strip_tags(title.group(1)) if title else '—'}")
    fields = sorted(set(re.findall(r"<(?:input|select|textarea)[^>]*\bname=[\"']([^\"']+)", html, flags=re.I)))
    say(f"  form fields: {[f for f in fields if not f.startswith('__')][:40]}")
    hidden = [f for f in fields if f.startswith("__")]
    if hidden:
        say(f"  ASP.NET state fields: {hidden}")
    links = sorted(set(re.findall(r"(?:href|src)=[\"']([^\"']+)[\"']", html, flags=re.I)))
    files = [urljoin(base, x) for x in links if re.search(r"\.(csv|xls|xlsx|zip|pdf)(\?|$)", x, re.I)]
    say(f"  file links ({len(files)}): {files[:25]}")
    apis = sorted(set(re.findall(r"https?://api\.bseindia\.com/[A-Za-z0-9_/.\-]+", html)))
    apis += sorted(set(re.findall(r"[\"'](/api/[A-Za-z0-9_/\-]+)", html)))
    say(f"  API endpoints in page: {apis[:40]}")
    scripts = [urljoin(base, x) for x in links if re.search(r"\.js(\?|$)", x, re.I)]
    return scripts, files


def grep_scripts(session, scripts, patterns, referer, limit=25):
    """Fetch a page's own JS and print the API endpoints it calls that match `patterns`."""
    found = {}
    for src in scripts[:limit]:
        if "bseindia" not in src and "nseindia" not in src:
            continue
        st, body = get(session, src, referer=referer, save=False)
        if st != 200:
            continue
        js = decode(body)
        for m in re.finditer(r"[\"'`]((?:https?://api\.bseindia\.com)?/?(?:BseIndiaAPI/)?api/[A-Za-z0-9_/\-]+)", js):
            ep = m.group(1)
            if any(p.lower() in ep.lower() for p in patterns):
                ctx = js[max(0, m.start() - 160): m.end() + 200].replace("\n", " ")
                found.setdefault(ep, ctx)
    say(f"  matching endpoints in scripts: {len(found)}")
    for ep, ctx in found.items():
        say(f"  * {ep}\n      …{ctx}…")
    return list(found)


def trading_days(n_recent=3):
    try:
        doc = json.loads((ROOT / "dashboard" / "data" / "nse_dashboard_data.json").read_text())
        days = sorted(r["date"] for r in doc.get("daily_all", []))
    except (OSError, ValueError, KeyError):
        days = []
    recent = days[-n_recent:] if days else [date.today().isoformat()]
    old = [d for d in days if d >= "2023-10-03"][:1] + [d for d in days if d >= "2023-11-01"][:1]
    return [date.fromisoformat(d) for d in recent + old]


# ═══════════════════════════════════════════════════════════════
# SOURCES
# ═══════════════════════════════════════════════════════════════

def probe_nse(s, days):
    head("NSE: daily reports listing (to find the participant files' exact names)")
    for key in ("FO", "CM", "favDerivatives", "favCapital"):
        for path in (f"/api/daily-reports?key={key}", f"/api/merged-daily-reports?key={key}"):
            st, body = get(s, NSE + path, referer=NSE + "/all-reports-derivatives")
            if st == 200 and body:
                text = decode(body)
                hits = sorted(set(re.findall(r"[\"']([^\"']*(?:articipant|fii|FII|ategor|lient)[^\"']*)[\"']", text)))
                say(f"  entries mentioning participant/fii/category/client: {hits[:40]}")
                if not hits:
                    show_text(body, 6)

    for kind in ("oi", "vol"):
        head(f"NSE: F&O participant-wise {kind.upper()} (content/nsccl/fao_participant_{kind}_DDMMYYYY.csv)")
        for d in days:
            for host in (NSE_ARCH, "https://archives.nseindia.com"):
                url = f"{host}/content/nsccl/fao_participant_{kind}_{d:%d%m%Y}.csv"
                st, body = get(s, url, referer=NSE + "/")
                if st == 200 and body:
                    show_text(body, 12)
                    break

    head("NSE: FII derivatives statistics (content/fo/fii_stats_DD-Mon-YYYY.xls)")
    for d in days:
        url = f"{NSE_ARCH}/content/fo/fii_stats_{d:%d-%b-%Y}.xls"
        st, body = get(s, url, referer=NSE + "/")
        if st == 200 and body:
            show_xls(body)

    head("NSE: FII/DII cash, provisional (api/fiidiiTradeReact and neighbours)")
    for path in ("/api/fiidiiTradeReact", "/api/fiidiiTradeNse", "/api/fiidii-trade-react",
                 "/api/historical/fii-dii?from=01-10-2026&to=31-10-2026"):
        st, body = get(s, NSE + path, referer=NSE + "/reports/fii-dii")
        if st == 200 and body:
            show_json(body, 30)
    st, body = get(s, NSE + "/reports/fii-dii", referer=NSE + "/")
    if st == 200:
        page_digest(body, NSE + "/reports/fii-dii")

    head("NSE: CM category-wise turnover candidates")
    for d in days[:1] + days[-1:]:
        for url in (f"{NSE_ARCH}/content/cm/cat_turnover_{d:%d%m%y}.xls",
                    f"{NSE_ARCH}/archives/equities/cat/cat_turnover_{d:%d%m%y}.xls",
                    f"{NSE_ARCH}/content/equities/cat_turnover_{d:%d%m%y}.xls"):
            st, body = get(s, url, referer=NSE + "/")
            if st == 200 and body and len(body) > 200:
                show_xls(body)


def probe_pulse(s):
    head("NSE: Market Pulse (listing, then the category-wise turnover table)")
    pdfs = []
    for url in (NSE + "/research/publications-reports-market-pulse",
                NSE + "/static/research/publications-reports-market-pulse",
                NSE + "/api/research-reports?type=market-pulse",
                NSE + "/api/publications?type=MarketPulse"):
        st, body = get(s, url, referer=NSE + "/")
        if st == 200 and body:
            text = decode(body)
            found = sorted(set(re.findall(r"https?://[^\"'\s]+?Market[^\"'\s]*?Pulse[^\"'\s]*?\.pdf", text, re.I)))
            found += sorted(set(urljoin(NSE_ARCH, x) for x in re.findall(r"[\"'](/[^\"'\s]*Pulse[^\"'\s]*\.pdf)", text, re.I)))
            say(f"  Market Pulse PDF links: {len(found)} {found[:15]}")
            pdfs += found
            if not found:
                page_digest(body, url)
    try:
        import pdfplumber
    except ImportError:
        say("  pdfplumber not installed: skipping table extraction")
        return
    for url in (pdfs[:1] + PULSE_KNOWN)[:3]:
        st, body = get(s, url, referer=NSE + "/")
        if st != 200 or not body.startswith(b"%PDF"):
            continue
        try:
            with pdfplumber.open(io.BytesIO(body)) as pdf:
                say(f"  {len(pdf.pages)} pages")
                shown = 0
                for i, page in enumerate(pdf.pages):
                    text = page.extract_text() or ""
                    if not re.search(r"category[- ]wise", text, re.I) or not re.search(r"turnover", text, re.I):
                        continue
                    say(f"  -- page {i + 1} (mentions category-wise turnover)")
                    for line in text.splitlines():
                        if re.search(r"categor|individual|propriet|fpi|dii|corporate|nri|other|share|turnover|cash|future|option", line, re.I):
                            say("  | " + line[:300])
                    for t in page.extract_tables()[:3]:
                        say("  table:")
                        for row in t[:20]:
                            say("  | " + " ¦ ".join("" if c is None else str(c) for c in row))
                    shown += 1
                    if shown >= 3:
                        break
        except Exception as e:
            say(f"  PDF read failed: {type(e).__name__}: {e}")


def probe_bse(s, days):
    pages = {
        "BSE: F&O participant-wise volume / OI": BSE + "/markets/Derivatives/DeriReports/DeriMarketDisclosures.aspx",
        "BSE: investor category-wise turnover (cash)": BSE + "/markets/equity/EQReports/categorywise_turnover.aspx",
    }
    for title, url in pages.items():
        head(title)
        st, body = get(s, url, referer=BSE + "/")
        if st == 200 and body:
            scripts, files = page_digest(body, url)
            show_html_tables(body, max_tables=4, max_rows=12)
            grep_scripts(s, scripts, ("ateg", "articip", "isclos", "Deri", "FII", "Turnover"), referer=url)
            for f in files[:4]:
                fst, fb = get(s, f, referer=url)
                if fst == 200 and fb:
                    show_text(fb, 12)
    # Endpoint guesses in BSE's usual naming, kept only if they answer with data
    head("BSE: API guesses (kept only if they answer)")
    d0, d1 = days[-1], days[0]
    for path in (
        f"/BseIndiaAPI/api/ParticipantWiseTrading/w?Fdate={d0:%Y%m%d}&TDate={d1:%Y%m%d}",
        f"/BseIndiaAPI/api/DeriParticipantWise/w?date={d1:%d/%m/%Y}",
        f"/BseIndiaAPI/api/CategoryWiseTurnover/w?fromdate={d0:%Y%m%d}&todate={d1:%Y%m%d}",
        f"/BseIndiaAPI/api/categorywise_turnover/w?fdate={d0:%Y%m%d}&tdate={d1:%Y%m%d}",
        "/BseIndiaAPI/api/FIIDIIData/w",
    ):
        st, body = get(s, BSE_API + path, referer=BSE + "/", accept="application/json, text/plain, */*")
        if st == 200 and body and len(body) > 20:
            show_json(body, 20)


def probe_nsdl(s):
    head("NSDL: FPI daily (Latest), monthly and archive pages")
    for path in ("/web/Reports/Latest.aspx", "/web/Reports/Monthly.aspx", "/web/Reports/Archive.aspx",
                 "/web/Reports/Yearwise.aspx", "/web/Reports/FPI_Fortnightly_Selection.aspx"):
        url = NSDL + path
        st, body = get(s, url, referer=NSDL + "/")
        if st == 200 and body:
            page_digest(body, url)
            show_html_tables(body, max_tables=4, max_rows=30)


def main():
    from nse_pipeline import nse_session
    from bse_pipeline import _make_bse_session
    from curl_cffi import requests as cffi_requests

    days = [date.fromisoformat(x) for x in sys.argv[1:]] or trading_days()
    say(f"Participants source probe — {datetime.utcnow():%Y-%m-%d %H:%M} UTC — dates {[d.isoformat() for d in days]}")
    OUT.mkdir(exist_ok=True)

    steps = [("NSE", lambda: probe_nse(nse_session(), days)),
             ("NSE Market Pulse", lambda: probe_pulse(nse_session())),
             ("BSE", lambda: probe_bse(_make_bse_session(), days)),
             ("NSDL", lambda: probe_nsdl(cffi_requests.Session()))]
    for name, step in steps:
        try:
            step()
        except Exception as e:  # one source failing must not hide the others
            say(f"\n!! {name} probe failed: {type(e).__name__}: {e}")
    say("\nRaw replies saved under probe/ (the workflow uploads them as an artifact).")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
