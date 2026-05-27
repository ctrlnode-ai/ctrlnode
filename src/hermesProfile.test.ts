import { describe, expect, test } from 'bun:test';
import os from 'os';
import path from 'path';
import {
  getGlobalHermesHome,
  getHermesProfileHome,
  getHermesProfileConfigPath,
  getHermesSoulMdPath,
  buildHermesConfigYaml,
} from './hermesProfile';

describe('hermesProfile — path helpers', () => {
  test('getGlobalHermesHome returns ~/.hermes', () => {
    const result = getGlobalHermesHome();
    expect(result).toBe(path.join(os.homedir(), '.hermes'));
  });

  test('getHermesProfileHome returns ~/.hermes/profiles/{id}', () => {
    const result = getHermesProfileHome('hermes-analyst');
    expect(result).toBe(path.join(os.homedir(), '.hermes', 'profiles', 'hermes-analyst'));
  });

  test('getHermesProfileHome sanitizes unsafe chars in id', () => {
    const result = getHermesProfileHome('MY AGENT!');
    expect(result).not.toContain(' ');
    expect(result).not.toContain('!');
  });

  test('getHermesProfileConfigPath', () => {
    const result = getHermesProfileConfigPath('hermes-qa');
    expect(result).toBe(path.join(os.homedir(), '.hermes', 'profiles', 'hermes-qa', 'config.yaml'));
  });

  test('getHermesSoulMdPath', () => {
    const result = getHermesSoulMdPath('hermes-qa');
    expect(result).toBe(path.join(os.homedir(), '.hermes', 'profiles', 'hermes-qa', 'SOUL.md'));
  });
});

describe('hermesProfile — buildHermesConfigYaml', () => {
  test('bare model id produces model block without provider line', () => {
    const yaml = buildHermesConfigYaml('gpt-5.4-mini');
    expect(yaml).toBe('model:\n  default: gpt-5.4-mini\n');
  });

  test('provider:model syntax sets provider and default', () => {
    const yaml = buildHermesConfigYaml('copilot-acp:gpt-5.4-mini');
    expect(yaml).toBe('model:\n  provider: copilot-acp\n  default: gpt-5.4-mini\n');
  });

  test('openrouter:anthropic/claude-sonnet-4', () => {
    const yaml = buildHermesConfigYaml('openrouter:anthropic/claude-sonnet-4');
    expect(yaml).toBe('model:\n  provider: openrouter\n  default: anthropic/claude-sonnet-4\n');
  });

  test('undefined model returns empty string', () => {
    expect(buildHermesConfigYaml(undefined)).toBe('');
  });

  test('empty string model returns empty string', () => {
    expect(buildHermesConfigYaml('')).toBe('');
  });
});
