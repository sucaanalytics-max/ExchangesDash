"""
Brokers mirror: clone Tusk's brokers-dashboard tables (sb_*) into this repo's
Supabase project (NSE-BSE), so broker and exchange data sit in one lake.

Source: abiyani-tools/brokersdashboard writes sb_* tables in its own Supabase
project (everjfpbnlbcpuarnhob) on weekdays at 14:17 UTC. We read them with
that project's publishable (read-only) key and never write there.

    python scripts/brokers_mirror.py --emit-ddl out.sql   # their sb_* table definitions as SQL, for review
    python scripts/brokers_mirror.py                      # copy what changed in every sb_* table on our side
    python scripts/brokers_mirror.py --full               # full resync: re-read and re-upsert every row

The copy covers exactly the sb_* tables created on our side from the reviewed
--emit-ddl output (brokers_mirror_schema.sql), with the same names, columns and
primary keys.

Run-keyed tables (primary key includes run_id: sb_calibration, sb_daily_revenue,
sb_summary_cells, sb_pat_lines, …) keep every engine run's rows, so they are
copied run by run. sb_runs (small) is read in full on both sides, and a
run-keyed table reads only the rows of
  - runs our sb_runs lacks, or whose sb_runs row differs from ours (e.g. it
    finished since the last copy);
  - each broker and mode's latest successful run, on their side and in our
    copy: the engine's PAT step upserts sb_pat_lines / sb_valuation_lines into
    that run after it has finished, and again on a later day while no newer
    run exists (run_pat.py there). Our latest is re-read too, so the run a
    new one replaces is checked once more.
Those rows are compared with our copy of the same runs and only new or changed
rows are upserted. Older runs are not read: the engine inserts a run's
calibration, daily and summary rows before marking it finished, and never
writes to a run once a newer one has succeeded. A run gone from their sb_runs
has its rows deleted here. Our sb_runs is written last and records which runs
are copied: when any run-keyed table fails, new or changed runs are left out
of it (and runs gone there stay), so the next run reads them again.

Other tables (sb_brokers, sb_calendar, sb_broker_daily, sb_share_prices) are
copied in full each run, as is every table with --full.

Deletes: rows whose key is gone from the source are deleted, but only when the
source returned rows and at most MAX_DELETE_SHARE of the copy (of a table, of
the runs read, or of sb_runs) would go, so an outage or a half-read cannot wipe
it. A table whose columns no longer match theirs is skipped with an error
(re-run --emit-ddl and apply the change); the others are still copied and the
run exits non-zero.

Environment:
  BROKERS_SUPABASE_URL   their project URL (default below)
  BROKERS_SUPABASE_KEY   their publishable key (GitHub secret)
  SUPABASE_URL           our project (NSE-BSE)        } mirror mode only
  SUPABASE_KEY           our service-role key         }
"""

import json
import os
import re
import sys
from datetime import datetime, timezone

SOURCE_DEFAULT_URL = "https://everjfpbnlbcpuarnhob.supabase.co"
PREFIX = "sb_"
PAGE = 1000               # PostgREST's default max rows per request
BATCH = 500               # rows per upsert request
MAX_DELETE_SHARE = 0.20   # larger deletions are refused (likely a bad read)
TIMEOUT = 60
RUNS = "sb_runs"          # the engine's run register; tables keyed on its run_id are copied run by run
RUN_CHUNK = 40            # run ids per run_id=in.(…) filter (keeps the URL short)


def auth_headers(key):
    """New-style keys (sb_publishable_…, sb_secret_…) go in apikey only;
    legacy JWT keys also as the bearer token."""
    h = {"apikey": key}
    if key.startswith("eyJ"):
        h["Authorization"] = f"Bearer {key}"
    return h


# ── Schema (PostgREST OpenAPI) ───────────────────────────────────────────────

def fetch_openapi(session, url, key):
    """The project's OpenAPI document (PostgREST, Swagger 2.0)."""
    r = session.get(f"{url}/rest/v1/", headers={**auth_headers(key), "Accept": "application/openapi+json"},
                    timeout=TIMEOUT)
    if r.status_code in (401, 403, 404):
        raise PermissionError(f"{url}: the API schema is not readable with this key (HTTP {r.status_code})")
    r.raise_for_status()
    return r.json()


