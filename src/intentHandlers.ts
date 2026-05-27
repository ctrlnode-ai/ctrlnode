import { logger } from './logger';
import { BridgeMessage } from './types';
import { HandlerContext } from './handlerContext';
import { discoveredAgents, agentStatuses } from './agentDiscovery';
import { resolveTargetAgentId } from './agentRouting';
import { getIntentProviderMethod } from './intentDispatchPolicy';
import { setAgentRunning } from './websocket';
import { handleInvokeTool } from './openclawInvoker';

/**
 * Main entry point for action-based intents from SaaS.
 * For dispatch_task, delegates to ctx.provider.dispatchTask() so that different
 * providers (OpenClaw, ClaudeCode) can handle execution differently.
 */
export async function handleIntentAction(msg: BridgeMessage, ctx: HandlerContext, intentType: string): Promise<void> {
  const contextTaskId = msg.contextTaskId ?? msg.taskId;
  const { requestId, args, content, executionId } = msg;
  const providerMethod = getIntentProviderMethod(intentType);
  const targetId = resolveTargetAgentId(msg.agentId);
  let agentInfo = discoveredAgents[targetId!];

  if (!agentInfo) {
    ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'AGENT_NOT_FOUND' });
    return;
  }

  let parsedArgs: any;
  try {
    parsedArgs = typeof args === 'string' && args.trim() ? JSON.parse(args) : (args ?? (content ? { message: content } : undefined));
  } catch {
    parsedArgs = args ?? (content ? { message: content } : undefined);
  }

  logger.debug('intent.received', { agentId: targetId, intentType, providerMethod, executionId, contextTaskId, rawArgs: args });

  // ── dispatch_task: delegate to provider ──────────────────────────────────────
  if (intentType === 'dispatch_task') {
    const prompt = parsedArgs?.task || parsedArgs?.message || content || '';
    if (!prompt) {
      ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, executionId, contextTaskId, error: 'MISSING_INTENT_PAYLOAD' });
      return;
    }

    const taskFolderName = parsedArgs?.taskFolderName ?? msg.taskFolderName;
    const taskMode = parsedArgs?.taskMode as string | undefined;
    const repoPath = parsedArgs?.repoPath as string | undefined;
    const taskLogRelativePath = parsedArgs?.taskLogRelativePath as string | undefined;

    // In repo mode, use the repository root as the working directory instead of the agent workspace.
    const workingDir = (taskMode === 'repo' && repoPath) ? repoPath : agentInfo.workspace;

    // Mark the agent as running immediately so the UI reflects activity from the start.
    setAgentRunning(targetId!);

    try {
      await ctx.provider.dispatchTask(
        {
          agentId: targetId!,
          taskId: contextTaskId || '',
          prompt,
          workingDir,
          tools: parsedArgs?.tools,
          taskFolderName,
          skipSessionWipe: parsedArgs?.skipSessionWipe,
          executionId,
          taskMode,
          repoPath,
          taskLogRelativePath,
        },
        {
          onStream: (event) => {
            if (event?.type === 'assistant' || event?.type === 'tool_use' || event?.type === 'tool_result'
                || event?.kind === 'text_chunk' || event?.kind === 'tool_call' || event?.kind === 'tool_result') {
              setAgentRunning(targetId!);
              ctx.sendToSaas({ action: 'agent_stream', agentId: targetId, taskId: contextTaskId, event });
            }
          },
          onMessage: (text) => {
            setAgentRunning(targetId!);
            ctx.sendToSaas({ action: 'agent_activity', agentId: targetId, taskId: contextTaskId, delta: text });
          },
          onModelDiscovered: (model) => {
            ctx.sendToSaas({ action: 'task_model_update', taskId: contextTaskId, model });
          },
          onComplete: (status, reason) => {
            ctx.sendToSaas({ action: 'task_complete', agentId: targetId, taskId: contextTaskId, status, reason, source: 'provider' });
            ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, result: status });
          },
        }
      );
    } catch (err: any) {
      logger.error('intent.dispatch_task.critical_error', { taskId: contextTaskId, error: err.message, stack: err.stack });
      ctx.sendToSaas({
        action: 'task_complete',
        agentId: targetId,
        taskId: contextTaskId,
        status: 'failed',
        reason: `Bridge provider exception: ${err.message}`,
        source: 'bridge'
      });
      ctx.sendToSaas({
        action: 'intent_result',
        requestId,
        agentId: targetId,
        intentType,
        providerMethod,
        executionId,
        contextTaskId,
        error: 'BRIDGE_INTERNAL_ERROR'
      });
    }
    return;
  }

  // ── followup / agent_command / init_ping: delegate to provider.sendToSession ─
  if (intentType === 'followup' || intentType === 'agent_command') {
    const message = parsedArgs?.message || content || '';
    setAgentRunning(targetId!);

    try {
      await ctx.provider.sendToSession(
        {
          agentId: targetId!,
          taskId: contextTaskId || '',
          sessionId: parsedArgs?.sessionId || parsedArgs?.session_id,
          sessionKey: parsedArgs?.sessionKey,
          message,
          intentType,
          executionId,
        },
        {
          onStream: (event) => {
            if (event?.type === 'assistant' || event?.type === 'tool_use' || event?.type === 'tool_result'
                || event?.kind === 'text_chunk' || event?.kind === 'tool_call' || event?.kind === 'tool_result') {
              setAgentRunning(targetId!);
              ctx.sendToSaas({ action: 'agent_stream', agentId: targetId, taskId: contextTaskId, event });
            }
          },
          onMessage: (text) => {
            setAgentRunning(targetId!);
            ctx.sendToSaas({ action: 'agent_activity', agentId: targetId, taskId: contextTaskId, delta: text });
          },
          onComplete: (status, reason) => {
            ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, result: status, ...(reason ? { error: reason } : {}) });
          },
        }
      );
    } catch (err: any) {
      logger.error('intent.session_action.critical_error', { taskId: contextTaskId, error: err.message });
      ctx.sendToSaas({
        action: 'intent_result',
        requestId,
        agentId: targetId,
        intentType,
        providerMethod,
        executionId,
        contextTaskId,
        error: `BRIDGE_INTERNAL_ERROR: ${err.message}`
      });
    }
    return;
  }

  // ── Other intents (init_ping, etc.): fall through to OpenClaw HTTP invoker ───
  if (!providerMethod) {
    ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, executionId, contextTaskId, error: 'UNSUPPORTED_INTENT' });
    return;
  }

  logger.debug('intent.request', { agentId: targetId, intentType, providerMethod, args: parsedArgs, executionId, contextTaskId });
  await handleInvokeTool(msg, ctx, { intentType, providerMethod });
}

// Re-export so existing callers (messageHandlers.ts, OpenClawProvider) keep working
// without updating their import paths.
export { handleInvokeTool } from './openclawInvoker';
