// ─────────────────────────────────────────────────────────────────────────────
// event-detector.ts — Lot 2 (2026-05-06)
// ─────────────────────────────────────────────────────────────────────────────
// Passive multi-strategy event detector. Runs alongside the existing detector
// (which is killswitched off via WORKER_*_BUY_ENABLED=false during the 7-day
// observation week). NEVER triggers BUY orders. Only writes to Redis under
// the shadow:* namespace for retroactive simulation.
//
// 6 event types evaluated per tick:
//   1. early_explosive    — sub-minute explosion (existing detector rule)
//   2. progressive_pump   — slow climb (EIGEN/BLEND/CHECK style — missed by current detector)
//   3. stair_step         — second pump after pullback (re-entry pattern)
//   4. crash_rebound      — bounce after big drop
//   5. new_listing_pump   — first 24h listing momentum (FUTURE: needs listing_date wiring)
//   6. volume_spike       — volume burst without price move (often precedes pump)
//
// Each event triggers an EventFollowup (T+5/15/30/60min PnL recording).
//
// Storage:
//   • shadow:events_pending   — Hash (eventId → JSON ShadowEvent)
//                                while followups are still being collected
//   • shadow:events_completed — List (LPUSH after 4th followup, LTRIM 50000)
//
// Estimated cost: ~17k Redis commands/week. See journal.txt for breakdown.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisHset } from "./redis.js";
import type { RingBuffers, PriceSnapshot } from "./ring-buffers.js";
import { EventFollowup } from "./event-followup.js";

// Event kinds & detection rules

export type EventKind =
  | "early_explosive"
  | "progressive_pump"
  | "stair_step"
  | "crash_rebound"
  | "new_listing_pump"
  | "volume_spike";

export interface ShadowEvent {
  eventId: string;
  kind: EventKind;
  symbol: string;
  ts: number;

  // Snapshot of the asset at detection time
  snapshot: {
    price: number;
    bestBid: number | null;
    change30s: number | null;
    change1m: number | null;
    change2m: number | null;
    change5m: number | null;
    change15m: number | null;
    change30min: number | null;
    change1h: number | null;
    change4h: number | null;
    volume24h: number;
    drawdownFromPeak: number;
    peakSampleCount: number;
  };

  // Market context (BTC + ETH at detection time)
  marketContext: {
    btcPrice: number | null;
    btcChange30s: number | null;
    btcChange1h: number | null;
    btcChange4h: number | null;
    ethPrice: number | null;
    ethChange30s: number | null;
    ethChange1h: number | null;
    ethChange4h: number | null;
  };

  // Followup PnL (filled by event-followup.ts as time passes)
  followup_5min: { price: number; pnlPct: number } | null;
  followup_15min: { price: number; pnlPct: number } | null;
  followup_30min: { price: number; pnlPct: number } | null;
  followup_60min: { price: number; pnlPct: number } | null;

  // Peak/trough tracking over the full 60min window. Filled by event-followup.ts
  // via a 30s polling timer. Critical for the 13/05 analysis: tells us
  //   • the maximum opportunity (peak) — was the event tradable?
  //   • the minimum drawdown (trough) — what stop-loss would have been needed?
  //   • when the peak occurred — calibrates optimal exit timing
  peakWithin60min: { price: number; pnlPct: number; tsOffsetMs: number } | null;
  troughWithin60min: { price: number; pnlPct: number; tsOffsetMs: number } | null;
}

// Per-symbol per-kind throttle to avoid spamming events
// e.g. a sustained pump that satisfies progressive_pump rule for 30min in a row
const THROTTLE_MS_PER_KIND: Record<EventKind, number> = {
  early_explosive: 5 * 60_000,    // 5 min
  progressive_pump: 15 * 60_000,  // 15 min
  stair_step: 10 * 60_000,        // 10 min
  crash_rebound: 30 * 60_000,     // 30 min
  new_listing_pump: 60 * 60_000,  // 1 h
  volume_spike: 10 * 60_000,      // 10 min
};

// For stair_step: remember when each symbol last hit c1h≥5%
// In-memory only (resets on worker restart, fine for shadow mode)
interface StairStepState {
  lastPeakAt: number;  // ms timestamp when c1h last ≥5%
  peakC1h: number;     // value of c1h at that moment
}

export class EventDetector {
  private ringBuffers: RingBuffers;
  private followup: EventFollowup;
  private btcSymbol = "BTC";
  private ethSymbol = "ETH";

  // Throttle: symbol|kind → last fired ts (ms)
  private throttleMap = new Map<string, number>();

