import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider';
import { AgentSummary } from '../types';
import {
  COPILOT_TIMEOUT_MINUTES,
  AGENTS_CTRLNODE_ROOT,
  resolveProjectHome,
} from '../config';
import { discoveredAgents } from '../agentDiscovery';
import { logger } from '../logger';
import { detectStatusTag, writeOutputFile, writeAgentLog } from './providerFileUtils';

export class CopilotAcpProvider implements IProvider {
  readonly providerName = 'copilot';

  async discoverAgents(): Promise<AgentSummary[]> {
    // Copilot agents are registered exclusively via sync_copilot_agents (pushed
    // from the SaaS after the user registers them). Returning a static fallback
    // here causes a phantom UNREGISTERED card in the UI for anyone running the
    // Bridge before any agent has been registered. discoveredAgents already
    // holds the synced entries and buildAgentSummaries() will include them.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const agentInfo = discoveredAgents[params.agentId];
    const effectivePrompt = agentInfo?.description
      ? `${agentInfo.description}\n\n---\n\n${params.prompt}`
      : params.prompt;
    await this._runAcp(params.taskId, effectivePrompt, callbacks, params.taskFolderName);
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    // ACP does not support persistent sessions yet — open a new session each time.
    const agentInfo = discoveredAgents[params.agentId];
    const effectivePrompt = agentInfo?.description
      ? `${agentInfo.description}\n\n---\n\n${params.message}`
      : params.message;
    await this._runAcp(params.taskId, effectivePrompt, callbacks);
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
    // Copilot ACP does not support SaaS-initiated workspace creation.
    return null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _runAcp(
    taskId: string,
    prompt: string,
    callbacks: TaskCallbacks,
    taskFolderName?: string,
  ): Promise<void> {
    // Run from the project-level home (tasks/{project}) so Copilot has full project
    // context as its working directory. workspace_path is an OpenClaw concept and
    // does not apply here.
    const providerTasksRoot = resolveProjectHome(taskFolderName);
    fs.mkdirSync(providerTasksRoot, { recursive: true });

    // Derive the task-specific output folder so the prompt tells Copilot exactly
    // where to write files (avoids the doubled-segment bug where Copilot appended
    // the full taskFolderName onto providerTasksRoot a second time).
    const taskFolder = taskFolderName
      ? path.join(AGENTS_CTRLNODE_ROOT, taskFolderName)
      : providerTasksRoot;
    const taskOutputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(taskOutputFolder, { recursive: true });
    const timeoutMs = COPILOT_TIMEOUT_MINUTES * 60_000;

    const isWindows = process.platform === 'win32';
    const cmd  = isWindows ? 'cmd.exe' : 'copilot';
    const args = isWindows ? ['/c', 'copilot', '--acp', '--stdio'] : ['--acp', '--stdio'];

    logger.info('copilot_acp.spawn', { taskId, cwd: providerTasksRoot });

    const proc = spawn(cmd, args, {
      cwd: providerTasksRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false,
    });

    if (!proc.stdin || !proc.stdout) {
      callbacks.onComplete('failed', 'Failed to start copilot ACP process');
      return;
    }

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      logger.warn('copilot_acp.timeout', { taskId, timeoutMinutes: COPILOT_TIMEOUT_MINUTES });
    }, timeoutMs);

    const output = Writable.toWeb(proc.stdin)  as unknown as WritableStream<Uint8Array>;
    const input  = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    let accumulatedText = '';
    const writtenFiles: string[] = [];

    // fsRoot: sandbox root for path resolution — scoped to providerTasksRoot so the
    // agent can read project-level context files as well as write to the task folder.
    const fsRoot = path.resolve(providerTasksRoot);

    const client: acp.Client = {
      async requestPermission(params) {
        // Auto-approve the first allow_once or allow_always option so Copilot
        // can execute tool calls (file writes, reads, etc.) without blocking.
        const allowOption = params.options?.find(
          (o: any) => o.kind === 'allow_once' || o.kind === 'allow_always',
        );
        if (allowOption) {
          logger.info('copilot_acp.permission_granted', { taskId, tool: params.toolCall?.title, optionId: allowOption.optionId });
          return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
        }
        // No allow option available — cancel to avoid hanging.
        logger.warn('copilot_acp.permission_cancelled', { taskId, tool: params.toolCall?.title });
        return { outcome: { outcome: 'cancelled' } };
      },

      async sessionUpdate(params) {
        const update = (params as any).update;
        const mapped = mapAcpUpdate(taskId, update);
        if (mapped) {
          callbacks.onStream(mapped);
          // Stream each text chunk to the Activity panel in real time.
          if (mapped.kind === 'text_chunk' && mapped.text) {
            accumulatedText += mapped.text;
            callbacks.onMessage(mapped.text);
          }
        }
      },

      // ── ACP filesystem capabilities ───────────────────────────────────────

      async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
        const safePath = resolveSecurePath(params.path, fsRoot);
        if (!safePath) {
          logger.warn('copilot_acp.write_denied', { taskId, path: params.path, reason: 'outside_sandbox' });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, params.content, 'utf8');
        writtenFiles.push(safePath);
        logger.info('copilot_acp.file_written', { taskId, path: safePath });
        callbacks.onStream({ kind: 'file_written', taskId, path: safePath });
        return {};
      },

