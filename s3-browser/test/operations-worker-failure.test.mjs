import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationStore } from "../operations-store.mjs";
import { OperationsWorker } from "../operations-worker.mjs";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-worker-failure-"));
  const store = new OperationStore(join(dir, "operations.json"));
  await store.init();
  return store;
}

test("start arms one poller and stop is idempotent", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({ store, s3ops: {} });

  worker.start();
  const timer = worker.timer;
  assert.ok(timer, "start arms the poll timer");
  worker.start();
  assert.equal(worker.timer, timer, "a second start does not arm another timer");

  worker.stop();
  assert.equal(worker.timer, null);
  worker.stop();
  assert.equal(worker.timer, null);

  worker.start();
  assert.ok(worker.timer, "the worker can be restarted");
  worker.stop();
});

test("kick reports a rejected wake instead of leaving an unhandled rejection", async () => {
  const store = {
    getNextQueued() {
      throw new Error("queue read failed");
    },
  };
  const worker = new OperationsWorker({ store, s3ops: {} });

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    worker.kick();
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    console.error = originalError;
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /operation worker failed: Error: queue read failed/);
  assert.equal(worker.loopActive, false, "the loop flag is released after a failure");
});

test("an unsupported operation type fails the record with a reason", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({ store, s3ops: {} });
  const op = await store.enqueue("teleport", { bucket: "b1" });

  await worker.wake();

  const failed = store.getById(op.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /Unsupported operation type: teleport/);
  assert.equal(failed.progress.message, "Failed");
  assert.equal(failed.completedAt === null, false);
});

test("a cooperative cancellation is recorded as cancelled, not failed", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({
    store,
    s3ops: {
      async copyTargets() {
        const error = new Error("Operation cancelled");
        error.name = "OperationCancelledError";
        throw error;
      },
    },
  });
  const op = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });

  await worker.wake();

  const cancelled = store.getById(op.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.progress.message, "Cancelled");
});

test("running an unknown operation is a no-op", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({ store, s3ops: {} });

  const result = await worker.runOperation("op_missing");

  assert.equal(result, undefined);
  assert.deepEqual(store.list(), []);
});

test("rename operations dispatch to renameTarget with the stored payload", async () => {
  const store = await createStore();
  const seen = [];
  const worker = new OperationsWorker({
    store,
    s3ops: {
      async renameTarget(args) {
        seen.push(args);
        return { renamed: 1 };
      },
    },
  });
  const op = await store.enqueue("rename", { bucket: "b1", source: "qa/a.txt", newName: "b.txt" });

  await worker.wake();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, "qa/a.txt");
  assert.equal(seen[0].newName, "b.txt");
  assert.equal(typeof seen[0].onProgress, "function");
  assert.equal(typeof seen[0].shouldCancel, "function");
  assert.deepEqual(store.getById(op.id).result, { renamed: 1 });
});

test("one wake drains the queue in creation order with the right adapters", async () => {
  const store = await createStore();
  const executed = [];
  const worker = new OperationsWorker({
    store,
    s3ops: {
      async moveTargets({ sources }) {
        executed.push(`move:${sources[0]}`);
        return { moved: sources.length };
      },
      async deleteTargets({ targets }) {
        executed.push(`delete:${targets[0]}`);
        return { deleted: targets.length };
      },
      async copyTargets({ sources }) {
        executed.push(`copy:${sources[0]}`);
        return { copied: sources.length };
      },
    },
  });

  const first = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });
  const second = await store.enqueue("move", { bucket: "b1", sources: ["b"], destination: "d/" });
  const third = await store.enqueue("delete", { bucket: "b1", targets: ["c"] });

  await worker.wake();

  assert.deepEqual(executed, ["copy:a", "move:b", "delete:c"]);
  assert.equal(store.getById(first.id).status, "completed");
  assert.equal(store.getById(second.id).status, "completed");
  assert.equal(store.getById(third.id).status, "completed");
  assert.deepEqual(store.getById(first.id).result, { copied: 1 });
  assert.equal(store.getNextQueued(), null);
});

test("a failing operation does not block the rest of the queue", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({
    store,
    s3ops: {
      async copyTargets({ sources }) {
        if (sources[0] === "bad") throw new Error("copy denied");
        return { copied: 1 };
      },
    },
  });

  const bad = await store.enqueue("copy", { bucket: "b1", sources: ["bad"], destination: "d/" });
  const good = await store.enqueue("copy", { bucket: "b1", sources: ["good"], destination: "d/" });

  await worker.wake();

  assert.equal(store.getById(bad.id).status, "failed");
  assert.match(store.getById(bad.id).error, /copy denied/);
  assert.equal(store.getById(good.id).status, "completed");
});

test("progress reported by an adapter lands on the stored record", async () => {
  const store = await createStore();
  const worker = new OperationsWorker({
    store,
    s3ops: {
      async deleteTargets({ onProgress }) {
        onProgress({ total: 3, completed: 1, message: "Deleting" });
        onProgress({ total: 3, completed: 2, message: "Deleting" });
        return { deleted: 2 };
      },
    },
  });
  const op = await store.enqueue("delete", { bucket: "b1", targets: ["a", "b", "c"] });

  await worker.runOperation(op.id);

  const record = store.getById(op.id);
  assert.equal(record.status, "completed");
  assert.equal(record.progress.total, 3);
  assert.equal(record.progress.completed, 3, "completion normalises the completed count");
  assert.equal(record.progress.message, "Completed");
});
