"""Excel mirror: the shared valuation inputs, the dashboard's valuation results and
its data, written into four workbooks on OneDrive / SharePoint.

    nse_vf, bse_vf, mcx_vf   the house vF valuation files: the P/E and discount input
                             cells on "Tusk - Summary" (label-checked first), and a
                             "Web Dashboard" sheet of inputs and results
    dashboard                the Exchanges Dashboard workbook: plain-value WD_* feed
                             sheets its analysis sheets read from

Runs daily at 01:00 IST and on demand from the dashboard's Refresh Excel button
(.github/workflows/excel-mirror.yml; docs/EXCEL_MIRROR.md has the setup, the cell
mapping and the sheet layouts). Writes go through the Excel REST API in a workbook
session, range by range, so a workbook open in Excel takes the writes and its
formulas elsewhere are never touched (scripts/excel_sync.py instead re-uploads a
whole file).

Inputs: the shared overrides from Supabase `valuation_inputs` (a run fails rather
than write the defaults when Supabase does not answer) over
dashboard/data/valuation_inputs.json; results from scripts/valuation_outputs.py,
which runs the dashboard's own JS, so the workbooks show the web figures.

Each run is logged to Supabase `excel_sync_runs` (valuation_sync_schema.sql):
with --run-id (a manual run /api/excel-refresh created) that row goes running →
success / partial / failed; otherwise a new row is inserted.

Env:
  ENABLE_EXCEL_MIRROR      'true' to write; otherwise the run does nothing (a
                           --run-id row is closed as failed, so the panel does
                           not wait on it). --check and --dry-run run regardless.
  EXCEL_TARGETS            JSON {"nse_vf": T, "bse_vf": T, "mcx_vf": T, "dashboard": T},
                           T = {"drive_id", "item_id"}, {"user": upn, "path": "/f/x.xlsx"}
                           (that user's OneDrive) or {"drive_id", "path"} (any drive)
  EXCEL_TARGETS_DRYRUN     the same for --dry-run (copies in a test folder)
  MSGRAPH_TENANT_ID, MSGRAPH_CLIENT_ID, MSGRAPH_CLIENT_SECRET   (excel_sync.get_graph_token)
  SUPABASE_URL, SUPABASE_KEY   service-role key (the workflow passes SUPABASE_SERVICE_KEY)
  GITHUB_RUN_ID            recorded on the run row

Usage:
  python scripts/excel_mirror.py [--trigger scheduled|manual] [--run-id N] [--dry-run]
  python scripts/excel_mirror.py --check [--dry-run]     read only: metadata, sheets, labels,
                                                          and a session that saves nothing
"""

import argparse
import json
import os
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

import valuation_outputs

GRAPH = "https://graph.microsoft.com/v1.0"
EXCHANGES = ("bse", "mcx", "nse")
NAMES = {"bse": "BSE", "mcx": "MCX", "nse": "NSE"}
VF_TARGETS = {"nse_vf": "nse", "bse_vf": "bse", "mcx_vf": "mcx"}
TARGET_KEYS = ("nse_vf", "bse_vf", "mcx_vf", "dashboard")

SUMMARY_SHEET = "Tusk - Summary"
WEB_SHEET = "Web Dashboard"

# Per request: at most this many cells, and about this many bytes of JSON
CELLS_PER_REQUEST = 4000
BYTES_PER_REQUEST = 1_000_000
MAX_TRIES = 5            # 429 / 503 / 504 (and dropped connections), then the call fails
MAX_WAIT_S = 60
RETRY_STATUSES = (429, 503, 504)
TIMEOUT_S = 60
CREATE_SESSION_TIMEOUT_S = 180   # opening a large workbook can take minutes

# A Web Dashboard / WD_* sheet is rewritten only when it is empty or its A1 holds this
# job's stamp: a sheet of the same name made by hand is left alone (an error instead)
STAMP_PREFIX = "Written by ExchangesDash"

IST = timezone(timedelta(hours=5, minutes=30))

# ── The vF input cells on "Tusk - Summary" ──────────────────────────────────
# Confirmed on copies of the three files (20250809_NSE vF, 20260718_BSE VF,
# 20250827_MCX vF, 23 Nov 2026). Each write is label-checked: the label cell must
# read `label` (trimmed, case-insensitive), and the target cells must hold plain
# values, not formulas; any mismatch skips all of that file's input writes.
# keys: effective inputs (scripts/valuation_outputs.py) written left to right, × scale.
#   pe0/pe1/pe2  P/E bear / base / bull
#   d2           discount_to_today_pct (valuation_inputs.json), as a fraction (9 % → 0.09)
#   d1           discount_to_fy_end_pct, as a fraction (18 % → 0.18)
# NSE's sheet differs: its today discount sits in F10 (row "Upside - Current"; row 9,
# "Current", divides by it), not in F11 beside "Target Price - FY27".
# identity: the file's ticker cell (B2), checked first. BSE's and MCX's labels are the
# same, so without it swapped target ids would write one exchange's inputs into the
# other's file; a mismatch skips the whole file (nothing written to it).
_PE = {"name": "P/E bear / base / bull", "label_cell": "A16", "label": "PE Ratio", "range": "B16:D16", "keys": ["pe0", "pe1", "pe2"], "scale": 1}
_FY_END = {"name": "Discount to FY end", "label_cell": "A12", "label": "Target Price - FY28", "range": "F12", "keys": ["d1"], "scale": 0.01}
_TODAY = {"name": "Discount to today", "label_cell": "A11", "label": "Target Price - FY27", "range": "F11", "keys": ["d2"], "scale": 0.01}
VF_INPUT_CELLS = {
    "nse": {"identity": {"cell": "B2", "value": "National Stock Exchange (NSE)"},
            "inputs": [_PE, {**_TODAY, "label_cell": "A10", "label": "Upside - Current", "range": "F10"}, _FY_END]},
    "bse": {"identity": {"cell": "B2", "value": "BSE"}, "inputs": [_PE, _TODAY, _FY_END]},
    "mcx": {"identity": {"cell": "B2", "value": "MCX"}, "inputs": [_PE, _TODAY, _FY_END]},
}

