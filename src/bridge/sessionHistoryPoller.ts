import path from 'path';
import fs from 'fs';
import { OPENCLAW_CONFIG, SESSION_INACTIVITY_TIMEOUT_MINUTES, SESSION_HISTORY_POLL_MS, AGENT_IDLE_RESET_MS } from './config';
import { getTaskSubagentSession } from './subagentSessions';
import { logger } from './logger';

export type SendToSaasFn = (payload: any) => void;
export type SetAgentRunningFn = (agentId: string) => void;

/**
 * Pure function: scans a list of {role, text} messages for the first
 * TASK_COMPLETED / TASK_FAILED / TASK_BLOCKED status tag and returns
 * the canonical status string for the SaaS, or null if none found.
 */
export function detectStatusTagFromMessages(
  messages: Array<{ role: string; text: string }>,
  expectedTaskId?: string
): 'done' | 'failed' | 'blocked' | null {
  const statusTagRe = /<(TASK_COMPLETED|TASK_FAILED|TASK_BLOCKED):([a-f0-9\-]+)>/i;
  for (const m of messages) {
    const match = statusTagRe.exec(m.text);
    if (match) {
      const tag = match[1].toUpperCase() as string;
      const tagTaskId = match[2].toLowerCase();
      
      if (expectedTaskId && tagTaskId !== expectedTaskId.toLowerCase()) {
        continue; // Ignore tags from old tasks that might be in the context
      }

      return tag === 'TASK_COMPLETED' ? 'done'
           : tag === 'TASK_FAILED'    ? 'failed'
           :                            'blocked';
    }
  }
  return null;
}

/**
 * Picks the OpenClaw session entry from sessions.json for this agent/task.
 */
export function resolveTaskSessionEntry(
  index: Record<string, any>,
  agentId: string,
  taskId?: string
): any | null {
  const subagentPrefix = `agent:${agentId}:subagent:`;
  const mainKey = `agent:${agentId}:main`;

  // 0) Deterministic mapping (taskId -> childSessionKey) from dispatch.
  if (taskId) {
    try {
      const mappedKey = getTaskSubagentSession(taskId);
      if (mappedKey) {
        const fullMappedKey = mappedKey.startsWith(`agent:${agentId}:`) ? mappedKey : `${subagentPrefix}${mappedKey}`;
        if (index[fullMappedKey]) return index[fullMappedKey];
        if (index[mappedKey]) return index[mappedKey];
      }
    } catch {
      /* ignore */
    }
  }

  // 1) Exact subagent key for this task UUID.
  if (taskId) {
    const specificKey = `${subagentPrefix}${taskId}`;
    if (index[specificKey]) return index[specificKey];
  }

  // 2) Main session (or legacy 'main').
  if (index[mainKey]) return index[mainKey];
  if (index['main']) return index['main'];

  logger.warn('poller.session_resolution_failed', { agentId, taskId, availableKeys: Object.keys(index) });
  return null;
}

// ── Main agent session log polling ────────────────────────────────────────────

// Map of taskId → interval timer. Supports multiple simultaneous polled tasks
// (e.g. a pipeline step with parallel task assignments to different agents).
const mainSessionTimers = new Map<string, ReturnType<typeof setInterval>>();

// Tracks how many raw JSONL lines have already been sent as agent_activity deltas.
// Key = taskId (same as mainSessionTimers key). Reset when polling stops.
const lastSentLineCount = new Map<string, number>();

// Optimizations for polling: track file size and last message timestamp
const lastCheckedFileSizes = new Map<string, number>();
const lastKnownTimestamps = new Map<string, number>();

// Roles whose text is forwarded as agent_activity — mirrors writeLog / agent_log.md.
const ACTIVITY_ROLES = new Set(['assistant', 'tool', 'toolResult']);

