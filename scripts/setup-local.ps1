#!/usr/bin/env pwsh
# scripts/setup-local.ps1 — clone-and-run setup for a SELF-HOSTED HIVV on Windows.
#
# Mirror of scripts/setup-local.sh for native Windows (PowerShell 5+).
# It installs the API dependencies, creates a local data directory, and starts
# the gateway in LOCAL-FIRST mode:
#
#   * NO PostgreSQL required
#   * NO internet required after the clone
#   * Local models on 8080/8090/11434/1234 are discovered automatically
#   * The public hive is contacted ONLY if you pass -JoinHive
#
# Usage:
#   .\scripts\setup-local.ps1
#   .\scripts\setup-local.ps1 -Check
#   .\scripts\setup-local.ps1 -JoinHive
#   .\scripts\setup-local.ps1 -Port 3011 -NoStart
#   .\scripts\setup-local.ps1 -NoAuto      # don't auto-install missing deps
#
# Missing dependencies (Node.js, Python) are installed automatically with
# winget/scoop/choco when possible. When they can't be, the exact command to
# type is printed.

[CmdletBinding()]
param(
    [int]$Port = 3011,
    [string]$DataDir = '',
    [switch]$JoinHive,
    [switch]$NoStart,
    [switch]$Check,
    [switch]$Quiet,
    [switch]$NoAuto
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ApiDir = Join-Path $RepoRoot 'api'

function Write-Step($m) { if (-not $Quiet) { Write-Host "==> $m" -ForegroundColor Cyan } }
function Write-Ok($m)   { if (-not $Quiet) { Write-Host "  [ok] $m" -ForegroundColor Green } }
function Write-Warn($m) { if (-not $Quiet) { Write-Host "  [!] $m"  -ForegroundColor Yellow } }
function Write-Fail($m) { Write-Host "  [x] $m" -ForegroundColor Red } }
function Write-Cmd($m)  { if (-not $Quiet) { Write-Host "    `$ $m" -ForegroundColor Cyan } }

# ── PATH refresh (winget writes to the registry, not the live session) ──
function Update-PathFromRegistry {
    $parts = @()
    foreach ($scope in @('Machine', 'User')) {
        try {
            $p = [Environment]::GetEnvironmentVariable('Path', $scope)
            if ($p) { $parts += $p }
        } catch { }
    }
    if ($parts.Count -gt 0) {
        $env:Path = ($parts -join ';') + ';' + $env:Path
    }
}

# ── package manager detection ──────────────────────────────────────────
function Get-PackageManager {
    foreach ($m in @('winget', 'scoop', 'choco')) {
        if (Get-Command $m -ErrorAction SilentlyContinue) { return $m }
    }
    return $null
}

# ── Node.js installer ──────────────────────────────────────────────────
function Install-Node {
    $pm = Get-PackageManager
    if (-not $pm) {
        Write-Host "  [x] no package manager found (winget/scoop/choco)" -ForegroundColor Red
        Write-Host ''
        Write-Host '  Install Node.js 18+ with one of these, then re-run:' -ForegroundColor Yellow
        Write-Cmd 'winget install OpenJS.NodeJS.LTS'
        Write-Cmd '# or: scoop install nodejs'
        Write-Cmd '# or: choco install nodejs-lts'
        Write-Host ''
        return $false
    }

    Write-Host "  -> installing Node.js with $pm (this can take a minute)..." -ForegroundColor DarkCyan
    switch ($pm) {
        'winget' {
            & winget install --silent --accept-source-agreements --accept-package-agreements `
                --id OpenJS.NodeJS.LTS 2>&1 | Out-Null
        }
        'scoop' { & scoop install nodejs 2>&1 | Out-Null }
        'choco'  { & choco install nodejs-lts -y 2>&1 | Out-Null }
    }
    Update-PathFromRegistry

    # winget may install to a path the session didn't know about yet
    $candidates = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "${env:ProgramFiles(x86)}\nodejs\node.exe",
        "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\node.exe')
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) {
            $env:Path = (Split-Path $c) + ';' + $env:Path
            break
        }
    }
    return [bool](Get-Command node -ErrorAction SilentlyContinue)
}

# ── Python installer ───────────────────────────────────────────────────
function Install-Python {
    $pm = Get-PackageManager
    if (-not $pm) {
        Write-Warn 'python not found — the hive CLI will not run (the API still will)'
        Write-Host '  Install Python 3.8+ (optional) with one of these:' -ForegroundColor Yellow
        Write-Cmd 'winget install Python.Python.3.12'
        Write-Cmd '# or: scoop install python'
        Write-Cmd '# or: choco install python'
        return $false
    }
    Write-Host '  -> installing Python...' -ForegroundColor DarkCyan
    switch ($pm) {
        'winget' {
            & winget install --silent --accept-source-agreements --accept-package-agreements `
                --id Python.Python.3.12 2>&1 | Out-Null
        }
        'scoop' { & scoop install python 2>&1 | Out-Null }
        'choco'  { & choco install python -y 2>&1 | Out-Null }
    }
    Update-PathFromRegistry
    return [bool](Get-Command python -ErrorAction SilentlyContinue)
}

