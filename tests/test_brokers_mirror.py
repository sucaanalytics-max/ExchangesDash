"""scripts/brokers_mirror.py against an in-memory fake of two Supabase REST
APIs (theirs: read only; ours: service role)."""

import contextlib
import copy
import io
import json
import unittest
from unittest import mock

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import brokers_mirror as bm

SRC = ("https://theirs.supabase.co", "sb_publishable_x")
DST = ("https://ours.supabase.co", "eyJservice")


def prop(fmt, pk=False, **kw):
    return dict({"format": fmt, "type": "string", **({"description": "Note:\nThis is a Primary Key.<pk/>"} if pk else {})},
                **kw)


def openapi(tables):
    return {"swagger": "2.0", "definitions": tables}


RUNS = {"required": ["run_id", "broker_id", "mode", "status", "started_at"], "properties": {
    "run_id": prop("uuid", pk=True), "broker_id": prop("text"), "mode": prop("run_mode", enum=["parity", "live"]),
    "as_of": prop("date"), "started_at": prop("timestamp with time zone"),
    "finished_at": prop("timestamp with time zone"), "status": prop("text"), "notes": prop("jsonb")}}
DAILY = {"required": ["run_id", "trade_date", "segment"], "properties": {
    "run_id": prop("uuid", pk=True), "trade_date": prop("date", pk=True), "segment": prop("text", pk=True),
    "revenue_cr": prop("numeric")}}
PAT = {"required": ["run_id", "period_key", "line", "scenario", "value"], "properties": {
    "run_id": prop("uuid", pk=True), "period_key": prop("text", pk=True), "line": prop("text", pk=True),
    "scenario": prop("text", pk=True), "value": prop("numeric")}}
BROKERS = {"required": ["broker_id", "name"], "properties": {"broker_id": prop("text", pk=True), "name": prop("text")}}


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


PAGING = ("select", "order", "limit", "offset")


def matches(row, filters):
    """PostgREST eq. / in.(…) filters, as the mirror sends them."""
    for c, f in filters.items():
        op, val = f.split(".", 1)
        if op == "eq" and str(row[c]) != val:
            return False
        if op == "in" and json.dumps(str(row[c])) not in val[1:-1].split(","):
            return False
    return True


class FakeSupabase:
    """Just enough PostgREST: OpenAPI, filtered ordered paging, upsert on a key, delete by eq / in."""

    def __init__(self, base, specs, data, openapi_status=200):
        self.base, self.specs, self.data, self.openapi_status = base, specs, data, openapi_status
        self.calls = []

    def owns(self, url):
        return url.startswith(self.base)

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("GET", url, params))
        path = url[len(self.base):]
        if path == "/rest/v1/":
            return Resp(self.openapi_status, openapi(self.specs) if self.openapi_status == 200 else None)
        table = path.split("/")[-1]
        order = [o.split(".")[0] for o in params["order"].split(",")]
        filters = {k: v for k, v in params.items() if k not in PAGING}
        rows = sorted((r for r in self.data.get(table, []) if matches(r, filters)),
                      key=lambda r: tuple(str(r[c]) for c in order))
        if params["select"] != "*":
            keep = params["select"].split(",")
            rows = [{c: r[c] for c in keep} for r in rows]
        return Resp(200, copy.deepcopy(rows[params["offset"]:params["offset"] + params["limit"]]))

    def post(self, url, params=None, data=None, headers=None, timeout=None):
        table, pk = url.split("/")[-1], params["on_conflict"].split(",")
        new_rows = json.loads(data)
        self.calls.append(("POST", url, params, len(new_rows)))
        rows = self.data.setdefault(table, [])
        index = {tuple(r[c] for c in pk): i for i, r in enumerate(rows)}
        for new in new_rows:
            key = tuple(new[c] for c in pk)
            if key in index:
                rows[index[key]] = new
            else:
                index[key] = len(rows)
                rows.append(new)
        return Resp(201)

    def delete(self, url, params=None, headers=None, timeout=None):
        self.calls.append(("DELETE", url, params))
        table = url.split("/")[-1]
        self.data[table] = [r for r in self.data.get(table, []) if not matches(r, params)]
        return Resp(204)


