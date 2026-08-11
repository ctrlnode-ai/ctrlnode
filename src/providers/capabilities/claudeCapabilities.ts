/**
 * @file claudeCapabilities.ts
 * @description Skill discovery for the Claude Agent SDK provider.
 *
 * The SDK exposes the real, resolved catalogue via `Query.supportedCommands()`, so this is
 * the one provider where discovery is `live` rather than a filesystem scan.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

import { logger } from '../../logger.js';
import { buildCapabilityCacheKey, readCapabilityCache, writeCapabilityCache } from './capabilityCache.js';
import { sanitizeSkills } from './skillScanner.js';
import {
  CAPABILITY_SESSION_DISCOVERY_TIMEOUT_MS,
  DiscoverCapabilitiesParams,
  DiscoveredSkill,
  ProviderCapabilities,
  emptyCapabilities,
} from './types.js';

/** The subset of the SDK's SlashCommand we rely on — kept loose so SDK bumps do not break. */
export interface ClaudeSlashCommandLike {
  name: string;
  description?: string;
  argumentHint?: string;
}

/**
 * Claude invokes skills as `/name`. Names arrive without the slash, but a leading slash is
 * tolerated so an SDK change cannot produce a `//name` insertion.
 */
export function mapClaudeSlashCommands(commands: ClaudeSlashCommandLike[]): DiscoveredSkill[] {
  const skills: DiscoveredSkill[] = [];

  for (const command of commands) {
    const name = command.name?.trim().replace(/^\/+/, '');
    if (!name) continue;

    skills.push({
      id: name,
      name,
      description: command.description,
      argumentHint: command.argumentHint,
      invocation: `/${name}`,
      scope: 'user',
      userInvocable: true,
      enabled: true,
    });
  }

  return skills;
}

/**
 * Opens a short-lived SDK session purely to read its command catalogue.
 *
 * `supportedCommands()` needs streaming input mode, so the prompt is an async generator that
 * never yields — the session initializes, answers the control request, and is interrupted.
 * No turn is ever run, so this costs no tokens.
 *
 * Booting that session is slow (~19s cold, ~9-11s warm on Windows) because the SDK spawns the
 * `claude` CLI and waits for full initialization, so results are cached and the budget is
 * generous. `force` skips the cache for an explicit refresh.
 */
export async function discoverClaudeCapabilities(
  params: DiscoverCapabilitiesParams,
  buildOptions: (params: DiscoverCapabilitiesParams) => Options,
  force = false,
): Promise<ProviderCapabilities> {
  const cacheKey = buildCapabilityCacheKey('claude-sdk', params);
  if (!force) {
    const cached = readCapabilityCache(cacheKey);
    if (cached) {
      logger.debug('capabilities.claude.cache_hit', { agentId: params.agentId, skills: cached.skills.length });
      return cached;
    }
  }

  const base = emptyCapabilities('claude-sdk', params, 'live');

  let session: ReturnType<typeof query> | undefined;
  try {
    // Never yields: keeps the session in streaming-input mode without sending a turn.
    const idlePrompt = (async function* () {
      await new Promise<void>(() => {});
    })();

    session = query({ prompt: idlePrompt, options: buildOptions(params) });

    const startedAt = Date.now();
    const commands = await Promise.race([
      session.supportedCommands(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CAPABILITY_DISCOVERY_TIMEOUT')), CAPABILITY_SESSION_DISCOVERY_TIMEOUT_MS),
      ),
    ]);

    base.skills = sanitizeSkills(mapClaudeSlashCommands(commands as ClaudeSlashCommandLike[]));
    writeCapabilityCache(cacheKey, base);
    logger.info('capabilities.claude.discovered', {
      agentId: params.agentId,
      count: base.skills.length,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    const message = String(e);
    logger.warn('capabilities.claude.failed', { agentId: params.agentId, err: message });
    base.discovery.warnings.push(
      message.includes('CAPABILITY_DISCOVERY_TIMEOUT') ? 'claude_discovery_timeout' : 'claude_discovery_failed',
    );
  } finally {
    try {
      await session?.interrupt();
    } catch {
      // Session teardown is best-effort — a failed interrupt must not fail discovery.
    }
  }

  return base;
}
