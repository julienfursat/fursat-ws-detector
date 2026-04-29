// ─────────────────────────────────────────────────────────────────────────────
// ring-buffers.ts — Ring buffers per-asset for 5m/15m/1h/4h price snapshots
// ─────────────────────────────────────────────────────────────────────────────
// Maintains a circular buffer of historical prices per asset, snapshotted at
// regular intervals. Allows O(1) lookup of "what was the price N minutes ago"
// to compute change5m, change15m, change1h, change4h on any given tick.
//
// Memory layout (per asset):
//   • currentPrice      : updated on every tick
//   • currentVolume24h  : updated on every tick
//   • shortBuffer       : Float64Array(720) — 720 snapshots × 5s = 1h history
//                         Used for change5m, change15m, change1h
//   • longBuffer        : Float64Array(480) — 480 snapshots × 30s = 4h history
//                         Used for change4h and the 2h peak window (for drawdown)
//
// Snapshots are written by a single timer (every 5s for short, every 30s for long).
// When a buffer slot is uninitialized (just-listed asset, < N min of history),
// the value stored is NaN — readers test isNaN() and return null for that change.
//
// Total memory: ~250 assets × (720 + 480) floats × 8 bytes ≈ 2.4 MB. Trivial.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";

const SHORT_INTERVAL_MS = 5_000;       // 5s between short snapshots
const SHORT_BUFFER_SIZE = 720;         // 720 × 5s = 3600s = 1h
const LONG_INTERVAL_MS = 30_000;       // 30s between long snapshots
const LONG_BUFFER_SIZE = 480;          // 480 × 30s = 14400s = 4h

// Lookup offsets in the short buffer (in slots)
const SHORT_OFFSET_5M = Math.round((5 * 60_000) / SHORT_INTERVAL_MS);   // 60
const SHORT_OFFSET_15M = Math.round((15 * 60_000) / SHORT_INTERVAL_MS); // 180
const SHORT_OFFSET_1H = Math.round((60 * 60_000) / SHORT_INTERVAL_MS);  // 720 (= full buffer)
// Lookup offsets in the long buffer
const LONG_OFFSET_4H = Math.round((4 * 60 * 60_000) / LONG_INTERVAL_MS); // 480 (= full buffer)
const LONG_OFFSET_2H = Math.round((2 * 60 * 60_000) / LONG_INTERVAL_MS); // 240

interface AssetBuffers {
  symbol: string;
  currentPrice: number;
  currentVolume24h: number;
  // Short buffer — 5s granularity, 1h horizon. Used for 5m/15m/1h lookups.
  shortBuffer: Float64Array;
  shortHead: number;          // next write position
  shortFilledCount: number;   // how many slots are filled (caps at SHORT_BUFFER_SIZE)
  // Long buffer — 30s granularity, 4h horizon. Used for 4h lookup + 2h peak.
  longBuffer: Float64Array;
  longHead: number;
  longFilledCount: number;
  // Last update timestamp — for staleness checks
  lastTickAt: number;
}

export interface PriceSnapshot {
  currentPrice: number;
  volume24h: number;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change4h: number | null;
  // Drawdown from peak over 2h window. Null if not enough samples.
  drawdownFromPeak: number;
  peakSampleCount: number;
}

export class RingBuffers {
  private buffers = new Map<string, AssetBuffers>();
  private shortTimer: NodeJS.Timeout | null = null;
  private longTimer: NodeJS.Timeout | null = null;
  private snapshotsCount = 0;
  private startedAt = 0;

  /**
   * Update the current price/volume for an asset on every tick.
   * Allocates the buffer lazily on first observation.
   */
  updateTick(symbol: string, price: number, volume24h: number, timestamp: number): void {
    let buf = this.buffers.get(symbol);
    if (!buf) {
      buf = {
        symbol,
        currentPrice: price,
        currentVolume24h: volume24h,
        shortBuffer: new Float64Array(SHORT_BUFFER_SIZE).fill(NaN),
        shortHead: 0,
        shortFilledCount: 0,
        longBuffer: new Float64Array(LONG_BUFFER_SIZE).fill(NaN),
        longHead: 0,
        longFilledCount: 0,
        lastTickAt: timestamp,
      };
      this.buffers.set(symbol, buf);
    } else {
      buf.currentPrice = price;
      buf.currentVolume24h = volume24h;
      buf.lastTickAt = timestamp;
    }
  }

