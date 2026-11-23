#!/usr/bin/env python3
"""tests/test_toolkit.py — the twelve tools (HIVV_TOOLKIT_PLAN.md).

Covers:
  · the catalog is complete and internally consistent
  · the safe math evaluator (no eval, exact results, hostile input)
  · the text parsers (JSON / CSV / XML / YAML / HTML)
  · the timezone converter (offsets, DST, differences)
  · the SSRF guard refuses internal targets
  · the memory store round-trips
  · the file store reads and searches documents
  · the policy posture: web search is ask-gated and NOT advertised
  · the SSE tool-stream interceptor holds tool frames back

No network, no $HOME writes, no database — the live-gateway checks are
skipped when the gateway is down.
"""
import json
import os
import subprocess
import time
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
API = REPO / "api"
GATEWAY = "http://127.0.0.1:3011"

sys.path.insert(0, str(API))


def _node(script: str):
    """Run a node script and return its parsed JSON output."""
    proc = subprocess.run(
        ["node", "-e", script],
        cwd=str(API), capture_output=True, text=True, timeout=60,
    )
    if proc.returncode != 0:
        raise AssertionError(f"node failed ({proc.returncode}): {proc.stderr[-2000:]}")
    out = proc.stdout.strip()
    if not out:
        raise AssertionError("node produced no output")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return out


def _strip_js_comments(src: str) -> str:
    """Remove // and /* */ comments so a source scan is not fooled by prose."""
    out = []
    in_block = False
    for line in str(src).splitlines():
        if in_block:
            if "*/" in line:
                line = line.split("*/", 1)[1]
                in_block = False
            else:
                continue
        i = line.find("//")
        j = line.find("/*")
        if j != -1 and (i == -1 or j < i):
            line = line[:j]
            in_block = True
        elif i != -1:
            line = line[:i]
        out.append(line)
    return "\n".join(out)