/**
 * After sessions.json points at a sessionId, OpenClaw may still be creating the `.jsonl`.
 * Poll briefly within the same scheduler tick so 1–2s delays still yield agent_activity
 * without waiting for the next SESSION_HISTORY_POLL_MS interval.
 * Max wall time ≈ (attempts - 1) * interval (e.g. 11 * 200ms ≈ 2.2s).
 */
const JSONL_FILE_WAIT_MAX_ATTEMPTS = 12;
const JSONL_FILE_WAIT_INTERVAL_MS = 200;

const MAX_CONSECUTIVE_MISSING_SESSION_TICKS = 3;
const missingSessionTickCounts = new Map<string, number>();

export function registerMissingSessionTick(taskId: string): { count: number; shouldStop: boolean } {
  const count = (missingSessionTickCounts.get(taskId) ?? 0) + 1;
  missingSessionTickCounts.set(taskId, count);

  return {
    count,
    shouldStop: count >= MAX_CONSECUTIVE_MISSING_SESSION_TICKS,
  };
}

export function clearMissingSessionTickState(taskId?: string): void {
  if (taskId) {
    missingSessionTickCounts.delete(taskId);
    return;
  }

  missingSessionTickCounts.clear();
}

/** Options for inactivity detection (defaults to configured values) */
export interface InactivityCheckResult {
  shouldWrite: boolean;
  outputPath?: string;
}

/**
 * Pure function: parse a list of raw JSONL lines from an OpenClaw session file
 * into structured {role, text} message objects (up to 600 chars per message).
 * Lines that are not `type:message` entries or that cannot be parsed are dropped.
 */
export function parseMessagesFromLines(lines: string[]): Array<{ role: string; text: string }> {
  return lines.map(line => {
    try {
      const e = JSON.parse(line);
      if (e.type !== 'message' || !e.message) return null;
      const role: string = e.message.role;
      const content = e.message.content;
      const text = Array.isArray(content)
        ? content.filter((c: any) => c.type === 'text').map((c: any) => c.text as string).join('').slice(0, 5000)
        : (typeof content === 'string' ? content.slice(0, 5000) : '');
      return text ? { role, text } : null;
    } catch { return null; }
  }).filter(Boolean) as Array<{ role: string; text: string }>;
}

/**
 * Pure function: given JSONL lines from a session file, determines whether the
 * session is inactive beyond the threshold and returns the output path where
 * `agent_log.md` should be written.
 */
export function checkSessionInactivity(
  lines: string[],
  taskFolderName: string | undefined,
  workspaceDir: string | undefined,
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

  const outputPath = (taskFolderName && path.isAbsolute(taskFolderName))
    ? path.join(taskFolderName, 'output', 'agent_log.md')
    : path.join(workspaceDir || '', taskFolderName || '', 'output', 'agent_log.md');

  return { shouldWrite: true, outputPath };
}

