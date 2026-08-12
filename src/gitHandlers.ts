/**
 * @file gitHandlers.ts
 * @description Read-only git inspection for a folder under the Bridge base path.
 *
 * Shells out to the user's local `git` binary (the same approach the Bridge already
 * takes for agent CLIs) rather than bundling a JS git implementation — that way the
 * user's existing git config, credential helper and SSH keys apply unchanged.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { BASE_PATH } from './config.js';
import { sanitizeRelPath } from './fileSystem.js';
import { parseGitStatusPorcelain, parseGitNumstat, type GitFileChange } from './gitStatus.js';

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a git subcommand in `cwd`. Injected in tests; never throws for a non-zero exit. */
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

/** Long enough for a cold `git status` on a large repo, short enough to not wedge the Bridge. */
const GIT_TIMEOUT_MS = 20_000;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  // Checked here so the ENOENT throw below can only ever mean "git binary missing".
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return { ok: false, stdout: '', stderr: 'CWD_NOT_FOUND' };
  }
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    // ENOENT means git itself is missing — the caller must not read that as "no changes".
    if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') throw result.error;
    return {
      ok: false,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? result.error.message,
    };
  }

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** Positive repository identities are stable for a Bridge process; mutable status is never cached. */
const repositoryRootsByRunner = new WeakMap<GitRunner, Map<string, string>>();

function repositoryRoots(run: GitRunner): Map<string, string> {
  let roots = repositoryRootsByRunner.get(run);
  if (!roots) {
    roots = new Map<string, string>();
    repositoryRootsByRunner.set(run, roots);
  }
  return roots;
}

function resolveGitRoot(cwd: string, run: GitRunner): GitRunResult {
  const key = path.resolve(cwd);
  const cached = repositoryRoots(run).get(key);
  if (cached) return { ok: true, stdout: cached, stderr: '' };

  const result = run(['rev-parse', '--show-toplevel'], cwd);
  const root = result.stdout.trim();
  if (result.ok && root) repositoryRoots(run).set(key, root);
  return result;
}

function invalidateGitRoot(cwd: string, run: GitRunner): void {
  repositoryRoots(run).delete(path.resolve(cwd));
}

function isNotRepository(result: GitRunResult): boolean {
  return !result.ok && /not a git repository/i.test(`${result.stderr}\n${result.stdout}`);
}

/** Local branch names, current branch first. Never fails the whole status — an empty list just means "unknown". */
function listLocalBranches(cwd: string, run: GitRunner, currentBranch: string | null): string[] {
  const result = run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], cwd);
  if (!result.ok) return [];

  const names = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!currentBranch) return names;
  return [currentBranch, ...names.filter((name) => name !== currentBranch)];
}

/**
 * Resolves a message's `path` to an absolute folder under BASE_PATH.
 * Returns null only when the path escapes the base — a folder that simply does not
 * exist is left for git to report as "not a repository".
 */
