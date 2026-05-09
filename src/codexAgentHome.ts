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
import { AGENTS_CTRLNODE_ROOT } from './config';
import { logger } from './logger';

/**
 * Returns the per-agent CODEX_HOME path: {AGENTS_CTRLNODE_ROOT}/.codex-agents/{agentId}/
 */
export function getCodexAgentHome(agentId: string): string {
  return path.join(AGENTS_CTRLNODE_ROOT, '.codex-agents', agentId);
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
    const sharedConfig = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'config.toml') : null;
    if (sharedConfig && fs.existsSync(sharedConfig)) {
      fs.copyFileSync(sharedConfig, path.join(agentHome, 'config.toml'));
    }

    // Ensure the ctrlnode root workspace is trusted so Codex CLI permits workspace-write sandbox.
    // Also set [windows] sandbox = "unelevated" — without it Codex ignores --sandbox workspace-write
    // and falls back to read-only on Windows machines that aren't running as admin.
    const configPath = path.join(agentHome, 'config.toml');
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, 'utf8');
      let extra = '';
      if (!existing.toLowerCase().includes(AGENTS_CTRLNODE_ROOT.toLowerCase())) {
        extra += `\n[projects.'${AGENTS_CTRLNODE_ROOT}']\ntrust_level = "trusted"\n`;
      }
      if (!existing.toLowerCase().includes('[windows]')) {
        extra += `\n[windows]\nsandbox = "unelevated"\n`;
      }
      if (extra) fs.appendFileSync(configPath, extra, 'utf8');
    }

    logger.info('codex_agent_home.provisioned', { agentId, path: agentHome });
  } catch (e) {
    logger.warn('codex_agent_home.provision_failed', { agentId, err: String(e) });
  }
}
