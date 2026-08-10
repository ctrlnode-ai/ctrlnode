import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { OPENCLAW_CONFIG, ctrlnodePath, CTRLNODE_ROOT, BASE_PATH } from './config.js';
import { ensureDir, isDirEmpty, readFileForBridge, walkDir, listDirShallow, listDirShallowEntries, sanitizeRelPath } from './fileSystem.js';
import { suppressFileChangedForAgentPaths } from './watcher.js';
import {
  discoveredAgents,
  isAgentInCtrlnode,
} from './agentDiscovery.js';
import { resolveTargetAgentId } from './agentRouting.js';

// Re-exports so existing callers (messageHandlers, CodexSdkProvider) keep working.
export { getCodexAgentHome, setupCodexAgentHome } from './codexAgentHome.js';
export { handleSyncProviderAgents, handleDeleteAgentFolders, handleDeleteAgentConfig, handleUpdateAgentConfig } from './agentRegistrationHandlers.js';
export type { SyncableProvider } from './agentRegistrationHandlers.js';
export { handleActivatePipelineTask } from './pipelineTaskHandler.js';

/** Files written only for scaffold/tooling purposes — should not trigger task completion. */
const SCAFFOLD_ONLY_FILES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db', '.keep', 'agent_log.md']);

/**
 * Debounce task_complete signals by 45s per task folder.
 * Agents often write intermediate output files before truly finishing —
 * we wait for a quiet window before declaring the task done.
 */
const TASK_COMPLETE_DEBOUNCE_MS = 45_000;
const taskCompleteTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleTaskComplete(taskFolderName: string, agentId: string, ctx: HandlerContext): void {
  const existing = taskCompleteTimers.get(taskFolderName);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    taskCompleteTimers.delete(taskFolderName);
    ctx.sendToSaas({ action: 'task_complete', agentId, taskFolderName, source: 'output_file' });
  }, TASK_COMPLETE_DEBOUNCE_MS);
  taskCompleteTimers.set(taskFolderName, timer);
}

/** Cancel any pending output-file task_complete debounce for this task folder (called when an explicit terminal signal arrives). */
export function cancelTaskCompleteDebounce(taskFolderName: string): void {
  const existing = taskCompleteTimers.get(taskFolderName);
  if (existing) {
    clearTimeout(existing);
    taskCompleteTimers.delete(taskFolderName);
  }
}

/**
 * Resolves the filesystem base path for a Bridge message.
 *
 * When `useCtrlnode=true` and the message specifies a provider that is not
 * active in this Bridge instance, falls back to CTRLNODE_ROOT.
 * All non-OpenClaw providers share this root, so a Copilot-only Bridge can
 * still read/write Gemini task folders (same physical path).
 */
function resolveBase(msg: BridgeMessage, ctx: HandlerContext, targetId: string | undefined): string | null {
  if (msg.useBasePath) return BASE_PATH;
  const useCtrlnode = msg.useCtrlnode ?? false;
  if (msg.provider) {
    const base = ctx.provider.resolveFilesystemBaseByProvider(msg.provider, useCtrlnode, targetId);
    if (base !== null) return base;
    // Provider not active in this Bridge instance — fall back to shared root.
    if (useCtrlnode) {
      logger.debug('resolveBase.provider_fallback', { msgProvider: msg.provider, agentId: targetId, fallback: CTRLNODE_ROOT });
      return CTRLNODE_ROOT;
    }
    return null;
  }
  // No provider specified + useCtrlnode=true → always use CTRLNODE_ROOT.
  // This handles proxy reads from the SaaS where the proxy agent may be OpenClaw
  // but the files live in the shared .ctrlnode folder (Cursor, Claude, Gemini, etc.).
  if (useCtrlnode) return CTRLNODE_ROOT;
  return ctx.provider.resolveFilesystemBase(targetId, useCtrlnode);
}

