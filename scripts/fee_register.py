"""
Effective-dated exchange transaction-fee register — the single source for every
rate that turns turnover into revenue. scripts/take_rates.py derives today's
constants from it (latest statutory rule); the NSE/BSE pipelines call rate() to
build the date-effective file variant (*_eff.json).

Units: rate_per_cr_per_side is ₹ per ₹1 crore of turnover, charged to EACH side
of a trade. Revenue = 2 × rate × single-counted turnover, applied to
  fut  → notional turnover   (NSE if_turnover + sf_turnover; BSE futures_turnover)
  opt  → premium turnover    (NSE io_premium + so_premium; BSE options_premium_turnover)
  cash → traded value        (cash_traded_value)
The IPFT (Investor Protection Fund Trust) contribution is a separate levy and is
excluded.

basis:
  flat           a flat rate set by the circular.
  slab_estimate  the circular sets turnover slabs (the marginal rate falls as an
                 exchange-wide monthly turnover rises), so no single rate is exact;
                 the number is a labelled flat estimate of the blended charge.
  calibrated     an effective rate backed out of a reported results figure, for a
                 segment where the statutory rate misses part of what is billed
                 (BSE cash: special-rate scrip groups pay more than 0.00375 %).
  calibrated_provisional
                 a calibrated rate for quarters not yet reported (trailing pooled
                 rate); replace with the quarter's own rate once results are out.
                 Calibrated rules overlay the statutory chain on the dates they
                 cover and are used by the date-effective variant only;
                 take_rates.py (the at-today's-rates files, live pollers,
                 /api/revenue) always uses the statutory rate.

Each rule: exchange, product (fut | opt | cash), effective_from / effective_to
(inclusive 'YYYY-MM-DD', None = open-ended), rate_per_cr_per_side, basis,
source (circular or results document), note. Statutory rules (flat |
slab_estimate) form one contiguous, non-overlapping chain per (exchange,
product) whose last rule is open-ended; validate() enforces that and
scripts/check_take_rates.py runs it in CI.
"""

from datetime import date, timedelta

_NSE_CIRC = "https://nsearchives.nseindia.com/content/circulars/FA{}.pdf"
_BSE_NOTICE = "https://www.bseindia.com/markets/MarketInfo/DispNewNoticesCirculars.aspx?page={}"

STATUTORY_BASES = ("flat", "slab_estimate")
CALIBRATED = "calibrated"
CALIBRATED_PROVISIONAL = "calibrated_provisional"
OVERLAY_BASES = (CALIBRATED, CALIBRATED_PROVISIONAL)
# A row's fee_basis is the least exact basis among its products.
_BASIS_RANK = {"flat": 0, CALIBRATED: 1, CALIBRATED_PROVISIONAL: 2, "slab_estimate": 3}


def _nse_era(frm, to, cash, fut, opt, basis, circular, note=""):
    src = f"NSE circular NSE/FA/{circular}: " + _NSE_CIRC.format(circular)
    return [
        {"exchange": "NSE", "product": p, "effective_from": frm, "effective_to": to,
         "rate_per_cr_per_side": r, "basis": basis, "source": src, "note": note}
        for p, r in (("cash", cash), ("fut", fut), ("opt", opt))
    ]


def _bse(product, frm, to, rate, basis, notice, note=""):
    return {"exchange": "BSE", "product": product, "effective_from": frm, "effective_to": to,
            "rate_per_cr_per_side": rate, "basis": basis,
            "source": f"BSE notice {notice}: " + _BSE_NOTICE.format(notice), "note": note}


_SLAB_NOTE = ("Turnover slabs: no single exact rate; flat estimate of the blended "
              "charge, labelled as an estimate.")

