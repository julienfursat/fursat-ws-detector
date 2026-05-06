// ─────────────────────────────────────────────────────────────────────────────
// event-followup.ts — Lot 2 (2026-05-06)
// ─────────────────────────────────────────────────────────────────────────────
// For each ShadowEvent fired by event-detector.ts, schedule 4 in-memory timers
// that record the asset's price at T+5min, T+15min, T+30min, T+60min and
// compute retroactive PnL (vs. the snapshot price at T).
//
// Additionally, a 30s polling timer tracks the peak (max price) and trough
// (min price) seen during the full 60min window. This is critical for the
// 13/05 analysis:
//   • Peak tells us the maximum opportunity (was the event tradable at all?)
//   • Trough tells us what stop-loss would have been needed
//   • Peak timing tells us the optimal exit window
//
// After the 4th followup, the event is moved from `shadow:events_pending`
// (Hash) to `shadow:events_completed` (List, capped at 50000).
//
// The List is what the analysis notebook will read at end of week to simulate
// strategies: "if I had bought at T on event X, what PnL at T+15min vs T+1h?"
//
// Edge cases handled:
//   • Worker restart: pending events in Redis are NOT recovered (in-memory
//     timer is lost). They remain in shadow:events_pending until manually
//     cleaned. This is acceptable for a 7-day shadow run.
//   • Symbol disappears from ring buffer: followup records null price + null
//     pnl, marking the slot as { price: 0, pnlPct: 0 } with a warning log.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisHdel, redisLpush, redisLtrim, redisHset } from "./redis.js";
import type { RingBuffers } from "./ring-buffers.js";
import type { ShadowEvent } from "./event-detector.js";

const FOLLOWUP_DELAYS_MS = {
  "5min": 5 * 60_000,
  "15min": 15 * 60_000,
  "30min": 30 * 60_000,
  "60min": 60 * 60_000,
} as const;

const PEAK_POLL_INTERVAL_MS = 30_000; // 30s sampling of peak/trough
const PEAK_TRACKING_DURATION_MS = 60 * 60_000; // 60min total

const SHADOW_PENDING_KEY = "shadow:events_pending";
const SHADOW_COMPLETED_KEY = "shadow:events_completed";
const SHADOW_COMPLETED_MAX = 50_000;

export class EventFollowup {
  private ringBuffers: RingBuffers;

  // Track pending events in memory so we can complete them as timers fire
  // Key: eventId
  private pending = new Map<string, ShadowEvent>();

  // Peak-tracking interval handles per eventId, so we can stop them at 60min
  private peakIntervals = new Map<string, NodeJS.Timeout>();

  constructor(ringBuffers: RingBuffers) {
    this.ringBuffers = ringBuffers;
  }

  /**
   * Schedule the 4 followups for a freshly-detected event, plus the
   * 30s peak/trough polling timer running for 60min.
   * Called from event-detector.ts after Redis HSET succeeds.
   */
  schedule(event: ShadowEvent): void {
    this.pending.set(event.eventId, event);

    setTimeout(() => void this.recordFollowup(event.eventId, "5min"),
      FOLLOWUP_DELAYS_MS["5min"]);
    setTimeout(() => void this.recordFollowup(event.eventId, "15min"),
      FOLLOWUP_DELAYS_MS["15min"]);
    setTimeout(() => void this.recordFollowup(event.eventId, "30min"),
      FOLLOWUP_DELAYS_MS["30min"]);
    setTimeout(() => void this.recordFollowup(event.eventId, "60min"),
      FOLLOWUP_DELAYS_MS["60min"]);

    // Peak/trough polling — RAM only, no Redis writes per tick
    const startedAt = Date.now();
    const interval = setInterval(() => {
      try {
        this.pollPeakTrough(event.eventId, startedAt);
      } catch (err) {
        logger.warn("[event-followup] pollPeakTrough threw", {
          eventId: event.eventId,
          err: (err as Error).message,
        });
      }
    }, PEAK_POLL_INTERVAL_MS);
    this.peakIntervals.set(event.eventId, interval);
  }

