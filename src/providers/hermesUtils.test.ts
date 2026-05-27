import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  parseHermesJsonLine,
  loadPersistedSessions,
  saveConversationId,
  formatHermesLogLineForActivity,
  shouldSkipHermesLogLine,
  extractHermesSessionId,
  hermesLogLineMatchesSession,
} from './hermesUtils';

describe('formatHermesLogLineForActivity', () => {
  test('skips plugin registration noise', () => {
    expect(
      formatHermesLogLineForActivity(
        "2026-05-25 01:46:18,160 INFO hermes_cli.plugins: Plugin 'web-xai' registered web provider: xai",
      ),
    ).toBeNull();
    expect(shouldSkipHermesLogLine("Plugin 'web-xai' registered")).toBe(true);
  });

  test('formats conversation turn with newlines', () => {
    const line =
      '2026-05-25 01:46:21,794 INFO [20260525_014619_1ceb3a] agent.conversation_loop: conversation turn: session=20260525_014619_1ceb3a model=gpt-5.4-mini provider=copilot-acp platform=cli history=0 msg="escribe hola mundo"';
    expect(formatHermesLogLineForActivity(line)).toBe(
      '→ Turn · gpt-5.4-mini (copilot-acp)\n   escribe hola mundo\n',
    );
  });

  test('formats turn ended line', () => {
    const line =
      '2026-05-25 01:46:31,373 INFO [20260525_014619_1ceb3a] agent.conversation_loop: Turn ended: reason=text_response(finish_reason=stop) model=gpt-5.4-mini api_calls=1/90 budget=1/90 tool_turns=0 last_msg_role=assistant response_len=10 session=20260525_014619_1ceb3a';
    expect(formatHermesLogLineForActivity(line)).toBe(
      '✓ Done · finish_reason=stop · gpt-5.4-mini · tools=0 · 10 chars\n',
    );
  });

  test('extracts session id from bracket prefix', () => {
    expect(extractHermesSessionId('[20260525_014619_1ceb3a] agent')).toBe('20260525_014619_1ceb3a');
  });

  test('hermesLogLineMatchesSession filters other sessions', () => {
    const line = '[20260525_999999_aaaaaa] agent.conversation_loop: conversation turn';
    expect(hermesLogLineMatchesSession(line, '20260525_014619_1ceb3a')).toBe(false);
    expect(hermesLogLineMatchesSession(line, '20260525_999999_aaaaaa')).toBe(true);
  });
});

describe('parseHermesJsonLine', () => {
  test('parses message event with content', () => {
    const result = parseHermesJsonLine('{"type":"message","content":"Hello world"}');
    expect(result).toEqual({ type: 'message', content: 'Hello world' });
  });

  test('parses conversation_id event with id', () => {
    const result = parseHermesJsonLine('{"type":"conversation_id","id":"conv-abc123"}');
    expect(result).toEqual({ type: 'conversation_id', id: 'conv-abc123' });
  });

  test('parses done event', () => {
    const result = parseHermesJsonLine('{"type":"done"}');
    expect(result).toEqual({ type: 'done' });
  });

  test('parses error event with message', () => {
    const result = parseHermesJsonLine('{"type":"error","message":"Something failed"}');
    expect(result).toEqual({ type: 'error', message: 'Something failed' });
  });

  test('returns null for invalid JSON', () => {
    const result = parseHermesJsonLine('not valid json at all');
    expect(result).toBeNull();
  });

  test('returns null for empty string', () => {
    const result = parseHermesJsonLine('');
    expect(result).toBeNull();
  });

  test('returns null for whitespace-only string', () => {
    const result = parseHermesJsonLine('   ');
    expect(result).toBeNull();
  });

  test('returns null for partial JSON', () => {
    const result = parseHermesJsonLine('{"type":');
    expect(result).toBeNull();
  });
});

describe('session persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('loadPersistedSessions returns empty map when directory does not exist', () => {
    const result = loadPersistedSessions('/nonexistent/path/that/does/not/exist/abc123');
    expect(result.size).toBe(0);
  });

  test('loadPersistedSessions returns empty map for empty directory', () => {
    const result = loadPersistedSessions(tmpDir);
    expect(result.size).toBe(0);
  });

  test('saveConversationId creates a JSON file with the conversation id', () => {
    saveConversationId(tmpDir, 'agent-1', 'conv-xyz');
    const filePath = path.join(tmpDir, 'agent-1.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(data.conversationId).toBe('conv-xyz');
  });

  test('saveConversationId stores updatedAt timestamp', () => {
    const before = Date.now();
    saveConversationId(tmpDir, 'agent-1', 'conv-xyz');
    const after = Date.now();
    const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'agent-1.json'), 'utf8'));
    expect(data.updatedAt).toBeGreaterThanOrEqual(before);
    expect(data.updatedAt).toBeLessThanOrEqual(after);
  });

  test('loadPersistedSessions reads saved conversation id', () => {
    saveConversationId(tmpDir, 'agent-1', 'conv-aaa');
    const result = loadPersistedSessions(tmpDir);
    expect(result.get('agent-1')).toBe('conv-aaa');
  });

  test('loadPersistedSessions reads multiple saved sessions', () => {
    saveConversationId(tmpDir, 'agent-1', 'conv-aaa');
    saveConversationId(tmpDir, 'agent-2', 'conv-bbb');
    const result = loadPersistedSessions(tmpDir);
    expect(result.get('agent-1')).toBe('conv-aaa');
    expect(result.get('agent-2')).toBe('conv-bbb');
    expect(result.size).toBe(2);
  });

  test('saveConversationId creates nested directory if it does not exist', () => {
    const nestedDir = path.join(tmpDir, 'nested', 'sessions');
    saveConversationId(nestedDir, 'agent-x', 'conv-y');
    expect(fs.existsSync(path.join(nestedDir, 'agent-x.json'))).toBe(true);
  });

  test('loadPersistedSessions skips files without .json extension', () => {
    fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'not a session');
    const result = loadPersistedSessions(tmpDir);
    expect(result.size).toBe(0);
  });

  test('loadPersistedSessions skips files with missing conversationId', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent-broken.json'), JSON.stringify({ updatedAt: 123 }));
    const result = loadPersistedSessions(tmpDir);
    expect(result.size).toBe(0);
  });

  test('loadPersistedSessions skips corrupted JSON files', () => {
    fs.writeFileSync(path.join(tmpDir, 'agent-bad.json'), 'not json { broken');
    saveConversationId(tmpDir, 'agent-ok', 'conv-good');
    const result = loadPersistedSessions(tmpDir);
    expect(result.size).toBe(1);
    expect(result.get('agent-ok')).toBe('conv-good');
  });

  test('saveConversationId overwrites existing session file', () => {
    saveConversationId(tmpDir, 'agent-1', 'conv-old');
    saveConversationId(tmpDir, 'agent-1', 'conv-new');
    const result = loadPersistedSessions(tmpDir);
    expect(result.get('agent-1')).toBe('conv-new');
  });
});