  /**
   * Compute a price snapshot for an asset.
   * Returns null if no tick has been observed for this symbol.
   *
   * change_n = (currentPrice - referencePrice_n) / referencePrice_n × 100
   * referencePrice_n = price stored N slots before current head (or null if not filled)
   */
  getSnapshot(symbol: string): PriceSnapshot | null {
    const buf = this.buffers.get(symbol);
    if (!buf) return null;

    const change5m = this.computeChange(buf, "short", SHORT_OFFSET_5M);
    const change15m = this.computeChange(buf, "short", SHORT_OFFSET_15M);
    const change1h = this.computeChange(buf, "short", SHORT_OFFSET_1H);
    const change4h = this.computeChange(buf, "long", LONG_OFFSET_4H);

    // Drawdown from peak over the last 2h, using long buffer (30s granularity).
    // We scan the last LONG_OFFSET_2H slots (or fewer if buffer not yet full)
    // and find the max price observed.
    const samplesToScan = Math.min(buf.longFilledCount, LONG_OFFSET_2H);
    let peakPrice = buf.currentPrice;
    let peakSampleCount = 0;
    if (samplesToScan > 0) {
      for (let i = 1; i <= samplesToScan; i++) {
        // Walk backward from the most recent slot
        const slotIdx = (buf.longHead - i + LONG_BUFFER_SIZE) % LONG_BUFFER_SIZE;
        const v = buf.longBuffer[slotIdx];
        if (!isNaN(v) && v > 0) {
          peakSampleCount++;
          if (v > peakPrice) peakPrice = v;
        }
      }
    }
    const drawdownFromPeak = peakPrice > 0
      ? ((buf.currentPrice - peakPrice) / peakPrice) * 100
      : 0;

    return {
      currentPrice: buf.currentPrice,
      volume24h: buf.currentVolume24h,
      change5m, change15m, change1h, change4h,
      drawdownFromPeak,
      peakSampleCount,
    };
  }

  /**
   * Returns the number of slots currently filled for diagnostic purposes.
   * Useful to know "is this asset's history mature enough for filters?"
   */
  getFillStatus(symbol: string): { shortFilled: number; longFilled: number } | null {
    const buf = this.buffers.get(symbol);
    if (!buf) return null;
    return { shortFilled: buf.shortFilledCount, longFilled: buf.longFilledCount };
  }

  /** Number of distinct assets being tracked. */
  size(): number {
    return this.buffers.size;
  }

  stats(): { assets: number; snapshotsTotal: number; uptimeMs: number } {
    return {
      assets: this.buffers.size,
      snapshotsTotal: this.snapshotsCount,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  start(): void {
    this.startedAt = Date.now();
    // Short buffer: snapshot every 5s
    this.shortTimer = setInterval(() => {
      for (const buf of this.buffers.values()) {
        buf.shortBuffer[buf.shortHead] = buf.currentPrice;
        buf.shortHead = (buf.shortHead + 1) % SHORT_BUFFER_SIZE;
        if (buf.shortFilledCount < SHORT_BUFFER_SIZE) buf.shortFilledCount++;
      }
      this.snapshotsCount++;
    }, SHORT_INTERVAL_MS);

    // Long buffer: snapshot every 30s
    this.longTimer = setInterval(() => {
      for (const buf of this.buffers.values()) {
        buf.longBuffer[buf.longHead] = buf.currentPrice;
        buf.longHead = (buf.longHead + 1) % LONG_BUFFER_SIZE;
        if (buf.longFilledCount < LONG_BUFFER_SIZE) buf.longFilledCount++;
      }
    }, LONG_INTERVAL_MS);

    logger.info("RingBuffers started", {
      shortIntervalMs: SHORT_INTERVAL_MS,
      shortBufferSize: SHORT_BUFFER_SIZE,
      longIntervalMs: LONG_INTERVAL_MS,
      longBufferSize: LONG_BUFFER_SIZE,
    });
  }

  stop(): void {
    if (this.shortTimer) clearInterval(this.shortTimer);
    if (this.longTimer) clearInterval(this.longTimer);
    this.shortTimer = null;
    this.longTimer = null;
  }

  /**
   * Force one snapshot in BOTH short and long buffers for ALL tracked assets.
   * Called by preload.ts to plant historical snapshots into the buffers.
   * Bypasses the timer-based snapshotting — used during warm-start only.
   */
  takeSnapshotForPreload(): void {
    for (const buf of this.buffers.values()) {
      // Short buffer slot
      buf.shortBuffer[buf.shortHead] = buf.currentPrice;
      buf.shortHead = (buf.shortHead + 1) % SHORT_BUFFER_SIZE;
      if (buf.shortFilledCount < SHORT_BUFFER_SIZE) buf.shortFilledCount++;
      // Long buffer slot
      buf.longBuffer[buf.longHead] = buf.currentPrice;
      buf.longHead = (buf.longHead + 1) % LONG_BUFFER_SIZE;
      if (buf.longFilledCount < LONG_BUFFER_SIZE) buf.longFilledCount++;
    }
    this.snapshotsCount++;
  }

  /**
   * Compute the percent change between current price and the price stored
   * `offset` slots before the current head in the requested buffer.
   * Returns null if the buffer hasn't been filled enough (i.e. that offset
   * slot is still NaN — asset was just listed or worker just started).
   */
  private computeChange(buf: AssetBuffers, kind: "short" | "long", offset: number): number | null {
    const buffer = kind === "short" ? buf.shortBuffer : buf.longBuffer;
    const head = kind === "short" ? buf.shortHead : buf.longHead;
    const filledCount = kind === "short" ? buf.shortFilledCount : buf.longFilledCount;
    const size = kind === "short" ? SHORT_BUFFER_SIZE : LONG_BUFFER_SIZE;

    if (filledCount < offset) return null;
    // Slot at `offset` positions back from head
    const slotIdx = (head - offset + size) % size;
    const refPrice = buffer[slotIdx];
    if (isNaN(refPrice) || refPrice <= 0) return null;
    return ((buf.currentPrice - refPrice) / refPrice) * 100;
  }
}