// @ts-nocheck
import { describe, expect, mock, test } from 'bun:test';

import { MultiProvider } from '../providers/MultiProvider';

describe('MultiProvider.generateStructuredPlan', () => {
  test('routes a graph planning request to the discovered agent owner', async () => {
    const childProvider = {
      providerName: 'claude-sdk',
      discoverAgents: mock(async () => [{ id: 'planner', name: 'Planner', workspace: '/tmp/planner' }]),
      dispatchTask: mock(async () => {}),
      sendToSession: mock(async () => {}),
      generateStructuredPlan: mock(async () => '{"name":"Daily brief"}'),
      invokeTool: mock(async () => {}),
      dispose: mock(async () => {}),
    };
    const provider = new MultiProvider([childProvider]);
    await provider.discoverAgents();

    const result = await provider.generateStructuredPlan({
      agentId: 'planner',
      prompt: 'Create a daily brief.',
      workingDir: '/tmp/planner',
      timeoutMs: 90_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(childProvider.generateStructuredPlan).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'planner' }));
  });
});
