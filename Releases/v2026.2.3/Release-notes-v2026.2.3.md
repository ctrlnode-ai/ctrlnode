## CtrlNode Bridge v2026.2.3 Release Notes

This release improves error handling in the Hermes provider, adds automatic Codex binary discovery, and adds support for the new Claude Opus 4.8 model.

---

### What's new

#### Claude Opus 4.8 support

`claude-opus-4-8` is now included in the known-models fallback lists for Anthropic, Copilot, and Cursor providers. When no API key is configured the model is available immediately; with an API key it is returned directly from the live API.

#### Hermes ACP — blockable error detection

The Hermes ACP provider can now distinguish between **configuration errors** (invalid model, missing or invalid API key) and fatal execution errors. When a configuration error is detected in the agent output or stderr, the task is marked as `blocked` instead of `failed`, which allows the orchestrator to surface a clear remediation message rather than treating it as an unrecoverable failure.

Detected patterns include: invalid model ID, invalid or missing API key, and similar provider-side configuration problems.

#### Hermes ACP — stderr capture

The Hermes ACP process now captures `stderr` in addition to `stdout`. The captured stderr is included in blockable-error detection, so configuration errors printed to stderr are correctly classified.

#### Codex — automatic binary resolution

The Codex SDK provider now resolves the `codex` binary from the system `PATH` automatically when `CODEX_BIN_PATH` is not set. On Windows it prefers the `.exe` over a `.cmd` wrapper to ensure direct spawning works correctly.

#### Installer simplified

The install scripts (`install.ps1` / `install.sh`) no longer ask for the binary install directory (it defaults silently to `%LOCALAPPDATA%\Programs\ctrlnode` on Windows and `/usr/local/bin` on Linux/macOS). API key configuration has been removed from the installer entirely — run `ctrlnode --setup` after installation to configure the pairing token and any provider API keys.

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

Replace the binary and restart. No configuration changes are required. Run `ctrlnode --setup` if you want to update your workspace, pairing token, or provider API keys.
