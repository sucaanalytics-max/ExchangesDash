"""
NSE commodity derivatives: daily volume per underlying from NSE's commodity
bhavcopy, set against MCX's own per-commodity bhavcopy rows, and NSE's
commodity transaction-charge revenue.

Writes dashboard/data/nse_commodity_daily.json, which the MCX view's
Competition tab reads (dashboard/js/19-mcx-competition.js).

NSE source: the UDiFF commodity bhavcopy
  https://nsearchives.nseindia.com/content/com/BhavCopy_NSE_CO_0_0_0_YYYYMMDD_F_0000.csv.zip
one row per contract. FinInstrmTp COF = futures, FUO = options on futures,
COO = options on goods (silver). TtlTradgVol is lots, TtlTrfVal is ₹ notional:
for an option, (strike + traded premium) × multiplier × lots. So the premium
is derived exactly as TtlTrfVal − strike × multiplier × lots. On 17 Nov 2026
that gave ₹103.1137 Cr against the ₹103.1136557 Cr in NSE's own market
turnover summary, and futures and options notional and trade counts matched
too. Each option row's implied average premium is checked against its
low–high range (to rounding: all of 10 Nov 2026's expiry-day rows pass), which
also validates OPTION_MULTIPLIER. An option traded on an
underlying with no known multiplier leaves that underlying's premium null and
warns. Each day also lists, as `xo`, the underlyings with an options contract
expiring that day (XpryDt = TradDt, traded or not): NSE's crude options expire
about a week before MCX's and most of NSE's volume comes on that day and the
one before, which the Competition tab's revenue-at-risk split needs.

MCX source: Supabase mcx_commodity_daily (the "OctoTusk + MCX" project, MCX's
bhavcopy per commodity and instrument, written by mcx-vercel): turnover_cr is
notional, and premium_turnover_cr is the options premium.

Shares are per underlying (UNDERLYINGS), never per contract, since NSE's and
MCX's contract sizes differ. A day whose MCX rows have not landed yet gets
`mcx: null` and no share, never a 100 % NSE share. The series starts on
2024-09-02, MCX's first actual (non-modelled) day. Dates are the commodity
calendar (MCX's own trading days, from mcx_dashboard_data.json), plus
weekdays after MCX's latest day that NSE may already have posted.

Revenue (scripts/fee_register.py, products com_fut / com_fut_elec / com_opt):
  com_rev_cr      at today's statutory rates, the basis of the whole dashboard;
  com_rev_eff_cr  at the rule in force each day (electricity futures were free
                  from 14 Jul to 31 Dec 2025, NSE/FA/69100).
Both are 2 × rate per side × turnover (futures on notional, options on
premium). Neither is added to NSE's equity total_rev: NSE's commodity revenue
is about ₹0.001–0.01 Cr a day.

Revenue per underlying (`ru`, ₹ Cr at today's rates), for the Competition
tab's top-commodities view: NSE's from fee_register as above; MCX's is its own
reported futures and options revenue for the day (mcx_dashboard_data.json,
fut_rev / opt_rev, written by mcx_pipeline.py from mcx-vercel) split across
underlyings by their share of that day's futures notional and options premium.
MCX's reported revenue is a flat rate on both (no MCX rate is kept here), so
the split is the same as pricing each underlying.

Runs in exchange-update.yml's mcx-update job, after mcx_pipeline.py. Each run
re-reads the last RECENT_DAYS dates and backfills up to BACKFILL_PER_RUN older
ones (MANUAL_BACKFILL on a manual run, which also retries days marked
unavailable). Environment: MCX_SUPABASE_KEY (required), EVENT / SLOT (as in
mtf_pipeline.py), NSE_COM_BACKFILL (overrides the budget).
"""

import csv
import io
import json
import os
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import fee_register  # noqa: E402
import take_rates  # noqa: E402
import trading_calendar  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "dashboard" / "data"
OUT_PATH = DATA_DIR / "nse_commodity_daily.json"
MCX_DATES_PATH = DATA_DIR / "mcx_dashboard_data.json"
NEW_DAYS_FILE = ROOT / ".new_nse_com_days_count"

NSE_URL = ("https://nsearchives.nseindia.com/content/com/"
           "BhavCopy_NSE_CO_0_0_0_{ymd}_F_0000.csv.zip")
