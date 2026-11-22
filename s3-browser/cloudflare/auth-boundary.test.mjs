import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { authenticate, getAccessConfig, __resetCaches } from "./auth.mjs";

const TEAM_DOMAIN = "boundary-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "boundary-aud";
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const CLOCK_SKEW_MS = 60 * 1000;
const FORCED_REFRESH_MS = 30 * 1000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherPrivateKey, publicKey: otherPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEY_ID = "kid-a";
const OTHER_KEY_ID = "kid-b";
const jwkFor = (key, kid) => ({ ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" });
const KEY_SET = [jwkFor(publicKey, KEY_ID)];
const ROTATED_SET = [...KEY_SET, jwkFor(otherPublicKey, OTHER_KEY_ID)];

const b64 = (value) => Buffer.from(value).toString("base64url");

function createToken({
  kid = KEY_ID,
  alg = "RS256",
  signingKey = privateKey,
  omit = [],
  payloadOverrides = {},
  headerOverrides = {},
  signature,
} = {}) {
  const header = { alg, kid, typ: "JWT", ...headerOverrides };
  const payload = {
    iss: ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    sub: "user-a",
    ...payloadOverrides,
  };
  for (const claim of omit) delete payload[claim];

  const encodedHeader = b64(JSON.stringify(header));
  const encodedPayload = b64(JSON.stringify(payload));
  const signed = `${encodedHeader}.${encodedPayload}`;
  const signatureValue = signature ?? sign("RSA-SHA256", Buffer.from(signed), signingKey).toString("base64url");
  return `${signed}.${signatureValue}`;
}

function stubJwks({ keysForCall = () => KEY_SET, fail = false, status = 200, body } = {}) {
  const state = { calls: 0 };
  const fetchImpl = async () => {
    state.calls += 1;
    if (fail) throw new Error("network unreachable");
    const payload = body !== undefined ? body : { keys: keysForCall(state.calls) };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, state };
}

const env = { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: AUDIENCE };
const at = (now) => () => now;

async function verify(token, options = {}) {
  return authenticate({ token, env: options.env || env, fetchImpl: options.fetchImpl, now: options.now || at(NOW) });
}

beforeEach(() => {
  __resetCaches();
});

test("an unconfigured Worker and an invalid clock fail closed with 503", async () => {
  assert.deepEqual(await authenticate({ token: "a.b.c", env: {}, now: at(NOW) }), {
    ok: false,
    status: 503,
    reason: "not_configured",
  });
  assert.equal((await authenticate({ token: null, env: {}, now: at(NOW) })).status, 503);
  assert.deepEqual(await authenticate({ token: "a.b.c", env, now: () => Number.NaN }), {
    ok: false,
    status: 503,
    reason: "not_configured",
  });
});

test("missing and structurally invalid tokens are 401", async () => {
  const { fetchImpl } = stubJwks();
  for (const token of [undefined, null, "", 42, "not-a-jwt", "a.b", "a.b.c.d", "a..b"]) {
    const result = await authenticate({ token, env, fetchImpl, now: at(NOW) });
    assert.equal(result.ok, false, `${String(token)} must be rejected`);
    assert.equal(result.status, 401);
  }
});

test("undecodable or non-object JWT segments are rejected as malformed", async () => {
  const { fetchImpl } = stubJwks();
  for (const token of ["!!!.e30.sig", `${b64("[1]")}.${b64("{}")}.sig`, `${b64("{}")}.!!!.sig`]) {
    const result = await authenticate({ token, env, fetchImpl, now: at(NOW) });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed_token", token);
  }
});

test("algorithm and key id are checked before any key is fetched", async () => {
  const { fetchImpl, state } = stubJwks();

  const weak = await authenticate({
    token: createToken({ alg: "HS256" }),
    env,
    fetchImpl,
    now: at(NOW),
  });
  assert.equal(weak.reason, "unsupported_algorithm");

  const noKid = await authenticate({
    token: createToken({ headerOverrides: { kid: undefined } }),
    env,
    fetchImpl,
    now: at(NOW),
  });
  assert.equal(noKid.reason, "missing_key_id");
  assert.equal(state.calls, 0, "malformed headers never cost a JWKS subrequest");
});

test("a JWKS that cannot be fetched or parsed is a 503", async () => {
  const failing = stubJwks({ fail: true });
  assert.deepEqual(await verify(createToken(), { fetchImpl: failing.fetchImpl }), {
    ok: false,
    status: 503,
    reason: "jwks_unavailable",
  });

  const notOk = stubJwks({ status: 500, body: { keys: KEY_SET } });
  assert.equal((await verify(createToken(), { fetchImpl: notOk.fetchImpl })).reason, "jwks_unavailable");

  const malformed = stubJwks({ body: {} });
  assert.equal((await verify(createToken(), { fetchImpl: malformed.fetchImpl })).reason, "jwks_unavailable");

  const unusableKeys = stubJwks({
    body: {
      keys: [
        null,
        "string",
        { kid: OTHER_KEY_ID, kty: "EC" },
        { kty: "RSA", n: "x", e: "AQAB" },
        { kid: "kid-broken", kty: "RSA", e: "AQAB" },
      ],
    },
  });
  assert.equal((await verify(createToken(), { fetchImpl: unusableKeys.fetchImpl })).reason, "jwks_unavailable");
});

test("an unknown key id inside the refresh window is rejected without another fetch", async () => {
  const { fetchImpl, state } = stubJwks();
  const warm = await verify(createToken(), { fetchImpl });
  assert.equal(warm.ok, true);

  const unknown = await verify(createToken({ kid: "kid-never-published" }), { fetchImpl });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, "unknown_key_id");
  assert.equal(state.calls, 1, "the cached key set is reused while it is fresh");
});

test("a rotated key id triggers one forced refresh after the minimum interval", async () => {
  const { fetchImpl, state } = stubJwks({
    keysForCall: (call) => (call === 1 ? KEY_SET : ROTATED_SET),
  });

  await verify(createToken(), { fetchImpl });
  assert.equal(state.calls, 1);

  const rotated = await verify(createToken({ kid: OTHER_KEY_ID, signingKey: otherPrivateKey }), {
    fetchImpl,
    now: at(NOW + FORCED_REFRESH_MS + 1000),
  });

  assert.equal(rotated.ok, true);
  assert.equal(rotated.claims.sub, "user-a");
  assert.equal(state.calls, 2);
});

test("a failed forced refresh keeps the caller unauthorized with 503", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ keys: KEY_SET }), { status: 200 });
    }
    throw new Error("network gone");
  };

  await verify(createToken(), { fetchImpl });
  const result = await verify(createToken({ kid: OTHER_KEY_ID, signingKey: otherPrivateKey }), {
    fetchImpl,
    now: at(NOW + FORCED_REFRESH_MS + 1000),
  });

  assert.deepEqual(result, { ok: false, status: 503, reason: "jwks_unavailable" });
  assert.equal(calls, 2);
});