# The inputs, in the order the Web Dashboard sheet and WD_Inputs list them
INPUT_KEYS = ["adr", "g", "pe0", "pe1", "pe2", "w0", "w1", "w2", "from", "oi", "margin", "days", "d1", "d2"]
EDITABLE_KEYS = INPUT_KEYS[:9]
INPUT_LABELS = {
    "adr": "ADR estimate, ₹ Cr / session (blank = 45 DMA)", "g": "QoQ ADR growth, %",
    "pe0": "P/E bear", "pe1": "P/E base", "pe2": "P/E bull",
    "w0": "Regression weight, %", "w1": "Ratio weight, %", "w2": "ADR model weight, %",
    "from": "Regression data from (blank = all data)",
    "oi": "Other income next FY, ₹ Cr", "margin": "PAT margin, %", "days": "Sessions next FY",
    "d1": "Discount to this FY's end, %", "d2": "Discount to today, %",
}


class GraphError(Exception):
    def __init__(self, status, message, url=""):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.url = url


class FileLocked(GraphError):
    """423: the file is locked (checked out, or open for exclusive editing)."""


class Conflict(GraphError):
    """409: e.g. a sheet of that name already exists (an add that was applied, then retried)."""


class SheetNotOurs(Exception):
    """A sheet of the mirror's name that this job did not write: left alone."""


class WrongFile(Exception):
    """The target's identity cell names another exchange: nothing is written to it."""


_sleep = time.sleep   # tests replace it


def _short(text, n=300):
    text = " ".join(str(text or "").split())
    return text if len(text) <= n else text[:n - 1] + "…"


# ── Microsoft Graph ─────────────────────────────────────────────────────────

class Graph:
    """Graph calls with the app token; retries 429 / 503 / 504 (Retry-After, else
    exponential backoff) up to MAX_TRIES. Raises GraphError, FileLocked (423) or
    Conflict (409). retry_read_timeout=False: a call that timed out waiting for the
    answer is not sent again (it may have been applied, e.g. a session created)."""

    def __init__(self, token):
        self.token = token
        self.calls = 0

    def request(self, method, url, body=None, session_id=None, timeout=TIMEOUT_S, retry_read_timeout=True):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if session_id:
            headers["workbook-session-id"] = session_id
        for attempt in range(1, MAX_TRIES + 1):
            self.calls += 1
            try:
                r = requests.request(method, url, headers=headers,
                                     data=None if body is None else json.dumps(body), timeout=timeout)
            except requests.RequestException as e:
                if isinstance(e, requests.ReadTimeout) and not retry_read_timeout:
                    raise GraphError(0, f"no answer in {timeout} s (not retried: it may have been applied)", url)
                if attempt == MAX_TRIES:
                    raise GraphError(0, f"no answer: {e}", url)
                _sleep(min(MAX_WAIT_S, 2 ** attempt))
                continue
            if r.status_code in RETRY_STATUSES and attempt < MAX_TRIES:
                wait = r.headers.get("Retry-After")
                try:
                    wait = float(wait)
                except (TypeError, ValueError):
                    wait = 2 ** attempt
                _sleep(min(MAX_WAIT_S, max(0.0, wait)))
                continue
            if r.status_code >= 400:
                msg = r.text
                try:
                    msg = r.json().get("error", {}).get("message") or msg
                except ValueError:
                    pass
                cls = {423: FileLocked, 409: Conflict}.get(r.status_code, GraphError)
                raise cls(r.status_code, _short(msg), url)
            if r.status_code == 204 or not r.content:
                return None
            try:
                return r.json()
            except ValueError:
                return None


def _odata(s):
    return quote(str(s).replace("'", "''"), safe="")


def col_letter(n):
    """1 → A, 27 → AA."""
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def parse_cell(ref):
    """'B16' → (16, 2)."""
    letters = "".join(c for c in ref if c.isalpha()).upper()
    col = 0
    for c in letters:
        col = col * 26 + ord(c) - 64
    return int("".join(c for c in ref if c.isdigit())), col


def parse_range(ref):
    """'B16:D16' → ((16, 2), (16, 4)); a single cell → the same corner twice."""
    a, _, b = ref.partition(":")
    return parse_cell(a), parse_cell(b or a)


def _is_number(s):
    try:
        float(s)
        return True
    except ValueError:
        return False


def _cell_value(v):
    """A JSON value as an Excel cell: None → empty, dict / list → JSON text. Text that
    Excel would take as a formula (=…, or +…, -…, @… when not a number) gets a leading
    apostrophe, so it stays text."""
    if v is None:
        return ""
    if isinstance(v, (dict, list)):
        v = json.dumps(v, separators=(",", ":"))
    if isinstance(v, str) and v and (v[0] == "=" or (v[0] in "+-@" and not _is_number(v))):
        return "'" + v
    return v


