# MC-Bridge Setup Guide (Native)

> Assumes OpenClaw is already installed and running on the system.

---

## 1. Check Gateway Accepts Tools

```bash
cat ~/.openclaw/openclaw.json | grep -A10 '"gateway"'
```

The config must have:
```json
"gateway": {
  "bind": "lan",
  "tools": {
    "allow": ["sessions_spawn", "sessions_send", "sessions_list"]
  }
}
```



---

## 2. Compile MC-Bridge

### Check CPU capabilities

```bash
grep flags /proc/cpuinfo | head -1 | grep -o "avx[^ ]*"
```

If output includes `avx2`, use `bun-linux-x64`. Otherwise, use `bun-linux-x64-baseline`.

Requires Bun:
```bash
cd src/CtrlNode.Bridge
bun build ./src/index.ts --compile --target=bun-linux-x64-baseline --outfile=mc-bridge
```

> Use `bun-linux-x64-baseline` for AVX-only CPUs. Use `bun-linux-x64` only if AVX2 is available.

---

## 3. Install MC-Bridge

```bash
sudo mv mc-bridge /usr/local/bin/mc-bridge
sudo chmod +x /usr/local/bin/mc-bridge
```

---

## 4. Create Start Script

```bash
cat > ~/.openclaw/start-bridge.sh << 'EOF'
#!/bin/bash
PAIRING_TOKEN=<your_pairing_token> \
SAAS_URL=wss://api-sta.ctrlnode.ai/ws/bridge \
OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
mc-bridge > ~/.openclaw/mc-bridge.log 2>&1
EOF
chmod +x ~/.openclaw/start-bridge.sh
```

Replace:
- `<your_pairing_token>` — from the SaaS control panel
- `<your_gateway_token>` — from `~/.openclaw/openclaw.json` → `gateway.auth.token`

---

## 5. Run the Bridge

```bash
~/.openclaw/start-bridge.sh &
```

Check logs:
```bash
tail -f ~/.openclaw/mc-bridge.log
```

Expected output:
```
{"msg":"startup","banner":"Mission Control — Agent Bridge v1.0"}
{"msg":"connected"}
{"msg":"handshake_sent","agentCount":1}
```

---

## Reference

| Item | Value |
|------|-------|
| OpenClaw config | `~/.openclaw/openclaw.json` |
| Gateway port | `18789` |
| MC-Bridge binary | `/usr/local/bin/mc-bridge` |
| Bridge start script | `~/.openclaw/start-bridge.sh` |
| Bridge logs | `~/.openclaw/mc-bridge.log` |
| Gateway logs | `~/.openclaw/gateway.log` |
