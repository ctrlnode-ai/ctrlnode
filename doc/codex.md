# Provider: OpenAI Codex (`codex`)

The `codex` provider dispatches tasks to **OpenAI Codex** using the `@openai/codex-sdk` TypeScript library.  Internally the SDK drives `codex app-server` over stdio JSON-RPC.  The Bridge handles per-agent `CODEX_HOME` isolation so each agent keeps its own configuration.

Provider name: **`codex`**

---

## Authentication

Codex supports **two** authentication modes:

**Option A — API key**

```env
CODEX_API_KEY=sk-...
```

**Option B — interactive login**

```bash
codex auth login
```

This stores credentials in `~/.codex/`.  No env var needed — the SDK picks it up automatically.

---

## Install the Codex CLI

The CLI must be installed with its **optional native dependencies** (binaries needed by the SDK).

**Linux / macOS**
```bash
npm install -g @openai/codex
# verify
codex --version
which codex          # note the path — you'll need it for CODEX_BIN_PATH
```

**Windows (PowerShell)**
```powershell
npm install -g @openai/codex
codex --version
where.exe codex      # note the path
```

> If the Bridge logs `Unable to locate Codex CLI binaries`, it means the binary is not in PATH or was installed without optional dependencies.  Use `CODEX_BIN_PATH` to set the absolute path explicitly (see below).

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CODEX_API_KEY` | if no CLI login | — | OpenAI API key |
| `CODEX_BIN_PATH` | no | *(auto-detect from PATH)* | Absolute path to the `codex` binary, e.g. `/usr/local/bin/codex` or `/usr/bin/codex` |
| `CODEX_DEFAULT_MODEL` | no | *(SDK default)* | Model override, e.g. `gpt-5.4-nano` or `codex-mini-latest` |
| `CODEX_TIMEOUT_MINUTES` | no | `10` | Hard timeout per task |
| `AGENTS_FOLDER` | no | `~` | Root directory where agent workspace folders are created |

---

## Run the Bridge with Codex

**Linux / macOS**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=codex \
CODEX_API_KEY=sk-... \
CODEX_BIN_PATH=/usr/local/bin/codex \
CODEX_DEFAULT_MODEL=gpt-5.4-nano \
./ctrlnode-bridge-linux-x64
```

**Linux / macOS — binary in non-standard path**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=codex \
CODEX_API_KEY=sk-... \
CODEX_BIN_PATH=/usr/bin/codex \
CODEX_DEFAULT_MODEL=gpt-5.4-nano \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN        = "your_pairing_token"
$env:PROVIDERS            = "codex"
$env:CODEX_API_KEY        = "sk-..."
$env:CODEX_BIN_PATH       = "C:\Users\you\AppData\Roaming\npm\codex.cmd"
$env:CODEX_DEFAULT_MODEL  = "gpt-5.4-nano"
.\ctrlnode-bridge.exe
```

**`.env` file**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=codex
CODEX_API_KEY=sk-...
CODEX_BIN_PATH=/usr/local/bin/codex
CODEX_DEFAULT_MODEL=gpt-5.4-nano
AGENTS_FOLDER=/home/ubuntu
```

---

## Per-agent home isolation

The Bridge provisions a dedicated `CODEX_HOME` directory for each agent under `AGENTS_FOLDER`.  This ensures each agent's Codex configuration, history, and credentials are kept separate, preventing cross-agent contamination in multi-agent setups.

---

## How it works

1. When a task is dispatched to a Codex agent, the Bridge resolves the agent-specific `CODEX_HOME` and starts the SDK session.
2. The task prompt and agent instructions are forwarded to the Codex model.
3. Output events are streamed back to CTRL NODE in real time.
4. On completion the Bridge writes an output markdown file and reports `completed`, `blocked`, or `failed` status.

---

## Combine with other providers

```env
PROVIDERS=codex,gemini
CODEX_API_KEY=sk-...
CODEX_BIN_PATH=/usr/local/bin/codex
GEMINI_API_KEY=AIza...
```
