#!/usr/bin/env bash
# scripts/lib/deps.sh — shared, cross-platform dependency installer.
#
# The problem this solves: HIVV's setup scripts used to say
#   "[ERROR] Node.js is not installed. Please install Node.js 18+ first."
# and exit 1. That is a dead end for a person who just cloned the repo.
#
# This library instead:
#   1. detects the OS + package manager,
#   2. auto-installs what's missing when it safely can,
#   3. ALWAYS prints the exact copy-paste command to type otherwise,
#   4. falls back to a user-local install that needs no sudo at all.
#
# Supported package managers: apt, dnf, yum, pacman, apk, zypper, brew,
# winget, scoop, choco, nvm/fnm (node only).
#
# Source this file — it defines functions, it does not run anything by itself.

# ── colors (safe when sourced) ──────────────────────────────────────────
if [[ -t 1 ]]; then
    D_RST=$'\033[0m'; D_BLD=$'\033[1m'; D_DIM=$'\033[2m'
    D_RED=$'\033[31m'; D_GRN=$'\033[32m'; D_YLW=$'\033[33m'; D_BLU=$'\033[34m'; D_CYN=$'\033[36m'
else
    D_RST=""; D_BLD=""; D_DIM=""; D_RED=""; D_GRN=""; D_YLW=""; D_BLU=""; D_CYN=""
fi

# ── tiny output helpers (prefixed to avoid clobbering caller's funcs) ───
dlog()   { printf '%s\n' "$*"; }
dstep()  { printf '%s==>%s %s%s%s\n' "$D_BLU" "$D_RST" "$D_BLD" "$1" "$D_RST"; }
dok()    { printf '  %s✓%s %s\n' "$D_GRN" "$D_RST" "$1"; }
dwarn()  { printf '  %s!%s %s\n' "$D_YLW" "$D_RST" "$1"; }
dfail()  { printf '  %s✗%s %s\n' "$D_RED" "$D_RST" "$1"; }
dinfo()  { printf '  %s→%s %s\n' "$D_DIM" "$D_RST" "$1"; }
dcmd()   { printf '    %s$ %s%s\n' "$D_CYN" "$1" "$D_RST"; }

# ── platform detection ──────────────────────────────────────────────────
# Sets: D_OS, D_ARCH, D_PKG (apt|dnf|yum|pacman|apk|zypper|brew|winget|scoop|choco|none)
#       D_LINUX_DISTRO, D_SUDO
detect_platform() {
    D_OS="$(uname -s 2>/dev/null || echo unknown)"
    D_ARCH="$(uname -m 2>/dev/null || echo unknown)"
    D_PKG="none"
    D_LINUX_DISTRO=""

    case "$D_OS" in
        Linux)
            if   command -v apt-get >/dev/null 2>&1; then D_PKG="apt"
            elif command -v dnf     >/dev/null 2>&1; then D_PKG="dnf"
            elif command -v yum     >/dev/null 2>&1; then D_PKG="yum"
            elif command -v pacman  >/dev/null 2>&1; then D_PKG="pacman"
            elif command -v apk     >/dev/null 2>&1; then D_PKG="apk"
            elif command -v zypper  >/dev/null 2>&1; then D_PKG="zypper"
            fi
            if [[ -r /etc/os-release ]]; then
                # shellcheck disable=SC1091
                D_LINUX_DISTRO="$(. /etc/os-release 2>/dev/null && echo "${ID:-unknown}")"
            fi
            ;;
        Darwin)
            D_PKG="brew"
            command -v brew >/dev/null 2>&1 || D_PKG="none"
            ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT)
            D_OS="windows"
            if   command -v winget >/dev/null 2>&1; then D_PKG="winget"
            elif command -v scoop >/dev/null 2>&1; then D_PKG="scoop"
            elif command -v choco  >/dev/null 2>&1; then D_PKG="choco"
            fi
            ;;
    esac

    # sudo availability (non-interactive only — never prompt the user here)
    D_SUDO=""
    if [[ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]]; then
        D_SUDO=""                                    # already root
    elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
        D_SUDO="sudo"
    fi
    export D_OS D_ARCH D_PKG D_LINUX_DISTRO D_SUDO
}

# ── privilege runner ────────────────────────────────────────────────────
# Runs a command with root when possible, else falls back to the plain
# command. Escalation ladder (wahi 2026-11-24 — password-only sudo used to
# make every privileged step a silent no-op):
#   root → plain · passwordless sudo → sudo -n ·
#   a human at a TTY → plain sudo (it asks THEM, prompt goes to /dev/tty) ·
#   otherwise → the plain command (never a prompt — CI/cron/piped must not hang)
d_run_privileged() {
    if [[ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]]; then
        "$@"
    elif [[ -n "$D_SUDO" ]]; then
        "$D_SUDO" -n "$@"
    elif d_can_prompt_sudo; then
        # a human is watching: plain sudo asks THEM (prompt → /dev/tty)
        sudo "$@"
    else
        "$@"
    fi
}

