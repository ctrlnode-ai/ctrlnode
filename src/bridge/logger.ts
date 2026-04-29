type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function nowIso() {
  return new Date().toISOString();
}

function write(level: LogLevel, payload: Record<string, any>) {
  const entry = Object.assign({ ts: nowIso(), level }, payload);
  // Emit a single-line JSON so logs are easy to parse and non-ambiguous
  try {
    console.log(JSON.stringify(entry));
  } catch (err) {
    // Fallback to plain console if serialization fails
    console.log(`[${entry.ts}] ${level.toUpperCase()} ${JSON.stringify(payload)}`);
  }
}

export const logger = {
  debug: (msg: string, meta: Record<string, any> = {}) => {}, // Debug logs disabled
  info:  (msg: string, meta: Record<string, any> = {}) => write('info',  { msg, ...meta }),
  warn:  (msg: string, meta: Record<string, any> = {}) => write('warn',  { msg, ...meta }),
  error: (msg: string, meta: Record<string, any> = {}) => write('error', { msg, ...meta }),
};

export default logger;