HISTORY_START = date(2024, 9, 2)
RECENT_DAYS = 3             # re-read every run (a file posted late, or replaced)
BACKFILL_PER_RUN = 40
MANUAL_BACKFILL = 700       # every commodity day since 2024-09-02 in one run
PENDING_DAYS = 4            # a 404 this recent is "not posted yet", older is unavailable
PAUSE_S = 0.3
STOP_STATUSES = (401, 403, 429)
PARSER_VERSION = 2          # bump when a parser fix changes stored figures (2: options expiries, xo)

# Underlyings shared by both exchanges: key → (label, NSE symbols, MCX symbols).
# Contract sizes differ (GOLD 1 kg, GOLDM 100 g, GOLD10G 10 g …), so every
# share is taken on the underlying, in ₹ notional or premium.
UNDERLYINGS = {
    "crude":       ("Crude oil",   ("CRUDEOIL", "CRUDEOILM"), ("CRUDEOIL", "CRUDEOILM")),
    "brent":       ("Brent crude", ("BRCRUDEOIL",), ()),
    "natgas":      ("Natural gas", ("NATURALGAS", "NATGASMINI"), ("NATURALGAS", "NATGASMINI")),
    "natgas_ind":  ("Natural gas (India)", ("NATGASIND",), ()),
    "gold":        ("Gold",        ("GOLD", "GOLDM", "GOLD10G", "GOLD1G", "GOLDGUINEA", "GOLDPETAL", "GOLDTEN"),
                    ("GOLD", "GOLDM", "GOLDGUINEA", "GOLDPETAL", "GOLDTEN")),
    "silver":      ("Silver",      ("SILVER", "SILVERM", "SILVER100", "SILVERMIC"),
                    ("SILVER", "SILVERM", "SILVERMIC", "SILVER100")),
    "electricity": ("Electricity", ("ELECMBL",), ("ELECDMBL", "ELECMBL")),
    "copper":      ("Copper",      ("COPPER",), ("COPPER",)),
    "aluminium":   ("Aluminium",   ("ALUMINIUM", "ALUMINI"), ("ALUMINIUM", "ALUMINI")),
    "zinc":        ("Zinc",        ("ZINC", "ZINCMINI"), ("ZINC", "ZINCMINI")),
    "lead":        ("Lead",        ("LEAD", "LEADMINI"), ("LEAD", "LEADMINI")),
    "nickel":      ("Nickel",      ("NICKEL",), ("NICKEL",)),
    "steel":       ("Steel rebar", (), ("STEELREBAR",)),
    "agri":        ("Agri",        (), ()),            # MCX's AGRO COMMODITIES head
    "index":       ("Indices",     (), ()),            # MCX's FUTIDX / OPTIDX (BULLDEX, METLDEX …)
}
NSE_SYMBOL = {s: k for k, (_, nse, _) in UNDERLYINGS.items() for s in nse}
MCX_SYMBOL = {s: k for k, (_, _, mcx) in UNDERLYINGS.items() for s in mcx}

# Units of the underlying per lot for the price NSE quotes, for options only
# (futures need none: TtlTrfVal is already the notional). Confirmed on every
# traded row of a monthly sample from Sep 2024 to Nov 2026.
OPTION_MULTIPLIER = {"CRUDEOIL": 100, "NATURALGAS": 1250, "SILVER": 30}

NSE_INSTRUMENT = {"COF": "fut", "FUO": "opt", "COO": "opt"}
MCX_INSTRUMENT = {"FUTCOM": "fut", "OPTFUT": "opt", "FUTIDX": "fut", "OPTIDX": "opt"}

NOTES = [
    {"date": "2025-07-14", "label": "NSE electricity futures launch (fee-free to 31 Dec 2025)"},
    {"date": "2026-01-01", "label": "NSE electricity futures fee waiver ends"},
]


class FetchError(Exception):
    def __init__(self, msg, refused=False):
        super().__init__(msg)
        self.refused = refused


# ═══════════════════════════════════════════════════════════════
# NSE
# ═══════════════════════════════════════════════════════════════

def _f(x):
    try:
        return float(x or 0)
    except ValueError:
        return 0.0


def _round(x, n=4):
    return None if x is None else round(x, n)


