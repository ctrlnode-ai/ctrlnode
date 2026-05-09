# Provider: GitHub Copilot (`copilot`)

The `copilot` provider dispatches tasks to **GitHub Copilot** using the **Agent Client Protocol (ACP)** over stdio.  The Bridge spawns the `@github/copilot` CLI with the task prompt, streams output via ACP events, and writes structured output files on completion.

Provider name: **`copilot`**

---

## Authentication

Copilot requires a **GitHub fine-grained Personal Access Token (PAT)** with the **Copilot Requests** permission.

> **Important:** The `Copilot Requests` permission is only available on **personal account** fine-grained PATs — it is not available on organisation tokens.

### Create the token

1. Go to [https://github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Set an expiration date
3. Under **Permissions → Repository permissions**, enable **Copilot Requests** (read & write)
4. Click **Generate token** and copy it

```env
COPILOT_GITHUB_TOKEN=github_pat_...
```

### Alternative — interactive login

```bash
npm install -g @github/copilot
copilot login
```

This stores an OAuth session in your local config.  Once logged in you can omit `COPILOT_GITHUB_TOKEN` — the CLI picks up the cached session automatically.

---

## Install the Copilot CLI

**Linux / macOS**
```bash
npm install -g @github/copilot
# verify
copilot --version
```

**Windows (PowerShell)**
```powershell
npm install -g @github/copilot
copilot --version
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `COPILOT_GITHUB_TOKEN` | if no CLI login | — | GitHub fine-grained PAT with **Copilot Requests** permission |
| `COPILOT_TIMEOUT_MINUTES` | no | `10` | Hard timeout per task |
| `AGENTS_FOLDER` | no | `~` | Root directory where agent workspace folders are created |

---

## Run the Bridge with Copilot

**Linux / macOS — PAT token**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=copilot \
COPILOT_GITHUB_TOKEN=github_pat_... \
./ctrlnode-bridge-linux-x64
```

**Linux / macOS — CLI login**
```bash
# Login once interactively
copilot login

# Then run the Bridge
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=copilot \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN         = "your_pairing_token"
$env:PROVIDERS             = "copilot"
$env:COPILOT_GITHUB_TOKEN  = "github_pat_..."
.\ctrlnode-bridge.exe
```

**`.env` file**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=copilot
COPILOT_GITHUB_TOKEN=github_pat_...
AGENTS_FOLDER=/home/ubuntu
```

---

## How it works

1. When a task is dispatched to a Copilot agent, the Bridge spawns the `@github/copilot` CLI as an ACP subprocess.
2. The agent's configured description (instructions) is prepended to the task prompt so Copilot acts according to its role.
3. ACP events are forwarded to CTRL NODE in real time.
4. On completion the Bridge writes an output markdown file and reports the final status.

> **Note:** The Copilot ACP provider does not maintain persistent sessions across tasks — each dispatch opens a fresh ACP session.

---

## Combine with other providers

```env
PROVIDERS=copilot,cursor
COPILOT_GITHUB_TOKEN=github_pat_...
CURSOR_API_KEY=crsr_...
```
