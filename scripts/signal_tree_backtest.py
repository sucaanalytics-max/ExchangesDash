"""Walk-forward backtest of the exchange trading-logic tree (25 Nov 2026 desk call) on BSE and MCX.

The tree, as drawn on the desk's whiteboard: each day, for each name,
  Gate 1 · revenue turning: a short ADR window against the 45-session ADR;
  Gate 2 · price cheap: on the ratio model (price ÷ 45-session revenue MA, mean ∓ σ) and/or
           below the regression line (price on the lagged MA, ∓ its standard error);
  Gate 3 · ADR model agrees: price at or below the ADR model's base (the 45-session ADR grown
           at the QoQ rate to the next FY × sessions + other income → PAT → EPS × P/E,
           discounted, as js/14-valuation.js's valuationAdrPath / valuationAdrModel);
and the ladder on the ratio: at or below bear (−1σ) buy futures, between bear and base sell a
put, at base sell a covered call, between base and bull cut the futures, at bull (+1σ) exit or,
with revenue also below the 45-day, go short. A 30 % override lets a long through when the short
window beats the 45-day by 30 % even if price is not cheap (up to +0.5σ).

No look-ahead: on day t every fit (ratio mean/σ, regression, its standard error) uses only
sessions before t, starting at the exchange's "Regression data from" date in
valuation_inputs.json (or --from); the MA is built only from revenue on or after that date and
ends on the last revenue day before t (the share files' lag). Decisions use t's close and are
filled at t's close. Nothing is fitted on returns: the grid below is fixed in advance, and the
train / test split (entries to TRAIN_END / after) only shows whether results hold up.

Grid (24): short window {10 sessions, the last 2 whole Mon–Fri weeks before t's week} ×
T {10 %, 20 %} × Gate 2 {ratio, ratio AND regression, ratio OR regression} ×
Gate 1 form {rising: short ≥ 45d × (1 + T); not falling: short ≥ 45d × (1 − T)}.

Legs use NSE's real closes (data/options/, scripts/stock_options_history.py): futures in the
near month, rolled at expiry at both contracts' closes; options of the nearest expiry with at
least MIN_DTE days left, the traded strike nearest the target (puts: the bear–base midpoint,
or the price if that is lower, so a put is never sold in the money; calls: max(bull, 1.05 ×
price)), sold at the close and held to expiry, settled on the underlying's close that day (premium − intrinsic). Option and futures prices are as traded,
the share series is split- and dividend-adjusted, so each day's factor = series price ÷ NSE's
underlying price converts between them; an option whose factor moves over 2 % in its life (a
corporate action) is dropped. Returns are on notional (the entry price); no margin, costs,
taxes or slippage.

    python scripts/signal_tree_backtest.py [--from YYYY-MM-DD] [--out DIR]

Writes <out>/backtest.json and <out>/backtest.md (default data/signal_tree/).
"""
import argparse
import csv
import json
import math
import re
import sys
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from itertools import product
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "dashboard" / "data"
OPTIONS_DIR = ROOT / "data" / "options"
OUT_DIR = ROOT / "data" / "signal_tree"
VALUATION_JS = ROOT / "dashboard" / "js" / "14-valuation.js"

NAMES = {"bse": "BSE", "mcx": "MCX"}
MA_WINDOW = 45
MIN_FIT = 60              # sessions in a fit before its bands are used
OVERRIDE = 0.30           # short window ≥ 45d × 1.3 lets a long through …
OVERRIDE_BAND = 0.5       # … with price up to ratio mean + 0.5σ
MIN_DTE = 10              # options: nearest expiry with at least this many days left
STRIKE_SEARCH = 0.05      # traded strike within ±5 % of the target
CALL_MIN = 1.05           # covered calls at least 5 % above the price
FACTOR_DRIFT = 0.02       # an option whose adjustment factor moves more than this is dropped
TRAIN_END = "2026-06-30"
EPISODE_GAP = 20          # entries more than this many sessions apart are separate episodes


@dataclass(frozen=True)
class Config:
    window: str           # "10d" | "2w"
    t: float              # 0.10 | 0.20
    gate2: str            # "ratio" | "and" | "or"
    form: str             # "rising" | "not_falling"

    @property
    def key(self):
        return f"{self.window}-T{int(self.t * 100)}-{self.gate2}-{self.form}"


