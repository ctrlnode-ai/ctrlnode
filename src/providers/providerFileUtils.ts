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

// ── Per-execution agent log naming ────────────────────────────────────────────

/**
 * Counts existing followup input files (`<shortId>-followup-<N>.md`) under
 * `<taskFolderAbs>/input` to determine which followup number is in progress.
 * Shared by `prepareFollowupFiles` (writing the next followup's input) and the
 * agent-log naming helpers below (so both agree on the same N without
 * duplicating the globbing logic).
 */
function countExistingFollowups(taskFolderAbs: string): number {
  const inputDir = path.join(taskFolderAbs, 'input');
  return fs.existsSync(inputDir)
    ? fs.readdirSync(inputDir).filter(f => f.match(/^[^-]+-followup-\d+\.md$/)).length
    : 0;
}

/**
 * Returns the agent-log file name for a given followup number: `agent_log.md`
 * for the initial run (n === 0), `agent_log.followup-N.md` for followup N.
 * Each execution (initial run or a given followup) gets its own log file
 * instead of every run overwriting the same `agent_log.md`, which previously
 * made Agent Activity show the most recent turn's content stomped over (or,
 * when a prior-history block was prepended into the prompt, interleaved with)
 * earlier turns.
 */
export function agentLogFileNameForFollowup(followupN: number): string {
  return followupN > 0 ? `agent_log.followup-${followupN}.md` : 'agent_log.md';
}

/**
 * Resolves the agent-log file name for the CURRENT execution of a task, based
 * on how many followups already exist on disk. Call this once at the start of
 * a run/followup dispatch — the same value must be used for the write at the
 * end of that turn.
 */
export function resolveCurrentAgentLogFileName(taskFolderAbs: string): string {
  return agentLogFileNameForFollowup(countExistingFollowups(taskFolderAbs));
}

/**
 * Reads and concatenates ALL agent logs for a task (initial run + every
 * followup, in order) so a stateless provider's prompt can carry full prior
 * context across followups — as opposed to only the latest turn's log, which
 * would lose earlier turns entirely once per-turn log files were introduced.
 * Returns '' if no logs exist yet.
 */
export function readAllAgentLogsForContext(taskFolderAbs: string): string {
  const outputDir = path.join(taskFolderAbs, 'output');
  if (!fs.existsSync(outputDir)) return '';

  const followupCount = countExistingFollowups(taskFolderAbs);
  const parts: string[] = [];
  for (let n = 0; n <= followupCount; n++) {
    const file = path.join(outputDir, agentLogFileNameForFollowup(n));
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf-8').trim();
        if (content) parts.push(content);
      }
    } catch {
      // skip unreadable log, keep collecting the rest
    }
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Write the agent conversation log to `<taskFolderPath>/output/<logFileName>`.
 * @param logFileName  File name for this execution's log — use
 *   `resolveCurrentAgentLogFileName` (or `agentLogFileNameForFollowup`) so each
 *   run/followup gets its own file instead of overwriting the previous one.
 *   Defaults to `agent_log.md` for callers that haven't been updated to pass it
 *   explicitly (single-execution providers with no followup concept yet).
 * @param logPrefix  Provider-specific log prefix, e.g. "cursor_sdk" or "gemini_acp".
 */
export function writeAgentLog(
  taskId: string,
  taskFolderPath: string,
  text: string,
  logPrefix: string,
  logFileName: string = 'agent_log.md',
): void {
  try {
    const outputDir = path.join(taskFolderPath, 'output');
    fs.mkdirSync(outputDir, { recursive: true });
    const logFile = path.join(outputDir, logFileName);
    fs.writeFileSync(logFile, text, 'utf8');
    logger.debug(`${logPrefix}.agent_log_written`, { taskId, path: logFile });
  } catch (err: any) {
    logger.warn(`${logPrefix}.agent_log_write_failed`, { taskId, error: err.message });
  }
}

// ── ACP filesystem sandbox ────────────────────────────────────────────────────

/**
 * Strips a redundant leading prefix from `filePath` when the model has (incorrectly)
 * re-specified the sandbox's own trailing path segments, e.g. calling `write_file` with
 * `tasks/openr/07-09/abc-task/output/x.html` while already running inside
 * `.../tasks/openr/07-09/abc-task` — this otherwise doubles the directory
 * (`.../abc-task/tasks/openr/07-09/abc-task/output/x.html`). Confirmed real behavior
 * from openai/gpt-5-nano via OpenRouter. Only strips when the match is anchored at a
 * path-segment boundary (not a partial directory-name match), and only compares
 * against the FULL sandbox path (or any suffix of it split on segment boundaries) so a
 * merely similar-looking but unrelated relative path is left untouched.
 */