STATUTORY_RULES = [
    # ── NSE equity F&O and cash ──
    *_nse_era(None, "2023-03-31", 326, 185, 3460, "slab_estimate", "46730",
              "Circular dated 18-Dec-2020. " + _SLAB_NOTE),
    *_nse_era("2023-04-01", "2024-03-31", 306, 175, 3150, "slab_estimate", "56129",
              "Circular dated 24-Mar-2023. " + _SLAB_NOTE),
    *_nse_era("2024-04-01", "2024-09-30", 303, 173, 3096, "slab_estimate", "61137",
              "Circular dated 14-Mar-2024. Implied flat equivalent of the slabs. " + _SLAB_NOTE),
    *_nse_era("2024-10-01", "2026-02-28", 297, 173, 3503, "flat", "64232",
              "Circular dated 27-Sep-2024 (SEBI true-to-label: flat rates, slabs removed)."),
    *_nse_era("2026-03-01", None, 307, 183, 3553, "flat", "73061",
              "Circular dated 27-Feb-2026: 306.99 / 182.99 / 3552.99 plus ₹0.01 IPFT, "
              "kept at the rounded 307 / 183 / 3553 used since 2026-08-07."),

    # ── BSE equity derivatives (options on premium; futures nil) ──
    {"exchange": "BSE", "product": "fut", "effective_from": None, "effective_to": None,
     "rate_per_cr_per_side": 0, "basis": "flat",
     "source": "No transaction charge on BSE equity futures (scripts/take_rates.py since inception).",
     "note": ""},
    _bse("opt", None, "2022-05-01", 0, "flat", "20190819-14", "Options transaction charges waived."),
    _bse("opt", "2022-05-02", "2023-10-31", 500, "flat", "20220425-2"),
    _bse("opt", "2023-11-01", "2024-05-12", 2060, "slab_estimate", "20231020-46",
         "Implied estimate. " + _SLAB_NOTE),
    _bse("opt", "2024-05-13", "2024-09-30", 3300, "slab_estimate", "20240430-42",
         "Implied estimate. " + _SLAB_NOTE),
    _bse("opt", "2024-10-01", None, 3250, "flat", "20240927-37",
         "Sensex and Bankex options. Sensex 50 and stock options pay 500, but the data has "
         "no product split, so 3250 is applied to all options premium (slight overstatement)."),

    # ── BSE cash equity ──
    _bse("cash", None, "2022-11-30", 326, "slab_estimate", "20210210-42",
         "Understated: other scrip groups pay more. " + _SLAB_NOTE),
    _bse("cash", "2022-12-01", None, 375, "flat", "20221109-7",
         "Statutory rate for scrip groups A/B. Understated: other scrip groups pay more."),
]


# ── Calibrated overlays (date-effective variant only) ──
# BSE cash. Method: effective ₹/Cr per side = BSE's reported "Equity Cash –
# Transaction Charges Income" (normal + special rate) ÷ (2 × the dashboard's
# cash_traded_value) for the fiscal quarter. Normal-rate income alone implies
# 354–385 ₹/Cr, i.e. about the 375 statutory rate for groups A/B; the premium
# comes from special-rate groups (X/XT/Z), whose share of turnover is falling,
# so the rate is calibrated per quarter rather than fixed.
# One row per reported quarter, oldest first, contiguous. Quarters not yet
# reported get CALIBRATED_PROVISIONAL at the trailing-four-quarter pooled rate.
_BSE_RESULTS = "https://nsearchives.nseindia.com/corporate/{}.pdf"
BSE_CASH_CALIBRATED_QUARTERS = [
    # (fy_quarter, rate_per_cr_per_side, results filing, how the quarter is derived)
    ("Q1 FY 2024", 812, "BSE_09082023182258_NSEIntimation", "Q1"),
    ("Q2 FY 2024", 811, "BSE_10112023163513_Nseintimation", "H1 − Q1"),
    ("Q3 FY 2024", 855, "BSE_05022024170840_NSEINTIMATION", "9M − H1"),
    ("Q4 FY 2024", 743, "BSE_08052024173719_NSEintimation", "FY − 9M"),
    ("Q1 FY 2025", 687, "BSE_07082024170058_NSEintimation", "Q1"),
    ("Q2 FY 2025", 786, "BSE_12112024181747_NSEintimation", "Q2"),
    ("Q3 FY 2025", 910, "BSE_06022025181633_NSEintimation", "Q3"),
    ("Q4 FY 2025", 758, "BSE1_06052025185359_NSEintimation", "Q4"),
    ("Q1 FY 2026", 622, "BSE1_07082025182504_Coveringletterinvestorpresentation", "Q1"),
    ("Q2 FY 2026", 658, "BSE1_11112025201829_Coveringletterinvestorpresentationrevised", "Q2"),
    ("Q3 FY 2026", 681, "BSE1_09022026185014_intimation", "Q3"),
    ("Q4 FY 2026", 584, "BSE1_07052026174401_NSEintimation", "Q4"),
    ("Q1 FY 2027", 557, "BSE1_04082026185534_NSEintimation", "Q1"),
]
# Pooled over the last four reported quarters (Q2 FY26–Q1 FY27): sum of income
# ÷ (2 × sum of traded value). Recompute when a quarter is added above.
BSE_CASH_PROVISIONAL_RATE = 616
BSE_CASH_PROVISIONAL_SOURCE = "Trailing four reported quarters pooled (Q2 FY 2026 – Q1 FY 2027)"


