"""scripts/excel_mirror.py against a fake Microsoft Graph and Supabase, mocked at
the HTTP level (requests.request / requests.post): a fake workbook model keeps
cells, sheets and sessions, so the tests check what lands in which cell."""

import contextlib
import json
import os
import re
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock
from urllib.parse import unquote, urlparse

import helpers  # noqa: F401  (puts scripts/ on sys.path)

import excel_mirror as xm

GRAPH = "https://graph.microsoft.com/v1.0"
SB = "https://sb.example.co"

TARGETS = {
    "nse_vf": {"drive_id": "d1", "item_id": "nse"},
    "bse_vf": {"drive_id": "d1", "item_id": "bse"},
    "mcx_vf": {"user": "research@example.com", "path": "/Valuations/MCX vF.xlsx"},
    "dashboard": {"drive_id": "d1", "item_id": "dash"},
}
DRYRUN = {k: {"drive_id": "dtest", "item_id": f"test-{k}"} for k in TARGETS}


def summary_sheet(ex):
    """The mapped cells of each vF file's "Tusk - Summary", as in the real files."""
    cells = {"B2": {"nse": "National Stock Exchange (NSE)", "bse": "BSE", "mcx": "MCX"}[ex], "A16": "PE Ratio", "B16": 40, "C16": 45, "D16": 50, "A12": "Target Price - FY28", "F12": 0.18,
             "A11": "Target Price - FY27", "F11": 0.09, "B11": "=B9*(1+$F$11)", "A10": "Upside - Current"}
    if ex == "nse":
        cells.update({"A9": "Current", "F10": 0.09, "B11": "=B12/(1+$F$12)"})
        del cells["F11"]
    return cells


class FakeResponse:
    def __init__(self, status, body=None, headers=None):
        self.status_code = status
        self.headers = headers or {}
        self._text = "" if body is None else json.dumps(body)
        self.content = self._text.encode()
        self.text = self._text

    def json(self):
        return json.loads(self._text)


class FakeCloud:
    """Graph workbooks (cells per sheet, sessions) and Supabase tables in memory."""

    def __init__(self, items=None):
        self.items = items or {}            # item_id → {"sheets": {name: {(r, c): value}}, "name": ...}
        self.sessions = {}                  # session id → item id
        self.closed = []
        self.calls = []                     # (method, path, body, headers)
        self.fail = {}                      # (method, path regex) → [status, …] consumed in order
        self.runs = []                      # excel_sync_runs rows
        self.inputs = [{"exchange": "bse", "inputs": {"pe1": 47, "pe9": 3}, "updated_at": "2026-11-22T05:00:00Z"}]
        self.supabase_down = False
        self.n = 0
        self.timeouts = []                  # (path, timeout) of Graph calls
        self.raise_on = {}                  # (method, path regex) → exception raised once
        self.add_then_conflict = set()      # sheet names whose add is applied, then answered 409

    # -- plumbing
    def request(self, method, url, headers=None, data=None, timeout=None):
        body = json.loads(data) if data else None
        u = urlparse(url)
        path = unquote(u.path) + (("?" + unquote(u.query)) if u.query else "")
        self.calls.append((method, path, body, headers or {}))
        self.timeouts.append((path, timeout))
        for (m, pat), exc in list(self.raise_on.items()):
            if m == method and re.search(pat, path):
                del self.raise_on[(m, pat)]
                raise exc
        for (m, pat), statuses in self.fail.items():
            if m == method and re.search(pat, path) and statuses:
                status = statuses.pop(0)
                return FakeResponse(status, {"error": {"message": f"fake {status}"}}, {"Retry-After": "2"} if status == 429 else {})
        if url.startswith(SB):
            return self.supabase(method, path, body)
        return self.graph(method, path, body, headers or {})

    def post(self, url, data=None, timeout=None, **kw):
        self.calls.append(("POST", url, data, {}))
        return FakeResponse(200, {"access_token": "token"})

    # -- Supabase
    def supabase(self, method, path, body):
        if self.supabase_down:
            raise xm.requests.ConnectionError("refused")
        if path.startswith("/rest/v1/valuation_inputs"):
            return FakeResponse(200, self.inputs)
        if path.startswith("/rest/v1/excel_sync_runs"):
            if method == "POST":
                self.n += 1
                row = {"id": 100 + self.n, **body}
                self.runs.append(row)
                return FakeResponse(201, [row])
            if method == "GET":
                return FakeResponse(200, self.runs)
            if method == "PATCH":
                rid = int(re.search(r"id=eq\.(\d+)", path).group(1))
                row = next((r for r in self.runs if r["id"] == rid), None)
                if row is None:
                    row = {"id": rid}
                    self.runs.append(row)
                only = re.search(r"status=in\.\(([^)]*)\)", path)
                if only and row.get("status") not in only.group(1).split(","):
                    return FakeResponse(204)
                row.update(body)
                return FakeResponse(204)
        return FakeResponse(404, {"message": "no route"})

    # -- Graph
    def graph(self, method, path, body, headers):
        p = path[len("/v1.0"):]
        m = re.match(r"/(?:users/[^/]+/drive|drives/[^/]+)/root:(.+?)(\?|$)", p)
        if m:
            item = next((k for k, v in self.items.items() if v.get("path") == m.group(1)), None)
            return FakeResponse(200, {"id": item, "name": "x.xlsx", "parentReference": {"driveId": "d9"}}) if item else FakeResponse(404, {})
        m = re.match(r"/drives/([^/]+)/items/([^/?]+)(.*)$", p)
        if not m or m.group(2) not in self.items:
            return FakeResponse(404, {"error": {"message": "itemNotFound"}})
        item_id, rest = m.group(2), m.group(3)
        wb = self.items[item_id]
        if rest == "":
            return FakeResponse(200, {"name": wb.get("name", f"{item_id}.xlsx"), "id": item_id})
        if rest == "/workbook/createSession":
            sid = f"s-{item_id}-{len(self.sessions)}"
            self.sessions[sid] = item_id
            return FakeResponse(201, {"id": sid, "persistChanges": body["persistChanges"]})
        if rest == "/workbook/closeSession":
            self.closed.append(headers.get("workbook-session-id"))
            return FakeResponse(204)
        if method != "GET" and headers.get("workbook-session-id") not in self.sessions:
            return FakeResponse(400, {"error": {"message": "no session"}})
        sheets = wb["sheets"]
        if rest.startswith("/workbook/worksheets?"):
            return FakeResponse(200, {"value": [{"name": n} for n in sheets]})
        if rest == "/workbook/worksheets/add":
            sheets[body["name"]] = {}
            if body["name"] in self.add_then_conflict:
                return FakeResponse(409, {"error": {"code": "ItemAlreadyExists", "message": "exists"}})
            return FakeResponse(201, {"name": body["name"]})
        m = re.match(r"/workbook/worksheets\('(.+?)'\)/(usedRange|range\(address='(.+?)'\))(/clear)?", rest)
        if not m:
            return FakeResponse(400, {"error": {"message": f"no route {rest}"}})
        name = m.group(1).replace("''", "'")
        if name not in sheets:
            return FakeResponse(404, {"error": {"message": "ItemNotFound"}})
        cells = sheets[name]
        if m.group(2) == "usedRange":
            if not cells:
                return FakeResponse(200, {"address": f"{name}!A1"})
            r1, c1 = max(r for r, _ in cells), max(c for _, c in cells)
            return FakeResponse(200, {"address": f"'{name}'!A1:{xm.col_letter(c1)}{r1}"})
        (r0, c0), (r1, c1) = xm.parse_range(m.group(3))
        if m.group(4):
            for k in [k for k in cells if r0 <= k[0] <= r1 and c0 <= k[1] <= c1]:
                del cells[k]
            return FakeResponse(200, {})
        if method == "GET":
            vals = [[cells.get((r, c), "") for c in range(c0, c1 + 1)] for r in range(r0, r1 + 1)]
            values = [["" if isinstance(v, str) and v.startswith("=") else v for v in row] for row in vals]
            return FakeResponse(200, {"address": m.group(3), "values": values, "formulas": vals})
        if method == "PATCH":
            vals = body["values"]
            assert len(vals) == r1 - r0 + 1 and all(len(r) == c1 - c0 + 1 for r in vals), (m.group(3), len(vals))
            for i, row in enumerate(vals):
                for j, v in enumerate(row):
                    if v == "":
                        cells.pop((r0 + i, c0 + j), None)
                    else:
                        cells[(r0 + i, c0 + j)] = v
            return FakeResponse(200, {})
        return FakeResponse(405, {})

    # -- helpers for assertions
    def cell(self, item, sheet, ref):
        return self.items[item]["sheets"][sheet].get(xm.parse_cell(ref))

    def writes(self, item=None):
        return [c for c in self.calls if c[0] in ("PATCH", "POST") and "/workbook/" in c[1]
                and not c[1].endswith(("createSession", "closeSession"))
                and (item is None or f"/items/{item}/" in c[1])]


