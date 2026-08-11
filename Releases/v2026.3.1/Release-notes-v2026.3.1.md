## CtrlNode Bridge v2026.3.1

This release packages the pending `feature/git-support` work together with the current local Bridge changes since v2026.3.0.

### Git workspace support

- Read repository status from a workspace, including branch, upstream, ahead/behind counts, file states, and line-change summaries.
- Inspect worktree and staged diffs, including untracked files.
- Support guarded `init`, `commit`, `fetch`, `pull`, `push`, `checkout`, and `create_branch` operations.
- Keep repository paths constrained to the configured Bridge workspace and surface Git errors without treating them as a clean repository.

### Provider capabilities

- Discover provider-specific skills and capability catalogues for the task instructions workflow.
- Route discovery to the provider that owns the selected agent.
- Use provider adapters, caching, and an empty fallback catalogue when discovery is unavailable.
- Run discovery read-only in the task working directory without exposing secrets or executing skill content.

### Workspace and startup

- Store the canonical Bridge configuration in `~/.ctrlnode/.env` while retaining compatibility with legacy locations.
- Migrate an existing workspace `.ctrlnode/.env` when the canonical config does not exist.
- Confirm workspace trust when starting from a directory different from the saved workspace.
- Show a terminal welcome panel with workspace, config, provider, and version information.
- Improve interactive terminal selection and keep non-interactive startup usable for services and scripts.

### Reliability and providers

- Increase default task inactivity, graph-generation, and provider turn budgets for longer-running work.
- Discover Codex installations in common npm, local-bin, and VS Code locations when `codex` is not on `PATH`.
- Reuse the shared Codex home for authentication and model discovery while preserving per-agent homes.
- Add provider health and capability discovery hooks without making unsupported providers fail task startup.

### Logging and installation

- Human-readable logs are the default, with `LOG_FORMAT=json` available for structured log consumers.
- Use `DEBUG=true` for diagnostic events and redact token, secret, password, credential, authorization, and API-key values from log output.
- Keep the installer workspace-neutral: setup persists `BASE_PATH` in the Bridge config instead of modifying the user shell environment.
- Installers continue to fetch the latest GitHub release, support custom install directories, handle platform-specific binaries, and optionally start the Bridge.

### Upgrade

Replace the Bridge binary with v2026.3.1 and restart it. Existing configuration can be reused; the first startup from a different directory may ask you to trust or select the workspace.
