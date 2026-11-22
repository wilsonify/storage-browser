import test from "node:test";
import assert from "node:assert/strict";

import { BudgetExhaustedError } from "./s3-adapter.mjs";
import { createHandler } from "./worker.mjs";

const BUCKET = "test-bucket";
const ORIGIN = "https://app.test";

function makeAdapter(seed = []) {
  const objects = new Map(seed.map((key) => [key, { key, bytes: `body:${key}` }]));
  const adapter = {
    objects,
    calls: { list: 0, copy: 0, delete: 0, upload: 0 },
    failCopy: new Set(),
    failDelete: new Set(),
    pageSize: 2,
    overlapToken: false,
    budget: null,
    spendPerCall: 1,
    gate: null,
    uploads: [],
    headCalls: [],
    bigFolderKeys: null,

    withBudget(budget) {
      this.budget = budget;
      return this;
    },
    clearBudget() {
      this.budget = null;
    },
    spend() {
      if (this.budget && !this.budget.take(this.spendPerCall)) throw new BudgetExhaustedError();
    },

    async listBuckets() {
      return [{ name: BUCKET, created: null }];
    },

    async listObjects() {
      return { folders: [], files: [], isTruncated: false };
    },

    async listAllKeys({ prefix = "", continuationToken }) {
      this.spend();
      this.calls.list += 1;
      if (this.overlapToken) return { keys: ["only.txt"], nextToken: "same-token" };
      if (this.bigFolderKeys && prefix === this.bigFolderKeys.prefix) {
        return { keys: this.bigFolderKeys.keys, nextToken: null };
      }
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(continuationToken || 0);
      const page = keys.slice(start, start + this.pageSize);
      const next = start + this.pageSize < keys.length ? String(start + this.pageSize) : null;
      return { keys: page, nextToken: next };
    },

    async copyKey(_bucket, sourceKey, destinationKey) {
      this.spend();
      this.calls.copy += 1;
      if (this.gate) await this.gate;
      if (this.failCopy.has(sourceKey)) throw new Error("copy denied");
      this.objects.set(destinationKey, { key: destinationKey, bytes: `body:${sourceKey}` });
    },

    async deleteKeysBatch(_bucket, keys) {
      this.spend();
      this.calls.delete += 1;
      const deleted = [];
      const errors = [];
      for (const key of keys) {
        if (this.failDelete.has(key)) {
          errors.push({ key, message: "delete denied" });
          continue;
        }
        this.objects.delete(key);
        deleted.push(key);
      }
      return { deleted, errors };
    },

    async headObject(_bucket, key) {
      this.headCalls.push(key);
      return this.objects.has(key) ? { exists: true, size: 1 } : { exists: false, size: null };
    },

    async getDownloadStream(_bucket, key) {
      this.spend();
      return {
        bucket: BUCKET,
        key,
        head: { ContentType: this.downloadContentType, ContentLength: 5 },
        body: this.downloadBody ?? "hello",
      };
    },

    async uploadObject({ key, body, contentType }) {
      this.spend();
      this.calls.upload += 1;
      this.uploads.push({ key, bytes: body, contentType });
      this.objects.set(key, { key, bytes: body });
      return { bucket: BUCKET, key, uploaded: true };
    },
  };
  return adapter;
}

function makeHandler(adapter, { authenticate, env = {}, createAdapter } = {}) {
  const state = { adapters: 0, authCalls: [], tokens: [] };
  const handler = createHandler({
    createAdapter: createAdapter || (() => {
      state.adapters += 1;
      return adapter;
    }),
    authenticate: authenticate || (async ({ token }) => {
      state.authCalls.push(token);
      return { ok: true, claims: { sub: "qa-user" } };
    }),
  });
  return { handler, state };
}

async function call(handler, path, { method = "GET", body, headers = {}, env = {} } = {}) {
  const requestHeaders = { ...headers };
  let requestBody;
  if (body instanceof FormData) {
    requestBody = body;
  } else if (body !== undefined) {
    requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
    requestBody = typeof body === "string" ? body : JSON.stringify(body);
  }

  const response = await handler.fetch(new Request(`https://app.test${path}`, {
    method,
    headers: requestHeaders,
    body: requestBody,
  }), env, { waitUntil() {} });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text, headers: response.headers };
}