def vf_item(ex, path=None):
    d = {"sheets": {"Tusk - Summary": {xm.parse_cell(k): v for k, v in summary_sheet(ex).items()}, "Model": {(1, 1): 7}}}
    if path:
        d["path"] = path
    return d


def cloud():
    return FakeCloud({
        "nse": vf_item("nse"), "bse": vf_item("bse"),
        "mcx": vf_item("mcx", "/Valuations/MCX vF.xlsx"),
        "dash": {"sheets": {"NSE": {(1, 1): "=WD_NSE_Daily!A3"}, "WD_VIX": {(1, 1): "Written by ExchangesDash at old", (900, 2): 99}}},
        **{f"test-{k}": (vf_item(xm.VF_TARGETS[k]) if k in xm.VF_TARGETS else {"sheets": {}}) for k in TARGETS},
    })


def env(**kw):
    e = {"ENABLE_EXCEL_MIRROR": "true", "EXCEL_TARGETS": json.dumps(TARGETS), "EXCEL_TARGETS_DRYRUN": json.dumps(DRYRUN),
         "SUPABASE_URL": SB, "SUPABASE_KEY": "service", "GITHUB_RUN_ID": "777",
         "MSGRAPH_TENANT_ID": "t", "MSGRAPH_CLIENT_ID": "c", "MSGRAPH_CLIENT_SECRET": "s"}
    e.update(kw)
    return e


class FixtureData:
    """A small valuation output and data set, so these tests need neither Node nor the real files."""

    @staticmethod
    def outputs(overrides=None):
        def ex_out(ex, pe):
            v = {"adr": None, "g": 5, "pe0": pe - 5, "pe1": pe, "pe2": pe + 5, "w0": 40, "w1": 20, "w2": 40, "from": None,
                 "oi": 100, "margin": 50, "days": 250, "d1": 18, "d2": 9}
            o = (overrides or {}).get(ex, {})
            v.update({k: o[k] for k in o if k in v})
            three = [1.0, 2.0, 3.0]
            tri = {"adr": 12.0, "regression": three, "ratio": None, "adr_model": three, "avg": three, "used": ["reg", "adr"],
                   "dropped": ["ratio"], "w_used": 80, "w_total": 100, "upside": [-0.5, 0, 0.5]}
            return {"inputs": v, "defaults": {**v, "pe1": pe}, "edited": [k for k in o if k in v], "overrides": o, "shares_cr": 40.79,
                    "context": {"q_label": "Q3 FY 2027", "q_adr": 12.0, "q_n": 30, "adr45": 11.5, "n45": 45, "last_date": "2026-11-20", "flags": {}},
                    "adr_path": {"quarters": [{"label": f"Q{q} FY27", "q": q, "fy": 2027, "adr": 12.0} for q in (3, 4)], "fy": 2028, "adr": 14.0},
                    "adr_model": {"adr_fy": 14.0, "txn": 3500, "oi": 100, "total": 3600, "margin": 50, "pat": 1800, "eps": 44.1,
                                  "pe": [v["pe0"], v["pe1"], v["pe2"]], "fy_next_end": three, "fy_end": three, "today": three},
                    "dma": tri, "est": tri, "est_is_dma": True, "target": {"values": [10.0, 20.0, 30.0], "upside": [-0.5, 0, 0.5]},
                    "cmp": 20.0, "cmp_date": "2026-11-20", "cmp_live": False, "ticker": "X.NS",
                    "fit": {"intercept": 1.0, "slope": 2.0, "se": 0.5, "n": 100, "r2": 0.8}, "fit_why": "", "ratio": None, "ratio_why": "x",
                    "window": {"from": None, "from_ignored": "", "ma_window": 45, "fit_start": "2025-01-01", "first_point": "2025-03-05",
                               "n": 100, "modelled_out": 0, "published_start": "2025-01-01", "published_n": 100},
                    "data_from": "2025-01-01", "fy_mismatch": False}
        return {"fy": 2028, "labels": {}, "exchanges": {"bse": ex_out("bse", 45), "mcx": ex_out("mcx", 46), "nse": ex_out("nse", 47)}}

    @staticmethod
    def data():
        days = [f"2026-11-{d:02d}" for d in (18, 19, 20)]
        raw = {
            "nse": {"daily_all": [{"date": d, "total_rev": 90.0 + i, "vix": 15 + i, "io_contracts": 10, "so_contracts": 1,
                                   "if_contracts": 2, "sf_contracts": 3, "io_premium": 100.0, "so_premium": 5.0} for i, d in enumerate(reversed(days))],
                    "quarterly": [{"quarter": "Q3 FY 2027", "total_rev": 2000}], "monthly": [{"month": "FY 2027 November", "total_rev": 900}]},
            "bse": {"daily_all": [{"date": d, "total_rev": 8.0, "total_contracts": 50, "options_premium_turnover": 12.0} for d in days[1:]],
                    "quarterly": [{"quarter": "Q3 FY 2027", "total_rev": 700, "options_premium_turnover": 1.0}], "monthly": []},
            "mcx": {"daily_all": [{"date": d, "total_rev": 20.0, "modelled": False} for d in days],
                    "quarterly": [{"quarter": "Q3 FY 2027", "total_rev": 480, "modelled_days": 0}], "monthly": []},
        }
        return {"inputs": {}, "raw": raw, "share": {}}


