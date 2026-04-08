# StocksScalper Startup Script
# Right-click -> Run with PowerShell
# Or open PowerShell and run: .\START.ps1

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host ""
Write-Host "=== StocksScalper Startup ===" -ForegroundColor Cyan
Write-Host "Account: Ekjot Singh | OxSecurities-Demo | 100k USD"
Write-Host ""

# --- Step 1: Check Docker ---
Write-Host "[1/4] Checking Docker..." -ForegroundColor Yellow
try {
    $null = docker info 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Docker is not running. Start Docker Desktop and try again." -ForegroundColor Red
        pause
        exit 1
    }
    Write-Host "      Docker is running." -ForegroundColor Green
} catch {
    Write-Host "ERROR: Docker not found. Install Docker Desktop from https://docker.com" -ForegroundColor Red
    pause
    exit 1
}

# --- Step 2: Start MT5 Bridge in new window ---
Write-Host ""
Write-Host "[2/4] Starting MT5 Python Bridge..." -ForegroundColor Yellow
Write-Host "      (Opens a new window - keep it open while trading)"

$bridgePath = Join-Path $PSScriptRoot "integrations\mt5-bridge"
if (Test-Path "$bridgePath\run.ps1") {
    Start-Process powershell.exe -ArgumentList "-NoExit -ExecutionPolicy Bypass -File `"$bridgePath\run.ps1`"" -WindowStyle Normal
    Write-Host "      Bridge window launched. Waiting 10 seconds for it to start..." -ForegroundColor Green
    Start-Sleep -Seconds 10
} else {
    Write-Host "      WARNING: MT5 bridge not found at $bridgePath" -ForegroundColor Yellow
}

# Check if bridge is up
$bridgeOk = $false
try {
    $response = Invoke-WebRequest -Uri "http://localhost:8000/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        $bridgeOk = $true
        Write-Host "      MT5 Bridge is responding on port 8000." -ForegroundColor Green
    }
} catch {
    Write-Host "      WARNING: MT5 Bridge not responding yet. It may still be starting up." -ForegroundColor Yellow
    Write-Host "      If MT5 connection fails, check the bridge window for errors." -ForegroundColor Yellow
    Write-Host "      Common fix: update MT5_PATH in integrations\mt5-bridge\.env" -ForegroundColor Yellow
}

# --- Step 3: Build and start Docker services ---
Write-Host ""
Write-Host "[3/4] Building and starting Docker containers..." -ForegroundColor Yellow
Write-Host "      This takes 1-3 minutes on first run, much faster after that."
Write-Host ""

docker compose up --build -d

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "ERROR: Docker compose failed. See errors above." -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "      All containers started." -ForegroundColor Green

# --- Step 4: Wait for API ---
Write-Host ""
Write-Host "[4/4] Waiting for API to become ready..." -ForegroundColor Yellow

$apiReady = $false
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:4210/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -eq 200) {
            $apiReady = $true
            break
        }
    } catch {}
    Write-Host "      Waiting... ($($i * 3)s / 90s)" -ForegroundColor DarkGray
}

Write-Host ""
if ($apiReady) {
    Write-Host "API is ready!" -ForegroundColor Green
} else {
    Write-Host "API did not respond in 90s. Check: docker compose logs api" -ForegroundColor Yellow
}

# --- Done ---
Write-Host ""
Write-Host "======================================" -ForegroundColor Green
Write-Host "  StocksScalper is running!" -ForegroundColor Green
Write-Host "======================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Dashboard : http://localhost:3210"
Write-Host "  API       : http://localhost:4210"
Write-Host "  MT5 Bridge: http://localhost:8000/health"
Write-Host ""
Write-Host "  To stop   : docker compose down"
Write-Host "  To reset  : .\RESET.ps1"
Write-Host "  To view logs: docker compose logs -f worker-market"
Write-Host ""

# Open dashboard
Start-Process "http://localhost:3210"

Write-Host "Press any key to exit this window..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
