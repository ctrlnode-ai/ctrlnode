// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import * as childProcess from 'child_process';
import { ClaudeCodeProvider } from '../providers/ClaudeCodeProvider';
import { AGENTS_CTRLNODE_ROOT, resolveProjectHome } from '../config';

/** Ctrlnode workspace root (base for joining taskFolderName). */
const CTRLNODE_ROOT = AGENTS_CTRLNODE_ROOT;

describe('ClaudeCodeProvider.resolveFilesystemBase', () => {
  test('returns AGENTS_CTRLNODE_ROOT regardless of agentId and useCtrlnode', () => {
    const provider = new ClaudeCodeProvider();
    const expected = AGENTS_CTRLNODE_ROOT;
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
    expect(spawnArgs[pIdx + 1]).toContain('piped input');
    // --add-dir must point to the task folder
    const addDirIdx = spawnArgs.indexOf('--add-dir');
    expect(addDirIdx).toBeGreaterThanOrEqual(0);
    expect(spawnArgs[addDirIdx + 1]).toBe(taskFolder);

    // Cleanup
    fs.rmSync(taskFolder, { recursive: true, force: true });
  });
});