class MirrorTest(unittest.TestCase):
    def run_main(self, args=(), cloud_=None, quiet=True, **env_kw):
        self.cloud = cloud_ or cloud()
        if "RUNNER_TEMP" not in env_kw:   # the run-id note goes to a fresh directory per test
            tmp = tempfile.TemporaryDirectory()
            self.addCleanup(tmp.cleanup)
            env_kw["RUNNER_TEMP"] = tmp.name
        seen = {}

        def compute(inputs, raw, share, overrides):
            seen["overrides"] = overrides
            return FixtureData.outputs(overrides)

        with mock.patch.dict(os.environ, env(**env_kw), clear=False), \
                mock.patch("requests.request", self.cloud.request), mock.patch("requests.post", self.cloud.post), \
                mock.patch.object(xm.valuation_outputs, "compute", compute), \
                mock.patch.object(xm.valuation_outputs, "load_data", FixtureData.data), \
                mock.patch.object(xm, "_sleep", lambda s: self.sleeps.append(s)), \
                mock.patch("excel_sync.MSGRAPH_TENANT_ID", "t"), \
                (mock.patch("builtins.print") if quiet else contextlib.nullcontext()):
            self.sleeps = []
            self.code = xm.main(list(args))
        self.overrides_seen = seen.get("overrides")
        return self.cloud


class Sessions(MirrorTest):
    def test_each_file_writes_in_a_persistent_session_that_is_closed(self):
        c = self.run_main()
        self.assertEqual(self.code, 0)
        creates = [x for x in c.calls if x[1].endswith("/workbook/createSession")]
        self.assertEqual(len(creates), 4)
        self.assertTrue(all(x[2] == {"persistChanges": True} for x in creates))
        self.assertEqual(sorted(c.closed), sorted(c.sessions))
        for method, path, body, headers in c.writes():
            self.assertIn(headers.get("workbook-session-id"), c.sessions, path)

    def test_user_and_path_target_is_resolved(self):
        c = self.run_main()
        self.assertTrue(any("/users/research@example.com/drive/root:/Valuations/MCX vF.xlsx" in x[1] for x in c.calls))
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "C16"), 46)


class InputCells(MirrorTest):
    def test_pe_and_discounts_land_in_the_mapped_cells(self):
        c = self.run_main()
        self.assertEqual([c.cell("bse", "Tusk - Summary", r) for r in ("B16", "C16", "D16")], [40, 47, 50])   # shared pe1 = 47
        self.assertEqual([c.cell("nse", "Tusk - Summary", r) for r in ("B16", "C16", "D16")], [42, 47, 52])
        for item in ("bse", "mcx"):
            self.assertAlmostEqual(c.cell(item, "Tusk - Summary", "F11"), 0.09)
            self.assertAlmostEqual(c.cell(item, "Tusk - Summary", "F12"), 0.18)
        self.assertAlmostEqual(c.cell("nse", "Tusk - Summary", "F10"), 0.09)
        self.assertAlmostEqual(c.cell("nse", "Tusk - Summary", "F12"), 0.18)
        self.assertIsNone(c.cell("nse", "Tusk - Summary", "F11"))
        # formulas and other sheets untouched
        self.assertEqual(c.cell("bse", "Tusk - Summary", "B11"), "=B9*(1+$F$11)")
        self.assertEqual(c.cell("bse", "Model", "A1"), 7)

    def test_overrides_come_from_supabase(self):
        self.run_main()
        self.assertEqual(self.overrides_seen, {"bse": {"pe1": 47, "pe9": 3}})

    def test_label_mismatch_skips_only_that_files_input_writes(self):
        c = cloud()
        c.items["bse"]["sheets"]["Tusk - Summary"][xm.parse_cell("A16")] = "PB Ratio"
        self.run_main(cloud_=c)
        self.assertEqual(c.cell("bse", "Tusk - Summary", "C16"), 45)           # untouched
        self.assertAlmostEqual(c.cell("bse", "Tusk - Summary", "F11"), 0.09)
        self.assertFalse(any("Tusk - Summary" in x[1] for x in c.writes("bse")))
        self.assertEqual(c.cell("bse", "Web Dashboard", "C8"), 40)            # its Web Dashboard still written
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "C16"), 46)           # other files written
        run = c.runs[-1]
        files = {f["target"]: f for f in run["files"]}
        self.assertEqual(files["bse_vf"]["status"], "partial")
        self.assertIn("A16 reads 'PB Ratio'", files["bse_vf"]["errors"][0])
        self.assertEqual(run["status"], "partial")
        self.assertEqual(self.code, 0)

    def test_label_check_is_trimmed_and_case_insensitive(self):
        c = cloud()
        c.items["mcx"]["sheets"]["Tusk - Summary"][xm.parse_cell("A16")] = "  pe ratio "
        self.run_main(cloud_=c)
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "C16"), 46)

    def test_a_formula_in_an_input_cell_is_not_overwritten(self):
        c = cloud()
        c.items["mcx"]["sheets"]["Tusk - Summary"][xm.parse_cell("F12")] = "=F11*2"
        self.run_main(cloud_=c)
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "F12"), "=F11*2")
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "C16"), 45)       # P/E not written either (46 in use)
        self.assertFalse(any("Tusk - Summary" in x[1] for x in c.writes("mcx")))


