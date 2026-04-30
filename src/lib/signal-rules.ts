// ─────────────────────────────────────────────────────────────────────────────
// signal-rules.ts — Module canonique des règles de détection et fast-exit
// ─────────────────────────────────────────────────────────────────────────────
// Ce fichier centralise TOUTES les constantes de seuils ET la logique pure de
// classification des signaux + évaluation des règles fast-exit. Extrait de
// scan.ts pour être partagé avec le worker WebSocket (fursat-ws-detector).
//
// Règle de modification : tout changement de seuil ou de logique de signal DOIT
// passer par ce fichier. Ne jamais réintroduire de constantes ou de logique de
// classification dans scan.ts ou ailleurs — sinon les deux univers (Vercel scan
// et worker WS) divergeront silencieusement.
//
// Toutes les fonctions exportées ici sont PURES (pas d'I/O, pas de Redis, pas
// de fetch). Elles prennent des inputs déjà résolus et retournent des verdicts.
// ─────────────────────────────────────────────────────────────────────────────

// ═════ CONSTANTES — SEUILS DE DÉTECTION ALT_PUMP ═════════════════════════════

// Pump altcoin thresholds — 1h window (legacy signal, still useful as fallback)
export const ALT_PUMP_PCT_1H_WEAK = 8;     // +8% / 1h  → FAIBLE
export const ALT_PUMP_PCT_1H_STRONG = 12;  // +12% / 1h → FORT
export const ALT_PUMP_PCT_1H_MAJOR = 20;   // +20% / 1h → MAJEUR
export const ALT_PUMP_PCT_4H = 15;         // +15% / 4h → signal confirmé

// Pump altcoin thresholds — 15min window
// 2026-04-23: STRONG 6→4, MAJOR 10→8
// 2026-04-24 evening: STRONG 4→5 — observed false positives (SEAM, faux pump) at 4%. Raising
// slightly trades a few missed mini-pumps for better signal quality. A pump that can't sustain
// 5% over 15 min is probably noise.
export const ALT_PUMP_PCT_15M_WEAK = 3;     // kept for reference, weak signals are skipped anyway
export const ALT_PUMP_PCT_15M_STRONG = 5;   // was 4 (2026-04-23), was 6 (original)
export const ALT_PUMP_PCT_15M_MAJOR = 8;
export const MIN_VOLUME_FOR_15M_SIGNAL = 1_000_000;

// Pump altcoin thresholds — 5min window (NEW 2026-04-24 evening)
// Designed to catch explosive pumps earlier than the 15min signal. With scan now running every
// 1 minute, we have snapshots at tight granularity so a "5 min ago" reference is reliable
// (tolerance ±30s). This fires typically at T+3-5 min into a pump vs T+5-8 min for the 15min
// signal — a real gain on fast pumps like TROLL (14h45 pump start, bought 15h08 at peak with
// current code; 5m signal would have fired around 14h50).
// Volume requirement is strict ($2M) because noise-to-signal ratio is worse on short windows.
//
// 2026-04-25: STRONG 2→3, MAJOR 4→5. Observed 24h of live data:
// the original 2%/5min threshold fired on noise (MEZO 2.1%, BICO 2.7%, RLS 2.2%, RAVE 2.4%,
// IRYS 3.6%, HIGH 5.1%, FORT 3.0%, SPK 2.4%) — most of which entered, stagnated, and were
// liquidated by dead_position_exit at small losses. The cumulative drag was significant.
// 3% over 5min (0.6%/min) is a more honest "acceleration" threshold; below that, it's drift.
// Trade-off: we'll miss some genuine but mild early pumps. Acceptable: the 15m signal at 5%
// will catch them 5-10 min later if they sustain.
export const ALT_PUMP_PCT_5M_STRONG = 3;    // was 2 (2026-04-24)
export const ALT_PUMP_PCT_5M_MAJOR = 5;     // was 4 (2026-04-24)
export const MIN_VOLUME_FOR_5M_SIGNAL = 2_000_000;

// Cumulative run-up guard (added 2026-04-24): if the 4h change is already very high, the pump
// is likely in its late phase and entering now means catching the top. We reject any alt_pump
// signal where change4h exceeds this threshold, regardless of the 15m/1h trigger magnitude.
// Rationale: ESP was bought at 08:40 after climbing since 05:00 (change4h was ~+15-20% at
// entry time); this filter would have skipped that entry.
// Only applied when change4h is available (enough history). If change4h can't be computed,
// we pass through — no data means no filter.
export const MAX_CUMULATIVE_RUNUP_4H_PCT = 12;

