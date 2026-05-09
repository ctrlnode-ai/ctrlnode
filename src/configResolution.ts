import path from 'path';

type EnvMap = Record<string, string | undefined>;

export interface ResolveOpenClawConfigInput {
  env: EnvMap;
  platform: NodeJS.Platform;
  homedir: string;
  existsSync: (filePath: string) => boolean;
}

export interface ResolveOpenClawConfigResult {
  path: string;
  source:
    | 'OPENCLAW_CONFIG_PATH'
    | 'OPENCLAW_STATE_DIR'
    | 'OPENCLAW_HOME'
    | 'HOME-default'
    | 'USERPROFILE-default'
    | 'homedir-default'
    | 'auto-discovered';
}

function normalizeNonEmpty(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getPathLib(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix;
}

function expandTilde(value: string, env: EnvMap, pathLib: typeof path.posix | typeof path.win32): string {
  if (!value.startsWith('~')) return value;
  const home = normalizeNonEmpty(env.HOME) ?? normalizeNonEmpty(env.USERPROFILE);
  if (!home) return value;
  return pathLib.join(home, value.slice(1));
}

function normalizeCandidate(value: string, env: EnvMap, pathLib: typeof path.posix | typeof path.win32): string {
  return pathLib.normalize(expandTilde(value, env, pathLib));
}

export function resolveOpenClawConfigPath(input: ResolveOpenClawConfigInput): ResolveOpenClawConfigResult {
  const { env, homedir, existsSync, platform } = input;
  const pathLib = getPathLib(platform);

  const explicitConfigPath = normalizeNonEmpty(env.OPENCLAW_CONFIG_PATH);
  if (explicitConfigPath) {
    return {
      path: normalizeCandidate(explicitConfigPath, env, pathLib),
      source: 'OPENCLAW_CONFIG_PATH',
    };
  }

  const explicitStateDir = normalizeNonEmpty(env.OPENCLAW_STATE_DIR);
  if (explicitStateDir) {
    return {
      path: pathLib.join(normalizeCandidate(explicitStateDir, env, pathLib), 'openclaw.json'),
      source: 'OPENCLAW_STATE_DIR',
    };
  }

  const explicitHome = normalizeNonEmpty(env.OPENCLAW_HOME);
  if (explicitHome) {
    return {
      path: pathLib.join(normalizeCandidate(explicitHome, env, pathLib), '.openclaw', 'openclaw.json'),
      source: 'OPENCLAW_HOME',
    };
  }

  const homeEnv = normalizeNonEmpty(env.HOME);
  const userProfile = normalizeNonEmpty(env.USERPROFILE);

  let defaultPath: string;
  let defaultSource: ResolveOpenClawConfigResult['source'];

  if (homeEnv) {
    defaultPath = pathLib.join(normalizeCandidate(homeEnv, env, pathLib), '.openclaw', 'openclaw.json');
    defaultSource = 'HOME-default';
  } else if (userProfile) {
    defaultPath = pathLib.join(normalizeCandidate(userProfile, env, pathLib), '.openclaw', 'openclaw.json');
    defaultSource = 'USERPROFILE-default';
  } else {
    defaultPath = pathLib.join(pathLib.normalize(homedir), '.openclaw', 'openclaw.json');
    defaultSource = 'homedir-default';
  }

  const candidates = [
    defaultPath,
    pathLib.join(pathLib.normalize(homedir), '.openclaw', 'openclaw.json'),
    path.posix.join('/home/node', '.openclaw', 'openclaw.json'),
    path.posix.join('/home/ubuntu', '.openclaw', 'openclaw.json'),
    path.posix.join('/root', '.openclaw', 'openclaw.json'),
    pathLib.join(pathLib.normalize(process.cwd()), '.openclaw', 'openclaw.json'),
    pathLib.join(pathLib.normalize(process.cwd()), 'openclaw.json'),
  ].map((candidate) => pathLib.normalize(candidate));

  const uniqueCandidates = [...new Set(candidates)];
  const discovered = uniqueCandidates.find((candidate) => existsSync(candidate));

  if (discovered) {
    if (discovered === defaultPath) {
      return { path: discovered, source: defaultSource };
    }
    return { path: discovered, source: 'auto-discovered' };
  }

  return { path: defaultPath, source: defaultSource };
}
