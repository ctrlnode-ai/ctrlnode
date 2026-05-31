/**
 * Normalises ACP sessionUpdate payloads for Bridge streaming / Agent Activity.
 */

export type AcpMappedEvent = {
  kind: string;
  text?: string;
  taskId: string;
  raw: unknown;
};

export function mapAcpUpdate(taskId: string, update: unknown): AcpMappedEvent | undefined {
  if (!update || typeof update !== 'object') return undefined;
  const u = update as Record<string, unknown>;

  if (u.sessionUpdate === 'agent_message_chunk' && (u.content as any)?.type === 'text') {
    return {
      kind: 'text_chunk',
      text: String((u.content as any).text ?? ''),
      taskId,
      raw: update,
    };
  }

  if (u.sessionUpdate === 'agent_thought' && (u.content as any)?.type === 'text') {
    return {
      kind: 'thinking',
      text: String((u.content as any).text ?? ''),
      taskId,
      raw: update,
    };
  }

  if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_result') {
    return { kind: String(u.sessionUpdate), taskId, raw: update };
  }

  return undefined;
}

/** Human-readable line for Agent Activity when a tool starts. */
export function formatAcpToolCallActivity(update: Record<string, unknown>): string {
  const title =
    (update.title as string | undefined)
    || ((update.rawInput as any)?.description as string | undefined)
    || ((update.rawInput as any)?.command as string | undefined)
    || (update.toolCallId as string | undefined)
    || 'tool';
  return `→ ${title}\n`;
}
