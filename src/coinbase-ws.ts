// ─────────────────────────────────────────────────────────────────────────────
// coinbase-ws.ts — WebSocket connection to Coinbase Advanced authenticated ticker
// ─────────────────────────────────────────────────────────────────────────────
// Connects to wss://advanced-trade-ws.coinbase.com, subscribes to the `ticker`
// channel for a list of product IDs WITH JWT authentication, and emits parsed
// Tick events.
//
// Authentication: Coinbase Advanced WS requires a CDP JWT in the subscribe
// payload to receive a full tick stream. Without it, the channel pushes only
// sporadic events (~7 ticks/min observed across 235 pairs) — confirmed empirically.
// We re-sign a fresh JWT on every subscribe (token TTL is 120s, signing is ~1ms).
//
// Resilience:
//   • Reconnect with exponential backoff (1s → 30s cap)
//   • Backoff resets after STABLE_CONNECTION_MS of uninterrupted connection
//   • Heartbeat watchdog: if no message received in HEARTBEAT_TIMEOUT_MS, force reconnect
//   • Graceful close on SIGTERM / SIGINT
//
// Coinbase Advanced WS specs:
//   • Subscribe message: { type: "subscribe", channel: "ticker", product_ids: [...], jwt: "..." }
//   • Server pushes "subscriptions" confirmation, then "ticker" envelopes with
//     events[].tickers[] arrays
//   • Server pings periodically; ws library auto-pongs (we don't need to handle it)
//
// Reference: https://docs.cloud.coinbase.com/advanced-trade/docs/ws-overview
// ─────────────────────────────────────────────────────────────────────────────

import WebSocket from "ws";
import { logger } from "./logger.js";
import { buildWsJWT } from "./jwt.js";

const COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com";

// Reconnect strategy
const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const STABLE_CONNECTION_MS = 5 * 60_000;  // after 5 min connected, reset backoff

// Watchdog: Coinbase pushes ticks frequently on liquid pairs; if NO message
// for 60s, the connection is likely silently broken (proxy, NAT timeout, etc.)
const HEARTBEAT_TIMEOUT_MS = 60_000;
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000;

// Subscribe in batches to avoid hitting any per-message size limit
const SUBSCRIBE_BATCH_SIZE = 100;

export interface Tick {
  symbol: string;       // e.g. "BTC" (without -USDC suffix)
  productId: string;    // e.g. "BTC-USDC"
  price: number;
  volume24h: number;    // 24h base volume (units of the base asset)
  bestBid: number | null;
  bestAsk: number | null;
  timestamp: number;    // ms epoch (parsed from event time)
}

export type TickHandler = (tick: Tick) => void;

interface CoinbaseTickerEvent {
  type?: string;
  product_id?: string;
  price?: string;
  volume_24_h?: string;
  best_bid?: string;
  best_ask?: string;
}

interface CoinbaseEnvelope {
  channel?: string;
  timestamp?: string;
  events?: Array<{ type?: string; tickers?: CoinbaseTickerEvent[] }>;
  type?: string;
  message?: string;
}

export class CoinbaseTickerStream {
  private ws: WebSocket | null = null;
  private productIds: string[];
  private onTick: TickHandler;
  private apiKey: string;
  private apiSecret: string;

  private reconnectAttempt = 0;
  private connectedAt = 0;
  private lastMessageAt = 0;
  private closedByUser = false;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  // Counters surfaced via stats() for /health and periodic logs
  private ticksReceived = 0;
  private connectionsOpened = 0;
  private reconnects = 0;

  constructor(
    productIds: string[],
    onTick: TickHandler,
    apiKey: string,
    apiSecret: string
  ) {
    this.productIds = productIds;
    this.onTick = onTick;
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
  }

  start(): void {
    this.closedByUser = false;
    this.connect();
    this.startHeartbeatWatchdog();
  }

