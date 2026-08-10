/**
 * @file ClaudeAgentSdkProvider.ts
 * @description IProvider implementation backed by the @anthropic-ai/claude-agent-sdk
 * TypeScript library. Unlike ClaudeCodeProvider (which spawns the claude.cmd CLI),
 * this provider uses the programmatic SDK API (`query()`) — no subprocess, no
 * stdin/arg-length issues, and full TypeScript types for messages.
 *
 * Provider name: "claude-sdk"
 *
 * Environment:
 *   ANTHROPIC_API_KEY   — required; passed to the SDK process env
 *   CLAUDE_SDK_TOOLS    — comma-separated allowed tools (default: Read,Write,Edit,Bash,Glob,Grep)
 *   CLAUDE_SDK_MAX_TURNS — max agentic turns (default: 200)
 *   TASK_TIMEOUT_MINUTES — hard timeout in minutes (default: 30)
 *   CLAUDE_SDK_PERMISSION_MODE — bypassPermissions | acceptEdits | dontAsk (default: bypassPermissions)
 *   CLAUDE_SDK_MODEL    — model alias/id override (default: inherited from SDK)
 */
import fs from 'fs';
import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams, ProviderHealth } from './IProvider.js';
import { AgentSummary } from '../types.js';
import {
  CTRLNODE_ROOT,
  resolveProjectHome,
  ANTHROPIC_API_KEY,
  CLAUDE_SDK_TOOLS,
  CLAUDE_SDK_MAX_TURNS,
  TASK_TIMEOUT_MINUTES,
  CLAUDE_SDK_PERMISSION_MODE,
  CLAUDE_SDK_EXECUTABLE,
  GRAPH_GENERATION_MAX_TURNS,
} from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { resolveModelsWithSubscriptionFirst } from '../subscriptionModelResolution.js';
import { getKnownModels } from '../modelManifest.js';
import { detectStatusTag, fetchAnthropicModels as _fetchAnthropicModels, writeTaskOutputs, createInactivityTimer, isStaleSessionError, buildStaleSessionRecoveryPrompt, resolveCurrentAgentLogFileName } from './providerFileUtils.js';
import {
  appendTaskLogToSystemParts,
  resolveRepoDispatchSpawn,
  resolveSessionFilePath,
  resolveTaskPaths,
} from './repoDispatchContext.js';
import { ClaudePlannerTextCollector } from '../graphBlueprintPlanner.js';


/**
 * Writes CLAUDE.md into the task folder with the agent role and instructions.
 * Claude SDK reads CLAUDE.md via the normal project-file discovery from `cwd`.
 */
function writeAgentsMd(taskFolder: string, role: string | undefined, instructions: string | undefined): void {
  const lines: string[] = [];
  if (role) lines.push(`You are a ${role}.`, '');
  if (instructions) lines.push(instructions, '');
  fs.writeFileSync(path.join(taskFolder, 'CLAUDE.md'), lines.join('\n'), 'utf-8');
}

/**
 * Splits a prompt that was built from task-notification.md into the task body
 * and the ## INSTRUCTIONS section (Steps 1-3: write files, write summary, write tag).
 * The INSTRUCTIONS section is better placed in the system prompt so the task
 * body stays clean (matching how ClaudeCodeProvider uses --append-system-prompt-file).
 */
function splitPromptInstructions(prompt: string): { taskBody: string; instructionsBlock: string | undefined } {
  const marker = '\n## INSTRUCTIONS\n';
  const idx = prompt.indexOf(marker);
  if (idx === -1) return { taskBody: prompt, instructionsBlock: undefined };
  return {
    taskBody: prompt.slice(0, idx).trim(),
    instructionsBlock: ('## INSTRUCTIONS\n' + prompt.slice(idx + marker.length)).trim(),
  };
}

/**
 * Real SDK error results (`SDKResultError`) carry `errors: string[]`, not a singular
 * `.error` string — reading `.error` (as this file used to) is always undefined for
 * genuine failures, silently discarding the actual reason. Extracts a readable
 * message from either shape (defensive against SDK version drift).
 */
function extractSdkResultErrorMessage(result: any): string | undefined {
  if (typeof result?.error === 'string' && result.error.trim()) return result.error;
  if (Array.isArray(result?.errors) && result.errors.length > 0) {
    const joined = result.errors.filter(Boolean).join('; ');
    if (joined) return joined;
  }
  return undefined;
}

