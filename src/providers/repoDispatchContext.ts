/**
 * Shared WORK DIRECTORY (repo) vs OUTPUT ONLY dispatch paths for all Bridge providers.
 */
import path from 'path';
import { CTRLNODE_ROOT } from '../config.js';
import type { DispatchTaskParams } from './IProvider.js';

export const TASK_LOG_SYSTEM_BLOCK_HEADER = '## Task log file (mandatory, outside repository)';

export function isRepoTaskMode(params: Pick<DispatchTaskParams, 'taskMode' | 'repoPath'>): boolean {
  return params.taskMode === 'repo' && Boolean(params.repoPath?.trim());
}

export function resolveTaskPaths(
  taskFolderName: string | undefined,
  taskId: string,
): { taskFolder: string; outputFolder: string } {
  const taskFolder = taskFolderName
    ? path.join(CTRLNODE_ROOT, taskFolderName)
    : path.join(CTRLNODE_ROOT, 'tasks', taskId || `task-${Date.now()}`);
  return { taskFolder, outputFolder: path.join(taskFolder, 'output') };
}

/**
 * Path for the Claude SDK session-id persistence file (resume-after-restart).
 * Lives inside the task's real folder — the same location output/CLAUDE.md use —
 * so it only falls back to a flat `tasks/<taskId>/` directory when taskFolderName
 * is genuinely unavailable, instead of always bypassing the real nested folder.
 */
export function resolveSessionFilePath(taskFolderName: string | undefined, taskId: string): string {
  const { taskFolder } = resolveTaskPaths(taskFolderName, taskId);
  return path.join(taskFolder, 'session_id');
}

export function resolveTaskLogAbsolutePath(taskLogRelativePath: string | undefined): string | null {
  if (!taskLogRelativePath?.trim()) return null;
  const rel = taskLogRelativePath.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return path.join(CTRLNODE_ROOT, rel);
}

export function buildTaskLogSystemBlock(taskLogRelativePath: string | undefined): string | undefined {
  const abs = resolveTaskLogAbsolutePath(taskLogRelativePath);
  if (!abs) return undefined;
  return (
    `${TASK_LOG_SYSTEM_BLOCK_HEADER}\n\n`
    + `Write your summary with the Write tool to this **absolute** path:\n\`${abs}\`\n\n`
    + 'Do not save this file inside the repository working tree.'
  );
}

/** Prepends task-log instructions when the SaaS template did not already include them. */
export function augmentPromptForRepoMode(prompt: string, params: DispatchTaskParams): string {
  if (!isRepoTaskMode(params)) return prompt;
  const block = buildTaskLogSystemBlock(params.taskLogRelativePath);
  if (!block) return prompt;
  if (prompt.includes(TASK_LOG_SYSTEM_BLOCK_HEADER)) return prompt;
  return `${block}\n\n---\n\n${prompt}`;
}

export function uniqueDirectories(dirs: string[]): string[] {
  return dirs.filter((d, i, arr) => arr.indexOf(d) === i);
}

export interface RepoDispatchSpawnContext {
  isRepoMode: boolean;
  taskFolder: string;
  outputFolder: string;
  /** Process / SDK working directory for this dispatch. */
  spawnCwd: string;
  taskLogAbsolutePath: string | null;
  /** Writable/readable extra roots (task folder + ctrlnode in repo mode). */
  extraDirectories: string[];
}

export function resolveRepoDispatchSpawn(
  params: DispatchTaskParams,
  outputModeCwd: string,
): RepoDispatchSpawnContext {
  const { taskFolder, outputFolder } = resolveTaskPaths(params.taskFolderName, params.taskId);
  const isRepoMode = isRepoTaskMode(params);
  return {
    isRepoMode,
    taskFolder,
    outputFolder,
    spawnCwd: isRepoMode ? path.resolve(params.workingDir || params.repoPath!) : outputModeCwd,
    taskLogAbsolutePath: resolveTaskLogAbsolutePath(params.taskLogRelativePath),
    extraDirectories: isRepoMode
      ? uniqueDirectories([taskFolder, CTRLNODE_ROOT])
      : uniqueDirectories([taskFolder]),
  };
}

export function appendTaskLogToSystemParts(parts: string[], params: DispatchTaskParams): void {
  if (!isRepoTaskMode(params)) return;
  const block = buildTaskLogSystemBlock(params.taskLogRelativePath);
  if (!block) return;
  if (parts.some((p) => p.includes(TASK_LOG_SYSTEM_BLOCK_HEADER))) return;
  parts.push(block);
}
