/**
 * @file codexAgentHome.ts
 * @description Per-agent CODEX_HOME provisioning.
 *
 * Each Codex agent gets its own `~/.codex-agents/{agentId}/` directory that
 * contains AGENTS.md (from the agent description) and optionally a config.toml
 * copied from the shared CODEX_HOME. The directory is created once at agent
 * registration and reused on every task run.
 */

import fs from 'fs';
import path from 'path';
import { CTRLNODE_ROOT } from './config.js';
import { logger } from './logger.js';

export function getKnownCodexHomeCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const home = env.USERPROFILE || env.HOME || '';
  const slash = (...parts: string[]) => parts.filter(Boolean).join('/').replace(/\\+/g, '/');
  const candidates = [slash(home, '.codex')];
  if (env.XDG_CONFIG_HOME) candidates.push(slash(env.XDG_CONFIG_HOME, 'codex'));
  if (platform === 'win32' && env.APPDATA) candidates.push(slash(env.APPDATA, '.codex'));
  return candidates;
}

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
  if (env.CODEX_HOME?.trim()) return env.CODEX_HOME.trim();
  return getKnownCodexHomeCandidates(platform, env).find(exists);
}

/**
 * Returns the per-agent CODEX_HOME path: {CTRLNODE_ROOT}/.codex-agents/{agentId}/
 */
export function getCodexAgentHome(agentId: string): string {
  return path.join(CTRLNODE_ROOT, '.codex-agents', agentId);
}

/**
 * Copies the shared Codex login cache into an isolated agent home.
 *
 * Codex CLI reads ChatGPT subscription credentials from auth.json under
 * CODEX_HOME. Agent homes are intentionally separate for sessions/config, so
 * they must receive the shared login cache before the CLI is spawned.
 */
export function syncCodexAuthToAgentHome(agentHome: string, sharedHome: string | undefined): boolean {
  if (!sharedHome) return false;

  const source = path.join(sharedHome, 'auth.json');
  if (!fs.existsSync(source)) return false;

  try {
    fs.mkdirSync(agentHome, { recursive: true });
    fs.copyFileSync(source, path.join(agentHome, 'auth.json'));
    logger.debug('codex_agent_home.auth_synced', { agentHome });
    return true;
  } catch (e) {
    logger.warn('codex_agent_home.auth_sync_failed', { agentHome, err: String(e) });
    return false;
  }
}

/**
 * Provisions the per-agent CODEX_HOME directory with AGENTS.md and optionally
 * config.toml (copied from the shared CODEX_HOME if set). Called once when the
 * agent is registered via sync_codex_agents — not on every task execution.
 */
export function setupCodexAgentHome(agentId: string, agentDescription: string): void {
  try {
    const agentHome = getCodexAgentHome(agentId);
    fs.mkdirSync(agentHome, { recursive: true });
    fs.writeFileSync(path.join(agentHome, 'AGENTS.md'), agentDescription, 'utf8');

    // Copy shared config.toml when available (e.g. openrouter provider config).
    const codexHome = resolveCodexHome();
    const sharedConfig = codexHome ? path.join(codexHome, 'config.toml') : null;
    if (sharedConfig && fs.existsSync(sharedConfig)) {
      fs.copyFileSync(sharedConfig, path.join(agentHome, 'config.toml'));
    }

    syncCodexAuthToAgentHome(agentHome, codexHome);

    // Ensure the ctrlnode root workspace is trusted so Codex CLI permits workspace-write sandbox.
    // Also set [windows] sandbox = "unelevated" — without it Codex ignores --sandbox workspace-write
    // and falls back to read-only on Windows machines that aren't running as admin.
    const configPath = path.join(agentHome, 'config.toml');
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf8');
      let extra = '';
      if (!existing.toLowerCase().includes(CTRLNODE_ROOT.toLowerCase())) {
        extra += `\n[projects.'${CTRLNODE_ROOT}']\ntrust_level = "trusted"\n`;
      }
      if (!existing.toLowerCase().includes('[windows]')) {
        extra += `\n[windows]\nsandbox = "unelevated"\n`;
      }
      if (extra) fs.appendFileSync(configPath, extra, 'utf8');
    }

    logger.debug('codex_agent_home.provisioned', { agentId, path: agentHome });
  } catch (e) {
    logger.warn('codex_agent_home.provision_failed', { agentId, err: String(e) });
  }
}
