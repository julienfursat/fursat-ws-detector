// ─────────────────────────────────────────────────────────────────────────────
// fast-exit-dispatcher.ts — POST SELL signals to fursat.net /api/agent/fast-exit
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors scan.ts fast-exit dispatch contract exactly (same headers, body, behavior).
//
// Body format (must match what fast-exit.ts expects):
//   {
//     symbol, reasonCode, pnlPct, pnlMax, pnlMin,
//     avgBuyPrice, currentPrice,
//     change1h, change15m, change30min,
//     holdingSince,        // = buyTimestamp
//     sellRatio?,          // 0.5 for partial_take, undefined = full sell
//     signalPrice, signalTimestamp
//   }
//
// Headers: same as entry (x-cron-secret, x-agent-secret, x-source: ws-worker)
//
// Cooldown shared with scan.ts via Redis key scan:fast_exit_recent (10 min)
// to prevent the worker AND scan.ts both firing fast-exit on the same symbol
// in a short window.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { redisGet, redisSet } from "./redis.js";

const FURSAT_API_BASE = (process.env.FURSAT_API_BASE ?? "https://www.fursat.net").replace(/\/$/, "");
const FAST_EXIT_URL = `${FURSAT_API_BASE}/api/agent/fast-exit`;
const FAST_EXIT_TIMEOUT_MS = 10_000;

const FAST_EXIT_RECENT_KEY = "scan:fast_exit_recent";
const FAST_EXIT_COOLDOWN_MS = 10 * 60 * 1000;  // 10 min — matches scan.ts

const FAST_EXIT_LOG_KEY = "worker:fast_exits_log";
const MAX_LOG_ENTRIES = 1000;

export interface FastExitDispatchPayload {
  symbol: string;
  reasonCode: "fast_stop_loss" | "fast_ratchet" | "fast_exit_on_green" | "dead_position_exit" | "fast_partial_take";
  pnlPct: number;
  pnlMax?: number;
  pnlMin?: number;
  avgBuyPrice: number;
  currentPrice: number;
  change1h: number | null;
  change15m: number | null;
  change30min: number | null;
  holdingSince: number;
  sellRatio?: number;
}

export interface FastExitDispatchResult {
  ok: boolean;
  status: number | null;
  responseBody: unknown;
  cooldownSkipped: boolean;
  error: string | null;
  durationMs: number;
}

interface FastExitLogEntry {
  ts: number;
  symbol: string;
  reasonCode: string;
  pnlPct: number;
  pnlMax: number | null;
  status: number | null;
  ok: boolean;
  cooldownSkipped: boolean;
  error: string | null;
  durationMs: number;
}

/**
 * Check if a symbol is in cooldown (a fast-exit was dispatched recently).
 * Reads scan:fast_exit_recent. Best-effort.
 */
export async function isInFastExitCooldown(symbol: string): Promise<boolean> {
  try {
    const recent = (await redisGet<Record<string, number>>(FAST_EXIT_RECENT_KEY)) ?? {};
    const lastFiredAt = recent[symbol];
    if (!lastFiredAt) return false;
    return Date.now() - lastFiredAt < FAST_EXIT_COOLDOWN_MS;
  } catch (err) {
    logger.warn("isInFastExitCooldown read failed", { err: (err as Error).message });
    return false;  // err on side of allowing dispatch
  }
}

/**
 * Record that a fast-exit was just dispatched on a symbol (cooldown timer starts).
 * Updates the shared key scan:fast_exit_recent so that both worker and scan.ts
 * see the same cooldown.
 */
async function recordFastExitDispatch(symbol: string): Promise<void> {
  try {
    const now = Date.now();
    const recent = (await redisGet<Record<string, number>>(FAST_EXIT_RECENT_KEY)) ?? {};
    recent[symbol] = now;
    // Prune old entries (>10 min)
    for (const [s, ts] of Object.entries(recent)) {
      if (now - ts > FAST_EXIT_COOLDOWN_MS) delete recent[s];
    }
    await redisSet(FAST_EXIT_RECENT_KEY, recent);
  } catch (err) {
    logger.warn("recordFastExitDispatch failed", { symbol, err: (err as Error).message });
  }
}

/**
 * Dispatch a fast-exit signal to fursat.net.
 *
 * Pre-condition: caller has verified that no cooldown is active (via isInFastExitCooldown).
 * We re-check the cooldown atomically here for safety, but the primary check should
 * happen earlier to avoid building the payload uselessly.
 *
 * Side effects:
 *   • Writes to scan:fast_exit_recent BEFORE the HTTP call (so scan.ts sees the cooldown)
 *   • Logs the result to worker:fast_exits_log
 */
