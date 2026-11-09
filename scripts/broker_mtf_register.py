"""Brokers' MTF books as their own filings state them: the hand-kept register
behind dashboard/data/mtf_brokers.json (MTF mode, NSE + BSE view, Brokers tab).

No exchange publishes broker-wise MTF books any more (NSE's member-wise "Client
Funding" report ended in Apr 2021), so each figure here comes from a document a
broker or its parent published: an investor presentation, shareholders' letter,
results press release, monthly business update, credit rating rationale or a
founder's post. BROKERS[id]["sources"] names each broker's best recurring
source (researched 9 Nov 2026) and when its next figure is due; add the figure
when it comes out (.claude/skills/broker-mtf/SKILL.md). mtf_pipeline.py
(brokers_doc) prices every figure against the exchanges' combined book (NSE +
BSE, mtf_daily.json) on its date, and prints the brokers whose next figure is
due. tests/test_broker_mtf_register.py runs validate().

Conventions:
- One dict per figure in DISCLOSURES: broker, as_of (the date the figure is
  for: a period end, or the month's last day for a monthly average), exactly one
  of book_cr (₹ crore, as precise as the document gives) or share_pct (a market
  share the filing states), measure, basis, source (document name), url (the
  primary document, never an aggregator), page (PDF page; None for a web page),
  quote (the document's words, with the figure), and optional note / rounded /
  precision.
- measure says what the figure is, since brokers report different things:
  share           a market share as published (ICICI Bank and Kotak Bank state
                  their broking arms' share, not a book); the book is derived
                  from it as share × the exchanges' book on that date
  gross           the gross MTF book: the basis the exchanges' book is on
  net             net of client cash collateral, or the balance-sheet loan line
                  (usually 80–87 % of gross, so its share understates)
  client_funding  MTF plus interest-bearing trade receivables (Angel One
                  publishes no MTF-only figure), so its share overstates
  unstated        the document calls it the MTF book without saying which
- basis: period_end, or month_avg (Angel One's monthly business update).
- precision 'integer' marks a share the filing rounds to a whole number
  ("~14 %"); rounded marks a ₹ figure the document rounds ("₹9,600+ Cr").
- Changes and market-share moves are only measured between figures of the same
  measure and basis (brokers_doc), and from 1 Oct 2025 the exchanges' book is on
  revised (gross) reporting (MTF_NOTES in dashboard/js/40-mtf.js).
- Never cite mtf.trading or a news site: a Sep 2026 copy of mtf.trading's broker
  file (Supabase mtf.broker_mtf_history) seeded this register, and each of its
  figures was re-checked in the document it cites before it went in.
"""

import re

