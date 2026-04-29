# Bridge Setup — Docker (bridge inside the container)

> Run all commands **inside** the container where OpenClaw is already running.
> The bridge connects to OpenClaw on `localhost` since both processes share the same network namespace.

---

## Prerequisites

- OpenClaw container already running with gateway configured
- A **Pairing Token** — generate one from the CtrlNode web panel (Settings → Bridge Tokens)
- Your **Gateway Token** — found in `/root/.openclaw/openclaw.json` → `gateway.auth.token`

---

## 1. Verify Gateway Config

```bash
grep -A10 '"gateway"' /root/.openclaw/openclaw.json
```

Must include:

```json
"gateway": {
  "bind": "lan",
  "tools": {
    "allow": ["sessions_spawn", "sessions_send", "sessions_list"]
  }
}
```

---

## 2. Download the Bridge Binary

Check your CPU first:

```bash
grep flags /proc/cpuinfo | head -1 | grep -o "avx[^ ]*"
```

- Output includes `avx2` → use `ctrlnode-bridge-linux-x64`
- Output shows only `avx` → use `ctrlnode-bridge-linux-x64-baseline`
- No output → use `ctrlnode-bridge-linux-x64-baseline`

**From your local machine**, copy the binary into the container:

```bash
# Replace vX.X.X with the latest release tag
curl -L https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/ctrlnode-bridge-linux-x64 \
  -o /usr/local/bin/ctrlnode-bridge

chmod +x /usr/local/bin/ctrlnode-bridge
```

Or copy from host:

```bash
docker cp ctrlnode-bridge-linux-x64 openclaw-container:/usr/local/bin/ctrlnode-bridge
docker exec openclaw-container chmod +x /usr/local/bin/ctrlnode-bridge
```

---

## 3. Run the Bridge (one-off test)

```bash
PAIRING_TOKEN=<your_pairing_token> \
OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
OPENCLAW_GATEWAY_URL=http://localhost:18789 \
ctrlnode-bridge
```

Expected output:

```
{"msg":"startup","banner":"CtrlNode Bridge v2.0"}
{"msg":"connected"}
{"msg":"handshake_sent","agentCount":1}
```

---

## 4. Run in Background

### Option A — nohup (simplest)

```bash
nohup env \
  PAIRING_TOKEN=<your_pairing_token> \
  OPENCLAW_GATEWAY_TOKEN=<your_gateway_token> \
  OPENCLAW_GATEWAY_URL=http://localhost:18789 \
  ctrlnode-bridge \
  > /tmp/ctrlnode-bridge.log 2>&1 &

echo "Bridge PID: $!"
```

Check logs:

```bash
tail -f /tmp/ctrlnode-bridge.log
```

Stop it:

```bash
kill $(pgrep -f ctrlnode-bridge)
```

### Option B — supervisor (auto-restart on crash)

Install supervisor inside the container:

```bash
apt-get install -y supervisor   # Debian/Ubuntu
# or
apk add supervisor              # Alpine
```

Create config:

```bash
cat > /etc/supervisor/conf.d/ctrlnode-bridge.conf << 'EOF'
[program:ctrlnode-bridge]
command=/usr/local/bin/ctrlnode-bridge
environment=PAIRING_TOKEN="<your_pairing_token>",OPENCLAW_GATEWAY_TOKEN="<your_gateway_token>",OPENCLAW_GATEWAY_URL="http://localhost:18789"
autostart=true
autorestart=true
stdout_logfile=/tmp/ctrlnode-bridge.log
stderr_logfile=/tmp/ctrlnode-bridge.log
EOF
```

Start:

```bash
supervisord -c /etc/supervisor/supervisord.conf
supervisorctl start ctrlnode-bridge
```

### Option C — dedicated bridge container (recommended for production)

Run the bridge as its own container alongside the OpenClaw container, sharing the network:

```yaml
# docker-compose.yml excerpt
services:
  openclaw:
    image: your-openclaw-image
    networks:
      - ai-net

  ctrlnode-bridge:
    image: oven/bun:alpine
    command: ["/usr/local/bin/ctrlnode-bridge"]
    volumes:
      - ./ctrlnode-bridge-linux-x64:/usr/local/bin/ctrlnode-bridge:ro
    environment:
      PAIRING_TOKEN: "${PAIRING_TOKEN}"
      OPENCLAW_GATEWAY_TOKEN: "${OPENCLAW_GATEWAY_TOKEN}"
      OPENCLAW_GATEWAY_URL: "http://openclaw:18789"
    restart: unless-stopped
    networks:
      - ai-net

networks:
  ai-net:
```

---

## Reference

| Item | Value |
|------|-------|
| Binary | `/usr/local/bin/ctrlnode-bridge` |
| Gateway URL | `http://localhost:18789` |
| Gateway config | `/root/.openclaw/openclaw.json` |
| Bridge logs (nohup) | `/tmp/ctrlnode-bridge.log` |
