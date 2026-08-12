/**
 * @file codexCapabilities.ts
 * @description Static skill discovery for the Codex provider.
 *
 * Codex loads project skills from `.agents/skills`, user skills from `$HOME/.agents/skills`,
 * and bundled skills from the active CODEX_HOME. It invokes them as `$name`, not `/name`, so
 * the menu inserts native Codex syntax even though the user opened it by typing `/`.
 */

import fs from 'fs';
import path from 'path';

import { getCodexAgentHome, resolveCodexHome } from '../../codexAgentHome.js';
import { logger } from '../../logger.js';
import { sanitizeSkills, scanSkillDirectories } from './skillScanner.js';
import {
  DiscoverCapabilitiesParams,
  DiscoveredSkill,
  ProviderCapabilities,
  emptyCapabilities,
} from './types.js';

/** Stops the upward walk from ever climbing past a repository or the filesystem root. */
const MAX_PARENT_LEVELS = 12;

/**
 * Directories Codex consults, nearest-first: the working directory and each ancestor up to
 * the repo root, then the agent's CODEX_HOME. Nearest-first matters because
 * `scanSkillDirectories` lets the first occurrence of a name win.
 */
export function buildCodexSkillDirectories(
  workingDirectory: string,
  codexHome: string | undefined,
): string[] {
  const directories: string[] = [];
  let repositoryRootFound = false;

  let current = path.resolve(workingDirectory);
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    directories.push(path.join(current, '.agents', 'skills'));

    // The repository root is the documented ceiling for Codex project skills.
    if (fs.existsSync(path.join(current, '.git'))) {
      repositoryRootFound = true;
      break;
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Outside a Git repository, Codex still supports CWD/.agents/skills but there is no
  // repository boundary that authorizes walking through unrelated parent directories.
  if (!repositoryRootFound) directories.splice(1);

  if (codexHome) directories.push(path.join(codexHome, 'skills'));

  return directories;
}

export function discoverCodexSkills(
  workingDirectory: string,
  codexHome: string | undefined,
  userHome?: string,
  includeProjectSkills = true,
): DiscoveredSkill[] {
  const projectDirectories = includeProjectSkills
    ? buildCodexSkillDirectories(workingDirectory, undefined)
    : [];
  const userDirectories = userHome ? [path.join(userHome, '.agents', 'skills')] : [];
  // Retain the former CODEX_HOME/skills location for existing installations. Bundled Codex
  // skills live one level deeper under `.system`, so scan that explicit root separately.
  const legacyHomeDirectories = codexHome ? [path.join(codexHome, 'skills')] : [];
  const systemDirectories = codexHome ? [path.join(codexHome, 'skills', '.system')] : [];

  const projectSkills = scanSkillDirectories(projectDirectories, 'project');
  const userSkills = scanSkillDirectories(userDirectories, 'user');
  const legacyHomeSkills = scanSkillDirectories(legacyHomeDirectories, 'user');
  const systemSkills = scanSkillDirectories(systemDirectories, 'builtin');

  logger.debug('capabilities.codex.skills_discovered', {
    includeProjectSkills,
    project: projectSkills.length,
    user: userSkills.length,
    legacyHome: legacyHomeSkills.length,
    builtin: systemSkills.length,
  });

  const scanned = [
    ...projectSkills,
    ...userSkills,
    ...legacyHomeSkills,
    ...systemSkills,
  ];

  return scanned.map((skill) => ({
    id: skill.name,
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    invocation: `$${skill.name}`,
    scope: skill.scope,
    userInvocable: true,
    enabled: true,
  }));
}

export function discoverCodexCapabilities(
  params: DiscoverCapabilitiesParams,
): ProviderCapabilities {
  const base = emptyCapabilities('codex', params, 'static');

  // Must match the CODEX_HOME the dispatch will actually use, otherwise the catalogue
  // would advertise skills the task cannot see.
  const agentHome = params.agentId ? getCodexAgentHome(params.agentId) : undefined;
  const codexHome = agentHome && fs.existsSync(agentHome) ? agentHome : resolveCodexHome();
  const userHome = process.env.USERPROFILE?.trim() || process.env.HOME?.trim() || undefined;

  base.skills = sanitizeSkills(discoverCodexSkills(
    params.workingDirectory,
    codexHome,
    userHome,
    params.taskMode === 'repo',
  ));
  return base;
}
