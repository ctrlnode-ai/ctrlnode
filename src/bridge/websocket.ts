/**
 * @file websocket.ts
 * @description WebSocket connection lifecycle management for the Agent Bridge.
 *
 * Responsibilities:
 *  - Establish and maintain the WebSocket connection to the CtrlNode.ai SaaS.
 *  - Perform the initial handshake (send agent list + version).
 *  - Detect and handle authentication failures (exit without retry).
 *  - Queue outgoing messages while disconnected and flush them on reconnect.
 *  - Send periodic heartbeats with per-agent status information.
 *  - Manage the config-poll timer that re-syncs discovered agents.
 *  - Provide `sendToSaas` as the single egress point for all other modules.
 */

import WebSocket from 'ws';
import fs from 'fs';
import {
  SAAS_URL,
  PAIRING_TOKEN,
  BRIDGE_VERSION,
  HEARTBEAT_MS,
  RECONNECT_MS,
  POLL_CONFIG_MS,
  AGENT_IDLE_RESET_MS,
  CONNECTION_TIMEOUT_MS,
  BRIDGE_INCOMING_DUMP_PATH,
} from './config';
import { discoveredAgents, agentStatuses, buildAgentSummaries, syncAgentDiscovery } from './agentDiscovery';
import { startWatcher, stopWatcher, processFileEvent } from './watcher';
import { handleMessage } from './messageHandlers';
import { logger } from './logger';

// ── Module-level state ────────────────────────────────────────────────────────

let ws:            WebSocket | null = null;
let isConnected    = false;

let heartbeatTimer:        ReturnType<typeof setInterval>  | null = null;
let reconnectTimer:        ReturnType<typeof setTimeout>   | null = null;
let configPollTimer:       ReturnType<typeof setInterval>  | null = null;
let connectionAttemptTimer: ReturnType<typeof setTimeout>  | null = null;
let incomingDumpWarned = false;

/** Set when an auth failure has been detected so the subsequent close event is ignored. */
let authFailed = false;

/** Outgoing messages queued while the WebSocket is not yet open. */
const pendingQueue: any[] = [];
const PENDING_QUEUE_MAX = 100;

/** Inactivity timers used to reset agent status back to "idle". */
const statusTimers: Record<string, ReturnType<typeof setTimeout>> = {};

// ── Egress ────────────────────────────────────────────────────────────────────

/**
 * Sends a JSON payload to the SaaS over the active WebSocket connection.
 * If the connection is not currently open the payload is queued and will be
 * sent automatically once the connection is re-established.
 *
 * @param payload - Any JSON-serialisable object to send.
 */
export function sendToSaas(payload: any): void {
  try {
    const json = JSON.stringify(payload);
    if (ws && isConnected && ws.readyState === WebSocket.OPEN) {
      logger.debug('outgoing', { payloadType: payload?.action || 'unknown', preview: json.slice(0, 512) });
      ws.send(json);
    } else {
      pendingQueue.push(payload);
      if (pendingQueue.length > PENDING_QUEUE_MAX) pendingQueue.shift();
      logger.debug('queued_outgoing', { payloadType: payload?.action || 'unknown', queueLength: pendingQueue.length });
    }
  } catch (err: any) {
    logger.error('sendToSaas_error', { error: err?.message });
  }
}

/**
 * Drains the pending message queue and sends all buffered messages
 * now that the WebSocket connection is open.
 */
function flushPendingQueue(): void {
  while (pendingQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
    ws!.send(JSON.stringify(pendingQueue.shift()));
  }
}

// ── Agent status ──────────────────────────────────────────────────────────────

/**
 * Marks an agent as "running" and starts a 15-second inactivity timer.
 * If the agent is already running, the existing timer is reset.
 * When the timer fires the agent status reverts to "idle" and a heartbeat
 * is sent so the SaaS UI reflects the change.
 *
 * @param agentId - ID of the agent that showed filesystem activity.
 */
