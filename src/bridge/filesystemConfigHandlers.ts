import fs from 'fs';
import path from 'path';

import { logger } from './logger';
import { BridgeMessage } from './types';
import { HandlerContext } from './handlerContext';
import { OPENCLAW_CONFIG, ctrlnodePath } from './config';
import { ensureDir, readFileForBridge, walkDir, sanitizeRelPath, deleteDir } from './fileSystem';
import { suppressFileChangedForAgentPaths } from './watcher';
import {
  discoveredAgents,
  upsertAgentConfig,
  deleteAgentConfig,
  normalizeAgentId,
  isAgentInCtrlnode,
} from './agentDiscovery';
import { resolveTargetAgentId } from './agentRouting';

/** Files written only for scaffold/tooling purposes — should not trigger task completion. */
const SCAFFOLD_ONLY_FILES = new Set(['.gitkeep', '.DS_Store', 'Thumbs.db', '.keep']);

export function handleWriteFile(msg: BridgeMessage, ctx: HandlerContext): void {
  const { path: relPath, content, useCtrlnode, contentEncoding } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  const basePath = useCtrlnode ? ctrlnodePath : agentInfo?.workspace;
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
  logger.info('write_file', { agentId: useCtrlnode ? 'CTRLNODE' : targetId, path: safePath });
  if (isTaskOutput) {
    const preview = typeof payload === 'string' ? payload.slice(-600) : '(binary)';
    logger.info('subagent.write_output', {
      agentId: targetId,
      path: safePath,
      preview,
    });
    // When any real file is written to output (root or subdirs), signal task completion to SaaS.
    // The taskFolderName is extracted from the path (e.g. "tasks/a9147f93-hell").
    // Ignore .gitkeep and other scaffold-only files.
    // Normalize to forward slashes so regex works on Windows paths too
    const normalizedPath = safePath.replace(/\\/g, '/');
    const outputFileMatch = normalizedPath.match(/^(tasks\/[^/]+)\/output\/(.+)$/);
    if (outputFileMatch) {
      const taskFolderName = outputFileMatch[1];
      const filename = path.basename(outputFileMatch[2]);
      if (!SCAFFOLD_ONLY_FILES.has(filename)) {
        logger.info('subagent.output_file_written', { agentId: targetId, taskFolderName, path: safePath });
        ctx.sendToSaas({
          action: 'task_complete',
          agentId: targetId,
          taskFolderName,
          source: 'output_file',
        });
      }
    }
  }
}

export async function handleDeletePath(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { requestId, path: relPath, useCtrlnode } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];
  const basePath = useCtrlnode ? ctrlnodePath : agentInfo?.workspace;

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
    logger.info('delete_path', { agentId: useCtrlnode ? 'CTRLNODE' : targetId, path: safePath });
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: true, error: null });
  } catch (err: any) {
    logger.warn('delete_path.failed', { agentId: useCtrlnode ? 'CTRLNODE' : targetId, path: safePath, error: err?.message });
    ctx.sendToSaas({ action: 'delete_path_ack', requestId, success: false, error: err?.message ?? 'DELETE_FAILED' });
  }
}

export function handleReadFile(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, path: relPath, useCtrlnode } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  const basePath = useCtrlnode ? ctrlnodePath : agentInfo?.workspace;
  if (!basePath) {
    ctx.sendToSaas({ action: 'read_file_response', requestId, error: 'BASE_PATH_NOT_FOUND' });
    return;
  }

  const safePath = sanitizeRelPath(relPath!);
  const fullPath = path.join(basePath, safePath);

  if (!path.resolve(fullPath).startsWith(path.resolve(basePath))) {
    ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content: null, error: 'INVALID_PATH' });
    return;
  }

  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content: null, error: 'FILE_NOT_FOUND' });
    return;
  }

  const { content, contentType, error } = readFileForBridge(fullPath);
  ctx.sendToSaas({ action: 'read_file_response', requestId, agentId: targetId, path: safePath, content, contentType, error: error ?? undefined });
  logger.info('read_file', { agentId: useCtrlnode ? 'CTRLNODE' : targetId, path: safePath, contentType, error: error ?? undefined });
}