  // Stair-step state: symbol → last peak observation
  private stairStepState = new Map<string, StairStepState>();

  // Counters for diagnostics
  private counters: Record<EventKind, number> = {
    early_explosive: 0,
    progressive_pump: 0,
    stair_step: 0,
    crash_rebound: 0,
    new_listing_pump: 0,
    volume_spike: 0,
  };

  constructor(ringBuffers: RingBuffers, followup: EventFollowup) {
    this.ringBuffers = ringBuffers;
    this.followup = followup;
  }

  /**
   * Public hook called from index.ts onTick handler.
   * Reads snapshot + BTC/ETH context internally; never throws.
   */
  evaluateTick(symbol: string): void {
    try {
      // Skip BTC and ETH themselves — we only care about altcoin events
      if (symbol === this.btcSymbol || symbol === this.ethSymbol) return;

      const snap = this.ringBuffers.getSnapshot(symbol);
      if (!snap) return;

      const btcSnap = this.ringBuffers.getSnapshot(this.btcSymbol);
      const ethSnap = this.ringBuffers.getSnapshot(this.ethSymbol);

      const now = Date.now();

      // Update stair-step memory regardless of whether we fire anything
      this.updateStairStepMemory(symbol, snap, now);

      // Evaluate each rule
      this.tryFire(symbol, "early_explosive", snap, btcSnap, ethSnap, now,
        () => this.matchEarlyExplosive(snap));

      this.tryFire(symbol, "progressive_pump", snap, btcSnap, ethSnap, now,
        () => this.matchProgressivePump(snap));

      this.tryFire(symbol, "stair_step", snap, btcSnap, ethSnap, now,
        () => this.matchStairStep(symbol, snap, now));

      this.tryFire(symbol, "crash_rebound", snap, btcSnap, ethSnap, now,
        () => this.matchCrashRebound(snap));

      this.tryFire(symbol, "volume_spike", snap, btcSnap, ethSnap, now,
        () => this.matchVolumeSpike(snap));

      // new_listing_pump skipped for Phase 1 — needs listing_date metadata
      // not currently tracked in ring buffers. Add in Phase 2 if useful.
    } catch (err) {
      logger.warn("[event-detector] evaluateTick threw", {
        symbol,
        err: (err as Error).message,
      });
    }
  }

  /**
   * Check throttle, evaluate matcher, and fire event if matched.
   */
  private tryFire(
    symbol: string,
    kind: EventKind,
    snap: PriceSnapshot,
    btcSnap: PriceSnapshot | null,
    ethSnap: PriceSnapshot | null,
    now: number,
    matcher: () => boolean,
  ): void {
    const throttleKey = `${symbol}|${kind}`;
    const lastFiredAt = this.throttleMap.get(throttleKey) ?? 0;
    if (now - lastFiredAt < THROTTLE_MS_PER_KIND[kind]) return;

    if (!matcher()) return;

    this.throttleMap.set(throttleKey, now);
    this.counters[kind]++;
    void this.fireEvent(kind, symbol, snap, btcSnap, ethSnap, now);
  }

  // ─── Detection rules ──────────────────────────────────────────────────────

  /** Sub-minute explosion. Mirrors current detector entry rule. */
  private matchEarlyExplosive(snap: PriceSnapshot): boolean {
    if (snap.change30s == null || snap.change1min == null) return false;
    if (snap.change2min == null || snap.change5m == null) return false;
    return (
      snap.change30s >= 1 &&
      snap.change1min >= 1 &&
      snap.change2min >= 2 &&
      snap.change5m < 4
    );
  }

  /**
   * Progressive pump: slow steady climb that the current sub-min detector misses.
   * Examples: EIGEN, BLEND, CHECK climbed for 60-90min without sub-min explosion.
   * Heuristic: c1h ≥3% AND still climbing on 5min (≥0.5%) AND 1h dominates 15m
   * (i.e. earlier part of the climb is the bigger contributor — meaning we're
   * not on a fresh acceleration but on a sustained slow build).
   */
  private matchProgressivePump(snap: PriceSnapshot): boolean {
    if (snap.change1h == null || snap.change15m == null || snap.change5m == null) return false;
    // Don't double-count early_explosive: skip if sub-min is already loud
    if (snap.change30s != null && snap.change30s >= 1.5) return false;
    return (
      snap.change1h >= 3 &&
      snap.change5m >= 0.5 &&
      snap.change1h >= snap.change15m * 2
    );
  }

