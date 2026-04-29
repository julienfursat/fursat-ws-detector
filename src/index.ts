// ─────────────────────────────────────────────────────────────────────────────
// index.ts — fursat-ws-detector entry point (étape 2B)
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap sequence:
//   1. Fetch tradable *-USDC products from Coinbase REST
//   2. Apply optional SYMBOL_OVERRIDE filter (testing)
//   3. Verify Coinbase credentials (required for WS auth)
//   4. Start ring buffers (5m/15m/1h/4h history)
//   5. PRELOAD ring buffers from scan:price_snapshots (warm start)
//   6. Start detector (event-driven on every tick)
//   7. Start the Coinbase ticker WS stream
//   8. Start the HTTP health server
//   9. Periodic stats log + product refresh
//  10. Graceful shutdown handlers
//
// Étape 2B behavior:
//   • Receives ticks → updates ring buffers → invokes detector
//   • Detector classifies signals → for alt_pump candidates only:
//     - Pre-checks (throttle, blacklist)
//     - Dispatches to fursat.net /api/agent/entry
//   • Logs all detections in dryrun:detected_signals_log
//   • Logs all dispatches in worker:dispatches_log
//   • scan.ts continues to run as a safety net (shared throttle prevents double dispatch)
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { fetchTradableSymbols, applySymbolOverride } from "./products.js";
import { CoinbaseTickerStream, type Tick } from "./coinbase-ws.js";
import { startHealthServer, type HealthProvider } from "./health-server.js";
import { writeHeartbeat } from "./redis.js";
import { RingBuffers } from "./ring-buffers.js";
import { Detector } from "./detector.js";
import { preloadRingBuffers } from "./preload.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PRODUCT_REFRESH_INTERVAL_MS = 60 * 60_000;  // refresh products every hour
const STATS_LOG_INTERVAL_MS = 5 * 60_000;          // log stats every 5 min
const TICK_DEBUG_SAMPLE_RATE = 50_000;             // log 1 tick out of N at debug

async function main(): Promise<void> {
  logger.info("Starting fursat-ws-detector (étape 2B — ring buffers + dispatch)", {
    nodeVersion: process.version,
    port: PORT,
    logLevel: process.env.LOG_LEVEL ?? "info",
  });

  // 1+2. Discover products
  const discovered = await fetchTradableSymbols();
  const symbols = applySymbolOverride(discovered);
  if (symbols.size === 0) {
    logger.error("No symbols to subscribe — aborting");
    process.exit(1);
  }
  const productIds = [...symbols].map(s => `${s}-USDC`);

  // 3. Coinbase credentials for WS auth
  const apiKey = process.env.COINBASE_API_KEY ?? "";
  const apiSecret = process.env.COINBASE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    logger.error("Coinbase credentials missing — aborting", {
      hasKey: !!apiKey,
      hasSecret: !!apiSecret,
    });
    process.exit(1);
  }

  // 4. Ring buffers
  const ringBuffers = new RingBuffers();
  ringBuffers.start();

  // 5. Preload from scan:price_snapshots (warm start — avoids 1h cold-start
  // window where change1h is null and most signals are filtered)
  await preloadRingBuffers(ringBuffers, symbols);

  // 6. Detector
  // heldSymbolsProvider: at étape 2B we don't poll positions yet, so always
  // return an empty set. position_crash signals won't fire (which is fine —
  // those are for owned altcoins, addressed in étape 2C).
  // The empty set returned here is also wrapped in a function so étape 2C
  // can swap it for a real position tracker without touching the detector.
  const heldSymbolsProvider = (): Set<string> => new Set<string>();
  const detector = new Detector(ringBuffers, symbols, heldSymbolsProvider);
  detector.start();

  // 6. Tick handler — feeds buffers and detector
  let totalTicks = 0;
  const onTick = (tick: Tick): void => {
    totalTicks++;
    // Feed the ring buffer first (so the detector sees the new price)
    ringBuffers.updateTick(tick.symbol, tick.price, tick.volume24h, tick.timestamp);
    // Run detection (cheap gates, full classify only if a threshold crosses)
    detector.evaluateTick(tick.symbol, tick.price, tick.volume24h);
    // Heartbeat throttled to ≤1 write per 30s
    void writeHeartbeat();
    if (totalTicks % TICK_DEBUG_SAMPLE_RATE === 0) {
      logger.debug("Tick sample", {
        symbol: tick.symbol,
        price: tick.price,
        totalTicks,
      });
    }
  };

  // 7. Start WS
  const stream = new CoinbaseTickerStream(productIds, onTick, apiKey, apiSecret);
  stream.start();

  // 8. HealthProvider that combines stream + buffers + detector stats
  const healthProvider: HealthProvider = {
    stats: () => stream.stats(),
  };
  const httpServer = startHealthServer(PORT, healthProvider);

  // 9. Periodic stats log (every 5 min) — combined view
  const statsTimer = setInterval(() => {
    logger.info("Stats", {
      stream: stream.stats(),
      buffers: ringBuffers.stats(),
      detector: detector.stats(),
    });
  }, STATS_LOG_INTERVAL_MS);

  // 10. Periodic product refresh
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await fetchTradableSymbols();
      const added = [...fresh].filter(s => !symbols.has(s));
      const removed = [...symbols].filter(s => !fresh.has(s));
      if (added.length > 0 || removed.length > 0) {
        // Update detector's universe (re-subscribe to WS deferred to a later step)
        for (const s of added) symbols.add(s);
        for (const s of removed) symbols.delete(s);
        detector.setTradableSymbols(symbols);
        logger.info("Product universe changed (detector universe updated, WS re-sub deferred)", {
          added, removed, currentCount: symbols.size, freshCount: fresh.size,
        });
      } else {
        logger.debug("Product universe unchanged", { count: symbols.size });
      }
    } catch (err) {
      logger.warn("Product refresh failed", { err: (err as Error).message });
    }
  }, PRODUCT_REFRESH_INTERVAL_MS);

  // 11. Graceful shutdown
  const shutdown = (signal: string): void => {
    logger.info("Shutting down", { signal });
    clearInterval(statsTimer);
    clearInterval(refreshTimer);
    detector.stop();   // flushes pending logs
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