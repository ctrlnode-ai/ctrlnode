import { discoveredAgents, normalizeAgentId } from './agentDiscovery';

/** Returns the first available agent ID when no specific agentId is provided. */
export function defaultAgentId(): string | undefined {
  return Object.keys(discoveredAgents)[0];
}

/** Resolves incoming agent ID to canonical lowercase, falling back to first discovered agent. */
export function resolveTargetAgentId(agentId?: string): string | undefined {
  return normalizeAgentId(agentId) || defaultAgentId();
}
