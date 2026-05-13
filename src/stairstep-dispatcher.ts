// ─────────────────────────────────────────────────────────────────────────────
// stairstep-dispatcher.ts — Lot 3 V3 (2026-05-13)
// ─────────────────────────────────────────────────────────────────────────────
// Dispatcher V3 : reçoit un ShadowEvent stair_step depuis event-detector.ts,
// applique les filtres V3, et POST vers /api/agent/entry avec signalType=
// "stairstep_trailing".
//
// Architecture (validée 2026-05-13) :
//   - Filtres V3 appliqués CÔTÉ WORKER pour ne pas spammer Vercel :
//     1. kind === "stair_step" (garanti par l'appelant event-detector)
//     2. snapshot.volume24h ≥ $500K
//     3. snapshot.change30s ≤ +1.5%
//   - Killswitch local cached (env var WORKER_STAIRSTEP_BUY_ENABLED par défaut
//     false, + Redis cryptoagent:stairstep_killswitch cache 5s)
//   - Cap quotidien checké côté Vercel (entry.ts handleStairstepEntry)
//   - Circuit breaker checké côté Vercel
//
// Inflight guard : interdit deux dispatch concurrents pour le même symbole
// (un BUY met ~1.5s à se settle Coinbase, on ne veut pas double-fire).
//
// Audit local : push dans worker:stairstep_dispatches_log (cap 1000) avec
// raison du skip / succès. Indépendant de stairstep:trades_log côté Vercel.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisLpush, redisLtrim } from "./redis.js";
import type { ShadowEvent } from "./event-detector.js";
// 2026-05-13 — Injection circulaire (light) du trailing manager pour wiring
// addPosition() après BUY confirmé. Utilise type-only import + setter pour
// éviter le problème de boot order.
import type { StairstepTrailing } from "./stairstep-trailing.js";

const FURSAT_API_BASE = (process.env.FURSAT_API_BASE ?? "https://www.fursat.net").replace(/\/$/, "");
const ENTRY_URL = `${FURSAT_API_BASE}/api/agent/entry`;
const ENTRY_TIMEOUT_MS = 10_000;

// Killswitch local : doit être TRUE pour dispatcher. Default false pour safety.
// Une fois la stratégie validée, on flip à true côté Railway.
const WORKER_STAIRSTEP_BUY_ENABLED =
  (process.env.WORKER_STAIRSTEP_BUY_ENABLED ?? "false").toLowerCase() === "true";

// Cache du killswitch dashboard (Redis cryptoagent:stairstep_killswitch).
// On ne lit Redis qu'une fois toutes les 5s pour économiser les calls.
const KILLSWITCH_KEY = "cryptoagent:stairstep_killswitch";
const KILLSWITCH_CACHE_TTL_MS = 5_000;

// Filtres V3 — ne dispatcher que si le snapshot satisfait ces conditions.
// Doublons des filtres validés à l'analyse 13/05 sur 6.4 jours de shadow events.
const V3_MIN_VOLUME_24H = 500_000;
const V3_MAX_CHANGE_30S = 1.5;

// Audit log (Redis LIST capped at 1000 entries)
const DISPATCH_LOG_KEY = "worker:stairstep_dispatches_log";
const MAX_DISPATCH_LOG = 1000;

interface KillswitchCache {
  state: "active" | "paused";
  fetchedAt: number;
}

interface DispatchLogEntry {
  ts: number;
  parisTime: string;
  symbol: string;
  decision: "dispatched" | "skipped" | "error";
  reason: string;
  // Snapshot context
  volume24h: number;
  change30s: number | null;
  change1h: number | null;
  change4h: number | null;
  signalPrice: number;
  // Response info (if dispatched)
  httpStatus: number | null;
  vercelReason: string | null;
  vercelExecuted: boolean | null;
  durationMs: number;
  error: string | null;
}

export class StairstepDispatcher {
  // Cache du killswitch dashboard
  private killswitchCache: KillswitchCache | null = null;