def pg_type(prop):
    """Postgres column type from an OpenAPI property; enums and unknown types become text."""
    fmt = (prop.get("format") or "").strip()
    if prop.get("enum") is not None:
        return "text[]" if fmt.endswith("[]") else "text"
    return fmt or "text"


def table_specs(openapi, prefix=PREFIX):
    """{table: {"columns": [(name, type, not_null)], "pk": [names]}} for every
    `prefix` table in the document, in the document's column order."""
    specs = {}
    for name, d in (openapi.get("definitions") or {}).items():
        if not name.startswith(prefix):
            continue
        required = set(d.get("required") or [])
        props = d.get("properties") or {}
        cols = [(c, pg_type(p), c in required) for c, p in props.items()]
        pk = [c for c, p in props.items() if "<pk/>" in (p.get("description") or "")]
        specs[name] = {"columns": cols, "pk": pk}
    return dict(sorted(specs.items()))


def qident(name):
    return '"' + name.replace('"', '""') + '"'


def ddl(specs, source_url, generated_at):
    """CREATE TABLE statements for the copy: same names, columns and primary
    keys; RLS on with no policies (service role only). Tables without a primary
    key cannot be mirrored and are listed in a comment instead."""
    out = [
        "-- Clone of the brokers-dashboard sb_* tables (abiyani-tools/brokersdashboard),",
        f"-- source {source_url}, generated by scripts/brokers_mirror.py --emit-ddl at {generated_at}.",
        "-- Review, then apply to the NSE-BSE project; scripts/brokers_mirror.py fills them daily.",
        "-- RLS is on with no policies: only the service role reads or writes them.",
        "",
    ]
    skipped = [t for t, s in specs.items() if not s["pk"]]
    for table, spec in specs.items():
        if not spec["pk"]:
            continue
        lines = [f"  {qident(c)} {t}{' not null' if nn else ''}" for c, t, nn in spec["columns"]]
        lines.append(f"  primary key ({', '.join(qident(c) for c in spec['pk'])})")
        out.append(f"create table if not exists public.{qident(table)} (\n" + ",\n".join(lines) + "\n);")
        out.append(f"alter table public.{qident(table)} enable row level security;")
        out.append(f"comment on table public.{qident(table)} is "
                   f"'Copy of brokers-dashboard {table} (scripts/brokers_mirror.py); not edited by hand.';")
        out.append("")
    if skipped:
        out.append("-- Not mirrored (no primary key, e.g. views): " + ", ".join(skipped))
    return "\n".join(out) + "\n"


# ── Rows ─────────────────────────────────────────────────────────────────────

def fetch_rows(session, url, key, table, order, select="*", filters=None):
    """Every row of `table` (matching the PostgREST `filters`, if any), paged
    and ordered by `order` (the primary key)."""
    rows, offset = [], 0
    while True:
        r = session.get(f"{url}/rest/v1/{table}",
                        params={**(filters or {}), "select": select,
                                "order": ",".join(f"{c}.asc" for c in order), "limit": PAGE, "offset": offset},
                        headers=auth_headers(key), timeout=TIMEOUT)
        r.raise_for_status()
        page = r.json()
        rows.extend(page)
        if len(page) < PAGE:
            return rows
        offset += PAGE


def fetch_run_rows(session, url, key, table, order, run_ids):
    """Every row of `table` whose run_id is one of `run_ids`."""
    ids, rows = sorted(run_ids), []
    for i in range(0, len(ids), RUN_CHUNK):
        rows += fetch_rows(session, url, key, table, order,
                           filters={"run_id": "in.(" + ",".join(pg_literal(v) for v in ids[i:i + RUN_CHUNK]) + ")"})
    return rows


