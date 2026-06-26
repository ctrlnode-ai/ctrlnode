## CtrlNode Bridge v2026.2.5 Release Notes

This release adds task cancellation, user input delivery, and persistent session resume for follow-ups across all providers.

---

### What's new

#### Task cancellation

Tasks can now be cancelled mid-run from the CtrlNode UI. Bridge receives a `cancel_task` command and signals the active provider to stop immediately:

- **Claude Code / Hermes CLI** — sends `SIGTERM` to the child process, then `SIGKILL` after 3 seconds if still running
- **Claude Agent SDK** — aborts via `AbortController`
- **Codex SDK** — sets a cancel flag that breaks the event stream loop cleanly
- **Copilot / Gemini / Hermes ACP** — sends `SIGTERM` to the ACP subprocess

#### User input delivery

When an ACP agent (Copilot, Gemini, Hermes ACP) encounters a permission prompt it cannot auto-approve, it now notifies the UI with a `task_waiting_for_input` event instead of silently cancelling. The UI can respond with an `input_response` message that Bridge forwards to the running process. Claude Code supports writing directly to `stdin`; ACP providers log a warning for now (full interactive support coming in a future release).

#### Persistent session resume for follow-ups (Claude Agent SDK)

Follow-up intents dispatched to Claude Agent SDK agents now resume the original conversation session instead of starting a new one:

- The session ID is saved to disk (`tasks/<taskId>/session_id`) when a task completes so it survives Bridge restarts
- On follow-up, Bridge reads the session ID from memory or disk and passes it to the SDK for full conversation history resumption
- A fresh dispatch (e.g. RERUN) always clears the cached session so it never accidentally resumes a stale one

#### Follow-up file preparation (all providers)

Follow-up messages now consistently write a numbered input file (`<shortId>-followup-N.md`) to the task's `input/` folder before dispatching to any provider. The agent prompt is automatically augmented with:

- An instruction pointing to the follow-up output file the agent should write (`<shortId>-followup-N-output.md`)
- For stateless providers (Codex, Hermes CLI/ACP, Gemini, Copilot): the prior `agent_log.md` is prepended as context so the agent knows what was done in the original run

Providers with native session history (Claude Code, Claude Agent SDK) receive only the output-file instruction since the conversation history is already available in the session.

#### Follow-up emits `task_complete`

Follow-up runs now emit a `task_complete` event when they finish, causing the backend to properly transition the task status back to `done` or `failed` after the follow-up completes.

---

### Upgrade

Replace the binary and restart. No configuration changes are required.