MEASURES = ("share", "gross", "net", "client_funding", "unstated")
BASES = ("period_end", "month_avg")
CADENCES = ("monthly", "quarterly", "irregular")
TYPES = ("bank", "discount", "full_service")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Each broker's best recurring source. cadence + lag_days give when the next figure
# is due (mtf_pipeline.brokers_due): quarterly / monthly = the next period end plus
# lag_days; irregular = lag_days after the latest figure. primary = the measure and
# basis the league table and charts follow; other figures stay in the table's history.
BROKERS = {
    "icicidirect": {
        "name": "ICICI Securities", "short": "ICICI Direct", "type": "bank", "parent": "ICICI Bank",
        "primary": {"measure": "share", "basis": "period_end"},
        "sources": {
            "primary": "ICICI Bank quarterly investor presentation, 'Key subsidiaries' slide",
            "where": "icici.bank.in/about-us/qfr; also filed on NSE / BSE",
            "cadence": "quarterly", "lag_days": 20,
            "metric": "'Market share in MTF of about X %' (one decimal, gross basis)",
            "fallbacks": "CRISIL rationale on ICICI Securities (about yearly; balance-sheet book, net); "
                         "ICICI Securities' own results on NSE's debt segment",
        },
    },
    "kotaksec": {
        "name": "Kotak Securities", "short": "Kotak Sec", "type": "bank", "parent": "Kotak Mahindra Bank",
        "primary": {"measure": "share", "basis": "period_end"},
        "sources": {
            "primary": "Kotak Mahindra Bank quarterly investor presentation, Kotak Securities slide",
            "where": "kotak.bank.in investor relations, …/QuarterlyReport/FY-YYYY/qN/…",
            "cadence": "quarterly", "lag_days": 28,
            "metric": "'Market share in Margin Trading Funding (MTF): ~X %' (whole number, so about ±₹800 Cr)",
            "fallbacks": "ICRA rationale on Kotak Securities (MTF book at a month end); KSL's special-purpose "
                         "results on NSE's debt segment ('Advances', balance sheet)",
        },
    },
    "hdfcsec": {
        "name": "HDFC Securities", "short": "HDFC Sec", "type": "bank", "parent": "HDFC Bank",
        "primary": {"measure": "gross", "basis": "period_end"},
        "sources": {
            "primary": "ICRA / CARE rating rationales on HDFC Securities",
            "where": "icra.in, careratings.com",
            "cadence": "irregular", "lag_days": 150,
            "metric": "'gross MTF book' and 'net MTF book' (₹ Cr); HDFC Bank's presentation gives no MTF figure",
            "fallbacks": "HDFC Securities' annual report ('MTF portfolio', net)",
        },
    },
    "motilaloswal": {
        "name": "Motilal Oswal Financial Services", "short": "Motilal Oswal", "type": "full_service", "parent": None,
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "Quarterly results press release (in the investor-presentation filing on NSE)",
            "where": "nsearchives.nseindia.com/corporate/MOTILALOFS_…",
            "cadence": "quarterly", "lag_days": 32,
            "metric": "'Group Margin Trade Funding (MTF) book' (₹ Cr, rounded, e.g. '₹9,600+ Cr')",
            "fallbacks": "Annual report, note 'Loans': margin trading facility (standalone)",
        },
    },
    "zerodha": {
        "name": "Zerodha Broking", "short": "Zerodha", "type": "discount", "parent": None,
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "Zerodha's Z-Connect posts and Nithin Kamath's blog",
            "where": "zerodha.com/z-connect, nithinkamath.me",
            "cadence": "irregular", "lag_days": 120,
            "metric": "rounded 'book size' (and what clients have 'borrowed'); unaudited",
            "fallbacks": "Annual financial statements (MCA filing, about Oct–Nov)",
        },
    },
    "bajajbroking": {
        "name": "Bajaj Financial Securities", "short": "Bajaj Broking", "type": "full_service", "parent": "Bajaj Finance",
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "Bajaj Finance quarterly investor presentation, Bajaj Financial Securities slide",
            "where": "cms-assets.bajajfinserv.in; also filed on NSE (BAJFINANCE_…InvestorPPT…)",
            "cadence": "quarterly", "lag_days": 22,
            "metric": "'AUM … (MTF: ₹X crore …)' = the Branch and Retail slides' 'MTF book stood at' figures added",
            "fallbacks": "CRISIL / ICRA rationale on Bajaj Financial Securities",
        },
    },
    "angelone": {
        "name": "Angel One", "short": "Angel One", "type": "discount", "parent": None,
        "primary": {"measure": "client_funding", "basis": "period_end"},
        "sources": {
            "primary": "Quarterly investor presentation (period end); monthly business update on NSE (monthly average)",
            "where": "angelone.in investor relations; nsearchives.nseindia.com/corporate/ANGEL…",
            "cadence": "quarterly", "lag_days": 18,
            "metric": "'Client Funding Book': MTF loans plus interest-bearing trade receivables (no MTF-only figure)",
            "fallbacks": "Monthly business update, 'Avg Client Funding Book (₹ Bn)', about the 5th of the next month",
        },
    },
    "axisdirect": {
        "name": "Axis Securities", "short": "Axis Direct", "type": "bank", "parent": "Axis Bank",
        "primary": {"measure": "net", "basis": "period_end"},
        "sources": {
            "primary": "CARE / ICRA / CRISIL rating rationales on Axis Securities",
            "where": "careratings.com, icra.in, crisilratings.com",
            "cadence": "irregular", "lag_days": 150,
            "metric": "'MTF book' (₹ Cr) = the balance-sheet loan line, so net",
            "fallbacks": "Axis Securities' own results on NSE's debt segment ('Loans')",
        },
    },
    "groww": {
        "name": "Groww", "short": "Groww", "type": "discount", "parent": None,
        "primary": {"measure": "net", "basis": "period_end"},
        "sources": {
            "primary": "Quarterly Shareholders' Letter",
            "where": "resources.groww.in/web-assets/media-library/…; also filed on NSE / BSE",
            "cadence": "quarterly", "lag_days": 18,
            "metric": "'MTF Book': the outstanding funded MTF balance at the period end",
            "fallbacks": "groww.in/investor-relations 'MTF Net Book' (near-live)",
        },
    },
    "sbisec": {
        "name": "SBICAP Securities", "short": "SBI Sec", "type": "bank", "parent": "State Bank of India",
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "ICRA rating rationales on SBICAP Securities",
            "where": "icra.in",
            "cadence": "irregular", "lag_days": 200,
            "metric": "'MTF book' (₹ Cr)",
            "fallbacks": "SBI's annual report (subsidiaries)",
        },
    },
    "miraesharekhan": {
        "name": "Mirae Asset Sharekhan", "short": "Mirae Sharekhan", "type": "full_service", "parent": "Mirae Asset",
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "ICRA rating rationale on Mirae Asset Capital Markets (the group, incl. Sharekhan and mStock)",
            "where": "icra.in",
            "cadence": "irregular", "lag_days": 300,
            "metric": "the group's MTF / consolidated loan book (₹ Cr)",
            "fallbacks": "CRISIL rationale (no MTF figure in the last one)",
        },
    },
    "jmfinancial": {
        "name": "JM Financial Services", "short": "JM Financial", "type": "full_service", "parent": "JM Financial",
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "JM Financial Ltd quarterly press release / investor presentation",
            "where": "nsearchives.nseindia.com/corporate/JMFINANCIL_…",
            "cadence": "quarterly", "lag_days": 38,
            "metric": "MTF / 'wealth loan book' (₹ Cr)",
            "fallbacks": "ICRA rationale on JM Financial Services ('MTF book')",
        },
    },
    "nuvama": {
        "name": "Nuvama Wealth and Investment", "short": "Nuvama", "type": "full_service", "parent": "Nuvama Wealth Management",
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "ICRA rating rationales on Nuvama Wealth and Investment (NWIL)",
            "where": "icra.in",
            "cadence": "irregular", "lag_days": 200,
            "metric": "'short-tenor MTF book' (₹ Cr); Nuvama's deck gives only its total loan book (ESOP + LAS + MTF)",
            "fallbacks": "NWIL annual report, note 'Loans': margin trading facility",
        },
    },
    "iifl": {
        "name": "IIFL Capital Services", "short": "IIFL Capital", "type": "full_service", "parent": None,
        "primary": {"measure": "net", "basis": "period_end"},
        "sources": {
            "primary": "Quarterly investor presentation",
            "where": "nsearchives.nseindia.com/corporate/IIFLSEC_…InvestorPresentation.pdf",
            "cadence": "quarterly", "lag_days": 32,
            "metric": "'Net Margin Trading Facility (MTF) Book (₹ Bn)'",
            "fallbacks": "CRISIL rationale on IIFL Capital Services ('MTF book (net)')",
        },
    },
    "anandrathi": {
        "name": "Anand Rathi Share and Stock Brokers", "short": "Anand Rathi", "type": "full_service", "parent": None,
        "primary": {"measure": "unstated", "basis": "period_end"},
        "sources": {
            "primary": "Quarterly results press release",
            "where": "nsearchives.nseindia.com/corporate/ARSSBL_…PressRelease…",
            "cadence": "quarterly", "lag_days": 18,
            "metric": "'MTF book' (₹ mn)",
            "fallbacks": "ICRA / CARE rationales on Anand Rathi Share and Stock Brokers",
        },
    },
}

