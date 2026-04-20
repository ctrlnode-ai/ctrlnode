/**
 * @file fileSystem.ts
 * @description Filesystem utility functions for the Mission Control Agent Bridge.
 *
 * Provides pure, side-effect-minimal helpers for:
 *  - Reading and writing files safely (no uncaught exceptions)
 *  - Detecting MIME content types from file extensions
 *  - Recursively listing directory contents
 *  - Sanitizing user-supplied relative paths (path traversal prevention)
 *  - Detecting mounted/network volumes that require polling-based watchers
 */

import path from 'path';
import fs from 'fs';
import { FileEntry, FileReadResult } from './types';
import { MAX_INLINE_IMAGE_BYTES } from './config';

// ── MIME type detection ───────────────────────────────────────────────────────

/** Maps lowercase file extensions to MIME content-type strings. */
const CONTENT_TYPE_MAP: Record<string, string> = {
  '.md':       'text/markdown',
  '.markdown': 'text/markdown',
  '.txt':      'text/plain',
  '.json':     'application/json',
  '.yaml':     'text/yaml',
  '.yml':      'text/yaml',
  '.xml':      'application/xml',
  '.csv':      'text/csv',
  '.html':     'text/html',
  '.htm':      'text/html',
  '.js':       'text/javascript',
  '.ts':       'text/typescript',
  '.css':      'text/css',
  '.png':      'image/png',
  '.jpg':      'image/jpeg',
  '.jpeg':     'image/jpeg',
  '.gif':      'image/gif',
  '.webp':     'image/webp',
  '.bmp':      'image/bmp',
  '.svg':      'image/svg+xml',
  '.avif':     'image/avif',
};

/**
 * Returns the MIME content-type for a given file path based on its extension.
 * Falls back to "application/octet-stream" for unknown extensions.
 *
 * @param fp - Absolute or relative path to the file.
 * @returns MIME type string (e.g. "text/markdown", "image/png").
 */
export function detectContentType(fp: string): string {
  const ext = path.extname(fp).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? 'application/octet-stream';
}

// ── Directory helpers ─────────────────────────────────────────────────────────

/**
 * Ensures a directory exists, creating it (and any missing ancestors) if needed.
 * Equivalent to `mkdir -p`. Never throws.
 *
 * @param dirPath - Absolute path of the directory to create.
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Recursively deletes a directory and all its contents.
 * Equivalent to `rm -rf`. Safe when the directory does not exist (no-op).
 * Never throws — errors are caught and returned as a boolean result.
 *
 * @param dirPath - Absolute path to the directory to delete.
 * @returns True if the directory was deleted (or did not exist), false on error.
 */
