/**
 * CodexSdkProvider — IProvider implementation using @openai/codex-sdk.
 *
 * The SDK wraps `codex app-server` internally over stdio JSON-RPC.
 * Equivalent to the Gemini/Copilot ACP providers but uses the Codex SDK
 * instead of the ACP protocol.
 *
 * Auth: CODEX_API_KEY env var (or ChatGPT OAuth session from `~/.codex/`).
 */
import { Codex } from '@openai/codex-sdk';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import {
  TASK_TIMEOUT_MINUTES,
  CTRLNODE_ROOT,
  resolveProjectHome,
} from '../config.js';
import { logger } from '../logger.js';
import {
  augmentPromptForRepoMode,
  resolveRepoDispatchSpawn,
  resolveTaskPaths,
  type RepoDispatchSpawnContext,
} from './repoDispatchContext.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { getCodexAgentHome, syncCodexAuthToAgentHome } from '../codexAgentHome.js';
import { setAgentRunning } from '../websocket.js';
import { detectStatusTag, writeTaskOutputs, fetchOpenAiCompatibleModels, createInactivityTimer } from './providerFileUtils.js';
import { readCodexSubscriptionModels, resolveModelsWithSubscriptionFirst } from '../subscriptionModelResolution.js';

/** Resolve `codex` binary from the system PATH (fallback when CODEX_BIN_PATH is not set). */
export function chooseCodexExecutable(candidates: string[], platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') return candidates.find(c => c.toLowerCase().endsWith('.exe'));
  return candidates[0] ?? undefined;
}

/**
 * Resolve a Codex executable from a PATH lookup, optionally preserving a
 * previously resolved path. The Bridge may run provider health checks after a
 * child process changes its inherited PATH; a transient lookup failure must
 * not turn an already-installed provider into "not installed".
 */
export function resolveCodexExecutableFromLookup(
  lookup: () => string[],
  platform: NodeJS.Platform = process.platform,
  cachedPath?: string,
): string | undefined {
  return cachedPath ?? chooseCodexExecutable(lookup(), platform);
}

let resolvedCodexExecutable: string | undefined;

function resolveCodexFromPath(): string | undefined {
  if (resolvedCodexExecutable) return resolvedCodexExecutable;

  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, ['codex'], { encoding: 'utf8', timeout: 3000 });
  if (result.status !== 0) return undefined;
  const candidates = result.stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
  resolvedCodexExecutable = resolveCodexExecutableFromLookup(() => candidates);
  return resolvedCodexExecutable;
}

/** Fetch available model IDs from the OpenAI API using CODEX_API_KEY or OPENAI_API_KEY. */
async function fetchOpenAiModels(): Promise<string[]> {
  const apiKey = process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY;
  return fetchOpenAiCompatibleModels(apiKey ?? '');
}

