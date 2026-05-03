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
import { PnlTracker } from "./pnl-tracker.js";

const TRADE_META_KEY = "agent:trade_meta";
// BACKLOG-3 phase 3 (2026-05-02) — Reduced from 30_000 to 5_000.
// The 30s interval created up to 30s of "blind window" right after a worker BUY,
// during which fast_slow_down/fast_tp/fast_sl rules could not evaluate (the asset
// wasn't yet in the positions map). At 5s, this window shrinks to ≤5s, giving
// sub-min rules effective coverage on short-lived trades (BOBBOB/QI/RLS/SYND-style,
// 2-5min duration). Coinbase rate limit (30 req/s) is comfortably respected:
// 1 paginated /accounts call per 5s ≈ 0.2 req/s.
const POLL_INTERVAL_MS = 5_000;

// BACKLOG-3 phase 3 (2026-05-02) — Vercel /api/agent/positions integration.
// Authoritative cost basis source. The endpoint computes independentCostBasis
// the same way cron.ts does (chronological BUYs - SELLs from Coinbase order
// history). Timeout is conservative — Vercel typically responds in 200-800ms
// (cache hit ~50ms, cache miss ~500-1000ms with Coinbase round-trips).
// 5s gives margin for cold-start while keeping the 5s poll cadence honest.
const VERCEL_POSITIONS_TIMEOUT_MS = 5_000;

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
  // PUMP-1H DETECTOR (NEW 2026-05-03) — Optional dispatch source. When
  // "worker-pump1h", fast-exit-evaluator routes to pump1h-specific exit
  // thresholds. When undefined or any other value, uses standard thresholds.
  dispatchSource?: string;
}

interface TradeMetaEntry {
  type?: string;
  symbol?: string;
  avgBuyPrice?: number;
  buyTimestamp?: number;
  // PUMP-1H DETECTOR (NEW 2026-05-03) — read by pollFromTradeMeta to populate
  // AgentPosition.dispatchSource. Set by entry.ts (Vercel) when storing a BUY
  // dispatched from worker-pump1h or worker-early.
  dispatchSource?: string;
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

  // BACKLOG-3 phase 3.1 (2026-05-02) — Trou B fix: optional pnlTracker reference
  // so we can prune stale entries (positions closed externally — manual SELL via
  // Coinbase app, or MANAGE cron SELL — would otherwise leave their pnlMax/pnlMin
  // entries lingering in the tracker. Next BUY of the same symbol would inherit
  // the stale pnlMax and trigger fast_ratchet immediately on first tick (drop
  // from old peak > 3 pts threshold). Wired via setPnlTracker() to keep the
  // constructor signature unchanged and avoid breaking existing call sites.
  private pnlTracker: PnlTracker | null = null;

  /**
   * Wire the PnlTracker that should be pruned whenever positions change.
   * Optional — if not set, positions tracking works as before but stale entries
   * may accumulate in the PnlTracker (acceptable degradation).
   */
  setPnlTracker(tracker: PnlTracker): void {
    this.pnlTracker = tracker;
  }

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
   * Single poll cycle.
   *
   * BACKLOG-3 phase 3 (2026-05-02) — Authoritative cost basis from Vercel.
   * Primary path: fetch /api/agent/positions which computes independentCostBasis
   * the same way cron.ts does (chronological BUYs - SELLs from Coinbase order history).
   * This is the single source of truth for cost basis and avoids the trade_meta
   * pitfalls (append-only history shadowing, race conditions, missed manual SELLs).
   *
   * Fallback path: if Vercel is unavailable, use the legacy trade_meta logic
   * with a stale-meta guard (24h cutoff) so we keep functioning even if /api/agent/positions
   * is down. The fallback is less accurate (still has the multi-BUY DCA shadowing issue)
   * but ensures resilience.
   */
  private async pollNow(): Promise<void> {
    this.pollCount++;
    try {
      const newPositions = await this.pollFromVercel();
      if (newPositions !== null) {
        this.applyNewPositions(newPositions, "vercel");
        return;
      }
      // Vercel returned null = unavailable. Fall back to trade_meta logic.
      logger.warn("Vercel /api/agent/positions unavailable, falling back to trade_meta");
      const fallbackPositions = await this.pollFromTradeMeta();
      this.applyNewPositions(fallbackPositions, "trade_meta_fallback");
    } catch (err) {
      this.pollErrors++;
      this.lastPollOk = false;
      logger.warn("Positions poll failed", { err: (err as Error).message });
    }
  }

  /**
   * Apply a new positions map (from any source). Preserves previously-known
   * currentPrice across refreshes so we don't reset to the avgBuyPrice placeholder
   * on every poll (the WS evaluator updates it tick-by-tick anyway).
   */
  private applyNewPositions(newPositions: Map<string, AgentPosition>, source: string): void {
    // Carry over currentPrice from previous map if available
    for (const [symbol, pos] of newPositions.entries()) {
      const prev = this.positions.get(symbol);
      if (prev?.currentPrice) {
        pos.currentPrice = prev.currentPrice;
        pos.pnlPct = ((prev.currentPrice - pos.avgBuyPrice) / pos.avgBuyPrice) * 100;
        pos.valueUSD = pos.units * prev.currentPrice;
      }
    }

    const before = this.positions.size;
    this.positions = newPositions;
    const after = this.positions.size;
    this.lastPollAt = Date.now();
    this.lastPollOk = true;

    if (before !== after || this.pollCount === 1) {
      logger.info("Positions refreshed", {
        source,
        held: after,
        symbols: [...newPositions.keys()].sort().join(","),
      });
    }

    // BACKLOG-3 phase 3.1 (2026-05-02) — Trou B fix: prune stale PnlTracker entries.
    // Positions closed externally (manual SELL via Coinbase app, or MANAGE cron SELL)
    // would otherwise leave their pnlMax/pnlMin entries in the tracker. A subsequent
    // BUY of the same symbol would inherit the stale peak and trigger fast_ratchet
    // on first tick. Pruning on every poll guarantees the tracker mirrors the actual
    // held set within at most POLL_INTERVAL_MS (5s).
    if (this.pnlTracker) {
      this.pnlTracker.pruneToHeld(new Set(newPositions.keys()));
    }
  }

