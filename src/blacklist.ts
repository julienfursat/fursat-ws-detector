// ─────────────────────────────────────────────────────────────────────────────
// blacklist.ts — Read agent:entry_blacklist (READ ONLY)
// ─────────────────────────────────────────────────────────────────────────────
// agent:entry_blacklist is OWNED by entry.ts (writes when an asset fails
// preflight or execution — typically 7 days). The worker only reads to skip
// dispatching on blacklisted assets.
//
// We cache the blacklist in memory and refresh every CACHE_TTL_MS to avoid
// hammering Redis on every signal. Stale by up to CACHE_TTL_MS — acceptable
// since blacklist changes are infrequent.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet } from "./redis.js";

const BLACKLIST_KEY = "agent:entry_blacklist";
const CACHE_TTL_MS = 60_000;  // refresh blacklist at most once per minute

interface BlacklistEntry {
  expiresAt: number;
  reason?: string;
}

let cachedBlacklist: Record<string, BlacklistEntry> = {};
let cachedAt = 0;

/**
 * Returns true if the symbol is currently blacklisted (and the blacklist
 * entry hasn't expired yet).
 */
export async function isBlacklisted(symbol: string): Promise<{
  blacklisted: boolean;
  reason?: string;
  expiresInMs?: number;
}> {
  const now = Date.now();
  if (now - cachedAt > CACHE_TTL_MS) {
    try {
      cachedBlacklist = (await redisGet<Record<string, BlacklistEntry>>(BLACKLIST_KEY)) ?? {};
      cachedAt = now;
    } catch (err) {
      logger.warn("isBlacklisted: Redis read failed, using stale cache", {
        err: (err as Error).message,
      });
    }
  }

  const entry = cachedBlacklist[symbol];
  if (!entry) return { blacklisted: false };
  if (entry.expiresAt < now) return { blacklisted: false };
  return {
    blacklisted: true,
    reason: entry.reason,
    expiresInMs: entry.expiresAt - now,
  };
}
