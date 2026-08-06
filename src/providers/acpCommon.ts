/**
 * acpCommon.ts
 * Shared utilities for ACP (Agent Client Protocol) provider implementations.
 */
import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import type { ChildProcess } from 'child_process';
import { logger } from '../logger.js';

// ── Process spawn ─────────────────────────────────────────────────────────────

/**
 * Returns the correct `[cmd, args]` pair for spawning an ACP CLI on Windows and Unix.
 * On Windows, ACP CLIs installed as npm packages are `.cmd` wrappers that require
 * `cmd.exe /c` to execute correctly from a non-shell spawn.
 */
export function buildAcpSpawnCommand(name: string, baseArgs: string[]): { cmd: string; args: string[] } {
  if (process.platform === 'win32') {
    return { cmd: 'cmd.exe', args: ['/c', name, ...baseArgs] };
  }
  return { cmd: name, args: baseArgs };
}

// ── Early-exit guard ──────────────────────────────────────────────────────────

/**
 * Creates a promise that rejects the moment the process crashes or exits early,
 * so callers can race it against their main ACP work and fail fast instead of
 * hanging indefinitely.
 *
 * Call `clearReject()` once the ACP work has finished normally so a subsequent
 * process close event does not surface as a spurious error.
 */
export function createProcEarlyExit(
  proc: ChildProcess,
  providerLog: string,
  taskId: string,
  closeMessage?: (code: number | null) => string,
): {
  promise: Promise<never>;
  clearReject(): void;
  readonly exitCode: number | null;
} {
  let _exitCode: number | null = null;
  let reject: ((err: Error) => void) | null = null;
  const promise = new Promise<never>((_res, rej) => { reject = rej; });

  proc.on('error', (err) => {
    logger.error(`${providerLog}.proc_error`, { taskId, error: err.message });
    reject?.(err);
  });
  proc.on('close', (code) => {
    _exitCode = code;
    logger.debug(`${providerLog}.proc_close`, { taskId, code });
    const msg = closeMessage?.(code)
      ?? `${providerLog.split('.')[0]} process exited with code ${code}`;
    reject?.(new Error(msg));
  });

  return {
    promise,
    clearReject: () => { reject = null; },
    get exitCode() { return _exitCode; },
  };
}

// ── ACP connection ────────────────────────────────────────────────────────────

/** Wraps a spawned process's stdio into an ACP ndjson stream. */
export function createAcpStream(proc: ChildProcess): acp.Stream {
  const output = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
  const input  = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
  return acp.ndJsonStream(output, input);
}

/**
 * Creates and initializes an ACP ClientSideConnection with standard filesystem
 * capabilities. The caller supplies the client object that handles ACP callbacks
 * (sessionUpdate, requestPermission, writeTextFile, …).
 */
export async function initAcpConnection(
  stream: acp.Stream,
  client: acp.Client,
): Promise<acp.ClientSideConnection> {
  const connection = new acp.ClientSideConnection((_agent) => client, stream);
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
  });
  return connection;
}

// ── Read-only structured planning ───────────────────────────────────────────────

export interface AcpStructuredPlanOptions {
  /** Log-category prefix, e.g. 'gemini_acp'. */
  providerLog: string;
  cmd: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompt: string;
  /** Bounded read-only planning time supplied by Bridge configuration. */
  timeoutMs: number;
}

/**
 * Runs one read-only prompt/response turn against an ACP CLI shared by every
 * ACP-based provider (Gemini, Copilot, Hermes). No MCP servers are registered
 * (no write tools reach the model) and file writes are rejected defensively,
 * so a graph-blueprint proposal can never touch disk or persist a session —
 * only the final assistant text is collected and returned.
 */
export function runAcpStructuredPlan(options: AcpStructuredPlanOptions): Promise<string> {
  const { providerLog, cmd, args, cwd, env, prompt, timeoutMs } = options;

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (!proc.stdin || !proc.stdout) {
      reject(new Error(`Failed to start ${providerLog} process`));
      return;
    }

    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!proc.killed) proc.kill('SIGTERM');
      fn();
    };

    const timer = setTimeout(() => {
      logger.warn(`${providerLog}.graph_generation_timeout`, { timeoutMs });
      finish(() => reject(new Error('GRAPH_GENERATION_TIMEOUT')));
    }, timeoutMs);

    const earlyExit = createProcEarlyExit(proc, providerLog, 'graph-planning');
    earlyExit.promise.catch((err) => finish(() => reject(err)));

    const stream = createAcpStream(proc);
    let accumulatedText = '';

    const client: acp.Client = {
      async requestPermission() {
        // Read-only planning never needs a tool approval; deny to fail fast.
        return { outcome: { outcome: 'cancelled' } };
      },
      async sessionUpdate(params) {
        const update = (params as { update?: unknown }).update as Record<string, unknown> | undefined;
        if (update?.sessionUpdate === 'agent_message_chunk' && (update.content as any)?.type === 'text') {
          accumulatedText += String((update.content as any).text ?? '');
        }
      },
      async writeTextFile() {
        throw new Error('GRAPH_GENERATION_READ_ONLY: planning must not write files');
      },
      async readTextFile() {
        return { content: '' };
      },
    };

    (async () => {
      const connection = await initAcpConnection(stream, client);
      const session = await connection.newSession({ cwd, mcpServers: [] });
      const result = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: prompt }],
      });

      const stopReason = (result as { stopReason?: string }).stopReason;
      if (stopReason !== 'end_turn') {
        throw new Error(`GRAPH_GENERATION_PROVIDER_ERROR: unexpected ACP stopReason ${stopReason}`);
      }
      const text = accumulatedText.trim();
      if (!text) throw new Error('GRAPH_GENERATION_EMPTY_RESPONSE');
      return text;
    })()
      .then((text) => finish(() => resolve(text)))
      .catch((err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))));
  });
}