export function handleWriteFile(msg: BridgeMessage, ctx: HandlerContext): void {
  const { path: relPath, content, useCtrlnode, contentEncoding } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!basePath) return;

  const safePath = sanitizeRelPath(relPath!);
  const fullPath = path.join(basePath, safePath);
  if (!useCtrlnode && !fullPath.startsWith(basePath)) return;

  ensureDir(path.dirname(fullPath));
  const normalizedSafePath = safePath.replace(/\\/g, '/');
  const isTaskInput = /^tasks\/[^/]+\/input\//i.test(normalizedSafePath);
  if (!useCtrlnode && targetId && isTaskInput) {
    // Suppress secondary file_changed events produced by backend-driven writes to task inputs
    // (assignment/unassignment migrations, markdown syncs, etc.).
    suppressFileChangedForAgentPaths(targetId, [normalizedSafePath], 3000);
  }

  // Strip status tags from output files before persisting to disk (text only).
  const isTaskOutput = safePath.includes('/output/') || safePath.includes('\\output\\');
  let payload: string | Buffer;
  if (contentEncoding === 'base64' && content) {
    payload = Buffer.from(content, 'base64');
  } else {
    const text = (isTaskOutput && content)
      ? content.replace(/<TASK_(?:COMPLETED|FAILED|BLOCKED):[a-f0-9-]+>/gi, '').trimEnd() + '\n'
      : (content || '');
    payload = text;
  }

  if (Buffer.isBuffer(payload)) {
    fs.writeFileSync(fullPath, payload);
  } else {
    fs.writeFileSync(fullPath, payload, 'utf8');
  }
  logger.debug('write_file', { agentId: targetId, path: safePath });

  if (isTaskOutput) {
    const preview = typeof payload === 'string' ? payload.slice(-600) : '(binary)';
    logger.debug('subagent.write_output', { agentId: targetId, path: safePath, preview });
    // When any real file is written to output, signal task completion to SaaS.
    const normalizedPath = safePath.replace(/\\/g, '/');
    const outputFileMatch = normalizedPath.match(/^(tasks\/[^/]+)\/output\/(.+)$/);
    if (outputFileMatch) {
      const taskFolderName = outputFileMatch[1]!;
      const filename = path.basename(outputFileMatch[2]!);
      if (!SCAFFOLD_ONLY_FILES.has(filename) && targetId) {
        logger.debug('subagent.output_file_written', { agentId: targetId, taskFolderName, path: safePath });
        scheduleTaskComplete(taskFolderName, targetId, ctx);
      }
    }
  }
}

export async function handleDeletePath(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { requestId, path: relPath } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!requestId || !relPath || !basePath) {
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: false, error: 'INVALID_REQUEST' });
    return;
  }

  const safePath = sanitizeRelPath(relPath);
  const fullPath = path.resolve(path.join(basePath, safePath));
  const resolvedBase = path.resolve(basePath);

  if (!fullPath.startsWith(resolvedBase)) {
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: false, error: 'INVALID_PATH' });
    return;
  }

  try {
    await fs.promises.rm(fullPath, { recursive: true, force: true });
    logger.debug('delete_path', { agentId: targetId, path: safePath });
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: true, error: null });
  } catch (err: any) {
    logger.warn('delete_path.failed', { agentId: targetId, path: safePath, error: err?.message });
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: false, error: err?.message ?? 'DELETE_FAILED' });
  }
}

export function handleCreateFolder(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, path: relPath } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!relPath) {
    ctx.sendToSaas({ action: 'create_folder_ack', requestId, success: false, error: 'MISSING_PATH' });
    return;
  }
  if (!basePath) {
    ctx.sendToSaas({ action: 'create_folder_ack', requestId, success: false, error: 'BASE_PATH_NOT_FOUND' });
    return;
  }

  const safePath = sanitizeRelPath(relPath);
  const fullPath = path.resolve(path.join(basePath, safePath));
  if (!fullPath.startsWith(path.resolve(basePath))) {
    ctx.sendToSaas({ action: 'create_folder_ack', requestId, success: false, error: 'INVALID_PATH' });
    return;
  }

  try {
    ensureDir(fullPath);
    logger.debug('create_folder', { agentId: targetId, path: safePath });
    ctx.sendToSaas({ action: 'create_folder_ack', requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'create_folder_ack', requestId, success: false, error: err?.message ?? 'CREATE_FAILED' });
  }
}

