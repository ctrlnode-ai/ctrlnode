## CtrlNode Bridge 2026.2.1 Release Notes

This release adds **model selection support** to the Bridge: every provider now reports the AI models it supports, and CtrlNode displays them as suggestions when you create or edit an agent — so you can pick the exact model without having to remember or type IDs manually.

---

### What's new

#### Model selection in agent setup

When the Bridge connects to CtrlNode, it queries each provider's available models and sends them to the platform.  The agent creation and edit forms now show a **MODEL** field with a searchable drop-down populated from the live list.

- Start typing to filter — press Enter or click a suggestion to confirm.
- If no model is entered the provider uses its default.
- The list is scoped to the selected provider when one is detected; otherwise all known models across providers are shown.

#### Built-in model lists per provider

Each provider ships a curated fallback list used when the live API is unavailable or no API key is configured:

| Provider | Source | Notable models |
|---|---|---|
| `copilot` | GitHub Copilot docs | claude-sonnet-4-6, gemini-2.5-pro, gpt-5.5, gpt-5.3-codex, … |
| `gemini` | Google AI Gemini API docs | gemini-2.5-pro/flash/flash-lite, gemini-3.1-flash-lite, gemini-3.1-pro-preview |
| `cursor` | Cursor pricing docs | claude-opus-4-7, gpt-5.5, grok-4.3, grok-4.20, kimi-k2.5, composer-2.5, … |
| `claude` / `claude-sdk` | Anthropic API (`/v1/models`) | dynamic list fetched at connect time |
| `claude-code` | Anthropic API (`/v1/models`) | dynamic list fetched at connect time |
| `codex` | OpenAI API (`/v1/models`) | dynamic list fetched at connect time |

When a live API call succeeds, the dynamic list replaces the fallback.  `MultiProvider` merges and deduplicates lists from all sub-providers.

#### New `IProvider.listModels()` method

All providers now implement the optional `listModels(): Promise<string[]>` method on the `IProvider` interface.  The Bridge calls this once after the handshake and sends the results to CtrlNode via a new WebSocket message:

```json
{ "action": "available_models", "models": { "copilot": ["claude-sonnet-4-6", ...], "cursor": [...] } }
```

CtrlNode stores the map, broadcasts it over SignalR to connected clients, and includes it in the `/api/system/bridge/status` REST response so the UI stays in sync even after a page refresh.

---

### Binaries

| File | Target |
|---|---|
| `ctrlnode-bridge.exe` | Windows x64 |
| `ctrlnode-bridge-linux-x64` | Linux x64 (requires AVX2) |
| `ctrlnode-bridge-linux-x64-baseline` | Linux x64 (no AVX2 — older CPUs / cloud VMs) |
| `ctrlnode-bridge-darwin-arm64` | macOS Apple Silicon |

---

### Upgrade

Replace the binary and restart the Bridge process.  No configuration changes are required — the model list is populated automatically on connect.
