#!/usr/bin/env sh
# CtrlNode Bridge — installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh
#
# Custom install directory:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh -s -- --dir ~/.local/bin

set -e

REPO="ctrlnode-ai/ctrlnode"
BINARY_NAME="ctrlnode-bridge"
DEFAULT_DIR="/usr/local/bin"
INSTALL_DIR=""

# --- parse args ---
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)   INSTALL_DIR="$2"; shift 2 ;;
    --dir=*) INSTALL_DIR="${1#*=}"; shift ;;
    *)       shift ;;
  esac
done

echo ""
echo "CtrlNode Bridge Installer"
echo "--------------------------"
echo ""

# --- install directory ---
if [ -z "$INSTALL_DIR" ]; then
  if [ -t 0 ]; then
    # running interactively (not piped) — ask
    printf "Install directory [%s]: " "$DEFAULT_DIR"
    read -r answer
    INSTALL_DIR="${answer:-$DEFAULT_DIR}"
  else
    # piped (curl | sh) — use default silently
    INSTALL_DIR="$DEFAULT_DIR"
    echo "  Using default install directory: $INSTALL_DIR"
    echo "  (pass --dir /your/path to override)"
  fi
fi

echo "  Installing to: $INSTALL_DIR"

# --- detect OS and arch ---
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)
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
      arm64)   ASSET="ctrlnode-bridge-darwin-arm64" ;;
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
echo ""
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

echo "  Release: $LATEST_TAG"
echo "  Asset:   $ASSET"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ASSET}"
TMP_FILE="$(mktemp)"

echo ""
echo "Downloading..."
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

# macOS: remove quarantine flag
if [ "$OS" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

echo ""
echo "✓ Installed: $DEST ($LATEST_TAG)"
echo ""
echo "Next: set your Pairing Token and start the Bridge:"
echo "  PAIRING_TOKEN=\"<token>\" ctrlnode-bridge"
echo ""
echo "Get your token at: https://app.ctrlnode.ai  (Settings → Bridge)"
echo "Docs:              https://github.com/${REPO}#readme"
echo ""
