# CtrlNode Bridge

[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1-orange?logo=bun)](https://bun.sh/)

The Bridge is a lightweight TypeScript/Bun process that connects a local [OpenClaw](https://github.com/openclaw/openclaw) runtime to CtrlNode SaaS over a persistent WebSocket.

It is the only component you run on your own infrastructure.

---

## How it works

1. **Startup** — reads `openclaw.json` to discover agents and workspace paths, sends a `handshake` to the SaaS.
2. **Watching** — runs a per-agent filesystem watcher (chokidar); file changes and task outputs stream to the SaaS in real time.
3. **Commands** — the SaaS sends actions (write task, read file, dispatch to agent, invoke tool); the bridge executes them locally and replies.
4. **Heartbeat** — sent every 30 s so the SaaS knows the bridge is alive.
5. **Session polling** — monitors OpenClaw session logs to detect task completion tags and signals the SaaS.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PAIRING_TOKEN` | **Yes** | — | Auth token from the CtrlNode control panel (Settings → Bridge). |
| `OPENCLAW_GATEWAY_TOKEN` | **Yes** | — | Bearer token for the local OpenClaw gateway (`gateway.auth.token` in `openclaw.json`). |
| `SAAS_URL` | No | `wss://api.ctrlnode.ai/ws/bridge` | WebSocket URL of your CtrlNode tenant. |
| `OPENCLAW_CONFIG` | No | `~/.openclaw/openclaw.json` | Full path to `openclaw.json`. |
| `OPENCLAW_BASE_PATH` | No | — | Directory containing `openclaw.json` (used when `OPENCLAW_CONFIG` is not set). |
| `OPENCLAW_GATEWAY_URL` | No | `http://localhost:18789` | URL of the local OpenClaw gateway. |
| `HEARTBEAT_MS` | No | `30000` | Heartbeat interval (ms). |
| `RECONNECT_MS` | No | `5000` | Reconnect delay after a dropped connection (ms). |
| `POLL_CONFIG_MS` | No | `60000` | How often the bridge re-reads agent config (ms). |
| `WATCHER_USE_POLLING` | No | `false` | Enable polling mode for Docker volumes without inotify support. |
| `WATCHER_POLL_INTERVAL` | No | `100` | Polling interval in ms (when polling mode is on). |

---

## Development

Requires [Bun](https://bun.sh/) ≥ 1.1.

```bash
# From the repo root
bun install
bun dev
```

### Building binaries

#### Check CPU capabilities first (Linux)

```bash
grep flags /proc/cpuinfo | head -1 | grep -o "avx[^ ]*"
```

- Includes `avx2` → use `build:linux`
- Only `avx` or nothing → use `build:linux-baseline` (safe for older/cloud CPUs)

#### Build commands

```bash
bun run build:linux            # → dist/ctrlnode-bridge-linux-x64
bun run build:linux-baseline   # → dist/ctrlnode-bridge-linux-x64-baseline
bun run build:mac              # → dist/ctrlnode-bridge-darwin-arm64
bun run build:win              # → dist/ctrlnode-bridge.exe
bun run build:all              # builds all platforms
```

---

## Source structure

| File | Responsibility |
|---|---|
| `index.ts` | Entry point — boots config, discovers agents, opens WebSocket |
| `config.ts` | Env vars, derived paths, runtime constants |
| `configResolution.ts` | Locates `openclaw.json` using env vars → home dir fallback |
| `types.ts` | Shared TypeScript interfaces |
| `agentDiscovery.ts` | Reads `openclaw.json`, syncs agent state |
| `agentRouting.ts` | Resolves target agent ID with fallback to first agent |
| `websocket.ts` | WebSocket lifecycle: handshake, heartbeat, reconnect, egress queue |
| `watcher.ts` | Per-agent chokidar watchers, file-event classification |
| `messageHandlers.ts` | Routes incoming SaaS messages to the right handler by action type |
| `filesystemConfigHandlers.ts` | Handles file read/write/list/create/delete actions |
| `intentHandlers.ts` | Forwards task dispatch and tool calls to OpenClaw gateway |
| `intentDispatchPolicy.ts` | Maps intent types to OpenClaw provider methods |
| `sessionHistoryPoller.ts` | Polls session JSONL files, detects completion tags, signals SaaS |
| `fileSystem.ts` | File I/O utilities: read, write, walk, MIME detection, path sanitization |
| `handlerContext.ts` | Shared context object (`sendToSaas`, `syncAgents`) passed to handlers |
| `logger.ts` | Structured JSON-line logger (info / warn / error) |
