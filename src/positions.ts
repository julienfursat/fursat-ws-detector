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
//   4. Skip dust positions (valueUSD < DUST_THRESHOLD_USD) — these are residual
//      balances after a SELL that Coinbase couldn't fully clear, not real positions
//   5. Maintain a current snapshot accessible to the fast-exit evaluator
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
// BACKLOG-3 phase 3 (2026-05-02) — Reduced from 30_000 to 5_000.
// The 30s interval created up to 30s of "blind window" right after a worker BUY,
// during which fast_slow_down/fast_tp/fast_sl rules could not evaluate (the asset
// wasn't yet in the positions map). At 5s, this window shrinks to ≤5s, giving
// sub-min rules effective coverage on short-lived trades (BOBBOB/QI/RLS/SYND-style,
// 2-5min duration). Coinbase rate limit (30 req/s) is comfortably respected:
// 1 paginated /accounts call per 5s ≈ 0.2 req/s.
const POLL_INTERVAL_MS = 5_000;

// Symbols that are NEVER opportunity positions (BTC/ETH are core holdings)
const MAJORS = new Set(["BTC", "ETH"]);
const STABLES = new Set([
  "USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP", "GUSD",
  "PYUSD", "FRAX", "LUSD", "SUSD", "EUR", "USD", "GBP", "EURS", "EURT",
]);

// Positions worth less than this (in USD-equivalent) are considered dust —
// residual balances from incomplete SELLs that Coinbase couldn't clear.
// We don't surveil these because:
//   1. fast-exit rules would compute nonsense PnL based on old avgBuyPrice
//   2. SELL attempts on dust positions fail (amount below minimum trade size)
//   3. They pollute logs and waste cooldown slots
const DUST_THRESHOLD_USD = 5;

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

      // 2. Read trade_meta from Redis, aggregate by symbol (most recent BUY per symbol).
      //
      // BACKLOG-3 phase 3 (2026-05-02) — Stale-meta guard.
      // Reject trade_meta entries whose buyTimestamp is older than STALE_META_MAX_AGE_MS.
      // Rationale: trade_meta is append-only (BUYs are never deleted, even after a full SELL).
      // If we re-buy an asset days/weeks after a previous full liquidation, the OLD
      // avgBuyPrice can leak through and make the worker compute pnlPct against a stale
      // entry price, leading to false fast_tp/slow_down/sl triggers.
      // Concrete bug observed: APE 02/05 12:30 — old BUY at $0.158 (28/04) shadowed the
      // new BUY at $0.183, causing worker to dispatch fast_tp at "PnL=15.8%" when actual
      // realized PnL was ≈ -$0.70 net.
      // This is a workaround. Proper fix in backlog: dedicated /api/agent/positions
      // endpoint that computes cost basis the same way cron.ts independentCostBasis does
      // (chronological BUYs - SELLs from Coinbase order history).
      const STALE_META_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // 24h
      const now = Date.now();
      const tradeMeta = (await redisGet<Record<string, TradeMetaEntry>>(TRADE_META_KEY)) ?? {};
      const metaBySymbol = new Map<string, { avgBuyPrice: number; buyTimestamp: number }>();
      let staleSkipped = 0;
      for (const orderId of Object.keys(tradeMeta)) {
        const meta = tradeMeta[orderId];
        if (!meta || meta.type !== "opportunity") continue;
        if (typeof meta.avgBuyPrice !== "number" || typeof meta.buyTimestamp !== "number" || !meta.symbol) continue;
        if ((now - meta.buyTimestamp) > STALE_META_MAX_AGE_MS) { staleSkipped++; continue; }
        const existing = metaBySymbol.get(meta.symbol);
        if (!existing || meta.buyTimestamp > existing.buyTimestamp) {
          metaBySymbol.set(meta.symbol, {
            avgBuyPrice: meta.avgBuyPrice,
            buyTimestamp: meta.buyTimestamp,
          });
        }
      }

      // 3. Build the new positions map: held symbols ∩ has-trade-meta ∩ not-dust
      const newPositions = new Map<string, AgentPosition>();
      let dustSkipped = 0;
      for (const [symbol, account] of accountsBySymbol.entries()) {
        const meta = metaBySymbol.get(symbol);
        if (!meta) continue; // legacy position, not surveilled by worker
        // Preserve the previous currentPrice if we have one (next tick will refresh).
        // If first time we see this position, currentPrice = avgBuyPrice as placeholder.
        const prev = this.positions.get(symbol);
        const currentPrice = prev?.currentPrice ?? meta.avgBuyPrice;
        const valueUSD = account.available * currentPrice;
        // Skip dust positions — residual balances Coinbase couldn't clear after SELL.
        // These would compute nonsense PnL against ancient avgBuyPrice.
        if (valueUSD < DUST_THRESHOLD_USD) {
          dustSkipped++;
          continue;
        }
        const pnlPct = ((currentPrice - meta.avgBuyPrice) / meta.avgBuyPrice) * 100;
        newPositions.set(symbol, {
          symbol,
          units: account.available,
          currentPrice,
          avgBuyPrice: meta.avgBuyPrice,
          buyTimestamp: meta.buyTimestamp,
          pnlPct,
          valueUSD,
        });
      }

      const before = this.positions.size;
      this.positions = newPositions;
      const after = this.positions.size;
      this.lastPollAt = Date.now();
      this.lastPollOk = true;

      if (before !== after || this.pollCount === 1 || staleSkipped > 0) {
        logger.info("Positions refreshed", {
          held: after,
          symbols: [...newPositions.keys()].sort().join(","),
          dustSkipped,
          staleSkipped,
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