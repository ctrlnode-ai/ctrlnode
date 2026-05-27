import { describe, expect, test } from 'bun:test';
import { buildHermesAgentsMarkdown, safeHermesAgentDir } from './hermesAgentHome';
import {
  detectHermesCopilotApiFailure,
  hermesAcpModelSetSkipReason,
  normalizeHermesModelId,
  parseHermesModelRef,
  shouldSkipHermesAcpSessionModelSet,
  stripHermesModelPrefix,
} from './hermesModelUtils';

describe('hermesAgentHome', () => {
  test('safeHermesAgentDir normalizes id', () => {
    expect(safeHermesAgentDir('HERMES-AG')).toBe('hermes-ag');
  });

  test('buildHermesAgentsMarkdown includes role and instructions', () => {
    const md = buildHermesAgentsMarkdown(
      { name: 'hermes ag', role: 'Dev', description: 'Always write files.' },
      'hermes-ag',
    );
    expect(md).toContain('# hermes ag');
    expect(md).toContain('## Role');
    expect(md).toContain('Dev');
    expect(md).toContain('## Instructions');
    expect(md).toContain('Always write files.');
    expect(md).toContain('Bridge agent id: hermes-ag');
  });

  test('normalizeHermesModelId replaces spaces', () => {
    expect(normalizeHermesModelId('gpt 5.4 mini')).toBe('gpt-5.4-mini');
    expect(normalizeHermesModelId('  ')).toBeUndefined();
  });

  test('parseHermesModelRef respects provider:model syntax', () => {
    expect(parseHermesModelRef('openrouter:anthropic/claude-sonnet-4')).toEqual({
      explicitProvider: 'openrouter',
      modelPart: 'anthropic/claude-sonnet-4',
    });
    expect(parseHermesModelRef('anthropic/claude-sonnet-4')).toEqual({
      modelPart: 'anthropic/claude-sonnet-4',
    });
  });

  test('shouldSkipHermesAcpSessionModelSet — multi-provider aware', () => {
    expect(shouldSkipHermesAcpSessionModelSet('gpt-5.4-mini')).toBe(true);
    expect(shouldSkipHermesAcpSessionModelSet('copilot-acp:gpt-5.4-mini')).toBe(true);
    expect(shouldSkipHermesAcpSessionModelSet('openrouter:gpt-5.4-mini')).toBe(false);
    expect(shouldSkipHermesAcpSessionModelSet('nous:hermes-3')).toBe(false);
    expect(shouldSkipHermesAcpSessionModelSet('anthropic/claude-sonnet-4')).toBe(false);
    expect(shouldSkipHermesAcpSessionModelSet('claude-sonnet-4-6')).toBe(false);
    expect(
      shouldSkipHermesAcpSessionModelSet('gpt-5.4-mini', 'copilot-acp:gpt-5.4-mini'),
    ).toBe(true);
    expect(
      shouldSkipHermesAcpSessionModelSet('anthropic/claude-sonnet-4', 'copilot-acp:gpt-5.4-mini'),
    ).toBe(false);
  });

  test('hermesAcpModelSetSkipReason', () => {
    expect(hermesAcpModelSetSkipReason('openrouter:gpt-5')).toBe('explicit_provider');
    expect(hermesAcpModelSetSkipReason('gpt-5.4-mini')).toBe('copilot_gpt5_set_model_hermes_bug');
  });

  test('stripHermesModelPrefix', () => {
    expect(stripHermesModelPrefix('copilot-acp:gpt-5.4-mini')).toBe('gpt-5.4-mini');
    expect(stripHermesModelPrefix('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
  });

  test('detectHermesCopilotApiFailure', () => {
    expect(
      detectHermesCopilotApiFailure(
        "API call failed after 3 retries: 'CopilotACPClient' object has no attribute 'responses'",
      ),
    ).toContain('API call failed');
    expect(detectHermesCopilotApiFailure('OK')).toBeUndefined();
  });
});
