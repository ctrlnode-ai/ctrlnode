/**
 * Maps Cursor SDK / runner failures to SaaS task terminal status + user-facing copy.
 */

export const CURSOR_MISSING_API_KEY_REASON =
  'Provider Cursor: missing CURSOR_API_KEY. Add your Cursor API key to the Bridge .env file and restart Bridge.';

export const CURSOR_INVALID_API_KEY_REASON =
  'Provider Cursor: authentication failed. Check CURSOR_API_KEY in Bridge .env (invalid or expired key).';

export function classifyCursorSdkTerminal(
  reason: string,
  options?: { hasApiKey?: boolean; runnerCode?: string },
): { status: 'blocked' | 'failed'; reason: string } {
  const hasApiKey = options?.hasApiKey ?? !!process.env.CURSOR_API_KEY?.trim();
  if (!hasApiKey) {
    return { status: 'blocked', reason: CURSOR_MISSING_API_KEY_REASON };
  }

  const text = (reason || '').trim();
  const lower = text.toLowerCase();
  const code = (options?.runnerCode || '').toLowerCase();

  const authLike =
    code === 'unauthenticated' ||
    lower.includes('unauthenticated') ||
    lower.includes('authenticationerror') ||
    lower.includes('invalid api key') ||
    lower.includes('api key exchange') ||
    lower.includes('missing cursor_api_key') ||
    lower.includes('missing api key');

  // Cursor ConnectError often surfaces as "[unknown] Error" with cause.code unauthenticated
  const genericConnectAuth =
    (lower === 'error' || lower.includes('[unknown] error') || lower.includes('connecterror')) &&
    (authLike || !text || lower === 'error');

  if (authLike || genericConnectAuth) {
    return { status: 'blocked', reason: CURSOR_INVALID_API_KEY_REASON };
  }

  return { status: 'failed', reason: text || 'Provider Cursor: task failed' };
}
