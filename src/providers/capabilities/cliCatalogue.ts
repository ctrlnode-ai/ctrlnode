/**
 * @file cliCatalogue.ts
 * @description Runs a provider CLI's JSON catalogue subcommand with a hard timeout.
 *
 * Only fixed, argument-free subcommands are ever run (`skill list --json`), never anything
 * derived from user input. Output is parsed as JSON; human-readable output is discarded
 * rather than scraped, so a CLI version bump degrades to an empty catalogue, not garbage.
 */

import { spawnSync } from 'child_process';

import { logger } from '../../logger.js';
import { CAPABILITY_DISCOVERY_TIMEOUT_MS } from './types.js';

export interface CliCatalogueResult {
  ok: boolean;
  stdout: string;
  /** Short machine-readable reason, safe to surface as a warning. */
  reason?: 'binary_missing' | 'timeout' | 'nonzero_exit';
}

export type CliRunner = (command: string, args: string[], cwd: string, timeoutMs?: number) => CliCatalogueResult;

export const defaultCliRunner: CliRunner = (command, args, cwd, timeoutMs = CAPABILITY_DISCOVERY_TIMEOUT_MS) => {
  // Windows resolves .cmd shims only through the shell, matching buildAcpSpawnCommand.
  const isWindows = process.platform === 'win32';
  const spawnCommand = isWindows ? 'cmd.exe' : command;
  const spawnArgs = isWindows ? ['/c', command, ...args] : args;

  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      stdout: '',
      reason: code === 'ENOENT' ? 'binary_missing' : code === 'ETIMEDOUT' ? 'timeout' : 'nonzero_exit',
    };
  }
  if (result.signal === 'SIGTERM') return { ok: false, stdout: '', reason: 'timeout' };
  if (result.status !== 0) {
    logger.debug('capabilities.cli.nonzero_exit', { command, status: result.status });
    return { ok: false, stdout: result.stdout ?? '', reason: 'nonzero_exit' };
  }

  return { ok: true, stdout: result.stdout ?? '' };
};

/**
 * Pulls an array of records out of a CLI payload that may be a bare array or wrapped
 * under a named key. Returns [] for anything else — including non-JSON output.
 */
export function extractCatalogueArray(raw: string, wrapperKeys: string[]): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return parsed.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');

  if (parsed && typeof parsed === 'object') {
    for (const key of wrapperKeys) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object');
      }
    }
  }

  return [];
}