if (-not $Quiet) {
    Write-Host ''
    Write-Host '  HIVE — a distributed AI network (at home and around the world)' -ForegroundColor DarkYellow
    Write-Host ''
}

# ── 1. platform ──────────────────────────────────────────────────────────
Write-Step "Checking platform"
Write-Ok "$([System.Environment]::OSVersion.VersionString) / $env:PROCESSOR_ARCHITECTURE"

# ── 2. node ──────────────────────────────────────────────────────────────
Write-Step "Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    $nodeVersion = (node --version).TrimStart('v')
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 18) {
        Write-Warn "node $nodeVersion is too old — HIVV needs node 18+"
        $nodeCmd = $null
    }
}
if (-not $nodeCmd) {
    if ($NoAuto) {
        Write-Fail 'node not found — install Node.js 18+ then re-run'
        Write-Host ''
        Write-Host '  Install Node.js 18+ with one of these, then re-run:' -ForegroundColor Yellow
        Write-Cmd 'winget install OpenJS.NodeJS.LTS'
        Write-Cmd '# or: scoop install nodejs'
        Write-Cmd '# or: choco install nodejs-lts'
        Write-Host ''
        exit 1
    }
    if (Install-Node) {
        Write-Ok "node $((node --version).TrimStart('v')) installed"
    } else {
        Write-Fail 'could not install Node.js automatically'
        Write-Host ''
        Write-Host '  Install Node.js 18+ with one of these, then re-run:' -ForegroundColor Yellow
        Write-Cmd 'winget install OpenJS.NodeJS.LTS'
        Write-Cmd '# or: scoop install nodejs'
        Write-Cmd '# or: choco install nodejs-lts'
        Write-Host ''
        exit 1
    }
} else {
    Write-Ok "node $((node --version).TrimStart('v'))"
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Fail 'npm not found — it ships with Node.js'
    exit 1
}
Write-Ok "npm $(npm --version)"

# ── 3. python (for the CLI) ─────────────────────────────────────────────
Write-Step "Checking Python"
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if ($py) {
    Write-Ok "python found ($($py.Source))"
} elseif (-not $NoAuto -and (Install-Python)) {
    Write-Ok 'python installed'
} else {
    Write-Warn 'python not found — the hive CLI will not run (the API still will)'
    Write-Host '  Install Python 3.8+ (optional) with: winget install Python.Python.3.12' -ForegroundColor DarkGray
}

# ── 4. local model servers ──────────────────────────────────────────────
Write-Step "Probing for local model servers"
$found = $false
foreach ($p in @(8080, 8081, 8082, 8090, 11434, 1234, 5000, 8000)) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$p/v1/models" -TimeoutSec 1 -UseBasicParsing
        if ($r.StatusCode -eq 200) { Write-Ok "model server on 127.0.0.1:$p"; $found = $true }
    } catch { }
}
if (-not $found) { Write-Warn "no local model server found — install llama.cpp or ollama (see README)" }

