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

// BACKLOG-3 phase 3 (2026-05-02) — Scan-side volume sanity ceiling.
// Coinbase API has been observed returning corrupt volume24h values:
//   - MOG: 2.68e18 (raw token units without decimals normalization)
//   - NOICE: $18.9B (still unrealistic for a microcap, dispatched 2026-05-01 → -$11.44 loss)
// We reject any alt_pump candidate above this ceiling. BTC's legitimate daily volume
// peaks around $50-100B but BTC pumps go through the dedicated BTC-pump path (not alt_pump),
// so a $100B ceiling for altcoins is comfortable yet still catches obvious corruption.
export const ALT_PUMP_MAX_VOLUME_USD = 100_000_000_000; // $100B

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

// ─── EARLY ENTRY sub-1min (BACKLOG-3 phase 2 — 2026-05-01) ─────────────────────
// Detects pumps EARLIER than the classical 5m/15m/1h windows allow.
// Rationale: post-mortem of 16 altcoin trades showed 15/16 entered at <2% from
// the 60min max → systematic "late entry". The 5m/15m windows fire at the
// END of the pump curve, not at its start. Sub-minute deltas catch the
// early ramp-up phase BEFORE the 5m window has time to register the move.
//
// Activation rule: change30s ≥ 1.0% AND change2min ≥ 2.0% AND change5m < 4.0%
//                  AND volume24h ≥ $1M AND drawdownFromPeak > -2% AND !isHeld.
// The "change5m < 4%" cap is critical — it ensures we're EARLY and not just
// duplicating the classical pumpdetection.
export const EARLY_ENTRY_MIN_CHANGE30S = 1.0;       // %, last 30 seconds
export const EARLY_ENTRY_MIN_CHANGE2MIN = 2.0;      // %, last 2 minutes
// BACKLOG-3 phase 3 (2026-05-02) — Anti "isolated candle" filter.
// When change30s, change1min and change2min are all within EPS of each other,
// it means the entire price move happened in the last ~30 seconds and the
// minutes preceding the entry were flat. Empirical observation on 24h of
// production data: 5/5 such trades were losses (LA, STRK, DRIFT, FIGHT, QI).
// These are typically isolated buy-pressure spikes that revert, not the start
// of a sustained pump (which produces a CRESCENDO pattern instead).
//
// Filter formula: reject if |change30s - change2min| < EARLY_ENTRY_ISOLATED_EPS.
// 0.1 is robust to rounding artifacts but selective enough to keep real
// crescendo signals (BOBBOB had 30s=1.45, 2m=2.20, diff=0.75 → kept).
export const EARLY_ENTRY_ISOLATED_EPS = 0.1;        // %-points
export const EARLY_ENTRY_MAX_CHANGE5M = 4.0;        // %, must NOT have triggered classical paths
export const EARLY_ENTRY_MIN_VOLUME_24H = 1_000_000;// $, no shitcoins
// BACKLOG-3 phase 3 (2026-05-02) — Sanity ceiling on volume24h.
// Coinbase API occasionally returns corrupt volume values:
//   - MOG: 2.68e18 (raw token units, missing decimals normalization)
//   - NOICE: 1.89e10 = $18.9B (still unrealistic for a microcap)
// Empirical max observed on legitimate altcoin signals over 24h: ~$1.25B (QI).
// $5B gives a comfortable 4× safety margin while rejecting both bug patterns.
// Note: this only applies to early-entry evaluation (worker side, microcap-targeted).
// Scan side keeps a more permissive 100B ceiling to allow BTC-sized assets.
export const EARLY_ENTRY_MAX_VOLUME_24H = 5_000_000_000; // $5B
export const EARLY_ENTRY_MIN_DRAWDOWN_PCT = -2.0;   // %, recent peak still close
export const EARLY_ENTRY_MIN_CHANGE1H = -3.0;       // %, no dead-cat-bounce