export function setAgentRunning(agentId: string): void {
  if (statusTimers[agentId]) clearTimeout(statusTimers[agentId]);

  if (agentStatuses[agentId] !== 'running') {
    agentStatuses[agentId] = 'running';
    logger.info('agent_status', { agentId, status: 'running' });
    sendHeartbeat();
  }

  statusTimers[agentId] = setTimeout(() => {
    agentStatuses[agentId] = 'idle';
    logger.info('agent_status', { agentId, status: 'idle' });
    delete statusTimers[agentId];
    sendHeartbeat();
  }, AGENT_IDLE_RESET_MS);
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

/**
 * Sends a heartbeat message to the SaaS with the current list of agent IDs,
 * an overall bridge status ("running" if any agent is active), and per-agent
 * status details.
 */
function sendHeartbeat(): void {
  if (!isConnected) return;
  const agents = Object.keys(discoveredAgents);
  sendToSaas({
    action:       'heartbeat',
    agents,
    status:       agents.some(id => agentStatuses[id] === 'running') ? 'running' : 'idle',
    agentStatuses: agents.map(id => ({ id, status: agentStatuses[id] })),
    timestamp:    new Date().toISOString(),
  });
}

/**
 * Starts the periodic heartbeat timer. Any previously running timer is
 * stopped first to avoid duplicate intervals.
 */
function startHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
}

/**
 * Stops the periodic heartbeat timer.
 */
function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// ── Config poll ───────────────────────────────────────────────────────────────

/**
 * Starts the periodic config-poll timer that re-reads openclaw.json and
 * ctrlnode/agents-config.json to detect agent additions/removals.
 * Safe to call multiple times — only one timer will run.
 */
function startConfigPoll(): void {
  if (configPollTimer) return;
  configPollTimer = setInterval(() => runSyncAgents(), POLL_CONFIG_MS);
}

// ── Agent sync ────────────────────────────────────────────────────────────────

/**
 * Runs a full agent-discovery sync cycle and sends an `agent_update` message
 * to the SaaS if the agent list has changed.
 *
 * This function is passed as a callback to handlers that need to trigger
 * re-discovery (e.g. after a sync_config or update_agent_config message).
 */
export function runSyncAgents(): void {
  syncAgentDiscovery({
    onAgentAdded(id, info) {
      startWatcher(id, info.workspace, (agentId, workspaceDir, event, filePath) => {
        processFileEvent(agentId, workspaceDir, event, filePath, {
          sendToSaas,
          setAgentRunning,
        });
      });
    },
    onAgentRemoved(id) {
      stopWatcher(id);
    },
    onChanged() {
      sendToSaas({
        action: 'agent_update',
        version: BRIDGE_VERSION,
        agents: buildAgentSummaries(),
      });
      sendHeartbeat();
    },
  });
}

// ── Connection ────────────────────────────────────────────────────────────────

/**
 * Schedules a reconnection attempt after `RECONNECT_MS` milliseconds.
 * Consecutive calls before the timer fires are ignored (only one timer runs).
 */
function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

/**
 * Returns true when the WebSocket close code or error message indicates an
 * authentication failure (invalid or missing PAIRING_TOKEN).
 *
 * @param code    - WebSocket close code (pass 0 when checking an error).
 * @param message - Error message string (pass "" when checking a close code).
 */
function isAuthError(code: number, message: string): boolean {
  if (code === 1008 || code === 1002) return true;
  return ['401', 'Unauthorized', 'Expected 101', '403'].some(s => message.includes(s));
}

/**
 * Logs a fatal authentication-failure banner to stderr and exits the process
 * after a short delay (to ensure logs are flushed).
 *
 * @param detail - Additional context to include in the error output.
 */
function exitOnAuthFailure(detail: string): void {
  logger.error('auth_failed', { detail });
  console.error('AUTHENTICATION FAILED');
  console.error(detail);
  console.error('Set a valid PAIRING_TOKEN and restart.');
  setTimeout(() => process.exit(1), 200);
}