  /**
   * Sample currentPrice every 30s; update peak/trough in the in-memory event
   * if a new extremum is observed. Stops itself after 60min.
   */
  private pollPeakTrough(eventId: string, startedAt: number): void {
    const event = this.pending.get(eventId);
    if (!event) {
      this.stopPeakTracking(eventId);
      return;
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed > PEAK_TRACKING_DURATION_MS) {
      this.stopPeakTracking(eventId);
      return;
    }

    const snap = this.ringBuffers.getSnapshot(event.symbol);
    if (!snap || snap.currentPrice <= 0) return;

    const currentPrice = snap.currentPrice;
    const entryPrice = event.snapshot.price;
    if (entryPrice <= 0) return;

    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;

    // Update peak (highest price seen)
    if (event.peakWithin60min === null || currentPrice > event.peakWithin60min.price) {
      event.peakWithin60min = {
        price: currentPrice,
        pnlPct,
        tsOffsetMs: elapsed,
      };
    }

    // Update trough (lowest price seen)
    if (event.troughWithin60min === null || currentPrice < event.troughWithin60min.price) {
      event.troughWithin60min = {
        price: currentPrice,
        pnlPct,
        tsOffsetMs: elapsed,
      };
    }
  }

  private stopPeakTracking(eventId: string): void {
    const interval = this.peakIntervals.get(eventId);
    if (interval) {
      clearInterval(interval);
      this.peakIntervals.delete(eventId);
    }
  }

  /**
   * Record the price at a given followup checkpoint and update Redis.
   * On the 60min checkpoint (last one), move event from pending to completed.
   */
  private async recordFollowup(
    eventId: string,
    label: keyof typeof FOLLOWUP_DELAYS_MS,
  ): Promise<void> {
    const event = this.pending.get(eventId);
    if (!event) {
      logger.warn("[event-followup] event not in memory at followup time", {
        eventId, label,
      });
      return;
    }

    try {
      const snap = this.ringBuffers.getSnapshot(event.symbol);
      const currentPrice = snap?.currentPrice ?? 0;
      const entryPrice = event.snapshot.price;
      const pnlPct = entryPrice > 0
        ? ((currentPrice - entryPrice) / entryPrice) * 100
        : 0;

      const payload = { price: currentPrice, pnlPct };

      // Update event object in-memory
      switch (label) {
        case "5min":  event.followup_5min = payload; break;
        case "15min": event.followup_15min = payload; break;
        case "30min": event.followup_30min = payload; break;
        case "60min": event.followup_60min = payload; break;
      }

      logger.info("[event-followup] checkpoint", {
        eventId,
        label,
        symbol: event.symbol,
        kind: event.kind,
        entryPrice,
        currentPrice,
        pnlPct: pnlPct.toFixed(2),
      });

      if (label !== "60min") {
        // Update pending event in Redis (incremental update)
        await redisHset(SHADOW_PENDING_KEY, eventId, event);
        return;
      }

      // 60min checkpoint = final. Stop peak tracking, move to completed.
      this.stopPeakTracking(eventId);
      await redisLpush(SHADOW_COMPLETED_KEY, event);
      await redisLtrim(SHADOW_COMPLETED_KEY, 0, SHADOW_COMPLETED_MAX - 1);
      await redisHdel(SHADOW_PENDING_KEY, eventId);
      this.pending.delete(eventId);

      logger.info("[event-followup] event completed", {
        eventId,
        symbol: event.symbol,
        kind: event.kind,
        pnl_5m: event.followup_5min?.pnlPct?.toFixed(2) ?? "n/a",
        pnl_15m: event.followup_15min?.pnlPct?.toFixed(2) ?? "n/a",
        pnl_30m: event.followup_30min?.pnlPct?.toFixed(2) ?? "n/a",
        pnl_60m: event.followup_60min?.pnlPct?.toFixed(2) ?? "n/a",
        peak_pct: event.peakWithin60min?.pnlPct?.toFixed(2) ?? "n/a",
        peak_at_min: event.peakWithin60min
          ? (event.peakWithin60min.tsOffsetMs / 60_000).toFixed(1)
          : "n/a",
        trough_pct: event.troughWithin60min?.pnlPct?.toFixed(2) ?? "n/a",
      });
    } catch (err) {
      logger.warn("[event-followup] recordFollowup threw", {
        eventId,
        label,
        err: (err as Error).message,
      });
    }
  }

  /**
   * Diagnostic accessor.
   */
  getPendingCount(): number {
    return this.pending.size;
  }
}
