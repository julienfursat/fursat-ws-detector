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
import { dispatchFastExit, isInFastExitCooldown, type FastExitDispatchPayload } from "./fast-exit-dispatcher.js";
import type { PositionsTracker } from "./positions.js";

// BACKLOG-3 phase 3 (2026-05-02) — Worker-side kill switch on classical alt_pump dispatches.
// Mirrors the scan.ts SCAN_ALT_PUMP_BUY_ENABLED flag. The classical 5m/15m/1h
// classifySignal path produces the same kind of late-entry trades that scan does
// (HONEY at 11:16 02/05 was dispatched via this path with 5m=15m=1h=5.6%, lost money).
// Default: disabled (opt-in). Re-enable via env: WORKER_ALT_PUMP_BUY_ENABLED=true.
// Note: early_pump dispatches (sub-minute) remain ACTIVE — they have a different
// risk profile because they catch starts not tops.
// Other signal types (major_crash, position_crash, major_pump, early_pump) are NOT affected.
const WORKER_ALT_PUMP_BUY_ENABLED = (process.env.WORKER_ALT_PUMP_BUY_ENABLED ?? "false").toLowerCase() === "true";
const WORKER_ALT_PUMP_DISABLED_COUNTER_KEY = "worker:alt_pump_disabled_count";
import {
  classifySignal,
  evaluateFastPathCandidate,
  evaluateEarlyEntry,
  evaluateSlowDownExit,
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
  EARLY_ENTRY_MIN_CHANGE30S,
  EARLY_ENTRY_MIN_CHANGE2MIN,
} from "./lib/signal-rules.js";

// Logs kept in Redis — bounded to prevent unbounded growth.
// Use dryrun:* prefix so the assertDryrunKey guard in redis.ts allows the writes.
const DETECTED_LOG_KEY = "dryrun:detected_signals_log";
const FILTERED_LOG_KEY = "dryrun:filtered_signals_log";
const FASTPATH_LOG_KEY = "dryrun:fastpath_log";  // BACKLOG-3 phase 1, log-only fast-path observation
// BACKLOG-3 phase 2 (2026-05-01) — ACTIVE early-pump dispatch + slow-down exit observations.
// Despite "dryrun:" prefix (Redis guard), these logs trace REAL dispatches now, not just hypotheticals.
const EARLY_DISPATCH_LOG_KEY = "dryrun:early_dispatch_log";
const SLOW_DOWN_DISPATCH_LOG_KEY = "dryrun:slow_down_dispatch_log";
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

// BACKLOG-3 phase 2 (2026-05-01) — ACTIVE early dispatch log.
// One entry per actual early_pump dispatch attempt (whether dispatched or skipped).
// Used to monitor real production behavior and tune EARLY_ENTRY_* thresholds.
interface EarlyDispatchEntry {
  ts: number;
  symbol: string;
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  volume24h: number;
  drawdownFromPeak: number;
  isHeld: boolean;
  // Verdict and disposition
  isEarly: boolean;        // evaluateEarlyEntry result
  reason: string;          // explanatory tag
  dispatched: boolean;     // did we actually call dispatchEntry()
  dispatchSkipReason?: string;  // throttle / blacklist / inflight (if not dispatched)
}

// BACKLOG-3 phase 2 (2026-05-01) — ACTIVE slow-down exit dispatch log.
// One entry per evaluation on a HELD asset that triggered a slow-down/tp/sl verdict.
interface SlowDownDispatchEntry {
  ts: number;
  symbol: string;
  pnlPct: number;
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
  reasonCode: "fast_slow_down" | "fast_tp" | "fast_sl";
  detail: string;
  dispatched: boolean;
  dispatchSkipReason?: string;
}

export class Detector {
  private ringBuffers: RingBuffers;
  private tradableSymbols: Set<string>;
  private heldSymbolsProvider: () => Set<string>;
  // BACKLOG-3 phase 3 (2026-05-02) — Optional positions reference, used by
  // tryDispatchSlowDown to compute pnlPct directly from the tracked position
  // instead of doing an independent getAvgBuyPrice lookup. When provided, this
  // avoids the 60s null-cache pitfall and stays synchronized with the same
  // source of truth as fast-exit-evaluator (which has worked correctly).
  // Optional for backwards compatibility — when absent, slow-down evaluation
  // falls back to the legacy getAvgBuyPrice path.
  private positions: PositionsTracker | null = null;
  private flushTimer: NodeJS.Timeout | null = null;

