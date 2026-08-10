/**
 * @file login.ts
 * @description `ctrlnode login` — OAuth Device Authorization Grant (RFC 8628) style flow
 * so the user authorizes this Bridge from a browser (on any device) instead of copy-pasting
 * a PAIRING_TOKEN. See management/docs/07-07-bridge-oauth-login-design.md for the design.
 *
 * Chosen over a loopback (localhost callback) flow — the same tradeoff GitHub CLI/Copilot
 * CLI made over Claude Code/Cursor's approach — because the Bridge frequently runs on
 * headless servers/containers where the browser confirming the login is not the same
 * machine as the one running `ctrlnode login`.
 */
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { apiBaseUrl } from './modelManifest.js';
import { mergeEnvFile } from './setupEnv.js';
import { BRIDGE_VERSION } from './config.js';

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Best-effort browser open — silently does nothing on headless machines (no error surfaced). */
function tryOpenBrowser(url: string): void {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
    execFile(cmd, args, { windowsHide: true }, () => { /* ignore failures — headless is fine */ });
  } catch { /* ignore — user still has the URL printed above */ }
}

/** Derives the web app's base URL from the device-code verificationUri (strips the known /bridge/activate suffix). */
function deriveAppUrl(verificationUri: string): string {
  return verificationUri.replace(/\/bridge\/activate\/?$/, '') || verificationUri;
}

async function requestDeviceCode(apiBase: string): Promise<DeviceCodeResponse> {
  const resp = await fetch(`${apiBase}/api/bridge/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hostname: os.hostname(), platform: process.platform, bridgeVersion: BRIDGE_VERSION }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`Could not start login (HTTP ${resp.status}). Check your network connection and try again.`);
  }
  return await resp.json() as DeviceCodeResponse;
}

async function pollForToken(apiBase: string, deviceCode: string, expiresInSeconds: number, pollIntervalSeconds: number): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000;
  let intervalMs = pollIntervalSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const resp = await fetch(`${apiBase}/api/bridge/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceCode }),
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 200) {
      const { pairingToken } = await resp.json() as { pairingToken: string };
      return pairingToken;
    }
    if (resp.status === 202) {
      continue; // still pending — keep polling
    }
    if (resp.status === 429) {
      intervalMs += 5_000; // slow_down — back off, mirrors RFC 8628 guidance
      continue;
    }
    if (resp.status === 400) {
      const body = await resp.json().catch(() => ({})) as { error?: string };
      if (body.error === 'access_denied') {
        throw new Error('Login rejected from the browser.');
      }
      throw new Error('Login code expired. Run "ctrlnode login" again.');
    }
    throw new Error(`Unexpected response while waiting for login (HTTP ${resp.status}).`);
  }

  throw new Error('Login timed out. Run "ctrlnode login" again.');
}

/**
 * Runs the device-login flow and, on success, writes PAIRING_TOKEN into the given .env file.
 * Returns the pairing token once written (or throws on failure/timeout/rejection).
 */
export async function runLogin(envFile: string): Promise<string> {
  const apiBase = apiBaseUrl();

  console.log('\nRequesting a login code...\n');
  const { deviceCode, userCode, verificationUri, expiresInSeconds, pollIntervalSeconds } = await requestDeviceCode(apiBase);

  console.log('To authorize this Bridge, visit:\n');
  console.log(`  ${verificationUri}`);
  console.log('\nand enter this code:\n');
  console.log(`  ${userCode}\n`);
  console.log('Opening your browser automatically (if available)...');
  console.log('Waiting for confirmation... (Ctrl+C to cancel)\n');

  tryOpenBrowser(`${verificationUri}?code=${encodeURIComponent(userCode)}`);

  const pairingToken = await pollForToken(apiBase, deviceCode, expiresInSeconds, pollIntervalSeconds);

  mergeEnvFile(envFile, { PAIRING_TOKEN: pairingToken });
  console.log('Login successful — PAIRING_TOKEN saved.');
  console.log(`  Config: ${envFile}\n`);

  const appUrl = deriveAppUrl(verificationUri);
  console.log(`Opening your browser automatically (if available): ${appUrl}`);
  console.log(`If it doesn't open, visit it yourself: ${appUrl}\n`);
  tryOpenBrowser(appUrl);

  return pairingToken;
}

/** Resolves the same .env path config.ts uses, for use before config.ts has loaded. */
export function defaultEnvFilePath(): string {
  return path.join(process.env.BASE_PATH || os.homedir(), '.ctrlnode', '.env');
}
