# Provider: OpenClaw (`openclaw`)

The `openclaw` provider is the **original CTRL NODE backend** — it dispatches tasks to agents running inside the [OpenClaw](https://github.com/openclaw/openclaw) gateway over HTTP.  OpenClaw manages its own agent runtime and session history; the Bridge relays task intents, streams session output back to CTRL NODE, and detects completion tags in agent replies.

Provider name: **`openclaw`**

---

## What is OpenClaw?

OpenClaw is an open-source AI agent executor that manages sessions, handles tool calls, and orchestrates sub-agents.  It runs on your machine or server and exposes a local HTTP gateway.  The Bridge connects to that gateway.

---

## Prerequisites

OpenClaw must be running before starting the Bridge with this provider.

Install and start OpenClaw following the official instructions:

→ [https://github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

Once running, the gateway is available at `http://localhost:18789` by default.

---

## Authentication

OpenClaw uses a **gateway token** that you set when starting the OpenClaw process.

```env
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
```

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | **yes** | — | Token configured in your OpenClaw instance |
| `OPENCLAW_GATEWAY_URL` | no | `http://localhost:18789` | URL of the running OpenClaw gateway |
| `AGENTS_FOLDER` | no | `~` | Root directory used for agent workspace paths |

---

## Agent configuration

OpenClaw agents are defined in `openclaw.json` in the agent workspace root.  The Bridge reads this file to discover agents and their workspace paths.

A minimal `openclaw.json`:

```json
{
  "agents": [
    {
      "id": "my-agent",
      "name": "My Agent",
      "workspace": "/home/user/workspaces/my-agent"
    }
  ]
}
```

Refer to the [OpenClaw documentation](https://github.com/openclaw/openclaw) for full configuration options.

---

## Run the Bridge with OpenClaw

**Linux / macOS**
```bash
PAIRING_TOKEN=your_pairing_token \
PROVIDERS=openclaw \
OPENCLAW_GATEWAY_TOKEN=your_gateway_token \
./ctrlnode-bridge-linux-x64
```

**Windows (PowerShell)**
```powershell
$env:PAIRING_TOKEN          = "your_pairing_token"
$env:PROVIDERS              = "openclaw"
$env:OPENCLAW_GATEWAY_TOKEN = "your_gateway_token"
.\ctrlnode-bridge.exe
```

**`.env` file**
```env
PAIRING_TOKEN=your_pairing_token
PROVIDERS=openclaw
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
OPENCLAW_GATEWAY_URL=http://localhost:18789
```

---

## Run alongside other providers

The `openclaw` provider can be combined with any other provider.  Tasks assigned to OpenClaw agents go to the gateway; tasks assigned to Claude/Cursor/etc. agents go to their respective SDKs.

```env
PROVIDERS=openclaw,claude-sdk
OPENCLAW_GATEWAY_TOKEN=your_gateway_token
ANTHROPIC_API_KEY=sk-ant-...
```

---

## How it works

1. The Bridge reads `openclaw.json` to build the agent list and registers each agent with CTRL NODE.
2. When a task is dispatched, the Bridge calls the OpenClaw gateway's `sessions/spawn` endpoint with the task prompt and agent ID.
3. The main session log is polled at regular intervals; incoming messages are streamed to CTRL NODE.
4. Completion is detected when the agent writes a `<TASK_COMPLETED:…>`, `<TASK_BLOCKED:…>`, or `<TASK_FAILED:…>` tag in its output, or when the gateway signals session end.

---

## Docker setup

If you run OpenClaw in Docker alongside the Bridge, add it to the same Docker network and set `OPENCLAW_GATEWAY_URL` to the container's internal hostname, e.g. `http://openclaw:18789`.
