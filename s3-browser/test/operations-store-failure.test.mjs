import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OperationStore } from "../operations-store.mjs";

async function createStore() {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-store-failure-"));
  const filePath = join(dir, "operations.json");
  const store = new OperationStore(filePath);
  await store.init();
  return { store, dir, filePath };
}

test("a corrupt queue file fails loudly and is left untouched", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-corrupt-"));
  const filePath = join(dir, "operations.json");
  await writeFile(filePath, "{ this is not json", "utf-8");

  const store = new OperationStore(filePath);
  await assert.rejects(() => store.init(), SyntaxError);
  assert.equal(await readFile(filePath, "utf-8"), "{ this is not json", "corrupt state is never silently replaced");
});

test("a queue file with a non-array operations field initialises empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-shape-"));
  const filePath = join(dir, "operations.json");
  await writeFile(filePath, JSON.stringify({ operations: "nope" }), "utf-8");

  const store = new OperationStore(filePath);
  await store.init();
  assert.deepEqual(store.list(), []);

  await store.enqueue("delete", { bucket: "b1", targets: ["a"] });
  const persisted = JSON.parse(await readFile(filePath, "utf-8"));
  assert.equal(persisted.operations.length, 1, "the next write replaces the invalid shape");
});

test("updates for unknown ids return null instead of mutating another record", async () => {
  const { store } = await createStore();
  const created = await store.enqueue("delete", { bucket: "b1", targets: ["a"] });

  assert.equal(await store.markRunning("op_missing"), null);
  assert.equal(await store.markProgress("op_missing", { completed: 1 }), null);
  assert.equal(await store.markCompleted("op_missing", { deleted: 1 }), null);
  assert.equal(await store.markFailed("op_missing", new Error("x")), null);
  assert.equal(await store.markCancelled("op_missing"), null);
  assert.equal(await store.retry("op_missing"), null);
  assert.equal(await store.cancel("op_missing"), null);

  assert.equal(store.getById(created.id).status, "queued");
});

test("cancel distinguishes queued, running and finished operations", async () => {
  const { store } = await createStore();
  const queued = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });
  const running = await store.enqueue("copy", { bucket: "b1", sources: ["b"], destination: "d/" });
  const finished = await store.enqueue("copy", { bucket: "b1", sources: ["c"], destination: "d/" });

  const queuedResult = await store.cancel(queued.id);
  assert.equal(queuedResult.changed, true);
  assert.equal(queuedResult.op.status, "cancelled");
  assert.equal(queuedResult.op.progress.message, "Cancelled");
  assert.equal(queuedResult.op.completedAt === null, false);

  await store.markRunning(running.id);
  const runningResult = await store.cancel(running.id);
  assert.equal(runningResult.changed, true);
  assert.equal(runningResult.op.status, "running", "a running operation is not marked cancelled up front");
  assert.equal(runningResult.op.cancelRequested, true);
  assert.equal(runningResult.op.progress.message, "Cancelling");

  await store.markCompleted(finished.id, { copied: 1 });
  const finishedResult = await store.cancel(finished.id);
  assert.equal(finishedResult.changed, false);
  assert.equal(finishedResult.reason, "Operation already finished");
  assert.equal(finishedResult.op.status, "completed");
});

test("markCancelled clears a pending cancellation request", async () => {
  const { store } = await createStore();
  const op = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });
  await store.markRunning(op.id);
  await store.cancel(op.id);
  assert.equal(store.getById(op.id).cancelRequested, true);

  const cancelled = await store.markCancelled(op.id, "Stopped after 1 of 3");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelRequested, false);
  assert.equal(cancelled.error, null);
  assert.equal(cancelled.progress.message, "Stopped after 1 of 3");
});

test("completion, failure and progress persist the exact stored state", async () => {
  const { store, filePath } = await createStore();
  const op = await store.enqueue("delete", { bucket: "b1", targets: ["a", "b"] });

  const running = await store.markRunning(op.id);
  assert.equal(running.attempts, 1);
  assert.equal(running.error, null);
  assert.equal(running.startedAt === null, false);

  await store.markProgress(op.id, { total: 2, completed: 1, message: "Deleting" });
  const progressed = store.getById(op.id);
  assert.equal(progressed.progress.completed, 1);
  assert.equal(progressed.progress.message, "Deleting");

  const completed = await store.markCompleted(op.id, { deleted: 2 });
  assert.equal(completed.status, "completed");
  assert.equal(completed.progress.completed, 2, "completion fills the known total");
  assert.deepEqual(completed.result, { deleted: 2 });

  const reloaded = new OperationStore(filePath);
  await reloaded.init();
  const persisted = reloaded.getById(op.id);
  assert.equal(persisted.status, "completed");
  assert.deepEqual(persisted.result, { deleted: 2 });
  assert.equal(persisted.progress.completed, 2);

  const second = await store.enqueue("delete", { bucket: "b1", targets: ["c"] });
  await store.markFailed(second.id, "plain string failure");
  const failed = store.getById(second.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "plain string failure", "non-Error failures are stringified");
  assert.equal(failed.progress.message, "Failed");
});

test("marks without a known total do not invent one", async () => {
  const { store } = await createStore();
  const op = await store.enqueue("delete", { bucket: "b1", targets: ["a"] });
  const completed = await store.markCompleted(op.id, null);
  assert.equal(completed.progress.total, 0);
  assert.equal(completed.progress.completed, 0);
  assert.equal(completed.result, null);
});

test("queue ordering is FIFO for the next job and newest-first for listing", async () => {
  const { store } = await createStore();
  const first = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await store.enqueue("copy", { bucket: "b1", sources: ["b"], destination: "d/" });

  assert.equal(store.getNextQueued().id, first.id);

  await store.markRunning(first.id);
  assert.equal(store.getNextQueued().id, second.id);

  await store.markCompleted(first.id, {});
  await store.markCompleted(second.id, {});
  assert.equal(store.getNextQueued(), null, "finished work is never picked up again");

  const listed = store.list();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].createdAt >= listed[1].createdAt, true, "listing is newest first");
});

test("concurrent writes leave a complete queue file behind", async () => {
  const { store, filePath } = await createStore();

  await Promise.all([
    store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" }),
    store.enqueue("copy", { bucket: "b1", sources: ["b"], destination: "d/" }),
    store.enqueue("copy", { bucket: "b1", sources: ["c"], destination: "d/" }),
  ]);

  const reloaded = new OperationStore(filePath);
  await reloaded.init();
  assert.equal(reloaded.list().length, 3);
  assert.deepEqual(
    reloaded.list().map((op) => op.payload.sources[0]).sort(),
    ["a", "b", "c"],
  );
});

test("running work is recovered as queued after a restart", async () => {
  const { store, filePath } = await createStore();
  const running = await store.enqueue("copy", { bucket: "b1", sources: ["a"], destination: "d/" });
  const untouched = await store.enqueue("copy", { bucket: "b1", sources: ["b"], destination: "d/" });
  await store.markRunning(running.id);

  const recovered = new OperationStore(filePath);
  await recovered.init();

  const op = recovered.getById(running.id);
  assert.equal(op.status, "queued");
  assert.equal(op.error, "Recovered after restart");
  assert.equal(recovered.getById(untouched.id).status, "queued");
  assert.equal(recovered.getById(untouched.id).error, null, "queued work is not relabelled");
});