function resolveRepoCwd(relPath: string | undefined): string | null {
  const raw = (relPath ?? '').replace(/\\/g, '/');
  // Reject rather than sanitize: silently rewriting `../other` to `<base>/other`
  // would report status for a different repository than the caller asked for.
  if (raw.split('/').includes('..')) return null;

  const safeRel = sanitizeRelPath(raw);
  const base = path.resolve(BASE_PATH);
  const full = path.resolve(path.join(BASE_PATH, safeRel));
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function isGitMissing(err: unknown): boolean {
  return (err as { code?: string })?.code === 'ENOENT'
    || /ENOENT/.test((err as Error)?.message ?? '');
}

export function handleGitStatus(msg: BridgeMessage, ctx: HandlerContext, run: GitRunner = defaultGitRunner): void {
  const { requestId } = msg;
  const respond = (payload: Record<string, unknown>) =>
    ctx.sendToSaas({ action: 'git_status_response', requestId, ...payload });

  const cwd = resolveRepoCwd(msg.path);
  if (!cwd) {
    respond({ isRepo: false, error: 'INVALID_PATH' });
    return;
  }

  try {
    const root = resolveGitRoot(cwd, run);
    if (!root.ok) {
      respond({ isRepo: false, error: null });
      return;
    }

    const status = run(['status', '--porcelain=v2', '--branch'], cwd);
    if (isNotRepository(status)) {
      invalidateGitRoot(cwd, run);
      respond({ isRepo: false, error: null });
      return;
    }
    if (!status.ok) {
      const detail = failureText(status, 'unknown git status failure');
      logger.debug('git_status.command_failed', {
        path: msg.path,
        error: detail.slice(0, 512),
      });
      respond({ isRepo: false, error: `GIT_STATUS_FAILED: ${detail}` });
      return;
    }
    if (!status.stdout.trim()) {
      // `--branch` always emits porcelain headers, even for a clean repository.
      // Empty output is therefore an invalid/transient result, not a clean snapshot.
      logger.warn('git_status.empty_output', { path: msg.path });
      respond({ isRepo: false, error: 'GIT_STATUS_EMPTY_OUTPUT' });
      return;
    }
    const summary = parseGitStatusPorcelain(status.stdout);

    // Untracked files never appear in numstat, so their counts stay at zero.
    const counts = new Map<string, { added: number; deleted: number; binary: boolean }>();
    for (const args of [['diff', '--numstat'], ['diff', '--cached', '--numstat']]) {
      const res = run(args, cwd);
      if (!res.ok) continue;
      for (const entry of parseGitNumstat(res.stdout)) {
        const prev = counts.get(entry.path) ?? { added: 0, deleted: 0, binary: false };
        counts.set(entry.path, {
          added: prev.added + entry.added,
          deleted: prev.deleted + entry.deleted,
          binary: prev.binary || entry.binary,
        });
      }
    }

    const files = summary.files.map((file: GitFileChange) => ({
      ...file,
      ...(counts.get(file.path) ?? { added: 0, deleted: 0, binary: false }),
    }));

    const branches = listLocalBranches(cwd, run, summary.branch);

    logger.debug('git_status', { path: msg.path, branch: summary.branch, changed: files.length });

    respond({
      isRepo: true,
      root: root.stdout.trim(),
      branch: summary.branch,
      detached: summary.detached,
      upstream: summary.upstream,
      ahead: summary.ahead,
      behind: summary.behind,
      files,
      branches,
      error: null,
    });
  } catch (err) {
    if (isGitMissing(err)) {
      logger.warn('git_status.git_not_available', { path: msg.path });
      respond({ isRepo: false, error: 'GIT_NOT_AVAILABLE' });
      return;
    }
    logger.warn('git_status.failed', { path: msg.path, error: (err as Error)?.message });
    respond({ isRepo: false, error: (err as Error)?.message ?? 'GIT_STATUS_FAILED' });
  }
}

export function handleGitDiff(msg: BridgeMessage, ctx: HandlerContext, run: GitRunner = defaultGitRunner): void {
  const { requestId, filePath } = msg;
  const respond = (payload: Record<string, unknown>) =>
    ctx.sendToSaas({ action: 'git_diff_response', requestId, filePath, ...payload });

  if (!filePath) {
    respond({ error: 'MISSING_PATH' });
    return;
  }

  const cwd = resolveRepoCwd(msg.path);
  if (!cwd) {
    respond({ error: 'INVALID_PATH' });
    return;
  }

  const safeFile = sanitizeRelPath(filePath);

  try {
    const root = resolveGitRoot(cwd, run);
    if (!root.ok) {
      respond({ error: 'NOT_A_REPOSITORY' });
      return;
    }

    if (msg.untracked) {
      // Untracked files have no blob to diff against — /dev/null gives an all-added diff.
      // `--no-index` exits non-zero whenever it finds differences, so ignore `ok` here.
      const added = run(['diff', '--no-index', '--', devNull(), safeFile], cwd);
      respond({ diff: added.stdout, error: null });
      return;
    }

    const worktree = run(['diff', '--', safeFile], cwd);
    if (isNotRepository(worktree)) {
      invalidateGitRoot(cwd, run);
      respond({ error: 'NOT_A_REPOSITORY' });
      return;
    }
    if (worktree.stdout.trim()) {
      respond({ diff: worktree.stdout, error: null });
      return;
    }

    const staged = run(['diff', '--cached', '--', safeFile], cwd);
    if (isNotRepository(staged)) {
      invalidateGitRoot(cwd, run);
      respond({ error: 'NOT_A_REPOSITORY' });
      return;
    }
    respond({ diff: staged.stdout, error: null });
  } catch (err) {
    if (isGitMissing(err)) {
      respond({ error: 'GIT_NOT_AVAILABLE' });
      return;
    }
    logger.warn('git_diff.failed', { path: msg.path, filePath, error: (err as Error)?.message });
    respond({ error: (err as Error)?.message ?? 'GIT_DIFF_FAILED' });
  }
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * Operations the SaaS may trigger. Deliberately a closed set of non-destructive
 * commands: nothing here rewrites history, discards work, or force-pushes.
 * `checkout` and `create_branch` never pass `-f`/`--force` — git itself refuses
 * to switch branches over a dirty working tree, and that refusal is surfaced as-is.
 */
const GIT_OPERATIONS = ['init', 'commit', 'fetch', 'pull', 'push', 'checkout', 'create_branch'] as const;
export type GitOperation = (typeof GIT_OPERATIONS)[number];

function isSupportedOperation(value: unknown): value is GitOperation {
  return GIT_OPERATIONS.includes(value as GitOperation);
}

/** Prefers git's own stderr over a generic code — it is what the user needs to read. */
function failureText(res: GitRunResult, fallback: string): string {
  return res.stderr.trim() || res.stdout.trim() || fallback;
}

export function handleGitOperation(msg: BridgeMessage, ctx: HandlerContext, run: GitRunner = defaultGitRunner): void {
  const { requestId, operation } = msg;
  const respond = (payload: Record<string, unknown>) =>
    ctx.sendToSaas({ action: 'git_operation_ack', requestId, operation, ...payload });

  if (!isSupportedOperation(operation)) {
    respond({ success: false, error: 'UNSUPPORTED_OPERATION' });
    return;
  }

  const cwd = resolveRepoCwd(msg.path);
  if (!cwd) {
    respond({ success: false, error: 'INVALID_PATH' });
    return;
  }

  const message = (msg.message ?? '').trim();
  if (operation === 'commit' && !message) {
    respond({ success: false, error: 'MISSING_COMMIT_MESSAGE' });
    return;
  }

  const branch = (msg.branch ?? '').trim();
  if ((operation === 'checkout' || operation === 'create_branch') && !branch) {
    respond({ success: false, error: 'MISSING_BRANCH_NAME' });
    return;
  }

  try {
    if (operation === 'init') {
      const initialized = run(['init'], cwd);
      if (!initialized.ok) {
        logger.warn('git_init.failed', { path: msg.path, error: failureText(initialized, 'GIT_INIT_FAILED') });
        respond({ success: false, error: failureText(initialized, 'GIT_INIT_FAILED') });
        return;
      }

      invalidateGitRoot(cwd, run);
      logger.info('git_init', { path: msg.path });
      respond({ success: true, error: null, output: (initialized.stdout || initialized.stderr).trim() });
      return;
    }

    const root = resolveGitRoot(cwd, run);
    if (!root.ok) {
      respond({ success: false, error: 'NOT_A_REPOSITORY' });
      return;
    }

    if (operation === 'commit') {
      // Two steps so a staging failure never produces a half-empty commit.
      const staged = run(['add', '-A'], cwd);
      if (!staged.ok) {
        if (isNotRepository(staged)) invalidateGitRoot(cwd, run);
        respond({ success: false, error: failureText(staged, 'GIT_ADD_FAILED') });
        return;
      }
      // argv form — the message stays a single argument, never a shell string.
      const committed = run(['commit', '-m', message], cwd);
      if (!committed.ok) {
        if (isNotRepository(committed)) invalidateGitRoot(cwd, run);
        respond({ success: false, error: failureText(committed, 'GIT_COMMIT_FAILED') });
        return;
      }
      logger.debug('git_commit', { path: msg.path });
      respond({ success: true, error: null, output: committed.stdout.trim() });
      return;
    }

    if (operation === 'checkout') {
      // No `-f`: a dirty working tree that checkout would overwrite makes git refuse on
      // its own, and that refusal (with its file list) is exactly what respond() surfaces.
      const switched = run(['checkout', branch], cwd);
      if (!switched.ok) {
        if (isNotRepository(switched)) invalidateGitRoot(cwd, run);
        logger.warn('git_checkout.failed', { path: msg.path, branch, error: switched.stderr.trim() });
        respond({ success: false, error: failureText(switched, 'GIT_CHECKOUT_FAILED') });
        return;
      }
      logger.debug('git_checkout', { path: msg.path, branch });
      respond({ success: true, error: null, output: (switched.stdout || switched.stderr).trim() });
      return;
    }

    if (operation === 'create_branch') {
      const baseBranch = (msg.baseBranch ?? '').trim();
      const args = baseBranch ? ['checkout', '-b', branch, baseBranch] : ['checkout', '-b', branch];
      const created = run(args, cwd);
      if (!created.ok) {
        if (isNotRepository(created)) invalidateGitRoot(cwd, run);
        logger.warn('git_create_branch.failed', { path: msg.path, branch, baseBranch, error: created.stderr.trim() });
        respond({ success: false, error: failureText(created, 'GIT_CREATE_BRANCH_FAILED') });
        return;
      }
      logger.debug('git_create_branch', { path: msg.path, branch, baseBranch });
      respond({ success: true, error: null, output: (created.stdout || created.stderr).trim() });
      return;
    }

    // `--ff-only` keeps pull from inventing a merge commit; push goes to the tracked
    // upstream with no force flag, so it can only ever fast-forward the remote.
    const args: Record<Exclude<GitOperation, 'init' | 'commit' | 'checkout' | 'create_branch'>, string[]> = {
      fetch: ['fetch', '--prune'],
      pull: ['pull', '--ff-only'],
      push: ['push'],
    };

    const res = run(args[operation as Exclude<GitOperation, 'init' | 'commit' | 'checkout' | 'create_branch'>], cwd);
    if (!res.ok) {
      if (isNotRepository(res)) invalidateGitRoot(cwd, run);
      logger.warn('git_operation.failed', { operation, path: msg.path, error: res.stderr.trim() });
      respond({ success: false, error: failureText(res, 'GIT_OPERATION_FAILED') });
      return;
    }

    logger.debug('git_operation', { operation, path: msg.path });
    respond({ success: true, error: null, output: (res.stdout || res.stderr).trim() });
  } catch (err) {
    if (isGitMissing(err)) {
      respond({ success: false, error: 'GIT_NOT_AVAILABLE' });
      return;
    }
    logger.warn('git_operation.threw', { operation, path: msg.path, error: (err as Error)?.message });
    respond({ success: false, error: (err as Error)?.message ?? 'GIT_OPERATION_FAILED' });
  }
}
