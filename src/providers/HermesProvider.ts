/**
 * @file HermesProvider.ts
 * @description IProvider implementation backed by the `hermes chat` CLI (Nous Research, MIT).
 * Uses Option B: stateful CLI subprocess with per-agent sessionCache persisted to
 * `.hermes-sessions/` so conversations survive Bridge restarts.
 *
 * Agent Activity: tail `hermes logs agent -f` and format agent.log lines (official path).
 * Task output: stdout from `hermes chat -Q -q` (final answer only — not mixed into activity).
 *
 * @see https://hermes-agent.nousresearch.com/docs/reference/cli-commands
 *
 * Provider name: "hermes"
 *
 * Environment:
 *   HERMES_HOME             — optional path to Hermes home dir (default: ~/.hermes)
 *   HERMES_TIMEOUT_MINUTES  — hard timeout per task (default: 15)
 *   DEBUG=true              — tails agent.log at DEBUG level for richer tool traces
 *
 * Install: pip install hermes-agent  (requires Python 3.11+)
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import { CTRLNODE_ROOT, HERMES_HOME, HERMES_TIMEOUT_MINUTES } from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { augmentPromptForRepoMode, resolveRepoDispatchSpawn } from './repoDispatchContext.js';
import { writeOutputFile, writeAgentLog } from './providerFileUtils.js';
import {
  formatHermesLogLineForActivity,
  extractHermesSessionId,
  hermesLogLineMatchesSession,
  loadPersistedSessions,
  saveConversationId,
} from './hermesUtils.js';
import { setupHermesAgentHome, readHermesAgentsMd } from '../hermesAgentHome.js';
import { getHermesProfileHome, ensureHermesProfile } from '../hermesProfile.js';
import { listHermesModels, normalizeHermesModelId } from '../hermesModelUtils.js';

function pushActivity(
  line: string,
  activeSessionId: string | undefined,
  onFormatted: (text: string) => void,
  onSession: (id: string) => void,
): string | undefined {
  const sid = extractHermesSessionId(line) ?? activeSessionId;
  if (sid && !activeSessionId) onSession(sid);
  if (!hermesLogLineMatchesSession(line, sid ?? activeSessionId)) return sid ?? activeSessionId;

  const formatted = formatHermesLogLineForActivity(line);
  if (formatted) onFormatted(formatted);
  return sid ?? activeSessionId;
}

export class HermesProvider implements IProvider {
  readonly providerName = 'hermes';

  /** agentId → Hermes conversation_id (persisted to .hermes-sessions/ on disk) */
  private conversationIds: Map<string, string>;

  private get sessionsDir(): string {
    return path.join(CTRLNODE_ROOT, '.hermes-sessions');
  }

  constructor() {
    this.conversationIds = loadPersistedSessions(path.join(CTRLNODE_ROOT, '.hermes-sessions'));
    if (this.conversationIds.size > 0) {
      logger.info('hermes_provider.sessions_loaded', { count: this.conversationIds.size });
    }
  }

  async discoverAgents(): Promise<AgentSummary[]> {
    const { getGlobalHermesHome } = await import('../hermesProfile.js');
    const profilesDir = path.join(getGlobalHermesHome(), 'profiles');
    if (!fs.existsSync(profilesDir)) return [];
    try {
      return fs.readdirSync(profilesDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => ({
          id: e.name,
          name: e.name,
          workspace: path.join(profilesDir, e.name),
          provider: 'hermes',
          model: 'default',
          exists: fs.existsSync(path.join(profilesDir, e.name)),
          hostname: os.hostname(),
        }));
    } catch {
      return [];
    }
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const { agentId, taskId, prompt, taskFolderName } = params;

    const dispatch = resolveRepoDispatchSpawn(params, CTRLNODE_ROOT);
    const { taskFolder, outputFolder } = dispatch;
    fs.mkdirSync(outputFolder, { recursive: true });

    const resumeConv = params.skipSessionWipe ? this.conversationIds.get(agentId) : undefined;

    const agentInfo = discoveredAgents[agentId];
    if (agentInfo) {
      setupHermesAgentHome(agentId, {
        name: agentInfo.name,
        role: agentInfo.role,
        description: agentInfo.description,
        model: agentInfo.model,
      });
    }

    const inputDir = path.join(taskFolder, 'input');
    const inputFiles = fs.existsSync(inputDir) ? fs.readdirSync(inputDir).filter(f => f.endsWith('.md')) : [];
    let promptText = inputFiles.length > 0
      ? fs.readFileSync(path.join(inputDir, inputFiles[0]), 'utf8')
      : prompt;

    const agentsMd = readHermesAgentsMd(agentId);
    if (agentsMd?.trim()) {
      promptText = `${agentsMd.trim()}\n\n---\n\n${promptText}`;
    }
    promptText = augmentPromptForRepoMode(promptText, params);

    const hermesCwd = dispatch.isRepoMode ? dispatch.spawnCwd : taskFolder;
    logger.info('hermes_provider.repo_mode', {
      agentId,
      taskId,
      isRepoMode: dispatch.isRepoMode,
      cwd: hermesCwd,
      taskLogRelativePath: params.taskLogRelativePath ?? null,
    });

    const modelId = normalizeHermesModelId(agentInfo?.model);
    const cliArgs = resumeConv
      ? ['chat', '-Q', '--resume', resumeConv]
      : ['chat', '-Q'];
    if (modelId) cliArgs.push('-m', modelId);
    cliArgs.push('-q', promptText);

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (agentId && agentInfo) {
      ensureHermesProfile(agentId, {
        name: agentInfo.name,
        role: agentInfo.role,
        description: agentInfo.description,
        model: agentInfo.model,
      });
      env['HERMES_HOME'] = getHermesProfileHome(agentId);
    } else if (agentId) {
      env['HERMES_HOME'] = getHermesProfileHome(agentId);
      logger.warn('hermes_provider.profile_home_no_agent_info', { agentId });
    } else if (HERMES_HOME) {
      env['HERMES_HOME'] = HERMES_HOME;
    }

    const logArgs = ['logs', 'agent', '-f', '--since', '5s'];
    if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
      logArgs.push('--level', 'DEBUG');
    }

    logger.info('hermes_provider.dispatch', {
      agentId,
      taskId,
      resumingConv: resumeConv ?? null,
      skipSessionWipe: params.skipSessionWipe ?? false,
      taskFolder,
      logTail: logArgs.join(' '),
    });

    return new Promise<void>((resolve) => {
      let activeSessionId: string | undefined;
      let agentLogText = '';
      let outputText = '';
      let settled = false;

      const emitActivity = (text: string) => {
        agentLogText += text;
        callbacks.onMessage(text);
      };

      const logProc = spawn('hermes', logArgs, { env, stdio: ['ignore', 'pipe', 'ignore'] });
      let logBuffer = '';
      logProc.stdout.on('data', (chunk: Buffer) => {
        logBuffer += chunk.toString();
        const lines = logBuffer.split('\n');
        logBuffer = lines.pop() ?? '';
        for (const line of lines) {
          activeSessionId = pushActivity(line, activeSessionId, emitActivity, (id) => {
            activeSessionId = id;
          });
        }
      });

      const proc = spawn('hermes', cliArgs, {
        cwd: hermesCwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (status: 'completed' | 'failed' | 'blocked', reason?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        logProc.kill();
        if (logBuffer.trim()) {
          activeSessionId = pushActivity(logBuffer, activeSessionId, emitActivity, (id) => {
            activeSessionId = id;
          });
        }
        if (activeSessionId) {
          this.conversationIds.set(agentId, activeSessionId);
          saveConversationId(this.sessionsDir, agentId, activeSessionId);
        }
        if (taskFolderName) {
          const taskFullPath = path.join(CTRLNODE_ROOT, taskFolderName);
          const folderBasename = path.basename(taskFolderName);
          if (outputText.trim()) {
            writeOutputFile(taskId, taskFullPath, folderBasename, outputText, 'hermes_provider');
          }
          if (agentLogText.trim()) {
            writeAgentLog(taskId, taskFullPath, agentLogText, 'hermes_provider');
          }
        }
        logger.info('hermes_provider.complete', { agentId, taskId, status, sessionId: activeSessionId });
        callbacks.onComplete(status, reason);
        resolve();
      };

      const timeoutHandle = setTimeout(() => {
        proc.kill();
        finish('blocked', `Task timed out after ${HERMES_TIMEOUT_MINUTES} minutes`);
      }, HERMES_TIMEOUT_MINUTES * 60_000);

      // Final answer only — do not mirror stdout into Agent Activity (avoids glued log+text blobs).
      proc.stdout.on('data', (chunk: Buffer) => {
        outputText += chunk.toString();
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        logger.debug('hermes_provider.stderr', { agentId, text: text.slice(0, 300) });
        if (process.env.DEBUG === 'true' || process.env.DEBUG === '1') {
          for (const line of text.split('\n')) {
            activeSessionId = pushActivity(line, activeSessionId, emitActivity, (id) => {
              activeSessionId = id;
            });
          }
        }
      });

      proc.on('error', (err) => {
        logger.error('hermes_provider.spawn_error', { agentId, error: err.message });
        finish('failed', `Failed to start Hermes: ${err.message}`);
      });

      proc.on('close', (code) => {
        finish(code === 0 ? 'completed' : 'failed', code !== 0 ? `Exit code: ${code}` : undefined);
      });
    });
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    await this.dispatchTask(
      {
        agentId: params.agentId,
        taskId: params.taskId,
        prompt: params.message,
        workingDir: CTRLNODE_ROOT,
        skipSessionWipe: true,
      },
      callbacks,
    );
  }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {}

  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(agentId: string | undefined, _useCtrlnode: boolean): string | null {
    if (agentId) return getHermesProfileHome(agentId);
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
}
