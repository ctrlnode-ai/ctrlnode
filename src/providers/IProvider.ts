import { AgentSummary } from '../types.js';
import type { DiscoverCapabilitiesParams, ProviderCapabilities } from './capabilities/types.js';

export interface DispatchTaskParams {
  agentId: string;
  taskId: string;
  prompt: string;
  workingDir: string;
  tools?: string;
  taskFolderName?: string;
  taskFolderPath?: string;
  skipSessionWipe?: boolean;
  predecessorAgentId?: string;
  executionId?: string;
  taskMode?: string;
  repoPath?: string;
  /** CtrlNode-relative path to the task log markdown (tasks/.../output/*-output.md). */
  taskLogRelativePath?: string;
}

export interface TaskCallbacks {
  onStream(event: any): void;
  onMessage(text: string): void;
  onComplete(status: 'completed' | 'failed' | 'blocked', reason?: string): void;
  /** Called when the provider discovers the real model name (e.g. from claude system/init). Optional. */
  onModelDiscovered?(model: string): void;
  /** Called when the provider is blocked waiting for user input (e.g. a permission prompt). */
  onWaitingForInput?(prompt?: string): void;
}

export interface SendToSessionParams {
  agentId: string;
  taskId: string;
  sessionId?: string;
  sessionKey?: string;
  message: string;
  intentType: string;
  executionId?: string;
  /** CtrlNode-relative folder for the task (e.g. tasks/proyecto/06-25/uuid-slug). Bridge uses it to number followup files. */
  taskFolderName?: string;
}

export interface GenerateStructuredPlanParams {
  agentId: string;
  prompt: string;
  workingDir: string;
  /** Bounded read-only planning time supplied by Bridge configuration. */
  timeoutMs: number;
}

export type ProviderHealthReason = 'binary_missing' | 'auth_required' | 'service_unreachable';

export interface ProviderHealth {
  available: boolean;
  reason?: ProviderHealthReason;
}

export interface IProvider {
  /** Lowercase provider identifier matching AgentInfo.provider (e.g. 'copilot', 'cursor', 'codex'). */
  readonly providerName: string;
  discoverAgents(): Promise<AgentSummary[]>;
  dispatchTask(params: DispatchTaskParams, callbacks: TaskCallbacks): Promise<void>;
  sendToSession(params: SendToSessionParams, callbacks: TaskCallbacks): Promise<void>;
  /**
   * Produces one read-only, structured planning response. It must not create task
   * folders, persist a task session, or emit task lifecycle callbacks.
   */
  generateStructuredPlan?(params: GenerateStructuredPlanParams): Promise<string>;
  invokeTool(msg: any, sendToSaas: (payload: any) => void): Promise<void>;
  dispose(): Promise<void>;
  /** Remove an agent from the provider's registry (e.g. Cursor Agent.delete). Returns true if deleted. */
  deleteAgent(agentId: string): Promise<boolean>;
  /** Base dir for read/write/list/delete operations. Returns null if agent not found. */
  resolveFilesystemBase(agentId: string | undefined, useCtrlnode: boolean): string | null;
  /**
   * Resolves the filesystem base path by provider name rather than agent ownership.
   * Used when the SaaS explicitly indicates which provider's filesystem to use.
   */
  resolveFilesystemBaseByProvider(providerName: string, useCtrlnode: boolean, agentId?: string): string | null;
  /** Base dir for create_workspace. Returns null to acknowledge without creating. */
  resolveWorkspaceCreationBase(useCtrlnode: boolean): string | null;
  /**
   * Optional: returns available model IDs for this provider by querying its API.
   * Returns an empty array when not supported or the API call fails.
   */
  listModels?(): Promise<string[]>;

  /**
   * Optional: abort a currently-running task by taskId.
   * No-op when taskId is not currently active in this provider.
   */
  cancelRun?(taskId: string): Promise<void>;

  /**
   * Optional: deliver a user's text response to a task currently waiting for input.
   * No-op when taskId is not in a waiting state.
   */
  deliverInput?(taskId: string, text: string): Promise<void>;

  /**
   * Optional: returns true if the underlying tool/SDK is available on this machine.
   * Called at startup and on every heartbeat tick to report provider health to the server.
   * Default (when not implemented): assumed available (true).
   */
  isAvailable?(): Promise<boolean>;
  /** Rich live health used by Bridge status reporting. */
  checkHealth?(): Promise<ProviderHealth>;

  /**
   * Optional: read-only catalogue of user-invocable skills for the task INSTRUCTIONS slash menu.
   *
   * Must never execute skill content, start MCP servers, or return secrets — see
   * capabilities/types.ts. Providers without an implementation fall back to the stateless
   * adapter registry, and then to an empty `unsupported` catalogue.
   */
  discoverCapabilities?(params: DiscoverCapabilitiesParams): Promise<ProviderCapabilities>;
}