test("a token signed by an unpublished key is rejected", async () => {
  const { fetchImpl } = stubJwks();
  const result = await verify(createToken({ signingKey: otherPrivateKey }), { fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_signature");
});

test("claims are validated in a fail-closed order", async () => {
  const { fetchImpl } = stubJwks();

  assert.equal((await verify(createToken({ omit: ["iss"] }), { fetchImpl })).reason, "invalid_issuer");
  assert.equal((await verify(createToken({ payloadOverrides: { iss: "https://evil.example" } }), { fetchImpl })).reason, "invalid_issuer");
  assert.equal((await verify(createToken({ payloadOverrides: { aud: "other-aud" } }), { fetchImpl })).reason, "invalid_audience");
  assert.equal((await verify(createToken({ payloadOverrides: { aud: ["other-aud", AUDIENCE] } }), { fetchImpl })).ok, true);
  assert.equal((await verify(createToken({ payloadOverrides: { aud: ["other-aud"] } }), { fetchImpl })).reason, "invalid_audience");

  assert.equal((await verify(createToken({ omit: ["exp"] }), { fetchImpl })).reason, "missing_expiry");
  assert.equal((await verify(createToken({ payloadOverrides: { exp: "soon" } }), { fetchImpl })).reason, "missing_expiry");
});

test("issuer comparison tolerates case and a trailing slash but nothing else", async () => {
  const { fetchImpl } = stubJwks();
  const tolerant = await verify(createToken({
    payloadOverrides: { iss: `HTTPS://${TEAM_DOMAIN.toUpperCase()}/` },
  }), { fetchImpl });
  assert.equal(tolerant.ok, true);

  const withPath = await verify(createToken({
    payloadOverrides: { iss: `${ISSUER}/extra` },
  }), { fetchImpl });
  assert.equal(withPath.reason, "invalid_issuer");
});

test("expiry honours the 60 second clock skew at the boundary", async () => {
  const { fetchImpl } = stubJwks();
  const expSeconds = Math.floor(NOW / 1000);

  const atBoundary = await verify(createToken({ payloadOverrides: { exp: expSeconds - CLOCK_SKEW_MS / 1000 } }), { fetchImpl });
  assert.equal(atBoundary.ok, false, "an expiry exactly one skew window old is expired");
  assert.equal(atBoundary.reason, "expired_token");

  const justInside = await verify(createToken({ payloadOverrides: { exp: expSeconds - CLOCK_SKEW_MS / 1000 + 1 } }), { fetchImpl });
  assert.equal(justInside.ok, true, "one second inside the skew window is still accepted");

  const longExpired = await verify(createToken({ payloadOverrides: { exp: expSeconds - 3600 } }), { fetchImpl });
  assert.equal(longExpired.reason, "expired_token");
});

test("not-before is enforced with the same skew tolerance", async () => {
  const { fetchImpl } = stubJwks();
  const nowSeconds = Math.floor(NOW / 1000);

  assert.equal(
    (await verify(createToken({ payloadOverrides: { nbf: "later" } }), { fetchImpl })).reason,
    "invalid_not_before",
  );
  assert.equal(
    (await verify(createToken({ payloadOverrides: { nbf: nowSeconds + 600 } }), { fetchImpl })).reason,
    "token_not_yet_valid",
  );
  assert.equal(
    (await verify(createToken({ payloadOverrides: { nbf: nowSeconds + 30 } }), { fetchImpl })).ok,
    true,
    "a not-before within the skew window is accepted",
  );
});

test("a valid token fetches the key set once and returns its claims", async () => {
  const { fetchImpl, state } = stubJwks();
  const first = await verify(createToken(), { fetchImpl });
  const second = await verify(createToken({ payloadOverrides: { sub: "user-b" } }), { fetchImpl });

  assert.equal(first.ok, true);
  assert.equal(first.claims.sub, "user-a");
  assert.equal(second.claims.sub, "user-b");
  assert.equal(state.calls, 1, "the JWKS cache is shared across requests");
});

test("configuration parsing rejects malformed team domains and trims the audience", () => {
  assert.equal(getAccessConfig(undefined), null);
  assert.equal(getAccessConfig({ ACCESS_TEAM_DOMAIN: 42, ACCESS_AUD: AUDIENCE }), null);
  assert.equal(getAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: "   " }), null);
  assert.equal(getAccessConfig({ ACCESS_TEAM_DOMAIN: "a.b:443", ACCESS_AUD: AUDIENCE }), null);

  const config = getAccessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM_DOMAIN}`, ACCESS_AUD: ` ${AUDIENCE} ` });
  assert.equal(config.audience, AUDIENCE);
});