def _gateway_up() -> bool:
    try:
        import urllib.request
        with urllib.request.urlopen(f"{GATEWAY}/api/health", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


# ── the catalog ─────────────────────────────────────────────────────────────
class TestCatalog(unittest.TestCase):
    def test_thirteen_tools_exist_with_canonical_names(self):
        names = _node("console.log(JSON.stringify(require('./lib/toolkit').allTools().map(t=>t.name)))")
        for expected in [
            "web_search", "current_time", "calculator", "web_fetch", "http_request",
            "code_interpreter", "file_read", "file_search", "memory",
            "text_parser", "timezone_convert", "translate",
        ]:
            self.assertIn(expected, names, f"the toolkit is missing '{expected}'")

    def test_every_tool_declares_the_four_essentials(self):
        tools = _node("console.log(JSON.stringify(require('./lib/toolkit').allTools()))")
        for t in tools:
            self.assertTrue(t.get("name"), "a tool has no name")
            self.assertTrue(t.get("description"), f"{t['name']} has no description")
            self.assertTrue(t.get("capability"), f"{t['name']} has no capability")
            params = t.get("parameters")
            self.assertIsInstance(params, dict, f"{t['name']} has no JSON schema")
            self.assertEqual(params.get("type"), "object", f"{t['name']} schema is not an object")
            self.assertIsInstance(params.get("properties", {}), dict, f"{t['name']} properties are not an object")
            for req in params.get("required", []):
                self.assertIn(req, params.get("properties", {}),
                              f"{t['name']} requires '{req}' but does not declare it")

    def test_aliases_resolve_to_the_canonical_tool(self):
        pairs = {
            "search": "web_search", "news": "web_search",
            "time": "current_time", "get_time": "current_time",
            "calculate": "calculator", "calc": "calculator",
            "fetch": "web_fetch", "reader": "web_fetch",
            "exec": "code_interpreter", "run_code": "code_interpreter",
            "read_file": "file_read", "grep": "file_search",
            "remember": "memory", "parse": "text_parser",
            "tz": "timezone_convert", "translation": "translate",
        }
        script = ("const t=require('./lib/toolkit');const p=%s;"
                  "console.log(JSON.stringify(Object.entries(p).map(([a,c])=>[a,t.resolveTool(a)?t.resolveTool(a).name:null])));"
                  % json.dumps(pairs))
        for alias, canonical in _node(script):
            self.assertEqual(alias and canonical, canonical, f"alias '{alias}' did not resolve")

    def test_unknown_tool_resolves_to_nothing(self):
        self.assertIsNone(_node("console.log(JSON.stringify(require('./lib/toolkit').resolveTool('totally-unknown')))"))

    def test_openai_schemas_are_well_formed(self):
        schemas = _node("console.log(JSON.stringify(require('./lib/toolkit').openaiSchemas()))")
        self.assertGreater(len(schemas), 5)
        for s in schemas:
            self.assertEqual(s.get("type"), "function")
            fn = s.get("function", {})
            self.assertTrue(fn.get("name"))
            self.assertTrue(fn.get("description"), f"{fn.get('name')} has no description")
            self.assertEqual(fn.get("parameters", {}).get("type"), "object")

    def test_no_duplicate_schema_names(self):
        schemas = _node("console.log(JSON.stringify(require('./lib/toolkit').openaiSchemas().map(s=>s.function.name)))")
        self.assertEqual(len(schemas), len(set(schemas)), "two tools share a name")

    def test_tool_capability_map_covers_the_catalog(self):
        out = _node(
            "const t=require('./lib/toolkit');const c=require('./lib/capabilities');"
            "console.log(JSON.stringify(t.allTools().map(x=>[x.name,c.toolToCap(x.name),x.capability])));"
        )
        for name, mapped, declared in out:
            self.assertEqual(mapped, declared,
                             f"'{name}' maps to '{mapped}' in TOOL_CAPS but declares '{declared}'")


# ── the calculator ──────────────────────────────────────────────────────────
def _eval(expr):
    script = ("const {evaluate}=require('./lib/math');"
              "console.log(JSON.stringify(evaluate(%s)));" % json.dumps(expr))
    return _node(script)


class TestMath(unittest.TestCase):

    def test_basic_arithmetic(self):
        for expr, want in [("2+2", 4), ("10-3", 7), ("6*7", 42), ("10/4", 2.5),
                           ("10%3", 1), ("2^10", 1024), ("-5+3", -2), ("(1+2)*3", 9)]:
            r = _eval(expr)
            self.assertTrue(r["ok"], f"{expr} failed: {r.get('error')}")
            self.assertAlmostEqual(float(r["result"]), float(want), places=9, msg=expr)

    def test_precedence_and_right_associativity(self):
        self.assertEqual(_eval("2+3*4")["result"], 14)
        self.assertEqual(_eval("(2+3)*4")["result"], 20)
        self.assertEqual(_eval("2^3^2")["result"], 512)   # right-associative

    def test_functions_and_constants(self):
        for expr, want in [("sqrt(16)", 4), ("abs(-7)", 7), ("min(3,1,2)", 1), ("max(3,1,2)", 3),
                           ("factorial(5)", 120), ("hypot(3,4)", 5), ("deg(asin(1))", 90)]:
            r = _eval(expr)
            self.assertTrue(r["ok"], f"{expr} failed: {r.get('error')}")
            self.assertAlmostEqual(float(r["result"]), float(want), places=6, msg=expr)

    def test_float_noise_is_tidied(self):
        # 0.1 + 0.2 must read as 0.3, not 0.30000000000000004 — a model that
        # sees the noise will "correct" it into a wrong answer.
        self.assertEqual(_eval("0.1+0.2")["result"], 0.3)

    def test_division_by_zero_is_an_error_not_a_crash(self):
        r = _eval("1/0")
        self.assertFalse(r["ok"])
        self.assertIn("zero", r["error"].lower())

    def test_no_code_execution_is_possible(self):
        for hostile in [
            "__proto__",
            "constructor",
            "process.exit(1)",
            "require('fs')",
            "globalThis",
            "1; alert(1)",
            "() => 1",
            "[1,2]",
            "a.b.c",
        ]:
            r = _eval(hostile)
            self.assertFalse(r["ok"], f"'{hostile}' was evaluated instead of refused")

    def test_the_module_contains_no_eval(self):
        src = (API / "lib" / "math.js").read_text(encoding="utf-8")
        code = _strip_js_comments(src)
        # no eval( and no new Function( — the whole point of the module
        self.assertNotIn("eval(", code)
        self.assertNotIn("new Function", code)

    def test_overlong_input_is_refused(self):
        r = _eval("1+" * 5000 + "1")
        self.assertFalse(r["ok"])


# ── the text parsers ────────────────────────────────────────────────────────
class TestTextParse(unittest.TestCase):
    def _parse(self, args):
        script = ("const t=require('./lib/textparse');console.log(JSON.stringify(t));")
        return _node(script)

    def test_html_is_stripped_to_readable_text(self):
        out = _node(
            "const t=require('./lib/textparse');"
            "console.log(JSON.stringify(t.stripHtml('<html><head><style>p{color:red}</style>"
            "<script>alert(1)</script></head><body><h1>Hi &amp; bye</h1><p>One</p></body></html>')));"
        )
        self.assertIn("Hi & bye", out)
        self.assertNotIn("alert(1)", out)
        self.assertNotIn("color:red", out)

    def test_xml_becomes_structure(self):
        out = _node(
            "const t=require('./lib/textparse');"
            "console.log(JSON.stringify(t.parseXml('<rss><channel><item><title>T</title></item>"
            "<item><title>U</title></item></channel></rss>')));"
        )
        titles = out["channel"]["item"]
        self.assertEqual(titles[0]["title"], "T")
        self.assertEqual(titles[1]["title"], "U")

    def test_yaml_becomes_structure(self):
        out = _node(
            "const t=require('./lib/textparse');"
            "console.log(JSON.stringify(t.parseYaml('name: hivv\\nport: 3011\\ntags:\\n  - a\\n  - b\\n"
            "nested:\\n  x: 1\\n  flag: true\\n')));"
        )
        self.assertEqual(out["name"], "hivv")
        self.assertEqual(out["port"], 3011)
        self.assertEqual(out["tags"], ["a", "b"])
        self.assertEqual(out["nested"]["x"], 1)
        self.assertIs(out["nested"]["flag"], True)

    def test_format_detection(self):
        out = _node(
            "const t=require('./lib/textparse');"
            "console.log(JSON.stringify(['{\"a\":1}','a,b,c\\n1,2,3','<a><b>1</b></a>',"
            "'name: x\\nval: 2','hello world'].map(t.detectFormat)));"
        )
        self.assertEqual(out, ["json", "csv", "xml", "yaml", "text"])

    def test_the_tool_returns_plain_text_instead_of_failing(self):
        """Unstructured prose is not a parse failure.

        The tool used to answer \'could not parse the input as text\' — a
        model that handed prose to the parser got an error it then had to
        explain to the user, instead of the prose back.
        """
        out = _node(
            "const t=require('./lib/toolkit');"
            "t.execute('text_parser',{input:'just some words here'},"
            "{principal:'t',skipGate:true}).then(r=>console.log(JSON.stringify(r)));"
        )
        self.assertTrue(out["ok"], out.get("error"))
        self.assertEqual(out["data"]["detected_format"], "text")
        self.assertEqual(out["data"]["parsed"], "just some words here")
        # the entities a caller usually wanted come along too
        self.assertIn("extracted", out["data"])

    def test_real_csv_parses(self):
        """A CSV with REAL newlines (not the two characters backslash-n)."""
        out = _node(
            "const t=require('./lib/toolkit');"
            "t.execute('text_parser',{input:'name,age\\nada,36\\ngrace,45'},"
            "{principal:'t',skipGate:true}).then(r=>console.log(JSON.stringify(r)));"
        )
        self.assertTrue(out["ok"], out.get("error"))
        self.assertEqual(out["data"]["detected_format"], "csv")
        self.assertEqual(out["data"]["parsed"],
                         [{"name": "ada", "age": "36"}, {"name": "grace", "age": "45"}])

    def test_entity_extraction(self):
        out = _node(
            "const t=require('./lib/textparse');"
            "console.log(JSON.stringify(t.extractEntities('visit https://hivv.org or mail a@b.co on 2026-11-22')));"
        )
        self.assertIn("https://hivv.org", out["urls"])
        self.assertIn("a@b.co", out["emails"])
        self.assertIn("2026-11-22", out["dates"])
        # a date must not contribute its digits to the number sum
        self.assertEqual(out["numbers"]["count"], 0)


# ── the timezone converter ──────────────────────────────────────────────────
class TestTimezone(unittest.TestCase):
    def _tz(self, args):
        script = ("const t=require('./lib/toolkit');"
                  "t.execute('timezone_convert',%s,{principal:'t',skipGate:true})"
                  ".then(r=>console.log(JSON.stringify(r.data)));" % json.dumps(args))
        return _node(script)

    def test_offsets_are_east_of_utc_with_the_right_sign(self):
        for tz, want in [("Asia/Karachi", "+05:00"), ("Europe/Paris", "+01:00"),
                         ("America/New_York", "-05:00"), ("UTC", "+00:00"),
                         ("Asia/Kolkata", "+05:30")]:
            data = self._tz({"timezone": tz, "datetime": "2026-01-15T12:00:00Z"})
            self.assertEqual(data["utc_offset"], want, f"{tz} offset")

    def test_daylight_saving_is_detected(self):
        winter = self._tz({"timezone": "Europe/Paris", "datetime": "2026-01-15T12:00:00Z"})
        summer = self._tz({"timezone": "Europe/Paris", "datetime": "2026-07-15T12:00:00Z"})
        self.assertIs(winter["is_dst"], False)
        self.assertIs(summer["is_dst"], True)
        self.assertEqual(winter["utc_offset"], "+01:00")
        self.assertEqual(summer["utc_offset"], "+02:00")

    def test_southern_hemisphere_dst(self):
        syd = self._tz({"timezone": "Australia/Sydney", "datetime": "2026-01-15T12:00:00Z"})
        self.assertIs(syd["is_dst"], True)

    def test_difference_between_two_zones_is_signed(self):
        data = self._tz({"timezone": "Europe/Paris", "from_timezone": "Asia/Karachi",
                         "datetime": "2026-01-15T12:00:00Z"})
        # Paris is UTC+1, Karachi is UTC+5 → Paris is FOUR hours behind
        self.assertEqual(data["difference"], "-4.00 hours")
        self.assertEqual(data["from_utc_offset"], "+05:00")

    def test_invalid_timezone_is_refused_with_a_helpful_message(self):
        out = _node(
            "const t=require('./lib/toolkit');"
            "t.execute('timezone_convert',{timezone:'Mars/Olympus'},{principal:'t',skipGate:true})"
            ".then(r=>console.log(JSON.stringify(r)));"
        )
        self.assertFalse(out["ok"])
        self.assertIn("not a valid IANA timezone", out["error"])


# ── the SSRF guard ──────────────────────────────────────────────────────────
class TestSsrf(unittest.TestCase):
    def _fetch(self, url):
        out = _node(
            "const t=require('./lib/toolkit');"
            "t.execute('web_fetch',{url:%s},{principal:'t',skipGate:true})"
            ".then(r=>console.log(JSON.stringify(r)));" % json.dumps(url)
        )
        return out

    def test_loopback_and_metadata_are_refused(self):
        for url in [
            "http://127.0.0.1:3011/api/health",
            "http://localhost:3011/",
            "http://169.254.169.254/latest/meta-data/",
            "http://10.0.0.1/",
            "http://192.168.1.1/",
            "http://[::1]/",
        ]:
            r = self._fetch(url)
            self.assertFalse(r["ok"], f"{url} was NOT refused")
            self.assertTrue(r.get("refused"), f"{url} was not marked as refused")

    def test_non_http_schemes_are_refused(self):
        r = self._fetch("file:///etc/passwd")
        self.assertFalse(r["ok"])


# ── the memory store ────────────────────────────────────────────────────────
class TestMemory(unittest.TestCase):
    def test_round_trip_on_the_local_file_store(self):
        out = _node(
            "const m=require('./lib/memory');"
            "m.init(null,{dataDir:require('os').tmpdir()+'/hivv-mem-test'});"
            "(async()=>{const p='test-principal-'+Date.now();"
            "await m.forget(p);"
            "const w=await m.remember(p,'unit',{value:'metric',n:1});"
            "const r=await m.recall(p);"
            "const f=await m.forget(p,'unit');"
            "const r2=await m.recall(p);"
            "console.log(JSON.stringify({w,r,f,r2}));})();"
        )
        self.assertTrue(out["w"]["ok"])
        self.assertTrue(out["w"]["created"])
        self.assertEqual(out["r"]["count"], 1)
        self.assertEqual(out["r"]["items"][0]["value"]["value"], "metric")
        self.assertEqual(out["f"]["removed"], 1)
        self.assertEqual(out["r2"]["count"], 0)

    def test_oversized_values_are_refused(self):
        out = _node(
            "const m=require('./lib/memory');"
            "m.init(null,{dataDir:require('os').tmpdir()+'/hivv-mem-test'});"
            "(async()=>{const r=await m.remember('p'+Date.now(),'k','x'.repeat(100000));"
            "console.log(JSON.stringify(r));})();"
        )
        self.assertFalse(out["ok"])
        self.assertIn("too large", out["error"])

    def test_memory_is_scoped_per_principal(self):
        out = _node(
            "const m=require('./lib/memory');"
            "m.init(null,{dataDir:require('os').tmpdir()+'/hivv-mem-test'});"
            "(async()=>{const a='pa-'+Date.now(),b='pb-'+Date.now();"
            "await m.remember(a,'k','secret');"
            "const r=await m.recall(b);"
            "console.log(JSON.stringify(r));})();"
        )
        self.assertEqual(out["count"], 0, "one principal read another's memory")


# ── the policy posture ──────────────────────────────────────────────────────
class TestPolicyPosture(unittest.TestCase):
    def test_web_search_is_not_advertised_by_default(self):
        out = _node(
            "const t=require('./lib/toolkit');"
            "console.log(JSON.stringify({advertised:t.advertisedTools().map(x=>x.name),"
            "enabled:t.isWebSearchEnabled()}));"
        )
        self.assertNotIn("web_search", out["advertised"],
                         "web search must not be advertised until it is enabled")
        self.assertFalse(out["enabled"])

    def test_web_search_becomes_advertised_when_the_flag_is_on(self):
        out = _node(
            "process.env.HIVV_ENABLE_WEB_SEARCH='1';"
            "const t=require('./lib/toolkit');"
            "console.log(JSON.stringify({advertised:t.advertisedTools().map(x=>x.name),"
            "enabled:t.isWebSearchEnabled()}));"
        )
        self.assertIn("web_search", out["advertised"])
        self.assertTrue(out["enabled"])

    def test_web_search_maps_to_the_web_search_capability(self):
        out = _node(
            "const t=require('./lib/toolkit');"
            "console.log(JSON.stringify(t.allTools().map(x=>[x.name,x.capability])));"
        )
        caps = dict(out)
        self.assertEqual(caps["web_search"], "web.search")
        self.assertEqual(caps["web_fetch"], "web.fetch")
        self.assertEqual(caps["http_request"], "web.fetch")
        self.assertEqual(caps["code_interpreter"], "coding.execute")
        self.assertEqual(caps["file_read"], "data.file.read")
        self.assertEqual(caps["memory"], "data.memory")

    def test_the_migration_flips_web_search_to_ask(self):
        mig = (API / "migrations" / "022_toolkit.sql").read_text(encoding="utf-8")
        self.assertIn("'web.search'", mig)
        self.assertIn("default_verdict = 'ask'", mig)

    def test_the_migration_creates_the_memory_table(self):
        mig = (API / "migrations" / "022_toolkit.sql").read_text(encoding="utf-8")
        self.assertIn("CREATE TABLE IF NOT EXISTS hivv_memory", mig)

    def test_the_migration_fixes_the_coding_execute_tier(self):
        mig = (API / "migrations" / "022_toolkit.sql").read_text(encoding="utf-8")
        self.assertIn("tier = 'side-effect'", mig)

    def test_the_offline_registry_matches_the_seeded_one(self):
        # The built-in list used to disagree with the table (different tiers,
        # six missing keys) — an offline install published a different
        # capability surface than a live one.
        out = _node(
            "const c=require('./lib/capabilities');"
            "console.log(JSON.stringify(c.BUILTIN_CAPABILITIES||[]));"
        )
        if not out:
            out = _node(
                "const c=require('./lib/capabilities');"
                "const m=require('fs').readFileSync('./lib/capabilities.js','utf8');"
                "const rows=[...m.matchAll(/key: '([^']+)'[^}]*?tier: '([^']+)'[^}]*?default_verdict: '([^']+)'/g)]"
                ".map(x=>[x[1],x[2],x[3]]);"
                "console.log(JSON.stringify(rows));"
            )
        self.assertTrue(out, "could not read the built-in capability list")
        keys = {r[0]: r for r in out}
        self.assertIn("data.file.read", keys)
        self.assertIn("data.memory", keys)
        self.assertEqual(keys["web.search"][2], "ask")
        self.assertEqual(keys["coding.execute"][1], "side-effect")


# ── the SSE tool-stream interceptor ─────────────────────────────────────────
class TestToolStream(unittest.TestCase):
    def test_frames_split_on_the_blank_line(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "console.log(JSON.stringify(s.splitFrames('a\\n\\nb\\n\\nc')));"
        )
        self.assertEqual(out["frames"], ["a", "b"])
        self.assertEqual(out["rest"], "c")

    def test_a_partial_frame_is_buffered_not_emitted(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "console.log(JSON.stringify(s.splitFrames('data: {\"x\":1}\\n\\ndata: {\"y')));"
        )
        self.assertEqual(len(out["frames"]), 1)
        self.assertIn('"y', out["rest"])

    def test_tool_call_deltas_are_merged_by_index(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "console.log(JSON.stringify(s.mergeToolCalls(["
            "{index:0,id:'call_1',function:{name:'current_',arguments:'{\"a\"'}},"
            "{index:0,function:{name:'time',arguments:':1}'}}])));"
        )
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["function"]["name"], "current_time")
        self.assertEqual(out[0]["function"]["arguments"], '{"a":1}')

    def test_the_interceptor_holds_tool_frames_and_forwards_content(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "const sent=[];"
            "const fake={setHeader(){},write(x){sent.push(x);},end(){}};"
            "const i=new s.ToolStreamInterceptor(fake);"
            "i.write('data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\","
            "\"function\":{\"name\":\"current_time\",\"arguments\":\"{}\"}}]}}]}\\n\\n');"
            "i.write('data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\\n\\n');"
            "i.write('data: [DONE]\\n\\n');"
            "console.log(JSON.stringify({sent,held:i.hadToolCalls(),"
            "calls:i.toolCalls().map(c=>c.function.name),content:i.content}));"
        )
        joined = "".join(out["sent"])
        self.assertIn("hi", joined)
        self.assertNotIn("tool_calls", joined, "a tool_call frame reached the client")
        self.assertTrue(out["held"])
        self.assertEqual(out["calls"], ["current_time"])

    def test_the_interceptor_never_closes_the_real_response_early(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "let ended=0;const fake={setHeader(){},write(){},end(){ended++;}};"
            "const i=new s.ToolStreamInterceptor(fake);"
            "i.write('data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\\n\\n');"
            "i.end();"
            "console.log(JSON.stringify({ended,finished:i.finished}));"
        )
        self.assertEqual(out["ended"], 0, "the router's end() closed the client's stream")
        self.assertFalse(out["finished"])

    def test_release_sends_the_terminator_but_not_the_tool_frames(self):
        out = _node(
            "const s=require('./lib/tool-stream');"
            "const sent=[];const fake={setHeader(){},write(x){sent.push(x);},end(){}};"
            "const i=new s.ToolStreamInterceptor(fake);"
            "i.write('data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\","
            "\"function\":{\"name\":\"calculator\",\"arguments\":\"{}\"}}]}}]}\\n\\n');"
            "i.write('data: [DONE]\\n\\n');"
            "i.release();"
            "console.log(JSON.stringify(sent));"
        )
        joined = "".join(out)
        self.assertIn("[DONE]", joined)
        self.assertNotIn("tool_calls", joined)


