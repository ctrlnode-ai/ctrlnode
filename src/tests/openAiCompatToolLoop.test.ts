// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runToolLoop, extractFallbackToolCalls } from '../providers/openAiCompatToolLoop';

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('extractFallbackToolCalls', () => {
  test('returns [] for plain text with no code blocks', () => {
    expect(extractFallbackToolCalls('just some narrative text, no code')).toEqual([]);
  });

  test('returns [] for a code block containing non-JSON text', () => {
    const content = '```\nnot json at all\n```';
    expect(extractFallbackToolCalls(content)).toEqual([]);
  });

  test('returns [] for a JSON block missing the arguments key', () => {
    const content = '```json\n{"name": "write_file"}\n```';
    expect(extractFallbackToolCalls(content)).toEqual([]);
  });

  test('returns [] for a JSON block with an extra unexpected key', () => {
    const content = '```json\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "x"}, "extra": 1}\n```';
    expect(extractFallbackToolCalls(content)).toEqual([]);
  });

  test('returns [] when arguments is not an object', () => {
    const content = '```json\n{"name": "write_file", "arguments": "not an object"}\n```';
    expect(extractFallbackToolCalls(content)).toEqual([]);
  });

  test('parses a single block with the json language tag and a newline before the JSON', () => {
    const content = 'Step 1 - do it\n```json\n{"name": "write_file", "arguments": {"path": "out.md", "content": "hi"}}\n```';
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(1);
    expect(result[0].function.name).toBe('write_file');
    expect(JSON.parse(result[0].function.arguments)).toEqual({ path: 'out.md', content: 'hi' });
  });

  test('parses a single block with no language tag', () => {
    const content = '```\n{"name": "write_file", "arguments": {"path": "out.md", "content": "hi"}}\n```';
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(1);
    expect(result[0].function.name).toBe('write_file');
  });

  test('parses a same-line fence with no newline before the JSON (observed from qwen2.5-coder)', () => {
    const content = '```json{"name": "write_file", "arguments": {"path": "out.md", "content": "hi"}}```';
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(1);
    expect(result[0].function.name).toBe('write_file');
  });

  test('parses multiple blocks in order (the real multi-step scenario reported by the user)', () => {
    const content = [
      'Plan',
      'Step 0 - Create Output Folder',
      '```json',
      '{"name": "write_file", "arguments": {"path": "output/", "content": ""}}',
      '```',
      'Step 1 - Write HTML File',
      '```json',
      '{"name": "write_file", "arguments": {"path": "output/index.html", "content": "<html>hola</html>"}}',
      '```',
      'Step 2 - Summarize Work',
      '```json',
      '{"name": "write_file", "arguments": {"path": "output/summary.md", "content": "# summary"}}',
      '```',
    ].join('\n');

    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(3);
    expect(JSON.parse(result[0].function.arguments).path).toBe('output/');
    expect(JSON.parse(result[1].function.arguments).path).toBe('output/index.html');
    expect(JSON.parse(result[2].function.arguments).path).toBe('output/summary.md');
  });

  test('does not truncate when arguments.content itself contains a nested fenced code block', () => {
    // Regression test for the moderate issue found in spec review: a naive
    // fence-closing regex truncates at the FIRST inner ``` inside the JSON string value.
    const nestedContent = 'Here is a sample:\\n```\\nsome code\\n```\\nend of sample';
    const content = `\`\`\`json\n{"name": "write_file", "arguments": {"path": "out.md", "content": "${nestedContent}"}}\n\`\`\``;
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(1);
    const parsedArgs = JSON.parse(result[0].function.arguments);
    expect(parsedArgs.content).toBe(JSON.parse(`"${nestedContent}"`));
  });

  test('recovers the real tool call when an unmatched brace appears in prose before it', () => {
    const content = 'The config uses { as a delimiter. Anyway, here is the real call:\n```json\n{"name": "write_file", "arguments": {"path": "out.md", "content": "hi"}}\n```';
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(1);
    expect(result[0].function.name).toBe('write_file');
  });

  test('assigns unique synthetic ids to each extracted call', () => {
    const content = '```json\n{"name": "write_file", "arguments": {"path": "a.md", "content": "1"}}\n```\n```json\n{"name": "write_file", "arguments": {"path": "b.md", "content": "2"}}\n```';
    const result = extractFallbackToolCalls(content);
    expect(result.length).toBe(2);
    expect(result[0].id).not.toBe(result[1].id);
  });
});

