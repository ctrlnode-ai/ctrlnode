# CtrlNode Bridge — Windows installer
# Usage (from PowerShell):
#   irm https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.ps1 | iex
#
# Or with a custom install directory:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.ps1))) -InstallDir "$HOME\.local\bin"

param(
  [string]$InstallDir = "$env:LOCALAPPDATA\Programs\ctrlnode"
)

$ErrorActionPreference = "Stop"
$REPO = "ctrlnode-ai/ctrlnode"
$BINARY_NAME = "ctrlnode-bridge.exe"
$ASSET = "ctrlnode-bridge.exe"

Write-Host "CtrlNode Bridge Installer" -ForegroundColor Cyan
Write-Host ""

# --- get latest release tag ---
Write-Host "Fetching latest release..."
$releaseInfo = Invoke-RestMethod "https://api.github.com/repos/$REPO/releases/latest"
$tag = $releaseInfo.tag_name

if (-not $tag) {
  Write-Error "Could not determine latest release tag."
  exit 1
}

Write-Host "Latest release: $tag"
Write-Host "Downloading: $ASSET"

$downloadUrl = "https://github.com/$REPO/releases/download/$tag/$ASSET"
$tmpFile = [System.IO.Path]::GetTempFileName() + ".exe"

$client = New-Object System.Net.WebClient
$client.DownloadFile($downloadUrl, $tmpFile)

# --- install ---
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
$dest = Join-Path $InstallDir $BINARY_NAME
Move-Item $tmpFile $dest -Force

Write-Host ""
Write-Host "OK  Installed: $dest" -ForegroundColor Green
Write-Host "    Version:   $tag"
Write-Host ""

# --- add to PATH if not already there ---
$currentPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
if ($currentPath -notlike "*$InstallDir*") {
  [System.Environment]::SetEnvironmentVariable(
    "PATH",
    "$currentPath;$InstallDir",
    "User"
  )
  Write-Host "OK  Added $InstallDir to your PATH (restart terminal to apply)" -ForegroundColor Green
} else {
  Write-Host "    $InstallDir is already in PATH"
}

# --- ask for tokens ---
Write-Host ""
$pairingToken = Read-Host "Pairing Token (from ctrlnode.ai -> Settings -> Bridge)"
$gatewayToken = Read-Host "OpenClaw Gateway Token (from ~/.openclaw/openclaw.json -> gateway.auth.token)"

$pt = if ($pairingToken) { $pairingToken } else { "<your_pairing_token>" }
$gt = if ($gatewayToken) { $gatewayToken } else { "<your_gateway_token>" }

Write-Host ""
Write-Host "Run:" -ForegroundColor Cyan
Write-Host "  `$env:PAIRING_TOKEN=`"$pt`"; `$env:OPENCLAW_GATEWAY_TOKEN=`"$gt`"; ctrlnode-bridge"
Write-Host ""
Write-Host "Docs: https://github.com/$REPO/tree/main/doc/setup"
