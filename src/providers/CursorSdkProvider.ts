/**
 * CursorSdkProvider — IProvider implementation using @cursor/sdk.
 *
 * @cursor/sdk uses @connectrpc/connect-node (HTTP/2 gRPC) which is incompatible
 * with Bun's http2 implementation (causes NGHTTP2_FRAME_SIZE_ERROR). We work
 * around this by spawning a Node.js child process (cursor-sdk-runner.mjs) that
 * runs the SDK and communicates with the Bridge via stdin/stdout JSONL.
 *
 * Auth: CURSOR_API_KEY env var (Cursor Dashboard → Integrations).
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider';
import { AgentSummary } from '../types';
import {
  CURSOR_TIMEOUT_MINUTES,
  CTRLNODE_ROOT,
  resolveProjectHome,
} from '../config';
import { discoveredAgents } from '../agentDiscovery';
import { logger } from '../logger';
import { augmentPromptForRepoMode, resolveRepoDispatchSpawn } from './repoDispatchContext';
import { detectStatusTag, writeTaskOutputs } from './providerFileUtils';
import { CURSOR_KNOWN_MODELS } from './knownModels';
import { CURSOR_SDK_RUNNER_SOURCE } from './cursorSdkRunnerEmbedded';
import { SQLITE3_NATIVE_B64 } from './cursorSqlite3NativeEmbedded';
import { SQLITE3_JS_FILES } from './cursorSqlite3JsEmbedded';

/**
 * Resolves what to spawn for the cursor SDK runner.
 * @cursor/sdk uses native bindings that require a real Node.js environment
 * (it walks the filesystem looking for package.json — fails inside Bun's VFS).
 * Always spawns Node.js. Prefer a sibling cursor-sdk-runner.mjs next to the binary;
 * if absent, the embedded source is extracted to /tmp on first use.
 */
// Tmp dir where the runner .mjs is extracted — sqlite3 node_modules lives here too.
let _runnerTmpDir: string | undefined;

function ensureRunnerTmpDir(): string {
  if (_runnerTmpDir) return _runnerTmpDir;
  _runnerTmpDir = path.join(os.tmpdir(), 'ctrlnode-cursor-runner');
  fs.mkdirSync(_runnerTmpDir, { recursive: true });
  return _runnerTmpDir;
}

function ensureSqlite3NextToRunner(runnerDir: string): void {
  // ESM resolver walks up from the importer directory looking for node_modules.
  // Place sqlite3 as a proper package next to the runner so it resolves correctly.
  // NODE_PATH does not work for ESM; this sibling node_modules approach does.
  const pkgDir = path.join(runnerDir, 'node_modules', 'sqlite3');

  // First preference: real sqlite3 in node_modules next to the exe or in cwd.
  const binDir = path.dirname(process.execPath);
  const realSqlite3 = [
    path.join(binDir, 'node_modules', 'sqlite3'),
    path.join(process.cwd(), 'node_modules', 'sqlite3'),
  ].find(d => fs.existsSync(path.join(d, 'build', 'Release', 'node_sqlite3.node')));

  if (realSqlite3) {
    if (!fs.existsSync(path.join(pkgDir, 'build', 'Release', 'node_sqlite3.node'))) {
      _copySqlite3Package(realSqlite3, pkgDir);
      logger.info('cursor_sdk.sqlite3_copied', { from: realSqlite3 });
    }
    return;
  }

  // Second preference: extract the embedded .node binary.
  if (!fs.existsSync(path.join(pkgDir, 'build', 'Release', 'node_sqlite3.node'))) {
    _extractSqlite3Binding(pkgDir);
  }
}

function _copySqlite3Package(srcPkgDir: string, dstPkgDir: string): void {
  // Copy the full sqlite3 package recursively (JS files + binding).
  const copyDir = (src: string, dst: string) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        copyDir(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  };
  copyDir(srcPkgDir, dstPkgDir);
}

