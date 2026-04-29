// ─────────────────────────────────────────────────────────────────────────────
// throttle.ts — Per-asset and hourly throttle, SHARED with scan.ts
// ─────────────────────────────────────────────────────────────────────────────
// We share Redis keys with scan.ts so coordination is automatic:
//   • If scan.ts dispatches an asset at T0, the worker won't dispatch it
//     again until T0+30min (per-asset throttle).
//   • If 3 dispatches have happened in the current hour (worker + scan.ts
//     combined), no further dispatches until the hour rolls.
//
// Keys (must match scan.ts exactly):
//   scan:dispatched_assets       Record<symbol, timestamp>
//   scan:hourly_count_dispatches Record<hour_bucket, count>
//
// Both keys auto-prune: scan.ts cleans entries older than 30min/1h on each
// scan. The worker just adds entries; pruning happens naturally next scan.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";

const DISPATCHED_ASSETS_KEY = "scan:dispatched_assets";
const HOURLY_COUNT_KEY = "scan:hourly_count_dispatches";

const PER_ASSET_THROTTLE_MS = 30 * 60 * 1000;          // 30 min
const HOURLY_CAP = 3;                                    // 3 dispatches/hour (matches scan.ts ALT_PUMP_HOURLY_CAP)

/**
 * Returns "throttled" with a reason if the asset cannot be dispatched right now.
 * Returns "ok" if the asset is eligible.
 *
 * Reads are best-effort: if Redis is unavailable we err on the side of caution
 * and return "ok" (better to dispatch than to miss a signal — the entry endpoint
 * has its own anti-double-dispatch guards).
 */
export async function checkThrottle(symbol: string): Promise<
  | { allowed: true }
  | { allowed: false; reason: "per_asset" | "hourly_cap"; details: Record<string, unknown> }
> {
  const now = Date.now();

  // Per-asset check
  const dispatched = (await redisGet<Record<string, number>>(DISPATCHED_ASSETS_KEY)) ?? {};
  const lastDispatchedAt = dispatched[symbol];
  if (lastDispatchedAt && now - lastDispatchedAt < PER_ASSET_THROTTLE_MS) {
    const remainingMin = Math.round((PER_ASSET_THROTTLE_MS - (now - lastDispatchedAt)) / 60_000);
    return {
      allowed: false,
      reason: "per_asset",
      details: { lastDispatchedAt, remainingMin },
    };
  }

  // Hourly cap check
  const currentHour = Math.floor(now / 3_600_000);
  const hourlyCounts = (await redisGet<Record<string, number>>(HOURLY_COUNT_KEY)) ?? {};
  const currentHourCount = hourlyCounts[String(currentHour)] ?? 0;
  if (currentHourCount >= HOURLY_CAP) {
    return {
      allowed: false,
      reason: "hourly_cap",
      details: { currentHour, currentHourCount, cap: HOURLY_CAP },
    };
  }

  return { allowed: true };
}

/**
 * Record that we dispatched on this asset. Updates BOTH keys atomically-ish
 * (read-modify-write — we accept the small race window, scan.ts uses the
 * same pattern). Optionally pass `releaseAfterTransientSkip=true` to NOT
 * record the throttle (used when entry returned skipped=true with a transient reason).
 */
export async function recordDispatch(symbol: string): Promise<void> {
  const now = Date.now();
  try {
    // Per-asset
    const dispatched = (await redisGet<Record<string, number>>(DISPATCHED_ASSETS_KEY)) ?? {};
    dispatched[symbol] = now;
    // Prune entries older than PER_ASSET_THROTTLE_MS to bound the map size
    for (const [s, ts] of Object.entries(dispatched)) {
      if (now - ts > PER_ASSET_THROTTLE_MS) delete dispatched[s];
    }
    await redisSet(DISPATCHED_ASSETS_KEY, dispatched);

    // Hourly cap
    const hourlyCounts = (await redisGet<Record<string, number>>(HOURLY_COUNT_KEY)) ?? {};
    const currentHour = Math.floor(now / 3_600_000);
    hourlyCounts[String(currentHour)] = (hourlyCounts[String(currentHour)] ?? 0) + 1;
    // Prune any hour buckets older than 3h
    for (const hourStr of Object.keys(hourlyCounts)) {
      if (currentHour - parseInt(hourStr, 10) > 3) delete hourlyCounts[hourStr];
    }
    await redisSet(HOURLY_COUNT_KEY, hourlyCounts);
  } catch (err) {
    logger.warn("recordDispatch failed", { symbol, err: (err as Error).message });
  }
}

/**
 * Release the per-asset throttle (used after entry returns skipped=true with
 * a TRANSIENT reason like parallel_cap or btc_below_floor — these are conditions
 * that may clear quickly, so the asset should be eligible again on next signal).
 */
export async function releaseAssetThrottle(symbol: string): Promise<void> {
  try {
    const dispatched = (await redisGet<Record<string, number>>(DISPATCHED_ASSETS_KEY)) ?? {};
    delete dispatched[symbol];
    await redisSet(DISPATCHED_ASSETS_KEY, dispatched);
  } catch (err) {
    logger.warn("releaseAssetThrottle failed", { symbol, err: (err as Error).message });
  }
}