async function drive(handler, op, limit = 60) {
  let current = op;
  let guard = 0;
  while (!["completed", "completed_with_errors", "failed", "cancelled"].includes(current.status) && guard < limit) {
    guard += 1;
    const response = await call(handler, `/api/operations/${current.id}/advance`, { method: "POST" });
    assert.equal(response.status, 200);
    current = response.body;
  }
  return current;
}

test("preflight and response CORS reflect only configured origins", async () => {
  const adapter = makeAdapter();
  const { handler, state } = makeHandler(adapter);

  const allowed = await call(handler, "/api/buckets", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN },
    env: { ALLOWED_ORIGINS: `${ORIGIN},https://other.test` },
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(allowed.headers.get("access-control-allow-methods"), /PUT/);
  assert.equal(allowed.headers.get("access-control-max-age"), "600");

  const denied = await call(handler, "/api/buckets", {
    method: "OPTIONS",
    headers: { Origin: "https://evil.test" },
    env: { ALLOWED_ORIGINS: ORIGIN },
  });
  assert.equal(denied.status, 204);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);

  const unconfigured = await call(handler, "/api/buckets", {
    method: "OPTIONS",
    headers: { Origin: ORIGIN },
    env: {},
  });
  assert.equal(unconfigured.headers.get("access-control-allow-origin"), null);
  assert.equal(state.authCalls.length, 0, "preflight never authenticates");
});