def compact(out, nd=4):
    """{underlying: {fut|opt: totals}} → the stored form {underlying: {"f":
    [contracts, notional ₹ Cr], "o": [contracts, notional ₹ Cr, premium ₹ Cr or
    null]}}, keeping only cells that traded."""
    res = {}
    for und in sorted(out):
        cells = {}
        for inst, c in out[und].items():
            if not c["contracts"] and not c["notional_cr"]:
                continue
            if inst == "fut":
                cells["f"] = [c["contracts"], _round(c["notional_cr"], nd)]
            else:
                cells["o"] = [c["contracts"], _round(c["notional_cr"], nd), _round(c["premium_cr"], nd)]
        if cells:
            res[und] = cells
    return res


def parse_bhavcopy(zip_bytes):
    """(TradDt, compact {underlying: {"f": [...], "o": [...]}}, checks, xo) from one
    day's bhavcopy zip. Only contracts that traded count; xo is the sorted list of
    underlyings with an options contract expiring that day, traded or not."""
    z = zipfile.ZipFile(io.BytesIO(zip_bytes))
    name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
    rows = csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))
    out, checks, bad_rows, no_mult, expiring = {}, [], {}, set(), set()
    trade_date = None
    for r in rows:
        trade_date = trade_date or r.get("TradDt")
        inst = NSE_INSTRUMENT.get(r.get("FinInstrmTp"))
        sym = (r.get("TckrSymb") or "").strip()
        xp = (r.get("XpryDt") or "").strip()
        if inst == "opt" and xp and xp == (r.get("TradDt") or "").strip():
            expiring.add(NSE_SYMBOL.get(sym, sym.lower()))
        lots = _f(r.get("TtlTradgVol"))
        if lots <= 0:
            continue
        if inst is None:
            msg = f"unknown instrument type {r.get('FinInstrmTp')!r} ({sym}): left out"
            if msg not in checks:
                checks.append(msg)
            continue
        und = NSE_SYMBOL.get(sym)
        if und is None:
            und = sym.lower()
            if f"unmapped NSE symbol {sym}" not in checks:
                checks.append(f"unmapped NSE symbol {sym}")
        cell = out.setdefault(und, {}).setdefault(inst, {
            "contracts": 0, "notional_cr": 0.0, **({"premium_cr": 0.0} if inst == "opt" else {})})
        val = _f(r.get("TtlTrfVal"))
        cell["contracts"] += int(lots)
        cell["notional_cr"] += val / 1e7
        if inst == "opt":
            mult = OPTION_MULTIPLIER.get(sym)
            if mult is None:
                no_mult.add(sym)
                cell["premium_cr"] = None
                continue
            strike = _f(r.get("StrkPric"))
            prem = val - strike * mult * lots
            if cell["premium_cr"] is not None:
                cell["premium_cr"] += prem / 1e7
            avg = prem / (mult * lots)
            lo, hi = _f(r.get("LwPric")), _f(r.get("HghPric"))
            # Rounding only: TtlTrfVal is in paise, so the derived average is exact
            # to well under a paisa. (A tolerance scaled to the strike would exceed
            # the price of most expiry-day options and could not catch them.)
            tol = 0.01 + 1e-6 * strike
            if not (lo - tol <= avg <= hi + tol):
                bad_rows[sym] = bad_rows.get(sym, 0) + 1
    for sym in sorted(no_mult):
        checks.append(f"options traded on {sym} with no known multiplier: premium left null")
    for sym, n in sorted(bad_rows.items()):
        checks.append(f"{sym}: {n} option row(s) whose derived premium is outside the day's price range")
    return trade_date, compact(out), checks, sorted(expiring)


def fetch_nse(session, d):
    """(url, zip bytes or None, reason). None = not posted (404 / not a zip);
    FetchError = try again next run."""
    url = NSE_URL.format(ymd=d.strftime("%Y%m%d"))
    try:
        r = session.get(url, timeout=30, headers={"Referer": "https://www.nseindia.com/"})
    except Exception as e:  # curl_cffi raises its own error types
        raise FetchError(f"{type(e).__name__}: {e}") from e
    if r.status_code == 404:
        return url, None, "not posted (HTTP 404)"
    if r.status_code != 200:
        raise FetchError(f"HTTP {r.status_code}", refused=r.status_code in STOP_STATUSES)
    body = r.content or b""
    if len(body) < 64 or not body.startswith(b"PK"):
        return url, None, f"not posted ({len(body)}-byte reply, not a zip)"
    return url, body, None


def make_session():
    from curl_cffi import requests as cffi
    return cffi.Session(impersonate="chrome")


