// @ts-nocheck
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { discoveredAgents } from '../agentDiscovery';

/**
 * generateStructuredPlan talks to the same cursor-sdk-runner.mjs subprocess as
 * dispatchTask, but sends { command: 'plan' } and expects a single
 * plan_result/plan_error line instead of the full task_* event stream — the
 * runner creates an ephemeral (non-resumable) Cursor Cloud Agent and deletes
 * it immediately after, so no session is left behind.
 */
describe('CursorSdkProvider.generateStructuredPlan', () => {
  const agentId = 'cursor-planner';
  const originalApiKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    process.env.CURSOR_API_KEY = 'test-key';
    discoveredAgents[agentId] = { workspace: process.cwd(), name: 'Planner', model: 'composer-2' };
  });

  afterEach(() => {
    process.env.CURSOR_API_KEY = originalApiKey;
    delete discoveredAgents[agentId];
    mock.restore();
  });

  function fakeProc() {
    const proc: any = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = mock(() => { proc.killed = true; });
    return proc;
  }

  test('sends a plan command and resolves with the runner plan_result text', async () => {
    let proc: any;
    let stdinWritten = '';
    mock.module('child_process', () => ({
      spawn: mock(() => {
        proc = fakeProc();
        proc.stdin.on('data', (chunk: Buffer) => { stdinWritten += chunk.toString(); });
        return proc;
      }),
    }));

    const { CursorSdkProvider } = await import('../providers/CursorSdkProvider');
    const provider = new CursorSdkProvider();

    const resultPromise = provider.generateStructuredPlan({
      agentId,
      prompt: 'Create a daily engineering brief graph.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({ type: 'plan_result', text: '{"name":"Daily brief"}' }) + '\n');

    const result = await resultPromise;
    expect(result).toBe('{"name":"Daily brief"}');

    const sent = JSON.parse(stdinWritten.trim());
    expect(sent).toEqual(expect.objectContaining({
      command: 'plan',
      prompt: 'Create a daily engineering brief graph.',
      model: 'composer-2',
      apiKey: 'test-key',
      timeoutMs: 90_000,
    }));
  });

  test('rejects with the runner plan_error message', async () => {
    let proc: any;
    mock.module('child_process', () => ({
      spawn: mock(() => { proc = fakeProc(); return proc; }),
    }));

    const { CursorSdkProvider } = await import('../providers/CursorSdkProvider');
    const provider = new CursorSdkProvider();

    const resultPromise = provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    await new Promise((r) => setTimeout(r, 20));
    proc.stdout.write(JSON.stringify({ type: 'plan_error', error: 'Invalid or unauthorized Cursor API key.' }) + '\n');

    await expect(resultPromise).rejects.toThrow('Invalid or unauthorized Cursor API key.');
  });

  test('rejects with GRAPH_GENERATION_TIMEOUT and kills the process when the runner never responds', async () => {
    let proc: any;
    mock.module('child_process', () => ({
      spawn: mock(() => { proc = fakeProc(); return proc; }),
    }));

    const { CursorSdkProvider } = await import('../providers/CursorSdkProvider');
    const provider = new CursorSdkProvider();

    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 20,
    })).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');
    expect(proc.killed).toBe(true);
  });

  test('rejects immediately when CURSOR_API_KEY is not set, without spawning a process', async () => {
    process.env.CURSOR_API_KEY = '';
    const spawnMock = mock(() => fakeProc());
    mock.module('child_process', () => ({ spawn: spawnMock }));

    const { CursorSdkProvider } = await import('../providers/CursorSdkProvider');
    const provider = new CursorSdkProvider();

    await expect(provider.generateStructuredPlan({
      agentId,
      prompt: 'plan',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    })).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
