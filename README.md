<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.png">
  <img alt="CTRL NODE" src="assets/logo-dark.png" width="420">
</picture>

### Control and run AI agent graphs from anywhere.

[![License: ELv2](https://img.shields.io/badge/License-Elastic_v2-007EC6?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/badge/release-v2026.2.6-1aff8c?style=flat-square)](https://github.com/ctrlnode-ai/ctrlnode/releases)
[![Website](https://img.shields.io/badge/ctrlnode.ai-0A0A23?style=flat-square)](https://ctrlnode.ai)

[Website](https://ctrlnode.ai) · [App](https://app.ctrlnode.ai) · [Releases](https://github.com/ctrlnode-ai/ctrlnode/releases)

</div>

---

**CTRL NODE is a control system for AI agent graphs.** Build a graph from agent, task, and control nodes; connect the paths they can take; then run and observe it from one place.

Install the open-source Bridge on your laptop, server, or CI machine. It makes one outbound connection to CtrlNode, so your agents and workspaces stay on your machine—no inbound ports, VPN, or firewall changes.

---

## What changed in v2026.2.6

- **OpenRouter** — use your own `OPENROUTER_API_KEY` and pay only for usage.
- **Ollama** — run local models with no API key.
- **`ctrlnode login`** — authorize the Bridge in your browser; the pairing token is saved automatically.
- **Reliable follow-ups** — every execution has its own activity log and keeps earlier context.

See the full [v2026.2.6 release notes](Releases/v2026.2.6/Release-notes-v2026.2.6.md).

---

## How it works

```text
  CtrlNode app
       │
       │  Build and run AI agent graphs
       ▼
  CtrlNode control plane
       ├── Tasks and Kanban
       ├── Routines
       ├── Graph canvas
       └── Team, files, and activity
       │
       │  Outbound WebSocket
       ▼
  Your machine or server
       ├── CtrlNode Bridge
       ├── Your AI providers
       └── Your local workspaces and files
```

The Bridge only connects out. Your code and workspaces never leave your machine unless an agent explicitly returns output to CtrlNode.

---

## Supported providers

| Provider | Runs through | Setup |
|---|---|---|
| `claude` | Claude Agent SDK / Claude Code | `ANTHROPIC_API_KEY` or subscription |
| `copilot` | GitHub Copilot ACP | Copilot extension |
| `gemini` | Gemini CLI ACP | `GEMINI_API_KEY` |
| `codex` | OpenAI Codex SDK | `CODEX_API_KEY` |
| `cursor` | Cursor SDK | `CURSOR_API_KEY` |
| `hermes` | Hermes ACP | Hermes CLI |
| `openclaw` | OpenClaw gateway | `OPENCLAW_GATEWAY_TOKEN` |
| `openrouter` | OpenRouter API | `OPENROUTER_API_KEY` |
| `ollama` | Local Ollama | Install Ollama and pull a model |

Use more than one provider in the same graph.

---

## Ai Agents Graphs

![AI agent graph canvas](assets/graph-ai-agents-execution.png)

A **Graph** is the visual execution model in CtrlNode. Add agent nodes, connect their paths, choose a trigger, and deploy. Each node can use the provider and model that fits its job.

- Branch and fan out work
- Mix providers in one graph
- Start from a schedule or event
- Follow every node's activity live

---

## Also included

- **Tasks and Kanban** — run ad hoc work and track it from backlog to done.
- **Routines** — schedule recurring agent work.
- **Live activity** — watch output as each agent runs.
- **Files and memory** — give agents the local context they need.

---

## Get started

### 1. Install the Bridge

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.sh | sh
```

**Windows PowerShell**

```powershell
irm https://raw.githubusercontent.com/ctrlnode-ai/ctrlnode/main/install.ps1 | iex
```

Or [download a binary from Releases](https://github.com/ctrlnode-ai/ctrlnode/releases).

### 2. Sign in

```bash
ctrlnode login
```

Approve the code in your browser. Bridge stores the pairing token in its `.env` file.

### 3. Start the Bridge

```bash
ctrlnode
```

Your agents appear in the app. Create a task or graph and run it on your machine.

---

## Repository

| Component | Path |
|---|---|
| **Bridge source** | [`src/`](src/) |
| **Provider guides** | [`doc/`](doc/) |
| **Release notes** | [`Releases/`](Releases/) |

## Contributing

```bash
git clone https://github.com/ctrlnode-ai/ctrlnode.git
cd ctrlnode
bun install
bun dev
```

## License

Licensed under the [Elastic License 2.0](LICENSE) (ELv2).

<div align="center">

Built by [CTRL NODE](https://ctrlnode.ai)

</div>
