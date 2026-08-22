[CmdletBinding()]
param(
  [switch]$SkipFrontend,
  [switch]$SkipBackend,
  [switch]$DownloadDatasets
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$backendDir = Join-Path $repoRoot "backend"

function Copy-ExampleIfMissing {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Example,
    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  if (-not (Test-Path -LiteralPath $Destination)) {
    Copy-Item -LiteralPath $Example -Destination $Destination
    Write-Host "Created $Destination from its example file."
  }
}

Push-Location $repoRoot
try {
  if (-not $SkipFrontend) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $node -or -not $npm) {
      throw "Node.js 20.9 or newer (including npm) is required. Install it from https://nodejs.org/ and rerun this script."
    }

    $nodeVersionText = (& $node.Source --version).Trim().TrimStart("v")
    if ([Version]$nodeVersionText -lt [Version]"20.9.0") {
      throw "Node.js 20.9 or newer is required; found $nodeVersionText."
    }

    Write-Host "Installing frontend dependencies with npm ci..."
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }

    Copy-ExampleIfMissing `
      -Example (Join-Path $repoRoot ".env.example") `
      -Destination (Join-Path $repoRoot ".env.local")
  }

  if (-not $SkipBackend) {
    $venvDir = Join-Path $backendDir ".venv"
    $venvPython = Join-Path $venvDir "Scripts\python.exe"

    if (-not (Test-Path -LiteralPath $venvPython)) {
      $py = Get-Command py.exe -ErrorAction SilentlyContinue
      $python = Get-Command python.exe -ErrorAction SilentlyContinue

      Write-Host "Creating the backend virtual environment..."
      if ($py) {
        & $py.Source -3 -m venv $venvDir
      }
      elseif ($python) {
        & $python.Source -m venv $venvDir
      }
      else {
        throw "Python 3 is required. Install it from https://www.python.org/ and rerun this script."
      }

      if ($LASTEXITCODE -ne 0) {
        throw "Creating the Python virtual environment failed with exit code $LASTEXITCODE."
      }
    }

    Write-Host "Installing backend dependencies..."
    & $venvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) {
      throw "Updating pip failed with exit code $LASTEXITCODE."
    }

    & $venvPython -m pip install -r (Join-Path $backendDir "requirements.txt")
    if ($LASTEXITCODE -ne 0) {
      throw "Installing backend dependencies failed with exit code $LASTEXITCODE."
    }

    Copy-ExampleIfMissing `
      -Example (Join-Path $backendDir ".env.example") `
      -Destination (Join-Path $backendDir ".env")

    Write-Host "Downloading the standard YOLO model if it is not already available..."
    Push-Location $backendDir
    try {
      & $venvPython -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"
      if ($LASTEXITCODE -ne 0) {
        throw "Downloading the YOLO model failed with exit code $LASTEXITCODE."
      }
    }
    finally {
      Pop-Location
    }

    if ($DownloadDatasets) {
      Write-Host "Downloading configured datasets..."
      & (Join-Path $backendDir "scripts\download_datasets.ps1")
    }
  }

  Write-Host ""
  Write-Host "Setup complete."
  Write-Host "1. Fill in .env.local and backend/.env with your local values."
  Write-Host "2. Start the backend from its directory: cd backend; .\.venv\Scripts\python.exe app.py"
  Write-Host "3. In another terminal at the repository root, start the frontend: npm.cmd run dev"
  if (-not $DownloadDatasets) {
    Write-Host "Datasets were not downloaded. After configuring private URLs, run .\setup.ps1 -DownloadDatasets or .\backend\scripts\download_datasets.ps1."
  }
}
finally {
  Pop-Location
}
