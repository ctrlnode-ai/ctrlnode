/**
 * @file skillScanner.ts
 * @description Static, read-only discovery of `SKILL.md` folders plus payload sanitization.
 *
 * Discovery reads frontmatter metadata only — the body of a SKILL.md is instructions for an
 * agent and is never parsed as configuration nor executed here.
 */

import fs from 'fs';
import path from 'path';

import { logger } from '../../logger.js';
import {
  DiscoveredSkill,
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_SKILLS,
  SkillScope,
} from './types.js';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  argumentHint?: string;
}

const FRONTMATTER_KEYS = new Set(['name', 'description', 'argument-hint', 'argumenthint']);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Extracts the leading `---` YAML block. Deliberately a minimal line reader rather than a
 * YAML parser: only flat scalar keys matter, and the body must never influence the result.
 */
export function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const normalized = contents.replace(/^﻿/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(normalized);
  if (!match) return {};

  const result: SkillFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    if (!FRONTMATTER_KEYS.has(key)) continue;

    const value = unquote(line.slice(separator + 1));
    if (!value) continue;

    if (key === 'name') result.name = value;
    else if (key === 'description') result.description = value;
    else result.argumentHint = value;
  }
  return result;
}

/** Metadata read from disk, before provider-specific invocation syntax is applied. */
export interface ScannedSkill {
  name: string;
  description?: string;
  argumentHint?: string;
  scope: SkillScope;
}

/**
 * Walks each directory one level deep looking for `<dir>/<skill>/SKILL.md`.
 * Earlier directories take precedence, matching how the CLIs resolve name collisions.
 */
export function scanSkillDirectories(directories: string[], scope: SkillScope): ScannedSkill[] {
  const byName = new Map<string, ScannedSkill>();

  for (const directory of directories) {
    let entries: fs.Dirent[];
    try {
      if (!fs.existsSync(directory)) continue;
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (e) {
      logger.debug('skill_scanner.read_dir_failed', { directory, err: String(e) });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillFile = path.join(directory, entry.name, 'SKILL.md');
      let frontmatter: SkillFrontmatter = {};
      try {
        if (!fs.existsSync(skillFile)) continue;
        frontmatter = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8'));
      } catch (e) {
        logger.debug('skill_scanner.read_skill_failed', { skill: entry.name, err: String(e) });
        continue;
      }

      const name = frontmatter.name?.trim() || entry.name;
      if (byName.has(name)) continue;

      byName.set(name, {
        name,
        description: frontmatter.description,
        argumentHint: frontmatter.argumentHint,
        scope,
      });
    }
  }

  return [...byName.values()];
}

/** Windows drive paths and POSIX home paths that must not reach the browser. */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/][^\s'"]*)|(?:\/(?:home|Users|root|var|etc|opt)\/[^\s'"]*)/g;

function redact(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(ABSOLUTE_PATH_PATTERN, '[path]').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

/**
 * Final gate before serialization: enforces size ceilings and strips absolute paths.
 * Applied to every adapter's output, including CLI-sourced catalogues.
 */
export function sanitizeSkills(skills: DiscoveredSkill[]): DiscoveredSkill[] {
  const result: DiscoveredSkill[] = [];
  const seen = new Set<string>();

  for (const skill of skills) {
    const name = redact(skill.name, MAX_NAME_LENGTH);
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    result.push({
      id: redact(skill.id, MAX_NAME_LENGTH) || name,
      name,
      description: redact(skill.description, MAX_DESCRIPTION_LENGTH),
      argumentHint: redact(skill.argumentHint, MAX_NAME_LENGTH),
      invocation: skill.invocation,
      scope: skill.scope,
      userInvocable: skill.userInvocable,
      enabled: skill.enabled,
    });

    if (result.length >= MAX_SKILLS) break;
  }

  return result;
}
