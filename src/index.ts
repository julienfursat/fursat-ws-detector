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

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PRODUCT_REFRESH_INTERVAL_MS = 60 * 60_000;
const STATS_LOG_INTERVAL_MS = 5 * 60_000;
const TICK_DEBUG_SAMPLE_RATE = 50_000;

async function main(): Promise<void> {
  logger.info("Starting fursat-ws-detector (étape 2C — BUY entry + fast-exit SELL)", {
    nodeVersion: process.version,
    port: PORT,
    logLevel: process.env.LOG_LEVEL ?? "info",
  });

  // 1. Discover products
  const discovered = await fetchTradableSymbols();
  const symbols = applySymbolOverride(discovered);
  if (symbols.size === 0) {
    logger.error("No symbols to subscribe — aborting");
    process.exit(1);
  }
  const productIds = [...symbols].map(s => `${s}-USDC`);

  // 2. Coinbase credentials
  const apiKey = process.env.COINBASE_API_KEY ?? "";
  const apiSecret = process.env.COINBASE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    logger.error("Coinbase credentials missing — aborting", {
      hasKey: !!apiKey, hasSecret: !!apiSecret,
    });
    process.exit(1);
  }

  // 3. Start HTTP health server EARLY (before any potentially slow init).
  // Railway healthcheck has a 30s window — we need /health to respond ASAP.
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
  detector.start();

  // 9. Fast-exit evaluator (real-time SELL on every tick of held assets)
  const fastExitEvaluator = new FastExitEvaluator(ringBuffers, positions, pnlTracker);

  // 10. Tick handler — feeds buffers, detector, AND fast-exit-evaluator
  let totalTicks = 0;
  const onTick = (tick: Tick): void => {
    totalTicks++;
    ringBuffers.updateTick(tick.symbol, tick.price, tick.volume24h, tick.timestamp);
    detector.evaluateTick(tick.symbol, tick.price, tick.volume24h);
    fastExitEvaluator.evaluateTick(tick.symbol, tick.price);
    void writeHeartbeat();
    if (totalTicks % TICK_DEBUG_SAMPLE_RATE === 0) {
      logger.debug("Tick sample", {
        symbol: tick.symbol, price: tick.price, totalTicks,
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