export function handleListFiles(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, subpath, useCtrlnode } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  if (!agentInfo && !useCtrlnode) {
    ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'AGENT_NOT_FOUND' });
    return;
  }

  const baseDir = useCtrlnode ? ctrlnodePath : agentInfo!.workspace;
  let targetDir = baseDir;
  let basePath = '';

  if (subpath) {
    const normalized = path.normalize(subpath);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'INVALID_PATH' });
      return;
    }
    targetDir = path.join(baseDir, normalized);
    basePath = normalized;

    if (!path.resolve(targetDir).startsWith(path.resolve(baseDir))) {
      ctx.sendToSaas({ action: 'list_files_response', requestId, files: [], error: 'INVALID_PATH' });
      return;
    }
  }

  const files = walkDir(targetDir, basePath);
  ctx.sendToSaas({ action: 'list_files_response', requestId, agentId: targetId, files });
  logger.info('list_files', { agentId: useCtrlnode ? 'CTRLNODE' : targetId, subpath: subpath || '/', entries: files.length });
}

export function handleCreateWorkspace(msg: BridgeMessage, ctx: HandlerContext): void {
  const { requestId, folderName, files, useCtrlnode } = msg;

  if (!folderName) {
    ctx.sendToSaas({ action: 'create_workspace_response', requestId, workspacePath: null, success: false, error: 'MISSING_FOLDER_NAME' });
    return;
  }

  try {
    const basePath = useCtrlnode ? ctrlnodePath : path.dirname(OPENCLAW_CONFIG);
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

    logger.info('create_workspace', { folderName, workspacePath, files: (files || []).length });
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
    logger.info('sync_config', { path: OPENCLAW_CONFIG });
    ctx.syncAgents();
    ctx.sendToSaas({ action: 'sync_config_ack', requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: 'sync_config_ack', requestId, success: false, error: err.message });
  }
}

export function handleUpdateAgentConfig(msg: BridgeMessage, ctx: HandlerContext): void {
  const { agentId, name, model, workspace } = msg;
  upsertAgentConfig(normalizeAgentId(agentId), { name, model, workspace });
  ctx.syncAgents();
}

export async function handleDeleteAgentFolders(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { requestId, agentId, folderName } = msg;

  if (!folderName) {
    ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success: false, deleted: [], errors: ['NO_FOLDER_SPECIFIED'] });
    return;
  }

  const deleted: string[] = [];
  const errors: string[] = [];

  const resolved = path.resolve(folderName);
  if (!resolved.startsWith('/app/')) {
    errors.push(`UNSAFE_PATH: ${folderName}`);
    logger.warn('delete_agent_folders.blocked', { folder: folderName, reason: 'outside /app/' });
    ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success: false, deleted, errors });
    return;
  }

  const ok = await deleteDir(resolved);
  if (ok) {
    deleted.push(resolved);
    logger.info('delete_agent_folders.deleted', { agentId, folder: resolved });
  } else {
    errors.push(`DELETE_FAILED: ${resolved}`);
    logger.warn('delete_agent_folders.failed', { agentId, folder: resolved });
  }

  const success = errors.length === 0;
  ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success, deleted, errors });
}

export function handleDeleteAgentConfig(msg: BridgeMessage, ctx: HandlerContext): void {
  const deleted = deleteAgentConfig(normalizeAgentId(msg.agentId));
  if (deleted) ctx.syncAgents();
}

/**
 * Atomically activates a pipeline task on local disk:
 *  1. Copy ctrlnode/{predecessorTaskFolderName}/output/* → ctrlnode/{nextTaskFolderName}/input/{shortPredName}/
 *  2. Ensure ctrlnode/{nextTaskFolderName}/output/.gitkeep exists
 *
 * All task files live in ctrlnode/tasks/ regardless of assignment state (Option A).
 * No unassigned folder copying — the task was already in ctrlnode since creation.
 */
