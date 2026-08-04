/**
 * @file index.ts
 * @description Entry point for the CtrlNode.ai Agent Bridge.
 */

// BUILD_TIME is injected at compile time via --define BUILD_TIME="..."
declare const BUILD_TIME: string;
const _buildTime = typeof BUILD_TIME !== 'undefined' ? BUILD_TIME : 'dev';

// config.ts MUST be the first import — it validates env vars and exits
// with a user-friendly message if required files are missing.
const { PROVIDERS, ensurePairingToken, BRIDGE_VERSION, restrictProvidersTo } = await import('./config.js');

console.log(`\nCTRLNODE Bridge ${BRIDGE_VERSION}  built ${_buildTime}\n`);

// --setup: run interactive wizard and exit before loading anything else.
// Must be checked before any other imports so config.ts side-effects don't run.
if (process.argv.includes('--setup')) {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  process.exit(0);
}

// login / --login: device-authorization flow to obtain PAIRING_TOKEN without
// copy-pasting it from Settings → Bridge. See src/login.ts.
if (process.argv.includes('login') || process.argv.includes('--login')) {
  const { runLogin, defaultEnvFilePath } = await import('./login.js');
  try {
    await runLogin(defaultEnvFilePath());
    process.exit(0);
  } catch (err: any) {
    console.error(`\nLogin failed: ${err.message}\n`);
    process.exit(1);
  }
}

const { createProviders } = await import('./providers/factory.js');
const { MultiProvider } = await import('./providers/MultiProvider.js');
const { runSyncAgents, connect } = await import('./websocket.js');
const { logger } = await import('./logger.js');
const { loadModelManifest } = await import('./modelManifest.js');
const { checkAndApplyUpdate } = await import('./updater.js');
const { fetchKnownProviderKeys } = await import('./providerDiscovery.js');

// ── Keepalive ─────────────────────────────────────────────────────────────────

const keepalive = setInterval(() => {}, 1_000);
if (keepalive.unref) keepalive.unref();

// ── Bootstrap ─────────────────────────────────────────────────────────────────

// Check for Bridge updates — runs before pairing/connect so prompt appears right after banner.
// Failures are handled internally — Bridge always starts even if the check fails.
await checkAndApplyUpdate();

await ensurePairingToken();

// Fetch/refresh model manifest before connecting (Option A).
// Failures are handled internally — Bridge always starts even if the fetch fails.
await loadModelManifest();

// Narrow PROVIDERS to whatever the backend currently recognizes (single source of
// truth, same principle as the frontend's agent-type picker). If the fetch fails,
// this is skipped entirely and every provider this Bridge build knows about — and
// is credentialed for — stays active.
const knownProviderKeys = await fetchKnownProviderKeys();
if (knownProviderKeys) restrictProvidersTo(new Set(knownProviderKeys));

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
