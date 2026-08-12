## CtrlNode Bridge v2026.3.1

This release contains the changes that differ between `main` (`v2026.3.0`) and `feature/git-support`.

### Git workspace support

- Read repository status from a workspace, including branch, upstream, ahead/behind counts, file states, and line-change summaries.
- Inspect worktree and staged diffs, including untracked files.
- Support guarded `init`, `commit`, `fetch`, `pull`, `push`, `checkout`, and `create_branch` operations.
- Keep repository paths constrained to the configured Bridge workspace and surface Git errors without treating them as a clean repository.

### Provider capabilities

- Discover provider-specific skills and capability catalogues for the task instructions workflow.

### Workspace, configuration and installation

- Confirm workspace trust when starting from a directory different from the saved workspace.
- Show a terminal welcome panel with workspace, config, provider, and version information, with keyboard navigation for the trust prompt.
- Keep non-interactive startup usable for services and scripts.
- Stop installers from persisting `BASE_PATH` in the user environment; setup now saves the selected workspace in the Bridge configuration.
