import { describe, expect, test } from 'bun:test';

import { ClaudePlannerTextCollector } from '../graphBlueprintPlanner';

describe('ClaudePlannerTextCollector', () => {
  test('keeps only the latest growing snapshot for one assistant message', () => {
    const collector = new ClaudePlannerTextCollector();

    collector.add({
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: '{"name":"Daily' }] },
    });
    collector.add({
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: '{"name":"Daily brief"}' }] },
    });

    expect(collector.text).toBe('{"name":"Daily brief"}');
  });

  test('retains completed assistant turns in order', () => {
    const collector = new ClaudePlannerTextCollector();

    collector.add({
      type: 'assistant',
      uuid: 'assistant-1',
      message: { content: [{ type: 'text', text: '```json\n' }] },
    });
    collector.add({
      type: 'assistant',
      uuid: 'assistant-2',
      message: { content: [{ type: 'text', text: '{"name":"Daily brief"}\n```' }] },
    });

    expect(collector.text).toBe('```json\n{"name":"Daily brief"}\n```');
  });
});
