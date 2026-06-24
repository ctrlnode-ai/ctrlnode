/**
 * @file config.ts
 * @description Runtime configuration for the CtrlNode.ai Agent Bridge.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from './logger.js';
import { resolveOpenClawConfigPath } from './configResolution.js';

// ── Load .env — search order: cwd, .ctrlnode data dir, then home dir ────────────
function _findDotenv(): string | null {
  // Prefer the installer path (~/.ctrlnode/.env) over cwd/.env so a stray
  // .env in the Bridge repo does not override the user's workspace config.
  const candidates = [
    path.join(process.env.BASE_PATH || os.homedir(), '.ctrlnode', '.env'),
    path.join(process.cwd(), '.env'),
    path.join(os.homedir(), '.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}
let _dotenvPath: string | null = null;
try {
  const envFile = _findDotenv();
  if (!envFile) throw new Error('no .env');
  const raw = fs.readFileSync(envFile, 'utf8');
  const isInstallerEnv = envFile.replace(/\\/g, '/').includes('/.ctrlnode/.env');
  const installerOverrides = new Set(['PAIRING_TOKEN', 'SAAS_URL', 'BASE_PATH']);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    // Shell/docker may export stale vars; ~/.ctrlnode/.env from install.ps1 is authoritative.
    if (key in process.env && !(isInstallerEnv && installerOverrides.has(key))) continue;
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
  _dotenvPath = envFile;
  console.log(`Reading config from: ${envFile}`);
  const _bin = path.basename(process.execPath || process.argv[1] || 'ctrlnode');
  console.log(`Run '${_bin} --setup' to reconfigure, or edit the file above.\n`);
} catch { /* no .env file — fine */ }

// ── Linux TLS: ensure the npm ws package can find CA certificates ─────────────
// Bun x64-baseline on minimal Linux images has no default CA bundle path.
// The npm ws package uses node:https which reads SSL_CERT_FILE / SSL_CERT_DIR.
// Auto-detect the system CA bundle and set SSL_CERT_FILE before any TLS socket
// is opened (this module is loaded first, before websocket.ts).
if (process.platform === 'linux' && !process.env.SSL_CERT_FILE) {
  const caPaths = [
    '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu
    '/etc/pki/tls/certs/ca-bundle.crt',   // RHEL / CentOS
    '/etc/ssl/ca-bundle.pem',             // openSUSE
    '/etc/ssl/cert.pem',                  // Alpine
  ];
  for (const p of caPaths) {
    if (fs.existsSync(p)) {
      process.env.SSL_CERT_FILE = p;
      break;
    }
  }
}

// ── WebSocket / SaaS ──────────────────────────────────────────────────────────

export let SAAS_URL = process.env.SAAS_URL || 'wss://api.ctrlnode.ai/ws/bridge';
export let PAIRING_TOKEN = process.env.PAIRING_TOKEN || '';

// ── OpenClaw configuration paths ──────────────────────────────────────────────

export let OPENCLAW_CONFIG = '';
export const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
export let OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
export const BRIDGE_INCOMING_DUMP_PATH = process.env.BRIDGE_INCOMING_DUMP_PATH || '';

// ── Timer intervals ───────────────────────────────────────────────────────────

export const POLL_CONFIG_MS = parseInt(process.env.POLL_CONFIG_MS || '60000', 10);
export const HEARTBEAT_MS = parseInt(process.env.HEARTBEAT_MS || '30000', 10);
export const RECONNECT_MS = parseInt(process.env.RECONNECT_MS || '5000', 10);
export const CONNECTION_TIMEOUT_MS = parseInt(process.env.CONNECTION_TIMEOUT_MS || '10000', 10);
export const AGENT_IDLE_RESET_MS = parseInt(process.env.AGENT_IDLE_RESET_MS || '15000', 10);
export const SESSION_HISTORY_POLL_MS = parseInt(process.env.SESSION_HISTORY_POLL_MS || '5000', 10);

// ── File watcher ──────────────────────────────────────────────────────────────

