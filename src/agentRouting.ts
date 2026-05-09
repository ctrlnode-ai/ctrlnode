import { normalizeAgentId } from './agentDiscovery';

/** Resolves incoming agent ID to canonical lowercase. Returns undefined if not provided. */
export function resolveTargetAgentId(agentId?: string): string | undefined {
  return normalizeAgentId(agentId);
}
