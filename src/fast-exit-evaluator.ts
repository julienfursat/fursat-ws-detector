// ─────────────────────────────────────────────────────────────────────────────
// fast-exit-evaluator.ts — Real-time fast-exit on every tick of held assets
// ─────────────────────────────────────────────────────────────────────────────
// Called on every tick (~290/sec aggregated). For each tick, if the symbol is
// a held position, we update pnlMax/pnlMin and evaluate the fast-exit rules.
// If a rule fires, we dispatch to fursat.net /api/agent/fast-exit.
//
// In-flight guard prevents re-firing on the same symbol while a dispatch is
// in progress (the cooldown via Redis is the durable guarantee, but the
// in-flight Set saves us Redis round-trips on fast pumps/dumps).
//
// Cooldown filtering happens AFTER pnlMax/pnlMin update — we always want to
// keep the tracker fresh, even when not dispatching.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";
import { PositionsTracker, type AgentPosition } from "./positions.js";
import { PnlTracker } from "./pnl-tracker.js";
import {
  evaluateFastExitRules,
  type AgentPosition as RuleAgentPosition,
  type FastExitContext,
} from "./lib/signal-rules.js";
import {
  dispatchFastExit,
  isInFastExitCooldown,
  type FastExitDispatchPayload,
} from "./fast-exit-dispatcher.js";

const PARTIAL_TAKEN_KEY = "agent:partial_taken";
const PARTIAL_TAKEN_CACHE_TTL_MS = 60_000;  // refresh at most once per minute

// BACKLOG-3 phase 2 (2026-05-01) — narrow alias of the 6 reason codes that
// evaluateFastExitRules can actually produce. The shared FastExitReason type was
// extended with fast_slow_down/fast_tp/fast_sl for the worker's sub-1min exits
// (handled in detector.tryDispatchSlowDown), but this evaluator only handles
// the classical 6 rules. Keeping a narrow local type avoids dead branches in the
// counter map and the dispatch payload typing.
type ClassicFastExitReason =
  | "fast_stop_loss"
  | "fast_partial_take"
  | "fast_no_pump_exit"
  | "fast_ratchet"
  | "fast_exit_on_green"
  | "dead_position_exit";

export class FastExitEvaluator {
  private ringBuffers: RingBuffers;
  private positions: PositionsTracker;
  private pnlTracker: PnlTracker;

  // Cache for partial_taken map
  private partialTakenCache: Record<string, number> = {};
  private partialTakenLoadedAt = 0;

  // In-flight guard: prevents re-firing the same symbol while a dispatch is pending
  private inFlight: Set<string> = new Set();

  // Stats
  private ticksEvaluated = 0;
  private rulesFired = 0;
  private dispatchOk = 0;
  private dispatchSkippedCooldown = 0;
  private dispatchHttpError = 0;
  private dispatchNetworkError = 0;
  private byReasonCode = {
    fast_stop_loss: 0,
    fast_partial_take: 0,
    fast_no_pump_exit: 0,
    fast_ratchet: 0,
    fast_exit_on_green: 0,
    dead_position_exit: 0,
  };

  constructor(ringBuffers: RingBuffers, positions: PositionsTracker, pnlTracker: PnlTracker) {
    this.ringBuffers = ringBuffers;
    this.positions = positions;
    this.pnlTracker = pnlTracker;
  }

  /**
   * Called on every tick (after the detector has had its turn).
   * If the symbol is a held position, update pnlMax/pnlMin and evaluate rules.
   */
  evaluateTick(symbol: string, currentPrice: number): void {
    const pos = this.positions.updatePriceForSymbol(symbol, currentPrice);
    if (!pos) return;  // not held
    this.ticksEvaluated++;

    // Always update tracker (keeps pnlMax/pnlMin fresh even if no dispatch)
    const tracked = this.pnlTracker.update(symbol, pos.pnlPct);

    // In-flight check (cheap)
    if (this.inFlight.has(symbol)) return;

    // Build the rule context
    const snap = this.ringBuffers.getSnapshot(symbol);
    if (!snap) return;  // no buffer data yet (shouldn't happen post-preload)

    const partialTaken = this.partialTakenCache[symbol] !== undefined;

    const rulePosition: RuleAgentPosition = {
      symbol: pos.symbol,
      units: pos.units,
      currentPrice: pos.currentPrice,
      avgBuyPrice: pos.avgBuyPrice,
      buyTimestamp: pos.buyTimestamp,
      pnlPct: pos.pnlPct,
      valueUSD: pos.valueUSD,
      source: "trade_meta",  // worker only surveils positions present in trade_meta
    };
    const ctx: FastExitContext = {
      pnlMax: tracked.pnlMax,
      pnlMin: tracked.pnlMin,
      change1h: snap.change1h,
      change15m: snap.change15m,
      change30min: snap.change30min,
      partialTaken,
      now: Date.now(),
    };

    const verdict = evaluateFastExitRules(rulePosition, ctx);
    if (!verdict) return;

    // A rule fired. Trigger dispatch (async, fire-and-forget).
    // Narrow assert: evaluateFastExitRules only returns ClassicFastExitReason values.
    // The shared FastExitReason union includes fast_slow_down/fast_tp/fast_sl since
    // BACKLOG-3 phase 2, but those are produced by detector.tryDispatchSlowDown,
    // not by evaluateFastExitRules. Cast is safe.
    this.rulesFired++;
    const reasonCode = verdict.reasonCode as ClassicFastExitReason;
    this.byReasonCode[reasonCode]++;
    void this.tryDispatch(pos, verdict, tracked);
  }

