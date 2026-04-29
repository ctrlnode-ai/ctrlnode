import path from 'path';
import fs from 'fs';
import { logger } from './logger';
import { OPENCLAW_CONFIG, SESSION_INACTIVITY_TIMEOUT_MINUTES, SESSION_HISTORY_POLL_MS } from './config';

export type SendToSaasFn = (payload: any) => void;

/**
 * Pure function: scans a list of {role, text} messages for the first
 * TASK_COMPLETED / TASK_FAILED / TASK_BLOCKED status tag and returns
 * the canonical status string for the SaaS, or null if none found.
 */
export function detectStatusTagFromMessages(messages: Array<{ role: string; text: string }>): 'done' | 'failed' | 'blocked' | null {
  const statusTagRe = /<(TASK_COMPLETED|TASK_FAILED|TASK_BLOCKED):[a-f0-9\-]+>/i;
  for (const m of messages) {
    const match = statusTagRe.exec(m.text);
    if (match) {
      const tag = match[1].toUpperCase() as string;
      return tag === 'TASK_COMPLETED' ? 'done'
           : tag === 'TASK_FAILED'    ? 'failed'
           :                            'blocked';
    }
  }
  return null;
}

// ── Main agent session log polling ────────────────────────────────────────────

// Map of taskId → interval timer. Supports multiple simultaneous polled tasks
// (e.g. a pipeline step with parallel task assignments to different agents).
const mainSessionTimers = new Map<string, ReturnType<typeof setInterval>>();

/** Options for inactivity detection (defaults to configured values) */
export interface InactivityCheckResult {
  shouldWrite: boolean;
  outputPath?: string;
}

/**
 * Pure function: given JSONL lines from a session file, determines whether the
 * session is inactive beyond the threshold and returns the output path where
 * `agent_log.md` should be written.
 */
export function checkSessionInactivity(
  lines: string[],
  taskFolderName: string | undefined,
  workspaceDir: string,
  thresholdMinutes: number
): InactivityCheckResult {
  if (!taskFolderName) return { shouldWrite: false };
  if (lines.length === 0) return { shouldWrite: false };

  // Find the last entry that has a top-level timestamp field
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
  const thresholdMs = thresholdMinutes * 60_000;
  if (elapsedMs <= thresholdMs) return { shouldWrite: false };

  const outputPath = path.join(workspaceDir, taskFolderName, 'output', 'agent_log.md');
  return { shouldWrite: true, outputPath };
}

