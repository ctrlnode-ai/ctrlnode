/**
 * updater.ts — Bridge self-update logic.
 *
 * Called once at startup before connecting. Checks the backend for a newer
 * version. If found and user confirms, downloads the new binary, replaces
 * the current executable, and re-launches. Any failure falls through silently
 * so the Bridge always starts.
 */
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { SAAS_URL, BRIDGE_VERSION } from './config.js';
import { logger } from './logger.js';

// Bun is a global in the Bun runtime — declare it for TypeScript
declare const Bun: {
  spawn(
    cmd: string[],
    opts?: { stdio?: ('inherit' | 'ignore' | 'pipe')[]; detached?: boolean }
  ): unknown;
};

// ── Version comparison ────────────────────────────────────────────────────────

/**
 * Returns true if `remote` is strictly greater than `local`.
 * Format: "YYYY.MAJOR.MINOR" — compared numerically left to right.
 */
export function isNewerVersion(local: string, remote: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, '').split('.').map(n => parseInt(n, 10));
  const l = parse(local);
  const r = parse(remote);
  for (let i = 0; i < Math.max(l.length, r.length); i++) {
    const lv = l[i] ?? 0;
    const rv = r[i] ?? 0;
    if (rv > lv) return true;
    if (rv < lv) return false;
  }
  return false;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiBaseUrl(): string {
  return SAAS_URL
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws\/bridge$/, '');
}

/** Returns true if the Linux CPU supports AVX2 (required for the non-baseline binary). */
function linuxHasAvx2(): boolean {
  try {
    const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
    return cpuinfo.includes('avx2');
  } catch {
    return false;
  }
}

/** Maps Bun/Node runtime platform+arch to the binary filename on GitHub releases. */
function binaryName(): string {
  const { platform, arch } = process;
  if (platform === 'win32')  return 'ctrlnode.exe';
  if (platform === 'darwin') return 'ctrlnode-darwin-arm64';
  if (platform === 'linux' && arch === 'x64')
    return linuxHasAvx2() ? 'ctrlnode-linux-x64' : 'ctrlnode-linux-x64-baseline';
  return '';
}

// ── Version check ─────────────────────────────────────────────────────────────

interface VersionResponse {
  version: string;
  releaseUrl: string;
  downloadUrlTemplate: string;
}

async function fetchLatestVersion(): Promise<VersionResponse | null> {
  const url = `${apiBaseUrl()}/api/bridge/version`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) {
      logger.warn('updater.fetch_failed', { url, status: resp.status });
      return null;
    }
    return await resp.json() as VersionResponse;
  } catch (err: unknown) {
    logger.warn('updater.fetch_error', { url, error: (err as Error)?.message });
    return null;
  }
}

// ── Stdin prompt ──────────────────────────────────────────────────────────────

/** Reads one line from stdin synchronously using Bun-compatible fd read. */
function readLine(): string {
  const buf = Buffer.alloc(256);
  let total = '';
  while (true) {
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n === 0) break;
    const chunk = buf.slice(0, n).toString('utf8');
    total += chunk;
    if (total.includes('\n')) break;
  }
  return total.trim();
}

// ── Download ──────────────────────────────────────────────────────────────────

async function downloadBinary(url: string, destPath: string): Promise<boolean> {
  logger.info('updater.download_start', { url, dest: destPath });
  try {
    const resp = await fetch(url);
    if (!resp.ok || !resp.body) {
      logger.warn('updater.download_failed', { url, status: resp.status });
      return false;
    }
    const file = fs.createWriteStream(destPath);
    const reader = resp.body.getReader();
    await new Promise<void>((resolve, reject) => {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { file.end(resolve); return; }
            if (!file.write(value)) await new Promise<void>(r => file.once('drain', r));
          }
        } catch (e) { reject(e); }
      };
      pump();
    });
    return true;
  } catch (err: unknown) {
    logger.warn('updater.download_error', { url, error: (err as Error)?.message });
    try { fs.unlinkSync(destPath); } catch { /* ignore */ }
    return false;
  }
}

// ── Self-replace + re-exec ────────────────────────────────────────────────────

async function replaceAndRelaunch(tmpPath: string): Promise<void> {
  const execPath = process.execPath;

  if (process.platform === 'win32') {
    const batPath = path.join(os.tmpdir(), 'ctrlnode-update.bat');
    const args    = process.argv.slice(1).map(a => `"${a}"`).join(' ');
    const bat = [
      '@echo off',
      ':retry',
      `copy /y "${tmpPath}" "${execPath}" >nul 2>&1`,
      'if errorlevel 1 ( ping -n 2 127.0.0.1 >nul && goto retry )',
      `start "" "${execPath}" ${args}`,
    ].join('\r\n');
    fs.writeFileSync(batPath, bat, 'utf8');
    Bun.spawn(['cmd.exe', '/c', batPath], { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    process.exit(0);
  } else {
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, execPath);
    Bun.spawn([execPath, ...process.argv.slice(1)], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    process.exit(0);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function checkAndApplyUpdate(): Promise<void> {
  const latest = await fetchLatestVersion();
  if (!latest) return;

  if (!isNewerVersion(BRIDGE_VERSION, latest.version)) return;

  const bin = binaryName();
  if (!bin) {
    logger.warn('updater.unsupported_platform', { platform: process.platform, arch: process.arch });
    return;
  }

  const localVer  = BRIDGE_VERSION.replace(/^v/, '');
  const remoteVer = latest.version.replace(/^v/, '');
  const line1 = `  Nueva versión disponible: v${remoteVer}`;
  const line2 = `  Instalada:  v${localVer}`;
  const line3 = `  Novedades:  ${latest.releaseUrl}`;
  const line4 = `  Actualizar ahora? [Y/n]:`;
  const inner = Math.max(line1.length, line2.length, line3.length, line4.length) + 2;
  const bar   = '─'.repeat(inner);
  const pad   = (s: string) => `│${s}${' '.repeat(inner - s.length)}│`;
  console.log(`\n┌${bar}┐`);
  console.log(pad(line1));
  console.log(pad(line2));
  console.log(pad(line3));
  console.log(pad(''));
  console.log(pad(line4));
  console.log(`└${bar}┘\n`);

  const interactive = process.stdin.isTTY;

  if (interactive) {
    process.stdout.write('> ');
    const answer = readLine();
    if (answer.toLowerCase() === 'n') {
      console.log('[updater] Update skipped.\n');
      return;
    }
  } else {
    logger.info('updater.non_interactive_auto_update', { latest: latest.version });
    console.log('[updater] Running non-interactively — applying update automatically.\n');
  }

  const downloadUrl = latest.downloadUrlTemplate.replace('{binaryName}', bin);
  const tmpPath = `${process.execPath}.tmp`;
  console.log(`\n[updater] Descargando ${downloadUrl} …`);
  const ok = await downloadBinary(downloadUrl, tmpPath);
  if (!ok) {
    console.log('[updater] Error al descargar — arrancando con la versión actual.\n');
    return;
  }

  console.log('[updater] Reemplazando binario y reiniciando…\n');
  await replaceAndRelaunch(tmpPath);
}
