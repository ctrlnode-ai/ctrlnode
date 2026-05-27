/**
 * Hermes model helpers: normalize UI values and optionally probe ACP for available models.
 */
import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'child_process';
import { Readable, Writable } from 'stream';
import { CTRLNODE_ROOT, HERMES_HOME } from './config';
import { logger } from './logger';
import { checkBinaryExists, checkHermesAcpAvailable } from './providers/providerHealthUtils';

/** Normalize model id from CtrlNode UI (spaces → dashes). */
export function normalizeHermesModelId(model: string | undefined | null): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/g, '-');
}

/** Strip `provider:` or `vendor/model` prefix for routing heuristics. */
export function stripHermesModelPrefix(modelId: string): string {
  const normalized = normalizeHermesModelId(modelId) ?? modelId;
  if (normalized.includes(':')) {
    return normalized.split(':').pop() ?? normalized;
  }
  if (normalized.includes('/')) {
    return normalized.split('/').pop() ?? normalized;
  }
  return normalized;
}

/**
 * Provider prefixes recognized by Hermes `parse_model_input` (`provider:model`).
 * Not an exhaustive catalog — Hermes validates at runtime; this mirrors the syntax rules.
 */
const HERMES_EXPLICIT_PROVIDER_PREFIXES = new Set([
  'openrouter',
  'copilot-acp',
  'copilot',
  'anthropic',
  'openai',
  'openai-codex',
  'google',
  'gemini',
  'xai',
  'xai-oauth',
  'nous',
  'ollama',
  'groq',
  'mistral',
  'deepseek',
  'custom',
]);

export type ParsedHermesModelRef = {
  /** Set when UI uses `provider:model` (e.g. `openrouter:anthropic/claude-sonnet-4`). */
  explicitProvider?: string;
  modelPart: string;
};

/** Parse Hermes model id the same way as `provider:model` vs bare model. */
export function parseHermesModelRef(modelId: string): ParsedHermesModelRef {
  const normalized = normalizeHermesModelId(modelId) ?? modelId;
  const colon = normalized.indexOf(':');
  if (colon > 0) {
    const providerPart = normalized.slice(0, colon).toLowerCase();
    const modelPart = normalized.slice(colon + 1).trim();
    if (providerPart && modelPart && HERMES_EXPLICIT_PROVIDER_PREFIXES.has(providerPart)) {
      return { explicitProvider: providerPart, modelPart };
    }
  }
  return { modelPart: normalized };
}

function canonicalHermesModelId(modelId: string): string {
  return stripHermesModelPrefix(modelId).toLowerCase();
}

/**
 * Whether to skip ACP `setSessionModel` for this agent model.
 *
 * Hermes supports many providers (openrouter, nous, copilot-acp, …). We only skip the
 * **known-broken combo** from Hermes 0.14 logs: GPT-5 family while the session stays on
 * Copilot ACP — `setSessionModel` remaps to `provider=openai` + `codex_stream` and
 * CopilotACPClient lacks `.responses`.
 *
 * - `openrouter:…`, `nous:…`, etc. → always apply (provider switch).
 * - `anthropic/claude-…`, `claude-…` → apply (works via copilot-acp in QA).
 * - bare `gpt-5.4-mini` or `copilot-acp:gpt-5.4-mini` on a copilot session → skip.
 */
export function shouldSkipHermesAcpSessionModelSet(
  modelId: string | undefined | null,
  sessionInitialModel?: string,
): boolean {
  if (!modelId?.trim()) return false;

  const { explicitProvider, modelPart } = parseHermesModelRef(modelId);
  const bare = modelPart.toLowerCase();

  if (
    sessionInitialModel?.trim() &&
    canonicalHermesModelId(sessionInitialModel) === canonicalHermesModelId(modelId)
  ) {
    return true;
  }

  if (explicitProvider && explicitProvider !== 'copilot-acp' && explicitProvider !== 'copilot') {
    return false;
  }

  if (/^gpt-5/.test(bare) || /^gpt-4o/.test(bare)) {
    return true;
  }

  return false;
}

