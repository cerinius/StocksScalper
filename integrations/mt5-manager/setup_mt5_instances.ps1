# ============================================================
# setup_mt5_instances.ps1
# ============================================================
# Creates 10 portable MT5 terminal directories, one per account.
# Each directory is an independent copy of the MT5 installation.
# MT5's /portable flag means all data (config, logs, cache) stays
# inside that directory — accounts are fully isolated.
#
# Run ONCE before installing the Windows service.
# Run again to add or rebuild individual instances.
#
# Requires: Administrator privileges
# ============================================================

param(
    [string]$SourceMT5Dir  = "C:\Program Files\MetaTrader 5",
    [string]$InstancesRoot = "C:\MT5Instances",
    [int]   $AccountCount  = 10,
    [switch]$Force          # Re-copy even if destination already exists
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Preflight ────────────────────────────────────────────────────────────────────
if (-not (Test-Path $SourceMT5Dir)) {
    Write-Error "MT5 source directory not found: $SourceMT5Dir`nInstall MetaTrader 5 first, then run this script."
    exit 1
}

$sourceExe = Join-Path $SourceMT5Dir "terminal64.exe"
if (-not (Test-Path $sourceExe)) {
    Write-Error "terminal64.exe not found in $SourceMT5Dir"
    exit 1
}

# ── Create root instances directory ─────────────────────────────────────────────
if (-not (Test-Path $InstancesRoot)) {
    New-Item -ItemType Directory -Path $InstancesRoot | Out-Null
    Write-Host "[+] Created $InstancesRoot"
}

# ── Copy instances ────────────────────────────────────────────────────────────────
$created = 0
$skipped = 0

for ($i = 1; $i -le $AccountCount; $i++) {
    $destDir = Join-Path $InstancesRoot "account_$i"

    if ((Test-Path $destDir) -and -not $Force) {
        Write-Host "[~] account_$i already exists — skipping (use -Force to overwrite)"
        $skipped++
        continue
    }

    Write-Host "[*] Creating portable instance: account_$i ..."

    # Remove existing if -Force
    if ((Test-Path $destDir) -and $Force) {
        Remove-Item -Recurse -Force $destDir
    }

    # Copy entire MT5 directory
    Copy-Item -Recurse -Path $SourceMT5Dir -Destination $destDir

    # Create a sentinel file so MT5 treats this as a portable installation.
    # MT5 looks for "portable" marker — the /portable CLI flag achieves the same
    # but writing this file ensures the GUI also defaults to portable mode.
    $portableMarker = Join-Path $destDir "portable"
    if (-not (Test-Path $portableMarker)) {
        New-Item -ItemType File -Path $portableMarker | Out-Null
    }

    # Pre-create the data subdirectories MT5 expects in portable mode
    @("MQL5", "logs", "config", "bases", "history", "tester") | ForEach-Object {
        $subDir = Join-Path $destDir $_
        if (-not (Test-Path $subDir)) {
            New-Item -ItemType Directory -Path $subDir | Out-Null
        }
    }

    Write-Host "    [OK] $destDir"
    $created++
}

# ── Summary ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "=============================="
Write-Host " MT5 Instances Setup Complete"
Write-Host "=============================="
Write-Host "  Created : $created"
Write-Host "  Skipped : $skipped"
Write-Host "  Root    : $InstancesRoot"
Write-Host ""
Write-Host "Next step:"
Write-Host "  1. Edit integrations\mt5-manager\accounts.json with your logins/passwords"
Write-Host "  2. Run install_service.ps1 to register the Windows service"
Write-Host ""
