Set-Location $PSScriptRoot

Write-Host "Starting MT5 FastAPI Bridge..." -ForegroundColor Green

$pythonCmd = $null

if (Get-Command python -ErrorAction SilentlyContinue) {
    $pythonCmd = "python"
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    $pythonCmd = "py"
} else {
    Write-Host "Python is not installed or not in PATH." -ForegroundColor Red
    Write-Host "Install Python and make sure 'Add Python to PATH' is enabled." -ForegroundColor Yellow
    exit 1
}

if (-not (Test-Path ".venv")) {
    Write-Host "Creating virtual environment..." -ForegroundColor Yellow
    & $pythonCmd -m venv .venv
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Failed to create virtual environment." -ForegroundColor Red
        exit 1
    }
}

if (-not (Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Host "Virtual environment activation script not found." -ForegroundColor Red
    exit 1
}

& ".\.venv\Scripts\Activate.ps1"

python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload