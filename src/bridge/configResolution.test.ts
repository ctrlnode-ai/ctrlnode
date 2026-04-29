// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import path from 'path';
import { resolveOpenClawConfigPath } from './configResolution';

describe('resolveOpenClawConfigPath', () => {
  test('prefers OPENCLAW_CONFIG_PATH when provided', () => {
    const resolved = resolveOpenClawConfigPath({
      env: { OPENCLAW_CONFIG_PATH: '/custom/openclaw.json' },
      platform: 'linux',
      homedir: '/home/node',
      existsSync: () => false,
    });

    expect(resolved.path).toBe('/custom/openclaw.json');
    expect(resolved.source).toBe('OPENCLAW_CONFIG_PATH');
  });

  test('derives from OPENCLAW_STATE_DIR', () => {
    const resolved = resolveOpenClawConfigPath({
      env: { OPENCLAW_STATE_DIR: '/data/state' },
      platform: 'linux',
      homedir: '/home/node',
      existsSync: () => false,
    });

    expect(resolved.path).toBe('/data/state/openclaw.json');
    expect(resolved.source).toBe('OPENCLAW_STATE_DIR');
  });

  test('derives from OPENCLAW_HOME', () => {
    const resolved = resolveOpenClawConfigPath({
      env: { OPENCLAW_HOME: '/srv/openclaw-home' },
      platform: 'linux',
      homedir: '/home/node',
      existsSync: () => false,
    });

    expect(resolved.path).toBe('/srv/openclaw-home/.openclaw/openclaw.json');
    expect(resolved.source).toBe('OPENCLAW_HOME');
  });

  test('auto-discovers existing config from known candidates when env vars are absent', () => {
    const existing = new Set<string>([
      '/home/ubuntu/.openclaw/openclaw.json',
    ]);

    const resolved = resolveOpenClawConfigPath({
      env: {},
      platform: 'linux',
      homedir: '/home/node',
      existsSync: (p) => existing.has(path.normalize(p).replace(/\\/g, '/')),
    });

    expect(resolved.path).toBe('/home/ubuntu/.openclaw/openclaw.json');
    expect(resolved.source).toBe('auto-discovered');
  });

  test('falls back to HOME-based default when no candidates exist', () => {
    const resolved = resolveOpenClawConfigPath({
      env: { HOME: '/home/node' },
      platform: 'linux',
      homedir: '/ignored/by/home/env',
      existsSync: () => false,
    });

    expect(resolved.path).toBe('/home/node/.openclaw/openclaw.json');
    expect(resolved.source).toBe('HOME-default');
  });
});