class WebDashboard(MirrorTest):
    def test_layout_and_fixed_addresses(self):
        c = self.run_main()
        cell = lambda ref: c.cell("bse", "Web Dashboard", ref)  # noqa: E731
        self.assertRegex(cell("A1"), r"^Written by ExchangesDash at \d+ \w{3} \d{4} \d\d:\d\d IST; ")
        self.assertIn("data to 2026-11-20", cell("A1"))
        self.assertIn("inputs last changed 22 Nov 2026 10:30 IST", cell("A1"))
        self.assertEqual([cell(f"A{6 + i}") for i in range(14)], xm.INPUT_KEYS)
        self.assertEqual(cell("C9"), 47)       # pe1, shared
        self.assertEqual(cell("D9"), 45)       # its default
        self.assertIs(cell("E9"), True)
        a = xm.WEB_ADDRESSES
        self.assertEqual(cell(a["cmp"]), 20.0)
        self.assertEqual(cell(a["cmp_date"]), "2026-11-20")
        (r, c0), _ = xm.parse_range(a["target"])
        self.assertEqual(cell(a["target"].split(":")[0]), 10.0)
        self.assertEqual(c.items["bse"]["sheets"]["Web Dashboard"][(r, c0 + 1)], 20.0)
        self.assertEqual(cell(f"A{r}"), "Triangulated target (ADR estimate)")
        self.assertEqual(cell(f"A{xm.parse_cell(a['upside'].split(':')[0])[0]}"), "Upside vs CMP")
        self.assertEqual(cell(f"A{xm.parse_cell(a['adr_model_today'].split(':')[0])[0]}"), "ADR model, today")
        self.assertEqual(cell(a["adr_path"]), "ADR path")

    def test_rewritten_each_run(self):
        c = cloud()
        c.items["nse"]["sheets"]["Web Dashboard"] = {(1, 1): "Written by ExchangesDash at old", (500, 1): "stale", (3, 9): "x"}
        self.run_main(cloud_=c)
        self.assertNotIn((500, 1), c.items["nse"]["sheets"]["Web Dashboard"])
        self.assertNotIn((3, 9), c.items["nse"]["sheets"]["Web Dashboard"])
        clears = [x[1].split("range(address='")[1].split("'")[0] for x in c.writes("nse") if x[1].endswith("/clear")]
        self.assertEqual(clears, ["A70:I500", "F1:I69"])          # only beyond the new rows and columns
        self.assertFalse(any(x[1].endswith("worksheets/add") and "/items/nse/" in x[1] and x[2]["name"] == "Web Dashboard" for x in c.calls))


class FeedSheets(MirrorTest):
    def test_dashboard_feed_sheets(self):
        c = self.run_main()
        sheets = c.items["dash"]["sheets"]
        for name in ("WD_Inputs", "WD_Valuation", "WD_NSE_Daily", "WD_BSE_Daily", "WD_MCX_Daily",
                     "WD_Quarterly", "WD_Monthly", "WD_VIX", "WD_Contracts"):
            self.assertIn(name, sheets)
            self.assertTrue(str(c.cell("dash", name, "A1")).startswith("Written by ExchangesDash"), name)
        # daily: every field, oldest first, dates as ISO text
        self.assertEqual(c.cell("dash", "WD_NSE_Daily", "A2"), "date")
        self.assertEqual([c.cell("dash", "WD_NSE_Daily", f"A{r}") for r in (3, 4, 5)], ["2026-11-18", "2026-11-19", "2026-11-20"])
        head = [c.cell("dash", "WD_MCX_Daily", f"{xm.col_letter(i)}2") for i in range(1, 4)]
        self.assertEqual(head, ["date", "total_rev", "modelled"])
        self.assertIs(c.cell("dash", "WD_MCX_Daily", "C3"), False)
        # stacked, with an exchange column
        self.assertEqual([c.cell("dash", "WD_Quarterly", f"A{r}") for r in (2, 3, 4, 5)], ["exchange", "nse", "bse", "mcx"])
        self.assertEqual(c.cell("dash", "WD_Quarterly", "B2"), "quarter")
        # VIX, old rows cleared
        self.assertEqual([c.cell("dash", "WD_VIX", r) for r in ("A3", "B3", "B5")], ["2026-11-18", 17, 15])
        self.assertIsNone(c.cell("dash", "WD_VIX", "B900"))
        # Contracts: union of dates, BSE blank where it has none
        self.assertEqual([c.cell("dash", "WD_Contracts", f"{x}3") for x in "ABCDEF"], ["2026-11-18", 11, 5, 105.0, None, None])
        self.assertEqual([c.cell("dash", "WD_Contracts", f"{x}5") for x in "ABCDEF"], ["2026-11-20", 11, 5, 105.0, 50, 12.0])
        # inputs and valuation: one row per exchange
        self.assertEqual([c.cell("dash", "WD_Inputs", f"A{r}") for r in (3, 4, 5)], ["bse", "mcx", "nse"])
        self.assertEqual(c.cell("dash", "WD_Inputs", "E3"), 47)   # bse pe1
        self.assertEqual(c.cell("dash", "WD_Valuation", "A2"), "exchange")
        col = {c.cell("dash", "WD_Valuation", f"{xm.col_letter(i)}2"): i for i in range(1, 80)}
        self.assertEqual(c.items["dash"]["sheets"]["WD_Valuation"][(3, col["target_base"])], 20.0)
        # the analysis sheet is not touched
        self.assertEqual(c.cell("dash", "NSE", "A1"), "=WD_NSE_Daily!A3")

    def test_existing_sheet_cleared_missing_sheet_added(self):
        c = self.run_main()
        dash = [x for x in c.calls if "/items/dash/" in x[1]]
        adds = [x[2]["name"] for x in dash if x[1].endswith("worksheets/add")]
        self.assertNotIn("WD_VIX", adds)
        self.assertIn("WD_NSE_Daily", adds)
        clears = [x for x in dash if x[1].endswith("/clear")]
        self.assertEqual(len(clears), 1)
        self.assertIn("worksheets('WD_VIX')/range(address='A6:B900')/clear", clears[0][1])   # below the new rows only
        self.assertEqual(clears[0][2], {"applyTo": "Contents"})

    def test_chunking_a_1000_by_30_table(self):
        c = FakeCloud({"x": {"sheets": {"S": {}}}})
        with mock.patch("requests.request", c.request):
            wb = xm.Workbook(xm.Graph("t"), "d", "x")
            wb.open()
            rows = [[r * 100 + k for k in range(30)] for r in range(1000)]
            addresses = wb.write_table("S", rows)
        patches = [x for x in c.calls if x[0] == "PATCH"]
        self.assertEqual(len(patches), 8)          # 4000 cells ÷ 30 columns = 133 rows a request
        self.assertEqual(addresses, ["A1:AD133", "A134:AD266", "A267:AD399", "A400:AD532",
                                     "A533:AD665", "A666:AD798", "A799:AD931", "A932:AD1000"])
        self.assertTrue(all(len(x[2]["values"]) * 30 <= 4000 for x in patches))
        self.assertEqual(c.cell("x", "S", "AD1000"), 99929)
        self.assertEqual(wb.cells, 30000)

    def test_chunking_keeps_requests_under_a_megabyte(self):
        c = FakeCloud({"x": {"sheets": {"S": {}}}})
        with mock.patch("requests.request", c.request):
            wb = xm.Workbook(xm.Graph("t"), "d", "x")
            wb.open()
            wb.write_table("S", [["y" * 20000] * 2 for _ in range(100)])
        sizes = [len(json.dumps(x[2])) for x in c.calls if x[0] == "PATCH"]
        self.assertGreater(len(sizes), 3)
        self.assertTrue(all(s < 1_100_000 for s in sizes), sizes)


