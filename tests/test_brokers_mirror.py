"""scripts/brokers_mirror.py against an in-memory fake of two Supabase REST
APIs (theirs: read only; ours: service role)."""

import json
import unittest

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import brokers_mirror as bm

SRC = ("https://theirs.supabase.co", "sb_publishable_x")
DST = ("https://ours.supabase.co", "eyJservice")


def prop(fmt, pk=False, **kw):
    return dict({"format": fmt, "type": "string", **({"description": "Note:\nThis is a Primary Key.<pk/>"} if pk else {})},
                **kw)


def openapi(tables):
    return {"swagger": "2.0", "definitions": tables}


RUNS = {"required": ["run_id", "broker_id"], "properties": {
    "run_id": prop("uuid", pk=True), "broker_id": prop("text"), "as_of": prop("date"),
    "notes": prop("jsonb"), "mode": prop("run_mode", enum=["parity", "live"])}}
DAILY = {"required": ["run_id", "trade_date", "segment"], "properties": {
    "run_id": prop("uuid", pk=True), "trade_date": prop("date", pk=True), "segment": prop("text", pk=True),
    "revenue_cr": prop("numeric")}}


class Resp:
    def __init__(self, status=200, body=None):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeSupabase:
    """Just enough PostgREST: OpenAPI, ordered paging, upsert on a key, delete by eq / in."""

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
        rows = sorted(self.data.get(table, []), key=lambda r: tuple(str(r[c]) for c in order))
        if params["select"] != "*":
            keep = params["select"].split(",")
            rows = [{c: r[c] for c in keep} for r in rows]
        return Resp(200, rows[params["offset"]:params["offset"] + params["limit"]])

    def post(self, url, params=None, data=None, headers=None, timeout=None):
        self.calls.append(("POST", url, params))
        table, pk = url.split("/")[-1], params["on_conflict"].split(",")
        rows = self.data.setdefault(table, [])
        index = {tuple(r[c] for c in pk): i for i, r in enumerate(rows)}
        for new in json.loads(data):
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

        def match(r):
            for c, f in params.items():
                op, val = f.split(".", 1)
                if op == "eq" and str(r[c]) != val:
                    return False
                if op == "in" and json.dumps(str(r[c])) not in val[1:-1].split(","):
                    return False
            return True
        self.data[table] = [r for r in self.data.get(table, []) if not match(r)]
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


def runs(n, start=0):
    return [{"run_id": f"r{i:04d}", "broker_id": "ANGEL", "as_of": "2026-10-30", "notes": {"k": i}, "mode": "live"}
            for i in range(start, start + n)]


class Schema(unittest.TestCase):
    def test_specs_types_and_keys(self):
        specs = bm.table_specs(openapi({"sb_runs": RUNS, "sb_daily_revenue": DAILY, "broker_reports": RUNS}))
        self.assertEqual(list(specs), ["sb_daily_revenue", "sb_runs"])          # only sb_*
        self.assertEqual(specs["sb_daily_revenue"]["pk"], ["run_id", "trade_date", "segment"])
        self.assertIn(("mode", "text", False), specs["sb_runs"]["columns"])      # enum → text
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


class Mirror(unittest.TestCase):
    def setUp(self):
        self.theirs = FakeSupabase(SRC[0], {"sb_runs": RUNS, "sb_daily_revenue": DAILY, "sb_new": RUNS},
                                   {"sb_runs": runs(2500),
                                    "sb_daily_revenue": [{"run_id": "r1", "trade_date": "2026-10-30", "segment": s,
                                                          "revenue_cr": 1.5} for s in ("fo", "cash", "mtf")]})
        self.ours = FakeSupabase(DST[0], {"sb_runs": RUNS, "sb_daily_revenue": DAILY},
                                 {"sb_runs": runs(5, start=2500) + runs(10)})
        self.session = Session(self.theirs, self.ours)

    def run_mirror(self):
        return bm.mirror(self.session, SRC, DST, source_tables=["sb_runs", "sb_daily_revenue", "sb_new"])

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
        self.assertIn("| sb_runs | 2,500 | 2,500 | 5 | ok |", md)
        self.assertIn("apply brokers_mirror_schema.sql", bm.summary_markdown([], []))


if __name__ == "__main__":
    unittest.main()
