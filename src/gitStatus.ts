/**
 * Parsers for `git status --porcelain=v2 --branch` and `git diff --numstat`.
 *
 * Kept free of any I/O so the (fiddly) format handling can be unit tested —
 * gitHandlers.ts owns the actual `git` invocations.
 */

export interface GitFileChange {
  /** Path relative to the repository root, forward-slashed. */
  path: string;
  /** Index status letter, '.' when unchanged in the index, '?' for untracked. */
  staged: string;
  /** Worktree status letter, '.' when unchanged in the worktree, '?' for untracked. */
  unstaged: string;
  untracked: boolean;
  conflicted: boolean;
  /** Source path for renames/copies. */
  origPath?: string;
}

export interface GitStatusSummary {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitNumstatEntry {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/**
 * Expands git's compact rename notation into the destination path:
 * `src/{old => new}/app.ts` → `src/new/app.ts`, `old.ts => new.ts` → `new.ts`.
 */
function renameDestination(raw: string): string {
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) {
    const [, prefix, , to, suffix] = brace;
    return `${prefix}${to}${suffix}`.replace(/\/{2,}/g, '/');
  }
  const arrow = raw.split(' => ');
  return arrow.length === 2 ? arrow[1] : raw;
}

/**
 * Ordinary (`1`) and rename/copy (`2`) entries share a fixed field count before
 * the path; renames add one extra score field and a tab-separated original path.
 */
function parseTrackedEntry(line: string, kind: '1' | '2' | 'u'): GitFileChange | null {
  const fieldsBeforePath = kind === '1' ? 8 : kind === '2' ? 9 : 10;
  const parts = line.split(' ');
  if (parts.length <= fieldsBeforePath) return null;

  const xy = parts[1] ?? '..';
  // Paths may contain spaces — rejoin everything after the fixed-width fields.
  const pathField = parts.slice(fieldsBeforePath).join(' ');

  if (kind === '2') {
    const [dest, orig] = pathField.split('\t');
    return {
      path: dest,
      staged: xy[0] ?? '.',
      unstaged: xy[1] ?? '.',
      untracked: false,
      conflicted: false,
      ...(orig ? { origPath: orig } : {}),
    };
  }

  return {
    path: pathField,
    staged: xy[0] ?? '.',
    unstaged: xy[1] ?? '.',
    untracked: false,
    conflicted: kind === 'u',
  };
}

export function parseGitStatusPorcelain(stdout: string): GitStatusSummary {
  const summary: GitStatusSummary = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      if (head === '(detached)') summary.detached = true;
      else summary.branch = head;
      continue;
    }
    if (line.startsWith('# branch.upstream ')) {
      summary.upstream = line.slice('# branch.upstream '.length).trim();
      continue;
    }
    if (line.startsWith('# branch.ab ')) {
      const ab = line.slice('# branch.ab '.length).trim().match(/\+(\d+)\s+-(\d+)/);
      if (ab) {
        summary.ahead = Number(ab[1]);
        summary.behind = Number(ab[2]);
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // Ignored entries are noise for a changes panel.
    if (line.startsWith('! ')) continue;

    if (line.startsWith('? ')) {
      summary.files.push({
        path: line.slice(2),
        staged: '?',
        unstaged: '?',
        untracked: true,
        conflicted: false,
      });
      continue;
    }

    const kind = line[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      const entry = parseTrackedEntry(line, kind);
      if (entry) summary.files.push(entry);
    }
  }

  return summary;
}

export function parseGitNumstat(stdout: string): GitNumstatEntry[] {
  const entries: GitNumstatEntry[] = [];

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;

    const [added, deleted, ...pathParts] = line.split('\t');
    const rawPath = pathParts.join('\t');
    if (!rawPath) continue;

    const binary = added === '-' || deleted === '-';
    entries.push({
      path: renameDestination(rawPath),
      added: binary ? 0 : Number(added) || 0,
      deleted: binary ? 0 : Number(deleted) || 0,
      binary,
    });
  }

  return entries;
}
