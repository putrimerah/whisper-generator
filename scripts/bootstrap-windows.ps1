#Requires -Version 5.1
# Installs Windows prerequisites, then runs the project runtime installer.
# Run from a checked-out or extracted whisper-generator repository.
$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Installer = Join-Path $PSScriptRoot 'install-windows.ps1'

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

function Install-WingetPackage([string]$Id, [string]$Name, [string]$Action = 'install') {
  Write-Host "Installing $Name..." -ForegroundColor Cyan
  & winget $Action --id $Id --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "winget could not $Action $Name (exit code $LASTEXITCODE)."
  }
  Refresh-Path
}

function Node-Major {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  $version = (& node --version).Trim()
  if ($version -match '^v(\d+)') { return [int]$Matches[1] }
  return 0
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw @"
winget is required for one-command setup. Install or update App Installer from
Microsoft Store, then run this script again.
"@
}

$nodeMajor = Node-Major
if ($nodeMajor -lt 22) {
  $action = if ($nodeMajor -eq 0) { 'install' } else { 'upgrade' }
  Install-WingetPackage 'OpenJS.NodeJS.LTS' 'Node.js LTS' $action
}

$nodeMajor = Node-Major
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Found major version $nodeMajor."
}
Write-Host "Node.js $(& node --version) ready"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Install-WingetPackage 'Git.Git' 'Git'
}
Write-Host "Git $(& git --version) ready"

if (-not (Test-Path (Join-Path $Root 'package.json'))) {
  throw "Run this script from the whisper-generator repository."
}

& powershell -NoProfile -ExecutionPolicy Bypass -File $Installer
if ($LASTEXITCODE -ne 0) {
  throw "Windows runtime installer failed (exit code $LASTEXITCODE)."
}
