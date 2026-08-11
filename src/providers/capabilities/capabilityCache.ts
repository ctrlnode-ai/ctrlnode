/**
 * @file capabilityCache.ts
 * @description Short-lived in-process cache for discovered skill catalogues.
 *
 * Session-booting adapters (Claude) take ~9-19s to answer, which is far too slow to run on
 * every menu open. Skills change rarely, so the first open pays the cost and subsequent ones
 * are instant until the entry expires.
 */

import { logger } from '../../logger.js';
import {
  CAPABILITY_CACHE_TTL_MS,
  DiscoverCapabilitiesParams,
  ProviderCapabilities,
} from './types.js';

interface CacheEntry {
  capabilities: ProviderCapabilities;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function buildCapabilityCacheKey(
  providerName: string,
  params: DiscoverCapabilitiesParams,
): string {
  const agent = params.agentId ?? 'no-agent';
  const directory = params.workingDirectory.replace(/\\/g, '/').toLowerCase();
  return `${providerName}|${agent}|${params.taskMode}|${directory}`;
}

export function readCapabilityCache(key: string): ProviderCapabilities | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.capabilities;
}

/**
 * Stores a catalogue, unless discovery reported a warning.
 *
 * Caching a timed-out or failed lookup would pin an empty menu in place for the whole TTL,
 * so only clean results are kept and failures are retried on the next open.
 */
export function writeCapabilityCache(
  key: string,
  capabilities: ProviderCapabilities,
  expiresAt = Date.now() + CAPABILITY_CACHE_TTL_MS,
): void {
  if (capabilities.discovery.warnings.length > 0) return;

  cache.set(key, { capabilities, expiresAt });
  logger.debug('capabilities.cached', { key, skills: capabilities.skills.length });
}

export function clearCapabilityCache(): void {
  cache.clear();
}
