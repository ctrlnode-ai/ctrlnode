import fs from 'fs';
import path from 'path';

export interface HermesEvent {
  type: string;
  content?: string;
  id?: string;
  message?: string;
}

/** Log lines we never show in Agent Activity (infra / plugins / client lifecycle). */
const HERMES_LOG_SKIP_PATTERNS: RegExp[] = [
  /hermes_cli\.plugins/,
  /Plugin '.*' registered/,
  /run_agent:/,
  /agent\.auxiliary_client/,
  /OpenAI client (created|closed)/,
  /Copilot ACP client (created|closed)/,
  /tcp_force_closed/,
  /Nous 429 looks like upstream/,
];

/**
 * Session id embedded in Hermes agent.log lines, e.g. [20260525_014619_1ceb3a].
 * @see https://github.com/NousResearch/hermes-agent/blob/main/agent/conversation_loop.py
 */
export function extractHermesSessionId(line: string): string | undefined {
  const m = line.match(/\[(\d{8}_\d{6}_[a-f0-9]+)\]/i);
  return m?.[1];
}

export function shouldSkipHermesLogLine(line: string): boolean {
  return HERMES_LOG_SKIP_PATTERNS.some((p) => p.test(line));
}

/**
 * Turns a raw agent.log line into human-readable Agent Activity text.
 * Returns null when the line should be hidden.
 *
 * Official CLI: `hermes logs agent -f` tails ~/.hermes/logs/agent.log
 * (see https://hermes-agent.nousresearch.com/docs/reference/cli-commands).
 * There is no `hermes chat --output json` flag — activity comes from structured logs.
 */
export function formatHermesLogLineForActivity(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || shouldSkipHermesLogLine(trimmed)) return null;

  const turn = trimmed.match(
    /conversation turn: session=\S+ model=(\S+) provider=(\S+)[^]*?msg=(?:"([^"]*)"|'([^']*)')/,
  );
  if (turn) {
    const msg = (turn[3] ?? turn[4] ?? '').replace(/\s+/g, ' ').trim();
    const preview = msg.length > 120 ? `${msg.slice(0, 117)}…` : msg;
    return `→ Turn · ${turn[1]} (${turn[2]})\n   ${preview}\n`;
  }

  const api = trimmed.match(
    /API call #(\d+): model=(\S+) provider=\S+ in=(\d+) out=(\d+) total=\d+ latency=([\d.]+)s/,
  );
  if (api) {
    return `→ API #${api[1]} · ${api[2]} · in=${api[3]} out=${api[4]} · ${api[5]}s\n`;
  }

  const ended = trimmed.match(
    /Turn ended: reason=([^ ]+) model=(\S+)[^]*?tool_turns=(\d+)[^]*?response_len=(\d+)/,
  );
  if (ended) {
    const reason = ended[1].replace(/^text_response\(/, '').replace(/\)$/, '');
    return `✓ Done · ${reason} · ${ended[2]} · tools=${ended[3]} · ${ended[4]} chars\n`;
  }

  if (/Empty response after tool calls — nudging model/i.test(trimmed)) {
    return `→ Continuing after tool calls…\n`;
  }
  if (/Empty response after tool calls — using prior turn/i.test(trimmed)) {
    return `→ Using prior turn content as answer\n`;
  }
  if (/Partial stream content delivered/i.test(trimmed)) {
    return `→ Stream recovered partial response\n`;
  }
  if (/Turn ended with pending tool result/i.test(trimmed)) {
    const tool = trimmed.match(/last_tool=(\S+)/)?.[1];
    return tool ? `⚠ Turn ended with pending tool: ${tool}\n` : `⚠ Turn ended with pending tool\n`;
  }

  // Tool dispatch is usually DEBUG unless verbose; still surface explicit toolset lines.
  const toolOverride = trimmed.match(/Tool '([^']+)': toolset/);
  if (toolOverride) {
    return `→ Tool registry · ${toolOverride[1]}\n`;
  }

  const body = trimmed.replace(
    /^\d{4}-\d{2}-\d{2}[\d:.,\s]*(?:INFO|DEBUG|WARNING|ERROR)\s+(?:\[[^\]]+\]\s+)?(?:agent\.)?/,
    '',
  );
  if (!body || body.length < 8) return null;

  if (/^(conversation turn|API call #|Turn ended)/.test(body)) return null;

  return `${body}\n`;
}

/**
 * @deprecated Hermes CLI does not document JSON stdout; kept for backwards compatibility.
 */
export function parseHermesJsonLine(line: string): HermesEvent | null {
  if (!line?.trim()) return null;
  try {
    return JSON.parse(line) as HermesEvent;
  } catch {
    return null;
  }
}

export function loadPersistedSessions(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!fs.existsSync(dir)) return map;
  try {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const agentId = file.slice(0, -5);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (data.conversationId) map.set(agentId, data.conversationId as string);
      } catch { /* skip corrupted files */ }
    }
  } catch { /* skip unreadable dirs */ }
  return map;
}

export function saveConversationId(dir: string, agentId: string, convId: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${agentId}.json`),
    JSON.stringify({ conversationId: convId, updatedAt: Date.now() }),
    'utf8',
  );
}

/**
 * Returns true when a log line belongs to the active session (or has no session tag yet).
 */
export function hermesLogLineMatchesSession(line: string, sessionId: string | undefined): boolean {
  if (!sessionId) return true;
  const sid = extractHermesSessionId(line);
  return !sid || sid === sessionId;
}
