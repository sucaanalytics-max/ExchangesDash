"""Shared valuation inputs: the team sign-in (dashboard/api/team-login.js and
_team_auth.js), the inputs API (dashboard/api/valuation-inputs.js) against a
stubbed Supabase, its validation against the dashboard's own rules, and the
dashboard's shared store (js/14-valuation.js): shared vs this-browser
fallback, merging a fetch with edits not yet saved, and the debounced save."""

import json
import subprocess
import unittest

from helpers import DASHBOARD, NODE, js_eval, js_source

API = DASHBOARD / "api"
ENV = {"TEAM_PASSWORD": "open sesame", "TEAM_SESSION_SECRET": "s" * 32,
       "SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SERVICE_KEY": "service-key"}

# Runs a sequence of handler calls in one Node process (so the login's in-memory
# failure count carries over) against an in-memory Supabase. Each step:
# {api, method, query, body, ip, cookie}; cookie is 'valid', 'tampered',
# 'expired', 'far' (expiry beyond one session), 'login' (the Set-Cookie of the
# last step that set one) or absent. Prints {out: [{status, body, headers}],
# calls: [{method, path, query, headers, body}], db: {rows, log}}.
RUNNER = r"""
const [dir, cfg] = [process.argv[1], JSON.parse(process.argv[2])];
for (const k of ['TEAM_PASSWORD', 'TEAM_SESSION_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) delete process.env[k];
Object.assign(process.env, cfg.env || {});
const auth = require(dir + '/_team_auth.js');
const db = { rows: cfg.rows || [], log: [] };
const calls = [];
// Like fetch's Response: json() parses the text and throws on an empty body
const reply = (status, body) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
};
const minimal = (opts, status, body) => /return=minimal/.test((opts.headers || {}).Prefer || '') ? reply(status) : reply(status, body);
global.fetch = async (url, opts = {}) => {
  const u = new URL(url), method = opts.method || 'GET';
  calls.push({ method, path: u.pathname, query: u.search, headers: opts.headers || {},
               body: opts.body ? JSON.parse(opts.body) : null });
  if (cfg.fail) return reply(500, { message: 'boom' });
  if (u.pathname === '/rest/v1/valuation_inputs' && method === 'GET') {
    const eq = u.searchParams.get('exchange');
    return reply(200, db.rows.filter(r => !eq || 'eq.' + r.exchange === eq));
  }
  if (u.pathname === '/rest/v1/valuation_inputs' && method === 'POST') {
    const body = JSON.parse(opts.body), list = Array.isArray(body) ? body : [body];
    list.forEach(r => {
      const i = db.rows.findIndex(x => x.exchange === r.exchange);
      const before = i >= 0 ? db.rows[i].inputs : {};
      if (i >= 0) db.rows[i] = { ...db.rows[i], ...r }; else db.rows.push(r);
      // valuation_inputs_log_change, the table's trigger (valuation_sync_schema.sql)
      const same = JSON.stringify(Object.entries(before).sort()) === JSON.stringify(Object.entries(r.inputs).sort());
      if (!same) db.log.push({ exchange: r.exchange, before, after: r.inputs, changed_by: r.updated_by });
    });
    return minimal(opts, 201, list);
  }
  if (u.pathname === '/rest/v1/empty') return reply(Number(u.searchParams.get('status')));
  return reply(404, { message: 'no route' });
};
const now = Math.floor(Date.now() / 1000), secret = process.env.TEAM_SESSION_SECRET || 'x';
let lastSet = null;
const cookieFor = c => {
  if (c === 'valid') return auth.signSession(now + 3600, secret);
  if (c === 'expired') return auth.signSession(now - 10, secret);
  if (c === 'far') return auth.signSession(now + 40 * 86400, secret);
  if (c === 'tampered') { const v = auth.signSession(now + 3600, secret); return v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A'); }
  if (c === 'other-secret') return auth.signSession(now + 3600, 'not the secret');
  if (c === 'login') return /team_session=([^;]*)/.exec(lastSet)[1];
  return c;
};
const out = [];
(async () => {
  for (const step of cfg.steps) {
    const handler = require(dir + '/' + step.api + '.js');
    const headers = { 'x-forwarded-for': step.ip || '203.0.113.9' };
    if (step.cookie) headers.cookie = 'theme=dark; team_session=' + cookieFor(step.cookie);
    const req = { method: step.method, headers, query: step.query || {}, body: step.body };
    const res = { code: 200, headers: {}, body: null,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.code = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; } };
    await handler(req, res);
    if (res.headers['set-cookie']) lastSet = res.headers['set-cookie'];
    out.push({ status: res.code, body: res.body, headers: res.headers });
  }
  process.stdout.write(JSON.stringify({ out, calls, db }));
})();
"""