// ─── PUMP-1H ENTRY (NEW 2026-05-03) ───────────────────────────────────────────
// Detects sustained pumps (30-60min duration) that the EARLY_ENTRY path rejects.
// Rationale: the EARLY_ENTRY filter "change5m < 4%" rejects assets that have
// already moved 5%+ in the last 5min, even when they're in the middle of a
// long pump that will continue. Empirical example: TROLL on 2026-05-03 made
// +69% in 24h but was rejected 949 times in 15min by the worker because
// change5m was 4-7% (queue of pump in worker's view, not the start). Result:
// missed the entire pump.
//
// Strategy: a SECOND, ADDITIVE detection path that targets pumps already in
// progress (visible on 1h window) but still climbing (positive on 5m window).
// This is NOT a replacement for EARLY_ENTRY — it captures a different pump
// regime (sustained vs flash). The two paths run in parallel and are NEVER
// in conflict (a candidate either matches the early-flash pattern OR the
// sustained-pump pattern, but rarely both due to the change5m thresholds).
//
// Activation rule: change1h ≥ 10% AND change15m ≥ 4% AND change5m ≥ 0%
//                  AND volume24h ∈ [$1M, $5B] AND drawdownFromPeak > -5% AND !isHeld.
//
// Why these thresholds:
//   - change1h ≥ 10% : strong sustained move on the 1h window (avoids small drifts)
//   - change15m ≥ 4% : confirmed momentum on the 15min window (not a 1h artifact)
//   - change5m ≥ 0%  : NOT in retracement at the moment of entry (avoids buying tops)
//   - drawdown > -5% : tolerate slightly more drawdown than EARLY (-2%) since pump is older
//
// Cap & throttle: 5/h hourly cap (permissive for initial calibration), 60min
// per-asset throttle (vs 30min for EARLY because pump-1h pumps last longer
// and we should not multi-buy the same asset within one pump cycle).
//
// Exit rules: dispatched with type="opportunity-pump1h" so fast-exit-evaluator
// can apply DEDICATED thresholds (fast_tp +15%, ratchet drawdown 5pt fixed)
// instead of the sub-min thresholds (fast_tp +5%, asymmetric ratchet).
//
// Killswitch: WORKER_PUMP1H_BUY_ENABLED env var (default false until validated
// on 20+ samples). When false, evaluatePump1hEntry returns isPump1h=false
// with reason="killswitch_disabled".
export const PUMP1H_MIN_CHANGE1H = 10.0;           // %, sustained 1h move required
export const PUMP1H_MIN_CHANGE15M = 4.0;           // %, confirmed 15min momentum
export const PUMP1H_MIN_CHANGE5M = 0.0;            // %, NOT currently retracing
export const PUMP1H_MIN_VOLUME_24H = 1_000_000;    // $, same minimum as EARLY
export const PUMP1H_MAX_VOLUME_24H = 5_000_000_000; // $5B, same sanity ceiling as EARLY
export const PUMP1H_MIN_DRAWDOWN_PCT = -5.0;       // %, more permissive than EARLY (-2%)