// How long the output folder must be unchanged before we consider the process done.
const STABLE_WINDOW_MS  = 15_000;   // 15 s of no size change → stable
const POLL_INTERVAL_MS  = 3_000;    // check every 3 s
const MAX_WAIT_MS       = 20 * 60 * 1000; // give up after 20 min

/**
 * Polls `outputFolder` until its total byte size has been unchanged for
 * STABLE_WINDOW_MS. This lets the underlying claude process finish writing
 * files after the SDK emits result:success, preventing a premature DONE.
 */
async function waitForOutputStable(taskId: string, outputFolder: string): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastSize = -1;
  let stableSince = 0;

  while (Date.now() < deadline) {
    let totalSize = 0;
    try {
      const entries = fs.readdirSync(outputFolder);
      for (const entry of entries) {
        try {
          totalSize += fs.statSync(path.join(outputFolder, entry)).size;
        } catch { /* ignore */ }
      }
    } catch { /* folder may not exist yet */ }

    if (totalSize !== lastSize) {
      lastSize = totalSize;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= STABLE_WINDOW_MS) {
      logger.info('claude_sdk_provider.output_stable', { taskId, totalSize });
      return;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }

  logger.warn('claude_sdk_provider.output_stable_timeout', { taskId });
}

export class ClaudeAgentSdkProvider implements IProvider {
  readonly providerName = 'claude-sdk';

  /** taskId → session_id from previous runs, used for resume on followup. */
  private sessionCache = new Map<string, string>();
  private readonly _activeAborts = new Map<string, AbortController>();

  async discoverAgents(): Promise<AgentSummary[]> {
    // Like ClaudeCodeProvider, agents are registered via sync_claude_sdk_agents from SaaS.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const { taskId, prompt, taskFolderName, agentId } = params;
    const agentInfo = discoveredAgents[agentId];
    const agentModel = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;

    logger.info('claude_sdk_provider.dispatch', {
      provider: 'claude-sdk',
      taskId,
      agentId,
      model: agentModel ?? '(default)',
      authMode: ANTHROPIC_API_KEY ? 'api-key' : 'local-cli-login',
    });

    const dispatch = resolveRepoDispatchSpawn(params, CTRLNODE_ROOT);
    const { taskFolder, outputFolder, spawnCwd: cwd, isRepoMode, extraDirectories } = dispatch;

    // Clear any previous session so a fresh dispatch never resumes a stale session (e.g. RERUN).
    this.sessionCache.delete(taskId);
    const sessionFile = resolveSessionFilePath(taskFolderName, taskId);
    if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile);
    fs.mkdirSync(outputFolder, { recursive: true });

    // Write CLAUDE.md so SDK picks up role/instructions for this agent.
    writeAgentsMd(taskFolder, agentInfo?.role, agentInfo?.description);

    // Read CLAUDE.md content to inject as appendSystemPrompt — the SDK discovers
    // CLAUDE.md from cwd upward, so it won't find it in a subdirectory. We pass
    // it explicitly so the agent receives its role/instructions regardless of cwd.
    const claudeMdPath = path.join(taskFolder, 'CLAUDE.md');
    const claudeMdContent = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8').trim() : undefined;

