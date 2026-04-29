# Bridge Setup — Linux (native, no Docker)

> Assumes OpenClaw is already installed and running directly on the server.
> The bridge connects to OpenClaw's gateway on `localhost:18789`.

---

## Prerequisites

- OpenClaw already running (verify with `curl http://localhost:18789/health`)
- A **Pairing Token** — generate one from the CtrlNode web panel (Settings → Bridge Tokens)
- Your **Gateway Token** — found in `~/.openclaw/openclaw.json` → `gateway.auth.token`

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

Check your CPU:

```bash
grep flags /proc/cpuinfo | head -1 | grep -o "avx[^ ]*"
```

- Includes `avx2` → use `ctrlnode-bridge-linux-x64`
- Only `avx` → use `ctrlnode-bridge-linux-x64-baseline`

```bash
# Replace the filename if you need the baseline version
curl -L https://github.com/ctrlnode-ai/ctrlnode/releases/latest/download/ctrlnode-bridge-linux-x64 \
  -o /usr/local/bin/ctrlnode-bridge

chmod +x /usr/local/bin/ctrlnode-bridge
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

### Option B — systemd service (recommended — auto-start on reboot)

Create the service file:

```bash
sudo tee /etc/systemd/system/ctrlnode-bridge.service > /dev/null << EOF
[Unit]
Description=CtrlNode Bridge
After=network.target

[Service]
Type=simple
User=$USER
Environment=PAIRING_TOKEN=<your_pairing_token>
Environment=OPENCLAW_GATEWAY_TOKEN=<your_gateway_token>
ExecStart=/usr/local/bin/ctrlnode-bridge
Restart=always
RestartSec=5
StandardOutput=append:/var/log/ctrlnode-bridge.log
StandardError=append:/var/log/ctrlnode-bridge.log

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ctrlnode-bridge
sudo systemctl start ctrlnode-bridge
```

Check status:

```bash
sudo systemctl status ctrlnode-bridge
sudo journalctl -u ctrlnode-bridge -f
```

Stop / restart:

```bash
sudo systemctl stop ctrlnode-bridge
sudo systemctl restart ctrlnode-bridge
```

---

## Reference

| Item | Value |
|------|-------|
| Binary | `/usr/local/bin/ctrlnode-bridge` |
| Gateway URL | `http://localhost:18789` (default) |
| OpenClaw config | `~/.openclaw/openclaw.json` |
| Bridge logs (nohup) | `~/.openclaw/bridge.log` |
| Bridge logs (systemd) | `/var/log/ctrlnode-bridge.log` |
| Systemd unit | `/etc/systemd/system/ctrlnode-bridge.service` |