test("an allowed origin is advertised on real responses and a denied one is not", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  const allowed = await call(handler, "/api/buckets", {
    headers: { Origin: ORIGIN },
    env: { ALLOWED_ORIGINS: ORIGIN },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(allowed.headers.get("access-control-allow-credentials"), "true");
  assert.match(allowed.headers.get("vary"), /Origin/);

  const denied = await call(handler, "/api/buckets", {
    headers: { Origin: "https://evil.test" },
    env: { ALLOWED_ORIGINS: ORIGIN },
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("health, capabilities and unknown paths do not require authentication", async () => {
  const { handler, state } = makeHandler(makeAdapter());

  const health = await call(handler, "/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { ok: true });

  const capabilities = await call(handler, "/api/capabilities");
  assert.equal(capabilities.status, 200);
  assert.deepEqual(capabilities.body, { uploads: true, batchOperations: true, folderOperations: true });

  const page = await call(handler, "/index.html");
  assert.equal(page.status, 404);
  assert.deepEqual(page.body, { error: "Not found" });

  assert.equal(state.authCalls.length, 0);
  assert.equal(state.adapters, 0, "public routes never construct an S3 adapter");
});

test("authentication failures never reach the adapter", async () => {
  const unauthorized = makeHandler(makeAdapter(), {
    authenticate: async () => ({ ok: false, status: 401, reason: "missing_token" }),
  });
  const rejected = await call(unauthorized.handler, "/api/buckets");
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get("www-authenticate"), "Bearer");
  assert.deepEqual(rejected.body, { error: "Unauthorized" });
  assert.equal(unauthorized.state.adapters, 0);

  const unavailable = makeHandler(makeAdapter(), {
    authenticate: async () => ({ ok: false, status: 503, reason: "not_configured" }),
  });
  const unconfigured = await call(unavailable.handler, "/api/buckets");
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(unconfigured.body, { error: "Authentication is not available" });
  assert.equal(unavailable.state.adapters, 0);

  const throwing = makeHandler(makeAdapter(), {
    authenticate: async () => { throw new Error("auth exploded"); },
  });
  const exploded = await call(throwing.handler, "/api/buckets");
  assert.equal(exploded.status, 503);
  assert.equal(throwing.state.adapters, 0);
});

test("the access token is forwarded to the authenticator", async () => {
  const { handler, state } = makeHandler(makeAdapter());

  await call(handler, "/api/buckets", { headers: { "Cf-Access-Jwt-Assertion": "jwt-abc" } });

  assert.deepEqual(state.authCalls, ["jwt-abc"]);
});

test("download validates parameters and streams the stored bytes", async () => {
  const adapter = makeAdapter(["qa/note.txt"]);
  const { handler } = makeHandler(adapter);

  for (const path of ["/api/download", "/api/download?bucket=test-bucket", "/api/download?key=a.txt"]) {
    const response = await call(handler, path);
    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "Missing bucket or key" });
  }

  const inferred = await call(handler, `/api/download?bucket=${BUCKET}&key=${encodeURIComponent("qa/note.txt")}`);
  assert.equal(inferred.status, 200);
  assert.equal(inferred.text, "hello");
  assert.equal(inferred.headers.get("content-type"), "text/plain");
  assert.equal(inferred.headers.get("cache-control"), "private, no-store");
  assert.equal(
    inferred.headers.get("content-disposition"),
    "inline; filename=\"note.txt\"; filename*=UTF-8''note.txt",
  );

  adapter.downloadContentType = "application/x-custom";
  const declared = await call(handler, `/api/download?bucket=${BUCKET}&key=qa%2Fblob.bin`);
  assert.equal(declared.headers.get("content-type"), "application/x-custom");

  adapter.downloadContentType = undefined;
  const forced = await call(handler, `/api/download?bucket=${BUCKET}&key=qa%2Fnote.txt&download=1`);
  assert.match(forced.headers.get("content-disposition"), /^attachment; filename="note.txt"/);

  const unicode = await call(handler, `/api/download?bucket=${BUCKET}&key=${encodeURIComponent("qa/spaces in name — 测试.txt")}`);
  const disposition = unicode.headers.get("content-disposition");
  assert.equal(
    disposition.startsWith("inline; filename=\"spaces in name _ __.txt\"; filename*=UTF-8''"),
    true,
    disposition,
  );
  assert.match(disposition, /%E2%80%94/);
  assert.match(disposition, /%E6%B5%8B%E8%AF%95/);
});

test("object lookup requires both parameters and reports existence", async () => {
  const adapter = makeAdapter(["qa/here.txt"]);
  const { handler } = makeHandler(adapter);

  assert.equal((await call(handler, "/api/object")).status, 400);
  assert.equal((await call(handler, `/api/object?bucket=${BUCKET}`)).status, 400);

  const present = await call(handler, `/api/object?bucket=${BUCKET}&key=qa%2Fhere.txt`);
  assert.deepEqual(present.body, { exists: true, size: 1 });
  const missing = await call(handler, `/api/object?bucket=${BUCKET}&key=qa%2Fabsent.txt`);
  assert.deepEqual(missing.body, { exists: false, size: null });
  assert.deepEqual(adapter.headCalls, ["qa/here.txt", "qa/absent.txt"]);
});

test("raw upload rejects oversized declarations before storing anything", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  assert.equal((await call(handler, "/api/upload", { method: "PUT" })).status, 400);

  const declared = await call(handler, `/api/upload?bucket=${BUCKET}&key=qa%2Fbig.bin`, {
    method: "PUT",
    headers: { "Content-Length": String(51 * 1024 * 1024) },
    body: "ignored",
  });
  assert.equal(declared.status, 413);
  assert.match(declared.body.error, /upload limit/);
  assert.equal(adapter.calls.upload, 0);
  assert.equal(adapter.objects.size, 0);
});

test("raw upload enforces the cap even when no length is declared", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    start(controller) {
      for (let index = 0; index < 51; index += 1) controller.enqueue(chunk);
      controller.close();
    },
  });

  const response = await handler.fetch(new Request(
    `https://app.test/api/upload?bucket=${BUCKET}&key=qa%2Fstream.bin`,
    { method: "PUT", body, duplex: "half" },
  ), {}, { waitUntil() {} });

  assert.equal(response.status, 413);
  assert.equal(adapter.calls.upload, 0);
});

