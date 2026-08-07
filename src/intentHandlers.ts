import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { discoveredAgents, agentStatuses } from './agentDiscovery.js';
import { resolveTargetAgentId } from './agentRouting.js';
import { getIntentProviderMethod } from './intentDispatchPolicy.js';
import { reportProviderHealth, setAgentRunning } from './websocket.js';
import { handleInvokeTool } from './openclawInvoker.js';
import { prepareFollowupFiles } from './providers/providerFileUtils.js';
import { GRAPH_GENERATION_TIMEOUT_SECONDS, LOG_THINKING } from './config.js';
import { appendTaskProgressLog } from './providers/providerFileUtils.js';

function reportTaskProgress(ctx: HandlerContext, taskId: string | undefined, agentId: string | undefined, taskFolderName: string | undefined, event: any): void {
  if (!taskId || !agentId || !event) return;
  const kind = event.kind === 'thinking_delta' ? 'thinking' : event.kind;
  if (!['thinking', 'text_chunk', 'text_delta', 'tool_call', 'tool_result', 'file_written', 'run_status'].includes(kind)) return;
  const text = typeof event.text === 'string' ? event.text : undefined;
  const path = typeof event.path === 'string' ? event.path : undefined;
  if (kind !== 'thinking' || LOG_THINKING) appendTaskProgressLog(taskFolderName, kind, text, path);
  ctx.sendToSaas({ action: 'task_progress', taskId, agentId, kind, text: kind === 'thinking' && !LOG_THINKING ? undefined : text, path, timestamp: new Date().toISOString() });
}

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

  // ── generate_graph_blueprint: read-only structured planning ──────────────────
  if (intentType === 'generate_graph_blueprint') {
    const prompt = parsedArgs?.prompt || content || '';
    if (!prompt) {
      ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'MISSING_INTENT_PAYLOAD' });
      return;
    }
    if (!ctx.provider.generateStructuredPlan) {
      ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, error: 'GRAPH_GENERATION_UNSUPPORTED_PROVIDER' });
      return;
    }

    try {
      logger.info('graph_generation.started', { agentId: targetId, provider: ctx.provider.providerName });
      const result = await ctx.provider.generateStructuredPlan({
        agentId: targetId!,
        prompt,
        workingDir: agentInfo.workspace,
        timeoutMs: GRAPH_GENERATION_TIMEOUT_SECONDS * 1_000,
      });
      ctx.sendToSaas({ action: 'intent_result', requestId, agentId: targetId, intentType, providerMethod, executionId, contextTaskId, result });
      logger.info('graph_generation.completed', { agentId: targetId, provider: ctx.provider.providerName, responseLength: result.length });
    } catch (err: any) {
      logger.warn('graph_generation.failed', { agentId: targetId, provider: ctx.provider.providerName, error: err?.message });
      const errorMessage = err?.message || 'GRAPH_GENERATION_PROVIDER_ERROR';
      if (/\b(?:401|oauth|auth(?:entication)?|token).*?(?:expired|invalid|required|fail)/i.test(errorMessage))
        reportProviderHealth(agentInfo.provider ?? ctx.provider.providerName, { available: false, reason: 'auth_required' });
      const errorCode = /\b(?:timed?\s*out|abort(?:ed)?)\b/i.test(errorMessage)
        ? 'GRAPH_GENERATION_TIMEOUT'
        : errorMessage;
      ctx.sendToSaas({
        action: 'intent_result',
        requestId,
        agentId: targetId,
        intentType,
        providerMethod,
        executionId,
        contextTaskId,
        error: errorCode,
      });
    }
    return;
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
            reportTaskProgress(ctx, contextTaskId, targetId, taskFolderName, event);
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
          onWaitingForInput: (prompt) => {
            ctx.sendToSaas({ action: 'task_waiting_for_input', agentId: targetId, taskId: contextTaskId, prompt });
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
    const taskFolderName: string | undefined = parsedArgs?.taskFolderName;
    setAgentRunning(targetId!);

    // Write followup input file and build output-file instruction for all providers.
    // Providers with native session resume get only the output-file instruction.
    // Stateless providers (codex, hermes-acp, gemini-acp, copilot-acp) also receive
    // the prior agent_log.md as context so the agent knows what was done before.
    const providerName = ctx.provider.providerName;
    const hasNativeSession = providerName === 'claude-agent-sdk' || providerName === 'claude-code'
      || providerName === 'openclaw' || providerName === 'cursor';
    let augmentedMessage = message;
    if (intentType === 'followup' && (contextTaskId || taskFolderName)) {
      try {
        const { followupLogBlock, followupLogBlockWithHistory } = prepareFollowupFiles(contextTaskId || '', message, taskFolderName);
        const block = hasNativeSession ? followupLogBlock : followupLogBlockWithHistory;
        augmentedMessage = `<system>\n${block}\n</system>\n\n${message}`;
      } catch (e: any) {
        logger.warn('intent.followup_file_prep_failed', { taskId: contextTaskId, error: e?.message });
      }
    }

    try {
      await ctx.provider.sendToSession(
        {
          agentId: targetId!,
          taskId: contextTaskId || '',
          sessionId: parsedArgs?.sessionId || parsedArgs?.session_id,
          sessionKey: parsedArgs?.sessionKey,
          message: augmentedMessage,
          intentType,
          executionId,
          taskFolderName,
        },
        {
          onStream: (event) => {
            reportTaskProgress(ctx, contextTaskId, targetId, taskFolderName, event);
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
            // followup runs in the same session as the original task — emit task_complete so
            // the backend transitions the task back to done/failed after the followup finishes.
            ctx.sendToSaas({ action: 'task_complete', agentId: targetId, taskId: contextTaskId, status, reason, source: 'provider' });
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
export { handleInvokeTool } from './openclawInvoker.js';
