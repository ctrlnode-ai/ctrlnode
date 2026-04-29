// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { readBootstrapPreamble, readWorkspaceContext, wipeAgentSessions } from './fileSystem';

// ── Helpers ────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-bs-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeBootstrap(content: string) {
  fs.writeFileSync(path.join(tmpDir, 'BOOTSTRAP.md'), content, 'utf8');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('readBootstrapPreamble', () => {

  test('returns null when BOOTSTRAP.md does not exist', () => {
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('returns null when BOOTSTRAP.md is empty', () => {
    writeBootstrap('');
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('returns null when BOOTSTRAP.md has only a heading (no instructions)', () => {
    writeBootstrap('# Bootstrap — COMPI\n');
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('returns null when BOOTSTRAP.md has heading + blank lines but no real content', () => {
    writeBootstrap('# Bootstrap — COMPI\n\n   \n');
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('returns content when BOOTSTRAP.md has real instructions', () => {
    const content = '# Bootstrap — COMPI\n\nRead SOUL.md before starting any task.\n';
    writeBootstrap(content);
    const result = readBootstrapPreamble(tmpDir);
    expect(result).toBe(content.trim());
  });

  test('returns trimmed content', () => {
    writeBootstrap('\n\n# Bootstrap\n\nDo stuff.\n\n');
    const result = readBootstrapPreamble(tmpDir);
    expect(result).toBe('# Bootstrap\n\nDo stuff.');
  });

  test('treats file with only whitespace as empty', () => {
    writeBootstrap('   \n\t\n   ');
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('heading-only detection is case-insensitive and ignores trailing spaces', () => {
    writeBootstrap('# Bootstrap — COMPI   \n\n');
    expect(readBootstrapPreamble(tmpDir)).toBeNull();
  });

  test('returns content when file has heading followed by real lines', () => {
    const body = '# Bootstrap\n\n1. Read SOUL.md\n2. Read MEMORY.md\n';
    writeBootstrap(body);
    expect(readBootstrapPreamble(tmpDir)).toBe(body.trim());
  });

});

// ── wipeAgentSessions ──────────────────────────────────────────────────────────

describe('wipeAgentSessions', () => {

  test('creates sessions dir and writes empty sessions.json when dir does not exist', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = path.join(tmpDir, 'agents', 'compi', 'sessions');

    wipeAgentSessions('compi', openclawConfig);

    expect(fs.existsSync(sessionsDir)).toBe(true);
    expect(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8')).toBe('{}');
  });

  test('removes all files in sessions dir and resets sessions.json to {}', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = path.join(tmpDir, 'agents', 'compi', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'abc123.jsonl'), 'line1\nline2', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, 'def456.jsonl'), 'line3', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), '{"agent:compi:main":{}}', 'utf8');

    wipeAgentSessions('compi', openclawConfig);

    const remaining = fs.readdirSync(sessionsDir);
    expect(remaining).toEqual(['sessions.json']);
    expect(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8')).toBe('{}');
  });

  test('does not throw when sessions dir is already empty (only sessions.json)', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = path.join(tmpDir, 'agents', 'compi', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), '{}', 'utf8');

    expect(() => wipeAgentSessions('compi', openclawConfig)).not.toThrow();
    expect(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8')).toBe('{}');
  });

  test('isolates wipe to the specified agentId folder only', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const otherDir = path.join(tmpDir, 'agents', 'other-agent', 'sessions');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'sessions.json'), '{"keep":"me"}', 'utf8');

    wipeAgentSessions('compi', openclawConfig);

    // other-agent sessions must be untouched
    expect(fs.readFileSync(path.join(otherDir, 'sessions.json'), 'utf8')).toBe('{"keep":"me"}');
  });

});

// ── readWorkspaceContext ───────────────────────────────────────────────────────────────────

describe('readWorkspaceContext', () => {

  test('returns null when workspace is empty', () => {
    expect(readWorkspaceContext(tmpDir)).toBeNull();
  });

  test('returns null when all files are empty', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), '   ', 'utf8');
    expect(readWorkspaceContext(tmpDir)).toBeNull();
  });

  test('returns null when all files are headings only', () => {
    // Simulates un-configured agent templates with only headings and no body
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul — HUGO15', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# User Instructions — HUGO15', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '## Agents — HUGO15', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'BOOTSTRAP.md'), '# Bootstrap — HUGO15', 'utf8');
    expect(readWorkspaceContext(tmpDir)).toBeNull();
  });

  test('skips heading-only files but includes files with substantive content', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul — HUGO15', 'utf8');          // heading only → skip
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# User\n\nAlways respond in Spanish.', 'utf8'); // has body → include
    fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), '## Tools\n\nUse absolute paths.', 'utf8');     // has body → include
    const result = readWorkspaceContext(tmpDir)!;
    expect(result).not.toBeNull();
    expect(result).toContain('USER.md');
    expect(result).toContain('TOOLS.md');
    expect(result).not.toContain('SOUL.md');
  });

  test('includes a single file with its filename as header', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul\n\nYou are COMPI.', 'utf8');
    const result = readWorkspaceContext(tmpDir);
    expect(result).toContain('SOUL.md');
    expect(result).toContain('You are COMPI.');
  });

  test('includes all present files in order: SOUL, USER, TOOLS, AGENTS, BOOTSTRAP', () => {
    fs.writeFileSync(path.join(tmpDir, 'BOOTSTRAP.md'), '# Boot\n\nRead SOUL first.', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul\n\nYou are COMPI.', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), '# Tools\n\nUse absolute paths.', 'utf8');
    const result = readWorkspaceContext(tmpDir)!;
    expect(result).not.toBeNull();
    const soulIdx = result.indexOf('SOUL.md');
    const toolsIdx = result.indexOf('TOOLS.md');
    const bootIdx = result.indexOf('BOOTSTRAP.md');
    expect(soulIdx).toBeLessThan(toolsIdx);
    expect(toolsIdx).toBeLessThan(bootIdx);
  });

  test('skips files that do not exist without throwing', () => {
    fs.writeFileSync(path.join(tmpDir, 'TOOLS.md'), '# Tools\n\nAbsolute paths only.', 'utf8');
    // USER.md, SOUL.md, AGENTS.md, BOOTSTRAP.md don't exist
    const result = readWorkspaceContext(tmpDir);
    expect(result).not.toBeNull();
    expect(result).toContain('TOOLS.md');
    expect(result).not.toContain('USER.md');
  });

  test('wraps output in an Agent Context header', () => {
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# Soul\n\nYou are COMPI.', 'utf8');
    const result = readWorkspaceContext(tmpDir)!;
    expect(result).toMatch(/^## Agent Context/);
  });

});