# ═══════════════════════════════════════════════════════════════
# MCX
# ═══════════════════════════════════════════════════════════════

def fetch_mcx_rows(start=HISTORY_START):
    """mcx_commodity_daily rows from `start` on, the columns the shares need."""
    import mcx_pipeline
    return mcx_pipeline._sb_get(
        "mcx_commodity_daily"
        "?select=trading_date,commodity,commodity_head,instrument_type,contracts,turnover_cr,premium_turnover_cr"
        f"&trading_date=gte.{start.isoformat()}"
        "&order=trading_date.asc,commodity.asc,instrument_type.asc",
        max_rows=500_000,
    )


def mcx_underlying(r):
    if r.get("instrument_type") in ("FUTIDX", "OPTIDX"):
        return "index"
    sym = (r.get("commodity") or "").strip().upper()
    if sym in MCX_SYMBOL:
        return MCX_SYMBOL[sym]
    if sym.startswith("ELEC"):
        return "electricity"
    if "AGRO" in (r.get("commodity_head") or "").upper():
        return "agri"
    return sym.lower()


def mcx_by_date(rows):
    """{date: compact {underlying: {"f": [...], "o": [...]}}} and the MCX symbols
    with turnover that matched no underlying. Rows with no contracts and no
    turnover are skipped; a day with no turnover at all is left out (its rows
    have not landed)."""
    out, unmapped = {}, set()
    for r in rows:
        d, inst = r.get("trading_date"), MCX_INSTRUMENT.get(r.get("instrument_type"))
        con, notional = int(r.get("contracts") or 0), _f(r.get("turnover_cr"))
        if not d or inst is None or (con <= 0 and notional <= 0):
            continue
        und = mcx_underlying(r)
        if und not in UNDERLYINGS:
            unmapped.add(r.get("commodity"))
        cell = out.setdefault(d, {}).setdefault(und, {}).setdefault(inst, {
            "contracts": 0, "notional_cr": 0.0, **({"premium_cr": 0.0} if inst == "opt" else {})})
        cell["contracts"] += con
        cell["notional_cr"] += notional
        if inst == "opt":
            cell["premium_cr"] += _f(r.get("premium_turnover_cr"))
    keep = {}
    for d, unds in out.items():
        if sum(c["notional_cr"] for u in unds.values() for c in u.values()) > 0:
            keep[d] = compact(unds, 2)
    return keep, sorted(s for s in unmapped if s)


# ═══════════════════════════════════════════════════════════════
# REVENUE, TOTALS, PERIODS
# ═══════════════════════════════════════════════════════════════

def _fut_product(und):
    return "com_fut_elec" if und == "electricity" else "com_fut"


def revenue_by_underlying(nse, d=None):
    """NSE's commodity transaction-charge revenue (₹ Cr) per underlying for one
    day's compact aggregates: at today's rates, or at the rules in force on `d`.
    Futures are charged on notional, options on premium (an unknown premium
    counts as 0 and is listed in the day's checks)."""
    today = {"com_fut": take_rates.NSE_TR_COM_FUT, "com_fut_elec": take_rates.NSE_TR_COM_FUT_ELEC,
             "com_opt": take_rates.NSE_TR_COM_OPT}
    out = {}
    for und, cells in nse.items():
        total = 0.0
        for inst, c in cells.items():
            prod = _fut_product(und) if inst == "f" else "com_opt"
            base = c[1] if inst == "f" else (c[2] or 0.0)
            rate = fee_register.rate("NSE", prod, d)[0] if d else today[prod]
            total += base * rate
        out[und] = total
    return out


def revenue(nse, d=None):
    """NSE's commodity transaction-charge revenue (₹ Cr) for one day, all
    underlyings (see revenue_by_underlying)."""
    return round(sum(revenue_by_underlying(nse, d).values()), 6)


def mcx_revenue_by_underlying(mcx, fut_rev, opt_rev):
    """MCX's reported revenue for one day (₹ Cr, futures and options) split
    across underlyings by their share of the day's futures notional and options
    premium. None when MCX's rows or its reported revenue are missing, or when
    revenue has nothing to split over (2026-06-23: every MCX option row has
    premium 0, against ₹6.15 Cr of reported options revenue)."""
    if not mcx or fut_rev is None or opt_rev is None:
        return None
    fut = {u: c["f"][1] for u, c in mcx.items() if "f" in c}
    prem = {u: (c["o"][2] or 0.0) for u, c in mcx.items() if "o" in c}
    tf, tp = sum(fut.values()), sum(prem.values())
    if (fut_rev and not tf) or (opt_rev and not tp):
        return None
    out = {}
    for u in mcx:
        v = (fut_rev * fut.get(u, 0.0) / tf if tf else 0.0) + (opt_rev * prem.get(u, 0.0) / tp if tp else 0.0)
        out[u] = round(v, 6)
    return out


