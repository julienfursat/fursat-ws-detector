// ─────────────────────────────────────────────────────────────────────────────
// index.ts — fursat-ws-detector entry point (étape 2C)
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap sequence:
//   1. Fetch tradable *-USDC products from Coinbase REST
//   2. Verify Coinbase credentials (required for WS auth + REST /accounts)
//   3. Start ring buffers
//   4. Preload buffers from scan:price_snapshots
//   5. Start positions tracker (poll Coinbase /accounts every 30s + read trade_meta)
//   6. Start pnl tracker (load from Redis, persist every 5min)
//   7. Start detector (BUY dispatch as in étape 2B)
//   8. Start fast-exit evaluator (real-time SELL on every tick of held assets)
//   9. Start WS stream
//  10. Start HTTP health server
//  11. Periodic stats log + product refresh
//  12. Graceful shutdown
//
// Étape 2C behavior (delta vs 2B):
//   • Positions tracker polls /accounts every 30s + agent:trade_meta
//   • On every tick of a held asset, fast-exit-evaluator updates pnlMax/pnlMin
//     and evaluates the 5 fast-exit rules
//   • If a rule fires, dispatch to fursat.net /api/agent/fast-exit
//   • Cooldown shared with scan.ts via scan:fast_exit_recent (10 min)
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { fetchTradableSymbols, applySymbolOverride } from "./products.js";
import { CoinbaseTickerStream, type Tick } from "./coinbase-ws.js";
import { startHealthServer, type HealthProvider } from "./health-server.js";
import { writeHeartbeat } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";
import { Detector } from "./detector.js";
import { preloadRingBuffers } from "./preload.js";
import { PositionsTracker } from "./positions.js";
import { PnlTracker } from "./pnl-tracker.js";
import { FastExitEvaluator } from "./fast-exit-evaluator.js";
// Lot 2 (2026-05-06) — Multi-strategy event detector (passive, shadow:* keys only)
import { EventDetector } from "./event-detector.js";
import { EventFollowup } from "./event-followup.js";
// Lot 3 V3 (2026-05-13) — Dispatcher V3 pour la stratégie stair_step trailing.
// Tourne en parallèle du shadow recording, applique filtres V3 et dispatch BUY.
import { StairstepDispatcher } from "./stairstep-dispatcher.js";
// Lot 3 V3 (2026-05-13) — Gestion des positions ouvertes + trailing stop.
import { StairstepTrailing } from "./stairstep-trailing.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PRODUCT_REFRESH_INTERVAL_MS = 60 * 60_000;
const STATS_LOG_INTERVAL_MS = 5 * 60_000;
const TICK_DEBUG_SAMPLE_RATE = 50_000;

// 2026-05-08 — Resilience helpers for Coinbase Public Products API
// Background: on 2026-05-08 06:41-07:41 UTC the public products endpoint
// degraded from ~230 products to 0, causing every Railway boot to exit(1)
// before health server start (boot loop). Now we retry with exponential
// backoff and only exit if persistently empty after several attempts.
const PRODUCTS_FETCH_INITIAL_DELAY_MS = 2_000;
const PRODUCTS_FETCH_MAX_DELAY_MS = 60_000;
const PRODUCTS_FETCH_MAX_ATTEMPTS = 8;  // ~2 min total with backoff

async function fetchTradableSymbolsWithRetry(): Promise<Set<string>> {
  let delay = PRODUCTS_FETCH_INITIAL_DELAY_MS;
  for (let attempt = 1; attempt <= PRODUCTS_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const discovered = await fetchTradableSymbols();
      if (discovered.size > 0) {
        if (attempt > 1) {
          logger.info("Coinbase products API recovered", {
            attempt, count: discovered.size,
          });
        }
        return discovered;
      }
      logger.warn("Coinbase products API returned 0 products, retrying", {
        attempt, nextDelayMs: delay,
      });
    } catch (err) {
      logger.warn("Coinbase products API throw, retrying", {
        attempt, nextDelayMs: delay, err: (err as Error).message,
      });
    }
    if (attempt < PRODUCTS_FETCH_MAX_ATTEMPTS) {
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, PRODUCTS_FETCH_MAX_DELAY_MS);
    }
  }
  return new Set();  // caller decides what to do
}

