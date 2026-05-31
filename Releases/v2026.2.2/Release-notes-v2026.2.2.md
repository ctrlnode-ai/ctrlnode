## CtrlNode Bridge v2026.2.2 Release Notes

This release adds **Hermes provider support**, renames the binary to `ctrlnode`, and introduces an interactive setup wizard so first-run configuration requires no manual file editing.

---

### What's new

#### Hermes provider

The Bridge now supports **Hermes** as a native provider via the ACP protocol (`hermes acp`). Each Hermes agent gets its own isolated profile directory so credentials and conversation history never mix across agents.

#### Binary renamed to `ctrlnode`

The binary was previously named `ctrlnode-bridge[.exe]`. It is now simply `ctrlnode[.exe]`. The install scripts install it under the new name and add it to `PATH`.

#### Setup wizard (`ctrlnode --setup`)

Run `ctrlnode --setup` to configure the Bridge interactively:

- Choose your **workspace** — the root folder the Bridge can read and write. For developers, this is typically your code root.
- Enter your **pairing token** (Settings → Bridge at app.ctrlnode.ai).
- The token is saved to `<workspace>/.ctrlnode/.env` and `BASE_PATH` is persisted as a user environment variable automatically.

On subsequent runs the Bridge reads the saved config with no prompts. If the token is missing it asks inline before connecting.

#### Config file shown at startup

The Bridge now prints which `.env` file it loaded at startup, and reminds you of the `--setup` command if you need to reconfigure.

---

### Binaries

| File | Target |
|---|---|
| `ctrlnode.exe` | Windows x64 |
| `ctrlnode-linux-x64` | Linux x64 (requires AVX2) |
| `ctrlnode-linux-x64-baseline` | Linux x64 (no AVX2 — older CPUs / cloud VMs) |
| `ctrlnode-darwin-arm64` | macOS Apple Silicon |

---

### Upgrade

Replace the binary with the new `ctrlnode` binary and restart. If you have `ctrlnode-bridge` in your PATH, remove or rename the old binary. Run `ctrlnode --setup` if you want to move your workspace or update your pairing token.