export function handleRenameFolder(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, path: relPath, newPath } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!relPath || !newPath) {
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: false, error: 'MISSING_PATH' });
    return;
  }
  if (!basePath) {
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: false, error: 'BASE_PATH_NOT_FOUND' });
    return;
  }

  const resolvedBase = path.resolve(basePath);
  const fromPath = path.resolve(path.join(basePath, sanitizeRelPath(relPath)));
  const toPath = path.resolve(path.join(basePath, sanitizeRelPath(newPath)));
  if (!fromPath.startsWith(resolvedBase) || !toPath.startsWith(resolvedBase)) {
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: false, error: 'INVALID_PATH' });
    return;
  }

  if (!fs.existsSync(fromPath) || !fs.statSync(fromPath).isDirectory()) {
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: false, error: 'FOLDER_NOT_FOUND' });
    return;
  }

  try {
    ensureDir(path.dirname(toPath));
    fs.renameSync(fromPath, toPath);
    logger.debug('rename_folder', { agentId: targetId, path: relPath, newPath });
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'rename_folder_ack', requestId, success: false, error: err?.message ?? 'RENAME_FAILED' });
  }
}

/** Deletes a folder only when it is empty — refuses with FOLDER_NOT_EMPTY otherwise (no recursive delete here). */
export function handleDeleteFolder(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, path: relPath } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!relPath) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: 'MISSING_PATH' });
    return;
  }
  if (!basePath) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: 'BASE_PATH_NOT_FOUND' });
    return;
  }

  const safePath = sanitizeRelPath(relPath);
  const fullPath = path.resolve(path.join(basePath, safePath));
  if (!fullPath.startsWith(path.resolve(basePath))) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: 'INVALID_PATH' });
    return;
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: 'FOLDER_NOT_FOUND' });
    return;
  }

  if (!isDirEmpty(fullPath)) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: 'FOLDER_NOT_EMPTY' });
    return;
  }

  try {
    fs.rmdirSync(fullPath);
    logger.debug('delete_folder', { agentId: targetId, path: safePath });
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'delete_folder_ack', requestId, success: false, error: err?.message ?? 'DELETE_FAILED' });
  }
}

export function handleReadFile(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, path: relPath, useCtrlnode } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const basePath = resolveBase(msg, ctx, targetId);
  if (!basePath) {
    logger.warn('read_file.base_path_not_found', {
      agentId: targetId,
      msgProvider: msg.provider ?? null,
      useCtrlnode: useCtrlnode ?? false,
      providerName: (ctx.provider as any).providerName ?? '(multi)',
    });
    ctx.sendToSaas({ action: 'read_file_response', requestId, error: 'BASE_PATH_NOT_FOUND' });
    return;
  }

  const safePath = sanitizeRelPath(relPath!);
  const fullPath = path.join(basePath, safePath);
  logger.debug('read_file.attempt', { agentId: targetId, absPath: fullPath, relPath: safePath });

  if (!path.resolve(fullPath).startsWith(path.resolve(basePath))) {
    ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content: null, error: 'INVALID_PATH' });
    return;
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    logger.warn('read_file.not_found', { agentId: targetId, absPath: fullPath, basePath, relPathRaw: relPath, relPathSafe: safePath, msgProvider: msg.provider ?? null, useCtrlnode: useCtrlnode ?? false });
    ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content: null, error: 'FILE_NOT_FOUND' });
    return;
  }

  const { content, contentType, error } = readFileForBridge(fullPath);
  ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content, contentType, error: error ?? undefined });
  logger.debug('read_file', { agentId: targetId, path: safePath, contentType, error: error ?? undefined });
}

