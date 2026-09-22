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

function fakeS3WithPrefixMap(prefixMap = {}) {
  return new FakeClient({
    ListObjectsV2Command(input) {
      const keys = prefixMap[input.Prefix] || [];
      return {
        Contents: keys.map((key) => ({ Key: key })),
        IsTruncated: false,
      };
    },
  });
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
  assert.ok(!commandNames.includes("DeleteObjectsCommand"));
});

test("move cancellation does not delete source", async () => {
  const client = new FakeClient({});
  const ops = new AwsS3Ops(client);
  let cancel = false;

  await assert.rejects(
    () =>
      ops.moveTargets({
        bucket: "demo",
        sources: ["docs/file.txt"],
        destination: "archive/",
        shouldCancel: () => {
          if (!cancel) {
            cancel = true;
            return false;
          }
          return true;
        },
      }),
    /Operation cancelled/
  );

  const commandNames = client.calls.map((c) => c.type);
  assert.ok(!commandNames.includes("DeleteObjectsCommand"));
});

test("move file to same parent is rejected safely", async () => {
  const client = new FakeClient({});
  const ops = new AwsS3Ops(client);

  await assert.rejects(
    () =>
      ops.moveTargets({
        bucket: "demo",
        sources: ["docs/file.txt"],
        destination: "docs/",
      }),
    /Source and destination are the same/
  );

  const commandNames = client.calls.map((c) => c.type);
  assert.equal(commandNames.length, 0);
});

test("move folder to same parent is rejected safely", async () => {
  const client = new FakeClient({});
  const ops = new AwsS3Ops(client);

  await assert.rejects(
    () =>
      ops.moveTargets({
        bucket: "demo",
        sources: ["docs/folder/"],
        destination: "docs/",
      }),
    /Source and destination are the same/
  );

  const commandNames = client.calls.map((c) => c.type);
  assert.equal(commandNames.length, 0);
});

test("single folder dropped onto itself is a safe no-op", async () => {
  const client = fakeS3WithPrefixMap({
    "a/": ["a/file1.txt"],
  });
  const ops = new AwsS3Ops(client);

  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["a/"],
    destination: "a/",
  });

  assert.equal(result.noop, true);
  assert.equal(result.moved, 0);
  assert.equal(result.copied, 0);
  assert.deepEqual(result.skipped.destinationSelf, ["a/"]);
  const commandNames = client.calls.map((c) => c.type);
  assert.equal(commandNames.length, 0);
});

test("folder + file dropped onto selected folder processes file and excludes folder", async () => {
  const client = fakeS3WithPrefixMap({
    "a/": ["a/file1.txt"],
  });
  const ops = new AwsS3Ops(client);

  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["a/", "b.txt"],
    destination: "a/",
  });

  assert.equal(result.moved, 1);
  assert.deepEqual(result.skipped.destinationSelf, ["a/"]);
  const copyCalls = client.calls.filter((c) => c.type === "CopyObjectCommand");
  assert.equal(copyCalls.length, 1);
  assert.equal(copyCalls[0].input.Key, "a/b.txt");
});

test("folder + multiple files dropped onto selected folder processes non-destination items", async () => {
  const client = fakeS3WithPrefixMap({
    "a/": ["a/one.txt"],
  });
  const ops = new AwsS3Ops(client);

  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["a/", "b.txt", "c.txt"],
    destination: "a/",
  });

  assert.equal(result.moved, 2);
  assert.deepEqual(result.skipped.destinationSelf, ["a/"]);
  const copyCalls = client.calls.filter((c) => c.type === "CopyObjectCommand");
  assert.equal(copyCalls.length, 2);
  assert.deepEqual(copyCalls.map((c) => c.input.Key).sort(), ["a/b.txt", "a/c.txt"]);
});

test("nested folder selections avoid recursive self-copy and redundant nested entries", async () => {
  const client = fakeS3WithPrefixMap({
    "a/": ["a/child/file.txt", "a/root.txt"],
    "a/child/": ["a/child/file.txt"],
  });
  const ops = new AwsS3Ops(client);

  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["a/", "a/child/"],
    destination: "target/",
  });

  assert.equal(result.moved, 2);
  assert.deepEqual(result.skipped.redundantNested, ["a/child/"]);
  const copyCalls = client.calls.filter((c) => c.type === "CopyObjectCommand");
  assert.equal(copyCalls.length, 2);
});

test("folder with descendant destination excludes invalid recursive source and continues", async () => {
  const client = fakeS3WithPrefixMap({
    "a/": ["a/root.txt"],
  });
  const ops = new AwsS3Ops(client);

  const result = await ops.moveTargets({
    bucket: "demo",
    sources: ["a/", "outside.txt"],
    destination: "a/sub/",
  });

  assert.equal(result.moved, 1);
  assert.deepEqual(result.skipped.recursive, ["a/"]);
  const copyCalls = client.calls.filter((c) => c.type === "CopyObjectCommand");
  assert.equal(copyCalls.length, 1);
  assert.equal(copyCalls[0].input.Key, "a/sub/outside.txt");
});

test("large nested selection trips depth/object safety guard", async () => {
  const hugeKeys = Array.from({ length: 50001 }, (_, i) => `huge/item-${i}.txt`);
  const client = fakeS3WithPrefixMap({
    "huge/": hugeKeys,
  });
  const ops = new AwsS3Ops(client);

  await assert.rejects(
    () =>
      ops.moveTargets({
        bucket: "demo",
        sources: ["huge/"],
        destination: "target/",
      }),
    /Operation exceeds safety limit/
  );

  const commandNames = client.calls.map((c) => c.type);
  assert.ok(!commandNames.includes("DeleteObjectsCommand"));
});
