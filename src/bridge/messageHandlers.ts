/**
 * @file messageHandlers.ts
 * @description Thin message router for SaaS WebSocket actions.
 */

import { BridgeMessage } from './types';
import { logger } from './logger';
import { HandlerContext } from './handlerContext';
import {
  handleCreateWorkspace,
  handleDeleteAgentConfig,
  handleDeleteAgentFolders,
  handleDeletePath,
  handleListFiles,
  handleReadFile,
  handleSyncConfig,
  handleUpdateAgentConfig,
  handleWriteFile,
  handleCheckTaskOutput,
  handleActivatePipelineTask,
} from './filesystemConfigHandlers';
import { handleIntentAction, handleInvokeTool } from './intentHandlers';

export type { HandlerContext, SendFn } from './handlerContext';

export async function handleMessage(raw: { toString(): string }, ctx: HandlerContext): Promise<void> {
  let msg: BridgeMessage;
  try {
    msg = JSON.parse(raw.toString());
    logger.info('saas_message_received', { action: msg.action, agentId: msg.agentId, requestId: msg.requestId });
  } catch {
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
    default:
      break;
  }
}