export const WATCHER_USE_POLLING = process.env.WATCHER_USE_POLLING === 'true';
export const WATCHER_POLL_INTERVAL = parseInt(process.env.WATCHER_POLL_INTERVAL || '1000', 10);

// ── Provider selection ────────────────────────────────────────────────────────
// Internal constant — all providers are always loaded.
// The server drives agent→provider routing via sync_*_agents messages.

export let PROVIDERS: string[] = ['openclaw', 'claude', 'claude-sdk', 'copilot', 'gemini', 'codex', 'cursor', 'hermes'];

export let PROVIDER = PROVIDERS[0];

// ── Claude Code provider ──────────────────────────────────────────────────────

// ── Shared task timeout ───────────────────────────────────────────────────────
// Inactivity timeout for all providers. Fires only when the agent produces no
// output for this many minutes — an actively working agent is never killed.
export const TASK_TIMEOUT_MINUTES = parseInt(process.env.TASK_TIMEOUT_MINUTES || '10', 10);

export const CLAUDE_TOOLS = process.env.CLAUDE_TOOLS || 'Read,Write,Edit';
export const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '20', 10);
// Default true: Claude Code prompts for permission even for tools listed in --allowedTools
// when running non-interactively. Skip-permissions is required so file writes don't hang.
export const CLAUDE_SKIP_PERMISSIONS = process.env.CLAUDE_SKIP_PERMISSIONS !== 'false';

// ── Gemini CLI ACP provider ─────────────────────────────────────────────────



// ── Codex SDK provider ───────────────────────────────────────────────────────


// ── Cursor SDK provider ──────────────────────────────────────────────────────
// Provider name: "cursor" — uses @cursor/sdk programmatic API
// CURSOR_API_KEY is read by the provider directly from process.env; exported here
// so startup validation can warn early if the key is missing.

export let CURSOR_API_KEY = process.env.CURSOR_API_KEY || '';

// ── Claude Agent SDK provider ─────────────────────────────────────────────────
// Provider name: "claude-sdk" — uses @anthropic-ai/claude-agent-sdk programmatic API
// The SDK reads ANTHROPIC_API_KEY from process.env automatically; exported here
// so startup validation can warn early if the key is missing.

export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

export const CLAUDE_SDK_TOOLS = process.env.CLAUDE_SDK_TOOLS || 'Read,Write,Edit,Bash,Glob,Grep';
export const CLAUDE_SDK_MAX_TURNS = parseInt(process.env.CLAUDE_SDK_MAX_TURNS || '50', 10);
/** bypassPermissions | acceptEdits | dontAsk — default bypassPermissions for unattended agents */
export const CLAUDE_SDK_PERMISSION_MODE = process.env.CLAUDE_SDK_PERMISSION_MODE || 'bypassPermissions';
/**
 * Path to the claude CLI binary. Explicit via CLAUDE_SDK_EXECUTABLE env var,
 * or auto-detected from common install locations (npm global, Roaming\npm, etc.).
 */
