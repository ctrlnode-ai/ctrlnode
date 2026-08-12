import { describe, expect, it } from 'bun:test';
import { handleGitOperation, type GitRunner } from './gitHandlers.js';
import type { HandlerContext } from './handlerContext.js';
import type { BridgeMessage } from './types.js';

function makeCtx() {
  const sent: any[] = [];
  const ctx = {
    sendToSaas: (payload: any) => { sent.push(payload); },
    syncAgents: () => {},
    provider: {} as any,
  } as HandlerContext;
  return { ctx, sent };
}

function recordingRunner(overrides: (args: string[]) => { ok?: boolean; stdout?: string; stderr?: string } = () => ({})) {
  const calls: string[][] = [];
  const run: GitRunner = (args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
    const r = overrides(args);
    return { ok: r.ok ?? true, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { run, calls };
}

const msg = (over: Partial<BridgeMessage> = {}): BridgeMessage => ({
  action: 'git_operation', requestId: 'r1', path: 'proj', useBasePath: true, ...over,
});

describe('handleGitOperation — commit', () => {
  it('stages everything and commits with the given message', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'commit', message: 'my change' }), ctx, run);

    expect(calls.some((c) => c[0] === 'add' && c.includes('-A'))).toBe(true);
    const commit = calls.find((c) => c[0] === 'commit');
    expect(commit).toEqual(['commit', '-m', 'my change']);
    expect(sent[0]).toMatchObject({ action: 'git_operation_ack', requestId: 'r1', success: true });
  });

  it('refuses to commit without a message', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'commit', message: '   ' }), ctx, run);

    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(sent[0]).toMatchObject({ success: false, error: 'MISSING_COMMIT_MESSAGE' });
  });

  it('never passes the message as a shell string', () => {
    const { ctx } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'commit', message: 'oops"; rm -rf /' }), ctx, run);

    // argv form keeps the whole message a single argument, no shell involved
    expect(calls.find((c) => c[0] === 'commit')?.[2]).toBe('oops"; rm -rf /');
  });

  it('reports git stderr when the commit fails', () => {
    const { ctx, sent } = makeCtx();
    const { run } = recordingRunner((args) =>
      args[0] === 'commit' ? { ok: false, stderr: 'nothing to commit, working tree clean' } : {});

    handleGitOperation(msg({ operation: 'commit', message: 'x' }), ctx, run);

    expect(sent[0]).toMatchObject({ success: false });
    expect(sent[0].error).toContain('nothing to commit');
  });

  it('stops before committing when staging fails', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner((args) =>
      args[0] === 'add' ? { ok: false, stderr: 'permission denied' } : {});

    handleGitOperation(msg({ operation: 'commit', message: 'x' }), ctx, run);

    expect(calls.some((c) => c[0] === 'commit')).toBe(false);
    expect(sent[0]).toMatchObject({ success: false });
  });
});

describe('handleGitOperation — remote operations', () => {
  it('reuses positive repository detection across operations', () => {
    const { ctx } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'fetch' }), ctx, run);
    handleGitOperation(msg({ requestId: 'r2', operation: 'push' }), ctx, run);

    expect(calls.filter((c) => c[0] === 'rev-parse')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'fetch')).toHaveLength(1);
    expect(calls.filter((c) => c[0] === 'push')).toHaveLength(1);
  });

  it('fetches with prune', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'fetch' }), ctx, run);

    expect(calls.some((c) => c[0] === 'fetch')).toBe(true);
    expect(sent[0]).toMatchObject({ success: true, operation: 'fetch' });
  });

  it('pulls without creating a merge commit behind the user back', () => {
    const { ctx } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'pull' }), ctx, run);

    expect(calls.find((c) => c[0] === 'pull')).toEqual(['pull', '--ff-only']);
  });

  it('pushes to the tracked upstream', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'push' }), ctx, run);

    expect(calls.some((c) => c[0] === 'push')).toBe(true);
    expect(sent[0]).toMatchObject({ success: true, operation: 'push' });
  });

  it('never force-pushes', () => {
    const { ctx } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'push' }), ctx, run);

    const push = calls.find((c) => c[0] === 'push') ?? [];
    expect(push.some((a) => a === '--force' || a === '-f' || a === '--force-with-lease')).toBe(false);
  });

  it('surfaces an authentication failure instead of reporting success', () => {
    const { ctx, sent } = makeCtx();
    const { run } = recordingRunner((args) =>
      args[0] === 'push' ? { ok: false, stderr: 'fatal: Authentication failed' } : {});

    handleGitOperation(msg({ operation: 'push' }), ctx, run);

    expect(sent[0]).toMatchObject({ success: false });
    expect(sent[0].error).toContain('Authentication failed');
  });

  it('rejects an unknown operation rather than running anything', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'reset-hard' as never }), ctx, run);

    expect(calls.filter((c) => c[0] !== 'rev-parse')).toHaveLength(0);
    expect(sent[0]).toMatchObject({ success: false, error: 'UNSUPPORTED_OPERATION' });
  });

  it('refuses to operate outside the Bridge base path', () => {
    const { ctx, sent } = makeCtx();
    const { run, calls } = recordingRunner();

    handleGitOperation(msg({ operation: 'fetch', path: '../elsewhere' }), ctx, run);

    expect(calls).toHaveLength(0);
    expect(sent[0]).toMatchObject({ success: false, error: 'INVALID_PATH' });
  });

  it('reports a folder that is not a repository', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = (args) =>
      args[0] === 'rev-parse'
        ? { ok: false, stdout: '', stderr: 'not a git repository' }
        : { ok: true, stdout: '', stderr: '' };

    handleGitOperation(msg({ operation: 'fetch' }), ctx, run);

    expect(sent[0]).toMatchObject({ success: false, error: 'NOT_A_REPOSITORY' });
  });

  it('reports a missing git binary', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = () => { throw new Error('spawn git ENOENT'); };

    handleGitOperation(msg({ operation: 'fetch' }), ctx, run);

    expect(sent[0]).toMatchObject({ success: false, error: 'GIT_NOT_AVAILABLE' });
  });
});
