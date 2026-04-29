// ─────────────────────────────────────────────────────────────────────────────
// detector.ts — Event-driven signal detection on every tick
// ─────────────────────────────────────────────────────────────────────────────
// Called on every tick (~290/sec aggregated). Most ticks don't pump enough to
// warrant the full classify path, so we apply cheap "gates" first and only
// invoke classifySignal() on the rare ticks that actually cross a threshold.
//
// Gate logic (cheap, runs on every tick):
//   1. Asset must be in the tradable -USDC universe (built at startup)
//   2. Asset must NOT be a stable
//   3. At least one of {change5m, change15m, change1h} must be ≥ its WEAK
//      threshold — anything below that won't classify anyway
//
// If gate passes → invoke classifySignal() → either get a candidate (logged
// as detected) or get a skip reason (logged as filtered for diagnostic).
//
// Logging strategy:
//   • All candidates → worker:detected_signals_log (Redis list, capped at 1000)
//   • All filtered signals → worker:filtered_signals_log (capped at 1000)
//   • Console logs only at DEBUG level
//
// At étape 2A we LOG ONLY. No dispatch, no Redis write to scan:dispatched_assets.
// Étape 2B will add the dispatch path.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";
import {
  classifySignal,
  STABLES,
  MAJORS,
  type ClassifyInput,
  type MomentumCandidate,
  type SkipReason,
  ALT_PUMP_PCT_5M_STRONG,
  ALT_PUMP_PCT_15M_STRONG,
  ALT_PUMP_PCT_1H_WEAK,
  MAJOR_CRASH_PCT_1H,
  POS_CRASH_PCT_1H,
  MAJOR_PUMP_PCT_1H,
} from "./lib/signal-rules.js";

// Logs kept in Redis — bounded to prevent unbounded growth.
// Use dryrun:* prefix so the assertDryrunKey guard in redis.ts allows the writes.
const DETECTED_LOG_KEY = "dryrun:detected_signals_log";
const FILTERED_LOG_KEY = "dryrun:filtered_signals_log";
const MAX_LOG_ENTRIES = 1000;

// In-memory log buffers (flushed to Redis on a timer for efficiency).
// Without batching, a fast pump triggering 50 detections in 5 seconds would
// generate 50 Redis writes, hurting throughput.
const FLUSH_INTERVAL_MS = 5_000;

interface DetectedEntry {
  ts: number;
  symbol: string;
  signalType: string;
  severity: string;
  triggerSource: string | null;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change4h: number | null;
  volume24h: number;
  drawdownFromPeak: number;
  isHeld: boolean;
}

interface FilteredEntry {
  ts: number;
  symbol: string;
  reason: SkipReason;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
}

export class Detector {
  private ringBuffers: RingBuffers;
  private tradableSymbols: Set<string>;
  private heldSymbolsProvider: () => Set<string>;
  private flushTimer: NodeJS.Timeout | null = null;

  // Pending log entries (flushed every FLUSH_INTERVAL_MS)
  private pendingDetected: DetectedEntry[] = [];
  private pendingFiltered: FilteredEntry[] = [];

  // Counters surfaced via stats()
  private ticksEvaluated = 0;
  private gatePassed = 0;
  private candidatesDetected = 0;
  private signalsFiltered = 0;
  private bySignalType = { alt_pump: 0, major_crash: 0, position_crash: 0, major_pump: 0 };
  private byTriggerSource = { "5m": 0, "15m": 0, "1h": 0, none: 0 };

  constructor(
    ringBuffers: RingBuffers,
    tradableSymbols: Set<string>,
    heldSymbolsProvider: () => Set<string>
  ) {
    this.ringBuffers = ringBuffers;
    this.tradableSymbols = tradableSymbols;
    this.heldSymbolsProvider = heldSymbolsProvider;
  }

