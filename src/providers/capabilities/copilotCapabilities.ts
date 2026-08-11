/**
 * @file copilotCapabilities.ts
 * @description Skill discovery for the GitHub Copilot CLI/ACP provider.
 *
 * `copilot skill list --json` returns the resolved project+user catalogue, which is far more
 * reliable than scanning folders. Copilot invokes skills as `/name`.
 */

import { logger } from '../../logger.js';
import { CliRunner, defaultCliRunner, extractCatalogueArray } from './cliCatalogue.js';
import { sanitizeSkills } from './skillScanner.js';
import {
  DiscoverCapabilitiesParams,
  DiscoveredSkill,
  ProviderCapabilities,
  SkillScope,
  emptyCapabilities,
} from './types.js';

const KNOWN_SCOPES: SkillScope[] = ['project', 'user', 'plugin', 'managed', 'builtin'];

export function normalizeScope(value: unknown): SkillScope {
  const scope = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (KNOWN_SCOPES as string[]).includes(scope) ? (scope as SkillScope) : 'user';
}

function readString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

export function parseCopilotSkillList(raw: string): DiscoveredSkill[] {
  const entries = extractCatalogueArray(raw, ['skills', 'data', 'items']);
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    const name = readString(entry, 'name', 'id')?.replace(/^\/+/, '');
    if (!name) continue;

    skills.push({
      id: name,
      name,
      description: readString(entry, 'description', 'summary'),
      argumentHint: readString(entry, 'argumentHint', 'argument_hint', 'arguments'),
      invocation: `/${name}`,
      scope: normalizeScope(entry.scope ?? entry.source),
      userInvocable: entry.userInvocable !== false,
      enabled: entry.enabled !== false && entry.disabled !== true,
    });
  }

  return skills;
}

export function discoverCopilotCapabilities(
  params: DiscoverCapabilitiesParams,
  runCli: CliRunner = defaultCliRunner,
): ProviderCapabilities {
  const base = emptyCapabilities('copilot', params, 'live');

  const result = runCli('copilot', ['skill', 'list', '--json'], params.workingDirectory);
  if (!result.ok) {
    logger.debug('capabilities.copilot.cli_failed', { reason: result.reason });
    base.discovery.skills = 'unsupported';
    base.discovery.warnings.push(`copilot_cli_${result.reason ?? 'failed'}`);
    return base;
  }

  base.skills = sanitizeSkills(parseCopilotSkillList(result.stdout));
  return base;
}
