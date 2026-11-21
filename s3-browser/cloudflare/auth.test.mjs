import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";

import { authenticate, getAccessConfig, __resetCaches } from "./auth.mjs";
import { createHandler } from "./worker.mjs";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUDIENCE = "test-aud-tag";
const NOW = Date.UTC(2026, 10, 21, 12, 0, 0);
const TTL_MS = 5 * 60 * 1000;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherPrivateKey, publicKey: otherPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function publicJwk(key, kid) {
  return { ...key.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
}

const KEY_ID = "kid-1";
const ROTATED_KEY_ID = "kid-2";
const KEY_SET = [publicJwk(publicKey, KEY_ID)];
const ROTATED_KEY_SET = [...KEY_SET, publicJwk(otherPublicKey, ROTATED_KEY_ID)];

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function createToken({
  kid = KEY_ID,
  alg = "RS256",
  iss = ISSUER,
  aud = AUDIENCE,
  exp = Math.floor(NOW / 1000) + 3600,
  nbf,
  sub = "user-1",
  signingKey = privateKey,
  omit = [],
} = {}) {
  const header = { alg, kid, typ: "JWT" };
  const payload = { iss, aud, exp, iat: Math.floor(NOW / 1000), sub, type: "app" };
  if (nbf !== undefined) payload.nbf = nbf;
  for (const claim of omit) delete payload[claim];

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const signature = sign("RSA-SHA256", Buffer.from(`${encodedHeader}.${encodedPayload}`), signingKey);

  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

function stubJwks({ keys = KEY_SET, fail = false } = {}) {
  const state = { calls: 0, urls: [] };
  const fetchImpl = async (url) => {
    state.calls += 1;
    state.urls.push(String(url));
    if (fail) throw new Error("network unreachable");
    return new Response(JSON.stringify({ keys }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, state };
}

function baseEnv(overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    AWS_ACCESS_KEY_ID: "test-key-id",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    AWS_REGION: "us-east-1",
    S3_BROWSER_BUCKET: "064592191516-audio",
    ALLOWED_BUCKETS: "064592191516-audio",
    ALLOWED_ORIGINS: "",
    ...overrides,
  };
}

beforeEach(() => {
  __resetCaches();
});

test("getAccessConfig rejects incomplete or malformed configuration", () => {
  assert.equal(getAccessConfig({}), null);
  assert.equal(getAccessConfig({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }), null);
  assert.equal(getAccessConfig({ ACCESS_AUD: AUDIENCE }), null);
  assert.equal(getAccessConfig({ ACCESS_TEAM_DOMAIN: "not a domain", ACCESS_AUD: AUDIENCE }), null);

  const config = getAccessConfig({ ACCESS_TEAM_DOMAIN: `https://${TEAM_DOMAIN}/`, ACCESS_AUD: AUDIENCE });
  assert.equal(config.issuer, ISSUER);
  assert.equal(config.certsUrl, `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);
});

test("missing token is rejected with 401", async () => {
  const result = await authenticate({ token: null, env: baseEnv(), fetchImpl: stubJwks().fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test("malformed token and weak algorithms are rejected with 401", async () => {
  const { fetchImpl } = stubJwks();

  for (const token of ["not-a-jwt", "a.b", "a.b.c.d", ".."]) {
    const result = await authenticate({ token, env: baseEnv(), fetchImpl });
    assert.equal(result.status, 401, `token ${token}`);
  }

  const unsignedAlgorithm = await authenticate({
    token: createToken({ alg: "HS256" }),
    env: baseEnv(),
    fetchImpl,
  });
  assert.equal(unsignedAlgorithm.status, 401);
});

test("expired token is rejected with 401", async () => {
  const token = createToken({ exp: Math.floor(NOW / 1000) - 600 });
  const result = await authenticate({ token, env: baseEnv(), fetchImpl: stubJwks().fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(result.reason, "expired_token");
});

test("wrong audience is rejected with 401", async () => {
  const token = createToken({ aud: "someone-elses-application" });
  const result = await authenticate({ token, env: baseEnv(), fetchImpl: stubJwks().fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(result.reason, "invalid_audience");
});

test("wrong issuer is rejected with 401", async () => {
  const token = createToken({ iss: "https://other-team.cloudflareaccess.com" });
  const result = await authenticate({ token, env: baseEnv(), fetchImpl: stubJwks().fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(result.reason, "invalid_issuer");
});

test("invalid signature is rejected with 401", async () => {
  const token = createToken({ signingKey: otherPrivateKey });
  const result = await authenticate({ token, env: baseEnv(), fetchImpl: stubJwks().fetchImpl });
  assert.equal(result.status, 401);
  assert.equal(result.reason, "invalid_signature");
});

test("unknown key id is rejected with 401 and does not hammer the JWKS endpoint", async () => {
  const { fetchImpl, state } = stubJwks();
  let clock = NOW;

  const valid = await authenticate({ token: createToken(), env: baseEnv(), fetchImpl, now: () => clock });
  assert.equal(valid.ok, true);
  assert.equal(state.calls, 1);

  const unknown = await authenticate({
    token: createToken({ kid: "kid-unknown" }),
    env: baseEnv(),
    fetchImpl,
    now: () => clock,
  });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.reason, "unknown_key_id");
  assert.equal(state.calls, 1, "a fresh key set is not refetched for an unknown kid");

  clock = NOW + 60 * 1000;
  const stillUnknown = await authenticate({
    token: createToken({ kid: "kid-unknown" }),
    env: baseEnv(),
    fetchImpl,
    now: () => clock,
  });
  assert.equal(stillUnknown.status, 401);
  assert.equal(state.calls, 2, "an older key set is refreshed once for an unknown kid");
});

test("missing Access configuration returns 503", async () => {
  const { fetchImpl, state } = stubJwks();
  const token = createToken();

  for (const env of [{}, { ACCESS_TEAM_DOMAIN: TEAM_DOMAIN }, { ACCESS_AUD: AUDIENCE }]) {
    const result = await authenticate({ token, env, fetchImpl, now: () => NOW });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
  }

  assert.equal(state.calls, 0, "no JWKS request is made without configuration");
});

test("unreachable JWKS fails closed", async () => {
  const result = await authenticate({
    token: createToken(),
    env: baseEnv(),
    fetchImpl: stubJwks({ fail: true }).fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.reason, "jwks_unavailable");
});

test("an empty key set fails closed", async () => {
  const result = await authenticate({
    token: createToken(),
    env: baseEnv(),
    fetchImpl: stubJwks({ keys: [] }).fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
});

test("valid token is accepted and exposes claims", async () => {
  const result = await authenticate({
    token: createToken(),
    env: baseEnv(),
    fetchImpl: stubJwks().fetchImpl,
    now: () => NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.claims.sub, "user-1");
  assert.equal(result.claims.iss, ISSUER);
});

test("nbf in the future is rejected, nbf in the past is accepted", async () => {
  const { fetchImpl } = stubJwks();

  const notYetValid = await authenticate({
    token: createToken({ nbf: Math.floor(NOW / 1000) + 600 }),
    env: baseEnv(),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(notYetValid.status, 401);
  assert.equal(notYetValid.reason, "token_not_yet_valid");

  const valid = await authenticate({
    token: createToken({ nbf: Math.floor(NOW / 1000) - 60 }),
    env: baseEnv(),
    fetchImpl,
    now: () => NOW,
  });
  assert.equal(valid.ok, true);
});

test("JWKS is cached between verifications and refreshed after the TTL", async () => {
  const { fetchImpl, state } = stubJwks();
  const env = baseEnv();
  const token = createToken();
  let clock = NOW;

  assert.equal((await authenticate({ token, env, fetchImpl, now: () => clock })).ok, true);
  assert.equal((await authenticate({ token, env, fetchImpl, now: () => clock })).ok, true);
  assert.equal(state.calls, 1);
  assert.equal(state.urls[0], `https://${TEAM_DOMAIN}/cdn-cgi/access/certs`);

  clock = NOW + TTL_MS + 1000;
  assert.equal((await authenticate({ token, env, fetchImpl, now: () => clock })).ok, true);
  assert.equal(state.calls, 2);
});

test("key rotation is picked up when the cache expires", async () => {
  const { fetchImpl, state } = stubJwks();
  const env = baseEnv();
  let clock = NOW;

  assert.equal((await authenticate({ token: createToken(), env, fetchImpl, now: () => clock })).ok, true);
  assert.equal(state.calls, 1);

  const rotated = stubJwks({ keys: ROTATED_KEY_SET });
  clock = NOW + TTL_MS + 1000;
  const result = await authenticate({
    token: createToken({ kid: ROTATED_KEY_ID, signingKey: otherPrivateKey }),
    env,
    fetchImpl: rotated.fetchImpl,
    now: () => clock,
  });

  assert.equal(result.ok, true, "the rotated key id is served by the refreshed key set");
  assert.equal(rotated.state.calls, 1);
});

// ---------------------------------------------------------------------------
// Worker integration
// ---------------------------------------------------------------------------

function stubAdapter(record) {
  return {
    region: "us-east-1",
    async listBuckets() {
      record.calls.push("listBuckets");
      return [{ name: "064592191516-audio", created: null }];
    },
    async listObjects() {
      record.calls.push("listObjects");
      return { folders: [], files: [], isTruncated: false, nextContinuationToken: null, prefix: "", bucket: "b" };
    },
    async getDownloadStream() {
      record.calls.push("getDownloadStream");
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello from s3"));
          controller.close();
        },
      });
      return {
        head: { ContentType: "text/plain", ContentLength: 13 },
        key: "folder/hello.txt",
        body: { transformToWebStream: () => stream },
      };
    },
    async uploadObject() {
      record.calls.push("uploadObject");
      return { uploaded: true };
    },
    async deleteTargets() {
      record.calls.push("deleteTargets");
      return { deleted: 0 };
    },
    async moveTargets() {
      record.calls.push("moveTargets");
      return { moved: 0 };
    },
    async copyTargets() {
      record.calls.push("copyTargets");
      return { copied: 0 };
    },
    async renameTarget() {
      record.calls.push("renameTarget");
      return { renamed: 0 };
    },
  };
}

function buildWorker({ fetchImpl = stubJwks().fetchImpl, now = () => NOW } = {}) {
  const record = { calls: [], created: 0 };
  const handler = createHandler({
    createAdapter: () => {
      record.created += 1;
      return stubAdapter(record);
    },
    authenticate: (args) => authenticate({ ...args, fetchImpl, now }),
  });
  return { handler, record };
}

function callApi(handler, path, { token, env = baseEnv(), method = "GET", origin, body } = {}) {
  const headers = new Headers();
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  if (origin) headers.set("Origin", origin);

  const request = new Request(`https://app.example.com${path}`, { method, headers, body });
  return handler.fetch(request, env, { waitUntil: () => {} });
}

test("worker: health is public, minimal and never constructs the adapter", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(record.created, 0);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("worker: privileged routes require a token and return WWW-Authenticate", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/buckets");

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
  assert.equal(record.created, 0);
  assert.equal(record.calls.length, 0);
});

test("worker: a valid token reaches the adapter", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/buckets", { token: createToken() });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ name: "064592191516-audio", created: null }]);
  assert.equal(record.calls.includes("listBuckets"), true);
});

