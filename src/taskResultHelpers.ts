/**
 * @file taskResultHelpers.ts
 * @description Helpers for propagating task terminal outcomes (failed / blocked)
 * back to the SaaS via the handler context.
 */

import { logger } from './logger';
import { HandlerContext } from './handlerContext';

export type TaskTerminalStatus = 'failed' | 'blocked';

export function sendTaskTerminalToSaas(
  ctx: HandlerContext,
  agentId: string,
  taskId: string | undefined,
  status: TaskTerminalStatus,
  reason: string,
  source: string,
): void {
  if (!taskId) return;

  const normalizedReason = reason?.trim() || 'INVOKE_ERROR';

  logger.warn('intent.task_terminal_propagated', {
    agentId,
    taskId,
    status,
    source,
    reason: normalizedReason,
  });

  ctx.sendToSaas({
    action: 'task_complete',
    agentId,
    taskId,
    status,
    reason: normalizedReason,
    source,
  });
}

export function sendTaskFailureToSaas(
  ctx: HandlerContext,
  agentId: string,
  taskId: string | undefined,
  reason: string,
  source: string,
): void {
  sendTaskTerminalToSaas(ctx, agentId, taskId, 'failed', reason, source);
}

export function sendTaskBlockedToSaas(
  ctx: HandlerContext,
  agentId: string,
  taskId: string | undefined,
  reason: string,
  source: string,
): void {
  sendTaskTerminalToSaas(ctx, agentId, taskId, 'blocked', reason, source);
}

export function classifyTaskTerminalStatus(responseStatus: number, responseText: string): TaskTerminalStatus {
  if (responseStatus === 401 || /unauthorized/i.test(responseText)) {
    return 'blocked';
  }
  return 'failed';
}