# ── the `hivv` COMMAND itself ───────────────────────────────────────────
# THE FAILURE THIS FIXES
# ----------------------
# A clone contains a working CLI, but NOT on PATH. Right after setup the
# script printed "hivv chat ..." as the next step while `hivv` did not
# exist → "command not found" (2026-11-18). The agent even started fine,
# so nothing looked broken until the first real command.
#
# The LAYOUT IS THE CONTRACT — do not invent another one:
#
#     <prefix>/bin/hivv              ← the wrapper (bash)
#     <prefix>/lib/hivv/hivv-cli.py   ← the client (python)
#
# hivv-cli.py derives INSTALL_DIR from its own location (<prefix>/lib/hivv)
# and BIN_DIR from that (<prefix>/bin). The wrapper resolves the client
# relative to ITSELF the same way. So in this layout `hivv update` updates
# the INSTALLED copy — never a source checkout.
#
# Usage: d_install_cli <prefix> <use_sudo:0|1> <public_dir>
# Echoes the installed wrapper path on success; returns 1 on failure.
d_install_cli() {
    local prefix="${1:-$HOME/.local}" use_sudo="${2:-0}" public_dir="${3:-}"
    local lib_dir="$prefix/lib/hivv" bin_file="$prefix/bin/hivv"
    local sudo_cmd=""
    [[ "$use_sudo" == "1" ]] && sudo_cmd="$D_SUDO"

    if [[ ! -f "$public_dir/hivv-cli.py" ]] || [[ ! -f "$public_dir/hivv" ]]; then
        return 1
    fi
    $sudo_cmd mkdir -p "$lib_dir" "$prefix/bin" 2>/dev/null || return 1
    # NEVER write through a clone link. `cp src dst` with dst a symlink
    # follows it — so installing would overwrite the CLONE the user linked
    # with these bytes (clobbering their source, or "same file" erroring).
    # The link is the user's explicit choice (`hivv link`) — keep it.
    if [[ -L "$lib_dir/hivv-cli.py" ]]; then
        printf '[hivv] kept your clone link: %s -> %s\n' \
            "$lib_dir/hivv-cli.py" "$(readlink "$lib_dir/hivv-cli.py" 2>/dev/null)" >&2
        printf '[hivv] (run `hivv unlink` first if you want a standalone copy)\n' >&2
    else
        $sudo_cmd cp "$public_dir/hivv-cli.py" "$lib_dir/hivv-cli.py" 2>/dev/null || return 1
    fi
    $sudo_cmd cp "$public_dir/hivv" "$bin_file" 2>/dev/null || return 1
    $sudo_cmd chmod 0755 "$lib_dir/hivv-cli.py" "$bin_file" 2>/dev/null || return 1
    printf '%s\n' "$bin_file"
    return 0
}

# ── PATH: keep the CLI's bin dir reachable in FUTURE shells ─────────────
# The current shell is fixed by the caller (export PATH=...); a new terminal
# needs the rc file. Prints the rc file it touched, or nothing if PATH was
# already fine.
d_ensure_path() {
    local bin_dir="${1:-$HOME/.local/bin}" rc="" line=""
    case "${SHELL:-/bin/bash}" in
        */zsh)  rc="$HOME/.zshrc" ;;
        */fish) return 0 ;;   # fish needs `fish_add_path` — printed by the caller
        *)      rc="$HOME/.bashrc" ;;
    esac
    [[ -n "$rc" ]] || return 0
    [[ -f "$rc" ]] || : > "$rc" 2>/dev/null || return 0
    grep -qF "$bin_dir" "$rc" 2>/dev/null && return 0
    line="export PATH=\"$bin_dir:\$PATH\""
    printf '\n# hivv CLI\n%s\n' "$line" >> "$rc" 2>/dev/null || return 0
    printf '%s\n' "$rc"
    return 0
}

# ── the manual fallback table ───────────────────────────────────────────
# Every OS gets an exact command. This is the "at the minimum tell them
# what to type" requirement — always shown when auto-install is impossible.
d_node_manual_hint() {
    case "$D_OS" in
        Linux)
            case "$D_PKG" in
                apt)
                    dcmd "sudo apt-get update && sudo apt-get install -y nodejs npm"
                    dcmd "# or newer: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
                    ;;
                dnf)
                    dcmd "sudo dnf install -y nodejs npm"
                    ;;
                yum)
                    dcmd "sudo yum install -y nodejs npm"
                    ;;
                pacman)
                    dcmd "sudo pacman -S --noconfirm nodejs npm"
                    ;;
                apk)
                    dcmd "sudo apk add nodejs npm"
                    ;;
                zypper)
                    dcmd "sudo zypper install -y nodejs npm"
                    ;;
                *)
                    dcmd "# no package manager detected — install Node.js 18+ from https://nodejs.org/en/download"
                    ;;
            esac
            ;;
        Darwin)
            if command -v brew >/dev/null 2>&1; then
                dcmd "brew install node"
            else
                dcmd "# install Homebrew first: /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
                dcmd "brew install node"
            fi
            ;;
        windows)
            dcmd "winget install OpenJS.NodeJS.LTS"
            dcmd "# or: scoop install nodejs   /   choco install nodejs-lts"
            ;;
    esac
}

d_python_manual_hint() {
    case "$D_OS" in
        Linux)
            case "$D_PKG" in
                apt)    dcmd "sudo apt-get update && sudo apt-get install -y python3 python3-pip" ;;
                dnf)    dcmd "sudo dnf install -y python3 python3-pip" ;;
                yum)    dcmd "sudo yum install -y python3 python3-pip" ;;
                pacman) dcmd "sudo pacman -S --noconfirm python python-pip" ;;
                apk)    dcmd "sudo apk add python3 py3-pip" ;;
                zypper) dcmd "sudo zypper install -y python3 python3-pip" ;;
                *)      dcmd "# install Python 3.8+ from https://www.python.org/downloads/" ;;
            esac
            ;;
        Darwin)
            dcmd "brew install python3"
            ;;
        windows)
            dcmd "winget install Python.Python.3.12"
            dcmd "# or: scoop install python   /   choco install python"
            ;;
    esac
}

