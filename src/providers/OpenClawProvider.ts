import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider';
import { AgentSummary, BridgeMessage } from '../types';
import { buildAgentSummaries, discoveredAgents, isAgentInCtrlnode, normalizeAgentId } from '../agentDiscovery';
import { resolveTargetAgentId } from '../agentRouting';
import { OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_CONFIG, ctrlnodePath, AGENTS_CTRLNODE_ROOT } from '../config';
import { wipeAgentSessions } from '../fileSystem';
import { getIntentProviderMethod } from '../intentDispatchPolicy';
import { startMainSessionPolling, stopMainSessionPolling } from '../sessionHistoryPoller';
import { setTaskSubagentSession } from '../subagentSessions';
import { logger } from '../logger';

type TaskTerminalStatus = 'failed' | 'blocked';

function classifyTaskTerminalStatus(responseStatus: number, responseText: string): TaskTerminalStatus {
  if (responseStatus === 401 || /unauthorized/i.test(responseText)) return 'blocked';
  return 'failed';
}

export class OpenClawProvider implements IProvider {
  readonly providerName = 'openclaw';

  async discoverAgents(): Promise<AgentSummary[]> {
    return buildAgentSummaries();
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const { agentId, taskId, prompt, tools, taskFolderName, skipSessionWipe, executionId } = params;
    const agentInfo = discoveredAgents[agentId];
    if (!agentInfo) {
      callbacks.onComplete('failed', 'AGENT_NOT_FOUND');
      return;
    }

    if (!skipSessionWipe) {
      try {
        wipeAgentSessions(agentId, OPENCLAW_CONFIG);
        logger.info('dispatch_task.sessions_wiped', { agentId });
      } catch (err) {
        logger.warn('dispatch_task.sessions_wipe_failed', { agentId, error: String(err) });
      }
    }

    const sessionWorkspace = isAgentInCtrlnode(agentId) ? ctrlnodePath : agentInfo.workspace;

    await this._invokeSessionsSpawn({
      agentId,
      taskId,
      message: prompt,
      taskFolderName,
      sessionWorkspace,
      executionId,
      callbacks,
    });
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const { agentId, taskId, sessionId, sessionKey, message, intentType, executionId } = params;
    const agentInfo = discoveredAgents[agentId];
    if (!agentInfo) {
      callbacks.onComplete('failed', 'AGENT_NOT_FOUND');
      return;
    }

    const toolName = (sessionId || sessionKey) ? 'sessions_send' : 'sessions_spawn';
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (OPENCLAW_GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;

    const url = `${OPENCLAW_GATEWAY_URL.replace(/\/$/, '')}/tools/invoke`;
    const sendKey = sessionKey || sessionId || 'main';

    const requestBody = toolName === 'sessions_send'
      ? { tool: toolName, agentId, args: { sessionKey: sendKey, message } }
      : { tool: toolName, agentId, args: { task: message, message }, sessionKey: `agent:${agentId}:main` };

    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
      const text = await response.text();
      if (!response.ok) {
        const err = `HTTP_${response.status}: ${text.slice(0, 512)}`;
        const status = classifyTaskTerminalStatus(response.status, text);
        callbacks.onComplete(status, err);
        return;
      }
      const result = JSON.parse(text);
      const resultText = result.result?.content?.[0]?.text || text;
      callbacks.onMessage(resultText);
      callbacks.onComplete('completed');
    } catch (err: any) {
      callbacks.onComplete('failed', err?.message || 'INVOKE_ERROR');
    }
  }

  async invokeTool(msg: BridgeMessage, sendToSaas: (payload: any) => void): Promise<void> {
    // Delegate to the existing handleInvokeTool logic via a minimal ctx-like adapter.
    // This is imported lazily to avoid circular deps at module load time.
    const { handleInvokeTool } = await import('../intentHandlers');
    await handleInvokeTool(msg, {
      sendToSaas,
      syncAgents: () => {},
      provider: this,
    });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(agentId: string | undefined, useCtrlnode: boolean): string | null {
    // OpenClaw always roots under its own state directory, never under AGENTS_FOLDER.
    if (useCtrlnode) return path.join(path.dirname(ctrlnodePath), 'ctrlnode');
    const id = normalizeAgentId(agentId ?? '');
    return discoveredAgents[id]?.workspace ?? null;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    // OpenClaw always places workspaces inside its own state directory.
    return path.dirname(ctrlnodePath);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _invokeSessionsSpawn(opts: {
    agentId: string;
    taskId: string;
    message: string;
    taskFolderName?: string;
    sessionWorkspace: string;
    executionId?: string;
    callbacks: TaskCallbacks;
  }): Promise<void> {
    const { agentId, taskId, message, taskFolderName, sessionWorkspace, callbacks } = opts;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (OPENCLAW_GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
    const url = `${OPENCLAW_GATEWAY_URL.replace(/\/$/, '')}/tools/invoke`;

    const requestBody = {
      tool: 'sessions_spawn',
      agentId,
      args: { task: message, message },
      sessionKey: `agent:${agentId}:main`,
    };

    logger.info('openclaw_provider.spawn_attempt', { agentId, taskId, url });

    try {
      const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
      const text = await response.text();

      if (!response.ok) {
        const err = `HTTP_${response.status}: ${text.slice(0, 512)}`;
        logger.error('openclaw_provider.spawn_error', { agentId, status: response.status, body: text.slice(0, 512) });
        const terminalStatus = classifyTaskTerminalStatus(response.status, text);
        callbacks.onComplete(terminalStatus, err);
        return;
      }

      const toolResult = JSON.parse(text);
      const resultText = toolResult.result?.content?.[0]?.text || text;
      const spawnDetails = toolResult.result?.details as { status?: string; error?: string; childSessionKey?: string } | undefined;

      if (spawnDetails?.status === 'error') {
        const reason = spawnDetails.error?.trim() || 'sessions_spawn reported status error';
        logger.warn('openclaw_provider.spawn_internal_error', { agentId, taskId, reason });
        callbacks.onComplete('blocked', reason);
        return;
      }

      if (spawnDetails?.childSessionKey) {
        setTaskSubagentSession(taskId, spawnDetails.childSessionKey);
      }

      // Do NOT forward the spawn ack JSON as agent activity — it is a gateway handshake,
      // not model output. Real agent text arrives via the JSONL poller below.

      // Start polling for task completion via session JSONL files
      startMainSessionPolling(
        agentId,
        taskId,
        taskFolderName,
        sessionWorkspace,
        (payload) => {
          if (payload.action === 'task_complete') {
            callbacks.onComplete(payload.status || 'completed', payload.reason);
          } else {
            callbacks.onMessage(payload.message || '');
          }
        },
        () => {} // setAgentRunning — handled externally by websocket.ts
      );

      logger.info('openclaw_provider.spawn_ok', { agentId, taskId });
    } catch (err: any) {
      logger.error('openclaw_provider.spawn_exception', { agentId, taskId, error: err?.message });
      callbacks.onComplete('failed', err?.message || 'INVOKE_ERROR');
    }
  }
}
