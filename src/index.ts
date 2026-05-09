/**
 * @file index.ts
 * @description Entry point for the CtrlNode.ai Agent Bridge.
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

import { PROVIDERS, DOTENV_PATH } from './config';
import { createProviders } from './providers/factory';
import { MultiProvider } from './providers/MultiProvider';
import { runSyncAgents, connect } from './websocket';
import { logger } from './logger';

// BUILD_TIME is injected at compile time via --define BUILD_TIME="..."
// Falls back to 'dev' when running with bun run (not compiled).
declare const BUILD_TIME: string;
const _buildTime = typeof BUILD_TIME !== 'undefined' ? BUILD_TIME : 'dev';

// ── Startup banner ────────────────────────────────────────────────────────────

console.log(`CtrlNode.ai Bridge  built ${_buildTime}  providers: ${PROVIDERS.join(',')}  .env: ${DOTENV_PATH ?? 'none'}`);

// ── Keepalive ─────────────────────────────────────────────────────────────────

/**
 * Keeps the Node.js event loop alive during reconnect back-off periods
 * when no other handles (timers, sockets) are active.
 * `unref()` prevents this timer from blocking a clean process exit.
 */
const keepalive = setInterval(() => {}, 1_000);
if (keepalive.unref) keepalive.unref();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const rawProviders = createProviders(PROVIDERS);
const provider = rawProviders.length === 1 ? rawProviders[0] : new MultiProvider(rawProviders);

// Open (and maintain) the WebSocket connection to the SaaS.
connect(provider);

// Discover agents before connecting so the initial handshake includes them.
runSyncAgents();

// ── Process signals ───────────────────────────────────────────────────────────

process.on('SIGINT',  () => {
  logger.info('shutdown', { message: 'Shutting down' });
  provider.dispose().finally(() => process.exit(0));
});
process.on('SIGTERM', () => process.emit('SIGINT'));
process.on('uncaughtException', (err: Error) => logger.error('uncaught_exception', { message: err.message }));
