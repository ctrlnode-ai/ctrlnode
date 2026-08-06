// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test';

async function* asyncFrom(items: any[]) {
  for (const item of items) yield item;
}

describe('ClaudeAgentSdkProvider.generateStructuredPlan', () => {
  afterEach(() => mock.restore());

  test('uses a generous turn budget while staying read-only (no tools) for the planner call', async () => {
    let optionsSeen: any;

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ options }: any) => {
        optionsSeen = options;
        return asyncFrom([
          { type: 'assistant', uuid: 'm1', message: { content: [{ type: 'text', text: '{"name":"Daily brief"}' }] } },
          { type: 'result', subtype: 'success', session_id: 's1', result: '{"name":"Daily brief"}' },
        ]);
      },
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    await provider.generateStructuredPlan({
      agentId: 'claude-planner',
      prompt: 'Create a daily engineering brief graph from local evidence.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    // Read-only guarantee: no tools available to the model during graph-blueprint
    // generation (see management/docs/08-04-ai-graph-generation-plan) — only the
    // turn budget changes, not the isolation.
    expect(optionsSeen.allowedTools).toEqual([]);
    expect(optionsSeen.maxTurns).toBe(20);
    expect(optionsSeen.permissionMode).toBe('dontAsk');
  });
});
