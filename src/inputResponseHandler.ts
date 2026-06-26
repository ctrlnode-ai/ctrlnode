import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';

export async function handleInputResponse(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { taskId, agentId, text } = msg as any;
  if (!taskId || !text) {
    logger.warn('input_response.missing_fields', { agentId, taskId });
    return;
  }

  const provider = ctx.provider;
  if (typeof provider.deliverInput !== 'function') {
    logger.warn('input_response.not_supported', { agentId, taskId, provider: provider.constructor?.name });
    return;
  }

  logger.info('input_response.received', { agentId, taskId });
  try {
    await provider.deliverInput(taskId, text);
    logger.info('input_response.delivered', { agentId, taskId });
  } catch (err: any) {
    logger.error('input_response.error', { agentId, taskId, error: err.message });
  }
}
