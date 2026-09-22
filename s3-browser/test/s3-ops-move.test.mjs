import test from "node:test";
import assert from "node:assert/strict";

import { AwsS3Ops } from "../s3-ops.mjs";

class FakeClient {
  constructor(handlers) {
    this.handlers = handlers;
    this.calls = [];
  }

  async send(command) {
    const type = command.constructor.name;
    this.calls.push({ type, input: command.input });
    const handler = this.handlers[type];
    if (!handler) return {};
    return handler(command.input, this.calls.length - 1);
  }
}

test("move copies before deleting source", async () => {
  const client = new FakeClient({});
  const ops = new AwsS3Ops(client);

  const progress = [];
  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["docs/file.txt"],
    destination: "archive/",
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result.moved, 1);

  const commandNames = client.calls.map((c) => c.type);
  const copyIndex = commandNames.indexOf("CopyObjectCommand");
  const deleteIndex = commandNames.indexOf("DeleteObjectsCommand");

  assert.notEqual(copyIndex, -1);
  assert.notEqual(deleteIndex, -1);
  assert.ok(copyIndex < deleteIndex);
  assert.ok(progress.some((p) => p.message === "Copying"));
  assert.ok(progress.some((p) => p.message === "Deleting source"));
});

test("move does not delete source when copy fails", async () => {
  const client = new FakeClient({
    CopyObjectCommand() {
      throw new Error("copy failed");
    },
  });

  const ops = new AwsS3Ops(client);

  await assert.rejects(
    () =>
      ops.moveTargets({
        bucket: "demo",
        sources: ["docs/file.txt"],
        destination: "archive/",
      }),
    /copy failed/
  );

  const commandNames = client.calls.map((c) => c.type);
  assert.ok(commandNames.includes("CopyObjectCommand"));
  assert.ok(!commandNames.includes("DeleteObjectsCommand"));
});
