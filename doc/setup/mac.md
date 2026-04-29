# Bridge Setup — macOS (native, no Docker)

> Assumes OpenClaw is already installed and running on your Mac.
> The bridge connects to OpenClaw's gateway on `localhost:18789`.

---

## Prerequisites

- OpenClaw already running (verify with `curl http://localhost:18789/health`)
- A **Pairing Token** — generate one from the CtrlNode web panel (Settings → Bridge Tokens)
- Your **Gateway Token** — found in `~/.openclaw/openclaw.json` → `gateway.auth.token`
- Apple Silicon Mac (M1/M2/M3/M4) — the binary is `darwin-arm64`

> **Intel Mac?** Download the Linux x64 binary and run it under Rosetta, or build from source with `bun build ./src/index.ts --compile --target=bun-darwin-x64`.

---

## 1. Verify Gateway Config

```bash
cat ~/.openclaw/openclaw.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('gateway',{}), indent=2))"
```

Must include:

```json
{
  "bind": "lan",
  "tools": {
    "allow": ["sessions_spawn", "sessions_send", "sessions_list"]
  }
}
```

---

## 2. Download the Bridge Binary

```bash
curl -L https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/ctrlnode-bridge-darwin-arm64 \
  -o /usr/local/bin/ctrlnode-bridge

chmod +x /usr/local/bin/ctrlnode-bridge
```

macOS may block the binary on first run. Remove the quarantine attribute:

```bash
xattr -d com.apple.quarantine /usr/local/bin/ctrlnode-bridge
```

---

## 3. Run the Bridge (one-off test)

```bash
PAIRING_TOKEN=<your_pairing_token> \
OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
ctrlnode-bridge
```

Expected output:

```
{"msg":"startup","banner":"CtrlNode Bridge v2.0"}
{"msg":"connected"}
{"msg":"handshake_sent","agentCount":1}
```

Press `Ctrl+C` to stop.

---

## 4. Run in Background

### Option A — nohup (simplest)

```bash
nohup env \
  PAIRING_TOKEN=<your_pairing_token> \
  OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
  ctrlnode-bridge \
  > ~/.openclaw/bridge.log 2>&1 &

echo "Bridge PID: $!"
```

Check logs:

```bash
tail -f ~/.openclaw/bridge.log
```

Stop it:

```bash
kill $(pgrep -f ctrlnode-bridge)
```

### Option B — launchd (recommended — auto-start on login/reboot)

Create the plist file:

```bash
mkdir -p ~/Library/LaunchAgents

cat > ~/Library/LaunchAgents/ai.ctrlnode.bridge.plist << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.ctrlnode.bridge</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ctrlnode-bridge</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PAIRING_TOKEN</key>
    <string><your_pairing_token></string>
    <key>OPENCLAW_GATEWAY_TOKEN</key>
    <string><your_gateway_token></string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/Users/$USER/.openclaw/bridge.log</string>

  <key>StandardErrorPath</key>
  <string>/Users/$USER/.openclaw/bridge.log</string>
</dict>
</plist>
EOF
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/ai.ctrlnode.bridge.plist
launchctl start ai.ctrlnode.bridge
```

Check status:

```bash
launchctl list | grep ctrlnode
```

Check logs:

```bash
tail -f ~/.openclaw/bridge.log
```

Stop / unload:

```bash
launchctl stop ai.ctrlnode.bridge
launchctl unload ~/Library/LaunchAgents/ai.ctrlnode.bridge.plist
```

---

## Reference

| Item | Value |
|------|-------|
| Binary | `/usr/local/bin/ctrlnode-bridge` |
| Gateway URL | `http://localhost:18789` (default) |
| OpenClaw config | `~/.openclaw/openclaw.json` |
| Bridge logs | `~/.openclaw/bridge.log` |
| launchd plist | `~/Library/LaunchAgents/ai.ctrlnode.bridge.plist` |
