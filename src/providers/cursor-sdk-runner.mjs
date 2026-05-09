/**
 * cursor-sdk-runner.mjs
 *
 * Runs under Node.js (NOT Bun) because @cursor/sdk uses @connectrpc/connect-node
 * which requires Node.js's native http2 module. Bun's http2 is not fully compatible
 * and causes NGHTTP2_FRAME_SIZE_ERROR.
 *
 * Protocol (stdin → one JSON line, stdout → JSONL events):
 *
 * Commands:
 *   { command: "discover", cwd, apiKey }
 *     → { type: "discover_result", agents: [{ id, name, status?, lastModified }] }
 *
 *   { command: "run", taskId, agentId?, agentName?, prompt, cwd, model?, apiKey, timeoutMs? }
 *     → { type: "task_started",   taskId, cursorAgentId }
 *     → { type: "agent_resumed",  taskId, cursorAgentId }      (if resume succeeded)
 *     → { type: "agent_created",  taskId, cursorAgentId }      (if new agent)
 *     → { type: "text_delta",     taskId, text }
 *     → { type: "thinking_delta", taskId, text }
 *     → { type: "tool_started",   taskId, name, callId }
 *     → { type: "tool_completed", taskId, name, callId }
 *     → { type: "file_written",   taskId, path }
 *     → { type: "run_status",     taskId, status }             (status changes)
 *     → { type: "turn_ended",     taskId, usage? }
 *     → { type: "task_done",      taskId, summary, status, durationMs? }
 *     → { type: "task_error",     taskId, error }
 */
import { Agent } from '@cursor/sdk';
import readline from 'readline';

// ── Read one JSON line from stdin ─────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });
let inputLine = '';
for await (const line of rl) {
  inputLine = line.trim();
  if (inputLine) break;
}
rl.close();

if (!inputLine) {
  process.stderr.write('cursor-sdk-runner: no input received on stdin\n');
  process.exit(1);
}

