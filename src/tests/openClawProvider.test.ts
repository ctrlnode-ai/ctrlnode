// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import path from 'path';
import { OpenClawProvider } from '../providers/OpenClawProvider';
import { discoveredAgents } from '../agentDiscovery';
import { ctrlnodePath, CTRLNODE_ROOT } from '../config';

const AGENT_ID = 'test-agent-1';
const WORKSPACE = '/tmp/test-workspace';

beforeEach(() => {
  discoveredAgents[AGENT_ID] = { workspace: WORKSPACE, name: 'Test', model: 'default' };
});

afterEach(() => {
  delete discoveredAgents[AGENT_ID];
});

describe('OpenClawProvider.resolveFilesystemBase', () => {
  test('returns openclaw ctrlnode path when useCtrlnode=true regardless of agentId', () => {
    const provider = new OpenClawProvider();
    const expected = path.join(path.dirname(ctrlnodePath), 'ctrlnode');
    expect(provider.resolveFilesystemBase('any', true)).toBe(expected);
    expect(provider.resolveFilesystemBase(undefined, true)).toBe(expected);
  });

  test('returns agent workspace when useCtrlnode=false and agent exists', () => {
    const provider = new OpenClawProvider();
    expect(provider.resolveFilesystemBase(AGENT_ID, false)).toBe(WORKSPACE);
  });

  test('returns null when useCtrlnode=false and agent does not exist', () => {
    const provider = new OpenClawProvider();
    expect(provider.resolveFilesystemBase('ghost-agent', false)).toBeNull();
  });

  test('returns null when useCtrlnode=false and agentId is undefined', () => {
    const provider = new OpenClawProvider();
    expect(provider.resolveFilesystemBase(undefined, false)).toBeNull();
  });
});

describe('OpenClawProvider.resolveWorkspaceCreationBase', () => {
  test('returns openclaw dirname regardless of useCtrlnode', () => {
    const provider = new OpenClawProvider();
    expect(provider.resolveWorkspaceCreationBase(true)).toBe(path.dirname(ctrlnodePath));
  });

  test('returns dirname of ctrlnodePath when useCtrlnode=false', () => {
    const provider = new OpenClawProvider();
    expect(provider.resolveWorkspaceCreationBase(false)).toBe(path.dirname(ctrlnodePath));
  });
});
