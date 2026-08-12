/**
 * @file MultiProvider.ts
 * @description Composite IProvider that aggregates multiple sub-providers into
 * a single interface.  Allows running e.g. Copilot + Cursor from one Bridge
 * process (PROVIDERS=copilot,cursor).
 *
 * Agent ownership:
 *   Each agent ID discovered by a sub-provider is mapped to that provider.
 *   Task dispatch/session calls are routed to the owning provider.
 *   Ties are broken in PROVIDERS order (first one wins if IDs collide).
 */

import { logger } from '../logger.js';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams, GenerateStructuredPlanParams, ProviderHealth } from './IProvider.js';
import { AgentSummary } from '../types.js';
import { discoveredAgents, normalizeAgentId } from '../agentDiscovery.js';
import {
  DiscoverCapabilitiesParams,
  ProviderCapabilities,
  discoverStatelessCapabilities,
  emptyCapabilities,
} from './capabilities/index.js';

export class MultiProvider implements IProvider {
  private readonly providers: IProvider[];
  /** agentId → the provider that owns that agent */
  private agentOwner = new Map<string, IProvider>();

  readonly providerName = 'multi';

  constructor(providers: IProvider[]) {
    if (providers.length === 0) throw new Error('MultiProvider requires at least one provider');
    this.providers = providers;
  }

  // ── Discovery ────────────────────────────────────────────────────────────────

