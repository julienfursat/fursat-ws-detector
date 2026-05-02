// ─────────────────────────────────────────────────────────────────────────────
// throttle.ts — Per-asset and hourly throttle, SHARED with scan.ts
// ─────────────────────────────────────────────────────────────────────────────
// We share Redis keys with scan.ts so coordination is automatic:
//   • If scan.ts dispatches an asset at T0, the worker won't dispatch it
//     again until T0+30min (per-asset throttle).
//   • Hourly cap is split by signalType (BACKLOG-3 phase 3, 2026-05-02):
//       - alt_pump: 3/hr (conservative — protects against mass-trigger on BTC pump)
//       - early_pump: 10/hr (sub-min signals are higher quality, less correlated)
//     This prevents legitimate early_pump opportunities from being throttled by
//     classical alt_pump dispatches that share the same bucket.
//
// Keys (must match scan.ts exactly):
//   scan:dispatched_assets             Record<symbol, timestamp>      (per-asset, all types)
//   scan:hourly_count_dispatches       Record<hour_bucket, count>      (alt_pump bucket)
//   scan:hourly_count_dispatches_early Record<hour_bucket, count>      (early_pump bucket, NEW)
//
// Both keys auto-prune: scan.ts cleans entries older than 30min/1h on each
// scan. The worker just adds entries; pruning happens naturally next scan.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";

const DISPATCHED_ASSETS_KEY = "scan:dispatched_assets";
const HOURLY_COUNT_KEY = "scan:hourly_count_dispatches";
// BACKLOG-3 phase 3 (2026-05-02) — Separate bucket for early_pump signals.
// Allows raising the early_pump cap to 10/hr without affecting the classical
// alt_pump cap (which stays at 3/hr for safety).
const HOURLY_COUNT_EARLY_KEY = "scan:hourly_count_dispatches_early";

const PER_ASSET_THROTTLE_MS = 30 * 60 * 1000;          // 30 min

// Hourly caps per signal type. early_pump is more permissive because:
//   1. Sub-min signals are higher quality (anti-isolated-candle filter applied)
//   2. They're less correlated to BTC pump (no "ride the wave" mass-trigger)
//   3. Empirically, we observed legit signals being throttled (ELA 02/05 12:34)
//      while we still had cap budget on early_pump specifically.
const ALT_PUMP_HOURLY_CAP = 3;
const EARLY_PUMP_HOURLY_CAP = 10;

export type SignalTypeForThrottle = "alt_pump" | "early_pump";

/**
 * Returns "throttled" with a reason if the asset cannot be dispatched right now.
 * Returns "ok" if the asset is eligible.
 *
 * The hourly cap is checked against the bucket matching `signalType` so
 * alt_pump and early_pump don't compete for the same hourly budget.
 *
 * Reads are best-effort: if Redis is unavailable we err on the side of caution
 * and return "ok" (better to dispatch than to miss a signal — the entry endpoint
 * has its own anti-double-dispatch guards).
 */
export async function checkThrottle(
  symbol: string,
  signalType: SignalTypeForThrottle = "alt_pump",
): Promise<
  | { allowed: true }
  | { allowed: false; reason: "per_asset" | "hourly_cap"; details: Record<string, unknown> }
> {
  const now = Date.now();

  // Per-asset check (shared across all signal types — prevents same asset
  // being bought twice in 30min regardless of signal source)
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

  // Hourly cap check — uses the bucket matching signalType
  const hourlyKey = signalType === "early_pump" ? HOURLY_COUNT_EARLY_KEY : HOURLY_COUNT_KEY;
  const cap = signalType === "early_pump" ? EARLY_PUMP_HOURLY_CAP : ALT_PUMP_HOURLY_CAP;
  const currentHour = Math.floor(now / 3_600_000);
  const hourlyCounts = (await redisGet<Record<string, number>>(hourlyKey)) ?? {};
  const currentHourCount = hourlyCounts[String(currentHour)] ?? 0;
  if (currentHourCount >= cap) {
    return {
      allowed: false,
      reason: "hourly_cap",
      details: { signalType, currentHour, currentHourCount, cap },
    };
  }

  return { allowed: true };
}

/**
 * Record that we dispatched on this asset. Updates BOTH keys atomically-ish
 * (read-modify-write — we accept the small race window, scan.ts uses the
 * same pattern). The hourly counter is incremented in the bucket matching
 * `signalType` so each signal type has its own budget.
 */
export async function recordDispatch(
  symbol: string,
  signalType: SignalTypeForThrottle = "alt_pump",
): Promise<void> {
  const now = Date.now();
  try {
    // Per-asset (shared)
    const dispatched = (await redisGet<Record<string, number>>(DISPATCHED_ASSETS_KEY)) ?? {};
    dispatched[symbol] = now;
    // Prune entries older than PER_ASSET_THROTTLE_MS to bound the map size
    for (const [s, ts] of Object.entries(dispatched)) {
      if (now - ts > PER_ASSET_THROTTLE_MS) delete dispatched[s];
    }
    await redisSet(DISPATCHED_ASSETS_KEY, dispatched);

    // Hourly cap — write to the bucket matching signalType
    const hourlyKey = signalType === "early_pump" ? HOURLY_COUNT_EARLY_KEY : HOURLY_COUNT_KEY;
    const hourlyCounts = (await redisGet<Record<string, number>>(hourlyKey)) ?? {};
    const currentHour = Math.floor(now / 3_600_000);
    hourlyCounts[String(currentHour)] = (hourlyCounts[String(currentHour)] ?? 0) + 1;
    // Prune any hour buckets older than 3h
    for (const hourStr of Object.keys(hourlyCounts)) {
      if (currentHour - parseInt(hourStr, 10) > 3) delete hourlyCounts[hourStr];
    }
    await redisSet(hourlyKey, hourlyCounts);
  } catch (err) {
    logger.warn("recordDispatch failed", { symbol, signalType, err: (err as Error).message });
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