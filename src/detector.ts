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
import { redisGet, redisSet, redisLpush, redisLtrim } from "./redis.js";
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

// PUMP-1H DETECTOR (NEW 2026-05-03) — Sustained-pump path.
// Activated additively to early_pump. Targets pumps that EARLY_ENTRY rejects
// because change5m ≥ 4% (queue-of-pump in worker's view). See PUMP1H_*
// constants in signal-rules.ts for full rationale and the TROLL +69% case
// study that motivated this detector.
//
// Killswitch: WORKER_PUMP1H_BUY_ENABLED env var. Default false until validated
// on 20+ samples. When false, the detector still EVALUATES (and logs the
// near-miss) but does NOT dispatch.
//
// Cap horaire: 5/h max BUYs pump-1h (permissive for initial calibration).
// Throttle per-asset: 60min (longer than early_pump's 30min because pump-1h
// pumps last longer and we should not multi-buy the same asset within one
// pump cycle).
const WORKER_PUMP1H_BUY_ENABLED = (process.env.WORKER_PUMP1H_BUY_ENABLED ?? "false").toLowerCase() === "true";
const WORKER_PUMP1H_HOURLY_COUNTER_KEY = "worker:hourly_pump1h_count";
const WORKER_PUMP1H_DISPATCHED_KEY_PREFIX = "worker:dispatched:pump1h:";  // + symbol
const WORKER_PUMP1H_HOURLY_CAP = 5;
const WORKER_PUMP1H_THROTTLE_MS = 60 * 60 * 1000;  // 60min per-asset
import {
  classifySignal,
  evaluateFastPathCandidate,
  evaluateEarlyEntry,
  evaluatePump1hEntry,
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
//
// BACKLOG-3 phase 4 (2026-05-03) — Migrated from JSON-blob (GET → merge → SET) to
// Redis LIST (LPUSH + LTRIM). Two reasons:
//   1. The blob pattern was O(N) per flush (re-serialize the whole array). At 50000
//      entries that's ~5 MB written every 5s = unworkable.
//   2. The previous cap of 1000 entries saturated in ~42 min at production rates
//      (~1450 entries/h), making 24h analysis impossible.
// LIST + LPUSH is O(1) per write, so the cap can grow safely.
//
// dryrun:detected_signals_log was DEPRECATED in this phase: it carried strictly
// the same events as fastpath_log (recordDetected and recordFastPath were called
// back-to-back on every detection — see lines ~335/339), wasting ~50% of dryrun
// log writes for zero analytical value. fastpath_log is now the single source.
const FILTERED_LOG_KEY = "dryrun:filtered_signals_log";
const FASTPATH_LOG_KEY = "dryrun:fastpath_log";  // Single canonical detection log
// BACKLOG-3 phase 2 (2026-05-01) — ACTIVE early-pump dispatch + slow-down exit observations.
// Despite "dryrun:" prefix (Redis guard), these logs trace REAL dispatches now, not just hypotheticals.
const EARLY_DISPATCH_LOG_KEY = "dryrun:early_dispatch_log";
const SLOW_DOWN_DISPATCH_LOG_KEY = "dryrun:slow_down_dispatch_log";
// PUMP-1H DETECTOR (NEW 2026-05-03) — separate ring buffer for analysis.
// Same LPUSH/LTRIM pattern as the others. Same MAX_LOG_ENTRIES cap.
const PUMP1H_DISPATCH_LOG_KEY = "dryrun:pump1h_dispatch_log";
// 50000 entries × ~1450 entries/h ≈ 34 hours of coverage at full production rate.
// At ~10 KB compressed JSON per entry, this is ~5 MB Redis storage per log key.
const MAX_LOG_ENTRIES = 50_000;

/**
 * Format a Unix timestamp (ms) as Paris-local "YYYY-MM-DD HH:mm:ss".
 * Used for human-readable parisTime field on every dryrun entry, so downstream
 * analysis (debug-export → projectDryrunEntry) can render it directly without
 * needing tz lookups in the browser.
 */
function formatParisTime(tsMs: number): string {
  const d = new Date(tsMs);
  // toLocaleString with explicit Paris tz, then re-shape to "YYYY-MM-DD HH:mm:ss".
  // Avoid toISOString (UTC) and avoid hand-rolled offset arithmetic (DST headaches).
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

// In-memory log buffers (flushed to Redis on a timer for efficiency).
// Without batching, a fast pump triggering 50 detections in 5 seconds would
// generate 50 Redis writes, hurting throughput.
const FLUSH_INTERVAL_MS = 5_000;

// BACKLOG-3 phase 4 (2026-05-03) — DetectedEntry interface removed: the type
// was used solely for the deprecated dryrun:detected_signals_log, which carried
// a strict duplicate of fastpath_log. fastpath_log is the canonical event log.

interface FilteredEntry {
  ts: number;
  symbol: string;
  reason: SkipReason;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
}

// BACKLOG-3 phase 1 (2026-04-30) — fast-path candidate observation log.
// One entry per detected signal, recording what the fast-path system WOULD have done.
// Used for empirical calibration of Y_STRONG, Y_MAJOR, X_MIN before activating
// real fast-path triggers. Now the canonical detection event log (BACKLOG-3 phase 4).
interface FastPathEntry {
  ts: number;
  // BACKLOG-3 phase 4 (2026-05-03) — annotations for downstream projectDryrunEntry.
  // Without these, debug-export returns null for parisTime/severity/decision/reason
  // making 1000+ entries practically unanalyzable.
  parisTime: string;       // human-readable Europe/Paris timestamp
  severity: "weak" | "strong" | "major";  // mirrors classicalSeverity but at the top level
  decision: string;         // "fastpath_qualified" | "fastpath_observed" — what the fast-path verdict was
  reason: string;           // short human reason (e.g. "wouldFireStrong", "wouldFilterDead: change5m<2")
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
  // BACKLOG-3 phase 4 (2026-05-03) — annotations for projectDryrunEntry compatibility.
  parisTime: string;
  decision: string;        // "dispatched" | "skipped:<reason>" — single-field summary
  severity: "early";       // sentinel — early_pump dispatches don't have classical severity
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
  parisTime: string;       // BACKLOG-3 phase 4 (2026-05-03) — for projectDryrunEntry
  decision: string;        // "dispatched" | "skipped:<reason>"
  severity: "exit";        // sentinel — exit events, not entry signals
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

// PUMP-1H DETECTOR (NEW 2026-05-03) — log entry for dryrun:pump1h_dispatch_log.
// Mirrors EarlyDispatchEntry's shape so the same projectDryrunEntry projection
// can render either type. Severity sentinel "pump1h" distinguishes from "early".
interface Pump1hDispatchEntry {
  ts: number;
  parisTime: string;
  decision: string;        // "dispatched" | "skipped:<reason>"
  severity: "pump1h";      // sentinel — pump-1h dispatch events
  symbol: string;
  // Sub-minute windows (informative, not used by the detector itself but useful for analysis)
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
  // The windows actually used by evaluatePump1hEntry
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  volume24h: number;
  drawdownFromPeak: number;
  isHeld: boolean;
  // Verdict from evaluatePump1hEntry
  isPump1h: boolean;
  reason: string;
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
  // BACKLOG-3 phase 4 (2026-05-03) — pendingDetected removed: was a strict
  // duplicate of pendingFastPath (recordDetected and recordFastPath were called
  // back-to-back on every detection). fastpath_log is now the canonical event log.
  private pendingFiltered: FilteredEntry[] = [];
  private pendingFastPath: FastPathEntry[] = [];  // BACKLOG-3 phase 1
  // BACKLOG-3 phase 2 (2026-05-01) — ACTIVE early-pump and slow-down logs
  private pendingEarlyDispatch: EarlyDispatchEntry[] = [];
  private pendingSlowDown: SlowDownDispatchEntry[] = [];
  // PUMP-1H DETECTOR (NEW 2026-05-03) — pending log buffer
  private pendingPump1h: Pump1hDispatchEntry[] = [];

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

  // PUMP-1H DETECTOR (NEW 2026-05-03) — separate counters from early/slow-down
  // so we can analyze pump-1h dispatches in isolation.
  private pump1hEvaluated = 0;
  private pump1hTriggered = 0;
  private pump1hDispatched = 0;
  private pump1hSkippedKillswitch = 0;
  private pump1hSkippedHourlyCap = 0;

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

      // BACKLOG-3 phase 4 (2026-05-03) — recordDetected was deduplicated.
      // The two record* calls produced strictly identical event sets in two
      // different log keys, doubling Redis writes for zero analytical value.
      // fastpath_log is now the canonical detection event log.
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

    // ─── PUMP-1H DETECTOR (NEW 2026-05-03) — Sustained-pump entry ───
    // Evaluated INDEPENDENTLY of early_pump and classifySignal. Targets pumps
    // that EARLY_ENTRY rejects because change5m ≥ 4% (queue-of-pump in worker
    // view). NOT mutually exclusive with early_pump in code: if both trigger
    // on the same tick (rare — different change5m regimes), early_pump takes
    // precedence because it was evaluated first and its dispatch is in flight.
    // The inFlightDispatches Set guarantees no double-BUY.
    //
    // Pre-conditions match early_pump: not already classified as alt_pump/crash,
    // not held.
    if (!alreadyClassified && !isHeld) {
      this.pump1hEvaluated++;
      const pump1hVerdict = evaluatePump1hEntry(input);
      if (pump1hVerdict.isPump1h) {
        this.pump1hTriggered++;
        // Synthesize a MomentumCandidate of type "pump1h" with severity "strong".
        // The triggerSource is "1h" since this detector keys off the 1h window.
        const pump1hCandidate: MomentumCandidate = {
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
          score: 0,                       // not used downstream for pump1h
          signalType: "pump1h" as MomentumCandidate["signalType"],  // NEW signalType — entry.ts handles it as opportunity-pump1h
          severity: "strong",
          isHeld,
          drawdownFromPeak: snap.drawdownFromPeak,
          peakSampleCount: snap.peakSampleCount,
          triggerSource: "1h",
        };
        logger.info("⚡ PUMP-1H DISPATCH (candidate)", {
          symbol, ...{
            change5m: snap.change5m?.toFixed(2),
            change15m: snap.change15m?.toFixed(2),
            change1h: snap.change1h?.toFixed(2),
            volume24h: Math.round(snap.volume24h / 1000) + "k",
            reason: pump1hVerdict.reason,
            killswitch_enabled: WORKER_PUMP1H_BUY_ENABLED,
          },
        });
        void this.tryDispatchPump1h(pump1hCandidate, pump1hVerdict.reason);
      } else {
        // Optional: log near-miss pump-1h evaluations for calibration. Only log
        // when change1h is meaningful (≥5%) to avoid flooding the log with
        // routine ticks that are nowhere near triggering.
        if (snap.change1h !== null && snap.change1h >= 5) {
          this.recordPump1hDispatch(now, input, false, pump1hVerdict.reason, false, "not_triggered");
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
    pump1h: {
      evaluated: number;
      triggered: number;
      dispatched: number;
      skippedKillswitch: number;
      skippedHourlyCap: number;
    };
    pendingFiltered: number;
    pendingFastPath: number;
    pendingEarlyDispatch: number;
    pendingSlowDown: number;
    pendingPump1h: number;
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
      pump1h: {
        evaluated: this.pump1hEvaluated,
        triggered: this.pump1hTriggered,
        dispatched: this.pump1hDispatched,
        skippedKillswitch: this.pump1hSkippedKillswitch,
        skippedHourlyCap: this.pump1hSkippedHourlyCap,
      },
      pendingFiltered: this.pendingFiltered.length,
      pendingFastPath: this.pendingFastPath.length,
      pendingEarlyDispatch: this.pendingEarlyDispatch.length,
      pendingSlowDown: this.pendingSlowDown.length,
      pendingPump1h: this.pendingPump1h.length,
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
   * PUMP-1H DETECTOR (NEW 2026-05-03) — dispatch a pump-1h BUY.
   *
   * Pre-checks (ordered):
   *   1. Killswitch — if WORKER_PUMP1H_BUY_ENABLED=false, log near-miss and return.
   *      Safety: this is the master switch to disable pump-1h dispatches in
   *      production while the detector is still being calibrated.
   *   2. In-flight — same in-flight Set as early_pump (single source of truth
   *      across all detector dispatches; prevents double-BUY of any kind).
   *   3. Hourly cap — atomic counter at WORKER_PUMP1H_HOURLY_COUNTER_KEY with
   *      hour-bucket key and 1h TTL. Permissive cap of 5/h (test calibration).
   *   4. Per-asset throttle — 60min cooldown via WORKER_PUMP1H_DISPATCHED_KEY_PREFIX
   *      (keyed per symbol). Longer than early_pump's 30min because pump-1h
   *      pumps last longer and we should not multi-buy the same asset.
   *   5. Blacklist — same shared blacklist as early_pump (account_not_available, etc.).
   *
   * If all pre-checks pass, dispatches via dispatchEntry with signalType="pump1h".
   * The Vercel entry.ts side recognizes this signalType and stores the trade
   * with type="opportunity-pump1h" so fast-exit-evaluator routes the position
   * to the dedicated pump-1h exit thresholds (fast_tp +15%, ratchet 5pt fixed).
   */
  private async tryDispatchPump1h(c: MomentumCandidate, pump1hReason: string): Promise<void> {
    const symbol = c.symbol;
    const now = Date.now();

    // 1. Killswitch — log near-miss but DO NOT dispatch
    if (!WORKER_PUMP1H_BUY_ENABLED) {
      this.pump1hSkippedKillswitch++;
      this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, "killswitch_disabled");
      logger.info("Pump-1h dispatch SKIPPED — killswitch disabled", {
        symbol, reason: pump1hReason,
      });
      return;
    }

    // 2. In-flight (shared Set across early/pump1h to prevent double-BUY)
    if (this.inFlightDispatches.has(symbol)) {
      this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, "in_flight");
      return;
    }
    this.inFlightDispatches.add(symbol);

    try {
      // 3. Hourly cap (atomic check via Redis bucketed counter)
      const hourBucket = Math.floor(now / (60 * 60 * 1000));
      const counterKey = `${WORKER_PUMP1H_HOURLY_COUNTER_KEY}:${hourBucket}`;
      const currentCount = (await redisGet<number>(counterKey)) ?? 0;
      if (currentCount >= WORKER_PUMP1H_HOURLY_CAP) {
        this.pump1hSkippedHourlyCap++;
        this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, `hourly_cap:${currentCount}/${WORKER_PUMP1H_HOURLY_CAP}`);
        logger.info("Pump-1h dispatch SKIPPED — hourly cap reached", {
          symbol, currentCount, cap: WORKER_PUMP1H_HOURLY_CAP,
        });
        return;
      }

      // 4. Per-asset throttle (60min cooldown)
      const throttleKey = `${WORKER_PUMP1H_DISPATCHED_KEY_PREFIX}${symbol}`;
      const lastDispatchedAt = await redisGet<number>(throttleKey);
      if (lastDispatchedAt && (now - lastDispatchedAt) < WORKER_PUMP1H_THROTTLE_MS) {
        const remainingMin = Math.ceil((WORKER_PUMP1H_THROTTLE_MS - (now - lastDispatchedAt)) / 60000);
        this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, `throttle:per_asset:${remainingMin}min`);
        logger.info("Pump-1h dispatch SKIPPED — per-asset throttle", {
          symbol, remainingMin,
        });
        return;
      }

      // 5. Blacklist (shared with early_pump and classical paths)
      const blacklistCheck = await isBlacklisted(symbol);
      if (blacklistCheck.blacklisted) {
        this.dispatchPreCheckFailed.blacklist++;
        this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, `blacklist:${blacklistCheck.reason}`);
        logger.info("Pump-1h dispatch SKIPPED — blacklisted", {
          symbol, reason: blacklistCheck.reason,
        });
        return;
      }

      // All pre-checks passed — dispatch
      this.dispatchAttempted++;
      this.pump1hDispatched++;
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
        // Sub-minute deltas (informative for entry.ts logging, not required for pump1h decision)
        change30s: c.change30s,
        change1min: c.change1min,
        change2min: c.change2min,
      } as DispatchSignal;
      const result = await dispatchEntry(signal);

      if (result.ok) {
        this.dispatchOk++;
        // Update Redis counters AFTER successful dispatch (avoid burning the
        // hourly slot on failed dispatches like blacklist hits or 5xx errors).
        try {
          await redisSet(counterKey, currentCount + 1, { ex: 60 * 60 });  // 1h TTL
          await redisSet(throttleKey, now, { ex: 2 * 60 * 60 });  // 2h TTL (covers throttle window with margin)
        } catch (err) {
          logger.warn("Pump-1h counter update failed (non-fatal)", { symbol, err: (err as Error).message });
        }
      }
      else if (result.skipped) this.dispatchSkipped++;
      else if (result.error) this.dispatchNetworkError++;
      else this.dispatchHttpError++;

      this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, true);
    } catch (err) {
      logger.error("tryDispatchPump1h threw", { symbol, err: (err as Error).message });
      this.recordPump1hDispatch(now, this.candidateToInput(c), true, pump1hReason, false, `exception:${(err as Error).message}`);
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
    let dispatchSource: string | undefined;  // PUMP-1H DETECTOR (2026-05-03)
    if (this.positions) {
      const pos = this.positions.updatePriceForSymbol(symbol, snap.currentPrice);
      if (!pos) return;  // not held according to positions tracker
      pnlPct = pos.pnlPct;
      avgBuyPrice = pos.avgBuyPrice;
      dispatchSource = pos.dispatchSource;  // PUMP-1H DETECTOR (2026-05-03) — route exit thresholds
    } else {
      // Legacy fallback path (kept for backwards compat — should not be used
      // in production once worker-index passes positions to the constructor).
      const legacyAvg = await this.getAvgBuyPrice(symbol);
      if (legacyAvg == null || legacyAvg <= 0) return;
      avgBuyPrice = legacyAvg;
      pnlPct = ((snap.currentPrice - avgBuyPrice) / avgBuyPrice) * 100;
      // dispatchSource undefined → uses standard sub-min thresholds
    }

    const verdict = evaluateSlowDownExit({
      pnlPct,
      change30s: snap.change30s,
      change1min: snap.change1min,
      change2min: snap.change2min,
      dispatchSource,  // PUMP-1H DETECTOR (2026-05-03) — router for exit thresholds
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
      parisTime: formatParisTime(ts),
      decision: dispatched ? "dispatched" : `skipped:${dispatchSkipReason ?? "no_reason"}`,
      severity: "early",
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
      parisTime: formatParisTime(ts),
      decision: dispatched ? `dispatched:${reasonCode}` : `skipped:${dispatchSkipReason ?? "no_reason"}`,
      severity: "exit",
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

  // BACKLOG-3 phase 4 (2026-05-03) — recordDetected was removed (deduplicated
  // into recordFastPath). The two methods produced strictly identical event
  // sets. fastpath_log is now the canonical detection event log.

  /**
   * PUMP-1H DETECTOR (NEW 2026-05-03) — log buffer entry for pump1h_dispatch_log.
   * Mirrors recordEarlyDispatch shape (just with isPump1h instead of isEarly,
   * and severity sentinel "pump1h").
   */
  private recordPump1hDispatch(
    ts: number,
    input: ClassifyInput,
    isPump1h: boolean,
    reason: string,
    dispatched: boolean,
    dispatchSkipReason?: string,
  ): void {
    this.pendingPump1h.push({
      ts,
      parisTime: formatParisTime(ts),
      decision: dispatched ? "dispatched" : `skipped:${dispatchSkipReason ?? "no_reason"}`,
      severity: "pump1h",
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
      isPump1h,
      reason,
      dispatched,
      dispatchSkipReason,
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
   * BACKLOG-3 phase 1 — fast-path evaluation log (now canonical detection event log).
   * Calls the pure evaluator from signal-rules.ts and buffers the result for periodic flush.
   *
   * BACKLOG-3 phase 4 (2026-05-03) — Enriched with parisTime/severity/decision/reason
   * annotations so debug-export's projectDryrunEntry produces non-null values for
   * downstream analysis. Without these, the 1000+ entries returned were essentially
   * empty shells (numeric metrics only, no labels).
   */
  private recordFastPath(ts: number, c: MomentumCandidate): void {
    const verdict = evaluateFastPathCandidate(c);
    // Decision is what the fast-path verdict said: "qualified" if it would have fired
    // in production, "observed" otherwise (still useful for retrospective calibration).
    const decision = verdict.wouldFireMajor
      ? "fastpath_qualified_major"
      : verdict.wouldFireStrong
        ? "fastpath_qualified_strong"
        : verdict.wouldFilterDead
          ? "fastpath_filtered_dead"
          : "fastpath_observed";
    // Reason: short human-readable summary. Capped to 120 chars (matching projectDryrunEntry).
    const reason = verdict.reasons.length > 0
      ? verdict.reasons.join("; ").slice(0, 120)
      : `${c.signalType}/${c.severity}${c.triggerSource ? `@${c.triggerSource}` : ""}`;
    this.pendingFastPath.push({
      ts,
      parisTime: formatParisTime(ts),
      severity: c.severity,        // top-level mirror of classicalSeverity for projectDryrunEntry
      decision,
      reason,
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
   * Flush pending log entries to Redis.
   *
   * BACKLOG-3 phase 4 (2026-05-03) — Migrated from JSON-blob (GET → merge → SET)
   * to Redis LIST (LPUSH + LTRIM). The blob pattern was O(N) per flush which became
   * unworkable at MAX_LOG_ENTRIES = 50000 (5 MB re-serialized every 5s). With LIST,
   * each flush is 2 round-trips per log key regardless of total list size.
   *
   * Failure semantics: on LPUSH failure we re-queue locally, exactly like before.
   * LTRIM failure is non-fatal (next flush will trim correctly).
   */
  private async flushLogs(): Promise<void> {
    // BACKLOG-13 phase 1.B (2026-04-30): short-circuit when nothing to flush.
    // Saves Redis commands every 5s during quiet periods.
    if (
      this.pendingFiltered.length === 0 &&
      this.pendingFastPath.length === 0 &&
      this.pendingEarlyDispatch.length === 0 &&
      this.pendingSlowDown.length === 0 &&
      this.pendingPump1h.length === 0
    ) {
      return;
    }

    const filteredToFlush = this.pendingFiltered.splice(0);
    const fastPathToFlush = this.pendingFastPath.splice(0);
    const earlyToFlush = this.pendingEarlyDispatch.splice(0);
    const slowDownToFlush = this.pendingSlowDown.splice(0);
    const pump1hToFlush = this.pendingPump1h.splice(0);

    if (filteredToFlush.length > 0) {
      const ok = await redisLpush(FILTERED_LOG_KEY, filteredToFlush);
      if (ok) {
        await redisLtrim(FILTERED_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
      } else {
        this.pendingFiltered.unshift(...filteredToFlush);
      }
    }

    if (fastPathToFlush.length > 0) {
      const ok = await redisLpush(FASTPATH_LOG_KEY, fastPathToFlush);
      if (ok) {
        await redisLtrim(FASTPATH_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
      } else {
        this.pendingFastPath.unshift(...fastPathToFlush);
      }
    }

    if (earlyToFlush.length > 0) {
      const ok = await redisLpush(EARLY_DISPATCH_LOG_KEY, earlyToFlush);
      if (ok) {
        await redisLtrim(EARLY_DISPATCH_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
      } else {
        this.pendingEarlyDispatch.unshift(...earlyToFlush);
      }
    }

    if (slowDownToFlush.length > 0) {
      const ok = await redisLpush(SLOW_DOWN_DISPATCH_LOG_KEY, slowDownToFlush);
      if (ok) {
        await redisLtrim(SLOW_DOWN_DISPATCH_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
      } else {
        this.pendingSlowDown.unshift(...slowDownToFlush);
      }
    }

    // PUMP-1H DETECTOR (NEW 2026-05-03)
    if (pump1hToFlush.length > 0) {
      const ok = await redisLpush(PUMP1H_DISPATCH_LOG_KEY, pump1hToFlush);
      if (ok) {
        await redisLtrim(PUMP1H_DISPATCH_LOG_KEY, 0, MAX_LOG_ENTRIES - 1);
      } else {
        this.pendingPump1h.unshift(...pump1hToFlush);
      }
    }
  }
}