function _extractSqlite3Binding(pkgDir: string): void {
  if (!SQLITE3_NATIVE_B64) return;
  // We only have the .node binary embedded — copy the JS wrapper files from
  // the embedded sqlite3 JS source alongside it.
  for (const [relPath, content] of Object.entries(SQLITE3_JS_FILES)) {
    const dest = path.join(pkgDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf8');
  }
  const bindingPath = path.join(pkgDir, 'build', 'Release', 'node_sqlite3.node');
  fs.mkdirSync(path.dirname(bindingPath), { recursive: true });
  fs.writeFileSync(bindingPath, Buffer.from(SQLITE3_NATIVE_B64, 'base64'));
  logger.info('cursor_sdk.sqlite3_extracted', { path: bindingPath });
}

function getRunnerSpawnArgs(): { cmd: string; args: string[] } {
  const binDir = path.dirname(process.execPath);
  const sibling = path.join(binDir, 'cursor-sdk-runner.mjs');
  let runnerPath = sibling;
  if (!fs.existsSync(sibling)) {
    // Extract runner to a dedicated tmp dir so sqlite3 node_modules can live next to it.
    const runnerDir = ensureRunnerTmpDir();
    runnerPath = path.join(runnerDir, 'cursor-sdk-runner.mjs');
    // Always overwrite — the cached file may be stale from a previous binary version.
    fs.writeFileSync(runnerPath, CURSOR_SDK_RUNNER_SOURCE, 'utf8');
    logger.info('cursor_sdk.runner_extracted', { path: runnerPath });
    ensureSqlite3NextToRunner(runnerDir);
  }
  const isWindows = process.platform === 'win32';
  return { cmd: isWindows ? 'node.exe' : 'node', args: [runnerPath] };
}

export class CursorSdkProvider implements IProvider {
  readonly providerName = 'cursor';

  async discoverAgents(): Promise<AgentSummary[]> {
    // Cursor agents are registered exclusively via sync_cursor_agents (pushed
    // from the SaaS after the user registers them). Auto-discovery caused
    // phantom UNREGISTERED cards in the UI before any agent was registered.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const providerTasksRoot = resolveProjectHome(params.taskFolderName);
    const dispatch = resolveRepoDispatchSpawn(params, providerTasksRoot);
    const prompt = augmentPromptForRepoMode(params.prompt, params);
    logger.info('cursor_sdk.repo_mode', {
      taskId: params.taskId,
      isRepoMode: dispatch.isRepoMode,
      cwd: dispatch.spawnCwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });
    await this._run(params.taskId, prompt, dispatch.spawnCwd, callbacks, params.taskFolderName, params.agentId);
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    await this._run(params.taskId, params.message, undefined, callbacks, undefined, params.agentId);
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(agentId: string): Promise<boolean> {
    const apiKey = process.env.CURSOR_API_KEY ?? '';
    if (!apiKey) return false;
    return new Promise((resolve) => {
      const { cmd: runnerCmd, args: runnerArgs } = getRunnerSpawnArgs();
      logger.info('cursor_sdk.spawn', { cmd: runnerCmd, args: runnerArgs });
      const proc = spawn(runnerCmd, runnerArgs, {
        cwd: CTRLNODE_ROOT,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'inherit'],
        shell: false,
      });
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 10_000);
      let output = '';
      proc.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
      proc.on('error', () => { clearTimeout(timer); resolve(false); });
      proc.on('close', () => {
        clearTimeout(timer);
        for (const line of output.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'delete_result') { resolve(msg.success === true); return; }
          } catch { /* skip */ }
        }
        resolve(false);
      });
      proc.stdin?.write(JSON.stringify({ command: 'delete', agentId, apiKey }) + '\n');
      proc.stdin?.end();
    });
  }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    return CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    // Cursor SDK does not support SaaS-initiated workspace creation.
    return null;
  }

  async listModels(): Promise<string[]> {
    const { fetchOpenAiCompatibleModels } = await import('./providerFileUtils');
    const apiKey = process.env.CURSOR_API_KEY ?? '';
    // Cursor uses an OpenAI-compatible API at api.cursor.sh — accept all ids
    const models = await fetchOpenAiCompatibleModels(apiKey, 'https://api.cursor.sh', () => true);
    if (models.length > 0) return models;
    // Static fallback of known Cursor models
    return CURSOR_KNOWN_MODELS;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _run(
    taskId: string,
    prompt: string,
    spawnCwd: string,
    callbacks: TaskCallbacks,
    taskFolderName?: string,
    agentId?: string,
  ): Promise<void> {
    fs.mkdirSync(spawnCwd, { recursive: true });
    const timeoutMs = CURSOR_TIMEOUT_MINUTES * 60_000;

    const mcpRoot = path.resolve(spawnCwd);

    const { cmd: runnerCmd, args: runnerArgs } = getRunnerSpawnArgs();
    logger.info('cursor_sdk.start', { taskId, cwd: spawnCwd, mcpRoot, cmd: runnerCmd });
    logger.info('cursor_sdk.spawn', { cmd: runnerCmd, args: runnerArgs });
    const proc = spawn(runnerCmd, runnerArgs, {
      cwd: spawnCwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    });

    if (!proc.stdin || !proc.stdout) {
      callbacks.onComplete('failed', 'Failed to start cursor-sdk-runner process');
      return;
    }

    // Detect early exit
    let procExitCode: number | null = null;
    let earlyExitReject: ((err: Error) => void) | null = null;
    const earlyExitPromise = new Promise<never>((_res, rej) => { earlyExitReject = rej; });
    proc.on('error', (err) => {
      logger.error('cursor_sdk.proc_error', { taskId, error: err.message });
      earlyExitReject?.(err);
    });
    proc.on('close', (code) => {
      procExitCode = code;
      logger.info('cursor_sdk.proc_close', { taskId, code });
      earlyExitReject?.(new Error(`cursor-sdk-runner exited with code ${code}`));
    });

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      logger.warn('cursor_sdk.timeout', { taskId, timeoutMinutes: CURSOR_TIMEOUT_MINUTES });
    }, timeoutMs);

    let accumulatedText = '';
    const writtenFiles: string[] = [];

    // Per-agent model and description override.
    const agentInfo = agentId ? discoveredAgents[agentId] : undefined;
    const registeredModel = agentInfo?.model && agentInfo.model !== 'cursor' ? agentInfo.model : undefined;
    const effectiveModel = registeredModel ?? 'composer-2';
    const effectivePrompt = agentInfo?.description
      ? `${agentInfo.description}\n\n---\n\n${prompt}`
      : prompt;
    const wrappedPrompt = buildPrompt(effectivePrompt, mcpRoot);

    // Send task config as a single JSON line to stdin
    const taskConfig = JSON.stringify({
      command:   'run',
      taskId,
      agentId,
      prompt:    wrappedPrompt,
      cwd:       spawnCwd,
      mcpRoot,
      model:     effectiveModel,
      apiKey:    process.env.CURSOR_API_KEY ?? '',
      timeoutMs,
    });
    proc.stdin.write(taskConfig + '\n');
    proc.stdin.end();

    const runnerWork = async () => {
      // Read JSONL events from stdout
      const { createInterface } = await import('readline');
      const rl = createInterface({ input: proc.stdout!, terminal: false });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'text_delta' && typeof msg.text === 'string') {
          accumulatedText += msg.text;
          callbacks.onStream({ kind: 'text_delta', taskId, text: msg.text });
          callbacks.onMessage(msg.text);
        } else if (msg.type === 'thinking_delta' && typeof msg.text === 'string') {
          callbacks.onStream({ kind: 'thinking_delta', taskId, text: msg.text });
        } else if (msg.type === 'file_written') {
          const p = msg.path as string | undefined;
          if (p) {
            writtenFiles.push(p);
            logger.info('cursor_sdk.file_written', { taskId, path: p });
            callbacks.onStream({ kind: 'file_written', taskId, path: p });
          }
        } else if (msg.type === 'run_status') {
          logger.info('cursor_sdk.run_status', { taskId, status: msg.status });
          callbacks.onStream({ kind: 'run_status', taskId, status: msg.status });
        } else if (msg.type === 'turn_ended') {
          logger.info('cursor_sdk.turn_ended', { taskId, usage: msg.usage });
        } else if (msg.type === 'agent_resumed') {
          logger.info('cursor_sdk.agent_resumed', { taskId, cursorAgentId: msg.cursorAgentId });
        } else if (msg.type === 'agent_created') {
          logger.info('cursor_sdk.agent_created', { taskId, cursorAgentId: msg.cursorAgentId });
        } else if (msg.type === 'task_done') {
          if (!accumulatedText.trim() && msg.summary) {
            accumulatedText = msg.summary;
          }
          if (msg.model && callbacks.onModelDiscovered) {
            callbacks.onModelDiscovered(msg.model as string);
          }
          return;
        } else if (msg.type === 'task_error') {
          throw new Error(msg.error ?? 'Cursor runner reported task_error');
        }
      }
    };

    try {
      await Promise.race([runnerWork(), earlyExitPromise]);
      earlyExitReject = null;
      clearTimeout(timeoutHandle);

      if (timedOut) {
        callbacks.onComplete('blocked', 'Task timed out');
        return;
      }

      writeTaskOutputs(taskId, taskFolderName ?? '', accumulatedText, 'cursor_sdk');
      // onMessage called per text_delta chunk; skip final bulk send.
      const completion = detectStatusTag(accumulatedText);
      logger.info('cursor_sdk.done', { taskId, status: completion.status, filesWritten: writtenFiles.length });
      callbacks.onComplete(completion.status, completion.reason);

    } catch (err) {
      clearTimeout(timeoutHandle);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('cursor_sdk.error', { taskId, error: msg });
      callbacks.onComplete('failed', msg);
    } finally {
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(userPrompt: string, outputDir: string): string {
  return `You are an autonomous coding agent. Your task output folder is:
${outputDir}

When your task requires producing files (code, reports, data, etc.), write them directly to the output folder using your file editing tools. Do NOT just describe what you would do — actually create the files.

When you have finished all work, end your response with one of these tags on its own line:
<TASK_COMPLETED:done>
<TASK_BLOCKED:reason>
<TASK_FAILED:reason>

--- TASK ---
${userPrompt}`;
}
