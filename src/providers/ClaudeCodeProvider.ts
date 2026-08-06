import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import { CLAUDE_TOOLS, CLAUDE_MAX_TURNS, CLAUDE_SKIP_PERMISSIONS, CTRLNODE_ROOT, resolveProjectHome, TASK_TIMEOUT_MINUTES, GRAPH_GENERATION_MAX_TURNS } from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { augmentPromptForRepoMode, resolveRepoDispatchSpawn, resolveTaskPaths } from './repoDispatchContext.js';
import { createInactivityTimer, isStaleSessionError, buildStaleSessionRecoveryPrompt, resolveCurrentAgentLogFileName } from './providerFileUtils.js';
import { ClaudePlannerTextCollector } from '../graphBlueprintPlanner.js';


/**
 * Writes (or overwrites) CLAUDE.md in the task folder with the agent's role and
 * instructions. Claude CLI reads this file from cwd as its system prompt.
 * Writing it here scopes it to the task and overrides any parent-level CLAUDE.md.
 * Idempotent — safe to call on every dispatch.
 */
function writeAgentsMd(
  taskFolder: string,
  role: string | undefined,
  instructions: string | undefined,
  outputFolder: string,
  taskSlug: string,
  taskId: string,
): void {
  const lines: string[] = [
  ];
  if (role) lines.push(`You are a ${role}.`, '');
  if (instructions) lines.push(instructions, '');
  lines.push(
    '## Task Execution Rules',
    '',
    'Follow these steps exactly:',
    '',
    '**Step 1 — Do the work.** Use the Write or Edit tool to create every output file.',
    'Simply describing results in chat does NOT count — you MUST write files to disk.',
    '',
    `All generated files MUST be placed inside: \`${outputFolder}\``,
    '',
    `**Step 2 — Write a summary** to: \`${outputFolder}/${taskSlug}-output.md\``,
    '',
    '**Step 3 — End your chat reply** (NOT a file) with exactly one of:',
    `- \`<TASK_COMPLETED:${taskId}>\``,
    `- \`<TASK_FAILED:${taskId}>\``,
    `- \`<TASK_BLOCKED:${taskId}>\``,
    '',
  );
  fs.writeFileSync(path.join(taskFolder, 'CLAUDE.md'), lines.join('\n'), 'utf-8');
}

/** Extract plain text from a Claude stream-json content array */
function extractText(content: any[]): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' || b?.kind === 'text')
    .map((b: any) => b.text || b.content || '')
    .join('');
}

export class ClaudeCodeProvider implements IProvider {
  readonly providerName = 'claude';
  /** taskId → session_id from previous runs, used for --resume on followup */
  private sessionCache = new Map<string, string>();
  private readonly _activeRuns = new Map<string, import('child_process').ChildProcess>();