// ─── Mature pump filter (NEW 2026-04-26) ───
// Rejects signals where the 1h move is significant but the 15m portion is low — i.e. the pump
// is mostly behind us. The ratio (change15m / change1h) measures "what fraction of the 1h move
// happened in the last 15 minutes". A low ratio means the pump is digested/stalling.
// Example case TRAC: change1h=+25.8%, change15m=+1.1% → ratio 0.043 → SKIP (pump mature).
// Only applied when change1h ≥ MATURE_PUMP_MIN_1H_PCT (otherwise the ratio isn't meaningful).
// Threshold 0.3 means: if less than 30% of the 1h move happened in the last 15 min, skip.
export const MATURE_PUMP_MIN_1H_PCT = 15;        // below this, signal not strong enough for the filter to apply
export const MATURE_PUMP_MAX_RATIO = 0.3;        // change15m / change1h < 0.3 → mature pump, skip

// ─── Amplitude minimum filter (NEW 2026-04-28 — modif #6) ───
// Rejects signals where the amplitude is too low to qualify as a real pump, especially when
// change1h is missing (assets too recently listed). The bug case LMTS (28/04 05:25): signal
// was MAJOR via 15m=8.6% but change1h=n/a (no 1h history available). Bought at the absolute
// peak, position immediately dropped to -9%.
//
// Three checks:
//   1. STRONG signals: require either change1h ≥ 8% (1h confirmation) OR change5m ≥ 6% (strong micro).
//      This eliminates AVNT-like cases (15m=4.9%, 1h=5.8% → micro-volatility, not a real pump).
//   2. MAJOR signals: tolerant on amplitude (15m≥8 already qualifies), but require change1h be
//      computable (not null). LMTS pattern would have been skipped: 1h=null → no recent listing trades.
//   3. Asset listed too recently (no 1h history) → SKIP regardless of severity.
//      Initiates the 1h history but doesn't trade this cycle.
export const AMPLITUDE_MIN_1H_PCT_STRONG = 8;        // STRONG needs change1h ≥ 8% as one validation path
export const AMPLITUDE_MIN_5M_PCT_STRONG = 6;        // OR change5m ≥ 6% (very strong micro-burst)

// ═════ FAST-PATH SUB-MINUTE — LOG-ONLY OBSERVATION (NEW 2026-04-30) ══════════
// BACKLOG-3 étape 1 : observation des candidats fast-path basés sur change1min,
// pour calibrer empiriquement Y_STRONG, Y_MAJOR (déclenchement) et X_MIN (filtre)
// avant d'activer en production.
//
// ATTENTION — Ces seuils sont des VALEURS NOMINALES initiales, PAS calibrées.
// Ils servent à logger des candidats hypothétiques pour 24-48h d'observation.
// Ne pas les utiliser pour activer un déclenchement réel sans calibration.
//
// Logique nominale :
//   Y_STRONG = +2.0% sur change1min  → fast-path STRONG candidat
//   Y_MAJOR  = +3.5% sur change1min  → fast-path MAJOR candidat
//   X_MIN    = +0.3% sur change1min  → veto "pump mort" sur signaux STRONG/MAJOR classiques
//
// Pré-conditions communes au déclenchement :
//   - volume24h >= $1M (pas de nano-cap)
//   - change5m < 4% (pump pas encore "mature")
//   - change1h > -3% (pas de rebond après dump)
//   - !isHeld (pas déjà détenu)
export const FASTPATH_LOG_STRONG_CHANGE1MIN = 2.0;
export const FASTPATH_LOG_MAJOR_CHANGE1MIN = 3.5;
export const FASTPATH_LOG_FILTER_DEAD_CHANGE1MIN = 0.3;
export const FASTPATH_LOG_MIN_VOLUME_24H = 1_000_000;
export const FASTPATH_LOG_MAX_CHANGE5M = 4.0;
export const FASTPATH_LOG_MIN_CHANGE1H = -3.0;

// ═════ CONSTANTES — SEUILS DE CRASH / MAJORS ═════════════════════════════════

// Crash thresholds on open positions (altcoins held in portfolio)
export const POS_CRASH_PCT_1H = -10;

// Crash thresholds on BTC/ETH (defensive signals — always priority)
export const MAJOR_CRASH_PCT_1H = -5;
export const MAJOR_PUMP_PCT_1H = 5;

export const MIN_SIGNAL_VOLUME_USD = 500_000;

