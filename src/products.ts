// ─────────────────────────────────────────────────────────────────────────────
// products.ts — fetch tradable *-USDC products from Coinbase Advanced REST
// ─────────────────────────────────────────────────────────────────────────────
// Uses the PUBLIC Coinbase Advanced products endpoint — no authentication needed.
// Filters out: stables, disabled products, auction-mode products.
// Refreshed periodically by the worker (every PRODUCT_REFRESH_INTERVAL_MS).
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "./logger.js";

const STABLES = new Set([
  "USDC", "USDT", "DAI", "BUSD", "TUSD", "USDP",
  "GUSD", "PYUSD", "FRAX", "EURC",
]);

const COINBASE_PUBLIC_PRODUCTS_URL =
  "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=500";

/**
 * Returns the set of tradable altcoin symbols (without -USDC suffix) currently
 * available for spot trading on Coinbase Advanced. Symbols are filtered to
 * exclude stables, disabled products, and auction-mode products.
 */
export async function fetchTradableSymbols(): Promise<Set<string>> {
  const res = await fetch(COINBASE_PUBLIC_PRODUCTS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Coinbase products fetch failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { products?: CoinbaseProduct[] };
  const symbols = new Set<string>();

  for (const p of data.products ?? []) {
    if (!p.product_id?.endsWith("-USDC")) continue;
    const symbol = p.product_id.replace("-USDC", "");
    if (STABLES.has(symbol)) continue;
    if (p.trading_disabled || p.is_disabled || p.auction_mode) continue;
    const price = parseFloat(p.price ?? "0");
    if (!(price > 0)) continue;
    symbols.add(symbol);
  }

  logger.info("Fetched tradable symbols", { count: symbols.size });
  return symbols;
}

/**
 * Apply optional override from env: SYMBOL_OVERRIDE="BTC,ETH,SOL" restricts
 * the worker to these symbols only (useful for local testing).
 */
export function applySymbolOverride(discovered: Set<string>): Set<string> {
  const override = (process.env.SYMBOL_OVERRIDE ?? "").trim();
  if (!override) return discovered;
  const wanted = override.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const filtered = new Set(wanted.filter(s => discovered.has(s)));
  logger.info("Symbol override applied", {
    requested: wanted.length,
    matched: filtered.size,
    missing: wanted.filter(s => !discovered.has(s)),
  });
  return filtered;
}

interface CoinbaseProduct {
  product_id?: string;
  price?: string;
  trading_disabled?: boolean;
  is_disabled?: boolean;
  auction_mode?: boolean;
}