  /**
   * Primary path: fetch authoritative positions from Vercel /api/agent/positions.
   * Returns null if the endpoint is unreachable (so caller can fall back).
   * Returns an empty map if the endpoint is reachable but reports no positions
   * (legitimate "no agent positions held" state).
   */
  private async pollFromVercel(): Promise<Map<string, AgentPosition> | null> {
    const baseUrl = (process.env.FURSAT_API_BASE ?? "https://www.fursat.net").replace(/\/$/, "");
    const secret = process.env.CRYPTO_AGENT_SECRET ?? "";
    if (!secret) {
      // Without a secret we can't authenticate. Skip primary, go to fallback.
      return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), VERCEL_POSITIONS_TIMEOUT_MS);
    try {
      const res = await fetch(`${baseUrl}/api/agent/positions`, {
        method: "GET",
        headers: { "x-agent-secret": secret },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        logger.warn("Vercel /positions HTTP error", { status: res.status });
        return null;
      }
      const data: any = await res.json();
      const positionsMap = new Map<string, AgentPosition>();
      const remote = data.positions ?? {};
      for (const symbol of Object.keys(remote)) {
        const r = remote[symbol];
        if (!r || typeof r.units !== "number" || typeof r.avgBuyPrice !== "number") continue;
        if (r.units <= 0 || r.avgBuyPrice <= 0) continue;
        // Use avgBuyPrice as the placeholder current price; per-tick updates will refresh it.
        positionsMap.set(symbol, {
          symbol,
          units: r.units,
          currentPrice: r.avgBuyPrice,
          avgBuyPrice: r.avgBuyPrice,
          buyTimestamp: r.lastBuyTs ?? Date.now(),
          pnlPct: 0,
          valueUSD: r.valueUSD ?? (r.units * r.avgBuyPrice),
          // PUMP-1H DETECTOR (2026-05-03) — Read dispatchSource from Vercel response.
          // The Vercel /api/agent/positions endpoint returns this field per symbol
          // when the position originates from a worker-pump1h dispatch. When
          // undefined, fast-exit-evaluator falls back to standard sub-min thresholds
          // (no behavioral change on early_pump positions).
          dispatchSource: r.dispatchSource,
        });
      }
      return positionsMap;
    } catch (err) {
      clearTimeout(timeoutId);
      logger.warn("Vercel /positions fetch failed", { err: (err as Error).message });
      return null;
    }
  }

  /**
   * Fallback path: legacy trade_meta logic with stale-meta guard.
   * Used when Vercel /api/agent/positions is unreachable.
   * Less accurate (multi-BUY shadowing remains) but keeps the worker functional.
   */
  private async pollFromTradeMeta(): Promise<Map<string, AgentPosition>> {
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

    // 2. Read trade_meta with stale-meta guard (24h cutoff) — workaround for the
    // append-only-history shadowing bug. The /api/agent/positions endpoint is the
    // proper fix; this is the resilience-fallback only.
    const STALE_META_MAX_AGE_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const tradeMeta = (await redisGet<Record<string, TradeMetaEntry>>(TRADE_META_KEY)) ?? {};
    const metaBySymbol = new Map<string, { avgBuyPrice: number; buyTimestamp: number; dispatchSource?: string }>();
    for (const orderId of Object.keys(tradeMeta)) {
      const meta = tradeMeta[orderId];
      // PUMP-1H DETECTOR (2026-05-03) — Accept both "opportunity" (early_pump
      // and classical alt_pump) AND "opportunity-pump1h" (sustained pump).
      // Both types represent agent-managed BUYs that the worker should track.
      if (!meta || (meta.type !== "opportunity" && meta.type !== "opportunity-pump1h")) continue;
      if (typeof meta.avgBuyPrice !== "number" || typeof meta.buyTimestamp !== "number" || !meta.symbol) continue;
      if ((now - meta.buyTimestamp) > STALE_META_MAX_AGE_MS) continue;
      const existing = metaBySymbol.get(meta.symbol);
      if (!existing || meta.buyTimestamp > existing.buyTimestamp) {
        metaBySymbol.set(meta.symbol, {
          avgBuyPrice: meta.avgBuyPrice,
          buyTimestamp: meta.buyTimestamp,
          dispatchSource: meta.dispatchSource,
        });
      }
    }

    // 3. Build the new positions map: held symbols ∩ has-trade-meta ∩ not-dust
    const newPositions = new Map<string, AgentPosition>();
    for (const [symbol, account] of accountsBySymbol.entries()) {
      const meta = metaBySymbol.get(symbol);
      if (!meta) continue;
      const valueUSD = account.available * meta.avgBuyPrice;
      if (valueUSD < DUST_THRESHOLD_USD) continue;
      newPositions.set(symbol, {
        symbol,
        units: account.available,
        currentPrice: meta.avgBuyPrice,
        avgBuyPrice: meta.avgBuyPrice,
        buyTimestamp: meta.buyTimestamp,
        pnlPct: 0,
        valueUSD,
        dispatchSource: meta.dispatchSource,  // PUMP-1H DETECTOR (2026-05-03)
      });
    }
    return newPositions;
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