import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider';
import { AgentSummary } from '../types';
import {
  GEMINI_TIMEOUT_MINUTES,
  AGENTS_CTRLNODE_ROOT,
  resolveProjectHome,
} from '../config';
import { discoveredAgents } from '../agentDiscovery';
import { logger } from '../logger';
import { detectStatusTag, writeTaskOutputs } from './providerFileUtils';

export class GeminiAcpProvider implements IProvider {
  readonly providerName = 'gemini';

  async discoverAgents(): Promise<AgentSummary[]> {
    // Gemini agents are registered exclusively via sync_gemini_agents (pushed
    // from the SaaS after the user registers them). Returning a static fallback
    // here causes a phantom UNREGISTERED card in the UI.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    await this._runAcp(params.taskId, params.prompt, params.workingDir, callbacks, params.taskFolderName, params.agentId);
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    await this._runAcp(params.taskId, params.message, undefined, callbacks, undefined, params.agentId);
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    // Incoming paths from SaaS are already relative to workspace root (e.g. "tasks/prj/05-01/abc/input/...").
    // Return the ctrlnode root so path.join(base, relPath) resolves correctly.
    return AGENTS_CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    // Gemini ACP does not support SaaS-initiated workspace creation.
    return null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _runAcp(
    taskId: string,
    prompt: string,
    workingDir: string | undefined,
    callbacks: TaskCallbacks,
    taskFolderName?: string,
    agentId?: string,
  ): Promise<void> {
    // Run from AGENTS_CTRLNODE_ROOT so that relative paths in task prompts
    // like "tasks/geminip/05-05/{id}/output/" resolve correctly.
    // providerTasksRoot (tasks/{project}) is kept for GEMINI.md placement and
    // trusted-dir registration so Gemini loads agent context.
    const providerTasksRoot = resolveProjectHome(taskFolderName);
    fs.mkdirSync(providerTasksRoot, { recursive: true });
    const spawnCwd = AGENTS_CTRLNODE_ROOT;
    const timeoutMs = GEMINI_TIMEOUT_MINUTES * 60_000;

    // Per-agent model: use the model registered in the UI if explicitly set.
    // Only pass --model if configured (Gemini ACP may reject unknown flags).
    const agentInfo = agentId ? discoveredAgents[agentId] : undefined;
    const registeredModel = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;
    const effectiveModel = registeredModel ?? undefined;

    // Write GEMINI.md into the task folder with role + instructions so Gemini
    // loads them as project context (same pattern as CLAUDE.md for Claude agents).
    const geminiMdParts: string[] = [];
    if (agentInfo?.role)        geminiMdParts.push(`# Role\n${agentInfo.role}`);
    if (agentInfo?.description) geminiMdParts.push(`# Instructions\n${agentInfo.description}`);
    const geminiMdContent = geminiMdParts.join('\n\n');

    const geminiMdPath = path.join(providerTasksRoot, 'GEMINI.md');
    const wroteGeminiMd = geminiMdContent ? (() => {
      try {
        fs.mkdirSync(providerTasksRoot, { recursive: true });
        fs.writeFileSync(geminiMdPath, geminiMdContent, 'utf8');
        return true;
      }
      catch (e) { logger.warn('gemini_acp.gemini_md_write_failed', { taskId, err: String(e) }); return false; }
    })() : false;

    const isWindows = process.platform === 'win32';
    const acpArgs = ['--acp', '--approval-mode', 'yolo'];
    if (effectiveModel) acpArgs.push('--model', effectiveModel);
    const cmd  = isWindows ? 'cmd.exe' : 'gemini';
    const args = isWindows ? ['/c', 'gemini', ...acpArgs] : acpArgs;

    // Ensure the task folder is in Gemini's trusted directories so that
    // --approval-mode yolo is honoured and project agents are loaded.
    trustGeminiDirectory(providerTasksRoot, taskId);
    trustGeminiDirectory(AGENTS_CTRLNODE_ROOT, taskId);

    logger.info('gemini_acp.spawn', { taskId, cwd: spawnCwd, args: acpArgs, geminiMd: wroteGeminiMd });

    const proc = spawn(cmd, args, {
      cwd: spawnCwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    });

    if (!proc.stdin || !proc.stdout) {
      callbacks.onComplete('failed', 'Failed to start gemini ACP process');
      return;
    }

    // Detect early process exit — if gemini dies before completing, reject
    // immediately instead of hanging the connection forever.
    let procExitCode: number | null = null;
    let earlyExitReject: ((err: Error) => void) | null = null;
    const earlyExitPromise = new Promise<never>((_res, rej) => { earlyExitReject = rej; });
    proc.on('error', (err) => {
      logger.error('gemini_acp.proc_error', { taskId, error: err.message });
      earlyExitReject?.(err);
    });
    proc.on('close', (code) => {
      procExitCode = code;
      logger.info('gemini_acp.proc_close', { taskId, code });
      earlyExitReject?.(new Error(`gemini process exited with code ${code}`));
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      logger.warn('gemini_acp.timeout', { taskId, timeoutMinutes: GEMINI_TIMEOUT_MINUTES });
    }, timeoutMs);

    const output = Writable.toWeb(proc.stdin)  as unknown as WritableStream<Uint8Array>;
    const input  = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    let accumulatedText = '';
    const writtenFiles: string[] = [];

    // acpSandbox: AGENTS_CTRLNODE_ROOT so Gemini can read any file in the shared
    // ctrlnode folder, not just the task subfolder.
    const acpSandbox = path.resolve(AGENTS_CTRLNODE_ROOT);

    // mcpRoot: AGENTS_CTRLNODE_ROOT so the MCP filesystem server exposes the full
    // ctrlnode tree and relative paths like tasks/geminip/05-05/... resolve correctly.
    const mcpRoot = path.resolve(AGENTS_CTRLNODE_ROOT);

    const client: acp.Client = {
      async requestPermission(params) {
        // --approval-mode yolo handles most approvals at CLI level; belt-and-
        // suspenders: also auto-approve at ACP level if an allow option exists.
        const allowOption = params.options?.find(
          (o: any) => o.kind === 'allow_once' || o.kind === 'allow_always',
        );
        if (allowOption) {
          logger.info('gemini_acp.permission_granted', { taskId, tool: params.toolCall?.title, optionId: allowOption.optionId });
          return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
        }
        logger.warn('gemini_acp.permission_cancelled', { taskId, tool: params.toolCall?.title });
        return { outcome: { outcome: 'cancelled' } };
      },

      async sessionUpdate(params) {
        const update = (params as any).update;
        const mapped = mapAcpUpdate(taskId, update);
        if (mapped) {
          callbacks.onStream(mapped);
          if (mapped.kind === 'text_chunk' && mapped.text) {
            accumulatedText += mapped.text;
            callbacks.onMessage(mapped.text);
          }
        }
      },

      // ── ACP filesystem capabilities ───────────────────────────────────────

      async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
        const safePath = resolveSecurePath(params.path, acpSandbox);
        if (!safePath) {
          logger.warn('gemini_acp.write_denied', { taskId, path: params.path, reason: 'outside_sandbox' });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, params.content, 'utf8');
        writtenFiles.push(safePath);
        logger.info('gemini_acp.file_written', { taskId, path: safePath });
        callbacks.onStream({ kind: 'file_written', taskId, path: safePath });
        return {};
      },

      async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        const safePath = resolveSecurePath(params.path, acpSandbox);
        if (!safePath) {
          logger.warn('gemini_acp.read_denied', { taskId, path: params.path, reason: 'outside_sandbox' });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        try {
          const content = fs.readFileSync(safePath, 'utf8');
          logger.info('gemini_acp.file_read', { taskId, path: safePath });
          return { content };
        } catch (err: any) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // File doesn't exist yet — return empty so the agent knows it can write it.
            logger.info('gemini_acp.file_not_found', { taskId, path: safePath });
            return { content: '' };
          }
          throw new Error(`Cannot read file: ${err.message}`);
        }
      },
    };

    try {
      const connection = new acp.ClientSideConnection((_agent) => client, stream);

      // Race all ACP operations against early process exit so we fail fast
      // instead of hanging indefinitely if gemini exits unexpectedly.
      const acpWork = async () => {
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });

        const session = await connection.newSession({
          cwd: spawnCwd,
          mcpServers: [
            {
              name: 'filesystem',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', mcpRoot],
              env: [],
            },
          ],
        });

        // ACP exposes the active model via NewSessionResponse.models.currentModelId
        const sessionModelId: string | undefined = (session as any).models?.currentModelId ?? undefined;

        // Notify SaaS so the agent_task.model column is updated (same as Claude's system/init event).
        const reportedModel = sessionModelId ?? effectiveModel;
        if (reportedModel) {
          callbacks.onModelDiscovered?.(reportedModel);
        }

        // The SaaS prompt already contains ## INSTRUCTIONS with exact file paths.
        // Pass it directly — buildPrompt's output directory hint is redundant and
        // causes Gemini to concatenate the hint directory with the relative paths
        // from the prompt, producing doubled paths.
        const wrappedPrompt = prompt;

        const promptResult = await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: wrappedPrompt }],
        });

        return { promptResult, sessionModelId };
      };

      const acpResult = await Promise.race([acpWork(), earlyExitPromise]);
      const result = (acpResult as any).promptResult ?? acpResult;
      const sessionModelId: string | undefined = (acpResult as any).sessionModelId;
      // Once ACP work is done, nullify the early-exit reject so the close event
      // that fires during cleanup doesn't surface as an error.
      earlyExitReject = null;

      clearTimeout(timeout);

      if (timedOut) {
        callbacks.onComplete('blocked', 'Task timed out');
      } else if ((result as any).stopReason === 'end_turn') {
        writeTaskOutputs(taskId, taskFolderName ?? '', accumulatedText, 'gemini_acp');
        // onMessage called per-chunk during streaming; skip final bulk send.
        const completion = detectStatusTag(accumulatedText);
        // PromptResponse.usage carries token counts (@experimental ACP field)
        const usage = (result as any).usage as {
          inputTokens?: number; outputTokens?: number; totalTokens?: number; thoughtTokens?: number;
        } | null | undefined;
        logger.info('gemini_acp.done', {
          taskId,
          status: completion.status,
          filesWritten: writtenFiles.length,
          model: sessionModelId ?? effectiveModel ?? 'default',
          tokens: usage ? {
            input: usage.inputTokens,
            output: usage.outputTokens,
            total: usage.totalTokens,
            thought: usage.thoughtTokens,
          } : undefined,
        });
        callbacks.onComplete(completion.status, completion.reason);
      } else {
        const reason = `ACP stopReason: ${(result as any).stopReason}`;
        logger.warn('gemini_acp.unexpected_stop', { taskId, reason });
        callbacks.onComplete('failed', reason);
      }
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('gemini_acp.error', { taskId, error: msg });
      callbacks.onComplete('failed', msg);
    } finally {
      proc.stdin.end();
      if (!proc.killed) proc.kill('SIGTERM');
      if (wroteGeminiMd) {
        try { fs.unlinkSync(geminiMdPath); } catch { /* ignore */ }
      }
    }
  }
}