    // Resolve the input file (if any) to embed in the prompt so the SDK
    // receives the full task content without CLI arg-length concerns.
    const inputDir = path.join(taskFolder, 'input');
    const inputFiles = fs.existsSync(inputDir)
      ? fs.readdirSync(inputDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'))
      : [];
    const inputFile = inputFiles.length > 0 ? path.join(inputDir, inputFiles[0]) : null;
    const taskContent = inputFile ? fs.readFileSync(inputFile, 'utf-8').trim() : null;

    // Split "## INSTRUCTIONS" out of the prompt so it goes into the system block
    // (like ClaudeCodeProvider uses --append-system-prompt-file for CLAUDE.md).
    const { taskBody, instructionsBlock } = splitPromptInstructions(prompt);

    // Build the prompt: use task file content if present, otherwise the task body.
    const basePrompt = taskContent
      ? `${taskContent}\n\n---\n${taskBody}`
      : taskBody;

    // System block: CLAUDE.md + INSTRUCTIONS section (both optional).
    const systemParts: string[] = [];
    if (claudeMdContent) systemParts.push(claudeMdContent);
    if (instructionsBlock) systemParts.push(instructionsBlock);
    appendTaskLogToSystemParts(systemParts, params);
    const systemBlock = systemParts.length > 0 ? systemParts.join('\n\n---\n\n') : undefined;

    const fullPrompt = systemBlock
      ? `<system>\n${systemBlock}\n</system>\n\n${basePrompt}`
      : basePrompt;

    const additionalDirectories = isRepoMode ? extraDirectories : [taskFolder];

    logger.info('claude_sdk_provider.repo_mode', {
      taskId,
      isRepoMode,
      cwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });

    await this._runQuery({
      taskId,
      taskFolderName: taskFolderName ?? undefined,
      cwd,
      prompt: fullPrompt,
      additionalDirectories,
      appendSystemPrompt: systemBlock,
      model: agentModel,
      persistSession: true, // save session so followup can resume with full history
      outputFolder,
      callbacks,
    });
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const { taskId, message, agentId, taskFolderName } = params;

    // Lives inside the task's real folder (same location output/log/CLAUDE.md below
    // resolve to) when taskFolderName is known; only falls back to the flat
    // tasks/<taskId>/ layout if it's genuinely unavailable.
    const sessionFile = resolveSessionFilePath(taskFolderName, taskId);
    const prevSessionId = this.sessionCache.get(taskId)
      ?? (fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf-8').trim() : undefined);
    if (prevSessionId) {
      logger.info('claude_sdk_provider.session_resume', { taskId, sessionId: prevSessionId, source: this.sessionCache.has(taskId) ? 'memory' : 'disk' });
    } else {
      logger.warn('claude_sdk_provider.session_resume_missing', { taskId });
    }
    const agentInfo = discoveredAgents[agentId];
    const agentModel = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;

    // Output/log/CLAUDE.md must live in the task's REAL folder (same one the initial
    // run used and the one prepareFollowupFiles() writes the followup input file
    // into), not the taskId-keyed folder used only for session_id.
    const { taskFolder } = resolveTaskPaths(taskFolderName, taskId);
    const outputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(outputFolder, { recursive: true });
    writeAgentsMd(taskFolder, agentInfo?.role, agentInfo?.description);

    const claudeMdPath = path.join(taskFolder, 'CLAUDE.md');
    const claudeMdContent = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8').trim() : undefined;

    const providerTasksRoot = CTRLNODE_ROOT;
    fs.mkdirSync(providerTasksRoot, { recursive: true });

    // The followup input file was already written and the output-file instruction block
    // was injected into `message` by intentHandlers.ts (via prepareFollowupFiles).
    // Parse it out here so we can add claudeMd alongside it in the system prompt.
    const { taskBody: sessionBody, instructionsBlock: sessionInstructions } = splitPromptInstructions(message);
    const sessionSystemParts: string[] = [];
    if (claudeMdContent) sessionSystemParts.push(claudeMdContent);
    if (sessionInstructions) sessionSystemParts.push(sessionInstructions);
    const sessionSystem = sessionSystemParts.length > 0 ? sessionSystemParts.join('\n\n---\n\n') : undefined;
    const sessionPrompt = sessionSystem
      ? `<system>\n${sessionSystem}\n</system>\n\n${sessionBody}`
      : sessionBody;

    await this._runQuery({
      taskId,
      taskFolderName: taskFolderName ?? undefined,
      cwd: providerTasksRoot,
      prompt: sessionPrompt,
      resumeSessionId: prevSessionId,
      additionalDirectories: [taskFolder],
      appendSystemPrompt: sessionSystem,
      model: agentModel,
      persistSession: true, // keep session so follow-up resume works
      outputFolder,
      callbacks,
    });
  }

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const agentInfo = discoveredAgents[params.agentId];
    const model = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;
    const cwd = fs.existsSync(params.workingDir) ? params.workingDir : CTRLNODE_ROOT;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), params.timeoutMs);
    const options: Options = {
      cwd,
      // Read-only guarantee: no tools available to the model during graph-blueprint
      // generation (see management/docs/08-04-ai-graph-generation-plan) — it can
      // only read the prompt and respond with JSON, never write files or run
      // commands. GRAPH_GENERATION_MAX_TURNS is generous purely to give the model
      // room to self-correct its JSON response, not to allow a tool-use loop.
      allowedTools: [],
      permissionMode: 'dontAsk' as any,
      maxTurns: GRAPH_GENERATION_MAX_TURNS,
      persistSession: false,
      includePartialMessages: true,
      abortController,
      ...(model ? { model } : {}),
      ...(CLAUDE_SDK_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_SDK_EXECUTABLE } : {}),
    };
    const collector = new ClaudePlannerTextCollector();

    try {
      for await (const message of query({ prompt: params.prompt, options })) {
        collector.add(message);
        if ((message as any).type === 'result') {
          const result = message as any;
          if (result.subtype !== 'success') {
            if (result.subtype === 'error_max_turns') throw new Error('GRAPH_GENERATION_TIMEOUT');
            const message = extractSdkResultErrorMessage(result);
            throw new Error(message ?? `GRAPH_GENERATION_PROVIDER_ERROR: ${result.subtype}`);
          }
        }
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') throw new Error('GRAPH_GENERATION_TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    const result = collector.text.trim();
    if (!result) throw new Error('GRAPH_GENERATION_EMPTY_RESPONSE');
    return result;
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async cancelRun(taskId: string): Promise<void> {
    const abort = this._activeAborts.get(taskId);
    if (!abort) return;
    logger.info('claude_sdk_provider.cancel', { taskId });
    abort.abort();
    this._activeAborts.delete(taskId);
  }

  async dispose(): Promise<void> {}
  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    return CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    return null;
  }
  async listModels(): Promise<string[]> {
    const credentialsPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', '.credentials.json');
    return resolveModelsWithSubscriptionFirst(
      async () => fs.existsSync(credentialsPath) ? getKnownModels('claude') : [],
      () => _fetchAnthropicModels(ANTHROPIC_API_KEY),
    );
  }

  async isAvailable(): Promise<boolean> {
    if (!CLAUDE_SDK_EXECUTABLE) return false;
    return fs.existsSync(CLAUDE_SDK_EXECUTABLE);
  }

  async checkHealth(): Promise<ProviderHealth> {
    if (!await this.isAvailable()) return { available: false, reason: 'binary_missing' };
    if (ANTHROPIC_API_KEY) return { available: true };
    const credentialsPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', '.credentials.json');
    return fs.existsSync(credentialsPath)
      ? { available: true }
      : { available: false, reason: 'auth_required' };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private async _runQuery(opts: {
    taskId: string;
    taskFolderName?: string;
    cwd: string;
    prompt: string;
    resumeSessionId?: string;
    additionalDirectories?: string[];
    appendSystemPrompt?: string;
    model?: string;
    persistSession?: boolean;
    outputFolder?: string;
    callbacks: TaskCallbacks;
    /** Internal: set on the retry attempt after a stale-session recovery, to prevent infinite retry loops. */
    isSessionRecoveryRetry?: boolean;
  }): Promise<void> {
    const {
      taskId,
      taskFolderName,
      cwd,
      prompt,
      resumeSessionId,
      additionalDirectories,
      appendSystemPrompt,
      model,
      persistSession,
      outputFolder,
      callbacks,
      isSessionRecoveryRetry,
    } = opts;

    // Prepare this execution's agent log — stream assistant messages into it as they
    // arrive. Named agent_log.md for the initial run or agent_log.followup-N.md for
    // followup N (see resolveCurrentAgentLogFileName), so each execution keeps its own
    // log instead of a followup's live stream overwriting the initial run's log while
    // writeTaskOutputs (at the end) writes to a *different*, correctly-named file.
    const taskFolderAbsForLog = outputFolder ? path.dirname(outputFolder) : null;
    const agentLogPath = outputFolder
      ? path.join(outputFolder, resolveCurrentAgentLogFileName(taskFolderAbsForLog!))
      : null;
    if (agentLogPath && !fs.existsSync(agentLogPath)) {
      fs.writeFileSync(agentLogPath, `# Agent log\n\n`, 'utf-8');
    }

    const toolList = CLAUDE_SDK_TOOLS.split(',').map(t => t.trim()).filter(Boolean);

    const options: Options = {
      cwd,
      allowedTools: toolList,
      permissionMode: CLAUDE_SDK_PERMISSION_MODE as any,
      allowDangerouslySkipPermissions: CLAUDE_SDK_PERMISSION_MODE === 'bypassPermissions',
      maxTurns: CLAUDE_SDK_MAX_TURNS,
      persistSession: persistSession ?? false,
      includePartialMessages: true,
      ...(model ? { model } : {}),
      ...(additionalDirectories?.length ? { additionalDirectories } : {}),
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
      ...(CLAUDE_SDK_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_SDK_EXECUTABLE } : {}),
    };

    const timeoutMs = TASK_TIMEOUT_MINUTES * 60 * 1000;
    const abortController = new AbortController();
    options.abortController = abortController;
    this._activeAborts.set(taskId, abortController);

    const timer = createInactivityTimer(timeoutMs, () => {
      abortController.abort();
      logger.warn('claude_sdk_provider.timeout', { taskId, timeoutMinutes: TASK_TIMEOUT_MINUTES });
    });

    logger.info('claude_sdk_provider.query_start', {
      taskId,
      cwd,
      resume: resumeSessionId,
      tools: toolList,
      model,
      persistSession,
      appendSystemPrompt: appendSystemPrompt ? appendSystemPrompt.slice(0, 120).replace(/\n/g, '\\n') : null,
    });
    logger.debug('claude_sdk_provider.query_start_full', {
      taskId,
      prompt,
      appendSystemPrompt: appendSystemPrompt ?? null,
    });

    let sessionId: string | undefined;
    let completedStatus: string | undefined;
    let completedReason: string | undefined;
    let accumulatedText = '';
    let lastProcessedFullText = '';
    let currentMessageUuid: string | undefined;

    try {
      for await (const message of query({ prompt, options })) {
        timer.reset(); // any SDK message = agent is alive
        const msgType = (message as any).type;

        // Forward raw event to SaaS stream
        callbacks.onStream(message);

        if (msgType === 'result') {
          const result = message as any;
          sessionId = result.session_id;
          // error_max_turns means the agent ran out of turns without finishing → blocked (retriable)
          // any other non-success subtype → failed
          if (result.subtype === 'error_max_turns') {
            completedStatus = 'blocked';
            completedReason = `max_turns (limit: ${CLAUDE_SDK_MAX_TURNS})`;
          } else {
            completedStatus = result.subtype === 'success' ? 'completed' : 'failed';
            completedReason = result.subtype !== 'success'
              ? (extractSdkResultErrorMessage(result) ?? result.subtype)
              : undefined;
          }

          logger.info('claude_sdk_provider.result', {
            taskId,
            subtype: result.subtype,
            sessionId,
            costUsd: result.total_cost_usd,
          });
          continue;
        }

        if (msgType === 'assistant') {
          const assistantMsg = message as any;
          const uuid = assistantMsg.uuid ?? assistantMsg.message?.id;
          const content = assistantMsg.message?.content ?? assistantMsg.content ?? [];

          // Log tool_use calls so we can see the absolute paths the agent attempts to write
          for (const block of Array.isArray(content) ? content : []) {
            if (block?.type === 'tool_use') {
              const inputPath = block.input?.path ?? block.input?.file_path ?? block.input?.filename;
              logger.info('claude_sdk_provider.tool_use', {
                taskId,
                tool: block.name,
                path: inputPath,
                cwd,
                resolvedPath: inputPath ? path.resolve(cwd, inputPath) : undefined,
              });
            }
          }

          // Extract text delta (SDK sends growing snapshots with --include-partial-messages)
          let fullText = '';
          for (const block of Array.isArray(content) ? content : []) {
            if (block?.type === 'text') fullText += block.text ?? '';
          }

          if (fullText) {
            if (uuid && uuid !== currentMessageUuid) {
              currentMessageUuid = uuid;
              lastProcessedFullText = '';
            }

            let delta: string;
            if (fullText.startsWith(lastProcessedFullText)) {
              delta = fullText.slice(lastProcessedFullText.length);
              if (delta) lastProcessedFullText = fullText;
            } else {
              delta = fullText;
              lastProcessedFullText = fullText;
            }

            if (delta) {
              accumulatedText += delta;
              if (agentLogPath) {
                try { fs.appendFileSync(agentLogPath, delta, 'utf-8'); } catch { /* ignore */ }
              }
              callbacks.onMessage(delta);
              logger.info('claude_sdk_provider.assistant_delta', { taskId, preview: delta.slice(0, 100).replace(/\n/g, '\\n') });
            }
          }
          continue;
        }

        if (msgType === 'system') {
          const sys = message as any;
          if (sys.subtype === 'init' && sys.model) {
            callbacks.onModelDiscovered?.(sys.model as string);
            logger.info('claude_sdk_provider.model_discovered', { taskId, model: sys.model });
          }
        }
      }
    } catch (err: any) {
      timer.clear();
      this._activeAborts.delete(taskId);
      const isAbort = err?.name === 'AbortError'
        || (err?.message ?? '').toLowerCase().includes('aborted');
      if (isAbort) {
        callbacks.onComplete('blocked', `Task timed out after ${TASK_TIMEOUT_MINUTES} minutes`);
        return;
      }
      if (resumeSessionId && !isSessionRecoveryRetry && isStaleSessionError(err?.message ?? '')) {
        logger.warn('claude_sdk_provider.session_recovery', { taskId, staleSessionId: resumeSessionId });
        this.sessionCache.delete(taskId);
        await this._runQuery({
          ...opts,
          prompt: buildStaleSessionRecoveryPrompt(taskFolderAbsForLog ?? '', prompt),
          resumeSessionId: undefined,
          isSessionRecoveryRetry: true,
        });
        return;
      }
      logger.error('claude_sdk_provider.query_error', { taskId, error: err?.message });
      callbacks.onComplete('failed', err?.message ?? 'Unknown error');
      return;
    }

    timer.clear();
    this._activeAborts.delete(taskId);

    if (
      completedStatus === 'failed'
      && resumeSessionId
      && !isSessionRecoveryRetry
      && isStaleSessionError(completedReason ?? '')
    ) {
      logger.warn('claude_sdk_provider.session_recovery', { taskId, staleSessionId: resumeSessionId });
      this.sessionCache.delete(taskId);
      await this._runQuery({
        ...opts,
        prompt: buildStaleSessionRecoveryPrompt(taskFolderAbsForLog ?? '', prompt),
        resumeSessionId: undefined,
        isSessionRecoveryRetry: true,
      });
      return;
    }

    if (sessionId && taskId) {
      this.sessionCache.set(taskId, sessionId);
      // Persist to disk so followup can resume even after a Bridge restart. Lives
      // inside the task's real folder when taskFolderName is known, so it doesn't
      // create a stray flat directory directly under tasks/.
      const sessionFilePath = resolveSessionFilePath(taskFolderName, taskId);
      try {
        fs.mkdirSync(path.dirname(sessionFilePath), { recursive: true });
        fs.writeFileSync(sessionFilePath, sessionId, 'utf-8');
        logger.info('claude_sdk_provider.session_persisted', { taskId, sessionId });
      } catch (e: any) {
        logger.warn('claude_sdk_provider.session_persist_failed', { taskId, error: e?.message });
      }
    }

    const relTaskFolder = taskFolderName
      ?? (outputFolder ? path.relative(CTRLNODE_ROOT, path.dirname(outputFolder)).replace(/\\/g, '/') : undefined);

    // Wait for the underlying claude process to finish writing output files.
    // The SDK emits result:success when the conversation turn ends, but the process
    // can keep writing files for minutes after that. We poll the outputFolder until
    // its total size has been stable for STABLE_WINDOW_MS (no writes in progress).
    if (outputFolder && completedStatus === 'completed') {
      await waitForOutputStable(taskId, outputFolder);
    }

    if (relTaskFolder && accumulatedText.trim()) {
      writeTaskOutputs(taskId, relTaskFolder, accumulatedText, 'claude_sdk', accumulatedText);
      logger.info('claude_sdk_provider.outputs_written', {
        taskId,
        taskFolderName: relTaskFolder,
        textLen: accumulatedText.length,
      });
    }

    let finalStatus = (completedStatus as 'completed' | 'failed' | 'blocked' | undefined) ?? 'completed';
    let finalReason = completedReason;

    if (finalStatus === 'completed' && accumulatedText.trim()) {
      const tag = detectStatusTag(accumulatedText);
      finalStatus = tag.status;
      if (tag.reason) finalReason = tag.reason;
    }

    callbacks.onComplete(finalStatus, finalReason);
  }
}
