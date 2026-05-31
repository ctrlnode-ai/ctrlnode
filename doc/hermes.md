# Provider: Hermes (`hermes`)

The `hermes` provider dispatches tasks to **Hermes** using the **Agent Client Protocol (ACP)** over stdio (`hermes acp`). Each agent gets its own isolated Hermes profile so credentials and conversation history never mix across agents. Falls back to `hermes chat -Q -q` if ACP is unavailable.

Provider name: **`hermes`**

---

## Install the Hermes CLI

→ [Official installation guide](https://hermes-agent.nousresearch.com/docs/getting-started/installation)

---

## Authentication

Hermes reads API keys from `~/.hermes/auth.json`. Log in once interactively:

```bash
hermes auth login
```

This stores credentials in `~/.hermes/auth.json`. The Bridge automatically copies this file into each agent's isolated profile on first use, so every agent inherits the same providers.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `HERMES_TIMEOUT_MINUTES` | no | `15` | Hard timeout per task |
| `HERMES_USE_ACP` | no | `true` | Set to `false` to force `hermes chat` CLI mode |
| `HERMES_HOME` | no | `~/.hermes` | Emergency global override for the Hermes home directory |

---

## Agent profiles

Each CtrlNode agent gets its own Hermes profile at `~/.hermes/profiles/<agentId>/`, containing:

- **`SOUL.md`** — agent identity (name, role, instructions from the CtrlNode UI)
- **`config.yaml`** — model selection (written when a model is set in the UI)
- **`auth.json`** — seeded from `~/.hermes/auth.json` on first creation

Profiles are created automatically when an agent is registered. You do not need to manage them manually.

---

## Model selection

Set the model from the CtrlNode agent editor. The Bridge writes it to the agent's `config.yaml`:

```yaml
model:
  default: claude-sonnet-4-6
```

For provider-prefixed models (e.g. `openrouter/mistralai/mistral-large`):

```yaml
model:
  provider: openrouter
  default: mistralai/mistral-large
```

---

## How it works

1. The Bridge spawns `hermes acp` as a subprocess with `HERMES_HOME` pointing to the agent's profile.
2. Communication happens over ACP (Agent Client Protocol) via stdin/stdout — same protocol as Copilot and Gemini.
3. The Bridge also exposes an MCP filesystem server scoped to the workspace so Hermes can read and write task files.
4. Task events are forwarded to CTRL NODE in real time. On completion the Bridge writes output files and reports the final status.

---

## Combine with other providers

```env
HERMES_TIMEOUT_MINUTES=20
```

All providers run from the same Bridge process automatically — no extra configuration needed.
