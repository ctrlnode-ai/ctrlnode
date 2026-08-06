/**
 * openAiCompatToolLoop.ts — shared tool-calling loop for any provider that speaks
 * an OpenAI-compatible chat-completions API with `tools` (OpenRouter, Ollama, ...).
 * Providers differ only in base URL, auth headers, extra body fields, and how they
 * interpret a turn's raw response (e.g. OpenRouter reads usage.cost) — everything
 * else (the loop itself, tool execution, path safety) lives here once.
 */
import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { resolveSecurePath } from './providerFileUtils.js';
import { TaskCallbacks } from './IProvider.js';

export const TOOL_SCHEMAS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a UTF-8 text file relative to the task working directory.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write (overwrite) a UTF-8 text file relative to the task working directory. Creates parent directories.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'edit_file', description: 'Replace an exact substring in an existing file (must match exactly once).',
      parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'glob_files', description: 'List files matching a glob pattern under the task working directory.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep_files', description: 'Search for a regex pattern across files under the task working directory.',
      parameters: { type: 'object', properties: { pattern: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } } },
] as const;

export interface FallbackToolCall {
  id: string;
  function: { name: string; arguments: string };
}

/**
 * Fallback for models (confirmed with Ollama-served llama3.2:3b and qwen2.5-coder) that
 * describe a tool call as narrative text with an embedded JSON block instead of using
 * the real `tool_calls` mechanism, even with tool_choice: "required". Scans `content`
 * for `{name, arguments}`-shaped JSON inside fenced code blocks and returns them in the
 * same shape as real tool_calls, so the caller can execute them through the identical
 * path.
 *
 * Deliberately NOT a naive fence-closing regex: `arguments.content` is arbitrary free
 * text and can itself contain a fenced code block (e.g. narrating a write_file call
 * whose content is a markdown snippet with its own ``` inside it) — a regex searching
 * for the next ``` would truncate at that inner fence. Instead, once an opening fence
 * is found, this does a brace-depth-aware scan that respects JSON string literals, so
 * nested fence-like text inside a string value can't corrupt the match.
 */
export function extractFallbackToolCalls(content: string): FallbackToolCall[] {
  const results: FallbackToolCall[] = [];
  if (!content) return results;

  const fenceOpenRe = /```(?:[a-zA-Z]*)?\s*/g;
  let match: RegExpExecArray | null;

  while ((match = fenceOpenRe.exec(content)) !== null) {
    const start = fenceOpenRe.lastIndex;
    const span = findBalancedJsonObject(content, start);
    if (!span) continue;

    const raw = content.slice(span.start, span.end);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (isFallbackToolCallShape(parsed)) {
      results.push({
        id: `fallback-${results.length}`,
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments) },
      });
    }

    fenceOpenRe.lastIndex = span.end;
  }

  return results;
}

function isFallbackToolCallShape(value: any): value is { name: string; arguments: Record<string, any> } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('name') || !keys.includes('arguments')) return false;
  if (typeof value.name !== 'string') return false;
  if (value.arguments === null || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) return false;
  return true;
}

function findBalancedJsonObject(content: string, fromIndex: number): { start: number; end: number } | null {
  let searchFrom = fromIndex;

  while (true) {
    let i = searchFrom;
    while (i < content.length && content[i] !== '{') i++;
    if (i >= content.length) return null;

    const start = i;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let balanced = false;

    for (; i < content.length; i++) {
      const ch = content[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          balanced = true;
          break;
        }
      }
    }

    if (balanced) return { start, end: i + 1 };

    // This candidate '{' never balanced (unmatched brace in surrounding prose) —
    // retry from just past it, not from where the scan gave up, so a stray brace
    // doesn't poison the whole search.
    searchFrom = start + 1;
  }
}

export interface ToolLoopConfig {
  /** e.g. 'https://openrouter.ai/api' or 'http://localhost:11434' — WITHOUT trailing /v1. */
  baseUrl: string;
  /** Returns extra headers (e.g. Authorization). Return {} for providers with no auth. */
  authHeaders: () => Record<string, string>;
  /** Extra fields merged into the request body — e.g. { max_tokens } or { options: { num_ctx } }. */
  extraBody?: Record<string, any>;
  maxTurns: number;
  /** Called once per turn with the raw response JSON. Used by OpenRouter to accumulate usage.cost. */
  onTurnResponse?: (data: any) => void;
  logPrefix: 'openrouter' | 'ollama';
  requestTimeoutMs: number;
}

export interface ToolLoopResult {
  /** Final chat text only — what goes in the fallback `output.md`. */
  accumulatedText: string;
  /**
   * Full transcript: text deltas interleaved with a line per tool call
   * (name + the file path/pattern involved). Meant for `agent_log.md` —
   * richer than accumulatedText so the log isn't identical to the output.
   */
  activityLog: string;
  /** false = hit maxTurns without the model returning finish_reason "stop". */
  finishedNaturally: boolean;
}

export async function runToolLoop(
  taskId: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  cfg: ToolLoopConfig,
  callbacks: TaskCallbacks,
  isCancelled: () => boolean,
): Promise<ToolLoopResult> {
  const messages: any[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  let accumulatedText = '';
  let activityLog = '';
  let turn = 0;

  while (turn < cfg.maxTurns) {
    turn++;
    if (isCancelled()) break;

    const resp = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cfg.authHeaders() },
      body: JSON.stringify({ model, messages, tools: TOOL_SCHEMAS, tool_choice: 'auto', ...cfg.extraBody }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      const err: any = new Error(`${cfg.logPrefix} HTTP ${resp.status}: ${body.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }

    const data = await resp.json() as any;
    cfg.onTurnResponse?.(data);

    const choice = data.choices?.[0];
    const content: string = choice?.message?.content ?? '';
    const toolCalls: any[] = choice?.message?.tool_calls ?? [];
    const finishReason: string = choice?.finish_reason ?? 'stop';

    logger.debug(`${cfg.logPrefix}.turn`, { taskId, turn, finishReason, toolCallCount: toolCalls.length });

    if (content) {
      accumulatedText += content;
      activityLog += content;
      callbacks.onStream({ kind: 'text_chunk', taskId, text: content });
      callbacks.onMessage(content);
    }

    let effectiveToolCalls = toolCalls;
    if (toolCalls.length === 0) {
      const fallbackCalls = extractFallbackToolCalls(content);
      if (fallbackCalls.length === 0) {
        return { accumulatedText, activityLog, finishedNaturally: true };
      }
      logger.info(`${cfg.logPrefix}.fallback_tool_calls_detected`, { taskId, turn, count: fallbackCalls.length });
      effectiveToolCalls = fallbackCalls;
    }

    messages.push({ role: 'assistant', content: content || null, tool_calls: effectiveToolCalls });
    for (const call of effectiveToolCalls) {
      let args: any = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* leave {} */ }
      const target = args.path ?? args.pattern ?? '';
      logger.info(`${cfg.logPrefix}.tool_use`, { taskId, tool: call.function.name, target });

      const result = await executeTool(call, cwd, taskId, cfg.logPrefix);
      activityLog += `\n\n[tool] ${call.function.name}${target ? ` → ${target}` : ''}\n${result}`;
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }

  return { accumulatedText, activityLog, finishedNaturally: false };
}

