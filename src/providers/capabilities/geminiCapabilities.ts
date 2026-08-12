/**
 * @file geminiCapabilities.ts
 * @description Static custom-command discovery for the Gemini provider.
 *
 * Gemini CLI reads custom commands from `.gemini/commands/*.toml` (project, then user).
 * The installed CLI offers no JSON catalogue, so discovery is a filesystem scan and the
 * `description` key is read without evaluating the prompt body.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../../logger.js';
import { sanitizeSkills } from './skillScanner.js';
import {
  DiscoverCapabilitiesParams,
  DiscoveredSkill,
  ProviderCapabilities,
  SkillScope,
  emptyCapabilities,
} from './types.js';

export function buildGeminiCommandDirectories(
  workingDirectory: string,
  home: string | undefined,
): string[] {
  const directories = [path.join(workingDirectory, '.gemini', 'commands')];
  if (home) directories.push(path.join(home, '.gemini', 'commands'));
  return directories;
}

/** Reads only the top-level `description = "..."` scalar; the prompt body is ignored. */
export function parseGeminiCommandDescription(contents: string): string | undefined {
  const match = /^\s*description\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m.exec(contents);
  const value = (match?.[1] ?? match?.[2])?.trim();
  return value || undefined;
}

/**
 * Nested folders become namespaced commands (`git/commit.toml` → `/git:commit`), matching
 * how the Gemini CLI derives command names.
 */
function collectCommandFiles(directory: string, prefix: string, depth: number): { name: string; file: string }[] {
  if (depth > 3) return [];

  let entries: fs.Dirent[];
  try {
    if (!fs.existsSync(directory)) return [];
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (e) {
    logger.debug('capabilities.gemini.read_dir_failed', { err: String(e) });
    return [];
  }

  const found: { name: string; file: string }[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectCommandFiles(full, `${prefix}${entry.name}:`, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.toml')) {
      found.push({ name: `${prefix}${entry.name.slice(0, -5)}`, file: full });
    }
  }
  return found;
}

export function discoverGeminiSkills(
  workingDirectory: string,
  home: string | undefined,
): DiscoveredSkill[] {
  const sources: { directory: string; scope: SkillScope }[] = [
    { directory: path.join(workingDirectory, '.gemini', 'commands'), scope: 'project' },
    ...(home ? [{ directory: path.join(home, '.gemini', 'commands'), scope: 'user' as SkillScope }] : []),
  ];

  const byName = new Map<string, DiscoveredSkill>();
  for (const { directory, scope } of sources) {
    for (const { name, file } of collectCommandFiles(directory, '', 0)) {
      if (byName.has(name)) continue;

      let description: string | undefined;
      try {
        description = parseGeminiCommandDescription(fs.readFileSync(file, 'utf8'));
      } catch {
        description = undefined;
      }

      byName.set(name, {
        id: name,
        name,
        description,
        invocation: `/${name}`,
        scope,
        userInvocable: true,
        enabled: true,
      });
    }
  }

  return [...byName.values()];
}

export function discoverGeminiCapabilities(
  params: DiscoverCapabilitiesParams,
  home: string | undefined = process.env.USERPROFILE || process.env.HOME,
): ProviderCapabilities {
  const base = emptyCapabilities('gemini', params, 'static');
  base.skills = sanitizeSkills(discoverGeminiSkills(params.workingDirectory, home));
  return base;
}
