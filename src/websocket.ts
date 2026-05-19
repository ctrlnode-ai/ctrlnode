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
  PROVIDERS,
} from './config';
import { discoveredAgents, agentStatuses, purgedAgentIds, buildAgentSummaries, syncAgentDiscovery } from './agentDiscovery';
import type { AgentInfo } from './types';
import { startWatcher, stopWatcher, processFileEvent } from './watcher';
import { handleMessage } from './messageHandlers';
import { logger } from './logger';
import { IProvider } from './providers/IProvider';

// ── Module-level state ────────────────────────────────────────────────────────

let ws:            WebSocket | null = null;
let isConnected    = false;
let activeProvider: IProvider | null = null;

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
      // Skip per-chunk text stream traces — too noisy
      if (!(payload?.action === 'agent_stream' && payload?.event?.kind === 'text_chunk') &&
          !(payload?.action === 'agent_activity')) {
        logger.debug('outgoing', { payloadType: payload?.action || 'unknown', preview: json.slice(0, 512) });
      }
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
  if (agents.length === 0) return;
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
  if (!PROVIDERS.includes('openclaw') && activeProvider) {
    activeProvider.discoverAgents().then((summaries) => {
      for (const s of summaries) {
        if (!discoveredAgents[s.id] && !purgedAgentIds.has(s.id)) {
          const info: AgentInfo = { workspace: s.workspace, name: s.name, model: s.model, role: s.role, emoji: s.emoji, description: s.description, provider: s.provider };
          discoveredAgents[s.id] = info;
          agentStatuses[s.id] = 'idle';
        }
      }
      // Include ALL discoveredAgents (SDK-discovered UUIDs + DB-registered slugs added via
      // sync_cursor_agents) so the SaaS _agentIndex covers every registered BridgeAgentId.
      const all = buildAgentSummaries();
      if (all.length > 0) {
        sendToSaas({ action: 'agent_update', version: BRIDGE_VERSION, agents: all });
        sendHeartbeat();
      }
    }).catch((err) => {
      logger.error('sync_agents_provider_error', { error: err?.message });
    });
    return;
  }

  // When OpenClaw is active, discoverAgents() is not called above, so
  // MultiProvider's agentOwner map may never be populated for OpenClaw agents.
  // Call it here purely for the side-effect of warming ownership — results are
  // intentionally discarded; syncAgentDiscovery below handles reporting.
  if (activeProvider) {
    activeProvider.discoverAgents().catch((err) => {
      logger.warn('sync_agents.ownership_warm_failed', { error: err?.message });
    });
  }

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

const AUTH_RETRY_MS = 30_000;

/**
 * Logs an authentication-failure banner and schedules a retry after AUTH_RETRY_MS.
 * Does NOT exit — allows the token to be rotated without restarting the process.
 *
 * @param detail - Additional context to include in the error output.
 */
function retryOnAuthFailure(detail: string): void {
  logger.error('auth_failed', { detail, retrySeconds: AUTH_RETRY_MS / 1000 });
  console.error('AUTHENTICATION FAILED');
  console.error(detail);
  console.error(`Retrying in ${AUTH_RETRY_MS / 1000}s — update PAIRING_TOKEN and restart if this persists.`);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, AUTH_RETRY_MS);
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
export function connect(provider?: IProvider): void {
  if (provider) activeProvider = provider;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  logger.info('connecting', { url: SAAS_URL, providers: PROVIDERS });

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

    const isOpenClaw = PROVIDERS.includes('openclaw');
    const agents = isOpenClaw ? buildAgentSummaries() : [];
    const hs = { action: 'handshake', version: BRIDGE_VERSION, agents, providers: PROVIDERS };
    if (isOpenClaw) {
      logger.info('handshake_sent', { providers: PROVIDERS, agentCount: agents.length });
    } else {
      logger.info('handshake_sent', { providers: PROVIDERS });
    }
    sendToSaas(hs);

    // Async: query each active provider for its available models and forward to SaaS.
    // This must not block the handshake or the message loop.
    void (async () => {
      try {
        if (!activeProvider?.listModels) return;
        const providerModels = await Promise.race([
          activeProvider.listModels(),
          new Promise<string[]>(resolve => setTimeout(() => resolve([]), 12_000)),
        ]);
        if (providerModels.length > 0) {
          // Send per-provider map: for a MultiProvider the names collapse into the flat list;
          // here we use the top-level provider name so the backend can key by it.
          const models: Record<string, string[]> = {};
          // Expand MultiProvider sub-providers if supported, otherwise use top-level name.
          if ((activeProvider as any).providers) {
            const subProviders: IProvider[] = (activeProvider as any).providers;
            const subResults = await Promise.allSettled(
              subProviders.filter(p => p.listModels).map(p =>
                Promise.race([
                  p.listModels!(),
                  new Promise<string[]>(resolve => setTimeout(() => resolve([]), 10_000)),
                ]).then(ids => ({ name: p.providerName, ids }))
              )
            );
            for (const r of subResults) {
              if (r.status === 'fulfilled' && r.value.ids.length > 0) {
                models[r.value.name] = r.value.ids;
              }
            }
          } else {
            models[activeProvider.providerName] = providerModels;
          }
          if (Object.keys(models).length > 0) {
            sendToSaas({ action: 'available_models', models });
            logger.info('available_models_sent', { providers: Object.keys(models).join(',') });
          }
        }
      } catch (err: any) {
        logger.warn('available_models_fetch_failed', { error: err?.message });
      }
    })();

    flushPendingQueue();
    startHeartbeat();
    startConfigPoll();
  });

  // ── message ───────────────────────────────────────────────────────────────
  ws.on('message', async (data: any) => {
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

    try {
      await handleMessage(data, {
        sendToSaas,
        syncAgents: runSyncAgents,
        provider: activeProvider!,
      });
    } catch (err: any) {
      logger.error('handleMessage_critical_error', { error: err.message, stack: err.stack });
    }
  });

  // ── close ─────────────────────────────────────────────────────────────────
  ws.on('close', (code: number) => {
    if (connectionAttemptTimer) { clearTimeout(connectionAttemptTimer); connectionAttemptTimer = null; }
    isConnected = false;
    stopHeartbeat();

    // Auth failure was already handled by the error handler — skip.
    if (authFailed) return;

    if (isAuthError(code, '')) {
      authFailed = true;
      retryOnAuthFailure(`WebSocket closed with code ${code} (invalid/missing PAIRING_TOKEN).`);
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
      retryOnAuthFailure(err.message);
    } else {
      logger.error('websocket_error', { message: err.message });
      scheduleReconnect();
    }
  });

  // Reset auth flag when a fresh connection attempt begins.
  authFailed = false;
}