export async function deleteDir(dirPath: string): Promise<boolean> {
  try {
    await fs.promises.rm(dirPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ── Safe file I/O ─────────────────────────────────────────────────────────────

/**
 * Reads a text file and returns its content, or null if the file cannot be read.
 * Designed for fire-and-forget reads where a missing file is acceptable.
 *
 * @param fp - Absolute path to the file.
 * @returns UTF-8 file content, or null on any error.
 */
export function safeReadFile(fp: string): string | null {
  try { return fs.readFileSync(fp, 'utf8'); } catch { return null; }
}

/**
 * Reads a file and returns its content together with a MIME content-type.
 * Images within the inline size limit are returned as base64-encoded strings.
 * Images exceeding the limit return an IMAGE_TOO_LARGE error code.
 * All other files are returned as plain UTF-8 text.
 *
 * @param fp - Absolute path to the file.
 * @returns A {@link FileReadResult} with content, contentType, and error fields.
 */
export function readFileForBridge(fp: string): FileReadResult {
  try {
    const contentType = detectContentType(fp);

    if (contentType.startsWith('image/')) {
      const size = fs.statSync(fp).size;
      if (size > MAX_INLINE_IMAGE_BYTES) {
        return { contentType: 'application/octet-stream', content: null, error: `IMAGE_TOO_LARGE:${size}` };
      }
      return { contentType, content: fs.readFileSync(fp).toString('base64'), error: null };
    }

    return { contentType, content: fs.readFileSync(fp, 'utf8'), error: null };
  } catch {
    return { contentType: 'text/plain', content: null, error: 'FILE_READ_ERROR' };
  }
}

// ── Directory walk ────────────────────────────────────────────────────────────

/** Directory names always skipped during recursive directory walks. */
const SKIP_DIRS = new Set(['.openclaw', 'node_modules', '.git']);

/**
 * Recursively lists all files and directories inside `dir`.
 * Skips well-known noise directories (node_modules, .git, .openclaw).
 *
 * @param dir   - Absolute path of the directory to walk.
 * @param base  - Relative path prefix accumulated from parent calls (internal).
 * @returns     Array of {@link FileEntry} objects with name, path, type, and size.
 */
export function walkDir(dir: string, base = ''): FileEntry[] {
  const results: FileEntry[] = [];

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;

    const rel  = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      results.push({ name: entry.name, path: rel, type: 'dir' });
      results.push(...walkDir(full, rel));
    } else {
      let size: number | null = null;
      try { size = fs.statSync(full).size; } catch {}
      results.push({ name: entry.name, path: rel, type: 'file', size });
    }
  }

  return results;
}

// ── Path safety ───────────────────────────────────────────────────────────────

/**
 * Removes path traversal sequences and normalises separators in a
 * caller-supplied relative path so it is safe to join with a base directory.
 *
 * Rules applied (in order):
 *  1. Backslashes → forward slashes
 *  2. Any `../` sequences are removed
 *  3. Leading slashes are stripped
 *
 * @param relPath - Raw relative path string from an incoming WebSocket message.
 * @returns Sanitized relative path safe to pass to `path.join(base, ...)`.
 */
export function sanitizeRelPath(relPath: string): string {
  return (relPath || '')
    .replace(/\\/g, '/')
    .replace(/\.\.\//g, '')
    .replace(/^\//, '');
}

// ── Agent context files ───────────────────────────────────────────────────────

/**
 * Reads `BOOTSTRAP.md` from the agent's workspace directory and returns its
 * trimmed content, or null when the file is missing, empty, or contains only a
 * heading with no substantive instructions.
 *
 * Used by `dispatch_task` to prepend agent startup context to the spawned
 * sub-agent's `task` argument, compensating for OpenClaw's limitation that
 * only `AGENTS.md` and `TOOLS.md` are auto-injected into sub-agent sessions.
 *
 * @param workspacePath - Absolute path to the agent workspace directory.
 * @returns Trimmed BOOTSTRAP.md content, or null if empty/heading-only/missing.
 */
export function readBootstrapPreamble(workspacePath: string): string | null {
  const content = safeReadFile(path.join(workspacePath, 'BOOTSTRAP.md'));
  if (!content) return null;

  const trimmed = content.trim();
  if (!trimmed) return null;

  // If the entire file is just a single heading line (plus optional whitespace),
  // treat it as effectively empty — it carries no actionable instructions.
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
  if (lines.length === 1 && /^#\s/.test(lines[0])) return null;

  return trimmed;
}

/**
 * Ordered list of workspace context files to inject into every task dispatch.
 * Files that are missing or empty are silently skipped.
 */
export const WORKSPACE_CONTEXT_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'AGENTS.md',
  'TOOLS.md',
  'BOOTSTRAP.md',
] as const;

/**
 * Reads all present workspace context files and returns a single combined
 * preamble string suitable for prepending to a task message.
/**
 * Returns true when the trimmed content of a workspace file is considered
 * "substantive" — i.e. it contains at least one non-heading, non-empty line.
 *
 * This mirrors the heading-only guard in `readBootstrapPreamble` but applied
 * to every workspace context file so we don't waste tokens on placeholder
 * files that agents haven't filled in yet.
 *
 * Files that pass: anything with ≥1 line that isn't a Markdown heading (`# …`)
 * Files that fail: blank, whitespace-only, or headings-only content.
 */
function hasSubstantiveContent(trimmed: string): boolean {
  const lines = trimmed.split('\n').filter(l => l.trim().length > 0);
  return lines.some(l => !/^#{1,6}\s/.test(l));
}

/**
 * Reads all present workspace context files and returns a single combined
 * preamble string suitable for prepending to a task message.
 *
 * Each file is included as a `### <FileName>` section separated by `---`.
 * Files that are missing, blank, or contain only Markdown headings (common
 * for un-configured agent templates) are silently skipped to avoid wasting
 * tokens on placeholder content.
 * Returns `null` if no files contain meaningful content.
 *
 * @param workspacePath - Absolute path to the agent workspace directory.
 */
export function readWorkspaceContext(workspacePath: string): string | null {
  const sections: string[] = [];

  for (const fileName of WORKSPACE_CONTEXT_FILES) {
    const content = safeReadFile(path.join(workspacePath, fileName));
    if (!content) continue;
    const trimmed = content.trim();
    if (!trimmed || !hasSubstantiveContent(trimmed)) continue;
    sections.push(`### ${fileName}\n\n${trimmed}`);
  }

  if (sections.length === 0) return null;

  return `## Agent Context\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Wipes all session files for a given agent id and resets sessions.json to `{}`.
 *
 * This mirrors the behaviour of v1.0.0's dispatch_task sessions wipe: every file
 * inside `<openclawDir>/agents/<agentId>/sessions/` is removed, then a fresh
 * `sessions.json` with `{}` is written (or the dir is created if missing).
 *
 * Called before each `sessions_spawn` so sub-agent transcripts from previous
 * task runs do not accumulate and the session registry starts clean.
 *
 * @param agentId            - The agent identifier (e.g. "compi").
 * @param openclawConfigPath - Absolute path to the openclaw.json file.
 */
export function wipeAgentSessions(agentId: string, openclawConfigPath: string): void {
  const sessionsDir = path.join(path.dirname(openclawConfigPath), 'agents', agentId, 'sessions');
  if (fs.existsSync(sessionsDir)) {
    for (const file of fs.readdirSync(sessionsDir)) {
      fs.rmSync(path.join(sessionsDir, file), { recursive: true, force: true });
    }
  } else {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }
  fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), '{}', 'utf8');
}

// ── Volume detection ──────────────────────────────────────────────────────────

/**
 * Determines whether a given directory resides on a filesystem type that does
 * not reliably emit inotify events (e.g. Docker bind-mounts on macOS/Windows,
 * CIFS/SMB shares, VirtualBox shared folders).
 *
 * When this returns true the watcher should use polling mode instead of
 * native filesystem events.
 *
 * Only functional on Linux (reads /proc/mounts). Returns false on other
 * platforms or when /proc/mounts cannot be read.
 *
 * @param workspaceDir - Absolute path to the directory being watched.
 * @returns True if polling is recommended; false otherwise.
 */
export function isMountedVolumeLikely(workspaceDir: string): boolean {
  const PROBLEMATIC_FS = new Set(['cifs', 'smbfs', '9p', 'fuse', 'fuseblk', 'vboxsf', 'smb', 'fuse.osxfs', 'virtiofs']);

  try {
    const mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n');
    let best: { mountPoint: string; fsType: string } | null = null;

    for (const line of mounts) {
      const parts = line.split(' ');
      if (parts.length < 3) continue;
      const [, mountPoint, fsType] = parts;
      if (workspaceDir.startsWith(mountPoint) && (!best || mountPoint.length > best.mountPoint.length)) {
        best = { mountPoint, fsType };
      }
    }

    return best !== null && PROBLEMATIC_FS.has(best.fsType.toLowerCase());
  } catch {
    return false;
  }
}
