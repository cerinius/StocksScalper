# ============================================================
# install_service.ps1
# ============================================================
# Registers manager.py as a Windows service using NSSM
# (Non-Sucking Service Manager). The service:
#   - Starts automatically when Windows boots
#   - Runs as the CURRENT logged-in user (required — MT5 is a
#     GUI application and needs a user desktop session)
#   - Auto-restarts on crash
#   - Writes stdout/stderr to logs\service-stdout.log
#
# IMPORTANT: MT5 terminals require a desktop/user session.
# This service must run as a real user account, not SYSTEM.
# The machine should be configured for auto-login so the service
# starts without manual login after a reboot.
#
# Prerequisites:
#   - Run as Administrator
#   - Python installed and in PATH (verify: python --version)
#   - MT5 instances created (run setup_mt5_instances.ps1 first)
#   - accounts.json filled in with real credentials
# ============================================================

param(
    [string]$ServiceName    = "MT5Manager",
    [string]$DisplayName    = "MT5 Manager — Multi-Account Bridge",
    [string]$NssmDir        = "C:\nssm",
    [string]$ServiceUser    = "",   # Leave blank to use current user
    [string]$ServicePass    = "",   # Required if ServiceUser is set
    [switch]$Uninstall                # Pass -Uninstall to remove the service
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ─────────────────────────────────────────────────────────────────
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$ManagerPath = Join-Path $ScriptDir "manager.py"
$LogDir      = Join-Path $ScriptDir "logs"
$NssmExe     = Join-Path $NssmDir "nssm.exe"

# ── Helper: check admin ───────────────────────────────────────────────────────────
$currentPrincipal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run as Administrator. Right-click PowerShell → Run as Administrator."
    exit 1
}

# ── Uninstall path ────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Write-Host "Removing service '$ServiceName'..."
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        & $NssmExe stop $ServiceName
        & $NssmExe remove $ServiceName confirm
        Write-Host "[OK] Service removed."
    } else {
        Write-Host "[~] Service '$ServiceName' not found — nothing to remove."
    }
    exit 0
}

# ── Validate prerequisites ────────────────────────────────────────────────────────
if (-not (Test-Path $ManagerPath)) {
    Write-Error "manager.py not found at: $ManagerPath"
    exit 1
}

# Locate Python
$PythonExe = (Get-Command python -ErrorAction SilentlyContinue)?.Source
if (-not $PythonExe) {
    # Try common install paths
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Python\Python312\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python311\python.exe",
        "$env:LOCALAPPDATA\Programs\Python\Python310\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe",
        "C:\Python310\python.exe"
    )
    $PythonExe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $PythonExe) {
    Write-Error "Python not found. Install Python and ensure it is in PATH."
    exit 1
}
Write-Host "[*] Using Python: $PythonExe"

# ── Download NSSM if not present ─────────────────────────────────────────────────
if (-not (Test-Path $NssmExe)) {
    Write-Host "[*] NSSM not found — downloading..."
    $NssmZip = "$env:TEMP\nssm.zip"
    $NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"

    try {
        Invoke-WebRequest -Uri $NssmUrl -OutFile $NssmZip -UseBasicParsing
        Expand-Archive -Path $NssmZip -DestinationPath "$env:TEMP\nssm_extracted" -Force

        # NSSM zip contains nssm-2.24\win64\nssm.exe
        $extractedExe = Get-ChildItem "$env:TEMP\nssm_extracted" -Recurse -Filter "nssm.exe" |
                        Where-Object { $_.FullName -match "win64" } |
                        Select-Object -First 1

        if (-not $extractedExe) {
            Write-Error "Could not find nssm.exe in the downloaded archive."
            exit 1
        }

        New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
        Copy-Item $extractedExe.FullName $NssmExe
        Write-Host "[OK] NSSM installed to $NssmExe"
    } catch {
        Write-Error "Failed to download NSSM: $_`nDownload manually from https://nssm.cc and place nssm.exe at $NssmExe"
        exit 1
    } finally {
        Remove-Item $NssmZip -ErrorAction SilentlyContinue
        Remove-Item "$env:TEMP\nssm_extracted" -Recurse -ErrorAction SilentlyContinue
    }
}