export function handleActivatePipelineTask(msg: BridgeMessage, ctx: HandlerContext): void {
  const {
    requestId,
    predecessorAgentId,
    predecessorTaskFolderName,
    nextTaskAgentId,
    nextTaskFolderName,
  } = msg;

  if (!requestId || !predecessorAgentId || !predecessorTaskFolderName || !nextTaskAgentId || !nextTaskFolderName) {
    ctx.sendToSaas({ action: 'activate_pipeline_task_response', requestId, success: false, error: 'INVALID_REQUEST', filesCopied: 0 });
    return;
  }

  try {
    let filesCopied = 0;
    const safeNextFolder    = sanitizeRelPath(nextTaskFolderName);
    const safePredFolder    = sanitizeRelPath(predecessorTaskFolderName);

    // ── Step 1: copy predecessor output → next task input/{shortPredName}/ ──
    const predOutputDir     = path.join(ctrlnodePath, safePredFolder, 'output');
    const shortPredName     = safePredFolder.split('/').pop()!;
    const nextPredInputDir  = path.join(ctrlnodePath, safeNextFolder, 'input', shortPredName);

    if (path.resolve(predOutputDir).startsWith(path.resolve(ctrlnodePath)) && fs.existsSync(predOutputDir)) {
      ensureDir(nextPredInputDir);
      for (const entry of walkDir(predOutputDir, '')) {
        if (entry.type !== 'file') continue;
        const filename = path.basename(entry.path);
        if (filename === '.gitkeep') continue;
        const src  = path.join(predOutputDir, entry.path);
        const dest = path.join(nextPredInputDir, entry.path);
        ensureDir(path.dirname(dest));
        // Strip status tags so the next agent does not see stale completion signals from predecessor.
        try {
          const raw     = fs.readFileSync(src, 'utf8');
          const stripped = raw.replace(/<TASK_(?:COMPLETED|FAILED|BLOCKED):[a-f0-9-]+>/gi, '').trimEnd();
          fs.writeFileSync(dest, stripped + '\n', 'utf8');
        } catch {
          fs.copyFileSync(src, dest);
        }
        filesCopied++;
      }
    }

    // ── Step 2: ensure output/.gitkeep in next task folder ─────────────────
    const outputGitkeep = path.join(ctrlnodePath, safeNextFolder, 'output', '.gitkeep');
    ensureDir(path.dirname(outputGitkeep));
    if (!fs.existsSync(outputGitkeep)) {
      fs.writeFileSync(outputGitkeep, '', 'utf8');
    }

    logger.info('activate_pipeline_task', {
      predecessorAgentId,
      predecessorTaskFolderName,
      nextTaskAgentId,
      nextTaskFolderName,
      filesCopied,
    });

    ctx.sendToSaas({ action: 'activate_pipeline_task_response', requestId, success: true, error: null, filesCopied });
  } catch (err: any) {
    logger.warn('activate_pipeline_task.failed', { requestId, error: err?.message });
    ctx.sendToSaas({ action: 'activate_pipeline_task_response', requestId, success: false, error: err?.message ?? 'ACTIVATE_FAILED', filesCopied: 0 });
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

  // taskFolderName is like "tasks/a9147f93-plannner" — check its output subdirectory
  // Ctrlnode agents write output to ctrlnode/tasks/{id}/output, not to their own workspace.
  const basePath = isAgentInCtrlnode(targetId!) ? ctrlnodePath : agentInfo.workspace;
  const outputDir = path.join(basePath, taskFolderName, 'output');
  let hasOutput = false;
  if (fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir).filter(f => !SCAFFOLD_ONLY_FILES.has(f));
    hasOutput = files.length > 0;
  }

  logger.info('check_task_output', { agentId: targetId, taskFolderName, outputDir, hasOutput });
  ctx.sendToSaas({ action: 'check_task_output_result', agentId: targetId, taskFolderName, hasOutput });
}
