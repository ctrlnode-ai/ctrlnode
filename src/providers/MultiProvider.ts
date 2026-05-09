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

import { logger } from '../logger';
import { IProvider, DispatchTaskParams, TaskCallbacks, SendToSessionParams } from './IProvider';
import { AgentSummary } from '../types';
import { discoveredAgents, normalizeAgentId } from '../agentDiscovery';

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

  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean): string | null {
    const provider = this.providers.find(p => p.providerName === providerName);
    if (provider) return provider.resolveFilesystemBase(undefined, useCtrlnode);
    // Fallback to first provider
    return this.providers[0]?.resolveFilesystemBase(undefined, useCtrlnode) ?? null;
  }

  resolveWorkspaceCreationBase(useCtrlnode: boolean): string | null {
    for (const p of this.providers) {
      const base = p.resolveWorkspaceCreationBase(useCtrlnode);
      if (base !== null) return base;
    }
    return null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private resolveOwner(agentId: string): IProvider {
    const normId = normalizeAgentId(agentId);

    const owner = this.agentOwner.get(normId);
    if (owner) return owner;

    // Secondary lookup: agent was registered via sync_copilot_agents / sync_cursor_agents
    // (directly into discoveredAgents) without going through discoverAgents(), so
    // agentOwner was never populated for it. Match by the provider name stored in the registry.
    const providerName = discoveredAgents[normId]?.provider
      ?? (this.providers.find(p => p.providerName === 'openclaw') ? 'openclaw' : undefined);
    if (providerName) {
      const byName = this.providers.find(p => p.providerName === providerName);
      if (byName) {
        this.agentOwner.set(normId, byName); // cache for next time
        return byName;
      }
    }

    // Fallback to first provider if agent was auto-registered or not yet discovered
    logger.warn('multi_provider.owner_not_found.fallback', { agentId: normId, providerName });
    return this.providers[0];
  }
}