// ─── SLOW DOWN EXIT sub-1min (BACKLOG-3 phase 2 — 2026-05-01) ──────────────────
// Sells when the pump is still positive but the velocity is collapsing.
// Rationale: waiting for change30s ≤ 0% means we already lost 0.5-1% from the
// peak. Detecting velocity decay (vitesse_30s < 0.5 × vitesse_2m) catches the
// inflection BEFORE the actual reversal. Net: capture more of the pump's gain.
//
// All three velocities computed as %/sec from the corresponding window:
//   v30s = change30s / 30,  v1m = change1min / 60,  v2m = change2min / 120.
//
// SLOW_DOWN trigger: pnlPct ≥ 2.0% AND change30s > 0 AND v30s < 0.5*v2m AND v30s < v1m.
// FAST_TP        : pnlPct ≥ 5.0%
// FAST_SL        : change30s ≤ -1.0% AND pnlPct ≥ -3.0% (catches violent reversals before stop_loss kicks in)
export const SLOW_DOWN_MIN_PNL_PCT = 2.0;           // pnl_pct gross threshold (≈ +1.5% net after 0.5% round-trip fees)
export const SLOW_DOWN_VELOCITY_RATIO = 0.5;        // v30s / v2m must be below this
export const FAST_TP_PNL_PCT = 5.0;                 // pnl_pct that triggers immediate take-profit
export const FAST_SL_CHANGE30S_PCT = -1.0;          // change30s that triggers safety stop
export const FAST_SL_MIN_PNL_PCT = -3.0;            // only fire fast_sl if pnl is not already disaster

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
  signalType: "alt_pump" | "major_crash" | "major_pump" | "position_crash" | "early_pump";
  severity: "weak" | "strong" | "major";
  isHeld: boolean;
  drawdownFromPeak: number;
  peakSampleCount: number;
  // Which classification branch fired this candidate. Useful in logs to distinguish
  // signals that came from the 5m vs 15m vs 1h windows. Null for non-altpump signals
  // (crashes, position_crash, major_pump on BTC) where the source is implicit.
  // BACKLOG-3 phase 2 (2026-05-01): "30s" added for early_pump dispatches by the WS worker.
  triggerSource: "5m" | "15m" | "1h" | "30s" | null;
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
  | "amplitude_low_major_no1h"
  // BACKLOG-3 phase 3 (2026-05-02) — Coinbase volume24h sanity ceiling rejections
  | "corrupt_volume_5m"
  | "corrupt_volume_15m"
  | "corrupt_volume_1h";

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
    if (volume24h >= ALT_PUMP_MAX_VOLUME_USD) return { kind: "skip", reason: "corrupt_volume_5m" };
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
    if (volume24h >= ALT_PUMP_MAX_VOLUME_USD) return { kind: "skip", reason: "corrupt_volume_15m" };
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
    if (volume24h >= ALT_PUMP_MAX_VOLUME_USD) return { kind: "skip", reason: "corrupt_volume_1h" };
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
  | "dead_position_exit"
  | "fast_slow_down"     // BACKLOG-3 phase 2 — sub-1min velocity decay exit
  | "fast_tp"            // BACKLOG-3 phase 2 — sub-1min take-profit at +5%
  | "fast_sl";           // BACKLOG-3 phase 2 — sub-1min safety stop on violent reversal

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
// ═════ EARLY ENTRY SUB-1MIN (fonction pure — BACKLOG-3 phase 2) ═══════════════
// 2026-05-01 — Détection précoce des pumps via les fenêtres sub-minute, AVANT que
// les fenêtres classiques (5m/15m/1h) ne signalent. Catch les ramps-up à T+30-60s
// au lieu de T+5-10min, où les seuils classiques détectent typiquement le SOMMET.

export interface EarlyEntryResult {
  /** Le candidate doit être dispatché en early-pump */
  isEarly: boolean;
  /** Tag explicatif pour les logs */
  reason: string;
}

/**
 * Évalue si un tick correspond à un démarrage précoce de pump.
 *
 * NE TIENT PAS COMPTE DU CLASSIFY CLASSIQUE — cette fonction est appelée
 * indépendamment, après que classifySignal() a renvoyé "no_signal" ou "skip".
 * Si elle déclenche, on synthétise un MomentumCandidate de type "early_pump"
 * qui sera dispatché en fast-path direct (pas d'appel Claude).
 *
 * Pure : aucun I/O, pas de Redis, pas de fetch.
 *
 * Conditions (toutes doivent être vraies) :
 *   - change30s ≥ EARLY_ENTRY_MIN_CHANGE30S          (1.0%)
 *   - change2min ≥ EARLY_ENTRY_MIN_CHANGE2MIN        (2.0%)
 *   - change5m  <  EARLY_ENTRY_MAX_CHANGE5M          (4.0%)  ← critique : on est EARLY
 *   - volume24h ≥ EARLY_ENTRY_MIN_VOLUME_24H         ($1M)
 *   - drawdownFromPeak > EARLY_ENTRY_MIN_DRAWDOWN_PCT (-2%)
 *   - change1h > EARLY_ENTRY_MIN_CHANGE1H             (-3%, anti dead-cat-bounce)
 *   - !isHeld
 */
