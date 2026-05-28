/**
 * @file openclawInvoker.ts
 * @description HTTP proxy that forwards tool-invocation requests to the local
 * OpenClaw gateway (`POST /tools/invoke`) and relays the response back to SaaS.
 *
 * Extracted from intentHandlers.ts to keep the intent-routing layer thin.
 */

import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { discoveredAgents, isAgentInCtrlnode } from './agentDiscovery.js';
import { resolveTargetAgentId } from './agentRouting.js';
import {
  OPENCLAW_GATEWAY_URL,
  OPENCLAW_GATEWAY_TOKEN,
  OPENCLAW_CONFIG,
  ctrlnodePath,
} from './config.js';
import { wipeAgentSessions } from './fileSystem.js';
import {
  startMainSessionPolling,
  stopMainSessionPolling,
} from './sessionHistoryPoller.js';
import { setAgentRunning } from './websocket.js';
import { setTaskSubagentSession } from './subagentSessions.js';
import {
  sendTaskFailureToSaas,
  sendTaskBlockedToSaas,
  classifyTaskTerminalStatus,
} from './taskResultHelpers.js';

/**
 * Forwards a tool-invocation request to the local OpenClaw gateway
 * (`POST /tools/invoke`) and relays the response back to the SaaS.
 */
export async function handleInvokeTool(
  msg: BridgeMessage,
  ctx: HandlerContext,
  metadata?: { intentType?: string; providerMethod?: string },
): Promise<void> {
  const contextTaskId = msg.contextTaskId ?? msg.taskId;
  const { requestId, executionId, args, content } = msg;
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  const intentType = metadata?.intentType;
  const providerMethod = metadata?.providerMethod || 'gateway_http';

  if (!agentInfo) {
    ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'AGENT_NOT_FOUND' });
    return;
  }

  let toolName = msg.tool || intentType || 'unknown';
  let toolArgs: any;

  // 1. Parse arguments (handle string vs object, fallback to content/args)
  try {
    const rawArgs = args ?? (content ? { message: content } : undefined);
    toolArgs = typeof args === 'string' && args.trim() ? JSON.parse(args) : rawArgs;
  } catch {
    toolArgs = args ?? (content ? { message: content } : undefined);
  }

  // 2. Intent-to-Tool mapping translation
  if (intentType === 'init_ping') {
    // Use sessions_send (not ping) so OpenClaw loads pi-embedded and registers the
    // built-in legacy context engine. A plain /ping call does NOT load the session
    // machinery, leaving the context engine registry empty and causing
    // "Context engine 'legacy' is not registered" on the first sessions_spawn.
    toolName = 'sessions_send';
    // Keep message/sessionKey from args so the NO_REPLY pattern works.
    // If no sessionKey was provided, default to the agent's main session.
    if (!toolArgs?.sessionKey) {
      toolArgs = { ...toolArgs, sessionKey: 'main' };
    }
  } else if (intentType === 'create_session' || toolName === 'sessions_spawn') {
    toolName = 'sessions_spawn';
  } else if (intentType === 'agent_command' || intentType === 'dispatch_task' || intentType === 'followup') {
    const msgText = (toolArgs?.message || '').trim().toLowerCase();
    if (['start', 'stop', '/new', '/reset', 'status'].includes(msgText)) {
      toolName = msgText;
      toolArgs = {};
    } else if (intentType === 'dispatch_task') {
      // sessions_spawn is the correct external-orchestrator → agent injection mechanism.
      // sessions_send is for agent-to-agent (requires agentToAgent.enabled config).
      toolName = 'sessions_spawn';
      // Wipe previous sub-agent session files so each task starts with a clean slate.
      // This mirrors v1.0.0 behaviour: removes all transcripts + resets sessions.json to {}.
      // Skip wipe for non-first pipeline steps (skipSessionWipe=true) so the agent retains
      // session context from earlier steps in the same pipeline run.
      if (!toolArgs?.skipSessionWipe) {
        try {
          wipeAgentSessions(targetId!, OPENCLAW_CONFIG);
          logger.debug('dispatch_task.sessions_wiped', { agentId: targetId });
        } catch (err) {
          logger.warn('dispatch_task.sessions_wipe_failed', { agentId: targetId, error: String(err) });
        }
      } else {
        logger.debug('dispatch_task.sessions_wipe_skipped', { agentId: targetId, reason: 'non-first pipeline task' });
      }

      // Rewrite relative task paths (tasks/{folder}/…) to absolute so the model always
      // gets the correct full path regardless of session state or recovery.
      const originalTask = toolArgs?.task || toolArgs?.message || content || '';
      const absoluteTask = originalTask.replace(/(?<!\/)(tasks\/)/g, `${ctrlnodePath}/tasks/`);
      if (absoluteTask !== originalTask) {
        toolArgs = { ...toolArgs, task: absoluteTask, message: absoluteTask };
      }
    } else {
      // followup/agent_command: send to existing session if we have a sessionId or sessionKey, otherwise spawn
      toolName = (toolArgs?.sessionId || toolArgs?.session_id || toolArgs?.sessionKey) ? 'sessions_send' : 'sessions_spawn';
    }
  }

  const sessionId = toolArgs?.sessionId || toolArgs?.session_id;
  const sessionKey = toolArgs?.sessionKey || 'main';

  // 3. Ensure essential fields are populated for session tools but AVOID deleting fields
  if (toolName === 'sessions_spawn' || toolName === 'sessions_send') {
    toolArgs = {
      ...toolArgs,
      task: toolArgs.task || toolArgs.message || content || 'Process intent',
      message: toolArgs.message || toolArgs.task || content || 'Process intent',
    };
  }

  if (!toolName || toolName === 'unknown') {
    ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'MISSING_TOOL' });
    return;
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (OPENCLAW_GATEWAY_TOKEN) headers['Authorization'] = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;

  // 4. Session routing logic
  const baseUrl = OPENCLAW_GATEWAY_URL.replace(/\/$/, '');
  let effectiveSessionId = sessionId;
  let effectiveSessionKey = sessionKey;
  if (sessionId?.startsWith('agent:')) {
    effectiveSessionKey = sessionId;
  }

  const url = `${baseUrl}/tools/invoke`;
  const requestBody = buildRequestBody(toolName, targetId!, toolArgs, effectiveSessionId, effectiveSessionKey);

  logger.debug(intentType ? 'intent.http_send_attempt' : 'tool.http_send_attempt', {
    agentId: targetId,
    tool: toolName,
    sessionId: effectiveSessionId,
    url,
  });

  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(requestBody) });
    const text = await response.text();

    if (!response.ok) {
      await handleErrorResponse(
        response.status, text, toolName, toolArgs, effectiveSessionKey,
        { url, headers, ctx, targetId: targetId!, requestId, intentType, providerMethod, executionId, contextTaskId },
      );
      return;
    }

    const toolResult = JSON.parse(text);
    const resultText = toolResult.result?.content?.[0]?.text || text;

    await handleSuccessResponse(
      toolResult, toolName, toolArgs, text, resultText,
      { msg, ctx, targetId: targetId!, agentInfo, requestId, intentType, providerMethod, executionId, contextTaskId },
    );
  } catch (err: any) {
    logger.error(intentType ? 'intent.exception' : 'tool.exception', { agentId: targetId, tool: toolName, error: err?.message, executionId, contextTaskId });
    sendTaskFailureToSaas(ctx, targetId!, contextTaskId, err?.message || 'INVOKE_ERROR', 'intent_exception');
    ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: toolName, providerMethod, executionId, contextTaskId, error: err?.message || 'INVOKE_ERROR' });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

