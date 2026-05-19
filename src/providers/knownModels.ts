/**
 * Static model lists used as fallbacks when provider APIs are unavailable.
 * Sources:
 *   Copilot: https://docs.github.com/en/copilot/reference/ai-models/supported-models
 *   Gemini:  https://ai.google.dev/gemini-api/docs/models
 *   Cursor:  https://cursor.com/docs/models-and-pricing
 * Updated: 2026-05-19
 */

/** GitHub Copilot supported models (GA + public preview, non-retired). */
export const COPILOT_KNOWN_MODELS: string[] = [
  // Anthropic — Claude
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',

  // Google — Gemini
  'gemini-2.5-pro',
  'gemini-3-flash',
  'gemini-3.1-pro',

  // OpenAI — GPT
  'gpt-4.1',
  'gpt-5-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.5',

  // Fine-tuned / evaluation (public preview)
  'raptor-mini',
  'goldeneye',
];

/**
 * Gemini models fallback.
 * The Gemini provider tries the REST API first; this list is only used when
 * no API key is available or the call fails.
 * Source: https://ai.google.dev/gemini-api/docs/models  (updated 2026-05-19)
 */
export const GEMINI_KNOWN_MODELS: string[] = [
  // Gemini 2.5 family (stable)
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',

  // Gemini 3 family
  'gemini-3.1-flash-lite',       // stable
  'gemini-3-flash-preview',      // preview
  'gemini-3.1-pro-preview',      // preview
];

/**
 * Cursor supported models fallback.
 * The Cursor provider tries the OpenAI-compatible API first; this list is
 * used when no CURSOR_API_KEY is set or the call fails.
 * Source: https://cursor.com/docs/models-and-pricing  (updated 2026-05-19)
 */
export const CURSOR_KNOWN_MODELS: string[] = [
  // Anthropic — Claude
  'claude-haiku-4-5',
  'claude-sonnet-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',

  // Google — Gemini
  'gemini-2.5-flash',
  'gemini-3-flash',
  'gemini-3.1-pro',

  // OpenAI — GPT
  'gpt-5-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',

  // xAI — Grok
  'grok-4.3',
  'grok-4.20',

  // Moonshot — Kimi
  'kimi-k2.5',

  // Cursor native
  'composer-2.5',
];
