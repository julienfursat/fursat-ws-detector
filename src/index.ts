// ─────────────────────────────────────────────────────────────────────────────
// index.ts — fursat-ws-detector entry point
// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap sequence:
//   1. Fetch tradable *-USDC products from Coinbase REST
//   2. Apply optional SYMBOL_OVERRIDE filter (testing)
//   3. Start the HTTP health server (so Railway healthcheck can pass during
//      WS connect — actual /health=200 only once first tick arrives)
//   4. Start the Coinbase ticker WS stream
//   5. Periodically refresh products and write Redis heartbeat
//   6. Handle SIGTERM/SIGINT for graceful shutdown
//
// At this stage (étape 1), tick handling is INTENTIONALLY MINIMAL:
//   • Increment counter
//   • Log every Nth tick at debug level
//   • Write throttled heartbeat to Redis
// No ring buffers, no detection, no trading. Those come in étape 2+.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { fetchTradableSymbols, applySymbolOverride } from "./products.js";
import { CoinbaseTickerStream, type Tick } from "./coinbase-ws.js";
import { startHealthServer } from "./health-server.js";
import { writeHeartbeat } from "./redis.js";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const PRODUCT_REFRESH_INTERVAL_MS = 60 * 60_000;  // refresh products every hour
const STATS_LOG_INTERVAL_MS = 5 * 60_000;          // log stats every 5 min
const TICK_DEBUG_SAMPLE_RATE = 5_000;              // log 1 tick out of N at debug

async function main(): Promise<void> {
  logger.info("Starting fursat-ws-detector", {
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

  // 2.5. Coinbase credentials for WS auth (REQUIRED — Coinbase Advanced WS
  // pushes only sporadic events without authentication)
  const apiKey = process.env.COINBASE_API_KEY ?? "";
  const apiSecret = process.env.COINBASE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    logger.error("Coinbase credentials missing — aborting", {
      hasKey: !!apiKey,
      hasSecret: !!apiSecret,
    });
    process.exit(1);
  }

  // 3. Tick handler — minimal at this stage
  let totalTicks = 0;
  const onTick = (tick: Tick): void => {
    totalTicks++;
    if (totalTicks % TICK_DEBUG_SAMPLE_RATE === 0) {
      logger.debug("Tick sample", {
        symbol: tick.symbol,
        price: tick.price,
        volume24h: tick.volume24h,
        totalTicks,
      });
    }
  };

  // 4. Start WS
  const stream = new CoinbaseTickerStream(productIds, onTick, apiKey, apiSecret);
  stream.start();

  // 5. Start HTTP health server (after stream so the provider has stats available)
  const httpServer = startHealthServer(PORT, stream);

  // 6. Periodic stats log + Redis heartbeat
  const statsTimer = setInterval(async () => {
    const s = stream.stats();
    logger.info("Stats", s);
    await writeHeartbeat();
  }, STATS_LOG_INTERVAL_MS);

  // 7. Periodic product refresh — re-subscribe if the universe changed
  // (NEW assets listed, others delisted). For now we simply log the diff;
  // re-subscription will be handled when we add ring buffers in étape 2.
  const refreshTimer = setInterval(async () => {
    try {
      const fresh = await fetchTradableSymbols();
      const added = [...fresh].filter(s => !symbols.has(s));
      const removed = [...symbols].filter(s => !fresh.has(s));
      if (added.length > 0 || removed.length > 0) {
        logger.info("Product universe changed (re-subscribe deferred to étape 2)", {
          added, removed, currentCount: symbols.size, freshCount: fresh.size,
        });
      } else {
        logger.debug("Product universe unchanged", { count: symbols.size });
      }
    } catch (err) {
      logger.warn("Product refresh failed", { err: (err as Error).message });
    }
  }, PRODUCT_REFRESH_INTERVAL_MS);

  // 8. Graceful shutdown
  const shutdown = async (signal: string): Promise<void> => {
    logger.info("Shutting down", { signal });
    clearInterval(statsTimer);
    clearInterval(refreshTimer);
    stream.stop();
    httpServer.close();
    // Give in-flight requests/messages a moment to drain
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT", () => { void shutdown("SIGINT"); });

  // 9. Surface uncaught errors instead of dying silently
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