import test from "node:test";
import assert from "node:assert/strict";

import { BudgetExhaustedError } from "./s3-adapter.mjs";
import { createHandler } from "./worker.mjs";

const BUCKET = "test-bucket";

function makeAdapter(seed = []) {
  const objects = new Map(seed.map((key) => [key, { key }]));
  const adapter = {
    objects,
    calls: { list: 0, copy: 0, delete: 0 },
    failCopy: new Set(),
    failDelete: new Set(),
    pageSize: 2,
    budget: null,

    withBudget(budget) {
      this.budget = budget;
      return this;
    },
    clearBudget() {
      this.budget = null;
    },
    spend() {
      if (this.budget && !this.budget.take()) throw new BudgetExhaustedError();
    },

    async listAllKeys({ prefix = "", continuationToken }) {
      this.spend();
      this.calls.list += 1;
      const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = Number(continuationToken || 0);
      const page = keys.slice(start, start + this.pageSize);
      const next = start + this.pageSize < keys.length ? String(start + this.pageSize) : null;
      return { keys: page, nextToken: next };
    },

    async copyKey(_bucket, sourceKey, destinationKey) {
      this.spend();
      this.calls.copy += 1;
      if (this.failCopy.has(sourceKey)) throw new Error("copy denied");
      this.objects.set(destinationKey, { key: destinationKey });
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
      return this.objects.has(key) ? { exists: true, size: this.objects.get(key).size ?? 0 } : { exists: false, size: null };
    },

    async uploadObject({ key }) {
      this.spend();
      this.objects.set(key, { key });
      return { key, uploaded: true };
    },
  };
  return adapter;
}

function makeHandler(adapter) {
  return createHandler({
    createAdapter: () => adapter,
    authenticate: async () => ({ ok: true, claims: { sub: "qa-user" } }),
  });
}