async function main(): Promise<void> {
  logger.info("Starting fursat-ws-detector (étape 2C — BUY entry + fast-exit SELL)", {
    nodeVersion: process.version,
    port: PORT,
    logLevel: process.env.LOG_LEVEL ?? "info",
  });

  // 1. Start HTTP health server FIRST (before any potentially slow init).
  // Railway healthcheck has a 30s window — we need /health to respond ASAP.
  // 2026-05-08 — moved before fetchTradableSymbols so that a Coinbase API
  // outage doesn't cause boot loops (cf. 06:41-07:41 UTC incident).
  // Initial health responses will say "starting" until WS is connected.
  let healthSnapshot: () => any = () => ({
    connected: false,
    productsSubscribed: 0,
    ticksReceived: 0,
    connectionsOpened: 0,
    reconnects: 0,
    lastMessageAgeMs: null,
    uptimeMs: 0,
    starting: true,
  });
  const healthProvider: HealthProvider = {
    stats: () => healthSnapshot(),
  };
  const httpServer = startHealthServer(PORT, healthProvider);
  logger.info("HTTP health server started early — initialization continues in background");

  // 2. Verify Coinbase credentials early (cheap, no network call)
  const apiKey = process.env.COINBASE_API_KEY ?? "";
  const apiSecret = process.env.COINBASE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    logger.error("Coinbase credentials missing — aborting", {
      hasKey: !!apiKey, hasSecret: !!apiSecret,
    });
    process.exit(1);
  }

  // 3. Discover products (with retry — see fetchTradableSymbolsWithRetry).
  // If still empty after retries, exit(1) so Railway restarts later when
  // Coinbase has recovered. Health server is already up so Railway saw
  // healthy status and won't crash-loop us tightly.
  const discovered = await fetchTradableSymbolsWithRetry();
  const symbols = applySymbolOverride(discovered);
  if (symbols.size === 0) {
    logger.error("No symbols to subscribe after retries — aborting (Railway will restart)");
    process.exit(1);
  }
  const productIds = [...symbols].map(s => `${s}-USDC`);

  // 4. Ring buffers
  const ringBuffers = new RingBuffers();
  ringBuffers.start();

  // 5. Preload buffers from scan:price_snapshots
  await preloadRingBuffers(ringBuffers, symbols);

  // 6. Positions tracker (poll Coinbase /accounts + read trade_meta)
  const positions = new PositionsTracker();
  positions.start();

  // 7. PnL tracker (load from Redis, persist periodically)
  const pnlTracker = new PnlTracker();
  await pnlTracker.loadFromRedis();
  pnlTracker.start();

  // 8. Detector (BUY entry as in 2B)
  // BACKLOG-3 phase 3 (2026-05-02) — Pass positions to the detector so that
  // tryDispatchSlowDown uses the same source of truth as fast-exit-evaluator.
  // This fixes the bug where slow-down/tp/sl never triggered (getAvgBuyPrice
  // had a 60s null-cache pitfall when called right after a worker BUY).
  const heldSymbolsProvider = (): Set<string> => positions.getHeldSymbols();
  const detector = new Detector(ringBuffers, symbols, heldSymbolsProvider, positions);
  // BACKLOG-3 phase 5+ (2026-05-04) — Wire PnlTracker so tryDispatchSlowDown
  // can read pnl_max for fast_sl bypass (don't cut positions that already
  // touched +2%). Non-breaking: detector falls back to undefined pnl_max if
  // setter not called (no regression on legacy behavior).
  detector.setPnlTracker(pnlTracker);
  detector.start();

  // 9. Fast-exit evaluator (real-time SELL on every tick of held assets)
  const fastExitEvaluator = new FastExitEvaluator(ringBuffers, positions, pnlTracker);

  // 9b. Lot 2 (2026-05-06) — Passive multi-strategy event detector.
  // Writes shadow:* events for retroactive simulation. Never triggers BUYs.
  // Active during the 7-day observation week (07-12/05/2026).
  const eventFollowup = new EventFollowup(ringBuffers);
  const eventDetector = new EventDetector(ringBuffers, eventFollowup);

  // 9c. Lot 3 V3 (2026-05-13) — Stairstep V3 dispatcher + trailing.
  // Wires into eventDetector so that every stair_step event triggers a BUY
  // dispatch attempt (after V3 filters, killswitch, Vercel cap). When
  // WORKER_STAIRSTEP_BUY_ENABLED=false (default), all attempts are skipped
  // locally → zero impact on Vercel. Flip the env var to true to go live.
  //
  // Le trailing manager (StairstepTrailing) gère les positions ouvertes :
  //   - Reload depuis Redis au boot (resilience aux restarts)
  //   - Tracking peak/trough tick par tick
  //   - Trigger SELL via /api/agent/sell-stairstep selon 3 conditions:
  //     hard SL (-8%), trailing (peak retraced 1pt), timeout (2h no peak)
  //   - Reconcile Coinbase toutes les 60s (drop positions vendues ailleurs)
  const stairstepTrailing = new StairstepTrailing(positions);
  await stairstepTrailing.loadFromRedis();
  stairstepTrailing.start();

  const stairstepDispatcher = new StairstepDispatcher();
  stairstepDispatcher.setTrailing(stairstepTrailing);
  eventDetector.setStairstepDispatcher(stairstepDispatcher);

  // 10. Tick handler — feeds buffers, detector, AND fast-exit-evaluator
  let totalTicks = 0;
  const onTick = (tick: Tick): void => {
    totalTicks++;
    // BACKLOG-3 phase 7 (2026-05-06) — store bestBid in ring buffer too,
    // so detector.tryDispatchSlowDown can read it via snap.bestBid.
    ringBuffers.updateTick(tick.symbol, tick.price, tick.volume24h, tick.timestamp, tick.bestBid);
    detector.evaluateTick(tick.symbol, tick.price, tick.volume24h);
    // bestBid passed explicitly so fast-exit decisions use the actual SELL-side
    // price, not last_trade which can spike to fictive levels on thin orderbook
    // altcoins (root cause of pump1h slippage 05/05).
    fastExitEvaluator.evaluateTick(tick.symbol, tick.price, tick.bestBid);
    // Lot 2 — multi-strategy event detection (passive, shadow:* writes only)
    eventDetector.evaluateTick(tick.symbol);
    // Lot 3 V3 (2026-05-13) — Trailing stop pour positions stair_step ouvertes.
    // Fast path : si symbol pas tracké (99.9% des cas), retour immédiat.
    stairstepTrailing.evaluateTick(tick.symbol, tick.price, tick.bestBid);
    void writeHeartbeat();
    if (totalTicks % TICK_DEBUG_SAMPLE_RATE === 0) {
      logger.debug("Tick sample", {
        symbol: tick.symbol, price: tick.price, bestBid: tick.bestBid, totalTicks,
      });
    }
  };

  // 11. Start WS
  const stream = new CoinbaseTickerStream(productIds, onTick, apiKey, apiSecret);
  stream.start();

  // 12. Now that the stream is built, point the health snapshot at it.
  healthSnapshot = () => stream.stats();

  // 12. Periodic stats (every 5 min)
  const statsTimer = setInterval(() => {
    // Prune pnl tracker entries that no longer correspond to held positions
    pnlTracker.pruneToHeld(positions.getHeldSymbols());
    logger.info("Stats", {
      stream: stream.stats(),
      buffers: ringBuffers.stats(),
      detector: detector.stats(),
      positions: positions.stats(),
      pnlTracker: pnlTracker.stats(),
      fastExit: fastExitEvaluator.stats(),
      eventDetector: {
        counters: eventDetector.getCounters(),
        pendingFollowups: eventFollowup.getPendingCount(),
      },
      // Lot 3 V3 (2026-05-13)
      stairstepDispatcher: stairstepDispatcher.getStats(),
      stairstepTrailing: stairstepTrailing.getStats(),
    });
  }, STATS_LOG_INTERVAL_MS);

  // 13. Periodic product refresh
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await fetchTradableSymbols();
      const added = [...fresh].filter(s => !symbols.has(s));
      const removed = [...symbols].filter(s => !fresh.has(s));
      if (added.length > 0 || removed.length > 0) {
        for (const s of added) symbols.add(s);
        for (const s of removed) symbols.delete(s);
        detector.setTradableSymbols(symbols);
        logger.info("Product universe changed", {
          added, removed, currentCount: symbols.size, freshCount: fresh.size,
        });
      }
    } catch (err) {
      logger.warn("Product refresh failed", { err: (err as Error).message });
    }
  }, PRODUCT_REFRESH_INTERVAL_MS);

  // 14. Graceful shutdown
  const shutdown = (signal: string): void => {
    logger.info("Shutting down", { signal });
    clearInterval(statsTimer);
    clearInterval(refreshTimer);
    detector.stop();
    pnlTracker.stop();
    positions.stop();
    ringBuffers.stop();
    stream.stop();
    stairstepTrailing.stop();  // 2026-05-13 — stop reconcile timer
    httpServer.close();
    setTimeout(() => process.exit(0), 1_500);
  };
  process.on("SIGTERM", () => { shutdown("SIGTERM"); });
  process.on("SIGINT", () => { shutdown("SIGINT"); });

  process.on("uncaughtException", (err: Error) => {
    logger.error("uncaughtException", { err: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason: unknown) => {
    logger.error("unhandledRejection", { reason: String(reason) });
  });
}

main().catch((err: Error) => {
  logger.error("Fatal startup error", { err: err.message, stack: err.stack });
  process.exit(1);
});