class Session:
    """Routes each request to the fake project its URL belongs to."""

    def __init__(self, *projects):
        self.projects = projects

    def _for(self, url):
        return next(p for p in self.projects if p.owns(url))

    def get(self, url, **kw):
        return self._for(url).get(url, **kw)

    def post(self, url, **kw):
        return self._for(url).post(url, **kw)

    def delete(self, url, **kw):
        return self._for(url).delete(url, **kw)


def run(run_id, broker="ANGELONE", day=1, status="success", mode="live"):
    return {"run_id": run_id, "broker_id": broker, "mode": mode, "as_of": f"2026-11-{day:02d}",
            "started_at": f"2026-11-{day:02d}T14:30:00+00:00",
            "finished_at": None if status == "running" else f"2026-11-{day:02d}T14:41:07.25+00:00",
            "status": status, "notes": {"day": day}}


def runs(n, start=0):
    return [dict(run(f"r{i:04d}", day=1 + i % 28), started_at=f"2026-10-01T00:00:{i % 60:02d}+00:00")
            for i in range(start, start + n)]


def daily(run_id, days=4, value=1.0):
    return [{"run_id": run_id, "trade_date": f"2026-10-{d:02d}", "segment": s, "revenue_cr": value}
            for d in range(1, days + 1) for s in ("fo", "cash", "mtf_gross")]


def pat(run_id, value=10.0):
    return [{"run_id": run_id, "period_key": q, "line": ln, "scenario": sc, "value": value}
            for q in ("FY 2027", "FY 2028") for ln in ("pat", "eps") for sc in ("bear", "base")]


class Schema(unittest.TestCase):
    def test_specs_types_and_keys(self):
        specs = bm.table_specs(openapi({"sb_runs": RUNS, "sb_daily_revenue": DAILY, "broker_reports": RUNS}))
        self.assertEqual(list(specs), ["sb_daily_revenue", "sb_runs"])          # only sb_*
        self.assertEqual(specs["sb_daily_revenue"]["pk"], ["run_id", "trade_date", "segment"])
        self.assertIn(("mode", "text", True), specs["sb_runs"]["columns"])       # enum → text
        self.assertIn(("run_id", "uuid", True), specs["sb_runs"]["columns"])

    def test_ddl(self):
        specs = bm.table_specs(openapi({"sb_runs": RUNS, "sb_view": {"properties": {"x": prop("text")}}}))
        sql = bm.ddl(specs, SRC[0], "2026-11-02 05:00 UTC")
        self.assertIn('create table if not exists public."sb_runs" (', sql)
        self.assertIn('"run_id" uuid not null', sql)
        self.assertIn('"notes" jsonb,', sql)
        self.assertIn('primary key ("run_id")', sql)
        self.assertIn('alter table public."sb_runs" enable row level security;', sql)
        self.assertIn("Not mirrored (no primary key, e.g. views): sb_view", sql)
        self.assertNotIn('create table if not exists public."sb_view"', sql)

    def test_key_headers(self):
        self.assertEqual(bm.auth_headers("sb_publishable_x"), {"apikey": "sb_publishable_x"})
        self.assertEqual(bm.auth_headers("eyJabc")["Authorization"], "Bearer eyJabc")


class DeleteGuard(unittest.TestCase):
    def test_plan(self):
        keys = [(i,) for i in range(10)]
        self.assertEqual(bm.plan_deletes(keys[:9], keys), ([(9,)], None))
        self.assertEqual(bm.plan_deletes(keys, keys), ([], None))
        gone, why = bm.plan_deletes([], keys)
        self.assertEqual(gone, [])
        self.assertIn("no rows", why)
        gone, why = bm.plan_deletes(keys[:5], keys)
        self.assertEqual(gone, [])
        self.assertIn("over 20%", why)


