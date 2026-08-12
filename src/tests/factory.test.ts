// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { createProvider } from '../providers/factory';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { OllamaProvider } from '../providers/OllamaProvider';

describe('factory.createProvider', () => {
  test('"openrouter" resolves to OpenRouterProvider', () => {
    expect(createProvider('openrouter')).toBeInstanceOf(OpenRouterProvider);
  });

  test('"ollama" resolves to OllamaProvider', () => {
    expect(createProvider('ollama')).toBeInstanceOf(OllamaProvider);
  });
});
