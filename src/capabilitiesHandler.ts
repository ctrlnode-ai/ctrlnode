/**
 * @file capabilitiesHandler.ts
 * @description Handles `query_provider_capabilities` — the read-only skill catalogue the
 * SaaS shows in the task INSTRUCTIONS slash menu.
 *
 * The working directory is resolved here, from the task mode, and never taken as a raw
 * absolute path from the browser. OUTPUT mode deliberately resolves to the ctrlnode root so
 * the menu cannot advertise project skills that the OUTPUT execution would not load.
 */

import path from 'path';

import { BASE_PATH, CTRLNODE_ROOT } from './config.js';
import { HandlerContext } from './handlerContext.js';
import { logger } from './logger.js';
import { sanitizeRelPath } from './fileSystem.js';
import { BridgeMessage } from './types.js';
import {
  CapabilityTaskMode,
  discoverStatelessCapabilities,
  emptyCapabilities,
} from './providers/capabilities/index.js';

export interface CapabilityWorkingDirectoryParams {
  taskMode: CapabilityTaskMode;
  repoPath: string | undefined;
  basePath: string;
  ctrlnodeRoot: string;
}

/**
 * Mirrors `resolveRepoDispatchSpawn`: repo mode runs from the project directory, OUTPUT mode
 * from the ctrlnode root. Any resolved path that escapes the base path collapses back to the
 * ctrlnode root rather than being trusted.
 */
export function resolveCapabilityWorkingDirectory(
  params: CapabilityWorkingDirectoryParams,
): string {
  const ctrlnodeRoot = path.resolve(params.ctrlnodeRoot);
  if (params.taskMode !== 'repo') return ctrlnodeRoot;

  const raw = params.repoPath?.trim();
  if (!raw) return ctrlnodeRoot;

  const base = path.resolve(params.basePath);
  // An absolute path is honoured only when it already resolves inside the base path.
  const candidate = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(path.join(base, sanitizeRelPath(raw)));

  const relative = path.relative(base, candidate);
  const escapes = relative.startsWith('..') || path.isAbsolute(relative);
  if (escapes) {
    logger.warn('capabilities.working_directory_rejected', { reason: 'outside_base_path' });
    return ctrlnodeRoot;
  }

  return candidate;
}

function normalizeTaskMode(value: unknown): CapabilityTaskMode {
  return value === 'repo' ? 'repo' : 'output';
}

export async function handleQueryProviderCapabilities(
  msg: BridgeMessage,
  ctx: HandlerContext,
): Promise<void> {
  const taskMode = normalizeTaskMode((msg as any).taskMode);
  const workingDirectory = resolveCapabilityWorkingDirectory({
    taskMode,
    repoPath: (msg as any).repoPath,
    basePath: BASE_PATH,
    ctrlnodeRoot: CTRLNODE_ROOT,
  });

  const params = { agentId: msg.agentId, workingDirectory, taskMode };

  logger.debug('capabilities.query_received', {
    agentId: msg.agentId,
    taskMode,
    requestId: msg.requestId,
  });

  let capabilities;
  try {
    capabilities = ctx.provider.discoverCapabilities
      ? await ctx.provider.discoverCapabilities(params)
      : discoverStatelessCapabilities(ctx.provider.providerName, params);
  } catch (e) {
    logger.warn('capabilities.query_failed', { agentId: msg.agentId, err: String(e) });
    capabilities = emptyCapabilities(ctx.provider.providerName, params);
    capabilities.discovery.warnings.push('discovery_failed');
  }

  logger.info('capabilities.query_completed', {
    agentId: msg.agentId,
    provider: capabilities.provider,
    taskMode,
    skills: capabilities.skills.length,
    discovery: capabilities.discovery.skills,
  });

  ctx.sendToSaas({
    action: 'provider_capabilities_response',
    requestId: msg.requestId,
    capabilities,
  });
}