# ── node version helpers ────────────────────────────────────────────────
d_node_major() {
    local v="${1:-}"
    v="${v#v}"
    echo "${v%%.*}"
}

d_node_version() {
    node --version 2>/dev/null || echo ""
}

d_have_node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    local major
    major="$(d_node_major "$(d_node_version)")"
    [[ -n "$major" ]] && [[ "$major" =~ ^[0-9]+$ ]] && [[ "$major" -ge 18 ]]
}

# ── install node ────────────────────────────────────────────────────────
# Returns 0 if node >= 18 is available afterwards.
#   d_install_node [--no-auto]
# Without --no-auto it tries hard to install; on failure it prints the
# exact commands for the detected OS and returns 1.
d_install_node() {
    local auto=1
    [[ "${1:-}" == "--no-auto" ]] && auto=0

    if d_have_node_ok; then
        dok "node $(d_node_version)"
        return 0
    fi

    if command -v node >/dev/null 2>&1; then
        dwarn "node $(d_node_version) is too old — HIVV needs node 18+"
    else
        dwarn "node not found"
    fi

    if [[ "$auto" -eq 0 ]]; then
        printf '\n  %sInstall Node.js 18+:%s\n' "$D_BLD" "$D_RST"
        d_node_manual_hint
        printf '\n'
        return 1
    fi

    printf '\n  %sInstalling Node.js 18+ for you…%s\n' "$D_BLD" "$D_RST"

    # ── attempt 1: native package manager (system-wide, needs root) ─────
    if d_try_node_pkgmanager; then
        if d_have_node_ok; then
            dok "installed node $(d_node_version)"
            return 0
        fi
    fi

    # ── attempt 2: NodeSource (Debian/Ubuntu/Raspbian) ────────────────
    if [[ "$D_PKG" == "apt" ]]; then
        dinfo "trying NodeSource..."
        if curl -fsSL --connect-timeout 15 --max-time 60 https://deb.nodesource.com/setup_20.x \
             | d_run_privileged bash - >/dev/null 2>&1; then
            d_run_privileged apt-get install -y nodejs >/dev/null 2>&1 || true
            if d_have_node_ok; then
                dok "installed node $(d_node_version) (NodeSource 20.x)"
                return 0
            fi
        fi
    fi

    # ── attempt 3: fnm / nvm (user-local, NO sudo needed) ─────────────
    if d_try_node_userlocal; then
        if d_have_node_ok; then
            dok "installed node $(d_node_version) (user-local)"
            return 0
        fi
    fi

    # ── attempt 4: Node.js official tarball (user-local, NO sudo) ─────
    if d_try_node_tarball; then
        if d_have_node_ok; then
            dok "installed node $(d_node_version) (official tarball)"
            return 0
        fi
    fi

    # ── attempt 5: Windows package managers ───────────────────────────
    if [[ "$D_OS" == "windows" ]]; then
        if d_try_node_windows; then
            if d_have_node_ok; then
                dok "installed node $(d_node_version)"
                return 0
            fi
        fi
    fi

    printf '\n  %s✗ Could not install Node.js automatically.%s\n' "$D_RED$D_BLD" "$D_RST"
    printf '  %sRun one of these, then re-run the setup script:%s\n\n' "$D_BLD" "$D_RST"
    d_node_manual_hint
    printf '\n'
    return 1
}

# ── node install: native package manager ───────────────────────────────
d_try_node_pkgmanager() {
    case "$D_PKG" in
        apt)
            d_run_privileged apt-get update >/dev/null 2>&1 || true
            d_run_privileged apt-get install -y nodejs npm >/dev/null 2>&1
            ;;
        dnf)
            d_run_privileged dnf install -y nodejs npm >/dev/null 2>&1
            ;;
        yum)
            d_run_privileged yum install -y nodejs npm >/dev/null 2>&1
            ;;
        pacman)
            d_run_privileged pacman -S --noconfirm nodejs npm >/dev/null 2>&1
            ;;
        apk)
            d_run_privileged apk add --no-cache nodejs npm >/dev/null 2>&1
            ;;
        zypper)
            d_run_privileged zypper --non-interactive install nodejs npm >/dev/null 2>&1
            ;;
        brew)
            brew install node >/dev/null 2>&1
            ;;
        winget|scoop|choco)
            return 1   # handled by d_try_node_windows
            ;;
        *)
            return 1
            ;;
    esac
    d_have_node_ok
}

