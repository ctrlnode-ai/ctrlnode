#!/usr/bin/env sh
# CtrlNode Bridge — installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh
#
# Or with a custom install directory:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh -s -- --dir ~/.local/bin

set -e

REPO="ctrlnode-ai/ctrlnode"
BINARY_NAME="ctrlnode-bridge"
INSTALL_DIR="/usr/local/bin"

# --- parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    *) shift ;;
  esac
done

# --- detect OS and arch ---
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)
        # Check AVX2 support
        if grep -q avx2 /proc/cpuinfo 2>/dev/null; then
          ASSET="ctrlnode-bridge-linux-x64"
        else
          ASSET="ctrlnode-bridge-linux-x64-baseline"
        fi
        ;;
      aarch64|arm64)
        echo "ERROR: Linux ARM64 binary not yet available. Build from source: bun build ./src/bridge/index.ts --compile --target=bun-linux-arm64" >&2
        exit 1
        ;;
      *)
        echo "ERROR: Unsupported architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  Darwin)
    case "$ARCH" in
      arm64) ASSET="ctrlnode-bridge-darwin-arm64" ;;
      x86_64)
        echo "ERROR: macOS Intel binary not yet available. Use Rosetta or build from source." >&2
        exit 1
        ;;
      *)
        echo "ERROR: Unsupported architecture: $ARCH" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "ERROR: Unsupported OS: $OS. On Windows use install.ps1 instead." >&2
    exit 1
    ;;
esac

# --- get latest release tag ---
echo "Fetching latest release..."
if command -v curl >/dev/null 2>&1; then
  LATEST_TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
elif command -v wget >/dev/null 2>&1; then
  LATEST_TAG="$(wget -qO- "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
else
  echo "ERROR: curl or wget is required." >&2
  exit 1
fi

if [ -z "$LATEST_TAG" ]; then
  echo "ERROR: Could not determine latest release tag." >&2
  exit 1
fi

echo "Latest release: $LATEST_TAG"
echo "Downloading: $ASSET"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ASSET}"
TMP_FILE="$(mktemp)"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
else
  wget -qO "$TMP_FILE" "$DOWNLOAD_URL"
fi

# --- install ---
mkdir -p "$INSTALL_DIR"
DEST="${INSTALL_DIR}/${BINARY_NAME}"

if [ -w "$INSTALL_DIR" ]; then
  mv "$TMP_FILE" "$DEST"
else
  echo "Requires sudo to install to $INSTALL_DIR..."
  sudo mv "$TMP_FILE" "$DEST"
fi

chmod +x "$DEST"

# macOS: remove quarantine
if [ "$OS" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

echo ""
echo "✓ Installed: $DEST ($LATEST_TAG)"
echo ""

# --- ask for tokens (stdin may be piped when using curl | sh, open /dev/tty) ---
if [ -t 0 ]; then
  TTY=0
else
  exec 3</dev/tty 2>/dev/null && TTY=3 || TTY=""
fi

read_token() {
  prompt="$1"
  if [ -n "$TTY" ]; then
    printf "%s" "$prompt" >&2
    read -r value <&"$TTY"
  else
    value=""
  fi
  echo "$value"
}

PAIRING_TOKEN="$(read_token 'Pairing Token (from ctrlnode.ai → Settings → Bridge): ')"
OPENCLAW_GATEWAY_TOKEN="$(read_token 'OpenClaw Gateway Token (from ~/.openclaw/openclaw.json → gateway.auth.token): ')"

echo ""
echo "Run:"
if [ -n "$PAIRING_TOKEN" ] && [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  echo "  PAIRING_TOKEN=\"${PAIRING_TOKEN}\" OPENCLAW_GATEWAY_TOKEN=\"${OPENCLAW_GATEWAY_TOKEN}\" ctrlnode-bridge"
else
  echo "  PAIRING_TOKEN=\"<your_pairing_token>\" OPENCLAW_GATEWAY_TOKEN=\"<your_gateway_token>\" ctrlnode-bridge"
fi
echo ""
echo "Docs: https://github.com/${REPO}/tree/main/doc/setup"