test("worker: unauthenticated upload never reaches the adapter", async () => {
  const { handler, record } = buildWorker();
  const formData = new FormData();
  formData.append("bucket", "064592191516-audio");
  formData.append("key", "folder/new.txt");
  formData.append("file", new File(["data"], "new.txt", { type: "text/plain" }));

  const response = await callApi(handler, "/api/upload", { method: "POST", body: formData });

  assert.equal(response.status, 401);
  assert.equal(record.created, 0);
  assert.deepEqual(record.calls, []);
});

test("worker: unauthenticated deletion never reaches the adapter", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/operations", {
    method: "POST",
    body: JSON.stringify({
      type: "delete",
      payload: { bucket: "064592191516-audio", targets: ["folder/keep.txt"] },
    }),
  });

  assert.equal(response.status, 401);
  assert.equal(record.created, 0);
  assert.deepEqual(record.calls, []);
});

test("worker: unauthenticated cancel and move never reach the adapter", async () => {
  const { handler, record } = buildWorker();

  const cancel = await callApi(handler, "/api/operations/anything/cancel", { method: "POST" });
  assert.equal(cancel.status, 401);

  const move = await callApi(handler, "/api/move", {
    method: "POST",
    body: JSON.stringify({ bucket: "064592191516-audio", sources: ["a.txt"], destination: "folder/" }),
  });
  assert.equal(move.status, 401);

  assert.equal(record.created, 0);
  assert.deepEqual(record.calls, []);
});

