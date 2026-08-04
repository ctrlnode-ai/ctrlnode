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
          return asyncFrom([
            { type: 'result', subtype: 'error', session_id: 'stale-session-id', error: 'No conversation found with session ID: stale-session-id' },
          ]);
        }
        return asyncFrom([
          { type: 'result', subtype: 'max_turns', session_id: 'fresh-session-id' },
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

  test('writes output under taskFolderName, not the disconnected tasks/{taskId} folder, and keeps session_id at the fixed location', async () => {
    let lastOptionsSeen: any;

    mock.module('@anthropic-ai/claude-agent-sdk', () => ({
      query: ({ options }: any) => {
        lastOptionsSeen = options;
        return asyncFrom([
          { type: 'assistant', message: { content: [{ type: 'text', text: 'hello from followup' }] } },
          { type: 'result', subtype: 'max_turns', session_id: 'new-session-id' },
        ]);
      },
    }));

    const { ClaudeAgentSdkProvider } = await import('../providers/ClaudeAgentSdkProvider');
    const provider = new ClaudeAgentSdkProvider();

    const taskId = 'sdk-real-folder-task';
    const taskFolderName = 'tasks/proyecto-claude/07-09/bbf2d8db-cuanto';
    realTaskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    taskFolder = path.join(CTRLNODE_ROOT, 'tasks', taskId);

    // session_id lives at the fixed taskId-keyed location (written by a prior dispatch).
    fs.mkdirSync(taskFolder, { recursive: true });
    fs.writeFileSync(path.join(taskFolder, 'session_id'), 'prev-session-id', 'utf-8');

    const onComplete = mock((_status: string, _reason?: string) => {});
    await provider.sendToSession(
      { agentId: 'local', taskId, message: 'please continue', taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete }
    );

    expect(fs.existsSync(path.join(realTaskFolder, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(taskFolder, 'output'))).toBe(false);
    expect(lastOptionsSeen.additionalDirectories).toContain(realTaskFolder);
    expect(lastOptionsSeen.additionalDirectories).not.toContain(taskFolder);

    // session_id stays at the fixed taskId-keyed location, unchanged.
    expect(fs.existsSync(path.join(taskFolder, 'session_id'))).toBe(true);
    expect(fs.readFileSync(path.join(taskFolder, 'session_id'), 'utf-8')).toBe('new-session-id');
  });
});
