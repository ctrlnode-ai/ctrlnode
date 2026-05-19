/**
 * providerFileUtils.ts
 *
 * Shared file-writing utilities for all provider implementations.
 * Centralises output-file, agent-log, and status-tag detection logic
 * so each provider keeps its own prompt/runtime logic without duplicating
 * the filesystem bookkeeping.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../logger';
import { AGENTS_CTRLNODE_ROOT } from '../config';

// ── Shared model-listing helpers ──────────────────────────────────────────────

/** Fetch available model IDs from the Anthropic API. Returns [] on any failure. */
export async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return [];
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    return ((data.data ?? []) as any[]).map((m: any) => m.id as string).filter(Boolean).sort();
  } catch {
    return [];
  }
}

/** Fetch available model IDs from the OpenAI-compatible API. Returns [] on any failure. */
export async function fetchOpenAiCompatibleModels(
  apiKey: string,
  baseUrl = 'https://api.openai.com',
  filterFn?: (id: string) => boolean,
): Promise<string[]> {
  if (!apiKey) return [];
  const defaultFilter = (id: string) => /^(gpt-4|gpt-3\.5|o[1-9]|codex)/i.test(id);
  const keep = filterFn ?? defaultFilter;
  try {
    const resp = await fetch(`${baseUrl}/v1/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as any;
    return ((data.data ?? []) as any[])
      .map((m: any) => m.id as string)
      .filter((id: string) => id && keep(id))
      .sort();
  } catch {
    return [];
  }
}

// ── Status tag detection ──────────────────────────────────────────────────────

export function detectStatusTag(text: string): { status: 'completed' | 'failed' | 'blocked'; reason?: string } {
  if (/<TASK_COMPLETED:[^>]+>/.test(text)) return { status: 'completed' };
  if (/<TASK_BLOCKED:[^>]+>/.test(text))   return { status: 'blocked',   reason: 'Agent reported blocked' };
  if (/<TASK_FAILED:[^>]+>/.test(text))    return { status: 'failed',    reason: 'Agent reported failure' };
  return { status: 'completed' };
}

// ── Low-level writers ─────────────────────────────────────────────────────────

/**
 * Write the fallback output markdown file to `<taskFolderPath>/output/<folderBasename>-output.md`.
 * @param logPrefix  Provider-specific log prefix, e.g. "cursor_sdk" or "gemini_acp".
 */
export function writeOutputFile(
  taskId: string,
  taskFolderPath: string,
  folderBasename: string,
  text: string,
  logPrefix: string,
): void {
  try {
    const outputDir = path.join(taskFolderPath, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const outFile = path.join(outputDir, `${folderBasename}-output.md`);
    fs.writeFileSync(outFile, text, 'utf8');
    logger.debug(`${logPrefix}.output_file_written`, { taskId, path: outFile });
  } catch (err: any) {
    logger.warn(`${logPrefix}.output_file_write_failed`, { taskId, error: err.message });
  }
}

/**
 * Write the agent conversation log to `<taskFolderPath>/output/agent_log.md`.
 * @param logPrefix  Provider-specific log prefix, e.g. "cursor_sdk" or "gemini_acp".
 */
export function writeAgentLog(
  taskId: string,
  taskFolderPath: string,
  text: string,
  logPrefix: string,
): void {
  try {
    const outputDir = path.join(taskFolderPath, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const logFile = path.join(outputDir, 'agent_log.md');
    fs.writeFileSync(logFile, text, 'utf8');
    logger.debug(`${logPrefix}.agent_log_written`, { taskId, path: logFile });
  } catch (err: any) {
    logger.warn(`${logPrefix}.agent_log_write_failed`, { taskId, error: err.message });
  }
}

// ── Combined "done" helper ────────────────────────────────────────────────────

/**
 * Write task output files at the end of a provider run.
 *
 * Rules:
 *  - The fallback `*-output.md` is only written when the agent did NOT already
 *    produce that file on disk (avoids duplicates when the agent used file tools).
 *  - `agent_log.md` is always written so the conversation is persisted.
 *
 * @param taskFolderName  Relative path from AGENTS_CTRLNODE_ROOT, e.g. "tasks/cursorp/05-06/abc-task".
 * @param logPrefix       Provider-specific log prefix for structured logging.
 */
export function writeTaskOutputs(
  taskId: string,
  taskFolderName: string,
  accumulatedText: string,
  logPrefix: string,
): void {
  if (!taskFolderName || !accumulatedText.trim()) return;

  const taskFullPath = path.join(AGENTS_CTRLNODE_ROOT, taskFolderName);
  const folderBasename = path.basename(taskFolderName);
  const expectedOutputFile = path.join(taskFullPath, 'output', `${folderBasename}-output.md`);

  if (!fs.existsSync(expectedOutputFile)) {
    writeOutputFile(taskId, taskFullPath, folderBasename, accumulatedText, logPrefix);
  }
  writeAgentLog(taskId, taskFullPath, accumulatedText, logPrefix);
}
