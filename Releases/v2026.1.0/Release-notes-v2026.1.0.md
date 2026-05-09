## CtrlNode Bridge 2026.1.0 Release Notes

First public release of the CtrlNode Bridge — the open-source connector between your local [OpenClaw](https://github.com/openclaw/openclaw) runtime and [CtrlNode SaaS](https://ctrlnode.ai).

### Install

**Linux / macOS** — one-liner, detects platform and CPU automatically:

```bash
curl -fsSL https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.0/install.sh | sh
```

**Windows (PowerShell)**:

```powershell
irm https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.0/install.ps1 | iex
```

The installer downloads the right binary, adds it to PATH, asks for your two tokens and prints the exact run command.

### Manual download

| Platform | File |
|---|---|
| Linux (modern CPUs, AVX2) | `ctrlnode-bridge-linux-x64` |
| Linux (older CPUs, AVX only) | `ctrlnode-bridge-linux-x64-baseline` |
| macOS (Apple Silicon) | `ctrlnode-bridge-darwin-arm64` |
| Windows | `ctrlnode-bridge.exe` |

> Not sure which Linux binary? `grep -q avx2 /proc/cpuinfo && echo standard || echo baseline`

### Quick start (manual)

**Linux / macOS**
```bash
PAIRING_TOKEN="your_pairing_token" \
OPENCLAW_GATEWAY_TOKEN="your_gateway_token" \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN = "your_pairing_token"
$env:OPENCLAW_GATEWAY_TOKEN = "your_gateway_token"
.\ctrlnode-bridge.exe
```

See the [README](https://github.com/ctrlnode-ai/ctrlnode#readme) and [setup guides](https://github.com/ctrlnode-ai/ctrlnode/tree/main/doc/setup) for full instructions.
