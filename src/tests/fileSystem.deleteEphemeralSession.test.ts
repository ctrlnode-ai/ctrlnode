// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { deleteEphemeralSession } from '../fileSystem';

/**
 * deleteEphemeralSession is the surgical cleanup used after generateStructuredPlan
 * on OpenClaw: it must remove only the one throwaway subagent session it created,
 * never the agent's main session or any other subagent session.
 */
describe('deleteEphemeralSession', () => {
  let tmpDir: string;
  const agentId = 'compi';
  const planningKey = 'agent:compi:subagent:c25f9e6f-dab3-4438-8cdf-0f22b891d006';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ephemeral-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sessionsDirFor(id: string) {
    return path.join(tmpDir, 'agents', id, 'sessions');
  }

  test('removes the session entry and its jsonl, leaving main and other sessions untouched', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = sessionsDirFor(agentId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'ephemeral-session.jsonl'), 'line1', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, 'main-session.jsonl'), 'line2', 'utf8');
    fs.writeFileSync(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        [planningKey]: { sessionId: 'ephemeral-session' },
        'agent:compi:main': { sessionId: 'main-session' },
      }),
      'utf8',
    );

    deleteEphemeralSession(agentId, planningKey, openclawConfig);

    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
    expect(index).toEqual({ 'agent:compi:main': { sessionId: 'main-session' } });
    expect(fs.existsSync(path.join(sessionsDir, 'ephemeral-session.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, 'main-session.jsonl'))).toBe(true);
  });

  test('does not throw when sessions.json does not exist', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    expect(() => deleteEphemeralSession(agentId, planningKey, openclawConfig)).not.toThrow();
  });

  test('does not throw when the session key is already gone', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = sessionsDirFor(agentId);
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({ 'agent:compi:main': {} }), 'utf8');

    expect(() => deleteEphemeralSession(agentId, planningKey, openclawConfig)).not.toThrow();
    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
    expect(index).toEqual({ 'agent:compi:main': {} });
  });

  test('isolates deletion to the specified agentId folder only', () => {
    const openclawConfig = path.join(tmpDir, 'openclaw.json');
    const sessionsDir = sessionsDirFor(agentId);
    const otherDir = sessionsDirFor('other-agent');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'sessions.json'), JSON.stringify({ [planningKey]: { sessionId: 'x' } }), 'utf8');
    fs.writeFileSync(path.join(otherDir, 'sessions.json'), JSON.stringify({ [planningKey]: { sessionId: 'y' } }), 'utf8');

    deleteEphemeralSession(agentId, planningKey, openclawConfig);

    expect(JSON.parse(fs.readFileSync(path.join(otherDir, 'sessions.json'), 'utf8'))).toEqual({ [planningKey]: { sessionId: 'y' } });
  });
});
