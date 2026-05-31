/**
 * @file HermesAcpProvider.ts
 * @description Hermes via `hermes acp` (Agent Client Protocol). Primary path for dispatch_task.
 * Falls back to {@link HermesProvider} (`hermes chat -Q -q`) when ACP is unavailable or
 * `HERMES_USE_ACP=false`.
 *
 * Install: pip install "hermes-agent[acp]"
 * @see https://hermes-agent.nousresearch.com/docs/user-guide/features/acp
 */
import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import {
  CTRLNODE_ROOT,
  HERMES_HOME,
  HERMES_TIMEOUT_MINUTES,
} from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { detectStatusTag, writeTaskOutputs } from './providerFileUtils.js';
import { mapAcpUpdate, formatAcpToolCallActivity } from './acpUpdateMapper.js';
import { HermesProvider } from './HermesProvider.js';
import { augmentPromptForRepoMode, resolveRepoDispatchSpawn } from './repoDispatchContext.js';
import {
  getHermesAgentHome,
  setupHermesAgentHome,
  readHermesAgentsMd,
  readHermesAgentMeta,
} from '../hermesAgentHome.js';
import { getHermesProfileHome, ensureHermesProfile } from '../hermesProfile.js';
import {
  detectHermesCopilotApiFailure,
  detectHermesBlockableError,
  hermesAcpModelSetSkipReason,
  isHermesBlockableError,
  listHermesModels,
  normalizeHermesModelId,
  shouldSkipHermesAcpSessionModelSet,
} from '../hermesModelUtils.js';
import {
  createHermesAcpModelTracker,
  hermesModelsMismatch,
  markModelSetApplied,
  observeSessionUpdateForModel,
  resolveHermesRuntimeModel,
  seedTrackerFromSession,
} from '../hermesAcpModelTracking.js';

export class HermesAcpProvider implements IProvider {
  readonly providerName = 'hermes';

  private readonly cliFallback = new HermesProvider();
  private acpAvailable: boolean | null = null;

  async discoverAgents(): Promise<AgentSummary[]> {
    return [];
  }

  private async useAcp(): Promise<boolean> {
    const forcedCli =
      process.env.HERMES_USE_ACP === 'false' || process.env.HERMES_USE_ACP === '0';
    if (forcedCli) return false;

    if (this.acpAvailable !== null) return this.acpAvailable;

    const { checkBinaryExists, checkHermesAcpAvailable } = await import('./providerHealthUtils.js');
    const hasBinary = await checkBinaryExists('hermes');
    this.acpAvailable = hasBinary && (await checkHermesAcpAvailable());
    if (!this.acpAvailable) {
      logger.info('hermes_acp.unavailable', { fallback: 'hermes chat CLI' });
    }
    return this.acpAvailable!;
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    if (!(await this.useAcp())) {
      return this.cliFallback.dispatchTask(params, callbacks);
    }
    const dispatch = resolveRepoDispatchSpawn(params, CTRLNODE_ROOT);
    const promptText = augmentPromptForRepoMode(resolveTaskPrompt(params), params);
    logger.info('hermes_acp.repo_mode', {
      taskId: params.taskId,
      isRepoMode: dispatch.isRepoMode,
      cwd: dispatch.spawnCwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });
    await this._runAcp(
      params.taskId,
      promptText,
      callbacks,
      params.taskFolderName,
      params.agentId,
      dispatch.spawnCwd,
      dispatch.isRepoMode,
    );
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    if (!(await this.useAcp())) {
      return this.cliFallback.sendToSession(params, callbacks);
    }
    await this._runAcp(
      params.taskId,
      params.message,
      callbacks,
      undefined,
      params.agentId,
    );
  }

  async invokeTool(_msg: unknown, sendToSaas: (payload: unknown) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {
    await this.cliFallback.dispose();
  }

  async deleteAgent(_agentId: string): Promise<boolean> {
    return false;
  }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    return CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, _useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return CTRLNODE_ROOT;
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    return null;
  }

  async listModels(): Promise<string[]> {
    return listHermesModels();
  }