  /**
   * Stair-step: re-pump after a pullback.
   * Trigger: previously hit c1h ≥5% within last 60min, then drawdown ≥2% from peak,
   * now seeing c5m ≥2% (re-acceleration).
   */
  private matchStairStep(symbol: string, snap: PriceSnapshot, now: number): boolean {
    const state = this.stairStepState.get(symbol);
    if (!state) return false;
    if (now - state.lastPeakAt > 60 * 60_000) return false;  // peak too old
    if (snap.change5m == null) return false;
    // Need to have pulled back a bit before re-pumping
    if (snap.drawdownFromPeak > -2) return false;
    return snap.change5m >= 2;
  }

  /**
   * Crash rebound: significant drop on 4h, but bouncing on 1h.
   * Note: change24h not in PriceSnapshot, using change4h as proxy.
   */
  private matchCrashRebound(snap: PriceSnapshot): boolean {
    if (snap.change4h == null || snap.change1h == null) return false;
    return snap.change4h <= -10 && snap.change1h >= 3;
  }

  /**
   * Volume spike: 24h volume is meaningful (sanity floor) AND price hasn't yet
   * moved much. This is a leading indicator — interest building before pump.
   * Without per-window volume tracking (which would require ring-buffer extension),
   * we approximate by: significant volume AND modest price movement.
   * Phase 2 should add proper vol5m/vol30m ratio tracking.
   */
  private matchVolumeSpike(snap: PriceSnapshot): boolean {
    if (snap.volume24h < 500_000) return false;           // ignore tiny coins
    if (snap.change5m == null || snap.change15m == null) return false;
    // Price hasn't already pumped
    if (snap.change15m > 3) return false;
    // But there's some 5m movement (early signal)
    return snap.change5m >= 1 && snap.change5m < 3;
  }

  // ─── Stair-step memory ────────────────────────────────────────────────────

  private updateStairStepMemory(symbol: string, snap: PriceSnapshot, now: number): void {
    if (snap.change1h == null) return;
    const existing = this.stairStepState.get(symbol);

    // Record/update peak only if c1h ≥5% AND it's higher than what we had
    if (snap.change1h >= 5) {
      if (!existing || snap.change1h > existing.peakC1h) {
        this.stairStepState.set(symbol, {
          lastPeakAt: now,
          peakC1h: snap.change1h,
        });
      }
    }

    // Garbage-collect old entries (>2h old)
    if (existing && now - existing.lastPeakAt > 2 * 60 * 60_000) {
      this.stairStepState.delete(symbol);
    }
  }

  // ─── Event firing ─────────────────────────────────────────────────────────

  private async fireEvent(
    kind: EventKind,
    symbol: string,
    snap: PriceSnapshot,
    btcSnap: PriceSnapshot | null,
    ethSnap: PriceSnapshot | null,
    ts: number,
  ): Promise<void> {
    const eventId = `${kind}_${symbol}_${ts}`;

    const event: ShadowEvent = {
      eventId,
      kind,
      symbol,
      ts,
      snapshot: {
        price: snap.currentPrice,
        bestBid: null, // not exposed in PriceSnapshot interface; followup uses currentPrice
        change30s: snap.change30s,
        change1m: snap.change1min,
        change2m: snap.change2min,
        change5m: snap.change5m,
        change15m: snap.change15m,
        change30min: snap.change30min,
        change1h: snap.change1h,
        change4h: snap.change4h,
        volume24h: snap.volume24h,
        drawdownFromPeak: snap.drawdownFromPeak,
        peakSampleCount: snap.peakSampleCount,
      },
      marketContext: {
        btcPrice: btcSnap?.currentPrice ?? null,
        btcChange30s: btcSnap?.change30s ?? null,
        btcChange1h: btcSnap?.change1h ?? null,
        btcChange4h: btcSnap?.change4h ?? null,
        ethPrice: ethSnap?.currentPrice ?? null,
        ethChange30s: ethSnap?.change30s ?? null,
        ethChange1h: ethSnap?.change1h ?? null,
        ethChange4h: ethSnap?.change4h ?? null,
      },
      followup_5min: null,
      followup_15min: null,
      followup_30min: null,
      followup_60min: null,
      peakWithin60min: null,
      troughWithin60min: null,
    };

    logger.info("[event-detector] event fired", {
      kind,
      symbol,
      price: snap.currentPrice,
      c1h: snap.change1h,
      c5m: snap.change5m,
      eventId,
    });

    // Persist to pending hash
    await redisHset("shadow:events_pending", eventId, event);

    // Schedule followups (in-memory timers)
    this.followup.schedule(event);
  }

  /**
   * Diagnostic accessor — useful for periodic logger.info from index.ts
   */
  getCounters(): Readonly<Record<EventKind, number>> {
    return this.counters;
  }
}
