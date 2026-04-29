// ─────────────────────────────────────────────────────────────────────────────
// coinbase-rest.ts — Authenticated Coinbase Advanced REST helper
// ─────────────────────────────────────────────────────────────────────────────
// Mirrors fursat.net/src/lib/coinbase.ts coinbaseFetch() but on the worker side.
// Used by positions.ts to poll /accounts.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";
import { buildRestJWT } from "./jwt.js";

const COINBASE_BASE = "https://api.coinbase.com";

export interface CoinbaseFetchResult {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
}

/**
 * Authenticated GET/POST to Coinbase Advanced. Reads CDP credentials from env:
 *   COINBASE_API_KEY     (organizations/<uuid>/apiKeys/<uuid>)
 *   COINBASE_API_SECRET  (PEM private key, EC P-256)
 *
 * Returns { ok, status, data } — never throws on HTTP failures, returns ok=false instead.
 * Throws only on env misconfiguration.
 */
export async function coinbaseFetch(
  method: "GET" | "POST",
  path: string,
  body?: any
): Promise<CoinbaseFetchResult> {
  const apiKey = process.env.COINBASE_API_KEY ?? "";
  const apiSecret = process.env.COINBASE_API_SECRET ?? "";
  if (!apiKey || !apiSecret) {
    throw new Error("COINBASE_API_KEY / COINBASE_API_SECRET missing");
  }

  // The path used for JWT signing must be the URL path WITHOUT query string.
  const pathForJwt = path.split("?")[0];
  const jwt = buildRestJWT(apiKey, apiSecret, method, pathForJwt);

  const url = `${COINBASE_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${jwt}`,
    "Content-Type": "application/json",
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      logger.warn("coinbaseFetch non-OK", {
        method, path: pathForJwt, status: res.status,
        msg: data?.error_response?.message ?? data?.message ?? "?",
      });
      return { ok: false, status: res.status, data, error: data?.error_response?.message ?? data?.message };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    logger.warn("coinbaseFetch threw", { method, path: pathForJwt, err: (err as Error).message });
    return { ok: false, status: 0, data: null, error: (err as Error).message };
  }
}