// ── ACP update normalisation ──────────────────────────────────────────────────

function mapAcpUpdate(
  taskId: string,
  update: any,
): { kind: string; text?: string; taskId: string; raw: any } | undefined {
  if (!update || typeof update !== 'object') return undefined;

  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    return { kind: 'text_chunk', text: String(update.content.text ?? ''), taskId, raw: update };
  }

  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_result') {
    return { kind: update.sessionUpdate, taskId, raw: update };
  }

  return undefined;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(userPrompt: string, outputDir: string): string {
  return `You have access to a filesystem MCP tool called \`write_file\` that lets you write files to disk.
Output directory: ${outputDir}

When your task requires producing files (code, reports, data, etc.), use the \`write_file\` MCP tool to write each file to the output directory above.
Use relative paths (e.g. \`output/result.md\`) or absolute paths inside the output directory.

When you have finished all work, end your response with one of these tags on its own line:
<TASK_COMPLETED:done>
<TASK_BLOCKED:reason>
<TASK_FAILED:reason>

--- TASK ---
${userPrompt}`;
}

// ── Output file writers / status detection → providerFileUtils.ts ────────────

/**
 * Ensure `dir` (and AGENTS_CTRLNODE_ROOT) appear in ~/.gemini/trustedFolders.json
 * with value "TRUST_FOLDER", and that security.folderTrust.enabled is set in
 * ~/.gemini/settings.json — so Gemini CLI honours --approval-mode yolo and loads
 * GEMINI.md / project agents from the task folder.
 *
 * Gemini CLI uses lowercase forward-slash paths as keys in trustedFolders.json.
 * The trustedDirectories key in settings.json is NOT the correct mechanism.
 */
