/**
 * OpenRouterProvider — IProvider implementation using the OpenRouter REST API
 * (https://openrouter.ai/api/v1/chat/completions) via the shared tool loop.
 * Billing: pay-as-you-go with a user-owned OPENROUTER_API_KEY (BYOK, like Cursor).
 * See management/docs/07-07-openrouter-provider-b-implementation-payg.md for the
 * full design rationale (cost accounting, 402 handling, allowlist).
 */
import fs from 'fs';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider.js';
import { AgentSummary } from '../types.js';
import { runToolLoop } from './openAiCompatToolLoop.js';
import {
  CTRLNODE_ROOT, OPENROUTER_API_KEY, OPENROUTER_API_BASE, OPENROUTER_DEFAULT_MODEL,
  OPENROUTER_ALLOWED_MODELS, OPENROUTER_MAX_TURNS, OPENROUTER_MAX_TOKENS_PER_TURN,
  TASK_TIMEOUT_MINUTES,
} from '../config.js';
import { discoveredAgents } from '../agentDiscovery.js';
import { logger } from '../logger.js';
import { isRepoTaskMode, resolveTaskPaths } from './repoDispatchContext.js';
import { detectStatusTag, writeTaskOutputs } from './providerFileUtils.js';

/**
 * Resolves which model to use for a task, enforcing the allowlist.
 * Pure function — exported so tests can exercise the allowlist logic
 * deterministically without depending on process.env at test-run time.
 */
export function resolveOpenRouterModel(
  agentModel: string | undefined,
  defaultModel: string,
  allowedModels: string[],
  providerName: string,
): string | null {
  const model = agentModel && agentModel !== providerName ? agentModel : defaultModel;
  if (allowedModels.length > 0 && !allowedModels.includes(model)) return null;
  return model;
}

export class OpenRouterProvider implements IProvider {
  readonly providerName = 'openrouter';
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
    if (!OPENROUTER_API_KEY) return [];
    try {
      const resp = await fetch(`${OPENROUTER_API_BASE}/v1/models?supported_parameters=tools`, {
        headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!resp.ok) return [];
      const ids = ((await resp.json() as any).data ?? []).map((m: any) => m.id as string).filter(Boolean);
      const filtered = OPENROUTER_ALLOWED_MODELS.length > 0 ? ids.filter((id: string) => OPENROUTER_ALLOWED_MODELS.includes(id)) : ids;
      return filtered.sort();
    } catch { return []; }
  }

  async isAvailable(): Promise<boolean> { return !!OPENROUTER_API_KEY; }

  async cancelRun(taskId: string): Promise<void> {
    if (this._cancelFlags.has(taskId)) this._cancelFlags.set(taskId, true);
  }

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    if (isRepoTaskMode(params)) {
      callbacks.onComplete('blocked', 'OpenRouter provider does not yet support repo-mode tasks (taskMode: "repo"). Use a different provider for repository-checkout pipeline tasks.');
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

  private async _run(
    taskId: string, prompt: string, callbacks: TaskCallbacks, agentModel: string | undefined,
    taskFolderName: string | undefined, spawnCwd: string,
  ): Promise<void> {
    fs.mkdirSync(spawnCwd, { recursive: true });
    const model = this._resolveModel(agentModel);
    if (!model) { callbacks.onComplete('failed', `Model "${agentModel}" is not in OPENROUTER_ALLOWED_MODELS`); return; }
    callbacks.onModelDiscovered?.(model);

    this._cancelFlags.set(taskId, false);
    let totalCostUsd = 0;

    try {
      const { accumulatedText, activityLog, finishedNaturally } = await runToolLoop(
        taskId, model, this._systemPrompt(spawnCwd), prompt, spawnCwd,
        {
          baseUrl: OPENROUTER_API_BASE,
          authHeaders: () => ({ Authorization: `Bearer ${OPENROUTER_API_KEY}` }),
          extraBody: { max_tokens: OPENROUTER_MAX_TOKENS_PER_TURN },
          maxTurns: OPENROUTER_MAX_TURNS,
          onTurnResponse: (data) => { totalCostUsd += data.usage?.cost ?? 0; },
          logPrefix: 'openrouter',
          requestTimeoutMs: (TASK_TIMEOUT_MINUTES + 1) * 60_000,
        },
        callbacks,
        () => this._cancelFlags.get(taskId) ?? false,
      );

      this._cancelFlags.delete(taskId);
      // Cost goes in agent_log.md only (activityLog) — never in the fallback output.md
      // (accumulatedText), which should stay just the model's final answer.
      const activityLogWithCost = `${activityLog}\n\n---\n\n**Cost:** $${totalCostUsd.toFixed(4)} (OpenRouter, model: ${model})`;
      writeTaskOutputs(taskId, taskFolderName ?? '', accumulatedText, 'openrouter', activityLogWithCost);
      logger.info('openrouter.cost_summary', { taskId, totalCostUsd: totalCostUsd.toFixed(4) });
      const completion = detectStatusTag(accumulatedText);
      callbacks.onComplete(
        !finishedNaturally ? 'blocked' : completion.status,
        !finishedNaturally ? 'Max turns reached without a final answer' : completion.reason,
      );
    } catch (err: any) {
      this._cancelFlags.delete(taskId);
      const isPaymentRequired = err?.status === 402;
      logger.error('openrouter.error', { taskId, error: err?.message, isPaymentRequired });
      callbacks.onComplete(isPaymentRequired ? 'blocked' : 'failed',
        isPaymentRequired ? 'OpenRouter credit balance exhausted (402)' : err?.message);
    }
  }

  private _resolveModel(agentModel: string | undefined): string | null {
    return resolveOpenRouterModel(agentModel, OPENROUTER_DEFAULT_MODEL, OPENROUTER_ALLOWED_MODELS, this.providerName);
  }

  private _systemPrompt(cwd: string): string {
    return `You are an autonomous coding agent with Read/Write/Edit/Glob/Grep tools under ${cwd}. No shell access. End with <TASK_COMPLETED:done> / <TASK_BLOCKED:reason> / <TASK_FAILED:reason>.`;
  }
}
