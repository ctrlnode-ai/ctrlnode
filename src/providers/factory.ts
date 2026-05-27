import { IProvider } from './IProvider';
import { OpenClawProvider } from './OpenClawProvider';
import { ClaudeCodeProvider } from './ClaudeCodeProvider';
import { ClaudeAgentSdkProvider } from './ClaudeAgentSdkProvider';
import { CopilotAcpProvider } from './CopilotAcpProvider';
import { GeminiAcpProvider } from './GeminiAcpProvider';
import { CodexSdkProvider } from './CodexSdkProvider';
import { CursorSdkProvider } from './CursorSdkProvider';
import { HermesAcpProvider } from './HermesAcpProvider';

const KNOWN_PROVIDERS = new Set(['openclaw', 'claude', 'claude-sdk', 'copilot', 'gemini', 'codex', 'cursor', 'hermes']);

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
  return new OpenClawProvider();
}

/** Create one provider instance per name. Deduplicates repeated names. */
export function createProviders(names: string[]): IProvider[] {
  const seen = new Set<string>();
  return names
    .filter(n => { if (seen.has(n)) return false; seen.add(n); return true; })
    .map(n => createProvider(n));
}