function buildRequestBody(
  toolName: string,
  targetId: string,
  toolArgs: any,
  effectiveSessionId: string | undefined,
  effectiveSessionKey: string,
): any {
  if (toolName === 'sessions_send') {
    // sessions_send tool schema: { sessionKey, label, agentId, message, timeoutSeconds }
    // sessionId is NOT part of the tool schema — resolved internally by OpenClaw.
    const rawSendKey = toolArgs?.sessionKey || effectiveSessionKey || effectiveSessionId;
    // Strip the 'agent:{agentId}:' prefix — OpenClaw treats fully-qualified keys as cross-agent sends
    const sendKey = typeof rawSendKey === 'string' && rawSendKey.startsWith(`agent:${targetId}:`)
      ? rawSendKey.slice(`agent:${targetId}:`.length)
      : rawSendKey;
    return {
      tool: toolName,
      agentId: targetId,
      args: {
        sessionKey: sendKey,
        message: toolArgs.message,
        ...(toolArgs.timeoutSeconds != null ? { timeoutSeconds: toolArgs.timeoutSeconds } : {}),
      },
    };
  }

  if (toolName === 'sessions_spawn') {
    return {
      tool: toolName,
      agentId: targetId,
      args: { ...toolArgs, key: effectiveSessionKey },
      sessionKey: (targetId && !effectiveSessionKey.startsWith('agent:'))
        ? `agent:${targetId}:${effectiveSessionKey}`
        : effectiveSessionKey,
      ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {}),
    };
  }

  return { tool: toolName, agentId: targetId, args: toolArgs };
}

