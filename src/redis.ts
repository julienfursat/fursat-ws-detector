// ─────────────────────────────────────────────────────────────────────────────
// redis.ts — Upstash REST helper
// ─────────────────────────────────────────────────────────────────────────────
// Étape 2B: the worker now writes to keys SHARED with scan.ts on fursat.net:
//   • scan:dispatched_assets    — per-asset throttle (30 min/asset)
//   • scan:hourly_count_dispatches — hourly cap counter
//   • worker:dispatches_log     — diagnostic log of dispatches sent
//   • dryrun:detected_signals_log / dryrun:filtered_signals_log — observation logs
//
// Instead of a strict "dryrun:* only" allowlist, we use an explicit BLOCKLIST
// of sensitive keys the worker MUST NEVER touch (because they're owned by
// fursat.net and overwriting them would corrupt the agent's state):
//
//   • agent:perf_snapshots      — portfolio value history (owned by perf.ts)
//   • agent:trade_meta          — trade metadata (avgBuyPrice, buyTimestamp)
//   • agent:analyses            — Claude's MANAGE analyses
//   • agent:partial_taken       — partial-take state (owned by scan.ts)
//   • agent:positions           — agent position metadata
//   • scan:price_snapshots      — price history (READ ONLY for preload, never write)
//
// agent:entry_blacklist is also owned by entry.ts (writes blacklists on failures).
// The worker only READS it.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL ?? "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? "";

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  logger.warn("Upstash credentials missing — Redis writes will be no-ops");
}

/**
 * Keys the worker MUST NEVER write to. These are owned by fursat.net and
 * overwriting them would corrupt the production agent's state.
 */
const PROTECTED_KEYS = new Set([
  "agent:perf_snapshots",
  "agent:trade_meta",
  "agent:analyses",
  "agent:partial_taken",
  "agent:positions",
  "agent:entry_blacklist",
  "scan:price_snapshots",
]);

function assertNotProtected(key: string): void {
  if (PROTECTED_KEYS.has(key)) {
    throw new Error(`[redis] Refused to write to PROTECTED key (owned by fursat.net): ${key}`);
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
  assertNotProtected(key);
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

export async function redisDel(key: string): Promise<void> {
  assertNotProtected(key);
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  try {
    await fetch(UPSTASH_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(["DEL", key]),
    });
  } catch (err) {
    logger.warn("redisDel failed", { key, err: (err as Error).message });
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