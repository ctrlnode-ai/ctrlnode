# CtrlNode Bridge — Windows installer
# Usage (from PowerShell):
#   irm https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.ps1 | iex
#
# Or with a custom install directory:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.ps1))) -InstallDir "C:\tools\ctrlnode"

param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$REPO        = "ctrlnode-ai/ctrlnode"
$BINARY_NAME = "ctrlnode-bridge.exe"
$ASSET       = "ctrlnode-bridge.exe"
$DEFAULT_DIR = "$env:LOCALAPPDATA\Programs\ctrlnode"
$DEFAULT_WORKSPACE =  $env:USERPROFILE 

Write-Host ""
Write-Host "CtrlNode Bridge Installer" -ForegroundColor Cyan
Write-Host "--------------------------" -ForegroundColor Cyan
Write-Host ""

# --- install directory ---
if (-not $InstallDir) {
  $answer = Read-Host "Install directory for the Bridge binary [$DEFAULT_DIR]"
  $InstallDir = if ($answer.Trim()) { $answer.Trim() } else { $DEFAULT_DIR }
}
Write-Host "  Installing to: $InstallDir" -ForegroundColor Gray

# --- workspace directory ---
$workspaceAnswer = Read-Host "Workspace parent folder [$DEFAULT_WORKSPACE]  "
$WorkspaceRoot = if ($workspaceAnswer.Trim()) { $workspaceAnswer.Trim() } else { $DEFAULT_WORKSPACE }
Write-Host "  Workspace: $WorkspaceRoot" -ForegroundColor Gray

# Persist the workspace setting so the bridge can be started with just `ctrlnode-bridge`.
[System.Environment]::SetEnvironmentVariable('AGENTS_FOLDER', $WorkspaceRoot, 'User')

# --- get latest release tag ---
Write-Host ""
Write-Host "Fetching latest release..."
$releaseInfo = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest"
$tag = $releaseInfo.tag_name

if (-not $tag) {
  Write-Error "Could not determine latest release tag."
  exit 1
}

Write-Host "  Release: $tag"
Write-Host "  Asset:   $ASSET"

$downloadUrl = "https://github.com/$REPO/releases/download/$tag/$ASSET"
$tmpFile     = [System.IO.Path]::GetTempFileName() + ".exe"

Write-Host ""
Write-Host "Downloading..."
$client = New-Object System.Net.WebClient
$client.DownloadFile($downloadUrl, $tmpFile)

# --- install ---
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$dest = Join-Path $InstallDir $BINARY_NAME
if (Test-Path $dest) { Remove-Item $dest -Force }
Move-Item $tmpFile $dest -Force

Write-Host ""
Write-Host "OK  Installed: $dest" -ForegroundColor Green
Write-Host "    Version:   $tag"

# --- add to PATH if not already there ---
$currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$InstallDir*") {
  [System.Environment]::SetEnvironmentVariable("PATH", "$currentPath;$InstallDir", "User")
  Write-Host "OK  Added $InstallDir to your PATH (restart terminal to apply)" -ForegroundColor Green
} else {
  Write-Host "    $InstallDir is already in PATH"
}
$env:PATH = "$InstallDir;$env:PATH"

Write-Host ""
Write-Host "Next: start the Bridge:" -ForegroundColor Cyan
Write-Host '  ctrlnode-bridge'
Write-Host ""
Write-Host "Workspace: $WorkspaceRoot"
Write-Host "When you run the Bridge for the first time, it will prompt for your pairing token or read it from a .env file."
Write-Host "Get your token at: https://app.ctrlnode.ai  (Settings → Bridge)"
Write-Host "Docs:              https://github.com/$REPO#readme"
Write-Host ""

# --- optional: run the bridge now ---
$runNow = Read-Host "Do you want to run ctrlnode-bridge now? (y/N)"
if ($runNow.Trim().ToLower() -eq 'y') {
  $bridgePath = Join-Path $InstallDir $BINARY_NAME
  Write-Host "Starting ctrlnode-bridge..." -ForegroundColor Cyan
  Start-Process -FilePath $bridgePath -WorkingDirectory $WorkspaceRoot
}