export async function dispatchFastExit(payload: FastExitDispatchPayload): Promise<FastExitDispatchResult> {
  const startedAt = Date.now();
  const cronSecret = process.env.CRON_SECRET ?? process.env.CRYPTO_AGENT_SECRET ?? "";
  if (!cronSecret) {
    const err = "CRON_SECRET (or CRYPTO_AGENT_SECRET) missing — cannot dispatch fast-exit";
    logger.error(err);
    const result: FastExitDispatchResult = {
      ok: false, status: null, responseBody: null,
      cooldownSkipped: false, error: err, durationMs: Date.now() - startedAt,
    };
    await appendFastExitLog(buildLogEntry(payload, result));
    return result;
  }

  // Final cooldown check (defense in depth)
  const cooldownActive = await isInFastExitCooldown(payload.symbol);
  if (cooldownActive) {
    logger.info("Fast-exit SKIPPED — cooldown active", {
      symbol: payload.symbol, reasonCode: payload.reasonCode,
    });
    const result: FastExitDispatchResult = {
      ok: false, status: null, responseBody: null,
      cooldownSkipped: true, error: null, durationMs: Date.now() - startedAt,
    };
    return result;
  }

  // Record cooldown BEFORE dispatch (matches scan.ts behavior).
  // If dispatch fails, the cooldown is still set — that's OK, prevents tight retry loops.
  await recordFastExitDispatch(payload.symbol);

  const body = {
    symbol: payload.symbol,
    reasonCode: payload.reasonCode,
    pnlPct: payload.pnlPct,
    pnlMax: payload.pnlMax,
    pnlMin: payload.pnlMin,
    avgBuyPrice: payload.avgBuyPrice,
    currentPrice: payload.currentPrice,
    change1h: payload.change1h,
    change15m: payload.change15m,
    change30min: payload.change30min,
    holdingSince: payload.holdingSince,
    sellRatio: payload.sellRatio,
    signalPrice: payload.currentPrice,
    signalTimestamp: Date.now(),
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FAST_EXIT_TIMEOUT_MS);

  let result: FastExitDispatchResult;

  try {
    const res = await fetch(FAST_EXIT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cron-secret": cronSecret,
        "x-agent-secret": cronSecret,
        "x-source": "ws-worker",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let responseBody: unknown = null;
    try { responseBody = await res.json(); } catch { /* non-JSON */ }

    if (res.ok) {
      logger.info("Fast-exit dispatched OK", {
        symbol: payload.symbol, reasonCode: payload.reasonCode,
        pnlPct: payload.pnlPct.toFixed(1),
      });
    } else {
      logger.warn("Fast-exit HTTP error", {
        symbol: payload.symbol, status: res.status,
      });
    }

    result = {
      ok: res.ok,
      status: res.status,
      responseBody,
      cooldownSkipped: false,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    const errMessage = (err as Error).message ?? String(err);
    const errName = (err as Error).name ?? "unknown";
    logger.warn("Fast-exit dispatch failed", {
      symbol: payload.symbol, errName, errMessage,
    });
    result = {
      ok: false, status: null, responseBody: null,
      cooldownSkipped: false,
      error: `${errName}: ${errMessage}`,
      durationMs: Date.now() - startedAt,
    };
  }

  await appendFastExitLog(buildLogEntry(payload, result));
  return result;
}

function buildLogEntry(payload: FastExitDispatchPayload, result: FastExitDispatchResult): FastExitLogEntry {
  return {
    ts: Date.now(),
    symbol: payload.symbol,
    reasonCode: payload.reasonCode,
    pnlPct: payload.pnlPct,
    pnlMax: payload.pnlMax ?? null,
    status: result.status,
    ok: result.ok,
    cooldownSkipped: result.cooldownSkipped,
    error: result.error,
    durationMs: result.durationMs,
  };
}

async function appendFastExitLog(entry: FastExitLogEntry): Promise<void> {
  try {
    const existing = (await redisGet<FastExitLogEntry[]>(FAST_EXIT_LOG_KEY)) ?? [];
    const updated = [entry, ...existing].slice(0, MAX_LOG_ENTRIES);
    await redisSet(FAST_EXIT_LOG_KEY, updated);
  } catch (err) {
    logger.warn("Failed to append fast-exit log", { err: (err as Error).message });
  }
}
