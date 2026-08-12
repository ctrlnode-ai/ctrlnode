/**
 * @file index.ts
 * @description Maps a provider name to its capability adapter.
 *
 * Providers without an adapter return an empty catalogue with `unsupported` discovery rather
 * than an error — the slash menu then renders an honest "no skills available" state.
 */

import { logger } from '../../logger.js';
import { discoverCodexCapabilities } from './codexCapabilities.js';
import { discoverCopilotCapabilities } from './copilotCapabilities.js';
import { discoverCursorCapabilities } from './cursorCapabilities.js';
import { discoverGeminiCapabilities } from './geminiCapabilities.js';
import {
  DiscoverCapabilitiesParams,
  ProviderCapabilities,
  emptyCapabilities,
} from './types.js';

export * from './types.js';
export * from './capabilityCache.js';

/**
 * Adapters that need no provider instance. `claude-sdk` is absent on purpose: it needs the
 * provider's own SDK options, so ClaudeAgentSdkProvider implements discoverCapabilities itself.
 */
const STATELESS_ADAPTERS: Record<string, (params: DiscoverCapabilitiesParams) => ProviderCapabilities> = {
  codex: discoverCodexCapabilities,
  copilot: discoverCopilotCapabilities,
  cursor: discoverCursorCapabilities,
  gemini: discoverGeminiCapabilities,
};

export function hasStatelessAdapter(providerName: string): boolean {
  return providerName in STATELESS_ADAPTERS;
}

export function discoverStatelessCapabilities(
  providerName: string,
  params: DiscoverCapabilitiesParams,
): ProviderCapabilities {
  const adapter = STATELESS_ADAPTERS[providerName];
  if (!adapter) return emptyCapabilities(providerName, params);

  try {
    return adapter(params);
  } catch (e) {
    logger.warn('capabilities.adapter_failed', { provider: providerName, err: String(e) });
    const fallback = emptyCapabilities(providerName, params);
    fallback.discovery.warnings.push('adapter_failed');
    return fallback;
  }
}
