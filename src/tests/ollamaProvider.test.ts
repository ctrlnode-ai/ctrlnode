// @ts-nocheck
import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { OllamaProvider, resolveOllamaModel } from '../providers/OllamaProvider';
import { CTRLNODE_ROOT } from '../config';
import { discoveredAgents } from '../agentDiscovery';

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('OllamaProvider', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const callbacks = { onStream: () => {}, onMessage: () => {}, onComplete: () => {} };

  afterEach(() => { fetchSpy?.mockRestore(); delete discoveredAgents['a1']; });

  test('isAvailable is false when Ollama is not reachable', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('ECONNREFUSED'); });
    const provider = new OllamaProvider();
    expect(await provider.isAvailable()).toBe(false);
  });

  test('listModels returns only locally installed models from /api/tags', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ models: [{ name: 'qwen3-coder:30b' }, { name: 'devstral:24b' }] }));
    const provider = new OllamaProvider();
    expect(await provider.listModels()).toEqual(['devstral:24b', 'qwen3-coder:30b']);
  });

  test('dispatchTask reports blocked for repo-mode tasks instead of silently running in the wrong directory', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    let completeArgs: any = null;

    const provider = new OllamaProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId: 'repo-mode-task', prompt: 'x', taskMode: 'repo', repoPath: '/some/repo' } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('blocked');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('dispatchTask fails fast with a clear message when the model is not installed', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'devstral:24b' }] });
      throw new Error('should not reach chat completions');
    });

    const taskId = 'ol-task-missing-model';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    let completeArgs: any = null;

    discoveredAgents['a1'] = { model: 'qwen3-coder:30b' } as any;
    const provider = new OllamaProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId, prompt: 'do something', taskFolderName } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('failed');
    expect(completeArgs[1]).toContain('ollama pull');
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('dispatchTask sends options.num_ctx on every chat-completions request', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init?: any) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'devstral:24b' }] });
      const body = JSON.parse(init.body);
      expect(body.options?.num_ctx).toBeGreaterThan(0);
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
    });

    const taskId = 'ol-task-numctx';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    discoveredAgents['a1'] = { model: 'devstral:24b' } as any;

    const provider = new OllamaProvider();
    await provider.dispatchTask({ agentId: 'a1', taskId, prompt: 'x', taskFolderName } as any, callbacks);

    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('dispatchTask reports a clear "Ollama not running" message on connection failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'devstral:24b' }] });
      throw new TypeError('fetch failed');
    });

    const taskId = 'ol-task-down';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    let completeArgs: any = null;
    discoveredAgents['a1'] = { model: 'devstral:24b' } as any;

    const provider = new OllamaProvider();
    await provider.dispatchTask(
      { agentId: 'a1', taskId, prompt: 'x', taskFolderName } as any,
      { ...callbacks, onComplete: (...a: any[]) => { completeArgs = a; } },
    );

    expect(completeArgs[0]).toBe('failed');
    expect(completeArgs[1]).toMatch(/ollama serve/i);
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  // Allowlist coverage: resolveOllamaModel is a pure function that takes the allowlist
  // and default model as parameters, so these tests exercise every branch deterministically —
  // regardless of what OLLAMA_ALLOWED_MODELS / OLLAMA_DEFAULT_MODEL happen to be at
  // test-run time (see OllamaProvider.ts for the exported implementation).
  test('resolveOllamaModel rejects a model outside a non-empty allowlist', () => {
    const result = resolveOllamaModel('some-unlisted-model', 'devstral:24b', ['qwen3-coder:30b'], 'ollama');
    expect(result).toBeNull();
  });

  test('resolveOllamaModel accepts any model when the allowlist is empty', () => {
    const result = resolveOllamaModel('some-unlisted-model', 'devstral:24b', [], 'ollama');
    expect(result).toBe('some-unlisted-model');
  });

  test('resolveOllamaModel falls back to the default model when the agent has no model or the provider placeholder', () => {
    expect(resolveOllamaModel(undefined, 'devstral:24b', [], 'ollama')).toBe('devstral:24b');
    expect(resolveOllamaModel('ollama', 'devstral:24b', [], 'ollama')).toBe('devstral:24b');
  });

  test('resolveOllamaModel returns null when there is no agent model and no default model configured', () => {
    // Unique to Ollama: unlike OpenRouter, there is no sensible universal default model
    // to fall back to (OLLAMA_DEFAULT_MODEL defaults to '' when unset).
    expect(resolveOllamaModel(undefined, '', [], 'ollama')).toBeNull();
    expect(resolveOllamaModel('ollama', '', [], 'ollama')).toBeNull();
  });
});
