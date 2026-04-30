// ─────────────────────────────────────────────────────────────────────────────
// detector.ts — Event-driven signal detection + dispatch (étape 2B)
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
// If gate passes → invoke classifySignal() → either get a candidate or a skip
// reason (logged in dryrun:filtered_signals_log).
//
// Étape 2B — DISPATCH PATH (alt_pump candidates only):
//   1. Pre-checks (asynchronous):
//      • throttle.checkThrottle(symbol)   — shared with scan.ts
//      • blacklist.isBlacklisted(symbol)  — read-only from agent:entry_blacklist
//   2. If both pass → dispatcher.dispatchEntry(signal)
//      Dispatch goes to fursat.net /api/agent/entry with same headers/body as scan.ts
//
// Other signal types (major_crash, position_crash, major_pump) are LOGGED ONLY
// in 2B — these need MANAGE involvement which we'll re-evaluate later (BACKLOG-2).
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";
import { checkThrottle } from "./throttle.js";
import { isBlacklisted } from "./blacklist.js";
import { dispatchEntry, type DispatchSignal } from "./dispatcher.js";
import {
  classifySignal,
  evaluateFastPathCandidate,
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
const FASTPATH_LOG_KEY = "dryrun:fastpath_log";  // BACKLOG-3 phase 1, log-only fast-path observation
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
  // Sub-minute observability windows (NEW 2026-04-30 — log-only, BACKLOG-3 phase A)
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
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

// BACKLOG-3 phase 1 (2026-04-30) — log-only fast-path candidate observation.
// One entry per detected signal (alongside DetectedEntry), recording what the
// hypothetical fast-path system WOULD have done. Used for empirical calibration
// of Y_STRONG, Y_MAJOR, X_MIN before activating real fast-path triggers.
interface FastPathEntry {
  ts: number;
  symbol: string;
  // Sub-minute windows (the variables we want to calibrate)
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
  // Surrounding context for cross-checking calibration
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change4h: number | null;
  volume24h: number;
  drawdownFromPeak: number;
  isHeld: boolean;
  // Classical signal that triggered this observation
  classicalSeverity: "weak" | "strong" | "major";
  classicalSignalType: string;
  classicalTriggerSource: string | null;
  // Fast-path verdict (log-only)
  wouldFireStrong: boolean;
  wouldFireMajor: boolean;
  wouldFilterDead: boolean;
  reasons: string[];
}

export class Detector {
  private ringBuffers: RingBuffers;
  private tradableSymbols: Set<string>;
  private heldSymbolsProvider: () => Set<string>;
  private flushTimer: NodeJS.Timeout | null = null;

  // Pending log entries (flushed every FLUSH_INTERVAL_MS)
  private pendingDetected: DetectedEntry[] = [];
  private pendingFiltered: FilteredEntry[] = [];
  private pendingFastPath: FastPathEntry[] = [];  // BACKLOG-3 phase 1

  // Counters surfaced via stats()
  private ticksEvaluated = 0;
  private gatePassed = 0;
  private candidatesDetected = 0;
  private signalsFiltered = 0;
  private bySignalType = { alt_pump: 0, major_crash: 0, position_crash: 0, major_pump: 0 };
  private byTriggerSource = { "5m": 0, "15m": 0, "1h": 0, none: 0 };
  private bySeverity = { weak: 0, strong: 0, major: 0 };

  // Étape 2B dispatch counters
  private dispatchAttempted = 0;
  private dispatchOk = 0;
  private dispatchSkipped = 0;
  private dispatchHttpError = 0;
  private dispatchNetworkError = 0;
  private dispatchPreCheckFailed = { throttle: 0, blacklist: 0 };

  // In-flight guard: prevents re-triggering dispatch on the same symbol while
  // a previous dispatch is still in progress. The throttle in Redis catches
  // the re-trigger eventually, but the in-flight guard saves Redis round-trips
  // when a fast pump generates 10+ ticks per second on the same asset.
  private inFlightDispatches = new Set<string>();

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
      change30s: snap.change30s,
      change1min: snap.change1min,
      change2min: snap.change2min,
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
      const sev = result.candidate.severity as keyof typeof this.bySeverity;
      this.bySeverity[sev]++;
      this.recordDetected(now, result.candidate);

      // BACKLOG-3 phase 1: log-only fast-path evaluation. Pure function, no I/O,
      // result buffered for periodic flush along with detected/filtered logs.
      this.recordFastPath(now, result.candidate);

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

      // Étape 2B: dispatch alt_pump candidates only.
      // Skip WEAK signals: entry.ts always refuses them with signal_too_weak.
      // Sending them generates 2-3 dispatches per signal (WEAK candidate fires
      // every tick that crosses change1h ≥ 8%) for nothing.
      // Other signal types (major_crash, position_crash, major_pump) need
      // MANAGE involvement and are logged-only for now.
      if (result.candidate.signalType === "alt_pump"
          && result.candidate.severity !== "weak") {
        void this.tryDispatch(result.candidate);
      }
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
    bySeverity: { weak: number; strong: number; major: number };
    dispatch: {
      attempted: number;
      ok: number;
      skipped: number;
      httpError: number;
      networkError: number;
      preCheckFailed: { throttle: number; blacklist: number };
      inFlight: number;
    };
    pendingDetected: number;
    pendingFiltered: number;
    pendingFastPath: number;
  } {
    return {
      tradableUniverse: this.tradableSymbols.size,
      ticksEvaluated: this.ticksEvaluated,
      gatePassed: this.gatePassed,
      candidatesDetected: this.candidatesDetected,
      signalsFiltered: this.signalsFiltered,
      bySignalType: this.bySignalType,
      byTriggerSource: this.byTriggerSource,
      bySeverity: this.bySeverity,
      dispatch: {
        attempted: this.dispatchAttempted,
        ok: this.dispatchOk,
        skipped: this.dispatchSkipped,
        httpError: this.dispatchHttpError,
        networkError: this.dispatchNetworkError,
        preCheckFailed: this.dispatchPreCheckFailed,
        inFlight: this.inFlightDispatches.size,
      },
      pendingDetected: this.pendingDetected.length,
      pendingFiltered: this.pendingFiltered.length,
      pendingFastPath: this.pendingFastPath.length,
    };
  }

  /**
   * Try to dispatch an alt_pump candidate to fursat.net.
   * Pre-checks: in-flight guard, throttle, blacklist.
   * Fire-and-forget — caller doesn't await.
   */
  private async tryDispatch(c: MomentumCandidate): Promise<void> {
    const symbol = c.symbol;

    // Cheap in-memory guard: if a dispatch is already in-flight for this
    // symbol, skip silently. Prevents 50 dispatch attempts in 1s on a fast pump.
    if (this.inFlightDispatches.has(symbol)) return;
    this.inFlightDispatches.add(symbol);

    try {
      // Pre-check 1: throttle (shared with scan.ts)
      const throttleCheck = await checkThrottle(symbol);
      if (!throttleCheck.allowed) {
        this.dispatchPreCheckFailed.throttle++;
        logger.info("Dispatch SKIPPED — throttled", {
          symbol, reason: throttleCheck.reason, details: throttleCheck.details,
        });
        return;
      }

      // Pre-check 2: blacklist
      const blacklistCheck = await isBlacklisted(symbol);
      if (blacklistCheck.blacklisted) {
        this.dispatchPreCheckFailed.blacklist++;
        logger.info("Dispatch SKIPPED — blacklisted", {
          symbol,
          reason: blacklistCheck.reason,
          expiresInMs: blacklistCheck.expiresInMs,
        });
        return;
      }

      // All checks passed — dispatch
      this.dispatchAttempted++;
      const signal: DispatchSignal = {
        symbol,
        change5m: c.change5m,
        change15m: c.change15m,
        change1h: c.change1h,
        change24h: c.change24h,
        volume24h: c.volume24h,
        drawdownFromPeak: c.drawdownFromPeak,
        severity: c.severity,
        signalType: c.signalType,
        triggerSource: c.triggerSource,
        signalPrice: c.currentPrice,
        signalTimestamp: Date.now(),
      };
      const result = await dispatchEntry(signal);

      if (result.ok) this.dispatchOk++;
      else if (result.skipped) this.dispatchSkipped++;
      else if (result.error) this.dispatchNetworkError++;
      else this.dispatchHttpError++;
    } catch (err) {
      logger.error("tryDispatch threw", { symbol, err: (err as Error).message });
    } finally {
      this.inFlightDispatches.delete(symbol);
    }
  }

  private recordDetected(ts: number, c: MomentumCandidate): void {
    this.pendingDetected.push({
      ts,
      symbol: c.symbol,
      signalType: c.signalType,
      severity: c.severity,
      triggerSource: c.triggerSource,
      // Sub-minute observability windows — for BACKLOG-3 calibration
      change30s: c.change30s,
      change1min: c.change1min,
      change2min: c.change2min,
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
    // BACKLOG-13 phase 1.A (2026-04-30): disabled to reduce Redis writes.
    // dryrun:filtered_signals_log was used to calibrate fast-exit thresholds.
    // Calibration done; the log is no longer consulted. To re-enable, uncomment.
    // this.pendingFiltered.push({
    //   ts, symbol, reason,
    //   change5m: snap.change5m, change15m: snap.change15m, change1h: snap.change1h,
    // });
    void ts; void symbol; void reason; void snap;
  }

  /**
   * BACKLOG-3 phase 1 — log-only fast-path observation.
   * Calls the pure evaluator from signal-rules.ts and buffers the result
   * for periodic flush. Triggers ZERO real action.
   */
  private recordFastPath(ts: number, c: MomentumCandidate): void {
    const verdict = evaluateFastPathCandidate(c);
    this.pendingFastPath.push({
      ts,
      symbol: c.symbol,
      change30s: c.change30s,
      change1min: c.change1min,
      change2min: c.change2min,
      change5m: c.change5m,
      change15m: c.change15m,
      change1h: c.change1h,
      change4h: c.change4h,
      volume24h: c.volume24h,
      drawdownFromPeak: c.drawdownFromPeak,
      isHeld: c.isHeld,
      classicalSeverity: c.severity,
      classicalSignalType: c.signalType,
      classicalTriggerSource: c.triggerSource,
      wouldFireStrong: verdict.wouldFireStrong,
      wouldFireMajor: verdict.wouldFireMajor,
      wouldFilterDead: verdict.wouldFilterDead,
      reasons: verdict.reasons,
    });
  }

  /**
   * Flush pending log entries to Redis, prepending to the existing list and
   * truncating at MAX_LOG_ENTRIES. Done periodically rather than per-event
   * to amortize Redis cost on bursty pump waves.
   */
  private async flushLogs(): Promise<void> {
    // BACKLOG-13 phase 1.B (2026-04-30): short-circuit when nothing to flush.
    // Saves 6 Redis commands every 5s during quiet periods (nights, weekends,
    // calm market) — typically -50% writes when no signal activity.
    if (
      this.pendingDetected.length === 0 &&
      this.pendingFiltered.length === 0 &&
      this.pendingFastPath.length === 0
    ) {
      return;
    }

    const detectedToFlush = this.pendingDetected.splice(0);
    const filteredToFlush = this.pendingFiltered.splice(0);
    const fastPathToFlush = this.pendingFastPath.splice(0);

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

    // BACKLOG-3 phase 1 — flush fast-path observation log
    if (fastPathToFlush.length > 0) {
      try {
        const existing: FastPathEntry[] = (await redisGet<FastPathEntry[]>(FASTPATH_LOG_KEY)) ?? [];
        const merged = [...fastPathToFlush, ...existing].slice(0, MAX_LOG_ENTRIES);
        await redisSet(FASTPATH_LOG_KEY, merged);
      } catch (err) {
        logger.warn("Failed to flush fastpath log", { err: (err as Error).message });
        this.pendingFastPath.unshift(...fastPathToFlush);
      }
    }
  }
}