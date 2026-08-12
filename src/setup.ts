/**
 * @file setup.ts
 * @description Interactive setup wizard — runs when ctrlnode is invoked with --setup.
 * Prompts for workspace, optional provider API keys and pairing token, then writes .env.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { createInterface } from 'readline';
import { mergeEnvFile, promptProviderApiKeys } from './setupEnv.js';
import { runLogin } from './login.js';
import { canonicalBridgeEnvPath } from './workspaceTrust.js';

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

export async function runSetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const askLine = (q: string) => ask(rl, q);

  console.log('');
  console.log('CtrlNode Setup');
  console.log('--------------');
  console.log('');

  // ── Workspace ────────────────────────────────────────────────────────────────
  console.log('Where is your workspace?');
  console.log('  This is the root folder where ctrlnode will read and write files.');
  console.log('  For security, the bridge cannot access anything outside this folder.');
  console.log('  If you are a developer, point this to your source code root (e.g. ~/code).');
  const defaultWorkspace = process.env.BASE_PATH || os.homedir();
  const workspaceRaw = await askLine(`Workspace [${defaultWorkspace}]: `);
  const workspace = workspaceRaw || defaultWorkspace;
  console.log(`  Workspace: ${workspace}\n`);

  // ── Optional provider API keys ───────────────────────────────────────────────
  const providerKeys = await promptProviderApiKeys(askLine);

  // ── .env location (needed before pairing so browser login can write directly) ──
  const envFile = canonicalBridgeEnvPath();
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  mergeEnvFile(envFile, { BASE_PATH: workspace });

  // ── Pairing token ─────────────────────────────────────────────────────────────
  console.log('Pairing token');
  console.log('  Press Enter to sign in via browser (recommended), or paste a token');
  console.log('  from https://app.ctrlnode.ai (Settings → Bridge) if you already have one.');
  const token = await askLine('Pairing token (Enter to sign in via browser): ');
  rl.close();

  if (token) {
    mergeEnvFile(envFile, { PAIRING_TOKEN: token });
  } else {
    try {
      await runLogin(envFile);
    } catch (err: any) {
      console.error(`\nLogin failed: ${err.message}\n`);
      process.exit(1);
    }
  }

  // ── Write provider keys ──────────────────────────────────────────────────────
  mergeEnvFile(envFile, {
    ...(providerKeys.cursorApiKey ? { CURSOR_API_KEY: providerKeys.cursorApiKey } : {}),
    ...(providerKeys.anthropicApiKey ? { ANTHROPIC_API_KEY: providerKeys.anthropicApiKey } : {}),
    ...(providerKeys.openrouterApiKey ? { OPENROUTER_API_KEY: providerKeys.openrouterApiKey } : {}),
  });

  const bin = path.basename(process.execPath || 'ctrlnode');

  console.log('');
  console.log(`Config saved to: ${envFile}`);
  console.log(`Workspace: ${workspace}`);
  if (providerKeys.cursorApiKey) console.log('  CURSOR_API_KEY: saved');
  if (providerKeys.anthropicApiKey) console.log('  ANTHROPIC_API_KEY: saved');
  if (providerKeys.openrouterApiKey) console.log('  OPENROUTER_API_KEY: saved');
  console.log('');
  console.log('To start the bridge, run:');
  console.log(`  ${bin}`);
  console.log('');
}
