/**
 * OllamaProvider — IProvider implementation for 100% local inference via Ollama's
 * OpenAI-compatible endpoint. No API key. Model catalog is whatever the user has
 * locally pulled (`ollama pull <model>`), not a remote catalog.
 * See management/docs/07-07-ollama-local-provider-study.md for the full design
 * rationale, especially the num_ctx gotcha (§5) and hardware/model guidance.
 */
import fs from 'fs';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import { runToolLoop } from './openAiCompatToolLoop.js';
import {
  CTRLNODE_ROOT, OLLAMA_HOST, OLLAMA_DEFAULT_MODEL, OLLAMA_ALLOWED_MODELS,
  OLLAMA_MAX_TURNS, OLLAMA_NUM_CTX, OLLAMA_TASK_TIMEOUT_MINUTES,
} from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { isRepoTaskMode, resolveTaskPaths } from './repoDispatchContext.js';
import { detectStatusTag, writeTaskOutputs } from './providerFileUtils.js';

/**
 * Resolves which model to use for a task, enforcing the allowlist.
 * Pure function — exported so tests can exercise the allowlist logic
 * deterministically without depending on process.env at test-run time.
 *
 * Unlike OpenRouter, Ollama has no sensible universal default model, so when
 * the agent has no model configured (or the provider placeholder) AND
 * defaultModel is empty, this returns null rather than an empty string.
 */
export function resolveOllamaModel(
  agentModel: string | undefined,
  defaultModel: string,
  allowedModels: string[],
  providerName: string,
): string | null {
  const model = agentModel && agentModel !== providerName ? agentModel : defaultModel;
  if (!model) return null;
  if (allowedModels.length > 0 && !allowedModels.includes(model)) return null;
  return model;
}

export class OllamaProvider implements IProvider {
  readonly providerName = 'ollama';
  private readonly _cancelFlags = new Map<string, boolean>();

  async discoverAgents(): Promise<AgentSummary[]> { return []; }

  async invokeTool(_msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    sendToSaas({ action: 'tool_result', error: 'NOT_SUPPORTED_BY_PROVIDER' });
  }

  async dispose(): Promise<void> {}
  async deleteAgent(_agentId: string): Promise<boolean> { return false; }

  resolveFilesystemBase(_agentId: string | undefined, _useCtrlnode: boolean): string | null {
    return CTRLNODE_ROOT;
  }
  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    return providerName === this.providerName ? this.resolveFilesystemBase(undefined, useCtrlnode) : null;
  }
  resolveWorkspaceCreationBase(_useCtrlnode: boolean): string | null { return null; }

  async listModels(): Promise<string[]> {
    try {
      const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) return [];
      const names = ((await resp.json() as any).models ?? []).map((m: any) => m.name as string).filter(Boolean);
      const filtered = OLLAMA_ALLOWED_MODELS.length > 0 ? names.filter((n: string) => OLLAMA_ALLOWED_MODELS.includes(n)) : names;
      return filtered.sort();
    } catch { return []; }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      return resp.ok;
    } catch { return false; }
  }

  async cancelRun(taskId: string): Promise<void> {
    if (this._cancelFlags.has(taskId)) this._cancelFlags.set(taskId, true);
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    if (isRepoTaskMode(params)) {
      callbacks.onComplete('blocked', 'Ollama provider does not yet support repo-mode tasks (taskMode: "repo"). Use a different provider for repository-checkout pipeline tasks.');
      return;
    }
    const agentInfo = discoveredAgents[params.agentId];
    const { taskFolder } = resolveTaskPaths(params.taskFolderName, params.taskId);
    await this._run(params.taskId, params.prompt, callbacks, agentInfo?.model, params.taskFolderName, taskFolder);
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const agentInfo = discoveredAgents[params.agentId];
    const { taskFolder } = resolveTaskPaths(params.taskFolderName, params.taskId);
    await this._run(params.taskId, params.message, callbacks, agentInfo?.model, params.taskFolderName, taskFolder);
  }

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const model = this._resolveModel(discoveredAgents[params.agentId]?.model);
    if (!model) throw new Error('GRAPH_GENERATION_UNSUPPORTED_MODEL');

    const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: params.prompt }],
        stream: false,
        options: { num_ctx: OLLAMA_NUM_CTX },
      }),
      signal: AbortSignal.timeout(params.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GRAPH_GENERATION_PROVIDER_ERROR: Ollama HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const content = (await response.json() as any).message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('GRAPH_GENERATION_EMPTY_RESPONSE');
    return content.trim();
  }

  private async _run(
    taskId: string, prompt: string, callbacks: TaskCallbacks, agentModel: string | undefined,
    taskFolderName: string | undefined, spawnCwd: string,
  ): Promise<void> {
    fs.mkdirSync(spawnCwd, { recursive: true });

    const model = this._resolveModel(agentModel);
    if (!model) { callbacks.onComplete('failed', 'No Ollama model configured, or model not in OLLAMA_ALLOWED_MODELS'); return; }

    const installed = await this.listModels();
    if (installed.length > 0 && !installed.includes(model)) {
      callbacks.onComplete('failed', `Model "${model}" is not installed locally. Run: ollama pull ${model}`);
      return;
    }
    callbacks.onModelDiscovered?.(model);

    this._cancelFlags.set(taskId, false);

    try {
      const { accumulatedText, activityLog, finishedNaturally } = await runToolLoop(
        taskId, model, this._systemPrompt(spawnCwd), prompt, spawnCwd,
        {
          baseUrl: OLLAMA_HOST,
          authHeaders: () => ({}),
          extraBody: { options: { num_ctx: OLLAMA_NUM_CTX } },
          maxTurns: OLLAMA_MAX_TURNS,
          logPrefix: 'ollama',
          requestTimeoutMs: (OLLAMA_TASK_TIMEOUT_MINUTES + 1) * 60_000,
        },
        callbacks,
        () => this._cancelFlags.get(taskId) ?? false,
      );

      this._cancelFlags.delete(taskId);
      writeTaskOutputs(taskId, taskFolderName ?? '', accumulatedText, 'ollama', activityLog);
      const completion = detectStatusTag(accumulatedText);
      callbacks.onComplete(
        !finishedNaturally ? 'blocked' : completion.status,
        !finishedNaturally ? 'Max turns reached without a final answer' : completion.reason,
      );
    } catch (err: any) {
      this._cancelFlags.delete(taskId);
      const isConnectionFailure = /fetch failed|ECONNREFUSED/i.test(err?.message ?? '');
      logger.error('ollama.error', { taskId, error: err?.message, isConnectionFailure });
      callbacks.onComplete('failed', isConnectionFailure
        ? 'Cannot reach Ollama — is it running? (ollama serve)'
        : err?.message);
    }
  }

  private _resolveModel(agentModel: string | undefined): string | null {
    return resolveOllamaModel(agentModel, OLLAMA_DEFAULT_MODEL, OLLAMA_ALLOWED_MODELS, this.providerName);
  }

  private _systemPrompt(cwd: string): string {
    return `You are an autonomous coding agent with Read/Write/Edit/Glob/Grep tools under ${cwd}. No shell access. End with <TASK_COMPLETED:done> / <TASK_BLOCKED:reason> / <TASK_FAILED:reason>.`;
  }
}