def upsert(session, url, key, table, rows, pk):
    for i in range(0, len(rows), BATCH):
        r = session.post(f"{url}/rest/v1/{table}", params={"on_conflict": ",".join(pk)},
                         data=json.dumps(rows[i:i + BATCH]),
                         headers={**auth_headers(key), "Content-Type": "application/json",
                                  "Prefer": "resolution=merge-duplicates,return=minimal"},
                         timeout=TIMEOUT)
        r.raise_for_status()


def pg_text(v):
    """A value as PostgREST filter text (booleans lower-case, JSON as JSON)."""
    return json.dumps(v) if isinstance(v, (dict, list)) else str(v).lower() if isinstance(v, bool) else str(v)


def pg_literal(v):
    """A value inside a PostgREST in.(…) list, quoted."""
    return '"' + pg_text(v).replace("\\", "\\\\").replace('"', '\\"') + '"'


def delete_keys(session, url, key, table, pk, keys):
    """Delete rows by primary key: `in` lists for a one-column key, one
    request per row otherwise. With pk ["run_id"] on a run-keyed table, every
    row of those runs goes."""
    headers = {**auth_headers(key), "Prefer": "return=minimal"}
    if len(pk) == 1:
        vals = [k[0] for k in keys]
        for i in range(0, len(vals), 100):
            r = session.delete(f"{url}/rest/v1/{table}",
                               params={pk[0]: "in.(" + ",".join(pg_literal(v) for v in vals[i:i + 100]) + ")"},
                               headers=headers, timeout=TIMEOUT)
            r.raise_for_status()
        return
    for k in keys:
        r = session.delete(f"{url}/rest/v1/{table}", params={c: f"eq.{pg_text(v)}" for c, v in zip(pk, k)},
                           headers=headers, timeout=TIMEOUT)
        r.raise_for_status()


def row_key(row, pk):
    return tuple(row.get(c) for c in pk)


