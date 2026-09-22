const POLL_INTERVAL_MS = 600;

export class OperationsWorker {
  constructor({ store, s3ops }) {
    this.store = store;
    this.s3ops = s3ops;
    this.running = false;
    this.timer = null;
    this.loopActive = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), POLL_INTERVAL_MS);
    this.wake();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async wake() {
    if (this.loopActive) return;
    this.loopActive = true;

    try {
      while (true) {
        const next = this.store.getNextQueued();
        if (!next) break;
        await this.runOperation(next.id);
      }
    } finally {
      this.loopActive = false;
    }
  }

  async runOperation(id) {
    const op = await this.store.markRunning(id);
    if (!op) return;

    try {
      const onProgress = (progress) => this.store.markProgress(id, progress);
      let result;

      if (op.type === "move") {
        result = await this.s3ops.moveTargets({
          bucket: op.payload.bucket,
          sources: op.payload.sources,
          destination: op.payload.destination,
          onProgress,
        });
      } else if (op.type === "copy") {
        result = await this.s3ops.copyTargets({
          bucket: op.payload.bucket,
          sources: op.payload.sources,
          destination: op.payload.destination,
          onProgress,
        });
      } else if (op.type === "delete") {
        result = await this.s3ops.deleteTargets({
          bucket: op.payload.bucket,
          targets: op.payload.targets,
          onProgress,
        });
      } else if (op.type === "rename") {
        result = await this.s3ops.renameTarget({
          bucket: op.payload.bucket,
          source: op.payload.source,
          newName: op.payload.newName,
          onProgress,
        });
      } else {
        throw new Error(`Unsupported operation type: ${op.type}`);
      }

      await this.store.markCompleted(id, result);
    } catch (err) {
      await this.store.markFailed(id, err);
    }
  }
}
