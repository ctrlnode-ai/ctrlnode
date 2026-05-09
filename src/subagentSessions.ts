// In-memory mapping of taskId -> childSessionKey for deterministic subagent session lookup.
// The key stored is the raw childSessionKey as returned by OpenClaw (may be fully-qualified
// like 'agent:ag28:subagent:xxxx' or a short key). Consumers should normalize by prepending
// `agent:{agentId}:` when necessary.

export const taskSubagentSessions: Map<string, string> = new Map();

export function setTaskSubagentSession(taskId: string, childSessionKey: string): void {
  taskSubagentSessions.set(taskId, childSessionKey);
}

export function getTaskSubagentSession(taskId: string): string | undefined {
  return taskSubagentSessions.get(taskId);
}

export function deleteTaskSubagentSession(taskId: string): void {
  taskSubagentSessions.delete(taskId);
}
