// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';
import { handleIntentAction } from '../intentHandlers';

describe('handleIntentAction — generate_graph_blueprint', () => {
  const agentId = 'planning-agent';

  beforeEach(() => {
    discoveredAgents[agentId] = {
      workspace: '/tmp/planning-agent',
      name: 'Planning agent',
      model: 'sonnet',
    };
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
  });

  test('returns the planner JSON without dispatching a task or emitting task activity', async () => {
    const graphJson = '{"name":"Daily brief","nodes":[]}';
    const sendToSaas = mock(() => {});
    const provider = {
      providerName: 'test-provider',
      discoverAgents: mock(async () => []),
      dispatchTask: mock(async () => {}),
      sendToSession: mock(async () => {}),
      generateStructuredPlan: mock(async () => graphJson),
      invokeTool: mock(async () => {}),
      dispose: mock(async () => {}),
    };

    await handleIntentAction(
      {
        action: 'generate_graph_blueprint',
        requestId: 'preview-123',
        agentId,
        args: JSON.stringify({ prompt: 'Create a daily engineering brief.' }),
      } as any,
      { sendToSaas, syncAgents: mock(() => {}), provider } as any,
      'generate_graph_blueprint',
    );

    expect(provider.generateStructuredPlan).toHaveBeenCalledWith(expect.objectContaining({
      agentId,
      prompt: 'Create a daily engineering brief.',
      workingDir: '/tmp/planning-agent',
      timeoutMs: 300_000,
    }));
    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'intent_result',
      requestId: 'preview-123',
      agentId,
      intentType: 'generate_graph_blueprint',
      result: graphJson,
    }));
    expect(provider.dispatchTask).not.toHaveBeenCalled();
    expect(sendToSaas).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'task_complete' }));
    expect(sendToSaas).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'agent_activity' }));
  });

  test('returns a stable timeout code without dispatching a task', async () => {
    const sendToSaas = mock(() => {});
    const provider = {
      providerName: 'test-provider',
      discoverAgents: mock(async () => []),
      dispatchTask: mock(async () => {}),
      sendToSession: mock(async () => {}),
      generateStructuredPlan: mock(async () => { throw new Error('Graph generation timed out'); }),
      invokeTool: mock(async () => {}),
      dispose: mock(async () => {}),
    };

    await handleIntentAction(
      { action: 'generate_graph_blueprint', requestId: 'preview-timeout', agentId, args: JSON.stringify({ prompt: 'Create a graph.' }) } as any,
      { sendToSaas, syncAgents: mock(() => {}), provider } as any,
      'generate_graph_blueprint',
    );

    expect(sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'intent_result',
      requestId: 'preview-timeout',
      error: 'GRAPH_GENERATION_TIMEOUT',
    }));
    expect(provider.dispatchTask).not.toHaveBeenCalled();
  });
});
