/**
 * Tracks Hermes ACP session model across setSessionModel, config_option_update, and prompt completion.
 */
import { normalizeHermesModelId } from './hermesModelUtils';

export type HermesAcpModelTracker = {
  desiredModel?: string;
  initialSessionModel?: string;
  /** Best-known model id after setSessionModel / streaming updates. */
  runtimeModel?: string;
  modelSetApplied: boolean;
};

export function createHermesAcpModelTracker(desiredModel?: string): HermesAcpModelTracker {
  return { desiredModel, modelSetApplied: false };
}

export function readSessionCurrentModelId(session: unknown): string | undefined {
  const models = (session as { models?: { currentModelId?: string } })?.models;
  const id = models?.currentModelId;
  return typeof id === 'string' && id.trim() ? id.trim() : undefined;
}

export function seedTrackerFromSession(tracker: HermesAcpModelTracker, session: unknown): void {
  tracker.initialSessionModel = readSessionCurrentModelId(session);
  tracker.runtimeModel =
    extractModelFromConfigOptions((session as { configOptions?: unknown })?.configOptions) ??
    tracker.initialSessionModel;
}

export function markModelSetApplied(tracker: HermesAcpModelTracker, modelId: string): void {
  tracker.modelSetApplied = true;
  tracker.runtimeModel = modelId;
}

export function observeSessionUpdateForModel(tracker: HermesAcpModelTracker, update: unknown): void {
  if (!update || typeof update !== 'object') return;
  const u = update as Record<string, unknown>;

  if (u.sessionUpdate === 'config_option_update') {
    const fromConfig = extractModelFromConfigOptions(u.configOptions);
    if (fromConfig) tracker.runtimeModel = fromConfig;
  }

  const fromMeta = extractModelFromMeta(u._meta);
  if (fromMeta) tracker.runtimeModel = fromMeta;
}

export function resolveHermesRuntimeModel(
  tracker: HermesAcpModelTracker,
  promptResult?: unknown,
): string | undefined {
  const fromPrompt =
    promptResult && typeof promptResult === 'object'
      ? extractModelFromMeta((promptResult as Record<string, unknown>)._meta)
      : undefined;
  if (fromPrompt) return fromPrompt;
  if (tracker.runtimeModel) return tracker.runtimeModel;
  if (tracker.modelSetApplied && tracker.desiredModel) return tracker.desiredModel;
  return tracker.desiredModel ?? tracker.initialSessionModel;
}

function canonicalModelId(id: string): string {
  const normalized = normalizeHermesModelId(id) ?? id;
  const withoutProviderPrefix = normalized.includes(':')
    ? (normalized.split(':').pop() ?? normalized)
    : normalized.includes('/')
      ? (normalized.split('/').pop() ?? normalized)
      : normalized;
  return withoutProviderPrefix.toLowerCase();
}

/** True when configured and runtime models are both set and differ after normalization. */
export function hermesModelsMismatch(
  configured: string | undefined,
  runtime: string | undefined,
): boolean {
  if (!configured?.trim() || !runtime?.trim()) return false;
  const a = normalizeHermesModelId(configured);
  const b = normalizeHermesModelId(runtime);
  if (!a || !b) return false;
  if (a === b) return false;
  return canonicalModelId(a) !== canonicalModelId(b);
}

export function extractModelFromConfigOptions(configOptions: unknown): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const raw of configOptions) {
    if (!raw || typeof raw !== 'object') continue;
    const opt = raw as Record<string, unknown>;
    const category = opt.category;
    const id = opt.id;
    const isModel =
      category === 'model' ||
      (typeof id === 'string' && id.toLowerCase().includes('model'));
    if (!isModel || opt.type !== 'select') continue;

    const currentValue = opt.currentValue;
    if (typeof currentValue !== 'string' || !currentValue.trim()) continue;
    const label = resolveSelectOptionLabel(opt.options, currentValue.trim());
    return label ?? currentValue.trim();
  }
  return undefined;
}

function resolveSelectOptionLabel(options: unknown, valueId: string): string | undefined {
  const flat = flattenSelectOptions(options);
  const match = flat.find((o) => o.value === valueId);
  return match?.name;
}

function flattenSelectOptions(
  options: unknown,
): Array<{ value: string; name: string }> {
  if (!Array.isArray(options)) return [];
  const out: Array<{ value: string; name: string }> = [];
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.value === 'string' && typeof e.name === 'string') {
      out.push({ value: e.value, name: e.name });
      continue;
    }
    if (Array.isArray(e.options)) {
      for (const nested of e.options) {
        if (!nested || typeof nested !== 'object') continue;
        const n = nested as Record<string, unknown>;
        if (typeof n.value === 'string' && typeof n.name === 'string') {
          out.push({ value: n.value, name: n.name });
        }
      }
    }
  }
  return out;
}

function extractModelFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  for (const key of ['currentModelId', 'modelId', 'model']) {
    const v = m[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
