import { describe, expect, test } from 'bun:test';
import {
  createHermesAcpModelTracker,
  extractModelFromConfigOptions,
  hermesModelsMismatch,
  markModelSetApplied,
  observeSessionUpdateForModel,
  resolveHermesRuntimeModel,
  seedTrackerFromSession,
} from './hermesAcpModelTracking';

describe('hermesAcpModelTracking', () => {
  test('seedTrackerFromSession reads currentModelId', () => {
    const tracker = createHermesAcpModelTracker('anthropic/claude-sonnet-4');
    seedTrackerFromSession(tracker, {
      models: { currentModelId: 'copilot-acp:gpt-5.4-mini', availableModels: [] },
    });
    expect(tracker.initialSessionModel).toBe('copilot-acp:gpt-5.4-mini');
    expect(tracker.runtimeModel).toBe('copilot-acp:gpt-5.4-mini');
  });

  test('markModelSetApplied overrides stale session default', () => {
    const tracker = createHermesAcpModelTracker('anthropic/claude-sonnet-4');
    seedTrackerFromSession(tracker, {
      models: { currentModelId: 'copilot-acp:gpt-5.4-mini', availableModels: [] },
    });
    markModelSetApplied(tracker, 'anthropic/claude-sonnet-4');
    expect(resolveHermesRuntimeModel(tracker)).toBe('anthropic/claude-sonnet-4');
  });

  test('observeSessionUpdateForModel reads config_option_update', () => {
    const tracker = createHermesAcpModelTracker();
    observeSessionUpdateForModel(tracker, {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          type: 'select',
          category: 'model',
          id: 'model',
          name: 'Model',
          currentValue: 'sonnet-id',
          options: [{ value: 'sonnet-id', name: 'anthropic/claude-sonnet-4' }],
        },
      ],
    });
    expect(tracker.runtimeModel).toBe('anthropic/claude-sonnet-4');
  });

  test('hermesModelsMismatch ignores matching ids and detects drift', () => {
    expect(hermesModelsMismatch('claude-sonnet-4', 'anthropic/claude-sonnet-4')).toBe(false);
    expect(
      hermesModelsMismatch('anthropic/claude-sonnet-4', 'copilot-acp:gpt-5.4-mini'),
    ).toBe(true);
  });

  test('extractModelFromConfigOptions', () => {
    const model = extractModelFromConfigOptions([
      {
        type: 'select',
        category: 'model',
        currentValue: 'x',
        options: [{ value: 'x', name: 'gpt-5.4-mini' }],
      },
    ]);
    expect(model).toBe('gpt-5.4-mini');
  });
});
