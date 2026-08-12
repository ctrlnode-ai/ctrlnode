import { describe, test, expect } from 'bun:test';
import path from 'path';
import { resolveSecurePath } from '../providers/providerFileUtils.js';

describe('resolveSecurePath', () => {
  const sandbox = path.resolve(path.sep, 'ctrlnode', 'tasks', 'openr', '07-09', 'abc-task');

  test('resolves a normal relative path under the sandbox', () => {
    const result = resolveSecurePath('output/x.html', sandbox);
    expect(result).toBe(path.join(sandbox, 'output', 'x.html'));
  });

  test('strips a redundant full sandbox-path prefix (real gpt-5-nano bug)', () => {
    const redundant = 'tasks/openr/07-09/abc-task/output/mundiales/mundialnews.html';
    const result = resolveSecurePath(redundant, sandbox);
    expect(result).toBe(path.join(sandbox, 'output', 'mundiales', 'mundialnews.html'));
  });

  test('strips a redundant prefix that only matches a suffix of the sandbox path', () => {
    // model repeats just "abc-task/output/..." rather than the full tasks/.../abc-task chain
    const redundant = 'abc-task/output/x.html';
    const result = resolveSecurePath(redundant, sandbox);
    expect(result).toBe(path.join(sandbox, 'output', 'x.html'));
  });

  test('does not strip when path merely starts with a similarly-named but different segment', () => {
    // "abc-task-2" is not a segment-boundary match for "abc-task"
    const result = resolveSecurePath('abc-task-2/output/x.html', sandbox);
    expect(result).toBe(path.join(sandbox, 'abc-task-2', 'output', 'x.html'));
  });

  test('leaves an unrelated relative path untouched', () => {
    const result = resolveSecurePath('input/notes.md', sandbox);
    expect(result).toBe(path.join(sandbox, 'input', 'notes.md'));
  });

  test('still resolves absolute paths as before, without prefix-stripping', () => {
    const abs = path.join(sandbox, 'output', 'y.html');
    const result = resolveSecurePath(abs, sandbox);
    expect(result).toBe(abs);
  });

  test('still rejects a path that escapes the sandbox', () => {
    const result = resolveSecurePath('../../etc/passwd', sandbox);
    expect(result).toBeNull();
  });

  test('still rejects an absolute path outside the sandbox', () => {
    const result = resolveSecurePath(path.join(path.sep, 'etc', 'passwd'), sandbox);
    expect(result).toBeNull();
  });

  test('handles backslash-separated redundant prefix (Windows-style model output)', () => {
    const redundant = 'tasks\\openr\\07-09\\abc-task\\output\\x.html';
    const result = resolveSecurePath(redundant, sandbox);
    expect(result).toBe(path.join(sandbox, 'output', 'x.html'));
  });

  test('resolves to sandbox root itself when path is empty after stripping', () => {
    const result = resolveSecurePath('tasks/openr/07-09/abc-task', sandbox);
    expect(result).toBe(sandbox);
  });
});