def mcx_reported_revenue(path=None):
    """MCX's reported futures and options revenue per date (₹ Cr, at today's
    rates) from mcx_dashboard_data.json, special sessions included."""
    try:
        doc = json.loads(Path(path or MCX_DATES_PATH).read_text())
    except (OSError, ValueError) as e:
        print(f"WARNING: no MCX revenue for the per-underlying split ({e})")
        return {}
    rows = doc.get("daily_all", []) + doc.get("special_sessions", [])
    return {r["date"]: (r.get("fut_rev"), r.get("opt_rev")) for r in rows if "date" in r}


def totals(by_und):
    """Whole-segment totals of compact aggregates: futures notional, options
    notional and premium (None if any is unknown), contracts."""
    fut = sum(c["f"][1] for c in by_und.values() if "f" in c)
    opt = sum(c["o"][1] for c in by_und.values() if "o" in c)
    prems = [c["o"][2] for c in by_und.values() if "o" in c]
    con = sum(x[0] for c in by_und.values() for x in c.values())
    return {"fut_notional_cr": round(fut, 4), "opt_notional_cr": round(opt, 4),
            "opt_premium_cr": None if None in prems else round(sum(prems), 4), "contracts": con}


def _add(acc, by_und):
    """Add compact aggregates into `acc` (None stays None)."""
    for und, cells in by_und.items():
        for inst, c in cells.items():
            a = acc.setdefault(und, {}).setdefault(inst, [0] * len(c))
            for i, v in enumerate(c):
                a[i] = None if v is None or a[i] is None else a[i] + v


def premium_out(row):
    """True on a day whose MCX file gives every option a premium of 0 though
    options traded (2026-06-23): its options premium can't be compared, so
    periods leave it out of both sides' premium (`prem_days`). ccPremOk in
    dashboard/js/19-mcx-competition.js applies the same rule to daily rows."""
    opts = [c["o"] for c in (row.get("mcx") or {}).values() if "o" in c]
    return sum(o[1] for o in opts) > 0 and all(o[2] == 0 for o in opts)


def _without_premium(by_und):
    """Compact aggregates with every option's premium set to 0 (contracts and notional kept)."""
    return {u: {k: (list(c[:2]) + [0.0] if k == "o" else c) for k, c in cells.items()}
            for u, cells in by_und.items()}


def _round_tree(by_und):
    for cells in by_und.values():
        for k, c in cells.items():
            cells[k] = [round(v, 4) if isinstance(v, float) else v for v in c]
    return {u: by_und[u] for u in sorted(by_und)}


def fy_quarter_label(iso):
    y, m = int(iso[:4]), int(iso[5:7])
    q = {4: 1, 5: 1, 6: 1, 7: 2, 8: 2, 9: 2, 10: 3, 11: 3, 12: 3, 1: 4, 2: 4, 3: 4}[m]
    return f"Q{q} FY {y + 1 if m >= 4 else y}"


def quarter_sort_key(label):
    """'Q3 FY 2027' → (2027, 3); the same order as nse_pipeline.quarter_sort_key."""
    q, _, fy = label.split()
    return int(fy), int(q[1:])


