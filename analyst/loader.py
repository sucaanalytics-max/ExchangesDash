"""Read-only access to the datasets the pipelines publish in this repository.

Nothing here fetches from an exchange or writes anywhere: it reads the JSON and
CSV files the scheduled jobs commit (`dashboard/data/`, `data/intraday/`,
`data/options/`, `data/signal_tree/`), flattens them into rows, and records
which commit they came from. The files on `main` are the canonical copy;
Supabase's `nse_daily` / `bse_daily` / `mtf.exchange_daily` are not (see
analyst/README.md).

    import analyst
    snap = analyst.snapshot()                 # latest main on GitHub, pinned to one commit
    nse = snap.load("nse_daily")              # Dataset: .rows, .meta, .raw, .to_frame()
    old = analyst.snapshot("2026-06-30")      # the data as it stood at 23:59 IST that day
    loc = analyst.snapshot(source="local")    # this clone's origin/main (fetched first)

Every dataset of one snapshot comes from the same commit, so figures that are
combined (say NSE revenue with MTF) never mix two versions of the data.
Caveat flags (`modelled`, `fee_basis`, MTF `flags`, null counts) are kept as
columns and summarised in `meta["caveats"]`; nothing is filtered out.

Standard library only; `Dataset.to_frame()` needs pandas.
"""

import csv
import io
import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = "sucaanalytics-max/ExchangesDash"
RAW_URL = "https://raw.githubusercontent.com/{repo}/{sha}/{path}"
API_URL = "https://api.github.com/repos/{repo}"
IST = timezone(timedelta(hours=5, minutes=30))
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISO_PREFIX = re.compile(r"^\d{4}-\d{2}")
WORKTREE = "WORKTREE"


# ── Dataset ──────────────────────────────────────────────────────────────────

class Dataset:
    """Rows (list of dicts) plus where they came from.

    meta: dataset, description, unit, path(s), commit, committed_at, rows,
    first_date / last_date (on the dataset's date column), updated_at (the
    file's own stamp, when it has one) and caveats.
    raw: the whole parsed file, for fields the rows don't flatten (fits,
    notes, fee rules, `unavailable` lists …).
    """

    def __init__(self, name, rows, meta, raw=None):
        self.name = name
        self.rows = rows
        self.meta = meta
        self.raw = raw

    def __len__(self):
        return len(self.rows)

    def __iter__(self):
        return iter(self.rows)

    def __repr__(self):
        m = self.meta
        span = f" {m.get('first_date')}…{m.get('last_date')}" if m.get("last_date") else ""
        return f"<Dataset {self.name}: {len(self.rows)} rows{span} @ {str(m.get('commit'))[:8]}>"

    @property
    def columns(self):
        seen = {}
        for r in self.rows:
            for k in r:
                seen.setdefault(k, None)
        return list(seen)

    def to_frame(self):
        import pandas as pd  # optional dependency
        df = pd.DataFrame(self.rows, columns=self.columns or None)
        for col in ("date", "ts", "expiry", "as_of"):
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], errors="coerce")
        df.attrs["meta"] = self.meta
        return df


# ── Stores: where file bytes come from ───────────────────────────────────────

def _run_git(repo_dir, *args):
    return subprocess.run(["git", "-C", repo_dir, *args], check=True,
                          capture_output=True, text=True).stdout


def _end_of_day_ist(date_str):
    return datetime.strptime(date_str, "%Y-%m-%d").replace(
        hour=23, minute=59, second=59, tzinfo=IST)


