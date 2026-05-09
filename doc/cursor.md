# Provider: Cursor (`cursor`)

The `cursor` provider dispatches tasks to **Cursor** — the AI-first code editor — using the `@cursor/sdk` TypeScript library.

Because `@cursor/sdk` uses gRPC (HTTP/2) which is incompatible with Bun's HTTP/2 implementation, the Bridge spawns a separate **Node.js** child process (`cursor-sdk-runner.mjs`) and communicates with it over stdin/stdout JSONL.  The runner is embedded inside the Bridge binary and extracted automatically on first use — Node.js must be installed on the machine.

Provider name: **`cursor`**

---

## Authentication

Cursor uses an **API key** from the Cursor dashboard.

1. Open [https://cursor.com/settings](https://cursor.com/settings) → **Integrations** → **API Keys**
2. Create a new key
3. Set it as `CURSOR_API_KEY`

```env
CURSOR_API_KEY=crsr_...
```

---

## Prerequisites

### Node.js

The Bridge needs Node.js to run the Cursor SDK runner subprocess.

**Linux / macOS**
```bash
# Using nvm (recommended)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts
node --version

# Or via package manager (Ubuntu/Debian)
sudo apt install nodejs npm
```

**Windows (PowerShell)**
```powershell
# Using winget
winget install OpenJS.NodeJS.LTS
# Or download from https://nodejs.org
node --version
```

> The runner does **not** require `npm install` — the Bridge extracts a self-contained `cursor-sdk-runner.mjs` to `/tmp/` (Linux/macOS) or `%TEMP%` (Windows) on first run.  On subsequent runs it always overwrites the cached file to prevent stale-runner issues after Bridge upgrades.

### Note on `node_modules`

When running tasks, Cursor may create `node_modules` folders and a `cursor-sdk-runner.js` helper in the agent workspace.  These are normal runtime artifacts and can be added to `.gitignore` if you track the workspace in git.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `CURSOR_API_KEY` | **yes** | — | Cursor API key from the dashboard |
| `CURSOR_TIMEOUT_MINUTES` | no | `10` | Hard timeout per task |
| `AGENTS_FOLDER` | no | `~` | Root directory where agent workspace folders are created |

---

## Run the Bridge with Cursor

**Linux / macOS**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=cursor \
CURSOR_API_KEY=crsr_0cc282b2715c51548c8d2572bc7a554465b7b7e108fe96e0c44e604ae9540ca4 \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN  = "your_pairing_token"
$env:PROVIDERS      = "cursor"
$env:CURSOR_API_KEY = "crsr_..."
.\ctrlnode-bridge.exe
```

**`.env` file**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=cursor
CURSOR_API_KEY=crsr_...
AGENTS_FOLDER=/home/ubuntu
```

---

## How it works

1. When a task is dispatched to a Cursor agent, the Bridge spawns a Node.js process running the embedded `cursor-sdk-runner.mjs`.
2. The runner communicates with the Cursor SDK over gRPC and forwards messages to the Bridge over JSONL on stdout.
3. Task output is streamed back to CTRL NODE in real time.
4. On completion the Bridge writes an output markdown file and reports the final status.

---

## Combine with other providers

```env
PROVIDERS=cursor,claude-sdk
CURSOR_API_KEY=crsr_...
ANTHROPIC_API_KEY=sk-ant-...
```