# ── node install: fnm or nvm (user-local) ───────────────────────────────
d_try_node_userlocal() {
    local fnm_dir="$HOME/.local/share/fnm"
    local nvm_dir="$HOME/.nvm"

    # fnm first — it's a single static binary, no shell rc juggling needed
    if ! command -v fnm >/dev/null 2>&1 && ! command -v nvm >/dev/null 2>&1; then
        local os arch url
        os="$(uname -s | tr '[:upper:]' '[:lower:]')"
        arch="$(uname -m)"
        case "$arch" in
            x86_64|amd64) arch="x64" ;;
            aarch64|arm64) arch="arm64" ;;
        esac
        if [[ "$D_OS" == "windows" ]]; then
            os="windows"; arch="x64"
        fi
        url="https://github.com/Schniz/fnm/releases/latest/download/fnm-${os}-${arch}.zip"
        dinfo "trying fnm (user-local, no sudo)…"
        local tmp
        tmp="$(mktemp -d 2>/dev/null || echo "/tmp/hivv-fnm-$$")"
        if command -v curl >/dev/null 2>&1 \
           && curl -fsSL --connect-timeout 15 --max-time 120 "$url" -o "$tmp/fnm.zip" 2>/dev/null \
           && (command -v unzip >/dev/null 2>&1) \
           && unzip -oq "$tmp/fnm.zip" -d "$tmp/fnm" 2>/dev/null; then
            mkdir -p "$fnm_dir"
            if find "$tmp/fnm" -type f -name 'fnm*' ! -name '*.zip' -exec install -m 0755 {} "$fnm_dir/fnm" \; 2>/dev/null \
               || find "$tmp/fnm" -type f -name 'fnm*' -exec cp {} "$fnm_dir/fnm" \; 2>/dev/null; then
                export PATH="$fnm_dir:$PATH"
                if "$fnm_dir/fnm" install --lts >/dev/null 2>&1; then
                    local nb
                    nb="$("$fnm_dir/fnm" env --shell bash 2>/dev/null | sed -n 's/^export PATH="\(.*\)"$/\1/p' | head -1)"
                    [[ -n "$nb" ]] && export PATH="$nb:$PATH"
                    rm -rf "$tmp"
                    d_have_node_ok && return 0
                fi
            fi
        fi
        rm -rf "$tmp" 2>/dev/null || true
    fi

    # nvm — shell function based, so we must source it
    if [[ ! -s "$nvm_dir/nvm.sh" ]]; then
        dinfo "trying nvm (user-local, no sudo)…"
        if command -v curl >/dev/null 2>&1; then
            curl -fsSL --connect-timeout 15 --max-time 120 https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh \
                | bash >/dev/null 2>&1 || true
        fi
    fi
    if [[ -s "$nvm_dir/nvm.sh" ]]; then
        # shellcheck disable=SC1090
        . "$nvm_dir/nvm.sh" >/dev/null 2>&1 || true
        if command -v nvm >/dev/null 2>&1; then
            nvm install 20 >/dev/null 2>&1 || nvm install --lts >/dev/null 2>&1 || true
            nvm use 20 >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
            d_have_node_ok && return 0
        fi
    fi
    return 1
}

# ── node install: official tarball (no sudo, no shell rc needed) ────────
d_try_node_tarball() {
    case "$D_OS" in
        Linux)  os="linux"; ext="tar.xz" ;;
        Darwin) os="darwin"; ext="tar.gz" ;;
        *)      return 1 ;;
    esac
    local arch tarball url
    case "$D_ARCH" in
        x86_64|amd64)  arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        # armv7l has no official tarball build — skip rather than 404
        *)             return 1 ;;
    esac

    # Resolve the newest LTS major LIVE (never hardcode — Node LTS lines move).
    # nodejs.org/dist/index.json has an "lts" field: a string for LTS releases,
    # false for Current. Pick the highest major that has lts !== false.
    local lts="" lts_ver="" idx
    if command -v curl >/dev/null 2>&1; then
        idx="$(curl -fsSL --connect-timeout 10 --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null)" || idx=""
    fi
    if [[ -n "$idx" ]]; then
        # Each entry is one JSON object; keep the first (newest) that is LTS.
        lts_ver="$(printf '%s' "$idx" | tr '{' '\n' \
            | grep -v '"lts":false' \
            | grep -o '"version":"v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' \
            | head -1 | grep -o 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')"
        lts="${lts_ver#v}"; lts="${lts%%.*}"
    fi
    # Fallbacks if the index is unreachable: known-good LTS lines.
    if [[ ! "$lts" =~ ^[0-9]+$ ]] || [[ "$lts" -lt 18 ]]; then
        lts="22"
    fi
    if [[ ! "$lts_ver" =~ ^v[0-9] ]]; then
        # Resolve the exact patch release for that major from the index.
        lts_ver="$(printf '%s' "$idx" | tr '{' '\n' \
            | grep -o "\"version\":\"v${lts}\.[0-9][0-9]*\.[0-9][0-9]*\"" \
            | head -1 | grep -o 'v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*')"
    fi
    [[ "$lts_ver" =~ ^v[0-9] ]] || lts_ver="v${lts}.0.0"

    tarball="node-${lts_ver}-${os}-${arch}.${ext}"
    url="https://nodejs.org/dist/${lts_ver}/${tarball}"

    local base="$HOME/.local/node"
    local tmp
    tmp="$(mktemp -d 2>/dev/null || echo "/tmp/hivv-node-$$")"
    dinfo "downloading official Node.js ${lts} tarball…"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --connect-timeout 15 --max-time 300 "$url" -o "$tmp/node.tar" 2>/dev/null || {
            rm -rf "$tmp"; return 1;
        }
    elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=300 -O "$tmp/node.tar" "$url" 2>/dev/null || {
            rm -rf "$tmp"; return 1;
        }
    else
        rm -rf "$tmp"; return 1
    fi

    mkdir -p "$base" || { rm -rf "$tmp"; return 1; }
    case "$ext" in
        tar.xz) tar -xJf "$tmp/node.tar" -C "$base" --strip-components=1 2>/dev/null ;;
        *)      tar -xzf "$tmp/node.tar" -C "$base" --strip-components=1 2>/dev/null ;;
    esac
    rm -rf "$tmp" 2>/dev/null || true

    [[ -x "$base/bin/node" ]] || return 1
    export PATH="$base/bin:$PATH"
    d_have_node_ok && return 0
    return 1
}