class FullMirror(unittest.TestCase):
    """--full: every table is read and upserted whole, as before the run-by-run copy."""

    def setUp(self):
        self.theirs = FakeSupabase(SRC[0], {"sb_runs": RUNS, "sb_daily_revenue": DAILY, "sb_new": RUNS},
                                   {"sb_runs": runs(2500),
                                    "sb_daily_revenue": [{"run_id": "r1", "trade_date": "2026-10-30", "segment": s,
                                                          "revenue_cr": 1.5} for s in ("fo", "cash", "mtf")]})
        self.ours = FakeSupabase(DST[0], {"sb_runs": RUNS, "sb_daily_revenue": DAILY},
                                 {"sb_runs": runs(5, start=2500) + runs(10)})
        self.session = Session(self.theirs, self.ours)

    def run_mirror(self):
        return bm.mirror(self.session, SRC, DST, source_tables=["sb_runs", "sb_daily_revenue", "sb_new"], full=True)

    def test_copies_pages_and_deletes_vanished_rows(self):
        results, notes = self.run_mirror()
        by = {r["table"]: r for r in results}
        self.assertEqual(by["sb_runs"]["source"], 2500)                       # three pages read
        self.assertEqual(len(self.ours.data["sb_runs"]), 2500)                 # the 5 extra rows deleted
        self.assertEqual(by["sb_runs"]["deleted"], 5)
        self.assertEqual(sorted(r["segment"] for r in self.ours.data["sb_daily_revenue"]), ["cash", "fo", "mtf"])
        self.assertTrue(all(r["status"] == "ok" for r in results))
        self.assertIn("sb_new", notes[0])                                      # their new table is reported
        upserts = [c for c in self.ours.calls if c[0] == "POST" and c[1].endswith("sb_runs")]
        self.assertEqual(len(upserts), 5)                                      # 2500 rows in batches of 500
        self.assertEqual(upserts[0][2], {"on_conflict": "run_id"})

    def test_composite_key_delete(self):
        self.ours.data["sb_daily_revenue"] = [{"run_id": "r1", "trade_date": "2026-10-30", "segment": s,
                                               "revenue_cr": 0} for s in ("fo", "cash", "mtf", "old")]
        self.theirs.data["sb_daily_revenue"] += [{"run_id": "r2", "trade_date": "2026-10-31", "segment": s,
                                                  "revenue_cr": 1} for s in ("fo", "cash")]
        self.run_mirror()
        segs = sorted((r["run_id"], r["segment"], r["revenue_cr"]) for r in self.ours.data["sb_daily_revenue"])
        self.assertNotIn("old", [s for _, s, _ in segs])
        self.assertIn(("r1", "fo", 1.5), segs)                                 # updated from theirs

    def test_schema_change_skips_only_that_table(self):
        for r in self.theirs.data["sb_daily_revenue"]:
            r["orders_mn"] = 2.0
        results, _ = self.run_mirror()
        by = {r["table"]: r for r in results}
        self.assertEqual(by["sb_daily_revenue"]["status"], "error")
        self.assertIn("new on their side ['orders_mn']", by["sb_daily_revenue"]["note"])
        self.assertEqual(by["sb_runs"]["status"], "ok")
        self.assertNotIn("sb_daily_revenue", self.ours.data)                  # nothing written for it

    def test_empty_source_keeps_the_copy(self):
        self.theirs.data["sb_runs"] = []
        results, _ = self.run_mirror()
        by = {r["table"]: r for r in results}
        self.assertEqual(by["sb_runs"]["status"], "warning")
        self.assertEqual(len(self.ours.data["sb_runs"]), 15)

    def test_failing_table_does_not_stop_the_rest(self):
        orig = self.theirs.get

        def flaky(url, **kw):
            if url.endswith("/sb_daily_revenue"):
                return Resp(500)
            return orig(url, **kw)
        self.theirs.get = flaky
        results, _ = self.run_mirror()
        by = {r["table"]: r for r in results}
        self.assertEqual(by["sb_daily_revenue"]["status"], "error")
        self.assertEqual(by["sb_runs"]["status"], "ok")

    def test_summary(self):
        results, notes = self.run_mirror()
        md = bm.summary_markdown(results, notes)
        self.assertIn("| sb_runs | all rows | 2,500 | 2,500 | 5 | ok |", md)
        self.assertIn("apply brokers_mirror_schema.sql", bm.summary_markdown([], []))



