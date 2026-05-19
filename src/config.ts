/**
 * @file config.ts
 * @description Runtime configuration for the CtrlNode.ai Agent Bridge.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from './logger';
import { resolveOpenClawConfigPath } from './configResolution';

// ── Load .env — search order: cwd, .ctrlnode data dir, then home dir ────────────
function _findDotenv(): string | null {
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(process.env.AGENTS_FOLDER || os.homedir(), '.ctrlnode', '.env'),
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
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key in process.env) continue; // real env wins
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
  _dotenvPath = envFile;
} catch { /* no .env file — fine */ }

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
// PROVIDERS supports comma-separated list: PROVIDERS=copilot,cursor
// Falls back to PROVIDER (singular) for backwards compatibility.

const _providersEnvSet = !!(process.env.PROVIDERS || process.env.PROVIDER);

export let PROVIDERS: string[] = (process.env.PROVIDERS || process.env.PROVIDER || 'openclaw,claude,claude-sdk,copilot,gemini,codex,cursor')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);

/** Primary provider (first in list). Kept for backwards-compat with code that only needs one name. */
export let PROVIDER = PROVIDERS[0];

// ── Claude Code provider ──────────────────────────────────────────────────────

export const CLAUDE_TOOLS = process.env.CLAUDE_TOOLS || 'Read,Write,Edit';
export const CLAUDE_MAX_TURNS = parseInt(process.env.CLAUDE_MAX_TURNS || '20', 10);
export const CLAUDE_TIMEOUT_MINUTES = parseInt(process.env.CLAUDE_TIMEOUT_MINUTES || '10', 10);
// Default true: Claude Code prompts for permission even for tools listed in --allowedTools
// when running non-interactively. Skip-permissions is required so file writes don't hang.
export const CLAUDE_SKIP_PERMISSIONS = process.env.CLAUDE_SKIP_PERMISSIONS !== 'false';

// ── Gemini CLI ACP provider ─────────────────────────────────────────────────


export const GEMINI_TIMEOUT_MINUTES = parseInt(process.env.GEMINI_TIMEOUT_MINUTES || '10', 10);

// ── Codex SDK provider ───────────────────────────────────────────────────────

export const CODEX_TIMEOUT_MINUTES = parseInt(process.env.CODEX_TIMEOUT_MINUTES || '10', 10);

// ── Cursor SDK provider ──────────────────────────────────────────────────────
// Provider name: "cursor" — uses @cursor/sdk programmatic API
// CURSOR_API_KEY is read by the provider directly from process.env; exported here
// so startup validation can warn early if the key is missing.

export let CURSOR_API_KEY = process.env.CURSOR_API_KEY || '';
export const CURSOR_TIMEOUT_MINUTES = parseInt(process.env.CURSOR_TIMEOUT_MINUTES || '10', 10);

// ── Claude Agent SDK provider ─────────────────────────────────────────────────
// Provider name: "claude-sdk" — uses @anthropic-ai/claude-agent-sdk programmatic API
// The SDK reads ANTHROPIC_API_KEY from process.env automatically; exported here
// so startup validation can warn early if the key is missing.

export let ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

export const CLAUDE_SDK_TOOLS = process.env.CLAUDE_SDK_TOOLS || 'Read,Write,Edit,Bash,Glob,Grep';
export const CLAUDE_SDK_MAX_TURNS = parseInt(process.env.CLAUDE_SDK_MAX_TURNS || '50', 10);
export const CLAUDE_SDK_TIMEOUT_MINUTES = parseInt(process.env.CLAUDE_SDK_TIMEOUT_MINUTES || '10', 10);
/** bypassPermissions | acceptEdits | dontAsk — default bypassPermissions for unattended agents */
export const CLAUDE_SDK_PERMISSION_MODE = process.env.CLAUDE_SDK_PERMISSION_MODE || 'bypassPermissions';
/**
 * Optional path to the claude CLI binary. Set CLAUDE_SDK_EXECUTABLE when the
 * native binary was not installed as an optional npm dep (e.g. --omit=optional
 * on Linux). Example: /usr/local/bin/claude
 */
export const CLAUDE_SDK_EXECUTABLE = process.env.CLAUDE_SDK_EXECUTABLE || '';

// ── Copilot ACP provider ──────────────────────────────────────────────────────


export const COPILOT_TIMEOUT_MINUTES = parseInt(process.env.COPILOT_TIMEOUT_MINUTES || '10', 10);

// ── Non-OpenClaw agents base folder ──────────────────────────────────────────
// All non-OpenClaw providers (Cursor, Gemini, Codex, Copilot, Claude) use this
// as the root for their workspace and task folders.
// Structure: AGENTS_FOLDER/ctrlnode/{tasks,workspace-mc-xxx,...}
export let AGENTS_FOLDER = process.env.AGENTS_FOLDER || os.homedir();

