import { IProvider } from './IProvider.js';
import { OpenClawProvider } from './OpenClawProvider.js';
import { ClaudeCodeProvider } from './ClaudeCodeProvider.js';
import { ClaudeAgentSdkProvider } from './ClaudeAgentSdkProvider.js';
import { CopilotAcpProvider } from './CopilotAcpProvider.js';
import { GeminiAcpProvider } from './GeminiAcpProvider.js';
import { CodexSdkProvider } from './CodexSdkProvider.js';
import { CursorSdkProvider } from './CursorSdkProvider.js';
import { HermesAcpProvider } from './HermesAcpProvider.js';
import { OpenRouterProvider } from './OpenRouterProvider.js';
import { OllamaProvider } from './OllamaProvider.js';

/**
 * Providers this Bridge build actually knows how to construct. Exported so config.ts
 * can intersect it with the canonical provider list fetched from the backend
 * (GET /api/agent-types) — the backend is the source of truth for "which providers
 * exist in the product", this Set is the source of truth for "which ones THIS build
 * has code for". A provider the backend knows about but this (older) Bridge build
 * doesn't is silently skipped rather than crashing on an unrecognized name.
 */
export const KNOWN_PROVIDERS = new Set(['openclaw', 'claude', 'claude-sdk', 'copilot', 'gemini', 'codex', 'cursor', 'hermes', 'openrouter', 'ollama']);

export function createProvider(name: string): IProvider {
  if (!KNOWN_PROVIDERS.has(name)) {
    console.error(`Unknown provider: "${name}". Valid values: ${[...KNOWN_PROVIDERS].join(', ')}`);
    process.exit(1);
  }
  if (name === 'claude')       return new ClaudeAgentSdkProvider();
  if (name === 'claude-sdk')   return new ClaudeAgentSdkProvider();
  if (name === 'copilot')      return new CopilotAcpProvider();
  if (name === 'gemini')       return new GeminiAcpProvider();
  if (name === 'codex')        return new CodexSdkProvider();
  if (name === 'cursor')       return new CursorSdkProvider();
  if (name === 'hermes')       return new HermesAcpProvider();
  if (name === 'openrouter')   return new OpenRouterProvider();
  if (name === 'ollama')       return new OllamaProvider();
  return new OpenClawProvider();
}

/** Create one provider instance per name. Deduplicates repeated names. */
export function createProviders(names: string[]): IProvider[] {
  const seen = new Set<string>();
  return names
    .filter(n => { if (seen.has(n)) return false; seen.add(n); return true; })
    .map(n => createProvider(n));
}
