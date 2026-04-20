/**
 * @file agentDiscovery.ts
 * @description Agent discovery, configuration I/O, and sync logic.
 *
 * Agents are discovered and managed directly from `openclaw.json`
 * per https://docs.openclaw.ai/concepts/multi-agent.
 *
 * On each sync agents are discovered, newly added agents receive a
 * file-system watcher, and removed agents have theirs torn down.
 * Callers receive change notifications via callbacks instead of a
 * direct dependency on the watcher or WebSocket modules.
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { AgentInfo, AgentSummary } from './types';
import { OPENCLAW_CONFIG, ctrlnodePath } from './config';
import { logger } from './logger';
import { ensureDir } from './fileSystem';

// ── Runtime state ─────────────────────────────────────────────────────────────

/** Map of agentId → AgentInfo for every currently known agent. */
export let discoveredAgents: Record<string, AgentInfo> = {};

/** Map of agentId → "idle" | "running" tracking filesystem activity. */
export const agentStatuses: Record<string, string> = {};

/**
 * Canonicalizes a user-provided agent ID for stable storage and lookups.
 */
export function normalizeAgentId(agentId: string | undefined | null): string {
  return (agentId ?? '').trim().toLowerCase();
}

// ── Config I/O ────────────────────────────────────────────────────────────────

/**
 * Reads and parses the main OpenClaw configuration file (openclaw.json).
 *
 * @returns Parsed config object, or null if the file is missing or invalid JSON.
 */
export function readOpenClawConfig(): any {
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, 'utf8'));
  } catch (err: any) {
    console.error(`[BRIDGE] Cannot read ${OPENCLAW_CONFIG}: ${err.message}`);
    return null;
  }
}

/**
 * Writes the given config object to openclaw.json.
 * All agent updates go directly into the main OpenClaw configuration.
 *
 * @param config - The full config object to serialise as JSON.
 */
