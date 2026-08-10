type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogFormat = 'human' | 'json';

const SENSITIVE_KEY_PATTERN = /token|secret|password|authorization|credential|api[_-]?key/i;
const SENSITIVE_VALUE_PATTERN = /(bearer\s+)[^\s,;]+|(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi;

const HUMAN_META_KEYS = new Set([
  'agentId', 'agentCount', 'available', 'command', 'count', 'delta', 'detail', 'error',
  'hostname', 'id', 'message', 'mode', 'model', 'name', 'note', 'path', 'payloadType',
  'provider', 'providers', 'queueLength', 'reason', 'retrySeconds', 'status',
  'taskId', 'unhealthy', 'url', 'workspace', 'workspaceDir',
]);

const ACTION_EVENTS = new Set([
  'connecting', 'queued_outgoing', 'retrying', 'reconnecting', 'browser_sign_in_starting',
  'handshake_sent', 'available_models_sent', 'dump_incoming_failed',
]);

function nowIso() {
  return new Date().toISOString();
}

function currentFormat(): LogFormat {
  return String(process.env.LOG_FORMAT || '').trim().toLowerCase() === 'json' ? 'json' : 'human';
}

function isDebugEnabled(): boolean {
  return process.env.DEBUG === 'true' || process.env.DEBUG === '1';
}

function redactText(value: string): string {
  return value.replace(SENSITIVE_VALUE_PATTERN, (_match, prefix: string | undefined) => `${prefix || '[hidden]'}[hidden]`);
}

function safeText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(safeText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    try {
      return redactText(JSON.stringify(value));
    } catch {
      return '[unavailable]';
    }
  }
  return redactText(String(value));
}

function humanizeEventName(event: string): string {
  return event
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function metaValue(meta: Record<string, any>, key: string): string {
  return safeText(meta[key]);
}

function withValue(label: string, value: string): string {
  return value ? `${label}${value}` : '';
}

function formatKnownEvent(event: string, meta: Record<string, any>): string | null {
  const agentId = metaValue(meta, 'agentId') || metaValue(meta, 'id');
  const workspace = metaValue(meta, 'workspace') || metaValue(meta, 'workspaceDir');

  switch (event) {
    case 'config_loaded':
      return `Configuration loaded from ${metaValue(meta, 'path')}${withValue('. Reconfigure with ', metaValue(meta, 'command'))}`;
    case 'browser_sign_in_starting':
      return 'No pairing token configured — starting browser sign-in.';
    case 'connecting':
      return `Connecting to ${metaValue(meta, 'url')}${withValue(' (providers: ', metaValue(meta, 'providers'))}${metaValue(meta, 'providers') ? ')' : ''}`;
    case 'connected':
      return 'Connected to CtrlNode.';
    case 'handshake_sent':
      return `Bridge handshake sent${meta.agentCount !== undefined ? ` (${metaValue(meta, 'agentCount')} agent${meta.agentCount === 1 ? '' : 's'})` : ''}.`;
    case 'agent_discovered':
      return `Agent discovered: ${agentId}${withValue(' (workspace: ', workspace)}${workspace ? ')' : ''}`;
    case 'agent_removed':
      return `Agent removed: ${agentId}.`;
    case 'workspace_missing':
      return `Workspace missing for agent ${agentId}: ${workspace}`;
    case 'agent_status':
      return `Agent ${agentId} is ${metaValue(meta, 'status')}.`;
    case 'anthropic_api_key_not_set':
      return `Anthropic API key not configured${withValue(' — ', metaValue(meta, 'note'))}`;
    case 'anthropic_api_key_detected':
      return `Anthropic API key detected (mode: ${metaValue(meta, 'mode') || 'configured'}).`;
    case 'cursor_api_key_not_set':
      return `Cursor API key not configured${withValue(' — ', metaValue(meta, 'note'))}`;
    case 'cursor_api_key_detected':
      return `Cursor API key detected (mode: ${metaValue(meta, 'mode') || 'configured'}).`;
    case 'openrouter_api_key_not_set':
      return `OpenRouter API key not configured${withValue(' — ', metaValue(meta, 'note'))}`;
    case 'openrouter_api_key_detected':
      return `OpenRouter API key detected (mode: ${metaValue(meta, 'mode') || 'configured'}).`;
    case 'openclaw_config_not_found':
      return `OpenClaw config not found${withValue(': ', metaValue(meta, 'path'))}`;
    case 'auth_failed':
      return `Authentication failed${withValue(': ', metaValue(meta, 'detail'))}`;
    case 'auth_retry_scheduled':
      return `Authentication will retry in ${metaValue(meta, 'retrySeconds')}s${withValue(' — ', metaValue(meta, 'message'))}`;
    case 'connection_timeout':
      return `Connection timed out${withValue(': ', metaValue(meta, 'message'))}`;
    case 'shutdown':
      return 'Shutting down Bridge.';
    case 'openclaw_config_read_failed':
      return `Could not read OpenClaw config${withValue(': ', metaValue(meta, 'error'))}`;
    case 'openclaw_config_write_failed':
      return `Could not save OpenClaw config${withValue(': ', metaValue(meta, 'error'))}`;
    case 'provider_health_check_failed':
      return `Provider health check failed${withValue(': ', metaValue(meta, 'error'))}`;
    default:
      return null;
  }
}

function formatHumanMessage(event: string, meta: Record<string, any>): string {
  const known = formatKnownEvent(event, meta);
  if (known) return known;

  const details = Object.entries(meta)
    .filter(([key, value]) => HUMAN_META_KEYS.has(key) && !SENSITIVE_KEY_PATTERN.test(key) && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${safeText(value)}`)
    .filter(entry => !entry.endsWith('='))
    .slice(0, 6);

  return `${humanizeEventName(event)}${details.length ? ` (${details.join(', ')})` : ''}`;
}

function symbolFor(level: LogLevel, event: string): string {
  if (level === 'error') return '✗';
  if (level === 'warn') return '⚠';
  if (ACTION_EVENTS.has(event)) return '→';
  return '✓';
}

function serializableMeta(meta: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(meta)) {
    try {
      JSON.stringify(value);
      result[key] = value;
    } catch {
      result[key] = String(value);
    }
  }
  return result;
}

export function formatHumanLog(level: LogLevel, event: string, meta: Record<string, any> = {}): string {
  return `${symbolFor(level, event)} ${formatHumanMessage(event, meta)}`;
}

function write(level: LogLevel, payload: Record<string, any>) {
  const event = String(payload.msg || 'bridge_event');
  const meta = { ...payload };
  delete meta.msg;

  if (currentFormat() === 'json') {
    const entry = { ts: nowIso(), level, msg: event, ...serializableMeta(meta) };
    try {
      console.log(JSON.stringify(entry));
    } catch {
      console.log(JSON.stringify({ ts: entry.ts, level, msg: event, serializationError: true }));
    }
    return;
  }

  console.log(formatHumanLog(level, event, meta));
}

export const logger = {
  debug: (msg: string, meta: Record<string, any> = {}) => {
    if (isDebugEnabled()) write('debug', { msg, ...meta });
  },
  info:  (msg: string, meta: Record<string, any> = {}) => write('info', { msg, ...meta }),
  warn:  (msg: string, meta: Record<string, any> = {}) => write('warn', { msg, ...meta }),
  error: (msg: string, meta: Record<string, any> = {}) => write('error', { msg, ...meta }),
};

export default logger;
