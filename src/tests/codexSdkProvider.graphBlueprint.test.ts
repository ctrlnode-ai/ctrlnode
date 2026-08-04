// @ts-nocheck
import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('CodexSdkProvider.generateStructuredPlan', () => {
  afterEach(() => mock.restore());

  test('uses a read-only isolated turn and requests a GraphBlueprint JSON response', async () => {
    let threadOptions: any;
    let promptSeen = '';
    let turnOptions: any;

    mock.module('@openai/codex-sdk', () => ({
      Codex: class {
        startThread(options: any) {
          threadOptions = options;
          return {
            run: async (prompt: string, options: any) => {
              promptSeen = prompt;
              turnOptions = options;
              return { finalResponse: '{"name":"Daily brief"}', items: [], usage: null };
            },
          };
        }
      },
    }));

    const { CodexSdkProvider } = await import('../providers/CodexSdkProvider');
    const provider = new CodexSdkProvider();
    const result = await provider.generateStructuredPlan({
      agentId: 'codex-planner',
      prompt: 'Create a daily engineering brief graph from local evidence.',
      workingDir: process.cwd(),
      timeoutMs: 90_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
    expect(promptSeen).toContain('Create a daily engineering brief graph');
    expect(threadOptions).toEqual(expect.objectContaining({
      workingDirectory: process.cwd(),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      skipGitRepoCheck: true,
    }));
    expect(turnOptions.outputSchema).toEqual(expect.objectContaining({
      type: 'object',
      required: expect.arrayContaining(['name', 'schedule', 'nodes']),
    }));
  });
});
