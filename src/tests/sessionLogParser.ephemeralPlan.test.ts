// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEphemeralPlanResult } from '../sessionLogParser';

/**
 * readEphemeralPlanResult is the pure, synchronous read used by OpenClawProvider's
 * generateStructuredPlan poll loop. It never blocks or waits — it reports the
 * current state of a single ephemeral subagent session so the caller can decide
 * whether to keep polling, resolve, or reject.
 */
describe('readEphemeralPlanResult', () => {
  let sessionsDir: string;
  const agentId = 'agent-1';
  const planningId = 'c25f9e6f-dab3-4438-8cdf-0f22b891d006';

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ephemeral-plan-'));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, lines: object[]) {
    fs.writeFileSync(
      path.join(sessionsDir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n'),
      'utf8',
    );
  }

  function messageLine(role: string, text: string) {
    return { type: 'message', timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text }] } };
  }

  test('returns pending when the session entry does not exist yet', () => {
    const index = {};
    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result).toEqual({ status: 'pending' });
  });

  test('returns pending when the entry exists but the jsonl has not been flushed yet', () => {
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result).toEqual({ status: 'pending' });
  });

  test('returns pending while the transcript has no completion tag yet', () => {
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    writeSession('sess-1', [messageLine('assistant', 'Still thinking...')]);

    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result).toEqual({ status: 'pending' });
  });

  test('returns done with the assistant text (tag stripped) once TASK_COMPLETED appears', () => {
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    writeSession('sess-1', [
      messageLine('assistant', `{"name":"Daily brief"}\n<TASK_COMPLETED:${planningId}>`),
    ]);

    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result.status).toBe('done');
    expect(result.text).toBe('{"name":"Daily brief"}');
  });

  test('joins multiple assistant messages before stripping the tag', () => {
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    writeSession('sess-1', [
      messageLine('assistant', 'Part one.'),
      messageLine('tool', 'irrelevant tool output'),
      messageLine('assistant', `Part two.\n<TASK_COMPLETED:${planningId}>`),
    ]);

    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result.status).toBe('done');
    expect(result.text).toBe('Part one.\n\nPart two.');
  });

  test('returns failed with the assistant text when TASK_FAILED appears', () => {
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    writeSession('sess-1', [
      messageLine('assistant', `Cannot comply with this request.\n<TASK_FAILED:${planningId}>`),
    ]);

    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result.status).toBe('failed');
    expect(result.text).toBe('Cannot comply with this request.');
  });

  test('ignores a completion tag belonging to a different planning id', () => {
    const otherId = 'aaaaaaaa-0000-0000-0000-000000000099';
    const index = { [`agent:${agentId}:subagent:${planningId}`]: { sessionId: 'sess-1' } };
    writeSession('sess-1', [messageLine('assistant', `done\n<TASK_COMPLETED:${otherId}>`)]);

    const result = readEphemeralPlanResult(index, sessionsDir, agentId, planningId);
    expect(result.status).toBe('pending');
  });
});