SPECS = {"sb_brokers": BROKERS, "sb_daily_revenue": DAILY, "sb_pat_lines": PAT, "sb_runs": RUNS}


class IncrementalMirror(unittest.TestCase):
    """The default copy: run-keyed tables read new, changed and latest runs only."""

    def setUp(self):
        # Angel One live runs on 1…8 Nov, Groww's latest, an old parity run; PAT lines on each live broker's latest
        their_runs = [run(f"a{d}", day=d) for d in range(1, 9)] + [run("g8", "GROWW", day=8),
                                                                   run("p1", mode="parity", day=1)]
        data = {"sb_brokers": [{"broker_id": "ANGELONE", "name": "Angel One"}, {"broker_id": "GROWW", "name": "Groww"}],
                "sb_runs": their_runs,
                "sb_daily_revenue": [row for r in their_runs for row in daily(r["run_id"])],
                "sb_pat_lines": pat("a7") + pat("a8") + pat("g8")}
        self.theirs = FakeSupabase(SRC[0], SPECS, data)
        self.ours = FakeSupabase(DST[0], SPECS, copy.deepcopy(data))     # in step with theirs
        self.session = Session(self.theirs, self.ours)

    def run_mirror(self, full=False):
        self.theirs.calls.clear()
        self.ours.calls.clear()
        results, notes = bm.mirror(self.session, SRC, DST, full=full)
        return {r["table"]: r for r in results}, notes

    def upserted(self, table):
        return sum(c[3] for c in self.ours.calls if c[0] == "POST" and c[1].endswith("/" + table))

    def runs_read(self, table, project=None):
        """Run ids the mirror asked `project` (theirs) for in `table`; None for an unfiltered read."""
        ids = set()
        for c in (project or self.theirs).calls:
            if c[0] == "GET" and c[1].endswith("/" + table):
                if "run_id" not in c[2]:
                    return None
                ids |= {v.strip('"') for v in c[2]["run_id"][4:-1].split(",")}
        return ids

    def rows(self, project, table, run_id=None):
        return sorted((r for r in project.data.get(table, []) if run_id is None or r["run_id"] == run_id),
                      key=lambda r: json.dumps(r, sort_keys=True))

    def assert_in_step(self):
        for table in SPECS:
            self.assertEqual(self.rows(self.ours, table), self.rows(self.theirs, table), table)

    def test_nothing_new_upserts_only_sb_runs_and_full_tables(self):
        by, notes = self.run_mirror()
        written = {c[1].split("/")[-1] for c in self.ours.calls if c[0] == "POST"}
        self.assertEqual(written, {"sb_brokers", "sb_runs"})
        self.assertFalse([c for c in self.ours.calls if c[0] == "DELETE"])
        # only each broker and mode's latest successful run is read again
        self.assertEqual(self.runs_read("sb_daily_revenue"), {"a8", "g8", "p1"})
        self.assertEqual(self.runs_read("sb_pat_lines"), {"a8", "g8", "p1"})
        self.assertEqual(by["sb_daily_revenue"]["copied"], "3 of 10 runs")
        self.assertEqual((by["sb_daily_revenue"]["upserted"], by["sb_pat_lines"]["upserted"]), (0, 0))
        self.assertTrue(all(r["status"] == "ok" for r in by.values()))
        self.assertIn("read 3: 0 new, 0 changed, 3 rechecked", notes[-1])
        self.assert_in_step()

    def test_new_run_copies_only_its_rows(self):
        self.theirs.data["sb_runs"].append(run("a9", day=9))
        self.theirs.data["sb_daily_revenue"] += daily("a9", days=5)
        self.theirs.data["sb_pat_lines"] += pat("a9")
        with mock.patch.object(bm, "RUN_CHUNK", 1):                         # one run per in.(…) filter
            by, _ = self.run_mirror()
        self.assertEqual(self.upserted("sb_daily_revenue"), 15)               # a9's rows, nothing else
        self.assertEqual(self.upserted("sb_pat_lines"), 8)
        self.assertEqual(by["sb_daily_revenue"]["upserted"], 15)
        # a8 is read once more (our latest until a9 is recorded); a1…a7 are not
        self.assertEqual(self.runs_read("sb_daily_revenue"), {"a9", "a8", "g8", "p1"})
        self.assertIn("a9", {r["run_id"] for r in self.ours.data["sb_runs"]})
        self.assert_in_step()
        # and the next run reads only the latest runs again
        self.run_mirror()
        self.assertEqual(self.runs_read("sb_daily_revenue"), {"a9", "g8", "p1"})
        self.assertEqual(self.upserted("sb_daily_revenue"), 0)

    def test_pat_rewritten_on_the_latest_run_is_copied(self):
        # their PAT step ran again on a8 (no newer run): new values and a new line
        self.theirs.data["sb_pat_lines"][8]["value"] = 11.5
        self.theirs.data["sb_pat_lines"].append({"run_id": "a8", "period_key": "FY 2028", "line": "target",
                                                 "scenario": "base", "value": 310.9})
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_pat_lines"]["upserted"], 2)
        self.assertEqual(self.upserted("sb_daily_revenue"), 0)
        self.assert_in_step()

    def test_late_rows_on_a_replaced_run_are_still_copied(self):
        # PAT lines for a8 landed after our last copy, and a9 was published before this one
        self.ours.data["sb_pat_lines"] = [r for r in self.ours.data["sb_pat_lines"] if r["run_id"] != "a8"]
        self.theirs.data["sb_runs"].append(run("a9", day=9))
        self.theirs.data["sb_daily_revenue"] += daily("a9")
        self.run_mirror()
        self.assert_in_step()

    def test_run_that_finished_is_copied_again(self):
        # our last copy caught a9 while it was still being written
        self.theirs.data["sb_runs"].append(run("a9", day=9))
        self.theirs.data["sb_daily_revenue"] += daily("a9")
        self.ours.data["sb_runs"].append(run("a9", day=9, status="running"))
        self.ours.data["sb_daily_revenue"] += daily("a9")[:5]
        by, notes = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["upserted"], 7)
        self.assertIn("0 new, 1 changed", notes[-1])
        self.assert_in_step()

    def test_timestamp_format_is_not_a_change(self):
        for r in self.ours.data["sb_runs"]:
            r["started_at"] = r["started_at"].replace("+00:00", "Z")
            r["finished_at"] = r["finished_at"].replace("14:41:07.25+00:00", "20:11:07.250+05:30")
        _, notes = self.run_mirror()
        self.assertIn("0 new, 0 changed, 3 rechecked", notes[-1])

    def test_run_gone_from_theirs_is_deleted_everywhere(self):
        self.theirs.data["sb_runs"] = [r for r in self.theirs.data["sb_runs"] if r["run_id"] != "a2"]
        self.theirs.data["sb_daily_revenue"] = [r for r in self.theirs.data["sb_daily_revenue"] if r["run_id"] != "a2"]
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["deleted"], 12)
        self.assertEqual(by["sb_runs"]["deleted"], 1)
        self.assertEqual(self.runs_read("sb_daily_revenue"), {"a8", "g8", "p1"})   # a2's rows are not read there
        self.assert_in_step()

    def test_many_runs_gone_are_kept(self):
        gone = {"a1", "a2", "a3"}                                            # 3 of 10 runs: over 20%
        self.theirs.data["sb_runs"] = [r for r in self.theirs.data["sb_runs"] if r["run_id"] not in gone]
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_runs"]["status"], "warning")
        self.assertIn("3 of 10 runs would go", by["sb_runs"]["note"])
        self.assertEqual(len(self.ours.data["sb_runs"]), 10)
        self.assertEqual(len(self.ours.data["sb_daily_revenue"]), 120)

    def test_rows_gone_from_a_run_read_are_deleted(self):
        self.ours.data["sb_daily_revenue"].append({"run_id": "a8", "trade_date": "2026-10-31", "segment": "fo",
                                                   "revenue_cr": 9.0})
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["deleted"], 1)
        self.assert_in_step()

    def test_failed_table_holds_the_run_back_until_it_copies(self):
        self.theirs.data["sb_runs"].append(run("a9", day=9))
        self.theirs.data["sb_daily_revenue"] += [dict(r, orders_mn=1.0) for r in daily("a9")]
        self.theirs.data["sb_pat_lines"] += pat("a9")
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["status"], "error")
        self.assertEqual(by["sb_pat_lines"]["upserted"], 8)                    # the other tables still copy
        self.assertNotIn("a9", {r["run_id"] for r in self.ours.data["sb_runs"]})
        self.assertIn("1 new or changed run(s) not recorded", by["sb_runs"]["note"])
        # their column goes again (or ours is added): the next run picks a9 up
        for r in self.theirs.data["sb_daily_revenue"]:
            r.pop("orders_mn", None)
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["upserted"], 12)
        self.assertEqual(by["sb_pat_lines"]["upserted"], 0)
        self.assert_in_step()

    def test_runs_unreadable(self):
        orig = self.theirs.get

        def flaky(url, **kw):
            return Resp(500) if url.endswith("/sb_runs") else orig(url, **kw)
        self.theirs.get = flaky
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_daily_revenue"]["status"], "error")
        self.assertIn("sb_runs could not be read", by["sb_daily_revenue"]["note"])
        self.assertEqual(by["sb_runs"]["status"], "error")
        self.assertEqual(by["sb_brokers"]["status"], "ok")

    def test_full_resync_reads_and_upserts_every_row(self):
        self.ours.data["sb_daily_revenue"] = [r for r in self.ours.data["sb_daily_revenue"] if r["run_id"] != "a2"]
        by, notes = self.run_mirror(full=True)
        self.assertIsNone(self.runs_read("sb_daily_revenue"))                  # unfiltered
        self.assertEqual(self.upserted("sb_daily_revenue"), 120)
        self.assertEqual(by["sb_daily_revenue"]["copied"], "all rows")
        self.assertIn("every row read (--full)", notes[-1])
        self.assert_in_step()

    def test_tables_without_run_id_are_copied_whole(self):
        self.assertFalse(bm.is_run_keyed("sb_brokers", bm.table_specs(openapi(SPECS))["sb_brokers"]))
        self.assertFalse(bm.is_run_keyed("sb_runs", bm.table_specs(openapi(SPECS))["sb_runs"]))
        self.assertTrue(bm.is_run_keyed("sb_pat_lines", bm.table_specs(openapi(SPECS))["sb_pat_lines"]))
        by, _ = self.run_mirror()
        self.assertEqual(by["sb_brokers"]["upserted"], 2)