class _GitStore:
    """A local clone. ref: a branch, tag, SHA, a YYYY-MM-DD date (the last
    commit on origin/main at 23:59:59 IST that day) or WORKTREE (files on disk)."""

    def __init__(self, ref="origin/main", repo_dir=REPO_DIR, fetch=True):
        self.repo_dir = repo_dir
        self.ref = ref
        if ref == WORKTREE:
            self.sha, self.committed_at = WORKTREE, None
            return
        if fetch:
            try:
                _run_git(repo_dir, "fetch", "--quiet", "origin", "main")
            except (subprocess.CalledProcessError, OSError) as exc:
                print(f"analyst: git fetch failed ({exc}); reading the local origin/main")
        if DATE_RE.match(ref):
            until = _end_of_day_ist(ref).isoformat()
            sha = _run_git(repo_dir, "rev-list", "-1", "--first-parent",
                           f"--before={until}", "origin/main").strip()
            if not sha:
                raise ValueError(f"no commit on origin/main on or before {ref}")
        else:
            sha = _run_git(repo_dir, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
        self.sha = sha
        self.committed_at = _run_git(repo_dir, "show", "-s", "--format=%cI", sha).strip()

    def read(self, path):
        if self.sha == WORKTREE:
            with open(os.path.join(self.repo_dir, path), encoding="utf-8") as f:
                return f.read()
        try:
            return _run_git(self.repo_dir, "show", f"{self.sha}:{path}")
        except subprocess.CalledProcessError:
            raise FileNotFoundError(f"{path} not in commit {self.sha[:8]}") from None

    def list(self, prefix):
        prefix = prefix.rstrip("/")
        if self.sha == WORKTREE:
            base = os.path.join(self.repo_dir, prefix)
            if not os.path.isdir(base):
                return []
            return sorted(f"{prefix}/{n}" for n in os.listdir(base))
        out = _run_git(self.repo_dir, "ls-tree", "--name-only", self.sha, prefix + "/")
        return sorted(p for p in out.splitlines() if p)


class _GitHubStore:
    """The public repository over HTTPS. The ref is resolved to one commit SHA
    first and every file is read at that SHA (raw.githubusercontent.com does not
    rate-limit; the API calls do: 60 an hour without GITHUB_TOKEN)."""

    def __init__(self, ref="main", repo=REPO):
        self.repo = repo
        self.ref = ref
        api = API_URL.format(repo=repo)
        if DATE_RE.match(ref):
            # GitHub's `until` filter can return a commit from a PR branch that was
            # dated before the day but merged into main after it, which would leak
            # later data. Only a first-parent walk is safe, and that needs git.
            raise ValueError("a date ref needs the local clone: snapshot(ref, source='local') "
                             "(or pass a commit SHA)")
        commit = self._api(f"{api}/commits/{ref}")
        self.sha = commit["sha"]
        self.committed_at = commit["commit"]["committer"]["date"]

    @staticmethod
    def _get(url, accept=None):
        headers = {"User-Agent": "exchangesdash-analyst-loader"}
        if accept:
            headers["Accept"] = accept
        token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if token and "api.github.com" in url:
            headers["Authorization"] = f"Bearer {token}"
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
            return r.read().decode("utf-8")

    def _api(self, url):
        return json.loads(self._get(url, "application/vnd.github+json"))

    def read(self, path):
        try:
            return self._get(RAW_URL.format(repo=self.repo, sha=self.sha, path=path))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise FileNotFoundError(f"{path} not in commit {self.sha[:8]}") from None
            raise

    def list(self, prefix):
        prefix = prefix.rstrip("/")
        try:
            items = self._api(f"{API_URL.format(repo=self.repo)}/contents/{prefix}?ref={self.sha}")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return []
            raise
        return sorted(i["path"] for i in items)


# ── Flatteners ───────────────────────────────────────────────────────────────

def _key(*keys):
    def get(d):
        for k in keys:
            d = d[k]
        return list(d)
    return get


def _tables_long(container_key, id_key):
    """participants_<source>: [{date|edition, tables: {name: {fields, rows: {category: [values]}}}}]
    → one row per (day, table, category, field)."""
    def get(d):
        out = []
        for item in d.get(container_key, []):
            for table, t in (item.get("tables") or {}).items():
                fields = t.get("fields") or t.get("months") or []
                rows = t.get("rows") or {}
                for category, values in rows.items():
                    if isinstance(values, dict):          # Market Pulse: {month: share}
                        pairs = values.items()
                    else:
                        pairs = zip(fields, values)
                    for field, value in pairs:
                        out.append({id_key: item.get(id_key), "table": table,
                                    "category": category, "field": field, "value": value})
        return out
    return get


PERIOD_FIELD = {"daily": "date", "monthly": "month", "quarterly": "quarter"}


def _commodity_long(period_key):
    """nse_commodity_daily: per day/month/quarter {nse|mcx: {underlying: {f: [...], o: [...]}}}
    → one row per (period, side, underlying)."""
    def get(d):
        out = []
        for p in d.get(period_key, []):
            ru = p.get("ru") or {}
            expiring = set(p.get("xo") or [])
            for side in ("nse", "mcx"):
                book = p.get(side)
                if book is None:                         # MCX's rows not landed yet
                    continue
                for und, v in book.items():
                    f = v.get("f") or [None, None]
                    o = v.get("o") or [None, None, None]
                    row = {PERIOD_FIELD[period_key]: p.get(PERIOD_FIELD[period_key]),
                           "side": side, "underlying": und,
                           "fut_contracts": f[0], "fut_notional_cr": f[1],
                           "opt_contracts": o[0], "opt_notional_cr": o[1], "opt_premium_cr": o[2],
                           "txn_rev_cr": (ru.get(side) or {}).get(und)}
                    if period_key == "daily":
                        # `xo` is omitted on days with no expiry, and unknown on days read before parser 2
                        known = side == "nse" and (p.get("parser") or 1) >= 2
                        row["nse_option_expiry"] = (und in expiring) if known else None
                    else:
                        row["days"] = p.get("days")
                    out.append(row)
        return out
    return get


def _commodity_charges(d):
    return [{"date": p["date"], "nse_charges_cr_today_rates": (p.get("rev") or [None, None])[0],
             "nse_charges_cr_then_rates": (p.get("rev") or [None, None])[1],
             "mcx_landed": p.get("mcx") is not None, "parser": p.get("parser")}
            for p in d.get("daily", [])]


def _stocks(exchange):
    def get(d):
        block = d[exchange]
        cols = d["columns"][exchange]
        return [dict(zip(cols, r), date=block["date"], exchange=exchange) for r in block["rows"]]
    return get


def _broker_series(d):
    out = []
    for b in d.get("brokers", []):
        for s in b.get("series", []):
            out.append({"broker_id": b["id"], "broker": b.get("short") or b.get("name"),
                        "parent": b.get("parent"), **s})
    return out


def _broker_live(d):
    return [{"broker_id": k, **r} for k, rs in (d.get("readings") or {}).items() for r in rs]


def _participants_daily(d):
    out = []
    for view, v in d.get("views", {}).items():
        dates = v.get("dates", [])
        for category, values in (v.get("series") or {}).items():
            for date, value in zip(dates, values):
                out.append({"view": view, "date": date, "category": category, "value": value})
    return out


def _participants_monthly(d):
    out = []
    for view, v in d.get("views", {}).items():
        shares = v.get("shares") or {}
        for category, by_month in (v.get("series") or {}).items():
            for month, value in by_month.items():
                out.append({"view": view, "month": month, "category": category, "value": value,
                            "share_pct": (shares.get(category) or {}).get(month),
                            "days": (v.get("days") or {}).get(month), "unit": v.get("unit"),
                            "aggregation": v.get("aggregation")})
    for segment, cats in (d.get("pulse") or {}).items():
        for category, by_month in cats.items():
            for month, value in by_month.items():
                out.append({"view": f"pulse:{segment}", "month": month, "category": category,
                            "value": None, "share_pct": value, "days": None, "unit": "%",
                            "aggregation": "Market Pulse share"})
    return out


def _india_vix(d):
    return [{"date": date, "vix": close} for date, close in d.get("daily", [])]


def _india_vix_window(d):
    """india_vix_history's window and its stats, kept in meta["window"]."""
    return {"window": {"source": d.get("source"), "years": d.get("window_years"),
                       "from": d.get("from"), "to": d.get("to"), **(d.get("stats") or {})}}


def _none(_d):
    return []


# ── Caveats ──────────────────────────────────────────────────────────────────

TODAY_RATES = ("Revenue is at today's statutory rates for every day (the dashboard's basis); "
               "the *_eff datasets re-price each day at the rule then in force.")
SPECIAL = ("Muhurat / DR-test sessions are NOT in these rows (they are in *_special_sessions) and "
           "must stay out of averages, day counts and weekday figures.")


def _count(rows, pred):
    return sum(1 for r in rows if pred(r))


def _exchange_caveats(ex, eff):
    def check(rows, raw):
        out = [SPECIAL]
        if ex == "mcx":
            n = _count(rows, lambda r: r.get("modelled"))
            if n:
                out.append(f"{n} rows are modelled (before 2024-09-02, `modelled` true): keep them out "
                           "of YoY, segment-mix comparisons and regressions. total_rev = fut + opt.")
        elif eff:
            n = _count(rows, lambda r: r.get("fee_basis") not in (None, "flat"))
            out.append("Re-priced at the rule then in force; slab-era periods (NSE to 2024-09-30, BSE options "
                       "2023-11-01 to 2024-09-30) are flat estimates. See fee_basis / fee_basis_by_product"
                       + (f" ({n} rows not 'flat')." if n else "."))
        else:
            out.append(TODAY_RATES)
        nulls = {}
        for r in rows:
            for k, v in r.items():
                if v is None:
                    nulls[k] = nulls.get(k, 0) + 1
        if nulls:
            out.append("Null means not published (never 0): " +
                       ", ".join(f"{k} {n}" for k, n in sorted(nulls.items())))
        return out
    return check


def _mtf_caveats(rows, raw):
    out = ["Rows are keyed on the reporting date (the trading day the book is for), published the next "
           "trading day; NSE revises a date a few days later (the revised block is used)."]
    flagged = {}
    for r in rows:
        for f in r.get("flags") or []:
            flagged[f] = flagged.get(f, 0) + 1
    if flagged:
        out.append("Flags: " + ", ".join(f"{k} {n}" for k, n in sorted(flagged.items())) +
                   " (`spike` days are left out of `combined`; the others are advisory).")
    unavailable = (raw or {}).get("unavailable") or {}
    for ex, days in unavailable.items():
        if days:
            out.append(f"{ex.upper()}: {len(days)} dates not served / unusable (raw['unavailable']['{ex}']).")
    out.append("Exchange-side level breaks are listed in raw['notes'] (BSE 12 Mar 2024 and 1 Oct 2025, "
               "BSE's doubled 20 Oct 2025 file, NSE's gross-reporting step on 1 Oct 2025).")
    return out


def _static(*lines):
    return lambda rows, raw: list(lines)


def _commodity_caveats(rows, raw):
    out = ["Shares are per underlying in ₹, never per contract. Options notional = (strike + premium) × "
           "multiplier × lots; premium is derived. NSE's commodity charges are never in NSE's total_rev."]
    if raw and raw.get("unavailable"):
        out.append(f"{len(raw['unavailable'])} days unavailable (raw['unavailable']).")
    nulls = _count(rows, lambda r: r.get("txn_rev_cr") is None and r.get("side") == "mcx")
    if nulls:
        out.append(f"{nulls} MCX rows have no split revenue (days that can't be split, e.g. 2026-06-23).")
    return out


# ── Registry ─────────────────────────────────────────────────────────────────

D = "dashboard/data/"
PARTICIPANT_SOURCES = ["nse_fo_oi", "nse_fo_vol", "nse_fii_fo", "nse_cm_cat", "nse_fo_cat", "nse_fiidii",
                       "nse_pulse", "bse_fo_oi", "bse_fo_vol", "bse_fo_cat", "bse_cash_cat", "nsdl_fpi"]

REGISTRY = {}


def _reg(name, path, extract, desc, unit=None, date_key="date", caveats=None, optional=False,
         extra_meta=None):
    """extra_meta: raw file → dict merged into the Dataset's meta (file-level figures)."""
    REGISTRY[name] = {"path": path, "extract": extract, "desc": desc, "unit": unit,
                      "date_key": date_key, "caveats": caveats, "optional": optional,
                      "extra_meta": extra_meta}


for _ex, _label in (("nse", "NSE"), ("bse", "BSE"), ("mcx", "MCX")):
    _f = f"{D}{_ex}_dashboard_data.json"
    _reg(f"{_ex}_daily", _f, _key("daily_all"),
         f"{_label} turnover, contracts and transaction revenue per trading day", "₹ Cr",
         caveats=_exchange_caveats(_ex, False))
    _reg(f"{_ex}_special_sessions", _f, lambda d: list(d.get("special_sessions", [])),
         f"{_label} Muhurat and DR-test sessions (kept out of every average)", "₹ Cr",
         caveats=_static(SPECIAL))
    _reg(f"{_ex}_monthly", _f, _key("monthly"), f"{_label} revenue by month", "₹ Cr", date_key="month",
         caveats=_exchange_caveats(_ex, False))
    _reg(f"{_ex}_quarterly", _f, _key("quarterly"), f"{_label} revenue by Indian FY quarter", "₹ Cr",
         date_key=None, caveats=_exchange_caveats(_ex, False))
    _reg(f"{_ex}_share_series", f"{D}{_ex}_share_analysis.json", _key("series"),
         f"{_label} share price vs the previous session's revenue MA (the regression's input)", "₹",
         caveats=_static("Fit and diagnostics in raw['regression'] / raw['methodology']; "
                         "price_pred is null unless the fit is supported."))
    _reg(f"{_ex}_share_revenue", f"{D}{_ex}_share_analysis.json", _key("revenue_daily"),
         f"{_label} daily revenue series used by the share-price regression", "₹ Cr")
    if _ex != "mcx":
        _reg(f"{_ex}_weekly", _f, _key("weekly"), f"{_label} revenue by week", "₹ Cr", date_key="week",
             caveats=_exchange_caveats(_ex, False))
        _fe = f"{D}{_ex}_dashboard_data_eff.json"
        _reg(f"{_ex}_daily_eff", _fe, _key("daily_all"),
             f"{_label} daily rows re-priced at the fee rule in force that day", "₹ Cr",
             caveats=_exchange_caveats(_ex, True))
        _reg(f"{_ex}_monthly_eff", _fe, _key("monthly"), f"{_label} monthly, rules then in force", "₹ Cr",
             date_key="month", caveats=_exchange_caveats(_ex, True))
        _reg(f"{_ex}_quarterly_eff", _fe, _key("quarterly"), f"{_label} quarterly, rules then in force",
             "₹ Cr", date_key=None, caveats=_exchange_caveats(_ex, True))

_reg("nse_pnl", f"{D}nse_dashboard_data.json", _key("pnl"),
     "NSE quarterly P&L: reported quarters (scripts/nse_reported_pnl.py) and the forecast (is_predicted)",
     "₹ Cr", date_key=None,
     caveats=_static("Rows with is_predicted true are the model's forecast, not reported figures."))
_reg("nse_pnl_fy", f"{D}nse_dashboard_data.json", _key("pnl_fy"), "NSE P&L by financial year", "₹ Cr",
     date_key=None)

_reg("nse_commodity_daily", f"{D}nse_commodity_daily.json", _commodity_long("daily"),
     "NSE vs MCX commodity derivatives per day and underlying", "contracts / ₹ Cr",
     caveats=_commodity_caveats)
_reg("nse_commodity_monthly", f"{D}nse_commodity_daily.json", _commodity_long("monthly"),
     "NSE vs MCX commodity derivatives per month and underlying (days with both sides)",
     "contracts / ₹ Cr", date_key="month", caveats=_commodity_caveats)
_reg("nse_commodity_quarterly", f"{D}nse_commodity_daily.json", _commodity_long("quarterly"),
     "NSE vs MCX commodity derivatives per quarter and underlying", "contracts / ₹ Cr",
     date_key=None, caveats=_commodity_caveats)
_reg("nse_commodity_charges", f"{D}nse_commodity_daily.json", _commodity_charges,
     "NSE commodity transaction charges per day (memo; never in NSE total_rev)", "₹ Cr")

_reg("mtf_nse", f"{D}mtf_daily.json", _key("nse"), "NSE MTF book: opening, fresh, liquidated, closing",
     "₹ Cr", caveats=_mtf_caveats)
_reg("mtf_bse", f"{D}mtf_daily.json", _key("bse"), "BSE MTF: amount financed and book", "₹ Cr",
     caveats=_mtf_caveats)
_reg("mtf_combined", f"{D}mtf_daily.json", _key("combined"), "NSE closing book + BSE amount financed",
     "₹ Cr", caveats=_mtf_caveats)
_reg("mtf_nse_book", f"{D}nse_mtf_daily.json", _key("daily"),
     "NSE MTF closing book only (what the brokers engine reads)", "₹ Cr")
_reg("mtf_stocks_nse", f"{D}mtf_stocks_latest.json", _stocks("nse"),
     "NSE MTF per security, latest reporting day", "₹ lakh / shares")
_reg("mtf_stocks_bse", f"{D}mtf_stocks_latest.json", _stocks("bse"),
     "BSE MTF per security, latest reporting day", "₹ lakh / shares")
_reg("mtf_brokers", f"{D}mtf_brokers.json", _broker_series,
     "Brokers' disclosed MTF books / shares, each with its filing source", "₹ Cr / %", date_key="as_of",
     caveats=_static("Compare only figures of the same `measure` and `basis` (share / gross / net / "
                     "client_funding / unstated). Figures over 120 days old are stale."))
_reg("mtf_broker_live", f"{D}mtf_broker_live.json", _broker_live,
     "Brokers' MTF figures read from their web pages each run (Groww)", "₹ Cr",
     caveats=_static("A separate series from the filings; never mixed into mtf_brokers."))

for _src in PARTICIPANT_SOURCES:
    _pulse = _src == "nse_pulse"
    _reg(f"participants_{_src}", f"{D}participants_{_src}.json",
         _tables_long("editions" if _pulse else "days", "edition" if _pulse else "date"),
         f"Participant-wise data as published by the source ({_src}), long format",
         None, date_key="edition" if _pulse else "date",
         caveats=_static("Stored as published: each source's own categories, field names and units "
                         "(labels respelt over time stay verbatim). Units are in the field names."))
_reg("participants_daily", f"{D}participants_daily.json", _participants_daily,
     "The Participants tab's views, value per category per day", None,
     caveats=_static("Units per view in participants_monthly."))
_reg("participants_monthly", f"{D}participants_monthly.json", _participants_monthly,
     "The Participants tab's views by month (value, share) and Market Pulse's monthly shares", None,
     date_key="month")

_reg("india_vix_history", f"{D}india_vix_history.json", _india_vix,
     "India VIX daily closes over the last 10 years (Yahoo ^INDIAVIX), the Revenue Summary chart's input",
     "index points", extra_meta=_india_vix_window,
     caveats=_static("Yahoo's feed, the same as nse_daily's `vix`, which re-checks only its last 10 days "
                     "each run, so an older close Yahoo has since revised can differ there.",
                     "A rolling 10-year window: rows older than 10 years before the latest close drop "
                     "off. The window's n, mean, sample sd and the latest close's z and pct_below are "
                     "in meta['window'] (raw['stats'])."))

_reg("valuation_inputs", f"{D}valuation_inputs.json", _none,
     "Shared valuation defaults (hand-edited); use .raw", None, date_key=None)
_reg("signal_tree_backtest", "data/signal_tree/backtest.json", _none,
     "Trading-logic tree backtest results; use .raw", None, date_key=None, optional=True)

CSV_DIRS = {
    "intraday_5m": ("data/intraday/5m", "5-minute bars, IST bar start, as traded (unadjusted)", "ts", False),
}
OPTIONS_DIR = "data/options"


# ── Snapshot ─────────────────────────────────────────────────────────────────

def _num(v):
    if v == "":
        return None
    try:
        return int(v)
    except ValueError:
        try:
            return float(v)
        except ValueError:
            return v


class Snapshot:
    """Every dataset read from one commit."""

    def __init__(self, ref=None, source="github", repo_dir=REPO_DIR, fetch=True):
        if source == "local":
            self.store = _GitStore(ref or "origin/main", repo_dir, fetch=fetch)
        elif source == "github":
            self.store = _GitHubStore(ref or "main")
        else:
            raise ValueError("source must be 'github' or 'local'")
        self.source = source
        self._json = {}

    @property
    def commit(self):
        return self.store.sha

    def __repr__(self):
        return f"<Snapshot {self.source} {self.store.ref} @ {str(self.commit)[:8]} {self.store.committed_at}>"

    def _read_json(self, path):
        if path not in self._json:
            self._json[path] = json.loads(self.store.read(path))
        return self._json[path]

    def _meta(self, name, desc, unit, paths, rows, date_key, raw, caveats):
        dates = [str(r[date_key]) for r in rows if date_key and r.get(date_key)]
        if all(ISO_PREFIX.match(x) for x in dates):
            dates.sort()                        # ISO dates / months / timestamps sort as text
        return {"dataset": name, "description": desc, "unit": unit,
                "path": paths[0] if len(paths) == 1 else paths,
                "source": self.source, "ref": self.store.ref, "commit": self.commit,
                "committed_at": self.store.committed_at, "rows": len(rows),
                "first_date": dates[0] if dates else None, "last_date": dates[-1] if dates else None,
                "updated_at": raw.get("updated_at") if isinstance(raw, dict) else None,
                "caveats": caveats}

    def load(self, name):
        if name.startswith("options:"):
            return self._load_csv_dir(name, f"{OPTIONS_DIR}/{name.split(':', 1)[1].upper()}",
                                      "NSE F&O bhavcopy rows for the symbol (futures; options of the two "
                                      "nearest expiries within ±25 %), as traded, unadjusted", "date")
        if name in CSV_DIRS:
            path, desc, date_key, _ = CSV_DIRS[name]
            return self._load_csv_dir(name, path, desc, date_key)
        if name not in REGISTRY:
            raise KeyError(f"unknown dataset {name!r}; see analyst.datasets()")
        spec = REGISTRY[name]
        raw = self._read_json(spec["path"])
        rows = spec["extract"](raw)
        caveats = spec["caveats"](rows, raw) if spec["caveats"] else []
        meta = self._meta(name, spec["desc"], spec["unit"], [spec["path"]], rows, spec["date_key"],
                          raw, caveats)
        if spec["extra_meta"]:
            meta.update(spec["extra_meta"](raw))
        return Dataset(name, rows, meta, raw)

    def _load_csv_dir(self, name, path, desc, date_key):
        files = [p for p in self.store.list(path) if p.endswith(".csv")]
        if not files:
            raise FileNotFoundError(f"no CSV files under {path} in commit {str(self.commit)[:8]}")
        rows = []
        for p in files:
            for r in csv.DictReader(io.StringIO(self.store.read(p))):
                rows.append({k: (v if k in ("ts", "date", "expiry", "symbol", "type") else _num(v))
                             for k, v in r.items()})
        caveats = ["Prices as traded, unadjusted for splits and bonuses."]
        if name == "intraday_5m":
            caveats.append("Volume is 0 for indices and for most stocks' 09:15 bar.")
        return Dataset(name, rows, self._meta(name, desc, None, files, rows, date_key, None, caveats))

    def options_symbols(self):
        return [p.rsplit("/", 1)[1] for p in self.store.list(OPTIONS_DIR) if not p.endswith(".json")]


def snapshot(ref=None, source="github", repo_dir=REPO_DIR, fetch=True):
    """Pin every later load() to one commit. ref: None (latest main), a branch, a
    SHA, or 'YYYY-MM-DD' (as the data stood at 23:59:59 IST that day). source:
    'github' (default, needs network) or 'local' (this clone; `fetch` first
    updates origin/main; ref 'WORKTREE' reads the files on disk)."""
    return Snapshot(ref, source, repo_dir, fetch)


def load(name, ref=None, source="github", **kw):
    """One dataset from its own snapshot. To combine datasets, use snapshot() so
    they share a commit."""
    return snapshot(ref, source, **kw).load(name)


def datasets():
    """{name: description} for every dataset (plus 'options:<SYMBOL>')."""
    out = {n: s["desc"] for n, s in REGISTRY.items()}
    out.update({n: v[1] for n, v in CSV_DIRS.items()})
    out["options:<SYMBOL>"] = "NSE F&O bhavcopy history for a symbol (BSE, MCX), see snapshot().options_symbols()"
    return out
