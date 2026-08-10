import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getKnownCodexHomeCandidates, resolveCodexHome, syncCodexAuthToAgentHome } from '../codexAgentHome.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('syncCodexAuthToAgentHome', () => {
  test('copies the ChatGPT auth cache into an isolated agent CODEX_HOME', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-codex-auth-'));
    temporaryDirectories.push(root);
    const sharedHome = path.join(root, 'shared');
    const agentHome = path.join(root, 'agent');
    fs.mkdirSync(sharedHome, { recursive: true });
    fs.writeFileSync(path.join(sharedHome, 'auth.json'), '{"auth_mode":"chatgpt"}', 'utf8');

    expect(syncCodexAuthToAgentHome(agentHome, sharedHome)).toBe(true);
    expect(fs.readFileSync(path.join(agentHome, 'auth.json'), 'utf8'))
      .toBe('{"auth_mode":"chatgpt"}');
  });

  test('does not create auth when the shared CODEX_HOME has no session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctrlnode-codex-auth-'));
    temporaryDirectories.push(root);

    expect(syncCodexAuthToAgentHome(path.join(root, 'agent'), path.join(root, 'shared'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'agent', 'auth.json'))).toBe(false);
  });
});

describe('resolveCodexHome', () => {
  test('finds the standard Windows Codex home without CODEX_HOME', () => {
    const candidates = getKnownCodexHomeCandidates('win32', {
      USERPROFILE: 'C:/Users/vil',
      APPDATA: 'C:/Users/vil/AppData/Roaming',
    });

    expect(candidates).toContain('C:/Users/vil/.codex');
    expect(candidates).toContain('C:/Users/vil/AppData/Roaming/.codex');
  });

  test('returns the first existing standard home', () => {
    expect(resolveCodexHome({ CODEX_HOME: '', HOME: '/home/vil' }, 'linux', (candidate) => candidate === '/home/vil/.codex'))
      .toBe('/home/vil/.codex');
  });
});
