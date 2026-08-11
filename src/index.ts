/**
 * @file index.ts
 * @description Entry point for the CtrlNode.ai Agent Bridge.
 */

const _isLoginCommand = (await import('./cliMode.js')).isLoginCommand(process.argv);
const _isSetupCommand = process.argv.includes('--setup');

// --setup: run interactive wizard and exit before loading anything else.
// Must be checked before any other imports so config.ts side-effects don't run.
if (_isSetupCommand) {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  process.exit(0);
}

// login / --login: device-authorization flow to obtain PAIRING_TOKEN without
// copy-pasting it from Settings → Bridge. See src/login.ts.
if (_isLoginCommand) {
  const { runLogin, defaultEnvFilePath } = await import('./login.js');
  try {
    await runLogin(defaultEnvFilePath());
    process.exit(0);
  } catch (err: any) {
    console.error(`\nLogin failed: ${err.message}\n`);
    process.exit(1);
  }
}

// Resolve and persist the workspace before config.ts reads BASE_PATH. Interactive
// launches ask whenever the current directory differs; services keep the saved path.
const { canonicalBridgeEnvPath, runWorkspaceTrustPreflight } = await import('./workspaceTrust.js');
await runWorkspaceTrustPreflight();

const {
  BASE_PATH,
  BRIDGE_VERSION,
  DOTENV_PATH,
  PROVIDERS,
  ensurePairingToken,
  restrictProvidersTo,
} = await import('./config.js');
const { renderWelcomePanel, supportsTerminalColor } = await import('./terminalPanels.js');
for (const line of renderWelcomePanel({
  workspace: BASE_PATH,
  configPath: DOTENV_PATH ?? canonicalBridgeEnvPath(),
  providerCount: PROVIDERS.length,
  version: BRIDGE_VERSION,
  boxed: Boolean(process.stdout.isTTY),
  color: supportsTerminalColor(),
  columns: process.stdout.columns,
})) console.log(line);
console.log('');

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
