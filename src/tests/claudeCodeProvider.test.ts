// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import * as childProcess from 'child_process';
import { ClaudeCodeProvider } from '../providers/ClaudeCodeProvider';
import { CTRLNODE_ROOT, resolveProjectHome } from '../config';


describe('ClaudeCodeProvider.resolveFilesystemBase', () => {
  test('returns CTRLNODE_ROOT regardless of agentId and useCtrlnode', () => {
    const provider = new ClaudeCodeProvider();
    const expected = CTRLNODE_ROOT;
    expect(provider.resolveFilesystemBase('any-agent', true)).toBe(expected);
    expect(provider.resolveFilesystemBase('any-agent', false)).toBe(expected);
    expect(provider.resolveFilesystemBase(undefined, false)).toBe(expected);
  });
});

describe('ClaudeCodeProvider.resolveWorkspaceCreationBase', () => {
  test('returns null regardless of useCtrlnode', () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.resolveWorkspaceCreationBase(true)).toBeNull();
    expect(provider.resolveWorkspaceCreationBase(false)).toBeNull();
  });
});

describe('ClaudeCodeProvider.discoverAgents', () => {
  test('returns empty array (agents registered via sync_claude_agents)', async () => {
    const provider = new ClaudeCodeProvider();
    const agents = await provider.discoverAgents();
    expect(agents).toHaveLength(0);
  });
});

describe('ClaudeCodeProvider.dispatchTask', () => {
  let tmpDir: string;
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-provider-test-'));
    // Intercept spawn so Claude CLI is never actually called
    spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { on: (_e: string, _cb: Function) => {} },
      stderr: { on: (_e: string, _cb: Function) => {} },
      on: (event: string, cb: Function) => { if (event === 'close') cb(0); },
    } as any);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    spawnSpy.mockRestore();
  });

  test('creates output dir under task folder but does NOT write input/task.md', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'test-task-id';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);

    await provider.dispatchTask(
      { agentId: 'local', taskId, prompt: 'do something', taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete: () => {} }
    );

    expect(fs.existsSync(path.join(taskFolder, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(taskFolder, 'input', 'task.md'))).toBe(false);

    // Cleanup
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('spawns Claude with cwd=TASKS_ROOT, not the task subfolder', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'test-task-id-2';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    /** Expected cwd: the provider’s tasks root = …/ctrlnode/tasks/proj */
    const providerTasksRoot = resolveProjectHome(taskFolderName);

    await provider.dispatchTask(
      { agentId: 'local', taskId, prompt: 'do something', taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete: () => {} }
    );

    const spawnCall = spawnSpy.mock.calls[0];
    const spawnOptions = spawnCall[2] as any;
    expect(spawnOptions.cwd).toBe(providerTasksRoot);

    // Cleanup
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('falls back to passing prompt via -p when no input file exists', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'test-task-id-3';
    const prompt = 'direct task prompt content';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);

    await provider.dispatchTask(
      { agentId: 'local', taskId, prompt, taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete: () => {} }
    );

    const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
    const pIdx = spawnArgs.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    // No input file → original prompt passed through
    expect(spawnArgs[pIdx + 1]).toBe(prompt);

    // Cleanup
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });

  test('uses short -p and --add-dir when input file exists', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'test-task-id-4';
    const taskFolderName = `tasks/proj/${taskId}`;
    const taskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    const inputDir = path.join(taskFolder, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    const inputContent = 'dame una lista de perifericos de un ordenador';
    fs.writeFileSync(path.join(inputDir, `${taskId}.md`), inputContent, 'utf-8');

    await provider.dispatchTask(
      { agentId: 'local', taskId, prompt: 'original long prompt', taskFolderName } as any,
      { onStream: () => {}, onMessage: () => {}, onComplete: () => {} }
    );

    const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
    const pIdx = spawnArgs.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    // -p must be the short fixed instruction, not the original prompt
    expect(spawnArgs[pIdx + 1]).toContain('stdin');
    // --add-dir must point to the task folder
    const addDirIdx = spawnArgs.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[addDirIdx + 1]).toBe(taskFolder);

    // Cleanup
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });
});

