## CtrlNode Bridge 2026.2.0 Release Notes

This release expands the Bridge beyond OpenClaw by introducing a **multi-provider architecture** — you can now connect any supported AI coding agent CLI (Claude, Copilot, Gemini, Codex, Cursor) to CtrlNode, alongside or instead of OpenClaw.  Each backend is called a **Provider**.

---

### What's new

#### Multi-provider architecture

The Bridge now manages multiple agent providers in a single process.  A new `PROVIDERS` environment variable accepts a comma-separated list of provider names:

```env
PROVIDERS=openclaw,claude-sdk,copilot,cursor
```

The previous `PROVIDER` (singular) variable still works as a fallback.  When more than one provider is listed, a `MultiProvider` composite routes each task to the correct backend based on agent ownership, with first-registered provider winning on ID conflicts.

#### New providers

| Provider name | SDK / protocol | Key env var |
|---|---|---|
| `openclaw` | OpenClaw Gateway HTTP (unchanged) | `OPENCLAW_GATEWAY_TOKEN` |
| `claude` / `claude-sdk` | `@anthropic-ai/claude-agent-sdk` | `ANTHROPIC_API_KEY` |
| `copilot` | `@agentclientprotocol/sdk` (ACP) | *(Copilot extension)* |
| `gemini` | `@agentclientprotocol/sdk` (ACP) | *(Gemini CLI)* |
| `codex` | `@openai/codex-sdk` | `CODEX_API_KEY` |
| `cursor` | `@cursor/sdk` via Node.js runner | `CURSOR_API_KEY` |

All providers implement the same `IProvider` interface (`dispatchTask`, `sendToSession`, `invokeTool`, `discoverAgents`, `deleteAgent`, `resolveFilesystemBase`), so the Bridge core treats them identically.

#### Provider-specific highlights

**Claude Agent SDK** (`claude-sdk`)
- Uses the programmatic `@anthropic-ai/claude-agent-sdk` `query()` API — no subprocess, no stdin/arg-length limits.
- Writes a `CLAUDE.md` context file into the task folder with the agent's role and instructions so Claude picks them up via normal project-file discovery.
- Splits the task prompt into body + `## INSTRUCTIONS` block, placing instructions in the system prompt for a cleaner agent context.
- Real-time streaming of assistant events forwarded to CtrlNode SaaS.
- Session resume support (session ID cached per `taskId`).
- `CLAUDE_SDK_TOOLS`, `CLAUDE_SDK_MAX_TURNS`, `CLAUDE_SDK_TIMEOUT_MINUTES`, `CLAUDE_SDK_PERMISSION_MODE`, `CLAUDE_SDK_MODEL` env vars.

**Cursor SDK** (`cursor`)
- `@cursor/sdk` uses gRPC (HTTP/2) which is incompatible with Bun's http2 stack; the provider spawns a Node.js child process (`cursor-sdk-runner.mjs`) and communicates over stdin/stdout JSONL.
- The runner binary is embedded in the Bridge executable; on first run it is extracted to a temp path.  The cached file is always overwritten to prevent stale-runner issues after upgrades.
- `CURSOR_API_KEY`, `CURSOR_TIMEOUT_MINUTES`.

**Copilot / Gemini ACP** (`copilot`, `gemini`)
- Both use the Agent Client Protocol (ACP) SDK over stdio.
- Agent instructions (`description`) are prepended to the task prompt so each agent behaves according to its configured role.
- `COPILOT_TIMEOUT_MINUTES`, `GEMINI_TIMEOUT_MINUTES`.

**Codex SDK** (`codex`)
- Wraps `@openai/codex-sdk`, which drives `codex app-server` internally over stdio JSON-RPC.
- Per-agent `CODEX_HOME` provisioning keeps each agent's configuration isolated.
- `CODEX_TIMEOUT_MINUTES`.

#### Shared provider utilities

A new `providerFileUtils.ts` module centralises the filesystem bookkeeping that was previously duplicated across providers:

- `writeTaskOutputs` — writes the final output markdown and agent log, stripping `<TASK_COMPLETED/FAILED/BLOCKED>` tags from persisted files.
- `detectStatusTag` — detects completion / blocked / failed status from agent output text.
- `writeOutputFile` / `writeAgentLog` — low-level writers shared by all providers.

#### Agent lifecycle & synchronisation

- `sync_claude_sdk_agents`, `sync_copilot_agents`, `sync_gemini_agents`, `sync_codex_agents`, `sync_cursor_agents` WebSocket commands register provider agents from the SaaS without requiring the Bridge to auto-discover them (prevents phantom UNREGISTERED cards before any agent is configured).
- `delete_agent_folders` command removes agent filesystem folders recursively.
- Purged/deleted agent IDs are tracked in memory to prevent re-discovery from SDK `list()` calls within the same session.

#### Environment & configuration

- `.env` loading from `cwd` at startup covers all new env vars (API keys, timeout overrides).
- `AGENTS_CTRLNODE_ROOT` is now the canonical workspace root used consistently across all providers for task folder resolution and filesystem operations.
- `resolveProjectHome(agentId)` derives the agent's project home within the root.
- Startup validation warns early when a required API key is missing for a configured provider.

#### Filesystem handlers

- `resolveFilesystemBase` / `resolveFilesystemBaseByProvider` on every provider enable correct path resolution for `read_file`, `write_file`, `list_files`, `delete_path` SaaS commands regardless of which provider owns the agent.
- `trustedFolders.json` is updated automatically when Gemini trust is enabled for a workspace.

---

### Breaking changes / migration

| What changed | Action required |
|---|---|
| `PROVIDER` (singular) now becomes `PROVIDERS[0]` | No action — existing `.env` files continue to work |
| Default providers when `PROVIDERS`/`PROVIDER` is unset now includes all backends | If you only want OpenClaw, set `PROVIDERS=openclaw` explicitly |
| `openclaw.json` remains the source of truth for OpenClaw agents | No change |

---

### Install

**Linux / macOS** — one-liner, detects platform and CPU automatically:

```bash
curl -fsSL https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.2.0/install.sh | sh
```

**Windows (PowerShell)**:

```powershell
irm https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.2.0/install.ps1 | iex
```

### Manual download

| Platform | File |
|---|---|
| Linux (modern CPUs, AVX2) | `ctrlnode-bridge-linux-x64` |
| Linux (older CPUs, AVX only) | `ctrlnode-bridge-linux-x64-baseline` |
| macOS (Apple Silicon) | `ctrlnode-bridge-darwin-arm64` |
| Windows | `ctrlnode-bridge.exe` |

> Not sure which Linux binary? `grep -q avx2 /proc/cpuinfo && echo standard || echo baseline`

### Quick start (multi-provider example)

```env
# .env
PAIRING_TOKEN=your_pairing_token

# Run OpenClaw + Claude SDK + Cursor simultaneously
PROVIDERS=openclaw,claude-sdk,cursor

OPENCLAW_GATEWAY_TOKEN=your_openclaw_token
ANTHROPIC_API_KEY=your_anthropic_key
CURSOR_API_KEY=your_cursor_key
```

```bash
./ctrlnode-bridge-linux-x64
```

See the [README](https://github.com/ctrlnode-ai/ctrlnode#readme) and [setup guides](https://github.com/ctrlnode-ai/ctrlnode/tree/main/doc/setup) for full instructions.