function stripRedundantSandboxPrefix(filePath: string, sandboxRoot: string): string {
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const rootSegments = path.resolve(sandboxRoot).split(path.sep).filter(Boolean);
  const pathSegments = normalizedPath.split('/').filter(Boolean);

  for (let take = Math.min(rootSegments.length, pathSegments.length); take > 0; take--) {
    const rootSuffix = rootSegments.slice(rootSegments.length - take);
    const pathPrefix = pathSegments.slice(0, take);
    if (rootSuffix.every((seg, i) => seg === pathPrefix[i])) {
      return pathSegments.slice(take).join('/');
    }
  }
  return normalizedPath;
}

/**
 * Resolves `filePath` relative to `sandboxRoot` and returns the absolute path
 * only if it stays inside the sandbox. Returns null for any path that escapes.
 */
export function resolveSecurePath(filePath: string, sandboxRoot: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(sandboxRoot, stripRedundantSandboxPrefix(filePath, sandboxRoot));
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

/** Appends one bounded, typed progress entry to the execution log. */
export function appendTaskProgressLog(taskFolderName: string | undefined, kind: string, text?: string, filePath?: string): void {
  if (!taskFolderName) return;
  const taskFullPath = path.join(CTRLNODE_ROOT, taskFolderName);
  const logFile = path.join(taskFullPath, 'output', resolveCurrentAgentLogFileName(taskFullPath));
  const detail = (text || filePath || '').slice(0, 8_000);
  if (!detail) return;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n[${new Date().toISOString()}] ${kind.toUpperCase()}\n${detail}\n`, 'utf8');
  } catch (error: any) {
    logger.warn('task_progress_log_write_failed', { taskFolderName, kind, error: error?.message });
  }
}

// ── Combined "done" helper ────────────────────────────────────────────────────

/**
 * Write task output files at the end of a provider run.
 *
 * Rules:
 *  - The fallback `*-output.md` is only written when the agent did NOT already
 *    produce that file on disk (avoids duplicates when the agent used file tools).
 *  - The agent log for this execution is always written so the conversation is
 *    persisted — as `agent_log.md` for the initial run, or
 *    `agent_log.followup-N.md` for followup N (see `resolveCurrentAgentLogFileName`),
 *    so each execution keeps its own log instead of overwriting the previous one.
 *  - When `activityLogText` is set, it is used for the log instead of
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
    const logFileName = resolveCurrentAgentLogFileName(taskFullPath);
    writeAgentLog(taskId, taskFullPath, logBody, logPrefix, logFileName);
  }
}

// ── Stale-session recovery (shared across stateful providers) ─────────────────

/**
 * True when `text` (a stderr blob or SDK error message) indicates the provider's
 * native session store no longer has the requested conversation — e.g. the
 * Claude CLI's "No conversation found with session ID: ..." error. Providers
 * that resume via a native session id (not the stateless followup log block)
 * use this to detect a stale `resumeSessionId` and retry as a fresh session.
 */
export function isStaleSessionError(text: string): boolean {
  if (!text) return false;
  return /no\s+conversation\s+found\s+with\s+session/i.test(text);
}

/**
 * Builds a recovery prompt for a follow-up whose native session resume failed
 * because the provider no longer recognizes the session id. Prepends every
 * prior execution's agent-log content (initial run + all followups so far, in
 * order — not just the current turn's not-yet-written log) so the agent
 * regains full context despite starting a brand-new session instead of truly
 * resuming.
 *
 * @param agentLogPathOrTaskFolder  Accepts either a direct path to a single
 *   agent-log file (legacy single-execution callers) or the task's absolute
 *   folder (preferred — reads and concatenates ALL per-execution logs via
 *   `readAllAgentLogsForContext`). Detected by checking whether the path's
 *   basename looks like an agent-log file name.
 */
export function buildStaleSessionRecoveryPrompt(agentLogPathOrTaskFolder: string, originalPrompt: string): string {
  try {
    const isDirectLogFile = /^agent_log(\.followup-\d+)?\.md$/.test(path.basename(agentLogPathOrTaskFolder));
    const logContent = isDirectLogFile
      ? (fs.existsSync(agentLogPathOrTaskFolder) ? fs.readFileSync(agentLogPathOrTaskFolder, 'utf-8').trim() : '')
      : readAllAgentLogsForContext(agentLogPathOrTaskFolder);

    if (logContent) {
      return `## Prior task conversation log\n\nThe previous conversation history is unavailable (session expired), so this is a new session. The following is the conversation log from every previous run of this task, in order. Use it as context to understand what was already done before responding.\n\n${logContent}\n\n---\n\n${originalPrompt}`;
    }
  } catch {
    // fall through to plain prompt
  }
  return originalPrompt;
}