  /**
   * Update the tradable universe (called when products refresh).
   */
  setTradableSymbols(symbols: Set<string>): void {
    this.tradableSymbols = symbols;
  }

  /**
   * Called on every tick by index.ts. Updates the ring buffer happens BEFORE
   * this is invoked; here we evaluate whether the new tick should trigger a
   * detection.
   */
  evaluateTick(symbol: string, _price: number, _volume24h: number): void {
    this.ticksEvaluated++;

    // Gate 1: only assets in our tradable -USDC universe
    if (!this.tradableSymbols.has(symbol)) return;

    // Gate 2: skip stables (cheap pre-filter, also caught by classifySignal)
    if (STABLES.has(symbol)) return;

    // Get the snapshot — needed for both gates and classify
    const snap = this.ringBuffers.getSnapshot(symbol);
    if (!snap) return;

    // Gate 3: cheap threshold pre-check. Only classify if at least one of
    // the change metrics is past its weakest threshold. This avoids running
    // the full classifier on the 95% of ticks that are routine drift.
    const isMajor = MAJORS.has(symbol);
    const isHeld = this.heldSymbolsProvider().has(symbol);
    const passesGate =
      // Pump triggers (alt_pump path)
      (snap.change5m !== null && snap.change5m >= ALT_PUMP_PCT_5M_STRONG)
      || (snap.change15m !== null && snap.change15m >= ALT_PUMP_PCT_15M_STRONG)
      || (snap.change1h !== null && snap.change1h >= ALT_PUMP_PCT_1H_WEAK)
      // Crash triggers (defensive paths)
      || (isMajor && snap.change1h !== null && snap.change1h <= MAJOR_CRASH_PCT_1H)
      || (isHeld && !isMajor && snap.change1h !== null && snap.change1h <= POS_CRASH_PCT_1H)
      // BTC pump trigger
      || (symbol === "BTC" && snap.change1h !== null && snap.change1h >= MAJOR_PUMP_PCT_1H);

    if (!passesGate) return;
    this.gatePassed++;

    // Get 24h change from volume payload — Coinbase ticker doesn't include it directly,
    // but for now we use 0 as a placeholder. Étape 2B will plug in price_percent_chg_24h
    // from the tick payload (already in the WS message).
    const change24h = 0;

    const input: ClassifyInput = {
      symbol,
      currentPrice: snap.currentPrice,
      change5m: snap.change5m,
      change15m: snap.change15m,
      change1h: snap.change1h,
      change4h: snap.change4h,
      change24h,
      volume24h: snap.volume24h,
      isHeld,
      isMajor,
      drawdownFromPeak: snap.drawdownFromPeak,
      peakSampleCount: snap.peakSampleCount,
    };

    const result = classifySignal(input);
    const now = Date.now();

    if (result.kind === "candidate") {
      this.candidatesDetected++;
      // Cast keys explicitly — TS strict mode rejects dynamic indexing on a
      // narrowly-typed counter object even though the values come from the
      // signal-rules union types and are guaranteed safe.
      const sigType = result.candidate.signalType as keyof typeof this.bySignalType;
      this.bySignalType[sigType]++;
      const ts = (result.candidate.triggerSource ?? "none") as keyof typeof this.byTriggerSource;
      this.byTriggerSource[ts]++;
      this.recordDetected(now, result.candidate);
      logger.info("⚡ SIGNAL DETECTED", {
        symbol,
        type: result.candidate.signalType,
        severity: result.candidate.severity,
        via: result.candidate.triggerSource,
        change5m: snap.change5m?.toFixed(1),
        change15m: snap.change15m?.toFixed(1),
        change1h: snap.change1h?.toFixed(1),
        change4h: snap.change4h?.toFixed(1),
        vol24h: Math.round(snap.volume24h / 1000) + "k",
        drawdown: snap.drawdownFromPeak.toFixed(1),
        held: isHeld,
      });
    } else if (result.reason !== "no_signal") {
      this.signalsFiltered++;
      this.recordFiltered(now, symbol, result.reason, snap);
      // Don't log every filter — too noisy at info level. Log at debug only.
      logger.debug("Signal filtered", {
        symbol, reason: result.reason,
        change5m: snap.change5m?.toFixed(1),
        change15m: snap.change15m?.toFixed(1),
      });
    }
  }