class Retries(MirrorTest):
    def test_429_is_retried_after_retry_after(self):
        c = cloud()
        c.fail[("PATCH", r"/items/bse/.*Tusk - Summary")] = [429, 429]
        self.run_main(cloud_=c)
        self.assertEqual(self.sleeps[:2], [2.0, 2.0])
        self.assertEqual(c.cell("bse", "Tusk - Summary", "C16"), 47)
        self.assertEqual(c.runs[-1]["status"], "success")

    def test_gives_up_after_five_tries(self):
        c = cloud()
        c.fail[("PATCH", r"/items/bse/.*Tusk - Summary")] = [503] * 10
        self.run_main(cloud_=c)
        self.assertEqual(len([x for x in c.calls if x[0] == "PATCH" and "/items/bse/" in x[1] and "Tusk - Summary" in x[1]]), 5)
        files = {f["target"]: f for f in c.runs[-1]["files"]}
        self.assertEqual(files["bse_vf"]["status"], "failed")
        self.assertEqual(c.runs[-1]["status"], "partial")

    def test_a_locked_file_fails_alone(self):
        c = cloud()
        c.fail[("POST", r"/items/nse/workbook/createSession")] = [423]
        self.run_main(cloud_=c)
        files = {f["target"]: f for f in c.runs[-1]["files"]}
        self.assertEqual(files["nse_vf"]["status"], "failed")
        self.assertIn("locked", files["nse_vf"]["errors"][0])
        for k in ("bse_vf", "mcx_vf", "dashboard"):
            self.assertEqual(files[k]["status"], "success", k)
        self.assertEqual(c.cell("bse", "Tusk - Summary", "C16"), 47)
        self.assertEqual(c.runs[-1]["status"], "partial")
        self.assertEqual(self.sleeps, [])     # a lock is not retried

    def test_a_lock_mid_file_still_closes_its_session(self):
        c = cloud()
        c.fail[("POST", r"/items/dash/.*worksheets/add")] = [409]
        self.run_main(cloud_=c)
        dash_sessions = [s for s, item in c.sessions.items() if item == "dash"]
        self.assertTrue(dash_sessions and all(s in c.closed for s in dash_sessions))


class RunLogging(MirrorTest):
    def test_manual_run_updates_its_row(self):
        c = cloud()
        c.runs.append({"id": 42, "trigger": "manual", "status": "queued"})
        self.run_main(["--trigger", "manual", "--run-id", "42"], cloud_=c)
        self.assertEqual(len(c.runs), 1)
        run = c.runs[0]
        self.assertEqual((run["trigger"], run["status"], run["github_run_id"]), ("manual", "success", 777))
        self.assertTrue(run["started_at"] and run["finished_at"])
        statuses = [x[2]["status"] for x in c.calls if x[0] == "PATCH" and "excel_sync_runs" in x[1]]
        self.assertEqual(statuses, ["running", "success"])
        files = {f["target"]: f for f in run["files"]}
        self.assertEqual(set(files), set(xm.TARGET_KEYS))
        self.assertGreater(files["dashboard"]["cells"], 0)
        self.assertIn("WD_NSE_Daily", files["dashboard"]["sheets"])
        self.assertIn("duration_s", files["nse_vf"])
        self.assertIsNone(run["error"])

    def test_scheduled_run_inserts_a_row(self):
        c = self.run_main()
        self.assertEqual(len(c.runs), 1)
        self.assertEqual((c.runs[0]["trigger"], c.runs[0]["status"]), ("scheduled", "success"))
        inserts = [x for x in c.calls if x[0] == "POST" and "excel_sync_runs" in x[1]]
        self.assertEqual(inserts[0][2]["status"], "running")
        self.assertEqual(inserts[0][3]["Prefer"], "return=representation")

    def test_all_files_failing_fails_the_run(self):
        c = cloud()
        for item in ("nse", "bse", "mcx", "dash"):
            c.fail[("POST", rf"/items/{item}/workbook/createSession")] = [423]
        c.fail[("GET", r"/users/")] = [423]
        self.run_main(cloud_=c)
        self.assertEqual(c.runs[-1]["status"], "failed")
        self.assertEqual(self.code, 1)

    def test_supabase_down_fails_without_writing(self):
        c = cloud()
        c.supabase_down = True
        self.run_main(cloud_=c)
        self.assertEqual(self.code, 1)
        self.assertEqual([x for x in c.calls if "graph.microsoft.com" in x[1] or "login.microsoftonline" in x[1]], [])

    def test_supabase_inputs_unreadable_fails_the_logged_run(self):
        c = cloud()
        c.fail[("GET", r"/rest/v1/valuation_inputs")] = [500]
        c.runs.append({"id": 9, "status": "queued", "trigger": "manual"})
        self.run_main(["--run-id", "9", "--trigger", "manual"], cloud_=c)
        self.assertEqual(c.runs[0]["status"], "failed")
        self.assertIn("shared inputs not read", c.runs[0]["error"])
        self.assertFalse(any("graph.microsoft.com" in x[1] for x in c.calls))

    def test_missing_targets_fail_the_run(self):
        c = self.run_main(EXCEL_TARGETS="")
        self.assertEqual(c.runs[-1]["status"], "failed")
        self.assertIn("EXCEL_TARGETS not set", c.runs[-1]["error"])

    def test_dry_run_uses_the_dry_run_targets(self):
        c = self.run_main(["--dry-run"], ENABLE_EXCEL_MIRROR="")
        self.assertEqual(c.cell("test-bse_vf", "Tusk - Summary", "C16"), 47)
        self.assertEqual(c.cell("bse", "Tusk - Summary", "C16"), 45)
        self.assertFalse(any("/items/bse/" in x[1] or "/items/dash/" in x[1] for x in c.calls))
        self.assertTrue(all(f["dry_run"] for f in c.runs[-1]["files"]))


