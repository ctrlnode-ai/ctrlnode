import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  canonicalBridgeEnvPath,
  runWorkspaceTrustPreflight,
  shouldPromptForWorkspaceTrust,
  shouldRunWorkspaceTrustPreflight,
} from '../workspaceTrust.js';
import { defaultEnvFilePath } from '../login.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-workspace-trust-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('workspace trust path resolution', () => {
  test('uses the user configuration directory for the canonical env file', () => {
    expect(canonicalBridgeEnvPath('C:\\Users\\VIL')).toBe(path.join('C:\\Users\\VIL', '.ctrlnode', '.env'));
  });

  test('does not prompt when cwd matches BASE_PATH', () => {
    expect(shouldPromptForWorkspaceTrust('/work/project', '/work/project', 'linux')).toBe(false);
  });

  test('compares Windows paths case-insensitively', () => {
    expect(shouldPromptForWorkspaceTrust('C:\\CTRLNODE_EXAMPLE', 'c:\\ctrlnode_example\\', 'win32')).toBe(false);
  });

  test('prompts when cwd differs from BASE_PATH', () => {
    expect(shouldPromptForWorkspaceTrust('/work/current', '/work/saved', 'linux')).toBe(true);
  });

  test('runs only for normal Bridge startup commands', () => {
    expect(shouldRunWorkspaceTrustPreflight(['ctrlnode'])).toBe(true);
    expect(shouldRunWorkspaceTrustPreflight(['ctrlnode', '--setup'])).toBe(false);
    expect(shouldRunWorkspaceTrustPreflight(['ctrlnode', 'login'])).toBe(false);
    expect(shouldRunWorkspaceTrustPreflight(['ctrlnode', '--login'])).toBe(false);
  });

  test('login always targets the canonical user env instead of BASE_PATH', () => {
    const previous = process.env.BASE_PATH;
    process.env.BASE_PATH = path.join(os.tmpdir(), 'legacy-workspace');
    try {
      expect(defaultEnvFilePath()).toBe(canonicalBridgeEnvPath(os.homedir()));
    } finally {
      if (previous === undefined) delete process.env.BASE_PATH;
      else process.env.BASE_PATH = previous;
    }
  });
});