class Workbook:
    """One workbook through the Excel REST API, inside a persistent session."""

    def __init__(self, graph, drive_id, item_id):
        self.g = graph
        self.item = f"{GRAPH}/drives/{quote(drive_id, safe='')}/items/{quote(item_id, safe='')}"
        self.base = f"{self.item}/workbook"
        self.session = None
        self.cells = 0

    def call(self, method, path, body=None):
        return self.g.request(method, f"{self.base}/{path}", body, self.session)

    def metadata(self):
        return self.g.request("GET", self.item)

    def open(self, persist=True):
        """Opens a workbook session. Not retried after a read timeout (a retry could leave
        an orphan session); any id received is kept, so close() closes it."""
        got = self.g.request("POST", f"{self.base}/createSession", {"persistChanges": persist},
                             timeout=CREATE_SESSION_TIMEOUT_S, retry_read_timeout=False) or {}
        self.session = got.get("id")
        if not self.session:
            raise GraphError(0, "createSession returned no id")

    def close(self):
        if self.session:
            try:
                self.g.request("POST", f"{self.base}/closeSession", {}, self.session)
            finally:
                self.session = None

    def sheet_names(self):
        return [w.get("name") for w in (self.call("GET", "worksheets?$select=name") or {}).get("value", [])]

    def _sheet(self, name):
        return f"worksheets('{_odata(name)}')"

    def add_sheet(self, name, names):
        """Adds a sheet and records it in `names`. A 409 (it exists: an add applied,
        then retried) re-reads the names, and is an error only if it is still missing."""
        try:
            self.call("POST", "worksheets/add", {"name": name})
        except Conflict:
            names[:] = self.sheet_names()
            if name not in names:
                raise
            return
        names.append(name)

    def read(self, sheet, address):
        """{values, formulas} of a range."""
        return self.call("GET", f"{self._sheet(sheet)}/range(address='{_odata(address)}')?$select=address,values,formulas") or {}

    def extent(self, sheet):
        """(last row, last column, A1's value) of the sheet's used range; None when empty."""
        used = self.call("GET", f"{self._sheet(sheet)}/usedRange(valuesOnly=true)?$select=address") or {}
        address = (used.get("address") or "A1").split("!")[-1]
        _, (r1, c1) = parse_range(address)
        a1 = ((self.read(sheet, "A1").get("values") or [[""]])[0] or [""])[0]
        if (r1, c1) == (1, 1) and a1 in ("", None):
            return None
        return r1, c1, a1

    def clear(self, sheet, address):
        """Clears the contents of a range (formats stay)."""
        self.call("POST", f"{self._sheet(sheet)}/range(address='{_odata(address)}')/clear", {"applyTo": "Contents"})

    def write(self, sheet, address, values):
        self.call("PATCH", f"{self._sheet(sheet)}/range(address='{_odata(address)}')", {"values": values})
        self.cells += sum(len(r) for r in values)

    def write_table(self, sheet, rows, top=1, left=1):
        """Writes `rows` (padded to one width) from row `top`, column `left`, in
        chunks of whole rows: at most CELLS_PER_REQUEST cells and about
        BYTES_PER_REQUEST of JSON each. Returns the addresses written."""
        if not rows:
            return []
        width = max(len(r) for r in rows)
        rows = [[_cell_value(v) for v in r] + [""] * (width - len(r)) for r in rows]
        per = max(1, CELLS_PER_REQUEST // width)
        addresses, i = [], 0
        while i < len(rows):
            chunk, size = [], 0
            while i < len(rows) and len(chunk) < per:
                n = len(json.dumps(rows[i])) + 1
                if chunk and size + n > BYTES_PER_REQUEST:
                    break
                chunk.append(rows[i])
                size += n
                i += 1
            r0 = top + i - len(chunk)
            address = f"{col_letter(left)}{r0}:{col_letter(left + width - 1)}{r0 + len(chunk) - 1}"
            self.write(sheet, address, chunk)
            addresses.append(address)
        return addresses

    def rewrite_sheet(self, sheet, rows, names):
        """Writes `rows` from A1 into a sheet of the mirror's: created if missing (names:
        the workbook's sheets, updated); if it exists, only when empty or stamped by this
        job (else SheetNotOurs, and nothing is written). The new rows are written first,
        then only what lies beyond them (rows below, columns to the right) is cleared, so
        a run that fails part-way leaves the old values, never a blank sheet."""
        old = None
        if sheet in names:
            old = self.extent(sheet)
            if old and not str(old[2]).startswith(STAMP_PREFIX):
                raise SheetNotOurs(f"sheet {sheet!r} was not written by this job (A1 reads {_short(old[2], 40)!r}): left alone")
        else:
            self.add_sheet(sheet, names)
        addresses = self.write_table(sheet, rows)
        if old:
            n, w = len(rows), max(len(r) for r in rows)
            r1, c1 = old[0], old[1]
            if r1 > n:
                self.clear(sheet, f"A{n + 1}:{col_letter(max(c1, w))}{r1}")
            if c1 > w:
                self.clear(sheet, f"{col_letter(w + 1)}1:{col_letter(c1)}{min(n, r1)}")
        return addresses


# ── Targets ─────────────────────────────────────────────────────────────────

def parse_targets(text):
    """EXCEL_TARGETS JSON → {key: target}; raises ValueError when unusable."""
    if not text or not text.strip():
        raise ValueError("not set")
    try:
        t = json.loads(text)
    except ValueError as e:
        raise ValueError(f"not JSON ({e})")
    if not isinstance(t, dict):
        raise ValueError("not a JSON object")
    out = {}
    for key, v in t.items():
        if key not in TARGET_KEYS:
            raise ValueError(f"unknown target {key!r} (expected {', '.join(TARGET_KEYS)})")
        ok = isinstance(v, dict) and ((v.get("drive_id") and (v.get("item_id") or v.get("path")))
                                      or (v.get("user") and v.get("path")))
        if not ok:
            raise ValueError(f"{key}: needs drive_id + item_id, drive_id + path, or user + path")
        out[key] = v
    return out


def resolve_target(graph, key, t):
    """(drive_id, item_id). A path target is looked up and its ids printed for pinning:
    user + path in that user's OneDrive (/users/{upn}/drive/root:{path}), drive_id + path
    in that drive, e.g. a SharePoint library (/drives/{id}/root:{path})."""
    if t.get("drive_id") and t.get("item_id"):
        return t["drive_id"], t["item_id"]
    path = "/" + t["path"].lstrip("/")
    if t.get("drive_id"):
        where, base = f"drive {t['drive_id']}", f"{GRAPH}/drives/{quote(t['drive_id'], safe='')}"
    else:
        where, base = t["user"], f"{GRAPH}/users/{quote(t['user'], safe='@')}/drive"
    meta = graph.request("GET", f"{base}/root:{quote(path)}?$select=id,name,parentReference")
    drive_id, item_id = meta["parentReference"]["driveId"], meta["id"]
    print(f"{key}: {where}:{path} → pin as {json.dumps({'drive_id': drive_id, 'item_id': item_id})}")
    return drive_id, item_id


# ── Supabase ────────────────────────────────────────────────────────────────

class SupabaseError(Exception):
    pass


def sb(method, path, body=None, prefer=None):
    base, key = os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_KEY", "")
    if not base or not key:
        raise SupabaseError("SUPABASE_URL / SUPABASE_KEY not set")
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    try:
        r = requests.request(method, f"{base}/rest/v1/{path}", headers=headers,
                             data=None if body is None else json.dumps(body), timeout=30)
    except requests.RequestException as e:
        raise SupabaseError(f"no answer: {e}")
    if r.status_code >= 400:
        raise SupabaseError(f"HTTP {r.status_code}: {_short(r.text, 200)}")
    return r.json() if r.content else None


def read_shared_inputs():
    """({ex: overrides}, {ex: updated_at}) from Supabase valuation_inputs."""
    rows = sb("GET", "valuation_inputs?select=exchange,inputs,updated_at") or []
    overrides, updated = {}, {}
    for r in rows:
        ex = r.get("exchange")
        if ex in EXCHANGES:
            if isinstance(r.get("inputs"), dict):
                overrides[ex] = r["inputs"]
            updated[ex] = r.get("updated_at")
    return overrides, updated


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class RunLog:
    """The excel_sync_runs row of this run. Logging failures are printed, not fatal,
    except where the caller needs the row."""

    def __init__(self, run_id=None, trigger="scheduled"):
        self.id = run_id
        self.trigger = trigger
        gh = os.environ.get("GITHUB_RUN_ID", "")
        self.github_run_id = int(gh) if gh.isdigit() else None

    def start(self):
        fields = {"status": "running", "started_at": _now_iso(), "github_run_id": self.github_run_id}
        try:
            if self.id:
                sb("PATCH", f"excel_sync_runs?id=eq.{int(self.id)}", fields, "return=minimal")
            else:
                rows = sb("POST", "excel_sync_runs", {"trigger": self.trigger, **fields}, "return=representation")
                self.id = rows[0]["id"] if rows else None
        except SupabaseError as e:
            print(f"WARNING: could not log the run start: {e}")
        # The workflow's always() step (--finalize) closes this row if the job dies first
        path = run_id_file()
        if self.id:
            try:
                with open(path, "w") as f:
                    f.write(str(self.id))
            except OSError as e:
                print(f"WARNING: could not note the run id: {e}")

    def finish(self, status, files=None, error=None):
        if not self.id:
            return
        try:
            sb("PATCH", f"excel_sync_runs?id=eq.{int(self.id)}",
               {"status": status, "finished_at": _now_iso(), "files": files, "error": _short(error, 500) if error else None,
                "github_run_id": self.github_run_id}, "return=minimal")
        except SupabaseError as e:
            print(f"WARNING: could not log the run result: {e}")


def run_id_file():
    """Where this job notes its run row's id for --finalize: EXCEL_RUN_ID_FILE, else
    excel_run_id in the runner's temp directory (RUNNER_TEMP, emptied per job; the
    `runner` context cannot be used in a job-level env: in the workflow)."""
    return os.environ.get("EXCEL_RUN_ID_FILE") or os.path.join(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir(), "excel_run_id")


def finalize(run_id, conclusion):
    """The workflow's last step, run whatever happened: a row still queued or running
    (the job failed, was cancelled or timed out before recording a result) is closed as
    failed. A row the run finished is not touched (the PATCH filters on its status)."""
    if not run_id:
        try:
            with open(run_id_file()) as f:
                run_id = f.read().strip()
        except OSError:
            run_id = None
    if not run_id or not str(run_id).isdigit():
        print("No run row to close.")
        return
    try:
        sb("PATCH", f"excel_sync_runs?id=eq.{int(run_id)}&status=in.(queued,running)",
           {"status": "failed", "finished_at": _now_iso(),
            "error": f"the workflow job ended ({conclusion or 'unknown'}) before the run recorded a result"},
           "return=minimal")
    except SupabaseError as e:
        print(f"WARNING: could not close run {run_id}: {e}")


# ── The daily slot's gate ───────────────────────────────────────────────────
# Vercel Cron dispatches the 01:00 IST run on time; GitHub's own `schedule:` fires the
# same slot hours late. That late run is skipped when a scheduled run already
# succeeded (or partly) in the last SCHEDULED_SKIP_HOURS, so there is one a day.
SCHEDULED_SKIP_HOURS = 20


def _parse_ts(x):
    try:
        dt = datetime.fromisoformat(str(x).replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def scheduled_run_due(rows, now, hours=SCHEDULED_SKIP_HOURS):
    """False when one of `rows` (excel_sync_runs) is a scheduled run that finished with
    success or partial within `hours` before `now`; else True."""
    cutoff = now - timedelta(hours=hours)
    for r in rows or []:
        t = _parse_ts(r.get("finished_at")) if r.get("finished_at") else None
        if r.get("trigger") == "scheduled" and r.get("status") in ("success", "partial") and t and cutoff <= t <= now + timedelta(minutes=5):
            return False
    return True


def gate(event_name, now=None):
    """(run?, why) for the workflow's gate job. Only GitHub's own schedule is gated; a
    dispatched run (Vercel Cron's slot, the button, by hand) always runs. When the log
    cannot be read the run goes ahead: a repeat is harmless, a missed day is not."""
    if event_name != "schedule":
        return True, f"{event_name or 'manual'} run: not gated"
    now = now or datetime.now(timezone.utc)
    since = (now - timedelta(hours=SCHEDULED_SKIP_HOURS)).isoformat(timespec="seconds").replace("+00:00", "Z")
    try:
        rows = sb("GET", "excel_sync_runs?select=trigger,status,finished_at&trigger=eq.scheduled"
                         f"&status=in.(success,partial)&finished_at=gte.{since}&order=finished_at.desc&limit=5")
    except SupabaseError as e:
        return True, f"run log not read ({e}): running"
    if scheduled_run_due(rows, now):
        return True, f"no scheduled run finished in the last {SCHEDULED_SKIP_HOURS} h"
    return False, f"a scheduled run already finished in the last {SCHEDULED_SKIP_HOURS} h: skipped"


# ── What gets written ───────────────────────────────────────────────────────

def ist_text(iso_or_dt):
    """'2026-11-23T19:30:00Z' or a datetime → '24 Nov 2026 01:00 IST'; '' for none."""
    if not iso_or_dt:
        return ""
    dt = iso_or_dt
    if isinstance(dt, str):
        try:
            dt = datetime.fromisoformat(dt.replace("Z", "+00:00"))
        except ValueError:
            return dt
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(IST).strftime("%-d %b %Y %H:%M IST")


def stamp(now, data_to, inputs_changed):
    return (f"{STAMP_PREFIX} at {ist_text(now)}; data to {data_to or 'n/a'}; "
            f"inputs last changed {ist_text(inputs_changed) or 'never (the defaults)'}")


def _latest(*isos):
    xs = [x for x in isos if x]
    return max(xs) if xs else None


def _three(x):
    return list(x) if x else ["", "", ""]


def web_dashboard_rows(ex, e, now, inputs_changed):
    """The vF file's "Web Dashboard" sheet, five columns A–E, fixed addresses
    (docs/EXCEL_MIRROR.md lists them; WEB_ADDRESSES below names the main ones)."""
    v, d = e["inputs"], e["defaults"]
    ctx, a, fit, ratio, win = e["context"], e["adr_model"], e["fit"] or {}, e["ratio"] or {}, e["window"]
    rows = [
        [stamp(now, ctx["last_date"], inputs_changed)],
        [f"{NAMES[ex]}: the web dashboard's Valuation Model inputs and results. Plain values, rewritten on every run: link to these cells, do not type here."],
        [],
        ["Inputs"],
        ["Key", "Input", "Value", "Default", "Edited"],
    ]
    for k in INPUT_KEYS:
        rows.append([k, INPUT_LABELS[k], v.get(k), d.get(k), (k in e["edited"]) if k in EDITABLE_KEYS else ""])
    rows += [[], ["Market and fit"], ["Item", "Value"]]
    items = [
        ("CMP, ₹", e["cmp"]), ("CMP date (last close)", e["cmp_date"]), ("Data to", ctx["last_date"]),
        ("Current quarter", ctx["q_label"]), ("Quarter ADR to date, ₹ Cr", ctx["q_adr"]), ("Quarter sessions", ctx["q_n"]),
        ("45 DMA ADR, ₹ Cr", ctx["adr45"]), ("ADR in the estimate table, ₹ Cr", e["est"]["adr"]),
        ("Next FY", f"FY{str(e['adr_path']['fy'])[-2:]}"), ("Next-FY average ADR, ₹ Cr", a["adr_fy"]),
        ("Total income next FY, ₹ Cr", a["total"]), ("PAT next FY, ₹ Cr", a["pat"]), ("EPS next FY, ₹", a["eps"]),
        ("Shares, Cr", e["shares_cr"]), ("Fit sessions (n)", win["n"]), ("Regression data from", e["data_from"]),
        ("Fit first point", win["first_point"]), ("Fit intercept, ₹", fit.get("intercept")), ("Fit slope", fit.get("slope")),
        ("Fit standard error, ₹", fit.get("se")), ("Fit R²", fit.get("r2")), ("Price ÷ MA mean", ratio.get("mean")),
        ("Price ÷ MA σ", ratio.get("sd")), ("Fit note", e["fit_why"]), ("Ratio note", e["ratio_why"]),
    ]
    rows += [[k, val] for k, val in items]
    rows += [[], ["Targets, ₹ per share (upside as a fraction of CMP)", "Bear", "Base", "Bull"]]
    tri = lambda label, x: [label] + _three(x)  # noqa: E731
    rows += [
        tri("Triangulated target (ADR estimate)", e["target"]["values"]),
        tri("Upside vs CMP", e["target"]["upside"]),
        tri("ADR model, next FY-end target", a["fy_next_end"]),
        tri("ADR model, this FY-end target", a["fy_end"]),
        tri("ADR model, today", a["today"]),
    ]
    for key, name in (("dma", "45 DMA"), ("est", "ADR estimate")):
        t = e[key]
        rows += [
            tri(f"{name}: Regression", t["regression"]), tri(f"{name}: Ratio", t["ratio"]),
            tri(f"{name}: ADR model", t["adr_model"]), tri(f"{name}: Weighted average", t["avg"]),
            tri(f"{name}: Upside vs CMP", t["upside"]),
        ]
    rows += [[], ["ADR path", "ADR, ₹ Cr / session"]]
    rows += [[p["label"], p["adr"]] for p in e["adr_path"]["quarters"]]
    rows.append([f"FY{str(e['adr_path']['fy'])[-2:]} average", e["adr_path"]["adr"]])
    return rows


# Main fixed addresses of the Web Dashboard sheet (a test checks them against the layout)
WEB_ADDRESSES = {
    "stamp": "A1", "inputs": "C6:C19", "cmp": "B23", "cmp_date": "B24",
    "target": "B50:D50", "upside": "B51:D51", "adr_model_today": "B54:D54", "adr_path": "A66",
}


def valuation_row(ex, e, inputs_changed):
    a, fit, ratio = e["adr_model"], e["fit"] or {}, e["ratio"] or {}
    row = [ex, e["cmp"], e["cmp_date"], e["context"]["last_date"], e["context"]["q_label"], e["context"]["q_adr"],
           e["context"]["adr45"], e["est"]["adr"], e["est_is_dma"], e["adr_path"]["fy"], a["adr_fy"], a["eps"]]
    for x in (e["target"]["values"], e["target"]["upside"], a["fy_next_end"], a["fy_end"], a["today"]):
        row += _three(x)
    for key in ("dma", "est"):
        for x in ("regression", "ratio", "adr_model", "avg"):
            row += _three(e[key][x])
    row += [e["window"]["n"], e["data_from"], e["window"]["first_point"], fit.get("intercept"), fit.get("slope"),
            fit.get("se"), fit.get("r2"), ratio.get("mean"), ratio.get("sd"), e["shares_cr"], inputs_changed]
    return row


def valuation_header():
    h = ["exchange", "cmp", "cmp_date", "data_to", "quarter", "quarter_adr", "adr45", "adr_estimate_used", "estimate_is_45dma",
         "next_fy", "next_fy_adr", "eps_next_fy"]
    for p in ("target", "upside", "adr_model_fy_next_end", "adr_model_fy_end", "adr_model_today"):
        h += [f"{p}_bear", f"{p}_base", f"{p}_bull"]
    for t in ("dma", "est"):
        for x in ("regression", "ratio", "adr_model", "avg"):
            h += [f"{t}_{x}_bear", f"{t}_{x}_base", f"{t}_{x}_bull"]
    return h + ["fit_n", "data_from", "fit_first_point", "fit_intercept", "fit_slope", "fit_se", "fit_r2",
                "ratio_mean", "ratio_sd", "shares_cr", "inputs_changed_at"]


def _columns(rows, first=("date",)):
    cols = [c for c in first if any(c in r for r in rows)]
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    return cols


def table(rows, cols):
    return [[r.get(c) for c in cols] for r in rows]


def feed_sheets(outputs, raw, updated, now):
    """{sheet: rows} for the Exchanges Dashboard workbook: row 1 stamp, row 2 headers,
    data from row 3."""
    sheets = {}
    ex_out = outputs["exchanges"]
    changed = _latest(*updated.values())
    daily = {ex: sorted((raw.get(ex) or {}).get("daily_all") or [], key=lambda r: r.get("date") or "") for ex in EXCHANGES}
    last = {ex: (daily[ex][-1]["date"] if daily[ex] else None) for ex in EXCHANGES}
    data_to = _latest(*last.values())

    head = ["exchange"] + INPUT_KEYS + ["edited", "inputs_changed_at"]
    rows = [[ex] + [ex_out[ex].get("inputs", {}).get(k) for k in INPUT_KEYS]
            + [",".join(ex_out[ex].get("edited", [])), ist_text(updated.get(ex))] for ex in EXCHANGES]
    sheets["WD_Inputs"] = [[stamp(now, data_to, changed)], head] + rows

    # One row per exchange whatever happens, so the rows keep their addresses
    head = valuation_header()
    rows = [valuation_row(ex, ex_out[ex], ist_text(updated.get(ex))) if "error" not in ex_out[ex]
            else [ex] + [""] * (len(head) - 1) for ex in EXCHANGES]
    sheets["WD_Valuation"] = [[stamp(now, data_to, changed)], head] + rows

    for ex in ("nse", "bse", "mcx"):
        cols = _columns(daily[ex])
        sheets[f"WD_{NAMES[ex]}_Daily"] = [[stamp(now, last[ex], changed)], cols] + table(daily[ex], cols)

    for key, sheet, first in (("quarterly", "WD_Quarterly", ("quarter",)), ("monthly", "WD_Monthly", ("month",))):
        stacked = [{"exchange": ex, **r} for ex in ("nse", "bse", "mcx") for r in (raw.get(ex) or {}).get(key) or []]
        cols = _columns(stacked, ("exchange",) + first)
        sheets[sheet] = [[stamp(now, data_to, changed)], cols] + table(stacked, cols)

    vix = [[r["date"], r["vix"]] for r in daily["nse"] if r.get("vix") is not None]
    sheets["WD_VIX"] = [[stamp(now, last["nse"], changed)], ["date", "vix"]] + vix

    nse = {r["date"]: r for r in daily["nse"]}
    bse = {r["date"]: r for r in daily["bse"]}
    contracts = []
    for date in sorted(set(nse) | set(bse)):
        n, b = nse.get(date), bse.get(date)
        add = lambda r, *ks: sum(r.get(k) or 0 for k in ks) if r else None  # noqa: E731
        contracts.append([date, add(n, "io_contracts", "so_contracts"), add(n, "if_contracts", "sf_contracts"),
                          add(n, "io_premium", "so_premium"), b.get("total_contracts") if b else None,
                          b.get("options_premium_turnover") if b else None])
    sheets["WD_Contracts"] = [[stamp(now, _latest(last["nse"], last["bse"]), changed)],
                              ["date", "nse_option_contracts", "nse_futures_contracts", "nse_option_premium_cr",
                               "bse_contracts", "bse_option_premium_cr"]] + contracts
    return sheets


# ── One file ────────────────────────────────────────────────────────────────

def label_check(wb, ex):
    """Reads the identity and mapped cells of "Tusk - Summary" in one range.
    Returns (identity problem or None, [label problems]): every label must match and
    every target cell must hold a value, not a formula."""
    spec = VF_INPUT_CELLS[ex]
    cells, ident = spec["inputs"], spec["identity"]
    corners = ([parse_cell(ident["cell"])] + [parse_cell(c["label_cell"]) for c in cells]
               + [p for c in cells for p in parse_range(c["range"])])
    r0, c0 = min(r for r, _ in corners), min(c for _, c in corners)
    r1, c1 = max(r for r, _ in corners), max(c for _, c in corners)
    got = wb.read(SUMMARY_SHEET, f"{col_letter(c0)}{r0}:{col_letter(c1)}{r1}")
    values, formulas = got.get("values") or [], got.get("formulas") or []

    def at(grid, r, c):
        try:
            return grid[r - r0][c - c0]
        except (IndexError, TypeError):
            return None

    same = lambda a, b: str(a or "").strip().casefold() == str(b).strip().casefold()  # noqa: E731
    seen = at(values, *parse_cell(ident["cell"]))
    identity = None if same(seen, ident["value"]) else \
        f"{ident['cell']} reads {str(seen or '').strip()!r}, expected {ident['value']!r}: not the {NAMES[ex]} file"
    problems = []
    for c in cells:
        seen = at(values, *parse_cell(c["label_cell"]))
        if not same(seen, c["label"]):
            problems.append(f"{c['label_cell']} reads {str(seen or '').strip()!r}, expected {c['label']!r}")
            continue
        (ra, ca), (rb, cb) = parse_range(c["range"])
        for rr in range(ra, rb + 1):
            for cc in range(ca, cb + 1):
                f = at(formulas, rr, cc)
                if isinstance(f, str) and f.startswith("="):
                    problems.append(f"{col_letter(cc)}{rr} holds a formula ({_short(f, 40)}), not an input")
    return identity, problems


def write_vf(wb, ex, e, now, inputs_changed, result):
    names = wb.sheet_names()
    if SUMMARY_SHEET not in names:
        raise WrongFile(f"no sheet {SUMMARY_SHEET!r}: not a vF file, nothing written")
    identity, problems = label_check(wb, ex)
    if identity:
        raise WrongFile(f"identity check failed, nothing written: {identity}")
    # input_cells: per mapped range, whether it was written (the panel says "some" vs none)
    cells = result["input_cells"] = {c["range"]: False for c in VF_INPUT_CELLS[ex]["inputs"]}
    if problems:
        result["errors"].append("label check failed, input cells not written: " + "; ".join(problems))
    else:
        for c in VF_INPUT_CELLS[ex]["inputs"]:
            vals = [e["inputs"].get(k) for k in c["keys"]]
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
                result["errors"].append(f"{c['range']} ({c['name']}) has no value to write: left as it is")
                continue
            wb.write(SUMMARY_SHEET, c["range"], [[v * c["scale"] for v in vals]])
            cells[c["range"]] = True
    result["inputs_written"] = all(cells.values())
    try:
        wb.rewrite_sheet(WEB_SHEET, web_dashboard_rows(ex, e, now, inputs_changed), names)
        result["sheets"].append(WEB_SHEET)
    except SheetNotOurs as err:
        result["errors"].append(str(err))


def write_dashboard(wb, sheets, result):
    names = wb.sheet_names()
    for sheet, rows in sheets.items():
        try:
            wb.rewrite_sheet(sheet, rows, names)
            result["sheets"].append(sheet)
        except SheetNotOurs as err:
            result["errors"].append(str(err))


def run_target(graph, key, target, work, dry_run):
    """Writes one target; never raises. Returns its result for excel_sync_runs.files:
    failed when it stopped early, partial when it finished with errors (a skipped
    sheet or input cell, or a closeSession that failed), else success."""
    t0 = time.monotonic()
    result = {"target": key, "status": "failed", "cells": 0, "sheets": [], "errors": [], "dry_run": dry_run}
    if key in VF_TARGETS:
        result["inputs_written"] = False
    wb, fatal = None, True
    try:
        drive_id, item_id = resolve_target(graph, key, target)
        result["item"] = {"drive_id": drive_id, "item_id": item_id}
        wb = Workbook(graph, drive_id, item_id)
        wb.open()
        work(wb, result)
        fatal = False
    except FileLocked as e:
        result["errors"].append(f"file locked ({e})")
    except Conflict as e:
        result["errors"].append(f"conflict ({e})")
    except (GraphError, WrongFile) as e:
        result["errors"].append(str(e))
    except Exception as e:   # a bug must not stop the other files
        result["errors"].append(f"{type(e).__name__}: {_short(e)}")
    finally:
        if wb is not None:
            try:
                wb.close()
            except GraphError as e:
                result["errors"].append(f"closeSession: {e}")
            result["cells"] = wb.cells
    result["status"] = "failed" if fatal else "partial" if result["errors"] else "success"
    result["duration_s"] = round(time.monotonic() - t0, 1)
    print(f"{key}: {result['status']}, {result['cells']} cells, sheets {', '.join(result['sheets']) or '-'}"
          + (f"; {' | '.join(result['errors'])}" if result["errors"] else ""))
    return result


def run_status(files):
    done = [f for f in files if f["status"] != "skipped"]
    if not done or all(f["status"] == "failed" for f in done):
        return "failed"
    return "success" if all(f["status"] == "success" for f in done) else "partial"


def graph_token():
    """excel_sync.get_graph_token, which exits on failure: a GraphError here instead."""
    import excel_sync
    try:
        return excel_sync.get_graph_token()
    except SystemExit:
        raise GraphError(401, "Microsoft Graph sign-in failed (MSGRAPH_TENANT_ID / CLIENT_ID / CLIENT_SECRET)")


def mirror(targets, dry_run=False, now=None, data=None):
    """The write run. Returns (status, files, error)."""
    now = now or datetime.now(timezone.utc)
    try:
        overrides, updated = read_shared_inputs()
    except SupabaseError as e:
        return "failed", [], f"shared inputs not read from Supabase ({e}); nothing written"
    data = data or valuation_outputs.load_data()
    outputs = valuation_outputs.compute(data["inputs"], data["raw"], data["share"], overrides)
    graph = Graph(graph_token())
    files = []
    for key in TARGET_KEYS:
        if key not in targets:
            files.append({"target": key, "status": "skipped", "cells": 0, "sheets": [], "errors": ["no target configured"], "dry_run": dry_run})
            continue
        if key in VF_TARGETS:
            ex = VF_TARGETS[key]
            e = outputs["exchanges"][ex]
            if "error" in e:
                files.append({"target": key, "status": "failed", "cells": 0, "sheets": [], "errors": [f"no valuation: {e['error']}"], "dry_run": dry_run})
                continue
            work = lambda wb, res, ex=ex, e=e: write_vf(wb, ex, e, now, updated.get(ex), res)  # noqa: E731
        else:
            sheets = feed_sheets(outputs, data["raw"], updated, now)
            work = lambda wb, res, sheets=sheets: write_dashboard(wb, sheets, res)  # noqa: E731
        files.append(run_target(graph, key, targets[key], work, dry_run))
    status = run_status(files)
    return status, files, None if status != "failed" else "no file was written"


def session_probe(wb):
    """Opens and closes a session that saves nothing (persistChanges: false): proves the
    app may open the workbook through the Excel REST API before any write. 'OK' or why not."""
    try:
        wb.open(persist=False)
    except GraphError as e:
        return f"REFUSED {e}"
    try:
        wb.close()
    except GraphError as e:
        return f"opened, but closeSession failed: {e}"
    return "OK"


def ours_text(wb, sheets):
    """How the mirror's sheets stand: missing (will be created), ours, or not ours (skipped)."""
    out = []
    for name in sheets:
        try:
            old = wb.extent(name)
        except GraphError as e:
            out.append(f"{name}: {e}")
            continue
        if old and not str(old[2]).startswith(STAMP_PREFIX):
            out.append(f"{name}: NOT OURS, will be skipped")
    return "; ".join(out)


def check(targets):
    """Read only: each target's metadata, sheets, identity and label checks, and a session
    that saves nothing, as a table. True when every configured target passes."""
    graph = Graph(graph_token())
    rows = [("target", "file", "drive_id / item_id", "sheets", "Web Dashboard / WD_*", "identity / labels", "session")]
    ok = True
    for key in TARGET_KEYS:
        if key not in targets:
            rows.append((key, "-", "not configured", "", "", "", ""))
            continue
        try:
            drive_id, item_id = resolve_target(graph, key, targets[key])
            wb = Workbook(graph, drive_id, item_id)
            meta = wb.metadata() or {}
            names = wb.sheet_names()
            if key in VF_TARGETS:
                if SUMMARY_SHEET not in names:
                    labels = f"no {SUMMARY_SHEET!r} sheet"
                else:
                    identity, problems = label_check(wb, VF_TARGETS[key])
                    labels = identity or ("OK" if not problems else "; ".join(problems))
                mine = ([WEB_SHEET] if WEB_SHEET in names else [])
                state = ours_text(wb, mine) or ("present" if mine else "will be created")
            else:
                labels = "n/a"
                wd = [n for n in names if n.startswith("WD_")]
                state = ours_text(wb, wd) or (f"{len(wd)} WD_* sheets" if wd else "will be created")
            session = session_probe(wb)
            ok = ok and labels in ("OK", "n/a") and session == "OK" and "NOT OURS" not in state
            rows.append((key, meta.get("name", "?"), f"{drive_id} / {item_id}", str(len(names)), state, labels, session))
        except GraphError as e:
            ok = False
            rows.append((key, "-", "", "", "", f"ERROR {e}", ""))
    widths = [max(len(str(r[i])) for r in rows) for i in range(len(rows[0]))]
    for r in rows:
        print("  ".join(str(c).ljust(w) for c, w in zip(r, widths)).rstrip())
    if not ok:
        print("Not every target passed: see docs/EXCEL_MIRROR.md (a REFUSED session means app-only Excel REST "
              "calls are not allowed for this file; the docs describe the fallbacks).")
    return ok


def main(argv=None):
    ap = argparse.ArgumentParser(description="Mirror the dashboard's inputs, results and data into the Excel workbooks.")
    ap.add_argument("--trigger", choices=("scheduled", "manual"), default="scheduled")
    ap.add_argument("--run-id", help="excel_sync_runs id of a manual run created by /api/excel-refresh")
    ap.add_argument("--dry-run", action="store_true", help="write to EXCEL_TARGETS_DRYRUN (test copies)")
    ap.add_argument("--check", action="store_true", help="read only: metadata, sheets and label checks of each target")
    ap.add_argument("--gate", action="store_true", help="the workflow's gate: run=true|false to GITHUB_OUTPUT")
    ap.add_argument("--finalize", action="store_true", help="close this job's run row if it is still queued or running")
    ap.add_argument("--conclusion", default="", help="with --finalize: the job's status")
    args = ap.parse_args(argv)
    run_id = args.run_id if args.run_id and str(args.run_id).strip() else None

    if args.gate:
        run, why = gate(os.environ.get("GITHUB_EVENT_NAME", ""))
        print(f"Gate: {'run' if run else 'skip'} ({why})")
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            with open(out, "a") as f:
                f.write(f"run={'true' if run else 'false'}\n")
        return 0
    if args.finalize:
        finalize(run_id, args.conclusion)
        return 0

    if not (args.check or args.dry_run) and os.environ.get("ENABLE_EXCEL_MIRROR", "").strip().lower() != "true":
        print("Excel mirror is off (repository variable ENABLE_EXCEL_MIRROR is not 'true'): nothing written.")
        if run_id:
            RunLog(run_id, args.trigger).finish("failed", [], "Excel mirror is switched off (ENABLE_EXCEL_MIRROR)")
        return 0

    env = "EXCEL_TARGETS_DRYRUN" if args.dry_run else "EXCEL_TARGETS"
    try:
        targets = parse_targets(os.environ.get(env, ""))
    except ValueError as e:
        targets, bad = None, f"{env} {e}"

    if args.check:
        if targets is None:
            print(f"ERROR: {bad}")
            return 1
        try:
            return 0 if check(targets) else 1
        except GraphError as e:
            print(f"ERROR: {e}")
            return 1

    log = RunLog(run_id, args.trigger)
    log.start()
    if targets is None:
        status, files, error = "failed", [], bad
    else:
        try:
            status, files, error = mirror(targets, dry_run=args.dry_run)
        except Exception as e:   # outputs, sign-in: the run fails as a whole
            status, files, error = "failed", [], f"{type(e).__name__}: {_short(e)}"
    log.finish(status, files, error)
    print(f"Excel mirror{' (dry run)' if args.dry_run else ''}: {status}" + (f": {error}" if error else ""))
    if status == "partial":
        print("::warning::Excel mirror finished with errors on some files")
    return 1 if status == "failed" else 0


if __name__ == "__main__":
    sys.exit(main())
