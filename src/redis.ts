// ─────────────────────────────────────────────────────────────────────────────
// redis.ts — Upstash REST helper, scoped to dryrun:* namespace
// ─────────────────────────────────────────────────────────────────────────────
// All writes from this worker MUST go to keys prefixed with "dryrun:" — this is
// enforced by assertDryrunKey(). The worker shares the same Upstash instance as
// fursat.net but is otherwise isolated.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  logger.warn("Upstash credentials missing — Redis writes will be no-ops");
}

/** Guards against accidental writes outside the dryrun:* namespace. */
function assertDryrunKey(key: string): void {
  if (!key.startsWith("dryrun:")) {
    throw new Error(`[redis] Refused to write to non-dryrun key: ${key}`);
  }
}

export async function redisGet<T = unknown>(key: string): Promise<T | null> {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    const data = (await res.json()) as { result?: string };
    if (data.result === undefined || data.result === null) return null;
    try {
      return JSON.parse(data.result) as T;
    } catch {
      return data.result as unknown as T;
    }
  } catch (err) {
    logger.warn("redisGet failed", { key, err: (err as Error).message });
    return null;
  }
}

export async function redisSet(key: string, value: unknown): Promise<void> {
  assertDryrunKey(key);
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["SET", key, JSON.stringify(value)]),
    });
  } catch (err) {
    logger.warn("redisSet failed", { key, err: (err as Error).message });
  }
}

/**
 * Throttled heartbeat write — only persists if more than `minIntervalMs` have
 * elapsed since the last successful write. Returns true if the write happened.
 */
let lastHeartbeatWriteAt = 0;
export async function writeHeartbeat(minIntervalMs = 30_000): Promise<boolean> {
  const now = Date.now();
  if (now - lastHeartbeatWriteAt < minIntervalMs) return false;
  lastHeartbeatWriteAt = now;
  await redisSet("dryrun:ws_heartbeat", { ts: now });
  return true;
}