test("raw upload stores exactly the received bytes and content type", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  const response = await handler.fetch(new Request(
    `https://app.test/api/upload?bucket=${BUCKET}&key=${encodeURIComponent("qa/hello.txt")}&contentType=text%2Fplain`,
    { method: "PUT", body: "hello" },
  ), {}, { waitUntil() {} });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bucket: BUCKET, key: "qa/hello.txt", uploaded: true });
  assert.equal(adapter.uploads.length, 1);
  assert.equal(Buffer.from(adapter.uploads[0].bytes).toString(), "hello");
  assert.equal(adapter.uploads[0].contentType, "text/plain");
});

test("multipart upload accepts the documented field aliases", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  const form = new FormData();
  form.set("bucket", BUCKET);
  form.set("key", "qa/form.txt");
  form.set("file", new File(["hi"], "form.txt", { type: "text/plain" }));
  const stored = await call(handler, "/api/upload", { method: "POST", body: form });
  assert.equal(stored.status, 200);
  assert.equal(Buffer.from(adapter.uploads[0].bytes).toString(), "hi");
  assert.equal(adapter.uploads[0].contentType, "text/plain");

  const aliased = new FormData();
  aliased.set("bucket", BUCKET);
  aliased.set("path", "qa/alias.bin");
  aliased.set("upload", new File(["xx"], "alias.bin"));
  const aliasedResponse = await call(handler, "/api/upload", { method: "POST", body: aliased });
  assert.equal(aliasedResponse.status, 200);
  assert.equal(adapter.uploads[1].key, "qa/alias.bin");
  assert.equal(adapter.uploads[1].contentType, "application/octet-stream");

  const incomplete = new FormData();
  incomplete.set("bucket", BUCKET);
  incomplete.set("key", "qa/none.txt");
  const rejected = await call(handler, "/api/upload", { method: "POST", body: incomplete });
  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body, { error: "Missing bucket, key, or file upload" });
});

test("operation payloads are validated before any adapter work", async () => {
  const adapter = makeAdapter(["qa/tree/a.txt"]);
  const { handler, state } = makeHandler(adapter);

  const malformed = await call(handler, "/api/operations", { method: "POST", body: "{" });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: "Invalid JSON body" });

  const empty = await call(handler, "/api/operations", { method: "POST", body: "" });
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: "Invalid operation payload" });

  const invalidType = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "syncLocalToS3", payload: { bucket: BUCKET, sources: ["a"], destination: "" } },
  });
  assert.equal(invalidType.status, 400);
  assert.match(invalidType.body.error, /Invalid operation type: syncLocalToS3/);

  const cases = [
    [{ type: "delete", payload: { bucket: BUCKET, targets: [] } }, /missing targets/],
    [{ type: "delete", payload: {} }, /Missing bucket/],
    [{ type: "rename", payload: { bucket: BUCKET, source: "qa/a.txt" } }, /missing source or new name/],
    [{ type: "rename", payload: { bucket: BUCKET, source: "qa/a.txt", newName: "a/b" } }, /invalid name/],
    [{ type: "move", payload: { bucket: BUCKET, sources: [] , destination: "d/" } }, /missing sources/],
    [{ type: "copy", payload: { bucket: BUCKET, sources: ["qa/tree/"], destination: "qa/tree/inner/" } }, /inside the source/],
  ];

  for (const [body, expected] of cases) {
    const response = await call(handler, "/api/operations", { method: "POST", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.body.error, expected);
  }

  assert.equal(state.adapters, 0, "rejected requests never construct an adapter");
});

test("a file rename copies then deletes and reports both counters", async () => {
  const adapter = makeAdapter(["qa/old.txt"]);
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "rename", payload: { bucket: BUCKET, source: "qa/old.txt", newName: "new.txt" } },
  });
  assert.equal(created.status, 202);

  const op = await drive(handler, created.body);
  assert.equal(op.status, "completed");
  assert.equal(op.result.copied, 1);
  assert.equal(op.result.deleted, 1);
  assert.equal(op.result.total, 1);
  assert.equal(adapter.objects.has("qa/new.txt"), true);
  assert.equal(adapter.objects.has("qa/old.txt"), false);
});

