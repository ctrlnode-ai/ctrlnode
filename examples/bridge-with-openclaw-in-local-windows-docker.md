# Bridge with OpenClaw in local Windows Docker

## Context

Testing the Bridge binary from GitHub Releases against the local dev API (`localhost:8080`) using the OpenClaw Docker container's gateway token.

---

## Commands executed

### Check OpenClaw Docker container env vars
```powershell
docker exec ctrlnode-openclaw-1 env
```

### Read openclaw.json to get gateway token
```powershell
docker exec ctrlnode-openclaw-1 cat /app/openclaw.json
```
→ `gateway.auth.token = 1bf846e83ca23e97e9a7b5edba22ff946c01a3b80587e2547248834ac815036d`

### Check exposed ports
```powershell
docker port ctrlnode-openclaw-1
```
→ `18789/tcp -> 0.0.0.0:18789`

### Get latest release assets from GitHub API
```powershell
$r = Invoke-RestMethod "https://api.github.com/repos/ctrlnode-ai/ctrlnode/releases/latest"
$r.tag_name
$r.assets | ForEach-Object { "$($_.name) -> $($_.browser_download_url)" }
```
→ `v2026.1.1` — binaries: `ctrlnode-bridge-linux-x64`, `ctrlnode-bridge-linux-x64-baseline`, `ctrlnode-bridge-darwin-arm64`, `ctrlnode-bridge.exe`

### Download bridge binary
```powershell
Invoke-WebRequest "https://github.com/ctrlnode-ai/ctrlnode/releases/download/v2026.1.1/ctrlnode-bridge.exe" `
  -OutFile "C:\CODE\2026\CtrlNode\temp\ctrlnode-bridge.exe" -UseBasicParsing
```
→ 115,629,568 bytes

### Generate pairing token
Via UI at `http://localhost:5173/system/bridge-tokens` → name `local-dev`  
→ `14056d58f5feb49af4d0e7663c9a5470474e706df86e1d41733ca33ca5aaafc8`

### Launch the bridge
```powershell
$env:PAIRING_TOKEN = "14056d58f5feb49af4d0e7663c9a5470474e706df86e1d41733ca33ca5aaafc8"
$env:OPENCLAW_GATEWAY_URL = "http://localhost:18789"
$env:OPENCLAW_GATEWAY_TOKEN = "1bf846e83ca23e97e9a7b5edba22ff946c01a3b80587e2547248834ac815036d"
$env:SAAS_URL = "ws://localhost:8080/ws/bridge"
C:\CODE\2026\CtrlNode\temp\ctrlnode-bridge.exe
```

### Result
```
{"msg":"connected"}
{"msg":"handshake_sent","agentCount":1}
```

UI showed: **BRIDGE ONLINE · Connected to server. Active agents: 1**

---

## Notes

- `OPENCLAW_GATEWAY_URL` defaults to `http://localhost:18789` — no need to set it explicitly when running locally
- The bridge asked for OpenClaw directory on first run → pressed Enter to use default (`C:\Users\VIL\.openclaw`)
- The local `openclaw.json` had a `firstbot` agent with a missing workspace dir → warning `workspace_missing` (non-fatal)
- Token `local-dev` is now active in the DB