  // Inflight guard — interdit deux dispatch concurrents pour le même symbol
  private inflight = new Set<string>();

  // 2026-05-13 — Wiring V3 : trailing manager injecté via setTrailing.
  // Quand un BUY est confirmé Vercel, on appelle trailing.addPosition pour
  // démarrer le suivi peak/trough.
  private trailing: StairstepTrailing | null = null;

  // Stats
  private stats_ = {
    dispatchesAttempted: 0,
    dispatchesOk: 0,
    skippedKillswitchLocal: 0,
    skippedKillswitchDashboard: 0,
    skippedFilterVolume: 0,
    skippedFilterC30s: 0,
    skippedInflight: 0,
    httpErrors: 0,
    networkErrors: 0,
    vercelSkips: 0,    // entry.ts a accepté mais skipped (cap, circuit breaker, etc.)
  };

  /**
   * Hook principal : appelé par event-detector.ts juste après fireEvent
   * (en parallèle du shadow recording, ne bloque pas la logique d'analyse).
   *
   * Fire-and-forget : la promesse n'est pas await pour ne pas ralentir
   * l'évaluation des autres règles dans event-detector.evaluateTick.
   */
  tryDispatch(event: ShadowEvent): void {
    // Guard : on ne traite que les stair_step
    if (event.kind !== "stair_step") return;
    void this.tryDispatchAsync(event);
  }

  /**
   * 2026-05-13 — Wiring du trailing manager. Appelé une fois au boot
   * par index.ts juste après instantiation.
   */
  setTrailing(trailing: StairstepTrailing): void {
    this.trailing = trailing;
    logger.info("[stairstep-dispatcher] StairstepTrailing wired");
  }