export function evaluateEarlyEntry(input: ClassifyInput): EarlyEntryResult {
  const {
    change30s, change2min, change5m, change1h, volume24h, isHeld, drawdownFromPeak, symbol,
  } = input;

  // Stables and majors never qualify (defensive — should be filtered upstream too)
  if (STABLES.has(symbol) || MAJORS.has(symbol)) {
    return { isEarly: false, reason: "stable_or_major" };
  }
  if (isHeld) {
    return { isEarly: false, reason: "already_held" };
  }
  if (change30s == null || change2min == null) {
    return { isEarly: false, reason: "no_sub_minute_data" };
  }
  if (volume24h < EARLY_ENTRY_MIN_VOLUME_24H) {
    return { isEarly: false, reason: `low_volume:${(volume24h / 1_000_000).toFixed(2)}M` };
  }
  // Sanity: reject corrupt volume payloads (cf. MOG $2.68e18, NOICE $18.9B bug).
  // Tightened from $100B to $5B (2026-05-02): empirical max on legit signals = ~$1.25B.
  if (volume24h >= EARLY_ENTRY_MAX_VOLUME_24H) {
    return { isEarly: false, reason: `corrupt_volume:${(volume24h / 1_000_000_000).toFixed(1)}B` };
  }
  if (drawdownFromPeak <= EARLY_ENTRY_MIN_DRAWDOWN_PCT) {
    return { isEarly: false, reason: `drawdown_too_deep:${drawdownFromPeak.toFixed(1)}%` };
  }
  if (change1h !== null && change1h <= EARLY_ENTRY_MIN_CHANGE1H) {
    return { isEarly: false, reason: `dead_cat_bounce:c1h=${change1h.toFixed(1)}%` };
  }
  // The "EARLY" gate: must NOT have already triggered classical paths
  if (change5m !== null && change5m >= EARLY_ENTRY_MAX_CHANGE5M) {
    return { isEarly: false, reason: `not_early:c5m=${change5m.toFixed(1)}%` };
  }
  // Core trigger
  if (change30s < EARLY_ENTRY_MIN_CHANGE30S) {
    return { isEarly: false, reason: `slow_30s:${change30s.toFixed(2)}%` };
  }
  if (change2min < EARLY_ENTRY_MIN_CHANGE2MIN) {
    return { isEarly: false, reason: `slow_2m:${change2min.toFixed(2)}%` };
  }

  // BACKLOG-3 phase 3 (2026-05-02) — Anti "isolated candle" guard.
  // If change30s ≈ change2min (within EARLY_ENTRY_ISOLATED_EPS), the move is
  // confined to the last 30 seconds and the preceding 90s were flat. Empirically:
  // 5/5 such trades on 24h of production data were losses (LA/STRK/DRIFT/FIGHT/QI).
  // True crescendo pumps show change30s noticeably different from change2min
  // (BOBBOB 30s=1.45, 2m=2.20 → kept; STRK 30s=2.56, 2m=2.56 → rejected).
  if (Math.abs(change30s - change2min) < EARLY_ENTRY_ISOLATED_EPS) {
    return {
      isEarly: false,
      reason: `isolated_candle:30s=${change30s.toFixed(2)}%≈2m=${change2min.toFixed(2)}%`,
    };
  }

  return {
    isEarly: true,
    reason: `early_pump: 30s=${change30s.toFixed(2)}% 2m=${change2min.toFixed(2)}% 5m=${change5m?.toFixed(2) ?? "n/a"}%`,
  };
}

// ═════ PUMP-1H ENTRY (NEW 2026-05-03) ═════════════════════════════════════════
// Sustained-pump detector. Additive to evaluateEarlyEntry — runs in parallel,
// catches pumps that EARLY_ENTRY rejects due to change5m ≥ 4% filter.
// See PUMP1H_* constants block above for full rationale.

export interface Pump1hEntryResult {
  /** Le candidate doit être dispatché en pump-1h */
  isPump1h: boolean;
  /** Tag explicatif pour les logs */
  reason: string;
}

