import { describe, expect, it } from 'bun:test';
import { handleGitStatus, handleGitDiff, handleGitOperation, type GitRunner } from './gitHandlers.js';
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

/** Builds a runner that answers by matching the first git subcommand + flags. */
function runnerFrom(responses: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>): GitRunner {
  return (args) => {
    const key = Object.keys(responses).find((k) => args.join(' ').startsWith(k));
    const r = key ? responses[key] : undefined;
    return { ok: r?.ok ?? true, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
}

const statusMsg: BridgeMessage = { action: 'git_status', requestId: 'r1', path: 'proj', useBasePath: true };

describe('handleGitStatus', () => {
  it('reports isRepo false when the folder is not inside a git repository', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({ 'rev-parse': { ok: false, stderr: 'not a git repository' } });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: 'git_status_response', requestId: 'r1', isRepo: false });
  });

  it('returns branch, ahead/behind and changed files for a repository', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': {
        stdout: [
          '# branch.head main',
          '# branch.upstream origin/main',
          '# branch.ab +1 -0',
          '1 .M N... 100644 100644 100644 aaa bbb src/app.ts',
        ].join('\n'),
      },
      'diff --numstat': { stdout: '4\t2\tsrc/app.ts' },
      'diff --cached --numstat': { stdout: '' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0]).toMatchObject({
      action: 'git_status_response',
      isRepo: true,
      branch: 'main',
      ahead: 1,
      behind: 0,
    });
    expect(sent[0].files).toHaveLength(1);
    expect(sent[0].files[0]).toMatchObject({ path: 'src/app.ts', added: 4, deleted: 2 });
  });

  it('reuses positive repository detection while refreshing status', () => {
    const { ctx } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') {
        return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      }
      return {
        ok: true,
        stdout: args[0] === 'status' ? '# branch.head main\n' : '',
        stderr: '',
      };
    };

    handleGitStatus(statusMsg, ctx, run);
    handleGitStatus({ ...statusMsg, requestId: 'r2' }, ctx, run);

    expect(calls.filter((args) => args[0] === 'rev-parse')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'status')).toHaveLength(2);
  });

  it('does not cache a negative repository detection', () => {
    const { ctx, sent } = makeCtx();
    let detections = 0;
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') {
        detections += 1;
        return detections === 1
          ? { ok: false, stdout: '', stderr: 'fatal: not a git repository' }
          : { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      }
      return {
        ok: true,
        stdout: args[0] === 'status' ? '# branch.head main\n' : '',
        stderr: '',
      };
    };

    handleGitStatus(statusMsg, ctx, run);
    handleGitStatus({ ...statusMsg, requestId: 'r2' }, ctx, run);

    expect(detections).toBe(2);
    expect(sent[0]).toMatchObject({ isRepo: false });
    expect(sent[1]).toMatchObject({ isRepo: true, branch: 'main' });
  });

  it('invalidates cached detection when the repository disappears', () => {
    const { ctx, sent } = makeCtx();
    let detections = 0;
    let statuses = 0;
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') {
        detections += 1;
        return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      }
      if (args[0] === 'status') {
        statuses += 1;
        return statuses === 2
          ? { ok: false, stdout: '', stderr: 'fatal: not a git repository' }
          : { ok: true, stdout: '# branch.head main\n', stderr: '' };
      }
      return { ok: true, stdout: '', stderr: '' };
    };

    handleGitStatus(statusMsg, ctx, run);
    handleGitStatus({ ...statusMsg, requestId: 'r2' }, ctx, run);
    handleGitStatus({ ...statusMsg, requestId: 'r3' }, ctx, run);

    expect(sent[1]).toMatchObject({ isRepo: false });
    expect(sent[2]).toMatchObject({ isRepo: true, branch: 'main' });
    expect(detections).toBe(2);
  });

  it('sums staged and unstaged line counts for the same file', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { stdout: '1 MM N... 100644 100644 100644 aaa bbb src/app.ts' },
      'diff --numstat': { stdout: '1\t1\tsrc/app.ts' },
      'diff --cached --numstat': { stdout: '10\t5\tsrc/app.ts' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0].files[0]).toMatchObject({ added: 11, deleted: 6 });
  });

  it('reports zero counts for untracked files rather than dropping them', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { stdout: '? new.txt' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0].files[0]).toMatchObject({ path: 'new.txt', untracked: true, added: 0, deleted: 0 });
  });

  it('refuses a path that escapes the Bridge base path', () => {
    const { ctx, sent } = makeCtx();
    let called = false;
    const run: GitRunner = () => { called = true; return { ok: true, stdout: '', stderr: '' }; };

    handleGitStatus({ ...statusMsg, path: '../../etc' }, ctx, run);

    expect(called).toBe(false);
    expect(sent[0]).toMatchObject({ action: 'git_status_response', isRepo: false, error: 'INVALID_PATH' });
  });

  it('surfaces a missing git binary as an error instead of an empty status', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = () => { throw new Error('spawn git ENOENT'); };

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0]).toMatchObject({ action: 'git_status_response', isRepo: false, error: 'GIT_NOT_AVAILABLE' });
  });

  it('does not turn a failed git status command into a clean repository snapshot', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { ok: false, stderr: 'fatal: transient status failure' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0]).toMatchObject({
      action: 'git_status_response',
      isRepo: false,
      error: 'GIT_STATUS_FAILED: fatal: transient status failure',
    });
  });

  it('rejects empty status output because porcelain v2 with branch headers is never empty', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { ok: true, stdout: '' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0]).toMatchObject({
      action: 'git_status_response',
      isRepo: false,
      error: 'GIT_STATUS_EMPTY_OUTPUT',
    });
  });

  it('lists local branches alongside the status, current branch first', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { stdout: '# branch.head main\n' },
      'for-each-ref': { stdout: 'main\nfeature/x\ndevelop\n' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0].branches).toEqual(['main', 'feature/x', 'develop']);
  });

  it('falls back to an empty branch list rather than failing the whole status', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'status': { stdout: '# branch.head main\n' },
      'for-each-ref': { ok: false, stderr: 'unexpected failure' },
    });

    handleGitStatus(statusMsg, ctx, run);

    expect(sent[0]).toMatchObject({ isRepo: true, branches: [] });
  });
});