# ── node install: Windows package managers ──────────────────────────────
d_try_node_windows() {
    case "$D_PKG" in
        winget)
            dinfo "trying winget…"
            winget install --silent --accept-source-agreements --accept-package-agreements \
                --id OpenJS.NodeJS.LTS >/dev/null 2>&1
            ;;
        scoop)
            dinfo "trying scoop…"
            scoop install nodejs >/dev/null 2>&1
            ;;
        choco)
            dinfo "trying chocolatey…"
            choco install nodejs-lts -y >/dev/null 2>&1
            ;;
        *)
            return 1
            ;;
    esac
    # Refresh PATH from the machine+user environment (winget writes there)
    if command -v powershell >/dev/null 2>&1; then
        local winpath
        winpath="$(powershell -NoProfile -Command \
            "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')" \
            2>/dev/null || echo "")"
        if [[ -n "$winpath" ]]; then
            export PATH="$(echo "$winpath" | tr ';' ':'):$PATH"
        fi
    fi
    d_have_node_ok
}

# ── python ──────────────────────────────────────────────────────────────
d_have_python_ok() {
    local p
    for p in python3 python; do
        if command -v "$p" >/dev/null 2>&1; then
            local v major minor
            v="$("$p" -c 'import sys;print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || echo 0.0)"
            major="${v%%.*}"; minor="${v##*.}"
            if [[ "$major" =~ ^[0-9]+$ ]] && { [[ "$major" -gt 3 ]] || { [[ "$major" -eq 3 ]] && [[ "$minor" =~ ^[0-9]+$ ]] && [[ "$minor" -ge 8 ]]; }; }; then
                D_PYTHON_BIN="$p"
                export D_PYTHON_BIN
                return 0
            fi
        fi
    done
    return 1
}

d_install_python() {
    local auto=1
    [[ "${1:-}" == "--no-auto" ]] && auto=0

    if d_have_python_ok; then
        dok "python $("$D_PYTHON_BIN" --version 2>&1 | awk '{print $2}') ($D_PYTHON_BIN)"
        return 0
    fi

    dwarn "python 3.8+ not found — the hivv CLI will not run (the gateway still will)"

    if [[ "$auto" -eq 0 ]]; then
        printf '\n  %sInstall Python 3.8+ (optional — only needed for the hivv CLI):%s\n' "$D_BLD" "$D_RST"
        d_python_manual_hint
        printf '\n'
        return 1
    fi

    printf '\n  %sInstalling Python…%s\n' "$D_BLD" "$D_RST"
    case "$D_PKG" in
        apt)
            d_run_privileged apt-get update >/dev/null 2>&1 || true
            d_run_privileged apt-get install -y python3 python3-pip >/dev/null 2>&1
            ;;
        dnf)    d_run_privileged dnf install -y python3 python3-pip >/dev/null 2>&1 ;;
        yum)    d_run_privileged yum install -y python3 python3-pip >/dev/null 2>&1 ;;
        pacman) d_run_privileged pacman -S --noconfirm python python-pip >/dev/null 2>&1 ;;
        apk)    d_run_privileged apk add --no-cache python3 py3-pip >/dev/null 2>&1 ;;
        zypper) d_run_privileged zypper --non-interactive install python3 python3-pip >/dev/null 2>&1 ;;
        brew)   brew install python3 >/dev/null 2>&1 ;;
        winget) winget install --silent --accept-source-agreements --accept-package-agreements \
                    --id Python.Python.3.12 >/dev/null 2>&1 ;;
        scoop)  scoop install python >/dev/null 2>&1 ;;
        choco)  choco install python -y >/dev/null 2>&1 ;;
    esac

    if d_have_python_ok; then
        dok "installed python $("$D_PYTHON_BIN" --version 2>&1 | awk '{print $2}')"
        return 0
    fi

    printf '\n  %s!%s Could not install Python automatically (it is optional).\n' "$D_YLW" "$D_RST"
    printf '    %sRun this if you want the hivv CLI:%s\n' "$D_DIM" "$D_RST"
    d_python_manual_hint
    printf '\n'
    return 1
}

# ── postgres (OPTIONAL — local-first mode does not need it) ─────────────
d_have_psql() {
    command -v psql >/dev/null 2>&1
}

