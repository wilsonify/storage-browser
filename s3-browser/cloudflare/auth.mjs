// Cloudflare Access JWT verification for the S3 Browser Worker.
//
// The Worker is expected to sit behind a Cloudflare Access application. Access
// signs a JWT for the authenticated session and forwards it on every request as
// the `Cf-Access-Jwt-Assertion` header. This module validates that token against
// the team's published JWKS so a caller cannot bypass Access by reaching a route
// that does not have an Access policy attached.
//
// Fail-closed rules:
// - Missing ACCESS_TEAM_DOMAIN / ACCESS_AUD => 503, no privileged work.
// - JWKS cannot be fetched => 503. There is no stale-key fallback.
// - Any claim, algorithm, key or signature problem => 401.

const JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const MIN_FORCED_REFRESH_MS = 30 * 1000;

/** @type {Map<string, { keys: Map<string, CryptoKey>, fetchedAt: number }>} */
const jwksCache = new Map();

/** Test-only hook: clears the cached signing keys. */
export function __resetCaches() {
  jwksCache.clear();
}

function normalizeTeamDomain(value) {
  return String(value)
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Resolves the Access configuration from the Worker environment.
 * Returns null when either required value is missing so callers can fail closed.
 */
export function getAccessConfig(env) {
  const rawTeamDomain = typeof env?.ACCESS_TEAM_DOMAIN === "string" ? env.ACCESS_TEAM_DOMAIN : "";
  const audience = typeof env?.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  const teamDomain = normalizeTeamDomain(rawTeamDomain);

  if (!teamDomain || !audience) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(teamDomain)) return null;

  return {
    teamDomain,
    audience,
    issuer: `https://${teamDomain}`,
    certsUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
  };
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  let binary;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("Invalid base64url segment");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonSegment(segment) {
  const text = new TextDecoder().decode(decodeBase64Url(segment));
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JWT segment");
  }
  return parsed;
}

async function importSigningKey(jwk) {
  const key = await crypto.subtle.importKey(
    "jwk",
    {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      alg: "RS256",
      ext: true,
    },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return key;
}

async function loadSigningKeys(config, fetchImpl, now, { force = false } = {}) {
  const cached = jwksCache.get(config.teamDomain);
  if (cached && !force && now - cached.fetchedAt < JWKS_TTL_MS) {
    return { keys: cached.keys, fetchedAt: cached.fetchedAt };
  }

  const response = await fetchImpl(config.certsUrl, { headers: { accept: "application/json" } });
  if (!response || !response.ok) {
    throw new Error("JWKS unavailable");
  }

  const body = await response.json();
  const published = Array.isArray(body?.keys) ? body.keys : null;
  if (!published) {
    throw new Error("JWKS malformed");
  }

  const keys = new Map();
  for (const jwk of published) {
    if (!jwk || typeof jwk !== "object") continue;
    if (typeof jwk.kid !== "string" || !jwk.kid) continue;
    if (jwk.kty !== "RSA") continue;
    try {
      keys.set(jwk.kid, await importSigningKey(jwk));
    } catch {
      // A single malformed key must not invalidate the rest of the key set.
    }
  }

  if (!keys.size) {
    throw new Error("JWKS malformed");
  }

  jwksCache.set(config.teamDomain, { keys, fetchedAt: now });
  return { keys, fetchedAt: now };
}

function normalizeIssuer(value) {
  return String(value).trim().replace(/\/+$/, "").toLowerCase();
}

function audienceMatches(claimValue, expected) {
  if (Array.isArray(claimValue)) return claimValue.some((value) => value === expected);
  return claimValue === expected;
}

async function verifySignature(key, signedData, signature) {
  try {
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, signedData);
  } catch {
    return false;
  }
}

function reject(reason, status = 401) {
  return { ok: false, status, reason };
}

/**
 * Verifies a Cloudflare Access JWT.
 *
 * @param {object} options
 * @param {string | null | undefined} options.token Raw `Cf-Access-Jwt-Assertion` value.
 * @param {object} options.env Worker environment (ACCESS_TEAM_DOMAIN, ACCESS_AUD).
 * @param {typeof fetch} [options.fetchImpl] Fetch implementation for the JWKS request.
 * @param {() => number} [options.now] Clock, injectable for tests.
 * @returns {Promise<{ok: true, claims: object} | {ok: false, status: number, reason: string}>}
 */
export async function authenticate({ token, env, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const config = getAccessConfig(env);
  if (!config) return reject("not_configured", 503);

  const timestamp = typeof now === "function" ? now() : Number(now);
  if (!Number.isFinite(timestamp)) return reject("not_configured", 503);

  if (typeof token !== "string" || !token) return reject("missing_token");

  const segments = token.split(".");
  if (segments.length !== 3 || segments.some((segment) => !segment)) return reject("malformed_token");

  let header;
  let claims;
  try {
    header = decodeJsonSegment(segments[0]);
    claims = decodeJsonSegment(segments[1]);
  } catch {
    return reject("malformed_token");
  }

  if (header.alg !== "RS256") return reject("unsupported_algorithm");
  if (typeof header.kid !== "string" || !header.kid) return reject("missing_key_id");

  let loaded;
  try {
    loaded = await loadSigningKeys(config, fetchImpl, timestamp);
  } catch {
    return reject("jwks_unavailable", 503);
  }

  let signingKey = loaded.keys.get(header.kid) || null;

  // Access rotates signing keys. If the key id is unknown and the cached key set
  // is not brand new, refresh once before rejecting. The minimum interval keeps
  // unauthenticated callers from turning every request into a JWKS subrequest.
  if (!signingKey && timestamp - loaded.fetchedAt >= MIN_FORCED_REFRESH_MS) {
    try {
      loaded = await loadSigningKeys(config, fetchImpl, timestamp, { force: true });
    } catch {
      return reject("jwks_unavailable", 503);
    }
    signingKey = loaded.keys.get(header.kid) || null;
  }

  if (!signingKey) return reject("unknown_key_id");

  let signature;
  try {
    signature = decodeBase64Url(segments[2]);
  } catch {
    return reject("malformed_token");
  }

  const signedData = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
  const signatureValid = await verifySignature(signingKey, signedData, signature);
  if (!signatureValid) return reject("invalid_signature");

  if (typeof claims.iss !== "string" || normalizeIssuer(claims.iss) !== normalizeIssuer(config.issuer)) {
    return reject("invalid_issuer");
  }

  if (!audienceMatches(claims.aud, config.audience)) return reject("invalid_audience");

  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return reject("missing_expiry");
  if (claims.exp * 1000 + CLOCK_SKEW_MS <= timestamp) return reject("expired_token");

  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) return reject("invalid_not_before");
    if (claims.nbf * 1000 > timestamp + CLOCK_SKEW_MS) return reject("token_not_yet_valid");
  }

  return { ok: true, claims };
}