  async discoverAgents(): Promise<AgentSummary[]> {
    // Claude agents are registered exclusively via sync_claude_agents (pushed
    // from the SaaS after the user registers them). Returning a static fallback
    // here causes a phantom UNREGISTERED card in the UI.
    return [];
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const { taskId, prompt, taskFolderName, agentId } = params;
    const agentInfo = discoveredAgents[agentId];
    const agentModel = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;

    logger.info('claude_provider.dispatch', { provider: 'claude', taskId, agentId, model: agentModel ?? '(default)' });

    const providerTasksRoot = resolveProjectHome(taskFolderName);
    const dispatch = resolveRepoDispatchSpawn(params, providerTasksRoot);
    const { taskFolder, outputFolder, spawnCwd: cwd } = dispatch;
    fs.mkdirSync(outputFolder, { recursive: true });

    const taskSlug = path.basename(taskFolder);
    const relativeOutputFolder = path.relative(cwd, outputFolder).replace(/\\/g, '/');

    // Write CLAUDE.md with role, instructions, and exact output paths for this task.
    writeAgentsMd(taskFolder, agentInfo?.role, agentInfo?.description, relativeOutputFolder, taskSlug, taskId);

    // Pipe the input file as stdin so large task content doesn't hit the Windows
    // cmd.exe ~32 KB arg limit. -p is a short fixed trigger.
    const inputDir = path.join(taskFolder, 'input');
    const inputFiles = fs.existsSync(inputDir)
      ? fs.readdirSync(inputDir).filter(f => f.endsWith('.md') || f.endsWith('.txt'))
      : [];
    const inputFile = inputFiles.length > 0 ? path.join(inputDir, inputFiles[0]) : null;
    const stdinContent = inputFile ? fs.readFileSync(inputFile, 'utf-8') : null;
    const dispatchPrompt = augmentPromptForRepoMode(
      stdinContent != null ? 'Execute the task provided in stdin.' : prompt,
      params,
    );

    logger.info('claude_provider.repo_mode', {
      taskId,
      isRepoMode: dispatch.isRepoMode,
      cwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });

    await this._spawnClaude({
      taskId,
      cwd,
      prompt: dispatchPrompt,
      stdinContent,
      addDir: taskFolder,
      model: agentModel,
      outputFolder,
      callbacks,
    });
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const { taskId, message, agentId, taskFolderName } = params;
    const prevSessionId = this.sessionCache.get(taskId);
    const agentInfo = discoveredAgents[agentId];
    const agentModel = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;

    // Output/log/CLAUDE.md must live in the task's REAL folder (same one the initial
    // run used and the one prepareFollowupFiles() writes the followup input file
    // into), not the taskId-keyed folder.
    const { taskFolder } = resolveTaskPaths(taskFolderName, taskId);
    const outputFolder = path.join(taskFolder, 'output');
    fs.mkdirSync(outputFolder, { recursive: true });

    const providerTasksRoot = resolveProjectHome(taskFolderName);
    const taskSlug = path.basename(taskFolder);
    const relativeOutputFolder = path.relative(providerTasksRoot, outputFolder).replace(/\\/g, '/');
    writeAgentsMd(taskFolder, agentInfo?.role, agentInfo?.description, relativeOutputFolder, taskSlug, taskId);
    fs.mkdirSync(providerTasksRoot, { recursive: true });
    await this._spawnClaude({ taskId, cwd: providerTasksRoot, prompt: message, resumeSessionId: prevSessionId, addDir: taskFolder, model: agentModel, outputFolder, callbacks });
  }

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const agentInfo = discoveredAgents[params.agentId];
    const model = agentInfo?.model && agentInfo.model !== this.providerName ? agentInfo.model : undefined;
    const cwd = fs.existsSync(params.workingDir) ? params.workingDir : CTRLNODE_ROOT;
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      // Read-only guarantee: no tools available to the model during graph-blueprint
      // generation (see management/docs/08-04-ai-graph-generation-plan) — it can
      // only read the prompt and respond with JSON, never write files or run
      // commands. GRAPH_GENERATION_MAX_TURNS is generous purely to give the model
      // room to self-correct its JSON response, not to allow a tool-use loop.
      '--allowedTools', '',
      '--max-turns', String(GRAPH_GENERATION_MAX_TURNS),
      '--no-session-persistence',
      ...(model ? ['--model', model] : []),
      '-p', params.prompt,
    ];
    const [spawnBin, spawnArgs] = process.platform === 'win32'
      ? (['cmd.exe', ['/c', 'claude.cmd', ...args]] as const)
      : (['claude', args] as const);

    return new Promise<string>((resolve, reject) => {
      const proc = spawn(spawnBin, [...spawnArgs], {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      const collector = new ClaudePlannerTextCollector();
      let stderr = '';
      let lineBuffer = '';
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error('GRAPH_GENERATION_TIMEOUT'));
      }, params.timeoutMs);

      proc.stdout?.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          try { collector.add(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      proc.on('close', (code) => {
        clearTimeout(timeout);
        const result = collector.text.trim();
        if (code !== 0) {
          reject(new Error(stderr.trim().slice(0, 512) || `GRAPH_GENERATION_PROVIDER_EXIT_${code}`));
        } else if (!result) {
          reject(new Error('GRAPH_GENERATION_EMPTY_RESPONSE'));
        } else {
          resolve(result);
        }
      });
    });
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async cancelRun(taskId: string): Promise<void> {
    const proc = this._activeRuns.get(taskId);
    if (!proc) return;
    logger.info('claude_provider.cancel', { taskId });
    proc.kill('SIGTERM');
    setTimeout(() => { if (!proc.killed) proc.kill('SIGKILL'); }, 3000);
    this._activeRuns.delete(taskId);
  }

  deliverInput = async (taskId: string, text: string): Promise<void> => {
    const proc = this._activeRuns.get(taskId);
    if (!proc?.stdin?.writable) {
      logger.warn('deliverInput: no active process for task', { taskId });
      return;
    }
    proc.stdin.write(text + '\n');
    logger.info('deliverInput: sent to claude stdin', { taskId });
  };

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    // SaaS always sends subpath like "tasks/x/y", so base = ctrlnode root.
    // The handlers' sanitizeRelPath + path.resolve guard prevents traversal above this root.
    return CTRLNODE_ROOT;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    if (providerName !== this.providerName) return null;
    return this.resolveFilesystemBase(undefined, useCtrlnode);
  }

  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null {
    // Claude Code does not support SaaS-initiated workspace creation.
    return null;
  }

  async listModels(): Promise<string[]> {
    const { fetchAnthropicModels } = await import('./providerFileUtils.js');
    const { ANTHROPIC_API_KEY } = await import('../config.js');
    const { resolveModelsWithSubscriptionFirst } = await import('../subscriptionModelResolution.js');
    const { getKnownModels } = await import('../modelManifest.js');
    const credentialsPath = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', '.credentials.json');
    return resolveModelsWithSubscriptionFirst(
      async () => fs.existsSync(credentialsPath) ? getKnownModels('claude') : [],
      () => fetchAnthropicModels(ANTHROPIC_API_KEY),
    );
  }

  async isAvailable(): Promise<boolean> {
    const { CLAUDE_SDK_EXECUTABLE } = await import('../config.js');
    if (!CLAUDE_SDK_EXECUTABLE) return false;
    const fs_ = await import('fs');
    return fs_.existsSync(CLAUDE_SDK_EXECUTABLE);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  private async _spawnClaude(opts: {
    taskId: string;
    cwd: string;
    prompt: string;
    /** Content to write to Claude's stdin (replaces -p for large task bodies). */
    stdinContent?: string | null;
    /** Directory to expose to Claude via --add-dir (task folder). */
    addDir?: string;
    resumeSessionId?: string;
    model?: string;
    outputFolder?: string;
    callbacks: TaskCallbacks;
    /** Internal: set on the retry attempt after a stale-session recovery, to prevent infinite retry loops. */
    isSessionRecoveryRetry?: boolean;
  }): Promise<void> {
    const { taskId, cwd, prompt, stdinContent, addDir, resumeSessionId, model, outputFolder, callbacks, isSessionRecoveryRetry } = opts;

    // Prepare this execution's agent log path — messages are appended as they stream
    // in. Named agent_log.md for the initial run or agent_log.followup-N.md for
    // followup N (see resolveCurrentAgentLogFileName), so each execution keeps its
    // own log instead of every followup overwriting the initial run's log.
    const taskFolderAbsForLog = outputFolder ? path.dirname(outputFolder) : null;
    const agentLogPath = outputFolder
      ? path.join(outputFolder, resolveCurrentAgentLogFileName(taskFolderAbsForLog!))
      : null;
    if (agentLogPath && !fs.existsSync(agentLogPath)) {
      fs.writeFileSync(agentLogPath, `# Agent log\n\n`, 'utf-8');
    }

    const args: string[] = [
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--allowedTools', CLAUDE_TOOLS,
      '--max-turns', String(CLAUDE_MAX_TURNS),
    ];

    if (model) {
      args.push('--model', model);
    }

    // Grant Claude read/write access to the task folder when provided.
    if (addDir) {
      args.push('--add-dir', addDir);
      // --add-dir grants file access but NOT config discovery, so CLAUDE.md in the
      // task folder is not auto-read. Inject it explicitly if it exists.
      const taskClaudeMd = path.join(addDir, 'CLAUDE.md');
      if (fs.existsSync(taskClaudeMd)) {
        args.push('--append-system-prompt-file', taskClaudeMd);
      }
    }

    args.push('-p', prompt);

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      // One-shot dispatch: don't save the session to disk.
      args.push('--no-session-persistence');
    }

    if (CLAUDE_SKIP_PERMISSIONS) {
      args.push('--dangerously-skip-permissions');
    }

    // On Windows, spawning .cmd with shell:true causes the shell to join all args
    // with spaces, breaking multi-word -p prompts. Use cmd.exe /c explicitly with
    // shell:false so each arg is passed as a discrete element to the child process.
    const [spawnBin, spawnArgs] = process.platform === 'win32'
      ? (['cmd.exe', ['/c', 'claude.cmd', ...args]] as const)
      : (['claude', args] as const);

    logger.info('claude_provider.spawn', {
      taskId,
      cwd,
      bin: spawnBin,
      resume: resumeSessionId,
      argFlags: args.filter(a => a.startsWith('--')),
      promptPreview: prompt.slice(0, 500),
      stdinPreview: stdinContent ? stdinContent.slice(0, 200) : null,
    });

    const proc = spawn(spawnBin, [...spawnArgs], {
      cwd,
      shell: false,
      env: { ...process.env },
      stdio: [stdinContent != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });

    if (opts.taskId) this._activeRuns.set(opts.taskId, proc);

    // If we have task content to pipe, write it to stdin then close the pipe.
    // Claude reads it as additional context before processing the -p instruction.
    if (stdinContent != null && proc.stdin) {
      proc.stdin.write(stdinContent, 'utf-8');
      proc.stdin.end();
    }

    const timeoutMs = TASK_TIMEOUT_MINUTES * 60 * 1000;
    const timer = createInactivityTimer(timeoutMs, () => {
      proc.kill('SIGTERM');
      logger.warn('claude_provider.timeout', { taskId, timeoutMinutes: TASK_TIMEOUT_MINUTES });
    });

    let sessionId: string | undefined;
    let stderrBuf = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrBuf += text;
      logger.warn('claude_provider.stderr', { taskId, text: text.slice(0, 500) });
    });

    // Track cumulative text sent so far to forward only new deltas.
    // Claude with --include-partial-messages sends GROWING SNAPSHOTS of the same message.
    // We track the last full text we processed to calculate deltas.
    // To handle multiple turns correctly (e.g. thinking -> plan -> action), we reset
    // when a turn is completed.
    let lastProcessedFullText = '';
    let currentMessageId: string | undefined;

    // Parse stdout line by line
    let lineBuf = '';
    let firstChunk = true;
    proc.stdout?.on('data', (chunk: Buffer) => {
      timer.reset();
      if (firstChunk) {
        firstChunk = false;
        logger.info('claude_provider.stdout_first_chunk', { taskId, bytes: chunk.length, preview: chunk.toString().slice(0, 200) });
      }
      lineBuf += chunk.toString();
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed);

          // If the event looks like a tool-use or thought turn, we clear the message deduplication
          // because assistant text might reset or restart after tool results arrive.
          if (event.type === 'assistant' && event.message?.id && event.message.id !== currentMessageId) {
             // Already handled below, but good to know
          }

          callbacks.onStream(event);

          if (event.type === 'result') {
            sessionId = event.session_id;
          }

          if (event.type === 'assistant' && event.message?.content) {
            const eventId = event.message.id;
            // Use message.partial to skip intermediate snapshot processing if available,
            // but Claude Code current stream-json often sends full growing content in assistant events.
            const isPartial = event.message.partial === true;

            const fullText = extractText(event.message.content);
            
            if (fullText) {
              let delta = '';
              
              // If we have a new ID, we reset the processed text to handle the new TURN
              if (eventId && eventId !== currentMessageId) {
                logger.info('claude_provider.turn_switch', { taskId, oldId: currentMessageId, newId: eventId });
                currentMessageId = eventId;
                lastProcessedFullText = '';
              }

              if (fullText.startsWith(lastProcessedFullText)) {
                delta = fullText.slice(lastProcessedFullText.length);
                if (delta) {
                   lastProcessedFullText = fullText;
                }
              } else {
                // If the stream resets or provides a version that doesn't include the previous prefix,
                // we treat it as a fresh start for this turn.
                delta = fullText;
                lastProcessedFullText = fullText;
              }

              if (delta) {
                // If the event is NOT partial (it's a final snapshot of a chunk/turn), 
                // we still send the delta but won't expect more growing snapshots for THIS specific response chunk.
                logger.info('claude_provider.assistant_message', { taskId, preview: delta.slice(0, 100).replace(/\n/g, '\\n'), eventId, isPartial });
                
                if (agentLogPath) {
                  try {
                    fs.appendFileSync(agentLogPath, delta, 'utf-8');
                  } catch (writeErr) {
                    logger.warn('claude_provider.agent_log_write_error', { taskId, error: String(writeErr) });
                  }
                }
                callbacks.onMessage(delta);
              }
            }
          }

          if (event.type === 'system') {
            if (event.subtype === 'init' && event.model) {
              logger.info('claude_provider.init', { taskId, model: event.model, sessionId: event.session_id });
              callbacks.onModelDiscovered?.(event.model as string);
            } else {
              logger.info('claude_provider.system_event', { taskId, subtype: event.subtype });
            }
          }
        } catch {
          // non-JSON line from Claude (e.g. startup info)
          logger.info('claude_provider.non_json_line', { taskId, line: trimmed.slice(0, 200) });
        }
      }
    });

    await new Promise<void>((resolve) => {
      proc.on('close', (code) => {
        if (opts.taskId) this._activeRuns.delete(opts.taskId);
        timer.clear();

        if (sessionId && taskId) {
          this.sessionCache.set(taskId, sessionId);
        }

        if (timer.fired) {
          callbacks.onComplete('blocked', `Task timed out after ${TASK_TIMEOUT_MINUTES} minutes`);
          resolve();
        } else if (code === 0) {
          callbacks.onComplete('completed');
          resolve();
        } else if (resumeSessionId && !isSessionRecoveryRetry && isStaleSessionError(stderrBuf)) {
          logger.warn('claude_provider.session_recovery', { taskId, staleSessionId: resumeSessionId });
          this.sessionCache.delete(taskId);
          const recoveryPrompt = buildStaleSessionRecoveryPrompt(taskFolderAbsForLog ?? '', prompt);
          this._spawnClaude({
            ...opts,
            prompt: recoveryPrompt,
            resumeSessionId: undefined,
            isSessionRecoveryRetry: true,
          }).then(resolve);
        } else {
          const reason = stderrBuf.slice(0, 512) || `exit code ${code}`;
          logger.warn('claude_provider.exit_nonzero', { taskId, code, stderr: stderrBuf.slice(0, 512) });
          callbacks.onComplete('failed', reason);
          resolve();
        }
      });

      proc.on('error', (err) => {
        if (opts.taskId) this._activeRuns.delete(opts.taskId);
        timer.clear();
        logger.error('claude_provider.spawn_error', { taskId, error: err.message });
        callbacks.onComplete('failed', err.message);
        resolve();
      });
    });
  }
}
