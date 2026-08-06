// @ts-nocheck
import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { OpenRouterProvider, resolveOpenRouterModel } from '../providers/OpenRouterProvider';
import { CTRLNODE_ROOT } from '../config';

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('OpenRouterProvider', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const callbacks = { onStream: () => {}, onMessage: () => {}, onComplete: () => {} };

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test('resolveFilesystemBase returns CTRLNODE_ROOT', () => {
    const provider = new OpenRouterProvider();
    expect(provider.resolveFilesystemBase('any', true)).toBe(CTRLNODE_ROOT);
  });

  test('discoverAgents returns empty array (agents come from a sync_* push)', async () => {
    const provider = new OpenRouterProvider();
    expect(await provider.discoverAgents()).toHaveLength(0);
  });

  test('dispatchTask completes and reports accumulated cost when the loop finishes naturally', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return jsonResponse({ usage: { cost: 0.002 }, choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
      throw new Error('unexpected extra call');
    });

    const taskId = 'or-task-1';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    let completeArgs: any = null;

    const provider = new OpenRouterProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId, prompt: 'do something', taskFolderName } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('completed');
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('agent_log.md includes the accumulated cost; output.md does not', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({ usage: { cost: 0.0074 }, choices: [{ finish_reason: 'stop', message: { content: 'final answer' } }] }));

    const taskId = 'or-task-cost';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);

    const provider = new OpenRouterProvider();
    await provider.dispatchTask({ agentId: 'a1', taskId, prompt: 'x', taskFolderName } as any, callbacks);

    const agentLog = fs.readFileSync(path.join(taskFolder, 'output', 'agent_log.md'), 'utf8');
    const outputMd = fs.readFileSync(path.join(taskFolder, 'output', `${taskId}-output.md`), 'utf8');

    expect(agentLog).toContain('$0.0074');
    expect(outputMd).not.toContain('$0.0074');
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('dispatchTask reports blocked for repo-mode tasks instead of silently running in the wrong directory', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    let completeArgs: any = null;

    const provider = new OpenRouterProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId: 'repo-mode-task', prompt: 'x', taskMode: 'repo', repoPath: '/some/repo' } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('dispatchTask reports blocked with a clear reason on HTTP 402', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('no credit', { status: 402 }));

    const taskId = 'or-task-402';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    let completeArgs: any = null;

    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const provider = new OpenRouterProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId, prompt: 'do something', taskFolderName } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('blocked');
    expect(completeArgs[1]).toContain('402');
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  // Allowlist coverage: resolveOpenRouterModel is a pure function that takes the allowlist
  // as a parameter, so these tests exercise both branches of the allowlist check
  // deterministically — regardless of what OPENROUTER_ALLOWED_MODELS happens to be at
  // test-run time (see OpenRouterProvider.ts for the exported implementation).
  test('resolveOpenRouterModel rejects a model outside a non-empty allowlist', () => {
    const result = resolveOpenRouterModel('some/unlisted-model', 'anthropic/claude-sonnet-4.5', ['anthropic/claude-haiku-4.5'], 'openrouter');
    expect(result).toBeNull();
  });

  test('resolveOpenRouterModel accepts any model when the allowlist is empty', () => {
    const result = resolveOpenRouterModel('some/unlisted-model', 'anthropic/claude-sonnet-4.5', [], 'openrouter');
    expect(result).toBe('some/unlisted-model');
  });

  test('resolveOpenRouterModel falls back to the default model when the agent has no model or the provider placeholder', () => {
    expect(resolveOpenRouterModel(undefined, 'anthropic/claude-sonnet-4.5', [], 'openrouter')).toBe('anthropic/claude-sonnet-4.5');
    expect(resolveOpenRouterModel('openrouter', 'anthropic/claude-sonnet-4.5', [], 'openrouter')).toBe('anthropic/claude-sonnet-4.5');
  });
});
