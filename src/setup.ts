/**
 * @file setup.ts
 * @description Interactive setup wizard — runs when ctrlnode is invoked with --setup.
 * Prompts for workspace, optional provider API keys, pairing token; writes .env; persists BASE_PATH.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';
import { mergeEnvFile, promptProviderApiKeys } from './setupEnv.js';
import { runLogin } from './login.js';

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
}

function persistBasePath(workspace: string): void {
  if (process.platform === 'win32') {
    try {
      execSync(`powershell -Command "[System.Environment]::SetEnvironmentVariable('BASE_PATH', '${workspace}', 'User')"`, { stdio: 'ignore' });
    } catch { /* non-fatal */ }
  } else {
    // Linux / macOS: append to shell RC
    const rc = [
      path.join(os.homedir(), '.zshrc'),
      path.join(os.homedir(), '.bashrc'),
      path.join(os.homedir(), '.profile'),
    ].find(f => fs.existsSync(f));
    if (rc) {
      const content = fs.readFileSync(rc, 'utf8');
      const filtered = content.split('\n').filter(l => !l.includes('BASE_PATH')).join('\n');
      fs.writeFileSync(rc, filtered + `\nexport BASE_PATH="${workspace}"\n`, 'utf8');
    }
  }
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
  const envDir  = path.join(workspace, '.ctrlnode');
  const envFile = path.join(envDir, '.env');
  fs.mkdirSync(envDir, { recursive: true });

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

  // ── Persist BASE_PATH in user environment ─────────────────────────────────────
  persistBasePath(workspace);

  const bin = path.basename(process.execPath || 'ctrlnode');

  console.log('');
  console.log(`Config saved to: ${envFile}`);
  console.log(`BASE_PATH set to: ${workspace}`);
  if (providerKeys.cursorApiKey) console.log('  CURSOR_API_KEY: saved');
  if (providerKeys.anthropicApiKey) console.log('  ANTHROPIC_API_KEY: saved');
  if (providerKeys.openrouterApiKey) console.log('  OPENROUTER_API_KEY: saved');
  console.log('');
  console.log('To start the bridge, either:');
  console.log('  1. Close this terminal and open a new one, then run:');
  console.log(`       ${bin}`);
  console.log('  2. Or in this terminal, run:');
  if (process.platform === 'win32') {
    console.log(`       $env:BASE_PATH='${workspace}'; ${bin}`);
  } else {
    console.log(`       BASE_PATH='${workspace}' ${bin}`);
  }
  console.log('');
}