// ── Tool execution (shared, provider-agnostic) ─────────────────────────────────

async function executeTool(call: any, cwd: string, taskId: string, logPrefix: string): Promise<string> {
  let args: any = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* leave {} */ }
  const name = call.function.name;
  try {
    switch (name) {
      case 'read_file': {
        const p = resolveSecurePath(args.path, cwd);
        if (!p) return 'ERROR: path escapes working directory';
        return fs.readFileSync(p, 'utf8');
      }
      case 'write_file': {
        const p = resolveSecurePath(args.path, cwd);
        if (!p) return 'ERROR: path escapes working directory';
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, args.content, 'utf8');
        return `OK: wrote ${args.content.length} bytes to ${args.path}`;
      }
      case 'edit_file': {
        const p = resolveSecurePath(args.path, cwd);
        if (!p) return 'ERROR: path escapes working directory';
        const original = fs.readFileSync(p, 'utf8');
        const occurrences = original.split(args.old_string).length - 1;
        if (occurrences !== 1) return `ERROR: old_string matched ${occurrences} times, expected exactly 1`;
        // Function-replacer form avoids $-pattern substitution ($&, $1, $$, ...) that
        // String.prototype.replace would otherwise apply to a literal replacement string.
        fs.writeFileSync(p, original.replace(args.old_string, () => args.new_string), 'utf8');
        return 'OK: file edited';
      }
      case 'glob_files':
        return (await globCwd(cwd, args.pattern)).join('\n') || '(no matches)';
      case 'grep_files':
        return await grepCwd(cwd, args.pattern, args.glob);
      default:
        return `ERROR: unknown tool ${name}`;
    }
  } catch (err: any) {
    logger.warn(`${logPrefix}.tool_error`, { taskId, tool: name, error: err.message });
    return `ERROR: ${err.message}`;
  }
}

async function globCwd(cwd: string, pattern: string): Promise<string[]> {
  const g = new (globalThis as any).Bun.Glob(pattern);
  const out: string[] = [];
  for await (const file of g.scan({ cwd, onlyFiles: true })) out.push(file);
  return out.slice(0, 500);
}

async function grepCwd(cwd: string, pattern: string, globPattern?: string): Promise<string> {
  // Length cap as a cheap ReDoS mitigation — LLM-supplied patterns are untrusted input
  // and unbounded regex complexity (e.g. nested quantifiers) can block the event loop
  // with no timeout. A full complexity/timeout guard is a larger change; this caps the
  // most obvious pathological-pattern risk cheaply.
  if (pattern.length > 200) return 'ERROR: pattern too long (max 200 characters)';
  const re = new RegExp(pattern);
  const files = await globCwd(cwd, globPattern || '**/*');
  const hits: string[] = [];
  for (const rel of files) {
    try {
      fs.readFileSync(path.join(cwd, rel), 'utf8').split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    } catch { /* binary or unreadable — skip */ }
    if (hits.length >= 200) break;
  }
  return hits.join('\n') || '(no matches)';
}
