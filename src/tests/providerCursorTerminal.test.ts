import { describe, expect, test } from 'bun:test';
import {
  classifyCursorSdkTerminal,
  CURSOR_MISSING_API_KEY_REASON,
  CURSOR_INVALID_API_KEY_REASON,
} from '../providers/providerCursorTerminal';

describe('classifyCursorSdkTerminal', () => {
  test('no API key → blocked with missing-key copy', () => {
    const r = classifyCursorSdkTerminal('Error', { hasApiKey: false });
    expect(r.status).toBe('blocked');
    expect(r.reason).toBe(CURSOR_MISSING_API_KEY_REASON);
  });

  test('unauthenticated runner code → blocked', () => {
    const r = classifyCursorSdkTerminal('Error', { hasApiKey: true, runnerCode: 'unauthenticated' });
    expect(r.status).toBe('blocked');
    expect(r.reason).toBe(CURSOR_INVALID_API_KEY_REASON);
  });

  test('generic runtime error → failed', () => {
    const r = classifyCursorSdkTerminal('spawn ENOENT', { hasApiKey: true });
    expect(r.status).toBe('failed');
  });
});
