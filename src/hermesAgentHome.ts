/**
 * @file hermesAgentHome.ts
 * @description Per-agent Hermes home under CTRLNODE_ROOT/agents/{agentId}/.
 * AGENTS.md is populated from CtrlNode INSTRUCTIONS (description) + ROLE and read by hermes acp.
 */
import fs from 'fs';
import path from 'path';
import { CTRLNODE_ROOT, getHermesAgentsDir } from './config.js';
import { normalizeAgentId } from './agentDiscovery.js';
import { logger } from './logger.js';

export function safeHermesAgentDir(agentId: string): string {
  const id = normalizeAgentId(agentId);
  const safe = id.replace(/[^a-z0-9-_]/g, '_');
  return safe || 'agent';
}

/** Absolute path: {HERMES_AGENTS_DIR}/{agentId}/ */
export function getHermesAgentHome(agentId: string): string {
  return path.join(getHermesAgentsDir(), safeHermesAgentDir(agentId));
}

export type HermesAgentMeta = {
  bridgeAgentId: string;
  name?: string;
  /** Model from CtrlNode UI (Hermes runtime may still use ~/.hermes until ACP model API). */
  model?: string;
  updatedAt: string;
};

export function getHermesMetaPath(agentId: string): string {
  return path.join(getHermesAgentHome(agentId), '.meta.json');
}

export function writeHermesAgentMeta(agentId: string, meta: Omit<HermesAgentMeta, 'updatedAt'> & { updatedAt?: string }): void {
  try {
    const home = getHermesAgentHome(agentId);
    fs.mkdirSync(home, { recursive: true });
    const payload: HermesAgentMeta = {
      bridgeAgentId: meta.bridgeAgentId || agentId,
      name: meta.name,
      model: meta.model,
      updatedAt: meta.updatedAt ?? new Date().toISOString(),
    };
    fs.writeFileSync(getHermesMetaPath(agentId), JSON.stringify(payload, null, 2), 'utf8');
    logger.debug('hermes_agent_home.meta_written', { agentId, model: payload.model ?? null });
  } catch (e) {
    logger.warn('hermes_agent_home.meta_write_failed', { agentId, err: String(e) });
  }
}

export function readHermesAgentMeta(agentId: string): HermesAgentMeta | null {
  try {
    const p = getHermesMetaPath(agentId);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HermesAgentMeta;
  } catch {
    return null;
  }
}

export function getHermesAgentsMdPath(agentId: string): string {
  return path.join(getHermesAgentHome(agentId), 'AGENTS.md');
}

/** Relative path from CTRLNODE_ROOT for write_file / SaaS. */
export function hermesAgentsMdRelPath(agentId: string): string {
  return path.join('agents', safeHermesAgentDir(agentId), 'AGENTS.md').replace(/\\/g, '/');
}

export type HermesAgentProfile = {
  name?: string;
  role?: string;
  description?: string;
  model?: string;
};

export function buildHermesAgentsMarkdown(profile: HermesAgentProfile, agentId: string): string {
  const name = profile.name?.trim() || agentId;
  const role = profile.role?.trim() || '_(not set)_';
  const instructions = profile.description?.trim() || '_No operating instructions defined._';
  return [
    `# ${name}`,
    '',
    '## Role',
    role,
    '',
    '## Instructions',
    instructions,
    '',
    '## Identity',
    `Bridge agent id: ${agentId}`,
    'Provider: Hermes (CtrlNode)',
    '',
  ].join('\n');
}

/**
 * Ensures agents/{id}/AGENTS.md exists. Does not overwrite an existing file (SaaS template wins).
 */
export function setupHermesAgentHome(agentId: string, profile: HermesAgentProfile): void {
  try {
    const home = getHermesAgentHome(agentId);
    fs.mkdirSync(home, { recursive: true });
    const agentsMdPath = path.join(home, 'AGENTS.md');
    if (fs.existsSync(agentsMdPath)) {
      logger.debug('hermes_agent_home.skip_existing', { agentId, path: agentsMdPath });
      return;
    }
    fs.writeFileSync(agentsMdPath, buildHermesAgentsMarkdown(profile, agentId), 'utf8');
    writeHermesAgentMeta(agentId, { bridgeAgentId: agentId, name: profile.name, model: profile.model });
    logger.info('hermes_agent_home.provisioned', { agentId, path: agentsMdPath });
  } catch (e) {
    logger.warn('hermes_agent_home.provision_failed', { agentId, err: String(e) });
  }
}

/** Write or refresh AGENTS.md from current discovered agent fields (e.g. after SaaS edit). */
export function writeHermesAgentsMd(agentId: string, profile: HermesAgentProfile): void {
  try {
    const home = getHermesAgentHome(agentId);
    fs.mkdirSync(home, { recursive: true });
    const agentsMdPath = path.join(home, 'AGENTS.md');
    fs.writeFileSync(agentsMdPath, buildHermesAgentsMarkdown(profile, agentId), 'utf8');
    writeHermesAgentMeta(agentId, { bridgeAgentId: agentId, name: profile.name, model: profile.model });
    logger.debug('hermes_agent_home.agents_md_written', { agentId, path: agentsMdPath });
  } catch (e) {
    logger.warn('hermes_agent_home.write_failed', { agentId, err: String(e) });
  }
}

export function readHermesAgentsMd(agentId: string): string | null {
  try {
    const p = getHermesAgentsMdPath(agentId);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function deleteHermesAgentHome(agentId: string): void {
  try {
    const home = getHermesAgentHome(agentId);
    if (fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true, force: true });
      logger.debug('hermes_agent_home.deleted', { agentId, path: home });
    }
  } catch (e) {
    logger.warn('hermes_agent_home.delete_failed', { agentId, err: String(e) });
  }
}
