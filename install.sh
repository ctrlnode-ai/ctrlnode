#!/usr/bin/env sh
# CtrlNode Bridge — installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh
#
# Custom install directory:
#   curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh -s -- --dir ~/.local/bin

set -e

REPO="ctrlnode-ai/ctrlnode"
BINARY_NAME="ctrlnode"
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

DEFAULT_WORKSPACE="$HOME"
WORKSPACE_ROOT=""

echo ""
echo "CtrlNode Bridge Installer"
echo "--------------------------"
echo ""

# --- install directory ---
if [ -z "$INSTALL_DIR" ]; then
  if [ -t 1 ] && [ -e /dev/tty ]; then
    printf "Install directory for the Bridge binary [%s]: " "$DEFAULT_DIR" > /dev/tty
    read -r answer < /dev/tty
    INSTALL_DIR="${answer:-$DEFAULT_DIR}"
  else
    INSTALL_DIR="$DEFAULT_DIR"
    echo "  Using default install directory: $INSTALL_DIR"
    echo "  (pass --dir /your/path to override)"
  fi
fi

echo "  Installing to: $INSTALL_DIR"

# --- workspace directory ---
if [ -t 1 ] && [ -e /dev/tty ]; then
  printf "Workspace parent folder (where agent tasks live) [%s]: " "$DEFAULT_WORKSPACE" > /dev/tty
  read -r ws_answer < /dev/tty
  WORKSPACE_ROOT="${ws_answer:-$DEFAULT_WORKSPACE}"
else
  WORKSPACE_ROOT="$DEFAULT_WORKSPACE"
fi

echo "  Workspace: $WORKSPACE_ROOT"

# Persist workspace
SHELL_RC=""
if [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.profile" ]; then SHELL_RC="$HOME/.profile"
fi

if [ -n "$SHELL_RC" ]; then
  grep -v 'BASE_PATH' "$SHELL_RC" > "${SHELL_RC}.tmp" && mv "${SHELL_RC}.tmp" "$SHELL_RC"
  echo "export BASE_PATH=\"$WORKSPACE_ROOT\"" >> "$SHELL_RC"
fi
export BASE_PATH="$WORKSPACE_ROOT"

# --- detect OS and arch ---
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)
        if grep -q avx2 /proc/cpuinfo 2>/dev/null; then
          ASSET="ctrlnode-linux-x64"
        else
          ASSET="ctrlnode-linux-x64-baseline"
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
      arm64)   ASSET="ctrlnode-darwin-arm64" ;;
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

# Stop any running instance before replacing the binary
if [ -f "$DEST" ]; then
  if command -v pkill >/dev/null 2>&1; then
    pkill -x "$BINARY_NAME" 2>/dev/null && sleep 0.5 || true
  fi
fi

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
echo "Next: start the Bridge:"
echo "  ctrlnode"
echo ""
echo "Workspace: $WORKSPACE_ROOT"
echo "When you run the Bridge for the first time, it will prompt for your pairing token or read it from a .env file."
echo "Get your token at: https://app.ctrlnode.ai  (Settings → Bridge)"
echo "Docs:              https://github.com/${REPO}#readme"
echo ""

# --- optional: run the bridge now ---
if [ -t 1 ] && [ -e /dev/tty ]; then
  printf "Do you want to run ctrlnode now? (Y/n): " > /dev/tty
  read -r run_now < /dev/tty
  case "$run_now" in
    n|N|no|No)
      echo "You can start it later with: ctrlnode"
      ;;
    *)
      echo "Starting ctrlnode..."
      BASE_PATH="$WORKSPACE_ROOT" "$DEST"
      ;;
  esac
fi