  private async tryDispatchAsync(event: ShadowEvent): Promise<void> {
    const startedAt = Date.now();
    const symbol = event.symbol;
    const snap = event.snapshot;

    // ── 1. Killswitch local (env var Railway) ────────────────────────────
    if (!WORKER_STAIRSTEP_BUY_ENABLED) {
      this.stats_.skippedKillswitchLocal++;
      // No audit log for this — too noisy, this is the default state pre-launch
      return;
    }

    // ── 2. Filtres V3 ────────────────────────────────────────────────────
    if (snap.volume24h < V3_MIN_VOLUME_24H) {
      this.stats_.skippedFilterVolume++;
      await this.logEntry({
        ts: Date.now(),
        symbol,
        decision: "skipped",
        reason: `vol24h=$${(snap.volume24h / 1000).toFixed(0)}k < $${V3_MIN_VOLUME_24H / 1000}k`,
        snap,
        signalPrice: snap.price,
        httpStatus: null,
        vercelReason: null,
        vercelExecuted: null,
        durationMs: Date.now() - startedAt,
        error: null,
      });
      return;
    }

    if (snap.change30s !== null && snap.change30s > V3_MAX_CHANGE_30S) {
      this.stats_.skippedFilterC30s++;
      await this.logEntry({
        ts: Date.now(),
        symbol,
        decision: "skipped",
        reason: `c30s=${snap.change30s.toFixed(2)}% > ${V3_MAX_CHANGE_30S}% (queue de pump)`,
        snap,
        signalPrice: snap.price,
        httpStatus: null,
        vercelReason: null,
        vercelExecuted: null,
        durationMs: Date.now() - startedAt,
        error: null,
      });
      return;
    }

    // ── 3. Killswitch dashboard (Redis, avec cache 5s) ───────────────────
    const killswitchPaused = await this.isKillswitchPaused();
    if (killswitchPaused) {
      this.stats_.skippedKillswitchDashboard++;
      await this.logEntry({
        ts: Date.now(),
        symbol,
        decision: "skipped",
        reason: "killswitch_dashboard_paused",
        snap,
        signalPrice: snap.price,
        httpStatus: null,
        vercelReason: null,
        vercelExecuted: null,
        durationMs: Date.now() - startedAt,
        error: null,
      });
      return;
    }

    // ── 4. Inflight guard ────────────────────────────────────────────────
    if (this.inflight.has(symbol)) {
      this.stats_.skippedInflight++;
      logger.info("[stairstep-dispatcher] inflight skip", { symbol });
      return;
    }
    this.inflight.add(symbol);

    // ── 5. Dispatch HTTP ─────────────────────────────────────────────────
    try {
      this.stats_.dispatchesAttempted++;
      const cronSecret = process.env.CRON_SECRET ?? process.env.CRYPTO_AGENT_SECRET ?? "";
      if (!cronSecret) {
        throw new Error("CRON_SECRET (or CRYPTO_AGENT_SECRET) missing");
      }

      // Payload — entry.ts handleStairstepEntry attend ces champs.
      // On envoie aussi change5m/15m/1h/24h pour cohérence avec le payload
      // legacy (entry.ts les ignore mais ça simplifie le parsing).
      const signalPayload = {
        signal: {
          symbol,
          change5m: snap.change5m,
          change15m: snap.change15m,
          change1h: snap.change1h,
          change24h: 0,  // not in shadow snapshot, default 0
          volume24h: snap.volume24h,
          drawdownFromPeak: snap.drawdownFromPeak,
          severity: "v3",
          signalType: "stairstep_trailing",
          triggerSource: null,
          signalPrice: snap.price,
          signalTimestamp: event.ts,
          // V3-specific extras :
          change30s: snap.change30s,
          change4h: snap.change4h,
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), ENTRY_TIMEOUT_MS);
      let httpStatus: number | null = null;
      let vercelBody: any = null;

      try {
        const res = await fetch(ENTRY_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-cron-secret": cronSecret,
            "x-agent-secret": cronSecret,
            "x-source": "ws-worker",
          },
          body: JSON.stringify(signalPayload),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        httpStatus = res.status;
        try { vercelBody = await res.json(); } catch { /* non-JSON */ }
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }

      const skipped = vercelBody?.skipped === true;
      const executed = vercelBody?.executed === true;
      const reason = vercelBody?.reason ?? null;

      if (executed) {
        this.stats_.dispatchesOk++;
        logger.info("✅ STAIRSTEP V3 BUY dispatched OK", {
          symbol,
          orderId: vercelBody?.orderId,
          avgBuyPrice: vercelBody?.avgBuyPrice,
          slippageEntryPct: vercelBody?.slippageEntryPct,
          dailyCount: vercelBody?.dailyCount,
        });
        // 2026-05-13 — Démarrer le suivi trailing immédiatement après BUY OK.
        // Si trailing n'est pas wired (cas dégradé), on logue un warning car
        // la position serait orpheline.
        if (this.trailing) {
          await this.trailing.addPosition({
            symbol,
            buyOrderId: vercelBody?.orderId ?? "unknown",
            avgBuyPrice: vercelBody?.avgBuyPrice ?? snap.price,
            sizingUsdc: vercelBody?.sizingUsdc ?? 50,
          });
        } else {
          logger.error("[stairstep-dispatcher] BUY OK but trailing not wired — position will be orphaned!", {
            symbol, orderId: vercelBody?.orderId,
          });
        }
      } else if (skipped) {
        this.stats_.vercelSkips++;
        logger.info("[stairstep-dispatcher] Vercel skipped", { symbol, reason });
      } else if (httpStatus && httpStatus >= 400) {
        this.stats_.httpErrors++;
        logger.warn("[stairstep-dispatcher] HTTP error", { symbol, status: httpStatus, body: vercelBody });
      }

      await this.logEntry({
        ts: Date.now(),
        symbol,
        decision: executed ? "dispatched" : "skipped",
        reason: reason ?? (executed ? "dispatched_ok" : "unknown"),
        snap,
        signalPrice: snap.price,
        httpStatus,
        vercelReason: reason,
        vercelExecuted: executed,
        durationMs: Date.now() - startedAt,
        error: null,
      });
    } catch (err) {
      this.stats_.networkErrors++;
      const errMsg = (err as Error).message ?? String(err);
      logger.warn("[stairstep-dispatcher] dispatch threw", { symbol, err: errMsg });
      await this.logEntry({
        ts: Date.now(),
        symbol,
        decision: "error",
        reason: "network_or_timeout",
        snap,
        signalPrice: snap.price,
        httpStatus: null,
        vercelReason: null,
        vercelExecuted: null,
        durationMs: Date.now() - startedAt,
        error: errMsg,
      });
    } finally {
      this.inflight.delete(symbol);
    }
  }

