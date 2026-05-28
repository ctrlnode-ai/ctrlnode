/**
 * @file setupEnv.ts
 * @description Helpers for merging workspace .env and optional provider API key prompts.
 */

import fs from 'fs';

export type ProviderApiKeys = {
  cursorApiKey?: string;
  anthropicApiKey?: string;
};

/** Merge vars into an existing KEY=value .env file (create or update keys). */
export function mergeEnvFile(envFile: string, vars: Record<string, string>): void {
  const map = new Map<string, string>();
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) map.set(m[1], m[2]);
    }
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value) map.set(key, value);
  }
  const lines = [...map.entries()].map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envFile, lines.join('\n') + '\n', 'utf8');
}

/** Ask optionally for Cursor and Claude API keys (after workspace is chosen). */
export async function promptProviderApiKeys(
  ask: (question: string) => Promise<string>,
): Promise<ProviderApiKeys> {
  console.log('');
  console.log('Optional: provider API keys');
  console.log('  For Cursor and Claude SDK agents. Answer N or press Enter to skip.');
  console.log('  You can add them later in workspace/.ctrlnode/.env');
  console.log('');

  let cursorApiKey = '';
  const useCursor = await ask('Configure Cursor API key (CURSOR_API_KEY)? (y/N): ');
  if (/^y(es)?$/i.test(useCursor)) {
    cursorApiKey = await ask('CURSOR_API_KEY: ');
  }

  let anthropicApiKey = '';
  const useClaude = await ask('Configure Claude API key (ANTHROPIC_API_KEY)? (y/N): ');
  if (/^y(es)?$/i.test(useClaude)) {
    anthropicApiKey = await ask('ANTHROPIC_API_KEY: ');
  }

  console.log('');
  return {
    ...(cursorApiKey ? { cursorApiKey } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
  };
}
