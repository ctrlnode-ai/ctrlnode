// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';
import * as AcpCommonReal from '../providers/acpCommon';

describe('HermesAcpProvider.generateStructuredPlan', () => {
  const agentId = 'hermes-planner';

  beforeEach(() => {
    discoveredAgents[agentId] = { workspace: process.cwd(), name: 'Planner', model: 'hermes-4' };
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
    mock.restore();
  });

  function mockAcp(runAcpStructuredPlan: (options: any) => Promise<string>) {
    mock.module('../providers/acpCommon.js', () => ({
      ...AcpCommonReal,
      buildAcpSpawnCommand: (name: string, baseArgs: string[]) => ({ cmd: name, args: baseArgs }),
      runAcpStructuredPlan: mock(runAcpStructuredPlan),
    }));
  }

  function mockHealth(available: boolean) {
    mock.module('../providers/providerHealthUtils.js', () => ({
      checkBinaryExists: mock(async () => available),
      checkHermesAcpAvailable: mock(async () => available),
    }));
  }

  function mockProfile() {
    mock.module('../hermesProfile.js', () => ({
      getHermesProfileHome: mock((id: string) => `/tmp/hermes-profiles/${id}`),
      ensureHermesProfile: mock(() => {}),
    }));
  }

  test('spawns hermes acp with the agent profile HERMES_HOME and returns the planner text', async () => {
    mockHealth(true);
    mockProfile();
    let seenOptions: any;
    mockAcp(async (options: any) => {
      seenOptions = options;
      return '{"name":"Daily brief"}';
    });

    const { HermesAcpProvider } = await import('../providers/HermesAcpProvider');
    const provider = new HermesAcpProvider();
    const result = await provider.generateStructuredPlan({
      agentId,
      prompt: 'Create a daily engineering brief graph.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(seenOptions).toEqual(expect.objectContaining({
      providerLog: 'hermes_acp',
      cmd: 'hermes',
      args: ['acp'],
      cwd: process.cwd(),
      prompt: 'Create a daily engineering brief graph.',
      timeoutMs: 90_000,
    }));
    expect(seenOptions.env.HERMES_HOME).toBe(`/tmp/hermes-profiles/${agentId}`);
  });

  test('rejects with GRAPH_GENERATION_UNSUPPORTED_PROVIDER when ACP is unavailable (CLI-only fallback)', async () => {
    mockHealth(false);
    mockProfile();
    mockAcp(async () => { throw new Error('should not be called'); });

    const { HermesAcpProvider } = await import('../providers/HermesAcpProvider');
    const provider = new HermesAcpProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    })).rejects.toThrow('GRAPH_GENERATION_UNSUPPORTED_PROVIDER');
  });

  test('propagates a planner error without dispatching a task', async () => {
    mockHealth(true);
    mockProfile();
    mockAcp(async () => { throw new Error('GRAPH_GENERATION_TIMEOUT'); });

    const { HermesAcpProvider } = await import('../providers/HermesAcpProvider');
    const provider = new HermesAcpProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    })).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');
  });
});