d_install_postgres() {
    local auto=1
    [[ "${1:-}" == "--no-auto" ]] && auto=0

    if d_have_psql; then
        dok "psql $(psql --version 2>/dev/null | awk '{print $3}')"
        return 0
    fi

    dwarn "PostgreSQL client not found — only needed for the hosted/multi-user mode"

    if [[ "$auto" -eq 0 ]]; then
        printf '\n  %sInstall PostgreSQL (optional — local-first mode does NOT need it):%s\n' "$D_BLD" "$D_RST"
        case "$D_PKG" in
            apt)    dcmd "sudo apt-get install -y postgresql postgresql-client" ;;
            dnf)    dcmd "sudo dnf install -y postgresql postgresql" ;;
            yum)    dcmd "sudo yum install -y postgresql postgresql" ;;
            pacman) dcmd "sudo pacman -S --noconfirm postgresql" ;;
            apk)    dcmd "sudo apk add postgresql postgresql-client" ;;
            zypper) dcmd "sudo zypper install -y postgresql postgresql" ;;
            brew)   dcmd "brew install postgresql@16 && brew services start postgresql@16" ;;
            *)      dcmd "# install PostgreSQL from https://www.postgresql.org/download/" ;;
        esac
        printf '\n'
        return 1
    fi

    printf '\n  %sInstalling PostgreSQL…%s\n' "$D_BLD" "$D_RST"
    case "$D_PKG" in
        apt)    d_run_privileged apt-get update >/dev/null 2>&1 || true
                d_run_privileged apt-get install -y postgresql postgresql-client >/dev/null 2>&1 ;;
        dnf)    d_run_privileged dnf install -y postgresql postgresql >/dev/null 2>&1 ;;
        yum)    d_run_privileged yum install -y postgresql postgresql >/dev/null 2>&1 ;;
        pacman) d_run_privileged pacman -S --noconfirm postgresql >/dev/null 2>&1 ;;
        apk)    d_run_privileged apk add --no-cache postgresql postgresql-client >/dev/null 2>&1 ;;
        zypper) d_run_privileged zypper --non-interactive install postgresql postgresql >/dev/null 2>&1 ;;
        brew)   brew install postgresql@16 >/dev/null 2>&1 ;;
    esac

    if d_have_psql; then
        dok "installed psql $(psql --version 2>/dev/null | awk '{print $3}')"
        return 0
    fi
    dwarn "PostgreSQL install failed — continuing in local-first mode (no database needed)"
    return 1
}

# ── pm2 (optional — only for the hosted/PM2 mode) ───────────────────────
d_have_pm2() {
    command -v pm2 >/dev/null 2>&1
}

d_install_pm2() {
    if d_have_pm2; then
        dok "pm2 $(pm2 --version 2>/dev/null | tail -1)"
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        dwarn "npm not available — skipping pm2"
        return 1
    fi
    dinfo "installing pm2…"
    npm install -g pm2 --silent --no-audit --no-fund >/dev/null 2>&1
    if d_have_pm2; then
        dok "installed pm2 $(pm2 --version 2>/dev/null | tail -1)"
        return 0
    fi
    dwarn "pm2 install failed — you can run the gateway directly with: node api/server.js"
    return 1
}

# ── build tools (git + cmake + C++ compiler + make) — for llama.cpp ──────
# THE FAILURE THIS FIXES
# ----------------------
# 2026-11-21 (asher@wahi): `hivv install llm` on a box without git died with
#   FileNotFoundError: [Errno 2] No such file or directory: 'git'
# — a Python traceback mid-install with no way forward. cmake was equally
# unchecked: a box with git but no cmake failed one step later with the
# same traceback.
#
# The contract (same as everything else in this file): auto-install when we
# safely can, otherwise print the EXACT copy-paste command and return 1.
# NEVER prompt for a password — `sudo -n` only, or CI hangs.
d_have_build_tools() {
    command -v git >/dev/null 2>&1 || return 1
    command -v cmake >/dev/null 2>&1 || return 1
    command -v make >/dev/null 2>&1 || return 1
    # cxx = ANY C++ compiler — wahi 2026-11-25: configure died with
    # "No CMAKE_CXX_COMPILER could be found" after git+cmake had passed.
    command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 \
        || command -v clang++ >/dev/null 2>&1
}

d_build_tools_hint() {
    case "$D_PKG" in
        apt)    dcmd "sudo apt-get update && sudo apt-get install -y git cmake g++ make" ;;
        dnf)    dcmd "sudo dnf install -y git cmake gcc-c++ make" ;;
        yum)    dcmd "sudo yum install -y git cmake gcc-c++ make" ;;
        pacman) dcmd "sudo pacman -S --noconfirm git cmake gcc make" ;;
        apk)    dcmd "sudo apk add git cmake g++ make" ;;
        zypper) dcmd "sudo zypper --non-interactive install git cmake gcc-c++ make" ;;
        brew)   dcmd "brew install git cmake" ;;
        *)
            if [[ "$D_OS" == "Darwin" ]]; then
                # A Mac with NO Homebrew has no package manager to name, so the
                # Linux line below is a dead end — and it lists git, a C++
                # compiler and make, three things this Mac already has (Xcode
                # Command Line Tools). Only cmake was missing, and there was no
                # way to get it. Same wall the CLI hit (2026-11-28).
                dinfo "this Mac needs cmake — git, your C++ compiler and make are already installed"
                dcmd '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
                dcmd "brew install cmake"
                dinfo "…or skip the build entirely — llama.cpp ships prebuilt macOS binaries:"
                dcmd "hivv llm install-llama --auto"
            else
                dcmd "install git, cmake, a C++ compiler and make with your package manager"
            fi
            ;;
    esac
}