// ═════ CONSTANTES — FAST-EXIT RULES ══════════════════════════════════════════
// Rules applied to agent "opportunity" positions on every scan cycle.
// Purely deterministic, no Claude involvement. Each rule triggers a SELL.
//
// Rule 1 — Fast stop-loss: catches fast crashes before MANAGE cycle reaches them.
//   Trigger: change1h < -8% AND PnL ≤ -10%
//
// Rule 1.5 (NEW 2026-04-26) — Fast partial take-profit: secures 50% of position when PnL
// reaches +12% for the first time. Designed to capture profit on short-lived pumps where
// the position never has the chance to be assessed by MANAGE (which runs every 30+ min).
// Once partial taken, a flag is set in Redis so this rule doesn't re-trigger on the same
// position. The remaining 50% stays under fast_ratchet protection.
//   Trigger: PnL ≥ +12% AND not previously partial-taken on this position
//
// Rule 2 — Fast ratchet: captures retracements from a profit peak.
//   Trigger: PnL_max ≥ +8% AND PnL ≤ PnL_max - drawdown_pts
//   2026-04-26: drawdown_pts is now ASYMMETRIC:
//     - 3 pts if PnL_max < +15%   (tighter — we want to lock in early gains quickly)
//     - 5 pts if PnL_max ≥ +15%   (looser — let big winners run further)
//
// Rule 3 — Fast exit-on-green: liberate capital on positions that recovered to slight profit
//   after a loss. Only on older positions with meaningful value.
//   Trigger: PnL ≥ +1% AND PnL_min ≤ -2% AND age ≥ 24h AND value ≥ $50
export const FAST_EXIT_STOP_LOSS_CHANGE1H = -8;
export const FAST_EXIT_STOP_LOSS_PNL = -10;
export const FAST_PARTIAL_TAKE_PNL = 12;          // PnL ≥ +12% triggers partial take
export const FAST_PARTIAL_TAKE_RATIO = 0.5;       // SELL 50% of available (legacy default)
// 2026-04-30: Dynamic partial-take ratio — adapt to pnlPct at trigger time.
// On explosive pumps where pnlPct ≥ +20% when partial fires (rare with old fenetres,
// expected to become common with sub-minute detection), we lock in MORE of the gain
// because the pump is likely near peak. The remaining 25% is still under ratchet
// protection in case the pump continues higher.
// Examples observed nuit du 30/04:
//   L3 #1: partial fired at pnlPct=28.25% → with new logic, 75% sold = $87 secured (vs $58 with 50%).
//   IDEX: partial fired at pnlPct=14.5% → unchanged, 50% sold (pump still active).
export const FAST_PARTIAL_TAKE_EXPLOSIVE_PNL_THRESHOLD = 20;  // pnlPct ≥ this → switch to higher ratio
export const FAST_PARTIAL_TAKE_RATIO_EXPLOSIVE = 0.75;        // SELL 75% on explosive pumps
export const FAST_EXIT_RATCHET_PNL_MAX_TRIGGER = 8;
export const FAST_EXIT_RATCHET_DRAWDOWN_PTS_LOW = 3;     // pnl_max < 15 → drawdown 3 pts
export const FAST_EXIT_RATCHET_DRAWDOWN_PTS_HIGH = 5;    // pnl_max ≥ 15 → drawdown 5 pts
export const FAST_EXIT_RATCHET_ASYMMETRIC_THRESHOLD = 15; // pnl_max threshold for switching low→high
export const FAST_EXIT_GREEN_PNL = 1;
export const FAST_EXIT_GREEN_PNL_MIN = -2;
export const FAST_EXIT_GREEN_MIN_AGE_MS = 24 * 60 * 60 * 1000;  // 24h
export const FAST_EXIT_GREEN_MIN_VALUE_USD = 50;

// Rule 4 — Fast dead-position exit (NEW 2026-04-24 evening)
// Targets positions that were bought on a pump signal but haven't moved significantly after
// ~1h. Rationale: if a pump didn't materialize within an hour of entry, the momentum is dead
// and the position is more likely to dump than to recover. Better to exit flat than wait for
// the drawdown. Observed cases: TROLL (15h08 buy), ZKP (14h02 buy), SEAM (14h24 buy) —
// all bought near peak, stagnated, then dumped.
// Trigger: age ∈ [45min, 2h] AND |PnL| ≤ 3% AND |change30min of price| ≤ 2%
// The double bound (age window) avoids firing too early (pre-judging a pump that's still forming)
// and too late (other rules should have fired by then, this is a safety net).
export const FAST_EXIT_DEAD_MIN_AGE_MS = 45 * 60 * 1000;   // 45 min
export const FAST_EXIT_DEAD_MAX_AGE_MS = 2 * 60 * 60 * 1000;  // 2h
export const FAST_EXIT_DEAD_PNL_BAND = 3;       // |PnL| ≤ 3%
export const FAST_EXIT_DEAD_CHANGE30M_BAND = 2; // |change30min| ≤ 2%