function trustGeminiDirectory(dir: string, taskId: string): void {
  const geminiDir   = path.join(os.homedir(), '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');
  const trustPath   = path.join(geminiDir, 'trustedFolders.json');

  // Normalize to lowercase forward-slash format (how Gemini CLI stores them).
  const normalizeTrustKey = (p: string) =>
    path.resolve(p).replace(/\\/g, '/').toLowerCase();

  try {
    fs.mkdirSync(geminiDir, { recursive: true });

    // 1. Ensure folderTrust is enabled in settings.json
    let settings: Record<string, any> = {};
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* keep empty */ }
    }
    const folderTrustEnabled = settings?.security?.folderTrust?.enabled === true;
    if (!folderTrustEnabled) {
      settings.security ??= {};
      settings.security.folderTrust ??= {};
      settings.security.folderTrust.enabled = true;
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
      logger.info('gemini_acp.folder_trust_enabled', { taskId });
    }

    // 2. Write trusted folder entries to trustedFolders.json
    let trusted: Record<string, string> = {};
    if (fs.existsSync(trustPath)) {
      try { trusted = JSON.parse(fs.readFileSync(trustPath, 'utf8')); } catch { /* keep empty */ }
    }

    const toTrust = [path.resolve(dir), path.resolve(AGENTS_CTRLNODE_ROOT)];
    const added: string[] = [];
    for (const d of toTrust) {
      const key = normalizeTrustKey(d);
      if (trusted[key] !== 'TRUST_FOLDER') {
        trusted[key] = 'TRUST_FOLDER';
        added.push(key);
      }
    }

    if (added.length > 0) {
      fs.writeFileSync(trustPath, JSON.stringify(trusted, null, 2), 'utf8');
      logger.info('gemini_acp.trusted_dirs_added', { taskId, added });
    }
  } catch (e) {
    logger.warn('gemini_acp.trusted_dirs_write_failed', { taskId, err: String(e) });
  }
}

// ── Security: sandbox path resolution ────────────────────────────────────────

function resolveSecurePath(filePath: string, sandboxRoot: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(sandboxRoot, filePath);
  const normalRoot = path.resolve(sandboxRoot);
  return resolved.startsWith(normalRoot + path.sep) || resolved === normalRoot
    ? resolved
    : null;
}
