[CmdletBinding()]
param(
  [ValidateSet("all", "etrike_ebike", "road_vehicles")]
  [string]$Dataset = "all"
)

$ErrorActionPreference = "Stop"
$backendDir = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $backendDir ".env"

if (-not (Test-Path -LiteralPath $envFile)) {
  throw "backend/.env was not found. Copy backend/.env.example and add the private dataset URLs."
}

if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
  throw "curl.exe is required. It is included with current Windows 10 and Windows 11 installations."
}

$values = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
    $values[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
  }
}

$datasets = @(
  @{ Key = "ROBOFLOW_ETRIKE_EBIKE_DATASET_URL"; Name = "etrike_ebike" },
  @{ Key = "ROBOFLOW_ROAD_VEHICLES_DATASET_URL"; LegacyKey = "ROBOFLOW_JEEPNEY_DATASET_URL"; Name = "road_vehicles" }
)

if ($Dataset -ne "all") {
  $datasets = $datasets | Where-Object { $_.Name -eq $Dataset }
}

foreach ($item in $datasets) {
  $url = $values[$item.Key]
  if ([string]::IsNullOrWhiteSpace($url) -and $item.LegacyKey) {
    $url = $values[$item.LegacyKey]
  }
  if ([string]::IsNullOrWhiteSpace($url)) {
    Write-Warning "$($item.Name) URL is not configured; skipping."
    continue
  }

  $destination = Join-Path (Join-Path $backendDir "datasets") $item.Name
  $archive = Join-Path ([System.IO.Path]::GetTempPath()) "$($item.Name)-dataset.zip"

  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }

  try {
    Write-Host "Downloading $($item.Name) dataset (large downloads can take several minutes)..."
    & curl.exe `
      --location `
      --fail `
      --silent `
      --show-error `
      --retry 3 `
      --retry-delay 2 `
      --retry-all-errors `
      --connect-timeout 30 `
      --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" `
      --header "Accept: application/zip,application/octet-stream;q=0.9,*/*;q=0.8" `
      --output $archive `
      $url

    if ($LASTEXITCODE -ne 0) {
      throw "Roboflow download failed with curl exit code $LASTEXITCODE."
    }

    if (-not (Test-Path -LiteralPath $archive)) {
      throw "Roboflow did not create a download file."
    }

    $stream = [System.IO.File]::OpenRead($archive)
    try {
      $firstByte = $stream.ReadByte()
      $secondByte = $stream.ReadByte()
    }
    finally {
      $stream.Dispose()
    }

    if ($firstByte -ne 0x50 -or $secondByte -ne 0x4B) {
      throw "Roboflow returned a web page instead of a ZIP. Generate a fresh download-code URL in Roboflow Universe and update backend/.env."
    }

    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Write-Host "Extracting $($item.Name) dataset..."
    Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force

    $yaml = Get-ChildItem -LiteralPath $destination -Recurse -Filter "data.yaml" | Select-Object -First 1
    if (-not $yaml) {
      throw "Download extracted, but no data.yaml was found under $destination."
    }

    Write-Host "Dataset ready: $($yaml.DirectoryName)"
  }
  finally {
    if (Test-Path -LiteralPath $archive) {
      Remove-Item -LiteralPath $archive -Force
    }
  }
}