GRID = [Config(w, t, g, f) for w, t, g, f in
        product(("10d", "2w"), (0.10, 0.20), ("ratio", "and", "or"), ("rising", "not_falling"))]


# ─────────────────────────────── data ───────────────────────────────

def shares_outstanding(path=VALUATION_JS):
    """{ex: shares in Cr} from SHARES_OUTSTANDING_CR in js/14-valuation.js (the only copy)."""
    txt = Path(path).read_text()
    block = txt[txt.index("SHARES_OUTSTANDING_CR"):]
    block = block[:block.index("};")]
    return {m.group(1): float(m.group(2)) for m in re.finditer(r"(\w+): \{ value: ([\d.]+)", block)}


def load_share(ex, data_dir=DATA):
    s = json.loads((Path(data_dir) / f"{ex}_share_analysis.json").read_text())
    prices = {r["date"]: r["price"] for r in s["series"]
              if not r.get("modelled") and r.get("price") and math.isfinite(r["price"])}
    rev = s["revenue_daily"]
    rev = rev if isinstance(rev, list) else [{"date": d, "revenue_cr": v} for d, v in sorted(rev.items())]
    revenue = [(r["date"], r["revenue_cr"]) for r in rev
               if not r.get("modelled") and r.get("revenue_cr") is not None]
    return prices, sorted(revenue)


def load_options(sym, options_dir=OPTIONS_DIR):
    """{date: {"und": float, "fut": [(expiry, close)], "CE"/"PE": {expiry: [(strike, close, contracts)]}}}"""
    out = {}
    for p in sorted((Path(options_dir) / sym).glob("*.csv")):
        with open(p, newline="") as fh:
            for r in csv.DictReader(fh):
                day = out.setdefault(r["date"], {"und": float(r["underlying"]), "fut": [], "CE": {}, "PE": {}})
                if r["type"] == "FUT":
                    day["fut"].append((r["expiry"], float(r["close"])))
                else:
                    day[r["type"]].setdefault(r["expiry"], []).append(
                        (float(r["strike"]), float(r["close"]), int(r["contracts"])))
    for day in out.values():
        day["fut"].sort()
    return out


