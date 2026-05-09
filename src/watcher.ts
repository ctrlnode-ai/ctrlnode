/**
 * @file watcher.ts
 * @description Per-agent filesystem watchers and file-event processing.
 *
 * Uses chokidar to watch each agent's workspace directory. When files change,
 * every event is classified as `file_changed` and dispatched via the provided
 * callbacks. The API side is responsible for deriving task context from the path.
 *
 * Polling mode is auto-enabled for directories on mounted/network volumes
 * (see {@link isMountedVolumeLikely}).
 */

import path from 'path';
import fs from 'fs';
import chokidar from 'chokidar';
import { WATCHER_USE_POLLING, WATCHER_POLL_INTERVAL } from './config';
import { isMountedVolumeLikely, safeReadFile } from './fileSystem';
import { logger } from './logger';

// ── Regex patterns ───────────────────────────────────────────────────────────

/** Filenames that should never trigger events (chokidar scaffolding artefacts). */
const IGNORE_FILES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db']);

/**
 * Temporary suppression windows for file_changed events produced by bridge-internal
 * bulk operations (e.g. atomic pipeline activation copies).
 * Key: agentId -> [{ prefix, until }]. Prefixes use forward-slash relative paths.
 */
const suppressedFileChangedPrefixes: Record<string, Array<{ prefix: string; until: number }>> = {};

// ── State ─────────────────────────────────────────────────────────────────────

/** Map of agentId → active chokidar FSWatcher instance. */
const activeWatchers: Record<string, chokidar.FSWatcher> = {};

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Low-level file-event handler passed to {@link startWatcher}.
 * Receives the raw chokidar event so higher-level processing can be done
 * in {@link processFileEvent}.
 */
export type FileEventHandler = (
  agentId:      string,
  workspaceDir: string,
  event:        string,
  filePath:     string
) => void;

/**
 * Callbacks required by {@link processFileEvent} to dispatch events and
 * update agent status without depending on global state directly.
 */
export type WatcherCallbacks = {
  /** Sends a message to the SaaS over the active WebSocket connection. */
  sendToSaas: (payload: any) => void;
  /** Marks the agent as running and resets the idle timer. */
  setAgentRunning: (agentId: string) => void;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Starts a chokidar watcher for the given agent's workspace directory.
 * If a watcher is already active for this agent, this is a no-op.
 *
 * Polling mode is enabled automatically when:
 *  - `WATCHER_USE_POLLING=true` is set, OR
 *  - The directory is detected to be on a mounted/network volume.
 *
 * @param agentId      - Unique identifier of the agent.
 * @param workspaceDir - Absolute path to the agent's workspace directory.
 * @param onEvent      - Callback invoked for every "add" or "change" event.
 */
export function startWatcher(agentId: string, workspaceDir: string, onEvent: FileEventHandler): void {
  if (activeWatchers[agentId]) return;

  if (!fs.existsSync(workspaceDir)) {
    logger.warn('workspace_missing', { agentId, workspaceDir });
  }

  const usePolling = WATCHER_USE_POLLING || isMountedVolumeLikely(workspaceDir);

  const watcher = chokidar.watch(workspaceDir, {
    persistent:       true,
    ignoreInitial:    true,
    depth:            10,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 },
    usePolling,
    interval:         WATCHER_POLL_INTERVAL,
    ignored:          [/(^|[/])\.+/, '**/node_modules/**'],
  });

  watcher.on('add',    fp => onEvent(agentId, workspaceDir, 'add',    fp));
  watcher.on('change', fp => onEvent(agentId, workspaceDir, 'change', fp));
  watcher.on('ready',  () => logger.info('watcher_ready', { agentId, polling: usePolling, workspaceDir }));
  watcher.on('error',  (err: Error) => logger.error('watcher_error', { agentId, message: err.message }));

  activeWatchers[agentId] = watcher;
}

/**
 * Closes and removes the active watcher for the given agent.
 * Safe to call when no watcher exists (no-op).
 *
 * @param agentId - Unique identifier of the agent whose watcher to stop.
 */
export function stopWatcher(agentId: string): void {
  const watcher = activeWatchers[agentId];
  if (!watcher) return;
  watcher.close();
  delete activeWatchers[agentId];
  delete suppressedFileChangedPrefixes[agentId];
  logger.info('watcher_stopped', { agentId });
}

/**
 * Suppresses file_changed events for the given agent/path prefixes during a short
 * time window. Used to avoid secondary events from bridge-internal bulk copies.
 */
export function suppressFileChangedForAgentPaths(
  agentId: string,
  prefixes: string[],
  ttlMs = 3000,
): void {
  const now = Date.now();
  const until = now + Math.max(200, ttlMs);
  const normalized = prefixes
    .map(p => (p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim())
    .filter(Boolean);
  if (normalized.length === 0) return;

  const existing = (suppressedFileChangedPrefixes[agentId] || []).filter(x => x.until > now);
  for (const prefix of normalized) {
    existing.push({ prefix, until });
  }
  suppressedFileChangedPrefixes[agentId] = existing;

  logger.debug('file_changed_suppression_set', { agentId, prefixes: normalized, ttlMs });
}

function isFileChangedSuppressed(agentId: string, relPath: string): boolean {
  const rules = suppressedFileChangedPrefixes[agentId];
  if (!rules || rules.length === 0) return false;

  const now = Date.now();
  const alive = rules.filter(r => r.until > now);
  suppressedFileChangedPrefixes[agentId] = alive;

  return alive.some(r => relPath === r.prefix || relPath.startsWith(`${r.prefix}/`));
}

/**
 * Classifies a raw filesystem event and dispatches a `file_changed` message
 * through the provided callbacks. All task context (output detection, status
 * advances) is derived on the API side from the file path.
 *
 * Processing order:
 *  1. Skip files in the ignore list.
 *  2. If suppressed, skip.
 *  3. Send file_changed with path, event and content.
 *  4. Update running status for output/log files.
 *
 * @param agentId      - ID of the agent whose workspace emitted the event.
 * @param workspaceDir - Absolute base path of the agent's workspace.
 * @param event        - chokidar event name ("add" or "change").
 * @param filePath     - Absolute path of the file that changed.
 * @param cb           - {@link WatcherCallbacks} for side effects.
 */
export function processFileEvent(
  agentId:      string,
  workspaceDir: string,
  event:        string,
  filePath:     string,
  cb:           WatcherCallbacks
): void {
  const relPath = path.relative(workspaceDir, filePath).replace(/\\/g, '/');
  if (IGNORE_FILES.has(path.basename(relPath))) return;

  if (isFileChangedSuppressed(agentId, relPath)) {
    logger.debug('file_changed_suppressed', { agentId, path: relPath });
    return;
  }

  logger.debug('file_changed', { agentId, path: relPath, event });
  cb.sendToSaas({ action: 'file_changed', agentId, path: relPath, event, content: safeReadFile(filePath) });

  if (relPath.includes('/output/') || relPath.includes('/logs/')) {
    cb.setAgentRunning(agentId);
  }
}