const diffMsg: BridgeMessage = {
  action: 'git_diff',
  requestId: 'd1',
  path: 'proj',
  filePath: 'src/app.ts',
  useBasePath: true,
};

describe('handleGitDiff', () => {
  it('returns the unified diff for a single file', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({
      'rev-parse': { stdout: 'C:/workspace/proj\n' },
      'diff': { stdout: '@@ -1 +1 @@\n-old\n+new\n' },
    });

    handleGitDiff(diffMsg, ctx, run);

    expect(sent[0]).toMatchObject({ action: 'git_diff_response', requestId: 'd1', filePath: 'src/app.ts' });
    expect(sent[0].diff).toContain('+new');
  });

  it('falls back to the staged diff when the worktree diff is empty', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[] = [];
    const run: GitRunner = (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      if (args.includes('--cached')) return { ok: true, stdout: '@@ staged @@\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };

    handleGitDiff(diffMsg, ctx, run);

    expect(calls.some((c) => c.includes('--cached'))).toBe(true);
    expect(sent[0].diff).toContain('staged');
  });

  it('reads an untracked file as an all-added diff', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      if (args.includes('--no-index')) return { ok: false, stdout: '@@ -0,0 +1 @@\n+brand new\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };

    handleGitDiff({ ...diffMsg, untracked: true }, ctx, run);

    expect(sent[0].diff).toContain('+brand new');
  });

  it('requires a file path', () => {
    const { ctx, sent } = makeCtx();
    const run = runnerFrom({ 'rev-parse': { stdout: 'C:/workspace/proj\n' } });

    handleGitDiff({ ...diffMsg, filePath: undefined }, ctx, run);

    expect(sent[0]).toMatchObject({ action: 'git_diff_response', error: 'MISSING_PATH' });
  });
});

