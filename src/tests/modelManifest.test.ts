// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import path from 'path';
import { CTRLNODE_ROOT } from '../config';
import {
  getKnownModels,
  applyManifestFromServer,
  __resetModelManifestForTests,
} from '../modelManifest';

// applyManifestFromServer() writes CTRLNODE_ROOT/model-manifest.json as a disk cache
// side effect — snapshot/restore it so these tests don't clobber a real dev cache.
const DISK_CACHE_PATH = path.join(CTRLNODE_ROOT, 'model-manifest.json');
let diskCacheBackup: string | null;

describe('getKnownModels', () => {
  beforeEach(() => {
    __resetModelManifestForTests();
    diskCacheBackup = fs.existsSync(DISK_CACHE_PATH) ? fs.readFileSync(DISK_CACHE_PATH, 'utf-8') : null;
  });

  afterEach(() => {
    if (diskCacheBackup !== null) fs.writeFileSync(DISK_CACHE_PATH, diskCacheBackup, 'utf-8');
    else fs.rmSync(DISK_CACHE_PATH, { force: true });
  });

  test('returns empty array when no manifest has been loaded (no hardcoded fallback)', () => {
    expect(getKnownModels('copilot')).toEqual([]);
    expect(getKnownModels('gemini')).toEqual([]);
    expect(getKnownModels('cursor')).toEqual([]);
    expect(getKnownModels('claude')).toEqual([]);
  });

  test('returns the provider list from a manifest applied via applyManifestFromServer', () => {
    applyManifestFromServer({
      version: 'v1',
      providers: { copilot: ['gpt-5.5', 'claude-opus-4-8'] },
    });

    expect(getKnownModels('copilot')).toEqual(['gpt-5.5', 'claude-opus-4-8']);
  });

  test('returns empty array for a provider missing from the applied manifest', () => {
    applyManifestFromServer({
      version: 'v1',
      providers: { claude: ['claude-opus-4-8'] },
    });

    expect(getKnownModels('cursor')).toEqual([]);
  });
});