describe('runWorkspaceTrustPreflight', () => {
  test('accepts the current directory and preserves existing env values', async () => {
    const homeDir = temporaryDirectory();
    const envFile = canonicalBridgeEnvPath(homeDir);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'PAIRING_TOKEN=secret-value\nBASE_PATH=/saved\n', 'utf8');
    const answers = ['1'];
    const output: string[] = [];
    const runtimeEnv: NodeJS.ProcessEnv = {};

    const selected = await runWorkspaceTrustPreflight({
      cwd: '/current',
      homeDir,
      platform: 'linux',
      env: runtimeEnv,
      interactive: true,
      ask: async () => answers.shift() ?? '',
      write: line => output.push(line),
    });

    expect(selected).toBe(path.normalize('/current'));
    expect(runtimeEnv.BASE_PATH).toBe(path.normalize('/current'));
    expect(fs.readFileSync(envFile, 'utf8')).toContain('PAIRING_TOKEN=secret-value');
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`BASE_PATH=${path.normalize('/current')}`);
    const renderedOutput = output.join('\n');
    expect(renderedOutput).toContain('┌');
    expect(renderedOutput).toContain('CTRLNODE · WORKSPACE TRUST');
    expect(renderedOutput).toContain('Do you trust the contents of this directory?');
    expect(renderedOutput).toContain('› 1  Yes, continue');
    expect(renderedOutput).toContain('2  No, choose another directory');
    expect(renderedOutput).not.toContain('project-local config');
  });

  test('migrates legacy workspace configuration before changing BASE_PATH', async () => {
    const homeDir = temporaryDirectory();
    const legacyWorkspace = path.join(homeDir, 'legacy');
    const legacyEnvFile = path.join(legacyWorkspace, '.ctrlnode', '.env');
    fs.mkdirSync(path.dirname(legacyEnvFile), { recursive: true });
    fs.writeFileSync(legacyEnvFile, 'PAIRING_TOKEN=legacy-token\nCURSOR_API_KEY=legacy-key\n', 'utf8');

    await runWorkspaceTrustPreflight({
      cwd: path.join(homeDir, 'current'),
      homeDir,
      platform: process.platform,
      env: { BASE_PATH: legacyWorkspace },
      interactive: true,
      ask: async () => '1',
      write: () => {},
    });

    const canonicalConfig = fs.readFileSync(canonicalBridgeEnvPath(homeDir), 'utf8');
    expect(canonicalConfig).toContain('PAIRING_TOKEN=legacy-token');
    expect(canonicalConfig).toContain('CURSOR_API_KEY=legacy-key');
  });

  test('proposes the user home after No and allows the value to be edited', async () => {
    const homeDir = temporaryDirectory();
    const alternate = path.join(homeDir, 'alternate');
    fs.mkdirSync(alternate);
    const answers = ['2', alternate];

    const selected = await runWorkspaceTrustPreflight({
      cwd: path.join(homeDir, 'untrusted'),
      homeDir,
      platform: process.platform,
      env: {},
      interactive: true,
      ask: async () => answers.shift() ?? '',
      write: () => {},
    });

    expect(selected).toBe(path.normalize(alternate));
    expect(fs.readFileSync(canonicalBridgeEnvPath(homeDir), 'utf8')).toContain(`BASE_PATH=${path.normalize(alternate)}`);
  });

  test('uses the arrow-key selector result before asking for an alternate workspace', async () => {
    const homeDir = temporaryDirectory();
    const alternate = path.join(homeDir, 'selected-with-arrows');
    let renderedSelection = -1;
    const fallbackAnswers = [alternate, '1'];

    const selected = await runWorkspaceTrustPreflight({
      cwd: path.join(homeDir, 'untrusted'),
      homeDir,
      platform: process.platform,
      env: {},
      interactive: true,
      select: async options => {
        options.render(1);
        renderedSelection = 1;
        return 1;
      },
      ask: async () => fallbackAnswers.shift() ?? '1',
      write: () => {},
    });

    expect(renderedSelection).toBe(1);
    expect(selected).toBe(path.normalize(alternate));
  });

  test('uses the proposed home when the editable path is left blank', async () => {
    const homeDir = temporaryDirectory();
    const answers = ['2', ''];

    const selected = await runWorkspaceTrustPreflight({
      cwd: path.join(homeDir, 'untrusted'),
      homeDir,
      platform: process.platform,
      env: {},
      interactive: true,
      ask: async () => answers.shift() ?? '',
      write: () => {},
    });

    expect(selected).toBe(path.normalize(homeDir));
  });

  test('asks again after an invalid menu option', async () => {
    const homeDir = temporaryDirectory();
    const answers = ['invalid', '1'];
    const questions: string[] = [];

    await runWorkspaceTrustPreflight({
      cwd: path.join(homeDir, 'current'),
      homeDir,
      platform: process.platform,
      env: {},
      interactive: true,
      ask: async question => {
        questions.push(question);
        return answers.shift() ?? '';
      },
      write: () => {},
    });

    expect(questions.filter(question => question.includes('Select an option')).length).toBe(2);
  });

  test('keeps the saved BASE_PATH without prompting in non-interactive mode', async () => {
    const homeDir = temporaryDirectory();
    const envFile = canonicalBridgeEnvPath(homeDir);
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'BASE_PATH=/saved\n', 'utf8');
    let askCount = 0;
    const runtimeEnv: NodeJS.ProcessEnv = {};

    const selected = await runWorkspaceTrustPreflight({
      cwd: '/different',
      homeDir,
      platform: 'linux',
      env: runtimeEnv,
      interactive: false,
      ask: async () => {
        askCount += 1;
        return '1';
      },
      write: () => {},
    });

    expect(selected).toBe(path.normalize('/saved'));
    expect(runtimeEnv.BASE_PATH).toBe(path.normalize('/saved'));
    expect(askCount).toBe(0);
  });
});