# ── the bee-side tool server ────────────────────────────────────────────────
class TestBeeToolServer(unittest.TestCase):
    def setUp(self):
        self.script = REPO / "public_html" / "hivv-tools.py"

    def _py(self, body):
        proc = subprocess.run(
            [sys.executable, "-c", body], capture_output=True, text=True, timeout=60,
            cwd=str(self.script.parent),
        )
        if proc.returncode != 0:
            raise AssertionError(f"python failed: {proc.stderr[-2000:]}")
        return json.loads(proc.stdout.strip().splitlines()[-1])

    def test_the_bee_calculator_has_no_eval(self):
        out = self._py(
            "import importlib.util,json;"
            "spec=importlib.util.spec_from_file_location('ht','hivv-tools.py');"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            "print(json.dumps(m.tool_calculate('(1+2)*3^2')))"
        )
        self.assertEqual(out["result"], 27)

    def test_the_bee_calculator_refuses_code(self):
        out = self._py(
            "import importlib.util,json;"
            "spec=importlib.util.spec_from_file_location('ht','hivv-tools.py');"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            "print(json.dumps(m.tool_calculate('__import__(\"os\").system(\"id\")')))"
        )
        self.assertIn("error", out)

    def test_the_bee_server_advertises_the_whole_catalog(self):
        out = self._py(
            "import importlib.util,json;"
            "spec=importlib.util.spec_from_file_location('ht','hivv-tools.py');"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            "print(json.dumps([t['name'] for t in m.TOOLS]))"
        )
        for expected in ["web_search", "current_time", "calculator", "web_fetch",
                         "http_request", "code_interpreter", "file_read", "file_search",
                         "memory", "text_parser", "timezone_convert", "translate"]:
            self.assertIn(expected, out)

    def test_the_bee_server_never_calls_eval(self):
        # Parsed, not grepped: a comment may SAY "eval", but no code may CALL
        # it. The old calculator used eval() on a regex-cleaned string — a
        # code-execution primitive wearing a calculator's clothes.
        import ast
        tree = ast.parse(self.script.read_text(encoding="utf-8"))
        called = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                fn = node.func
                if isinstance(fn, ast.Name):
                    called.add(fn.id)
                elif isinstance(fn, ast.Attribute):
                    called.add(fn.attr)
        for forbidden in ("eval", "exec", "compile", "__import__"):
            self.assertNotIn(forbidden, called,
                             f"the bee tool server calls {forbidden}()")

    def test_the_bee_timezone_conversion(self):
        out = self._py(
            "import importlib.util,json;"
            "spec=importlib.util.spec_from_file_location('ht','hivv-tools.py');"
            "m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);"
            "print(json.dumps(m.tool_timezone({'timezone':'Asia/Karachi',"
            "'from_timezone':'Europe/Paris','datetime':'2026-01-15T12:00:00Z'})))"
        )
        self.assertEqual(out["local"], "2026-01-15 17:00:00")
        self.assertEqual(out["from_local"], "2026-01-15 13:00:00")

    def test_the_bee_server_is_threaded(self):
        """A plain HTTPServer serves ONE request at a time.

        That is not a detail: a proxied call can take 30 seconds (a code run
        in the hub's sandbox), and a bare TCP probe from the CLI holds the
        server hostage while the CLI waits on its own HTTP request — the
        single-threaded server cannot answer the second connection until the
        first one closes. The whole local-tool path timed out because of it.
        """
        src = self.script.read_text(encoding="utf-8")
        self.assertIn("ThreadingHTTPServer", src)
        self.assertNotIn("server = HTTPServer(", src)

    def test_the_cli_uses_the_ipv4_loopback_for_the_tool_server(self):
        """`localhost` resolves to ::1 FIRST on this box, and the tool server
        binds IPv4 only — so every local tool call tried IPv6 first and
        timed out."""
        cli = (REPO / "public_html" / "hivv-cli.py").read_text(encoding="utf-8")
        self.assertNotIn('localhost", TOOLS_PORT', cli)
        self.assertNotIn('http://localhost:{TOOLS_PORT}', cli)
        self.assertIn('http://127.0.0.1:{TOOLS_PORT}', cli)