describe('runToolLoop', () => {
  let cwd: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  const callbacks = { onStream: () => {}, onMessage: () => {}, onComplete: () => {} };
  const baseCfg = {
    baseUrl: 'https://example.test/api',
    authHeaders: () => ({}),
    maxTurns: 20,
    logPrefix: 'openrouter' as const,
    requestTimeoutMs: 5_000,
  };

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-loop-test-'));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fetchSpy?.mockRestore();
  });

  test('happy path: one tool_calls turn (write_file) then stop', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.md', content: 'hello' }) } }],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
    });

    const result = await runToolLoop('t1', 'some-model', 'system prompt', 'user prompt', cwd, baseCfg, callbacks, () => false);

    expect(result.finishedNaturally).toBe(true);
    expect(result.accumulatedText).toContain('TASK_COMPLETED');
    expect(fs.readFileSync(path.join(cwd, 'out.md'), 'utf8')).toBe('hello');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('falls back to executing a JSON tool call embedded in narrative text when tool_calls is empty', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            finish_reason: 'stop', // model did NOT use real tool_calls
            message: {
              content: 'Step 1 - Write the file\n```json\n{"name": "write_file", "arguments": {"path": "out.md", "content": "hello from fallback"}}\n```',
              tool_calls: [],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
    });

    const result = await runToolLoop('t-fallback', 'some-model', 'system prompt', 'user prompt', cwd, baseCfg, callbacks, () => false);

    expect(fs.readFileSync(path.join(cwd, 'out.md'), 'utf8')).toBe('hello from fallback');
    expect(result.activityLog).toContain('[tool] write_file');
    expect(result.activityLog).toContain('out.md');
    expect(fetchSpy).toHaveBeenCalledTimes(2); // confirms the loop continued to a 2nd turn, per the fallback-calls-continue-the-loop design decision
  });

  test('returns finishedNaturally with no tool execution when there is no embedded JSON and no real tool_calls', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'just a plain text answer, no tools', tool_calls: [] } }] });
    });

    const result = await runToolLoop('t-no-fallback', 'some-model', 'system', 'user', cwd, baseCfg, callbacks, () => false);

    expect(result.finishedNaturally).toBe(true);
    expect(result.accumulatedText).toBe('just a plain text answer, no tools');
    expect(fetchSpy).toHaveBeenCalledTimes(1); // did NOT continue the loop — confirms unchanged behavior when nothing is found
  });

  test('activityLog includes tool call names/targets while accumulatedText stays final-text-only', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.md', content: 'hello' }) } }],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'final summary' } }] });
    });

    const result = await runToolLoop('t-activity', 'some-model', 'system', 'user', cwd, baseCfg, callbacks, () => false);

    expect(result.accumulatedText).toBe('final summary');
    expect(result.activityLog).toContain('[tool] write_file');
    expect(result.activityLog).toContain('out.md');
    expect(result.activityLog).toContain('final summary');
    expect(result.activityLog).not.toBe(result.accumulatedText);
  });

  test('read_file rejects a path that escapes the working directory', async () => {
    let secondBody: any = null;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      const parsed = JSON.parse(init.body);
      if (parsed.messages.some((m: any) => m.role === 'tool')) {
        secondBody = parsed;
        return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
      }
      return jsonResponse({
        choices: [{
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: JSON.stringify({ path: '../../etc/passwd' }) } }] },
        }],
      });
    });

    await runToolLoop('t2', 'some-model', 'system', 'user', cwd, baseCfg, callbacks, () => false);

    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toContain('ERROR: path escapes working directory');
  });

  test('stops after maxTurns without finish_reason stop and reports finishedNaturally=false', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({
      choices: [{
        finish_reason: 'tool_calls',
        message: { content: null, tool_calls: [{ id: 'call_x', function: { name: 'glob_files', arguments: JSON.stringify({ pattern: '**/*' }) } }] },
      }],
    }));

    const cfg = { ...baseCfg, maxTurns: 3 };
    const result = await runToolLoop('t3', 'some-model', 'system', 'user', cwd, cfg, callbacks, () => false);

    expect(result.finishedNaturally).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test('stops immediately when isCancelled() returns true', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'x' } }] }));
    const result = await runToolLoop('t4', 'm', 's', 'u', cwd, baseCfg, callbacks, () => true);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(result.accumulatedText).toBe('');
  });

  test('throws with .status set when the HTTP response is not ok', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('payment required', { status: 402 }));
    await expect(runToolLoop('t5', 'm', 's', 'u', cwd, baseCfg, callbacks, () => false)).rejects.toMatchObject({ status: 402 });
  });

  test('edit_file writes new_string literally even when it contains $-pattern substitution tokens', async () => {
    fs.writeFileSync(path.join(cwd, 'target.md'), 'before MARKER after', 'utf8');
    let secondBody: any = null;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      const parsed = JSON.parse(init.body);
      if (parsed.messages.some((m: any) => m.role === 'tool')) {
        secondBody = parsed;
        return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
      }
      return jsonResponse({
        choices: [{
          finish_reason: 'tool_calls',
          message: {
            content: null,
            tool_calls: [{
              id: 'call_1',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ path: 'target.md', old_string: 'MARKER', new_string: 'money: $& / group: $1 / literal: $$' }),
              },
            }],
          },
        }],
      });
    });

    await runToolLoop('t6', 'some-model', 'system', 'user', cwd, baseCfg, callbacks, () => false);

    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe('OK: file edited');
    expect(fs.readFileSync(path.join(cwd, 'target.md'), 'utf8')).toBe('before money: $& / group: $1 / literal: $$ after');
  });

  test('grep_files rejects a pattern longer than 200 characters with an ERROR result', async () => {
    fs.writeFileSync(path.join(cwd, 'file.txt'), 'some content\n', 'utf8');
    const longPattern = 'a'.repeat(201);
    let secondBody: any = null;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (_url: any, init: any) => {
      const parsed = JSON.parse(init.body);
      if (parsed.messages.some((m: any) => m.role === 'tool')) {
        secondBody = parsed;
        return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }] });
      }
      return jsonResponse({
        choices: [{
          finish_reason: 'tool_calls',
          message: { content: null, tool_calls: [{ id: 'call_1', function: { name: 'grep_files', arguments: JSON.stringify({ pattern: longPattern }) } }] },
        }],
      });
    });

    await runToolLoop('t7', 'some-model', 'system', 'user', cwd, baseCfg, callbacks, () => false);

    const toolMsg = secondBody.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toBe('ERROR: pattern too long (max 200 characters)');
  });

  test('uses real tool_calls even when finish_reason is not "tool_calls" (defensive against non-conformant providers)', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            finish_reason: 'stop', // unusual: provider says stop but still populated tool_calls
            message: {
              content: null,
              tool_calls: [{ id: 'call_1', function: { name: 'write_file', arguments: JSON.stringify({ path: 'out.md', content: 'real call used' }) } }],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
    });

    const result = await runToolLoop('t-real-despite-stop', 'some-model', 'system prompt', 'user prompt', cwd, baseCfg, callbacks, () => false);

    expect(fs.readFileSync(path.join(cwd, 'out.md'), 'utf8')).toBe('real call used');
    expect(result.activityLog).toContain('[tool] write_file');
  });

  test('executes multiple fallback tool calls detected in one turn, in order', async () => {
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) {
        return jsonResponse({
          choices: [{
            finish_reason: 'stop',
            message: {
              content: '```json\n{"name": "write_file", "arguments": {"path": "a.md", "content": "first"}}\n```\n```json\n{"name": "write_file", "arguments": {"path": "b.md", "content": "second"}}\n```',
              tool_calls: [],
            },
          }],
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '<TASK_COMPLETED:done>' } }] });
    });

    const result = await runToolLoop('t-multi-fallback', 'some-model', 'system prompt', 'user prompt', cwd, baseCfg, callbacks, () => false);

    expect(fs.readFileSync(path.join(cwd, 'a.md'), 'utf8')).toBe('first');
    expect(fs.readFileSync(path.join(cwd, 'b.md'), 'utf8')).toBe('second');
  });
});