// Auto-bootstrap common folder structure if it doesn't exist
const agentsRoot = path.join(AGENTS_FOLDER, '.ctrlnode');
if (!fs.existsSync(agentsRoot)) {
  try {
    fs.mkdirSync(agentsRoot, { recursive: true });
    logger.debug(`Bootstrap: Created missing agents root at ${agentsRoot}`);
  } catch (err) {
    logger.warn(`Bootstrap: Could not create agents root at ${agentsRoot}. Providers may fail if write access is denied.`);
  }
}

export let AGENTS_CTRLNODE_ROOT = agentsRoot;

/**
 * Derives the project-level home directory from a taskFolderName.
 * taskFolderName format: "tasks/{project}/{date}/{taskId}"
 * Returns: AGENTS_CTRLNODE_ROOT/tasks/{project}
 * Falls back to AGENTS_CTRLNODE_ROOT if the name is missing or has fewer than 2 segments.
 */
export function resolveProjectHome(taskFolderName: string | undefined): string {
  if (!taskFolderName) return AGENTS_CTRLNODE_ROOT;
  const parts = taskFolderName.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length >= 2) return path.join(AGENTS_CTRLNODE_ROOT, parts[0], parts[1]);
  return path.join(AGENTS_CTRLNODE_ROOT, taskFolderName);
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export const BRIDGE_VERSION = 'v2026.2.0';
export const SESSION_INACTIVITY_TIMEOUT_MINUTES = parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_MINUTES || '5', 10);
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Synchronous TTY prompt that works in compiled Bun binaries on all platforms.
 * On Windows, uses globalThis.prompt (blocks correctly in Bun).
 * On Linux/macOS, reads directly from /dev/tty to avoid Bun's prompt returning '' immediately.
 */
function ttyPrompt(message: string): string | null {
  if (process.platform === 'win32') {
    const builtinPrompt = (globalThis as any).prompt as ((msg: string) => string | null | undefined) | undefined;
    if (typeof builtinPrompt === 'function') {
      const result = builtinPrompt(message);
      return result ?? null;
    }
    return null;
  }

  // Linux / macOS: read directly from /dev/tty — blocks until the user presses Enter.
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    process.stderr.write(message + ' ');
    const line = execFileSync('bash', ['-c', 'read -r _line </dev/tty && printf "%s" "$_line"'], {
      stdio: ['inherit', 'pipe', 'inherit'],
      timeout: 0,
    });
    return line.toString();
  } catch {
    return null;
  }
}

const canPrompt = process.stdout.isTTY === true;

/** --setup flag forces re-running all interactive prompts even if env vars are set. */
const FORCE_SETUP = process.argv.includes('--setup');

/** True when user explicitly chose Claude subscription mode (no API key needed). */
let _claudeSubscriptionMode = false;

// ── Interactive TTY setup ─────────────────────────────────────────────────────

export const DOTENV_PATH: string | null = _dotenvPath;

