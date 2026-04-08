# StocksScalper - Trading Data Reset
# Wipes all live trading data (positions, orders, candidates, news, price bars,
# account snapshots) while keeping structural data (users, symbols, roles, etc.)
#
# Usage: Right-click -> Run with PowerShell
#   OR:  Open PowerShell, run: .\RESET.ps1

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Invoke-Docker {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [switch]$IgnoreExitCode
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $process = Start-Process -FilePath "docker" -ArgumentList $Arguments -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath

        $stdout = if (Test-Path $stdoutPath) { Get-Content $stdoutPath -Raw } else { "" }
        $stderr = if (Test-Path $stderrPath) { Get-Content $stderrPath -Raw } else { "" }

        if (-not $IgnoreExitCode -and $process.ExitCode -ne 0) {
            $details = @($stderr.Trim(), $stdout.Trim()) | Where-Object { $_ }
            if ($details.Count -gt 0) {
                throw ($details -join [Environment]::NewLine)
            }

            throw "docker $($Arguments -join ' ') failed with exit code $($process.ExitCode)."
        }

        return [PSCustomObject]@{
            ExitCode = $process.ExitCode
            StdOut = $stdout
            StdErr = $stderr
        }
    } finally {
        if (Test-Path $stdoutPath) { Remove-Item $stdoutPath -Force }
        if (Test-Path $stderrPath) { Remove-Item $stderrPath -Force }
    }
}

Write-Host ""
Write-Host "===========================================================" -ForegroundColor Yellow
Write-Host "          StocksScalper -- TRADING DATA RESET              " -ForegroundColor Yellow
Write-Host "===========================================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "This will DELETE all trading data from the database:" -ForegroundColor Red
Write-Host "  - Positions, Orders, Trade Candidates" -ForegroundColor Red
Write-Host "  - Account Snapshots, Market Snapshots" -ForegroundColor Red
Write-Host "  - Price Bars, News Items" -ForegroundColor Red
Write-Host "  - Execution Decisions, Validation Runs, Backtest Results" -ForegroundColor Red
Write-Host "  - Audit Logs, Risk Events, Worker Runs, Notifications" -ForegroundColor Red
Write-Host ""
Write-Host "Structural data is KEPT:" -ForegroundColor Green
Write-Host "  - Users, Roles, Integrations, Symbols, Watchlists, System Settings" -ForegroundColor Green
Write-Host ""

$confirm = Read-Host "Type YES to confirm reset"
if ($confirm -ne "YES") {
    Write-Host "Reset cancelled." -ForegroundColor Yellow
    exit 0
}

# Check Docker is running
Write-Host ""
Write-Host "Checking Docker..." -ForegroundColor Cyan
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "Docker not found. Install Docker Desktop." -ForegroundColor Red
    exit 1
}

try {
    $dockerInfo = Invoke-Docker -Arguments @("info") -IgnoreExitCode
} catch {
    Write-Host "Docker is not running. Start Docker Desktop first." -ForegroundColor Red
    exit 1
}

if ($dockerInfo.ExitCode -ne 0) {
    Write-Host "Docker is not running. Start Docker Desktop first." -ForegroundColor Red
    exit 1
}

# Find the postgres container (try both naming conventions)
Write-Host "Locating database container..." -ForegroundColor Cyan

$pgContainer = $null
$candidates = @("stocksscalper-postgres-1", "stocks-scalper-postgres-1", "stocksscalper_postgres_1")
foreach ($name in $candidates) {
    $check = (Invoke-Docker -Arguments @("ps", "--filter", "name=$name", "--filter", "status=running", "-q")).StdOut
    if ($check -and $check.Trim() -ne "") {
        $pgContainer = $name
        break
    }
}

if (-not $pgContainer) {
    # Last resort: find any running postgres container in the project
    $pgContainer = ((Invoke-Docker -Arguments @("ps", "--filter", "ancestor=postgres", "--filter", "status=running", "--format", "{{.Names}}")).StdOut -split "`r?`n" | Select-Object -First 1).Trim()
}

if (-not $pgContainer) {
    Write-Host "Could not find a running postgres container." -ForegroundColor Red
    Write-Host "Make sure the system is running: START.ps1 first, then RESET.ps1" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Alternative: wipe everything with:" -ForegroundColor Yellow
    Write-Host "  docker compose down -v && docker compose up --build -d" -ForegroundColor Yellow
    exit 1
}