  start(): void {
    this.flushTimer = setInterval(() => { void this.flushLogs(); }, FLUSH_INTERVAL_MS);
    logger.info("Detector started", {
      tradableSymbols: this.tradableSymbols.size,
      flushIntervalMs: FLUSH_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    void this.flushLogs();
  }

  stats(): {
    tradableUniverse: number;
    ticksEvaluated: number;
    gatePassed: number;
    candidatesDetected: number;
    signalsFiltered: number;
    bySignalType: { alt_pump: number; major_crash: number; position_crash: number; major_pump: number };
    byTriggerSource: { "5m": number; "15m": number; "1h": number; none: number };
    pendingDetected: number;
    pendingFiltered: number;
  } {
    return {
      tradableUniverse: this.tradableSymbols.size,
      ticksEvaluated: this.ticksEvaluated,
      gatePassed: this.gatePassed,
      candidatesDetected: this.candidatesDetected,
      signalsFiltered: this.signalsFiltered,
      bySignalType: this.bySignalType,
      byTriggerSource: this.byTriggerSource,
      pendingDetected: this.pendingDetected.length,
      pendingFiltered: this.pendingFiltered.length,
    };
  }

  private recordDetected(ts: number, c: MomentumCandidate): void {
    this.pendingDetected.push({
      ts,
      symbol: c.symbol,
      signalType: c.signalType,
      severity: c.severity,
      triggerSource: c.triggerSource,
      change5m: c.change5m,
      change15m: c.change15m,
      change1h: c.change1h,
      change4h: c.change4h,
      volume24h: c.volume24h,
      drawdownFromPeak: c.drawdownFromPeak,
      isHeld: c.isHeld,
    });
  }

  private recordFiltered(
    ts: number, symbol: string, reason: SkipReason,
    snap: { change5m: number | null; change15m: number | null; change1h: number | null }
  ): void {
    this.pendingFiltered.push({
      ts, symbol, reason,
      change5m: snap.change5m, change15m: snap.change15m, change1h: snap.change1h,
    });
  }

  /**
   * Flush pending log entries to Redis, prepending to the existing list and
   * truncating at MAX_LOG_ENTRIES. Done periodically rather than per-event
   * to amortize Redis cost on bursty pump waves.
   */
  private async flushLogs(): Promise<void> {
    const detectedToFlush = this.pendingDetected.splice(0);
    const filteredToFlush = this.pendingFiltered.splice(0);

    if (detectedToFlush.length > 0) {
      try {
        const existing: DetectedEntry[] = (await redisGet<DetectedEntry[]>(DETECTED_LOG_KEY)) ?? [];
        const merged = [...detectedToFlush, ...existing].slice(0, MAX_LOG_ENTRIES);
        await redisSet(DETECTED_LOG_KEY, merged);
      } catch (err) {
        logger.warn("Failed to flush detected log", { err: (err as Error).message });
        // Re-queue so we don't lose them on transient failure
        this.pendingDetected.unshift(...detectedToFlush);
      }
    }

    if (filteredToFlush.length > 0) {
      try {
        const existing: FilteredEntry[] = (await redisGet<FilteredEntry[]>(FILTERED_LOG_KEY)) ?? [];
        const merged = [...filteredToFlush, ...existing].slice(0, MAX_LOG_ENTRIES);
        await redisSet(FILTERED_LOG_KEY, merged);
      } catch (err) {
        logger.warn("Failed to flush filtered log", { err: (err as Error).message });
        this.pendingFiltered.unshift(...filteredToFlush);
      }
    }
  }
}