/** Reason string for logs when {@link shouldSkipHermesAcpSessionModelSet} is true. */
export function hermesAcpModelSetSkipReason(
  modelId: string,
  sessionInitialModel?: string,
): string {
  const { explicitProvider } = parseHermesModelRef(modelId);
  if (
    sessionInitialModel?.trim() &&
    canonicalHermesModelId(sessionInitialModel) === canonicalHermesModelId(modelId)
  ) {
    return 'matches_session_default';
  }
  if (explicitProvider && explicitProvider !== 'copilot-acp' && explicitProvider !== 'copilot') {
    return 'explicit_provider';
  }
  return 'copilot_gpt5_set_model_hermes_bug';
}

/** Detect Hermes provider API failures echoed into task output or agent_log. */
export function detectHermesCopilotApiFailure(text: string): string | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/API call failed after \d+ retries/i.test(t)) return t.split('\n')[0]?.trim() ?? t;
  if (/CopilotACPClient.*has no attribute 'responses'/i.test(t)) {
    return "CopilotACPClient missing 'responses' (Hermes codex_stream path)";
  }
  return undefined;
}

const FALLBACK_MODELS = [
  'gpt-5.4-mini',
  'gpt-5.4',
  'claude-sonnet-4',
  'anthropic/claude-sonnet-4',
  'claude-haiku-4-5',
];

let cachedModels: string[] | null = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 30 * 60_000;

/**
 * Returns model ids advertised by Hermes ACP (cached). Falls back to a small static list.
 */
export async function listHermesModels(): Promise<string[]> {
  if (cachedModels && Date.now() < cacheExpiresAt) return cachedModels;

  const probed = await probeHermesModelsViaAcp();
  const merged = [...new Set([...probed, ...FALLBACK_MODELS])].filter(Boolean);
  cachedModels = merged;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return merged;
}

async function probeHermesModelsViaAcp(): Promise<string[]> {
  if (!(await checkBinaryExists('hermes')) || !(await checkHermesAcpAvailable())) {
    return [];
  }

  const isWindows = process.platform === 'win32';
  const cmd = isWindows ? 'cmd.exe' : 'hermes';
  const args = isWindows ? ['/c', 'hermes', 'acp'] : ['acp'];

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (HERMES_HOME) env['HERMES_HOME'] = HERMES_HOME;

  return new Promise<string[]>((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: CTRLNODE_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
      shell: false,
    });

    const finish = (models: string[]) => {
      if (!proc.killed) proc.kill('SIGTERM');
      resolve(models);
    };

    const timer = setTimeout(() => {
      logger.debug('hermes_models.probe_timeout');
      finish([]);
    }, 14_000);

    if (!proc.stdin || !proc.stdout) {
      clearTimeout(timer);
      finish([]);
      return;
    }

    const output = Writable.toWeb(proc.stdin) as unknown as WritableStream<Uint8Array>;
    const input = Readable.toWeb(proc.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    const client: acp.Client = {
      async requestPermission() {
        return { outcome: { outcome: 'cancelled' } };
      },
      async sessionUpdate() {},
      async writeTextFile() {
        return {};
      },
      async readTextFile() {
        return { content: '' };
      },
    };

    void (async () => {
      try {
        const connection = new acp.ClientSideConnection((_agent) => client, stream);
        await connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        });
        const session = await connection.newSession({
          cwd: CTRLNODE_ROOT,
          mcpServers: [],
        });
        const modelsState = (session as { models?: { availableModels?: Array<{ modelId: string }> } }).models;
        const ids = modelsState?.availableModels?.map((m) => m.modelId).filter(Boolean) ?? [];
        logger.debug('hermes_models.probe_ok', { count: ids.length });
        clearTimeout(timer);
        finish(ids);
      } catch (err) {
        logger.debug('hermes_models.probe_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        clearTimeout(timer);
        finish([]);
      } finally {
        proc.stdin?.end();
      }
    })();
  });
}
