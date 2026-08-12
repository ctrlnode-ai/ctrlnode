// @ts-nocheck
import { describe, expect, test, mock } from 'bun:test';

describe('config.ts browser sign-in fallback (no PAIRING_TOKEN configured)', () => {
  test('loginAndAdoptPairingToken runs the same device-login flow as `ctrlnode login` and adopts the token', async () => {
    const runLoginMock = mock(async (_envFile: string) => 'pt-from-browser-login');

    const config = await import('../config');
    const token = await config.loginAndAdoptPairingToken('/tmp/some-bridge/.env', runLoginMock);

    expect(runLoginMock).toHaveBeenCalledWith('/tmp/some-bridge/.env');
    expect(token).toBe('pt-from-browser-login');
    expect(config.PAIRING_TOKEN).toBe('pt-from-browser-login');
    expect(process.env.PAIRING_TOKEN).toBe('pt-from-browser-login');
  });

  test('ensurePairingToken skips the login flow entirely when a token is already configured', async () => {
    const config = await import('../config');
    // Token was adopted by the previous test (or from the real .env) — either way it's non-empty here.
    expect(config.PAIRING_TOKEN).toBeTruthy();
    const tokenBefore = config.PAIRING_TOKEN;

    await config.ensurePairingToken();

    // The `if (PAIRING_TOKEN) return;` guard means this resolves immediately without
    // touching the login flow (which would require network access and change the token).
    expect(config.PAIRING_TOKEN).toBe(tokenBefore);
  });
});
