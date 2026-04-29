// ─────────────────────────────────────────────────────────────────────────────
// preload.ts — Warm-start the ring buffers from scan:price_snapshots
// ─────────────────────────────────────────────────────────────────────────────
// At cold start, the worker would normally need 1h of WS history before change1h
// becomes available, and 4h before change4h works. During that warmup, the
// detector misses real signals.
//
// This module solves the cold-start problem by reading scan:price_snapshots
// (written by scan.ts every minute on fursat.net) and replaying it INTO the
// ring buffers WITH PROPER TEMPORAL INTERPOLATION.
//
// scan:price_snapshots format (defined in fursat.net/scan.ts):
//   [
//     { timestamp: 1777456262707, prices: { BTC: 77664.46, ETH: 2343.19, ... } },
//     ...   // up to 280 snapshots, NEWEST FIRST, written ~every minute
//   ]
//
// THE BUG WE'RE FIXING (observed 2026-04-29):
//   v1 of preload planted 1 buffer slot per scan snapshot. Since the short
//   buffer is 5s-granular and scan writes every 60s, this meant:
//   • 60 slots in the short buffer = 60 minutes of scan history (compressed)
//     INSTEAD OF the 5-minute window the buffer is supposed to represent
//   • change5m, change15m, change1h all returned values comparing against
//     prices ~12x older than they should — completely wrong semantically
//   • Empirically: GWEI was bought by scan at +5.9%/15m, but the worker
//     filtered it as drawdown_15m because its "15min ago" reference was
//     actually 3h ago (post-pump price), making it look like a drawdown
//
// THE FIX — STEP INTERPOLATION:
//   For each scan snapshot at time t_scan with price p:
//     • short buffer: plant 12 slots of 5s each, all with price p,
//       covering the window [t_scan, t_scan + 60s)
//     • long buffer: plant 2 slots of 30s each, all with price p,
//       covering the window [t_scan, t_scan + 60s)
//   This gives temporally-correct slot mapping. After preload:
//     • short buffer = 720 slots filled = 1h of dense history → change1h works
//     • long buffer = 480 slots filled = 4h of dense history → change4h works
//   (limited by buffer capacity, not by available scan history)
//
// We use STEP interpolation (constant price for each 60s window) rather than
// linear interpolation between snapshots. Linear would be slightly more
// accurate but adds complexity for negligible benefit at minute-level.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";

const PRICE_SNAPSHOTS_KEY = "scan:price_snapshots";

// Granularities of the underlying ring buffers (must match ring-buffers.ts)
const SHORT_INTERVAL_MS = 5_000;
const SHORT_BUFFER_SIZE = 720;
const LONG_INTERVAL_MS = 30_000;
const LONG_BUFFER_SIZE = 480;

// Scan writes one snapshot every ~60 seconds
const SCAN_INTERVAL_MS = 60_000;
const SHORT_SLOTS_PER_SCAN = SCAN_INTERVAL_MS / SHORT_INTERVAL_MS;  // 12
const LONG_SLOTS_PER_SCAN = SCAN_INTERVAL_MS / LONG_INTERVAL_MS;    // 2

interface PriceSnapshot {
  timestamp: number;
  prices: Record<string, number>;
}

export interface PreloadResult {
  loaded: boolean;
  scanSnapshots: number;
  shortSlotsPlanted: number;
  longSlotsPlanted: number;
  oldestSnapshotAgeMs: number | null;
  newestSnapshotAgeMs: number | null;
  symbolsCovered: number;
  durationMs: number;
}

/**
 * Read scan:price_snapshots and replay it into the ring buffers using STEP
 * interpolation (12 short slots / 2 long slots per scan snapshot).
 */
export async function preloadRingBuffers(
  ringBuffers: RingBuffers,
  tradableSymbols: Set<string>
): Promise<PreloadResult> {
  const startedAt = Date.now();
  const snapshots = await redisGet<PriceSnapshot[]>(PRICE_SNAPSHOTS_KEY);

  if (!snapshots || !Array.isArray(snapshots) || snapshots.length === 0) {
    logger.warn("Preload: no snapshots found in scan:price_snapshots — cold start");
    return {
      loaded: false,
      scanSnapshots: 0, shortSlotsPlanted: 0, longSlotsPlanted: 0,
      oldestSnapshotAgeMs: null, newestSnapshotAgeMs: null,
      symbolsCovered: 0, durationMs: Date.now() - startedAt,
    };
  }

  // scan.ts writes newest-first. For chronological replay we reverse to oldest-first.
  const chronological = [...snapshots].reverse();

  // To fill the buffers efficiently, we keep ONLY the recent-enough snapshots:
  //   • short buffer holds 720 slots × 5s = 1h → keep last 60 scan snapshots × 12 slots = 720
  //   • long buffer holds 480 slots × 30s = 4h → keep last 240 scan snapshots × 2 slots = 480
  // We use the larger window (240) since long buffer needs the most history.
  const SCANS_FOR_FULL_LONG = LONG_BUFFER_SIZE / LONG_SLOTS_PER_SCAN;  // 240
  const usedSnapshots = chronological.slice(-SCANS_FOR_FULL_LONG);

  const symbolsSeen = new Set<string>();
  let shortSlotsPlanted = 0;
  let longSlotsPlanted = 0;

  for (let i = 0; i < usedSnapshots.length; i++) {
    const snap = usedSnapshots[i];
    if (!snap.prices || typeof snap.timestamp !== "number") continue;

    // Update each tracked asset's currentPrice for this snapshot
    for (const [symbol, price] of Object.entries(snap.prices)) {
      if (!tradableSymbols.has(symbol)) continue;
      if (typeof price !== "number" || !(price > 0)) continue;
      // volume24h not available in scan snapshots — pass 0 (real WS tick will overwrite)
      ringBuffers.updateTick(symbol, price, 0, snap.timestamp);
      symbolsSeen.add(symbol);
    }

    // Plant short slots (only for the most recent SHORT_BUFFER_SIZE/SHORT_SLOTS_PER_SCAN
    // snapshots — older ones would just get evicted by the ring buffer wrap-around)
    const SCANS_FOR_FULL_SHORT = SHORT_BUFFER_SIZE / SHORT_SLOTS_PER_SCAN;  // 60
    const shouldPlantShort = i >= usedSnapshots.length - SCANS_FOR_FULL_SHORT;
    if (shouldPlantShort) {
      for (let s = 0; s < SHORT_SLOTS_PER_SCAN; s++) {
        ringBuffers.takeShortSnapshotForPreload();
        shortSlotsPlanted++;
      }
    }

    // Plant long slots (every snapshot contributes 2 slots — long buffer is bigger)
    for (let l = 0; l < LONG_SLOTS_PER_SCAN; l++) {
      ringBuffers.takeLongSnapshotForPreload();
      longSlotsPlanted++;
    }
  }

  const newest = snapshots[0]?.timestamp ?? 0;
  const oldest = snapshots[snapshots.length - 1]?.timestamp ?? 0;
  const now = Date.now();

  const result: PreloadResult = {
    loaded: true,
    scanSnapshots: usedSnapshots.length,
    shortSlotsPlanted,
    longSlotsPlanted,
    oldestSnapshotAgeMs: oldest > 0 ? now - oldest : null,
    newestSnapshotAgeMs: newest > 0 ? now - newest : null,
    symbolsCovered: symbolsSeen.size,
    durationMs: Date.now() - startedAt,
  };

  logger.info("Preload complete", { ...result });
  return result;
}