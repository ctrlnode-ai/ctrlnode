// @ts-nocheck
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { discoveredAgents } from '../agentDiscovery';
import * as ConfigReal from '../config';

/**
 * OpenClawProvider.generateStructuredPlan spawns an ephemeral (never-resumed)
 * OpenClaw subagent session via sessions_spawn, polls its transcript on disk
 * for the planner's TASK_COMPLETED tag (sessions_spawn has no synchronous
 * response), then deletes just that one session — main and other sessions
 * must be untouched. This is a soft-read-only guarantee: unlike the SDK-based
 * providers, OpenClaw has no allowedTools:[] equivalent over the gateway, so
 * "read-only" here is enforced only by the prompt instruction.
 */
describe('OpenClawProvider.generateStructuredPlan', () => {
  const agentId = 'compi';
  let tmpDir: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-openclaw-plan-'));
    discoveredAgents[agentId] = { workspace: path.join(tmpDir, 'workspace'), name: 'Compi', model: 'default' };
    mock.module('../config.js', () => ({
      ...ConfigReal,
      OPENCLAW_CONFIG: path.join(tmpDir, 'openclaw.json'),
      GRAPH_GENERATION_SESSION_POLL_MS: 5,
    }));
  });

  afterEach(() => {
    delete discoveredAgents[agentId];
    fetchSpy?.mockRestore();
    mock.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sessionsDir() {
    return path.join(tmpDir, 'agents', agentId, 'sessions');
  }

  /** Extracts the ephemeral sessionKey/planningId OpenClawProvider generated from the spawn request body. */
  function planningIdFromSessionKey(sessionKey: string): string {
    return sessionKey.split(':').pop()!;
  }

  test('spawns an ephemeral subagent session, polls until TASK_COMPLETED, resolves with the text, then deletes the session', async () => {
    let sentBody: any;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      // Simulate OpenClaw flushing the session transcript shortly after the spawn ack.
      setTimeout(() => {
        const planningId = planningIdFromSessionKey(sentBody.sessionKey);
        const dir = sessionsDir();
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
          [sentBody.sessionKey]: { sessionId: 'sess-1' },
        }), 'utf8');
        fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), JSON.stringify({
          type: 'message',
          timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [{ type: 'text', text: `{"name":"Daily brief"}\n<TASK_COMPLETED:${planningId}>` }] },
        }), 'utf8');
      }, 15);
      return new Response(JSON.stringify({ result: { content: [{ text: 'spawned' }], details: { status: 'ok' } } }), { status: 200 });
    });

    const { OpenClawProvider } = await import('../providers/OpenClawProvider');
    const provider = new OpenClawProvider();
    const result = await provider.generateStructuredPlan({
      agentId,
      prompt: 'Create a daily engineering brief graph.',
      workingDir: path.join(tmpDir, 'workspace'),
      timeoutMs: 2_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(sentBody.tool).toBe('sessions_spawn');
    expect(sentBody.agentId).toBe(agentId);
    expect(sentBody.sessionKey).toMatch(new RegExp(`^agent:${agentId}:subagent:`));
    expect(sentBody.args.message).toContain('Create a daily engineering brief graph.');

    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir(), 'sessions.json'), 'utf8'));
    expect(index[sentBody.sessionKey]).toBeUndefined();
  });

  test('rejects with GRAPH_GENERATION_TIMEOUT and still cleans up when the session never completes', async () => {
    let sentBody: any;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      const dir = sessionsDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({
        [sentBody.sessionKey]: { sessionId: 'sess-1' },
      }), 'utf8');
      fs.writeFileSync(path.join(dir, 'sess-1.jsonl'), JSON.stringify({
        type: 'message',
        timestamp: new Date().toISOString(),
        message: { role: 'assistant', content: [{ type: 'text', text: 'still thinking, no tag yet' }] },
      }), 'utf8');
      return new Response(JSON.stringify({ result: { content: [{ text: 'spawned' }], details: { status: 'ok' } } }), { status: 200 });
    });

    const { OpenClawProvider } = await import('../providers/OpenClawProvider');
    const provider = new OpenClawProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: path.join(tmpDir, 'workspace'),
      timeoutMs: 30,
    })).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');

    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir(), 'sessions.json'), 'utf8'));
    expect(index[sentBody.sessionKey]).toBeUndefined();
  });

  test('rejects immediately with the HTTP error when the spawn call itself fails, without polling', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('gateway unavailable', { status: 503 }));

    const { OpenClawProvider } = await import('../providers/OpenClawProvider');
    const provider = new OpenClawProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: path.join(tmpDir, 'workspace'),
      timeoutMs: 2_000,
    })).rejects.toThrow('HTTP_503');
  });

  test('rejects with AGENT_NOT_FOUND for an unregistered agent, without calling fetch', async () => {
    delete discoveredAgents[agentId];
    fetchSpy = spyOn(globalThis, 'fetch');

    const { OpenClawProvider } = await import('../providers/OpenClawProvider');
    const provider = new OpenClawProvider();
    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: path.join(tmpDir, 'workspace'),
      timeoutMs: 2_000,
    })).rejects.toThrow('AGENT_NOT_FOUND');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
