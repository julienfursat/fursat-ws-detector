// ─────────────────────────────────────────────────────────────────────────────
// preload.ts — Warm-start the ring buffers from scan:price_snapshots
// ─────────────────────────────────────────────────────────────────────────────
// At cold start, the worker would normally need 1h of WS history before change1h
// becomes available, and 4h before change4h works. During that warmup, the
// detector misses real signals (we observed this in étape 2A — all signals
// filtered as amplitude_low_*_no1h for the first hour).
//
// This module solves the cold-start problem by reading scan:price_snapshots
// (written by scan.ts every minute on fursat.net) and replaying it into the
// ring buffers. After preload, the worker has up to 4h40 of immediately-usable
// history and is fully operational from the first tick.
//
// scan:price_snapshots format (defined in fursat.net/scan.ts):
//   [
//     { timestamp: 1777456262707, prices: { BTC: 77664.46, ETH: 2343.19, ... } },
//     ...   // up to 280 snapshots, NEWEST FIRST, written ~every minute
//   ]
//
// Replay strategy:
//   • Sort snapshots OLDEST FIRST (preload.replay walks chronologically)
//   • For each snapshot: simulate updateTick() then trigger one short-buffer
//     snapshot (5s slot) and, every 6 snapshots, one long-buffer snapshot (30s)
//   • The mapping isn't perfect (scan.ts writes every 60s, our short buffer is
//     5s granular), so we just plant a single snapshot per scan:price_snapshots
//     entry. After preload: short buffer covers ~280 × 5s = 23min effectively
//     CONTIGUOUS, long buffer covers ~46 × 30s = 23min — that's enough to
//     unblock change5m, change15m, change1h immediately, and change4h after
//     ~3h40 of additional WS data
//
// Important: this only fills slots; we do NOT trigger detector evaluation
// during replay. Detection only starts on real WS ticks.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";

const PRICE_SNAPSHOTS_KEY = "scan:price_snapshots";

interface PriceSnapshot {
  timestamp: number;
  prices: Record<string, number>;
}

export interface PreloadResult {
  loaded: boolean;
  snapshotCount: number;
  oldestSnapshotAgeMs: number | null;
  newestSnapshotAgeMs: number | null;
  symbolsCovered: number;
  durationMs: number;
}

/**
 * Read scan:price_snapshots and replay it into the ring buffers.
 * Returns stats about what was loaded for diagnostic purposes.
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
      snapshotCount: 0,
      oldestSnapshotAgeMs: null,
      newestSnapshotAgeMs: null,
      symbolsCovered: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  // scan.ts writes newest-first ([newSnapshot, ...snapshots]).
  // For chronological replay we reverse to oldest-first.
  const chronological = [...snapshots].reverse();

  const symbolsSeen = new Set<string>();
  let replayedCount = 0;

  for (const snap of chronological) {
    if (!snap.prices || typeof snap.timestamp !== "number") continue;
    for (const [symbol, price] of Object.entries(snap.prices)) {
      // Restrict to our tradable universe to avoid filling buffers with
      // assets we don't track via WS.
      if (!tradableSymbols.has(symbol)) continue;
      if (typeof price !== "number" || !(price > 0)) continue;
      // We don't have volume24h in scan:price_snapshots — pass 0.
      // First real WS tick will overwrite currentVolume24h with the real value.
      ringBuffers.updateTick(symbol, price, 0, snap.timestamp);
      symbolsSeen.add(symbol);
    }
    // Force a snapshot tick — we use the public API ringBuffers.takeSnapshot()
    // (added to ring-buffers.ts) to plant one slot per scan:price_snapshots entry.
    ringBuffers.takeSnapshotForPreload();
    replayedCount++;
  }

  const newest = snapshots[0]?.timestamp ?? 0;
  const oldest = snapshots[snapshots.length - 1]?.timestamp ?? 0;
  const now = Date.now();

  const result: PreloadResult = {
    loaded: true,
    snapshotCount: replayedCount,
    oldestSnapshotAgeMs: oldest > 0 ? now - oldest : null,
    newestSnapshotAgeMs: newest > 0 ? now - newest : null,
    symbolsCovered: symbolsSeen.size,
    durationMs: Date.now() - startedAt,
  };

  logger.info("Preload complete", { ...result });
  return result;
}
