# CtrlNode Bridge — Local installer (dev/test)
# Installs the binary from the same LocalReleases folder — no download needed.
# Usage:
#   .\install.ps1
#   .\install.ps1 -InstallDir "C:\tools\ctrlnode"

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ctrlnode"
)

$ErrorActionPreference = "Stop"
$LOCAL_RELEASES    = $PSScriptRoot
$BINARY_NAME       = "ctrlnode.exe"
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

# --- "download" (fake) ---
$srcFile = Join-Path $LOCAL_RELEASES $BINARY_NAME
if (-not (Test-Path $srcFile)) {
  Write-Error "Binary not found in LocalReleases: $srcFile"
  exit 1
}

$tag = (Get-Item $srcFile).LastWriteTime.ToString("yyyy-MM-dd")

Write-Host "Fetching latest release..."
Write-Host "  Release: local"
Write-Host "  Asset:   $BINARY_NAME"
Write-Host ""
Write-Host "Downloading..."
Start-Sleep -Milliseconds 300

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
Copy-Item $srcFile $dest -Force

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
