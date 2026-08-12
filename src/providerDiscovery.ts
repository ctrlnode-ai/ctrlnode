/**
 * providerDiscovery.ts
 *
 * Fetches the canonical provider list from the backend (GET /api/agent-types)
 * so config.ts's PROVIDERS can be narrowed to whatever the backend currently
 * recognizes, mirroring the same "single source of truth on the backend"
 * principle already applied to the frontend's agent-type picker.
 *
 * Failure (network, timeout, bad JSON) returns null — callers must treat
 * that as "don't restrict anything", since an unreachable backend is not
 * evidence that a provider should be disabled.
 */
import { apiBaseUrl } from './modelManifest.js';
import { logger } from './logger.js';

const FETCH_TIMEOUT_MS = 8_000;

export async function fetchKnownProviderKeys(): Promise<string[] | null> {
  try {
    const resp = await fetch(`${apiBaseUrl()}/api/agent-types`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) {
      logger.warn('providerDiscovery.fetch_failed', { status: resp.status });
      return null;
    }
    const body = await resp.json() as { providerKeyByAgentType?: Record<string, string> };
    const keys = Object.values(body.providerKeyByAgentType ?? {}).filter(Boolean);
    if (keys.length === 0) return null;
    return [...new Set(keys)];
  } catch (err: any) {
    logger.warn('providerDiscovery.fetch_error', { message: err?.message });
    return null;
  }
}
