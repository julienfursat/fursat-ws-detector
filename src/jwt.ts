// ─────────────────────────────────────────────────────────────────────────────
// jwt.ts — Coinbase CDP JWT signing
// ─────────────────────────────────────────────────────────────────────────────
// Replicates the JWT logic used by fursat.net's src/lib/coinbase.ts so REST
// and WS share the same signing approach.
//
// Algorithm: ES256 (ECDSA P-256 SHA-256), IEEE-P1363 signature format
// Key format: PEM (EC PRIVATE KEY block)
//
// Two variants:
//   • buildRestJWT(method, path) — used for REST endpoints, includes `uri` claim
//   • buildWsJWT()                — used for WS subscribe, NO `uri` claim
//
// Why the difference: REST endpoints scope the JWT to a specific URI for
// security; WS subscribes are a single long-lived auth so the JWT only
// authenticates the user, not a specific resource.
//
// Token TTL: 120 seconds. The WS subscribe must be sent within that window.
// We re-build a fresh JWT on every subscribe call (cheap, ~1ms).
// ─────────────────────────────────────────────────────────────────────────────

import * as crypto from "node:crypto";

/** Normalize a PEM string that may have \n literals instead of real newlines. */
function normalizePem(secret: string): string {
  return secret.replace(/\\n/g, "\n");
}

function encodeBase64Url(obj: object): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/**
 * Build a CDP JWT for REST endpoints. Mirrors fursat.net/src/lib/coinbase.ts.
 * Currently unused in the worker (we use only public REST for product discovery)
 * but exported for future use (e.g. authenticated REST in trading mode).
 */
export function buildRestJWT(
  apiKey: string,
  apiSecret: string,
  method: string,
  path: string
): string {
  const uri = `${method} api.coinbase.com${path}`;
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");

  const header = { alg: "ES256", kid: apiKey, nonce, typ: "JWT" };
  const payload = {
    sub: apiKey,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    uri,
  };

  return signJwt(header, payload, normalizePem(apiSecret));
}

/**
 * Build a CDP JWT for WebSocket auth on Coinbase Advanced Trade WS.
 *
 * Per Coinbase's official WebSocket auth docs, the WS JWT uses a DIFFERENT
 * claim set than REST:
 *   • iss: "coinbase-cloud"   (REST uses "cdp" — confirmed working in prod for REST,
 *                              but WS rejects the "cdp" issuer silently and downgrades
 *                              the connection to unauthenticated rate-limited mode)
 *   • NO `aud` claim         (REST has aud:["cdp_service"], WS doesn't accept it)
 *   • NO `uri` claim         (REST scopes by URI, WS doesn't)
 *
 * Reference: https://docs.cloud.coinbase.com/advanced-trade/docs/ws-overview
 */
export function buildWsJWT(apiKey: string, apiSecret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");

  const header = { alg: "ES256", kid: apiKey, nonce, typ: "JWT" };
  const payload = {
    iss: "coinbase-cloud",
    nbf: now,
    exp: now + 120,
    sub: apiKey,
  };

  return signJwt(header, payload, normalizePem(apiSecret));
}

function signJwt(header: object, payload: object, pemSecret: string): string {
  const signingInput = `${encodeBase64Url(header)}.${encodeBase64Url(payload)}`;
  const sign = crypto.createSign("SHA256");
  sign.update(signingInput);
  const signature = sign
    .sign({ key: pemSecret, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${signingInput}.${signature}`;
}