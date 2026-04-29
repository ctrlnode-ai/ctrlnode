/**
 * @file config.ts
 * @description Runtime configuration for the CtrlNode.ai Agent Bridge.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { logger } from './logger';
import { resolveOpenClawConfigPath } from './configResolution';

// ── WebSocket / SaaS ──────────────────────────────────────────────────────────

export let SAAS_URL = process.env.SAAS_URL || 'wss://api-sta.ctrlnode.ai/ws/bridge';
export let PAIRING_TOKEN = process.env.PAIRING_TOKEN || '';

// ── OpenClaw configuration paths ──────────────────────────────────────────────

export let OPENCLAW_CONFIG = '';
export const OPENCLAW_GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || 'http://localhost:18789';
export const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
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

// ── Misc ──────────────────────────────────────────────────────────────────────

export const BRIDGE_VERSION = '1.0.0';
export const SESSION_INACTIVITY_TIMEOUT_MINUTES = parseInt(process.env.SESSION_INACTIVITY_TIMEOUT_MINUTES || '5', 10);
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

const runtimePrompt = (globalThis as any).prompt as ((message: string) => string | null | undefined) | undefined;
const canPrompt = typeof runtimePrompt === 'function';

// ── Interactive TTY setup ─────────────────────────────────────────────────────

if (process.stdout.isTTY && canPrompt) {
  if (process.env.SAAS_URL === undefined) {
    const input = runtimePrompt!('Enter SaaS URL [wss://api-sta.ctrlnode.ai/ws/bridge]:');
    SAAS_URL = (input || 'wss://api-sta.ctrlnode.ai/ws/bridge').trim();
  }

  if (!PAIRING_TOKEN) {
    const input = runtimePrompt!('Please enter your PAIRING_TOKEN:');
    if (input) PAIRING_TOKEN = input.trim();
  }

  if (!process.env.OPENCLAW_CONFIG_PATH && !process.env.OPENCLAW_STATE_DIR && !process.env.OPENCLAW_HOME) {
    const defaultDir = path.join(os.homedir(), '.openclaw');
    const input = runtimePrompt!(`Enter OpenClaw directory [${defaultDir}]:`);
    const selectedDir = (input || defaultDir).trim();
    process.env.OPENCLAW_HOME = selectedDir.replace(/[\\\/]\.openclaw$/, '');
  }
}

if (!PAIRING_TOKEN) {
  logger.error('pairing_token_missing', { message: 'PAIRING_TOKEN is required.' });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.error('PAIRING_TOKEN is required. Set the PAIRING_TOKEN environment variable.');
    process.exit(1);
  }
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
  logger.info('config_path_resolved', { path: OPENCLAW_CONFIG, source: resolvedConfig.source });
  return OPENCLAW_CONFIG;
}

refreshOpenClawConfig();

export const ctrlnodePath = path.join(path.dirname(OPENCLAW_CONFIG), 'ctrlnode');

// ── Startup validation ────────────────────────────────────────────────────────

if (!fs.existsSync(OPENCLAW_CONFIG)) {
  logger.error('config_missing', { expected: OPENCLAW_CONFIG });
  if (!process.env.BUN_TEST && !process.env.TEST) {
    console.error('OpenClaw configuration not found.');
    console.error(`   Expected at: ${OPENCLAW_CONFIG}`);
    console.error('   Set OPENCLAW_CONFIG_PATH, OPENCLAW_STATE_DIR, OPENCLAW_HOME, or ensure ~/.openclaw/openclaw.json exists.');
    process.exit(1);
  }
}
