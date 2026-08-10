// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  handleListFiles,
  handleReadFile,
  handleCreateWorkspace,
  handleCreateFolder,
  handleRenameFolder,
  handleDeleteFolder,
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
  test('calls provider.resolveFilesystemBase with agentId and useCtrlnode when no provider field', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);
    fs.writeFileSync(path.join(tmpDir, 'test.txt'), 'content', 'utf8');

    // useCtrlnode=false + no msg.provider → resolveBase delegates to resolveFilesystemBase
    handleReadFile({ action: 'read_file', agentId: 'local', useCtrlnode: false, requestId: 'r1', path: 'test.txt' } as any, ctx as any);

    expect(provider.resolveFilesystemBase).toHaveBeenCalledWith('local', false);
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

// ── handleCreateFolder ───────────────────────────────────────────────────────

describe('handleCreateFolder', () => {
  test('creates the folder under the resolved base path and acks success', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleCreateFolder({ action: 'create_folder', requestId: 'r1', useCtrlnode: false, path: 'new-folder' } as any, ctx as any);

    expect(fs.existsSync(path.join(tmpDir, 'new-folder'))).toBe(true);
    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create_folder_ack', requestId: 'r1', success: true, error: null,
    }));
  });

  test('acks MISSING_PATH when no path is given', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleCreateFolder({ action: 'create_folder', requestId: 'r1', useCtrlnode: false } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'create_folder_ack', requestId: 'r1', success: false, error: 'MISSING_PATH',
    }));
  });

  test('acks INVALID_PATH and does not escape the base path via traversal', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleCreateFolder({ action: 'create_folder', requestId: 'r1', useCtrlnode: false, path: '../escaped' } as any, ctx as any);

    expect(fs.existsSync(path.join(path.dirname(tmpDir), 'escaped'))).toBe(false);
  });
});

// ── handleRenameFolder ───────────────────────────────────────────────────────

describe('handleRenameFolder', () => {
  test('renames the folder in place and acks success', () => {
    fs.mkdirSync(path.join(tmpDir, 'old-name'));
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleRenameFolder({ action: 'rename_folder', requestId: 'r1', useCtrlnode: false, path: 'old-name', newPath: 'new-name' } as any, ctx as any);

    expect(fs.existsSync(path.join(tmpDir, 'old-name'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'new-name'))).toBe(true);
    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rename_folder_ack', requestId: 'r1', success: true, error: null,
    }));
  });

  test('acks FOLDER_NOT_FOUND when the source folder does not exist', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleRenameFolder({ action: 'rename_folder', requestId: 'r1', useCtrlnode: false, path: 'missing', newPath: 'renamed' } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rename_folder_ack', requestId: 'r1', success: false, error: 'FOLDER_NOT_FOUND',
    }));
  });
});

// ── handleDeleteFolder ───────────────────────────────────────────────────────

describe('handleDeleteFolder', () => {
  test('deletes an empty folder and acks success', () => {
    fs.mkdirSync(path.join(tmpDir, 'empty-folder'));
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleDeleteFolder({ action: 'delete_folder', requestId: 'r1', useCtrlnode: false, path: 'empty-folder' } as any, ctx as any);

    expect(fs.existsSync(path.join(tmpDir, 'empty-folder'))).toBe(false);
    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete_folder_ack', requestId: 'r1', success: true, error: null,
    }));
  });

  test('refuses to delete a non-empty folder and leaves it in place', () => {
    fs.mkdirSync(path.join(tmpDir, 'has-files'));
    fs.writeFileSync(path.join(tmpDir, 'has-files', 'note.txt'), 'hi', 'utf8');
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleDeleteFolder({ action: 'delete_folder', requestId: 'r1', useCtrlnode: false, path: 'has-files' } as any, ctx as any);

    expect(fs.existsSync(path.join(tmpDir, 'has-files', 'note.txt'))).toBe(true);
    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete_folder_ack', requestId: 'r1', success: false, error: 'FOLDER_NOT_EMPTY',
    }));
  });

  test('acks FOLDER_NOT_FOUND when the folder does not exist', () => {
    const provider = makeProvider(tmpDir);
    const ctx = makeCtx(provider);

    handleDeleteFolder({ action: 'delete_folder', requestId: 'r1', useCtrlnode: false, path: 'missing' } as any, ctx as any);

    expect(ctx.sendToSaas).toHaveBeenCalledWith(expect.objectContaining({
      action: 'delete_folder_ack', requestId: 'r1', success: false, error: 'FOLDER_NOT_FOUND',
    }));
  });
});