export function writeOpenClawConfig(config: any): void {
  try {
    ensureDir(path.dirname(OPENCLAW_CONFIG));
    fs.writeFileSync(OPENCLAW_CONFIG, JSON.stringify(config, null, 2), 'utf8');
    logger.info('openclaw_config_written', {
      path: OPENCLAW_CONFIG,
      agentsCount: Array.isArray(config?.agents?.list) ? config.agents.list.length : 0,
    });
  } catch (err: any) {
    logger.error('openclaw_config_write_failed', { path: OPENCLAW_CONFIG, error: err?.message });
    console.error(`[BRIDGE] Failed to write ${OPENCLAW_CONFIG}: ${err.message}`);
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Converts a raw config object (from openclaw.json or agents-config.json)
 * into a normalised agents map.
 *
 * Workspace paths that are relative are resolved against the directory
 * that contains openclaw.json. Entries without an `id` field are ignored.
 *
 * @param config - Parsed JSON config object with an `agents.list` array.
 * @returns Map of agentId → {@link AgentInfo}.
 */
function discoverAgents(config: any): Record<string, AgentInfo> {
  if (!config?.agents?.list) return {};

  const result: Record<string, AgentInfo> = {};

  for (const a of config.agents.list.filter((entry: any) => !!entry.id)) {
    const normalizedId = normalizeAgentId(a.id);
    if (!normalizedId || normalizedId === 'main') continue;

        const rawWorkspace = a.workspace || config?.agents?.defaults?.workspace || '/root/.openclaw/workspace';
        const workspace = path.isAbsolute(rawWorkspace)
          ? rawWorkspace
          : path.resolve(path.dirname(OPENCLAW_CONFIG), rawWorkspace);

        const info: AgentInfo = { workspace, name: a.name || normalizedId, model: a.model || 'default' };
        if (a.role)        info.role        = a.role;
        if (a.emoji)       info.emoji       = a.emoji;
        if (a.description) info.description = a.description;

        result[normalizedId] = info;
  }

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds the array of agent summaries that is included in handshake and
 * agent_update messages sent to the SaaS.
 *
 * @returns Array of {@link AgentSummary} objects, one per discovered agent.
 */
export function buildAgentSummaries(): AgentSummary[] {
  return Object.entries(discoveredAgents).map(([id, info]) => ({
    id,
    ...info,
    exists:   fs.existsSync(info.workspace),
    hostname: os.hostname(),
  }));
}

/**
 * Returns true if the given agent's workspace resides inside the Mission Control
 * ctrlnode directory (i.e. it is a Mission Control-managed agent).
 *
 * @param agentId - The agent ID to check.
 * @returns True when the agent workspace is under the ctrlnode path.
 */
export function isAgentInCtrlnode(agentId: string): boolean {
  const info = discoveredAgents[normalizeAgentId(agentId)];
  if (!info) return false;
  return path.resolve(info.workspace).startsWith(path.resolve(ctrlnodePath));
}

// ── Sync callbacks ────────────────────────────────────────────────────────────

/**
 * Callbacks passed to {@link syncAgentDiscovery} so the discovery module
 * does not directly depend on the watcher or WebSocket modules.
 */
export type SyncCallbacks = {
  /** Called when a new agent ID is found and a watcher should be started. */
  onAgentAdded: (id: string, info: AgentInfo) => void;
  /** Called when an agent ID disappears and its watcher should be stopped. */
  onAgentRemoved: (id: string) => void;
  /** Called after all additions/removals so the caller can push an update to the SaaS. */
  onChanged: () => void;
};

/**
 * Reads openclaw.json and compares the discovered agents against
 * the currently known agent list.
 *
 * - New agents trigger `onAgentAdded` and default to "idle" status.
 * - Removed agents trigger `onAgentRemoved` and have their status deleted.
 * - When any change occurred, `onChanged` is called once at the end.
 *
 * Safe to call repeatedly (on startup, periodic poll, and after config writes).
 *
 * @param callbacks - {@link SyncCallbacks} to notify about individual changes.
 */
export function syncAgentDiscovery(callbacks: SyncCallbacks): void {
  const merged: Record<string, AgentInfo> = discoverAgents(readOpenClawConfig());

  let changed = false;

  for (const [id, info] of Object.entries(merged)) {
    if (!discoveredAgents[id]) {
      logger.info('agent_discovered', { agentId: id, workspace: info.workspace });
      agentStatuses[id] = 'idle';
      callbacks.onAgentAdded(id, info);
      changed = true;
    }
  }

  for (const id of Object.keys(discoveredAgents)) {
    if (!merged[id]) {
      logger.info('agent_removed', { agentId: id });
      callbacks.onAgentRemoved(id);
      delete agentStatuses[id];
      changed = true;
    }
  }

  discoveredAgents = merged;
  if (changed) callbacks.onChanged();
}

// ── Agent config mutations ────────────────────────────────────────────────────

/**
 * Creates or updates an agent entry in openclaw.json under agents.list[].
 * Only the provided fields are written; existing fields are preserved.
 *
 * Per https://docs.openclaw.ai/concepts/multi-agent, all agent configuration
 * lives in openclaw.json, including model, workspace, and other metadata.
 *
 * @param agentId - The agent ID to create or update.
 * @param fields  - Partial agent fields to merge into the stored entry.
 */
export function upsertAgentConfig(
  agentId: string,
  fields: { name?: string; model?: string; workspace?: string }
): void {
  const normalizedId = normalizeAgentId(agentId);
  if (!normalizedId) return;

  const config = readOpenClawConfig() ?? { agents: { list: [] } };
  config.agents ??= { list: [] };
  config.agents.list ??= [];

  for (const a of config.agents.list) {
    if (a?.id) a.id = normalizeAgentId(a.id);
  }

  const existing = config.agents.list.find((a: any) => a.id === normalizedId);
  const operation = existing ? 'update' : 'create';
  logger.info('agent_metadata_update_attempt', {
    agentId: normalizedId,
    operation,
    configPath: OPENCLAW_CONFIG,
    hasName: fields.name !== undefined,
    hasModel: fields.model !== undefined,
    hasWorkspace: fields.workspace !== undefined,
  });

  if (existing) {
    Object.assign(existing, fields);
    existing.sandbox = existing.sandbox || { mode: "off" };
  } else {
    config.agents.list.push({ id: normalizedId, sandbox: { mode: "off" }, ...fields });
  }

  writeOpenClawConfig(config);

  const persisted = readOpenClawConfig();
  const persistedAgent = persisted?.agents?.list?.find((a: any) => normalizeAgentId(a?.id) === normalizedId);

  if (persistedAgent) {
    logger.info('agent_metadata_persisted', {
      agentId: normalizedId,
      operation,
      configPath: OPENCLAW_CONFIG,
      agentsCount: Array.isArray(persisted?.agents?.list) ? persisted.agents.list.length : null,
      workspace: persistedAgent.workspace ?? null,
    });
  } else {
    logger.error('agent_metadata_persist_failed', {
      agentId: normalizedId,
      operation,
      configPath: OPENCLAW_CONFIG,
    });
  }

  logger.info('agent_metadata_updated', { agentId: normalizedId });
}

/**
 * Removes an agent entry from openclaw.json's agents.list[].
 * Does nothing and returns false if the agent was not found in the file.
 *
 * @param agentId - The agent ID to remove.
 * @returns True if the entry was found and deleted; false otherwise.
 */
export function deleteAgentConfig(agentId: string): boolean {
  const normalizedId = normalizeAgentId(agentId);
  if (!normalizedId) return false;

  const config = readOpenClawConfig();
  if (!config?.agents?.list) return false;

  for (const a of config.agents.list) {
    if (a?.id) a.id = normalizeAgentId(a.id);
  }

  const before = config.agents.list.length;
  config.agents.list = config.agents.list.filter((a: any) => a.id !== normalizedId);
  if (config.agents.list.length === before) return false;

  writeOpenClawConfig(config);
  logger.info('agent_deleted', { agentId: normalizedId });
  return true;
}