# ── 5. data directory ───────────────────────────────────────────────────
if (-not $DataDir) {
    $base = $env:LOCALAPPDATA
    if (-not $base) { $base = Join-Path $HOME 'AppData\Local' }
    $DataDir = Join-Path $base 'hivv'
}
Write-Step "Preparing local data directory"
foreach ($sub in @('', 'keys', 'logs')) {
    $p = if ($sub) { Join-Path $DataDir $sub } else { $DataDir }
    New-Item -ItemType Directory -Force -Path $p | Out-Null
}
Write-Ok $DataDir

# ── 6. dependencies ──────────────────────────────────────────────────────
Write-Step "Installing API dependencies"
Push-Location $ApiDir
try {
    if (Test-Path 'package-lock.json') {
        npm ci --silent --no-audit --no-fund 2>$null
        if ($LASTEXITCODE -ne 0) { npm install --silent --no-audit --no-fund }
    } else {
        npm install --silent --no-audit --no-fund
    }
} finally {
    Pop-Location
}
if (Test-Path (Join-Path $ApiDir 'node_modules')) {
    Write-Ok "node_modules ready"
} else {
    Write-Fail "npm install failed"
    exit 1
}

# ── 7. environment file ──────────────────────────────────────────────────
$EnvFile = Join-Path $DataDir 'hivv.env'
Write-Step "Writing environment"
if (Test-Path $EnvFile) {
    Write-Ok "$EnvFile (kept — your settings are preserved)"
} else {
    $secret = node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
    $lines = @(
        '# HIVV local-first environment (generated locally)',
        'HIVV_MODE=local',
        'HIVV_DB_REQUIRED=0',
        "HIVV_DATA_DIR=$DataDir",
        "HIVV_PORT=$Port",
        "HIVV_HIVE_JOIN=$(if ($JoinHive) { '1' } else { '0' })",
        'HIVV_HIVE_URL=https://hivv.org',
        "HIVV_SESSION_SECRET=$secret",
        'NODE_ENV=production'
    )
    Set-Content -Path $EnvFile -Value ($lines -join "`n") -Encoding UTF8
    Write-Ok "$EnvFile (created)"
}

if ($Check) {
    Write-Step "Check complete — nothing was started"
    exit 0
}

# ── 8. start ─────────────────────────────────────────────────────────────
if ($NoStart) {
    Write-Step "Setup complete (not started)"
    Write-Host "  start it with: `$env:HIVV_DATA_DIR='$DataDir'; `$env:HIVV_PORT=$Port; node api\server.js"
    exit 0
}

Write-Step "Starting the local gateway"
$Log = Join-Path $DataDir 'logs\hivv-local.log'
Push-Location $ApiDir
try {
    $env:HIVV_MODE = 'local'
    $env:HIVV_DB_REQUIRED = '0'
    $env:HIVV_DATA_DIR = $DataDir
    $env:HIVV_PORT = "$Port"
    $env:HIVV_HIVE_JOIN = if ($JoinHive) { '1' } else { '0' }
    $env:NODE_ENV = 'production'
    $proc = Start-Process -FilePath 'node' -ArgumentList 'server.js' `
        -WorkingDirectory $ApiDir -RedirectStandardOutput $Log `
        -RedirectStandardError (Join-Path $DataDir 'logs\hivv-local.err.log') `
        -PassThru -WindowStyle Hidden
    Set-Content -Path (Join-Path $DataDir 'hivv.pid') -Value $proc.Id
} finally {
    Pop-Location
}

Start-Sleep -Seconds 3
try {
    $h = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -UseBasicParsing
    if ($h.StatusCode -eq 200) {
        Write-Ok "gateway is healthy on http://127.0.0.1:$Port"
        Write-Host "  health : http://127.0.0.1:$Port/api/health"
        Write-Host "  partner: http://127.0.0.1:$Port/api/partner/manifest"
        Write-Host "  openai : http://127.0.0.1:$Port/v1"
        Write-Host "  logs   : $Log"
        Write-Host "  stop   : Stop-Process -Id $($proc.Id)"
    }
} catch {
    Write-Fail "gateway did not come up — see $Log"
    if (Test-Path $Log) { Get-Content $Log -Tail 20 }
    exit 1
}
