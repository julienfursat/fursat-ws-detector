// ─────────────────────────────────────────────────────────────────────────────
// positions.ts — Poll Coinbase /accounts and merge with agent:trade_meta
// ─────────────────────────────────────────────────────────────────────────────
// Builds the list of "agent positions" (opportunity altcoin holdings) that
// fast-exit rules should evaluate on every tick.
//
// Strategy:
//   1. Every 30s, poll Coinbase REST /api/v3/brokerage/accounts (paginated)
//   2. Read agent:trade_meta from Redis to get avgBuyPrice + buyTimestamp per symbol
//   3. For each held altcoin (NOT BTC/ETH, NOT stables) with trade_meta entry,
//      build an AgentPosition record
//   4. Maintain a current snapshot accessible to the fast-exit evaluator
//
// We mirror scan.ts logic:
//   - Multiple BUYs per symbol → keep the most RECENT buyTimestamp (simple heuristic;
//     averaging would be more accurate but adds complexity, scan.ts does the same)
//   - Symbols held but missing from trade_meta → SKIPPED (legacy positions are
//     not surveilled by the worker; scan.ts handles them via fallback to orders history)
//
// BACKLOG-1: switch to user channel WS (positions push) instead of polling REST.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet } from "./redis.js";
import { coinbaseFetch } from "./coinbase-rest.js";

const TRADE_META_KEY = "agent:trade_meta";
const POLL_INTERVAL_MS = 30_000;

// Symbols that are NEVER opportunity positions (BTC/ETH are core holdings)
const MAJORS = new Set(["BTC", "ETH"]);
const STABLES = new Set([
  "USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "GUSD",
  "PYUSD", "FRAX", "LUSD", "SUSD", "EUR", "USD", "GBP", "EURS", "EURT",
]);

export interface AgentPosition {
  symbol: string;
  units: number;
  currentPrice: number;     // updated externally per-tick by the evaluator
  avgBuyPrice: number;
  buyTimestamp: number;
  pnlPct: number;            // computed from currentPrice
  valueUSD: number;          // units * currentPrice
}

interface TradeMetaEntry {
  type?: string;
  symbol?: string;
  avgBuyPrice?: number;
  buyTimestamp?: number;
}

interface CoinbaseAccount {
  currency: string;
  available_balance?: { value?: string; currency?: string };
  hold?: { value?: string; currency?: string };
}

/**
 * Tracks current agent positions. Polls Coinbase /accounts on a timer and
 * caches the result. The fast-exit evaluator reads via getCurrentPositions().
 */
export class PositionsTracker {
  private positions: Map<string, AgentPosition> = new Map();
  private timer: any = null;
  private lastPollAt = 0;
  private lastPollOk = false;
  private pollCount = 0;
  private pollErrors = 0;

  /**
   * Returns the symbols currently held by the agent (set of strings).
   * Used by the detector to determine isHeld for classifySignal.
   */
  getHeldSymbols(): Set<string> {
    return new Set(this.positions.keys());
  }

  /**
   * Returns the full position record for a symbol, or undefined if not held.
   */
  getPosition(symbol: string): AgentPosition | undefined {
    return this.positions.get(symbol);
  }

  /**
   * Returns all current positions as an array (for stats / iteration).
   */
  getAllPositions(): AgentPosition[] {
    return [...this.positions.values()];
  }

