// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from './agentDiscovery';
import { handleIntentAction } from './intentHandlers';

describe('handleIntentAction — task failure propagation', () => {
  const agentId = 'agent-bridge-1';
  const taskId = 'b8f5b38d-2f28-4c8f-9a1c-2f5e8a6d3f61';
  const requestId = 'req-123';
  const executionId = 'exec-123';
  const errorMessage = 'Unable to connect. Is the computer able to access the url?';
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    discoveredAgents[agentId] = {
      workspace: '/tmp/ctrlnode-agent',
      name: 'Bridge Agent',
      model: 'default',
    };

    globalThis.fetch = mock(() => Promise.reject(new Error(errorMessage))) as any;
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
    globalThis.fetch = originalFetch;
  });

  test('sends task_complete failed with the fetch error reason when sessions_spawn throws', async () => {
    const sendToSaas = mock(() => {});
    const ctx = {
      sendToSaas,
      syncAgents: mock(() => {}),
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
      source: 'intent_exception',
    }));

    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'intent_result',
      requestId,
      agentId,
      executionId,
      contextTaskId: taskId,
      error: errorMessage,
    }));
  });

  test('sends task_complete blocked with the response error reason when sessions_spawn returns 401 unauthorized', async () => {
    const unauthorizedBody = '{"error":{"message":"Unauthorized","type":"unauthorized"}}';
    globalThis.fetch = mock(() => Promise.resolve(new Response(unauthorizedBody, {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))) as any;

    const sendToSaas = mock(() => {});
    const ctx = {
      sendToSaas,
      syncAgents: mock(() => {}),
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
      reason: `HTTP_401: ${unauthorizedBody}`,
      source: 'intent_response_error',
    }));
  });
});
