// ─────────────────────────────────────────────────────────────────────────────
// health-server.ts — minimal HTTP server exposing /health
// ─────────────────────────────────────────────────────────────────────────────
// No framework, just node:http. Used by:
//   • Railway healthcheck (configured in railway.json)
//   • cron-job.org external watchdog (notifies on failure)
//
// /health returns 200 if the WS is connected AND received a tick within the
// last 90 seconds. Returns 503 otherwise (Railway will restart the worker on
// repeated failures, depending on its policy).
//
// /metrics returns plain-text counters for ad-hoc inspection (curl-friendly).
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import type { Server } from "node:http";
import { logger } from "./logger.js";

const HEALTHY_LAST_TICK_MAX_AGE_MS = 90_000;

export interface HealthProvider {
  stats(): {
    connected: boolean;
    productsSubscribed: number;
    ticksReceived: number;
    connectionsOpened: number;
    reconnects: number;
    lastMessageAgeMs: number | null;
    uptimeMs: number;
  };
}

export function startHealthServer(
  port: number,
  provider: HealthProvider
): Server {
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400);
      res.end("Bad Request");
      return;
    }

    if (req.url === "/health" || req.url.startsWith("/health?")) {
      const s = provider.stats();
      const tickFresh = s.lastMessageAgeMs !== null
        && s.lastMessageAgeMs < HEALTHY_LAST_TICK_MAX_AGE_MS;
      const healthy = s.connected && tickFresh;
      const body = JSON.stringify({
        ok: healthy,
        wsConnected: s.connected,
        lastTickAgeMs: s.lastMessageAgeMs,
        productsSubscribed: s.productsSubscribed,
        ticksReceived: s.ticksReceived,
        reconnects: s.reconnects,
        uptimeMs: s.uptimeMs,
      });
      res.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
      res.end(body);
      return;
    }

    if (req.url === "/metrics") {
      const s = provider.stats();
      const lines = [
        `ws_connected ${s.connected ? 1 : 0}`,
        `ws_products_subscribed ${s.productsSubscribed}`,
        `ws_ticks_received_total ${s.ticksReceived}`,
        `ws_connections_opened_total ${s.connectionsOpened}`,
        `ws_reconnects_total ${s.reconnects}`,
        `ws_last_message_age_ms ${s.lastMessageAgeMs ?? -1}`,
        `ws_uptime_ms ${s.uptimeMs}`,
      ];
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(lines.join("\n") + "\n");
      return;
    }

    if (req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fursat-ws-detector — see /health and /metrics\n");
      return;
    }

    res.writeHead(404);
    res.end("Not Found");
  });

  server.listen(port, () => {
    logger.info("Health server listening", { port });
  });

  return server;
}