// Rule 1.7 — Fast no-pump exit (NEW 2026-04-29)
// Targets positions that were bought on a pump signal but the pump never materialized:
// PnL_max never reached even +2%, position is in (slight) loss, and we've waited long enough
// to be confident the pump is dead.
// This fills the "dead zone" between fast_stop_loss (-10% threshold) and dead_position_exit
// (±3% PnL band): a position drifting at -3% to -7% with no upward movement.
// Trigger: age ∈ [30min, 90min] AND pnl_max < +2% AND PnL ≤ 0%
// Rationale: with the WS worker dispatching fast, our detection is sub-minute. If a position
// hasn't shown momentum within 30min of entry, it's a failed entry — cut losses early
// rather than wait for fast_stop_loss at -10%.
// Priority 1.7: between fast_partial_take (1.5) and fast_ratchet (2).
export const FAST_EXIT_NO_PUMP_MIN_AGE_MS = 30 * 60 * 1000;   // 30 min
export const FAST_EXIT_NO_PUMP_MAX_AGE_MS = 90 * 60 * 1000;   // 90 min (then dead_position_exit takes over from 45 to 120, with overlap)
export const FAST_EXIT_NO_PUMP_PNL_MAX_THRESHOLD = 2;         // pnl_max < +2% = position never tried to pump
export const FAST_EXIT_NO_PUMP_PNL_THRESHOLD = 0;             // PnL ≤ 0% = position is flat or in loss

// ═════ CONSTANTES — ASSET CLASSIFICATION ═════════════════════════════════════

