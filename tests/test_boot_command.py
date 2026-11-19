"""Tests for `hivv boot` — the auto-start-at-login toggle — and for the
global yes/no normalisation.

WHY `hivv boot` EXISTS
`hivv start` starts the agent NOW. Whether it comes back after a reboot is
a different question, answered by the service manager (systemd `enable`, or
a macOS LaunchAgent's RunAtLoad). Mixing the two made "is it on?"
unanswerable — and on a laptop it is the difference between a bee that
rejoins the hive on wake and one that silently never comes back.

WHY THE NORMALISATION EXISTS
The user asked for `on`/`off` to mean the same as `yes`/`no` "for all hivv
commands". Doing it once, centrally, means every command that takes a
yes/no-like word gets it — including the ones added later, which nobody
has to remember to update. The danger is the flip side: a free-text field
(a chat message, a node name) must NEVER be rewritten, or `hivv node on`
would look up a node called "yes".

Pure logic — no systemd, no macOS, no network.
"""
import argparse
import importlib.util
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
CLI_PATH = REPO / "public_html" / "hivv-cli.py"

spec = importlib.util.spec_from_file_location("hivv_cli", CLI_PATH)
hivv = importlib.util.module_from_spec(spec)
sys.modules["hivv_cli"] = hivv
spec.loader.exec_module(hivv)


def norm(**kw):
    a = argparse.Namespace(**kw)
    hivv._normalize_bool_args(a)
    return a


class TestBoolArg:
    @pytest.mark.parametrize("word", ["yes", "y", "on", "true", "1", "enable",
                                      "enabled", "up", "start", "auto", "always"])
    def test_true_words(self, word):
        assert hivv._bool_arg(word) is True

    @pytest.mark.parametrize("word", ["no", "n", "off", "false", "0", "disable",
                                      "disabled", "stop", "manual", "never"])
    def test_false_words(self, word):
        assert hivv._bool_arg(word) is False

    @pytest.mark.parametrize("word", ["YES", "On", "OFF", "True", "  no  ", "YeS"])
    def test_case_and_space_insensitive(self, word):
        assert hivv._bool_arg(word) in (True, False)

    def test_none_is_none(self):
        assert hivv._bool_arg(None) is None

    @pytest.mark.parametrize("word", ["maybe", "perhaps", "", "1.5", "onoff"])
    def test_unknown_is_none(self, word):
        assert hivv._bool_arg(word) is None

    def test_empty_string_is_unknown(self):
        # "" is falsy but must not mean "no"
        assert hivv._bool_arg("") is None


class TestNormalizeBoolArgs:
    def test_boolean_slot_is_normalized(self):
        assert norm(state="on").state == "yes"
        assert norm(state="OFF").state == "no"
        assert norm(action="enable").action == "yes"
        assert norm(action="disable").action == "no"

    def test_name_ending_yes_is_normalized(self):
        assert norm(auto_yes="on").auto_yes == "yes"

    def test_name_starting_enable_is_normalized(self):
        assert norm(enable_linger="off").enable_linger == "no"

    @pytest.mark.parametrize("field", ["msg", "name", "query", "text", "question",
                                       "node", "model"])
    def test_free_text_is_never_rewritten(self, field):
        for word in ("on", "off", "yes", "no", "true", "1", "0"):
            out = norm(**{field: word})
            assert getattr(out, field) == word, (
                f"{field}={word!r} is free text and must not be rewritten"
            )

    def test_bool_attribute_is_left_alone(self):
        a = norm(flag=True)
        assert a.flag is True

    def test_non_string_attributes_are_left_alone(self):
        a = norm(n=5, items=["a", "b"], d={"k": "v"})
        assert a.n == 5
        assert a.items == ["a", "b"]
        assert a.d == {"k": "v"}

    def test_no_attributes_is_fine(self):
        norm()

    def test_canonical_values_are_yes_and_no(self):
        # existing `== "yes"` checks in the codebase must keep working
        assert norm(state="on").state == "yes"
        assert norm(state="off").state == "no"


class TestBootCommandExists:
    def test_command_is_registered(self):
        # _resolve_cmds turns the name into the function itself
        entry = hivv.COMMANDS.get("boot")
        assert entry is not None
        assert entry is hivv.cmd_boot or getattr(entry, "__name__", "") == "cmd_boot"

    def test_command_is_callable(self):
        assert callable(getattr(hivv, "cmd_boot", None))

    def test_parser_accepts_boot(self):
        parser = hivv.build_parser()
        args = parser.parse_args(["boot"])
        assert getattr(args, "state", None) is None

    def test_parser_accepts_boot_with_state(self):
        parser = hivv.build_parser()
        args = parser.parse_args(["boot", "yes"])
        assert args.state == "yes"

    @pytest.mark.parametrize("word", ["yes", "no", "on", "off"])
    def test_parser_accepts_every_bool_word(self, word):
        """argparse must NOT use choices= here — 'on'/'off' have to parse."""
        parser = hivv.build_parser()
        args = parser.parse_args(["boot", word])
        assert args.state == word


class TestBootStateDetection:
    """`_boot_state` must always RETURN a state, never raise.

    It is called on every platform, including ones with no systemd and no
    LaunchAgent — an exception here would make `hivv boot` unusable rather
    than merely uninformative.
    """

    def test_returns_a_known_state(self):
        state, detail = hivv._boot_state()
        assert state in ("enabled", "disabled", "not-installed", "unsupported")
        assert isinstance(detail, str) and detail

    def test_does_not_raise_on_any_platform(self, monkeypatch):
        for plat in ("Linux", "Darwin", "Windows", "FreeBSD"):
            monkeypatch.setattr(hivv.platform, "system", lambda p=plat: p)
            state, _ = hivv._boot_state()
            assert state in ("enabled", "disabled", "not-installed", "unsupported")


class TestHelpText:
    def test_boot_is_documented(self):
        help_map = hivv.COMMAND_HELP if hasattr(hivv, "COMMAND_HELP") else None
        if help_map is None:
            # the help table lives in a local dict inside main(); check the
            # source instead — the command must be discoverable
            src = CLI_PATH.read_text()
            assert '"boot":' in src
            assert "auto-start the agent at login" in src
