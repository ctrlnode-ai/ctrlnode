## CtrlNode Bridge v2026.2.6

This release adds OpenRouter, Ollama, browser login, AI-generated pipeline blueprints, and more reliable follow-ups.

### New providers

#### OpenRouter

Use OpenRouter with your own API key and pay only for what you use.

- Add `OPENROUTER_API_KEY` with `ctrlnode --setup` or in `.env`.
- The provider activates automatically.
- Task cost is saved in `agent_log.md`.
- Insufficient OpenRouter credit is reported as **blocked**.
- Optional settings: `OPENROUTER_DEFAULT_MODEL`, `OPENROUTER_ALLOWED_MODELS`, `OPENROUTER_MAX_TURNS`, and `OPENROUTER_MAX_TOKENS_PER_TURN`.

#### Ollama

Run agents locally with Ollama. No API key is needed.

- Install Ollama and pull the model you want to use: `ollama pull <model>`.
- By default, Bridge connects to `http://localhost:11434`.
- Set `OLLAMA_HOST` only when your Ollama server uses another address.
- `OLLAMA_NUM_CTX` controls the context window (default: `32768`).

OpenRouter and Ollama can read, write, edit, search, and list files in the task workspace.

### AI-generated pipeline blueprints

Describe a pipeline in plain language and get a structured blueprint back.

- Works with every provider: Claude Code, Claude Agent SDK, Codex, Copilot, Cursor, Gemini, Hermes, OpenClaw, OpenRouter, and Ollama.
- Read-only: it never creates a task folder, persists a session, or shows up in task history.
- Bounded to a short timeout (default 90s, `GRAPH_GENERATION_TIMEOUT_SECONDS`) so a stuck draft never occupies an agent.

### Easier sign-in

Run:

```bash
ctrlnode login
```

Bridge shows a code, opens the authorization page when possible, and saves the pairing token to its `.env` file after approval. This also works when Bridge runs on a remote or headless machine.

### Better follow-ups and logs

- Claude follow-ups automatically start a new session when the previous session is no longer available, while keeping the task context.
- Each execution now has its own log file: `agent_log.md`, `agent_log.followup-1.md`, `agent_log.followup-2.md`, and so on.
- Follow-ups receive the full earlier activity, including for Copilot, Hermes, OpenRouter, and Ollama.

### Provider and model updates

- Bridge now uses the provider list configured by CtrlNode, preventing mismatches between Bridge and the backend.
- Model lists are loaded from CtrlNode instead of being bundled into the Bridge binary; the old hardcoded fallback lists are gone.

### Reliability fixes

- OpenRouter and Ollama now fall back to parsing tool calls embedded in the model's text when the API reports none, with a brace-aware scanner so stray braces in prose no longer drop real tool calls.
- Fixed Ollama health checks silently failing when `OLLAMA_HOST` was set to a bind address such as `0.0.0.0`; Bridge now normalizes it to a connectable host.
- Fixed follow-ups occasionally writing output and logs to the wrong task folder.

### Upgrade

Replace the Bridge binary and restart it. Existing installations do not need configuration changes.

To enable a new provider:

- **OpenRouter:** add `OPENROUTER_API_KEY`.
- **Ollama:** install Ollama and pull a model.
