import { describe, expect, test } from 'bun:test';
import path from 'path';

import { resolveCapabilityWorkingDirectory } from '../capabilitiesHandler.js';

const BASE = process.platform === 'win32' ? 'C:\\bridge-base' : '/bridge-base';

describe('resolveCapabilityWorkingDirectory', () => {
  test('OUTPUT mode ignores any supplied repo path and uses the ctrlnode root', () => {
    const resolved = resolveCapabilityWorkingDirectory({
      taskMode: 'output',
      repoPath: 'projects/secret-repo',
      basePath: BASE,
      ctrlnodeRoot: path.join(BASE, '.ctrlnode'),
    });

    expect(resolved).toBe(path.resolve(path.join(BASE, '.ctrlnode')));
  });

  test('repo mode resolves the project path under the base path', () => {
    const resolved = resolveCapabilityWorkingDirectory({
      taskMode: 'repo',
      repoPath: 'projects/api',
      basePath: BASE,
      ctrlnodeRoot: path.join(BASE, '.ctrlnode'),
    });

    expect(resolved).toBe(path.resolve(path.join(BASE, 'projects', 'api')));
  });

  test('rejects traversal that would escape the base path', () => {
    const resolved = resolveCapabilityWorkingDirectory({
      taskMode: 'repo',
      repoPath: '../../etc',
      basePath: BASE,
      ctrlnodeRoot: path.join(BASE, '.ctrlnode'),
    });

    expect(resolved.startsWith(path.resolve(BASE))).toBe(true);
  });

  test('accepts an absolute repo path that already lives inside the base path', () => {
    const inside = path.join(BASE, 'projects', 'api');

    expect(
      resolveCapabilityWorkingDirectory({
        taskMode: 'repo',
        repoPath: inside,
        basePath: BASE,
        ctrlnodeRoot: path.join(BASE, '.ctrlnode'),
      }),
    ).toBe(path.resolve(inside));
  });

  test('falls back to the ctrlnode root when repo mode has no path', () => {
    const resolved = resolveCapabilityWorkingDirectory({
      taskMode: 'repo',
      repoPath: undefined,
      basePath: BASE,
      ctrlnodeRoot: path.join(BASE, '.ctrlnode'),
    });

    expect(resolved).toBe(path.resolve(path.join(BASE, '.ctrlnode')));
  });
});
