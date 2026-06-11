/**
 * @file index.ts
 * @description Entry point for the CtrlNode.ai Agent Bridge.
 */

// BUILD_TIME is injected at compile time via --define BUILD_TIME="..."
declare const BUILD_TIME: string;
const _buildTime = typeof BUILD_TIME !== 'undefined' ? BUILD_TIME : 'dev';

console.log(`\nCTRLNODE Bridge v2026.2.2  built ${_buildTime}\n`);

// --setup: run interactive wizard and exit before loading anything else.
// Must be checked before any other imports so config.ts side-effects don't run.
if (process.argv.includes('--setup')) {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  process.exit(0);
}

// config.ts MUST be the first import — it validates env vars and exits
// with a user-friendly message if required files are missing.
const { PROVIDERS, ensurePairingToken } = await import('./config.js');
const { createProviders } = await import('./providers/factory.js');
const { MultiProvider } = await import('./providers/MultiProvider.js');
const { runSyncAgents, connect } = await import('./websocket.js');
const { logger } = await import('./logger.js');
const { loadModelManifest } = await import('./modelManifest.js');

// ── Keepalive ─────────────────────────────────────────────────────────────────

const keepalive = setInterval(() => {}, 1_000);
if (keepalive.unref) keepalive.unref();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

await ensurePairingToken();

// Fetch/refresh model manifest before connecting (Option A).
// Failures are handled internally — Bridge always starts even if the fetch fails.
await loadModelManifest();

const rawProviders = createProviders(PROVIDERS);
const provider = rawProviders.length === 1 ? rawProviders[0] : new MultiProvider(rawProviders);

connect(provider);
runSyncAgents();

// ── Process signals ───────────────────────────────────────────────────────────

process.on('SIGINT',  () => {
  logger.debug('shutdown', { message: 'Shutting down' });
  provider.dispose().finally(() => process.exit(0));
});
process.on('SIGTERM', () => process.emit('SIGINT'));
process.on('uncaughtException', (err: Error) => logger.error('uncaught_exception', { message: err.message }));

export {};