d_install_build_tools() {
    if d_have_build_tools; then
        dok "build tools present (git, cmake, C++ compiler, make)"
        return 0
    fi

    dwarn "git/cmake/C++ compiler/make missing — needed to build llama.cpp from source"

    case "$D_PKG" in
        apt)
            d_run_privileged apt-get update >/dev/null 2>&1 || true
            d_run_privileged apt-get install -y git cmake g++ make >/dev/null 2>&1
            ;;
        dnf)    d_run_privileged dnf install -y git cmake gcc-c++ make >/dev/null 2>&1 ;;
        yum)    d_run_privileged yum install -y git cmake gcc-c++ make >/dev/null 2>&1 ;;
        pacman) d_run_privileged pacman -S --noconfirm git cmake gcc make >/dev/null 2>&1 ;;
        apk)    d_run_privileged apk add --no-cache git cmake g++ make >/dev/null 2>&1 ;;
        zypper) d_run_privileged zypper --non-interactive install git cmake gcc-c++ make >/dev/null 2>&1 ;;
        brew)   brew install git cmake >/dev/null 2>&1 ;;
    esac

    if d_have_build_tools; then
        dok "installed build tools (git, cmake, C++ compiler, make)"
        return 0
    fi
    printf '\n  %s!%s Could not install the build tools automatically.\n' "$D_YLW" "$D_RST"
    printf '    %sRun this to build the local LLM:%s\n' "$D_DIM" "$D_RST"
    d_build_tools_hint
    printf '\n'
    return 1
}

# ── contributor tools: git + gh ─────────────────────────────────────────
# HIVV's source is open, and AI agents are explicitly welcome to change it
# (see CONTRIBUTING.md "For AI agents" and /ai.txt). git is the transport;
# gh is the PR/issue surface.
#
# NEITHER IS REQUIRED TO RUN HIVV. They are required only to CONTRIBUTE, so
# the rule here is the same as everywhere else in this file: ASK, don't
# decide — and when we do install, never dead-end (auto-install, else print
# the exact copy-paste command).
d_have_git() { command -v git >/dev/null 2>&1; }
d_have_gh()   { command -v gh   >/dev/null 2>&1; }

d_dev_tools_hint() {
    case "$D_PKG" in
        apt)    dcmd "sudo apt-get update && sudo apt-get install -y git gh" ;;
        dnf)    dcmd "sudo dnf install -y git gh" ;;
        yum)    dcmd "sudo yum install -y git gh" ;;
        pacman) dcmd "sudo pacman -S --noconfirm git github-cli" ;;
        apk)    dcmd "sudo apk add git github-cli" ;;
        zypper) dcmd "sudo zypper --non-interactive install git github-cli" ;;
        brew)   dcmd "brew install git gh" ;;
        winget) dcmd "winget install --id GitHub.cli -e --source winget" ;;
        scoop)  dcmd "scoop install git gh" ;;
        choco)  dcmd "choco install git gh -y" ;;
        *)      dcmd "install git and the GitHub CLI (gh) with your package manager" ;;
    esac
}

# gh is NOT in every distro's default repo set. When the package manager
# cannot find it, the official install script is the exact command — and it
# needs no guesswork about universe/extra repos.
d_gh_official_hint() {
    dcmd "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null"
    dcmd "sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg"
    dcmd "echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\" | sudo tee /etc/apt/sources.list.d/github-cli.list"
    dcmd "sudo apt-get update && sudo apt-get install -y gh"
}

d_install_dev_tools() {
    if d_have_git && d_have_gh; then
        dok "contributor tools present (git, gh)"
        return 0
    fi

    case "$D_PKG" in
        apt)
            d_run_privileged apt-get update >/dev/null 2>&1 || true
            d_run_privileged apt-get install -y git >/dev/null 2>&1
            d_run_privileged apt-get install -y gh >/dev/null 2>&1
            ;;
        dnf)    d_run_privileged dnf install -y git gh >/dev/null 2>&1 ;;
        yum)    d_run_privileged yum install -y git gh >/dev/null 2>&1 ;;
        pacman) d_run_privileged pacman -S --noconfirm git github-cli >/dev/null 2>&1 ;;
        apk)    d_run_privileged apk add --no-cache git github-cli >/dev/null 2>&1 ;;
        zypper) d_run_privileged zypper --non-interactive install git github-cli >/dev/null 2>&1 ;;
        brew)   brew install git gh >/dev/null 2>&1 ;;
        winget) winget install --id GitHub.cli -e --source winget --accept-package-agreements --accept-source-agreements >/dev/null 2>&1 ;;
        scoop)  scoop install git gh >/dev/null 2>&1 ;;
        choco)  choco install git gh -y >/dev/null 2>&1 ;;
    esac

    if d_have_git && d_have_gh; then
        dok "installed contributor tools (git, gh)"
        return 0
    fi

    # Partial success is still a partial success — say exactly what is missing.
    if d_have_git && ! d_have_gh; then
        printf '\n  %s!%s git is installed, but the GitHub CLI (gh) is not.\n' "$D_YLW" "$D_RST"
        printf '    %sgh is what opens pull requests. Install it with:%s\n' "$D_DIM" "$D_RST"
        if [[ "$D_PKG" == "apt" ]]; then d_gh_official_hint; else d_dev_tools_hint; fi
        printf '\n'
        return 1
    fi
    if ! d_have_git; then
        printf '\n  %s✗%s Could not install git automatically.\n' "$D_RED" "$D_RST"
        printf '    %sgit is how changes reach the source. Install it with:%s\n' "$D_DIM" "$D_RST"
        d_dev_tools_hint
        printf '\n'
        return 1
    fi
    return 0
}