  /**
   * Refresh the partial_taken cache from Redis periodically.
   * Lazy-loaded on demand (when the cache is older than TTL).
   */
  private async refreshPartialTakenIfStale(): Promise<void> {
    const now = Date.now();
    if (now - this.partialTakenLoadedAt < PARTIAL_TAKEN_CACHE_TTL_MS) return;
    try {
      const data = (await redisGet<Record<string, number>>(PARTIAL_TAKEN_KEY)) ?? {};
      this.partialTakenCache = data;
      this.partialTakenLoadedAt = now;
    } catch (err) {
      logger.warn("partial_taken refresh failed", { err: (err as Error).message });
    }
  }

  /**
   * Dispatch a fast-exit verdict. Pre-checks cooldown, then POSTs.
   * Fire-and-forget (caller doesn't await).
   */
  private async tryDispatch(
    pos: AgentPosition,
    verdict: ReturnType<typeof evaluateFastExitRules>,
    tracked: { pnlMax: number; pnlMin: number }
  ): Promise<void> {
    if (!verdict) return;
    const symbol = pos.symbol;
    this.inFlight.add(symbol);

    try {
      // Refresh partial_taken cache if stale (might have changed since last fire)
      await this.refreshPartialTakenIfStale();

      // Re-check cooldown (might have been set by scan.ts in between)
      const cooldownActive = await isInFastExitCooldown(symbol);
      if (cooldownActive) {
        this.dispatchSkippedCooldown++;
        logger.info("Fast-exit SKIPPED — cooldown active (post-evaluation)", {
          symbol, reasonCode: verdict.reasonCode,
        });
        return;
      }

      const payload: FastExitDispatchPayload = {
        symbol: pos.symbol,
        reasonCode: verdict.reasonCode as ClassicFastExitReason,  // safe: see narrow note above
        pnlPct: pos.pnlPct,
        pnlMax: tracked.pnlMax,
        pnlMin: tracked.pnlMin,
        avgBuyPrice: pos.avgBuyPrice,
        currentPrice: pos.currentPrice,
        change1h: verdict.change1h,
        change15m: verdict.change15m,
        change30min: verdict.change30min,
        holdingSince: pos.buyTimestamp,
        sellRatio: verdict.sellRatio,
      };

      logger.info("⚡ FAST-EXIT TRIGGERED", {
        symbol, reasonCode: verdict.reasonCode,
        pnlPct: pos.pnlPct.toFixed(1),
        pnlMax: tracked.pnlMax.toFixed(1),
        pnlMin: tracked.pnlMin.toFixed(1),
        change1h: verdict.change1h?.toFixed(1) ?? "n/a",
        change30min: verdict.change30min?.toFixed(1) ?? "n/a",
      });

      const result = await dispatchFastExit(payload);
      if (result.ok) this.dispatchOk++;
      else if (result.cooldownSkipped) this.dispatchSkippedCooldown++;
      else if (result.error) this.dispatchNetworkError++;
      else this.dispatchHttpError++;

      // After successful full-exit (not partial), drop the symbol from pnl tracker
      // (position is being closed — next BUY will start fresh tracking).
      if (result.ok && verdict.reasonCode !== "fast_partial_take") {
        this.pnlTracker.drop(symbol);
      }
    } catch (err) {
      logger.error("tryDispatch fast-exit threw", { symbol, err: (err as Error).message });
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  stats() {
    return {
      ticksEvaluated: this.ticksEvaluated,
      rulesFired: this.rulesFired,
      byReasonCode: this.byReasonCode,
      dispatch: {
        ok: this.dispatchOk,
        skippedCooldown: this.dispatchSkippedCooldown,
        httpError: this.dispatchHttpError,
        networkError: this.dispatchNetworkError,
      },
      inFlight: this.inFlight.size,
    };
  }
}