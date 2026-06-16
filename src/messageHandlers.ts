/**
 * @file messageHandlers.ts
 * @description Thin message router for SaaS WebSocket actions.
 */

import { BridgeMessage } from './types.js';
import { logger } from './logger.js';
import { HandlerContext } from './handlerContext.js';
import { PROVIDERS } from './config.js';
import {
  handleCreateWorkspace,
  handleDeleteAgentConfig,
  handleDeleteAgentFolders,
  handleDeletePath,
  handleListFiles,
  handleReadFile,
  handleSyncConfig,
  handleSyncProviderAgents,
  handleUpdateAgentConfig,
  handleWriteFile,
  handleCheckTaskOutput,
  handleActivatePipelineTask,
} from './filesystemConfigHandlers.js';
import { handleIntentAction, handleInvokeTool } from './intentHandlers.js';
import { applyManifestFromServer } from './modelManifest.js';

/** Actions that only make sense for the OpenClaw provider */
const OPENCLAW_ONLY_ACTIONS = new Set(['sync_config', 'invoke_tool', 'init_ping']);

export type { HandlerContext, SendFn } from './handlerContext.js';

export async function handleMessage(raw: { toString(): string }, ctx: HandlerContext): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = JSON.parse(raw.toString());
    logger.debug('saas_message_received', {
      action: msg.action,
      agentId: msg.agentId,
      requestId: msg.requestId,
      ...(msg.path     !== undefined ? { path:       msg.path }     : {}),
      ...(msg.provider !== undefined ? { provider:   msg.provider } : {}),
      ...(msg.useCtrlnode !== undefined ? { useCtrlnode: msg.useCtrlnode } : {}),
    });
  } catch {
    return;
  }

  if (!PROVIDERS.includes('openclaw') && OPENCLAW_ONLY_ACTIONS.has(msg.action)) {
    ctx.sendToSaas({ action: 'tool_result', requestId: msg.requestId, error: 'NOT_SUPPORTED_BY_PROVIDER', action_requested: msg.action });
    return;
  }

  switch (msg.action) {
    case 'write_file':
      handleWriteFile(msg, ctx);
      break;
    case 'read_file':
      handleReadFile(msg, ctx);
      break;
    case 'list_files':
      handleListFiles(msg, ctx);
      break;
    case 'create_workspace':
      handleCreateWorkspace(msg, ctx);
      break;
    case 'sync_config':
      handleSyncConfig(msg, ctx);
      break;
    case 'update_agent_config':
      handleUpdateAgentConfig(msg, ctx);
      break;
    case 'delete_path':
      await handleDeletePath(msg, ctx);
      break;
    case 'delete_agent_folders':
      await handleDeleteAgentFolders(msg, ctx);
      break;
    case 'delete_agent_config':
      handleDeleteAgentConfig(msg, ctx);
      break;
    case 'dispatch_task':
      await handleIntentAction(msg, ctx, 'dispatch_task');
      break;
    case 'agent_command':
      await handleIntentAction(msg, ctx, 'agent_command');
      break;
    case 'followup':
      await handleIntentAction(msg, ctx, 'followup');
      break;
    case 'init_ping':
      await handleIntentAction(msg, ctx, 'init_ping');
      break;
    case 'invoke_tool':
      await handleInvokeTool(msg, ctx);
      break;
    case 'check_task_output':
      handleCheckTaskOutput(msg, ctx);
      break;
    case 'activate_pipeline_task':
      handleActivatePipelineTask(msg, ctx);
      break;
    case 'sync_cursor_agents':
      handleSyncProviderAgents('cursor', msg, ctx);
      break;
    case 'sync_copilot_agents':
      handleSyncProviderAgents('copilot', msg, ctx);
      break;
    case 'sync_codex_agents':
      handleSyncProviderAgents('codex', msg, ctx);
      break;
    case 'sync_gemini_agents':
      handleSyncProviderAgents('gemini', msg, ctx);
      break;
    case 'sync_claude_agents':
      handleSyncProviderAgents('claude', msg, ctx);
      break;
    case 'sync_claude_sdk_agents':
      handleSyncProviderAgents('claude-sdk', msg, ctx);
      break;
    case 'sync_hermes_agents':
      handleSyncProviderAgents('hermes', msg, ctx);
      break;
    case 'model_manifest':
      applyManifestFromServer(msg as any);
      break;
    default:
      break;
  }
}
