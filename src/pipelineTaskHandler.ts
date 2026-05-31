/**
 * @file pipelineTaskHandler.ts
 * @description Handler for the `activate_pipeline_task` Bridge message.
 *
 * Atomically activates a pipeline task on local disk:
 *  1. Copy ctrlnode/{predecessorTaskFolderName}/output/* → ctrlnode/{nextTaskFolderName}/input/{shortPredName}/
 *  2. Ensure ctrlnode/{nextTaskFolderName}/output/.gitkeep exists
 *
 * All task files live in ctrlnode/tasks/ regardless of assignment state (Option A).
 * No unassigned folder copying — the task was already in ctrlnode since creation.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { ctrlnodePath } from './config.js';
import { ensureDir, walkDir, sanitizeRelPath } from './fileSystem.js';

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
    const safeNextFolder = sanitizeRelPath(nextTaskFolderName);
    const safePredFolder = sanitizeRelPath(predecessorTaskFolderName);

    // ── Step 1: copy predecessor output → next task input/{shortPredName}/ ──
    const predOutputDir    = path.join(ctrlnodePath, safePredFolder, 'output');
    const shortPredName    = safePredFolder.split('/').pop()!;
    const nextPredInputDir = path.join(ctrlnodePath, safeNextFolder, 'input', shortPredName);

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

    logger.debug('activate_pipeline_task', {
      predecessorAgentId, predecessorTaskFolderName,
      nextTaskAgentId, nextTaskFolderName, filesCopied,
    });

    ctx.sendToSaas({ action: 'activate_pipeline_task_response', requestId, success: true, error: null, filesCopied });
  } catch (err: any) {
    logger.warn('activate_pipeline_task.failed', { requestId, error: err?.message });
    ctx.sendToSaas({ action: 'activate_pipeline_task_response', requestId, success: false, error: err?.message ?? 'ACTIVATE_FAILED', filesCopied: 0 });
  }
}
