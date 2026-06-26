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
import { logger } from '../logger.js';
import { CTRLNODE_ROOT } from '../config.js';
import { getKnownModels } from '../modelManifest.js';

// ── Shared model-listing helpers ──────────────────────────────────────────────

/** Fetch available model IDs from the Anthropic API. Falls back to manifest/known models when no API key is set. */
export async function fetchAnthropicModels(apiKey: string): Promise<string[]> {
  if (!apiKey) return getKnownModels('claude');
  try {
    const resp = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return getKnownModels('claude');
    const data = await resp.json() as any;
    const ids = ((data.data ?? []) as any[]).map((m: any) => m.id as string).filter(Boolean).sort();
    return ids.length > 0 ? ids : getKnownModels('claude');
  } catch {
    return getKnownModels('claude');
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

// ── ACP filesystem sandbox ────────────────────────────────────────────────────

/**
 * Resolves `filePath` relative to `sandboxRoot` and returns the absolute path
 * only if it stays inside the sandbox. Returns null for any path that escapes.
 */
export function resolveSecurePath(filePath: string, sandboxRoot: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(sandboxRoot, filePath);
  const normalRoot = path.resolve(sandboxRoot);
  return resolved.startsWith(normalRoot + path.sep) || resolved === normalRoot
    ? resolved
    : null;
}

// ── Inactivity timer ─────────────────────────────────────────────────────────

/**
 * Creates a self-resetting inactivity timer shared by all provider implementations.
 *
 * The timer fires `onTimeout` if no call to `reset()` arrives within `timeoutMs`.
 * Call `reset()` on every received message/event so an actively working agent is
 * never killed by a fixed wall-clock timeout. Call `clear()` when the task
 * finishes to cancel any pending fire.
 */
export function createInactivityTimer(
  timeoutMs: number,
  onTimeout: () => void,
): { reset(): void; clear(): void; readonly fired: boolean } {
  let handle: ReturnType<typeof setTimeout>;
  let _fired = false;
  const reset = () => {
    clearTimeout(handle);
    handle = setTimeout(() => { _fired = true; onTimeout(); }, timeoutMs);
  };
  reset();
  return {
    reset,
    clear: () => clearTimeout(handle),
    get fired() { return _fired; },
  };
}

// ── Combined "done" helper ────────────────────────────────────────────────────

/**
 * Write task output files at the end of a provider run.
 *
 * Rules:
 *  - The fallback `*-output.md` is only written when the agent did NOT already
 *    produce that file on disk (avoids duplicates when the agent used file tools).
 *  - `agent_log.md` is always written so the conversation is persisted.
 *  - When `activityLogText` is set, it is used for `agent_log.md` instead of
 *    `accumulatedText` (final chat reply only), so tool lines are not lost.
 *
 * @param taskFolderName  Relative path from CTRLNODE_ROOT, e.g. "tasks/cursorp/05-06/abc-task".
 * @param logPrefix       Provider-specific log prefix for structured logging.
 * @param activityLogText Optional full Agent Activity transcript (tools + chunks).
 */
export function writeTaskOutputs(
  taskId: string,
  taskFolderName: string,
  accumulatedText: string,
  logPrefix: string,
  activityLogText?: string,
): void {
  if (!taskFolderName) return;

  const taskFullPath = path.join(CTRLNODE_ROOT, taskFolderName);
  const folderBasename = path.basename(taskFolderName);
  const expectedOutputFile = path.join(taskFullPath, 'output', `${folderBasename}-output.md`);

  if (accumulatedText.trim() && !fs.existsSync(expectedOutputFile)) {
    writeOutputFile(taskId, taskFullPath, folderBasename, accumulatedText, logPrefix);
  }

  const logBody = (activityLogText?.trim() || accumulatedText.trim());
  if (logBody) {
    writeAgentLog(taskId, taskFullPath, logBody, logPrefix);
  }
}

// ── Followup file preparation (shared across all providers) ───────────────────

export interface FollowupFileResult {
  /** Absolute path to the written input file (e.g. .../input/ea94c3f8-followup-2.md) */
  followupInputFile: string;
  /** CtrlNode-relative output path the agent should write to (e.g. tasks/.../output/ea94c3f8-followup-2-output.md) */
  followupOutputRel: string;
  /** Instruction block to inject into the agent prompt (output file instruction only) */
  followupLogBlock: string;
  /** Same as followupLogBlock but also includes the agent_log.md content as prior-context */
  followupLogBlockWithHistory: string;
  /** Sequential number used (1-based) */
  followupN: number;
  /** Base name without extension (e.g. "ea94c3f8-followup-2") */
  followupBaseName: string;
}

/**
 * Writes the followup input file to disk and returns naming info.
 * Called by intentHandlers before dispatching to any provider so all providers
 * get consistent followup file handling without duplicating this logic.
 *
 * `followupLogBlock`            — output-file instruction only (for providers with native session resume)
 * `followupLogBlockWithHistory` — same + agent_log.md content prepended (for stateless providers)
 */
export function prepareFollowupFiles(
  taskId: string,
  message: string,
  taskFolderName: string | undefined,
): FollowupFileResult {
  const taskFolderAbs = taskFolderName
    ? path.join(CTRLNODE_ROOT, taskFolderName)
    : path.join(CTRLNODE_ROOT, 'tasks', taskId);

  const folderBasename = taskFolderName ? path.basename(taskFolderName) : taskId.slice(0, 8);
  const shortId = folderBasename.split('-')[0] ?? taskId.slice(0, 8);

  const inputDir = path.join(taskFolderAbs, 'input');
  fs.mkdirSync(inputDir, { recursive: true });

  const existingFollowups = fs.existsSync(inputDir)
    ? fs.readdirSync(inputDir).filter(f => f.match(/^[^-]+-followup-\d+\.md$/)).length
    : 0;
  const followupN = existingFollowups + 1;
  const followupBaseName = `${shortId}-followup-${followupN}`;
  const followupInputFile = path.join(inputDir, `${followupBaseName}.md`);
  const followupOutputRel = taskFolderName
    ? `${taskFolderName}/output/${followupBaseName}-output.md`
    : `tasks/${taskId}/output/${followupBaseName}-output.md`;

  try {
    fs.writeFileSync(followupInputFile, message, 'utf-8');
    logger.info('followup_files.input_written', { taskId, file: `${followupBaseName}.md`, n: followupN });
  } catch (e: any) {
    logger.warn('followup_files.input_write_failed', { taskId, error: e?.message });
  }

  const followupLogBlock = `## Follow-up output file\n\nWrite your follow-up result to this file using the Write tool:\n\`${followupOutputRel}\``;

  // Try to load agent_log.md from the previous run so stateless providers have prior context.
  const agentLogPath = path.join(taskFolderAbs, 'output', 'agent_log.md');
  let followupLogBlockWithHistory = followupLogBlock;
  try {
    if (fs.existsSync(agentLogPath)) {
      const logContent = fs.readFileSync(agentLogPath, 'utf-8').trim();
      if (logContent) {
        followupLogBlockWithHistory =
          `## Prior task conversation log\n\nThe following is the conversation log from the previous task run. Use it as context to understand what was already done before responding to the follow-up.\n\n${logContent}\n\n---\n\n${followupLogBlock}`;
        logger.info('followup_files.history_loaded', { taskId, logBytes: logContent.length });
      }
    }
  } catch (e: any) {
    logger.warn('followup_files.history_load_failed', { taskId, error: e?.message });
  }

  return { followupInputFile, followupOutputRel, followupLogBlock, followupLogBlockWithHistory, followupN, followupBaseName };
}
