import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationStore } from "../operations-store.mjs";
import { OperationsWorker } from "../operations-worker.mjs";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-ops-"));
  const store = new OperationStore(join(dir, "operations.json"));
  await store.init();
  return store;
}

async function waitForStatus(store, id, status, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const op = store.getById(id);
    if (op?.status === status) return op;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out waiting for status '${status}'`);
}

test("store persists operations across reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-store-"));
  const filePath = join(dir, "operations.json");

  const store1 = new OperationStore(filePath);
  await store1.init();
  const op = await store1.enqueue("copy", {
    bucket: "demo",
    sources: ["a.txt"],
    destination: "target/",
  });

  const store2 = new OperationStore(filePath);
  await store2.init();
  const loaded = store2.getById(op.id);

  assert.ok(loaded);
  assert.equal(loaded.type, "copy");
  assert.equal(loaded.status, "queued");
});

test("store recovers running operations as queued on restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-recover-"));
  const filePath = join(dir, "operations.json");

  const store1 = new OperationStore(filePath);
  await store1.init();
  const op = await store1.enqueue("copy", {
    bucket: "demo",
    sources: ["a.txt"],
    destination: "target/",
  });
  await store1.markRunning(op.id);

  const store2 = new OperationStore(filePath);
  await store2.init();
  const recovered = store2.getById(op.id);

  assert.equal(recovered.status, "queued");
  assert.equal(recovered.error, "Recovered after restart");
});

test("worker processes queued operation and records progress", async () => {
  const store = await createStore();

  const s3ops = {
    async moveTargets({ onProgress }) {
      onProgress({ total: 2, completed: 1, message: "Copying" });
      onProgress({ total: 2, completed: 2, message: "Deleting source" });
      return { moved: 1 };
    },
  };

  const worker = new OperationsWorker({ store, s3ops });
  const op = await store.enqueue("move", {
    bucket: "demo",
    sources: ["from/a.txt"],
    destination: "to/",
  });

  await worker.wake();
  const completed = await waitForStatus(store, op.id, "completed");

  assert.equal(completed.result.moved, 1);
  assert.equal(completed.progress.completed, 2);
  assert.equal(completed.progress.total, 2);
});

test("failed operation can be retried", async () => {
  const store = await createStore();
  let attempts = 0;

  const s3ops = {
    async deleteTargets() {
      attempts += 1;
      if (attempts === 1) throw new Error("transient failure");
      return { deleted: 1 };
    },
  };

  const worker = new OperationsWorker({ store, s3ops });
  const op = await store.enqueue("delete", {
    bucket: "demo",
    targets: ["a.txt"],
  });

  await worker.wake();
  const failed = await waitForStatus(store, op.id, "failed");
  assert.match(failed.error, /transient failure/);

  await store.retry(op.id);
  await worker.wake();
  const completed = await waitForStatus(store, op.id, "completed");

  assert.equal(completed.result.deleted, 1);
  assert.equal(attempts, 2);
});

test("queued operation can be cancelled before execution", async () => {
  const store = await createStore();
  let called = false;

  const s3ops = {
    async copyTargets() {
      called = true;
      return { copied: 1 };
    },
  };

  const worker = new OperationsWorker({ store, s3ops });
  const op = await store.enqueue("copy", {
    bucket: "demo",
    sources: ["a.txt"],
    destination: "target/",
  });

  await store.cancel(op.id);
  await worker.wake();

  const cancelled = store.getById(op.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(called, false);
});

test("running operation can be cancelled cooperatively", async () => {
  const store = await createStore();

  const s3ops = {
    async copyTargets({ shouldCancel, onProgress }) {
      onProgress({ total: 10, completed: 1, message: "Copying" });
      for (let i = 0; i < 10; i += 1) {
        if (shouldCancel()) {
          const err = new Error("Operation cancelled");
          err.name = "OperationCancelledError";
          throw err;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      return { copied: 10 };
    },
  };

  const worker = new OperationsWorker({ store, s3ops });
  const op = await store.enqueue("copy", {
    bucket: "demo",
    sources: ["a.txt"],
    destination: "target/",
  });

  const runningPromise = worker.runOperation(op.id);
  await new Promise((r) => setTimeout(r, 10));
  await store.cancel(op.id);
  await runningPromise;

  const cancelled = store.getById(op.id);
  assert.equal(cancelled.status, "cancelled");
});
