// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import path from 'path';

import {
  checkSessionInactivity,
  clearMissingSessionTickState,
  detectStatusTagFromMessages,
  registerMissingSessionTick,
  resolveTaskSessionEntry,
} from './sessionHistoryPoller';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeEntry(timestampIso: string, role = 'assistant', text = 'hello') {
  return JSON.stringify({
    type: 'message',
    timestamp: timestampIso,
    message: { role, content: [{ type: 'text', text }] },
  });
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

const FAKE_WORKSPACE = '/app/workspace';
const TASK_FOLDER = 'tasks/abc-123';
const TASK_ID = 'task-uuid-1';
const AGENT_ID = 'agent-1';

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('checkSessionInactivity — pure inactivity detection', () => {

  test('returns shouldWrite=true when last timestamp exceeds threshold', () => {
    const lines = [makeEntry(minutesAgo(10))];
    const result = checkSessionInactivity(lines, TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(true);
    expect(result.outputPath).toContain(path.join(FAKE_WORKSPACE, TASK_FOLDER, 'output', 'agent_log.md'));
  });

  test('result.outputPath has correct structure', () => {
    const lines = [makeEntry(minutesAgo(10))];
    const result = checkSessionInactivity(lines, TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.outputPath).toBe(path.join(FAKE_WORKSPACE, TASK_FOLDER, 'output', 'agent_log.md'));
  });

  test('returns shouldWrite=false when last activity is recent', () => {
    const lines = [makeEntry(minutesAgo(1))];
    const result = checkSessionInactivity(lines, TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(false);
  });

  test('returns shouldWrite=false when no entry has a timestamp', () => {
    const lines = [
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })
    ];
    const result = checkSessionInactivity(lines, TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(false);
  });

  test('returns shouldWrite=false when taskFolderName is not provided', () => {
    const lines = [makeEntry(minutesAgo(10))];
    const result = checkSessionInactivity(lines, undefined, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(false);
  });

  test('returns shouldWrite=false when lines array is empty', () => {
    const result = checkSessionInactivity([], TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(false);
  });

  test('uses the LAST timestamp entry in the log (not the first)', () => {
    const lines = [
      makeEntry(minutesAgo(20)),  // old — would trigger if it were last
      makeEntry(minutesAgo(1)),   // recent — this is the last entry, no trigger
    ];
    const result = checkSessionInactivity(lines, TASK_FOLDER, FAKE_WORKSPACE, 5);

    expect(result.shouldWrite).toBe(false);
  });
});

// ── Tests: detectStatusTagFromMessages ────────────────────────────────────────

describe('detectStatusTagFromMessages — status tag detection', () => {

  test('returns "done" when TASK_COMPLETED tag is present', () => {
    const messages = [{ role: 'assistant', text: 'Work done. <TASK_COMPLETED:c25f9e6f-dab3-4438-8cdf-0f22b891d006>' }];
    expect(detectStatusTagFromMessages(messages)).toBe('done');
  });

  test('returns "failed" when TASK_FAILED tag is present', () => {
    const messages = [{ role: 'assistant', text: 'Could not proceed. <TASK_FAILED:c25f9e6f-dab3-4438-8cdf-0f22b891d006>' }];
    expect(detectStatusTagFromMessages(messages)).toBe('failed');
  });

  test('returns "blocked" when TASK_BLOCKED tag is present', () => {
    const messages = [{ role: 'assistant', text: 'Waiting for input. <TASK_BLOCKED:c25f9e6f-dab3-4438-8cdf-0f22b891d006>' }];
    expect(detectStatusTagFromMessages(messages)).toBe('blocked');
  });

  test('returns null when no status tag is present', () => {
    const messages = [{ role: 'assistant', text: 'Still working on it.' }];
    expect(detectStatusTagFromMessages(messages)).toBeNull();
  });

  test('returns null for empty message list', () => {
    expect(detectStatusTagFromMessages([])).toBeNull();
  });

  test('detects tag in the first matching message (stops at first match)', () => {
    const messages = [
      { role: 'assistant', text: 'Step 1 done. <TASK_COMPLETED:aaaaaaaa-0000-0000-0000-000000000001>' },
      { role: 'assistant', text: 'Oops. <TASK_FAILED:aaaaaaaa-0000-0000-0000-000000000002>' },
    ];
    expect(detectStatusTagFromMessages(messages)).toBe('done');
  });

  test('is case-insensitive for the tag', () => {
    const messages = [{ role: 'assistant', text: '<task_completed:c25f9e6f-dab3-4438-8cdf-0f22b891d006>' }];
    expect(detectStatusTagFromMessages(messages)).toBe('done');
  });
});

// ── Tests: resolveTaskSessionEntry ─────────────────────────────────────────────

describe('resolveTaskSessionEntry — exact task/session selection', () => {
  test('returns the exact subagent entry for the task when present', () => {
    const index = {
      'agent:agent-1:subagent:task-uuid-1': { sessionId: 'session-a', updatedAt: 1000 },
      'agent:agent-1:subagent:task-uuid-2': { sessionId: 'session-b', updatedAt: 2000 },
      'agent:agent-1:main': { sessionId: 'main-session', updatedAt: 3000 },
    };

    expect(resolveTaskSessionEntry(index, 'agent-1', 'task-uuid-1')).toEqual({
      sessionId: 'session-a',
      updatedAt: 1000,
    });
  });

  test('falls back to main when exact subagent key for taskId is missing', () => {
    const index = {
      'agent:agent-1:subagent:task-uuid-2': { sessionId: 'session-b', updatedAt: 2000 },
      'agent:agent-1:main': { sessionId: 'main-session', updatedAt: 3000 },
    };

    // Sin clave agent:{id}:subagent:{taskId} ni mapping en memoria → sesión principal.
    expect(resolveTaskSessionEntry(index, 'agent-1', 'task-uuid-1')).toEqual({
      sessionId: 'main-session',
      updatedAt: 3000,
    });
  });
});

describe('missing session tick tracking — orphan timer cleanup', () => {
  test('only reaches the stop threshold after three consecutive empty ticks and resets cleanly', () => {
    clearMissingSessionTickState();

    expect(registerMissingSessionTick('task-1')).toEqual({ count: 1, shouldStop: false });
    expect(registerMissingSessionTick('task-1')).toEqual({ count: 2, shouldStop: false });
    expect(registerMissingSessionTick('task-1')).toEqual({ count: 3, shouldStop: true });

    clearMissingSessionTickState();
    expect(registerMissingSessionTick('task-1')).toEqual({ count: 1, shouldStop: false });
  });
});
