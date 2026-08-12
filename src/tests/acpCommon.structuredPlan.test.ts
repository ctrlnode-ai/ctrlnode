// @ts-nocheck
import { PassThrough } from 'stream';
import { afterEach, describe, expect, mock, test } from 'bun:test';

/**
 * runAcpStructuredPlan is the shared read-only planning helper reused by every
 * ACP-based provider (Gemini, Copilot, Hermes). It must open a session with no
 * MCP servers (no write tools), collect only the final agent text, and never
 * emit a task lifecycle — it is a plain request/response call.
 */
describe('acpCommon.runAcpStructuredPlan', () => {
  afterEach(() => {
    mock.restore();
  });

  function mockAcpSdk(promptImpl: (client: any, sessionParams: any, promptParams: any) => Promise<any>) {
    let capturedSessionParams: any;
    let capturedPromptParams: any;
    mock.module('@agentclientprotocol/sdk', () => ({
      PROTOCOL_VERSION: 1,
      ndJsonStream: () => ({}),
      ClientSideConnection: class {
        client: any;
        constructor(agentFactory: (agent: unknown) => any) {
          this.client = agentFactory({});
        }
        async initialize() { return {}; }
        async newSession(params: any) {
          capturedSessionParams = params;
          return { sessionId: 'session-1' };
        }
        async prompt(params: any) {
          capturedPromptParams = params;
          return promptImpl(this.client, capturedSessionParams, capturedPromptParams);
        }
      },
    }));
    return {
      getSessionParams: () => capturedSessionParams,
      getPromptParams: () => capturedPromptParams,
    };
  }

  function fakeSpawn(): any {
    const proc: any = new (require('events').EventEmitter)();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.killed = false;
    proc.kill = mock(() => { proc.killed = true; });
    return proc;
  }

  test('collects agent_message_chunk text and returns it trimmed on end_turn', async () => {
    let proc: any;
    mock.module('child_process', () => ({
      spawn: mock(() => {
        proc = fakeSpawn();
        return proc;
      }),
    }));
    mockAcpSdk(async (client) => {
      await client.sessionUpdate({
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"name":"Daily brief"}  ' } },
      });
      return { stopReason: 'end_turn' };
    });

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    const result = await runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: ['--acp'],
      cwd: process.cwd(),
      prompt: 'Create a daily brief graph.',
      timeoutMs: 5_000,
    });

    expect(result).toBe('{"name":"Daily brief"}');
  });

  test('opens the session with no MCP servers so the planner has no write tools', async () => {
    mock.module('child_process', () => ({ spawn: mock(() => fakeSpawn()) }));
    const { getSessionParams } = mockAcpSdk(async () => ({ stopReason: 'end_turn' }));

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    await runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: [],
      cwd: process.cwd(),
      prompt: 'plan',
      timeoutMs: 5_000,
    }).catch(() => {});

    expect(getSessionParams().mcpServers).toEqual([]);
  });

  test('rejects a write attempt from the planner instead of writing to disk', async () => {
    mock.module('child_process', () => ({ spawn: mock(() => fakeSpawn()) }));
    let writeAttemptError: unknown;
    mockAcpSdk(async (client) => {
      try {
        await client.writeTextFile({ path: 'output/blueprint.json', content: 'x' });
      } catch (err) {
        writeAttemptError = err;
      }
      return { stopReason: 'end_turn' };
    });

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    await runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: [],
      cwd: process.cwd(),
      prompt: 'plan',
      timeoutMs: 5_000,
    }).catch(() => {});

    expect(writeAttemptError).toBeInstanceOf(Error);
  });

  test('throws GRAPH_GENERATION_EMPTY_RESPONSE when the planner returns no text', async () => {
    mock.module('child_process', () => ({ spawn: mock(() => fakeSpawn()) }));
    mockAcpSdk(async () => ({ stopReason: 'end_turn' }));

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    await expect(runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: [],
      cwd: process.cwd(),
      prompt: 'plan',
      timeoutMs: 5_000,
    })).rejects.toThrow('GRAPH_GENERATION_EMPTY_RESPONSE');
  });

  test('throws a descriptive error for an unexpected ACP stopReason', async () => {
    mock.module('child_process', () => ({ spawn: mock(() => fakeSpawn()) }));
    mockAcpSdk(async () => ({ stopReason: 'refusal' }));

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    await expect(runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: [],
      cwd: process.cwd(),
      prompt: 'plan',
      timeoutMs: 5_000,
    })).rejects.toThrow(/refusal/);
  });

  test('kills the process and throws GRAPH_GENERATION_TIMEOUT when the planner never responds', async () => {
    let proc: any;
    mock.module('child_process', () => ({
      spawn: mock(() => { proc = fakeSpawn(); return proc; }),
    }));
    mockAcpSdk(() => new Promise(() => {})); // never resolves

    const { runAcpStructuredPlan } = await import('../providers/acpCommon');
    await expect(runAcpStructuredPlan({
      providerLog: 'test_acp',
      cmd: 'test-cli',
      args: [],
      cwd: process.cwd(),
      prompt: 'plan',
      timeoutMs: 20,
    })).rejects.toThrow('GRAPH_GENERATION_TIMEOUT');
    expect(proc.killed).toBe(true);
  });
});
