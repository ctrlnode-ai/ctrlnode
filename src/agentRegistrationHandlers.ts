/**
 * @file agentRegistrationHandlers.ts
 * @description Handlers for agent lifecycle messages: sync, delete config,
 * delete folders. Extracted from filesystemConfigHandlers.ts.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { BridgeMessage } from './types.js';
import { HandlerContext } from './handlerContext.js';
import { CTRLNODE_ROOT } from './config.js';
import { deleteDir } from './fileSystem.js';
import {
  discoveredAgents,
  agentStatuses,
  purgedAgentIds,
  buildAgentSummaries,
  upsertAgentConfig,
  deleteAgentConfig,
  normalizeAgentId,
} from './agentDiscovery.js';
import { setupCodexAgentHome } from './codexAgentHome.js';
import { ensureHermesProfile, deleteHermesProfile, writeHermesSoulMd, writeHermesProfileConfig } from './hermesProfile.js';

/** Providers that support the generic sync_provider_agents flow. */
export type SyncableProvider = 'cursor' | 'copilot' | 'codex' | 'gemini' | 'claude' | 'claude-sdk' | 'hermes';

/**
 * Generic handler for sync_{provider}_agents messages.
 * Replaces the three separate handlers (cursor / copilot / codex) — adding a
 * new provider only requires a new case in the messageHandlers switch.
 *
 * Payload: { agents: JSON string of Array<{ id, name, workspace? }> }
 * Performs an authoritative sync: registers new agents, skips tombstoned ones,
 * and removes stale agents for this provider that are no longer in the list.
 */
export function handleSyncProviderAgents(provider: SyncableProvider, msg: BridgeMessage, ctx: HandlerContext): void {
  const action = `sync_${provider}_agents`;
  const ackAction = `${action}_ack`;
  const { requestId, agents } = msg;

  if (!agents) {
    ctx.sendToSaas({ action: ackAction, requestId, success: false, error: 'MISSING_AGENTS' });
    return;
  }

  try {
    const parsed = JSON.parse(agents) as Array<{ id: string; name?: string; workspace?: string; model?: string; role?: string; description?: string }>;
    logger.debug(action, { count: parsed.length });

    const incomingIds = new Set<string>();
    for (const a of parsed) {
      const normalId = normalizeAgentId(a.id);
      if (!normalId) continue;
      incomingIds.add(normalId);
      if (purgedAgentIds.has(normalId)) {
        logger.debug(`${action}.skip_purged`, { id: normalId });
        continue;
      }
      const existing = discoveredAgents[normalId];
      discoveredAgents[normalId] = {
        workspace: a.workspace || CTRLNODE_ROOT,
        name: a.name ?? normalId,
        model: a.model || provider,
        role: a.role ?? existing?.role ?? '',
        emoji: existing?.emoji ?? '',
        description: a.description || '',
        provider,
      };
      if (!agentStatuses[normalId]) agentStatuses[normalId] = 'idle';
      logger.debug(existing ? `${action}.updated` : `${action}.registered`, {
        id: normalId, name: a.name, model: a.model, hasDescription: !!a.description,
      });

      // For codex agents: provision a persistent per-agent CODEX_HOME so
      // AGENTS.md + config.toml are written once here, not on every task run.
      if (provider === 'codex') {
        setupCodexAgentHome(normalId, a.description || '');
      }
      if (provider === 'hermes') {
        ensureHermesProfile(normalId, {
          name: a.name,
          role: a.role,
          description: a.description,
          model: a.model,
        });
      }
    }

    // Authoritative sync: remove agents for this provider no longer in the incoming list.
    // Exception: agents discovered from the local filesystem (fromFilesystem=true) are NOT
    // tombstoned — they were not registered in CtrlNode DB and should remain detectable.
    for (const [id, info] of Object.entries(discoveredAgents)) {
      if (info.provider === provider && !incomingIds.has(id) && !purgedAgentIds.has(id)) {
        if (info.fromFilesystem) {
          logger.debug(`${action}.keep_filesystem_agent`, { id });
          continue;
        }
        delete discoveredAgents[id];
        purgedAgentIds.add(id);
        if (provider === 'hermes') deleteHermesProfile(id);
        logger.debug(`${action}.removed_stale`, { id });
      }
    }

    // SDK agents (cursor, claude, etc.) don't appear in openclaw.json, so
    // force an immediate agent_update so the backend learns about them now.
    ctx.syncAgents();
    ctx.sendToSaas({ action: 'agent_update', agents: buildAgentSummaries() });
    ctx.sendToSaas({ action: ackAction, requestId, success: true, error: null });
  } catch (err: any) {
    ctx.sendToSaas({ action: ackAction, requestId, success: false, error: err.message });
  }
}