let msg;
try {
  msg = JSON.parse(inputLine);
} catch (e) {
  process.stderr.write(`cursor-sdk-runner: invalid JSON on stdin: ${e.message}\n`);
  process.exit(1);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// ── Dispatch command ──────────────────────────────────────────────────────────

if (msg.command === 'discover') {
  await runDiscover(msg);
} else if (msg.command === 'delete') {
  await runDelete(msg);
} else {
  await runTask(msg);
}

// ── discover: list local Cursor agents via SDK ────────────────────────────────

async function runDiscover({ cwd, apiKey }) {
  try {
    const { items } = await Agent.list({ runtime: 'local', cwd, apiKey });
    emit({
      type: 'discover_result',
      agents: items.map(a => ({
        id:           a.agentId,
        name:         a.name ?? a.agentId,
        status:       a.status ?? 'idle',
        lastModified: a.lastModified,
      })),
    });
  } catch (err) {
    // Non-fatal: return empty list so the Bridge handshake can continue.
    process.stderr.write(`cursor-sdk-runner discover error: ${err?.message ?? err}\n`);
    emit({ type: 'discover_result', agents: [] });
  }
}

// ── delete: deregister a Cursor agent via SDK ────────────────────────────────

async function runDelete({ agentId, apiKey }) {
  try {
    await Agent.delete(agentId, { apiKey });
    emit({ type: 'delete_result', agentId, success: true });
  } catch (err) {
    process.stderr.write(`cursor-sdk-runner delete error: ${err?.message ?? err}\n`);
    emit({ type: 'delete_result', agentId, success: false, error: err?.message ?? String(err) });
  }
}

// ── run: dispatch a task to a Cursor agent ────────────────────────────────────

async function runTask({ taskId, agentId, agentName, prompt, cwd, model, apiKey, timeoutMs }) {
  emit({ type: 'task_started', taskId, cursorAgentId: agentId ?? null });

  const modelSelection = { id: model ?? 'composer-2' };
  const agentOptions = {
    apiKey,
    model: modelSelection,
    // Load .cursor/ project-level settings (hooks, MCP, subagent definitions)
    local: { cwd, settingSources: ['project'] },
  };

  let agent;

  // Resume an existing agent (preserves conversation history) when an agentId is
  // provided. Fall back to a fresh agent with a stable ID so subsequent runs can
  // resume again.
  if (agentId) {
    try {
      agent = await Agent.resume(agentId, { apiKey, model: modelSelection });
      emit({ type: 'agent_resumed', taskId, cursorAgentId: agentId });
    } catch (_resumeErr) {
      // Agent doesn't exist yet — create it with the stable ID
      agent = await Agent.create({ ...agentOptions, agentId, name: agentName ?? agentId });
      emit({ type: 'agent_created', taskId, cursorAgentId: agent.agentId });
    }
  } else {
    agent = await Agent.create(agentOptions);
    emit({ type: 'agent_created', taskId, cursorAgentId: agent.agentId });
  }

  // Set up timeout: call run.cancel() for graceful shutdown
  let activeRun = null;
  let cancelTimer = null;
  if (timeoutMs && timeoutMs > 0) {
    cancelTimer = setTimeout(async () => {
      if (activeRun) {
        try { await activeRun.cancel(); } catch { /* ignore */ }
      }
    }, timeoutMs);
  }

  // Helper: attempt to send; if the agent has a stuck active run, wipe and recreate it.
  async function sendWithStuckRunRecovery(ag, promptText, sendOptions) {
    try {
      return await ag.send(promptText, sendOptions);
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      if (!msg.includes('already has active run')) throw sendErr;
      // Agent is stuck — delete it so we can start fresh.
      process.stderr.write(`[cursor-sdk] stuck run detected on agent ${ag.agentId ?? agentId}; recreating agent\n`);
      try { await agent[Symbol.asyncDispose](); } catch { /* ignore */ }
      try { await Agent.delete(agentId, { apiKey }); } catch { /* ignore */ }
      // Try to recreate with the same stable ID. If the local SQLite entry still
      // exists (remote delete does not always clear the local DB), fall back to a
      // brand-new agent without a fixed ID.
      try {
        ag = await Agent.create({ ...agentOptions, agentId, name: agentId });
      } catch (createErr) {
        const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
        const suffix = Math.random().toString(36).slice(2, 8);
        const fallbackId = `${agentId}-${suffix}`;
        process.stderr.write(`[cursor-sdk] create with same id failed (${createMsg}); retrying with id ${fallbackId}\n`);
        ag = await Agent.create({ ...agentOptions, agentId: fallbackId, name: fallbackId });
      }
      emit({ type: 'agent_created', taskId, cursorAgentId: ag.agentId });
      agent = ag; // update outer ref so dispose in catch/finally uses the new instance
      return await ag.send(promptText, sendOptions);
    }
  }

  try {
    const run = await sendWithStuckRunRecovery(agent, prompt, {
      onDelta: ({ update }) => {
        if (!update || typeof update !== 'object') return;
        switch (update.type) {
          case 'text-delta':
            if (typeof update.text === 'string')
              emit({ type: 'text_delta', taskId, text: update.text });
            break;
          case 'thinking-delta':
            if (typeof update.text === 'string')
              emit({ type: 'thinking_delta', taskId, text: update.text });
            break;
          case 'tool-call-started':
            emit({ type: 'tool_started', taskId, name: update.toolCall?.name, callId: update.callId });
            break;
          case 'tool-call-completed':
            emit({ type: 'tool_completed', taskId, name: update.toolCall?.name, callId: update.callId });
            break;
          case 'turn-ended':
            emit({ type: 'turn_ended', taskId, usage: update.usage ?? null });
            break;
        }
      },
    });

    activeRun = run;

    // Emit run status transitions (RUNNING → FINISHED / ERROR / CANCELLED)
    const unsubStatus = run.onDidChangeStatus(status => {
      emit({ type: 'run_status', taskId, status });
    });

    for await (const event of run.stream()) {
      switch (event.type) {
        case 'tool_call':
          // File write detection — emit a dedicated event so the provider can
          // track written paths without parsing opaque args/result payloads.
          if (event.status === 'completed' && event.name === 'write_file') {
            const p = event.args?.path;
            if (p) emit({ type: 'file_written', taskId, path: p });
          }
          if (event.status === 'error') {
            process.stderr.write(`[cursor-sdk] tool error: ${event.name} — ${JSON.stringify(event.result)}\n`);
          }
          break;
        case 'status':
          // Log status transitions. Don't treat ERROR as immediately fatal —
          // it can be a transient cloud state during agent initialization.
          // Let run.wait() provide the authoritative final outcome.
          // Only CANCELLED is treated as a hard stop since it won't recover.
          if (event.status === 'CANCELLED') {
            unsubStatus();
            if (cancelTimer) clearTimeout(cancelTimer);
            await agent[Symbol.asyncDispose]();
            emit({ type: 'task_error', taskId, error: `Cursor run cancelled${event.message ? ': ' + event.message : ''}` });
            process.exitCode = 1;
            return;
          }
          break;
      }
    }

    unsubStatus();
    if (cancelTimer) clearTimeout(cancelTimer);

    const result = await run.wait();

    // Dispose agent cleanly. Do NOT use "await using" — syntax requires TS ≥ 5.2
    // with useDefineForClassFields and may error at parse time on some Node builds.
    await agent[Symbol.asyncDispose]();

    emit({
      type:       'task_done',
      taskId,
      summary:    result.result ?? `status:${result.status}`,
      status:     result.status,
      durationMs: result.durationMs ?? null,
      model:      result.model?.id ?? run.model?.id ?? null,
    });

  } catch (err) {
    if (cancelTimer) clearTimeout(cancelTimer);
    try { await agent[Symbol.asyncDispose](); } catch { /* ignore */ }
    emit({
      type:  'task_error',
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    process.exitCode = 1;
  }
}
