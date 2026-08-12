// @ts-nocheck
import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import { fetchKnownProviderKeys } from '../providerDiscovery';

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('fetchKnownProviderKeys', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test('returns the deduplicated provider keys on success', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({
        providerKeyByAgentType: {
          OpenClaw: 'openclaw',
          Cursor: 'cursor',
          OpenRouter: 'openrouter',
          Ollama: 'ollama',
          ClaudeCodeAlias: 'claude',
        },
      }),
    );

    const keys = await fetchKnownProviderKeys();
    expect(keys).not.toBeNull();
    expect(new Set(keys)).toEqual(new Set(['openclaw', 'cursor', 'openrouter', 'ollama', 'claude']));
  });

  test('returns null when the response is not ok', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }));
    expect(await fetchKnownProviderKeys()).toBeNull();
  });

  test('returns null when providerKeyByAgentType is missing or empty', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}));
    expect(await fetchKnownProviderKeys()).toBeNull();
  });

  test('returns null when fetch throws', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network down'); });
    expect(await fetchKnownProviderKeys()).toBeNull();
  });
});
