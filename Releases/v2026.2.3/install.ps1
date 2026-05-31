# CtrlNode Bridge — Windows installer
# Usage:
#   iwr https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/install.ps1 | iex
#
# With custom install directory:
#   & ([scriptblock]::Create((iwr https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/install.ps1))) -InstallDir "C:\tools\ctrlnode"

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ctrlnode"
)

$ErrorActionPreference = "Stop"
$REPO        = "ctrlnode-ai/ctrlnode"
$BINARY_NAME = "ctrlnode.exe"
$DEFAULT_WORKSPACE = $env:USERPROFILE

Write-Host ""
Write-Host "CtrlNode Bridge Installer" -ForegroundColor Cyan
Write-Host "--------------------------" -ForegroundColor Cyan
Write-Host ""

# --- workspace directory ---
Write-Host "Where is your workspace?"
Write-Host "This is the root folder where ctrlnode will read and write files." -ForegroundColor DarkGray
Write-Host "For security, the bridge cannot access anything outside this folder." -ForegroundColor DarkGray
Write-Host "If you are a developer, point this to your source code root (e.g. C:\Code)." -ForegroundColor DarkGray
$workspaceAnswer = Read-Host "Workspace [$DEFAULT_WORKSPACE]"
$WorkspaceRoot = if ($workspaceAnswer.Trim()) { $workspaceAnswer.Trim() } else { $DEFAULT_WORKSPACE }
Write-Host "  Workspace: $WorkspaceRoot" -ForegroundColor Gray
Write-Host "  Tip: to change it later, set the BASE_PATH environment variable and restart ctrlnode." -ForegroundColor DarkGray
Write-Host ""

[System.Environment]::SetEnvironmentVariable('BASE_PATH', $WorkspaceRoot, 'User')

# --- fetch latest release from GitHub ---
Write-Host "Fetching latest release..."
$releaseInfo = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest"
$tag = $releaseInfo.tag_name

if (-not $tag) {
  Write-Error "Could not determine latest release tag."
  exit 1
}

Write-Host "  Release: $tag"
Write-Host "  Asset:   $BINARY_NAME"
Write-Host ""
Write-Host "Downloading..."

$downloadUrl = "https://github.com/$REPO/releases/download/$tag/$BINARY_NAME"
$tmpFile = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), $BINARY_NAME)
Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpFile -UseBasicParsing

# --- install ---
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$dest = Join-Path $InstallDir $BINARY_NAME
if (Test-Path $dest) {
  Get-Process | Where-Object { $_.Path -eq $dest } | ForEach-Object {
    Write-Host "  Stopping running instance (PID $($_.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $_.Id -Force
    Start-Sleep -Milliseconds 500
  }
  Remove-Item $dest -Force
}
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
Write-Host "  ctrlnode"
Write-Host ""
Write-Host "Workspace: $WorkspaceRoot"
Write-Host "When you run the Bridge for the first time, it will prompt for your pairing token or read it from a .env file."
Write-Host "Full setup (token + API keys):  ctrlnode --setup"
Write-Host "Get your token at: https://app.ctrlnode.ai  (Settings -> Bridge)"
Write-Host ""

# --- optional: run the bridge now ---
$runNow = Read-Host "Do you want to run ctrlnode now? (Y/n)"
if ($runNow.Trim().ToLower() -ne 'n') {
  Write-Host "Starting ctrlnode..." -ForegroundColor Cyan
  $env:BASE_PATH = $WorkspaceRoot
  & $dest
}