function readMainSessionLog(
  agentId: string,
  taskId?: string,
  taskFolderName?: string,
  workspaceDir?: string,
  sendToSaas?: SendToSaasFn,
  setAgentRunning?: SetAgentRunningFn
): void {
  try {
    const sessionsDir = path.join(path.dirname(OPENCLAW_CONFIG), 'agents', agentId, 'sessions');
    const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
    if (!fs.existsSync(sessionsJsonPath)) {
      return;
    }

    const index = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
    const mainKey = `agent:${agentId}:main`;
    const entry: any = resolveTaskSessionEntry(index, agentId, taskId);
    if (!entry) {
      const missingTick = taskId ? registerMissingSessionTick(taskId) : null;
      if (taskId && missingTick?.shouldStop) {
        stopMainSessionPolling(taskId);
      }
      return;
    }
    if (taskId) {
      clearMissingSessionTickState(taskId);
    }
    // OpenClaw sessions.json stores sessionId; derive the JSONL path from it.
    const jsonlPath = entry.sessionFile ?? path.join(sessionsDir, `${entry.sessionId}.jsonl`);

    // If the sessions.json entry references a JSONL path that does not yet exist,
    // it is often a benign race (OpenClaw hasn't flushed the session file yet). Try
    // several short retries over ~2s before deferring to the next poll tick.
    if (!jsonlPath || !fs.existsSync(jsonlPath)) {
      let attempts = 0;

      const tryCheck = () => {
        attempts += 1;
        if (jsonlPath && fs.existsSync(jsonlPath)) {
          // Re-run the read flow now that the file exists.
          try { readMainSessionLog(agentId, taskId, taskFolderName, workspaceDir, sendToSaas, setAgentRunning); } catch { /* ignore */ }
          return;
        }
        if (attempts < JSONL_FILE_WAIT_MAX_ATTEMPTS) {
          setTimeout(tryCheck, JSONL_FILE_WAIT_INTERVAL_MS);
          return;
        }
      };

      tryCheck();
      return;
    }

    const pollKey = taskId ?? agentId;
    const stat = fs.statSync(jsonlPath);
    const lastSize = lastCheckedFileSizes.get(pollKey) ?? 0;

    if (stat.size === lastSize) {
      // File has not grown. Check inactivity timeout purely from memory.
      const lastTimestampMs = lastKnownTimestamps.get(pollKey);
      if (lastTimestampMs) {
        const elapsedMs = Date.now() - lastTimestampMs;
        const thresholdMs = SESSION_INACTIVITY_TIMEOUT_MINUTES * 60_000;
        if (elapsedMs <= thresholdMs) {
          return; // No new data and not timed out yet. Skip expensive parse.
        }
      } else {
        return; // No timestamp known yet, nothing to do.
      }
    }
    
    lastCheckedFileSizes.set(pollKey, stat.size);
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);

    // Update last known timestamp for the next tick
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.timestamp) {
          lastKnownTimestamps.set(pollKey, Date.parse(e.timestamp));
          break;
        }
      } catch { /* ignore */ }
    }

    // Mark agent as running when the session log has a recent entry (within AGENT_IDLE_RESET_MS).
    if (setAgentRunning && lines.length > 0) {
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.timestamp) {
            const ageMs = Date.now() - Date.parse(e.timestamp);
            if (ageMs >= 0 && ageMs <= AGENT_IDLE_RESET_MS) {
              setAgentRunning(agentId);
            }
            break;
          }
        } catch { /* ignore malformed lines */ }
      }
    }

    const messages = parseMessagesFromLines(lines);

    // Helper: write assistant/toolResult messages from this session to the task output log file.
    const writeLog = (outputPath: string) => {
      if (!outputPath) return;
      try {
        const INCLUDE_ROLES = new Set(['assistant', 'tool', 'toolResult']);
        const logContent = messages
          .filter((m) => INCLUDE_ROLES.has(m.role))
          .map((m) => m.text)
          .join('\n\n---\n\n');
        
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, logContent || '(no messages)', 'utf8');
        
        logger.info('poller.write_success', { taskId, outputPath });
        
        if (sendToSaas) {
          sendToSaas({ action: 'file_changed', agentId, path: outputPath });
        }
      } catch (err) {
        // Log to console/logger but don't re-throw so the completion message still goes out
        logger.error('poller.write_failed', { taskId, outputPath, error: String(err) });
      }
    };

    // ── Agent activity streaming ───────────────────────────────────────────────
    // Send new assistant-role lines as incremental deltas to the SaaS so the UI
    // can stream them character-by-character.  Uses the same role filter as writeLog.
    if (taskId && sendToSaas) {
      const pollKey = taskId;
      const prevCount = lastSentLineCount.get(pollKey) ?? 0;
      const newRawLines = lines.slice(prevCount);
      if (newRawLines.length > 0) {
        const delta = newRawLines
          .map(line => {
            try {
              const e = JSON.parse(line);
              if (e.type !== 'message' || !e.message) return '';
              if (!ACTIVITY_ROLES.has(e.message.role)) return '';
              const content = e.message.content;
              const text = Array.isArray(content)
                ? content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text as string)
                    .join('')
                : (typeof content === 'string' ? content : '');
              return text.slice(0, 5000);
            } catch { return ''; }
          })
          .filter(Boolean)
          .join('\n\n');
        if (delta.trim()) {
          sendToSaas({ action: 'agent_activity', taskId, agentId, delta, seqNum: prevCount });
        }
        lastSentLineCount.set(pollKey, lines.length);
      }
    }

    // Status-tag detection: if the agent emitted a TASK_COMPLETED/FAILED/BLOCKED tag,
    // report completion immediately without waiting for inactivity timeout.
    // We check BOTH the selected session (subagent or main) AND the main agent session,
    // because the orchestrating agent may write the tag in its own session rather than
    // in the subagent session.
    if (taskId && sendToSaas) {
      let detectedStatus = detectStatusTagFromMessages(messages, taskId);

      // Secondary check: read the main agent session and look for a status tag there too.
      if (!detectedStatus) {
        const mainEntry = index[mainKey] || index['main'] || null;
        if (mainEntry && mainEntry !== entry) {
          const mainJsonlPath: string = mainEntry.sessionFile ?? path.join(sessionsDir, `${mainEntry.sessionId}.jsonl`);
          if (mainJsonlPath && fs.existsSync(mainJsonlPath)) {
            try {
              const mainLines = fs.readFileSync(mainJsonlPath, 'utf8').split('\n').filter(Boolean);
              const mainMessages = parseMessagesFromLines(mainLines);
              detectedStatus = detectStatusTagFromMessages(mainMessages, taskId);
            } catch { /* ignore read errors on secondary check */ }
          }
        }
      }

      if (detectedStatus) {
        logger.info('poller.status_tag_detected', { taskId, status: detectedStatus });
        // Always write the log file when completion is detected.
        if (taskFolderName) {
          const outputPath = path.isAbsolute(taskFolderName)
            ? path.join(taskFolderName, 'output', 'agent_log.md')
            : path.join(workspaceDir || '', taskFolderName, 'output', 'agent_log.md');
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
        writeLog(outputPath);
        stopMainSessionPolling(taskId);
        if (sendToSaas) {
          sendToSaas({ action: 'task_complete', agentId, taskId, status: 'done', source: 'inactivity_timeout' });
        }
      }
    }
  } catch (err) {
    logger.error('poller.uncaught_error', { taskId, error: String(err) });
  }
}

