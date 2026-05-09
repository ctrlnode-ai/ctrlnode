// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  handleListFiles,
  handleReadFile,
  handleCreateWorkspace,
} from '../filesystemConfigHandlers';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-handlers-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProvider(basePath: string | null = tmpDir) {
  return {
    discoverAgents: mock(async () => []),
    dispatchTask: mock(async () => {}),
    sendToSession: mock(async () => {}),
    invokeTool: mock(async () => {}),
    dispose: mock(async () => {}),
    resolveFilesystemBase: mock(() => basePath),
    resolveWorkspaceCreationBase: mock(() => basePath),
  };
}

function makeCtx(provider: ReturnType<typeof makeProvider>) {
  return {
    sendToSaas: mock(() => {}),
    syncAgents: mock(() => {}),
    provider,
  };
}

// ── handleListFiles ──────────────────────────────────────────────────────────

describe('handleListFiles', () => {
  test('calls provider.resolveFilesystemBase with agentId and useCtrlnode', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleListFiles({ action: 'list_files', agentId: 'local', useCtrlnode: false, requestId: 'r1' } as any, ctx as any);

    expect(provider.resolveFilesystemBase).toHaveBeenCalledWith('local', false);
  });

  test('responds AGENT_NOT_FOUND when provider returns null', () => {
    const provider = makeProvider(null);
    const ctx = makeCtx(provider);

    handleListFiles({ action: 'list_files', agentId: 'ghost', useCtrlnode: false, requestId: 'r1' } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'list_files_response',
      error: 'AGENT_NOT_FOUND',
    }));
  });

  test('returns files from provider base path when subpath is given', () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hi', 'utf8');
    const provider = makeProvider(path.dirname(tmpDir));
    const ctx = makeCtx(provider);
    const subpath = path.basename(tmpDir);

    handleListFiles({ action: 'list_files', agentId: 'local', useCtrlnode: false, requestId: 'r1', subpath } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'list_files_response',
      files: expect.arrayContaining([expect.objectContaining({ path: `${subpath}/hello.txt` })]),
    }));
  });
});

// ── handleReadFile ───────────────────────────────────────────────────────────

describe('handleReadFile', () => {
  test('calls provider.resolveFilesystemBase with agentId and useCtrlnode', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'content', 'utf8');

    handleReadFile({ action: 'read_file', agentId: 'local', useCtrlnode: true, requestId: 'r1', path: 'test.txt' } as any, ctx as any);

    expect(provider.resolveFilesystemBase).toHaveBeenCalledWith('local', true);
  });

  test('responds BASE_PATH_NOT_FOUND when provider returns null', () => {
    const provider = makeProvider(null);
    const ctx = makeCtx(provider);

    handleReadFile({ action: 'read_file', agentId: 'ghost', useCtrlnode: false, requestId: 'r1', path: 'x.txt' } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'read_file_response',
      error: 'BASE_PATH_NOT_FOUND',
    }));
  });
});

// ── handleCreateWorkspace ────────────────────────────────────────────────────

describe('handleCreateWorkspace', () => {
  test('calls provider.resolveWorkspaceCreationBase with useCtrlnode', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleCreateWorkspace({ action: 'create_workspace', requestId: 'r1', folderName: 'my-folder', useCtrlnode: false, files: [] } as any, ctx as any);

    expect(provider.resolveWorkspaceCreationBase).toHaveBeenCalledWith(false);
  });

  test('creates folder under provider base path', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleCreateWorkspace({ action: 'create_workspace', requestId: 'r1', folderName: 'my-folder', useCtrlnode: false, files: [] } as any, ctx as any);

    expect(fs.existsSync(path.join(tmpDir, 'my-folder'))).toBe(true);
    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create_workspace_response',
      success: true,
    }));
  });

  test('responds success without creating when provider returns null', () => {
    const provider = makeProvider(null);
    const ctx = makeCtx(provider);

    handleCreateWorkspace({ action: 'create_workspace', requestId: 'r1', folderName: 'agents/local/agent', useCtrlnode: false, files: [] } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create_workspace_response',
      success: true,
    }));
    // Folder must NOT be created in cwd
    expect(fs.existsSync(path.join(process.cwd(), 'agents', 'local', 'agent'))).toBe(false);
  });
});