class Gating(MirrorTest):
    def test_off_means_no_calls(self):
        for value in ("", "false", "1"):
            with self.subTest(value=value):
                c = self.run_main(ENABLE_EXCEL_MIRROR=value)
                self.assertEqual(self.code, 0)
                self.assertEqual(c.calls, [])

    def test_off_closes_a_manual_runs_row(self):
        c = cloud()
        c.runs.append({"id": 5, "status": "queued", "trigger": "manual"})
        self.run_main(["--run-id", "5", "--trigger", "manual"], cloud_=c, ENABLE_EXCEL_MIRROR="false")
        self.assertEqual(c.runs[0]["status"], "failed")
        self.assertIn("switched off", c.runs[0]["error"])
        self.assertFalse(any("graph.microsoft.com" in x[1] for x in c.calls))


class Check(MirrorTest):
    def test_check_reads_and_writes_nothing(self):
        c = cloud()
        c.items["bse"]["sheets"]["Tusk - Summary"][xm.parse_cell("A12")] = "Target Price - FY29"
        with mock.patch("builtins.print") as p:
            self.run_main(["--check"], cloud_=c, quiet=False, ENABLE_EXCEL_MIRROR="")
        out = "\n".join(" ".join(map(str, a.args)) for a in p.call_args_list)
        self.assertEqual(self.code, 1)                 # a label failed
        self.assertIn("A12 reads 'Target Price - FY29'", out)
        self.assertIn("pin as", out)                    # the path target's ids
        self.assertTrue(re.search(r"nse_vf\s+nse\.xlsx\s+d1 / nse\s+2\s+will be created\s+OK\s+OK", out), out)
        self.assertEqual(c.writes(), [])
        self.assertFalse(any(x[0] in ("PATCH", "DELETE", "PUT") for x in c.calls))
        creates = [x for x in c.calls if x[1].endswith("createSession")]
        self.assertEqual(len(creates), 4)                     # the write path is proved, saving nothing
        self.assertTrue(all(x[2] == {"persistChanges": False} for x in creates))
        self.assertEqual(sorted(c.closed), sorted(c.sessions))
        self.assertEqual(c.runs, [])

    def test_check_reports_a_refused_session_and_a_foreign_sheet(self):
        c = cloud()
        c.fail[("POST", r"/items/bse/workbook/createSession")] = [403]
        c.items["dash"]["sheets"]["WD_Monthly"] = {(1, 1): "hand-made"}
        with mock.patch("builtins.print") as p:
            self.run_main(["--check"], cloud_=c, quiet=False)
        out = "\n".join(" ".join(map(str, a.args)) for a in p.call_args_list)
        self.assertEqual(self.code, 1)
        self.assertRegex(out, r"bse_vf .* OK\s+REFUSED HTTP 403")
        self.assertIn("WD_Monthly: NOT OURS, will be skipped", out)
        self.assertEqual(c.writes(), [])

    def test_check_passes_on_good_files(self):
        with mock.patch("builtins.print"):
            self.run_main(["--check"])
        self.assertEqual(self.code, 0)


class Targets(unittest.TestCase):
    def test_drive_and_path_target_is_looked_up_in_that_drive(self):
        c = FakeCloud({"x": {"path": "/Shared/x.xlsx", "sheets": {}}})
        with mock.patch("requests.request", c.request), mock.patch("builtins.print"):
            got = xm.resolve_target(xm.Graph("t"), "dashboard", {"drive_id": "b!abc", "path": "Shared/x.xlsx"})
        self.assertEqual(got, ("d9", "x"))
        self.assertIn("/drives/b!abc/root:/Shared/x.xlsx", c.calls[0][1])

    def test_parse(self):
        self.assertEqual(xm.parse_targets(json.dumps(TARGETS)), TARGETS)
        self.assertEqual(xm.parse_targets('{"nse_vf": {"drive_id": "d", "path": "/a.xlsx"}}'), {"nse_vf": {"drive_id": "d", "path": "/a.xlsx"}})
        for bad in ("", "[]", "{", json.dumps({"other": {}}), json.dumps({"nse_vf": {"drive_id": "x"}})):
            with self.subTest(bad=bad):
                with self.assertRaises(ValueError):
                    xm.parse_targets(bad)

    def test_mapping_matches_the_brief(self):
        m = {ex: {c["range"]: (c["label_cell"], c["label"], c["keys"]) for c in spec["inputs"]} for ex, spec in xm.VF_INPUT_CELLS.items()}
        self.assertEqual({ex: (s["identity"]["cell"], s["identity"]["value"]) for ex, s in xm.VF_INPUT_CELLS.items()},
                         {"nse": ("B2", "National Stock Exchange (NSE)"), "bse": ("B2", "BSE"), "mcx": ("B2", "MCX")})
        for ex in ("nse", "bse", "mcx"):
            self.assertEqual(m[ex]["B16:D16"], ("A16", "PE Ratio", ["pe0", "pe1", "pe2"]))
            self.assertEqual(m[ex]["F12"], ("A12", "Target Price - FY28", ["d1"]))
        self.assertEqual(m["bse"]["F11"], ("A11", "Target Price - FY27", ["d2"]))
        self.assertEqual(m["mcx"]["F11"], ("A11", "Target Price - FY27", ["d2"]))
        self.assertEqual(m["nse"]["F10"], ("A10", "Upside - Current", ["d2"]))