// ── Followup file preparation (shared across all providers) ───────────────────

export interface FollowupFileResult {
  /** Absolute path to the written input file (e.g. .../input/ea94c3f8-followup-2.md) */
  followupInputFile: string;
  /** CtrlNode-relative output path the agent should write to (e.g. tasks/.../output/ea94c3f8-followup-2-output.md) */
  followupOutputRel: string;
  /** Instruction block to inject into the agent prompt (context + output file guidance) */
  followupLogBlock: string;
  /** Same as followupLogBlock but also includes the full prior agent-log history (every execution's log, in order) as context */
  followupLogBlockWithHistory: string;
  /** Sequential number used (1-based) */
  followupN: number;
  /** Base name without extension (e.g. "ea94c3f8-followup-2") */
  followupBaseName: string;
}

export interface FollowupContextOptions {
  taskMode?: string;
  repoPath?: string;
  focusFiles?: string[];
}

/**
 * Re-states the durable task context for a follow-up turn. Native sessions keep
 * their history, but stateless providers and recovered sessions still need the
 * same repository/input guidance that the initial task template contained.
 */
export function buildFollowupContextBlock(
  taskFolderAbs: string,
  options: FollowupContextOptions = {},
): string {
  const inputPath = path.join(taskFolderAbs, 'input');
  const lines = [
    '## Original task context',
    '',
    'This is a continuation of the existing task, not a standalone request. Before acting, review the original task instructions and the context already attached to it. Preserve its constraints and use the previous work as context.',
    '',
    `Original task input and context files are under: \`${inputPath}\``,
    'Read the original task input and any relevant files from that folder before responding.',
  ];

  if (options.taskMode === 'repo' && options.repoPath?.trim()) {
    lines.push(
      '',
      '## Repository context',
      '',
      `Continue working in the same project work directory: \`${options.repoPath.trim()}\``,
      'Use the full work directory as context; do not treat this follow-up as an output-only task.',
    );

    const focusFiles = (options.focusFiles ?? []).filter((value) => value.trim());
    if (focusFiles.length > 0) {
      lines.push(
        '',
        'Start by reviewing these prioritized files or folders:',
        ...focusFiles.map((value) => `- \`${value.trim()}\``),
        '',
        'You still have access to the full work directory and may explore beyond these paths when needed.',
      );
    }
  }

  lines.push(
    '',
    'If this follow-up contains @ file or folder references, inspect those references before completing the request.',
  );
  return lines.join('\n');
}

/**
 * Writes the followup input file to disk and returns naming info.
 * Called by intentHandlers before dispatching to any provider so all providers
 * get consistent followup file handling without duplicating this logic.
 *
 * `followupLogBlock`            — task-context + output-file instructions (for providers with native session resume)
 * `followupLogBlockWithHistory` — same + full prior agent-log history prepended (for stateless providers)
 */
export function prepareFollowupFiles(
  taskId: string,
  message: string,
  taskFolderName: string | undefined,
  context: FollowupContextOptions = {},
): FollowupFileResult {
  const taskFolderAbs = taskFolderName
    ? path.join(CTRLNODE_ROOT, taskFolderName)
    : path.join(CTRLNODE_ROOT, 'tasks', taskId);

  const folderBasename = taskFolderName ? path.basename(taskFolderName) : taskId.slice(0, 8);
  const shortId = folderBasename.split('-')[0] ?? taskId.slice(0, 8);

  // Read prior history BEFORE writing this followup's own input file below —
  // otherwise countExistingFollowups() (used internally) would count this
  // followup as already existing and skip its own not-yet-written log.
  const priorHistory = readAllAgentLogsForContext(taskFolderAbs);

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

  const followupContextBlock = buildFollowupContextBlock(taskFolderAbs, context);
  const followupLogBlock = `${followupContextBlock}\n\n## Follow-up output file\n\nWrite your follow-up result to this file using the Write tool:\n\`${followupOutputRel}\``;

  let followupLogBlockWithHistory = followupLogBlock;
  if (priorHistory) {
    followupLogBlockWithHistory =
      `## Prior task conversation log\n\nThe following is the conversation log from every previous run of this task (initial run and any earlier follow-ups), in order. Use it as context to understand what was already done before responding to the follow-up.\n\n${priorHistory}\n\n---\n\n${followupLogBlock}`;
    logger.info('followup_files.history_loaded', { taskId, logBytes: priorHistory.length });
  }

  return { followupInputFile, followupOutputRel, followupLogBlock, followupLogBlockWithHistory, followupN, followupBaseName };
}