      async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        const safePath = resolveSecurePath(params.path, fsRoot);
        if (!safePath) {
          logger.warn('copilot_acp.read_denied', { taskId, path: params.path, reason: 'outside_sandbox' });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        try {
          const content = fs.readFileSync(safePath, 'utf8');
          logger.info('copilot_acp.file_read', { taskId, path: safePath });
          return { content };
        } catch (err: any) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            // File doesn't exist yet — return empty so the agent knows it can write it.
            logger.info('copilot_acp.file_not_found', { taskId, path: safePath });
            return { content: '' };
          }
          throw new Error(`Cannot read file: ${err.message}`);
        }
      },
    };

    try {
      const connection = new acp.ClientSideConnection((_agent) => client, stream);

      await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      const session = await connection.newSession({
        cwd: providerTasksRoot,
        mcpServers: [
          {
            name: 'filesystem',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', fsRoot],
            env: [],
          },
        ],
      });

      // Wrap the user prompt with filesystem instructions so Copilot knows
      // which MCP tool to call when it needs to write output files.
      // Pass the task-specific output folder so Copilot writes to the correct location.
      const wrappedPrompt = buildPrompt(prompt, taskOutputFolder);

      const result = await connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: wrappedPrompt }],
      });

      clearTimeout(timeout);

      if (timedOut) {
        callbacks.onComplete('blocked', 'Task timed out');
      } else if ((result as any).stopReason === 'end_turn') {
        // If neither the ACP writeTextFile handler nor the MCP server-filesystem
        // tool produced the expected output file, fall back to writing the
        // accumulated chat response.  We check the actual file on disk so that
        // files written by the MCP npx server (which bypass writtenFiles tracking)
        // are also detected.
        const expectedOutFile = taskFolderName
          ? path.join(taskFolder, 'output', `${path.basename(taskFolderName)}-output.md`)
          : null;
        const outputAlreadyExists = expectedOutFile ? fs.existsSync(expectedOutFile) : false;
        if (!outputAlreadyExists && taskFolderName && accumulatedText.trim()) {
          writeOutputFile(taskId, taskFolder, path.basename(taskFolderName), accumulatedText, 'copilot_acp');
        }
        // Always write the full agent log so the conversation is persisted.
        if (taskFolderName && accumulatedText.trim()) {
          writeAgentLog(taskId, taskFolder, accumulatedText, 'copilot_acp');
        }
        // onMessage is called per-chunk during streaming; skip final bulk send to avoid duplicates.
        const completion = detectStatusTag(accumulatedText);
        logger.info('copilot_acp.done', { taskId, status: completion.status, filesWritten: writtenFiles.length });
        callbacks.onComplete(completion.status, completion.reason);
      } else {
        const reason = `ACP stopReason: ${(result as any).stopReason}`;
        logger.warn('copilot_acp.unexpected_stop', { taskId, reason });
        callbacks.onComplete('failed', reason);
      }
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('copilot_acp.error', { taskId, error: msg });
      callbacks.onComplete('failed', msg);
    } finally {
      proc.stdin.end();
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }
}

// ── ACP update normalisation ─────────────────────────────────────────────────

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

/**
 * Wraps the raw task prompt with filesystem instructions so Copilot uses the
 * MCP `write_file` tool (from @modelcontextprotocol/server-filesystem) to
 * persist output files instead of only printing them in the chat response.
 */
function buildPrompt(userPrompt: string, outputDir: string): string {
  return `You have access to a filesystem MCP tool called \`write_file\` that lets you write files to disk.
Output directory: ${outputDir}

When your task requires producing files (code, reports, data, etc.), use the \`write_file\` MCP tool to write each file to the output directory above.
Always use the exact absolute path shown above (or a file name directly inside it, e.g. \`${outputDir}/result.md\`). Do NOT construct sub-paths by appending folder segments to this directory; write directly into it.

When you have finished all work, end your response with one of these tags on its own line:
<TASK_COMPLETED:done>
<TASK_BLOCKED:reason>
<TASK_FAILED:reason>

--- TASK ---
${userPrompt}`;
}

// ── Security: sandbox path resolution ────────────────────────────────────────

/**
 * Resolves `filePath` and ensures it stays within `sandboxRoot`.
 * Returns the resolved absolute path, or null if it would escape the sandbox.
 */
function resolveSecurePath(filePath: string, sandboxRoot: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(sandboxRoot, filePath);
  const normalRoot = path.resolve(sandboxRoot);
  return resolved.startsWith(normalRoot + path.sep) || resolved === normalRoot
    ? resolved
    : null;
}
