// @ts-nocheck
import { describe, expect, test } from 'bun:test';

import { getIntentProviderMethod } from './intentDispatchPolicy';

describe('intent dispatch policy', () => {
  test('maps supported intents to sessions.send', () => {
    expect(getIntentProviderMethod('dispatch_task')).toBe('sessions.send');
    expect(getIntentProviderMethod('agent_command')).toBe('sessions.send');
    expect(getIntentProviderMethod('followup')).toBeUndefined();
    expect(getIntentProviderMethod('init_ping')).toBe('sessions.send');
  });

  test('returns undefined for unsupported intent', () => {
    expect(getIntentProviderMethod('unknown_intent')).toBeUndefined();
  });
});