test("a folder rename rewrites the prefix and deletes the originals", async () => {
  const adapter = makeAdapter(["qa/old/a.txt", "qa/old/nested/b.txt", "qa/old/"]);
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "rename", payload: { bucket: BUCKET, source: "qa/old/", newName: "new" } },
  });
  const op = await drive(handler, created.body);

  assert.equal(op.status, "completed");
  // Copies land under the new prefix and every child is deleted from the old one.
  // The empty source marker object (`qa/old/`) is not deleted: the rename plan skips
  // the marker itself and only moves children. Tracked as finding Q-01 in
  // docs/qa/test-strategy.md.
  assert.deepEqual(
    [...adapter.objects.keys()].filter((key) => !key.endsWith("/")).sort(),
    ["qa/new/a.txt", "qa/new/nested/b.txt"],
  );
  assert.equal(adapter.objects.has("qa/old/"), true, "the empty source folder marker remains (Q-01)");
  assert.equal(op.result.copied, 2);
  assert.equal(op.result.deleted, 2);
  assert.equal(op.result.total, 2, "the folder marker itself is not planned as an object");
});

test("an advance while a batch is in flight returns 409 and keeps the operation", async () => {
  const adapter = makeAdapter(["qa/gated/a.txt"]);
  let release;
  adapter.gate = new Promise((resolve) => { release = resolve; });
  const { handler } = makeHandler(adapter);

  const pending = call(handler, "/api/operations", {
    method: "POST",
    body: { type: "copy", payload: { bucket: BUCKET, sources: ["qa/gated/"], destination: "qa/out/" } },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const listed = await call(handler, "/api/operations");
  // The operation map is module-scoped, so identify the in-flight record by state
  // instead of assuming it is the newest listed entry.
  const inFlight = listed.body.operations.find((op) => op.status === "running");
  assert.ok(inFlight, "the operation is visible while its batch runs");

  const conflict = await call(handler, `/api/operations/${inFlight.id}/advance`, { method: "POST" });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /already running/);
  assert.equal(conflict.body.operation.id, inFlight.id);

  release();
  const created = await pending;
  assert.equal(created.status, 202);
  assert.equal(adapter.objects.has("qa/out/gated/a.txt"), true);

  const unknown = await call(handler, "/api/operations/op_missing/advance", { method: "POST" });
  assert.equal(unknown.status, 404);
});

test("budget exhaustion pauses with an exact remaining count and resumes", async () => {
  const seed = Array.from({ length: 5 }, (_, index) => `qa/budget/f-${index}.txt`);
  const adapter = makeAdapter(seed);
  adapter.spendPerCall = 10;
  adapter.pageSize = 10;
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/budget/"], destination: "qa/moved/" } },
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.status, "running");
  assert.equal(created.body.progress.message, "Paused (continues on next poll)");
  assert.equal(created.body.result.remainingCount, 4);
  assert.deepEqual(created.body.result.remaining, seed.slice(1));
  assert.equal(created.body.result.completed, 1);
  assert.equal(adapter.objects.has(seed[0]), false, "the first object was fully moved");
  assert.equal(adapter.objects.has("qa/moved/budget/f-0.txt"), true);
  assert.equal(adapter.objects.has(seed[1]), true, "the next source is untouched");
  assert.equal(
    adapter.objects.has("qa/moved/budget/f-1.txt"),
    false,
    "pausing happens before the next S3 request is issued, so no orphan copy is created",
  );

  const finished = await drive(handler, created.body);
  assert.equal(finished.status, "completed");
  assert.equal(finished.result.total, 5);
  assert.equal(finished.result.completed, 5);
  assert.equal(finished.result.remainingCount, 0);
  for (const key of seed) {
    assert.equal(adapter.objects.has(key), false);
    assert.equal(adapter.objects.has(key.replace("qa/budget/", "qa/moved/budget/")), true);
  }
});

