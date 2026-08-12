import { beforeEach, describe, expect, test } from 'bun:test';
import {
  buildCapabilityCacheKey,
  clearCapabilityCache,
  readCapabilityCache,
  writeCapabilityCache,
} from '../providers/capabilities/capabilityCache.js';
import { emptyCapabilities } from '../providers/capabilities/types.js';

const params = { agentId: 'sonet-5', workingDirectory: 'C:/work', taskMode: 'output' as const };

function capabilitiesWithSkill() {
  const caps = emptyCapabilities('claude-sdk', params, 'live');
  caps.skills = [{
    id: 'review',
    name: 'review',
    invocation: '/review',
    scope: 'user',
    userInvocable: true,
    enabled: true,
  }];
  return caps;
}

beforeEach(() => clearCapabilityCache());

describe('buildCapabilityCacheKey', () => {
  test('separates agents, task modes and working directories', () => {
    const base = buildCapabilityCacheKey('claude-sdk', params);

    expect(base).not.toBe(buildCapabilityCacheKey('claude-sdk', { ...params, agentId: 'other' }));
    expect(base).not.toBe(buildCapabilityCacheKey('claude-sdk', { ...params, taskMode: 'repo' }));
    expect(base).not.toBe(buildCapabilityCacheKey('claude-sdk', { ...params, workingDirectory: 'C:/elsewhere' }));
  });
});

describe('capability cache', () => {
  test('returns a stored catalogue within its TTL', () => {
    const key = buildCapabilityCacheKey('claude-sdk', params);
    writeCapabilityCache(key, capabilitiesWithSkill());

    expect(readCapabilityCache(key)?.skills).toHaveLength(1);
  });

  test('misses once the entry has expired', () => {
    const key = buildCapabilityCacheKey('claude-sdk', params);
    writeCapabilityCache(key, capabilitiesWithSkill(), Date.now() - 1);

    expect(readCapabilityCache(key)).toBeUndefined();
  });

  test('never caches a failed discovery, so a transient failure is retried', () => {
    const key = buildCapabilityCacheKey('claude-sdk', params);
    const failed = emptyCapabilities('claude-sdk', params, 'live', ['claude_discovery_timeout']);

    writeCapabilityCache(key, failed);

    expect(readCapabilityCache(key)).toBeUndefined();
  });

  test('caches a genuinely empty catalogue that carried no warning', () => {
    const key = buildCapabilityCacheKey('claude-sdk', params);
    writeCapabilityCache(key, emptyCapabilities('claude-sdk', params, 'live'));

    expect(readCapabilityCache(key)?.skills).toEqual([]);
  });

  test('clearing drops every entry', () => {
    const key = buildCapabilityCacheKey('claude-sdk', params);
    writeCapabilityCache(key, capabilitiesWithSkill());
    clearCapabilityCache();

    expect(readCapabilityCache(key)).toBeUndefined();
  });
});
