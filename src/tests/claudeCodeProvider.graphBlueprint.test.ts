// @ts-nocheck
import { PassThrough } from 'stream';
import { afterEach, describe, expect, mock, test } from 'bun:test';

function fakeSpawn(): any {
  const proc: any = new (require('events').EventEmitter)();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.killed = false;
  proc.kill = mock(() => { proc.killed = true; });
  return proc;
}

describe('ClaudeCodeProvider.generateStructuredPlan', () => {
  afterEach(() => mock.restore());

  test('uses a generous turn budget while staying read-only (--allowedTools "") for the planner call', async () => {
    let spawnArgs: string[] = [];
    let proc: any;

    mock.module('child_process', () => ({
      spawn: mock((_bin: string, args: string[]) => {
        spawnArgs = args;
        proc = fakeSpawn();
        return proc;
      }),
    }));

    const { ClaudeCodeProvider } = await import('../providers/ClaudeCodeProvider');
    const provider = new ClaudeCodeProvider();

    const resultPromise = provider.generateStructuredPlan({
      agentId: 'claude-planner',
      prompt: 'Create a daily engineering brief graph from local evidence.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    // Let the spawn + listener wiring settle before emitting stdout/close.
    await new Promise((r) => setTimeout(r, 0));
    proc.stdout.write(JSON.stringify({
      type: 'assistant',
      uuid: 'm1',
      message: { content: [{ type: 'text', text: '{"name":"Daily brief"}' }] },
    }) + '\n');
    proc.emit('close', 0);

    const result = await resultPromise;

    expect(result).toBe('{"name":"Daily brief"}');
    // Read-only guarantee: no tools available to the model during graph-blueprint
    // generation (see management/docs/08-04-ai-graph-generation-plan) — only the
    // turn budget changes, not the isolation.
    expect(spawnArgs).toContain('--allowedTools');
    expect(spawnArgs[spawnArgs.indexOf('--allowedTools') + 1]).toBe('');
    expect(spawnArgs).toContain('--max-turns');
    expect(spawnArgs[spawnArgs.indexOf('--max-turns') + 1]).toBe('20');
  });
});
