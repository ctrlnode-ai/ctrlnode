# Advanced install — CtrlNode Bridge

This guide covers manual installation for every supported platform.
Use this when you cannot run the one-liner installer (air-gapped servers, CI pipelines, custom install paths, etc.).

→ **Quick install?** Go back to the [README](../../README.md#get-started-in-3-steps) and use the one-liner.

---

## Available binaries

Download from the [Releases page](https://github.com/ctrlnode-ai/ctrlnode/releases) or grab them directly:

| Binary | Platform |
|---|---|
| `ctrlnode-bridge.exe` | Windows x64 |
| `ctrlnode-bridge-linux-x64` | Linux x64 (modern CPUs, requires AVX2) |
| `ctrlnode-bridge-linux-x64-baseline` | Linux x64 (older CPUs, AVX only) |
| `ctrlnode-bridge-darwin-arm64` | macOS Apple Silicon (M1/M2/M3/M4) |

---

## Which Linux binary do I need?

The two Linux builds differ only in CPU instruction-set requirements:

```bash
grep -o 'avx[^ ]*' /proc/cpuinfo | sort -u | head
```

- Output includes `avx2` → use **`ctrlnode-bridge-linux-x64`** (faster, smaller)
- Output shows only `avx` (no `avx2`) → use **`ctrlnode-bridge-linux-x64-baseline`**
- No output at all → use **`ctrlnode-bridge-linux-x64-baseline`**

Quick one-liner that decides for you:

```bash
grep -q avx2 /proc/cpuinfo && echo "use: ctrlnode-bridge-linux-x64" || echo "use: ctrlnode-bridge-linux-x64-baseline"
```

---

## Linux x64

```bash
# 1 — download (pick the right binary — see above)
BINARY=ctrlnode-bridge-linux-x64        # or -baseline
curl -fsSL \
  https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.1/${BINARY} \
  -o /usr/local/bin/ctrlnode-bridge

# 2 — make executable
chmod +x /usr/local/bin/ctrlnode-bridge

# 3 — run
PAIRING_TOKEN="<your_pairing_token>" \
OPENCLAW_GATEWAY_TOKEN="<your_gateway_token>" \
ctrlnode-bridge
```

> **No write access to `/usr/local/bin`?**
> ```bash
> mkdir -p ~/.local/bin
> mv /tmp/ctrlnode-bridge ~/.local/bin/
> export PATH="$PATH:$HOME/.local/bin"   # add to ~/.bashrc or ~/.zshrc to persist
> ```

---

## macOS (Apple Silicon — M1/M2/M3/M4)

```bash
# 1 — download
curl -fsSL \
  https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.1/ctrlnode-bridge-darwin-arm64 \
  -o /usr/local/bin/ctrlnode-bridge

# 2 — make executable and remove quarantine
chmod +x /usr/local/bin/ctrlnode-bridge
xattr -d com.apple.quarantine /usr/local/bin/ctrlnode-bridge 2>/dev/null || true

# 3 — run
PAIRING_TOKEN="<your_pairing_token>" \
OPENCLAW_GATEWAY_TOKEN="<your_gateway_token>" \
ctrlnode-bridge
```

> macOS Intel is not yet available as a pre-built binary. Use Rosetta 2 or build from source (`bun build ./src/index.ts --compile --target=bun-darwin-x64`).

---

## Windows (PowerShell)

```powershell
# 1 — download
$dest = "$env:LOCALAPPDATA\Programs\ctrlnode\ctrlnode-bridge.exe"
New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
Invoke-WebRequest `
  "https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.1/ctrlnode-bridge.exe" `
  -OutFile $dest

# 2 — (optional) add to PATH for the current user
$userPath = [System.Environment]::GetEnvironmentVariable("PATH", "User")
$dir = Split-Path $dest
if ($userPath -notlike "*$dir*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$userPath;$dir", "User")
    Write-Host "Added $dir to PATH. Restart your terminal to apply."
}

# 3 — run
$env:PAIRING_TOKEN = "<your_pairing_token>"
$env:OPENCLAW_GATEWAY_TOKEN = "<your_gateway_token>"
ctrlnode-bridge
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PAIRING_TOKEN` | ✅ | From [ctrlnode.ai](https://ctrlnode.ai) → Settings → Bridge |
| `OPENCLAW_GATEWAY_TOKEN` | ✅ | From `~/.openclaw/openclaw.json` → `gateway.auth.token` |
| `SAAS_URL` | optional | Override WebSocket endpoint (default: `wss://app.ctrlnode.ai/ws/bridge`) |
| `LOG_LEVEL` | optional | `debug` / `info` / `warn` / `error` (default: `info`) |

---

## Running as a service

- [docker.md](docker.md) — Bridge inside a Docker container alongside OpenClaw
- [linux.md](linux.md) — Linux server, no Docker (systemd service)
- [mac.md](mac.md) — macOS native (launchd service)
