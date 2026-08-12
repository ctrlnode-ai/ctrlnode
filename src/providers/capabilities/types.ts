/**
 * @file types.ts
 * @description Shared shape for provider capability discovery (skills / slash commands).
 *
 * The SaaS renders this in the task INSTRUCTIONS slash menu, so the payload must never
 * carry secrets: no env, tokens, headers, full argv, query strings or absolute user paths.
 * Adapters return metadata only — discovery never executes SKILL.md content.
 */

export type SkillScope = 'project' | 'user' | 'plugin' | 'managed' | 'builtin';

export type SkillDiscoveryMode = 'live' | 'static' | 'unsupported';

export type CapabilityTaskMode = 'output' | 'repo';

export interface DiscoveredSkill {
  /** Stable identifier within the provider (usually the skill name). */
  id: string;
  name: string;
  description?: string;
  argumentHint?: string;
  /** Text inserted into INSTRUCTIONS — native provider syntax (`/name` or `$name`). */
  invocation: string;
  scope: SkillScope;
  userInvocable: boolean;
  enabled: boolean;
}

export interface ProviderCapabilities {
  provider: string;
  agentId?: string;
  taskMode: CapabilityTaskMode;
  /** Which filesystem root the agent will actually run from for this task mode. */
  workspaceScope: 'ctrlnode' | 'project';
  skills: DiscoveredSkill[];
  discovery: {
    skills: SkillDiscoveryMode;
    warnings: string[];
    /** ISO-8601 timestamp of when the catalogue was observed. */
    observedAt: string;
  };
}

export interface DiscoverCapabilitiesParams {
  agentId?: string;
  /** Absolute working directory the task will run from. */
  workingDirectory: string;
  taskMode: CapabilityTaskMode;
}

/** Hard ceilings so a misconfigured skills folder cannot produce an enormous payload. */
export const MAX_SKILLS = 200;
export const MAX_DESCRIPTION_LENGTH = 300;
export const MAX_NAME_LENGTH = 120;

/**
 * Budget for adapters that only read a catalogue from a CLI or the filesystem. These finish in
 * well under a second when the tool is present, so a short ceiling just bounds a hung process.
 */
export const CAPABILITY_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Budget for adapters that must boot a full agent session to be asked for its commands.
 *
 * The Claude SDK spawns the `claude` CLI and completes initialization before answering
 * `supportedCommands()`; measured at ~19s cold and ~9-11s warm on Windows, where the `.cmd`
 * shim adds startup cost. A 5s ceiling therefore always timed out and reported an empty
 * catalogue even though discovery itself worked.
 */
export const CAPABILITY_SESSION_DISCOVERY_TIMEOUT_MS = 40_000;

/**
 * How long a successful catalogue stays reusable.
 *
 * Booting a session per menu open is far too slow to sit in front of a keystroke, and skills
 * change rarely — so the first open pays the cost and later ones are instant. The UI's REFRESH
 * action bypasses this.
 */
export const CAPABILITY_CACHE_TTL_MS = 5 * 60_000;

export function emptyCapabilities(
  provider: string,
  params: DiscoverCapabilitiesParams,
  skillsMode: SkillDiscoveryMode = 'unsupported',
  warnings: string[] = [],
): ProviderCapabilities {
  return {
    provider,
    agentId: params.agentId,
    taskMode: params.taskMode,
    workspaceScope: params.taskMode === 'repo' ? 'project' : 'ctrlnode',
    skills: [],
    discovery: { skills: skillsMode, warnings, observedAt: new Date().toISOString() },
  };
}