  /**
   * Updates the currentPrice and pnlPct for a position, in-place.
   * Called by the fast-exit evaluator on every tick of a held asset.
   * Returns the updated position, or undefined if symbol not held.
   */
  updatePriceForSymbol(symbol: string, currentPrice: number): AgentPosition | undefined {
    const pos = this.positions.get(symbol);
    if (!pos) return undefined;
    pos.currentPrice = currentPrice;
    pos.pnlPct = ((currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100;
    pos.valueUSD = pos.units * currentPrice;
    return pos;
  }

  start(): void {
    void this.pollNow();
    this.timer = setInterval(() => { void this.pollNow(); }, POLL_INTERVAL_MS);
    logger.info("PositionsTracker started", { pollIntervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats() {
    return {
      heldCount: this.positions.size,
      lastPollAgeMs: this.lastPollAt > 0 ? Date.now() - this.lastPollAt : null,
      lastPollOk: this.lastPollOk,
      pollCount: this.pollCount,
      pollErrors: this.pollErrors,
    };
  }

  /**
   * Single poll cycle: fetch all accounts (paginated), read trade_meta,
   * rebuild the positions map.
   */
  private async pollNow(): Promise<void> {
    this.pollCount++;
    try {
      // 1. Fetch all Coinbase accounts (paginated)
      const accounts = await this.fetchAllAccounts();
      const accountsBySymbol = new Map<string, { available: number; total: number }>();
      for (const acc of accounts) {
        const symbol = acc.currency;
        if (!symbol) continue;
        if (MAJORS.has(symbol)) continue;
        if (STABLES.has(symbol)) continue;
        const available = parseFloat(acc.available_balance?.value ?? "0");
        const hold = parseFloat(acc.hold?.value ?? "0");
        const total = available + hold;
        if (total <= 0) continue;
        accountsBySymbol.set(symbol, { available, total });
      }

      // 2. Read trade_meta from Redis, aggregate by symbol (most recent BUY per symbol)
      const tradeMeta = (await redisGet<Record<string, TradeMetaEntry>>(TRADE_META_KEY)) ?? {};
      const metaBySymbol = new Map<string, { avgBuyPrice: number; buyTimestamp: number }>();
      for (const orderId of Object.keys(tradeMeta)) {
        const meta = tradeMeta[orderId];
        if (!meta || meta.type !== "opportunity") continue;
        if (typeof meta.avgBuyPrice !== "number" || typeof meta.buyTimestamp !== "number" || !meta.symbol) continue;
        const existing = metaBySymbol.get(meta.symbol);
        if (!existing || meta.buyTimestamp > existing.buyTimestamp) {
          metaBySymbol.set(meta.symbol, {
            avgBuyPrice: meta.avgBuyPrice,
            buyTimestamp: meta.buyTimestamp,
          });
        }
      }

      // 3. Build the new positions map: held symbols ∩ has-trade-meta
      const newPositions = new Map<string, AgentPosition>();
      for (const [symbol, account] of accountsBySymbol.entries()) {
        const meta = metaBySymbol.get(symbol);
        if (!meta) continue; // legacy position, not surveilled by worker
        // Preserve the previous currentPrice if we have one (next tick will refresh).
        // If first time we see this position, currentPrice = avgBuyPrice as placeholder.
        const prev = this.positions.get(symbol);
        const currentPrice = prev?.currentPrice ?? meta.avgBuyPrice;
        const pnlPct = ((currentPrice - meta.avgBuyPrice) / meta.avgBuyPrice) * 100;
        newPositions.set(symbol, {
          symbol,
          units: account.available,
          currentPrice,
          avgBuyPrice: meta.avgBuyPrice,
          buyTimestamp: meta.buyTimestamp,
          pnlPct,
          valueUSD: account.available * currentPrice,
        });
      }

      const before = this.positions.size;
      this.positions = newPositions;
      const after = this.positions.size;
      this.lastPollAt = Date.now();
      this.lastPollOk = true;

      if (before !== after || this.pollCount === 1) {
        logger.info("Positions refreshed", {
          held: after,
          symbols: [...newPositions.keys()].sort().join(","),
        });
      }
    } catch (err) {
      this.pollErrors++;
      this.lastPollOk = false;
      logger.warn("Positions poll failed", { err: (err as Error).message });
    }
  }

  /**
   * Fetch all Coinbase accounts (paginated). Returns flat list.
   */
  private async fetchAllAccounts(): Promise<CoinbaseAccount[]> {
    const all: CoinbaseAccount[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const path = cursor
        ? `/api/v3/brokerage/accounts?limit=250&cursor=${encodeURIComponent(cursor)}`
        : `/api/v3/brokerage/accounts?limit=250`;
      const { ok, data } = await coinbaseFetch("GET", path);
      if (!ok || !data) {
        throw new Error(`accounts fetch failed (page ${pages})`);
      }
      const accounts: CoinbaseAccount[] = data.accounts ?? [];
      all.push(...accounts);
      cursor = data.has_next && data.cursor ? data.cursor : null;
      pages++;
      if (pages > 20) break;  // safety: never infinite loop
    } while (cursor);
    return all;
  }
}