  /**
   * Lit le killswitch dashboard depuis Redis avec cache 5s.
   * Returns true si paused (skip dispatches).
   */
  private async isKillswitchPaused(): Promise<boolean> {
    const now = Date.now();
    if (this.killswitchCache && now - this.killswitchCache.fetchedAt < KILLSWITCH_CACHE_TTL_MS) {
      return this.killswitchCache.state === "paused";
    }

    // Refresh from Redis
    let state: "active" | "paused" = "active";
    try {
      const raw = await redisGet<unknown>(KILLSWITCH_KEY);
      if (raw !== null && raw !== undefined) {
        if (typeof raw === "object" && raw !== null && "state" in raw) {
          state = (raw as { state: string }).state === "paused" ? "paused" : "active";
        } else if (typeof raw === "string") {
          state = (raw === "1" || raw === "paused") ? "paused" : "active";
        }
      }
    } catch (err) {
      // En cas d'erreur Redis on est conservateur : on assume active (laisser passer).
      // Le killswitch local et le cap Vercel sont les vrais filets de sécurité.
      logger.warn("[stairstep-dispatcher] killswitch fetch failed, assuming active", {
        err: (err as Error).message,
      });
    }

    this.killswitchCache = { state, fetchedAt: now };
    return state === "paused";
  }

  /**
   * Append to worker:stairstep_dispatches_log (capped at MAX_DISPATCH_LOG).
   * Best-effort — failure here doesn't affect dispatch outcome.
   */
  private async logEntry(opts: {
    ts: number;
    symbol: string;
    decision: "dispatched" | "skipped" | "error";
    reason: string;
    snap: ShadowEvent["snapshot"];
    signalPrice: number;
    httpStatus: number | null;
    vercelReason: string | null;
    vercelExecuted: boolean | null;
    durationMs: number;
    error: string | null;
  }): Promise<void> {
    try {
      const entry: DispatchLogEntry = {
        ts: opts.ts,
        parisTime: new Date(opts.ts).toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
        symbol: opts.symbol,
        decision: opts.decision,
        reason: opts.reason,
        volume24h: opts.snap.volume24h,
        change30s: opts.snap.change30s,
        change1h: opts.snap.change1h,
        change4h: opts.snap.change4h,
        signalPrice: opts.signalPrice,
        httpStatus: opts.httpStatus,
        vercelReason: opts.vercelReason,
        vercelExecuted: opts.vercelExecuted,
        durationMs: opts.durationMs,
        error: opts.error,
      };
      const ok = await redisLpush(DISPATCH_LOG_KEY, entry);
      if (ok) {
        await redisLtrim(DISPATCH_LOG_KEY, 0, MAX_DISPATCH_LOG - 1);
      }
    } catch (err) {
      logger.warn("[stairstep-dispatcher] logEntry failed", {
        err: (err as Error).message,
      });
    }
  }

  /**
   * Diagnostic accessor — exposed in index.ts STATS_LOG_INTERVAL_MS.
   */
  getStats() {
    return {
      ...this.stats_,
      inflightCount: this.inflight.size,
      killswitchCache: this.killswitchCache
        ? {
            state: this.killswitchCache.state,
            ageMs: Date.now() - this.killswitchCache.fetchedAt,
          }
        : null,
      enabled: WORKER_STAIRSTEP_BUY_ENABLED,
    };
  }
}