export const CLAUDE_SDK_EXECUTABLE = (() => {
  if (process.env.CLAUDE_SDK_EXECUTABLE) return process.env.CLAUDE_SDK_EXECUTABLE;
  // Auto-detect on Windows: npm global installs land in %APPDATA%\npm\
  const candidates = [
    process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude.cmd` : '',
    process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude` : '',
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\npm\\claude.cmd` : '',
    // Unix-style locations (Linux/macOS)
    '/usr/local/bin/claude',
    '/usr/bin/claude',
    `${process.env.HOME ?? ''}/.local/bin/claude`,
  ].filter(Boolean);
  const fs_ = require('fs') as typeof import('fs');
  for (const p of candidates) {
    if (fs_.existsSync(p)) return p;
  }
  return '';
})();

// ── Hermes provider ───────────────────────────────────────────────────────────
// Provider name: "hermes" — uses `hermes acp` (primary) or `hermes chat` CLI (fallback).
// HERMES_HOME: emergency global override only. In normal operation, each agent spawns
// hermes with HERMES_HOME set to its own native profile at ~/.hermes/profiles/{agentId}/.
// See hermesProfile.ts for profile path logic.

export const HERMES_HOME = process.env.HERMES_HOME || '';
// HERMES_USE_ACP=false forces hermes chat -Q -q (CLI) instead of hermes acp

// ── Copilot ACP provider ──────────────────────────────────────────────────────



// ── Non-OpenClaw agents base folder ──────────────────────────────────────────
// All non-OpenClaw providers (Cursor, Gemini, Codex, Copilot, Claude) use this
// as the root for their workspace and task folders.
// Structure: BASE_PATH/.ctrlnode/{tasks,workspace-mc-xxx,...}
export let BASE_PATH = process.env.BASE_PATH || os.homedir();

// Auto-bootstrap common folder structure if it doesn't exist
const agentsRoot = path.join(BASE_PATH, '.ctrlnode');
if (!fs.existsSync(agentsRoot)) {
  try {
    fs.mkdirSync(agentsRoot, { recursive: true });
    logger.debug(`Bootstrap: Created missing agents root at ${agentsRoot}`);
  } catch (err) {
    logger.warn(`Bootstrap: Could not create agents root at ${agentsRoot}. Providers may fail if write access is denied.`);
  }

  // ── Save interactive answers to .env so next run skips prompts ──────────────
  // Only write when there was no pre-existing .env and user went through the
  // interactive flow (not when all vars were already in env).
  if (!_dotenvPath) {
    try {
      const envLines: string[] = [];
      if (PAIRING_TOKEN) envLines.push(`PAIRING_TOKEN=${PAIRING_TOKEN}`);
      if (SAAS_URL && SAAS_URL !== 'wss://api.ctrlnode.ai/ws/bridge') envLines.push(`SAAS_URL=${SAAS_URL}`);
      if (process.env.ANTHROPIC_API_KEY) envLines.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
      if (process.env.CURSOR_API_KEY) envLines.push(`CURSOR_API_KEY=${process.env.CURSOR_API_KEY}`);
      if (process.env.OPENCLAW_GATEWAY_TOKEN) envLines.push(`OPENCLAW_GATEWAY_TOKEN=${process.env.OPENCLAW_GATEWAY_TOKEN}`);
      if (process.env.OPENCLAW_HOME) envLines.push(`OPENCLAW_HOME=${process.env.OPENCLAW_HOME}`);
      if (envLines.length > 0) {
        const ctrlnodeDir = path.join(process.env.BASE_PATH || os.homedir(), '.ctrlnode');
        fs.mkdirSync(ctrlnodeDir, { recursive: true });
        const envPath = path.join(ctrlnodeDir, '.env');
        fs.writeFileSync(envPath, envLines.join('\n') + '\n', 'utf8');
        console.log(`\n  ✓ Configuration saved to ${envPath}`);
      }
    } catch (e: any) {
      console.warn(`  ⚠ Could not save .env: ${e.message}`);
    }
  }
}

// ── Re-read mutable env vars after interactive setup ─────────────────────────
// process.env may have been mutated by the TTY block above; refresh exported lets.
ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY      || ANTHROPIC_API_KEY;
CURSOR_API_KEY         = process.env.CURSOR_API_KEY         || CURSOR_API_KEY;
OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;
BASE_PATH = process.env.BASE_PATH || BASE_PATH;

export let CTRLNODE_ROOT = path.join(BASE_PATH, '.ctrlnode');

/** Per-agent Hermes homes under the current ctrlnode root. */
export function getHermesAgentsDir(): string {
  return path.join(CTRLNODE_ROOT, 'agents');
}

/**
 * Derives the project-level home directory from a taskFolderName.
 * taskFolderName format: "tasks/{project}/{date}/{taskId}"
 * Returns: CTRLNODE_ROOT/tasks/{project}
 * Falls back to CTRLNODE_ROOT if the name is missing or has fewer than 2 segments.
 */
export function resolveProjectHome(taskFolderName: string | undefined): string {
  if (!taskFolderName) return CTRLNODE_ROOT;
  const parts = taskFolderName.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return path.join(CTRLNODE_ROOT, parts[0], parts[1]);
  return path.join(CTRLNODE_ROOT, taskFolderName);
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export const BRIDGE_VERSION = 'v2026.2.4';
export const SESSION_INACTIVITY_TIMEOUT_MINUTES = parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_MINUTES || '5', 10);
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

export const MAX_INLINE_PDF_BYTES = 15 * 1024 * 1024;

export const DOTENV_PATH: string | null = _dotenvPath;

// ── Refresh exported vars from process.env (loaded from .env or shell) ────────
ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY    || ANTHROPIC_API_KEY;
CURSOR_API_KEY       = process.env.CURSOR_API_KEY       || CURSOR_API_KEY;
OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;
BASE_PATH     = process.env.BASE_PATH || BASE_PATH;
CTRLNODE_ROOT = path.join(BASE_PATH, '.ctrlnode');


if (!PAIRING_TOKEN && (process.env.BUN_TEST || process.env.TEST)) {
  logger.error('pairing_token_missing', { message: 'PAIRING_TOKEN is required.' });
}

/**
 * If PAIRING_TOKEN is missing, prompts the user interactively and persists
 * the token to the .env file. Must be called from index.ts before connect().
 */
export async function ensurePairingToken(): Promise<void> {
  if (PAIRING_TOKEN) return;

  const envFile = _dotenvPath ?? path.join(process.env.BASE_PATH || os.homedir(), '.ctrlnode', '.env');
  const { createInterface } = await import('readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const token = await new Promise<string>(resolve => {
    rl.question('\nPAIRING_TOKEN not found. Enter your pairing token (Settings → Bridge at app.ctrlnode.ai): ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });

  if (!token) {
    console.error('No token entered. Exiting.');
    process.exit(1);
  }

  PAIRING_TOKEN = token;
  process.env.PAIRING_TOKEN = token;

  try {
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    if (!existing.includes('PAIRING_TOKEN')) {
      fs.appendFileSync(envFile, `\nPAIRING_TOKEN=${token}\n`, 'utf8');
      console.log(`Token saved to ${envFile}\n`);
    }
  } catch (e: any) {
    logger.warn('pairing_token_persist_failed', { error: e?.message });
  }
}

// Startup credential diagnostics — informational only; missing keys cause task
// failures at dispatch time, not Bridge startup failures.
if (!ANTHROPIC_API_KEY) {
  logger.info('anthropic_api_key_not_set', { note: 'Claude SDK agents will use subscription mode or fail at dispatch.' });
} else {
  logger.info('anthropic_api_key_detected', { mode: 'api-key' });
}

if (!CURSOR_API_KEY) {
  logger.info('cursor_api_key_not_set', { note: 'Cursor agents will fail at dispatch if a key is required.' });
} else {
  logger.info('cursor_api_key_detected', { mode: 'api-key' });
}


// ── Resolve OPENCLAW_CONFIG ───────────────────────────────────────────────────

export function refreshOpenClawConfig(): string {
  const resolvedConfig = resolveOpenClawConfigPath({
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    existsSync: fs.existsSync,
  });

  OPENCLAW_CONFIG = resolvedConfig.path;
  logger.debug('config_path_resolved', { path: OPENCLAW_CONFIG, source: resolvedConfig.source });
  return OPENCLAW_CONFIG;
}

// Resolve OpenClaw config path; if the file doesn't exist, remove openclaw from
// the active PROVIDERS list so the factory skips it instead of crashing.
refreshOpenClawConfig();
if (!fs.existsSync(OPENCLAW_CONFIG)) {
  logger.info('openclaw_config_not_found', {
    path: OPENCLAW_CONFIG,
    note: 'OpenClaw provider disabled. Set OPENCLAW_HOME or ensure ~/.openclaw/openclaw.json exists to enable it.',
  });
  PROVIDERS = PROVIDERS.filter(p => p !== 'openclaw');
  PROVIDER = PROVIDERS[0];
}

export const ctrlnodePath = path.join(path.dirname(OPENCLAW_CONFIG || path.join(os.homedir(), '.openclaw', 'openclaw.json')), 'ctrlnode');

