import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';
import { normalizeAgentId } from './agentDiscovery.js';
import { parseHermesModelRef, normalizeHermesModelId } from './hermesModelUtils.js';
import { HERMES_HOME } from './config.js';

function safeProfileId(agentId: string): string {
  const id = normalizeAgentId(agentId);
  const safe = id.replace(/[^a-z0-9-_]/g, '_');
  return safe || 'agent';
}

/**
 * Absolute path to the global Hermes home.
 * Respects HERMES_HOME env var (emergency override) so profile writes and spawns
 * always operate on the same directory.
 */
export function getGlobalHermesHome(): string {
  return HERMES_HOME || path.join(os.homedir(), '.hermes');
}

/** Absolute path to the native Hermes profile for a CtrlNode agent. */
export function getHermesProfileHome(agentId: string): string {
  return path.join(getGlobalHermesHome(), 'profiles', safeProfileId(agentId));
}

/** Path to config.yaml inside a profile. */
export function getHermesProfileConfigPath(agentId: string): string {
  return path.join(getHermesProfileHome(agentId), 'config.yaml');
}

/** Path to SOUL.md inside a profile. */
export function getHermesSoulMdPath(agentId: string): string {
  return path.join(getHermesProfileHome(agentId), 'SOUL.md');
}

/**
 * Build Hermes config.yaml content from a CtrlNode UI model string.
 * Returns empty string when model is blank (caller should skip writing).
 */
export function buildHermesConfigYaml(uiModel: string | undefined | null): string {
  const normalized = normalizeHermesModelId(uiModel);
  if (!normalized) return '';

  const { explicitProvider, modelPart } = parseHermesModelRef(normalized);

  const lines = ['model:'];
  if (explicitProvider) {
    lines.push(`  provider: ${explicitProvider}`);
  }
  lines.push(`  default: ${modelPart}`);
  lines.push('');
  return lines.join('\n');
}

export type HermesProfileOptions = {
  name?: string;
  role?: string;
  description?: string;
  model?: string;
};

/**
 * Build SOUL.md content for a Hermes profile.
 * SOUL.md is the Hermes-native identity file read from HERMES_HOME.
 * profile.description maps to the INSTRUCTIONS field from the CtrlNode UI.
 */
export function buildHermesSoulMd(profile: HermesProfileOptions, agentId: string): string {
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
 * Write (or overwrite) config.yaml for a profile from the agent's UI model string.
 * If no model is provided, skips the write.
 */
export function writeHermesProfileConfig(agentId: string, uiModel: string | undefined): void {
  const yaml = buildHermesConfigYaml(uiModel);
  if (!yaml) {
    logger.debug('hermes_profile.config_skip_no_model', { agentId });
    return;
  }
  try {
    const configPath = getHermesProfileConfigPath(agentId);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, yaml, 'utf8');
    logger.debug('hermes_profile.config_written', { agentId, model: uiModel });
  } catch (e) {
    logger.warn('hermes_profile.config_write_failed', { agentId, err: String(e) });
  }
}

/** Write or refresh SOUL.md in a profile from current agent fields. */
export function writeHermesSoulMd(agentId: string, profile: HermesProfileOptions): void {
  try {
    const soulPath = getHermesSoulMdPath(agentId);
    fs.mkdirSync(path.dirname(soulPath), { recursive: true });
    fs.writeFileSync(soulPath, buildHermesSoulMd(profile, agentId), 'utf8');
    logger.debug('hermes_profile.soul_md_written', { agentId });
  } catch (e) {
    logger.warn('hermes_profile.soul_md_write_failed', { agentId, err: String(e) });
  }
}

/**
 * Copy auth.json (API keys for OpenRouter, Anthropic, etc.) from the global
 * Hermes home into the profile. Skips if the profile already has auth.json.
 * This gives the profile agent access to the same providers as the global session.
 */
function seedAuthJson(profileDir: string): void {
  const src = path.join(getGlobalHermesHome(), 'auth.json');
  const dst = path.join(profileDir, 'auth.json');
  if (fs.existsSync(dst)) return;
  if (!fs.existsSync(src)) {
    logger.debug('hermes_profile.auth_json_seed_skip', { reason: 'global auth.json not found' });
    return;
  }
  try {
    fs.copyFileSync(src, dst);
    logger.info('hermes_profile.auth_json_seeded', { profileDir });
  } catch (e) {
    logger.warn('hermes_profile.auth_json_seed_failed', { profileDir, err: String(e) });
  }
}

/**
 * Copy .env from the global Hermes home into the profile.
 * Skips if the profile already has .env.
 * Allows per-profile API key overrides while inheriting the global default.
 */
function seedEnvFile(profileDir: string): void {
  const src = path.join(getGlobalHermesHome(), '.env');
  const dst = path.join(profileDir, '.env');
  if (fs.existsSync(dst)) {
    logger.info('hermes_profile.env_seed_skip', { reason: 'profile already has .env', dst });
    return;
  }
  if (!fs.existsSync(src)) {
    logger.info('hermes_profile.env_seed_skip', { reason: 'global .env not found', src });
    return;
  }
  try {
    fs.copyFileSync(src, dst);
    logger.info('hermes_profile.env_seeded', { src, dst });
  } catch (e) {
    logger.warn('hermes_profile.env_seed_failed', { profileDir, err: String(e) });
  }
}

/**
 * Ensure a Hermes profile directory exists for the given agent.
 * Writes SOUL.md + config.yaml and seeds auth.json (API keys) from the
 * global ~/.hermes/auth.json on first creation. Safe to call multiple times
 * (idempotent — auth.json seed is skipped when the file already exists).
 *
 * Use this on agent CREATE and SYNC operations.
 * For lightweight UPDATE (edit only), use writeHermesSoulMd + writeHermesProfileConfig directly.
 */
export function ensureHermesProfile(agentId: string, profile: HermesProfileOptions): string {
  const profileDir = getHermesProfileHome(agentId);
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    seedAuthJson(profileDir);
    seedEnvFile(profileDir);
    writeHermesSoulMd(agentId, profile);
    writeHermesProfileConfig(agentId, profile.model);
    logger.info('hermes_profile.ensured', { agentId, profileDir });
  } catch (e) {
    logger.warn('hermes_profile.ensure_failed', { agentId, err: String(e) });
  }
  return profileDir;
}

/** Delete the profile directory for a removed agent. */
export function deleteHermesProfile(agentId: string): void {
  try {
    const profileDir = getHermesProfileHome(agentId);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
      logger.debug('hermes_profile.deleted', { agentId, profileDir });
    }
  } catch (e) {
    logger.warn('hermes_profile.delete_failed', { agentId, err: String(e) });
  }
}
