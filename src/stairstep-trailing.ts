// ─────────────────────────────────────────────────────────────────────────────
// stairstep-trailing.ts — Lot 3 V3 (2026-05-13)
// ─────────────────────────────────────────────────────────────────────────────
// Gestion complète des positions ouvertes par la stratégie V3 (stair_step).
// Tracker peak/trough en RAM, déclencher les SELL via /api/agent/sell-stairstep.
//
// LOGIQUE D'EXIT (par ordre de priorité décroissant) :
//
//   1. HARD STOP-LOSS — currentPnl ≤ -X% (default -8%)
//      • Reason : "stairstep_hard_sl"
//      • Validé statistiquement (analyse 13/05) : SL -8% préserve 91% de
//        l'espérance théorique tout en limitant la queue gauche (-26% max obs).
//
//   2. TRAILING — peak ≥ +1% AND currentPnl ≤ peak - 1pt
//      • Reason : "stairstep_trailing"
//      • Cas nominal : capture le pic du pump avec retracement modéré.
//
//   3. TIMEOUT NO PEAK — (now - buy) > 2h AND peak < +1%
//      • Reason : "stairstep_timeout_no_peak"
//      • La position "glisse" sans direction claire après 2h → on sort.
//
// CYCLE DE VIE :
//   - addPosition() appelé par stairstep-dispatcher après BUY confirmed Vercel
//   - evaluateTick() appelé par index.ts onTick (filtre fast si pas trackée)
//   - reconcileWithCoinbase() toutes les 60s : drop positions vendues ailleurs
//   - persistOpenPositions() : Redis hash stairstep:open_positions, throttle 30s
//   - loadFromRedis() au boot : reconstruction in-memory
//
// SAFETY :
//   - Inflight guard par symbole (interdit double SELL)
//   - SELL fail → garder en RAM, retry au prochain tick éligible
//   - Reconciliation 60s : drop si Coinbase n'a plus la balance
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisLpush, redisLtrim } from "./redis.js";
import type { PositionsTracker } from "./positions.js";

// ─── Env config (override possible via Railway env vars) ────────────────────

// Stop-loss dur en valeur absolue (positive). Default 8 = -8%.
// Validé statistiquement sur 512 trades V3 : préserve 91% de l'espérance.
const HARD_STOP_LOSS_PCT = Math.abs(parseFloat(process.env.STAIRSTEP_HARD_STOP_LOSS_PCT ?? "8"));

// Seuil minimum de peak pour activer le trailing. Sinon timeout 2h.
// 1.0 = peak doit atteindre +1% pour qu'on commence à trailler.
const MIN_PEAK_PCT = parseFloat(process.env.STAIRSTEP_MIN_PEAK_PCT ?? "1.0");

// Delta du trailing depuis le peak. 1.0 = exit si current ≤ peak - 1pt.
const TRAILING_DELTA_PCT = parseFloat(process.env.STAIRSTEP_TRAILING_DELTA_PCT ?? "1.0");

// Timeout pour les positions sans peak ≥ MIN_PEAK_PCT. Default 2h.
const TIMEOUT_NO_PEAK_MS = parseInt(
  process.env.STAIRSTEP_TIMEOUT_NO_PEAK_MS ?? String(2 * 3600 * 1000), 10
);

// 2026-05-16 BUG FIX — Timeout absolu (MAX_HOLD), indépendant du peak.
// Le timeout classique (TIMEOUT_NO_PEAK) ne déclenche QUE si la position n'a
// jamais atteint MIN_PEAK_PCT. Conséquence : une position qui touche +1.05%
// au tick 5min puis stagne devient immortelle, sortant en trailing seulement
// quand un retracement majeur (parfois -10 à -18%) le déclenche.
// Cas observé 15-16/05 sur FIS : positions de 166 min à 2930 min, sorties
// en trailing à -$9.65 ou pire à cause de slippage exécution sur thin orderbook.
// Le MAX_HOLD est un garde-fou : peu importe le peak, on coupe à T+MAX_HOLD.
// Default 4h : couvre 95% des cas V3 normaux (<2h), coupe les positions zombies.
const MAX_HOLD_MS = parseInt(
  process.env.STAIRSTEP_MAX_HOLD_MS ?? String(4 * 3600 * 1000), 10
);

// ─── Constantes Redis + intervalles ─────────────────────────────────────────

