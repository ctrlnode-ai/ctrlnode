import { describe, expect, it } from 'bun:test';
import { parseGitStatusPorcelain, parseGitNumstat } from './gitStatus.js';

describe('parseGitStatusPorcelain', () => {
  it('reads branch name and ahead/behind counts from the header', () => {
    const out = [
      '# branch.oid 1a2b3c',
      '# branch.head feature/git-ops',
      '# branch.upstream origin/feature/git-ops',
      '# branch.ab +3 -2',
    ].join('\n');

    const status = parseGitStatusPorcelain(out);

    expect(status.branch).toBe('feature/git-ops');
    expect(status.upstream).toBe('origin/feature/git-ops');
    expect(status.ahead).toBe(3);
    expect(status.behind).toBe(2);
  });

  it('reports a detached HEAD as detached with no upstream', () => {
    const status = parseGitStatusPorcelain('# branch.oid 1a2b3c\n# branch.head (detached)');

    expect(status.branch).toBe(null);
    expect(status.detached).toBe(true);
    expect(status.upstream).toBe(null);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
  });

  it('splits staged and unstaged letters for an ordinary changed file', () => {
    // "1 .M" → unmodified in index, modified in worktree
    const status = parseGitStatusPorcelain('1 .M N... 100644 100644 100644 aaa bbb src/app.ts');

    expect(status.files).toHaveLength(1);
    expect(status.files[0]).toMatchObject({
      path: 'src/app.ts',
      staged: '.',
      unstaged: 'M',
      untracked: false,
    });
  });

  it('marks a file staged when the index letter is set', () => {
    const status = parseGitStatusPorcelain('1 M. N... 100644 100644 100644 aaa bbb src/app.ts');

    expect(status.files[0]).toMatchObject({ staged: 'M', unstaged: '.' });
  });

  it('keeps paths that contain spaces intact', () => {
    const status = parseGitStatusPorcelain('1 .M N... 100644 100644 100644 aaa bbb docs/my notes.md');

    expect(status.files[0].path).toBe('docs/my notes.md');
  });

  it('reads renames with their original path', () => {
    const status = parseGitStatusPorcelain('2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\told/name.ts');

    expect(status.files[0]).toMatchObject({
      path: 'new/name.ts',
      origPath: 'old/name.ts',
      staged: 'R',
    });
  });

  it('flags untracked entries', () => {
    const status = parseGitStatusPorcelain('? scratch.txt');

    expect(status.files[0]).toMatchObject({ path: 'scratch.txt', untracked: true, unstaged: '?' });
  });

  it('flags unmerged entries as conflicted', () => {
    const status = parseGitStatusPorcelain('u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts');

    expect(status.files[0]).toMatchObject({ path: 'src/conflict.ts', conflicted: true });
  });

  it('ignores ignored entries and blank lines', () => {
    const status = parseGitStatusPorcelain('! node_modules/\n\n? real.txt\n');

    expect(status.files).toHaveLength(1);
    expect(status.files[0].path).toBe('real.txt');
  });

  it('returns an empty file list for a clean tree', () => {
    const status = parseGitStatusPorcelain('# branch.oid 1a2b3c\n# branch.head main\n');

    expect(status.files).toEqual([]);
  });
});

describe('parseGitNumstat', () => {
  it('reads added and deleted counts per file', () => {
    const entries = parseGitNumstat('12\t3\tsrc/app.ts\n0\t7\tREADME.md');

    expect(entries).toEqual([
      { path: 'src/app.ts', added: 12, deleted: 3, binary: false },
      { path: 'README.md', added: 0, deleted: 7, binary: false },
    ]);
  });

  it('marks binary files instead of reporting fake zero counts', () => {
    const entries = parseGitNumstat('-\t-\tassets/logo.png');

    expect(entries[0]).toEqual({ path: 'assets/logo.png', added: 0, deleted: 0, binary: true });
  });

  it('uses the destination path for brace-style renames', () => {
    const entries = parseGitNumstat('1\t1\tsrc/{old => new}/app.ts');

    expect(entries[0].path).toBe('src/new/app.ts');
  });

  it('ignores blank lines', () => {
    expect(parseGitNumstat('\n1\t1\ta.ts\n\n')).toHaveLength(1);
  });

  it('returns an empty list for empty output', () => {
    expect(parseGitNumstat('')).toEqual([]);
  });
});