/**
 * Évalue si un tick correspond à un pump 1h en cours qui mérite une entrée.
 *
 * Pure : aucun I/O, pas de Redis, pas de fetch. Le caller (worker) gère
 * killswitch (WORKER_PUMP1H_BUY_ENABLED), throttle per-asset, hourly cap.
 *
 * Conditions (toutes doivent être vraies) :
 *   - change1h  ≥ PUMP1H_MIN_CHANGE1H        (10%)
 *   - change15m ≥ PUMP1H_MIN_CHANGE15M       (4%)
 *   - change5m  ≥ PUMP1H_MIN_CHANGE5M        (0%, n'est PAS en retracement)
 *   - volume24h ∈ [PUMP1H_MIN_VOLUME_24H, PUMP1H_MAX_VOLUME_24H]
 *   - drawdownFromPeak > PUMP1H_MIN_DRAWDOWN_PCT (-5%)
 *   - !isHeld
 *
 * NB: pas de check anti-isolated-candle car le pattern est différent
 * (isolated-candle est un signal sub-minute qui ne s'applique pas à 1h).
 *
 * NB2: pas de check change30s/change1m/change2min — un pump-1h peut être
 * détecté même si la dernière minute est calme (consolidation intra-pump).
 * Le risque est contrebalancé par le fait que change5m ≥ 0% garantit qu'on
 * n'achète pas dans une chute brutale.
 */
export function evaluatePump1hEntry(input: ClassifyInput): Pump1hEntryResult {
  const {
    change5m, change15m, change1h, volume24h, isHeld, drawdownFromPeak, symbol,
  } = input;

  // Stables and majors never qualify (defensive)
  if (STABLES.has(symbol) || MAJORS.has(symbol)) {
    return { isPump1h: false, reason: "stable_or_major" };
  }
  if (isHeld) {
    return { isPump1h: false, reason: "already_held" };
  }
  // Volume sanity
  if (volume24h < PUMP1H_MIN_VOLUME_24H) {
    return { isPump1h: false, reason: `low_volume:${(volume24h / 1_000_000).toFixed(2)}M` };
  }
  if (volume24h >= PUMP1H_MAX_VOLUME_24H) {
    return { isPump1h: false, reason: `corrupt_volume:${(volume24h / 1_000_000_000).toFixed(1)}B` };
  }
  // Drawdown — more permissive than EARLY (-5% vs -2%) because pumps that have
  // run for 30-60min legitimately have larger drawdowns from their peak
  if (drawdownFromPeak <= PUMP1H_MIN_DRAWDOWN_PCT) {
    return { isPump1h: false, reason: `drawdown_too_deep:${drawdownFromPeak.toFixed(1)}%` };
  }
  // Required windows must exist (1h and 15m are mandatory for this detector)
  if (change1h === null) {
    return { isPump1h: false, reason: "no_1h_data" };
  }
  if (change15m === null) {
    return { isPump1h: false, reason: "no_15m_data" };
  }
  if (change5m === null) {
    return { isPump1h: false, reason: "no_5m_data" };
  }
  // Core triggers
  if (change1h < PUMP1H_MIN_CHANGE1H) {
    return { isPump1h: false, reason: `weak_1h:c1h=${change1h.toFixed(1)}%` };
  }
  if (change15m < PUMP1H_MIN_CHANGE15M) {
    return { isPump1h: false, reason: `weak_15m:c15m=${change15m.toFixed(1)}%` };
  }
  if (change5m < PUMP1H_MIN_CHANGE5M) {
    return { isPump1h: false, reason: `retracing_5m:c5m=${change5m.toFixed(1)}%` };
  }

  return {
    isPump1h: true,
    reason: `pump1h: 1h=${change1h.toFixed(1)}% 15m=${change15m.toFixed(1)}% 5m=${change5m.toFixed(1)}%`,
  };
}

