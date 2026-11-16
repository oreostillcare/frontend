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

function Get-CommandPath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

function Refresh-ProcessPath {
  $pathParts = @(
    [Environment]::GetEnvironmentVariable("Path", "Machine")
    [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

  $env:Path = $pathParts -join ";"
}

Push-Location $repoRoot
try {
  Copy-ExampleIfMissing `
    -Example (Join-Path $repoRoot ".env.example") `
    -Destination (Join-Path $repoRoot ".env")

  if (Test-Path -LiteralPath (Join-Path $repoRoot ".env.local")) {
    Write-Warning "Next.js gives .env.local precedence over .env. Move that legacy file aside before starting the frontend; setup will not read or modify it."
  }

  if (-not $SkipFrontend) {
    $nodePath = Get-CommandPath -Name "node.exe"
    $npmPath = Get-CommandPath -Name "npm.cmd"

    if (-not $nodePath -or -not $npmPath) {
      $wingetPath = Get-CommandPath -Name "winget.exe"
      if (-not $wingetPath) {
        throw "Node.js is missing and winget is unavailable. Install Node.js LTS from https://nodejs.org/ and rerun this script."
      }

      Write-Host "Node.js was not found. Installing Node.js LTS with winget..."
      Write-Host "Windows may ask for administrator approval."
      & $wingetPath install `
        --id OpenJS.NodeJS.LTS `
        --exact `
        --source winget `
        --silent `
        --accept-package-agreements `
        --accept-source-agreements
      if ($LASTEXITCODE -ne 0) {
        throw "Installing Node.js with winget failed with exit code $LASTEXITCODE."
      }

      Refresh-ProcessPath
      $nodePath = Get-CommandPath -Name "node.exe"
      $npmPath = Get-CommandPath -Name "npm.cmd"

      if (-not $nodePath -or -not $npmPath) {
        $nodeInstallDir = Join-Path $env:ProgramFiles "nodejs"
        $nodeCandidate = Join-Path $nodeInstallDir "node.exe"
        $npmCandidate = Join-Path $nodeInstallDir "npm.cmd"
        if (Test-Path -LiteralPath $nodeCandidate) {
          $nodePath = $nodeCandidate
        }
        if (Test-Path -LiteralPath $npmCandidate) {
          $npmPath = $npmCandidate
        }
      }

      if (-not $nodePath -or -not $npmPath) {
        throw "Node.js was installed, but this terminal cannot find it yet. Open a new PowerShell window and rerun .\setup.ps1."
      }
    }

    $nodeVersionText = (& $nodePath --version).Trim().TrimStart("v")
    if ([Version]$nodeVersionText -lt [Version]"20.9.0") {
      throw "Node.js 20.9 or newer is required; found $nodeVersionText."
    }

    Write-Host "Installing frontend dependencies with npm ci..."
    & $npmPath ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
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

    & $venvPython -m pip install -r (Join-Path $backendDir "requirements-openvino.txt")
    if ($LASTEXITCODE -ne 0) {
      throw "Installing backend dependencies failed with exit code $LASTEXITCODE."
    }

    Push-Location $backendDir
    try {
      Write-Host "Validating the configured inference model artifacts..."
      & $venvPython -c "import sys; from config import settings; from detector import ModelPool; pool = ModelPool(settings); print('Inference backend:', pool.backend); print('Models:', pool.status()); sys.exit(0 if pool.online else 1)"
      if ($LASTEXITCODE -ne 0) {
        throw "Model validation failed. Supply both OpenVINO export directories under backend/models/openvino, or configure valid model paths in the root .env."
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
  Write-Host "1. Configure the root .env with your local values; both services use it."
  Write-Host "2. For the /local Reset system button, start both services from the repository root: .\backend\.venv\Scripts\python.exe .\backend\run_local.py"
  Write-Host "3. Or start them separately: cd backend; .\.venv\Scripts\python.exe app.py, then npm.cmd run dev in another terminal (reset button disabled)."
  if (-not $DownloadDatasets) {
    Write-Host "Datasets were not downloaded. After configuring private URLs, run .\setup.ps1 -DownloadDatasets or .\backend\scripts\download_datasets.ps1."
  }
}
finally {
  Pop-Location
}
