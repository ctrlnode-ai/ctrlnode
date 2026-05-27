/**
 * @file setup.ts
 * @description Interactive setup wizard — runs when ctrlnode is invoked with --setup.
 * Prompts for workspace and pairing token, writes .env, persists BASE_PATH, then exits.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

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
  const workspaceRaw = await ask(rl, `Workspace [${defaultWorkspace}]: `);
  const workspace = workspaceRaw || defaultWorkspace;
  console.log(`  Workspace: ${workspace}\n`);

  // ── Pairing token ─────────────────────────────────────────────────────────────
  console.log('Enter your pairing token.');
  console.log('  Get it at: https://app.ctrlnode.ai  (Settings → Bridge)');
  const token = await ask(rl, 'Pairing token: ');
  rl.close();

  if (!token) {
    console.error('No token entered. Exiting.');
    process.exit(1);
  }

  // ── Write .env ────────────────────────────────────────────────────────────────
  const envDir  = path.join(workspace, '.ctrlnode');
  const envFile = path.join(envDir, '.env');
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(envFile, `PAIRING_TOKEN=${token}\n`, 'utf8');

  // ── Persist BASE_PATH in user environment ─────────────────────────────────────
  persistBasePath(workspace);

  const bin = path.basename(process.execPath || 'ctrlnode');

  console.log('');
  console.log(`Config saved to: ${envFile}`);
  console.log(`BASE_PATH set to: ${workspace}`);
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
