import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams } from './IProvider.js';
import { AgentSummary, BridgeMessage } from '../types.js';
import { buildAgentSummaries, discoveredAgents, isAgentInCtrlnode, normalizeAgentId } from '../agentDiscovery.js';
import { resolveTargetAgentId } from '../agentRouting.js';
import { OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_CONFIG, ctrlnodePath, CTRLNODE_ROOT, GRAPH_GENERATION_SESSION_POLL_MS } from '../config.js';
import { wipeAgentSessions, deleteEphemeralSession } from '../fileSystem.js';
import { getIntentProviderMethod } from '../intentDispatchPolicy.js';
import { startMainSessionPolling, stopMainSessionPolling } from '../sessionHistoryPoller.js';
import { readEphemeralPlanResult } from '../sessionLogParser.js';
import { setTaskSubagentSession } from '../subagentSessions.js';
import { logger } from '../logger.js';
import { augmentPromptForRepoMode, isRepoTaskMode } from './repoDispatchContext.js';

type TaskTerminalStatus = 'failed' | 'blocked';

function classifyTaskTerminalStatus(responseStatus: number, responseText: string): TaskTerminalStatus {
  if (responseStatus === 401 || /unauthorized/i.test(responseText)) return 'blocked';
  return 'failed';
}

/**
 * The gateway has no allowedTools:[]-style restriction, so this instruction is
 * the only thing keeping the ephemeral planning session read-only — it is a
 * request, not an enforced constraint, unlike the SDK-based providers.
 */
function buildPlanningPrompt(userPrompt: string, planningId: string): string {
  return `You are generating a read-only structured planning proposal. Do NOT create, write, or modify any files. Do NOT run shell commands or any tool that changes state. Only respond with the requested content below.

${userPrompt}

When you have finished, end your response with this exact tag on its own line and nothing after it:
<TASK_COMPLETED:${planningId}>`;
}

export class OpenClawProvider implements IProvider {
  readonly providerName = 'openclaw';