def fy_quarter(iso):
    y, m = int(iso[:4]), int(iso[5:7])
    return {"q": (m - 4) % 12 // 3 + 1, "fy": y + 1 if m >= 4 else y}


# ─────────────────────────────── models ───────────────────────────────

def adr_path_fy(start, start_adr, qoq_pct):
    """valuationAdrPath: next FY's average ADR, compounding qoq_pct a quarter from `start`."""
    q, fy, adr, nxt = start["q"], start["fy"], start_adr, []
    while fy <= start["fy"] + 1:
        if fy == start["fy"] + 1:
            nxt.append(adr)
        adr *= 1 + qoq_pct / 100
        q += 1
        if q > 4:
            q, fy = 1, fy + 1
    return sum(nxt) / len(nxt)


def adr_model_now(adr_fy, v, shares):
    """valuationAdrModel's `now` targets [bear, base, bull]."""
    total = adr_fy * v["days"] + v["oi"]
    eps = total * v["margin"] / 100 / shares
    return [eps * pe / (1 + v["d1"] / 100) / (1 + v["d2"] / 100) for pe in v["pe"]]


def valuation_inputs(ex, path=DATA / "valuation_inputs.json"):
    d = json.loads(Path(path).read_text())
    e = d["exchanges"][ex]
    pe = e["editable"]["pe"]
    return {
        "g": e["editable"]["qoq_growth_pct"], "pe": [pe["bear"], pe["base"], pe["bull"]],
        "days": e["fixed"]["sessions"], "oi": e["fixed"]["other_income_cr"],
        "margin": e["fixed"]["pat_margin_pct"],
        "d1": d["discount_to_fy_end_pct"], "d2": d["discount_to_today_pct"],
        "from": e["editable"]["regression_from"],
    }


class Fit:
    """Running sums for the ratio (price ÷ MA) and OLS of price on MA over the rows added."""

    def __init__(self):
        self.n = 0
        self.sx = self.sy = self.sxx = self.sxy = self.syy = self.sr = self.srr = 0.0

    def add(self, x, y):
        self.n += 1
        self.sx += x; self.sy += y
        self.sxx += x * x; self.sxy += x * y; self.syy += y * y
        r = y / x
        self.sr += r; self.srr += r * r

    def ratio(self):
        if self.n < 2:
            return None
        mean = self.sr / self.n
        return mean, math.sqrt(max(self.srr / self.n - mean * mean, 0.0))

    def regression(self):
        """(slope, intercept, se) with se = √(SSR ÷ (n − 2)), as shareResidualSE; None below 3 rows."""
        if self.n < 3:
            return None
        cxx = self.sxx - self.sx ** 2 / self.n
        cxy = self.sxy - self.sx * self.sy / self.n
        cyy = self.syy - self.sy ** 2 / self.n
        if cxx <= 0:
            return None
        slope = cxy / cxx
        ssr = max(cyy - slope * cxy, 0.0)
        return slope, self.sy / self.n - slope * self.sx / self.n, math.sqrt(ssr / (self.n - 2))


def two_whole_weeks(rev_dates, rev_vals, t):
    """Mean revenue over the two complete Mon–Fri weeks before t's week (None if empty)."""
    td = date.fromisoformat(t)
    mon = td - timedelta(days=td.weekday())
    lo, hi = (mon - timedelta(days=14)).isoformat(), mon.isoformat()
    vals = [v for d, v in zip(rev_dates, rev_vals) if lo <= d < hi]
    return sum(vals) / len(vals) if vals else None


def daily_signals(prices, revenue, v, shares, start):
    """One dict per price date ≥ start (with a full MA): everything the tree reads, fitted only
    on sessions before that date."""
    revenue = [(d, x) for d, x in revenue if d >= start]
    rd = [d for d, _ in revenue]
    rv = [x for _, x in revenue]
    fit, out = Fit(), []
    pending = None                                   # yesterday's row joins the fit today
    for t in sorted(d for d in prices if d >= start):
        if pending:
            fit.add(*pending)
            pending = None
        i = _last_before(rd, t)
        if i is None or i + 1 < MA_WINDOW:
            continue
        adr45 = sum(rv[i - MA_WINDOW + 1:i + 1]) / MA_WINDOW
        price = prices[t]
        row = {
            "date": t, "price": price, "adr45": adr45,
            "short_10d": sum(rv[i - 9:i + 1]) / 10, "short_2w": two_whole_weeks(rd, rv, t),
            "n_fit": fit.n, "ratio": None, "reg": None,
        }
        if fit.n >= MIN_FIT:
            mean, sd = fit.ratio()
            row["ratio"] = [(mean - sd) * adr45, mean * adr45, (mean + sd) * adr45]
            reg = fit.regression()
            if reg and reg[0] > 0:
                base = reg[1] + reg[0] * adr45
                row["reg"] = [base - reg[2], base, base + reg[2]]
        row["adr_model"] = adr_model_now(adr_path_fy(fy_quarter(t), adr45, v["g"]), v, shares)
        out.append(row)
        pending = (adr45, price)
    return out


def _last_before(sorted_dates, t):
    lo, hi = 0, len(sorted_dates)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_dates[mid] < t:
            lo = mid + 1
        else:
            hi = mid
    return lo - 1 if lo > 0 else None


# ─────────────────────────────── the tree ───────────────────────────────

def gates(s, cfg):
    """(gate1, gate2, gate3, override, turning_down) for one day's signals under a config."""
    short = s["short_10d"] if cfg.window == "10d" else s["short_2w"]
    if short is None or s["ratio"] is None:
        return None
    a = s["adr45"]
    g1 = short >= a * (1 + cfg.t) if cfg.form == "rising" else short >= a * (1 - cfg.t)
    by_ratio = s["price"] <= s["ratio"][1]
    by_reg = s["reg"] is not None and s["price"] <= s["reg"][1]
    g2 = {"ratio": by_ratio, "and": by_ratio and by_reg, "or": by_ratio or by_reg}[cfg.gate2]
    g3 = s["price"] <= s["adr_model"][1]
    bear, base, bull = s["ratio"]
    over = short >= a * (1 + OVERRIDE) and s["price"] <= base + OVERRIDE_BAND * (bull - base)
    return g1, g2, g3, over, short < a * (1 - cfg.t), short


def ladder(price, ratio):
    bear, base, bull = ratio
    if price <= bear:
        return "bear"
    if price < base:
        return "bear-base"
    if price < (base + bull) / 2:
        return "base"
    if price < bull:
        return "base-bull"
    return "bull"


def pick_option(day, kind, target_raw, t):
    """(expiry, strike, premium) of the traded option nearest target_raw at the nearest expiry with
    ≥ MIN_DTE days left; None if no traded strike within STRIKE_SEARCH."""
    td = date.fromisoformat(t)
    exps = sorted(e for e in day[kind] if (date.fromisoformat(e) - td).days >= MIN_DTE)
    for e in exps[:1]:
        cands = [(abs(k - target_raw), k, c) for k, c, n in day[kind][e] if n > 0 and c > 0
                 and abs(k / target_raw - 1) <= STRIKE_SEARCH]
        if cands:
            _, k, c = min(cands)
            return e, k, c
    return None


def near_future(day, t):
    """(expiry, close) of the nearest futures contract not yet expired on t."""
    for e, c in day["fut"]:
        if e >= t:
            return e, c
    return None


def simulate(sig, opts, cfg, name):
    """Runs one config over one name's daily signals; returns the list of closed and open trades."""
    trades, fut, put, call = [], None, None, None
    by_date = {s["date"]: s for s in sig}
    days = [s["date"] for s in sig if s["date"] in opts]

    def close_trade(pos, t, exit_px, why, ret):
        trades.append({**{k: v for k, v in pos.items() if not k.startswith("_")},
                       "exit_date": t, "exit_px": round(exit_px, 2), "why_exit": why,
                       "ret_pct": round(ret * 100, 3), "open": why == "open at end"})

    for t in days:
        s, day = by_date[t], opts[t]
        f = s["price"] / day["und"]                    # adjusted ÷ raw
        # Options expiring today (or whose expiry passed on a day without data) settle on the underlying
        for leg in ("put", "call"):
            pos = put if leg == "put" else call
            if pos and t >= pos["expiry"]:
                und = day["und"]
                intrinsic = max(pos["strike"] - und, 0) if leg == "put" else max(und - pos["strike"], 0)
                if abs(f / pos["_f"] - 1) > FACTOR_DRIFT:
                    close_trade(pos, t, und * f, "dropped: corporate action", 0.0)
                    trades[-1]["dropped"] = True
                else:
                    close_trade(pos, t, und * f, "expiry", (pos["premium"] - intrinsic) / pos["_und"])
                if leg == "put":
                    put = None
                else:
                    call = None
        # Futures: mark, and roll a contract expiring today into the next
        if fut:
            cur = next((c for e, c in day["fut"] if e == fut["_exp"]), None)
            if cur is not None:
                fut["_pnl"] += fut["side"] * (cur * f - fut["_mark"])
                fut["_mark"] = cur * f
            if t >= fut["_exp"]:
                nxt = next(((e, c) for e, c in day["fut"] if e > t), None)
                if nxt:
                    fut["_exp"], fut["_mark"] = nxt[0], nxt[1] * f
                    fut["rolls"] += 1
        g = gates(s, cfg)
        if g is None:
            continue
        g1, g2, g3, over, down, short = g
        pos_on_ladder = ladder(s["price"], s["ratio"])
        bear, base, bull = s["ratio"]
        # Exits
        if fut and fut["side"] > 0:
            why = ("base–bull: cut futures" if pos_on_ladder in ("base-bull", "bull")
                   else "revenue turning down at base" if down and s["price"] >= base else None)
            if why:
                close_trade(fut, t, s["price"], why, fut["_pnl"] / fut["_entry"])
                fut = None
                if call:                                 # buy the covered call back at today's close
                    row = next((c for k, c, n in day["CE"].get(call["expiry"], []) if k == call["strike"]), None)
                    if row is not None and abs(f / call["_f"] - 1) <= FACTOR_DRIFT:
                        close_trade(call, t, s["price"], "bought back with the futures", (call["premium"] - row) / call["_und"])
                    else:
                        close_trade(call, t, s["price"], "dropped: no close to buy back", 0.0)
                        trades[-1]["dropped"] = True
                    call = None
        elif fut and fut["side"] < 0 and s["price"] <= base:
            close_trade(fut, t, s["price"], "back to base: cover short", fut["_pnl"] / fut["_entry"])
            fut = None
        # Entries
        long_ok = g1 and g2 and g3
        if not fut and not put and (long_ok or (over and g3)):
            if pos_on_ladder == "bear" or (not long_ok and over):
                nf = near_future(day, t)
                if nf:
                    fut = {"name": name, "config": cfg.key, "leg": "futures long",
                           "why_entry": "override: short window ≥ 45d + 30 %" if not long_ok else "gates 1–3 at bear",
                           "entry_date": t, "entry_px": round(s["price"], 2), "side": 1, "rolls": 0,
                           "_exp": nf[0], "_mark": nf[1] * f, "_entry": nf[1] * f, "_pnl": 0.0}
            elif pos_on_ladder == "bear-base":
                o = pick_option(day, "PE", min((bear + base) / 2, s["price"]) / f, t)
                if o:
                    put = {"name": name, "config": cfg.key, "leg": "put sold", "why_entry": "gates 1–3 bear–base",
                           "entry_date": t, "entry_px": round(s["price"], 2), "expiry": o[0], "strike": o[1],
                           "premium": o[2], "premium_pct": round(o[2] / day["und"] * 100, 2),
                           "strike_adj": round(o[1] * f, 2), "_und": day["und"], "_f": f}
        if not fut and short < s["adr45"] and pos_on_ladder == "bull":
            nf = near_future(day, t)
            if nf:
                fut = {"name": name, "config": cfg.key, "leg": "futures short",
                       "why_entry": "at bull, revenue below the 45-day", "entry_date": t,
                       "entry_px": round(s["price"], 2), "side": -1, "rolls": 0,
                       "_exp": nf[0], "_mark": nf[1] * f, "_entry": nf[1] * f, "_pnl": 0.0}
        if fut and fut["side"] > 0 and not call and pos_on_ladder == "base":
            o = pick_option(day, "CE", max(bull, CALL_MIN * s["price"]) / f, t)
            if o:
                call = {"name": name, "config": cfg.key, "leg": "covered call sold", "why_entry": "long futures at base",
                        "entry_date": t, "entry_px": round(s["price"], 2), "expiry": o[0], "strike": o[1],
                        "premium": o[2], "premium_pct": round(o[2] / day["und"] * 100, 2),
                        "strike_adj": round(o[1] * f, 2), "_und": day["und"], "_f": f}
    if days:
        t, day = days[-1], opts[days[-1]]
        if fut:
            close_trade(fut, t, by_date[t]["price"], "open at end", fut["_pnl"] / fut["_entry"])
        for pos, kind in ((put, "PE"), (call, "CE")):
            if pos:
                row = next((c for k, c, n in day[kind].get(pos["expiry"], []) if k == pos["strike"]), pos["premium"])
                close_trade(pos, t, by_date[t]["price"], "open at end", (pos["premium"] - row) / pos["_und"])
    return trades


# ─────────────────────────────── report ───────────────────────────────

def summarize(trades, session_index):
    def stats(ts):
        ts = [x for x in ts if not x.get("dropped")]
        if not ts:
            return {"n": 0}
        r = [x["ret_pct"] for x in ts]
        return {"n": len(ts), "win_pct": round(100 * sum(1 for x in r if x > 0) / len(r), 1),
                "mean_ret_pct": round(sum(r) / len(r), 2), "sum_ret_pct": round(sum(r), 2),
                "worst_ret_pct": round(min(r), 2), "best_ret_pct": round(max(r), 2)}
    entries = sorted(session_index[x["entry_date"]] for x in trades if not x.get("dropped"))
    episodes = sum(1 for i, e in enumerate(entries) if i == 0 or e - entries[i - 1] > EPISODE_GAP)
    legs = sorted({x["leg"] for x in trades})
    return {
        "all": stats(trades), "episodes": episodes,
        "train": stats([x for x in trades if x["entry_date"] <= TRAIN_END]),
        "test": stats([x for x in trades if x["entry_date"] > TRAIN_END]),
        "by_leg": {leg: stats([x for x in trades if x["leg"] == leg]) for leg in legs},
        "dropped": sum(1 for x in trades if x.get("dropped")),
    }


def elasticity(sig):
    """log price on log MA over the latest fit window (the last row's history): the slope the
    ratio assumes is 1; the regression's implied elasticity at today's MA is slope × MA ÷ fitted price."""
    rows = [(math.log(s["adr45"]), math.log(s["price"])) for s in sig]
    if len(rows) < MIN_FIT:
        return None
    f = Fit()
    for x, y in rows:
        f.add(x, y)
    slope, intercept, se = f.regression()
    lin = Fit()
    for s in sig:
        lin.add(s["adr45"], s["price"])
    b, a, _ = lin.regression()
    last = sig[-1]["adr45"]
    return {"log_log_slope": round(slope, 3), "n": f.n,
            "linear_implied_at_latest_ma": round(b * last / (a + b * last), 3)}


def today_view(sig, cfgs):
    s = sig[-1]
    out = {"date": s["date"], "price": round(s["price"], 1), "adr45": round(s["adr45"], 2),
           "short_10d": round(s["short_10d"], 2),
           "short_2w": round(s["short_2w"], 2) if s["short_2w"] else None,
           "ratio": [round(x) for x in s["ratio"]] if s["ratio"] else None,
           "reg": [round(x) for x in s["reg"]] if s["reg"] else None,
           "adr_model": [round(x) for x in s["adr_model"]],
           "ladder": ladder(s["price"], s["ratio"]) if s["ratio"] else None, "configs": {}}
    for cfg in cfgs:
        g = gates(s, cfg)
        if g:
            out["configs"][cfg.key] = dict(zip(("gate1", "gate2", "gate3", "override"), g[:4]))
    return out


def replay(sig, trades, lo, hi):
    """What each config did, and the signals, between lo and hi."""
    days = [s for s in sig if lo <= s["date"] <= hi]
    acts = {}
    for x in trades:
        if lo <= x["entry_date"] <= hi:
            acts.setdefault(x["config"], []).append(
                {k: x[k] for k in ("leg", "entry_date", "entry_px", "exit_date", "why_exit", "ret_pct")})
    return {"signals": [{"date": s["date"], "price": round(s["price"], 1), "adr45": round(s["adr45"], 2),
                         "short_10d": round(s["short_10d"], 2),
                         "ladder": ladder(s["price"], s["ratio"]) if s["ratio"] else None,
                         "ratio": [round(v) for v in s["ratio"]] if s["ratio"] else None,
                         "reg_base": round(s["reg"][1]) if s["reg"] else None} for s in days],
            "trades_by_config": acts}


REPLAYS = {
    "bse_oct_2026": ("bse", "2026-09-15", "2026-10-31", "BSE from 1 Oct 2026: the tree should catch the run"),
    "mcx_puts_3700": ("mcx", "2026-11-09", "2026-11-18", "MCX puts sold near 3,700 in mid-Nov: the tree should avoid them"),
    "mcx_fut_3800": ("mcx", "2026-11-10", "2026-11-25", "MCX at 3,700–3,800: the tree should be at base–bull (cut futures, sell calls)"),
}


def run(start_override=None, data_dir=DATA, options_dir=OPTIONS_DIR):
    shares = shares_outstanding()
    result = {"method": __doc__.split("\n\n")[1].strip(), "grid": [c.key for c in GRID], "names": {}}
    sigs, all_trades = {}, {}
    for ex, sym in NAMES.items():
        v = valuation_inputs(ex, Path(data_dir) / "valuation_inputs.json")
        start = start_override or v["from"]
        prices, revenue = load_share(ex, data_dir)
        opts = load_options(sym, options_dir)
        sig = daily_signals(prices, revenue, v, shares[ex], start)
        sigs[ex] = sig
        session_index = {s["date"]: i for i, s in enumerate(sig)}
        traded = [s for s in sig if s["ratio"] and s["date"] in opts]
        per_cfg, trades_ex = {}, []
        for cfg in GRID:
            tr = simulate(sig, opts, cfg, sym)
            trades_ex += tr
            per_cfg[cfg.key] = summarize(tr, session_index)
        all_trades[ex] = trades_ex
        result["names"][sym] = {
            "fit_from": start, "first_signal": sig[0]["date"] if sig else None,
            "first_tradable": traded[0]["date"] if traded else None,
            "last": sig[-1]["date"] if sig else None, "option_days": len(opts),
            "inputs": v, "shares_cr": shares[ex],
            "elasticity": elasticity(sig), "today": today_view(sig, GRID) if sig else None,
            "configs": per_cfg,
        }
    result["replays"] = {k: {"note": note, **replay(sigs[ex], all_trades[ex], lo, hi)}
                         for k, (ex, lo, hi, note) in REPLAYS.items()}
    result["trades"] = [t for ex in NAMES for t in all_trades[ex]]
    return result


def markdown(res):
    L = ["# Trading-logic tree: walk-forward backtest", "", res["method"], ""]
    for sym, n in res["names"].items():
        L += [f"## {sym}", "",
              f"Fit from {n['fit_from']}; first signal {n['first_signal']}, first day with bands and option "
              f"data {n['first_tradable']}, last {n['last']}; {n['option_days']} days of NSE option data.", ""]
        e = n["elasticity"]
        if e:
            L += [f"Elasticity of price to the 45-session ADR: log–log slope {e['log_log_slope']} "
                  f"(ratio model assumes 1; the linear regression implies {e['linear_implied_at_latest_ma']} at today's MA).", ""]
        L += ["| Config | Trades | Episodes | Win % | Mean % | Sum % | Worst % | Train n / sum % | Test n / sum % |",
              "|---|---|---|---|---|---|---|---|---|"]
        rows = sorted(n["configs"].items(), key=lambda kv: -(kv[1]["all"].get("sum_ret_pct") or -1e9))
        for k, c in rows:
            a, tr, te = c["all"], c["train"], c["test"]
            if not a["n"]:
                L.append(f"| {k} | 0 | 0 | | | | | | |")
                continue
            L.append(f"| {k} | {a['n']} | {c['episodes']} | {a['win_pct']} | {a['mean_ret_pct']} | {a['sum_ret_pct']} | "
                     f"{a['worst_ret_pct']} | {tr['n']} / {tr.get('sum_ret_pct', 0)} | {te['n']} / {te.get('sum_ret_pct', 0)} |")
        t = n["today"]
        if t:
            L += ["", f"Today ({t['date']}): price {t['price']}, 45-day ADR {t['adr45']}, 10-session {t['short_10d']}, "
                  f"2 whole weeks {t['short_2w']}; ratio {t['ratio']}, regression {t['reg']}, ADR model {t['adr_model']} "
                  f"→ ladder **{t['ladder']}**.", ""]
            passing = [k for k, g in t["configs"].items() if g["gate1"] and g["gate2"] and g["gate3"]]
            L += [f"All three gates pass today in {len(passing)} of {len(t['configs'])} configs"
                  + (f": {', '.join(passing)}." if passing else "."), ""]
    L += ["## Replay cases", ""]
    for k, r in res["replays"].items():
        L += [f"### {r['note']}", ""]
        acts = r["trades_by_config"]
        if not acts:
            L += ["No config traded in this window.", ""]
        for cfg, xs in sorted(acts.items()):
            L.append(f"- `{cfg}`: " + "; ".join(
                f"{x['leg']} {x['entry_date']} at {x['entry_px']} → {x['exit_date']} ({x['why_exit']}) {x['ret_pct']} %"
                for x in xs))
        L.append("")
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--from", dest="start", default=None, help="fit start for both names (default: valuation_inputs.json)")
    ap.add_argument("--out", default=str(OUT_DIR))
    a = ap.parse_args(argv)
    res = run(a.start)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "backtest.json").write_text(json.dumps(res, indent=1, default=lambda o: asdict(o)) + "\n")
    (out / "backtest.md").write_text(markdown(res))
    for sym, n in res["names"].items():
        best = max(n["configs"].items(), key=lambda kv: kv[1]["all"].get("sum_ret_pct") or -1e9)
        print(f"{sym}: {n['option_days']} option days, first tradable {n['first_tradable']}; "
              f"best config {best[0]} sum {best[1]['all'].get('sum_ret_pct')} % over {best[1]['all']['n']} trades")
    print(f"Wrote {out / 'backtest.json'} and {out / 'backtest.md'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