export const STABLES = new Set(["USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "GUSD", "PYUSD", "FRAX", "EURC"]);
export const MAJORS = new Set(["BTC", "ETH"]);

// ═════ TYPES PARTAGÉS ════════════════════════════════════════════════════════

export interface MomentumCandidate {
  symbol: string;
  currentPrice: number;
  // Sub-minute observability windows (NEW 2026-04-30 — log-only for BACKLOG-3 phase A)
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change4h: number | null;
  change24h: number;
  volume24h: number;
  score: number;
  signalType: "alt_pump" | "major_crash" | "major_pump" | "position_crash";
  severity: "weak" | "strong" | "major";
  isHeld: boolean;
  drawdownFromPeak: number;
  peakSampleCount: number;
  // Which classification branch fired this candidate. Useful in logs to distinguish
  // signals that came from the 5m vs 15m vs 1h windows. Null for non-altpump signals
  // (crashes, position_crash, major_pump on BTC) where the source is implicit.
  triggerSource: "5m" | "15m" | "1h" | null;
}

// Agent position with enough context to evaluate fast-exit rules.
export interface AgentPosition {
  symbol: string;
  units: number;              // available units
  currentPrice: number;
  avgBuyPrice: number;        // from trade_meta OR fallback from Coinbase orders history
  buyTimestamp: number;       // from trade_meta OR fallback: latest BUY order time
  pnlPct: number;             // computed here
  valueUSD: number;           // units * currentPrice
  source: "trade_meta" | "legacy_orders";  // which path populated avgBuyPrice/buyTimestamp
}

// ═════ CLASSIFICATION DES SIGNAUX (fonction pure) ════════════════════════════

/**
 * Input pour classifySignal — toutes les données nécessaires déjà résolues
 * par l'appelant (changes calculés, peak/drawdown calculé, etc.).
 */
export interface ClassifyInput {
  symbol: string;
  currentPrice: number;
  // Sub-minute observability windows (NEW 2026-04-30 — log-only for BACKLOG-3 phase A)
  // Optional because scan.ts (polling 1min) cannot compute these — only the WS worker can.
  // When absent, candidates will have null values for these fields (no impact on classification).
  change30s?: number | null;
  change1min?: number | null;
  change2min?: number | null;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change4h: number | null;
  change24h: number;
  volume24h: number;
  isHeld: boolean;
  isMajor: boolean;
  drawdownFromPeak: number;     // negative if below peak, 0 or positive if at/above
  peakSampleCount: number;
}

/**
 * Reasons for skipping a signal at classification time.
 * Used both as filter telemetry counters AND for explainability.
 */
export type SkipReason =
  | "no_signal"                    // no threshold crossed
  | "volume_5m"
  | "volume_15m"
  | "volume_1h"
  | "drawdown_5m"
  | "drawdown_15m"
  | "drawdown_1h"
  | "runup_4h_5m"
  | "runup_4h_15m"
  | "runup_4h_1h"
  | "mature_pump_5m"
  | "mature_pump_15m"
  | "mature_pump_1h"
  | "amplitude_low_5m"
  | "amplitude_low_15m"
  | "amplitude_low_major_no1h";

/**
 * Output: either a classified candidate, or a structured skip with reason.
 * The skip variant carries the detail needed for telemetry (mature_pump symbols,
 * filter branch counters, etc.) so callers can aggregate without re-running logic.
 */
export type ClassifyResult =
  | { kind: "candidate"; candidate: MomentumCandidate }
  | {
      kind: "skip";
      reason: SkipReason;
      // Detail populated for mature_pump (used by maturePumpFiltered telemetry).
      // Other reasons leave this null.
      maturePumpDetail?: {
        branch: "5m" | "15m" | "1h";
        change15m: number;
        change1h: number;
        ratio: number;
      };
    };

/**
 * Classifies an asset's price changes into a signal candidate, applying ALL
 * filters (volume, drawdown, runup_4h, mature_pump, amplitude_low). Pure
 * function: no I/O, deterministic given inputs.
 *
 * Mirrors EXACTLY the priority chain in scan.ts:
 *   1. major_crash (BTC/ETH change1h ≤ -5%)
 *   2. position_crash (held altcoin change1h ≤ -10%)
 *   3. major_pump (BTC change1h ≥ +5%)
 *   4. alt_pump via 5m branch (change5m ≥ 3%, full filter set)
 *   5. alt_pump via 15m branch (change15m ≥ 5%, full filter set)
 *   6. alt_pump via 1h branch (change1h ≥ 8%, partial filter set — no amplitude_low)
 *
 * Score is computed inline (severityWeight × log10(volume) × heldBoost).
 */
export function classifySignal(input: ClassifyInput): ClassifyResult {
  const {
    symbol, currentPrice,
    change5m, change15m, change1h, change4h, change24h,
    volume24h, isHeld, isMajor, drawdownFromPeak, peakSampleCount,
  } = input;
  // Optional sub-minute fields — default to null if caller didn't provide them
  // (e.g. scan.ts polling 1min has no access to sub-minute granularity).
  const change30s = input.change30s ?? null;
  const change1min = input.change1min ?? null;
  const change2min = input.change2min ?? null;

  // Drawdown guard threshold depends on how many samples we have in the 2h peak window.
  // < 3 samples → no guard (not enough data); 3-5 samples → -3%; ≥ 6 samples → -1.5%.
  let drawdownThreshold: number | null;
  if (peakSampleCount >= 6) drawdownThreshold = -1.5;
  else if (peakSampleCount >= 3) drawdownThreshold = -3;
  else drawdownThreshold = null;

  let signalType: MomentumCandidate["signalType"] | null = null;
  let severity: MomentumCandidate["severity"] | null = null;
  let triggerSource: MomentumCandidate["triggerSource"] = null;

  // ─── Priority 1: BTC/ETH crash ───
  if (isMajor && change1h !== null && change1h <= MAJOR_CRASH_PCT_1H) {
    signalType = "major_crash";
    severity = change1h <= MAJOR_CRASH_PCT_1H * 2 ? "major" : "strong";
  }
  // ─── Priority 2: held altcoin position crash ───
  else if (isHeld && !isMajor && change1h !== null && change1h <= POS_CRASH_PCT_1H) {
    signalType = "position_crash";
    severity = change1h <= POS_CRASH_PCT_1H * 1.5 ? "major" : "strong";
  }
  // ─── Priority 3: BTC pump ───
  else if (symbol === "BTC" && change1h !== null && change1h >= MAJOR_PUMP_PCT_1H) {
    signalType = "major_pump";
    if (change1h >= MAJOR_PUMP_PCT_1H * 2) severity = "major";
    else if (change1h >= MAJOR_PUMP_PCT_1H * 1.4) severity = "strong";
    else severity = "weak";
  }
  // ─── Priority 3.2: alt_pump via 5m (earliest detection) ───
  else if (!isMajor && change5m !== null && change5m >= ALT_PUMP_PCT_5M_STRONG) {
    if (volume24h < MIN_VOLUME_FOR_5M_SIGNAL) return { kind: "skip", reason: "volume_5m" };
    if (drawdownThreshold !== null && drawdownFromPeak <= drawdownThreshold) return { kind: "skip", reason: "drawdown_5m" };
    if (change4h !== null && change4h > MAX_CUMULATIVE_RUNUP_4H_PCT) return { kind: "skip", reason: "runup_4h_5m" };
    // Mature pump filter: only meaningful when change1h is significant.
    if (change1h !== null && change1h >= MATURE_PUMP_MIN_1H_PCT
        && change15m !== null && change15m > 0
        && (change15m / change1h) < MATURE_PUMP_MAX_RATIO) {
      return {
        kind: "skip",
        reason: "mature_pump_5m",
        maturePumpDetail: { branch: "5m", change15m, change1h, ratio: change15m / change1h },
      };
    }
    // Amplitude minimum filter (modif #6, 2026-04-28)
    const isMajor5m = change5m >= ALT_PUMP_PCT_5M_MAJOR;
    if (change1h === null) {
      return { kind: "skip", reason: isMajor5m ? "amplitude_low_major_no1h" : "amplitude_low_5m" };
    }
    if (!isMajor5m
        && change1h < AMPLITUDE_MIN_1H_PCT_STRONG
        && change5m < AMPLITUDE_MIN_5M_PCT_STRONG) {
      return { kind: "skip", reason: "amplitude_low_5m" };
    }
    signalType = "alt_pump";
    triggerSource = "5m";
    severity = isMajor5m ? "major" : "strong";
  }
  // ─── Priority 3.5: alt_pump via 15m (fallback if 5m missed edge or volume<$2M) ───
  else if (!isMajor && change15m !== null && change15m >= ALT_PUMP_PCT_15M_STRONG) {
    if (volume24h < MIN_VOLUME_FOR_15M_SIGNAL) return { kind: "skip", reason: "volume_15m" };
    if (drawdownThreshold !== null && drawdownFromPeak <= drawdownThreshold) return { kind: "skip", reason: "drawdown_15m" };
    if (change4h !== null && change4h > MAX_CUMULATIVE_RUNUP_4H_PCT) return { kind: "skip", reason: "runup_4h_15m" };
    if (change1h !== null && change1h >= MATURE_PUMP_MIN_1H_PCT
        && (change15m / change1h) < MATURE_PUMP_MAX_RATIO) {
      return {
        kind: "skip",
        reason: "mature_pump_15m",
        maturePumpDetail: { branch: "15m", change15m, change1h, ratio: change15m / change1h },
      };
    }
    const isMajor15m = change15m >= ALT_PUMP_PCT_15M_MAJOR;
    if (change1h === null) {
      return { kind: "skip", reason: isMajor15m ? "amplitude_low_major_no1h" : "amplitude_low_15m" };
    }
    if (!isMajor15m && change1h < AMPLITUDE_MIN_1H_PCT_STRONG) {
      return { kind: "skip", reason: "amplitude_low_15m" };
    }
    signalType = "alt_pump";
    triggerSource = "15m";
    severity = isMajor15m ? "major" : "strong";
  }
  // ─── Priority 4: alt_pump via 1h (slow-burn pumps) ───
  else if (!isMajor && change1h !== null && change1h >= ALT_PUMP_PCT_1H_WEAK) {
    if (volume24h < MIN_SIGNAL_VOLUME_USD) return { kind: "skip", reason: "volume_1h" };
    if (drawdownThreshold !== null && drawdownFromPeak <= drawdownThreshold) return { kind: "skip", reason: "drawdown_1h" };
    if (change4h !== null && change4h > MAX_CUMULATIVE_RUNUP_4H_PCT) return { kind: "skip", reason: "runup_4h_1h" };
    if (change1h >= MATURE_PUMP_MIN_1H_PCT
        && change15m !== null
        && (change15m / change1h) < MATURE_PUMP_MAX_RATIO) {
      return {
        kind: "skip",
        reason: "mature_pump_1h",
        maturePumpDetail: { branch: "1h", change15m, change1h, ratio: change15m / change1h },
      };
    }
    signalType = "alt_pump";
    triggerSource = "1h";
    if (change1h >= ALT_PUMP_PCT_1H_MAJOR) severity = "major";
    else if (change1h >= ALT_PUMP_PCT_1H_STRONG) severity = "strong";
    else severity = "weak";
  }

  if (!signalType || !severity) {
    return { kind: "skip", reason: "no_signal" };
  }

  // Score: severityWeight × log10(volume) × heldBoost
  const severityWeight = severity === "major" ? 100 : severity === "strong" ? 50 : 10;
  const volumeScore = Math.log10(Math.max(volume24h, 1));
  const heldBoost = isHeld && (signalType === "position_crash" || signalType === "major_crash") ? 2 : 1;
  const score = severityWeight * volumeScore * heldBoost;

  const candidate: MomentumCandidate = {
    symbol, currentPrice,
    change30s, change1min, change2min,
    change5m, change15m, change1h, change4h, change24h,
    volume24h,
    score, signalType, severity, isHeld,
    drawdownFromPeak, peakSampleCount, triggerSource,
  };
  return { kind: "candidate", candidate };
}

// ═════ FAST-EXIT EVALUATION (fonction pure) ══════════════════════════════════

export type FastExitReason =
  | "fast_stop_loss"
  | "fast_partial_take"
  | "fast_no_pump_exit"
  | "fast_ratchet"
  | "fast_exit_on_green"
  | "dead_position_exit";

/**
 * Context for evaluating fast-exit rules on a position.
 * All values are pre-resolved by the caller (Redis lookups, snapshot finds).
 */
export interface FastExitContext {
  pnlMax: number | undefined;        // from pnlMaxMap
  pnlMin: number | undefined;        // from pnlMinMap
  change1h: number | null;           // computed from snap1h
  change15m: number | null;          // computed from snap15m
  change30min: number | null;        // computed from snap30m
  partialTaken: boolean;             // whether partial-take has already fired on this position
  now: number;                       // Date.now() — for age computation
}

export interface FastExitVerdict {
  reasonCode: FastExitReason;
  priority: number;                  // lower = more urgent (1 = stop_loss, 4 = dead_position)
  sellRatio?: number;                // for partial takes (0.5 = 50%); omitted = 100%
  // Pass-through context for logging/dispatch payload
  change1h: number | null;
  change15m: number | null;
  change30min: number | null;
}

/**
 * Evaluates fast-exit rules on a single position. Returns the highest-priority
 * triggered rule, or null if no rule triggers. Pure function: no I/O.
 *
 * Priority order (mirrors scan.ts §0.5):
 *   1.   fast_stop_loss      (change1h < -8% AND PnL ≤ -10%)
 *   1.5  fast_partial_take   (PnL ≥ +12% AND not partial-taken)
 *   1.7  fast_no_pump_exit   (age ∈ [30min,90min] AND pnl_max < +2% AND PnL ≤ 0%)
 *   2.   fast_ratchet        (PnL_max ≥ +8% AND PnL ≤ PnL_max - drawdown_pts)
 *   3.   fast_exit_on_green  (PnL ≥ +1% AND PnL_min ≤ -2% AND age ≥ 24h AND value ≥ $50)
 *   4.   dead_position_exit  (age ∈ [45min,2h] AND |PnL| ≤ 3% AND |change30min| ≤ 2%)
 *
 * Caller is responsible for cooldown filtering (FAST_EXIT_COOLDOWN_MS) BEFORE
 * calling this function — that's an I/O concern (Redis read), not a pure rule.
 */
export function evaluateFastExitRules(
  position: AgentPosition,
  ctx: FastExitContext
): FastExitVerdict | null {
  const { pnlMax, pnlMin, change1h, change15m, change30min, partialTaken, now } = ctx;
  const ageMs = now - position.buyTimestamp;

  // Rule 1: FAST STOP-LOSS — most urgent, evaluated first
  if (change1h !== null
      && change1h < FAST_EXIT_STOP_LOSS_CHANGE1H
      && position.pnlPct <= FAST_EXIT_STOP_LOSS_PNL) {
    return { reasonCode: "fast_stop_loss", priority: 1, change1h, change15m, change30min };
  }

  // Rule 1.5: FAST PARTIAL TAKE — preemptive at +12%, before ratchet
  // Dynamic ratio (2026-04-30): on explosive pumps (pnlPct ≥ +20% at trigger), lock in 75%
  // instead of 50% — the pump is likely near peak and we want to secure more profit.
  if (position.pnlPct >= FAST_PARTIAL_TAKE_PNL && !partialTaken) {
    const sellRatio = position.pnlPct >= FAST_PARTIAL_TAKE_EXPLOSIVE_PNL_THRESHOLD
      ? FAST_PARTIAL_TAKE_RATIO_EXPLOSIVE
      : FAST_PARTIAL_TAKE_RATIO;
    return {
      reasonCode: "fast_partial_take", priority: 1.5,
      sellRatio,
      change1h, change15m, change30min,
    };
  }

  // Rule 1.7: FAST NO-PUMP EXIT — position never showed momentum, exit early
  // Fills the dead zone between fast_stop_loss (-10%) and dead_position_exit (±3% band).
  // If pnl_max never crossed +2% within 30-90min and we're flat-or-losing, the entry failed.
  if (pnlMax !== undefined
      && pnlMax < FAST_EXIT_NO_PUMP_PNL_MAX_THRESHOLD
      && position.pnlPct <= FAST_EXIT_NO_PUMP_PNL_THRESHOLD
      && ageMs >= FAST_EXIT_NO_PUMP_MIN_AGE_MS
      && ageMs <= FAST_EXIT_NO_PUMP_MAX_AGE_MS) {
    return { reasonCode: "fast_no_pump_exit", priority: 1.7, change1h, change15m, change30min };
  }

  // Rule 2: FAST RATCHET — asymmetric drawdown threshold
  if (pnlMax !== undefined && pnlMax >= FAST_EXIT_RATCHET_PNL_MAX_TRIGGER) {
    const drawdownPts = pnlMax >= FAST_EXIT_RATCHET_ASYMMETRIC_THRESHOLD
      ? FAST_EXIT_RATCHET_DRAWDOWN_PTS_HIGH
      : FAST_EXIT_RATCHET_DRAWDOWN_PTS_LOW;
    if (position.pnlPct <= (pnlMax - drawdownPts)) {
      return { reasonCode: "fast_ratchet", priority: 2, change1h, change15m, change30min };
    }
  }

  // Rule 3: FAST EXIT-ON-GREEN — recovered position, free up capital
  if (position.pnlPct >= FAST_EXIT_GREEN_PNL
      && pnlMin !== undefined && pnlMin <= FAST_EXIT_GREEN_PNL_MIN
      && ageMs >= FAST_EXIT_GREEN_MIN_AGE_MS
      && position.valueUSD >= FAST_EXIT_GREEN_MIN_VALUE_USD) {
    return { reasonCode: "fast_exit_on_green", priority: 3, change1h, change15m, change30min };
  }

  // Rule 4: DEAD POSITION EXIT — pump didn't materialize within 1h, exit flat
  if (ageMs >= FAST_EXIT_DEAD_MIN_AGE_MS
      && ageMs <= FAST_EXIT_DEAD_MAX_AGE_MS
      && Math.abs(position.pnlPct) <= FAST_EXIT_DEAD_PNL_BAND
      && change30min !== null
      && Math.abs(change30min) <= FAST_EXIT_DEAD_CHANGE30M_BAND) {
    return { reasonCode: "dead_position_exit", priority: 4, change1h, change15m, change30min };
  }

  return null;
}

// ═════ FAST-PATH SUB-MINUTE EVALUATION (LOG-ONLY, fonction pure) ═════════════
// BACKLOG-3 étape 1 (2026-04-30) — observation des candidats sub-minute pour
// calibration empirique avant activation. Voir constantes FASTPATH_LOG_* en
// haut du fichier pour les seuils nominaux et la logique.

export interface FastPathCandidate {
  /** Le signal aurait déclenché un fast-path STRONG (change1min ≥ FASTPATH_LOG_STRONG_CHANGE1MIN) */
  wouldFireStrong: boolean;
  /** Le signal aurait déclenché un fast-path MAJOR (change1min ≥ FASTPATH_LOG_MAJOR_CHANGE1MIN) */
  wouldFireMajor: boolean;
  /** Le signal classique STRONG/MAJOR aurait été filtré comme "pump mort" (change1min < FASTPATH_LOG_FILTER_DEAD_CHANGE1MIN) */
  wouldFilterDead: boolean;
  /** Tags explicatifs pour le log (debug/calibration) */
  reasons: string[];
}

/**
 * Évalue les candidats fast-path en mode LOG-ONLY.
 *
 * NE DÉCLENCHE RIEN. Cette fonction calcule uniquement ce qui SE SERAIT PASSÉ
 * si un système fast-path sub-minute était actif. Le résultat doit être loggé
 * (par exemple dans `dryrun:fastpath_log`) pour calibration empirique sur 24-48h.
 *
 * Fonction pure — pas d'I/O, pas de Redis, pas de fetch.
 *
 * Trois verdicts indépendants :
 *   - wouldFireStrong / wouldFireMajor : déclenchement hypothétique sur change1min
 *     ≥ seuil, sous réserve de pré-conditions (volume, pump non-mature, pas de
 *     rebond post-dump, pas déjà détenu).
 *   - wouldFilterDead : signal classique STRONG/MAJOR qui aurait été rejeté car
 *     change1min sous le seuil de vélocité minimum (pump déjà mort au dispatch).
 *
 * @param candidate Le candidat issu de classifySignal() — contient déjà change1min etc.
 * @returns Verdict avec les trois flags + tags explicatifs.
 */
export function evaluateFastPathCandidate(candidate: MomentumCandidate): FastPathCandidate {
  const { change1min, change5m, change1h, volume24h, isHeld, severity } = candidate;
  const reasons: string[] = [];
  let wouldFireStrong = false;
  let wouldFireMajor = false;
  let wouldFilterDead = false;

  // ─── Branche déclenchement STRONG/MAJOR (toutes pré-conditions doivent être vraies) ───
  if (change1min === null) {
    reasons.push("no_change1min");
  } else if (volume24h < FASTPATH_LOG_MIN_VOLUME_24H) {
    reasons.push("low_volume24h");
  } else if (change5m !== null && change5m >= FASTPATH_LOG_MAX_CHANGE5M) {
    reasons.push("pump_mature_5m");
  } else if (change1h !== null && change1h <= FASTPATH_LOG_MIN_CHANGE1H) {
    reasons.push("dead_cat_bounce");
  } else if (isHeld) {
    reasons.push("already_held");
  } else if (change1min >= FASTPATH_LOG_MAJOR_CHANGE1MIN) {
    wouldFireMajor = true;
    wouldFireStrong = true;
    reasons.push(`fire_major:c1m=${change1min.toFixed(2)}%`);
  } else if (change1min >= FASTPATH_LOG_STRONG_CHANGE1MIN) {
    wouldFireStrong = true;
    reasons.push(`fire_strong:c1m=${change1min.toFixed(2)}%`);
  } else {
    reasons.push(`below_strong:c1m=${change1min.toFixed(2)}%`);
  }

  // ─── Branche filtre "pump mort" (indépendante) ───
  // S'applique aux signaux classiques STRONG/MAJOR : si change1min est sous le seuil
  // de vélocité minimum, le pump est probablement déjà mort au moment du dispatch.
  if (
    (severity === "strong" || severity === "major")
    && change1min !== null
    && change1min < FASTPATH_LOG_FILTER_DEAD_CHANGE1MIN
  ) {
    wouldFilterDead = true;
    reasons.push(`filter_dead:c1m=${change1min.toFixed(2)}%`);
  }

  return { wouldFireStrong, wouldFireMajor, wouldFilterDead, reasons };
}