/**
 * @file types.ts
 * @description Shared TypeScript interfaces and types for the Mission Control Agent Bridge.
 *
 * All data structures that flow between modules (agent info, file results,
 * WebSocket messages) are defined here to provide a single source of truth
 * and make the codebase easy to extend.
 */

// ── Agent ─────────────────────────────────────────────────────────────────────

/**
 * Core metadata about a discovered agent.
 * Sourced from openclaw.json or ctrlnode/agents-config.json.
 */
export interface AgentInfo {
  /** Absolute path to the agent's workspace directory on the local filesystem. */
  workspace: string;
  /** Human-readable display name. Defaults to the agent's ID. */
  name: string;
  /** AI model identifier (e.g. "claude-3-5-sonnet"). Defaults to "default". */
  model: string;
  /** Optional role label shown in the Mission Control UI. */
  role?: string;
  /** Optional emoji shown next to the agent name in the UI. */
  emoji?: string;
  /** Optional longer description for the agent. */
  description?: string;
}

/**
 * AgentInfo extended with runtime fields sent to the SaaS on handshake/update.
 */
export interface AgentSummary extends AgentInfo {
  /** Unique agent identifier (matches the key in discoveredAgents). */
  id: string;
  /** Whether the workspace directory currently exists on disk. */
  exists: boolean;
  /** OS hostname of the machine running this bridge. */
  hostname: string;
}

// ── File system ───────────────────────────────────────────────────────────────

/**
 * A single entry returned by the recursive directory walk (list_files).
 */
export interface FileEntry {
  /** Base name of the file or directory. */
  name: string;
  /** Relative path from the workspace root, using forward slashes. */
  path: string;
  /** Whether this entry is a regular file or a directory. */
  type: 'file' | 'dir';
  /** File size in bytes. Null for directories or when stat fails. */
  size?: number | null;
}

/**
 * Result returned by readFileForBridge when reading a file to send to the SaaS.
 */
export interface FileReadResult {
  /** File content — plain text or base64-encoded (for images). Null on error. */
  content: string | null;
  /** MIME type of the file (e.g. "text/markdown", "image/png"). */
  contentType: string;
  /** Error code string if reading failed; null on success. */
  error: string | null;
}

// ── WebSocket messages ────────────────────────────────────────────────────────

/**
 * Shape of an incoming WebSocket message from the SaaS.
 * Only the fields used by the Bridge are typed; the action discriminator
 * drives which optional fields are expected.
 */
export interface BridgeMessage {
  /** Identifies the operation to perform (e.g. "write_task", "read_file"). */
  action: string;
  /** Target agent ID. When absent the first discovered agent is used. */
  agentId?: string;
  /** Correlation ID used to match async responses back to requests. */
  requestId?: string;
  /** Task ID for task-related operations. */
  taskId?: string;
  /** File content to write, or task description markdown. */
  content?: string;
  /** Relative file path within the agent workspace or ctrlnode root. */
  path?: string;
  /** Sub-directory to list within the agent workspace. */
  subpath?: string;
  /** Tool name for direct invoke_tool actions. */
  tool?: string;
  /** Arguments for intent-based or tool actions (object or JSON string). */
  args?: unknown;
  /** Optional correlation ID for execution tracking across systems. */
  executionId?: string;
  /** Optional business task correlation ID. */
  contextTaskId?: string;
  /** When true, operations target the ctrlnode root instead of the agent workspace. */
  useCtrlnode?: boolean;
  /** Folder name or path for single-folder operations such as create_workspace or delete_agent_folders. */
  folderName?: string;
  /** Initial files to write when creating a new workspace. */
  files?: Array<{ path: string; content: string }>;
  /** Full JSON content for sync_config operations. */
  configContent?: string;
  /** Agent display name for update_agent_config. */
  name?: string;
  /** Agent model identifier for update_agent_config. */
  model?: string;
  /** Agent workspace path for update_agent_config. */
  workspace?: string;
  /** Task folder name for check_task_output and related polling operations. */
  taskFolderName?: string;
  /** Predecessor agent OpenClaw ID for atomic pipeline activation. */
  predecessorAgentId?: string;
  /** Predecessor task folder name (e.g. tasks/aaaa-task1). */
  predecessorTaskFolderName?: string;
  /** Successor/next task agent OpenClaw ID for atomic pipeline activation. */
  nextTaskAgentId?: string;
  /** Successor task folder name (e.g. tasks/bbbb-task2). */
  nextTaskFolderName?: string;

}