def periods(daily, key):
    """Monthly or quarterly sums over regular days that have both exchanges'
    figures (`days`), so every share in a period has a real MCX denominator.
    `ru` sums each side's revenue per underlying over the `ru_days` of those
    days that have it (a day MCX's revenue can't be split for is left out).
    Options premium is summed over the `prem_days` of those days: a day whose
    MCX file gives every option a premium of 0 (premium_out) adds its contracts
    and notional but no premium, on either side, so premium shares and averages
    per session leave it out."""
    out = {}
    for r in daily:
        if r.get("session") or r.get("mcx") is None:
            continue
        label = r["date"][:7] if key == "month" else fy_quarter_label(r["date"])
        p = out.setdefault(label, {key: label, "days": 0, "prem_days": 0, "nse": {}, "mcx": {}, "rev": [0.0, 0.0],
                                   "ru": {"nse": {}, "mcx": {}}, "ru_days": {"nse": 0, "mcx": 0}})
        p["days"] += 1
        if premium_out(r):
            _add(p["nse"], _without_premium(r["nse"]))
            _add(p["mcx"], _without_premium(r["mcx"]))
        else:
            p["prem_days"] += 1
            _add(p["nse"], r["nse"])
            _add(p["mcx"], r["mcx"])
        p["rev"] = [p["rev"][0] + r["rev"][0], p["rev"][1] + r["rev"][1]]
        ru = r.get("ru") or {}
        for side in ("nse", "mcx"):
            if ru.get(side) is None:   # left out; ru_days counts the days that are in
                continue
            p["ru_days"][side] += 1
            for u, v in ru[side].items():
                p["ru"][side][u] = p["ru"][side].get(u, 0.0) + v
    rows = []
    for p in out.values():
        p["nse"], p["mcx"] = _round_tree(p["nse"]), _round_tree(p["mcx"])
        p["rev"] = [round(x, 6) for x in p["rev"]]
        p["ru"] = {s: {u: round(x, 6) for u, x in sorted(v.items())} for s, v in p["ru"].items()}
        rows.append(p)
    if key == "month":
        return sorted(rows, key=lambda p: p["month"])
    return sorted(rows, key=lambda p: quarter_sort_key(p["quarter"]))


# ═══════════════════════════════════════════════════════════════
# STORE, DATES, RUN
# ═══════════════════════════════════════════════════════════════

def load_store(path=None):
    """(NSE day records by date, unavailable {date: reason}) from the last output.
    Records read by an older parser are kept (published until re-read) but marked
    `stale`, so the backfill re-reads them."""
    try:
        doc = json.loads(Path(path or OUT_PATH).read_text())
    except (OSError, ValueError):
        doc = {}
    nse = {}
    for r in doc.get("daily", []):
        rec = {"date": r["date"], "nse": r["nse"], "checks": r.get("checks", []),
               "xo": r.get("xo", []), "parser": r.get("parser", 1)}
        if rec["parser"] < PARSER_VERSION:
            rec["stale"] = True
        nse[r["date"]] = rec
    return nse, dict(doc.get("unavailable", {}))


def commodity_dates(today, path=None):
    """MCX's trading days from HISTORY_START (special sessions included), plus
    weekdays after its latest day up to yesterday, which NSE may have posted
    before MCX's revenue lands. Returns (dates, set of MCX dates)."""
    try:
        doc = json.loads(Path(path or MCX_DATES_PATH).read_text())
    except (OSError, ValueError) as e:
        print(f"WARNING: no MCX trading dates ({e})")
        doc = {}
    mcx = {r["date"] for r in doc.get("daily_all", [])} | {r["date"] for r in doc.get("special_sessions", [])}
    days = {date.fromisoformat(x) for x in mcx if x >= HISTORY_START.isoformat()}
    d = (max(days) if days else HISTORY_START) + timedelta(days=1)
    while d < today:
        if d.weekday() < 5:
            days.add(d)
        d += timedelta(days=1)
    return sorted(days), mcx


def plan_dates(dates, have, unavailable, recent=RECENT_DAYS, backfill=BACKFILL_PER_RUN, retry=False):
    """The recent window (always re-read), then up to `backfill` older days not
    yet stored (nor unavailable, unless `retry`), newest first."""
    window = dates[-recent:] if recent else []
    older = [d for d in reversed(dates[:len(dates) - len(window)])
             if d.isoformat() not in have and (retry or d.isoformat() not in unavailable)][:backfill]
    return window, older


