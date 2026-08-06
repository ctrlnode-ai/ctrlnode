/**
 * modelManifest.ts
 *
 * Manages the local model manifest cache so providers always have an up-to-date
 * model list without requiring a Bridge redeploy when new models are released.
 *
 * Two sync mechanisms work together:
 *   Option A — Startup HTTP fetch: GET <api-base>/api/bridge/models
 *              Runs at process start before the WebSocket connects.
 *              Result is cached to disk (CTRLNODE_ROOT/model-manifest.json, TTL 24h).
 *
 *   Option D — Handshake push: the backend sends a `model_manifest` WebSocket
 *              message after handshake. Bridge stores it, overwriting the disk cache.
 *
 * Priority for model lists (highest → lowest):
 *   1. Provider native API (Anthropic, Gemini, Cursor) — handled in each provider
 *   2. In-memory manifest loaded by this module (ultimately sourced from
 *      model-manifest.json via the backend's GET /api/bridge/models — the single
 *      source of truth for providers with no native listModels API, e.g. Copilot)
 *
 * No hardcoded fallback: if no manifest has been loaded yet (or a provider isn't
 * present in it), getKnownModels() returns an empty list — ModelComboBox in the
 * frontend accepts free-text model ids regardless.
 */

import fs   from 'fs';
import path from 'path';
import { SAAS_URL, CTRLNODE_ROOT } from './config.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ProviderName = 'claude' | 'copilot' | 'gemini' | 'cursor';

interface ManifestFile {
  version:   string;
  fetchedAt: string;  // ISO-8601
  providers: Record<string, string[]>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MANIFEST_PATH   = path.join(CTRLNODE_ROOT, 'model-manifest.json');
const CACHE_TTL_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const FETCH_TIMEOUT_MS = 8_000;

/** Derives the HTTP(S) base URL from the WebSocket URL (wss → https, ws → http). */
export function apiBaseUrl(): string {
  return SAAS_URL
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws\/bridge$/, '');
}

// ── In-memory cache ────────────────────────────────────────────────────────────

let _manifest: ManifestFile | null = null;

// ── Disk cache helpers ────────────────────────────────────────────────────────

function readDiskCache(): ManifestFile | null {
  try {
    if (!fs.existsSync(MANIFEST_PATH)) return null;
    const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as ManifestFile;
  } catch {
    return null;
  }
}

function writeDiskCache(manifest: ManifestFile): void {
  try {
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (err: any) {
    logger.warn('model_manifest.write_failed', { error: err?.message });
  }
}

function isCacheStale(manifest: ManifestFile): boolean {
  const fetched = new Date(manifest.fetchedAt).getTime();
  return isNaN(fetched) || Date.now() - fetched > CACHE_TTL_MS;
}

// ── Fetch from backend ─────────────────────────────────────────────────────────

async function fetchFromApi(): Promise<ManifestFile | null> {
  const url = `${apiBaseUrl()}/api/bridge/models`;
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      logger.warn('model_manifest.fetch_failed', { url, status: resp.status });
      return null;
    }
    const data = await resp.json() as { version?: string; providers?: Record<string, string[]> };
    if (!data.providers || typeof data.providers !== 'object') return null;
    return {
      version:   data.version ?? new Date().toISOString().slice(0, 10),
      fetchedAt: new Date().toISOString(),
      providers: data.providers,
    };
  } catch (err: any) {
    logger.warn('model_manifest.fetch_error', { url, error: err?.message });
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Option A — Called once at Bridge startup before connecting.
 * Loads the disk cache if fresh; otherwise fetches from the API.
 * Always falls back to hardcode on any failure.
 */
export async function loadModelManifest(): Promise<void> {
  const cached = readDiskCache();

  if (cached && !isCacheStale(cached)) {
    _manifest = cached;
    logger.debug('model_manifest.loaded_from_cache', { version: cached.version });
    return;
  }

  const fetched = await fetchFromApi();
  if (fetched) {
    _manifest = fetched;
    writeDiskCache(fetched);
    logger.info('model_manifest.fetched', { version: fetched.version });
    return;
  }

  // Fetch failed — use stale cache if available, otherwise in-memory remains null (hardcode kicks in)
  if (cached) {
    _manifest = cached;
    logger.warn('model_manifest.using_stale_cache', { version: cached.version });
  } else {
    logger.warn('model_manifest.using_hardcoded_fallback');
  }
}

/**
 * Option D — Called when the Bridge receives a `model_manifest` WebSocket message
 * pushed by the backend after handshake. Updates in-memory and disk cache.
 */
export function applyManifestFromServer(data: { version?: string; providers?: Record<string, string[]> }): void {
  if (!data.providers || typeof data.providers !== 'object') return;

  const manifest: ManifestFile = {
    version:   data.version ?? new Date().toISOString().slice(0, 10),
    fetchedAt: new Date().toISOString(),
    providers: data.providers,
  };

  _manifest = manifest;
  writeDiskCache(manifest);
  logger.info('model_manifest.updated_from_server', { version: manifest.version });
}

/**
 * Returns the known model list for a provider from the loaded manifest.
 * Returns an empty array if no manifest is loaded yet or the provider isn't in it.
 */
export function getKnownModels(provider: ProviderName): string[] {
  return _manifest?.providers[provider] ?? [];
}

/** Test-only seam: clears the in-memory manifest so tests can start from a known state. */
export function __resetModelManifestForTests(): void {
  _manifest = null;
}