const OPEN_POSITIONS_KEY = "stairstep:open_positions";   // Hash: symbol → OpenPosition JSON
const TRADES_LOG_KEY = "stairstep:trades_log";           // List capped 1000 (logs côté worker)
const MAX_TRADES_LOG = 1000;

// Throttle persistance : on persiste une position au plus 1× / 30s
// (sauf updates significatives comme création / peak boost).
const PERSIST_THROTTLE_MS = 30_000;
const PEAK_DELTA_FOR_INSTANT_PERSIST = 0.5;  // si peak boost ≥ +0.5pp → persist immédiat

// Reconciliation Coinbase
const RECONCILE_INTERVAL_MS = 60_000;

// V3 (2026-05-13 hotfix) — Grace period anti-drop précoce.
// Bug d'origine : BNKR 16:52:10 BUY OK → 16:52:15 reconcile drop (Coinbase pas
// encore polled), 16:52:24 Positions refreshed confirme BNKR détenue → trop tard,
// déjà drop. Statistiquement ~50% des nouvelles positions étaient liquidées
// silencieusement du tracker dans la fenêtre [BUY, prochain poll Vercel].
// Solution : ne JAMAIS drop une position de moins de 90s (couvre poll 30s +
// confirmation Coinbase + marge). Au pire on garde une position fantôme 90s
// en RAM si elle a vraiment été annulée ailleurs — négligeable.
const RECONCILE_GRACE_MS = 90_000;

// Dispatch SELL
const FURSAT_API_BASE = (process.env.FURSAT_API_BASE ?? "https://www.fursat.net").replace(/\/$/, "");
const SELL_URL = `${FURSAT_API_BASE}/api/agent/sell-stairstep`;
const SELL_TIMEOUT_MS = 15_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OpenPosition {
  symbol: string;
  buyOrderId: string;
  buyTimestamp: number;
  avgBuyPrice: number;          // exec price reporté par Vercel
  sizingUsdc: number;
  // Tracker peak / trough depuis le BUY
  peakPnlPct: number;
  peakPriceAt: number;          // timestamp ms du peak observé
  peakPrice: number;
  troughPnlPct: number;
  troughPriceAt: number;
  // Dernier tick observé
  currentPnlPct: number;
  currentPrice: number;
  lastTickAt: number;
  // Persistance
  lastPersistedAt: number;
  lastPersistedPeakPnl: number;
}

type ExitReason = "stairstep_hard_sl" | "stairstep_trailing" | "stairstep_timeout_no_peak" | "stairstep_max_hold_timeout";

export class StairstepTrailing {
  private positions = new Map<string, OpenPosition>();
  private inflight = new Set<string>();    // symboles avec SELL en cours
  private positionsTracker: PositionsTracker;

  // Stats
  private stats_ = {
    positionsOpened: 0,
    positionsClosed: 0,
    sellsAttempted: 0,
    sellsOk: 0,
    sellsHttpError: 0,
    sellsNetworkError: 0,
    sellsByReason: {
      stairstep_hard_sl: 0,
      stairstep_trailing: 0,
      stairstep_timeout_no_peak: 0,
      stairstep_max_hold_timeout: 0,
    } as Record<ExitReason, number>,
    reconcileDropped: 0,    // positions droppées car Coinbase n'a plus la balance
    reconcileGraced: 0,     // V3 hotfix : positions épargnées par grace period (jeunes < 90s)
    reloadFromRedis: 0,
  };

  // Timer reconciliation
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(positionsTracker: PositionsTracker) {
    this.positionsTracker = positionsTracker;
  }