def run_nse(session, store, unavailable, dates, mcx_dates, backfill, now_iso, today,
            fetch=fetch_nse, pause=time.sleep, retry=False):
    """Fetch and parse planned days into `store`. Returns (changed dates, errors)."""
    fresh = {k for k, rec in store.items() if not rec.get("stale")}
    window, older = plan_dates(dates, fresh, unavailable, backfill=backfill, retry=retry)
    print(f"NSE commodity: {len(window)} recent + {len(older)} older day(s) to read")
    changed, errors = [], []
    for d in window + older:
        key = d.isoformat()
        try:
            url, body, why = fetch(session, d)
        except FetchError as e:
            errors.append(f"{key}: {e}")
            print(f"  {key}: {e}")
            if e.refused:
                print("  NSE refused the request: stopping this run")
                break
            continue
        finally:
            pause(PAUSE_S)
        if body is None:
            if key in mcx_dates and (today - d).days > PENDING_DAYS and key not in store:
                if unavailable.get(key) != why:
                    unavailable[key] = why
                    changed.append(key)
            continue
        try:
            trade_date, nse, checks, xo = parse_bhavcopy(body)
        except Exception as e:  # a malformed file: retried next run
            errors.append(f"{key}: parse failed ({type(e).__name__}: {e})")
            print(f"  {key}: parse failed ({type(e).__name__}: {e})")
            continue
        if trade_date and trade_date != key:
            checks = checks + [f"file's TradDt is {trade_date}"]
        rec = {"date": key, "nse": nse, "checks": checks, "xo": xo, "parser": PARSER_VERSION}
        old = store.get(key)
        if old is None or old.get("stale") or \
                (old.get("nse"), old.get("checks", []), old.get("xo", [])) != (nse, checks, xo):
            changed.append(key)
            store[key] = rec
            if unavailable.pop(key, None) is not None:
                print(f"  {key}: now served")
        for c in checks:
            print(f"  {key}: {c}")
    return changed, errors


def build_doc(store, unavailable, mcx, unmapped_mcx, updated_at, mcx_rev=None):
    """The published file. Each daily row: date, nse and mcx in compact form
    (mcx null until MCX's rows land), rev = [₹ Cr at today's rates, at the rule
    then in force], ru = revenue per underlying at today's rates for each side
    (mcx null until both MCX's rows and its reported revenue are in), and
    session / checks / parser when they apply. `mcx_rev`: {date: (fut_rev,
    opt_rev)}, read from mcx_dashboard_data.json when not given."""
    if mcx_rev is None:
        mcx_rev = mcx_reported_revenue()
    daily = []
    for key in sorted(store):
        rec = store[key]
        nse = rec["nse"]
        m = mcx.get(key)
        fr, orv = mcx_rev.get(key, (None, None))
        row = {"date": key, "nse": nse, "mcx": m, "rev": [revenue(nse), revenue(nse, key)],
               "ru": {"nse": {u: round(v, 6) for u, v in sorted(revenue_by_underlying(nse).items())},
                      "mcx": mcx_revenue_by_underlying(m, fr, orv)}}
        s = trading_calendar.special_session("mcx", key)
        if s:
            row["session"], row["session_note"] = s["type"], s["note"]
        if rec.get("xo"):
            row["xo"] = rec["xo"]
        if rec.get("checks"):
            row["checks"] = rec["checks"]
        if rec.get("parser", 1) != 1:
            row["parser"] = rec["parser"]
        daily.append(row)
    return {
        "updated_at": updated_at,
        "format": {"f": "futures [contracts, notional ₹ Cr]",
                   "o": "options [contracts, notional ₹ Cr, premium ₹ Cr]",
                   "rev": "NSE commodity transaction charges, ₹ Cr [at today's rates, at the rule then in force]",
                   "ru": "transaction revenue per underlying, ₹ Cr at today's rates: {nse, mcx}; NSE's priced "
                         "from fee_register, MCX's = its reported futures / options revenue for the day split "
                         "by each underlying's share of futures notional / options premium; in periods, summed "
                         "over ru_days",
                   "xo": "underlyings with an NSE options contract expiring that day (bhavcopy XpryDt = "
                         "TradDt); absent on days read before parser 2",
                   "prem_days": "in periods: the sessions whose options premium is summed; a day whose MCX file "
                                "gives every option a premium of 0 (2026-06-23) adds no premium on either side"},
        "source": {
            "nse": "NSE commodity bhavcopy (UDiFF): " + NSE_URL.format(ymd="YYYYMMDD"),
            "mcx": "MCX bhavcopy per commodity (Supabase mcx_commodity_daily)",
            "premium": "NSE options premium = TtlTrfVal − strike × multiplier × lots (derived; "
                       "matched NSE's market turnover summary to the rupee on 17 Nov 2026)",
        },
        "underlyings": [{"key": k, "label": lab, "nse": list(n), "mcx": list(m)}
                        for k, (lab, n, m) in UNDERLYINGS.items()],
        "fee_rules": [r for r in fee_register.rules_for("NSE") if r["product"] in fee_register.COM_PRODUCTS],
        "notes": NOTES,
        "unmapped_mcx": unmapped_mcx,
        "unavailable": dict(sorted(unavailable.items())),
        "daily": daily,
        "monthly": periods(daily, "month"),
        "quarterly": periods(daily, "quarter"),
    }


