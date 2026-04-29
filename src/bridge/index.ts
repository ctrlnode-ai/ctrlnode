/**
 * @file index.ts
 * @description Entry point for the Mission Control Agent Bridge.
 *
 * Bootstraps the bridge in three steps:
 *  1. Import config.ts — resolves all environment variables and validates
 *     that openclaw.json exists (exits with a helpful message if not).
 *  2. Run an initial agent-discovery sync to populate the agent list before
 *     the WebSocket handshake is sent.
 *  3. Open the WebSocket connection to the SaaS.
 *
 * A keepalive timer prevents Node.js from exiting when there are no other
 * active handles (e.g. during the reconnect back-off period).
 *
 * Signal handlers (SIGINT / SIGTERM) shut the process down cleanly.
 */

// config.ts MUST be the first import — it validates env vars and exits
// with a user-friendly message if required files are missing.
import './config';

import { runSyncAgents, connect } from './websocket';
import { logger } from './logger';

// ── Startup banner ────────────────────────────────────────────────────────────

logger.info('startup', { banner: 'Mission Control — Agent Bridge v1.0', builtAt: '__BUILD_TIME__' });

// ── Keepalive ─────────────────────────────────────────────────────────────────

/**
 * Keeps the Node.js event loop alive during reconnect back-off periods
 * when no other handles (timers, sockets) are active.
 * `unref()` prevents this timer from blocking a clean process exit.
 */
const keepalive = setInterval(() => {}, 1_000);
if (keepalive.unref) keepalive.unref();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Discover agents from openclaw.json before connecting
// so the initial handshake already includes them.
runSyncAgents();

// Open (and maintain) the WebSocket connection to the SaaS.
connect();

// ── Process signals ───────────────────────────────────────────────────────────

process.on('SIGINT',  () => { logger.info('shutdown', { message: 'Shutting down' }); process.exit(0); });
process.on('SIGTERM', () => process.emit('SIGINT'));
process.on('uncaughtException', (err: Error) => logger.error('uncaught_exception', { message: err.message }));