DISCLOSURES = [
]


def validate(brokers=None, disclosures=None):
    """Problems with the register, as a list of strings (empty = valid)."""
    brokers = BROKERS if brokers is None else brokers
    disclosures = DISCLOSURES if disclosures is None else disclosures
    out = []
    for bid, b in brokers.items():
        if not re.fullmatch(r"[a-z0-9]+", bid):
            out.append(f"{bid}: id must be lower-case letters and digits")
        for k in ("name", "short", "type", "primary", "sources"):
            if not b.get(k):
                out.append(f"{bid}: missing {k}")
        if b.get("type") not in TYPES:
            out.append(f"{bid}: type {b.get('type')!r} not in {TYPES}")
        p = b.get("primary") or {}
        if p.get("measure") not in MEASURES or p.get("basis") not in BASES:
            out.append(f"{bid}: primary {p!r} needs a known measure and basis")
        s = b.get("sources") or {}
        for k in ("primary", "where", "cadence", "lag_days", "metric"):
            if s.get(k) in (None, ""):
                out.append(f"{bid}: sources missing {k}")
        if s.get("cadence") not in CADENCES:
            out.append(f"{bid}: cadence {s.get('cadence')!r} not in {CADENCES}")
        if not isinstance(s.get("lag_days"), int) or s.get("lag_days", 0) <= 0:
            out.append(f"{bid}: lag_days must be a positive whole number of days")
        if not any(d.get("broker") == bid and d.get("measure") == p.get("measure") and d.get("basis") == p.get("basis")
                   for d in disclosures):
            out.append(f"{bid}: no figure on its primary measure {p.get('measure')} / {p.get('basis')}")

    seen, prev = set(), None
    for i, d in enumerate(disclosures):
        tag = f"{d.get('broker')} {d.get('as_of')} ({i})"
        if d.get("broker") not in brokers:
            out.append(f"{tag}: unknown broker")
        if not _ISO.match(str(d.get("as_of", ""))):
            out.append(f"{tag}: as_of must be YYYY-MM-DD")
        book, share = d.get("book_cr"), d.get("share_pct")
        if (book is None) == (share is None):
            out.append(f"{tag}: give exactly one of book_cr and share_pct")
        if share is not None and d.get("measure") != "share":
            out.append(f"{tag}: share_pct needs measure 'share'")
        if book is not None and d.get("measure") == "share":
            out.append(f"{tag}: measure 'share' needs share_pct, not book_cr")
        for v, lo, hi, name in ((book, 1, 200000, "book_cr"), (share, 0.01, 60, "share_pct")):
            if v is not None and (not isinstance(v, (int, float)) or isinstance(v, bool) or not lo <= v <= hi):
                out.append(f"{tag}: {name} {v!r} out of range")
        if d.get("measure") not in MEASURES:
            out.append(f"{tag}: measure {d.get('measure')!r} not in {MEASURES}")
        if d.get("basis") not in BASES:
            out.append(f"{tag}: basis {d.get('basis')!r} not in {BASES}")
        if d.get("precision") not in (None, "integer"):
            out.append(f"{tag}: precision must be 'integer' or absent")
        if d.get("rounded") not in (None, True):
            out.append(f"{tag}: rounded must be True or absent")
        if not str(d.get("url", "")).startswith("https://"):
            out.append(f"{tag}: url must be https")
        if "mtf.trading" in str(d.get("url", "")):
            out.append(f"{tag}: cite the primary document, not mtf.trading")
        if not str(d.get("source", "")).strip() or not str(d.get("quote", "")).strip():
            out.append(f"{tag}: source and quote are required")
        if d.get("page") is not None and (not isinstance(d["page"], int) or d["page"] < 1):
            out.append(f"{tag}: page must be a positive whole number or None")
        extra = set(d) - {"broker", "as_of", "book_cr", "share_pct", "measure", "basis", "precision", "rounded",
                          "source", "url", "page", "quote", "note"}
        if extra:
            out.append(f"{tag}: unknown fields {sorted(extra)}")
        key = (d.get("broker"), d.get("as_of"), d.get("measure"), d.get("basis"))
        if key in seen:
            out.append(f"{tag}: duplicate figure for {key}")
        seen.add(key)
        order = (list(brokers).index(d["broker"]) if d.get("broker") in brokers else -1, str(d.get("as_of")))
        if prev is not None and order < prev:
            out.append(f"{tag}: rows must follow BROKERS order, then as_of")
        prev = order
    return out
