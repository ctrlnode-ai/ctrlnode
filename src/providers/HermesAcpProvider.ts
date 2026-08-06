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
import fs from 'fs';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import {
  CTRLNODE_ROOT,
  HERMES_HOME,
  TASK_TIMEOUT_MINUTES,
} from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { detectStatusTag, writeTaskOutputs, createInactivityTimer, resolveSecurePath } from './providerFileUtils.js';
import { mapAcpUpdate, formatAcpToolCallActivity } from './acpUpdateMapper.js';
import { HermesProvider } from './HermesProvider.js';
import { augmentPromptForRepoMode, resolveRepoDispatchSpawn } from './repoDispatchContext.js';
import { buildAcpSpawnCommand, createProcEarlyExit, createAcpStream, initAcpConnection, runAcpStructuredPlan } from './acpCommon.js';
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

  private readonly _activeRuns = new Map<string, import('child_process').ChildProcess>();
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

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    if (!(await this.useAcp())) {
      // The CLI fallback (`hermes chat -Q -q`) has no equivalent to a bounded,
      // read-only single-turn call — it is a stateful chat REPL, not a completion API.
      throw new Error('GRAPH_GENERATION_UNSUPPORTED_PROVIDER');
    }

    const { cmd, args } = buildAcpSpawnCommand('hermes', ['acp']);
    const cwd = fs.existsSync(params.workingDir) ? params.workingDir : CTRLNODE_ROOT;
    const agentInfo = discoveredAgents[params.agentId];
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agentInfo) {
      ensureHermesProfile(params.agentId, {
        name: agentInfo.name,
        role: agentInfo.role,
        description: agentInfo.description,
        model: agentInfo.model,
      });
      env['HERMES_HOME'] = getHermesProfileHome(params.agentId);
    } else if (HERMES_HOME) {
      env['HERMES_HOME'] = HERMES_HOME;
    }

    logger.info('hermes_acp.graph_generation_start', { agentId: params.agentId, cwd });
    try {
      const result = await runAcpStructuredPlan({
        providerLog: 'hermes_acp',
        cmd,
        args,
        cwd,
        env,
        prompt: params.prompt,
        timeoutMs: params.timeoutMs,
      });
      logger.info('hermes_acp.graph_generation_completed', { agentId: params.agentId, responseLength: result.length });
      return result;
    } catch (error: any) {
      logger.warn('hermes_acp.graph_generation_failed', { agentId: params.agentId, error: error?.message });
      throw error;
    }
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
    const timeoutMs = TASK_TIMEOUT_MINUTES * 60_000;

    const { cmd, args } = buildAcpSpawnCommand('hermes', ['acp']);

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

    this._activeRuns.set(taskId, proc);

    if (!proc.stdin || !proc.stdout) {
      callbacks.onComplete('failed', 'Failed to start hermes ACP process');
      return;
    }

    const earlyExit = createProcEarlyExit(proc, 'hermes_acp', taskId);
    let stderrText = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString();
    });

    const timer = createInactivityTimer(timeoutMs, () => {
      proc.kill('SIGTERM');
      logger.warn('hermes_acp.timeout', { taskId, timeoutMinutes: TASK_TIMEOUT_MINUTES });
    });

    const stream = createAcpStream(proc);

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
        callbacks.onWaitingForInput?.(params.toolCall?.title);
        return { outcome: { outcome: 'cancelled' } };
      },

      async sessionUpdate(params) {
        timer.reset();
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
      const acpWork = async () => {
        const connection = await initAcpConnection(stream, client);

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

      const acpResult = await Promise.race([acpWork(), earlyExit.promise]);
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
      earlyExit.clearReject();

      timer.clear();

      if (timer.fired) {
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
          exitCode: earlyExit.exitCode,
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
      timer.clear();
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('hermes_acp.error', { taskId, error: msg });
      const status = isHermesBlockableError(msg) ? 'blocked' : 'failed';
      callbacks.onComplete(status, msg);
    } finally {
      this._activeRuns.delete(taskId);
      proc.stdin.end();
      if (!proc.killed) proc.kill('SIGTERM');
    }
  }

  async cancelRun(taskId: string): Promise<void> {
    const proc = this._activeRuns.get(taskId);
    if (!proc) return;
    logger.info('hermes_acp_provider.cancel', { taskId });
    if (!proc.killed) proc.kill('SIGTERM');
    this._activeRuns.delete(taskId);
  }

  deliverInput = async (taskId: string, _text: string): Promise<void> => {
    logger.warn('deliverInput not yet supported for ACP interaction', { taskId, provider: this.providerName });
  };
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