interface ResponseContext {
  url: string;
  headers: Record<string, string>;
  ctx: HandlerContext;
  targetId: string;
  requestId: string | undefined;
  intentType: string | undefined;
  providerMethod: string;
  executionId: string | undefined;
  contextTaskId: string | undefined;
}

async function handleErrorResponse(
  status: number,
  text: string,
  toolName: string,
  toolArgs: any,
  effectiveSessionKey: string,
  rCtx: ResponseContext,
): Promise<void> {
  const { url, headers, ctx, targetId, requestId, intentType, providerMethod, executionId, contextTaskId } = rCtx;

  // Fallback: if sessions_send fails due to visibility restriction, retry as sessions_spawn
  const isVisibilityError = status === 403 && text.includes('visibility');
  if (toolName === 'sessions_send' && isVisibilityError) {
    logger.warn('intent.sessions_send_visibility_fallback', {
      agentId: targetId, intentType, executionId, contextTaskId,
      hint: 'Set tools.sessions.visibility=all in OpenClaw config to avoid this fallback',
    });
    const spawnBody = { tool: 'sessions_spawn', agentId: targetId, args: { ...toolArgs }, sessionKey: effectiveSessionKey };
    const spawnResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify(spawnBody) });
    const spawnText = await spawnResponse.text();
    if (!spawnResponse.ok) {
      const err = `HTTP_${spawnResponse.status}: ${spawnText.slice(0, 512)}`;
      logger.error('intent.spawn_fallback_error', { agentId: targetId, tool: 'sessions_spawn', status: spawnResponse.status, body: spawnText.slice(0, 512) });
      const terminalStatus = classifyTaskTerminalStatus(spawnResponse.status, spawnText);
      if (terminalStatus === 'blocked') {
        sendTaskBlockedToSaas(ctx, targetId, contextTaskId, err, 'intent_response_error');
      } else {
        sendTaskFailureToSaas(ctx, targetId, contextTaskId, err, 'intent_response_error');
      }
      ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: 'sessions_spawn', providerMethod, executionId, contextTaskId, error: err });
      return;
    }
    const spawnResult = JSON.parse(spawnText);
    const spawnResultText = spawnResult.result?.content?.[0]?.text || spawnText;
    ctx.sendToSaas({ action: 'agent_message', agentId: targetId, taskId: contextTaskId, message: spawnResultText });
    ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: 'sessions_spawn', providerMethod, executionId, contextTaskId, result: spawnText, resultPreview: spawnText.slice(0, 200) });
    return;
  }

  const err = `HTTP_${status}: ${text.slice(0, 512)}`;
  logger.error(intentType ? 'intent.response_error' : 'tool.response_error', {
    agentId: targetId, tool: toolName, status, body: text.slice(0, 512), executionId, contextTaskId,
  });
  const terminalStatus = classifyTaskTerminalStatus(status, text);
  if (terminalStatus === 'blocked') {
    sendTaskBlockedToSaas(ctx, targetId, contextTaskId, err, 'intent_response_error');
  } else {
    sendTaskFailureToSaas(ctx, targetId, contextTaskId, err, 'intent_response_error');
  }
  ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: toolName, providerMethod, executionId, contextTaskId, error: err });
}

interface SuccessContext {
  msg: BridgeMessage;
  ctx: HandlerContext;
  targetId: string;
  agentInfo: { workspace: string };
  requestId: string | undefined;
  intentType: string | undefined;
  providerMethod: string;
  executionId: string | undefined;
  contextTaskId: string | undefined;
}