function readMainSessionLog(
  agentId: string,
  taskId?: string,
  taskFolderName?: string,
  workspaceDir?: string,
  sendToSaas?: SendToSaasFn
): void {
  try {
    const sessionsDir = path.join(path.dirname(OPENCLAW_CONFIG), 'agents', agentId, 'sessions');
    const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
    if (!fs.existsSync(sessionsJsonPath)) {
      logger.info('main_session.no_sessions_json', { agentId, sessionsJsonPath });
      return;
    }

    const index = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
    const subagentPrefix = `agent:${agentId}:subagent:`;
    const mainKey = `agent:${agentId}:main`;

    // Priority order for entry lookup:
    // 1. Specific subagent for this task: agent:{id}:subagent:{taskId}
    //    — this is the session spawned by sessions_spawn for the current task.
    // 2. Most-recently-updated subagent entry (taskId not available or not matched).
    // 3. main entry — only for non-subagent agents that run tasks in their main session.
    let entry: any = null;
    if (taskId) {
      entry = index[`${subagentPrefix}${taskId}`] ?? null;
    }
    if (!entry) {
      const subagentEntries = Object.entries(index)
        .filter(([k]) => k.startsWith(subagentPrefix))
        .map(([, v]) => v as any)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      entry = subagentEntries[0] ?? null;
    }
    if (!entry) {
      entry = index[mainKey] || index['main'] || null;
    }
    if (!entry) {
      logger.info('main_session.entry_missing', { agentId, taskId, mainKey, keys: Object.keys(index) });
      return;
    }
    // OpenClaw sessions.json stores sessionId; derive the JSONL path from it.
    const jsonlPath = entry.sessionFile ?? path.join(sessionsDir, `${entry.sessionId}.jsonl`);
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
      logger.info('main_session.jsonl_missing', { agentId, jsonlPath, sessionId: entry.sessionId });
      return;
    }

    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    const messages = lines.map(line => {
      try {
        const e = JSON.parse(line);
        if (e.type !== 'message' || !e.message) return null;
        const role = e.message.role;
        const content = e.message.content;
        const text = Array.isArray(content)
          ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('').slice(0, 600)
          : (typeof content === 'string' ? content.slice(0, 600) : '');
        return text ? { role, text } : null;
      } catch { return null; }
    }).filter(Boolean);

    // Helper: write assistant/toolResult messages from this session to the task output log file.
    const writeLog = (outputPath: string) => {
      const INCLUDE_ROLES = new Set(['assistant', 'tool', 'toolResult']);
      const logContent = (messages as Array<{ role: string; text: string }>)
        .filter((m) => INCLUDE_ROLES.has(m.role))
        .map((m) => m.text)
        .join('\n\n---\n\n');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, logContent || '(no messages)', 'utf8');
      logger.info('main_session.log_written', { agentId, taskId, outputPath });
    };

    // Status-tag detection: if the agent emitted a TASK_COMPLETED/FAILED/BLOCKED tag,
    // report completion immediately without waiting for inactivity timeout.
    if (taskId && sendToSaas) {
      const detectedStatus = detectStatusTagFromMessages(messages as Array<{ role: string; text: string }>);
      if (detectedStatus) {
        logger.info('main_session.status_tag_detected', { agentId, taskId, status: detectedStatus });
        // Always write the log file when completion is detected.
        if (taskFolderName && workspaceDir) {
          const outputPath = path.join(workspaceDir, taskFolderName, 'output', 'agent_log.md');
          writeLog(outputPath);
        }
        stopMainSessionPolling(taskId);
        sendToSaas({ action: 'task_complete', agentId, taskId, status: detectedStatus, source: 'main_session' });
        return;
      }
    }

    // Inactivity detection: if taskFolderName + workspaceDir provided, check if session is stale
    if (taskId && taskFolderName && workspaceDir) {
      const { shouldWrite, outputPath } = checkSessionInactivity(
        lines,
        taskFolderName,
        workspaceDir,
        SESSION_INACTIVITY_TIMEOUT_MINUTES
      );
      if (shouldWrite && outputPath) {
        logger.warn('main_session.inactivity_detected', { agentId, taskId, taskFolderName, thresholdMinutes: SESSION_INACTIVITY_TIMEOUT_MINUTES });
        writeLog(outputPath);
        stopMainSessionPolling(taskId);
        if (sendToSaas) {
          sendToSaas({ action: 'task_complete', agentId, taskId, status: 'done', source: 'inactivity_timeout' });
        }
      } else {
        logger.info('main_session.tick_no_action', { agentId, taskId, lines: lines.length, messagesWithText: (messages as any[]).length });
      }
    }
  } catch (e: any) {
    logger.warn('main_session.log_failed', { agentId, error: e?.message });
  }
}

export function startMainSessionPolling(
  agentId: string,
  taskId?: string,
  taskFolderName?: string,
  workspaceDir?: string,
  sendToSaas?: SendToSaasFn
): void {
  const key = taskId ?? agentId;

  // Stop any existing poller for this specific task before starting a new one.
  // This handles bridge-restart mid-task and quick re-dispatches of the same task.
  stopMainSessionPolling(key);

  readMainSessionLog(agentId, taskId, taskFolderName, workspaceDir, sendToSaas); // immediate read
  const timer = setInterval(
    () => readMainSessionLog(agentId, taskId, taskFolderName, workspaceDir, sendToSaas),
    SESSION_HISTORY_POLL_MS
  );
  mainSessionTimers.set(key, timer);
  logger.info('main_session.polling_started', { agentId, taskId: key, intervalMs: SESSION_HISTORY_POLL_MS, activePollersCount: mainSessionTimers.size });
}

export function stopMainSessionPolling(taskId?: string): void {
  if (taskId) {
    const timer = mainSessionTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      mainSessionTimers.delete(taskId);
    }
  } else {
    // Stop all active pollers (e.g. on bridge shutdown or /stop command).
    for (const timer of mainSessionTimers.values()) clearInterval(timer);
    mainSessionTimers.clear();
  }
}