  // Pending log entries (flushed every FLUSH_INTERVAL_MS)
  private pendingDetected: DetectedEntry[] = [];
  private pendingFiltered: FilteredEntry[] = [];
  private pendingFastPath: FastPathEntry[] = [];  // BACKLOG-3 phase 1
  // BACKLOG-3 phase 2 (2026-05-01) — ACTIVE early-pump and slow-down logs
  private pendingEarlyDispatch: EarlyDispatchEntry[] = [];
  private pendingSlowDown: SlowDownDispatchEntry[] = [];

  // Counters surfaced via stats()
  private ticksEvaluated = 0;
  private gatePassed = 0;
  private candidatesDetected = 0;
  private signalsFiltered = 0;
  private bySignalType = { alt_pump: 0, major_crash: 0, position_crash: 0, major_pump: 0, early_pump: 0 };
  private byTriggerSource = { "5m": 0, "15m": 0, "1h": 0, "30s": 0, none: 0 };
  private bySeverity = { weak: 0, strong: 0, major: 0 };

  // BACKLOG-3 phase 2 — early/slow-down counters
  private earlyEvaluated = 0;
  private earlyTriggered = 0;
  private earlyDispatched = 0;
  private slowDownEvaluated = 0;
  private slowDownTriggered = 0;
  private slowDownDispatched = 0;

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
    heldSymbolsProvider: () => Set<string>,
    positions?: PositionsTracker,
  ) {
    this.ringBuffers = ringBuffers;
    this.tradableSymbols = tradableSymbols;
    this.heldSymbolsProvider = heldSymbolsProvider;
    this.positions = positions ?? null;
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
    //
    // BACKLOG-3 phase 2 (2026-05-01): widened to also pass when:
    //   (a) Sub-minute deltas suggest an EARLY pump (change30s ≥ 1% AND change2min ≥ 2%)
    //       — needed because the classical 5m gate fires too late (post-mortem
    //         showed 15/16 trades entered at <2% from 60min max).
    //   (b) The asset is HELD — needed to evaluate slow-down/tp/sl exit on every tick.
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
      || (symbol === "BTC" && snap.change1h !== null && snap.change1h >= MAJOR_PUMP_PCT_1H)
      // BACKLOG-3 phase 2: early-pump sub-minute trigger
      || (snap.change30s !== null && snap.change30s >= EARLY_ENTRY_MIN_CHANGE30S
          && snap.change2min !== null && snap.change2min >= EARLY_ENTRY_MIN_CHANGE2MIN)
      // BACKLOG-3 phase 2: held positions need every tick for slow-down evaluation
      || isHeld;

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
      //
      // BACKLOG-3 phase 3 (2026-05-02) — Kill switch via WORKER_ALT_PUMP_BUY_ENABLED.
      // When disabled (default), classical alt_pump dispatches are short-circuited
      // BEFORE tryDispatch (no HTTP call to /api/agent/entry). The throttle is
      // intentionally NOT recorded so a future re-enable doesn't suppress legitimate signals.
      if (result.candidate.signalType === "alt_pump"
          && result.candidate.severity !== "weak") {
        if (WORKER_ALT_PUMP_BUY_ENABLED) {
          void this.tryDispatch(result.candidate);
        } else {
          // Log what-if for retrospective analysis (mirrors scan.ts disabled log)
          const c = result.candidate;
          logger.info(`[WORKER] ⊘ alt_pump BUY DISABLED (env WORKER_ALT_PUMP_BUY_ENABLED=false) — would have dispatched: ${c.symbol} ${c.severity}${c.triggerSource ? ` via ${c.triggerSource}` : ""} (5m=${c.change5m?.toFixed(1) ?? "n/a"}% 15m=${c.change15m?.toFixed(1) ?? "n/a"}% 1h=${c.change1h?.toFixed(1) ?? "n/a"}% vol=$${(c.volume24h / 1_000_000).toFixed(1)}M)`);
          // Bump counter for what-if visibility (best-effort)
          void (async () => {
            try {
              const current = (await redisGet<number>(WORKER_ALT_PUMP_DISABLED_COUNTER_KEY)) ?? 0;
              await redisSet(WORKER_ALT_PUMP_DISABLED_COUNTER_KEY, current + 1);
            } catch { /* non-fatal */ }
          })();
        }
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

    // ─── BACKLOG-3 phase 2 (2026-05-01) — EARLY ENTRY (sub-minute) ───
    // Evaluated INDEPENDENTLY of classifySignal, so an asset that didn't trigger
    // any classical path can still be dispatched as early_pump if sub-minute
    // velocity meets the criteria. Skip if classify already produced an alt_pump
    // candidate (already dispatched above) or a held-position signal.
    const alreadyClassified = result.kind === "candidate"
      && (result.candidate.signalType === "alt_pump" || result.candidate.signalType === "position_crash");
    if (!alreadyClassified && !isHeld) {
      this.earlyEvaluated++;
      const earlyVerdict = evaluateEarlyEntry(input);
      if (earlyVerdict.isEarly) {
        this.earlyTriggered++;
        // Synthesize a MomentumCandidate of type "early_pump" with severity "strong"
        // so entry.ts routes it to fast-path (Claude bypassed). The amount is
        // controlled in entry.ts via the early_pump signalType branch ($80 nominal).
        const earlyCandidate: MomentumCandidate = {
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
          score: 0,                       // not used downstream for early_pump
          signalType: "early_pump",
          severity: "strong",
          isHeld,
          drawdownFromPeak: snap.drawdownFromPeak,
          peakSampleCount: snap.peakSampleCount,
          triggerSource: "30s",
        };
        logger.info("⚡ EARLY DISPATCH", {
          symbol, ...{
            change30s: snap.change30s?.toFixed(2),
            change1min: snap.change1min?.toFixed(2),
            change2min: snap.change2min?.toFixed(2),
            change5m: snap.change5m?.toFixed(2),
            volume24h: Math.round(snap.volume24h / 1000) + "k",
            reason: earlyVerdict.reason,
          },
        });
        // Counter and log are updated inside tryDispatchEarly (knows actual disposition)
        void this.tryDispatchEarly(earlyCandidate, earlyVerdict.reason);
      } else {
        // Optional: log near-miss early evaluations for calibration. Only log when
        // sub-minute data is present and at least one threshold was close, otherwise
        // we'd flood the log on every routine tick.
        if (snap.change30s !== null && snap.change30s >= 0.5) {
          this.recordEarlyDispatch(now, input, earlyVerdict.isEarly, earlyVerdict.reason, false, "not_triggered");
        }
      }
    }

    // ─── BACKLOG-3 phase 2 (2026-05-01) — SLOW-DOWN EXIT (sub-minute) ───
    // Evaluated on every tick of a HELD asset. Dispatches POST to /api/agent/fast-exit
    // with reasonCode = fast_slow_down / fast_tp / fast_sl when the rule fires.
    if (isHeld) {
      this.slowDownEvaluated++;
      // pnlPct is unknown at the worker — we don't have avgBuyPrice in-memory.
      // The worker needs to ask the entry.ts side for the position info. To keep
      // this fast, we let the /api/agent/fast-exit endpoint do the pnl computation
      // and re-evaluate the rule server-side. Worker only sends the sub-minute
      // signature; server fetches avgBuyPrice from trade_meta.
      // SO: we always send the sub-minute candidate and let server decide.
      // Optimization: only POST when ANY of the three rules COULD fire. Cheap heuristic:
      //   change30s ≥ -1.0% safety_check: true (wide → catches tp/slow-down)
      //   OR change30s ≤ -1.0%           (catches fast_sl)
      // i.e. always — so we throttle by per-symbol cooldown instead.
      void this.tryDispatchSlowDown(symbol, snap, now);
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
    bySignalType: { alt_pump: number; major_crash: number; position_crash: number; major_pump: number; early_pump: number };
    byTriggerSource: { "5m": number; "15m": number; "1h": number; "30s": number; none: number };
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
    earlyEntry: {
      evaluated: number;
      triggered: number;
      dispatched: number;
    };
    slowDown: {
      evaluated: number;
      triggered: number;
      dispatched: number;
    };
    pendingDetected: number;
    pendingFiltered: number;
    pendingFastPath: number;
    pendingEarlyDispatch: number;
    pendingSlowDown: number;
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
      earlyEntry: {
        evaluated: this.earlyEvaluated,
        triggered: this.earlyTriggered,
        dispatched: this.earlyDispatched,
      },
      slowDown: {
        evaluated: this.slowDownEvaluated,
        triggered: this.slowDownTriggered,
        dispatched: this.slowDownDispatched,
      },
      pendingDetected: this.pendingDetected.length,
      pendingFiltered: this.pendingFiltered.length,
      pendingFastPath: this.pendingFastPath.length,
      pendingEarlyDispatch: this.pendingEarlyDispatch.length,
      pendingSlowDown: this.pendingSlowDown.length,
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
      // BACKLOG-3 phase 2 (2026-05-01) — DispatchSignal.signalType is narrowly typed
      // to the original 4 values (alt_pump | major_crash | position_crash | major_pump).
      // tryDispatch is only called for those 4 (early_pump goes via tryDispatchEarly), so
      // the cast is safe in practice. Long-term: extend DispatchSignal in dispatcher.ts.
      const signal: DispatchSignal = {
        symbol,
        change5m: c.change5m,
        change15m: c.change15m,
        change1h: c.change1h,
        change24h: c.change24h,
        volume24h: c.volume24h,
        drawdownFromPeak: c.drawdownFromPeak,
        severity: c.severity,
        signalType: c.signalType as DispatchSignal["signalType"],
        triggerSource: c.triggerSource as DispatchSignal["triggerSource"],
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

  // ─── BACKLOG-3 phase 2 (2026-05-01) — Early dispatch + Slow-down ────────────

  /**
   * Cache for avgBuyPrice lookups from agent:trade_meta.
   * TTL 60s — long enough to avoid Redis spam during pump bursts (10+ ticks/s),
   * short enough that fresh BUYs are reflected within a minute.
   * Cache shape: { symbol → { avgBuyPrice, fetchedAt } }
   */
  private avgBuyPriceCache = new Map<string, { avgBuyPrice: number | null; fetchedAt: number }>();
  private static readonly AVG_BUY_CACHE_TTL_MS = 60_000;

  /**
   * Per-symbol slow-down dispatch cooldown (ms). Avoids re-firing fast_slow_down
   * 50 times in a row on the same tick burst. The actual SELL is idempotent
   * server-side (Coinbase rejects double-sell), but we avoid wasteful HTTP traffic.
   */
  private slowDownLastDispatch = new Map<string, number>();
  private static readonly SLOW_DOWN_COOLDOWN_MS = 30_000;

  /**
   * Dispatches an early_pump candidate to /api/agent/entry. Same pre-check stack
   * as tryDispatch (throttle, blacklist, in-flight guard).
   */
  private async tryDispatchEarly(c: MomentumCandidate, earlyReason: string): Promise<void> {
    const symbol = c.symbol;
    const now = Date.now();

    if (this.inFlightDispatches.has(symbol)) {
      this.recordEarlyDispatch(now, this.candidateToInput(c), true, earlyReason, false, "in_flight");
      return;
    }
    this.inFlightDispatches.add(symbol);

    try {
      const throttleCheck = await checkThrottle(symbol, "early_pump");
      if (!throttleCheck.allowed) {
        this.dispatchPreCheckFailed.throttle++;
        this.recordEarlyDispatch(now, this.candidateToInput(c), true, earlyReason, false, `throttle:${throttleCheck.reason}`);
        logger.info("Early dispatch SKIPPED — throttled", {
          symbol, reason: throttleCheck.reason,
        });
        return;
      }

      const blacklistCheck = await isBlacklisted(symbol);
      if (blacklistCheck.blacklisted) {
        this.dispatchPreCheckFailed.blacklist++;
        this.recordEarlyDispatch(now, this.candidateToInput(c), true, earlyReason, false, `blacklist:${blacklistCheck.reason}`);
        logger.info("Early dispatch SKIPPED — blacklisted", {
          symbol, reason: blacklistCheck.reason,
        });
        return;
      }

      // All pre-checks passed — dispatch
      this.dispatchAttempted++;
      this.earlyDispatched++;
      // BACKLOG-3 phase 2 (2026-05-01) — early_pump is outside DispatchSignal.signalType
      // narrow union but accepted by entry.ts as a string. Cast each field individually
      // and use a separate object so we can attach the sub-minute deltas (which DispatchSignal
      // also doesn't formally declare). entry.ts reads them via dynamic property access.
      const signal = {
        symbol,
        change5m: c.change5m,
        change15m: c.change15m,
        change1h: c.change1h,
        change24h: c.change24h,
        volume24h: c.volume24h,
        drawdownFromPeak: c.drawdownFromPeak,
        severity: c.severity,
        signalType: c.signalType as DispatchSignal["signalType"],  // safe cast: entry.ts accepts string
        triggerSource: c.triggerSource as DispatchSignal["triggerSource"],
        signalPrice: c.currentPrice,
        signalTimestamp: now,
        // Sub-minute deltas — entry.ts reads these for fast-path logging and early_pump eligibility
        change30s: c.change30s,
        change1min: c.change1min,
        change2min: c.change2min,
      } as DispatchSignal;
      const result = await dispatchEntry(signal);

      if (result.ok) this.dispatchOk++;
      else if (result.skipped) this.dispatchSkipped++;
      else if (result.error) this.dispatchNetworkError++;
      else this.dispatchHttpError++;

      this.recordEarlyDispatch(now, this.candidateToInput(c), true, earlyReason, true);
    } catch (err) {
      logger.error("tryDispatchEarly threw", { symbol, err: (err as Error).message });
      this.recordEarlyDispatch(now, this.candidateToInput(c), true, earlyReason, false, `exception:${(err as Error).message}`);
    } finally {
      this.inFlightDispatches.delete(symbol);
    }
  }

  /**
   * Helper: rebuild a ClassifyInput from a MomentumCandidate for logging.
   * Only used by recordEarlyDispatch — extracts the fields we want to persist.
   */
  private candidateToInput(c: MomentumCandidate): ClassifyInput {
    return {
      symbol: c.symbol,
      currentPrice: c.currentPrice,
      change30s: c.change30s,
      change1min: c.change1min,
      change2min: c.change2min,
      change5m: c.change5m,
      change15m: c.change15m,
      change1h: c.change1h,
      change4h: c.change4h,
      change24h: c.change24h,
      volume24h: c.volume24h,
      isHeld: c.isHeld,
      isMajor: MAJORS.has(c.symbol),
      drawdownFromPeak: c.drawdownFromPeak,
      peakSampleCount: c.peakSampleCount,
    };
  }

  /**
   * Reads avgBuyPrice for a symbol from agent:trade_meta with 60s in-memory cache.
   * Returns null if no position metadata exists (e.g. legacy or just-bought asset).
   *
   * trade_meta shape: { [orderId]: { symbol, side, avgBuyPrice, ... } }
   * For each symbol, we want the avgBuyPrice of the LATEST BUY. We scan in reverse
   * insertion order (objects preserve insertion in modern JS).
   */
  private async getAvgBuyPrice(symbol: string): Promise<number | null> {
    const cached = this.avgBuyPriceCache.get(symbol);
    if (cached && (Date.now() - cached.fetchedAt) < Detector.AVG_BUY_CACHE_TTL_MS) {
      return cached.avgBuyPrice;
    }
    try {
      const meta = await redisGet<Record<string, { symbol?: string; side?: string; avgBuyPrice?: number; price?: number }>>("agent:trade_meta");
      if (!meta) {
        this.avgBuyPriceCache.set(symbol, { avgBuyPrice: null, fetchedAt: Date.now() });
        return null;
      }
      // Walk entries in reverse to find the most recent BUY for this symbol
      const entries = Object.entries(meta);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [, m] = entries[i];
        if (m && m.symbol === symbol && (m.side ?? "").toUpperCase() === "BUY") {
          const price = m.avgBuyPrice ?? m.price ?? null;
          this.avgBuyPriceCache.set(symbol, { avgBuyPrice: price, fetchedAt: Date.now() });
          return price;
        }
      }
      this.avgBuyPriceCache.set(symbol, { avgBuyPrice: null, fetchedAt: Date.now() });
      return null;
    } catch (err) {
      logger.warn("getAvgBuyPrice failed", { symbol, err: (err as Error).message });
      return null;
    }
  }

  /**
   * Evaluates slow-down/tp/sl on a held position. Reads avgBuyPrice from cache
   * (or Redis on cache miss), computes pnlPct, calls evaluateSlowDownExit.
   * If triggered, dispatches via the shared fast-exit-dispatcher (same path as
   * the classical fast-exit-evaluator) — gives us the 10min Redis cooldown
   * shared with scan.ts for free, and unifies all SELL traffic.
   *
   * Two-tier cooldown:
   *   • In-memory 30s per symbol — absorbs tick-burst spam before any Redis I/O.
   *   • Redis 10min via fast-exit-dispatcher — survives restarts, shared with scan.ts.
   */
  private async tryDispatchSlowDown(
    symbol: string,
    snap: { currentPrice: number; change30s: number | null; change1min: number | null; change2min: number | null },
    now: number,
  ): Promise<void> {
    // Tier 1: in-memory cooldown (30s) — cheap pre-filter
    const lastDispatch = this.slowDownLastDispatch.get(symbol);
    if (lastDispatch && (now - lastDispatch) < Detector.SLOW_DOWN_COOLDOWN_MS) {
      return;
    }

    // Need sub-minute data
    if (snap.change30s == null || snap.change1min == null || snap.change2min == null) {
      return;
    }

    // BACKLOG-3 phase 3 (2026-05-02) — Use the SAME source of truth as
    // fast-exit-evaluator (positions.updatePriceForSymbol). Previously we used a
    // separate getAvgBuyPrice() with its own cache, which had a 60s null-cache
    // bug: if the first lookup happened before agent:trade_meta was propagated
    // (right after a worker BUY), null was cached for 60s, blocking slow-down
    // evaluation during the entire pump window of 2-5min trades. By using
    // positions.updatePriceForSymbol() we get pnlPct already computed and
    // synchronized with the rest of the worker.
    let pnlPct: number;
    let avgBuyPrice: number;
    if (this.positions) {
      const pos = this.positions.updatePriceForSymbol(symbol, snap.currentPrice);
      if (!pos) return;  // not held according to positions tracker
      pnlPct = pos.pnlPct;
      avgBuyPrice = pos.avgBuyPrice;
    } else {
      // Legacy fallback path (kept for backwards compat — should not be used
      // in production once worker-index passes positions to the constructor).
      const legacyAvg = await this.getAvgBuyPrice(symbol);
      if (legacyAvg == null || legacyAvg <= 0) return;
      avgBuyPrice = legacyAvg;
      pnlPct = ((snap.currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
    }

    const verdict = evaluateSlowDownExit({
      pnlPct,
      change30s: snap.change30s,
      change1min: snap.change1min,
      change2min: snap.change2min,
    });

    if (!verdict) return;

    this.slowDownTriggered++;
    // Set in-memory cooldown immediately (before any I/O) so concurrent ticks bail fast
    this.slowDownLastDispatch.set(symbol, now);

    logger.info("⚡ SLOW-DOWN TRIGGER", {
      symbol, reasonCode: verdict.reasonCode, detail: verdict.detail,
      pnl: pnlPct.toFixed(2), price: snap.currentPrice,
    });

    // Tier 2: Redis cooldown check (10min, shared with scan.ts and fast-exit-evaluator)
    try {
      const cooldownActive = await isInFastExitCooldown(symbol);
      if (cooldownActive) {
        logger.info("Slow-down SKIPPED — Redis cooldown active (recent fast-exit on this symbol)", {
          symbol, reasonCode: verdict.reasonCode,
        });
        this.recordSlowDown(now, symbol, pnlPct, snap, verdict.reasonCode, verdict.detail, false, "redis_cooldown");
        return;
      }

      // Build payload — sub-minute reasonCodes don't use change30min/15m/1h, set null.
      // pnlMax/pnlMin are tracked by fast-exit-evaluator's PnlTracker, not here. We omit
      // them rather than sending stale/wrong values; fast-exit.ts treats them as optional.
      const payload: FastExitDispatchPayload = {
        symbol,
        reasonCode: verdict.reasonCode,
        pnlPct,
        avgBuyPrice,
        currentPrice: snap.currentPrice,
        change1h: null,
        change15m: null,
        change30min: null,
        holdingSince: 0,  // unknown to detector; fast-exit.ts only uses this for logging
      };

      const result = await dispatchFastExit(payload);
      if (result.ok) this.slowDownDispatched++;
      this.recordSlowDown(
        now, symbol, pnlPct, snap, verdict.reasonCode, verdict.detail, result.ok,
        result.ok ? undefined : (result.cooldownSkipped ? "dispatcher_cooldown" : (result.error ?? `http_${result.status}`)),
      );
    } catch (err) {
      logger.error("dispatchFastExit threw on slow-down", { symbol, err: (err as Error).message });
      this.recordSlowDown(now, symbol, pnlPct, snap, verdict.reasonCode, verdict.detail, false, `exception:${(err as Error).message}`);
    }
  }

  /**
   * Buffers an early-dispatch observation for periodic flush to
   * dryrun:early_dispatch_log.
   */
  private recordEarlyDispatch(
    ts: number,
    input: ClassifyInput,
    isEarly: boolean,
    reason: string,
    dispatched: boolean,
    dispatchSkipReason?: string,
  ): void {
    this.pendingEarlyDispatch.push({
      ts,
      symbol: input.symbol,
      change30s: input.change30s ?? null,
      change1min: input.change1min ?? null,
      change2min: input.change2min ?? null,
      change5m: input.change5m,
      change15m: input.change15m,
      change1h: input.change1h,
      volume24h: input.volume24h,
      drawdownFromPeak: input.drawdownFromPeak,
      isHeld: input.isHeld,
      isEarly,
      reason,
      dispatched,
      dispatchSkipReason,
    });
  }

  /**
   * Buffers a slow-down dispatch observation for periodic flush to
   * dryrun:slow_down_dispatch_log.
   */
  private recordSlowDown(
    ts: number,
    symbol: string,
    pnlPct: number,
    snap: { change30s: number | null; change1min: number | null; change2min: number | null },
    reasonCode: "fast_slow_down" | "fast_tp" | "fast_sl",
    detail: string,
    dispatched: boolean,
    dispatchSkipReason?: string,
  ): void {
    this.pendingSlowDown.push({
      ts,
      symbol,
      pnlPct,
      change30s: snap.change30s,
      change1min: snap.change1min,
      change2min: snap.change2min,
      reasonCode,
      detail,
      dispatched,
      dispatchSkipReason,
    });
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
    // Saves Redis commands every 5s during quiet periods (nights, weekends,
    // calm market) — typically -50% writes when no signal activity.
    // BACKLOG-3 phase 2 (2026-05-01): added early/slow-down buffers to the check.
    if (
      this.pendingDetected.length === 0 &&
      this.pendingFiltered.length === 0 &&
      this.pendingFastPath.length === 0 &&
      this.pendingEarlyDispatch.length === 0 &&
      this.pendingSlowDown.length === 0
    ) {
      return;
    }

    const detectedToFlush = this.pendingDetected.splice(0);
    const filteredToFlush = this.pendingFiltered.splice(0);
    const fastPathToFlush = this.pendingFastPath.splice(0);
    const earlyToFlush = this.pendingEarlyDispatch.splice(0);
    const slowDownToFlush = this.pendingSlowDown.splice(0);

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

    // BACKLOG-3 phase 2 — flush early-dispatch log
    if (earlyToFlush.length > 0) {
      try {
        const existing: EarlyDispatchEntry[] = (await redisGet<EarlyDispatchEntry[]>(EARLY_DISPATCH_LOG_KEY)) ?? [];
        const merged = [...earlyToFlush, ...existing].slice(0, MAX_LOG_ENTRIES);
        await redisSet(EARLY_DISPATCH_LOG_KEY, merged);
      } catch (err) {
        logger.warn("Failed to flush early dispatch log", { err: (err as Error).message });
        this.pendingEarlyDispatch.unshift(...earlyToFlush);
      }
    }

    // BACKLOG-3 phase 2 — flush slow-down dispatch log
    if (slowDownToFlush.length > 0) {
      try {
        const existing: SlowDownDispatchEntry[] = (await redisGet<SlowDownDispatchEntry[]>(SLOW_DOWN_DISPATCH_LOG_KEY)) ?? [];
        const merged = [...slowDownToFlush, ...existing].slice(0, MAX_LOG_ENTRIES);
        await redisSet(SLOW_DOWN_DISPATCH_LOG_KEY, merged);
      } catch (err) {
        logger.warn("Failed to flush slow-down log", { err: (err as Error).message });
        this.pendingSlowDown.unshift(...slowDownToFlush);
      }
    }
  }
}