  async isAvailable(): Promise<boolean> {
    const { checkBinaryExists } = await import('./providerHealthUtils.js');
    return checkBinaryExists('hermes');
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _runAcp(
    taskId: string,
    prompt: string,
    callbacks: TaskCallbacks,
    taskFolderName?: string,
    agentId?: string,
    spawnCwdOverride?: string,
    isRepoMode = false,
  ): Promise<void> {
    const taskFolder = taskFolderName
      ? path.join(CTRLNODE_ROOT, taskFolderName)
      : CTRLNODE_ROOT;
    const taskOutputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(taskOutputFolder, { recursive: true });

    const agentInfo = agentId ? discoveredAgents[agentId] : undefined;
    if (agentInfo?.model) callbacks.onModelDiscovered?.(agentInfo.model);

    const agentHome = agentId ? getHermesAgentHome(agentId) : CTRLNODE_ROOT;
    if (agentId && agentInfo) {
      setupHermesAgentHome(agentId, {
        name: agentInfo.name,
        role: agentInfo.role,
        description: agentInfo.description,
        model: agentInfo.model,
      });
    }
    const sessionCwd = isRepoMode && spawnCwdOverride
      ? spawnCwdOverride
      : (agentId ? agentHome : CTRLNODE_ROOT);
    const hasAgentsMd = agentId ? !!readHermesAgentsMd(agentId) : false;
    const uiMeta = agentId ? readHermesAgentMeta(agentId) : null;
    const timeoutMs = HERMES_TIMEOUT_MINUTES * 60_000;

    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'cmd.exe' : 'hermes';
    const args = isWindows ? ['/c', 'hermes', 'acp'] : ['acp'];

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agentId && agentInfo) {
      // Ensure the profile exists (idempotent) then point HERMES_HOME at it for this spawn.
      ensureHermesProfile(agentId, {
        name: agentInfo.name,
        role: agentInfo.role,
        description: agentInfo.description,
        model: agentInfo.model,
      });
      env['HERMES_HOME'] = getHermesProfileHome(agentId);
    } else if (agentId) {
      // Agent registered but not yet in discoveredAgents — still set profile home.
      env['HERMES_HOME'] = getHermesProfileHome(agentId);
      logger.warn('hermes_acp.profile_home_no_agent_info', { taskId, agentId });
    } else if (HERMES_HOME) {
      env['HERMES_HOME'] = HERMES_HOME;
    }

    logger.info('hermes_acp.agent_home', {
      taskId,
      agentHome: sessionCwd,
      profileHome: agentId ? getHermesProfileHome(agentId) : null,
      hasAgentsMd,
      agentId: agentId ?? null,
      uiModel: uiMeta?.model ?? agentInfo?.model ?? null,
    });

    const proc = spawn(cmd, args, {
      cwd: sessionCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    if (!proc.stdin || !proc.stdout) {
      callbacks.onComplete('failed', 'Failed to start hermes ACP process');
      return;
    }

    let procExitCode: number | null = null;
    let earlyExitReject: ((err: Error) => void) | null = null;
    const earlyExitPromise = new Promise<never>((_res, rej) => {
      earlyExitReject = rej;
    });
    proc.on('error', (err) => {
      logger.error('hermes_acp.proc_error', { taskId, error: err.message });
      earlyExitReject?.(err);
    });
    let stderrText = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });
    proc.on('close', (code) => {
      procExitCode = code;
      logger.debug('hermes_acp.proc_close', { taskId, code });
      earlyExitReject?.(new Error(`hermes process exited with code ${code}`));
    });

    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      logger.warn('hermes_acp.timeout', { taskId, timeoutMinutes: HERMES_TIMEOUT_MINUTES });
    }, timeoutMs);

    const output = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
    const input = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    let accumulatedText = '';
    /** Full transcript for agent_log.md (tools + chunks), not only the final reply. */
    let accumulatedActivityText = '';
    const writtenFiles: string[] = [];
    const acpSandbox = path.resolve(CTRLNODE_ROOT);
    const mcpRoot = path.resolve(CTRLNODE_ROOT);

    const appendActivity = (text: string) => {
      if (!text) return;
      if (accumulatedActivityText.endsWith(text)) return;
      accumulatedActivityText += text;
      callbacks.onMessage(text);
    };

    const desiredModel = normalizeHermesModelId(uiMeta?.model ?? agentInfo?.model);
    const modelTracker = createHermesAcpModelTracker(desiredModel);

    const client: acp.Client = {
      async requestPermission(params) {
        const allowOption = params.options?.find(
          (o: { kind?: string }) => o.kind === 'allow_once' || o.kind === 'allow_always' || o.kind === 'allow_session',
        );
        if (allowOption) {
          logger.debug('hermes_acp.permission_granted', {
            taskId,
            tool: params.toolCall?.title,
            optionId: allowOption.optionId,
          });
          return { outcome: { outcome: 'selected', optionId: allowOption.optionId } };
        }
        logger.warn('hermes_acp.permission_cancelled', { taskId, tool: params.toolCall?.title });
        return { outcome: { outcome: 'cancelled' } };
      },

      async sessionUpdate(params) {
        const update = (params as { update?: unknown }).update;
        observeSessionUpdateForModel(modelTracker, update);
        const mapped = mapAcpUpdate(taskId, update);
        if (!mapped) return;

        callbacks.onStream(mapped);
        if (mapped.kind === 'text_chunk' && mapped.text) {
          accumulatedText += mapped.text;
          appendActivity(mapped.text);
        } else if (mapped.kind === 'thinking' && mapped.text) {
          appendActivity(mapped.text);
        } else if (mapped.kind === 'tool_call' && update && typeof update === 'object') {
          appendActivity(formatAcpToolCallActivity(update as Record<string, unknown>));
        } else if (mapped.kind === 'tool_result' && update && typeof update === 'object') {
          const u = update as Record<string, unknown>;
          const status = u.status ?? 'done';
          appendActivity(`✓ tool ${String(status)}\n`);
        }
      },

      async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
        const safePath = resolveSecurePath(params.path, acpSandbox);
        if (!safePath) {
          logger.warn('hermes_acp.write_denied', { taskId, path: params.path });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        fs.mkdirSync(path.dirname(safePath), { recursive: true });
        fs.writeFileSync(safePath, params.content, 'utf8');
        writtenFiles.push(safePath);
        logger.debug('hermes_acp.file_written', { taskId, path: safePath });
        appendActivity(`→ write: ${safePath}\n`);
        callbacks.onStream({ kind: 'file_written', taskId, path: safePath });
        return {};
      },

      async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
        const safePath = resolveSecurePath(params.path, acpSandbox);
        if (!safePath) {
          logger.warn('hermes_acp.read_denied', { taskId, path: params.path });
          throw new Error(`Path outside allowed sandbox: ${params.path}`);
        }
        try {
          const content = fs.readFileSync(safePath, 'utf8');
          logger.debug('hermes_acp.file_read', { taskId, path: safePath });
          return { content };
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            return { content: '' };
          }
          throw new Error(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    };

    try {
      const connection = new acp.ClientSideConnection((_agent) => client, stream);

      const acpWork = async () => {
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
          },
        });

        const session = await connection.newSession({
          cwd: sessionCwd,
          mcpServers: [
            {
              name: 'filesystem',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', mcpRoot],
              env: [],
            },
          ],
        });

        seedTrackerFromSession(modelTracker, session);
        const sessionInitialModel = modelTracker.initialSessionModel;

        if (
          desiredModel &&
          !shouldSkipHermesAcpSessionModelSet(desiredModel, sessionInitialModel)
        ) {
          try {
            await connection.unstable_setSessionModel({
              sessionId: session.sessionId,
              modelId: desiredModel,
            });
            markModelSetApplied(modelTracker, desiredModel);
            logger.info('hermes_acp.model_set', { taskId, agentId: agentId ?? null, modelId: desiredModel });
          } catch (err) {
            logger.warn('hermes_acp.model_set_failed', {
              taskId,
              modelId: desiredModel,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (desiredModel && shouldSkipHermesAcpSessionModelSet(desiredModel, sessionInitialModel)) {
          logger.info('hermes_acp.model_set_skipped', {
            taskId,
            agentId: agentId ?? null,
            modelId: desiredModel,
            sessionInitialModel: sessionInitialModel ?? null,
            reason: hermesAcpModelSetSkipReason(desiredModel, sessionInitialModel),
          });
        }

        const prePromptModel = resolveHermesRuntimeModel(modelTracker);
        if (prePromptModel) callbacks.onModelDiscovered?.(prePromptModel);

        const wrappedPrompt = buildHermesPrompt(prompt, taskOutputFolder);

        const promptResult = await connection.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: wrappedPrompt }],
        });

        return { promptResult };
      };

      const acpResult = await Promise.race([acpWork(), earlyExitPromise]);
      const result = (acpResult as { promptResult?: unknown }).promptResult ?? acpResult;
      const runtimeModel = resolveHermesRuntimeModel(modelTracker, result);
      if (runtimeModel) {
        callbacks.onModelDiscovered?.(runtimeModel);
      }
      if (hermesModelsMismatch(desiredModel, runtimeModel)) {
        logger.warn('hermes_acp.model_mismatch', {
          taskId,
          agentId: agentId ?? null,
          configuredModel: desiredModel,
          runtimeModel,
          initialSessionModel: modelTracker.initialSessionModel ?? null,
        });
      }
      earlyExitReject = null;

      clearTimeout(timeout);

      if (timedOut) {
        callbacks.onComplete('blocked', 'Task timed out');
      } else if ((result as { stopReason?: string }).stopReason === 'end_turn') {
        if (taskFolderName) {
          writeTaskOutputs(
            taskId,
            taskFolderName,
            accumulatedText,
            'hermes_acp',
            accumulatedActivityText,
          );
        }
        const apiFailure = detectHermesCopilotApiFailure(accumulatedText);
        if (apiFailure) {
          logger.warn('hermes_acp.copilot_api_failure', { taskId, error: apiFailure });
          callbacks.onComplete('failed', apiFailure);
          return;
        }
        const blockableError = detectHermesBlockableError(accumulatedText)
          ?? detectHermesBlockableError(accumulatedActivityText)
          ?? detectHermesBlockableError(stderrText);
        if (blockableError) {
          logger.warn('hermes_acp.blockable_error', { taskId, error: blockableError });
          callbacks.onComplete('blocked', blockableError);
          return;
        }
        const completion = detectStatusTag(accumulatedText);
        const usage = (result as { usage?: Record<string, number> }).usage;
        logger.info('hermes_acp.done', {
          taskId,
          status: completion.status,
          filesWritten: writtenFiles.length,
          model: runtimeModel ?? agentInfo?.model ?? 'default',
          configuredModel: desiredModel ?? null,
          exitCode: procExitCode,
          tokens: usage
            ? {
                input: usage.inputTokens,
                output: usage.outputTokens,
                total: usage.totalTokens,
              }
            : undefined,
        });
        callbacks.onComplete(completion.status, completion.reason);
      } else {
        const reason = `ACP stopReason: ${(result as { stopReason?: string }).stopReason}`;
        logger.warn('hermes_acp.unexpected_stop', { taskId, reason });
        callbacks.onComplete('failed', reason);
      }
    } catch (err) {
      clearTimeout(timeout);
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('hermes_acp.error', { taskId, error: msg });
      const status = isHermesBlockableError(msg) ? 'blocked' : 'failed';
      callbacks.onComplete(status, msg);
    } finally {
      proc.stdin.end();
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }
}

