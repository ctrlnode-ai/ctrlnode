// @ts-nocheck
import { describe, expect, test, afterEach, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as childProcess from 'child_process';
import { runLogin } from '../login';

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

describe('runLogin', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let execFileSpy: ReturnType<typeof spyOn>;
  let envFile: string;

  afterEach(() => {
    fetchSpy?.mockRestore();
    execFileSpy?.mockRestore();
    if (envFile && fs.existsSync(envFile)) fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  });

  test('happy path: requests a code, polls through pending, writes PAIRING_TOKEN on success', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-test-'));
    envFile = path.join(tmpDir, '.env');

    execFileSpy = spyOn(childProcess, 'execFile').mockImplementation((_cmd, _args, _opts, cb) => { cb?.(null); return {} as any; });

    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/bridge/device/code')) {
        return jsonResponse({
          deviceCode: 'dc-123', userCode: 'WXYZ-1234',
          verificationUri: 'https://app.ctrlnode.ai/bridge/activate',
          expiresInSeconds: 5, pollIntervalSeconds: 0.01,
        });
      }
      if (u.endsWith('/api/bridge/device/token')) {
        call++;
        if (call < 2) return jsonResponse({ status: 'pending' }, 202);
        return jsonResponse({ pairingToken: 'pt-abc123' });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    await runLogin(envFile);

    const written = fs.readFileSync(envFile, 'utf8');
    expect(written).toContain('PAIRING_TOKEN=pt-abc123');
    expect(call).toBeGreaterThanOrEqual(2);
  });

  test('throws a clear error when the code is denied', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-test-'));
    envFile = path.join(tmpDir, '.env');
    execFileSpy = spyOn(childProcess, 'execFile').mockImplementation((_cmd, _args, _opts, cb) => { cb?.(null); return {} as any; });

    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.endsWith('/api/bridge/device/code')) {
        return jsonResponse({ deviceCode: 'dc-1', userCode: 'ABCD-1234', verificationUri: 'https://x/bridge/activate', expiresInSeconds: 5, pollIntervalSeconds: 0.01 });
      }
      return jsonResponse({ error: 'access_denied' }, 400);
    });

    await expect(runLogin(envFile)).rejects.toThrow(/rejected/i);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  test('throws when the initial device-code request fails', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 500 }));
    await expect(runLogin('/tmp/unused.env')).rejects.toThrow(/HTTP 500/);
  });
});
