// @ts-nocheck
import { describe, expect, test, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { CTRLNODE_ROOT } from '../config';

async function* asyncFrom(items: any[]) {
  for (const item of items) yield item;
}

describe('ClaudeAgentSdkProvider.sendToSession stale-session recovery', () => {
  let taskFolder: string;

  afterEach(() => {
    mock.restore();
    if (taskFolder) fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('retries without resume when the SDK reports the session id is unknown', async () => {
    // Note: keep the recovered run's status non-"completed" in the mock so the
    // provider's real output-stability poller (15s window) doesn't run during the test.
    let callCount = 0;
    let lastPromptSeen = '';
    let lastOptionsSeen: any;

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ prompt, options }: any) => {
        callCount += 1;
        lastPromptSeen = prompt;
        lastOptionsSeen = options;
        if (callCount === 1) {
          // Real SDK error results carry `errors: string[]`, not a singular `.error` string.
          return asyncFrom([
            { type: 'result', subtype: 'error_during_execution', session_id: 'stale-session-id', errors: ['No conversation found with session ID: stale-session-id'] },
          ]);
        }
        return asyncFrom([
          { type: 'result', subtype: 'error_max_turns', session_id: 'fresh-session-id' },
        ]);
      },
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    const taskId = 'sdk-stale-session-task';
    taskFolder = path.join(CTRLNODE_ROOT, 'tasks', taskId);
    const outputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(outputFolder, { recursive: true });
    fs.writeFileSync(path.join(outputFolder, 'agent_log.md'), '# Agent log\n\nDid step one already.', 'utf-8');

    (provider as any).sessionCache.set(taskId, 'stale-session-id');

    const onComplete = mock((_status: string, _reason?: string) => {});
    await provider.sendToSession(
      { agentId: 'local', taskId, message: 'please continue' } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete }
    );

    expect(callCount).toBe(2);
    expect(lastOptionsSeen.resume).toBeUndefined();
    expect(lastPromptSeen).toContain('Did step one already.');
    expect(lastPromptSeen).toContain('please continue');
    expect(onComplete).toHaveBeenCalledWith('blocked', expect.stringContaining('max_turns'));
  });
});

describe('ClaudeAgentSdkProvider.sendToSession task folder resolution', () => {
  let taskFolder: string;
  let realTaskFolder: string;

  afterEach(() => {
    mock.restore();
    if (taskFolder) fs.rmSync(taskFolder, { recursive: true, force: true });
    if (realTaskFolder) fs.rmSync(realTaskFolder, { recursive: true, force: true });
  });

  test('writes output and session_id under taskFolderName, never the disconnected tasks/{taskId} folder', async () => {
    let lastOptionsSeen: any;

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ options }: any) => {
        lastOptionsSeen = options;
        // Note: keep this non-"success" (blocked) so the provider's real output-stability
        // poller (15s window) doesn't run during the test.
        return asyncFrom([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'hello from followup' }] } },
          { type: 'result', subtype: 'error_max_turns', session_id: 'new-session-id' },
        ]);
      },
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    const taskId = 'sdk-real-folder-task';
    const taskFolderName = 'tasks/proyecto-claude/07-09/bbf2d8db-cuanto';
    realTaskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    taskFolder = path.join(CTRLNODE_ROOT, 'tasks', taskId);

    // session_id lives inside the real nested task folder (written by a prior dispatch
    // that also had taskFolderName available).
    fs.mkdirSync(realTaskFolder, { recursive: true });
    fs.writeFileSync(path.join(realTaskFolder, 'session_id'), 'prev-session-id', 'utf-8');

    const onComplete = mock((_status: string, _reason?: string) => {});
    await provider.sendToSession(
      { agentId: 'local', taskId, message: 'please continue', taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete }
    );

    expect(fs.existsSync(path.join(realTaskFolder, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(taskFolder, 'output'))).toBe(false);
    expect(lastOptionsSeen.additionalDirectories).toContain(realTaskFolder);
    expect(lastOptionsSeen.additionalDirectories).not.toContain(taskFolder);
    expect(lastOptionsSeen.resume).toBe('prev-session-id');

    // session_id is persisted inside the real task folder, not the flat tasks/{taskId} one.
    expect(fs.existsSync(path.join(realTaskFolder, 'session_id'))).toBe(true);
    expect(fs.readFileSync(path.join(realTaskFolder, 'session_id'), 'utf-8')).toBe('new-session-id');
    expect(fs.existsSync(taskFolder)).toBe(false);
  });
});

describe('ClaudeAgentSdkProvider — real SDK error-result shape', () => {
  afterEach(() => mock.restore());

  test('generateStructuredPlan surfaces the real error text (errors[]) instead of a generic fallback', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => asyncFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 's1',
          errors: ['overloaded_error: Anthropic API is temporarily overloaded'],
        },
      ]),
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    await expect(
      provider.generateStructuredPlan({
        agentId: 'local',
        prompt: 'plan something',
        workingDir: '/tmp/does-not-exist',
        timeoutMs: 5_000,
      } as any)
    ).rejects.toThrow('overloaded_error: Anthropic API is temporarily overloaded');
  });

  test('generateStructuredPlan still identifies error_max_turns as a timeout, not a generic provider error', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => asyncFrom([
        { type: 'result', subtype: 'error_max_turns', session_id: 's1', errors: [] },
      ]),
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    await expect(
      provider.generateStructuredPlan({
        agentId: 'local',
        prompt: 'plan something',
        workingDir: '/tmp/does-not-exist',
        timeoutMs: 5_000,
      } as any)
    ).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');
  });

  test('generateStructuredPlan falls back to a subtype-qualified message when the SDK gives no error text at all', async () => {
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => asyncFrom([
        { type: 'result', subtype: 'error_max_budget_usd', session_id: 's1', errors: [] },
      ]),
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    await expect(
      provider.generateStructuredPlan({
        agentId: 'local',
        prompt: 'plan something',
        workingDir: '/tmp/does-not-exist',
        timeoutMs: 5_000,
      } as any)
    ).rejects.toThrow('GRAPH_GENERATION_PROVIDER_ERROR: error_max_budget_usd');
  });

  test('dispatchTask marks the task failed with the real SDK error text, not a blocked/max_turns label', async () => {
    let taskFolder: string | undefined;
    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: () => asyncFrom([
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 's1',
          errors: ['overloaded_error: Anthropic API is temporarily overloaded'],
        },
      ]),
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    const taskId = 'sdk-real-error-shape-task';
    const taskFolderName = `tasks/demo/real-error-${taskId}`;
    taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);

    const onComplete = mock((_status: string, _reason?: string) => {});
    try {
      await provider.dispatchTask(
        { agentId: 'local', taskId, prompt: 'do work', taskFolderName } as any,
        { onStream: () => {}, onMessage: () => {}, onComplete }
      );

      expect(onComplete).toHaveBeenCalledWith('failed', 'overloaded_error: Anthropic API is temporarily overloaded');
    } finally {
      if (taskFolder && fs.existsSync(taskFolder)) fs.rmSync(taskFolder, { recursive: true, force: true });
    }
  });
});
