# Provider: Gemini (`gemini`)

The `gemini` provider dispatches tasks to **Google Gemini** using the `gemini` CLI and the **Agent Client Protocol (ACP)** over stdio.  The Bridge spawns the `gemini` process with the task prompt, streams output via ACP events, and writes structured output files on completion.

Provider name: **`gemini`**

---

## Authentication

Gemini supports **two** authentication modes:

**Option A — Gemini API key**

```env
GEMINI_API_KEY=AIza...
```

**Option B — `gemini auth login` (interactive machines)**

```bash
gemini auth login
```

This opens a browser Google OAuth flow and stores credentials locally.  No env var needed — the CLI picks it up automatically.

---

## Install the Gemini CLI

**Linux / macOS**
```bash
npm install -g @google/gemini-cli
# verify
gemini --version
```

> On Linux without root npm access: `npm config set prefix ~/.local` then add `~/.local/bin` to PATH.

**Windows (PowerShell)**
```powershell
npm install -g @google/gemini-cli
gemini --version
```

After installing, log in once if you are not using an API key:
```bash
gemini auth login
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `GEMINI_API_KEY` | if no CLI login | — | Google AI Studio / Vertex API key |
| `GEMINI_TIMEOUT_MINUTES` | no | `10` | Hard timeout per task |
| `AGENTS_FOLDER` | no | `~` | Root directory where agent workspace folders are created |

---

## Run the Bridge with Gemini

**Linux / macOS — API key**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=gemini \
GEMINI_API_KEY=AIza... \
AGENTS_FOLDER=/home/user \
./ctrlnode-bridge-linux-x64
```

**Linux / macOS — CLI login**
```bash
# Login once interactively
gemini auth login

# Then run the Bridge (no API key needed)
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=gemini \
AGENTS_FOLDER=/home/ubuntu \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN = "your_pairing_token"
$env:PROVIDERS     = "gemini"
$env:GEMINI_API_KEY = "AIza..."
.\ctrlnode-bridge.exe
```

**`.env` file**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=gemini
GEMINI_API_KEY=AIza...
AGENTS_FOLDER=/home/ubuntu
```

---

## Trusted folders

When the Bridge activates a task workspace, it automatically adds the workspace path to the Gemini `trustedFolders.json` configuration so the CLI does not prompt for trust confirmation mid-task.

---

## How it works

1. The Bridge spawns `gemini` as a subprocess for each task dispatch.
2. Communication happens over ACP (Agent Client Protocol) via stdin/stdout — the same protocol used by Copilot.
3. Task events are forwarded to CTRL NODE in real time.
4. On completion the Bridge writes an output markdown file and reports the final status.

---

## Combine with other providers

```env
PROVIDERS=gemini,claude-sdk
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
```
