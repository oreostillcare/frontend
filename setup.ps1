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

    $customModel = Join-Path $backendDir "models\best.pt"
    if (-not (Test-Path -LiteralPath $customModel)) {
      throw "The bundled custom model is missing at backend/models/best.pt. Restore it from the repository and rerun setup."
    }

    Push-Location $backendDir
    try {
      Write-Host "Validating the bundled custom traffic model..."
      $expectedCustomClasses = "ambulance,bicycle,bus,ebike,etrike,jeepney,motorcycle,pickup,sedan,suv,tricycle,truck,van"
      & $venvPython -c "from ultralytics import YOLO; expected=set('$expectedCustomClasses'.split(',')); actual={str(name).lower() for name in YOLO('models/best.pt').names.values()}; missing=expected-actual; assert not missing, f'Missing expected custom classes: {sorted(missing)}'; print('Custom model ready:', ', '.join(sorted(actual)))"
      if ($LASTEXITCODE -ne 0) {
        throw "Validating backend/models/best.pt failed with exit code $LASTEXITCODE."
      }

      Write-Host "Downloading the standard YOLO fallback model if it is not already available..."
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