class Safety(MirrorTest):
    """The review's fixes: never overwrite a sheet this job did not write, never a blank
    sheet on failure, never the wrong exchange's file."""

    def files(self):
        return {f["target"]: f for f in self.cloud.runs[-1]["files"]}

    def test_a_sheet_not_written_by_the_job_is_left_alone(self):
        c = cloud()
        c.items["bse"]["sheets"]["Web Dashboard"] = {(1, 1): "My notes", (2, 2): 5}
        c.items["dash"]["sheets"]["WD_Inputs"] = {(4, 3): "hand-made"}
        self.run_main(cloud_=c)
        self.assertEqual(c.items["bse"]["sheets"]["Web Dashboard"], {(1, 1): "My notes", (2, 2): 5})
        self.assertEqual(c.items["dash"]["sheets"]["WD_Inputs"], {(4, 3): "hand-made"})
        f = self.files()
        self.assertEqual(f["bse_vf"]["status"], "partial")
        self.assertIn("'Web Dashboard' was not written by this job", f["bse_vf"]["errors"][0])
        self.assertTrue(f["bse_vf"]["inputs_written"])                      # its inputs still went in
        self.assertEqual(c.cell("bse", "Tusk - Summary", "C16"), 47)
        self.assertEqual(f["dashboard"]["status"], "partial")
        self.assertNotIn("WD_Inputs", f["dashboard"]["sheets"])
        self.assertIn("WD_Valuation", f["dashboard"]["sheets"])

    def test_an_existing_empty_sheet_is_written(self):
        c = cloud()
        c.items["dash"]["sheets"]["WD_Inputs"] = {}
        self.run_main(cloud_=c)
        self.assertTrue(c.cell("dash", "WD_Inputs", "A1").startswith("Written by ExchangesDash"))
        self.assertFalse(any("WD_Inputs" in x[1] and x[1].endswith("/clear") for x in c.calls))

    def test_a_failed_write_leaves_the_old_values(self):
        c = cloud()
        c.fail[("PATCH", r"/items/dash/.*WD_VIX")] = [500]
        self.run_main(cloud_=c)
        self.assertEqual(c.cell("dash", "WD_VIX", "B900"), 99)               # nothing cleared first
        self.assertFalse(any("WD_VIX" in x[1] and x[1].endswith("/clear") for x in c.calls))
        self.assertEqual(self.files()["dashboard"]["status"], "failed")

    def test_swapped_targets_fail_the_identity_check(self):
        c = cloud()
        swapped = {**TARGETS, "bse_vf": {"drive_id": "d1", "item_id": "mcx"}, "mcx_vf": {"drive_id": "d1", "item_id": "bse"}}
        self.run_main(cloud_=c, EXCEL_TARGETS=json.dumps(swapped))
        f = self.files()
        for k, other in (("bse_vf", "MCX"), ("mcx_vf", "BSE")):
            self.assertEqual(f[k]["status"], "failed")
            self.assertIn(f"identity check failed, nothing written: B2 reads '{other}'", f[k]["errors"][0])
        self.assertEqual(c.writes("bse"), [])
        self.assertEqual(c.writes("mcx"), [])
        self.assertEqual(f["nse_vf"]["status"], "success")

    def test_a_409_on_add_is_idempotent(self):
        c = cloud()
        c.add_then_conflict = {"WD_NSE_Daily"}
        self.run_main(cloud_=c)
        f = self.files()["dashboard"]
        self.assertEqual(f["status"], "success", f["errors"])
        self.assertEqual(c.cell("dash", "WD_NSE_Daily", "A3"), "2026-11-18")

    def test_create_session_waits_longer_and_is_not_retried_after_a_timeout(self):
        c = cloud()
        c.raise_on[("POST", r"/items/nse/workbook/createSession")] = xm.requests.ReadTimeout("slow")
        self.run_main(cloud_=c)
        self.assertEqual(len([x for x in c.calls if x[1].endswith("/items/nse/workbook/createSession")]), 1)
        self.assertEqual(self.files()["nse_vf"]["status"], "failed")
        self.assertTrue(all(t == 180 for p, t in c.timeouts if p.endswith("createSession")))
        self.assertTrue(all(t == 60 for p, t in c.timeouts if "graph.microsoft" not in p and p.endswith("/clear")))

    def test_a_failed_close_session_is_not_success(self):
        c = cloud()
        c.fail[("POST", r"/items/bse/workbook/closeSession")] = [500]
        self.run_main(cloud_=c)
        f = self.files()["bse_vf"]
        self.assertEqual(f["status"], "partial")
        self.assertIn("closeSession", f["errors"][0])
        self.assertEqual(c.runs[-1]["status"], "partial")

    def test_a_missing_input_skips_only_its_cells(self):
        c = cloud()
        c.inputs = [{"exchange": "mcx", "inputs": {"pe0": None}, "updated_at": "2026-11-22T05:00:00Z"}]
        self.run_main(cloud_=c)
        f = self.files()["mcx_vf"]
        self.assertEqual(f["status"], "partial")
        self.assertFalse(f["inputs_written"])
        self.assertEqual(f["input_cells"], {"B16:D16": False, "F11": True, "F12": True})
        self.assertIn("B16:D16 (P/E bear / base / bull) has no value", f["errors"][0])
        self.assertEqual(c.cell("mcx", "Tusk - Summary", "C16"), 45)        # untouched
        self.assertAlmostEqual(c.cell("mcx", "Tusk - Summary", "F12"), 0.18)
        self.assertIn("Web Dashboard", f["sheets"])

    def test_inputs_written_is_recorded(self):
        self.run_main()
        f = self.files()
        self.assertTrue(f["nse_vf"]["inputs_written"])
        self.assertEqual(f["nse_vf"]["input_cells"], {"B16:D16": True, "F10": True, "F12": True})
        self.assertNotIn("inputs_written", f["dashboard"])

    def test_text_that_looks_like_a_formula_stays_text(self):
        self.assertEqual([xm._cell_value(v) for v in ("=1+1", "+91 22", "-x", "@sum", "-5", "+1.5", "2026-11-20", "", None, 3, True)],
                         ["'=1+1", "'+91 22", "'-x", "'@sum", "-5", "+1.5", "2026-11-20", "", "", 3, True])

    def test_an_errored_exchange_keeps_its_valuation_row(self):
        out = FixtureData.outputs()
        out["exchanges"]["mcx"] = {"error": "no daily rows"}
        sheets = xm.feed_sheets(out, FixtureData.data()["raw"], {}, datetime(2026, 11, 23, tzinfo=timezone.utc))
        rows = sheets["WD_Valuation"][2:]
        self.assertEqual([r[0] for r in rows], ["bse", "mcx", "nse"])
        self.assertEqual(rows[1][1:], [""] * (len(xm.valuation_header()) - 1))
        self.assertEqual(len(rows[1]), len(rows[0]))


