## CtrlNode Bridge v2026.3.0

This release improves reliability, progress reporting, workspace files, and startup logs.

### Codex

- Finds Codex automatically in common installations.
- Keeps Codex settings and login available for each agent.
- Supports single-agent and multi-agent workflow plans.

### Provider health

- Shows clearer provider status and failure reasons.
- Authentication failures are reported immediately.
- Successful health checks are hidden from normal logs and shown with `DEBUG=true`.

### Task progress

- Shows task progress, tool activity, file changes, and graph-generation progress in CtrlNode.
- Saves progress to the task log.

### Workspace files

- Create, rename, and delete empty folders from the workspace browser.
- Unsafe paths and non-empty folder deletion are blocked.

### Timeouts and login

- Longer default timeouts for complex tasks and workflow generation.
- Setup can open browser sign-in when no pairing token is provided.

### Logs

- Human-readable logs are now the default.
- Use `LOG_FORMAT=json` for structured logs.
- Use `DEBUG=true` for diagnostic details.

### Upgrade

Replace the Bridge binary and restart it. Existing configuration can be reused.
