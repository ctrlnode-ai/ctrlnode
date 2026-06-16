/**
 * acpCommon.ts
 * Shared utilities for ACP (Agent Client Protocol) provider implementations.
 */
import * as acp from '@agentclientprotocol/sdk';
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