test("a partial delete is reported as completed_with_errors with the failed key", async () => {
  const adapter = makeAdapter(["qa/del/a.txt", "qa/del/b.txt", "qa/del/c.txt"]);
  adapter.failDelete.add("qa/del/b.txt");
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/del/"] } },
  });
  const op = await drive(handler, created.body);

  assert.equal(op.status, "completed_with_errors");
  assert.equal(op.result.deleted, 2);
  assert.equal(op.result.completed, 2);
  assert.deepEqual(op.result.deleteFailed, ["qa/del/b.txt"]);
  assert.deepEqual(op.result.failed, [{
    key: "qa/del/b.txt",
    message: "delete denied",
    stage: "delete",
    task: { kind: "delete", key: "qa/del/b.txt" },
  }]);
  assert.equal(adapter.objects.has("qa/del/a.txt"), false);
  assert.equal(adapter.objects.has("qa/del/b.txt"), true, "the failed key is never reported as deleted");
  assert.equal(adapter.objects.has("qa/del/c.txt"), false);
});

test("a batch where every item failed ends in the failed state", async () => {
  const adapter = makeAdapter(["qa/allfail/a.txt", "qa/allfail/b.txt"]);
  adapter.failDelete.add("qa/allfail/a.txt");
  adapter.failDelete.add("qa/allfail/b.txt");
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/allfail/"] } },
  });
  const op = await drive(handler, created.body);

  assert.equal(op.status, "failed", "no successful work means failed, not completed_with_errors");
  assert.equal(op.result.completed, 0);
  assert.equal(op.result.deleted, 0);
  assert.equal(op.result.failed.length, 2);
  assert.deepEqual(op.result.deleteFailed.sort(), ["qa/allfail/a.txt", "qa/allfail/b.txt"]);
  assert.equal(adapter.objects.has("qa/allfail/a.txt"), true);
  assert.equal(adapter.objects.has("qa/allfail/b.txt"), true);
});

test("cancelling an in-flight batch is acknowledged and then finalised", async () => {
  const adapter = makeAdapter(["qa/inflight/a.txt", "qa/inflight/b.txt"]);
  let release;
  adapter.gate = new Promise((resolve) => { release = resolve; });
  const { handler } = makeHandler(adapter);

  const pending = call(handler, "/api/operations", {
    method: "POST",
    body: { type: "copy", payload: { bucket: BUCKET, sources: ["qa/inflight/"], destination: "qa/inflight-out/" } },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  const listed = await call(handler, "/api/operations");
  const running = listed.body.operations.find((op) => op.status === "running");
  assert.ok(running, "the batch is in flight");

  const cancelling = await call(handler, `/api/operations/${running.id}/cancel`, { method: "POST" });
  assert.equal(cancelling.status, 200);
  assert.equal(cancelling.body.status, "cancelling");
  assert.equal(cancelling.body.result.cancellationRequested, true);

  release();
  const created = await pending;
  assert.equal(created.body.status, "cancelled", "the operation ends cancelled once the batch stops");

  const after = await call(handler, `/api/operations/${running.id}/advance`, { method: "POST" });
  assert.equal(after.body.status, "cancelled");
  assert.equal(after.body.result.completed, created.body.result.completed);
});

test("retry refuses unfinished or failure-free operations and re-runs only failures", async () => {
  const adapter = makeAdapter(["qa/retry/a.txt", "qa/retry/b.txt"]);
  adapter.failDelete.add("qa/retry/b.txt");
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/retry/"] } },
  });
  const first = await drive(handler, created.body);
  assert.equal(first.status, "completed_with_errors");

  adapter.failDelete.clear();
  const retried = await call(handler, `/api/operations/${first.id}/retry`, { method: "POST" });
  assert.equal(retried.status, 202);
  assert.equal(retried.body.retryOf, first.id);

  const second = await drive(handler, retried.body);
  assert.equal(second.status, "completed");
  assert.equal(second.result.total, 1);
  assert.equal(adapter.objects.has("qa/retry/b.txt"), false);

  const nothingToRetry = await call(handler, `/api/operations/${second.id}/retry`, { method: "POST" });
  assert.equal(nothingToRetry.status, 400);
  assert.deepEqual(nothingToRetry.body, { error: "Operation has no failed items to retry" });

  const pausedAdapter = makeAdapter(Array.from({ length: 5 }, (_, i) => `qa/live/${i}.txt`));
  pausedAdapter.spendPerCall = 10;
  const pausedHandler = makeHandler(pausedAdapter);
  const running = await call(pausedHandler.handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/live/"], destination: "qa/live-out/" } },
  });
  const notFinished = await call(pausedHandler.handler, `/api/operations/${running.body.id}/retry`, { method: "POST" });
  assert.equal(notFinished.status, 400);
  assert.deepEqual(notFinished.body, { error: "Only finished operations may be retried" });
});