# ── the live gateway (skipped when it is down) ──────────────────────────────
class TestLiveGateway(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not _gateway_up():
            raise unittest.SkipTest("the gateway is not running on 127.0.0.1:3011")

    def _get(self, path):
        import urllib.request
        with urllib.request.urlopen(f"{GATEWAY}{path}", timeout=15) as r:
            return json.loads(r.read())

    def _post(self, path, body):
        import urllib.request
        req = urllib.request.Request(
            f"{GATEWAY}{path}", data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_the_catalog_endpoint_lists_every_tool(self):
        cat = self._get("/api/tools/catalog")
        self.assertGreaterEqual(cat["total"], 12)
        names = [t["name"] for t in cat["tools"]]
        for expected in ["calculator", "current_time", "code_interpreter", "memory",
                         "file_read", "file_search", "text_parser", "timezone_convert",
                         "translate", "http_request"]:
            self.assertIn(expected, names)

    def test_calculating_through_the_hub(self):
        status, body = self._post("/api/tools/calculator/invoke", {"expression": "(12+8)*3/7"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertAlmostEqual(body["data"]["result"], 60 / 7, places=8)

    def test_web_search_is_maybe_gated(self):
        status, body = self._post("/api/tools/web_search/invoke", {"query": "hivv"})
        self.assertEqual(status, 202, f"web search should ask first, got {status}: {body}")
        self.assertEqual(body["verdict"], "MAYBE")
        self.assertTrue(body.get("grant_id"))

    def test_web_fetch_is_maybe_gated(self):
        status, body = self._post("/api/tools/web_fetch/invoke", {"url": "https://example.com"})
        self.assertEqual(status, 202)
        self.assertEqual(body["verdict"], "MAYBE")

    def test_the_ssrf_guard_holds_on_the_live_gateway(self):
        status, body = self._post("/api/tools/web_fetch/invoke", {"url": "http://127.0.0.1:3011/api/health"})
        # either the gate asks first, or the guard refuses — never a fetch
        self.assertIn(status, (202, 400))
        if status == 400:
            self.assertIn("private network", body.get("error", ""))

    def test_mcp_lists_the_toolkit(self):
        import urllib.request
        req = urllib.request.Request(
            f"{GATEWAY}/mcp",
            data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).encode(),
            headers={"Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream"},
            method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
        names = [t["name"] for t in body["result"]["tools"]]
        for expected in ["chat", "route", "nodes", "honey",
                         "calculator", "current_time", "code_interpreter", "memory"]:
            self.assertIn(expected, names)

    def test_mcp_can_call_a_tool(self):
        import urllib.request
        req = urllib.request.Request(
            f"{GATEWAY}/mcp",
            data=json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": "calculator",
                                        "arguments": {"expression": "17*23+5"}}}).encode(),
            headers={"Content-Type": "application/json",
                     "Accept": "application/json, text/event-stream"},
            method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            body = json.loads(r.read())
        text = body["result"]["content"][0]["text"]
        self.assertIn("396", text)

    def test_the_discovery_route_publishes_the_toolkit(self):
        disc = self._get("/v1/capabilities")
        self.assertIn("toolkit", disc["data"])
        self.assertGreaterEqual(disc["data"]["toolkit"]["count"], 12)
        self.assertTrue(disc["data"]["toolkit"]["auto_attached"])

    def test_an_approved_grant_is_reusable(self):
        """A standing grant must actually stick.

        The tool route used to identify the caller by SOURCE IP, which behind
        a CDN is the edge node's address and changes between requests — so a
        standing grant was never reusable and every call asked a human
        again. The identity is now the signed visitor cookie / x-visitor-id.
        """
        import urllib.request
        visitor = f"testkit-{int(time.time() * 1000)}-{os.getpid()}"

        def invoke():
            req = urllib.request.Request(
                f"{GATEWAY}/api/tools/web_fetch/invoke",
                data=json.dumps({"url": "https://example.com"}).encode(),
                headers={"Content-Type": "application/json",
                         "x-visitor-id": visitor},
                method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return r.status, json.loads(r.read())
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")

        status, body = invoke()
        self.assertEqual(status, 202, f"the first call should ask: {body}")
        grant_id = body.get("grant_id")
        self.assertTrue(grant_id)

        # approve it (loopback is admin)
        req = urllib.request.Request(
            f"{GATEWAY}/api/policy/grants/{grant_id}/decide",
            data=json.dumps({"verdict": "approve", "scope": "standing",
                              "ttl_s": 600}).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            decided = json.loads(r.read())
        self.assertTrue(decided.get("ok"), decided)

        status, body = invoke()
        self.assertEqual(status, 200, f"the approved grant did not stick: {body}")
        self.assertTrue(body.get("ok"))
        self.assertEqual(body["policy"]["verdict"], "allow")
        self.assertEqual(body["data"]["status"], 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