export function startMainSessionPolling(
  agentId: string,
  taskId?: string,
  taskFolderName?: string,
  workspaceDir?: string,
  sendToSaas?: SendToSaasFn,
  setAgentRunning?: SetAgentRunningFn
): void {
  const key = taskId ?? agentId;
  
  if (!taskId) {
    logger.warn('poller.start_skipped_no_task_id', { agentId });
  } else {
    logger.info('poller.starting', { agentId, taskId, taskFolderName });
  }

  // Stop any existing poller for this specific task before starting a new one.
  // This handles bridge-restart mid-task and quick re-dispatches of the same task.
  stopMainSessionPolling(key);

  const timer = setInterval(
    () => readMainSessionLog(agentId, taskId, taskFolderName, workspaceDir, sendToSaas, setAgentRunning),
    SESSION_HISTORY_POLL_MS
  );
  mainSessionTimers.set(key, timer);
}

export function stopMainSessionPolling(taskId?: string): void {
  if (taskId) {
    const timer = mainSessionTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      mainSessionTimers.delete(taskId);
    }
    lastSentLineCount.delete(taskId);
    lastCheckedFileSizes.delete(taskId);
    lastKnownTimestamps.delete(taskId);
    clearMissingSessionTickState(taskId);
  } else {
    // Stop all active pollers (e.g. on bridge shutdown or /stop command).
    for (const timer of mainSessionTimers.values()) clearInterval(timer);
    mainSessionTimers.clear();
    lastSentLineCount.clear();
    lastCheckedFileSizes.clear();
    lastKnownTimestamps.clear();
    clearMissingSessionTickState();
  }
}