Write-Host "Found container: $pgContainer" -ForegroundColor Green

# Write SQL to a temp file (avoids PowerShell parsing -- comments and ::jsonb)
$tmpSql = [System.IO.Path]::GetTempFileName() -replace '\.tmp$', '.sql'

$sqlLines = @(
    "SET session_replication_role = 'replica';"
    "TRUNCATE TABLE ""BacktestResult"" CASCADE;"
    "TRUNCATE TABLE ""ValidationRun"" CASCADE;"
    "TRUNCATE TABLE ""ExecutionDecision"" CASCADE;"
    "TRUNCATE TABLE ""Order"" CASCADE;"
    "TRUNCATE TABLE ""Position"" CASCADE;"
    "TRUNCATE TABLE ""TradeCandidate"" CASCADE;"
    "TRUNCATE TABLE ""MarketSnapshot"" CASCADE;"
    "TRUNCATE TABLE ""AccountSnapshot"" CASCADE;"
    "TRUNCATE TABLE ""PriceBar"" CASCADE;"
    "TRUNCATE TABLE ""NewsSymbolLink"" CASCADE;"
    "TRUNCATE TABLE ""NewsItem"" CASCADE;"
    "TRUNCATE TABLE ""RiskEvent"" CASCADE;"
    "TRUNCATE TABLE ""WorkerRun"" CASCADE;"
    "TRUNCATE TABLE ""AuditLog"" CASCADE;"
    "TRUNCATE TABLE ""Notification"" CASCADE;"
    "TRUNCATE TABLE ""IntegrationStatus"" CASCADE;"
    "SET session_replication_role = 'origin';"
    "INSERT INTO ""IntegrationStatus"" (""id"", ""integrationId"", ""status"", ""summary"", ""lastHeartbeatAt"", ""createdAt"")"
    "SELECT gen_random_uuid(), id, 'CONNECTED', 'Reset - awaiting live connection.', NOW(), NOW()"
    "FROM ""Integration"" WHERE kind = 'MT5' LIMIT 1;"
    "UPDATE ""SystemSetting"" SET value = '{""maxRiskPerTradePct"": 1.0, ""lastAdjustedAt"": null, ""reason"": null}' WHERE key = 'risk.dynamicControls';"
    "UPDATE ""SystemSetting"" SET value = '{""active"": false}' WHERE key = 'risk.killSwitch';"
    "SELECT 'Reset complete' AS result;"
)

[System.IO.File]::WriteAllLines($tmpSql, $sqlLines, [System.Text.UTF8Encoding]::new($false))

Write-Host ""
Write-Host "Running database reset..." -ForegroundColor Cyan

try {
    # Copy SQL file into container
    Invoke-Docker -Arguments @("cp", $tmpSql, "${pgContainer}:/tmp/reset.sql") | Out-Null

    # Execute with psql -f (avoids any shell parsing of SQL content)
    $output = (Invoke-Docker -Arguments @("exec", $pgContainer, "psql", "-U", "stockradar", "-d", "stockradar", "-f", "/tmp/reset.sql")).StdOut

    Write-Host $output -ForegroundColor Gray

    # Cleanup temp file inside container
    Invoke-Docker -Arguments @("exec", $pgContainer, "rm", "-f", "/tmp/reset.sql") | Out-Null

} catch {
    Write-Host "Reset failed: $_" -ForegroundColor Red
    Write-Host ""
    Write-Host "You can reset manually by running:" -ForegroundColor Yellow
    Write-Host "  docker compose down -v" -ForegroundColor Yellow
    Write-Host "  docker compose up --build -d" -ForegroundColor Yellow
    Write-Host "(Wipes the entire database volume and re-seeds from scratch)" -ForegroundColor Yellow
    exit 1
} finally {
    # Always clean up temp file
    if (Test-Path $tmpSql) { Remove-Item $tmpSql -Force }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Green
Write-Host "  Trading data cleared successfully!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Run START.ps1 to restart all services" -ForegroundColor White
Write-Host "  2. The system will connect to your live MT5 terminal" -ForegroundColor White
Write-Host "  3. Real data will appear within ~60 seconds of startup" -ForegroundColor White
Write-Host ""
Write-Host "Press any key to exit..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
