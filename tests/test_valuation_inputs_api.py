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
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status,
  json: async () => body, text: async () => JSON.stringify(body) });
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
      if (i >= 0) db.rows[i] = { ...db.rows[i], ...r }; else db.rows.push(r);
    });
    return reply(201, list);
  }
  if (u.pathname === '/rest/v1/valuation_inputs_log' && method === 'POST') {
    const body = JSON.parse(opts.body);
    (Array.isArray(body) ? body : [body]).forEach(r => db.log.push(r));
    return reply(201, null);
  }
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

    def test_put_upserts_and_logs_before_and_after(self):
        got = run([put("bse", {"pe1": 50, "w0": 40, "adr": None})], rows=json.loads(json.dumps(ROWS)))
        r = got["out"][0]
        self.assertEqual(r["status"], 200)
        self.assertEqual(r["headers"]["cache-control"], "no-store")
        self.assertEqual(r["body"]["inputs"]["bse"], {"pe1": 50, "w0": 40, "adr": None})
        self.assertEqual(r["body"]["inputs"]["nse"], {"from": "2025-01-01"})
        self.assertIs(r["body"]["signed_in"], True)

        writes = [c for c in got["calls"] if c["method"] != "GET"]
        self.assertEqual([(c["method"], c["path"]) for c in writes],
                         [("POST", "/rest/v1/valuation_inputs"), ("POST", "/rest/v1/valuation_inputs_log")])
        upsert, log = writes
        self.assertEqual(upsert["query"], "?on_conflict=exchange")
        self.assertIn("resolution=merge-duplicates", upsert["headers"]["Prefer"])
        self.assertIn("return=representation", upsert["headers"]["Prefer"])
        row = upsert["body"][0] if isinstance(upsert["body"], list) else upsert["body"]
        self.assertEqual(row["exchange"], "bse")
        self.assertEqual(row["inputs"], {"pe1": 50, "w0": 40, "adr": None})
        self.assertRegex(row["updated_by"], r"^[0-9a-f]{12}$")
        entry = log["body"][0] if isinstance(log["body"], list) else log["body"]
        self.assertEqual((entry["exchange"], entry["before"], entry["after"]),
                         ("bse", {"pe1": 48, "adr": None}, {"pe1": 50, "w0": 40, "adr": None}))
        self.assertEqual(entry["changed_by"], row["updated_by"])
        self.assertEqual(got["db"]["log"], [entry])

    def test_put_on_a_new_exchange_logs_an_empty_before(self):
        got = run([put("mcx", {"g": 4})], rows=json.loads(json.dumps(ROWS)))
        self.assertEqual(got["out"][0]["status"], 200)
        self.assertEqual(got["db"]["log"][0]["before"], {})
        self.assertEqual(got["out"][0]["body"]["inputs"]["mcx"], {"g": 4})

    def test_body_may_be_a_json_string(self):
        step = {"api": "valuation-inputs", "method": "PUT", "cookie": "valid",
                "body": json.dumps({"exchange": "nse", "inputs": {}})}
        got = run([step], rows=json.loads(json.dumps(ROWS)))
        self.assertEqual(got["out"][0]["status"], 200)
        self.assertEqual(got["out"][0]["body"]["inputs"]["nse"], {})

    def test_other_methods_are_405(self):
        self.assertEqual(run([{"api": "valuation-inputs", "method": "DELETE", "cookie": "valid"}])["out"][0]["status"], 405)


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
STORE_JS = ["valuationNum", "valuationIsoDate", "VALUATION_EXCHANGES", "VALUATION_EDITABLE", "VALUATION_STORAGE_KEY",
            "VALUATION_SHARED", "valuationPlainObject", "readLocalValuationOverrides", "writeLocalValuationOverrides",
            "readValuationOverrides", "writeValuationOverrides", "valuationCanEdit", "valuationSameOverrides",
            "valuationChangedExchanges", "valuationMergeShared", "valuationSharedNotify", "valuationApplyShared",
            "loadSharedValuationInputs", "valuationScheduleSave", "valuationFlushSaves"]


def store(body, data=None):
    code = "\n".join(js_source(n) for n in STORE_JS)
    script = (f"const DATA = {json.dumps(data)};\nconst VALUATION_SAVE_DELAY_MS = 20;\n"
              "const mem = {};\n"
              "globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };\n"
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
          return { n, mode: VALUATION_SHARED.mode, o: readValuationOverrides(), cached: JSON.parse(mem.valuation_inputs_v1),
                   canEdit: valuationCanEdit(), written: writeValuationOverrides({ bse: { pe1: 50 } }), after: readValuationOverrides() };""",
            SHARED)
        self.assertEqual(got["n"], 1)
        self.assertEqual(got["mode"], "shared")
        self.assertEqual(got["o"], {"bse": {"pe1": 48}})
        self.assertEqual(got["cached"], {"bse": {"pe1": 48}})
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
                   pending: VALUATION_SHARED.pending, cached: JSON.parse(mem.valuation_inputs_v1) };""", SHARED)
        self.assertEqual(got["early"], 0)
        self.assertEqual(got["states"], ["saving"])
        self.assertEqual(sorted((p["b"]["exchange"], json.dumps(p["b"]["inputs"])) for p in got["puts"]),
                         [("bse", '{"pe1": 51}'), ("nse", '{"w0": 40}')])
        self.assertTrue(all(p["url"] == "/api/valuation-inputs" for p in got["puts"]))
        self.assertEqual(got["final"], "saved")
        self.assertEqual(got["o"], {"bse": {"pe1": 51}, "nse": {"w0": 40}})
        self.assertEqual(got["cached"], got["o"])
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


if __name__ == "__main__":
    unittest.main()
