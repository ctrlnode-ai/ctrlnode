## CtrlNode Bridge v2026.2.4 Release Notes

This release adds live model updates from the server and fixes premature task completion.

---

### What's new

#### Model list updated from the server — no Bridge reinstall needed

Model lists are now fetched from the CtrlNode backend on startup and refreshed after every connection. New models — including **Claude Fable 5** and **Claude Mythos 5** — become available automatically without installing a new Bridge version.

When the server is unreachable the previous cached list is used; if no cache exists, the built-in fallback list applies.

#### Fix: task marked done too early

Agents that write several output files in sequence could trigger a premature `task_complete` signal when the first file landed. Bridge now waits 45 seconds after the last file write before declaring the task done, giving the agent time to finish all its output. An explicit `<TASK_COMPLETED:…>` or `<TASK_FAILED:…>` tag cancels the wait immediately.

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
