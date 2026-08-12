import fs from 'fs';
import os from 'os';
import path from 'path';
import { createInterface } from 'readline';
import { logger } from './logger.js';
import { mergeEnvFile } from './setupEnv.js';
import { renderWorkspaceTrustPanel, supportsTerminalColor } from './terminalPanels.js';
import {
  canUseTerminalSelector,
  selectTerminalOption,
  type TerminalSelectorOptions,
} from './terminalSelector.js';

type Platform = NodeJS.Platform | 'linux';

export type WorkspaceTrustDependencies = {
  cwd?: string;
  homeDir?: string;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  interactive?: boolean;
  ask?: (question: string) => Promise<string>;
  write?: (line: string) => void;
  select?: (options: TerminalSelectorOptions) => Promise<number | null>;
};

export function canonicalBridgeEnvPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.ctrlnode', '.env');
}

function pathLibrary(platform: Platform): typeof path.win32 | typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

function normalizedForComparison(value: string, platform: Platform): string {
  const normalized = pathLibrary(platform).resolve(value).replace(/[\\/]+$/, '');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function shouldPromptForWorkspaceTrust(cwd: string, basePath: string, platform: Platform = process.platform): boolean {
  return normalizedForComparison(cwd, platform) !== normalizedForComparison(basePath, platform);
}

export function shouldRunWorkspaceTrustPreflight(args: readonly string[]): boolean {
  return !args.includes('--setup') && !args.includes('login') && !args.includes('--login');
}

function readEnvValue(envFile: string, key: string): string | undefined {
  if (!fs.existsSync(envFile)) return undefined;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match?.[1] === key) return match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return undefined;
}

function runtimeInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function runtimeAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise(resolve => rl.question(question, answer => resolve(answer.trim())));
  } finally {
    rl.close();
  }
}

function persistWorkspace(envFile: string, workspace: string): void {
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  mergeEnvFile(envFile, { BASE_PATH: workspace });
}

function migrateLegacyConfig(envFile: string, workspace: string, platform: Platform): void {
  if (fs.existsSync(envFile)) return;
  const legacyEnvFile = pathLibrary(platform).join(workspace, '.ctrlnode', '.env');
  if (!fs.existsSync(legacyEnvFile)) return;
  fs.mkdirSync(path.dirname(envFile), { recursive: true });
  fs.copyFileSync(legacyEnvFile, envFile);
  logger.debug('workspace_trust_config_migrated', { from: legacyEnvFile, to: envFile });
}

export async function runWorkspaceTrustPreflight(
  dependencies: WorkspaceTrustDependencies = {},
): Promise<string> {
  const cwd = path.normalize(dependencies.cwd ?? process.cwd());
  const homeDir = path.normalize(dependencies.homeDir ?? os.homedir());
  const platform = dependencies.platform ?? process.platform;
  const env = dependencies.env ?? process.env;
  const envFile = canonicalBridgeEnvPath(homeDir);
  const savedWorkspace = path.normalize(readEnvValue(envFile, 'BASE_PATH') || env.BASE_PATH || homeDir);
  const interactive = dependencies.interactive ?? runtimeInteractive();
  const ask = dependencies.ask ?? runtimeAsk;
  const write = dependencies.write ?? (line => console.log(line));

  migrateLegacyConfig(envFile, savedWorkspace, platform);

  if (!shouldPromptForWorkspaceTrust(cwd, savedWorkspace, platform)) {
    env.BASE_PATH = savedWorkspace;
    if (!readEnvValue(envFile, 'BASE_PATH')) persistWorkspace(envFile, savedWorkspace);
    logger.debug('workspace_trust_path_match', { workspace: savedWorkspace });
    return savedWorkspace;
  }

  if (!interactive) {
    env.BASE_PATH = savedWorkspace;
    logger.debug('workspace_trust_non_interactive', { workspace: savedWorkspace, cwd });
    return savedWorkspace;
  }

  const renderTrustPanel = (selectedIndex = 0) => renderWorkspaceTrustPanel({
    cwd,
    selectedIndex,
    boxed: interactive,
    color: supportsTerminalColor(),
    columns: process.stdout.columns,
  });

  write('');
  let choice: '1' | '2';
  const select = dependencies.select ?? selectTerminalOption;
  if (dependencies.select || canUseTerminalSelector()) {
    const selectedIndex = await select({ optionCount: 2, render: renderTrustPanel });
    if (selectedIndex === null) process.exit(130);
    choice = selectedIndex === 0 ? '1' : '2';
  } else {
    for (const line of renderTrustPanel()) write(line);
    while (true) {
      const answer = await ask('Select an option [1]: ');
      if (answer === '' || answer === '1') {
        choice = '1';
        break;
      }
      if (answer === '2') {
        choice = '2';
        break;
      }
      write('Please choose 1 or 2.');
    }
  }

  let workspace: string;
  if (choice === '1') {
    workspace = cwd;
    logger.debug('workspace_trust_current_accepted', { workspace });
  } else {
    const alternate = await ask(`Workspace [${homeDir}]: `);
    workspace = path.normalize(alternate || homeDir);
    logger.debug('workspace_trust_alternate_selected', { workspace, cwd });
  }

  persistWorkspace(envFile, workspace);
  env.BASE_PATH = workspace;
  write('');
  return workspace;
}
