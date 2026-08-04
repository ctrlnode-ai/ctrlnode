/**
 * @file sessionLogParser.ts
 * @description Pure functions for parsing OpenClaw session JSONL files and
 * detecting task completion / inactivity signals. Extracted from
 * sessionHistoryPoller.ts so they can be tested independently of the
 * stateful polling timers.
 */

import fs from 'fs';
import path from 'path';
import { getTaskSubagentSession } from './subagentSessions.js';
import { logger } from './logger.js';

// ── Shared function-type aliases ─────────────────────────────────────────────

/** Callback type used by the poller to forward events to the SaaS backend. */
export type SendToSaasFn = (payload: any) => void;

/** Callback type used to mark an agent as running in the websocket layer. */
export type SetAgentRunningFn = (agentId: string) => void;

// ── Result types ─────────────────────────────────────────────────────────────

/** Returned by {@link checkSessionInactivity}. */
export interface InactivityCheckResult {
  shouldWrite: boolean;
  outputPath?: string;
}

// ── Pure parsing helpers ──────────────────────────────────────────────────────

/**
 * Scans a list of `{role, text}` messages for the first
 * `TASK_COMPLETED` / `TASK_FAILED` / `TASK_BLOCKED` status tag and returns the
 * canonical SaaS status string, or `null` if none found.
 *
 * When `expectedTaskId` is supplied, tags carrying a different task UUID are
 * silently skipped to avoid mis-completion from stale context.
 */
export function detectStatusTagFromMessages(
  messages: Array<{ role: string; text: string }>,
  expectedTaskId?: string
): 'done' | 'failed' | 'blocked' | null {
  const statusTagRe = /<(TASK_COMPLETED|TASK_FAILED|TASK_BLOCKED):([a-f0-9\-]+)>/i;
  for (const m of messages) {
    const match = statusTagRe.exec(m.text);
    if (!match) continue;

    const tag = match[1].toUpperCase();
    const tagTaskId = match[2].toLowerCase();

    if (expectedTaskId && tagTaskId !== expectedTaskId.toLowerCase()) continue;

    return tag === 'TASK_COMPLETED' ? 'done'
         : tag === 'TASK_FAILED'    ? 'failed'
         :                            'blocked';
  }
  return null;
}

// ── Ephemeral planning session (generateStructuredPlan over OpenClaw) ─────────

/** Returned by {@link readEphemeralPlanResult}. */
export interface EphemeralPlanResult {
  status: 'pending' | 'done' | 'failed' | 'blocked';
  /** Assistant text with the status tag stripped. Present when status !== 'pending'. */
  text?: string;
}

/**
 * Pure, synchronous read of a single ephemeral OpenClaw subagent session
 * (`agent:{agentId}:subagent:{planningId}`), used to poll a read-only
 * structured-planning request without any stateful timers. Returns `pending`
 * until the model emits its status tag for this exact `planningId` — a tag
 * carrying a different id (stale context from a reused session slot) is
 * ignored, mirroring {@link detectStatusTagFromMessages}.
 */
export function readEphemeralPlanResult(
  index: Record<string, any>,
  sessionsDir: string,
  agentId: string,
  planningId: string,
): EphemeralPlanResult {
  const entry = resolveTaskSessionEntry(index, agentId, planningId);
  if (!entry) return { status: 'pending' };

  const jsonlPath: string | undefined = entry.sessionFile
    ?? (entry.sessionId ? path.join(sessionsDir, `${entry.sessionId}.jsonl`) : undefined);
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return { status: 'pending' };

  let lines: string[];
  try {
    lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return { status: 'pending' };
  }

  const messages = parseMessagesFromLines(lines);
  const status = detectStatusTagFromMessages(messages, planningId);
  if (!status) return { status: 'pending' };

  const tagWord = status === 'done' ? 'TASK_COMPLETED' : status === 'failed' ? 'TASK_FAILED' : 'TASK_BLOCKED';
  const tagRe = new RegExp(`<${tagWord}:${planningId}>`, 'i');
  const text = messages
    .filter((m) => m.role === 'assistant')
    .map((m) => m.text)
    .join('\n\n')
    .replace(tagRe, '')
    .trim();

  return { status, text };
}

