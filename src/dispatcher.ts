// ─────────────────────────────────────────────────────────────────────────────
// dispatcher.ts — POST signal candidates to fursat.net /api/agent/entry
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors the dispatch contract used by scan.ts (same headers, same body shape,
// same handling of skip reasons).
//
// Body format (must match what entry.ts expects):
//   {
//     signal: {
//       symbol, change5m, change15m, change1h, change24h,
//       volume24h, drawdownFromPeak,
//       severity, signalType, triggerSource,
//       signalPrice, signalTimestamp
//     }
//   }
//
// Headers:
//   Content-Type: application/json
//   x-cron-secret: <CRON_SECRET>
//   x-agent-secret: <CRON_SECRET>     (entry.ts accepts either)
//   x-source: ws-worker                (custom, lets entry.ts logs distinguish source)
//
// Response handling:
//   • { skipped: true, reason: "..." } → check if reason is TRANSIENT
//     - transient → release per-asset throttle (eligible on next signal)
//     - persistent → keep throttle (30min cooldown)
//   • { success: true, ... }            → keep throttle
//   • HTTP non-2xx                       → keep throttle (be conservative)
//   • Network/timeout                    → keep throttle
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";
import { recordDispatch, releaseAssetThrottle } from "./throttle.js";

const FURSAT_API_BASE = (process.env.FURSAT_API_BASE ?? "https://www.fursat.net").replace(/\/$/, "");
const ENTRY_URL = `${FURSAT_API_BASE}/api/agent/entry`;
const ENTRY_TIMEOUT_MS = 10_000;   // matches scan.ts

const DISPATCH_LOG_KEY = "worker:dispatches_log";
const MAX_DISPATCH_LOG = 1000;

// Must match scan.ts TRANSIENT_SKIP_REASONS
const TRANSIENT_SKIP_REASONS = new Set([
  "parallel_cap",
  "btc_below_floor",
  "signal_too_weak",
  "amount_too_small",
  "insufficient_financing",
]);

export interface DispatchSignal {
  symbol: string;
  change5m: number | null;
  change15m: number | null;
  change1h: number | null;
  change24h: number;
  volume24h: number;
  drawdownFromPeak: number;
  severity: "weak" | "strong" | "major";
  signalType: "alt_pump" | "major_crash" | "position_crash" | "major_pump";
  triggerSource: "5m" | "15m" | "1h" | null;
  signalPrice: number;
  signalTimestamp: number;
}

export interface DispatchResult {
  ok: boolean;
  status: number | null;
  responseBody: unknown;
  skipped: boolean;
  skipReason: string | null;
  throttleReleased: boolean;
  error: string | null;
  durationMs: number;
}

interface DispatchLogEntry {
  ts: number;
  symbol: string;
  severity: string;
  signalType: string;
  triggerSource: string | null;
  status: number | null;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  throttleReleased: boolean;
  error: string | null;
  durationMs: number;
}

/**
 * Dispatch a signal to fursat.net /api/agent/entry.
 *
 * Pre-conditions (caller must check before invoking):
 *   • Throttle clear (checkThrottle returned allowed=true)
 *   • Asset not blacklisted (isBlacklisted returned blacklisted=false)
 *   • Signal is a valid candidate (passed classifySignal)
 *
 * Side effects:
 *   • Always records dispatch in scan:dispatched_assets (so scan.ts sees it)
 *   • Logs full result to worker:dispatches_log
 *   • If response = transient skip, releases the per-asset throttle
 */
export async function dispatchEntry(signal: DispatchSignal): Promise<DispatchResult> {
  const startedAt = Date.now();
  const cronSecret = process.env.CRON_SECRET ?? process.env.CRYPTO_AGENT_SECRET ?? "";
  if (!cronSecret) {
    const err = "CRON_SECRET (or CRYPTO_AGENT_SECRET) missing — cannot dispatch";
    logger.error(err);
    const result: DispatchResult = {
      ok: false, status: null, responseBody: null,
      skipped: false, skipReason: null, throttleReleased: false,
      error: err, durationMs: Date.now() - startedAt,
    };
    await appendDispatchLog(buildLogEntry(signal, result));
    return result;
  }

  // Record dispatch in shared throttle BEFORE the HTTP call. If the call
  // fails or times out, the throttle stays — better to err on the side of
  // not double-dispatching. (If response is transient skip, we release after.)
  // BACKLOG-3 phase 3 (2026-05-02) — pass signalType so the right hourly bucket
  // is incremented (alt_pump uses 3/hr cap, early_pump uses 10/hr cap).
  const throttleSignalType = signal.signalType === "early_pump" ? "early_pump" : "alt_pump";
  await recordDispatch(signal.symbol, throttleSignalType);

  const payload = { signal };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ENTRY_TIMEOUT_MS);

  let result: DispatchResult;

  try {
    const res = await fetch(ENTRY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": cronSecret,
        "x-agent-secret": cronSecret,
        "x-source": "ws-worker",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON response */ }

    const skipped = isObject(body) && body.skipped === true;
    const reason = (skipped && isObject(body) && typeof body.reason === "string") ? body.reason : null;
    let throttleReleased = false;

    if (skipped && reason && TRANSIENT_SKIP_REASONS.has(reason)) {
      // Transient — release the throttle so the asset is eligible again
      await releaseAssetThrottle(signal.symbol);
      throttleReleased = true;
      logger.info("Dispatch SKIPPED (transient) — throttle released", {
        symbol: signal.symbol, reason,
      });
    } else if (skipped) {
      logger.info("Dispatch SKIPPED (persistent) — throttle kept 30min", {
        symbol: signal.symbol, reason,
      });
    } else if (res.ok) {
      logger.info("Dispatch OK", {
        symbol: signal.symbol, severity: signal.severity, status: res.status,
      });
    } else {
      logger.warn("Dispatch HTTP error — throttle kept", {
        symbol: signal.symbol, status: res.status,
      });
    }

    result = {
      ok: res.ok && !skipped,
      status: res.status,
      responseBody: body,
      skipped,
      skipReason: reason,
      throttleReleased,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMessage = (err as Error).message ?? String(err);
    const errName = (err as Error).name ?? "unknown";
    logger.warn("Dispatch failed/aborted — throttle kept", {
      symbol: signal.symbol, errName, errMessage,
    });
    result = {
      ok: false, status: null, responseBody: null,
      skipped: false, skipReason: null, throttleReleased: false,
      error: `${errName}: ${errMessage}`,
      durationMs: Date.now() - startedAt,
    };
  }

  await appendDispatchLog(buildLogEntry(signal, result));
  return result;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function buildLogEntry(signal: DispatchSignal, result: DispatchResult): DispatchLogEntry {
  return {
    ts: Date.now(),
    symbol: signal.symbol,
    severity: signal.severity,
    signalType: signal.signalType,
    triggerSource: signal.triggerSource,
    status: result.status,
    ok: result.ok,
    skipped: result.skipped,
    skipReason: result.skipReason,
    throttleReleased: result.throttleReleased,
    error: result.error,
    durationMs: result.durationMs,
  };
}

/**
 * Append to worker:dispatches_log (kept bounded at MAX_DISPATCH_LOG entries,
 * newest-first). Best-effort — failure here doesn't affect the dispatch outcome.
 */
async function appendDispatchLog(entry: DispatchLogEntry): Promise<void> {
  try {
    const existing = (await redisGet<DispatchLogEntry[]>(DISPATCH_LOG_KEY)) ?? [];
    const updated = [entry, ...existing].slice(0, MAX_DISPATCH_LOG);
    await redisSet(DISPATCH_LOG_KEY, updated);
  } catch (err) {
    logger.warn("Failed to append dispatch log", { err: (err as Error).message });
  }
}