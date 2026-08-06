// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';
import * as AcpCommonReal from '../providers/acpCommon';

describe('CopilotAcpProvider.generateStructuredPlan', () => {
  const agentId = 'copilot-planner';

  beforeEach(() => {
    discoveredAgents[agentId] = { workspace: process.cwd(), name: 'Planner', model: 'gpt-5' };
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
    mock.restore();
  });

  test('spawns the copilot ACP CLI in stdio mode and returns the planner text', async () => {
    let seenOptions: any;
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(async (options: any) => {
        seenOptions = options;
        return '{"name":"Daily brief"}';
      }),
    }));

    const { CopilotAcpProvider } = await import('../providers/CopilotAcpProvider');
    const provider = new CopilotAcpProvider();
    const result = await provider.generateStructuredPlan({
      agentId,
      prompt: 'Create a daily engineering brief graph.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(seenOptions).toEqual(expect.objectContaining({
      providerLog: 'copilot_acp',
      cmd: 'copilot',
      args: ['--acp', '--stdio'],
      cwd: process.cwd(),
      prompt: 'Create a daily engineering brief graph.',
      timeoutMs: 90_000,
    }));
  });

  test('propagates a planner error without dispatching a task', async () => {
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(async () => { throw new Error('GRAPH_GENERATION_UNSUPPORTED_PROVIDER'); }),
    }));

    const { CopilotAcpProvider } = await import('../providers/CopilotAcpProvider');
    const provider = new CopilotAcpProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    })).rejects.toThrow('GRAPH_GENERATION_UNSUPPORTED_PROVIDER');
  });
});