/**
 * Opens the WebSocket connection to the SaaS, registers all event handlers,
 * and sends the initial handshake once the connection is established.
 *
 * On successful open:
 *  - Sends `handshake` with version and discovered agent list.
 *  - Flushes any queued outgoing messages.
 *  - Starts the heartbeat and config-poll timers.
 *
 * On close with an auth code (1008/1002): exits the process immediately.
 * On other close codes: schedules a reconnect.
 * On error with an auth marker: exits the process immediately.
 * On other errors: schedules a reconnect.
 */
export function connect(): void {
  logger.info('connecting', { url: SAAS_URL });

  ws = new WebSocket(SAAS_URL, {
    headers: {
      'x-bridge-version': BRIDGE_VERSION,
      'x-agents':         Object.keys(discoveredAgents).join(','),
      'authorization':    `Bearer ${PAIRING_TOKEN}`,
    },
  });

  // Abort if the server never responds within CONNECTION_TIMEOUT_MS
  connectionAttemptTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      logger.warn('connection_timeout', { message: 'server not responding' });
      try { ws.close(); } catch {}
      scheduleReconnect();
    }
  }, CONNECTION_TIMEOUT_MS);

  // ── open ──────────────────────────────────────────────────────────────────
  ws.on('open', () => {
    if (connectionAttemptTimer) { clearTimeout(connectionAttemptTimer); connectionAttemptTimer = null; }
    isConnected = true;
    logger.info('connected', {});

    const hs = { action: 'handshake', version: BRIDGE_VERSION, agents: buildAgentSummaries() };
    logger.info('handshake_sent', { agentCount: hs.agents?.length ?? 0 });
    sendToSaas(hs);

    flushPendingQueue();
    startHeartbeat();
    startConfigPoll();
  });

  // ── message ───────────────────────────────────────────────────────────────
  ws.on('message', (data: any) => {
    try {
      const raw = data?.toString?.() ?? String(data);
      logger.debug('incoming_message', { preview: raw.slice(0, 1024) });
      // Optional debug dump: persist full incoming payloads when explicitly enabled.
      if (BRIDGE_INCOMING_DUMP_PATH) {
        try {
          fs.appendFileSync(BRIDGE_INCOMING_DUMP_PATH, raw.replace(/\r?\n/g, '') + "\n");
        } catch (e: any) {
          if (!incomingDumpWarned) {
            incomingDumpWarned = true;
            logger.warn('dump_incoming_failed', {
              path: BRIDGE_INCOMING_DUMP_PATH,
              error: e?.message,
            });
          }
        }
      }
    } catch (err) { /* ignore */ }
    handleMessage(data, {
      sendToSaas,
      syncAgents: runSyncAgents,
    });
  });

  // ── close ─────────────────────────────────────────────────────────────────
  ws.on('close', (code: number) => {
    if (connectionAttemptTimer) { clearTimeout(connectionAttemptTimer); connectionAttemptTimer = null; }
    isConnected = false;
    stopHeartbeat();

    // Auth failure was already handled by the error handler — skip.
    if (authFailed) return;

    if (isAuthError(code, '')) {
      exitOnAuthFailure(`WebSocket closed with code ${code} (invalid/missing PAIRING_TOKEN).`);
    } else {
      logger.warn('connection_closed', { code, retrySeconds: RECONNECT_MS / 1000 });
      scheduleReconnect();
    }
  });

  // ── error ─────────────────────────────────────────────────────────────────
  ws.on('error', (err: Error) => {
    if (connectionAttemptTimer) { clearTimeout(connectionAttemptTimer); connectionAttemptTimer = null; }

    if (isAuthError(0, err.message)) {
      authFailed = true;
      exitOnAuthFailure(err.message);
    } else {
      logger.error('websocket_error', { message: err.message });
      scheduleReconnect();
    }
  });

  // Reset auth flag when a fresh connection attempt begins.
  authFailed = false;
}
