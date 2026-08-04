// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';
import * as AcpCommonReal from '../providers/acpCommon';

describe('GeminiAcpProvider.generateStructuredPlan', () => {
  const agentId = 'gemini-planner';

  beforeEach(() => {
    discoveredAgents[agentId] = { workspace: process.cwd(), name: 'Planner', model: 'gemini-2.5-pro' };
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
    mock.restore();
  });

  test('spawns the gemini ACP CLI in yolo mode with the registered model and returns the planner text', async () => {
    let seenOptions: any;
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(async (options: any) => {
        seenOptions = options;
        return '{"name":"Daily brief"}';
      }),
    }));

    const { GeminiAcpProvider } = await import('../providers/GeminiAcpProvider');
    const provider = new GeminiAcpProvider();
    const result = await provider.generateStructuredPlan({
      agentId,
      prompt: 'Create a daily engineering brief graph.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(seenOptions).toEqual(expect.objectContaining({
      providerLog: 'gemini_acp',
      cmd: 'gemini',
      cwd: process.cwd(),
      prompt: 'Create a daily engineering brief graph.',
      timeoutMs: 90_000,
    }));
    expect(seenOptions.args).toEqual(expect.arrayContaining(['--acp', '--approval-mode', 'yolo', '--model', 'gemini-2.5-pro']));
  });

  test('omits --model when the agent has no registered model', async () => {
    delete discoveredAgents[agentId];
    discoveredAgents[agentId] = { workspace: process.cwd(), name: 'Planner' };
    let seenOptions: any;
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(async (options: any) => { seenOptions = options; return '{}'; }),
    }));

    const { GeminiAcpProvider } = await import('../providers/GeminiAcpProvider');
    const provider = new GeminiAcpProvider();
    await provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    expect(seenOptions.args).not.toContain('--model');
  });

  test('propagates a planner error without dispatching a task', async () => {
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(async () => { throw new Error('GRAPH_GENERATION_TIMEOUT'); }),
    }));

    const { GeminiAcpProvider } = await import('../providers/GeminiAcpProvider');
    const provider = new GeminiAcpProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    })).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');
  });
});
