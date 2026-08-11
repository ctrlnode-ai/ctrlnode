// @ts-nocheck
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as childProcess from 'child_process';

import { defaultGitRunner } from './gitHandlers.js';

describe('defaultGitRunner', () => {
  let spawnSyncSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    spawnSyncSpy?.mockRestore();
  });

  it('captures successful stderr instead of inheriting it', () => {
    spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: 'ok\n',
      stderr: 'warning: LF will be replaced by CRLF\n',
    } as any);

    const result = defaultGitRunner(['status'], process.cwd());

    expect(result).toEqual({
      ok: true,
      stdout: 'ok\n',
      stderr: 'warning: LF will be replaced by CRLF\n',
    });
    expect(spawnSyncSpy.mock.calls[0]?.[2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });
});
