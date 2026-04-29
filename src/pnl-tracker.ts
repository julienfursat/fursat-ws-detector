// ─────────────────────────────────────────────────────────────────────────────
// pnl-tracker.ts — Track pnlMax and pnlMin for each held position
// ─────────────────────────────────────────────────────────────────────────────
// fast_ratchet uses pnlMax (peak PnL) to detect retracements.
// fast_exit_on_green uses pnlMin (trough PnL) to detect recovery.
//
// Both are tracked in-memory by the worker. They reset to current pnlPct when
// the worker restarts — that's acceptable because:
//   • scan.ts also recomputes pnlMax/pnlMin at each scan (no cross-process sync)
//   • A fresh worker boot just means we start tracking from "now" — at worst,
//     fast_ratchet doesn't fire on positions that were already at pnlMax pre-restart
//   • For positions older than restart, scan.ts (still active) will catch them
//
// We persist the tracker state to Redis every 5 min so a restart doesn't lose
// too much history. Restored at boot.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";

const TRACKER_KEY = "worker:pnl_tracker";
const PERSIST_INTERVAL_MS = 5 * 60 * 1000;  // 5 min

interface PnlEntry {
  pnlMax: number;
  pnlMin: number;
  lastUpdatedAt: number;
}

export class PnlTracker {
  private entries: Map<string, PnlEntry> = new Map();
  private timer: any = null;
  private dirtySinceLastPersist = false;

  /**
   * Update tracker for a symbol with the latest pnlPct.
   * Returns the updated max/min (after applying this update).
   */
  update(symbol: string, pnlPct: number): { pnlMax: number; pnlMin: number } {
    const now = Date.now();
    const existing = this.entries.get(symbol);
    if (!existing) {
      const e: PnlEntry = { pnlMax: pnlPct, pnlMin: pnlPct, lastUpdatedAt: now };
      this.entries.set(symbol, e);
      this.dirtySinceLastPersist = true;
      return { pnlMax: e.pnlMax, pnlMin: e.pnlMin };
    }
    let changed = false;
    if (pnlPct > existing.pnlMax) { existing.pnlMax = pnlPct; changed = true; }
    if (pnlPct < existing.pnlMin) { existing.pnlMin = pnlPct; changed = true; }
    existing.lastUpdatedAt = now;
    if (changed) this.dirtySinceLastPersist = true;
    return { pnlMax: existing.pnlMax, pnlMin: existing.pnlMin };
  }

  /**
   * Returns the current max/min for a symbol, or undefined if not tracked yet.
   */
  get(symbol: string): { pnlMax: number; pnlMin: number } | undefined {
    const e = this.entries.get(symbol);
    return e ? { pnlMax: e.pnlMax, pnlMin: e.pnlMin } : undefined;
  }

  /**
   * Drop tracking for a symbol (called when position is closed via fast-exit).
   */
  drop(symbol: string): void {
    if (this.entries.delete(symbol)) {
      this.dirtySinceLastPersist = true;
    }
  }

  /**
   * Prune entries for symbols not in the active set (positions closed externally).
   */
  pruneToHeld(heldSymbols: Set<string>): void {
    let removed = 0;
    for (const sym of [...this.entries.keys()]) {
      if (!heldSymbols.has(sym)) {
        this.entries.delete(sym);
        removed++;
      }
    }
    if (removed > 0) {
      this.dirtySinceLastPersist = true;
      logger.debug("PnlTracker pruned", { removed });
    }
  }

  /**
   * Boot: load state from Redis if available.
   */
  async loadFromRedis(): Promise<void> {
    try {
      const data = await redisGet<Record<string, PnlEntry>>(TRACKER_KEY);
      if (data && typeof data === "object") {
        for (const [sym, entry] of Object.entries(data)) {
          if (entry && typeof entry.pnlMax === "number" && typeof entry.pnlMin === "number") {
            this.entries.set(sym, {
              pnlMax: entry.pnlMax,
              pnlMin: entry.pnlMin,
              lastUpdatedAt: entry.lastUpdatedAt ?? Date.now(),
            });
          }
        }
        logger.info("PnlTracker loaded from Redis", { entries: this.entries.size });
      }
    } catch (err) {
      logger.warn("PnlTracker load failed", { err: (err as Error).message });
    }
  }

  /**
   * Start periodic persist loop.
   */
  start(): void {
    this.timer = setInterval(() => { void this.persist(); }, PERSIST_INTERVAL_MS);
    logger.info("PnlTracker persist loop started", { intervalMs: PERSIST_INTERVAL_MS });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats() {
    return {
      tracked: this.entries.size,
      dirty: this.dirtySinceLastPersist,
    };
  }

  private async persist(): Promise<void> {
    if (!this.dirtySinceLastPersist) return;
    try {
      const out: Record<string, PnlEntry> = {};
      for (const [sym, entry] of this.entries.entries()) {
        out[sym] = entry;
      }
      await redisSet(TRACKER_KEY, out);
      this.dirtySinceLastPersist = false;
    } catch (err) {
      logger.warn("PnlTracker persist failed", { err: (err as Error).message });
    }
  }
}
