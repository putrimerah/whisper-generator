#Requires -Version 5.1
# Install the Windows-side runtime for whisper-generator.
# No administrator rights needed. Safe to re-run; each step is skipped when
# already satisfied.
$ErrorActionPreference = 'Stop'
# Whisper's help and transcript output contain characters outside Windows'
# default legacy code pages, including when stdout is redirected.
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'

$Root    = Join-Path $env:USERPROFILE '.wg'
$BinDir  = Join-Path $Root 'bin'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

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
  $work = Join-Path $Root 'work'
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  $tmp = Join-Path $work ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'ffmpeg.zip'
  $extract = Join-Path $tmp 'extract'
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $extract
  Get-ChildItem $extract -Recurse -Include 'ffmpeg.exe','ffprobe.exe' |
    ForEach-Object { if (-not (Test-Path (Join-Path $BinDir $_.Name))) { Copy-Item $_.FullName -Destination $BinDir } }
  Remove-Item $tmp -Recurse -Force
  Write-Host "installed: $ffmpeg"
}

# ---------------------------------------------------------------- 2/4 whisper
Log '2/4 whisper-ctranslate2'
$venv = Join-Path $Root 'venv'
$python = Join-Path $venv 'Scripts\python.exe'
$whisper = Join-Path $venv 'Scripts\whisper-ctranslate2.exe'
if (-not (Test-Path $python)) {
  & py -3.11 -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the Whisper Python environment.' }
}
& $python -m pip install 'whisper-ctranslate2==0.5.8' 'nvidia-cublas-cu12' 'nvidia-cudnn-cu12>=9,<10'
if ($LASTEXITCODE -ne 0) { throw 'Whisper installation failed.' }
if (-not (Test-Path $whisper)) { throw 'Whisper executable was not installed.' }

# Python 3.8+ requires explicit DLL directories for extension modules.
# Create only our own startup hook and retain handles for the whole process.
$hook = Join-Path $venv 'Lib\site-packages\wg-cuda.pth'
if (-not (Test-Path $hook)) {
  $hookLine = "import os,sys,glob; sys._wg_cuda_dirs=[os.add_dll_directory(p) for p in glob.glob(os.path.join(sys.prefix,'Lib','site-packages','nvidia','*','bin')) if os.path.isdir(p)]"
  [System.IO.File]::WriteAllText($hook, $hookLine + "`n", [System.Text.UTF8Encoding]::new($false))
}
$nvidia = Join-Path $venv 'Lib\site-packages\nvidia'
$dllDirs = @(Get-ChildItem -Path $nvidia -Directory | ForEach-Object {
  $bin = Join-Path $_.FullName 'bin'
  if (Test-Path $bin -PathType Container) { $bin }
})
if ($dllDirs.Count -gt 0) { $env:Path = ($dllDirs -join ';') + ';' + $env:Path }
& $whisper --help | Out-Null
if ($LASTEXITCODE -ne 0) {
  $code = $LASTEXITCODE
  throw "Whisper startup failed (exit code $code). Run & `"$whisper`" --help and check the error printed above."
}
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  & $python -c "import ctypes; ctypes.WinDLL('cublas64_12.dll'); ctypes.WinDLL('cudnn64_9.dll'); print('CUDA DLLs load successfully')"
  if ($LASTEXITCODE -ne 0) { throw 'CUDA libraries could not be loaded; check the error above.' }
}

# ---------------------------------------------------------------- 3/4 .env
Log '3/4 .env'
$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envPath)) {
  $example = Join-Path (Split-Path $PSScriptRoot -Parent) '.env.example'
  if (Test-Path $example) { Copy-Item $example $envPath }
  else { New-Item -ItemType File -Path $envPath -Force | Out-Null }
  Write-Host "created .env -- edit it to change the default folders"
}

# Append only missing settings. Keep existing user configuration intact,
# including explicit empty values, and do not record a missing executable.
function Add-EnginePath($name, $path) {
  if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return }
  $content = [System.IO.File]::ReadAllText($envPath)
  if ($content -match "(?m)^\s*(?:export\s+)?$name\s*=") {
    Write-Host "$name already set in .env; left unchanged"
    return
  }
  $line = "`r`n$name=`"$path`"`r`n"
  [System.IO.File]::AppendAllText($envPath, $line, [System.Text.UTF8Encoding]::new($false))
  Write-Host "added $name to .env"
}
Add-EnginePath 'WG_FFMPEG_PATH' $ffmpeg
Add-EnginePath 'WG_WHISPER_PATH' $whisper

# ---------------------------------------------------------------- 4/4 verify
Log '4/4 verify'
Push-Location (Split-Path $PSScriptRoot -Parent)
try {
  & npm.cmd install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Server dependency installation failed.' }
  & npm.cmd --prefix web install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Web dependency installation failed.' }
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed.' }
  node dist/cli.js doctor
  if ($LASTEXITCODE -ne 0) { throw 'Setup verification failed. Review the doctor checks above.' }
} finally { Pop-Location }

Write-Host ""
Write-Host "Done. Start the app with: npm start" -ForegroundColor Green