  async discoverAgents(): Promise<AgentSummary[]> {
    const results = await Promise.allSettled(this.providers.map(p => p.discoverAgents()));
    const all: AgentSummary[] = [];

    for (let i = 0; i < this.providers.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.error('multi_provider.discover_failed', { providerIndex: i, error: result.reason?.message });
        continue;
      }
      for (const agent of result.value) {
        const normId = normalizeAgentId(agent.id);
        if (!this.agentOwner.has(normId)) {
          this.agentOwner.set(normId, this.providers[i]);
        }
        all.push(agent);
      }
    }
    return all;
  }

  // ── Task dispatch ─────────────────────────────────────────────────────────────

  async dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void> {
    const owner = this.resolveOwner(params.agentId);
    return owner.dispatchTask(params, callbacks);
  }

  async sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void> {
    const owner = this.resolveOwner(params.agentId);
    return owner.sendToSession(params, callbacks);
  }

  async generateStructuredPlan(params: GenerateStructuredPlanParams): Promise<string> {
    const owner = this.resolveOwner(params.agentId);
    if (!owner.generateStructuredPlan) {
      throw new Error('GRAPH_GENERATION_UNSUPPORTED_PROVIDER');
    }
    return owner.generateStructuredPlan(params);
  }

  // ── Tool invocation ───────────────────────────────────────────────────────────

  async invokeTool(msg: any, sendToSaas: (payload: any) => void): Promise<void> {
    const agentId: string | undefined = msg?.agentId;
    if (agentId) {
      const owner = this.agentOwner.get(normalizeAgentId(agentId));
      if (owner) return owner.invokeTool(msg, sendToSaas);
    }
    // Fallback: try providers in order until one handles it without throwing
    for (const p of this.providers) {
      try {
        await p.invokeTool(msg, sendToSaas);
        return;
      } catch {
        // try next
      }
    }
    logger.warn('multi_provider.invoke_tool_unhandled', { agentId });
  }

  // ── Cancellation & input relay ────────────────────────────────────────────────

  async cancelRun(taskId: string): Promise<void> {
    // Fan out to all sub-providers — each silently no-ops if it doesn't own this taskId.
    const cancellers = this.providers.filter(p => typeof p.cancelRun === 'function');
    if (cancellers.length === 0) {
      logger.warn('multi_provider.cancel_run_not_supported', { taskId });
      return;
    }
    await Promise.allSettled(cancellers.map(p => p.cancelRun!(taskId)));
    logger.info('multi_provider.cancel_run_dispatched', { taskId, providers: cancellers.map(p => p.providerName) });
  }

  async deliverInput(taskId: string, text: string): Promise<void> {
    let handled = false;
    for (const p of this.providers) {
      if (typeof p.deliverInput === 'function') {
        try {
          await p.deliverInput(taskId, text);
          handled = true;
          break;
        } catch {
          // try next
        }
      }
    }
    if (!handled) {
      logger.warn('multi_provider.deliver_input_not_supported', { taskId });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    await Promise.allSettled(this.providers.map(p => p.dispose()));
  }

  // ── Agent management ──────────────────────────────────────────────────────────

  async deleteAgent(agentId: string): Promise<boolean> {
    const owner = this.agentOwner.get(normalizeAgentId(agentId));
    if (!owner) return false;
    return owner.deleteAgent(agentId);
  }

  // ── Filesystem ────────────────────────────────────────────────────────────────

  resolveFilesystemBase(agentId: string | undefined, useCtrlnode: boolean): string | null {
    if (agentId) {
      const normId = normalizeAgentId(agentId);
      const owner = this.agentOwner.get(normId);
      if (owner) return owner.resolveFilesystemBase(normId, useCtrlnode);
    }
    // Fallback: first provider that returns a non-null base
    for (const p of this.providers) {
      const base = p.resolveFilesystemBase(agentId, useCtrlnode);
      if (base !== null) return base;
    }
    return null;
  }

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean, agentId?: string): string | null {
    const provider = this.providers.find(p => p.providerName === providerName);
    if (provider) return provider.resolveFilesystemBase(agentId, useCtrlnode);
    // Fallback to first provider
    return this.providers[0]?.resolveFilesystemBase(agentId, useCtrlnode) ?? null;
  }

  resolveWorkspaceCreationBase(useCtrlnode: boolean): string | null {
    for (const p of this.providers) {
      const base = p.resolveWorkspaceCreationBase(useCtrlnode);
      if (base !== null) return base;
    }
    return null;
  }

  async listModels(): Promise<string[]> {
    const results = await Promise.allSettled(
      this.providers.filter(p => p.listModels).map(p => p.listModels!()),
    );
    // MultiProvider returns a flat deduplicated list across all sub-providers.
    const seen = new Set<string>();
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const id of r.value) seen.add(id);
      }
    }
    return [...seen].sort();
  }

  /**
   * Runs isAvailable() on all sub-providers concurrently.
   * Returns a map of providerName → boolean.
   * Providers that don't implement isAvailable() are assumed available (true).
   */
  async checkAllProviders(): Promise<Record<string, ProviderHealth>> {
    const results = await Promise.allSettled(
      this.providers.map(async p => ({
        name: p.providerName,
        health: p.checkHealth
          ? await p.checkHealth()
          : await (async () => {
              const available = p.isAvailable ? await p.isAvailable() : true;
              return available ? { available } : { available, reason: 'service_unreachable' as const };
            })(),
      })),
    );
    const health: Record<string, ProviderHealth> = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        health[r.value.name] = r.value.health;
      }
    }
    return health;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  // ── Capability discovery ──────────────────────────────────────────────────────

  /**
   * Routes to the agent's owning provider so the catalogue reflects the provider that will
   * actually run the task. An unknown or inactive agent yields an empty catalogue with a
   * warning rather than throwing: the slash menu must degrade, never break the task form.
   */
  async discoverCapabilities(params: DiscoverCapabilitiesParams): Promise<ProviderCapabilities> {
    let owner: IProvider;
    try {
      owner = this.resolveOwner(params.agentId ?? '');
    } catch (e) {
      logger.warn('multi_provider.capabilities_owner_unresolved', {
        agentId: params.agentId,
        err: String(e),
      });
      const unresolved = emptyCapabilities('unknown', params);
      unresolved.discovery.warnings.push('agent_provider_unknown');
      return unresolved;
    }

    if (owner.discoverCapabilities) return owner.discoverCapabilities(params);
    return discoverStatelessCapabilities(owner.providerName, params);
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private resolveOwner(agentId: string): IProvider {
    const normId = normalizeAgentId(agentId);

    // Authoritative: sync_*_agents may register provider after openclaw discoverAgents()
    // already cached this id in agentOwner — always prefer discoveredAgents.provider.
    const registeredProvider = discoveredAgents[normId]?.provider;
    if (registeredProvider) {
      const byName = this.providers.find(p => p.providerName === registeredProvider);
      if (byName) {
        this.agentOwner.set(normId, byName);
        return byName;
      }
      const active = this.providers.map(p => p.providerName).join(', ');
      logger.warn('multi_provider.owner_provider_inactive', { agentId: normId, providerName: registeredProvider, active });
      throw new Error(`PROVIDER_NOT_ACTIVE:${registeredProvider}`);
    }

    const owner = this.agentOwner.get(normId);
    if (owner) return owner;

    // Legacy fallback when provider field is missing (openclaw-only agents).
    const providerName = this.providers.find(p => p.providerName === 'openclaw') ? 'openclaw' : undefined;
    if (providerName) {
      const byName = this.providers.find(p => p.providerName === providerName);
      if (byName) {
        this.agentOwner.set(normId, byName); // cache for next time
        return byName;
      }
      // Provider is registered for this agent but NOT active in this Bridge instance.
      // Throw explicitly — silent fallback to providers[0] would run the task on the
      // wrong provider without any indication to the user.
      const active = this.providers.map(p => p.providerName).join(', ');
      logger.warn('multi_provider.owner_provider_inactive', { agentId: normId, providerName, active });
      throw new Error(`PROVIDER_NOT_ACTIVE:${providerName}`);
    }

    // Truly unknown agent — only safe to fall back to OpenClaw, which discovers
    // agents dynamically from openclaw.json. Any other provider would silently
    // run the task on the wrong backend.
    const fallback = this.providers[0];
    if (fallback.providerName === 'openclaw') {
      logger.warn('multi_provider.owner_not_found.fallback_openclaw', { agentId: normId });
      return fallback;
    }
    const activeProviders = this.providers.map(p => p.providerName).join(', ');
    logger.warn('multi_provider.owner_unknown_no_safe_fallback', { agentId: normId, activeProviders });
    throw new Error(`AGENT_PROVIDER_UNKNOWN:${normId}`);
  }
}
