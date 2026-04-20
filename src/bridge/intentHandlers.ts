import path from 'path';
import fs from 'fs';
import { logger } from './logger';
import { BridgeMessage } from './types';
import { HandlerContext } from './handlerContext';
import { discoveredAgents, isAgentInCtrlnode } from './agentDiscovery';
import { resolveTargetAgentId } from './agentRouting';
import { OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, OPENCLAW_CONFIG, ctrlnodePath } from './config';
import { wipeAgentSessions } from './fileSystem';
import { getIntentProviderMethod } from './intentDispatchPolicy';
import {
  startMainSessionPolling,
  stopMainSessionPolling,
} from './sessionHistoryPoller';

/**
 * Main entry point for action-based intents from SaaS.
 */
export async function handleIntentAction(msg: BridgeMessage, ctx: HandlerContext, intentType: string): Promise<void> {
  const { requestId, args, content, executionId, contextTaskId } = msg;
  const providerMethod = getIntentProviderMethod(intentType);
  const targetId = resolveTargetAgentId(msg.agentId);
  const agentInfo = discoveredAgents[targetId!];

  if (!agentInfo) {
    ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'AGENT_NOT_FOUND' });
    return;
  }
  if (!providerMethod) {
    ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, executionId, contextTaskId, error: 'UNSUPPORTED_INTENT' });
    return;
  }

  let parsedArgs: any;
  try {
    parsedArgs = typeof args === 'string' && args.trim() ? JSON.parse(args) : (args ?? (content ? { message: content } : undefined));
  } catch {
    parsedArgs = args ?? (content ? { message: content } : undefined);
  }

  if (parsedArgs === undefined || parsedArgs === null) {
    ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'MISSING_INTENT_PAYLOAD' });
    return;
  }

  logger.info('intent.received', { agentId: targetId, intentType, providerMethod, executionId, contextTaskId, rawArgs: args });
  logger.info('intent.request', { agentId: targetId, intentType, providerMethod, args: parsedArgs, executionId, contextTaskId });

  // ── Dispatch: Unified Tool Invoker ───────────────────────────────────────────
  await handleInvokeTool(msg, ctx, { intentType, providerMethod });
}

/**
 * Forwards a tool-invocation request to the local OpenClaw gateway
 * (`POST /tools/invoke`) and relays the response back to the SaaS.
 */
