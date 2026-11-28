"""Windows install on the main site — every OS gets a command that WORKS there.

The report that motivated this file: a visitor copied the homepage's
``curl -sSL https://hivv.org/install-hivv.sh | bash`` into PowerShell and got

    bash : The term 'bash' is not recognized as the name of a cmdlet ...

The Windows installer (`install-hivv.ps1`) already existed and already served
— the homepage simply never showed it, so a Windows visitor was handed a
command that cannot run on Windows. The homepage now carries ONE visible
command behind three labelled OS tabs (macOS/Linux · Windows · WSL), picks the
default from the visitor's own platform, and the copy button always copies
what is ON SCREEN.

Laws pinned here:
  1. the homepage shows a command for every OS, Windows included
  2. the default is DETECTED (a Windows visitor never sees "curl | bash" first)
  3. the copy button reads the DOM — never a hard-coded line
  4. script tags stay balanced (an unclosed one kills the whole page)
  5. cli.html's Windows commands are ones PowerShell can actually run
     (the old `iwr ... | iex; Install-Hivv -WithLlm -Yes` called a function
     that does not exist in the installer)
  6. the installer the page points at really exists, with its wrapper
"""
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PUBLIC = REPO / "public_html"


def _read(name: str) -> str:
    return (PUBLIC / name).read_text(encoding="utf-8")


UNIX_CMD = "curl -sSL https://hivv.org/install-hivv.sh | bash"
WIN_CMD = "iwr -useb https://hivv.org/install-hivv.ps1 | iex"


class TestHomepageShowsEveryOs:
    """The main page must offer a working command for each platform."""

    def test_unix_command_present(self):
        assert UNIX_CMD in _read("index.html")

    def test_windows_command_present(self):
        assert WIN_CMD in _read("index.html"), (
            "the homepage never offers the PowerShell installer — a Windows "
            "visitor copies 'curl | bash' and dies with 'bash: not recognized'")

    def test_wsl_has_its_own_tab(self):
        idx = _read("index.html")
        assert 'data-os="unix"' in idx and 'data-os="win"' in idx and 'data-os="wsl"' in idx, (
            "all three OS tabs must exist and be labelled")

    def test_tabs_are_labelled_for_humans(self):
        idx = _read("index.html")
        assert "macOS / Linux" in idx
        assert "Windows" in idx
        assert "WSL" in idx


class TestDetectionAndCopy:
    """The default comes from the visitor's platform, not from a coin toss."""

    def test_platform_is_detected(self):
        idx = _read("index.html")
        assert "userAgentData" in idx or "navigator.platform" in idx, (
            "no platform detection — Windows visitors keep getting the bash line")

    def test_windows_wins_detection(self):
        # /win/i against platform — Win32, Windows, Win64 all match
        idx = _read("index.html")
        assert "/win/i.test(p)" in idx, "detection must recognise Windows platforms"

    def test_a_remembered_choice_beats_detection(self):
        assert "localStorage.getItem('hivv-install-os')" in _read("index.html")

    def test_copy_reads_the_visible_command(self):
        idx = _read("index.html")
        assert "hivv-install-copy" in idx
        assert "hivv-install-cmd').textContent" in idx, (
            "copy must read what is on screen — a hard-coded string copies the "
            "bash line even when the Windows tab is showing")
        assert "clipboard.writeText('curl" not in idx, (
            "the copy button still hard-codes the unix command")

    def test_windows_prompt_shows_ps_not_dollar(self):
        # PS> instead of $ — a small signal that you are in PowerShell now
        assert "prompt: 'PS>'" in _read("index.html")

    def test_script_tags_balanced(self):
        html = _read("index.html")
        assert html.count("<script") == html.count("</script>"), (
            "an unclosed <script> swallows the next block and kills the page")


class TestNodePanelsCarryBothOs:
    """The 'run a node' panels are copy targets too."""

    def test_join_hive_panel_has_windows_line(self):
        idx = _read("index.html")
        assert "Windows PowerShell:" in idx
        # the panel shows BOTH installs, not just one
        assert idx.count(WIN_CMD) >= 2, "the install + node panels need the ps1 line too"

    def test_path_c_panel_has_windows_line(self):
        idx = _read("index.html")
        assert "# Windows PowerShell:" in idx

    def test_ai_manifest_names_the_windows_installer(self):
        assert "install-hivv.ps1" in _read("index.html")
        assert "install-hivv.ps1" in _read("ai.txt"), (
            "an agent answering a Windows user must learn the ps1 path too")


