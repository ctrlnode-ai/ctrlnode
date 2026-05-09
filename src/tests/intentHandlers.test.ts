// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';
import { handleIntentAction } from '../intentHandlers';

function makeProvider(dispatchImpl: (params: any, callbacks: any) => Promise<void>) {
  return {
    discoverAgents: mock(async () => []),
    dispatchTask: mock(dispatchImpl),
    sendToSession: mock(async () => {}),
    invokeTool: mock(async () => {}),
    dispose: mock(async () => {}),
  };
}

describe('handleIntentAction — task failure propagation', () => {
  const agentId = 'agent-bridge-1';
  const taskId = 'b8f5b38d-2f28-4c8f-9a1c-2f5e8a6d3f61';
  const requestId = 'req-123';
  const executionId = 'exec-123';
  const errorMessage = 'Unable to connect. Is the computer able to access the url?';

  beforeEach(() => {
    discoveredAgents[agentId] = {
      workspace: '/tmp/ctrlnode-agent',
      name: 'Bridge Agent',
      model: 'default',
    };
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
  });

  test('sends task_complete failed with the fetch error reason when sessions_spawn throws', async () => {
    const sendToSaas = mock(() => {});
    const provider = makeProvider(async (_params, callbacks) => {
      callbacks.onComplete('failed', errorMessage);
    });
    const ctx = {
      sendToSaas,
      syncAgents: mock(() => {}),
      provider,
    };

    await handleIntentAction(
      {
        action: 'dispatch_task',
        agentId,
        requestId,
        executionId,
        contextTaskId: taskId,
        args: {
          message: 'Run the task',
          skipSessionWipe: true,
        },
      } as any,
      ctx as any,
      'dispatch_task'
    );

    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'task_complete',
      agentId,
      taskId,
      status: 'failed',
      reason: errorMessage,
    }));

    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'intent_result',
      requestId,
      agentId,
      executionId,
      contextTaskId: taskId,
    }));
  });

  test('sends task_complete blocked with the response error reason when sessions_spawn returns 401 unauthorized', async () => {
    const unauthorizedReason = 'HTTP_401: Unauthorized';
    const sendToSaas = mock(() => {});
    const provider = makeProvider(async (_params, callbacks) => {
      callbacks.onComplete('blocked', unauthorizedReason);
    });
    const ctx = {
      sendToSaas,
      syncAgents: mock(() => {}),
      provider,
    };

    await handleIntentAction(
      {
        action: 'dispatch_task',
        agentId,
        requestId,
        executionId,
        contextTaskId: taskId,
        args: {
          message: 'Run the task',
          skipSessionWipe: true,
        },
      } as any,
      ctx as any,
      'dispatch_task'
    );

    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'task_complete',
      agentId,
      taskId,
      status: 'blocked',
    }));
  });
});