test("worker: missing Access configuration fails closed with 503", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/buckets", {
    token: createToken(),
    env: baseEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }),
  });

  assert.equal(response.status, 503);
  assert.equal(record.created, 0);
});

test("worker: JWKS failure fails closed with 503", async () => {
  const { handler, record } = buildWorker({ fetchImpl: stubJwks({ fail: true }).fetchImpl });
  const response = await callApi(handler, "/api/buckets", { token: createToken() });

  assert.equal(response.status, 503);
  assert.equal(record.created, 0);
});

test("worker: preflight never returns a wildcard origin", async () => {
  const { handler } = buildWorker();
  const response = await callApi(handler, "/api/buckets", {
    method: "OPTIONS",
    origin: "https://evil.example",
  });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-headers"), null);
});

test("worker: preflight allows only a configured origin", async () => {
  const { handler } = buildWorker();
  const env = baseEnv({ ALLOWED_ORIGINS: "https://tools.example" });

  const allowed = await callApi(handler, "/api/buckets", {
    method: "OPTIONS",
    origin: "https://tools.example",
    env,
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://tools.example");
  assert.equal(allowed.headers.get("access-control-allow-headers"), "Content-Type");

  const other = await callApi(handler, "/api/buckets", {
    method: "OPTIONS",
    origin: "https://evil.example",
    env,
  });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("worker: an unconfigured origin receives no CORS authorization", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/buckets", {
    token: createToken(),
    origin: "https://evil.example",
  });

  assert.equal(response.status, 200, "authentication, not CORS, decides access");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(record.calls.includes("listBuckets"), true);
});

test("worker: configured origin is echoed on a real response", async () => {
  const { handler } = buildWorker();
  const response = await callApi(handler, "/api/buckets", {
    token: createToken(),
    origin: "https://tools.example",
    env: baseEnv({ ALLOWED_ORIGINS: "https://tools.example" }),
  });

  assert.equal(response.headers.get("access-control-allow-origin"), "https://tools.example");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
});

test("worker: downloads return a web stream without a manual content length", async () => {
  const { handler, record } = buildWorker();
  const response = await callApi(handler, "/api/download?bucket=064592191516-audio&key=folder%2Fhello.txt", {
    token: createToken(),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain");
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(await response.text(), "hello from s3");
  assert.equal(record.calls.includes("getDownloadStream"), true);
});

test("worker: invalid bucket parameters surface as 400, not 500", async () => {
  const handler = createHandler({
    createAdapter: () => ({
      async listObjects() {
        const error = new Error("Invalid bucket: ../evil");
        throw error;
      },
    }),
    authenticate: async () => ({ ok: true, claims: { sub: "user-1" } }),
  });

  const response = await callApi(handler, "/api/buckets/..%2Fevil/objects", { token: createToken() });
  assert.equal(response.status, 400);
});

test("worker: unexpected adapter failures do not leak internal messages", async () => {
  const handler = createHandler({
    createAdapter: () => ({
      async listBuckets() {
        throw new Error("SignatureDoesNotMatch: Credential=AKIAIOSFODNN7EXAMPLE/20261121/us-east-1/s3/aws4_request");
      },
    }),
    authenticate: async () => ({ ok: true, claims: { sub: "user-1" } }),
  });

  const response = await callApi(handler, "/api/buckets", { token: createToken() });
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: "Request failed" });
});
