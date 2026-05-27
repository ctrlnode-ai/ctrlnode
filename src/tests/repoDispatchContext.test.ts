import { describe, expect, it } from 'vitest';
import path from 'path';
import {
  augmentPromptForRepoMode,
  buildTaskLogSystemBlock,
  isRepoTaskMode,
  resolveRepoDispatchSpawn,
  resolveTaskLogAbsolutePath,
} from '../providers/repoDispatchContext';
import { CTRLNODE_ROOT } from '../config';
import type { DispatchTaskParams } from '../providers/IProvider';

const baseParams = (overrides: Partial<DispatchTaskParams> = {}): DispatchTaskParams => ({
  agentId: 'agent-1',
  taskId: '550e8400-e29b-41d4-a716-446655440000',
  prompt: '# TASK\n\nDo work',
  workingDir: 'C:/repo/project',
  taskFolderName: 'tasks/demo/05-27/abc-task',
  ...overrides,
});

describe('repoDispatchContext', () => {
  it('detects repo task mode', () => {
    expect(isRepoTaskMode(baseParams({ taskMode: 'repo', repoPath: 'C:/repo' }))).toBe(true);
    expect(isRepoTaskMode(baseParams({ taskMode: 'output', repoPath: 'C:/repo' }))).toBe(false);
    expect(isRepoTaskMode(baseParams({ taskMode: 'repo', repoPath: '' }))).toBe(false);
  });

  it('resolves spawn cwd to repository in repo mode', () => {
    const ctx = resolveRepoDispatchSpawn(
      baseParams({ taskMode: 'repo', repoPath: 'C:/CODE/CtrlNode.Web', workingDir: 'C:/CODE/CtrlNode.Web' }),
      CTRLNODE_ROOT,
    );
    expect(ctx.isRepoMode).toBe(true);
    expect(ctx.spawnCwd).toBe(path.resolve('C:/CODE/CtrlNode.Web'));
    expect(ctx.extraDirectories).toContain(path.join(CTRLNODE_ROOT, 'tasks/demo/05-27/abc-task'));
    expect(ctx.extraDirectories).toContain(CTRLNODE_ROOT);
  });

  it('builds absolute task log path under ctrlnode root', () => {
    const abs = resolveTaskLogAbsolutePath('tasks/demo/05-27/abc-task/output/abc-output.md');
    expect(abs).toBe(path.join(CTRLNODE_ROOT, 'tasks/demo/05-27/abc-task/output/abc-output.md'));
  });

  it('augments prompt with task log block once', () => {
    const params = baseParams({
      taskMode: 'repo',
      repoPath: 'C:/repo',
      taskLogRelativePath: 'tasks/demo/05-27/abc-task/output/abc-output.md',
    });
    const once = augmentPromptForRepoMode('hello', params);
    expect(once).toContain('hello');
    expect(once).toContain(buildTaskLogSystemBlock(params.taskLogRelativePath)!);
    expect(augmentPromptForRepoMode(once, params)).toBe(once);
  });
});
