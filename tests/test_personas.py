"""Tests for PERSONAS — named personalities that stay private.

THE PRIVACY CONTRACT (why these tests exist)
The user's requirement: personas must be private from the ADMIN and from
EVERYONE ELSE — people use their AI the way they want, including for their
own spiritual life, and nobody reads over their shoulder. Not me, not the
hub, not other users.

The design makes that TRUE BY CONSTRUCTION rather than by promise:
  1. the persona LIST lives in browser localStorage only — it is never
     part of any request body (only the ACTIVE prompt travels, as the
     system message every chat already sends);
  2. the hub stores NO raw prompts at all: provenance keeps SHA-256
     digests + byte counts (request-provenance.js), and usage_logs has no
     prompt column — so even the live prompt is unreadable afterwards;
  3. the built-in God-conscious persona seeds INACTIVE — this is a public
     site; visitors keep the neutral default until they choose, and one
     tap activates it forever in THEIR browser only.

These are static contract tests over the shipped chat files (no browser
in CI): they pin the storage keys, the resolution order, the seed content,
and — most importantly — that nothing persona-related ever appears in a
network payload.
"""
import re
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
APP_JS = REPO / "public_html" / "chat" / "app.js"
INDEX_HTML = REPO / "public_html" / "chat" / "index.html"


def _app() -> str:
    return APP_JS.read_text(encoding="utf-8")


class TestStorageIsLocalOnly:
    def test_storage_keys_exist(self):
        src = _app()
        assert "hivv_personas" in src
        assert "hivv_active_persona" in src

    def test_save_personas_never_touches_the_network(self):
        """THE core assertion: the persona list must never be sent anywhere."""
        src = _app()
        m = re.search(r"function savePersonas\(\)\s*\{(.*?)\n  \}", src, re.S)
        assert m, "savePersonas not found"
        body = m.group(1)
        assert "localStorage.setItem" in body
        for forbidden in ("fetch(", "XMLHttpRequest", "navigator.sendBeacon",
                          "http.", "axios", "WebSocket"):
            assert forbidden not in body, (
                f"savePersonas must not touch the network (found {forbidden!r})"
            )

    def test_personas_never_appear_in_a_request_payload(self):
        """JSON.stringify(personas) must exist exactly once — inside
        savePersonas, writing to localStorage. Anywhere near a fetch would
        mean the list is being uploaded."""
        src = _app()
        occurrences = [m.start() for m in re.finditer(r"JSON\.stringify\(personas\)", src)]
        assert len(occurrences) == 1, (
            f"expected exactly 1 stringify(personas) (the localStorage write), "
            f"found {len(occurrences)}"
        )
        window = src[max(0, occurrences[0] - 400):occurrences[0] + 400]
        assert "localStorage.setItem" in window
        assert "fetch(" not in window

    def test_only_the_active_prompt_travels(self):
        """The chat request carries ONE system message built from the ACTIVE
        persona (or the fallbacks) — never the list."""
        src = _app()
        assert "const _pa = activePersona();" in src
        assert "(_pa && _pa.prompt) || gen.system_prompt || DEFAULT_SYSTEM" in src, (
            "resolution order must be: persona → system prompt → default"
        )


class TestSeedAndDefaults:
    def test_builtin_persona_is_god_conscious(self):
        """The seeded persona carries the reverence the project is FOR."""
        src = _app()
        m = re.search(r"const DEFAULT_PERSONA = \{(.*?)\n  \};", src, re.S)
        assert m, "DEFAULT_PERSONA not found"
        blob = m.group(1).lower()
        for marker in ("allah", "god", "islam", "hindu", "dharma",
                       "bhakti", "taqwa", "prayer"):
            assert marker in blob, f"the default persona must mention {marker!r}"
        # reverence without rivalry — the project's stated balance
        assert "without rivalry" in blob or "reverence" in blob

    def test_seed_starts_inactive_on_a_public_site(self):
        """Visitors keep the neutral default until they choose — seeding the
        spiritual persona ACTIVE for every visitor of a public site would
        make a private preference into a public one."""
        src = _app()
        seed = re.search(
            r"personas = \[JSON\.parse\(JSON\.stringify\(DEFAULT_PERSONA\)\)\];\s*"
            r"activePersonaId = '([^']*)';", src)
        assert seed, "seed branch not found"
        assert seed.group(1) == "", "the built-in persona must seed INACTIVE"

    def test_seed_only_when_empty(self):
        """Never clobber a user's own personas on later visits."""
        src = _app()
        assert "if (!Array.isArray(personas) || personas.length === 0)" in src


class TestUiContract:
    def test_index_has_the_persona_controls(self):
        html = INDEX_HTML.read_text(encoding="utf-8")
        for el in ("personaSelect", "personaNew", "personaEdit",
                   "personaDelete", "personaSave", "personaName",
                   "personaPrompt"):
            assert f'id="{el}"' in html, f"missing #{el} in chat/index.html"

    def test_privacy_is_stated_where_people_will_see(self):
        html = INDEX_HTML.read_text(encoding="utf-8")
        assert "stored only in this browser" in html

    def test_app_js_parses(self):
        r = subprocess.run(["node", "--check", str(APP_JS)],
                           capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr


class TestHubNeverStoresPrompts:
    """The server side of the privacy claim — if the hub stored raw
    prompts, browser-only personas would still leak through the chat
    channel. These pin that it does not."""

    def test_provenance_stores_digests_only(self):
        src = (REPO / "api" / "lib" / "request-provenance.js").read_text()
        assert "NEVER stored" in src
        assert "sha256" in src.lower()
        # no raw prompt column in the ledger insert
        for m in re.finditer(r"INSERT INTO hivv_request_provenance\s*\((.*?)\)",
                             src, re.S):
            cols = m.group(1)
            assert "prompt" not in cols.lower() or "prompt_sha" in cols.lower(), (
                "the provenance ledger must not gain a raw prompt column"
            )

    def test_usage_logs_has_no_prompt_column(self):
        src = (REPO / "api" / "lib" / "usage-tracker.js").read_text()
        m = re.search(r"INSERT INTO usage_logs\s*\((.*?)\)", src, re.S)
        assert m, "usage_logs insert not found"
        # exact column NAMES — `error_message` is an error string (fine),
        # a column literally called `message`/`prompt` would be the leak
        cols = {c.strip() for c in m.group(1).lower().split(",")}
        for bad in ("prompt", "message", "content", "system_prompt", "messages"):
            assert bad not in cols, f"usage_logs must not store a {bad!r} column"