  stop(): void {
    this.closedByUser = true;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      try { this.ws.close(1000, "shutdown"); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  stats(): {
    connected: boolean;
    productsSubscribed: number;
    ticksReceived: number;
    connectionsOpened: number;
    reconnects: number;
    lastMessageAgeMs: number | null;
    uptimeMs: number;
  } {
    return {
      connected: this.ws?.readyState === WebSocket.OPEN,
      productsSubscribed: this.productIds.length,
      ticksReceived: this.ticksReceived,
      connectionsOpened: this.connectionsOpened,
      reconnects: this.reconnects,
      lastMessageAgeMs: this.lastMessageAt > 0 ? Date.now() - this.lastMessageAt : null,
      uptimeMs: this.connectedAt > 0 ? Date.now() - this.connectedAt : 0,
    };
  }

  private connect(): void {
    if (this.closedByUser) return;
    logger.info("Connecting to Coinbase WS", {
      attempt: this.reconnectAttempt,
      products: this.productIds.length,
    });

    const ws = new WebSocket(COINBASE_WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      this.connectedAt = Date.now();
      this.lastMessageAt = Date.now();
      this.connectionsOpened++;
      logger.info("WS connected", { totalConnections: this.connectionsOpened });
      this.subscribeAll();
    });

    ws.on("message", (raw) => {
      this.lastMessageAt = Date.now();
      // After STABLE_CONNECTION_MS without trouble, reset backoff
      if (this.reconnectAttempt > 0
          && Date.now() - this.connectedAt > STABLE_CONNECTION_MS) {
        logger.info("Connection stable — resetting reconnect backoff");
        this.reconnectAttempt = 0;
      }
      this.handleMessage(raw.toString());
    });

    ws.on("error", (err) => {
      logger.warn("WS error", { err: err.message });
      // Don't reconnect here — the "close" event will fire and trigger reconnect.
    });

    ws.on("close", (code, reason) => {
      const wasOpen = this.connectedAt > 0;
      logger.warn("WS closed", {
        code,
        reason: reason.toString() || "<empty>",
        wasOpen,
      });
      this.ws = null;
      this.connectedAt = 0;
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    });
  }

  private subscribeAll(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Build a fresh JWT for this subscribe wave. All batches in the same wave
    // share the same JWT — Coinbase Advanced accepts that. JWT TTL is 120s,
    // we send all batches synchronously so we're well within the window.
    let jwt: string;
    try {
      jwt = buildWsJWT(this.apiKey, this.apiSecret);
    } catch (err) {
      logger.error("Failed to build WS JWT", { err: (err as Error).message });
      return;
    }
    for (let i = 0; i < this.productIds.length; i += SUBSCRIBE_BATCH_SIZE) {
      const batch = this.productIds.slice(i, i + SUBSCRIBE_BATCH_SIZE);
      this.ws.send(JSON.stringify({
        type: "subscribe",
        channel: "ticker",
        product_ids: batch,
        jwt,
      }));
    }
    logger.info("Subscribe sent (authenticated)", {
      products: this.productIds.length,
      batches: Math.ceil(this.productIds.length / SUBSCRIBE_BATCH_SIZE),
    });
  }

  private handleMessage(raw: string): void {
    let env: CoinbaseEnvelope;
    try {
      env = JSON.parse(raw) as CoinbaseEnvelope;
    } catch {
      logger.debug("Non-JSON WS message", { raw: raw.slice(0, 200) });
      return;
    }

    // Subscription confirmation
    if (env.channel === "subscriptions") {
      logger.info("Subscriptions confirmed");
      return;
    }

    // Server-side error envelope
    if (env.type === "error") {
      logger.warn("Coinbase WS error envelope", { message: env.message });
      return;
    }

    if (env.channel !== "ticker") return;

    const envTimestamp = env.timestamp ? Date.parse(env.timestamp) : Date.now();
    for (const event of env.events ?? []) {
      for (const ticker of event.tickers ?? []) {
        const productId = ticker.product_id;
        // Coinbase Advanced WS returns events with product_id `-USD` even when
        // we subscribed to `-USDC` pairs (their matching engine uses USD as the
        // canonical quote, USDC is treated as equivalent for the ticker stream).
        // We accept both suffixes and normalize the symbol by stripping either.
        // For trade execution (later, étape 6+) we'll trade on `-USDC` explicitly
        // via the REST API — this only affects how we observe price data.
        if (!productId) continue;
        let symbol: string;
        if (productId.endsWith("-USDC")) {
          symbol = productId.slice(0, -5);
        } else if (productId.endsWith("-USD")) {
          symbol = productId.slice(0, -4);
        } else {
          continue;
        }
        const price = parseFloat(ticker.price ?? "0");
        if (!(price > 0)) continue;
        const tick: Tick = {
          symbol,
          productId,
          price,
          volume24h: parseFloat(ticker.volume_24_h ?? "0"),
          bestBid: ticker.best_bid ? parseFloat(ticker.best_bid) : null,
          bestAsk: ticker.best_ask ? parseFloat(ticker.best_ask) : null,
          timestamp: envTimestamp,
        };
        this.ticksReceived++;
        try {
          this.onTick(tick);
        } catch (err) {
          logger.error("onTick handler threw", { err: (err as Error).message });
        }
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnects++;
    const delay = Math.min(
      RECONNECT_INITIAL_MS * Math.pow(2, this.reconnectAttempt),
      RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;
    logger.info("Reconnect scheduled", { delayMs: delay, attempt: this.reconnectAttempt });
    setTimeout(() => this.connect(), delay);
  }

  private startHeartbeatWatchdog(): void {
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const age = Date.now() - this.lastMessageAt;
      if (age > HEARTBEAT_TIMEOUT_MS) {
        logger.warn("Heartbeat timeout — forcing reconnect", { lastMessageAgeMs: age });
        try { this.ws.terminate(); } catch { /* ignore */ }
        // The "close" event will fire and trigger scheduleReconnect()
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }
}