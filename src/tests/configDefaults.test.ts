// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const CONFIG_ENV_KEYS = [
  'TASK_TIMEOUT_MINUTES',
  'CLAUDE_SDK_MAX_TURNS',
  'CLAUDE_MAX_TURNS',
  'GRAPH_GENERATION_TIMEOUT_SECONDS',
  'GRAPH_GENERATION_MAX_TURNS',
  'LOG_THINKING',
];

describe('Bridge configuration defaults', () => {
  test('uses the long-running task defaults when no environment overrides exist', () => {
    const temporaryBasePath = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-config-defaults-'));
    const childEnvironment = { ...process.env, BASE_PATH: temporaryBasePath };
    for (const key of CONFIG_ENV_KEYS) delete childEnvironment[key];

    const configUrl = pathToFileURL(path.resolve(import.meta.dir, '..', 'config.ts')).href;
    const result = spawnSync(
      process.execPath,
      ['-e', `import * as config from '${configUrl}'; console.log(JSON.stringify({ taskTimeout: config.TASK_TIMEOUT_MINUTES, sdkTurns: config.CLAUDE_SDK_MAX_TURNS, cliTurns: config.CLAUDE_MAX_TURNS, graphTimeout: config.GRAPH_GENERATION_TIMEOUT_SECONDS, graphTurns: config.GRAPH_GENERATION_MAX_TURNS, logThinking: config.LOG_THINKING }));`],
      { cwd: temporaryBasePath, env: childEnvironment, encoding: 'utf8' },
    );

    fs.rmSync(temporaryBasePath, { recursive: true, force: true });

    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);
    expect(config).toEqual({
      taskTimeout: 30,
      sdkTurns: 200,
      cliTurns: 200,
      graphTimeout: 300,
      graphTurns: 50,
      logThinking: true,
    });
  });
});