  /**
   * Boot : reload des positions depuis Redis (au cas où le worker a restarté
   * en plein milieu). Doit être appelé AVANT le wiring de evaluateTick.
   */
  async loadFromRedis(): Promise<void> {
    try {
      // HGETALL via REST API Upstash
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) {
        logger.warn("[stairstep-trailing] Upstash creds missing, skipping reload");
        return;
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["HGETALL", OPEN_POSITIONS_KEY]),
      });
      const data = await res.json() as { result?: string[] };
      const flat = data.result ?? [];
      // Upstash returns [field1, value1, field2, value2, ...] ou {field: value}
      // selon la version. On gère les deux cas.
      const entries: [string, string][] = [];
      if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
          if (typeof flat[i] === "string" && typeof flat[i+1] === "string") {
            entries.push([flat[i], flat[i+1]]);
          }
        }
      }
      let reloaded = 0;
      for (const [sym, payload] of entries) {
        try {
          const pos = JSON.parse(payload) as OpenPosition;
          if (pos && typeof pos.avgBuyPrice === "number" && pos.avgBuyPrice > 0) {
            this.positions.set(sym, pos);
            reloaded++;
          }
        } catch {/* skip malformed */}
      }
      this.stats_.reloadFromRedis = reloaded;
      logger.info("[stairstep-trailing] Loaded open positions from Redis", {
        reloaded, symbols: [...this.positions.keys()],
      });
    } catch (err) {
      logger.warn("[stairstep-trailing] loadFromRedis failed", {
        err: (err as Error).message,
      });
    }
  }

  /**
   * Démarre le timer de reconciliation Coinbase (toutes les 60s).
   */
  start(): void {
    this.reconcileTimer = setInterval(() => {
      void this.reconcileWithCoinbase();
    }, RECONCILE_INTERVAL_MS);
    logger.info("[stairstep-trailing] started", {
      hardStopLossPct: HARD_STOP_LOSS_PCT,
      minPeakPct: MIN_PEAK_PCT,
      trailingDeltaPct: TRAILING_DELTA_PCT,
      timeoutNoPeakMs: TIMEOUT_NO_PEAK_MS,
      maxHoldMs: MAX_HOLD_MS,
      reconcileIntervalMs: RECONCILE_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /**
   * Appelé par stairstep-dispatcher.ts quand Vercel confirme un BUY.
   * Crée la position en RAM + persist immédiat.
   */
  async addPosition(opts: {
    symbol: string;
    buyOrderId: string;
    avgBuyPrice: number;
    sizingUsdc: number;
  }): Promise<void> {
    const now = Date.now();
    const pos: OpenPosition = {
      symbol: opts.symbol,
      buyOrderId: opts.buyOrderId,
      buyTimestamp: now,
      avgBuyPrice: opts.avgBuyPrice,
      sizingUsdc: opts.sizingUsdc,
      peakPnlPct: 0,
      peakPriceAt: now,
      peakPrice: opts.avgBuyPrice,
      troughPnlPct: 0,
      troughPriceAt: now,
      currentPnlPct: 0,
      currentPrice: opts.avgBuyPrice,
      lastTickAt: now,
      lastPersistedAt: 0,
      lastPersistedPeakPnl: 0,
    };
    this.positions.set(opts.symbol, pos);
    this.stats_.positionsOpened++;
    logger.info("📥 STAIRSTEP position opened", {
      symbol: opts.symbol,
      avgBuyPrice: opts.avgBuyPrice,
      orderId: opts.buyOrderId,
      sizingUsdc: opts.sizingUsdc,
    });
    await this.persistPosition(pos, true);  // force persist on open
  }

  /**
   * Hook tick. Filtre rapide pour les symboles non-trackés (la majorité).
   * Quand un symbol est tracké, on update peak/trough et on évalue les
   * conditions d'exit.
   *
   * bestBid : sell-side price (préféré si disponible). Cohérent avec
   * fast-exit-evaluator (BACKLOG-3 phase 7) : évite les fantom spikes sur
   * thin orderbook altcoins.
   */
  evaluateTick(symbol: string, currentPrice: number, bestBid: number | null): void {
    const pos = this.positions.get(symbol);
    if (!pos) return;    // 99.9% des ticks short-circuit ici (fast path)

    // Skip si SELL inflight (évite double-fire)
    if (this.inflight.has(symbol)) return;

    const now = Date.now();
    // Use bestBid if available (real sell-side price), fallback to currentPrice.
    // Note: on n'utilise PAS currentPrice pour le PnL si bestBid disponible —
    // c'est la même décision que fast-exit-evaluator pour éviter les fantom
    // spikes sur thin orderbook (validé sur slippage pump1h 05/05).
    const effectivePrice = (bestBid && bestBid > 0) ? bestBid : currentPrice;
    const pnlPct = ((effectivePrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100;

    pos.currentPrice = effectivePrice;
    pos.currentPnlPct = pnlPct;
    pos.lastTickAt = now;

    // Update peak si nouveau max
    let peakBoosted = false;
    if (pnlPct > pos.peakPnlPct) {
      pos.peakPnlPct = pnlPct;
      pos.peakPriceAt = now;
      pos.peakPrice = effectivePrice;
      peakBoosted = true;
    }
    // Update trough si nouveau min
    if (pnlPct < pos.troughPnlPct) {
      pos.troughPnlPct = pnlPct;
      pos.troughPriceAt = now;
    }

    // ─── Conditions d'exit (ordre de priorité décroissant) ────────────────

    // 1. HARD STOP-LOSS (priorité max — catastrophe)
    if (pnlPct <= -HARD_STOP_LOSS_PCT) {
      void this.triggerSell(pos, "stairstep_hard_sl");
      return;
    }

    // 2. TRAILING — peak ≥ MIN_PEAK_PCT ET retracement ≥ TRAILING_DELTA_PCT
    if (pos.peakPnlPct >= MIN_PEAK_PCT && pnlPct <= pos.peakPnlPct - TRAILING_DELTA_PCT) {
      void this.triggerSell(pos, "stairstep_trailing");
      return;
    }

    // 3. TIMEOUT — durée > 2h ET peak n'a jamais atteint MIN_PEAK_PCT
    if (now - pos.buyTimestamp > TIMEOUT_NO_PEAK_MS && pos.peakPnlPct < MIN_PEAK_PCT) {
      void this.triggerSell(pos, "stairstep_timeout_no_peak");
      return;
    }

    // 4. MAX_HOLD — 2026-05-16 BUG FIX — garde-fou absolu, indépendant du peak.
    // Si une position a atteint peak ≥ MIN_PEAK_PCT mais ne déclenche jamais
    // le trailing (peak fictif sur tick bruyant, ou retracement trop progressif),
    // elle resterait immortelle. On coupe à T+MAX_HOLD_MS (default 4h) pour borner
    // la perte potentielle. Le SELL prendra le prix actuel, qui peut être négatif
    // mais sera presque toujours moins pire qu'attendre un trailing massif.
    if (now - pos.buyTimestamp > MAX_HOLD_MS) {
      void this.triggerSell(pos, "stairstep_max_hold_timeout");
      return;
    }

    // ─── Pas d'exit déclenché — persist si update significative ──────────
    if (peakBoosted && (pos.peakPnlPct - pos.lastPersistedPeakPnl) >= PEAK_DELTA_FOR_INSTANT_PERSIST) {
      logger.info("📈 STAIRSTEP peak boosted", {
        symbol: pos.symbol,
        peakPnl: pos.peakPnlPct.toFixed(2),
        currentPnl: pnlPct.toFixed(2),
      });
      void this.persistPosition(pos, true);
    } else if (now - pos.lastPersistedAt > PERSIST_THROTTLE_MS) {
      void this.persistPosition(pos, false);
    }
  }

  /**
   * Déclenche un SELL via /api/agent/sell-stairstep et nettoie la position
   * si succès. En cas d'échec : garde en RAM pour retry au prochain tick.
   */
  private async triggerSell(pos: OpenPosition, reason: ExitReason): Promise<void> {
    if (this.inflight.has(pos.symbol)) return;
    this.inflight.add(pos.symbol);
    this.stats_.sellsAttempted++;
    this.stats_.sellsByReason[reason]++;

    logger.info(`⚡ STAIRSTEP SELL TRIGGER ${reason}`, {
      symbol: pos.symbol,
      currentPnl: pos.currentPnlPct.toFixed(2),
      peakPnl: pos.peakPnlPct.toFixed(2),
      troughPnl: pos.troughPnlPct.toFixed(2),
      heldMinutes: ((Date.now() - pos.buyTimestamp) / 60_000).toFixed(1),
    });

    const cronSecret = process.env.CRON_SECRET ?? process.env.CRYPTO_AGENT_SECRET ?? "";
    if (!cronSecret) {
      logger.error("[stairstep-trailing] CRON_SECRET missing, cannot dispatch SELL");
      this.inflight.delete(pos.symbol);
      return;
    }

    const payload = {
      symbol: pos.symbol,
      reason,
      entryPrice: pos.avgBuyPrice,
      currentPrice: pos.currentPrice,
      peakPrice: pos.peakPrice,
      peakPnlPct: pos.peakPnlPct,
      currentPnlPct: pos.currentPnlPct,
      ts: Date.now(),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SELL_TIMEOUT_MS);
    let ok = false;
    let body: any = null;
    let httpStatus: number | null = null;

    try {
      const res = await fetch(SELL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cron-secret": cronSecret,
          "x-agent-secret": cronSecret,
          "x-source": "ws-worker",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      httpStatus = res.status;
      try { body = await res.json(); } catch {/* non-JSON */}
      ok = res.ok && body?.success === true;
    } catch (err) {
      clearTimeout(timeoutId);
      this.stats_.sellsNetworkError++;
      logger.warn("[stairstep-trailing] SELL dispatch failed", {
        symbol: pos.symbol, err: (err as Error).message,
      });
      this.inflight.delete(pos.symbol);
      return;
    }

    // ─ Append local log (sync best-effort) ───────────────────────────────
    void this.appendTradeLog({
      ts: Date.now(),
      action: "SELL",
      symbol: pos.symbol,
      reason,
      entryPrice: pos.avgBuyPrice,
      exitPrice: body?.avgSellPrice ?? null,
      orderId: body?.orderId ?? null,
      peakPnlPct: pos.peakPnlPct,
      troughPnlPct: pos.troughPnlPct,
      currentPnlPct: pos.currentPnlPct,
      realizedPnlPct: body?.realizedPnlPct ?? null,
      slippageExitPct: body?.slippageExitPct ?? null,
      heldMs: Date.now() - pos.buyTimestamp,
      httpStatus,
      ok,
    });

    if (ok) {
      this.stats_.sellsOk++;
      logger.info("✅ STAIRSTEP SELL OK", {
        symbol: pos.symbol,
        reason,
        realizedPnl: body?.realizedPnlPct?.toFixed(2) ?? "?",
        avgSellPrice: body?.avgSellPrice ?? "?",
      });
      this.positions.delete(pos.symbol);
      this.stats_.positionsClosed++;
      await this.deletePersistedPosition(pos.symbol);
    } else {
      // SELL fail OR Vercel reported success: false (e.g. PASSIVE_MODE, no_balance)
      // On garde la position en RAM pour retry au prochain tick éligible,
      // SAUF si reason = no_balance (la position n'existe plus Coinbase).
      const vercelReason = body?.reason ?? body?.error ?? "";
      if (typeof vercelReason === "string" && vercelReason.includes("no_balance")) {
        logger.warn("[stairstep-trailing] SELL no_balance — dropping from RAM", {
          symbol: pos.symbol,
        });
        this.positions.delete(pos.symbol);
        await this.deletePersistedPosition(pos.symbol);
      } else if (body?.passiveMode === true) {
        // PASSIVE_MODE : la position virtuelle reste, on simule un retry au tick suivant.
        // C'est utile pour dev/test mais en prod le SELL devrait passer.
        logger.warn("[stairstep-trailing] SELL passive_mode — keeping in RAM", {
          symbol: pos.symbol,
        });
      } else {
        this.stats_.sellsHttpError++;
        logger.warn("[stairstep-trailing] SELL fail, will retry next tick", {
          symbol: pos.symbol, vercelReason, httpStatus,
        });
      }
    }

    this.inflight.delete(pos.symbol);
  }

  /**
   * Reconciliation toutes les 60s : pour chaque position en RAM, check que
   * Coinbase a encore la balance. Si non → drop (vendu ailleurs).
   *
   * Aussi : alerte si Coinbase a une balance pour un symbole non-tracké (cas
   * extrêmement rare = restart corrompu OU position créée manuellement).
   * On NE prend PAS de position automatiquement pour de la prudence.
   */
  private async reconcileWithCoinbase(): Promise<void> {
    if (this.positions.size === 0) return;
    try {
      const heldSymbols = this.positionsTracker.getHeldSymbols();
      const now = Date.now();
      for (const [sym, pos] of [...this.positions.entries()]) {
        if (heldSymbols.has(sym)) continue;

        // V3 (2026-05-13 hotfix) — Grace period anti-drop précoce.
        // Une position fraîchement créée peut ne pas encore apparaître dans
        // heldSymbols (cache positions Vercel toutes les 30s vs BUY < 30s).
        // Cf. bug BNKR 16:52:10 → drop à 16:52:15 → confirmé Coinbase à 16:52:24.
        const ageMs = now - pos.buyTimestamp;
        if (ageMs < RECONCILE_GRACE_MS) {
          this.stats_.reconcileGraced++;
          logger.info("[stairstep-trailing] reconcile: skipping young position (grace period)", {
            symbol: sym,
            ageSeconds: (ageMs / 1000).toFixed(1),
            graceSeconds: (RECONCILE_GRACE_MS / 1000).toFixed(0),
            currentPnl: pos.currentPnlPct.toFixed(2),
          });
          continue;
        }

        logger.warn("[stairstep-trailing] reconcile: position no longer in Coinbase, dropping", {
          symbol: sym,
          avgBuyPrice: pos.avgBuyPrice,
          currentPnl: pos.currentPnlPct.toFixed(2),
          heldMinutes: ((Date.now() - pos.buyTimestamp) / 60_000).toFixed(1),
        });
        this.positions.delete(sym);
        this.stats_.reconcileDropped++;
        await this.deletePersistedPosition(sym);
      }
    } catch (err) {
      logger.warn("[stairstep-trailing] reconcile threw", {
        err: (err as Error).message,
      });
    }
  }

  // ─── Persistance Redis ────────────────────────────────────────────────────

  private async persistPosition(pos: OpenPosition, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - pos.lastPersistedAt < PERSIST_THROTTLE_MS) return;
    pos.lastPersistedAt = now;
    pos.lastPersistedPeakPnl = pos.peakPnlPct;
    try {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) return;
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["HSET", OPEN_POSITIONS_KEY, pos.symbol, JSON.stringify(pos)]),
      });
    } catch (err) {
      logger.warn("[stairstep-trailing] persist failed", {
        symbol: pos.symbol, err: (err as Error).message,
      });
    }
  }

  private async deletePersistedPosition(symbol: string): Promise<void> {
    try {
      const url = process.env.UPSTASH_REDIS_REST_URL;
      const token = process.env.UPSTASH_REDIS_REST_TOKEN;
      if (!url || !token) return;
      await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(["HDEL", OPEN_POSITIONS_KEY, symbol]),
      });
    } catch (err) {
      logger.warn("[stairstep-trailing] delete persisted position failed", {
        symbol, err: (err as Error).message,
      });
    }
  }

  // ─── Logs persistent (audit côté worker) ──────────────────────────────────

  private async appendTradeLog(entry: Record<string, unknown>): Promise<void> {
    try {
      const ok = await redisLpush(TRADES_LOG_KEY, entry);
      if (ok) {
        await redisLtrim(TRADES_LOG_KEY, 0, MAX_TRADES_LOG - 1);
      }
    } catch (err) {
      logger.warn("[stairstep-trailing] appendTradeLog failed", {
        err: (err as Error).message,
      });
    }
  }

  // ─── Diagnostic ───────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats_,
      openPositions: this.positions.size,
      inflight: this.inflight.size,
      symbols: [...this.positions.keys()],
      config: {
        hardStopLossPct: HARD_STOP_LOSS_PCT,
        minPeakPct: MIN_PEAK_PCT,
        trailingDeltaPct: TRAILING_DELTA_PCT,
        timeoutNoPeakHours: TIMEOUT_NO_PEAK_MS / 3600_000,
        maxHoldHours: MAX_HOLD_MS / 3600_000,
      },
    };
  }

  /**
   * Pour debug : retourne le snapshot complet d'une position si elle existe.
   */
  getPositionDebug(symbol: string): OpenPosition | null {
    return this.positions.get(symbol) ?? null;
  }

  /**
   * V3 (2026-05-13) — Indique si le trailing track une position ouverte sur ce symbol.
   * Utilisé par stairstep-dispatcher pour bloquer les BUY doublons (anti-DCA).
   * Bug d'origine 2026-05-13 ~19:13 : 2× BUY MATH consécutifs sans SELL entre les deux,
   * car le dispatcher ne vérifiait pas si une position existait déjà. La 2e position
   * écrasait la 1ère dans le tracking → peak perdu, PnL calculé sur la 2e cost basis.
   */
  hasPosition(symbol: string): boolean {
    return this.positions.has(symbol);
  }

  /**
   * Setter pour permettre au stairstep-dispatcher d'enregistrer les positions
   * juste après un BUY confirmé. (Injection bidirectionnelle pas nécessaire :
   * c'est le dispatcher qui connaît le trailing, pas l'inverse.)
   */
}