def dumps(obj, level=0):
    """JSON with each element of a list of objects on its own line (one-line diffs)."""
    pad, inner = " " * level, " " * (level + 1)
    if isinstance(obj, dict) and obj:
        items = [f"{inner}{json.dumps(k, ensure_ascii=False)}: {dumps(v, level + 1)}" for k, v in obj.items()]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(obj, list) and obj and all(isinstance(x, (dict, list)) for x in obj):
        return "[\n" + ",\n".join(inner + json.dumps(x, ensure_ascii=False, allow_nan=False,
                                                      separators=(",", ":")) for x in obj) + "\n" + pad + "]"
    return json.dumps(obj, ensure_ascii=False, allow_nan=False)


def write_if_changed(path, doc):
    """Write unless only updated_at differs. True if written."""
    path = Path(path)
    try:
        old = json.loads(path.read_text())
    except (OSError, ValueError):
        old = None
    if old is not None and {k: v for k, v in old.items() if k != "updated_at"} == \
            {k: v for k, v in doc.items() if k != "updated_at"}:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(dumps(doc) + "\n")
    return True


def main(session_factory=make_session, fetch=fetch_nse, mcx_fetch=fetch_mcx_rows, pause=time.sleep,
         today=None):
    import mcx_pipeline
    if not mcx_pipeline.MCX_SUPABASE_KEY:
        print("ERROR: MCX_SUPABASE_KEY is not set (GitHub secret).")
        return 1
    manual = os.environ.get("EVENT") == "workflow_dispatch" and not os.environ.get("SLOT")
    backfill = int(os.environ.get("NSE_COM_BACKFILL") or (MANUAL_BACKFILL if manual else BACKFILL_PER_RUN))
    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    today = today or (now + timedelta(hours=5, minutes=30)).date()
    print(f"NSE commodity pipeline — backfill {backfill}{', retrying unavailable days' if manual else ''}")

    store, unavailable = load_store()
    dates, mcx_dates = commodity_dates(today)
    changed, errors, failed = [], [], False
    try:
        changed, errors = run_nse(session_factory(), store, unavailable, dates, mcx_dates, backfill,
                                  now_iso, today, fetch=fetch, pause=pause, retry=manual)
    except Exception as e:  # session or network failure: keep what is stored
        errors.append(f"{type(e).__name__}: {e}")
        failed = True

    try:
        mcx, unmapped = mcx_by_date(mcx_fetch())
    except Exception as e:  # keep the previous file's MCX figures
        print(f"WARNING: mcx_commodity_daily not read ({type(e).__name__}: {e}); keeping the previous figures")
        try:
            prev = json.loads(OUT_PATH.read_text())
        except (OSError, ValueError):
            prev = {}
        mcx = {r["date"]: r["mcx"] for r in prev.get("daily", []) if r.get("mcx")}
        unmapped = prev.get("unmapped_mcx", [])
    for s in unmapped:
        print(f"::warning::MCX commodity {s} matches no underlying in UNDERLYINGS")

    doc = build_doc(store, unavailable, mcx, unmapped, now_iso)
    wrote = write_if_changed(OUT_PATH, doc)
    n = len(changed) if not wrote else max(len(changed), 1)
    NEW_DAYS_FILE.write_text(str(n))
    latest = doc["daily"][-1] if doc["daily"] else None
    if latest:
        t, m = totals(latest["nse"]), latest["mcx"] and totals(latest["mcx"])
        print(f"Latest {latest['date']}: NSE futures ₹{t['fut_notional_cr']:,.2f} Cr, options notional "
              f"₹{t['opt_notional_cr']:,.2f} Cr / premium ₹{t['opt_premium_cr'] or 0:,.2f} Cr"
              + (f"; MCX options premium ₹{m['opt_premium_cr']:,.2f} Cr" if m else "; MCX not in yet"))
    print(f"{len(changed)} new or revised day(s); {len(store)} stored; "
          f"nse_commodity_daily.json {'written' if wrote else 'unchanged'}")
    for e in errors[:10]:
        print(f"::warning::NSE commodity {e}")
    if failed or (errors and not changed and len(errors) >= RECENT_DAYS):
        print("::error::NSE commodity: no file could be read this run")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