/**
 * Resolves the OpenClaw session entry for a given `agentId` / `taskId` from
 * the parsed `sessions.json` index object. Resolution priority:
 *
 *  0. Deterministic dispatch mapping (taskId → session key via subagentSessions).
 *  1. Exact `agent:{agentId}:subagent:{taskId}` key.
 *  2. Main session (`agent:{agentId}:main` or legacy `main`).
 */
export function resolveTaskSessionEntry(
  index: Record<string, any>,
  agentId: string,
  taskId?: string
): any | null {
  const subagentPrefix = `agent:${agentId}:subagent:`;
  const mainKey = `agent:${agentId}:main`;

  // 0) Deterministic mapping (taskId → childSessionKey) registered at dispatch.
  if (taskId) {
    try {
      const mappedKey = getTaskSubagentSession(taskId);
      if (mappedKey) {
        const fullMappedKey = mappedKey.startsWith(`agent:${agentId}:`)
          ? mappedKey
          : `${subagentPrefix}${mappedKey}`;
        if (index[fullMappedKey]) return index[fullMappedKey];
        if (index[mappedKey])     return index[mappedKey];
      }
    } catch {
      /* ignore — mapping not found, fall through */
    }
  }

  // 1) Exact subagent key for this task UUID.
  if (taskId && index[`${subagentPrefix}${taskId}`]) return index[`${subagentPrefix}${taskId}`];

  // 2) Main session.
  if (index[mainKey])  return index[mainKey];
  if (index['main'])   return index['main'];

  logger.warn('poller.session_resolution_failed', { agentId, taskId, availableKeys: Object.keys(index) });
  return null;
}

/**
 * Parses raw JSONL lines from an OpenClaw session file into structured
 * `{role, text}` message objects (text capped at 5 000 chars per message).
 * Lines that are not `type: "message"` entries or that fail to parse are
 * silently dropped.
 */
export function parseMessagesFromLines(lines: string[]): Array<{ role: string; text: string }> {
  return lines.map(line => {
    try {
      const e = JSON.parse(line);
      if (e.type !== 'message' || !e.message) return null;

      const role: string = e.message.role;
      const content = e.message.content;
      const text = Array.isArray(content)
        ? content.filter((c: any) => c.type === 'text').map((c: any) => String(c.text)).join('').slice(0, 5000)
        : (typeof content === 'string' ? content.slice(0, 5000) : '');

      return text ? { role, text } : null;
    } catch {
      return null;
    }
  }).filter(Boolean) as Array<{ role: string; text: string }>;
}

/**
 * Determines whether the most recent activity in a session's JSONL lines
 * exceeds `thresholdMinutes` of inactivity. When it does, returns the
 * canonical `agent_log.md` output path so the caller can write or upload it.
 */
export function checkSessionInactivity(
  lines: string[],
  taskFolderName: string | undefined,
  workspaceDir: string | undefined,
  thresholdMinutes: number
): InactivityCheckResult {
  if (!taskFolderName || lines.length === 0) return { shouldWrite: false };

  // Find the last entry with a top-level `timestamp` field.
  let lastTimestampMs: number | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.timestamp) {
        lastTimestampMs = Date.parse(e.timestamp);
        break;
      }
    } catch { /* ignore malformed lines */ }
  }

  if (lastTimestampMs === null || isNaN(lastTimestampMs)) return { shouldWrite: false };

  const elapsedMs = Date.now() - lastTimestampMs;
  if (elapsedMs <= thresholdMinutes * 60_000) return { shouldWrite: false };

  const outputPath = path.isAbsolute(taskFolderName)
    ? path.join(taskFolderName, 'output', 'agent_log.md')
    : path.join(workspaceDir ?? '', taskFolderName, 'output', 'agent_log.md');

  return { shouldWrite: true, outputPath };
}