ISO_PARTS = re.compile(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$")


def parse_timestamp(text):
    """An ISO 8601 timestamp as PostgREST writes it ('…Z', '…+00:00', '…+05',
    1 to 6 fractional digits) as a UTC datetime; None if it is not one. Python
    3.10's datetime.fromisoformat takes only 0, 3 or 6 fractional digits and no
    'Z', so the text is normalised first and the result is the same on every
    Python."""
    m = ISO_PARTS.match(text.strip())
    if not m:
        return None
    base, frac, tz = m.groups()
    tz = "+00:00" if tz in (None, "Z") else tz if ":" in tz else (tz + ":00" if len(tz) == 3 else tz[:3] + ":" + tz[3:])
    try:
        d = datetime.fromisoformat(base.replace(" ", "T") + (f".{(frac + '000000')[:6]}" if frac else "") + tz)
    except ValueError:
        return None
    return d.astimezone(timezone.utc)


def canon(value, pg):
    """A value as compared between the two projects: timestamps as instants, so
    '…Z' and '…+00:00' (or another session time zone) read the same. A
    timestamp without a zone is taken as UTC, on both sides alike."""
    if isinstance(value, str) and pg.startswith("timestamp"):
        d = parse_timestamp(value)
        return value if d is None else d
    return value


def same_row(a, b, types):
    """True when our row `b` already holds their row `a` (`types`: column → Postgres type)."""
    return (b is not None and a.keys() == b.keys()
            and all(canon(a[c], types.get(c, "")) == canon(b[c], types.get(c, "")) for c in a))


def column_error(rows, cols):
    """The 'columns differ' note when their rows' columns are not ours, else None."""
    if not rows:
        return None
    theirs, ours = set().union(*(r.keys() for r in rows)), set(cols)
    if theirs == ours:
        return None
    extra, missing = sorted(theirs - ours), sorted(ours - theirs)
    return "columns differ: " + "; ".join(p for p in (f"new on their side {extra}" if extra else "",
                                                      f"gone on their side {missing}" if missing else "") if p)


def plan_deletes(source_keys, target_keys, max_share=MAX_DELETE_SHARE, unit="row"):
    """(keys to delete, reason they were not deleted or None)."""
    gone = sorted(set(target_keys) - set(source_keys), key=repr)
    if not gone:
        return [], None
    if not source_keys:
        return [], f"source returned no {unit}s; {len(gone)} {unit}(s) kept"
    if len(gone) > max_share * len(target_keys):
        return [], f"{len(gone)} of {len(target_keys)} {unit}s would go (over {max_share:.0%}); kept"
    return gone, None


def result(table, copied="all rows", **kw):
    return {"table": table, "copied": copied, "source": 0, "upserted": 0, "deleted": 0, "status": "ok", "note": "",
            **kw}


def is_run_keyed(table, spec):
    """A table holding rows per engine run: run_id is part of its primary key."""
    return table != RUNS and "run_id" in spec["pk"]


# ── Full copy (tables without run_id, sb_* with --full) ──────────────────────

def mirror_table(session, src, dst, table, spec):
    """Copy every row of one table. Returns a result dict for the summary."""
    cols, pk = [c for c, _, _ in spec["columns"]], spec["pk"]
    res = result(table)
    if not pk:
        res.update(status="skipped", note="no primary key on our side")
        return res
    rows = fetch_rows(session, *src, table, pk)
    res["source"] = len(rows)
    err = column_error(rows, cols)
    if err:
        res.update(status="error", note=err)
        return res
    upsert(session, *dst, table, rows, pk)
    res["upserted"] = len(rows)
    target_keys = [row_key(r, pk) for r in fetch_rows(session, *dst, table, pk, select=",".join(pk))]
    gone, reason = plan_deletes([row_key(r, pk) for r in rows], target_keys)
    if reason:
        res.update(status="warning", note=reason)
    if gone:
        delete_keys(session, *dst, table, pk, gone)
        res["deleted"] = len(gone)
    return res


# ── Run by run (tables keyed on run_id) ──────────────────────────────────────

def latest_runs(rows):
    """Each (broker_id, mode)'s latest successful run (by started_at): the run the
    engine's PAT and valuation steps write to after it has finished."""
    best = {}
    for r in rows:
        started = canon(r.get("started_at"), "timestamp with time zone")
        if r.get("status") != "success" or not isinstance(started, datetime):
            continue
        k = (r.get("broker_id"), r.get("mode"))
        if k not in best or started > best[k][0]:
            best[k] = (started, r["run_id"])
    return {run_id for _, run_id in best.values()}


def plan_runs(theirs, ours, types, full=False):
    """Which runs the run-keyed tables read, from their sb_runs and our copy of it.

    new: runs our copy lacks; changed: runs whose row differs from ours (a run
    that finished, failed or was edited); recheck: the other latest successful
    runs per broker and mode, theirs and ours (late writes); gone: runs to
    delete here (gone from theirs, within the delete guard). With full, every
    run of theirs is read."""
    t = {r["run_id"]: r for r in theirs}
    o = {r["run_id"]: r for r in ours}
    new = set(t) - set(o)
    changed = {k for k in set(t) & set(o) if not same_row(t[k], o[k], types)}
    recheck = ((latest_runs(theirs) | latest_runs(ours)) & set(t)) - new - changed
    gone, gone_note = plan_deletes([(k,) for k in t], [(k,) for k in set(t) | set(o)], unit="run")
    if gone_note:
        gone_note = "runs gone from theirs: " + gone_note
    return {"theirs": theirs, "new": new, "changed": changed, "recheck": recheck,
            "read": set(t) if full else new | changed | recheck,
            "gone": [g[0] for g in gone], "gone_note": gone_note}


def mirror_run_table(session, src, dst, table, spec, plan):
    """Copy the rows of the runs the plan reads into one run-keyed table: only
    rows that are new or differ from ours are upserted. Rows of runs gone from
    their sb_runs are deleted, as are rows of the runs read that are gone from
    theirs (guarded)."""
    cols, pk = [c for c, _, _ in spec["columns"]], spec["pk"]
    types = {c: t for c, t, _ in spec["columns"]}
    read, gone_runs = plan["read"], set(plan["gone"])
    res = result(table, copied=f"{len(read):,} of {len(plan['theirs']):,} runs")
    if not read and not gone_runs:
        res["note"] = "no new or changed runs"
        return res
    rows = fetch_run_rows(session, *src, table, pk, read) if read else []
    res["source"] = len(rows)
    err = column_error(rows, cols)
    if err:
        res.update(status="error", note=err)
        return res
    mine = {row_key(r, pk): r for r in fetch_run_rows(session, *dst, table, pk, read | gone_runs)}
    todo = [r for r in rows if not same_row(r, mine.get(row_key(r, pk)), types)]
    upsert(session, *dst, table, todo, pk)
    res["upserted"] = len(todo)

    # rows of the runs read that are gone from theirs, guarded like a full copy
    source_keys = {row_key(r, pk) for r in rows}
    in_read = [k for k, r in mine.items() if r.get("run_id") in read]
    gone, reason = plan_deletes(list(source_keys), list(source_keys | set(in_read)))
    if reason:
        res.update(status="warning", note=f"rows gone from runs read: {reason}")
    if gone:
        delete_keys(session, *dst, table, pk, gone)
    # every row of runs gone from their sb_runs (the run-level guard is in plan_runs)
    gone_rows = sum(1 for r in mine.values() if r.get("run_id") in gone_runs)
    if gone_rows:
        delete_keys(session, *dst, table, ["run_id"], [(g,) for g in sorted(gone_runs)])
    res["deleted"] = len(gone) + gone_rows
    return res


def mirror_runs(session, dst, spec, plan, hold):
    """Copy sb_runs from the snapshot the plan was made from, after the
    run-keyed tables. With hold (a run-keyed table failed), new and changed
    runs are left out and runs gone from theirs are kept, so the next run reads
    them again."""
    cols, pk = [c for c, _, _ in spec["columns"]], spec["pk"]
    rows = plan["theirs"]
    res = result(RUNS, source=len(rows))
    err = column_error(rows, cols)
    if err:
        res.update(status="error", note=err)
        return res
    held = (plan["new"] | plan["changed"]) if hold else set()
    todo = [r for r in rows if r["run_id"] not in held]
    upsert(session, *dst, RUNS, todo, pk)
    res["upserted"] = len(todo)
    notes = []
    if held:
        notes.append(f"{len(held):,} new or changed run(s) not recorded until every run-keyed table has copied them")
    if plan["gone_note"]:
        res["status"] = "warning"
        notes.append(plan["gone_note"])
    if plan["gone"] and hold:
        notes.append(f"{len(plan['gone']):,} run(s) gone from theirs kept until every run-keyed table has dropped them")
    elif plan["gone"]:
        delete_keys(session, *dst, RUNS, pk, [(g,) for g in plan["gone"]])
        res["deleted"] = len(plan["gone"])
    res["note"] = "; ".join(notes)
    return res


def mirror(session, src, dst, source_tables=None, full=False):
    """Copy every sb_* table that exists on our side: run-keyed tables run by
    run (every row with full), the others in full, sb_runs last. Returns
    (results, notes)."""
    ours = table_specs(fetch_openapi(session, *dst))
    notes = []
    if source_tables is not None:
        new = sorted(set(source_tables) - set(ours))
        if new:
            notes.append(f"their tables not copied yet (re-run --emit-ddl and apply): {', '.join(new)}")
    runs_spec = ours.get(RUNS) if (ours.get(RUNS) or {}).get("pk") == ["run_id"] else None
    keyed = {t for t, s in ours.items() if runs_spec and is_run_keyed(t, s)}
    plan, plan_error = None, None
    if runs_spec:
        try:
            plan = plan_runs(fetch_rows(session, *src, RUNS, ["run_id"]), fetch_rows(session, *dst, RUNS, ["run_id"]),
                             {c: t for c, t, _ in runs_spec["columns"]}, full=full)
        except Exception as e:   # without the run register no run-keyed table can be planned
            plan_error = f"{RUNS} could not be read: {type(e).__name__}: {e}"

    results, keyed_failed = [], False
    for table in [t for t in ours if t != RUNS] + ([RUNS] if runs_spec else []):
        spec = ours[table]
        try:
            if table == RUNS:
                res = mirror_runs(session, dst, spec, plan, hold=keyed_failed) if plan else None
            elif table in keyed and not full:
                res = mirror_run_table(session, src, dst, table, spec, plan) if plan else None
            else:
                res = mirror_table(session, src, dst, table, spec)
            if res is None:
                res = result(table, copied="", status="error", note=plan_error)
        except Exception as e:   # one table failing must not stop the others
            res = result(table, copied="", status="error", note=f"{type(e).__name__}: {e}")
        keyed_failed |= table in keyed and res["status"] == "error"
        results.append(res)
    if plan:
        notes.append(f"Runs: {len(plan['theirs']):,} on their side; "
                     + (f"every row read (--full); {len(plan['new']):,} new, {len(plan['changed']):,} changed"
                        if full else
                        f"read {len(plan['read']):,}: {len(plan['new']):,} new, {len(plan['changed']):,} changed, "
                        f"{len(plan['recheck']):,} rechecked (each broker and mode's latest successful run, "
                        "which the engine's PAT step writes to after it finishes)")
                     + f"; {len(plan['gone']):,} gone")
    return results, notes


def summary_markdown(results, notes):
    lines = ["### Brokers mirror", "",
             "| Table | Copied | Their rows read | Upserted | Deleted | Status | Note |",
             "|---|---|---:|---:|---:|---|---|"]
    lines += [f"| {r['table']} | {r['copied']} | {r['source']:,} | {r['upserted']:,} | {r['deleted']:,} "
              f"| {r['status']} | {r['note']} |" for r in results]
    if not results:
        lines.append("| (no sb_* tables on our side yet: apply brokers_mirror_schema.sql) | | | | | | |")
    return "\n".join(lines + [""] + [f"- {n}" for n in notes]) + "\n"


USAGE = "usage: brokers_mirror.py [--full | --emit-ddl [PATH]]"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv not in ([], ["--full"]) and argv[:1] != ["--emit-ddl"]:
        print(USAGE)
        return 2
    import requests
    src = ((os.environ.get("BROKERS_SUPABASE_URL") or SOURCE_DEFAULT_URL).rstrip("/"),
           os.environ.get("BROKERS_SUPABASE_KEY", ""))
    if not src[1]:
        print("ERROR: BROKERS_SUPABASE_KEY is not set (their publishable key, a GitHub secret).")
        return 1
    session = requests.Session()

    if argv[:1] == ["--emit-ddl"]:
        path = argv[1] if len(argv) > 1 else "brokers_mirror_schema.sql"
        try:
            specs = table_specs(fetch_openapi(session, *src))
        except PermissionError as e:
            print(f"ERROR: {e}. Ask Abhishek for the definitions instead:\n"
                  "  pg_dump --schema-only --table='public.sb_*' <their database URL>")
            return 1
        sql = ddl(specs, src[0], datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(sql)
        print(f"Wrote {path}: {len(specs)} sb_* table(s): {', '.join(specs)}")
        return 0

    dst = (os.environ.get("SUPABASE_URL", "").rstrip("/"), os.environ.get("SUPABASE_KEY", ""))
    if not all(dst):
        print("ERROR: SUPABASE_URL / SUPABASE_KEY (our project, service role) are not set.")
        return 1
    try:
        source_tables = list(table_specs(fetch_openapi(session, *src)))
    except Exception as e:   # their schema listing is optional in mirror mode
        print(f"NOTE: could not list their tables ({e}); copying the tables we have")
        source_tables = None
    results, notes = mirror(session, src, dst, source_tables, full=argv == ["--full"])
    report = summary_markdown(results, notes)
    print(report)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(report)
    for r in results:
        if r["status"] in ("error", "warning"):
            kind = "error" if r["status"] == "error" else "warning"
            print(f"::{kind} title=Brokers mirror {r['table']}::{r['note']}")
    return 1 if any(r["status"] == "error" for r in results) else 0


if __name__ == "__main__":
    sys.exit(main())