// ═════ SLOW-DOWN EXIT SUB-1MIN (fonction pure — BACKLOG-3 phase 2) ════════════
// 2026-05-01 — Sortie sur décélération du pump (vitesse instantanée chute) plutôt
// que sur retournement (prix qui baisse). Évite de "rendre" 0.5-1% au marché en
// attendant la confirmation de la baisse.

export interface SlowDownExitContext {
  /** PnL gross actuel (current/avgBuy - 1) × 100, en % */
  pnlPct: number;
  /** Variations sub-minute du tick courant */
  change30s: number | null;
  change1min: number | null;
  change2min: number | null;
}

export interface SlowDownExitVerdict {
  reasonCode: "fast_slow_down" | "fast_tp" | "fast_sl";
  /** Détails pour les logs (vitesses, ratios) */
  detail: string;
}

/**
 * Évalue trois règles d'exit sub-1min sur une position détenue :
 *   1. fast_tp        — pnl ≥ +5% → take-profit immédiat (priorité 1)
 *   2. fast_sl        — change30s ≤ -1% ET pnl ≥ -3% → safety stop avant fast_stop_loss (priorité 2)
 *   3. fast_slow_down — pnl ≥ +2% ET change30s > 0 ET v30s < 0.5×v2m ET v30s < v1m (priorité 3)
 *
 * Returns null si aucune règle ne déclenche.
 *
 * Pure : aucun I/O. Le caller (worker WS) appelle cette fonction à chaque tick
 * d'un asset qu'on tient, avec le pnlPct calculé à partir du prix courant et de
 * l'avgBuyPrice (lus depuis trade_meta côté worker, ou depuis Redis).
 */
export function evaluateSlowDownExit(ctx: SlowDownExitContext): SlowDownExitVerdict | null {
  const { pnlPct, change30s, change1min, change2min } = ctx;

  // Need sub-minute data to reason about velocity
  if (change30s == null || change1min == null || change2min == null) {
    return null;
  }

  // Rule 1: fast_tp — take-profit at +5% gross (≈ +4.5% net after fees)
  if (pnlPct >= FAST_TP_PNL_PCT) {
    return {
      reasonCode: "fast_tp",
      detail: `pnl=${pnlPct.toFixed(2)}% ≥ ${FAST_TP_PNL_PCT}%`,
    };
  }

  // Rule 2: fast_sl — violent reversal sub-1min, sortie d'urgence avant que fast_stop_loss
  // (qui a besoin de change1h ≤ -8% AND pnl ≤ -10%) ne kicke. Sauve typiquement 5-7 points
  // de perte sur les retournements brutaux.
  if (change30s <= FAST_SL_CHANGE30S_PCT && pnlPct >= FAST_SL_MIN_PNL_PCT) {
    return {
      reasonCode: "fast_sl",
      detail: `change30s=${change30s.toFixed(2)}% ≤ ${FAST_SL_CHANGE30S_PCT}%, pnl=${pnlPct.toFixed(2)}%`,
    };
  }

  // Rule 3: fast_slow_down — pump still positive but velocity collapsing
  if (pnlPct < SLOW_DOWN_MIN_PNL_PCT) {
    return null;  // not enough cushion to lock in
  }
  if (change30s <= 0) {
    return null;  // already turning negative — fast_sl branch handles violent cases, otherwise
                  // we fall back to existing fast-exit rules (ratchet, dead_position_exit)
  }

  // Velocities in %/sec
  const v30s = change30s / 30;
  const v1m  = change1min / 60;
  const v2m  = change2min / 120;

  // Avoid division-by-zero / pathological cases
  if (v2m <= 0) return null;

  const ratio = v30s / v2m;
  const decelerating = (v30s < v1m);
  const speedHalved  = (ratio < SLOW_DOWN_VELOCITY_RATIO);

  if (speedHalved && decelerating) {
    return {
      reasonCode: "fast_slow_down",
      detail: `pnl=${pnlPct.toFixed(2)}% v30s=${(v30s * 100).toFixed(3)}%/s v2m=${(v2m * 100).toFixed(3)}%/s ratio=${ratio.toFixed(2)}`,
    };
  }

  return null;
}