describe('ClaudeCodeProvider.sendToSession stale-session recovery', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('retries without --resume when the CLI reports the session id is unknown', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'stale-session-task';
    const taskFolder = path.join(CTRLNODE_ROOT, 'tasks', taskId);
    const outputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(outputFolder, { recursive: true });
    fs.writeFileSync(path.join(outputFolder, 'agent_log.md'), '# Agent log\n\nDid step one already.', 'utf-8');

    // Prime the in-memory session cache with a "stale" session id so sendToSession attempts --resume.
    (provider as any).sessionCache.set(taskId, 'stale-session-id');

    let callCount = 0;
    const spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(() => {
      callCount += 1;
      const isFirstCall = callCount === 1;
      return {
        stdout: { on: (_e: string, _cb: Function) => {} },
        stderr: {
          on: (event: string, cb: Function) => {
            if (event === 'data' && isFirstCall) {
              cb(Buffer.from('No conversation found with session ID: stale-session-id'));
            }
          },
        },
        stdin: { write: () => {}, end: () => {} },
        on: (event: string, cb: Function) => { if (event === 'close') cb(isFirstCall ? 1 : 0); },
      } as any;
    });

    try {
      const onComplete = mock((_status: string, _reason?: string) => {});
      await provider.sendToSession(
        { agentId: 'local', taskId, message: 'please continue' } as any,
        { onStream: () => {}, onMessage: () => {}, onComplete }
      );

      expect(callCount).toBe(2);

      // First call used --resume with the stale id.
      const firstArgs = spawnSpy.mock.calls[0][1] as string[];
      expect(firstArgs).toContain('--resume');
      expect(firstArgs[firstArgs.indexOf('--resume') + 1]).toBe('stale-session-id');

      // Retry call must NOT pass --resume, and must include the prior agent_log.md content.
      const secondArgs = spawnSpy.mock.calls[1][1] as string[];
      expect(secondArgs).not.toContain('--resume');
      const pIdx = secondArgs.indexOf('-p');
      expect(secondArgs[pIdx + 1]).toContain('Did step one already.');
      expect(secondArgs[pIdx + 1]).toContain('please continue');

      // Final callback reflects the successful retry, not the original failure.
      expect(onComplete).toHaveBeenCalledWith('completed');
    } finally {
      spawnSpy.mockRestore();
      fs.rmSync(taskFolder, { recursive: true, force: true });
    }
  });
});

describe('ClaudeCodeProvider.sendToSession task folder resolution', () => {
  let taskFolder: string;
  let realTaskFolder: string;

  afterEach(() => {
    if (taskFolder) fs.rmSync(taskFolder, { recursive: true, force: true });
    if (realTaskFolder) fs.rmSync(realTaskFolder, { recursive: true, force: true });
  });

  test('writes output under taskFolderName, not the disconnected tasks/{taskId} folder', async () => {
    const provider = new ClaudeCodeProvider();
    const taskId = 'code-real-folder-task';
    const taskFolderName = 'tasks/proyecto-claude/07-09/bbf2d8db-cuanto';
    realTaskFolder = path.join(CTRLNODE_ROOT, taskFolderName);
    taskFolder = path.join(CTRLNODE_ROOT, 'tasks', taskId);

    const spawnSpy = spyOn(childProcess, 'spawn').mockReturnValue({
      stdout: { on: (_e: string, _cb: Function) => {} },
      stderr: { on: (_e: string, _cb: Function) => {} },
      stdin: { write: () => {}, end: () => {} },
      on: (event: string, cb: Function) => { if (event === 'close') cb(0); },
    } as any);

    try {
      await provider.sendToSession(
        { agentId: 'local', taskId, message: 'please continue', taskFolderName } as any,
        { onStream: () => {}, onMessage: () => {}, onComplete: () => {} }
      );

      expect(fs.existsSync(path.join(realTaskFolder, 'output'))).toBe(true);
      expect(fs.existsSync(path.join(taskFolder, 'output'))).toBe(false);

      const spawnArgs = spawnSpy.mock.calls[0][1] as string[];
      const addDirIdx = spawnArgs.indexOf('--add-dir');
      expect(addDirIdx).toBeGreaterThanOrEqual(0);
      expect(spawnArgs[addDirIdx + 1]).toBe(realTaskFolder);
    } finally {
      spawnSpy.mockRestore();
    }
  });
});