def run(steps, env=None, rows=None, fail=False):
    cfg = {"env": ENV if env is None else env, "steps": steps, "rows": rows or [], "fail": fail}
    p = subprocess.run([NODE, "-e", RUNNER, str(API), json.dumps(cfg)], capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return json.loads(p.stdout)


def login(password, ip=None):
    return {"api": "team-login", "method": "POST", "body": {"password": password}, "ip": ip}


ROWS = [{"exchange": "bse", "inputs": {"pe1": 48, "adr": None}, "updated_at": "2026-11-20T10:00:00Z", "updated_by": "abc"},
        {"exchange": "nse", "inputs": {"from": "2025-01-01"}, "updated_at": "2026-11-21T10:00:00Z", "updated_by": "def"}]


@unittest.skipUnless(NODE, "needs node")
class TeamLogin(unittest.TestCase):
    def test_right_password_sets_a_session_cookie(self):
        r = run([login("open sesame")])["out"][0]
        self.assertEqual(r["status"], 204)
        cookie = r["headers"]["set-cookie"]
        self.assertRegex(cookie, r"^team_session=\d+\.[A-Za-z0-9_-]{43}; ")
        for part in ("HttpOnly", "Secure", "SameSite=Strict", "Path=/api", f"Max-Age={30 * 86400}"):
            self.assertIn(part, cookie)
        self.assertIn("no-store", r["headers"]["cache-control"])

    def test_body_may_be_a_json_string(self):
        r = run([{"api": "team-login", "method": "POST", "body": json.dumps({"password": "open sesame"})}])["out"][0]
        self.assertEqual(r["status"], 204)

    def test_wrong_password_is_401(self):
        r = run([login("guess")])["out"][0]
        self.assertEqual(r["status"], 401)
        self.assertNotIn("set-cookie", r["headers"])

    def test_five_failures_from_one_ip_lock_it_out(self):
        out = run([login("guess")] * 5 + [login("open sesame"), login("open sesame", ip="198.51.100.1")])["out"]
        self.assertEqual([o["status"] for o in out], [401] * 5 + [429, 204])
        self.assertIn("retry-after", out[5]["headers"])

    def test_missing_env_fails_closed(self):
        for env in ({}, {"TEAM_PASSWORD": "open sesame"}, {"TEAM_SESSION_SECRET": "s" * 32}):
            with self.subTest(env=env):
                self.assertEqual(run([login("open sesame")], env=env)["out"][0]["status"], 503)

    def test_logout_expires_the_cookie(self):
        r = run([{"api": "team-login", "method": "POST", "query": {"logout": "1"}, "cookie": "valid"}])["out"][0]
        self.assertEqual(r["status"], 204)
        self.assertRegex(r["headers"]["set-cookie"], r"^team_session=; .*Max-Age=0")

    def test_get_says_whether_signed_in(self):
        out = run([{"api": "team-login", "method": "GET"},
                   login("open sesame"),
                   {"api": "team-login", "method": "GET", "cookie": "login"}])["out"]
        self.assertEqual(out[0]["status"], 200)
        self.assertFalse(out[0]["body"]["signed_in"])
        self.assertTrue(out[2]["body"]["signed_in"])
        self.assertIn("no-store", out[0]["headers"]["cache-control"])

    def test_bad_sessions_are_refused(self):
        for cookie in ("tampered", "expired", "far", "other-secret", "garbage", "1.2"):
            with self.subTest(cookie=cookie):
                r = run([{"api": "team-login", "method": "GET", "cookie": cookie}])["out"][0]
                self.assertFalse(r["body"]["signed_in"])

    def test_other_methods_are_405(self):
        self.assertEqual(run([{"api": "team-login", "method": "DELETE"}])["out"][0]["status"], 405)


def put(exchange, inputs, cookie="valid"):
    return {"api": "valuation-inputs", "method": "PUT", "body": {"exchange": exchange, "inputs": inputs}, "cookie": cookie}


GET = {"api": "valuation-inputs", "method": "GET"}


@unittest.skipUnless(NODE, "needs node")
class ValuationInputsApi(unittest.TestCase):
    def test_get_merges_rows_per_exchange(self):
        got = run([GET, {**GET, "cookie": "valid"}], rows=ROWS)
        r = got["out"][0]
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["headers"]["cache-control"], "no-store")
        self.assertEqual(r["body"]["inputs"], {"bse": {"pe1": 48, "adr": None}, "mcx": {}, "nse": {"from": "2025-01-01"}})
        self.assertEqual(r["body"]["updated_at"], {"bse": "2026-11-20T10:00:00Z", "mcx": None, "nse": "2026-11-21T10:00:00Z"})
        self.assertIs(r["body"]["configured"], True)
        self.assertIs(r["body"]["signed_in"], False)
        self.assertIs(got["out"][1]["body"]["signed_in"], True)
        # Service-role key on every Supabase call
        for c in got["calls"]:
            self.assertEqual(c["headers"]["apikey"], "service-key")
            self.assertEqual(c["headers"]["Authorization"], "Bearer service-key")

    def test_missing_env_is_503(self):
        for env in ({"TEAM_PASSWORD": "p", "TEAM_SESSION_SECRET": "s" * 32},
                    {**ENV, "SUPABASE_SERVICE_KEY": ""}):
            got = run([GET, put("bse", {"pe1": 50})], env=env)
            for r in got["out"]:
                self.assertEqual(r["status"], 503)
                self.assertIs(r["body"]["configured"], False)
                self.assertEqual(r["headers"]["cache-control"], "no-store")
            self.assertEqual(got["calls"], [])

    def test_supabase_failure_is_502(self):
        r = run([GET], fail=True)["out"][0]
        self.assertEqual(r["status"], 502)

    def test_put_needs_a_session(self):
        for cookie in (None, "tampered", "expired"):
            with self.subTest(cookie=cookie):
                got = run([put("bse", {"pe1": 50}, cookie=cookie)], rows=ROWS)
                self.assertEqual(got["out"][0]["status"], 401)
                self.assertEqual([c for c in got["calls"] if c["method"] != "GET"], [])

    def test_put_rejects_bad_keys_and_values(self):
        cases = [
            ({"exchange": "lse", "inputs": {"pe1": 50}}, ["exchange"]),
            ({"exchange": "bse", "inputs": {"pe1": 50, "days": 300}}, ["days"]),
            ({"exchange": "bse", "inputs": {"pe1": 0, "w0": -1, "g": -100, "adr": 0}}, ["adr", "g", "pe1", "w0"]),
            ({"exchange": "bse", "inputs": {"pe2": "48", "from": "2025-02-30"}}, ["from", "pe2"]),
            ({"exchange": "bse", "inputs": {"from": "2999-01-01"}}, ["from"]),
            ({"exchange": "bse", "inputs": [1, 2]}, ["inputs"]),
            ({"exchange": "bse"}, ["inputs"]),
        ]
        steps = [{"api": "valuation-inputs", "method": "PUT", "body": b, "cookie": "valid"} for b, _ in cases]
        got = run(steps, rows=ROWS)
        for (body, bad), r in zip(cases, got["out"]):
            with self.subTest(body=body):
                self.assertEqual(r["status"], 400)
                self.assertEqual(sorted(r["body"]["bad"]), bad)
        self.assertEqual([c for c in got["calls"] if c["method"] != "GET"], [])
        self.assertEqual(got["db"]["rows"], ROWS)

    def test_put_upserts_and_the_trigger_logs(self):
        got = run([put("bse", {"pe1": 50, "w0": 40, "adr": None})], rows=json.loads(json.dumps(ROWS)))
        r = got["out"][0]
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["headers"]["cache-control"], "no-store")
        self.assertEqual(r["body"]["inputs"]["bse"], {"pe1": 50, "w0": 40, "adr": None})
        self.assertEqual(r["body"]["inputs"]["nse"], {"from": "2025-01-01"})
        self.assertIs(r["body"]["signed_in"], True)

        # One upsert, then the read for the answer: no separate before-read or log insert
        self.assertEqual([(c["method"], c["path"]) for c in got["calls"]],
                         [("POST", "/rest/v1/valuation_inputs"), ("GET", "/rest/v1/valuation_inputs")])
        upsert = got["calls"][0]
        self.assertEqual(upsert["query"], "?on_conflict=exchange")
        self.assertIn("resolution=merge-duplicates", upsert["headers"]["Prefer"])
        row = upsert["body"][0] if isinstance(upsert["body"], list) else upsert["body"]
        self.assertEqual(row["exchange"], "bse")
        self.assertEqual(row["inputs"], {"pe1": 50, "w0": 40, "adr": None})
        self.assertRegex(row["updated_by"], r"^[0-9a-f]{12}$")
        self.assertEqual(got["db"]["log"], [{"exchange": "bse", "before": {"pe1": 48, "adr": None},
                                             "after": {"pe1": 50, "w0": 40, "adr": None}, "changed_by": row["updated_by"]}])

    def test_put_on_a_new_exchange(self):
        got = run([put("mcx", {"g": 4})], rows=json.loads(json.dumps(ROWS)))
        self.assertEqual(got["out"][0]["status"], 200)
        self.assertEqual(got["out"][0]["body"]["inputs"]["mcx"], {"g": 4})
        self.assertEqual(got["db"]["log"][0]["before"], {})

    def test_an_empty_supabase_answer_is_not_an_error(self):
        """PostgREST answers return=minimal writes 201 and deletes 204 with no body:
        reading that as JSON threw, and every save answered 502 after writing."""
        script = (RUNNER.split("const now = ")[0] +
                  f"const {{ sb }} = require({json.dumps(str(API / 'valuation-inputs.js'))});\n"
                  "(async () => process.stdout.write(JSON.stringify([await sb('empty?status=201'), await sb('empty?status=204'),"
                  " await sb('valuation_inputs?on_conflict=exchange', { method: 'POST', headers: { Prefer: 'return=minimal' },"
                  " body: JSON.stringify([{ exchange: 'bse', inputs: {}, updated_by: 'x' }]) })])))();")
        p = subprocess.run([NODE, "-e", script, str(API), json.dumps({"env": ENV})], capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(p.stderr)
        self.assertEqual(json.loads(p.stdout), [None, None, None])

    def test_body_may_be_a_json_string(self):
        step = {"api": "valuation-inputs", "method": "PUT", "cookie": "valid",
                "body": json.dumps({"exchange": "nse", "inputs": {}})}
        got = run([step], rows=json.loads(json.dumps(ROWS)))
        self.assertEqual(got["out"][0]["status"], 200)
        self.assertEqual(got["out"][0]["body"]["inputs"]["nse"], {})

    def test_other_methods_are_405(self):
        self.assertEqual(run([{"api": "valuation-inputs", "method": "DELETE", "cookie": "valid"}])["out"][0]["status"], 405)


class Schema(unittest.TestCase):
    SQL = (API.parent.parent / "valuation_sync_schema.sql").read_text()

    def test_log_is_written_by_a_trigger(self):
        self.assertRegex(self.SQL, r"create trigger valuation_inputs_log_change\s+after insert or update on public\.valuation_inputs")
        self.assertIn("old.inputs", self.SQL)
        self.assertIn("new.updated_by", self.SQL)
        self.assertRegex(self.SQL, r"is not distinct from")   # unchanged: no log row

    def test_service_role_only(self):
        for t in ("valuation_inputs", "valuation_inputs_log", "excel_sync_runs"):
            self.assertIn(f"alter table public.{t}", self.SQL)
        self.assertNotIn("create policy", self.SQL)


# Values for the parity check (latest-date bound aside: the server has no data dates)
PARITY = [("adr", v) for v in (None, 0, -1, 0.01, 72.5, "70", True)] \
    + [("g", v) for v in (-100, -99.9, 0, 4.5, None, "3")] \
    + [(k, v) for k in ("pe0", "pe1", "pe2") for v in (0, -5, 0.1, 48, None, "48")] \
    + [(k, v) for k in ("w0", "w1", "w2") for v in (-0.01, 0, 45, 100, None)] \
    + [("from", v) for v in (None, "2025-01-01", "1899-12-31", "1900-01-01", "2025-02-30", "2025-1-1", "", 20250101, "2024-02-29")]


@unittest.skipUnless(NODE, "needs node")
class ValidationParity(unittest.TestCase):
    def test_server_rules_match_the_dashboard(self):
        script = (f"const {{ validateInputs }} = require({json.dumps(str(API / 'valuation-inputs.js'))});\n"
                  f"const cases = {json.dumps(PARITY)};\n"
                  "process.stdout.write(JSON.stringify(cases.map(([k, v]) => validateInputs({ [k]: v }).length === 0)));")
        p = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
        if p.returncode:
            raise RuntimeError(p.stderr)
        server = json.loads(p.stdout)
        page = js_eval(["valuationNum", "valuationIsoDate", "valuationInputOk"],
                       "DATA.map(([k, v]) => valuationInputOk(k, v))", PARITY)
        for (k, v), s, d in zip(PARITY, server, page):
            with self.subTest(key=k, value=v):
                self.assertEqual(s, d)

    def test_server_keys_match_the_dashboard(self):
        script = (f"const m = require({json.dumps(str(API / 'valuation-inputs.js'))});\n"
                  "process.stdout.write(JSON.stringify([m.EXCHANGES, m.EDITABLE]));")
        p = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True, check=True)
        exchanges, editable = json.loads(p.stdout)
        self.assertEqual(exchanges, js_eval(["VALUATION_EXCHANGES"], "VALUATION_EXCHANGES"))
        self.assertEqual(editable, js_eval(["VALUATION_EDITABLE"], "VALUATION_EDITABLE"))