const extractTaskIdFromText = (src: string): string | undefined =>
  src?.match(/TASK_(?:COMPLETED|FAILED|BLOCKED):([0-9a-f-]{36})/)?.[1];

async function handleSuccessResponse(
  toolResult: any,
  toolName: string,
  toolArgs: any,
  text: string,
  resultText: string,
  sCtx: SuccessContext,
): Promise<void> {
  const { msg, ctx, targetId, agentInfo, requestId, intentType, providerMethod, executionId, contextTaskId } = sCtx;

  const spawnDetails = toolResult.result?.details as
    | { status?: string; error?: string; childSessionKey?: string }
    | undefined;

  /** OpenClaw often returns HTTP 200 with ok:true while details.status is "error" (e.g. context engine missing). */
  const sessionsSpawnFailed =
    intentType === 'dispatch_task' &&
    toolName === 'sessions_spawn' &&
    spawnDetails?.status === 'error';

  if (sessionsSpawnFailed) {
    const reason = spawnDetails?.error?.trim() || 'sessions_spawn reported status error';
    sendTaskBlockedToSaas(ctx, targetId, contextTaskId, reason, 'sessions_spawn_openclaw_error');
  }

  // Capture child session key produced by sessions_spawn for deterministic subagent resolution.
  if (!sessionsSpawnFailed) {
    try {
      const childKey = toolResult.result?.details?.childSessionKey;
      const taskIdForSession = contextTaskId
        || (typeof toolArgs?.message === 'string' ? extractTaskIdFromText(toolArgs.message) : undefined)
        || undefined;
      if (intentType === 'dispatch_task' && toolName === 'sessions_spawn' && childKey && taskIdForSession) {
        setTaskSubagentSession(taskIdForSession, childKey);
      }
    } catch (e) {
      logger.warn('dispatch_task.spawn_result_handling_failed', { agentId: targetId, error: String(e) });
    }
  }

  // For dispatch_task (sessions_spawn), start polling the main session log for completion tags.
  if (!sessionsSpawnFailed && intentType === 'dispatch_task' && toolName === 'sessions_spawn') {
    const taskIdForSession = contextTaskId || extractTaskIdFromText(toolArgs?.message || '');
    if (taskIdForSession) {
      const folderForLog = toolArgs?.taskFolderName ?? msg.taskFolderName;
      // For ctrlnode agents, taskFolderName already contains the "tasks/" prefix so use
      // ctrlnodePath directly (not ctrlnodePath/tasks) to avoid a double "tasks/tasks/" path.
      const sessionWorkspace = isAgentInCtrlnode(targetId) ? ctrlnodePath : agentInfo.workspace;
      logger.debug('dispatch_task.starting_poller', { taskId: taskIdForSession, folderForLog, sessionWorkspace });
      startMainSessionPolling(targetId, taskIdForSession, folderForLog, sessionWorkspace, ctx.sendToSaas.bind(ctx), setAgentRunning);
    }
  }

  const modelReply = toolResult.result?.details?.reply || toolResult.result?.content?.[0]?.text;
  if (modelReply) {
    const doneTaskId = contextTaskId || extractTaskIdFromText(modelReply);
    const hasStatusTag = /TASK_COMPLETED|TASK_FAILED|TASK_BLOCKED/.test(modelReply);
    const hasCompletedKeyword = !!(contextTaskId && /task.{0,30}completed|completed.{0,30}task/i.test(modelReply));

    if (doneTaskId && (hasStatusTag || hasCompletedKeyword)) {
      stopMainSessionPolling(doneTaskId);
    }
    if (hasCompletedKeyword) {
      ctx.sendToSaas({ action: 'task_complete', agentId: targetId, taskId: contextTaskId, source: 'keyword_detection' });
    }
  }

  ctx.sendToSaas({ action: 'agent_message', agentId: targetId, taskId: contextTaskId, message: resultText });

  logger.debug(intentType ? 'intent.response' : 'tool.response', {
    agentId: targetId, tool: toolName, resultPreview: text.slice(0, 1024), executionId, contextTaskId,
  });

  ctx.sendToSaas({
    action: intentType ? 'intent_result' : 'tool_result',
    requestId,
    agentId: targetId,
    intentType,
    tool: toolName,
    providerMethod,
    executionId,
    contextTaskId,
    result: text,
    resultPreview: text.slice(0, 200),
  });
}