class Lifecycle(MirrorTest):
    """Rows never stay queued or running: the run id is noted for the workflow's
    always() step, which closes a row the job did not finish."""

    def test_the_run_id_is_noted_for_finalize(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "id")
            c = self.run_main(EXCEL_RUN_ID_FILE=path)
            self.assertEqual(open(path).read(), str(c.runs[0]["id"]))

    def test_the_run_id_note_defaults_to_the_runner_temp_directory(self):
        with tempfile.TemporaryDirectory() as d:
            c = self.run_main(RUNNER_TEMP=d, EXCEL_RUN_ID_FILE="")
            with open(os.path.join(d, "excel_run_id")) as f:
                self.assertEqual(f.read(), str(c.runs[0]["id"]))
            c.runs[0]["status"] = "running"                       # as if the job died after starting
            self.run_main(["--finalize", "--conclusion", "failure"], cloud_=c, RUNNER_TEMP=d, EXCEL_RUN_ID_FILE="")
            self.assertEqual(c.runs[0]["status"], "failed")

    def test_finalize_closes_a_row_left_running(self):
        c = cloud()
        c.runs.append({"id": 42, "trigger": "manual", "status": "running"})
        self.run_main(["--finalize", "--run-id", "42", "--conclusion", "cancelled"], cloud_=c)
        self.assertEqual(c.runs[0]["status"], "failed")
        self.assertIn("ended (cancelled)", c.runs[0]["error"])
        self.assertFalse(any("graph.microsoft" in x[1] for x in c.calls))

    def test_finalize_leaves_a_finished_row(self):
        import tempfile
        c = cloud()
        c.runs.append({"id": 43, "trigger": "scheduled", "status": "success", "error": None})
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "id")
            open(path, "w").write("43")
            self.run_main(["--finalize", "--conclusion", "failure"], cloud_=c, EXCEL_RUN_ID_FILE=path)
        self.assertEqual((c.runs[0]["status"], c.runs[0]["error"]), ("success", None))

    def test_finalize_without_a_row_does_nothing(self):
        c = self.run_main(["--finalize", "--conclusion", "failure"], EXCEL_RUN_ID_FILE="")
        self.assertEqual(c.calls, [])


class Gate(MirrorTest):
    NOW = datetime(2026, 11, 24, 2, 0, tzinfo=timezone.utc)

    def test_decision(self):
        due = lambda rows: xm.scheduled_run_due(rows, self.NOW)  # noqa: E731
        run = lambda **kw: {"trigger": "scheduled", "status": "success", "finished_at": "2026-11-23T19:35:00Z", **kw}  # noqa: E731
        self.assertTrue(due([]))
        self.assertFalse(due([run()]))                                       # Vercel's 19:30 run went through
        self.assertFalse(due([run(status="partial")]))
        self.assertTrue(due([run(status="failed")]))                         # a failed run is retried
        self.assertTrue(due([run(trigger="manual")]))                        # a button press is not the daily run
        self.assertTrue(due([run(finished_at="2026-11-23T05:00:00Z")]))      # 21 h ago
        self.assertTrue(due([run(finished_at=None)]))

    def test_only_githubs_schedule_is_gated(self):
        for event in ("workflow_dispatch", ""):
            self.assertEqual(xm.gate(event, self.NOW)[0], True)

    def test_gate_writes_its_output(self):
        import tempfile
        c = cloud()
        c.runs.append({"id": 1, "trigger": "scheduled", "status": "success",
                       "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            self.run_main(["--gate"], cloud_=c, GITHUB_EVENT_NAME="schedule", GITHUB_OUTPUT=out)
            self.assertEqual(open(out).read(), "run=false\n")
            self.run_main(["--gate"], cloud_=c, GITHUB_EVENT_NAME="workflow_dispatch", GITHUB_OUTPUT=out)
            self.assertEqual(open(out).read(), "run=false\nrun=true\n")
        self.assertFalse(any("graph.microsoft" in x[1] for x in c.calls))

    def test_gate_runs_when_the_log_cannot_be_read(self):
        c = cloud()
        c.supabase_down = True
        with mock.patch("requests.request", c.request):
            with mock.patch.dict(os.environ, env()):
                self.assertEqual(xm.gate("schedule", self.NOW)[0], True)


class WorkflowFile(unittest.TestCase):
    """.github/workflows/excel-mirror.yml (CI has no YAML parser: text checks)."""

    def setUp(self):
        self.text = (helpers.ROOT / ".github" / "workflows" / "excel-mirror.yml").read_text()

    def job(self, name):
        m = re.search(rf"^  {name}:\n(.*?)(?=^  [\w-]+:\n|\Z)", self.text, re.M | re.S)
        return m.group(1)

    def test_one_mirror_at_a_time_and_the_gate_outside_the_group(self):
        top = self.text[:self.text.index("\njobs:")]
        self.assertNotIn("concurrency:", top)
        gate, mirror = self.job("gate"), self.job("mirror")
        self.assertNotIn("concurrency", gate)
        self.assertIn("--gate", gate)
        self.assertIn("run: ${{ steps.gate.outputs.run }}", gate)
        self.assertIn("needs: gate", mirror)
        self.assertIn("if: ${{ needs.gate.outputs.run == 'true' }}", mirror)
        self.assertRegex(mirror, r"concurrency:\n\s+group: excel-mirror\n\s+cancel-in-progress: false")

    def test_the_last_step_always_closes_an_unfinished_row(self):
        mirror = self.job("mirror")
        last = mirror[mirror.rindex("- name:"):]
        self.assertIn("if: ${{ always() }}", last)
        self.assertIn("--finalize", last)
        self.assertIn("CONCLUSION: ${{ job.status }}", last)
        self.assertNotIn("${{ runner.", mirror[:mirror.index("steps:")])   # not allowed in a job's env

    def test_declares_the_dispatch_inputs(self):
        for name in ("trigger", "run_id", "dry_run", "check_only"):
            self.assertRegex(self.text, rf"\n      {name}:\n")
        self.assertIn("- cron: '30 19 * * *'", self.text)

    def test_env_and_secrets(self):
        for line in ("ENABLE_EXCEL_MIRROR: ${{ vars.ENABLE_EXCEL_MIRROR }}", "EXCEL_TARGETS: ${{ vars.EXCEL_TARGETS }}",
                     "EXCEL_TARGETS_DRYRUN: ${{ vars.EXCEL_TARGETS_DRYRUN }}", "SUPABASE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}",
                     "MSGRAPH_CLIENT_SECRET: ${{ secrets.MSGRAPH_CLIENT_SECRET }}", "uses: actions/setup-node@"):
            self.assertIn(line, self.text)

    def test_inputs_reach_the_shell_only_through_env(self):
        for line in self.text.splitlines():
            if "inputs." in line and "${{" in line:
                with self.subTest(line=line.strip()):
                    self.assertRegex(line.strip(), r"^[A-Z_]+: \$\{\{ inputs\.")


if __name__ == "__main__":
    unittest.main()