export async function handleDeleteAgentFolders(msg: BridgeMessage, ctx: HandlerContext): Promise<void> {
  const { requestId, agentId, folderName } = msg;

  if (!folderName) {
    ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success: false, deleted: [], errors: ['NO_FOLDER_SPECIFIED'] });
    return;
  }

  const deleted: string[] = [];
  const errors: string[] = [];

  const resolved = path.resolve(folderName);
  if (!resolved.startsWith('/app/')) {
    errors.push(`UNSAFE_PATH: ${folderName}`);
    logger.warn('delete_agent_folders.blocked', { folder: folderName, reason: 'outside /app/' });
    ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success: false, deleted, errors });
    return;
  }

  const ok = await deleteDir(resolved);
  if (ok) {
    deleted.push(resolved);
    logger.debug('delete_agent_folders.deleted', { agentId, folder: resolved });
  } else {
    errors.push(`DELETE_FAILED: ${resolved}`);
    logger.warn('delete_agent_folders.failed', { agentId, folder: resolved });
  }

  ctx.sendToSaas({ action: 'delete_agent_folders_response', requestId, agentId, success: errors.length === 0, deleted, errors });
}

export function handleDeleteAgentConfig(msg: BridgeMessage, ctx: HandlerContext): void {
  const normalId = normalizeAgentId(msg.agentId);
  const existing = normalId ? discoveredAgents[normalId] : undefined;
  const wasHermes = existing?.provider === 'hermes';

  // Remove from in-memory map so the next agent_update/heartbeat no longer reports this agent.
  let changed = false;
  if (normalId && existing) {
    delete discoveredAgents[normalId];
    changed = true;
  }

  if (wasHermes && normalId) {
    deleteHermesProfile(normalId);
    logger.info('delete_agent_config.hermes_home_removed', { agentId: normalId });
  }

  // Tombstone: prevent this agent from being re-added by the next discoverAgents() cycle.
  if (normalId) purgedAgentIds.add(normalId);

  // For OpenClaw: also remove from openclaw.json on disk.
  const deletedFromFile = deleteAgentConfig(normalId);
  if (deletedFromFile) changed = true;

  // For Cursor: deregister from the Cursor SDK (fire-and-forget, non-blocking).
  ctx.provider.deleteAgent(msg.agentId ?? '').then((ok) => {
    if (ok) logger.debug('delete_agent_config.cursor_sdk_deleted', { agentId: msg.agentId });
    else    logger.debug('delete_agent_config.cursor_sdk_skip', { agentId: msg.agentId });
  }).catch((err: any) => {
    logger.warn('delete_agent_config.cursor_sdk_error', { agentId: msg.agentId, error: err?.message });
  });

  if (changed) ctx.syncAgents();
}

export function handleUpdateAgentConfig(msg: BridgeMessage, ctx: HandlerContext): void {
  const { agentId, name, model, workspace } = msg;
  const normalId = normalizeAgentId(agentId);
  upsertAgentConfig(normalId, { name, model, workspace });
  // Also update the in-memory discoveredAgents entry so the new model/name is
  // used immediately for the next task dispatch (without waiting for a full
  // sync_provider_agents round-trip).
  if (normalId && discoveredAgents[normalId]) {
    if (name !== undefined) discoveredAgents[normalId].name = name;
    if (model !== undefined) discoveredAgents[normalId].model = model;
    if (workspace !== undefined) discoveredAgents[normalId].workspace = workspace;
    if (msg.role !== undefined) discoveredAgents[normalId].role = msg.role;
    if (msg.description !== undefined) discoveredAgents[normalId].description = msg.description;
    if (discoveredAgents[normalId].provider === 'hermes') {
      writeHermesSoulMd(normalId, {
        name: discoveredAgents[normalId].name,
        role: discoveredAgents[normalId].role,
        description: discoveredAgents[normalId].description,
        model: discoveredAgents[normalId].model,
      });
      writeHermesProfileConfig(normalId, discoveredAgents[normalId].model);
    }
    logger.info('update_agent_config.applied', { agentId: normalId, name, model, workspace });
  }
  ctx.syncAgents();
}
