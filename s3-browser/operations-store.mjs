import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function nowIso() {
  return new Date().toISOString();
}

function createId() {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class OperationStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.operations = [];
    this.pendingWrite = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });

    try {
      const raw = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      this.operations = Array.isArray(parsed.operations) ? parsed.operations : [];
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.operations = [];
      await this.persist();
    }

    let mutated = false;
    for (const op of this.operations) {
      if (op.status === "running") {
        op.status = "queued";
        op.error = "Recovered after restart";
        op.updatedAt = nowIso();
        mutated = true;
      }
    }

    if (mutated) await this.persist();
  }

  list() {
    return [...this.operations].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getById(id) {
    return this.operations.find((op) => op.id === id) || null;
  }

  async enqueue(type, payload) {
    const operation = {
      id: createId(),
      type,
      payload,
      status: "queued",
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      completedAt: null,
      error: null,
      progress: {
        total: 0,
        completed: 0,
        message: "Queued",
      },
      cancelRequested: false,
      result: null,
    };

    this.operations.push(operation);
    await this.persist();
    return operation;
  }

  async markRunning(id) {
    const op = this.getById(id);
    if (!op) return null;
    op.status = "running";
    op.attempts += 1;
    op.startedAt = nowIso();
    op.updatedAt = nowIso();
    op.error = null;
    op.cancelRequested = false;
    op.progress.message = "Running";
    await this.persist();
    return op;
  }

  async markProgress(id, progress) {
    const op = this.getById(id);
    if (!op) return null;
    op.progress = {
      ...op.progress,
      ...progress,
    };
    op.updatedAt = nowIso();
    await this.persist();
    return op;
  }

  async markCompleted(id, result) {
    const op = this.getById(id);
    if (!op) return null;
    op.status = "completed";
    op.result = result || null;
    op.completedAt = nowIso();
    op.updatedAt = nowIso();
    if (op.progress.total > 0) {
      op.progress.completed = op.progress.total;
    }
    op.progress.message = "Completed";
    await this.persist();
    return op;
  }

  async markFailed(id, error) {
    const op = this.getById(id);
    if (!op) return null;
    op.status = "failed";
    op.error = error?.message || String(error);
    op.completedAt = nowIso();
    op.updatedAt = nowIso();
    op.progress.message = "Failed";
    await this.persist();
    return op;
  }

  async retry(id) {
    const op = this.getById(id);
    if (!op) return null;
    op.status = "queued";
    op.error = null;
    op.completedAt = null;
    op.cancelRequested = false;
    op.updatedAt = nowIso();
    op.progress.message = "Queued (retry)";
    await this.persist();
    return op;
  }

  async markCancelled(id, reason = "Cancelled") {
    const op = this.getById(id);
    if (!op) return null;
    op.status = "cancelled";
    op.error = null;
    op.completedAt = nowIso();
    op.updatedAt = nowIso();
    op.cancelRequested = false;
    op.progress.message = reason;
    await this.persist();
    return op;
  }

  async cancel(id) {
    const op = this.getById(id);
    if (!op) return null;

    if (op.status === "completed" || op.status === "failed" || op.status === "cancelled") {
      return { op, changed: false, reason: "Operation already finished" };
    }

    if (op.status === "queued") {
      const cancelled = await this.markCancelled(id);
      return { op: cancelled, changed: true, reason: "Cancelled" };
    }

    if (op.status === "running") {
      op.cancelRequested = true;
      op.updatedAt = nowIso();
      op.progress.message = "Cancelling";
      await this.persist();
      return { op, changed: true, reason: "Cancellation requested" };
    }

    return { op, changed: false, reason: "Unsupported operation state" };
  }

  getNextQueued() {
    return this.operations
      .filter((op) => op.status === "queued")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null;
  }

  async persist() {
    this.pendingWrite = this.pendingWrite.then(async () => {
      const tempPath = join(dirname(this.filePath), `.operations-${Date.now()}.tmp`);
      const payload = JSON.stringify({ operations: this.operations }, null, 2);
      await writeFile(tempPath, payload, "utf-8");
      await rename(tempPath, this.filePath);
    });

    return this.pendingWrite;
  }
}
