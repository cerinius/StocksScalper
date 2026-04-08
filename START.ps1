# ============================================================
# StocksScalper — Full Startup Script
# Account: Ekjot Singh | OxSecurities-Demo | $100,000 USD
# ============================================================
#
# BEFORE RUNNING THIS SCRIPT:
#   1. Make sure MetaTrader 5 is running (it's already open — good!)
#   2. Make sure Docker Desktop is running
#   3. Right-click this file → "Run with PowerShell"
#      (or open PowerShell and run: .\START.ps1)
#
# WHAT THIS DOES:
#   Step 1: Starts the MT5 Python Bridge (connects Docker to your MT5 terminal)
#   Step 2: Waits for the bridge to be healthy
#   Step 3: Starts all Docker services (database, workers, web dashboard)
# ============================================================

param(
    [switch]$BridgeOnly,
    [switch]$DockerOnly
)

$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgePath = Join-Path $ScriptRoot "integrations\mt5-bridge"

function Write-Step {
    param($msg)
    Write-Host "`n>>> $msg" -ForegroundColor Cyan
}

function Write-OK {
    param($msg)
    Write-Host "  ✓ $msg" -ForegroundColor Green
}

function Write-Warn {
    param($msg)
    Write-Host "  ⚠ $msg" -ForegroundColor Yellow
}

function Write-Fail {
    param($msg)
    Write-Host "  ✗ $msg" -ForegroundColor Red
}

# ─── Check prerequisites ────────────────────────────────────────────────────────

Write-Step "Checking prerequisites..."

# Check MT5 is running
$mt5Process = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
if ($mt5Process) {
    Write-OK "MetaTrader 5 is running (PID $($mt5Process.Id))"
} else {
    Write-Warn "MetaTrader 5 doesn't appear to be running."
    Write-Host "  Please start MT5 and log in to account 1114231 (OxSecurities-Demo)" -ForegroundColor Yellow
    $continue = Read-Host "  Press Enter to continue anyway, or Ctrl+C to cancel"
}

# Check Docker
$dockerRunning = $false
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -eq 0) {
        $dockerRunning = $true
        Write-OK "Docker Desktop is running"
    }
} catch {}

if (-not $dockerRunning -and -not $BridgeOnly) {
    Write-Fail "Docker Desktop is not running. Please start Docker Desktop first."
    Write-Host "  Download from: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    exit 1
}

# ─── Step 1: Start MT5 Bridge ───────────────────────────────────────────────────

if (-not $DockerOnly) {
    Write-Step "Starting MT5 Python Bridge (port 8000)..."

    # Check if bridge is already running
    try {
        $health = Invoke-RestMethod -Uri "http://localhost:8000/health" -TimeoutSec 2 -ErrorAction Stop
        if ($health.connected) {
            Write-OK "MT5 Bridge already running and connected to account $($health.login) (Balance: `$$($health.balance))"
        } else {
            Write-Warn "MT5 Bridge running but not connected: $($health.error)"
        }
    } catch {
        # Not running — start it
        Write-Host "  Launching MT5 Bridge in a new terminal window..." -ForegroundColor White

        Start-Process powershell -ArgumentList @(
            "-NoExit",
            "-Command",
            "Set-Location '$BridgePath'; Write-Host 'MT5 Bridge starting...' -ForegroundColor Green; & '.\run.ps1'"
        ) -WindowStyle Normal

        # Wait for bridge to come up
        Write-Host "  Waiting for bridge to start" -NoNewline
        $maxWait = 30
        $connected = $false
        for ($i = 0; $i -lt $maxWait; $i++) {
            Start-Sleep -Seconds 1
            Write-Host "." -NoNewline
            try {
                $health = Invoke-RestMethod -Uri "http://localhost:8000/health" -TimeoutSec 1 -ErrorAction Stop
                $connected = $true
                break
            } catch {}
        }
        Write-Host ""

        if ($connected) {
            if ($health.connected) {
                Write-OK "MT5 Bridge connected! Account: $($health.login) | Balance: `$$($health.balance) | Server: $($health.server)"
            } else {
                Write-Warn "Bridge started but MT5 connection issue: $($health.error)"
                Write-Host "  Check that MT5 is logged in to account 1114231 on OxSecurities-Demo" -ForegroundColor Yellow
            }
        } else {
            Write-Warn "Bridge didn't respond in ${maxWait}s. Check the bridge window for errors."
            Write-Host "  Common fix: MT5 terminal path may differ. Edit integrations/mt5-bridge/.env" -ForegroundColor Yellow
        }
    }
}

if ($BridgeOnly) {
    Write-Host "`nBridge-only mode. Done." -ForegroundColor Green
    exit 0
}

# ─── Step 2: Start Docker services ─────────────────────────────────────────────

Write-Step "Starting Docker services..."
Set-Location $ScriptRoot

Write-Host "  Building and starting all containers (this may take 2-3 minutes on first run)..."
docker compose up --build -d

if ($LASTEXITCODE -ne 0) {
    Write-Fail "Docker compose failed. Check errors above."
    exit 1
}

Write-OK "All Docker containers started"

# ─── Step 3: Health check ───────────────────────────────────────────────────────

Write-Step "Waiting for API to be ready..."
$maxWait = 60
for ($i = 0; $i -lt $maxWait; $i++) {
    Start-Sleep -Seconds 2
    try {
        $api = Invoke-RestMethod -Uri "http://localhost:4210/health" -TimeoutSec 2 -ErrorAction Stop
        Write-OK "API is ready"
        break
    } catch {
        Write-Host "  Waiting... ($i/${maxWait}s)" -ForegroundColor DarkGray
    }
}

# ─── Done ───────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  STOCKSSCALPER IS RUNNING" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard:    http://localhost:3210" -ForegroundColor White
Write-Host "  API:          http://localhost:4210" -ForegroundColor White
Write-Host "  MT5 Bridge:   http://localhost:8000/health" -ForegroundColor White
Write-Host ""
Write-Host "  Account:      Ekjot Singh (#1114231)" -ForegroundColor Cyan
Write-Host "  Balance:      `$100,000 USD (OxSecurities-Demo)" -ForegroundColor Cyan
Write-Host "  Mode:         PAPER (demo trades, no real money)" -ForegroundColor Yellow
Write-Host ""
Write-Host "  To go LIVE: Change TRADING_MODE=live in .env.local" -ForegroundColor Yellow
Write-Host "              then run: docker compose restart worker-execution" -ForegroundColor Yellow
Write-Host ""
Write-Host "  To stop:    docker compose down" -ForegroundColor DarkGray
Write-Host "============================================================" -ForegroundColor Green

# Open dashboard in browser
Start-Process "http://localhost:3210"