const GRAPH_BLUEPRINT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'topology', 'templateFamily', 'schedule', 'nodes'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    topology: { type: 'string', enum: ['single', 'linear', 'fan_out_fan_in', 'dag'] },
    templateFamily: { type: 'string', enum: ['blank', 'research_report', 'linear', 'parallel', 'custom'] },
    schedule: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['manual', 'hourly', 'daily', 'weekdays', 'weekly', 'custom'] },
        time: { type: 'string' },
        days: { type: 'array', items: { type: 'integer' } },
        hours: { type: 'array', items: { type: 'integer' } },
        timezone: { type: 'string' },
        cron: { type: 'string' },
      },
    },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'label', 'instructions', 'taskMode', 'focusFiles', 'outputFolder', 'dependsOn'],
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          instructions: { type: 'string' },
          taskMode: { type: 'string', enum: ['output', 'repo'] },
          focusFiles: { type: 'array', items: { type: 'string' } },
          outputFolder: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export class CodexSdkProvider implements IProvider {
  readonly providerName = 'codex';
  private readonly _cancelFlags = new Map<string, boolean>();

  async discoverAgents(): Promise<AgentSummary[]> {
    // Codex agents are registered exclusively via sync_codex_agents (pushed
    // from the SaaS after the user registers them). Returning a static fallback
    // here causes a phantom UNREGISTERED card in the UI for anyone running the
    // Bridge before any agent has been registered. discoveredAgents already
    // holds the synced entries and buildAgentSummaries() will include them.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const agentInfo = discoveredAgents[params.agentId];
    const dispatch = resolveRepoDispatchSpawn(params, CTRLNODE_ROOT);
    const prompt = augmentPromptForRepoMode(params.prompt, params);
    logger.info('codex_sdk.repo_mode', {
      taskId: params.taskId,
      isRepoMode: dispatch.isRepoMode,
      cwd: dispatch.spawnCwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });
    await this._run(
      params.taskId,
      prompt,
      callbacks,
      params.agentId,
      params.taskFolderName,
      agentInfo?.description,
      agentInfo?.model,
      dispatch,
    );
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const agentInfo = discoveredAgents[params.agentId];
    await this._run(params.taskId, params.message, callbacks, params.agentId, undefined, agentInfo?.description, agentInfo?.model);
  }

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const agentInfo = discoveredAgents[params.agentId];
    const cwd = fs.existsSync(params.workingDir) ? params.workingDir : CTRLNODE_ROOT;
    const agentHome = getCodexAgentHome(params.agentId);
    syncCodexAuthToAgentHome(agentHome, process.env.CODEX_HOME);
    const codexHomeOverride = fs.existsSync(agentHome) ? agentHome : process.env.CODEX_HOME;
    const modelFromConfig = codexHomeOverride ? readModelFromConfigToml(codexHomeOverride) : undefined;
    const model = (agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined)
      ?? modelFromConfig
      ?? process.env.CODEX_DEFAULT_MODEL
      ?? undefined;
    const codexEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(process.env.CODEX_API_KEY ? { OPENAI_API_KEY: process.env.CODEX_API_KEY } : {}),
      ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
    };
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), params.timeoutMs);

    logger.info('codex_sdk.graph_generation_start', {
      agentId: params.agentId,
      cwd,
      model: model ?? '(default)',
      timeoutMs: params.timeoutMs,
    });

    try {
      const codex = new Codex({
        ...(process.env.CODEX_BIN_PATH ? { codexPathOverride: process.env.CODEX_BIN_PATH } : {}),
        env: codexEnv,
      });
      const thread = codex.startThread({
        workingDirectory: cwd,
        skipGitRepoCheck: true,
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        ...(model ? { model } : {}),
      });
      const turn = await thread.run(params.prompt, {
        outputSchema: GRAPH_BLUEPRINT_OUTPUT_SCHEMA,
        signal: abortController.signal,
      });
      const result = turn.finalResponse.trim();
      if (!result) throw new Error('GRAPH_GENERATION_EMPTY_RESPONSE');
      logger.info('codex_sdk.graph_generation_completed', {
        agentId: params.agentId,
        responseLength: result.length,
      });
      return result;
    } catch (error: any) {
      if (abortController.signal.aborted || error?.name === 'AbortError') {
        throw new Error('GRAPH_GENERATION_TIMEOUT');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    // Incoming paths from SaaS already include the "tasks/" prefix — return
    // ctrlnode root so path.join(base, relPath) resolves correctly.
    return CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    // Codex SDK does not support SaaS-initiated workspace creation.
    return null;
  }
  async listModels(): Promise<string[]> {
    const codexHome = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '', '.codex');
    return resolveModelsWithSubscriptionFirst(
      () => readCodexSubscriptionModels(codexHome),
      fetchOpenAiModels,
    );
  }

  async isAvailable(): Promise<boolean> {
    const resolvedPath = process.env.CODEX_BIN_PATH || resolveCodexFromPath();
    logger.info('codex_sdk.health_check', {
      available: Boolean(resolvedPath),
      platform: process.platform,
      resolvedPath: resolvedPath ?? '(not found)',
    });
    return Boolean(resolvedPath);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _run(
    taskId: string,
    prompt: string,
    callbacks: TaskCallbacks,
    agentId?: string,
    taskFolderName?: string,
    agentDescription?: string,
    agentModel?: string,
    dispatch?: RepoDispatchSpawnContext,
  ): Promise<void> {
    const { taskFolder, outputFolder } = resolveTaskPaths(taskFolderName, taskId);
    const ctx = dispatch ?? {
      isRepoMode: false,
      taskFolder,
      outputFolder,
      spawnCwd: CTRLNODE_ROOT,
      taskLogAbsolutePath: null,
      extraDirectories: [taskFolder],
    };
    const { spawnCwd, extraDirectories } = ctx;
    fs.mkdirSync(spawnCwd, { recursive: true });
    const timeoutMs = TASK_TIMEOUT_MINUTES * 60_000;

    logger.info('codex_sdk.start', { taskId, cwd: spawnCwd, taskFolder, model: agentModel });

    const agentHome = getCodexAgentHome(agentId ?? '');
    syncCodexAuthToAgentHome(agentHome, process.env.CODEX_HOME);
    const codexHomeOverride = fs.existsSync(agentHome) ? agentHome : process.env.CODEX_HOME;
    if (codexHomeOverride) ensureWorkspaceTrusted(codexHomeOverride);

    // Report the configured model immediately so the UI shows it.
    // Skip if the model value is just the provider name (e.g. "codex") — that
    // means no real model was configured on the agent.
    // Fall back to reading the model from the agent's config.toml so the UI
    // always shows the actual model even when the SaaS field is blank.
    const modelFromConfig = codexHomeOverride ? readModelFromConfigToml(codexHomeOverride) : undefined;
    // Use the agent-configured model, falling back to config.toml, then the
    // CODEX_DEFAULT_MODEL env var. No hardcoded fallback — if no model is set
    // the codex CLI will use whatever default its own config specifies.
    const effectiveModel = (agentModel && agentModel !== this.providerName ? agentModel : undefined)
      ?? modelFromConfig
      ?? process.env.CODEX_DEFAULT_MODEL
      ?? undefined;
    if (effectiveModel && callbacks.onModelDiscovered) {
      callbacks.onModelDiscovered(effectiveModel);
    }

    // CODEX_BIN_PATH lets operators point the SDK at a system-installed `codex`
    // binary (e.g. /usr/local/bin/codex) instead of relying on the npm optional
    // platform packages that don't exist inside the compiled Bun single-binary.
    // If not set, fall back to resolving `codex` from the system PATH.
    const codexBinPath = process.env.CODEX_BIN_PATH || resolveCodexFromPath();
    logger.info('codex_sdk.config', {
      taskId,
      codexBinPath: codexBinPath ?? '(not set — will use findCodexPath)',
      codexHomeOverride: codexHomeOverride ?? '(not set)',
      agentHome,
      agentHomeExists: fs.existsSync(agentHome),
      codexApiKeySet: !!process.env.CODEX_API_KEY,
      openaiApiKeySet: !!process.env.OPENAI_API_KEY,
      spawnCwd,
      taskFolder,
      effectiveModel,
    });

    // Build the env for the codex subprocess.
    // Some codex CLI builds read OPENAI_API_KEY instead of CODEX_API_KEY, so
    // map both to make sure the key reaches the binary regardless of version.
    const codexEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      ...(process.env.CODEX_API_KEY ? { OPENAI_API_KEY: process.env.CODEX_API_KEY } : {}),
      ...(codexHomeOverride ? { CODEX_HOME: codexHomeOverride } : {}),
    };

    // Preflight: identify the codex binary (once per task, cheap spawnSync)
    // This tells us whether it's the npm @openai/codex CLI or some other binary.
    if (codexBinPath) {
      try {
        const versionResult = spawnSync(codexBinPath, ['--version'], { encoding: 'utf8', timeout: 5000, env: codexEnv });
        const preflightStdout = (versionResult.stdout ?? '').trim().slice(0, 200);
        const preflightStderr = (versionResult.stderr ?? '').trim().slice(0, 200);
        // Also probe exec --help to confirm the subcommand exists
        const execHelpResult = spawnSync(codexBinPath, ['exec', '--help'], { encoding: 'utf8', timeout: 5000, env: codexEnv });
        const execHelpStdout = (execHelpResult.stdout ?? '').trim().slice(0, 200);
        const execHelpStderr = (execHelpResult.stderr ?? '').trim().slice(0, 200);
        logger.info('codex_sdk.preflight', {
          taskId,
          versionExitCode: versionResult.status ?? `signal:${versionResult.signal}`,
          versionStdout: preflightStdout || '(empty)',
          versionStderr: preflightStderr || '(empty)',
          execHelpExitCode: execHelpResult.status ?? `signal:${execHelpResult.signal}`,
          execHelpStdout: execHelpStdout || '(empty)',
          execHelpStderr: execHelpStderr.slice(0, 100) || '(empty)',
        });
      } catch (e: any) {
        logger.warn('codex_sdk.preflight_error', { taskId, error: e.message });
      }
    }

    let codex: Codex;
    try {
      codex = new Codex({
        ...(codexBinPath ? { codexPathOverride: codexBinPath } : {}),
        env: codexEnv,
      });
      logger.info('codex_sdk.init_ok', { taskId, codexBinPath: codexBinPath ?? '(findCodexPath)' });
    } catch (err: any) {
      const msg = `Failed to initialize Codex SDK: ${err.message}`;
      logger.error('codex_sdk.init_error', { taskId, error: err.message, stack: err.stack });
      callbacks.onComplete('failed', msg);
      return;
    }

    const timer = createInactivityTimer(timeoutMs, () => {
      logger.warn('codex_sdk.timeout', { taskId, timeoutMinutes: TASK_TIMEOUT_MINUTES });
    });

    let accumulatedText = '';
    const writtenFiles: string[] = [];

    try {
      const thread = codex.startThread({
        workingDirectory: spawnCwd,
        skipGitRepoCheck: true,
        // Allow the agent to write files in the working directory tree
        sandboxMode: 'workspace-write',
        // Never ask for approval — equivalent to --approval-mode yolo in CLI providers
        approvalPolicy: 'never',
        // Ensure the task output folder is writable even if outside cwd
        additionalDirectories: extraDirectories,
        // Pass the model when configured; if undefined the CLI uses its own
        // default (from config.toml or the CODEX_DEFAULT_MODEL env var).
        ...(effectiveModel ? { model: effectiveModel } : {}),
      });

      // The SaaS prompt already contains ## INSTRUCTIONS with exact file paths.
      // Pass it directly — the old buildPrompt wrapper added a redundant output
      // directory hint that caused Codex to double-resolve relative paths.
      const wrappedPrompt = prompt;
      logger.info('codex_sdk.thread_start', { taskId, promptLen: wrappedPrompt.length });
      const { events } = await thread.runStreamed(wrappedPrompt);
      logger.info('codex_sdk.events_stream_open', { taskId });

      this._cancelFlags.set(taskId, false);
      let eventCount = 0;
      for await (const event of events) {
        if (this._cancelFlags.get(taskId)) break;
        timer.reset();
        if (timer.fired) break;

        // Stream text deltas (SDK internal event not in the public type union)
        const rawEvent = event as any;
        eventCount++;
        if (eventCount <= 5 || rawEvent.type === 'turn.failed' || rawEvent.type === 'turn.completed') {
          logger.info('codex_sdk.event_trace', { taskId, type: rawEvent.type, seq: eventCount });
        }
        if (rawEvent.type === 'item/agentMessage/delta' && typeof rawEvent.text === 'string') {
          const chunk = rawEvent.text as string;
          accumulatedText += chunk;
          setAgentRunning(agentId ?? taskId);
          callbacks.onStream({ kind: 'text_chunk', taskId, text: chunk, raw: event });
          callbacks.onMessage(chunk);
        }

        // Final agent message (item.completed with agent_message).
        // Each completed agent turn may produce a full text that was NOT emitted as
        // incremental deltas (e.g. after shell tool calls). Always append so all turns
        // end up in the accumulated output, not just the first one.
        if (
          rawEvent.type === 'item.completed' &&
          rawEvent.item?.type === 'agent_message' &&
          typeof rawEvent.item?.text === 'string'
        ) {
          const completedText: string = rawEvent.item.text;
          // Only append if this text is not already the tail of what we accumulated
          // via delta chunks (avoids double-writing when deltas + completed both fire).
          if (!accumulatedText.trimEnd().endsWith(completedText.trimEnd())) {
            if (accumulatedText.trim()) accumulatedText += '\n\n';
            accumulatedText += completedText;
            callbacks.onMessage(completedText);
          }
          logger.info('codex_sdk.agent_message', { taskId, length: completedText.length });
        }

        // Shell commands executed by the agent
        if (
          rawEvent.type === 'item.completed' &&
          rawEvent.item?.type === 'command_execution'
        ) {
          const cmd = rawEvent.item?.command as string | undefined;
          const exitCode = rawEvent.item?.exit_code as number | undefined;
          const output = rawEvent.item?.aggregated_output as string | undefined;
          setAgentRunning(agentId ?? taskId);
          logger.info('codex_sdk.command_executed', { taskId, cmd, exitCode, outputLen: output?.length });
        }

        // File changes written by the agent (FileChangeItem has changes[].path, not .path)
        if (
          rawEvent.type === 'item.completed' &&
          rawEvent.item?.type === 'file_change'
        ) {
          const changes = (rawEvent.item?.changes ?? []) as Array<{ path: string; kind: string }>;
          for (const change of changes) {
            if (change.path) {
              writtenFiles.push(change.path);
              logger.info('codex_sdk.file_written', { taskId, path: change.path, kind: change.kind });
              callbacks.onStream({ kind: 'file_written', taskId, path: change.path });
            }
          }
        }

        // Log unexpected / diagnostic events
        if (
          rawEvent.type !== 'item/agentMessage/delta' &&
          rawEvent.type !== 'item.completed' &&
          rawEvent.type !== 'item.started' &&
          rawEvent.type !== 'item.updated' &&
          rawEvent.type !== 'thread.started' &&
          rawEvent.type !== 'turn.started' &&
          rawEvent.type !== 'turn.completed' &&
          rawEvent.type !== 'turn.failed'
        ) {
          // For error events log the full payload to capture the message
          const extra = rawEvent.type === 'error'
            ? { message: rawEvent.message ?? rawEvent.error?.message ?? JSON.stringify(rawEvent).slice(0, 300) }
            : {};
          logger.info('codex_sdk.event', { taskId, type: rawEvent.type, ...extra });
        }

        // Error events from the codex CLI (e.g. model access denied, API errors)
        if (rawEvent.type === 'error') {
          const rawMsg: string = rawEvent.message ?? rawEvent.error?.message ?? JSON.stringify(rawEvent).slice(0, 300);
          // Strip "Reconnecting... X/Y " prefix emitted by the codex CLI retry logic
          const errMsg = rawMsg.replace(/^Reconnecting\.\.\.\s*\d+\/\d+\s*/i, '').trim() || rawMsg;
          logger.error('codex_sdk.error_event', { taskId, error: errMsg });
          timer.clear();
          callbacks.onComplete('failed', errMsg);
          return;
        }

        // Turn failed
        if (rawEvent.type === 'turn.failed') {
          const errMsg = rawEvent.error?.message ?? 'Codex turn failed';
          logger.error('codex_sdk.turn_failed', { taskId, error: errMsg });
          timer.clear();
          callbacks.onComplete('failed', errMsg);
          return;
        }
      }

      logger.info('codex_sdk.events_stream_closed', { taskId, totalEvents: eventCount });
      this._cancelFlags.delete(taskId);
      timer.clear();

      if (timer.fired) {
        callbacks.onComplete('blocked', 'Task timed out');
        return;
      }

      // Fallback: write output file if agent didn't use file tools
      writeTaskOutputs(taskId, taskFolderName ?? '', accumulatedText, 'codex_sdk');
      // onMessage called per delta chunk; skip final bulk send.
      const completion = detectStatusTag(accumulatedText);
      logger.info('codex_sdk.done', { taskId, status: completion.status, filesWritten: writtenFiles.length, accumulatedLen: accumulatedText.length });
      callbacks.onComplete(completion.status, completion.reason);

    } catch (err) {
      this._cancelFlags.delete(taskId);
      timer.clear();
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      logger.error('codex_sdk.error', { taskId, error: msg, stack });
      callbacks.onComplete('failed', msg);
    }
  }

  async cancelRun(taskId: string): Promise<void> {
    if (!this._cancelFlags.has(taskId)) return;
    logger.info('codex_sdk_provider.cancel', { taskId });
    this._cancelFlags.set(taskId, true);
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(userPrompt: string, outputDir: string): string {
  return `You are an autonomous coding agent with full shell access. Your task output folder is:
${outputDir}

When your task requires producing files (code, reports, data, etc.), write them directly to the output folder using shell commands (e.g. \`mkdir -p "${outputDir}/output" && cat > "${outputDir}/output/result.md"\` or equivalent). Do NOT just describe what you would do — actually execute the commands and create the files.

When you have finished all work, end your response with one of these tags on its own line:
<TASK_COMPLETED:done>
<TASK_BLOCKED:reason>
<TASK_FAILED:reason>

--- TASK ---
${userPrompt}`;
}

// ── Status tag detection / output writers → providerFileUtils.ts ─────────────

// ── Config helpers ─────────────────────────────────────────────────────────────

/**
 * Reads the `model = "..."` line from a CODEX_HOME config.toml.
 * Returns undefined if the file doesn't exist or has no model entry.
 */
function readModelFromConfigToml(codexHomePath: string): string | undefined {
  try {
    const configPath = path.join(codexHomePath, 'config.toml');
    if (!fs.existsSync(configPath)) return undefined;
    const content = fs.readFileSync(configPath, 'utf8');
    const match = content.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensures the Codex agent config.toml has `trust_level = "trusted"` for the
 * given workspace directory. Without this, Codex CLI overrides --sandbox
 * workspace-write and falls back to read-only, preventing file writes.
 */
function ensureWorkspaceTrusted(codexHomePath: string): void {
  try {
    const configPath = path.join(codexHomePath, 'config.toml');
    if (!fs.existsSync(configPath)) return;
    const content = fs.readFileSync(configPath, 'utf8');
    let extra = '';
    if (!content.toLowerCase().includes(CTRLNODE_ROOT.toLowerCase())) {
      extra += `\n[projects.'${CTRLNODE_ROOT}']\ntrust_level = "trusted"\n`;
    }
    if (!content.toLowerCase().includes('[windows]')) {
      extra += `\n[windows]\nsandbox = "unelevated"\n`;
    }
    if (extra) {
      fs.appendFileSync(configPath, extra, 'utf8');
      logger.info('codex_agent_home.workspace_trusted', { codexHomePath, root: CTRLNODE_ROOT });
    }
  } catch (e) {
    logger.warn('codex_agent_home.workspace_trust_failed', { codexHomePath, err: String(e) });
  }
}
