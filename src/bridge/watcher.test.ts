// @ts-nocheck
import { describe, expect, test, mock, beforeEach } from 'bun:test';

import { processFileEvent, WatcherCallbacks } from './watcher';

// ── Helpers ───────────────────────────────────────────────────────────────────

const WORKSPACE = '/app/workspace';

function makeCallbacks(): WatcherCallbacks {
  return {
    sendToSaas:    mock(() => {}),
    setAgentRunning: mock(() => {}),
    // NOTE: pendingTasks intentionally absent — Option A removes it
  } as WatcherCallbacks;
}

// ── processFileEvent ──────────────────────────────────────────────────────────

describe('processFileEvent — Option A: unified file_changed', () => {
  test('output file emits file_changed (NOT task_output)', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/result.md`, cb);

    expect(cb.sendToSaas).toHaveBeenCalledTimes(1);
    const payload = (cb.sendToSaas as any).mock.calls[0][0];
    expect(payload.action).toBe('file_changed');
  });

  test('output file never emits task_output', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/result.md`, cb);

    const actions = (cb.sendToSaas as any).mock.calls.map((c: any[]) => c[0].action);
    expect(actions).not.toContain('task_output');
  });

  test('input file emits file_changed', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'change', `${WORKSPACE}/tasks/abc-123/input/task.md`, cb);

    expect(cb.sendToSaas).toHaveBeenCalledTimes(1);
    const payload = (cb.sendToSaas as any).mock.calls[0][0];
    expect(payload.action).toBe('file_changed');
  });

  test('no task_started event is ever emitted for any path', () => {
    const cb = makeCallbacks();
    // output file
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/result.md`, cb);
    // input file
    processFileEvent('agent1', WORKSPACE, 'change', `${WORKSPACE}/tasks/abc-123/input/task.md`, cb);
    // some other file
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/somefile.txt`, cb);

    const actions = (cb.sendToSaas as any).mock.calls.map((c: any[]) => c[0].action);
    expect(actions).not.toContain('task_started');
  });

  test('file_changed payload contains agentId, path and event', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/result.md`, cb);

    const payload = (cb.sendToSaas as any).mock.calls[0][0];
    expect(payload.agentId).toBe('agent1');
    expect(payload.path).toBe('tasks/abc-123/output/result.md');
    expect(payload.event).toBe('add');
  });

  test('output file activates setAgentRunning', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/result.md`, cb);

    expect(cb.setAgentRunning).toHaveBeenCalledWith('agent1');
  });

  test('ignored files (.gitkeep etc.) produce no events', () => {
    const cb = makeCallbacks();
    processFileEvent('agent1', WORKSPACE, 'add', `${WORKSPACE}/tasks/abc-123/output/.gitkeep`, cb);

    expect(cb.sendToSaas).not.toHaveBeenCalled();
  });
});