export function handleListFiles(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, subpath, useCtrlnode } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);

  const baseDir = resolveBase(msg, ctx, targetId);
  if (!baseDir) {
    logger.warn('list_files.base_path_not_found', {
      agentId: targetId,
      msgProvider: msg.provider ?? null,
      useCtrlnode: useCtrlnode ?? false,
      providerName: (ctx.provider as any).providerName ?? '(multi)',
    });
    ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'AGENT_NOT_FOUND' });
    return;
  }

  let targetDir = baseDir;
  let basePath = '';

  if (subpath) {
    const normalized = path.normalize(subpath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'INVALID_PATH' });
      return;
    }
    targetDir = path.join(baseDir, normalized);
    // Always use forward slashes so walkDir entries are portable across OSes.
    basePath = normalized.replace(/\\/g, '/');
    if (!path.resolve(targetDir).startsWith(path.resolve(baseDir))) {
      ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'INVALID_PATH' });
      return;
    }
  }

  logger.debug('list_files.attempt', { agentId: targetId, absDir: targetDir, subpath: subpath || '/', exists: fs.existsSync(targetDir) });
  const files = msg.useBasePath
    ? (msg.recursive
      ? walkDir(targetDir, basePath)
      : msg.shallowIncludeFiles
        ? listDirShallowEntries(targetDir, basePath)
        : listDirShallow(targetDir, basePath))
    : walkDir(targetDir, basePath);
  logger.debug('list_files', {
    agentId: targetId,
    subpath: subpath || '/',
    entries: files.length,
    shallow: !!msg.useBasePath,
    shallowIncludeFiles: !!msg.shallowIncludeFiles,
    recursive: !!msg.recursive,
  });
  ctx.sendToSaas({ action: 'list_files_response', requestId, files, basePath: baseDir, error: null });
}

export function handleCreateWorkspace(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, folderName, files, useCtrlnode } = msg;

  if (!folderName) {
    ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: false, error: 'MISSING_FOLDER_NAME' });
    return;
  }

  try {
    const basePath = ctx.provider.resolveWorkspaceCreationBase(useCtrlnode ?? false);
    if (!basePath) {
      ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: true, error: null });
      return;
    }

    const workspacePath = path.resolve(path.join(basePath, folderName));
    if (!workspacePath.startsWith(path.resolve(basePath))) {
      ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: false, error: 'INVALID_PATH' });
      return;
    }

    ensureDir(workspacePath);
    for (const file of (files || [])) {
      const fullPath = path.resolve(path.join(workspacePath, file.path));
      if (!fullPath.startsWith(workspacePath)) {
        ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: false, error: `INVALID_FILE_PATH: ${file.path}` });
        return;
      }
      ensureDir(path.dirname(fullPath));
      fs.writeFileSync(fullPath, file.content || '', 'utf8');
    }

    logger.debug('create_workspace', { folderName, workspacePath, files: (files || []).length });
    ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: false, error: err.message });
  }
}

export function handleSyncConfig(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, configContent } = msg;

  if (!configContent) {
    ctx.sendToSaas({ action: 'sync_config_ack', requestId, success: false, error: 'MISSING_CONFIG_CONTENT' });
    return;
  }

  try {
    ensureDir(path.dirname(OPENCLAW_CONFIG));
    fs.writeFileSync(OPENCLAW_CONFIG, configContent, 'utf8');
    logger.debug('sync_config', { path: OPENCLAW_CONFIG });
    ctx.syncAgents();
    ctx.sendToSaas({ action: 'sync_config_ack', requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'sync_config_ack', requestId, success: false, error: err.message });
  }
}

export function handleCheckTaskOutput(msg: BridgeMessage, ctx: HandlerContext): void {
  const { taskFolderName } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  if (!agentInfo || !taskFolderName) {
    ctx.sendToSaas({ action: 'check_task_output_result', agentId: targetId ?? msg.agentId, taskFolderName, hasOutput: false });
    return;
  }

  // Ctrlnode agents write output to ctrlnode/tasks/{id}/output, not to their own workspace.
  const basePath = isAgentInCtrlnode(targetId!) ? ctrlnodePath : agentInfo.workspace;
  const outputDir = path.join(basePath, taskFolderName, 'output');
  let hasOutput = false;
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir).filter(f => !SCAFFOLD_ONLY_FILES.has(f));
    hasOutput = files.length > 0;
  }

  // If a debounce timer is still running for this folder, the agent is still writing —
  // report hasOutput=false so the backend doesn't mark the task done prematurely.
  if (hasOutput && taskCompleteTimers.has(taskFolderName)) {
    logger.debug('check_task_output.debounce_pending', { agentId: targetId, taskFolderName });
    hasOutput = false;
  }

  logger.debug('check_task_output', { agentId: targetId, taskFolderName, outputDir, hasOutput });
  ctx.sendToSaas({ action: 'check_task_output_result', agentId: targetId, taskFolderName, hasOutput });
}
