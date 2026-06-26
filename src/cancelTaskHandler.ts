import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';

export async function handleCancelTask(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { taskId, agentId } = msg;
  if (!taskId) {
    logger.warn('cancel_task.missing_task_id', { agentId });
    return;
  }

  const provider = ctx.provider;
  if (typeof provider.cancelRun !== 'function') {
    logger.warn('cancel_task.not_supported', { agentId, taskId, provider: provider.constructor?.name });
    return;
  }

  logger.info('cancel_task.received', { agentId, taskId });
  try {
    await provider.cancelRun(taskId);
    logger.info('cancel_task.done', { agentId, taskId });
  } catch (err: any) {
    logger.error('cancel_task.error', { agentId, taskId, error: err.message });
  }
}
