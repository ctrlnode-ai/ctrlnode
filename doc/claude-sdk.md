# Provider: Claude (`claude-sdk`)

The `claude-sdk` provider dispatches tasks to **Anthropic Claude** using the `@anthropic-ai/claude-agent-sdk` TypeScript library — or alternatively the `claude` CLI binary.  It runs Claude agenically in the task folder, streams output back to CTRL NODE in real time, and writes structured output files on completion.

Provider name: **`claude-sdk`** (also accepted as `claude`)

---

## Authentication

Claude requires **either** an API key or an active CLI login session.

**Option A — API key (recommended for servers)**

```env
ANTHROPIC_API_KEY=sk-ant-...
```

Set this in your `.env` file next to the Bridge binary, or export it in the shell before starting the Bridge.

**Option B — `claude` CLI login (interactive machines)**

```bash
claude login
```

This opens a browser OAuth flow and stores a session token in `~/.claude/`.  No env var needed — the SDK and CLI both pick it up automatically.

---

## Install the `claude` CLI

The Bridge uses the Anthropic SDK directly (`@anthropic-ai/claude-agent-sdk`) — you do **not** need the CLI installed unless you set `CLAUDE_SDK_EXECUTABLE` to use the binary path.

If you want the CLI available (for interactive use or as the executable):

**Linux / macOS**
```bash
npm install -g @anthropic-ai/claude-code
# verify
claude --version
```

**Windows (PowerShell)**
```powershell
npm install -g @anthropic-ai/claude-code
claude --version
```

> On Linux you may need to prefix with `sudo` or configure npm to install globally without root — `npm config set prefix ~/.local` then add `~/.local/bin` to your PATH.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | if no CLI login | — | Anthropic API key |
| `CLAUDE_SDK_EXECUTABLE` | no | *(SDK internal)* | Full path to the `claude` binary when you want the CLI to be invoked instead of the SDK's bundled runner |
| `CLAUDE_SDK_TOOLS` | no | `Read,Write,Edit,Bash,Glob,Grep` | Comma-separated list of allowed tools |
| `CLAUDE_SDK_MAX_TURNS` | no | `20` | Maximum agentic turns per task |
| `CLAUDE_SDK_TIMEOUT_MINUTES` | no | `10` | Hard timeout per task |
| `CLAUDE_SDK_PERMISSION_MODE` | no | `bypassPermissions` | `bypassPermissions` \| `acceptEdits` \| `dontAsk` |
| `CLAUDE_SDK_MODEL` | no | *(SDK default)* | Model alias/ID override, e.g. `claude-opus-4-5` |
| `AGENTS_FOLDER` | no | `~` | Root directory where agent workspace folders are created |

---

## Run the Bridge with Claude

**Linux / macOS — API key**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=claude-sdk \
ANTHROPIC_API_KEY=sk-ant-... \
AGENTS_FOLDER=/home/user \
./ctrlnode-bridge-linux-x64
```

**Linux / macOS — CLI login, custom executable path**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=claude-sdk \
CLAUDE_SDK_EXECUTABLE=/home/ubuntu/.local/bin/claude \
AGENTS_FOLDER=/home/ubuntu \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN          = "your_pairing_token"
$env:PROVIDERS              = "claude-sdk"
$env:ANTHROPIC_API_KEY      = "sk-ant-..."
$env:AGENTS_FOLDER          = "C:\Users\you\agents"
.\ctrlnode-bridge.exe
```

**`.env` file (recommended for persistent setups)**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=claude-sdk
ANTHROPIC_API_KEY=sk-ant-...
AGENTS_FOLDER=/home/ubuntu
```
```bash
./ctrlnode-bridge-linux-x64
```

---

## How it works

1. When CTRL NODE dispatches a task to an agent registered under this provider, the Bridge creates a task folder inside `AGENTS_FOLDER/tasks/`.
2. A `CLAUDE.md` file is written into the task folder containing the agent's role and instructions — Claude picks this up automatically via its project-file discovery.
3. The `query()` SDK function is called with the task prompt and configured tools.  Assistant events are streamed back to CTRL NODE as they arrive.
4. On completion the Bridge writes an output markdown file and reports `completed`, `blocked`, or `failed` status.

---

## Combine with other providers

```env
PROVIDERS=claude-sdk,copilot
ANTHROPIC_API_KEY=sk-ant-...
COPILOT_GITHUB_TOKEN=github_pat_...
```

Tasks assigned to Claude agents go to `claude-sdk`; tasks assigned to Copilot agents go to `copilot` — all from the same Bridge process.