def quarter_bounds(label):
    """'Q1 FY 2027' → ('2026-04-01', '2026-06-30') — Indian FY, Apr–Mar."""
    q, _, fy = label.split()
    q, fy = int(q[1:]), int(fy)
    start_year = fy - 1 if q <= 3 else fy
    start_month = {1: 4, 2: 7, 3: 10, 4: 1}[q]
    start = date(start_year, start_month, 1)
    nxt = date(start_year + (start_month + 3 > 12), (start_month + 2) % 12 + 1, 1)
    return start.isoformat(), (nxt - timedelta(days=1)).isoformat()


def _bse_cash_calibrated():
    rules = []
    for label, rate_cr, filing, derived in BSE_CASH_CALIBRATED_QUARTERS:
        frm, to = quarter_bounds(label)
        rules.append({
            "exchange": "BSE", "product": "cash", "effective_from": frm, "effective_to": to,
            "rate_per_cr_per_side": rate_cr, "basis": CALIBRATED,
            "source": f"BSE results {label} ({filing}): " + _BSE_RESULTS.format(filing),
            "note": f"Equity cash transaction charges income ({derived}) ÷ (2 × cash traded value).",
        })
    last_to = date.fromisoformat(rules[-1]["effective_to"])
    rules.append({
        "exchange": "BSE", "product": "cash",
        "effective_from": (last_to + timedelta(days=1)).isoformat(), "effective_to": None,
        "rate_per_cr_per_side": BSE_CASH_PROVISIONAL_RATE, "basis": CALIBRATED_PROVISIONAL,
        "source": BSE_CASH_PROVISIONAL_SOURCE, "note": "Provisional: update when BSE reports.",
    })
    return rules


CALIBRATED_RULES = _bse_cash_calibrated()

RULES = STATUTORY_RULES + CALIBRATED_RULES


def fraction(rate_per_cr_per_side):
    """₹/Cr per side → two-sided fraction of turnover. rate/1e5 is the per-side
    percentage (183 → 0.00183 %), then the same '% / 100 × 2' take_rates.py has
    always used, so today's constants are bit-identical to the old literals."""
    return rate_per_cr_per_side / 1e5 / 100 * 2


def _iso(d):
    return d if isinstance(d, str) else d.strftime("%Y-%m-%d")


def _covers(r, s):
    return ((r["effective_from"] is None or s >= r["effective_from"])
            and (r["effective_to"] is None or s <= r["effective_to"]))


def _match(exchange, product, s, bases):
    exchange = exchange.upper()
    for r in RULES:
        if (r["exchange"] == exchange and r["product"] == product
                and r["basis"] in bases and _covers(r, s)):
            return r
    return None


def statutory_rule(exchange, product, d):
    """The statutory rule (flat | slab_estimate) in force on `d`."""
    r = _match(exchange, product, _iso(d), STATUTORY_BASES)
    if r is None:
        raise KeyError(f"no fee rule for {exchange} {product} on {_iso(d)}")
    return r


def rule(exchange, product, d):
    """The rule the date-effective variant uses on `d`: a calibrated (or
    provisional calibrated) rule when one covers the date, else the statutory rule."""
    s = _iso(d)
    return _match(exchange, product, s, OVERLAY_BASES) or statutory_rule(exchange, product, s)


def rate(exchange, product, d):
    """(two-sided fraction of turnover, basis) for `exchange` ('NSE' | 'BSE'),
    `product` ('fut' | 'opt' | 'cash') on date `d` (date or 'YYYY-MM-DD')."""
    r = rule(exchange, product, d)
    return fraction(r["rate_per_cr_per_side"]), r["basis"]


PRODUCTS = ("fut", "opt", "cash")