export async function handleInvokeTool(
  msg: BridgeMessage,
  ctx: HandlerContext,
  metadata?: { intentType?: string; providerMethod?: string }
): Promise<void> {
  const { requestId, executionId, contextTaskId, args, content } = msg;
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
    toolName = 'ping';
    toolArgs = {};
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
          logger.info('dispatch_task.sessions_wiped', { agentId: targetId });
        } catch (err) {
          logger.warn('dispatch_task.sessions_wipe_failed', { agentId: targetId, error: String(err) });
        }
      } else {
        logger.info('dispatch_task.sessions_wipe_skipped', { agentId: targetId, reason: 'non-first pipeline task' });
      }
      // TODO: workspace context injection disabled for simplicity.
      // Uncomment to prepend SOUL/TOOLS/BOOTSTRAP/etc. into every task dispatch:
      // const workspaceContext = agentInfo.workspace ? readWorkspaceContext(agentInfo.workspace) : null;

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
      task: toolArgs.task || toolArgs.message || content || "Process intent",
      message: toolArgs.message || toolArgs.task || content || "Process intent"
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
  let requestBody: any;

  if (toolName === 'sessions_send') {
    // Strict schema for message delivery.
    // OpenClaw sessions.send requires sessionKey (or label) + optionally sessionId.
    // Use the named sessionKey if provided; fall back to effectiveSessionId as a key.
    // sessions_send tool schema: { sessionKey, label, agentId, message, timeoutSeconds }
    // sessionKey wins; fall back to effectiveSessionKey (built from toolArgs.sessionKey or 'main').
    // sessionId is NOT part of the tool schema — it's resolved internally by OpenClaw.
    const rawSendKey = toolArgs?.sessionKey || effectiveSessionKey || effectiveSessionId;
    // Strip the 'agent:{agentId}:' prefix — OpenClaw treats fully-qualified keys as cross-agent sends
    const sendKey = typeof rawSendKey === 'string' && rawSendKey.startsWith(`agent:${targetId}:`)
      ? rawSendKey.slice(`agent:${targetId}:`.length)
      : rawSendKey;
    requestBody = {
      tool: toolName,
      agentId: targetId,
      args: {
        sessionKey: sendKey,
        message: toolArgs.message,
        ...(toolArgs.timeoutSeconds != null ? { timeoutSeconds: toolArgs.timeoutSeconds } : {}),
      }
    };
  } else if (toolName === 'sessions_spawn') {
    // Normal logic for spawn (allows more fields but needs task)
    requestBody = {
      tool: toolName,
      agentId: targetId,
      args: {
        ...toolArgs,
        key: effectiveSessionKey
      },
      sessionKey: (targetId && !effectiveSessionKey.startsWith('agent:')) ? `agent:${targetId}:${effectiveSessionKey}` : effectiveSessionKey,
      ...(effectiveSessionId ? { sessionId: effectiveSessionId } : {})
    };
  } else {
    // Generic tool invocation
    requestBody = {
      tool: toolName,
      agentId: targetId,
      args: toolArgs
    };
  }

  logger.info(intentType ? 'intent.http_send_attempt' : 'tool.http_send_attempt', { 
    agentId: targetId, 
    tool: toolName, 
    sessionId: effectiveSessionId, 
    url 
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });

    const text = await response.text();

    if (!response.ok) {
      // Fallback: if sessions_send fails due to visibility restriction, retry as sessions_spawn
      const isVisibilityError = response.status === 403 && text.includes('visibility');
      if (toolName === 'sessions_send' && isVisibilityError) {
        logger.warn('intent.sessions_send_visibility_fallback', {
          agentId: targetId,
          intentType,
          executionId,
          contextTaskId,
          hint: 'Set tools.sessions.visibility=all in OpenClaw config to avoid this fallback'
        });
        // Rebuild as sessions_spawn and retry
        const spawnBody = {
          tool: 'sessions_spawn',
          agentId: targetId,
          args: { ...toolArgs },
          sessionKey: effectiveSessionKey,
        };
        const spawnResponse = await fetch(url, { method: 'POST', headers, body: JSON.stringify(spawnBody) });
        const spawnText = await spawnResponse.text();
        if (!spawnResponse.ok) {
          const err = `HTTP_${spawnResponse.status}: ${spawnText.slice(0, 512)}`;
          logger.error('intent.spawn_fallback_error', { agentId: targetId, tool: 'sessions_spawn', status: spawnResponse.status, body: spawnText.slice(0, 512) });
          ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: 'sessions_spawn', providerMethod, executionId, contextTaskId, error: err });
          return;
        }
        const spawnResult = JSON.parse(spawnText);
        const spawnResultText = spawnResult.result?.content?.[0]?.text || spawnText;
        ctx.sendToSaas({ action: 'agent_message', agentId: targetId, taskId: contextTaskId, message: spawnResultText });
        ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: 'sessions_spawn', providerMethod, executionId, contextTaskId, result: spawnText, resultPreview: spawnText.slice(0, 200) });
        return;
      }

      const err = `HTTP_${response.status}: ${text.slice(0, 512)}`;
      logger.error(intentType ? 'intent.response_error' : 'tool.response_error', { 
        agentId: targetId, 
        tool: toolName, 
        status: response.status, 
        body: text.slice(0, 512), 
        executionId, 
        contextTaskId 
      });

      // If a task-related intent fails at the tool level (e.g. tool not available or 404),
      // we inject a <TASK_BLOCKED:id> tag so the SaaS can block the task automatically.
      if (contextTaskId && (intentType === 'dispatch_task' || intentType === 'agent_command')) {
        const blockTag = `<TASK_BLOCKED:${contextTaskId}>`;
        const blockReason = `Tool invocation failed (${toolName}): ${text.slice(0, 100)}`;
        ctx.sendToSaas({
          action: 'agent_message',
          agentId: targetId,
          taskId: contextTaskId,
          message: `${blockTag}\n\n⚠️ ${blockReason}`
        });
        logger.warn('intent.auto_block_injected', { agentId: targetId, taskId: contextTaskId, tool: toolName });
      }

      ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: toolName, providerMethod, executionId, contextTaskId, error: err });
      return;
    }

    const toolResult = JSON.parse(text);
    const resultText = toolResult.result?.content?.[0]?.text || text;

    // Helper: extract a task result tag UUID from any text (handles markdown table cells, raw tags, yield messages)
    const extractTaskId = (src: string): string | undefined =>
      src?.match(/TASK_(?:COMPLETED|FAILED|BLOCKED):([0-9a-f-]{36})/)?.[1];

    // For dispatch_task (sessions_spawn), start polling the main session log for
    // completion tags and inactivity timeout.
    if (intentType === 'dispatch_task' && toolName === 'sessions_spawn') {
      const taskIdForSession = contextTaskId || extractTaskId(toolArgs?.message || '');
      if (taskIdForSession) {
        // taskFolderName arrives as a top-level field in toolArgs (e.g. "tasks/06f4feac-makehi").
        // Fall back to msg.taskFolderName for backwards compatibility.
        const folderForLog = toolArgs?.taskFolderName ?? msg.taskFolderName;
        // For ctrlnode agents, taskFolderName already contains the "tasks/" prefix so use
        // ctrlnodePath directly (not ctrlnodePath/tasks) to avoid a double "tasks/tasks/" path.
        const sessionWorkspace = isAgentInCtrlnode(targetId!)
          ? ctrlnodePath
          : agentInfo.workspace;
        startMainSessionPolling(targetId!, taskIdForSession, folderForLog, sessionWorkspace, ctx.sendToSaas.bind(ctx));
        logger.info('dispatch_task.main_session_polling_started', { agentId: targetId, taskId: taskIdForSession, taskFolderName: folderForLog });
      }
    }

    // Log the model's reply to console so it's visible in Bridge logs
    const modelReply = toolResult.result?.details?.reply || toolResult.result?.content?.[0]?.text;
    if (modelReply) {
      logger.info('model.reply', {
        agentId: targetId,
        tool: toolName,
        taskId: contextTaskId,
        reply: modelReply
      });

      // When task ends (status tag or "task completed" keyword), stop main session polling.
      const doneTaskId = contextTaskId || extractTaskId(modelReply);
      const hasStatusTag = /TASK_COMPLETED|TASK_FAILED|TASK_BLOCKED/.test(modelReply);
      const hasCompletedKeyword = !!(contextTaskId && /task.{0,30}completed|completed.{0,30}task/i.test(modelReply));

      if (doneTaskId && (hasStatusTag || hasCompletedKeyword)) {
        stopMainSessionPolling(doneTaskId);
      }

      // Keyword-based completion: agent says "task completed" in chat → notify SaaS
      if (hasCompletedKeyword) {
        logger.info('dispatch_task.keyword_completion_detected', { agentId: targetId, taskId: contextTaskId });
        ctx.sendToSaas({ action: 'task_complete', agentId: targetId, taskId: contextTaskId, source: 'keyword_detection' });
      }
    }

    // Relay the agent's response back to the SaaS for real-time visibility and status parsing
    ctx.sendToSaas({
      action: 'agent_message',
      agentId: targetId,
      taskId: contextTaskId,
      message: resultText
    });

    logger.info(intentType ? 'intent.response' : 'tool.response', { 
      agentId: targetId, 
      tool: toolName, 
      resultPreview: text.slice(0, 1024),
      executionId,
      contextTaskId
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
      resultPreview: text.slice(0, 200)
    });
  } catch (err: any) {
    logger.error(intentType ? 'intent.exception' : 'tool.exception', { agentId: targetId, tool: toolName, error: err?.message, executionId, contextTaskId });
    ctx.sendToSaas({ action: intentType ? 'intent_result' : 'tool_result', requestId, agentId: targetId, intentType, tool: toolName, providerMethod, executionId, contextTaskId, error: err?.message || 'INVOKE_ERROR' });
  }
}
