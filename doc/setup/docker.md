# MC-Bridge Setup Guide

> Run all commands directly inside the container (e.g. via `docker exec -it openclaw-sandbox bash`).

---

## 1. Check Gateway Accepts Tools

```bash
grep -A10 '"gateway"' /root/.openclaw/openclaw.json
```

The config must have:
```json
"gateway": {
  "bind": "lan",
  "tools": {
    "allow": ["sessions_spawn"]
  }
}
```

---

## 2. Install MC-Bridge

### Check CPU capabilities

```bash
grep flags /proc/cpuinfo | head -1 | grep -o "avx[^ ]*"
```

If output includes `avx2`, use `bun-linux-x64`. Otherwise, use `bun-linux-x64-baseline`.

Compile locally (requires Bun):
```bash
cd src/bridge
bun build ./src/index.ts --compile --target=bun-linux-x64-baseline --outfile=mc-bridge-linux-x64
```

> Use `bun-linux-x64-baseline` for AVX-only CPUs (e.g. Intel Xeon E5-1620 v2). Use `bun-linux-x64` only if AVX2 is available.

Copy the binary into the container (from your local machine):
```bash
docker cp mc-bridge-linux-x64 openclaw-sandbox:/usr/local/bin/mc-bridge
```

Then inside the container, make it executable:
```bash
chmod +x /usr/local/bin/mc-bridge
```

---

## 3. Create Start Script

```bash
cat > /tmp/start-bridge.sh << 'EOF'
#!/bin/sh
PAIRING_TOKEN=<your_pairing_token> \
OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
mc-bridge > /tmp/mc-bridge.log 2>&1
EOF
chmod +x /tmp/start-bridge.sh
```

Replace:
- `<your_pairing_token>` — from the SaaS control panel
- `<your_gateway_token>` — from `/root/.openclaw/openclaw.json` → `gateway.auth.token`

---

## 4. Run the Bridge

```bash
/tmp/start-bridge.sh &
```

Check logs:
```bash
cat /tmp/mc-bridge.log
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
| Gateway port | `18789` |
| Gateway config | `/root/.openclaw/openclaw.json` |
| MC-Bridge binary | `/usr/local/bin/mc-bridge` |
| Bridge start script | `/tmp/start-bridge.sh` |
| Bridge logs | `/tmp/mc-bridge.log` |
| Gateway logs | `/tmp/openclaw.log` |
