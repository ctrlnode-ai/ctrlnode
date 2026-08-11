#!/usr/bin/env sh
# CtrlNode Bridge — Linux/macOS installer
# Usage:
#   curl -fsSL https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/install.sh | sh
#
# With custom install directory:
#   curl -fsSL https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/install.sh | sh -s -- --dir ~/.local/bin

set -e

REPO="ctrlnode-ai/ctrlnode"
BINARY_NAME="ctrlnode"
# Default to ~/.local/bin when not root (no sudo needed).
# Pass --dir /usr/local/bin to install system-wide.
if [ "$(id -u)" -eq 0 ]; then
  DEFAULT_DIR="/usr/local/bin"
else
  DEFAULT_DIR="$HOME/.local/bin"
fi
INSTALL_DIR="$DEFAULT_DIR"

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

# --- workspace directory ---
# Shell RC is used only when the installer needs to add ~/.local/bin to PATH.
SHELL_RC=""
if [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.zshrc" ]; then SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.profile" ]; then SHELL_RC="$HOME/.profile"
fi

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
        echo "ERROR: Linux ARM64 binary not yet available." >&2
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
        echo "ERROR: macOS Intel binary not yet available." >&2
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

# --- fetch latest release from GitHub ---
echo "Fetching latest release..."
if command -v curl >/dev/null 2>&1; then
  TAG="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
elif command -v wget >/dev/null 2>&1; then
  TAG="$(wget -qO- "https://api.github.com/repos/$REPO/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
else
  echo "ERROR: curl or wget required." >&2
  exit 1
fi

if [ -z "$TAG" ]; then
  echo "ERROR: Could not determine latest release tag." >&2
  exit 1
fi

echo "  Release: $TAG"
echo "  Asset:   $ASSET"
echo ""
echo "Downloading..."

DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
TMP_FILE="$(mktemp)"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DOWNLOAD_URL" -o "$TMP_FILE"
else
  wget -qO "$TMP_FILE" "$DOWNLOAD_URL"
fi

# --- install ---
DEST="${INSTALL_DIR}/${BINARY_NAME}"

# Stop any running instance before replacing the binary
if [ -f "$DEST" ]; then
  if command -v pkill >/dev/null 2>&1; then
    pkill -x "$BINARY_NAME" 2>/dev/null && sleep 0.5 || true
  fi
fi

mkdir -p "$INSTALL_DIR"
if [ -w "$INSTALL_DIR" ]; then
  cp "$TMP_FILE" "$DEST"
  chmod +x "$DEST"
else
  echo "Requires sudo to install to $INSTALL_DIR..."
  sudo cp "$TMP_FILE" "$DEST"
  sudo chmod +x "$DEST"
fi

# macOS: remove quarantine flag
if [ "$OS" = "Darwin" ]; then
  xattr -d com.apple.quarantine "$DEST" 2>/dev/null || true
fi

echo ""
echo "OK  Installed: $DEST"
echo "    Version:   $TAG"
echo ""

# Ensure ~/.local/bin is in PATH when using user-local install
PATH_UPDATED=0
if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
  if [ -n "$SHELL_RC" ] && ! grep -q '\.local/bin' "$SHELL_RC" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
    PATH_UPDATED=1
  fi
  export PATH="$HOME/.local/bin:$PATH"
  hash -r 2>/dev/null || true
fi

# If run as root via sudo, fix ownership of ~/.ctrlnode so the real user can write to it
if [ "$(id -u)" -eq 0 ] && [ -n "$SUDO_USER" ]; then
  REAL_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6 2>/dev/null || echo "")"
  if [ -n "$REAL_HOME" ] && [ -d "$REAL_HOME/.ctrlnode" ]; then
    chown -R "$SUDO_USER:$SUDO_USER" "$REAL_HOME/.ctrlnode" 2>/dev/null || true
    echo "    Fixed ownership of $REAL_HOME/.ctrlnode -> $SUDO_USER"
  fi
fi
if [ "$PATH_UPDATED" -eq 1 ]; then
  echo "┌─────────────────────────────────────────────────────┐"
  echo "│  IMPORTANT: reload your shell before running ctrlnode  │"
  echo "│                                                         │"
  echo "│    source $SHELL_RC"
  echo "│                                                         │"
  echo "│  Then start the Bridge:  ctrlnode                       │"
  echo "└─────────────────────────────────────────────────────┘"
else
  echo "Next: start the Bridge:"
  echo "  ctrlnode"
fi
echo ""
echo "When you run the Bridge for the first time, run 'ctrlnode login' to authorize it in your browser."
echo "Full setup (login + API keys):  ctrlnode --setup"
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
      # Redirect stdin from /dev/tty so ctrlnode's readline reads from the
      # terminal, not the curl pipe. Without this, readline captures the
      # prompt text itself as the answer and saves a corrupted PAIRING_TOKEN.
      "$DEST" < /dev/tty
      ;;
  esac
fi