# The dashboard's shared store, lifted out of js/14-valuation.js with a short
# save delay; `body` is an async function body returning its result.
STORE_JS = ["valuationNum", "valuationIsoDate", "valuationInputOk", "VALUATION_EXCHANGES", "VALUATION_EDITABLE",
            "VALUATION_STORAGE_KEY", "VALUATION_SHARED_CACHE_KEY",
            "VALUATION_SHARED", "valuationPlainObject", "readLocalValuationOverrides", "writeLocalValuationOverrides",
            "readSharedValuationCache", "writeSharedValuationCache", "valuationCleanOverrides", "valuationSameInput",
            "valuationUnpublishedKeys", "valuationUnpublished", "valuationPutOne", "valuationSavePass", "valuationSendOnLeave",
            "valuationPublishLocal", "valuationDiscardLocal", "valuationTeamSignOut",
            "readValuationOverrides", "writeValuationOverrides", "valuationCanEdit", "valuationSameOverrides",
            "valuationChangedExchanges", "valuationMergeShared", "valuationSharedNotify", "valuationApplyShared",
            "loadSharedValuationInputs", "valuationScheduleSave", "valuationFlushSaves"]


def store(body, data=None):
    code = "\n".join(js_source(n) for n in STORE_JS)
    script = (f"const DATA = {json.dumps(data)};\nconst VALUATION_SAVE_DELAY_MS = 20;\n"
              "const mem = {};\n"
              "globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; } };\n"
              "const sleep = ms => new Promise(r => setTimeout(r, ms));\n"
              f"{code}\n"
              f"(async () => {{ {body} }})().then(r => process.stdout.write(JSON.stringify(r)));")
    p = subprocess.run([NODE, "-"], input=script, capture_output=True, text=True)
    if p.returncode:
        raise RuntimeError(p.stderr)
    return json.loads(p.stdout)


