// ─────────────────────────────────────────────────────────────────────────────
// logger.ts — minimal structured logger with level filtering
// ─────────────────────────────────────────────────────────────────────────────
// Outputs JSON-ish lines for grep-friendly inspection in Railway logs.
// Level controlled via LOG_LEVEL env var (default: info).
// ─────────────────────────────────────────────────────────────────────────────

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const ENV_LEVEL = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level;
const MIN = LEVELS[ENV_LEVEL] ?? LEVELS.info;

function fmt(level: Level, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
  return `[${ts}] ${level.toUpperCase()} ${msg}${metaStr}`;
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS.debug >= MIN) console.log(fmt("debug", msg, meta));
  },
  info(msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS.info >= MIN) console.log(fmt("info", msg, meta));
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS.warn >= MIN) console.warn(fmt("warn", msg, meta));
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS.error >= MIN) console.error(fmt("error", msg, meta));
  },
};