describe('handleGitOperation', () => {
  it('initializes a workspace without requiring an existing repository', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      return args[0] === 'init'
        ? { ok: true, stdout: 'Initialized empty Git repository', stderr: '' }
        : { ok: false, stdout: '', stderr: 'not a git repository' };
    };

    handleGitOperation({ action: 'git_operation', requestId: 'i1', path: 'proj', operation: 'init' }, ctx, run);

    expect(calls).toEqual([['init']]);
    expect(sent[0]).toMatchObject({
      action: 'git_operation_ack',
      requestId: 'i1',
      operation: 'init',
      success: true,
    });
  });

  it('checks out an existing local branch', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      return { ok: true, stdout: "Switched to branch 'develop'", stderr: '' };
    };

    handleGitOperation(
      { action: 'git_operation', requestId: 'c1', path: 'proj', operation: 'checkout', branch: 'develop' },
      ctx,
      run,
    );

    expect(calls).toContainEqual(['checkout', 'develop']);
    expect(sent[0]).toMatchObject({ action: 'git_operation_ack', requestId: 'c1', operation: 'checkout', success: true });
  });

  it('never forces a checkout — git itself may refuse when the working tree is dirty', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      return {
        ok: false,
        stdout: '',
        stderr: "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts",
      };
    };

    handleGitOperation(
      { action: 'git_operation', requestId: 'c2', path: 'proj', operation: 'checkout', branch: 'develop' },
      ctx,
      run,
    );

    expect(calls.every((args) => !args.includes('-f') && !args.includes('--force'))).toBe(true);
    expect(sent[0]).toMatchObject({ success: false, error: expect.stringContaining('would be overwritten') });
  });

  it('requires a target branch name for checkout', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = () => ({ ok: true, stdout: 'C:/workspace/proj\n', stderr: '' });

    handleGitOperation({ action: 'git_operation', requestId: 'c3', path: 'proj', operation: 'checkout' }, ctx, run);

    expect(sent[0]).toMatchObject({ success: false, error: 'MISSING_BRANCH_NAME' });
  });

  it('creates a new branch from a base and switches to it in one step', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      return { ok: true, stdout: "Switched to a new branch 'feature/y'", stderr: '' };
    };

    handleGitOperation(
      {
        action: 'git_operation',
        requestId: 'b1',
        path: 'proj',
        operation: 'create_branch',
        branch: 'feature/y',
        baseBranch: 'develop',
      },
      ctx,
      run,
    );

    expect(calls).toContainEqual(['checkout', '-b', 'feature/y', 'develop']);
    expect(sent[0]).toMatchObject({ action: 'git_operation_ack', requestId: 'b1', operation: 'create_branch', success: true });
  });

  it('creates a branch from the current HEAD when no base branch is given', () => {
    const { ctx, sent } = makeCtx();
    const calls: string[][] = [];
    const run: GitRunner = (args) => {
      calls.push(args);
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      return { ok: true, stdout: '', stderr: '' };
    };

    handleGitOperation(
      { action: 'git_operation', requestId: 'b2', path: 'proj', operation: 'create_branch', branch: 'feature/z' },
      ctx,
      run,
    );

    expect(calls).toContainEqual(['checkout', '-b', 'feature/z']);
    expect(sent[0]).toMatchObject({ success: true });
  });

  it('requires a name for the branch being created', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = () => ({ ok: true, stdout: 'C:/workspace/proj\n', stderr: '' });

    handleGitOperation(
      { action: 'git_operation', requestId: 'b3', path: 'proj', operation: 'create_branch' },
      ctx,
      run,
    );

    expect(sent[0]).toMatchObject({ success: false, error: 'MISSING_BRANCH_NAME' });
  });

  it('surfaces a duplicate branch name as an error rather than silently switching', () => {
    const { ctx, sent } = makeCtx();
    const run: GitRunner = (args) => {
      if (args[0] === 'rev-parse') return { ok: true, stdout: 'C:/workspace/proj\n', stderr: '' };
      return { ok: false, stdout: '', stderr: "fatal: a branch named 'feature/y' already exists" };
    };

    handleGitOperation(
      { action: 'git_operation', requestId: 'b4', path: 'proj', operation: 'create_branch', branch: 'feature/y' },
      ctx,
      run,
    );

    expect(sent[0]).toMatchObject({ success: false, error: expect.stringContaining('already exists') });
  });
});