SHARED = {"configured": True, "signed_in": False, "inputs": {"bse": {"pe1": 48}, "mcx": {}, "nse": {}},
          "updated_at": {"bse": "2026-11-20T10:00:00Z", "mcx": None, "nse": None}}


@unittest.skipUnless(NODE, "needs node")
class SharedStore(unittest.TestCase):
    def test_falls_back_to_this_browser_when_the_api_is_missing(self):
        got = store("""
          mem.valuation_inputs_v1 = JSON.stringify({ mcx: { g: 7 } });
          const out = { before: readValuationOverrides(), mode0: VALUATION_SHARED.mode };
          const urls = [];
          globalThis.fetch = async url => { urls.push(url); return { ok: false, status: 404, json: async () => { throw new Error('html'); } }; };
          await loadSharedValuationInputs();
          out.mode = VALUATION_SHARED.mode;
          out.after = readValuationOverrides();
          out.canEdit = valuationCanEdit();
          out.urls = urls;
          return out;""")
        self.assertEqual(got["before"], {"mcx": {"g": 7}})   # rendered from the cache before the API answers
        self.assertEqual(got["mode0"], "pending")
        self.assertEqual((got["mode"], got["after"], got["canEdit"]), ("local", {"mcx": {"g": 7}}, True))
        self.assertEqual(got["urls"], ["/api/valuation-inputs"])   # no cache-busting query

    def test_unconfigured_api_means_local(self):
        got = store("""
          globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ error: 'x', configured: false }) });
          await loadSharedValuationInputs();
          return VALUATION_SHARED.mode;""")
        self.assertEqual(got, "local")

    def test_shared_inputs_win_and_are_cached(self):
        got = store("""
          mem.valuation_inputs_v1 = JSON.stringify({ mcx: { g: 7 } });
          let n = 0;
          globalThis.fetch = async () => { n++; await sleep(5); return { ok: true, status: 200, json: async () => DATA }; };
          await Promise.all([loadSharedValuationInputs(), loadSharedValuationInputs()]);   // one request in flight
          return { n, mode: VALUATION_SHARED.mode, o: readValuationOverrides(), cached: JSON.parse(mem.valuation_inputs_shared_v1),
                   local: JSON.parse(mem.valuation_inputs_v1),
                   canEdit: valuationCanEdit(), written: writeValuationOverrides({ bse: { pe1: 50 } }), after: readValuationOverrides() };""",
            SHARED)
        self.assertEqual(got["n"], 1)
        self.assertEqual(got["mode"], "shared")
        self.assertEqual(got["o"], {"bse": {"pe1": 48}})
        self.assertEqual(got["cached"], {"bse": {"pe1": 48}})   # the shared mirror has its own key
        self.assertEqual(got["local"], {"mcx": {"g": 7}})        # this browser's own edits are kept
        # Signed out: read-only, the write is refused
        self.assertEqual((got["canEdit"], got["written"], got["after"]), (False, False, {"bse": {"pe1": 48}}))

    def test_a_fetch_keeps_edits_not_yet_saved(self):
        got = js_eval(["VALUATION_EXCHANGES", "valuationPlainObject", "valuationMergeShared"],
                      "valuationMergeShared(DATA.server, DATA.local, { bse: true })",
                      {"server": {"bse": {"pe1": 48}, "mcx": {"g": 3}, "nse": {}},
                       "local": {"bse": {"pe1": 52}, "mcx": {"g": 9}}})
        self.assertEqual(got, {"bse": {"pe1": 52}, "mcx": {"g": 3}})

    def test_changed_exchanges(self):
        got = js_eval(["VALUATION_EXCHANGES", "valuationPlainObject", "valuationSameOverrides", "valuationChangedExchanges"],
                      "valuationChangedExchanges(DATA[0], DATA[1])",
                      [{"bse": {"pe1": 48, "adr": None}, "mcx": {"g": 3}},
                       {"bse": {"adr": None, "pe1": 48}, "nse": {"w0": 40}}])
        self.assertEqual(got, ["mcx", "nse"])

    def test_edits_save_once_after_typing_stops(self):
        got = store("""
          const puts = [], server = JSON.parse(JSON.stringify(DATA.inputs));
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              const b = JSON.parse(opts.body);
              puts.push({ url, b });
              server[b.exchange] = b.inputs;
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true,
                inputs: JSON.parse(JSON.stringify(server)), updated_at: { ...DATA.updated_at, [b.exchange]: '2026-11-23T09:00:00Z' } }) };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          const states = [];
          writeValuationOverrides({ bse: { pe1: 49 } });
          states.push(VALUATION_SHARED.status.state);
          writeValuationOverrides({ bse: { pe1: 50 } });
          writeValuationOverrides({ bse: { pe1: 51 }, nse: { w0: 40 } });
          const early = puts.length;
          await sleep(80);
          return { early, puts, states, final: VALUATION_SHARED.status.state, o: readValuationOverrides(),
                   pending: VALUATION_SHARED.pending, cached: JSON.parse(mem.valuation_inputs_shared_v1),
                   local: mem.valuation_inputs_v1 ?? null };""", SHARED)
        self.assertEqual(got["early"], 0)
        self.assertEqual(got["states"], ["saving"])
        self.assertEqual(sorted((p["b"]["exchange"], json.dumps(p["b"]["inputs"])) for p in got["puts"]),
                         [("bse", '{"pe1": 51}'), ("nse", '{"w0": 40}')])
        self.assertTrue(all(p["url"] == "/api/valuation-inputs" for p in got["puts"]))
        self.assertEqual(got["final"], "saved")
        self.assertEqual(got["o"], {"bse": {"pe1": 51}, "nse": {"w0": 40}})
        self.assertEqual(got["cached"], got["o"])
        self.assertIsNone(got["local"])
        self.assertEqual(got["pending"], {})

    def test_a_failed_save_keeps_the_edit_and_retries(self):
        got = store("""
          let fail = true, puts = 0;
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              puts++;
              if (fail) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
              const b = JSON.parse(opts.body);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, [b.exchange]: b.inputs } }) };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 55 } });
          await sleep(60);
          const failed = { state: VALUATION_SHARED.status.state, o: readValuationOverrides(), pending: { ...VALUATION_SHARED.pending } };
          // A refresh while the edit is unsaved keeps it
          await loadSharedValuationInputs();
          failed.afterRefresh = readValuationOverrides();
          fail = false;
          await valuationFlushSaves();
          return { failed, puts, state: VALUATION_SHARED.status.state, pending: VALUATION_SHARED.pending, o: readValuationOverrides() };""",
            SHARED)
        self.assertEqual(got["failed"]["state"], "error")
        self.assertEqual(got["failed"]["o"], {"bse": {"pe1": 55}})
        self.assertEqual(got["failed"]["pending"], {"bse": True})
        self.assertEqual(got["failed"]["afterRefresh"], {"bse": {"pe1": 55}})
        self.assertEqual((got["puts"], got["state"], got["pending"], got["o"]), (2, "saved", {}, {"bse": {"pe1": 55}}))

    def test_an_expired_session_on_save_signs_out(self):
        got = store("""
          globalThis.fetch = async (url, opts = {}) => opts.method === 'PUT'
            ? { ok: false, status: 401, json: async () => ({ error: 'Sign in to edit' }) }
            : { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 60 } });
          await sleep(60);
          return { state: VALUATION_SHARED.status.state, signedIn: VALUATION_SHARED.signedIn, pending: { ...VALUATION_SHARED.pending } };""",
            SHARED)
        self.assertEqual((got["state"], got["signedIn"], got["pending"]), ("error", False, {"bse": True}))

    def test_renders_from_the_shared_mirror_before_the_api_answers(self):
        got = store("""
          mem.valuation_inputs_v1 = JSON.stringify({ mcx: { g: 7 } });
          mem.valuation_inputs_shared_v1 = JSON.stringify({ bse: { pe1: 48 } });
          const pending = readValuationOverrides();
          globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
          await loadSharedValuationInputs();
          return { pending, local: readValuationOverrides() };""")
        self.assertEqual(got, {"pending": {"bse": {"pe1": 48}}, "local": {"mcx": {"g": 7}}})

    def test_no_write_before_the_first_answer(self):
        got = store("""
          const ok = writeValuationOverrides({ bse: { pe1: 50 } });
          return { ok, stored: mem.valuation_inputs_v1 ?? null, shared: mem.valuation_inputs_shared_v1 ?? null };""")
        self.assertEqual(got, {"ok": False, "stored": None, "shared": None})

    def test_a_get_answering_mid_put_keeps_the_edit(self):
        """A GET read before the PUT landed must not put the old value back."""
        got = store("""
          let server = JSON.parse(JSON.stringify(DATA.inputs));
          const answer = () => ({ ...DATA, signed_in: true, inputs: JSON.parse(JSON.stringify(server)) });
          let getDelay = 0;
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              await sleep(30);
              const b = JSON.parse(opts.body);
              server[b.exchange] = b.inputs;
              return { ok: true, status: 200, json: async () => answer() };
            }
            const snap = answer();   // read when the GET reaches the server
            await sleep(getDelay);
            return { ok: true, status: 200, json: async () => snap };
          };
          await loadSharedValuationInputs();
          const out = {};
          // 1. A GET that answers while the PUT is in flight
          writeValuationOverrides({ bse: { pe1: 60 } });
          const put1 = valuationFlushSaves();
          getDelay = 10;
          await sleep(5);
          await loadSharedValuationInputs();
          out.midPut = readValuationOverrides();
          await put1;
          out.afterPut = readValuationOverrides();
          // 2. A GET sent before the PUT that answers after it
          getDelay = 60;
          const get2 = loadSharedValuationInputs();
          await sleep(5);
          writeValuationOverrides({ bse: { pe1: 61 } });
          await valuationFlushSaves();
          out.putDone = readValuationOverrides();
          await get2;
          out.afterStaleGet = readValuationOverrides();
          out.server = server;
          out.pending = { ...VALUATION_SHARED.pending };
          return out;""", SHARED)
        self.assertEqual(got["midPut"], {"bse": {"pe1": 60}})
        self.assertEqual(got["afterPut"], {"bse": {"pe1": 60}})
        self.assertEqual(got["putDone"], {"bse": {"pe1": 61}})
        self.assertEqual(got["afterStaleGet"], {"bse": {"pe1": 61}})
        self.assertEqual(got["server"]["bse"], {"pe1": 61})
        self.assertEqual(got["pending"], {})

    def test_an_edit_during_a_put_is_sent_next(self):
        got = store("""
          const sent = [];
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              const b = JSON.parse(opts.body);
              sent.push(b.inputs.pe1);
              await sleep(30);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, bse: b.inputs } }) };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 60 } });
          const p = valuationFlushSaves();
          await sleep(10);
          writeValuationOverrides({ bse: { pe1: 62 } });   // while 60 is in flight
          await p;
          const mid = readValuationOverrides();
          await sleep(80);
          return { sent, mid, o: readValuationOverrides(), pending: { ...VALUATION_SHARED.pending } };""", SHARED)
        self.assertEqual(got["mid"], {"bse": {"pe1": 62}})
        self.assertEqual(got["sent"], [60, 62])
        self.assertEqual((got["o"], got["pending"]), ({"bse": {"pe1": 62}}, {}))

    def test_leaving_the_page_sends_with_keepalive(self):
        got = store("""
          const puts = [];
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') { puts.push(!!opts.keepalive); return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) }; }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 70 } });
          await valuationFlushSaves({ keepalive: true });
          await sleep(60);   // the debounce timer was cancelled: nothing more is sent
          return puts;""", SHARED)
        self.assertEqual(got, [True])

    def test_sign_out_saves_first(self):
        got = store("""
          const calls = [];
          let failPut = false;
          globalThis.fetch = async (url, opts = {}) => {
            calls.push(`${opts.method || 'GET'} ${url}`);
            if (opts.method === 'PUT') return failPut ? { ok: false, status: 500, json: async () => ({ error: 'boom' }) }
              : { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, bse: JSON.parse(opts.body).inputs } }) };
            if (url.startsWith('/api/team-login')) return { ok: true, status: 204, json: async () => { throw new Error('empty'); } };
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 71 } });
          const ok = await valuationTeamSignOut();
          const out = { ok, calls: calls.slice(1), signedIn: VALUATION_SHARED.signedIn };
          // A save that fails holds the sign-out back, unless forced
          VALUATION_SHARED.signedIn = true;
          failPut = true;
          writeValuationOverrides({ bse: { pe1: 72 } });
          out.held = await valuationTeamSignOut();
          out.heldSignedIn = VALUATION_SHARED.signedIn;
          out.forced = await valuationTeamSignOut({ force: true });
          out.forcedSignedIn = VALUATION_SHARED.signedIn;
          out.pendingAfter = { ...VALUATION_SHARED.pending };
          return out;""", SHARED)
        self.assertEqual(got["calls"], ["PUT /api/valuation-inputs", "POST /api/team-login?logout=1"])
        self.assertEqual((got["ok"], got["signedIn"]), (True, False))
        self.assertEqual((got["held"], got["heldSignedIn"]), (False, True))
        self.assertEqual((got["forced"], got["forcedSignedIn"], got["pendingAfter"]), (True, False, {}))

    def test_unpublished_browser_edits(self):
        got = js_eval(["valuationNum", "valuationIsoDate", "valuationInputOk", "VALUATION_EXCHANGES", "VALUATION_EDITABLE",
                       "valuationPlainObject", "valuationSameOverrides", "valuationCleanOverrides", "valuationSameInput",
                       "valuationUnpublishedKeys", "valuationUnpublished"],
                      "[valuationUnpublished(DATA.local, DATA.shared), valuationCleanOverrides(DATA.local.mcx)]",
                      {"local": {"bse": {"pe1": 48}, "mcx": {"g": 9, "days": 300, "pe0": -1}, "nse": {}},
                       "shared": {"bse": {"pe1": 48}, "nse": {"w0": 40}}})
        # nse has no browser edits, so its shared ones are not offered for replacement;
        # unusable or fixed keys are dropped
        self.assertEqual(got, [["mcx"], {"g": 9}])

    def test_publish_and_discard_browser_edits(self):
        got = store("""
          mem.valuation_inputs_v1 = JSON.stringify({ mcx: { g: 9 }, bse: { pe1: 48 } });
          const puts = [];
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              const b = JSON.parse(opts.body);
              puts.push(b);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, [b.exchange]: b.inputs } }) };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          const before = valuationUnpublished(readLocalValuationOverrides(), readValuationOverrides());
          const left = await valuationPublishLocal();
          const out = { before, left, puts, o: readValuationOverrides(), local: JSON.parse(mem.valuation_inputs_v1) };
          globalThis.confirm = () => true;
          mem.valuation_inputs_v1 = JSON.stringify({ nse: { g: 2 } });
          out.discarded = valuationDiscardLocal();
          out.localAfter = mem.valuation_inputs_v1 ?? null;
          return out;""", SHARED)
        self.assertEqual(got["before"], ["mcx"])
        self.assertEqual(got["puts"], [{"exchange": "mcx", "inputs": {"g": 9}}])
        self.assertEqual(got["left"], [])
        self.assertEqual(got["o"], {"bse": {"pe1": 48}, "mcx": {"g": 9}})
        self.assertEqual(got["local"], {"bse": {"pe1": 48}})   # published exchanges leave this browser's store
        self.assertEqual((got["discarded"], got["localAfter"]), (True, None))

    def test_unpublished_compares_only_this_browsers_keys(self):
        names = ["valuationNum", "valuationIsoDate", "valuationInputOk", "VALUATION_EXCHANGES", "VALUATION_EDITABLE",
                 "valuationPlainObject", "valuationCleanOverrides", "valuationSameInput", "valuationUnpublishedKeys"]
        got = js_eval(names, "valuationUnpublishedKeys(DATA.local, DATA.shared, DATA.defaults)", {
            "local": {"bse": {"pe1": 51}, "mcx": {"g": 3}, "nse": {"adr": 70}},
            "shared": {"bse": {"adr": 20, "pe1": 48}, "nse": {"adr": 70, "w0": 40}},
            "defaults": {"ex": {"bse": {"pe1": 45, "adr": None}, "mcx": {"g": 3}, "nse": {"adr": None}}}})
        # mcx: equal to the default the shared inputs leave in place; nse: the one local key matches
        self.assertEqual(got, {"bse": ["pe1"]})

    def test_publish_merges_onto_the_shared_exchange(self):
        got = store("""
          mem.valuation_inputs_v1 = JSON.stringify({ bse: { pe1: 51, pe0: 40 }, mcx: { g: 3 } });
          const puts = [];
          let server = { bse: { adr: 20 }, mcx: { w0: 30 }, nse: {} };
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              const b = JSON.parse(opts.body);
              puts.push(b);
              server = { ...server, [b.exchange]: b.inputs };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: server }) };
          };
          await loadSharedValuationInputs();
          // pe0 40 is the default: it adds nothing to the shared exchange; mcx g 3 is the default too
          const defaults = { ex: { bse: { adr: null, pe0: 40, pe1: 45 }, mcx: { g: 3, w0: 25 }, nse: {} } };
          const left = await valuationPublishLocal(defaults);
          return { left, puts, o: readValuationOverrides(), local: mem.valuation_inputs_v1 ?? null };""", SHARED)
        self.assertEqual(got["puts"], [{"exchange": "bse", "inputs": {"adr": 20, "pe1": 51}}])
        self.assertEqual(got["left"], [])
        self.assertEqual(got["o"], {"bse": {"adr": 20, "pe1": 51}, "mcx": {"w0": 30}})
        self.assertEqual(got["local"], '{"mcx":{"g":3}}')   # published exchanges leave this browser's store

    def test_sign_out_while_a_put_is_in_flight(self):
        """Signing out within a second of typing, while the first PUT is still out:
        the second edit is sent after it, then the sign-out, with no false failure."""
        got = store("""
          const calls = [];
          globalThis.fetch = async (url, opts = {}) => {
            const m = opts.method || 'GET';
            if (m === 'PUT') {
              const b = JSON.parse(opts.body);
              calls.push(`PUT ${b.inputs.pe1}`);
              await sleep(40);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, bse: b.inputs } }) };
            }
            if (url.startsWith('/api/team-login')) { calls.push('logout'); return { ok: true, status: 204, json: async () => { throw new Error('empty'); } }; }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 60 } });
          await sleep(30);                                   // the debounced PUT (20 ms) is in flight
          writeValuationOverrides({ bse: { pe1: 61 } });
          const ok = await valuationTeamSignOut();
          return { ok, calls, signedIn: VALUATION_SHARED.signedIn, pending: { ...VALUATION_SHARED.pending } };""", SHARED)
        self.assertEqual(got["calls"], ["PUT 60", "PUT 61", "logout"])
        self.assertEqual((got["ok"], got["signedIn"], got["pending"]), (True, False, {}))

    def test_flush_resolves_only_when_quiet(self):
        got = store("""
          let n = 0;
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') {
              n++;
              await sleep(20);
              const b = JSON.parse(opts.body);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs, [b.exchange]: b.inputs } }) };
            }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 60 } });
          const first = valuationFlushSaves();
          await sleep(5);
          writeValuationOverrides({ bse: { pe1: 61 } });
          const second = valuationFlushSaves();   // while the first pass is out
          const res = await second;
          return { res, n, pending: { ...VALUATION_SHARED.pending }, saving: !!VALUATION_SHARED.saving, first: await first };""", SHARED)
        self.assertEqual((got["res"], got["n"], got["pending"], got["saving"], got["first"]), (True, 2, {}, False, True))

    def test_leaving_sends_every_pending_exchange_at_once(self):
        got = store("""
          const puts = [];
          globalThis.fetch = async (url, opts = {}) => {
            if (opts.method === 'PUT') { puts.push([JSON.parse(opts.body).exchange, !!opts.keepalive]); await sleep(10);
              return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true, inputs: { ...DATA.inputs } }) }; }
            return { ok: true, status: 200, json: async () => ({ ...DATA, signed_in: true }) };
          };
          await loadSharedValuationInputs();
          writeValuationOverrides({ bse: { pe1: 60 }, mcx: { g: 5 }, nse: { w0: 30 } });
          valuationSendOnLeave();
          const sync = puts.slice();   // issued before anything awaited
          await sleep(60);
          return { sync, total: puts.length };""", SHARED)
        self.assertEqual(got["sync"], [["bse", True], ["mcx", True], ["nse", True]])
        self.assertEqual(got["total"], 3)   # the debounce timer was cancelled

    def test_unpublished_notice_lists_the_keys(self):
        names = ["valuationNum", "valuationIsoDate", "valuationInputOk", "VALUATION_EXCHANGES", "VALUATION_EDITABLE",
                 "VALUATION_INPUT_LABELS", "SHARE_EXCHANGE_NAMES", "valuationPlainObject", "valuationCleanOverrides",
                 "valuationSameInput", "valuationUnpublishedKeys", "valuationUnpublishedText"]
        got = js_eval(names, "valuationUnpublishedText(DATA.local, DATA.shared, DATA.defaults)", {
            "local": {"bse": {"pe1": 51, "adr": None}, "nse": {"g": 4}},
            "shared": {"bse": {"pe1": 48, "adr": 20}},
            "defaults": {"ex": {"bse": {"pe1": 45, "adr": None}, "nse": {"g": 3}}}})
        self.assertEqual(got, "BSE (ADR estimate blank vs shared 20; P/E base 51 vs shared 48), NSE (QoQ ADR growth 4 vs shared 3)")


if __name__ == "__main__":
    unittest.main()