class Timestamps(unittest.TestCase):
    """The same instant reads the same on every Python (3.10's fromisoformat takes no 'Z' and only 0, 3 or 6
    fractional digits)."""

    def test_formats(self):
        same = ["2026-11-09T14:41:07.25+00:00", "2026-11-09T14:41:07.250Z", "2026-11-09T14:41:07.250000+00:00",
                "2026-11-09T20:11:07.25+05:30", "2026-11-09 20:11:07.25+0530", "2026-11-09T19:41:07.25+05:00",
                "2026-11-09T14:41:07.25"]
        instants = {bm.parse_timestamp(s) for s in same}
        self.assertEqual(len(instants), 1, instants)
        self.assertEqual(bm.parse_timestamp("2026-11-09T19:41:07+05"), bm.parse_timestamp("2026-11-09T14:41:07Z"))
        self.assertEqual(bm.parse_timestamp("2026-11-09T14:41:07.1234567+00:00"),
                         bm.parse_timestamp("2026-11-09T14:41:07.123456Z"))
        self.assertIsNone(bm.parse_timestamp("not a time"))
        self.assertEqual(bm.canon("not a time", "timestamp with time zone"), "not a time")
        self.assertEqual(bm.canon("2026-11-09", "date"), "2026-11-09")


class Plan(unittest.TestCase):
    def test_latest_runs(self):
        rows = [run("a1", day=1), run("a2", day=2), run("a3", day=3, status="failed"), run("a4", day=4, status="running"),
                run("g1", "GROWW", day=1), run("p1", mode="parity", day=2)]
        self.assertEqual(bm.latest_runs(rows), {"a2", "g1", "p1"})

    def test_usage(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(bm.main(["--everything"]), 2)
        self.assertIn("--full", out.getvalue())

if __name__ == "__main__":
    unittest.main()