# ── Install Python dependencies ───────────────────────────────────────────────────
$ReqFile = Join-Path $ScriptDir "requirements.txt"
if (Test-Path $ReqFile) {
    Write-Host "[*] Installing Python dependencies..."
    & $PythonExe -m pip install -r $ReqFile --quiet
    Write-Host "[OK] Dependencies installed."
}

# ── Create log directory ──────────────────────────────────────────────────────────
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir | Out-Null
}

# ── Remove existing service if present ───────────────────────────────────────────
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "[*] Existing service found — removing before reinstall..."
    & $NssmExe stop $ServiceName
    & $NssmExe remove $ServiceName confirm
}

# ── Install the service ───────────────────────────────────────────────────────────
Write-Host "[*] Installing service '$ServiceName'..."
& $NssmExe install $ServiceName $PythonExe $ManagerPath

# ── Configure service ─────────────────────────────────────────────────────────────
# Working directory (so manager.py can find accounts.json)
& $NssmExe set $ServiceName AppDirectory $ScriptDir

# Display name
& $NssmExe set $ServiceName DisplayName $DisplayName

# Startup type: automatic
& $NssmExe set $ServiceName Start SERVICE_AUTO_START

# Restart on failure — wait 10s between restarts, up to 3 attempts per hour
& $NssmExe set $ServiceName AppThrottle 10000
& $NssmExe set $ServiceName AppRestartDelay 10000

# Log stdout and stderr to files (rotate at 10MB)
& $NssmExe set $ServiceName AppStdout (Join-Path $LogDir "service-stdout.log")
& $NssmExe set $ServiceName AppStderr (Join-Path $LogDir "service-stderr.log")
& $NssmExe set $ServiceName AppStdoutCreationDisposition 4   # append
& $NssmExe set $ServiceName AppStderrCreationDisposition 4   # append
& $NssmExe set $ServiceName AppRotateFiles 1
& $NssmExe set $ServiceName AppRotateBytes 10485760           # 10MB

# ── Run as current user (MT5 needs a user session) ───────────────────────────────
if ($ServiceUser -ne "") {
    Write-Host "[*] Configuring service to run as: $ServiceUser"
    & $NssmExe set $ServiceName ObjectName $ServiceUser $ServicePass
} else {
    # Default to LocalSystem but warn — MT5 GUI apps may not work under SYSTEM.
    # For production, pass -ServiceUser DOMAIN\username -ServicePass yourpassword
    Write-Host ""
    Write-Host "  *** WARNING ***"
    Write-Host "  No -ServiceUser specified. Service will run as LocalSystem."
    Write-Host "  MT5 is a GUI application and may not start correctly under LocalSystem."
    Write-Host "  For reliable operation, re-run with:"
    Write-Host "    -ServiceUser '.\YourWindowsUsername' -ServicePass 'YourPassword'"
    Write-Host ""
}

# ── Start the service ─────────────────────────────────────────────────────────────
Write-Host "[*] Starting service..."
& $NssmExe start $ServiceName

Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "=============================="
    Write-Host " Service installed and running"
    Write-Host "=============================="
} else {
    Write-Host ""
    Write-Host "[!] Service installed but may not be running yet."
    Write-Host "    Check logs at: $LogDir"
    Write-Host "    Or run: nssm status $ServiceName"
}

Write-Host ""
Write-Host "  Service name : $ServiceName"
Write-Host "  Gateway URL  : http://<this-machine-ip>:8000"
Write-Host "  Health check : http://<this-machine-ip>:8000/health"
Write-Host "  Accounts     : http://<this-machine-ip>:8000/accounts"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  nssm status  $ServiceName     — check status"
Write-Host "  nssm restart $ServiceName     — restart"
Write-Host "  nssm stop    $ServiceName     — stop"
Write-Host "  .\install_service.ps1 -Uninstall  — remove service"
Write-Host ""