if (process.stdout.isTTY && canPrompt) {
  if (FORCE_SETUP) {
    const input = ttyPrompt(`Enter SaaS URL [${SAAS_URL}]:`);
    SAAS_URL = (input?.trim() || SAAS_URL).trim();
  }

  if (!PAIRING_TOKEN || FORCE_SETUP) {
    let tokenInput: string | null = null;
    while (!tokenInput?.trim()) {
      tokenInput = ttyPrompt('Enter your CtrlNode pairing token (app.ctrlnode.ai → Bridge Tokens)') ?? null;
      if (!tokenInput?.trim()) {
        console.error('  ✗ Token required. Press Ctrl+C to cancel.');
      }
    }
    PAIRING_TOKEN = tokenInput.trim();
  }

  // If providers were set via env (not interactive), still ask for agents folder if needed
  if (_providersEnvSet && PROVIDERS.some(p => p !== 'openclaw') && FORCE_SETUP) {
    const defaultFolder = process.cwd();
    const input = ttyPrompt(`Enter working folder for agent files [${defaultFolder}]:`);
    process.env.AGENTS_FOLDER = input?.trim() || defaultFolder;
  }

  if (!_providersEnvSet || FORCE_SETUP) {
    // Display names shown to user → internal provider id
    const SELECTABLE: Array<{ label: string; id: string }> = [
      { label: 'OpenClaw',       id: 'openclaw'   },
      { label: 'Claude',         id: 'claude-sdk' },
      { label: 'GitHub Copilot', id: 'copilot'    },
      { label: 'Gemini',         id: 'gemini'     },
      { label: 'Codex',          id: 'codex'      },
      { label: 'Cursor',         id: 'cursor'     },
    ];
    console.log('\nSelect providers to enable (Y = yes, Enter = no):');
    const selected: string[] = [];
    for (const { label, id } of SELECTABLE) {
      const answer = ttyPrompt(`  [ ] Enable ${label}? [y/N]:`);
      const yes = !!answer && /^y/i.test(answer.trim());
      if (yes) selected.push(id);
    }
    if (selected.length > 0) {
      PROVIDERS = selected;
      PROVIDER = PROVIDERS[0];
    } else {
      console.error('\nNo providers selected. At least one provider is required.');
      process.exit(1);
    }

    // Ask for agents folder now that we know which providers are active
    if (PROVIDERS.some(p => p !== 'openclaw') && FORCE_SETUP) {
      const defaultFolder = process.cwd();
      const input = ttyPrompt(`Enter working folder for agent files [${defaultFolder}]:`);
      process.env.AGENTS_FOLDER = input?.trim() || defaultFolder;
    }

    // Claude: subscription vs API token
    if (PROVIDERS.includes('claude-sdk') && (!process.env.ANTHROPIC_API_KEY || FORCE_SETUP)) {
      console.log('\n  Claude can run with:');
      console.log('    1. Your subscription (Claude Max / Pro — claude CLI must be logged in)');
      console.log('    2. An Anthropic API key');
      let claudeMode: string | null = null;
      while (!claudeMode || (claudeMode.trim() !== '1' && claudeMode.trim() !== '2')) {
        claudeMode = ttyPrompt('  Choose [1/2]:') ?? null;
      }
      if (claudeMode.trim() === '2') {
        let key: string | null = null;
        while (!key?.trim()) {
          key = ttyPrompt('  Enter your Anthropic API key:') ?? null;
          if (!key?.trim()) console.error('  ✗ API key required. Press Ctrl+C to cancel.');
        }
        process.env.ANTHROPIC_API_KEY = key.trim();
      } else {
        _claudeSubscriptionMode = true;
      }
    }

    // Cursor: API token
    if (PROVIDERS.includes('cursor') && (!process.env.CURSOR_API_KEY || FORCE_SETUP)) {
      let key: string | null = null;
      while (!key?.trim()) {
        key = ttyPrompt('\n  Enter your Cursor API key (Cursor Dashboard → Integrations):') ?? null;
        if (!key?.trim()) console.error('  ✗ Cursor API key required. Press Ctrl+C to cancel.');
      }
      process.env.CURSOR_API_KEY = key.trim();
    }

    // OpenClaw: gateway token
    if (PROVIDERS.includes('openclaw') && (!process.env.OPENCLAW_GATEWAY_TOKEN || FORCE_SETUP)) {
      let key: string | null = null;
      while (!key?.trim()) {
        key = ttyPrompt('\n  Enter your OpenClaw gateway token:') ?? null;
        if (!key?.trim()) console.error('  ✗ OpenClaw token required. Press Ctrl+C to cancel.');
      }
      process.env.OPENCLAW_GATEWAY_TOKEN = key.trim();
    }
  }

  if (PROVIDERS.includes('openclaw') && (!process.env.OPENCLAW_CONFIG_PATH && !process.env.OPENCLAW_STATE_DIR && !process.env.OPENCLAW_HOME || FORCE_SETUP)) {
    const defaultDir = path.join(os.homedir(), '.openclaw');
    const input = ttyPrompt(`Enter OpenClaw directory [${defaultDir}]:`);
    const selectedDir = (input || defaultDir).trim();
    process.env.OPENCLAW_HOME = selectedDir.replace(/[\\\/]\.openclaw$/, '');
  }

  // ── Save interactive answers to .env so next run skips prompts ──────────────
  // Only write when there was no pre-existing .env and user went through the
  // interactive flow (not when all vars were already in env).
  if (!_dotenvPath) {
    try {
      const envLines: string[] = [];
      if (PAIRING_TOKEN) envLines.push(`PAIRING_TOKEN=${PAIRING_TOKEN}`);
      if (SAAS_URL && SAAS_URL !== 'wss://api.ctrlnode.ai/ws/bridge') envLines.push(`SAAS_URL=${SAAS_URL}`);
      if (PROVIDERS.length) envLines.push(`PROVIDERS=${PROVIDERS.join(',')}`);
      if (process.env.AGENTS_FOLDER) envLines.push(`AGENTS_FOLDER=${process.env.AGENTS_FOLDER}`);
      if (process.env.ANTHROPIC_API_KEY) envLines.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
      if (process.env.CURSOR_API_KEY) envLines.push(`CURSOR_API_KEY=${process.env.CURSOR_API_KEY}`);
      if (process.env.OPENCLAW_GATEWAY_TOKEN) envLines.push(`OPENCLAW_GATEWAY_TOKEN=${process.env.OPENCLAW_GATEWAY_TOKEN}`);
      if (process.env.OPENCLAW_HOME) envLines.push(`OPENCLAW_HOME=${process.env.OPENCLAW_HOME}`);
      if (envLines.length > 0) {
        const ctrlnodeDir = path.join(process.env.AGENTS_FOLDER || os.homedir(), '.ctrlnode');
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
ANTHROPIC_API_KEY    = process.env.ANTHROPIC_API_KEY    || ANTHROPIC_API_KEY;
CURSOR_API_KEY       = process.env.CURSOR_API_KEY       || CURSOR_API_KEY;
OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || OPENCLAW_GATEWAY_TOKEN;
AGENTS_FOLDER        = process.env.AGENTS_FOLDER        || AGENTS_FOLDER;
AGENTS_CTRLNODE_ROOT = path.join(AGENTS_FOLDER, '.ctrlnode');

// ── Auto-persist AGENTS_FOLDER if missing from an existing .env ──────────────
// When a user already had PAIRING_TOKEN + PROVIDERS in their .env, the
// interactive setup is skipped and AGENTS_FOLDER is never written. Detect this
// and silently append the default (os.homedir()) so future runs are consistent.
if (_dotenvPath && !process.env.AGENTS_FOLDER) {
  const defaultAgentsFolder = os.homedir();
  try {
    fs.appendFileSync(_dotenvPath, `\nAGENTS_FOLDER=${defaultAgentsFolder}\n`, 'utf8');
    process.env.AGENTS_FOLDER = defaultAgentsFolder;
    AGENTS_FOLDER = defaultAgentsFolder;
    AGENTS_CTRLNODE_ROOT = path.join(AGENTS_FOLDER, '.ctrlnode');
    logger.debug('agents_folder_auto_persisted', { path: _dotenvPath, value: defaultAgentsFolder });
  } catch (e: any) {
    logger.warn('agents_folder_auto_persist_failed', { error: e?.message });
  }
}

if (!PAIRING_TOKEN) {
  logger.error('pairing_token_missing', { message: 'PAIRING_TOKEN is required.' });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.error('PAIRING_TOKEN is required. Set the PAIRING_TOKEN environment variable.');
    process.exit(1);
  }
}

if (PROVIDERS.includes('claude-sdk') && !ANTHROPIC_API_KEY && !_claudeSubscriptionMode) {
  logger.warn('anthropic_api_key_missing', { message: 'ANTHROPIC_API_KEY is required for the claude-sdk provider.' });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.warn('Warning: ANTHROPIC_API_KEY is not set. The claude-sdk provider will fail when dispatching tasks.');
  }
} else if (PROVIDERS.includes('claude-sdk') && ANTHROPIC_API_KEY) {
  logger.info('anthropic_api_key_detected', { mode: 'api-key', keyPresent: true });
} else if (PROVIDERS.includes('claude-sdk') && _claudeSubscriptionMode) {
  logger.info('anthropic_api_key_detected', { mode: 'subscription', keyPresent: false });
}

if (PROVIDERS.includes('cursor') && !CURSOR_API_KEY) {
  logger.warn('cursor_api_key_missing', { message: 'CURSOR_API_KEY is required for the cursor provider.' });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.warn('Warning: CURSOR_API_KEY is not set. The cursor provider will fail when dispatching tasks.');
  }
} else if (PROVIDERS.includes('cursor') && CURSOR_API_KEY) {
  logger.info('cursor_api_key_detected', { mode: 'api-key', keyPresent: true });
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

if (PROVIDERS.includes('openclaw')) {
  refreshOpenClawConfig();
}

export const ctrlnodePath = path.join(path.dirname(OPENCLAW_CONFIG || path.join(os.homedir(), '.openclaw', 'openclaw.json')), 'ctrlnode');

// ── Startup validation (openclaw only) ───────────────────────────────────────

if (PROVIDERS.includes('openclaw') && !fs.existsSync(OPENCLAW_CONFIG)) {
  logger.error('config_missing', { expected: OPENCLAW_CONFIG });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.error('OpenClaw configuration not found.');
    console.error(`   Expected at: ${OPENCLAW_CONFIG}`);
    console.error('   Set OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR, OPENCLAW_HOME, or ensure ~/.openclaw/openclaw.json exists.');
    process.exit(1);
  }
}

