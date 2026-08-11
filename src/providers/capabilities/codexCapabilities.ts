/**
 * @file codexCapabilities.ts
 * @description Static skill discovery for the Codex provider.
 *
 * Codex loads `.agents/skills` from the working directory upwards to the repository root,
 * plus the skills folder of the active CODEX_HOME. It invokes them as `$name`, not `/name`,
 * so the menu inserts native Codex syntax even though the user opened it by typing `/`.
 */

import fs from 'fs';
import path from 'path';

import { getCodexAgentHome, resolveCodexHome } from '../../codexAgentHome.js';
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

  let current = path.resolve(workingDirectory);
  for (let level = 0; level < MAX_PARENT_LEVELS; level++) {
    directories.push(path.join(current, '.agents', 'skills'));

    // The repository root is the documented ceiling for Codex project skills.
    if (fs.existsSync(path.join(current, '.git'))) break;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (codexHome) directories.push(path.join(codexHome, 'skills'));

  return directories;
}

export function discoverCodexSkills(
  workingDirectory: string,
  codexHome: string | undefined,
): DiscoveredSkill[] {
  const projectDirectories = buildCodexSkillDirectories(workingDirectory, undefined);
  const homeDirectories = codexHome ? [path.join(codexHome, 'skills')] : [];

  const scanned = [
    ...scanSkillDirectories(projectDirectories, 'project'),
    ...scanSkillDirectories(homeDirectories, 'user'),
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

  base.skills = sanitizeSkills(discoverCodexSkills(params.workingDirectory, codexHome));
  return base;
}