# ── convenience: ensure everything the gateway needs ─────────────────────
# Returns 0 if node is present (the only hard requirement). Everything else
# is best-effort and never blocks.
d_ensure_gateway_deps() {
    detect_platform
    dstep "Checking Node.js"
    if ! d_install_node; then
        return 1
    fi
    dstep "Checking npm"
    if command -v npm >/dev/null 2>&1; then
        dok "npm $(npm --version 2>/dev/null)"
    else
        dwarn "npm not found — it ships with Node.js; try reinstalling Node.js"
    fi
    return 0
}

# ── interactive prompts ──────────────────────────────────────────────────
# d_ask_yesno "question" [default]
#   default: "y" or "n" (used when there is no TTY). Returns 0 for yes.
# d_ask_choice "question" "opt1|opt2|opt3" [default_index]
#   Returns the 1-based index of the chosen option.
#
# NEVER prompt when stdin is not a TTY — a script piped or run in CI must
# not hang waiting for keyboard input. The default is used instead.
#
# Read from stdin (NOT /dev/tty): stdin IS the terminal in a normal
# interactive run, and /dev/tty may not be the controlling terminal (it is
# absent under some pty harnesses, cron, containers and CI).
d_ask_yesno() {
    local q="$1" def="${2:-y}" ans=""
    if [[ ! -t 0 ]]; then
        # Not interactive → take the default silently.
        [[ "$def" == "y" ]] && return 0 || return 1
    fi
    local suffix="[y/N]"
    [[ "$def" == "y" ]] && suffix="[Y/n]"
    printf '  %s?%s %s %s' "$D_CYN" "$D_RST" "$q" "$D_DIM$suffix$D_RST"
    read -r ans || ans=""
    ans="${ans:-$def}"
    case "$ans" in
        [Yy]|[Yy][Ee][Ss]|[Yy][Ee][Ss][Tt][Ee][Rr]*) return 0 ;;
        *) return 1 ;;
    esac
}

d_ask_choice() {
    local q="$1" opts="$2" def="${3:-1}" ans="" i=1
    if [[ ! -t 0 ]]; then
        echo "$def"
        return "$def"
    fi
    # The MENU goes to stderr, the INDEX to stdout. That way
    #   choice="$(d_ask_choice ...)"
    # captures ONLY the number — the menu still reaches the terminal.
    {
        printf '\n  %s%s%s\n' "$D_BLD" "$q" "$D_RST"
        local IFS='|'
        for o in $opts; do
            printf '    %s%d)%s %s\n' "$D_CYN" "$i" "$D_RST" "$o"
            i=$((i + 1))
        done
        unset IFS
        printf '  %s?%s choice [%s]: ' "$D_CYN" "$D_RST" "$def"
    } >&2
    read -r ans || ans=""
    ans="${ans:-$def}"
    if [[ "$ans" =~ ^[0-9]+$ ]] && [[ "$ans" -ge 1 ]]; then
        echo "$ans"
        return "$ans"
    fi
    echo "$def"
    return "$def"
}

# ── does this machine already have a way to become root? ─────────────────
# Returns 0 if we CAN escalate without a password (already root, or
# passwordless sudo). Never prompts.
d_can_escalate() {
    [[ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]] && return 0
    command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1 && return 0
    return 1
}

# ── can we ASK for a password? (interactive only) ────────────────────────
# A prompt may only ever appear when a REAL human is watching: stdin is a
# TTY, not CI/cron/pytest, and the operator has not opted out. Everything
# else — including `curl | bash` pipes whose stdin is the pipe — stays on
# sudo -n. (sudo's prompt goes to /dev/tty, so redirection cannot hide it
# and a missing TTY makes sudo fail fast instead of hanging.)
d_can_prompt_sudo() {
    [[ ! -t 0 ]] && return 1
    [[ -n "${CI:-}" ]] && return 1
    [[ -n "${PYTEST_CURRENT_TEST:-}" ]] && return 1
    [[ "${HIVV_NO_SUDO_PROMPT:-0}" == "1" ]] && return 1
    [[ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]] && return 0
    command -v sudo >/dev/null 2>&1 && return 0
    return 1
}

# ── print a friendly "what did we detect / what to type" summary ────────
d_print_platform_summary() {
    printf '\n  %sdetected environment%s\n' "$D_BLD" "$D_RST"
    printf '    %sos%s        %s (%s)\n' "$D_DIM" "$D_RST" "$D_OS" "$D_ARCH"
    printf '    %spkg mgr%s   %s\n' "$D_DIM" "$D_RST" "$D_PKG"
    [[ -n "$D_LINUX_DISTRO" ]] && printf '    %sdistro%s    %s\n' "$D_DIM" "$D_RST" "$D_LINUX_DISTRO"
    printf '    %sprivilege%s %s\n' "$D_DIM" "$D_RST" \
        "$( [[ "$(id -u 2>/dev/null || echo 0)" -eq 0 ]] && echo root || { [[ -n "$D_SUDO" ]] && echo "sudo (no password needed)" || echo "user only (no sudo)"; } )"
    printf '\n'
}