function resolveTaskPrompt(params: DispatchTaskParams): string {
  const taskFolder = params.taskFolderName
    ? path.join(CTRLNODE_ROOT, params.taskFolderName)
    : path.join(CTRLNODE_ROOT, 'tasks', params.taskId || `task-${Date.now()}`);

  const inputDir = path.join(taskFolder, 'input');
  if (fs.existsSync(inputDir)) {
    const inputFiles = fs.readdirSync(inputDir).filter((f) => f.endsWith('.md'));
    if (inputFiles.length > 0) {
      return fs.readFileSync(path.join(inputDir, inputFiles[0]), 'utf8');
    }
  }
  return params.prompt;
}

function buildHermesPrompt(userPrompt: string, outputDir: string): string {
  return `You have access to filesystem tools (MCP and ACP) to read and write files under the workspace.
When producing deliverables, write files under this output directory:
${outputDir}

When you have finished all work, end your response with one of these tags on its own line:
<TASK_COMPLETED:done>
<TASK_BLOCKED:reason>
<TASK_FAILED:reason>

--- TASK ---
${userPrompt}`;
}

function resolveSecurePath(filePath: string, sandboxRoot: string): string | null {
  const resolved = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(sandboxRoot, filePath);
  const normalRoot = path.resolve(sandboxRoot);
  return resolved.startsWith(normalRoot + path.sep) || resolved === normalRoot ? resolved : null;
}
