import fs from 'fs';
import path from 'path';

/** Resolves model lists without requiring an API key for a locally authenticated provider. */
export async function resolveModelsWithSubscriptionFirst(
  subscriptionModels: () => Promise<string[]>,
  apiModels: () => Promise<string[]>,
): Promise<string[]> {
  try {
    const models = await subscriptionModels();
    if (models.length > 0) return models;
  } catch {
    // A missing/expired local session should fall through to API-key auth.
  }

  return apiModels();
}

/** Reads the model catalog cached by the authenticated Codex CLI session. */
export async function readCodexSubscriptionModels(
  codexHome: string,
  readFile: (filePath: string) => Promise<string> = (filePath) => fs.promises.readFile(filePath, 'utf8'),
): Promise<string[]> {
  try {
    const raw = await readFile(path.join(codexHome, 'models_cache.json'));
    const models = (JSON.parse(raw)?.models ?? []) as Array<{ slug?: unknown; visibility?: unknown }>;
    return models
      .filter(model => model.visibility === undefined || model.visibility === 'list')
      .map(model => typeof model.slug === 'string' ? model.slug : '')
      .filter(Boolean);
  } catch {
    return [];
  }
}