  async discoverAgents(): Promise<AgentSummary[]> {
    // Only return agents that belong to OpenClaw. buildAgentSummaries() returns
    // ALL agents (including Cursor/Copilot/etc. synced via sync_*_agents). If we
    // return those here, MultiProvider.discoverAgents() would register them under
    // OpenClawProvider in agentOwner, causing dispatches to go to the wrong provider.
    return buildAgentSummaries().filter(a => !a.provider || a.provider === 'openclaw');
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
        logger.debug('dispatch_task.sessions_wiped', { agentId });
      } catch (err) {
        logger.warn('dispatch_task.sessions_wipe_failed', { agentId, error: String(err) });
      }
    }

    const repoMode = isRepoTaskMode(params);
    const sessionWorkspace = repoMode
      ? path.resolve(params.workingDir || params.repoPath!)
      : (isAgentInCtrlnode(agentId) ? ctrlnodePath : agentInfo.workspace);
    const message = augmentPromptForRepoMode(prompt, params);

    logger.info('openclaw_provider.repo_mode', {
      agentId,
      taskId,
      isRepoMode: repoMode,
      sessionWorkspace,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });

    await this._invokeSessionsSpawn({
      agentId,
      taskId,
      message,
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

  /**
   * Read-only structured planning over OpenClaw. Unlike the SDK-based providers,
   * the gateway has no allowedTools:[]-style knob — the ephemeral session runs
   * with the agent's normal toolset, so "read-only" here is a prompt instruction,
   * not an enforced constraint. sessions_spawn also has no synchronous response
   * (only a spawn ack), so the result must be polled from the session transcript
   * OpenClaw writes to disk. The session is always deleted afterward — it is
   * never the agent's main session and is never reused/resumed.
   */
  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const agentInfo = discoveredAgents[params.agentId];
    if (!agentInfo) throw new Error('AGENT_NOT_FOUND');

    const planningId = randomUUID();
    const sessionKey = `agent:${params.agentId}:subagent:${planningId}`;
    const wrappedPrompt = buildPlanningPrompt(params.prompt, planningId);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (OPENCLAW_GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
    const url = `${OPENCLAW_GATEWAY_URL.replace(/\/$/, '')}/tools/invoke`;

    logger.info('openclaw_provider.graph_generation_start', { agentId: params.agentId, planningId });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tool: 'sessions_spawn',
          agentId: params.agentId,
          args: { task: wrappedPrompt, message: wrappedPrompt },
          sessionKey,
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`HTTP_${response.status}: ${text.slice(0, 512)}`);
      }

      const toolResult = JSON.parse(text);
      const spawnDetails = toolResult.result?.details as { status?: string; error?: string } | undefined;
      if (spawnDetails?.status === 'error') {
        throw new Error(spawnDetails.error?.trim() || 'GRAPH_GENERATION_PROVIDER_ERROR');
      }

      const result = await this._pollEphemeralPlan(params.agentId, planningId, params.timeoutMs);
      logger.info('openclaw_provider.graph_generation_completed', { agentId: params.agentId, planningId, responseLength: result.length });
      return result;
    } catch (error: any) {
      logger.warn('openclaw_provider.graph_generation_failed', { agentId: params.agentId, planningId, error: error?.message });
      throw error;
    } finally {
      deleteEphemeralSession(params.agentId, sessionKey, OPENCLAW_CONFIG);
    }
  }

  async invokeTool(msg: BridgeMessage, sendToSaas: (payload: any) => void): Promise<void> {
    // Delegate to the existing handleInvokeTool logic via a minimal ctx-like adapter.
    // This is imported lazily to avoid circular deps at module load time.
    const { handleInvokeTool } = await import('../intentHandlers.js');
    await handleInvokeTool(msg, {
      sendToSaas,
      syncAgents: () => {},
      provider: this,
    });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(agentId: string | undefined, useCtrlnode: boolean): string | null {
    // OpenClaw always roots under its own state directory, never under BASE_PATH.
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

  /**
   * Polls the ephemeral planning session's transcript on disk until the model
   * emits its completion tag or `timeoutMs` elapses. sessions_spawn's HTTP
   * response is only a spawn acknowledgement — OpenClaw writes the actual
   * reply to the session's .jsonl asynchronously, same as dispatch_task.
   */
  private _pollEphemeralPlan(agentId: string, planningId: string, timeoutMs: number): Promise<string> {
    const sessionsDir = path.join(path.dirname(OPENCLAW_CONFIG), 'agents', agentId, 'sessions');
    const sessionsJsonPath = path.join(sessionsDir, 'sessions.json');
    const deadline = Date.now() + timeoutMs;

    return new Promise<string>((resolve, reject) => {
      const tick = () => {
        let index: Record<string, any> = {};
        try {
          if (fs.existsSync(sessionsJsonPath)) {
            index = JSON.parse(fs.readFileSync(sessionsJsonPath, 'utf8'));
          }
        } catch {
          // Transient read/parse race while OpenClaw is writing the file — retry.
        }

        const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);

        if (result.status === 'pending') {
          if (Date.now() >= deadline) {
            reject(new Error('GRAPH_GENERATION_TIMEOUT'));
            return;
          }
          setTimeout(tick, GRAPH_GENERATION_SESSION_POLL_MS);
          return;
        }

        if (result.status === 'done') {
          const finalText = (result.text ?? '').trim();
          if (!finalText) reject(new Error('GRAPH_GENERATION_EMPTY_RESPONSE'));
          else resolve(finalText);
          return;
        }

        // 'failed' or 'blocked' — the agent explicitly declined via the status tag.
        reject(new Error(result.text?.trim() || `GRAPH_GENERATION_PROVIDER_ERROR: session ended as ${result.status}`));
      };
      tick();
    });
  }

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

    logger.debug('openclaw_provider.spawn_attempt', { agentId, taskId, url });

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
