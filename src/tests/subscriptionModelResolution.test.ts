import { describe, expect, test } from 'bun:test';
import { readCodexSubscriptionModels, resolveModelsWithSubscriptionFirst } from '../subscriptionModelResolution.js';
import { chooseCodexExecutable, resolveCodexExecutableFromLookup } from '../providers/CodexSdkProvider.js';

describe('resolveModelsWithSubscriptionFirst', () => {
  test('uses subscription models before attempting an API key', async () => {
    let apiAttempted = false;
    const result = await resolveModelsWithSubscriptionFirst(
      async () => ['subscription-model'],
      async () => { apiAttempted = true; return ['api-model']; },
    );

    expect(result).toEqual(['subscription-model']);
    expect(apiAttempted).toBe(false);
  });

  test('falls back to API models when subscription has no models', async () => {
    const result = await resolveModelsWithSubscriptionFirst(
      async () => [],
      async () => ['api-model'],
    );

    expect(result).toEqual(['api-model']);
  });

  test('reads Codex subscription models from the local models cache', async () => {
    const result = await readCodexSubscriptionModels('C:/codex', async () => JSON.stringify({
      models: [{ slug: 'gpt-5.6-sol', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }],
    }));

    expect(result).toEqual(['gpt-5.6-sol']);
  });

  test('chooses a Windows executable over npm wrapper candidates', () => {
    expect(chooseCodexExecutable(['C:/npm/codex', 'C:/npm/codex.cmd', 'C:/Codex/codex.exe'], 'win32'))
      .toBe('C:/Codex/codex.exe');
  });

  test('keeps the resolved executable stable when the lookup later changes', () => {
    const lookupResults = [
      ['C:/Codex/codex.exe'],
      [],
    ];
    let lookupIndex = 0;
    const lookup = () => lookupResults[Math.min(lookupIndex++, lookupResults.length - 1)];

    const first = resolveCodexExecutableFromLookup(lookup, 'win32');
    const second = resolveCodexExecutableFromLookup(lookup, 'win32', first);

    expect(first).toBe('C:/Codex/codex.exe');
    expect(second).toBe(first);
  });
});