async function call(handler, path, { method = "GET", body, headers = {} } = {}) {
  const response = await handler.fetch(new Request(`https://app.test${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }), {}, { waitUntil() {} });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, body: json, text };
}

async function drive(handler, op, limit = 40) {
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

test("folder delete expands every child object and reports totals", async () => {
  const adapter = makeAdapter([
    "qa/folder/a.txt",
    "qa/folder/b.txt",
    "qa/folder/nested/c.txt",
    "qa/other.txt",
  ]);
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "delete", payload: { bucket: BUCKET, targets: ["qa/folder/"] } },
  });
  assert.equal(created.status, 202);

  const op = await drive(handler, created.body);
  assert.equal(op.status, "completed");
  assert.equal(op.result.total, 3);
  assert.equal(op.result.completed, 3);
  assert.deepEqual(op.result.failed, []);
  assert.deepEqual(op.result.remaining, []);
  assert.equal(adapter.objects.has("qa/folder/a.txt"), false);
  assert.equal(adapter.objects.has("qa/folder/nested/c.txt"), false);
  assert.equal(adapter.objects.has("qa/other.txt"), true);
});

test("move pauses when the subrequest budget is spent and resumes on later advances", async () => {
  const seed = Array.from({ length: 25 }, (_, index) => `qa/move/file-${String(index).padStart(2, "0")}.txt`);
  const adapter = makeAdapter(seed);
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/move/"], destination: "qa/moved/" } },
  });

  assert.equal(created.status, 202);
  // The first invocation cannot finish 25 moves: 25 copies + 25 deletes exceeds the budget.
  assert.equal(created.body.status, "running");
  assert.equal(created.body.result.remaining.length > 0, true);

  const op = await drive(handler, created.body);
  assert.equal(op.status, "completed");
  assert.equal(op.result.total, 25);
  assert.equal(op.result.completed, 25);
  assert.equal(op.result.copied, 25);
  assert.equal(op.result.deleted, 25);
  assert.equal(op.result.remainingCount, 0);
  for (const key of seed) {
    assert.equal(adapter.objects.has(key), false, `source ${key} should be gone`);
    assert.equal(adapter.objects.has(key.replace("qa/move/", "qa/moved/move/")), true);
  }
});

test("move reports a failed delete instead of claiming success", async () => {
  const adapter = makeAdapter(["qa/mv/one.txt", "qa/mv/two.txt"]);
  adapter.failDelete.add("qa/mv/two.txt");
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/mv/"], destination: "qa/mv-out/" } },
  });
  const op = await drive(handler, created.body);

  assert.equal(op.status, "completed_with_errors");
  assert.equal(op.result.copied, 2);
  assert.equal(op.result.deleted, 1);
  assert.deepEqual(op.result.deleteFailed, ["qa/mv/two.txt"]);
  assert.equal(op.result.failed.length, 1);
  // Both copies exist; the failed source is still present.
  assert.equal(adapter.objects.has("qa/mv-out/mv/one.txt"), true);
  assert.equal(adapter.objects.has("qa/mv-out/mv/two.txt"), true);
  assert.equal(adapter.objects.has("qa/mv/two.txt"), true);
});

test("copying a folder keeps the folder name under the destination", async () => {
  const adapter = makeAdapter(["qa/tree/a.txt", "qa/tree/deep/b.txt"]);
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "copy", payload: { bucket: BUCKET, sources: ["qa/tree/"], destination: "qa/dest/" } },
  });
  assert.equal(created.status, 202);

  const op = await drive(handler, created.body);
  assert.equal(op.status, "completed");
  assert.equal(op.result.copied, 2);
  // Children keep their relative paths inside the copied folder, not flattened.
  assert.equal(adapter.objects.has("qa/dest/tree/a.txt"), true);
  assert.equal(adapter.objects.has("qa/dest/tree/deep/b.txt"), true);
  assert.equal(adapter.objects.has("qa/dest/tree/b.txt"), false);
  assert.equal(adapter.objects.has("qa/dest/a.txt"), false);
  assert.equal(adapter.objects.has("qa/tree/a.txt"), true);
});

test("copy into a destination inside the source folder is rejected", async () => {
  const adapter = makeAdapter(["qa/tree/a.txt"]);
  const handler = makeHandler(adapter);

  const response = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "copy", payload: { bucket: BUCKET, sources: ["qa/tree/"], destination: "qa/tree/inner/" } },
  });

  assert.equal(response.status, 400);
  assert.match(response.body.error, /inside the source/i);
  assert.equal(adapter.calls.list, 0);
});

test("cancel stops the operation and keeps partial state explicit", async () => {
  const seed = Array.from({ length: 25 }, (_, index) => `qa/cancel/file-${index}.txt`);
  const adapter = makeAdapter(seed);
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/cancel/"], destination: "qa/cancel-out/" } },
  });
  assert.equal(created.body.status, "running");

  const cancelled = await call(handler, `/api/operations/${created.body.id}/cancel`, { method: "POST" });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(cancelled.body.result.cancellationRequested, true);
  assert.equal(cancelled.body.result.remaining.length > 0, true);

  // A cancelled operation must not start another batch.
  const after = await call(handler, `/api/operations/${created.body.id}/advance`, { method: "POST" });
  assert.equal(after.body.status, "cancelled");
  assert.equal(after.body.result.completed, cancelled.body.result.completed);
});

test("retry re-runs only the failed keys", async () => {
  const adapter = makeAdapter(["qa/retry/one.txt", "qa/retry/two.txt"]);
  adapter.failDelete.add("qa/retry/two.txt");
  const handler = makeHandler(adapter);

  const created = await call(handler, "/api/operations", {
    method: "POST",
    body: { type: "move", payload: { bucket: BUCKET, sources: ["qa/retry/"], destination: "qa/retry-out/" } },
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
  assert.equal(adapter.objects.has("qa/retry/two.txt"), false);
  assert.equal(adapter.objects.has("qa/retry-out/retry/two.txt"), true);
});

test("object lookup reports whether an aborted upload actually landed", async () => {
  const adapter = makeAdapter(["qa/here.txt"]);
  const handler = makeHandler(adapter);

  const present = await call(handler, `/api/object?bucket=${BUCKET}&key=${encodeURIComponent("qa/here.txt")}`);
  const missing = await call(handler, `/api/object?bucket=${BUCKET}&key=${encodeURIComponent("qa/missing.txt")}`);

  assert.equal(present.status, 200);
  assert.equal(present.body.exists, true);
  assert.equal(missing.body.exists, false);
});

test("raw upload rejects bodies over the size cap before reaching S3", async () => {
  const adapter = makeAdapter();
  const handler = makeHandler(adapter);

  const response = await call(handler, `/api/upload?bucket=${BUCKET}&key=qa%2Fbig.bin`, {
    method: "PUT",
    headers: { "Content-Length": String(51 * 1024 * 1024), "Content-Type": "application/octet-stream" },
  });

  assert.equal(response.status, 413);
  assert.equal(adapter.calls.list, 0);
  assert.equal(adapter.objects.size, 0);
});

test("raw upload stores the object and reports its key", async () => {
  const adapter = makeAdapter();
  const handler = makeHandler(adapter);

  const response = await handler.fetch(new Request(
    `https://app.test/api/upload?bucket=${BUCKET}&key=${encodeURIComponent("qa/hello.txt")}&contentType=text%2Fplain`,
    { method: "PUT", body: "hello" },
  ), {}, { waitUntil() {} });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.key, "qa/hello.txt");
  assert.equal(adapter.objects.has("qa/hello.txt"), true);
});