test("cancel is honest about partial work and never rewrites a finished operation", async () => {
  const seed = Array.from({ length: 5 }, (_, index) => `qa/cancel/${index}.txt`);
  const adapter = makeAdapter(seed);
  adapter.spendPerCall = 10;
  adapter.pageSize = 10;
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/cancel/"], destination: "qa/cancel-out/" } },
  });
  assert.equal(created.body.status, "running");

  const cancelled = await call(handler, `/api/operations/${created.body.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.result.cancellationRequested, true);
  assert.equal(cancelled.body.result.remaining.length, 4);
  assert.equal(adapter.objects.has(seed[0]), false, "work completed before the cancel stays done");

  const after = await call(handler, `/api/operations/${created.body.id}/advance`, { method: "POST" });
  assert.equal(after.body.status, "cancelled");
  assert.equal(after.body.result.completed, cancelled.body.result.completed);

  const again = await call(handler, `/api/operations/${created.body.id}/cancel`, { method: "POST" });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "cancelled");

  const completedAdapter = makeAdapter(["qa/done/a.txt"]);
  const completedHandler = makeHandler(completedAdapter);
  const finished = await call(completedHandler.handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/done/"] } },
  });
  const finishedOp = await drive(completedHandler.handler, finished.body);
  assert.equal(finishedOp.status, "completed");

  const cancelFinished = await call(completedHandler.handler, `/api/operations/${finishedOp.id}/cancel`, { method: "POST" });
  assert.equal(cancelFinished.status, 200);
  assert.equal(cancelFinished.body.status, "completed", "cancelling finished work does not claim a cancel");
});

test("upstream errors are mapped without leaking service detail", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    adapter.listBuckets = async () => {
      const error = new Error("AccessDenied: nope");
      error.name = "AccessDenied";
      error.Code = "AccessDenied";
      error.$fault = "client";
      error.$metadata = { httpStatusCode: 403, requestId: "req-1" };
      throw error;
    };

    const response = await call(handler, "/api/buckets");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, { error: "Request failed" });

    const logged = errors.find((line) => line.includes("s3-browser request failed"));
    assert.ok(logged, "unknown failures are logged");
    assert.match(logged, /"httpStatusCode":403/);
    assert.match(logged, /"code":"AccessDenied"/);
    assert.match(logged, /"fault":"client"/);
    assert.match(logged, /"requestId":"req-1"/);

    adapter.listBuckets = async () => { throw "string failure"; };
    const nonError = await call(handler, "/api/buckets");
    assert.equal(nonError.status, 500);
    assert.match(errors[errors.length - 1], /unknown error/);
    assert.match(errors[errors.length - 1], /string failure/);
  } finally {
    console.error = originalError;
  }
});

test("validation and configuration failures map to 400, 413 and 503", async () => {
  const adapter = makeAdapter();
  const { handler } = makeHandler(adapter);

  const mappings = [
    ["Invalid bucket: bad/name", 400, "Invalid bucket: bad/name"],
    ["Bucket other is not allowed for this deployment.", 400, "Bucket other is not allowed for this deployment."],
    ["Invalid operation: missing targets", 400, "Invalid operation: missing targets"],
    ["Operation exceeds 5000 objects; split it.", 400, "Operation exceeds 5000 objects; split it."],
    ["Destination is inside the source folder.", 400, "Destination is inside the source folder."],
    ["Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as Worker secrets.", 503, "Object storage is not configured"],
  ];

  for (const [message, status, expected] of mappings) {
    adapter.listBuckets = async () => { throw new Error(message); };
    const response = await call(handler, "/api/buckets");
    assert.equal(response.status, status, message);
    assert.deepEqual(response.body, { error: expected });
  }

  const payloadError = new Error("File is larger than the 50 MiB upload limit");
  payloadError.name = "PayloadTooLargeError";
  adapter.listBuckets = async () => { throw payloadError; };
  const tooLarge = await call(handler, "/api/buckets");
  assert.equal(tooLarge.status, 413);
});

test("operations that fail mid-batch keep their records and error text", async () => {
  const adapter = makeAdapter(["qa/err/a.txt", "qa/err/b.txt"]);
  adapter.failCopy.add("qa/err/a.txt");
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "copy", payload: { bucket: BUCKET, sources: ["qa/err/"], destination: "qa/err-out/" } },
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.status, "failed");
  assert.match(created.body.error, /copy denied/);
  assert.equal(created.body.failed, undefined, "failure details are summarised in result, not leaked raw");
  assert.equal(created.body.result.failed.length, 0, "a thrown batch failure is not a per-key failure");
  assert.equal(adapter.objects.has("qa/err-out/err/a.txt"), false);
});

test("a listing that never advances fails instead of looping forever", async () => {
  const adapter = makeAdapter();
  adapter.overlapToken = true;
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/loop/"] } },
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.status, "failed");
  assert.match(created.body.error, /did not advance/);
  assert.equal(adapter.calls.list, 2, "the guard trips after a single repeated token");
  assert.equal(adapter.calls.delete, 0);
});

test("a plan larger than the safety ceiling is refused before deleting", async () => {
  const adapter = makeAdapter();
  adapter.bigFolderKeys = {
    prefix: "qa/huge/",
    keys: Array.from({ length: 5001 }, (_, index) => `qa/huge/${index}.txt`),
  };
  const { handler } = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/huge/"] } },
  });

  assert.equal(created.status, 202);
  assert.equal(created.body.status, "failed");
  assert.match(created.body.error, /exceeds 5000 objects/);
  assert.equal(adapter.calls.delete, 0, "no destructive call is issued for an oversized plan");
});

test("the legacy move route validates and performs the move", async () => {
  const adapter = makeAdapter(["qa/legacy/a.txt"]);
  const { handler } = makeHandler(adapter);

  const invalid = await call(handler, "/api/move", {
    method: "POST",
    body: { bucket: BUCKET, sources: ["qa/legacy/a.txt"] },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: "Missing bucket, sources, or destination" });

  const created = await call(handler, "/api/move", {
    method: "POST",
    body: { bucket: BUCKET, sources: ["qa/legacy/a.txt"], destination: "qa/legacy-out/" },
  });
  assert.equal(created.status, 202);

  const op = await drive(handler, created.body);
  assert.equal(op.status, "completed");
  assert.equal(adapter.objects.has("qa/legacy-out/a.txt"), true, "a file move keeps only the destination root plus the file name");
  assert.equal(adapter.objects.has("qa/legacy/a.txt"), false);
});

test("finished operations are trimmed once the retention cap is exceeded", async () => {
  const adapter = makeAdapter(["qa/t.txt"]);
  const { handler } = makeHandler(adapter);

  for (let index = 0; index < 55; index += 1) {
    const created = await call(handler, "/api/operations", {
      method: "POST",
      body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/t.txt"] } },
    });
    assert.equal(created.status, 202);
  }

  const listed = await call(handler, "/api/operations");
  assert.equal(listed.body.operations.length, 50, "only the newest 50 records are retained");
  assert.equal(listed.body.operations.every((op) => op.status !== "queued"), true);
});

test("operation lookup reports a missing id", async () => {
  const { handler } = makeHandler(makeAdapter());
  const response = await call(handler, "/api/operations/op_absent");
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "Operation not found" });
});
