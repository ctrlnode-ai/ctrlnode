import { describe, expect, test } from 'bun:test';
import { mapAcpUpdate, formatAcpToolCallActivity } from './acpUpdateMapper';

describe('mapAcpUpdate', () => {
  test('maps agent_message_chunk', () => {
    const mapped = mapAcpUpdate('t1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
    expect(mapped?.kind).toBe('text_chunk');
    expect(mapped?.text).toBe('hello');
  });

  test('maps tool_call', () => {
    const mapped = mapAcpUpdate('t1', { sessionUpdate: 'tool_call', title: 'read_file' });
    expect(mapped?.kind).toBe('tool_call');
  });

  test('maps agent_thought', () => {
    const mapped = mapAcpUpdate('t1', {
      sessionUpdate: 'agent_thought',
      content: { type: 'text', text: 'thinking…' },
    });
    expect(mapped?.kind).toBe('thinking');
    expect(mapped?.text).toBe('thinking…');
  });
});

describe('formatAcpToolCallActivity', () => {
  test('uses title when present', () => {
    expect(formatAcpToolCallActivity({ title: 'terminal' })).toBe('→ terminal\n');
  });
});