class TestCliPage:
    """cli.html's Windows commands must be runnable in PowerShell."""

    def test_windows_tab_exists(self):
        cli = _read("cli.html")
        assert 'data-tab="win"' in cli
        assert "Windows PowerShell" in cli

    def test_no_call_to_a_function_that_does_not_exist(self):
        cli = _read("cli.html")
        assert "Install-Hivv" not in cli, (
            "install-hivv.ps1 defines no Install-Hivv function — that command "
            "dies with 'Install-Hivv: The term is not recognized'")

    def test_with_llm_windows_command_uses_the_scriptblock_form(self):
        cli = _read("cli.html")
        assert "[scriptblock]::Create" in cli
        assert "-WithLlm -Yes" in cli

    def test_windows_uninstall_documented(self):
        cli = _read("cli.html")
        assert "-Uninstall" in cli, "the uninstall section must cover PowerShell"

    def test_windows_tab_auto_selected_for_windows_visitors(self):
        cli = _read("cli.html")
        assert 'data-tab="win"' in cli and "/win/i.test(p)" in cli

    def test_script_tags_balanced(self):
        html = _read("cli.html")
        assert html.count("<script") == html.count("</script>")


class TestTheInstallerBehindTheCommand:
    """The page points at install-hivv.ps1 — make sure it is real and complete."""

    def test_installer_exists_where_the_page_points(self):
        assert (PUBLIC / "install-hivv.ps1").is_file(), (
            "the homepage advertises https://hivv.org/install-hivv.ps1 but "
            "public_html/install-hivv.ps1 does not exist")

    def test_installer_fetches_the_cmd_wrapper(self):
        ps1 = _read("install-hivv.ps1")
        # the name is built as "$App.cmd" (hivv.cmd) — don't pin the literal
        assert '$App.cmd' in ps1, "the Windows wrapper it downloads is missing"
        assert (PUBLIC / "hivv.cmd").is_file(), "the wrapper file must be served too"

    def test_installer_sets_tls12_before_downloading(self):
        # PowerShell 5.1 defaults can fail the very first download without this
        assert "Tls12" in _read("install-hivv.ps1")

    def test_installer_documents_its_flags(self):
        ps1 = _read("install-hivv.ps1")
        for flag in ("-WithLlm", "-Uninstall", "-Yes", "-NoPath"):
            assert flag in ps1, f"{flag} missing from the installer's help"

    def test_installer_offers_to_install_python(self):
        # "requires python3" with no path forward is a dead end on Windows
        assert "winget install" in _read("install-hivv.ps1")

    def test_installer_registers_the_logon_task(self):
        assert "Register-ScheduledTask" in _read("install-hivv.ps1")


class TestInstallerPutsHivvOnTheCommandLine:
    """The report: after a plain 'iwr | iex' the 'hivv' command was NOT on the
    command line — the installer only PRINTED the two commands to add PATH by
    hand, and ollama (which it had just installed) was invisible to the
    running session."""

    def test_installer_asks_about_path_instead_of_printing_notes(self):
        import re
        ps1 = _read("install-hivv.ps1")
        assert re.search(r'Read-Host\s+"[^"]*PATH[^"]*\[Y/n\]"', ps1), (
            "no PATH prompt - a plain install leaves hivv off the command "
            "line and hands the visitor manual instructions instead")

    def test_path_is_added_to_the_current_session_too(self):
        # iwr | iex runs IN the visitor's window - hivv must resolve the
        # moment the script returns, no "reopen your terminal" required
        ps1 = _read("install-hivv.ps1")
        assert '$env:Path = "$BinDir;$env:Path"' in ps1

    def test_yes_still_adds_path_non_interactively(self):
        ps1 = _read("install-hivv.ps1")
        assert "[bool]$Yes" in ps1, "-Yes must still add PATH with no prompt"

    def test_no_path_flag_stays_silent(self):
        # -NoPath means don't touch it AND don't lecture about it
        ps1 = _read("install-hivv.ps1")
        assert "$needsPath -and -not $NoPath" in ps1

    def test_declining_path_still_prints_the_manual_commands(self):
        ps1 = _read("install-hivv.ps1")
        assert "SetEnvironmentVariable('Path'" in ps1

    def test_ollama_install_refreshes_the_session_path(self):
        # winget writes the registry PATH; the running session must re-read it
        # or Get-Command ollama misses the install that just succeeded
        ps1 = _read("install-hivv.ps1")
        assert ps1.count("Update-PathFromRegistry") >= 3, (
            "expected the definition + the python path + the ollama path")

    def test_ollama_failure_message_names_the_real_fix(self):
        ps1 = _read("install-hivv.ps1")
        assert "not visible in THIS window" in ps1

    def test_console_output_tries_utf8(self):
        # PS 5.1 on the OEM codepage renders the banner's emoji as '?'
        assert "[Console]::OutputEncoding" in _read("install-hivv.ps1")