def day_rates(exchange, d):
    """{product: (two-sided fraction, basis)} for every product on `d`."""
    s = _iso(d)
    return {p: rate(exchange, p, s) for p in PRODUCTS}


def current_statutory_rate(exchange, product):
    """Two-sided fraction of the open-ended statutory rule — today's rate."""
    exchange = exchange.upper()
    for r in STATUTORY_RULES:
        if r["exchange"] == exchange and r["product"] == product and r["effective_to"] is None:
            return fraction(r["rate_per_cr_per_side"])
    raise KeyError(f"no open-ended fee rule for {exchange} {product}")


def combined_basis(bases):
    """fee_basis for a row priced with several rules: the least exact one."""
    return max(bases, key=_BASIS_RANK.__getitem__)


def rules_for(exchange, start=None, end=None):
    """Rules for `exchange` overlapping [start, end] (inclusive), with their
    two-sided fraction — written into the *_eff.json files."""
    exchange = exchange.upper()
    out = []
    for r in RULES:
        if r["exchange"] != exchange:
            continue
        if end is not None and r["effective_from"] is not None and r["effective_from"] > end:
            continue
        if start is not None and r["effective_to"] is not None and r["effective_to"] < start:
            continue
        out.append({**r, "rate_two_sided": fraction(r["rate_per_cr_per_side"])})
    return out


def annotate_periods(periods, label_key, daily, row_label):
    """Give each aggregate period (quarterly/monthly/weekly entry) the combined
    fee_basis of its daily rows, overall and per product. row_label(d) must
    reproduce the period label."""
    by_label = {}
    for d in daily:
        by_label.setdefault(row_label(d), []).append(d)
    for p in periods:
        rows = by_label.get(p[label_key])
        if rows:
            p["fee_basis"] = combined_basis(r["fee_basis"] for r in rows)
            p["fee_basis_by_product"] = {
                prod: combined_basis(r["fee_basis_by_product"][prod] for r in rows)
                for prod in rows[0]["fee_basis_by_product"]
            }
    return periods


def validate():
    """Problems with the register (empty list = OK)."""
    bad = []
    keys = sorted({(r["exchange"], r["product"]) for r in RULES})
    for ex, prod in keys:
        chain = [r for r in STATUTORY_RULES if r["exchange"] == ex and r["product"] == prod]
        if not chain:
            bad.append(f"{ex} {prod}: calibrated rules but no statutory chain")
            continue
        if chain[0]["effective_from"] is not None:
            bad.append(f"{ex} {prod}: first statutory rule must be open at the start")
        if chain[-1]["effective_to"] is not None:
            bad.append(f"{ex} {prod}: last statutory rule must be open-ended")
        for a, b in zip(chain, chain[1:]):
            if a["effective_to"] is None or b["effective_from"] is None:
                bad.append(f"{ex} {prod}: open bound in the middle of the chain")
                continue
            nxt = (date.fromisoformat(a["effective_to"]) + timedelta(days=1)).isoformat()
            if b["effective_from"] != nxt:
                bad.append(f"{ex} {prod}: gap/overlap between {a['effective_to']} and {b['effective_from']}")
        cal = [r for r in CALIBRATED_RULES if r["exchange"] == ex and r["product"] == prod]
        for a, b in zip(cal, cal[1:]):
            nxt = (date.fromisoformat(a["effective_to"]) + timedelta(days=1)).isoformat() \
                if a["effective_to"] else None
            if b["effective_from"] != nxt:
                bad.append(f"{ex} {prod}: calibrated rules not contiguous at {b['effective_from']}")
        if cal and cal[-1]["effective_to"] is not None:
            bad.append(f"{ex} {prod}: last calibrated rule must be open-ended (provisional)")
    for r in RULES:
        if r["basis"] not in _BASIS_RANK:
            bad.append(f"{r['exchange']} {r['product']} {r['effective_from']}: unknown basis {r['basis']!r}")
        if r["product"] not in ("fut", "opt", "cash"):
            bad.append(f"{r['exchange']}: unknown product {r['product']!r}")
        if (r["effective_from"] and r["effective_to"]
                and r["effective_from"] > r["effective_to"]):
            bad.append(f"{r['exchange']} {r['product']}: from {r['effective_from']} after to {r['effective_to']}")
    return bad
