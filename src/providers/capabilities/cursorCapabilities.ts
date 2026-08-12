/**
 * @file cursorCapabilities.ts
 * @description Skill discovery for the Cursor provider.
 *
 * `cursor-agent` exposes a skill catalogue on recent versions; older builds do not, so a
 * filesystem scan of `.cursor/skills` backs it up. Cursor invokes skills as `/name`.
 */

import path from 'path';

import { logger } from '../../logger.js';
import { CliRunner, defaultCliRunner, extractCatalogueArray } from './cliCatalogue.js';
import { normalizeScope } from './copilotCapabilities.js';
import { sanitizeSkills, scanSkillDirectories } from './skillScanner.js';
import {
  DiscoverCapabilitiesParams,
  DiscoveredSkill,
  ProviderCapabilities,
  emptyCapabilities,
} from './types.js';

export function parseCursorSkillList(raw: string): DiscoveredSkill[] {
  const entries = extractCatalogueArray(raw, ['skills', 'commands', 'data']);
  const skills: DiscoveredSkill[] = [];

  for (const entry of entries) {
    const rawName = entry.name ?? entry.id;
    const name = typeof rawName === 'string' ? rawName.trim().replace(/^\/+/, '') : '';
    if (!name) continue;

    const description = typeof entry.description === 'string' ? entry.description.trim() : undefined;

    skills.push({
      id: name,
      name,
      description: description || undefined,
      invocation: `/${name}`,
      scope: normalizeScope(entry.scope),
      userInvocable: true,
      enabled: entry.enabled !== false,
    });
  }

  return skills;
}

export function buildCursorSkillDirectories(workingDirectory: string, home: string | undefined): string[] {
  const directories = [path.join(workingDirectory, '.cursor', 'skills')];
  if (home) directories.push(path.join(home, '.cursor', 'skills'));
  return directories;
}

export function discoverCursorCapabilities(
  params: DiscoverCapabilitiesParams,
  runCli: CliRunner = defaultCliRunner,
  home: string | undefined = process.env.USERPROFILE || process.env.HOME,
): ProviderCapabilities {
  const base = emptyCapabilities('cursor', params, 'live');

  const result = runCli('cursor-agent', ['skill', 'list', '--json'], params.workingDirectory);
  if (result.ok) {
    const parsed = parseCursorSkillList(result.stdout);
    if (parsed.length > 0) {
      base.skills = sanitizeSkills(parsed);
      return base;
    }
  } else {
    logger.debug('capabilities.cursor.cli_failed', { reason: result.reason });
  }

  // Fall back to the documented on-disk layout so older CLIs still show project skills.
  base.discovery.skills = 'static';
  base.skills = sanitizeSkills(
    [
      ...scanSkillDirectories([path.join(params.workingDirectory, '.cursor', 'skills')], 'project'),
      ...scanSkillDirectories(home ? [path.join(home, '.cursor', 'skills')] : [], 'user'),
    ].map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      argumentHint: skill.argumentHint,
      invocation: `/${skill.name}`,
      scope: skill.scope,
      userInvocable: true,
      enabled: true,
    })),
  );

  return base;
}
