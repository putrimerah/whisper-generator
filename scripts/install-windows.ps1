#Requires -Version 5.1
# Install the Windows-side runtime for whisper-generator.
# No administrator rights needed. Safe to re-run; each step is skipped when
# already satisfied.
$ErrorActionPreference = 'Stop'

$Root    = Join-Path $env:USERPROFILE '.wg'
$BinDir  = Join-Path $Root 'bin'
$EngDir  = Join-Path $Root 'engine'
New-Item -ItemType Directory -Force -Path $BinDir, $EngDir | Out-Null

function Log($msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# ---------------------------------------------------------------- 1/4 ffmpeg
Log '1/4 ffmpeg'
$ffmpeg = Join-Path $BinDir 'ffmpeg.exe'
if (Test-Path $ffmpeg) {
  Write-Host "already installed: $ffmpeg"
} else {
  $url = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip'
  $zip = Join-Path $env:TEMP 'wg-ffmpeg.zip'
  $tmp = Join-Path $env:TEMP 'wg-ffmpeg-extract'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  Get-ChildItem $tmp -Recurse -Include 'ffmpeg.exe','ffprobe.exe' |
    ForEach-Object { Copy-Item $_.FullName -Destination $BinDir -Force }
  Remove-Item $zip, $tmp -Recurse -Force
  Write-Host "installed: $ffmpeg"
}

# ---------------------------------------------------------------- 2/4 whisper
Log '2/4 whisper engine'
$whisper = Get-ChildItem $EngDir -Recurse -Filter 'whisper*.exe' -ErrorAction SilentlyContinue |
           Select-Object -First 1
if ($whisper) {
  Write-Host "already installed: $($whisper.FullName)"
} else {
  Write-Host 'Fetching the latest self-contained Whisper build...'
  $api = 'https://api.github.com/repos/Purfview/whisper-standalone-win/releases/latest'
  try {
    $rel   = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers @{ 'User-Agent' = 'whisper-generator' }
    $asset = $rel.assets | Where-Object { $_.name -match 'XXL.*\.7z$|Windows.*\.zip$' } | Select-Object -First 1
  } catch { $asset = $null }

  if (-not $asset) {
    Write-Warning @"
Could not resolve a download automatically.
Install the engine by hand, then re-run this script:
  1. Open https://github.com/Purfview/whisper-standalone-win/releases
  2. Download the Faster-Whisper build for Windows with CUDA support
  3. Extract it so that whisper-faster.exe sits inside:
       $EngDir
The CUDA DLLs (cublas64_*.dll, cudnn*.dll) MUST stay in the same folder
as the .exe. Windows resolves them from the executable's own directory.
"@
  } else {
    $pkg = Join-Path $env:TEMP $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $pkg -UseBasicParsing
    if ($pkg -like '*.zip') {
      Expand-Archive -Path $pkg -DestinationPath $EngDir -Force
      Remove-Item $pkg -Force
      Write-Host "installed into: $EngDir"
    } else {
      Write-Warning "Downloaded $pkg. Extract it into $EngDir with 7-Zip, then re-run this script."
    }
  }
  $whisper = Get-ChildItem $EngDir -Recurse -Filter 'whisper*.exe' -ErrorAction SilentlyContinue |
             Select-Object -First 1
}

# ---------------------------------------------------------------- 3/4 .env
Log '3/4 .env'
$envFile = Join-Path $PSScriptRoot '..\.env' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $envFile) {
  $envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  $example = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.example'
  if (Test-Path $example) { Copy-Item $example $envPath }
  else { New-Item -ItemType File -Path $envPath -Force | Out-Null }
  Add-Content $envPath ""
  Add-Content $envPath "WG_FFMPEG_PATH=$ffmpeg"
  if ($whisper) { Add-Content $envPath "WG_WHISPER_PATH=$($whisper.FullName)" }
  Write-Host "created .env -- edit it to change the default folders"
} else {
  Write-Host ".env already exists; not modified. Check WG_FFMPEG_PATH and WG_WHISPER_PATH by hand."
}

# ---------------------------------------------------------------- 4/4 verify
Log '4/4 verify'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  npm install --no-audit --no-fund | Out-Null
  npm --prefix web install --no-audit --no-fund | Out-Null
  npm run build
  node dist/cli.js doctor
} finally { Pop-Location }

Write-Host ""
Write-Host "Done. Start the app with: npm start" -ForegroundColor Green
