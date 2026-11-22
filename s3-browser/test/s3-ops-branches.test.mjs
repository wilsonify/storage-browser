import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AwsS3Ops } from "../s3-ops.mjs";

class FakeClient {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.calls = [];
  }

  async send(command) {
    const type = command.constructor.name;
    this.calls.push({ type, input: command.input });
    const handler = this.handlers[type];
    return handler ? handler(command.input, this.calls.length - 1) : {};
  }

  types() {
    return this.calls.map((call) => call.type);
  }
}

function cancelled() {
  const error = new Error("Operation cancelled");
  error.name = "OperationCancelledError";
  return error;
}

function listHandler(prefixMap = {}) {
  return (input) => ({
    Contents: (prefixMap[input.Prefix] || []).map((key) => ({ Key: key })),
    IsTruncated: false,
  });
}

test("listing buckets and objects maps the SDK shapes", async () => {
  const client = new FakeClient({
    ListBucketsCommand: () => ({
      Buckets: [{ Name: "one", CreationDate: new Date(0) }, { Name: "two" }],
    }),
    ListObjectsV2Command: () => ({
      CommonPrefixes: [{ Prefix: "music/albums/" }],
      Contents: [{ Key: "music/a.mp3", Size: 5, LastModified: new Date(0) }, { Key: "music/" }],
      IsTruncated: true,
      NextContinuationToken: "next",
    }),
  });
  const ops = new AwsS3Ops(client);

  assert.deepEqual(await ops.listBuckets(), [
    { name: "one", created: new Date(0).toISOString() },
    { name: "two", created: undefined },
  ]);

  const page = await ops.listObjects({ bucket: "b1", prefix: "music/" });
  assert.deepEqual(page.folders, [{ name: "albums", type: "folder", path: "music/albums/" }]);
  assert.equal(page.files.length, 1);
  assert.equal(page.files[0].name, "a.mp3");
  assert.equal(page.files[0].size, 5);
  assert.equal(page.isTruncated, true);
  assert.equal(page.nextContinuationToken, "next");

  const input = client.calls[1].input;
  assert.equal(input.Delimiter, "/");
  assert.equal(input.MaxKeys, 1000);
});

test("downloads head then get the same object", async () => {
  const client = new FakeClient({
    HeadObjectCommand: () => ({ ContentLength: 7 }),
    GetObjectCommand: () => ({ Body: "stream-body" }),
  });

  const result = await new AwsS3Ops(client).getDownloadStream("b1", "qa/a.txt");

  assert.equal(result.head.ContentLength, 7);
  assert.equal(result.body, "stream-body");
  assert.deepEqual(client.types(), ["HeadObjectCommand", "GetObjectCommand"]);
});

test("prefix enumeration follows continuation tokens until exhausted", async () => {
  const client = new FakeClient({
    ListObjectsV2Command: (input) => (input.ContinuationToken
      ? { Contents: [{ Key: "qa/c.txt" }], IsTruncated: false }
      : { Contents: [{ Key: "qa/a.txt" }], IsTruncated: true, NextContinuationToken: "page-2" }),
  });

  const keys = await new AwsS3Ops(client).listAllKeysForPrefix("b1", "qa/");

  assert.deepEqual(keys, ["qa/a.txt", "qa/c.txt"]);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].input.ContinuationToken, "page-2");
});

test("copy, delete and folder-marker commands use safe request shapes", async () => {
  const client = new FakeClient();
  const ops = new AwsS3Ops(client);

  await ops.copyObject("b1", "qa/a b.txt", "qa/out.txt");
  assert.equal(client.calls[0].input.CopySource, "b1/qa%2Fa%20b.txt");
  assert.equal(client.calls[0].input.Key, "qa/out.txt");

  await ops.deleteKeys("b1", Array.from({ length: 1001 }, (_, index) => `qa/${index}.txt`));
  assert.equal(client.calls.length, 3, "1001 keys take two delete requests");
  assert.equal(client.calls[1].input.Delete.Objects.length, 1000);
  assert.equal(client.calls[2].input.Delete.Objects.length, 1);
  assert.equal(client.calls[1].input.Delete.Quiet, true);

  await ops.putEmptyFolderMarker("b1", "qa/folder");
  assert.equal(client.calls[3].input.Key, "qa/folder/");
});

test("object size lookups treat only not-found as absence", async () => {
  const present = new FakeClient({ HeadObjectCommand: () => ({ ContentLength: 42 }) });
  assert.deepEqual(
    await new AwsS3Ops(present).getObjectSize("b1", "a.txt"),
    { exists: true, size: 42 },
  );

  const unknownSize = new FakeClient({ HeadObjectCommand: () => ({}) });
  assert.deepEqual(
    await new AwsS3Ops(unknownSize).getObjectSize("b1", "a.txt"),
    { exists: true, size: null },
    "a successful head without a length is still an existing object",
  );

  for (const error of [
    Object.assign(new Error("gone"), { name: "NotFound" }),
    Object.assign(new Error("gone"), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("gone"), { Code: "NotFound" }),
  ]) {
    const client = new FakeClient({ HeadObjectCommand: () => { throw error; } });
    assert.deepEqual(await new AwsS3Ops(client).getObjectSize("b1", "a.txt"), { exists: false, size: null });
  }

  const denied = new FakeClient({
    HeadObjectCommand: () => { throw Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } }); },
  });
  await assert.rejects(() => new AwsS3Ops(denied).getObjectSize("b1", "a.txt"), /denied/);
});

test("local upload planning separates files, empty folders and symlinks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-plan-"));
  const album = join(dir, "Album");
  await mkdir(join(album, "empty"), { recursive: true });
  await mkdir(join(album, "Disc 1"), { recursive: true });
  await writeFile(join(album, "cover.jpg"), "img");
  await writeFile(join(album, "Disc 1", "song.mp3"), "audio");

  let linkTarget = join(album, "link.txt");
  let createdLink = false;
  try {
    await symlink(join(album, "cover.jpg"), linkTarget);
    createdLink = true;
  } catch {
    createdLink = false;
  }

  const ops = new AwsS3Ops(new FakeClient());
  const plan = await ops.collectLocalUploadPlan(album, () => false);

  assert.equal(plan.rootName, "Album");
  const relativePaths = plan.files.map((file) => file.relPath.replaceAll("\\", "/")).sort();
  assert.deepEqual(relativePaths, ["Disc 1/song.mp3", "cover.jpg"]);
  assert.deepEqual(plan.emptyFolders, ["empty"]);
  if (createdLink) {
    assert.deepEqual(plan.skippedSymlinks, ["link.txt"]);
  } else {
    t.diagnostic("symlink creation not permitted; skipped symlink assertion");
  }

  const single = await ops.collectLocalUploadPlan(join(album, "cover.jpg"), () => false);
  assert.equal(single.rootName, null);
  assert.deepEqual(single.files.map((file) => file.relPath), ["cover.jpg"]);
  assert.equal(single.files[0].size, 3);

  // A cancelled walk stops before enumerating children.
  const cancelAfterStart = await ops.collectLocalUploadPlan(album, () => true).then(
    () => null,
    (error) => error,
  );
  assert.equal(cancelAfterStart?.name, "OperationCancelledError");
});

test("local sync is a no-op without usable sources", async () => {
  const client = new FakeClient();
  const ops = new AwsS3Ops(client);
  const progress = [];

  const result = await ops.syncLocalSourcesToS3({
    bucket: "b1",
    sources: ["", "   ", 42],
    destination: "/",
    onProgress: (update) => progress.push(update),
  });

  assert.equal(result.noop, true);
  assert.equal(result.uploaded, 0);
  assert.deepEqual(progress, [{ total: 0, completed: 0, message: "No-op" }]);
  assert.equal(client.calls.length, 0);
});

test("local sync skips unchanged objects and uploads changed ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-sync-"));
  await writeFile(join(dir, "same.txt"), "same");
  await writeFile(join(dir, "changed.txt"), "new-bytes");

  const sizes = {
    "dest/same.txt": 4,
    "dest/changed.txt": 3,
  };
  const client = new FakeClient({
    HeadObjectCommand: (input) => {
      if (!(input.Key in sizes)) throw Object.assign(new Error("missing"), { name: "NotFound" });
      return { ContentLength: sizes[input.Key] };
    },
  });

  const result = await new AwsS3Ops(client).syncLocalSourcesToS3({
    bucket: "b1",
    sources: [join(dir, "same.txt"), join(dir, "changed.txt")],
    destination: "/dest/",
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.uploadedNew, 0);
  assert.equal(result.uploadedUpdated, 1);
  assert.equal(result.skippedExisting, 1);
  assert.equal(result.destination, "dest/");

  const putKeys = client.calls
    .filter((call) => call.type === "PutObjectCommand")
    .map((call) => call.input.Key);
  assert.deepEqual(putKeys, ["dest/changed.txt"]);
});

test("local sync with overwrite skips existence checks entirely", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-overwrite-"));
  await writeFile(join(dir, "a.txt"), "a");

  const client = new FakeClient();
  const result = await new AwsS3Ops(client).syncLocalSourcesToS3({
    bucket: "b1",
    sources: [join(dir, "a.txt")],
    destination: "music/",
    overwrite: true,
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.uploadedNew, 1);
  assert.equal(client.types().includes("HeadObjectCommand"), false);
});

test("local sync writes folder markers for empty directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-marker-"));
  const root = join(dir, "Tree");
  await mkdir(join(root, "empty"), { recursive: true });

  const client = new FakeClient({
    HeadObjectCommand: () => { throw Object.assign(new Error("missing"), { name: "NotFound" }); },
  });

  const result = await new AwsS3Ops(client).syncLocalSourcesToS3({
    bucket: "b1",
    sources: [root],
    destination: "dest/",
  });

  assert.equal(result.folderMarkers, 1);
  const markers = client.calls
    .filter((call) => call.type === "PutObjectCommand")
    .map((call) => call.input.Key);
  assert.deepEqual(markers, ["dest/Tree/empty/"]);

  // A marker that already exists is skipped without a second write.
  const existing = new FakeClient({ HeadObjectCommand: () => ({ ContentLength: 0 }) });
  const skipped = await new AwsS3Ops(existing).syncLocalSourcesToS3({
    bucket: "b1",
    sources: [root],
    destination: "dest/",
  });
  assert.equal(skipped.skippedExisting, 1);
  assert.equal(skipped.folderMarkers, 0);
  assert.equal(existing.types().includes("PutObjectCommand"), false);
});

test("local sync honours cancellation before any upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-sync-cancel-"));
  await writeFile(join(dir, "a.txt"), "a");

  const client = new FakeClient();
  await assert.rejects(
    () => new AwsS3Ops(client).syncLocalSourcesToS3({
      bucket: "b1",
      sources: [join(dir, "a.txt")],
      destination: "d/",
      shouldCancel: () => true,
    }),
    (error) => error.name === "OperationCancelledError",
  );
  assert.equal(client.calls.length, 0);
});

test("copy planning expands folders, keeps names and marks empty folders", async () => {
  const client = new FakeClient({
    ListObjectsV2Command: listHandler({
      "qa/tree/": ["qa/tree/a.txt", "qa/tree/deep/b.txt"],
      "qa/empty/": [],
    }),
  });
  const ops = new AwsS3Ops(client);

  const files = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/tree/"],
    destination: "out/",
  });
  assert.equal(files.copied, 2);
  assert.deepEqual(files.copiedKeys.sort(), ["out/tree/a.txt", "out/tree/deep/b.txt"]);

  const markers = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/empty/"],
    destination: "out/",
  });
  assert.equal(markers.copied, 1);
  const markerPut = client.calls.find((call) => call.type === "PutObjectCommand");
  assert.equal(markerPut.input.Key, "out/empty/");

  const single = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/file.txt"],
    destination: "out",
  });
  assert.equal(single.copied, 1);
  assert.equal(single.copiedKeys[0], "out/file.txt");
});

test("copy planning drops self, recursive and redundant selections", async () => {
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/": ["qa/a.txt"] }) });
  const ops = new AwsS3Ops(client);

  const selfDestination = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/"],
    destination: "qa/",
  });
  assert.equal(selfDestination.noop, true);
  assert.deepEqual(selfDestination.skipped.destinationSelf, ["qa/"]);

  const recursive = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/"],
    destination: "qa/inner/",
  });
  assert.equal(recursive.noop, true);
  assert.deepEqual(recursive.skipped.recursive, ["qa/"]);

  const nested = await ops.copyTargets({
    bucket: "b1",
    sources: ["qa/", "qa/sub/"],
    destination: "out/",
  });
  assert.equal(nested.copied, 1);
  assert.deepEqual(nested.skipped.redundantNested, ["qa/sub/"]);
  assert.equal(client.calls.filter((call) => call.type === "CopyObjectCommand").length, 1);
});

test("copy planning enforces the expanded-object safety limit", async () => {
  const keys = Array.from({ length: 50001 }, (_, index) => `qa/huge/${index}.txt`);
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/huge/": keys }) });

  await assert.rejects(
    () => new AwsS3Ops(client).copyTargets({
      bucket: "b1",
      sources: ["qa/huge/"],
      destination: "out/",
    }),
    /safety limit of 50000 objects/,
  );
  assert.equal(client.calls.filter((call) => call.type === "CopyObjectCommand").length, 0);
});

test("copy planning stops at a cancellation between objects", async () => {
  let copies = 0;
  const client = new FakeClient({
    ListObjectsV2Command: listHandler({ "qa/tree/": ["qa/tree/a.txt", "qa/tree/b.txt"] }),
    CopyObjectCommand: () => { copies += 1; },
  });

  await assert.rejects(
    () => new AwsS3Ops(client).copyTargets({
      bucket: "b1",
      sources: ["qa/tree/"],
      destination: "out/",
      shouldCancel: () => copies >= 1,
    }),
    (error) => error.name === "OperationCancelledError",
  );
  assert.equal(copies, 1, "no further copies run after the cancel is observed");
});

test("move planning rejects same-parent moves and deletes only after copying", async () => {
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/src/": ["qa/src/a.txt", "qa/src/b.txt"] }) });
  const ops = new AwsS3Ops(client);

  await assert.rejects(
    () => ops.moveTargets({ bucket: "b1", sources: ["qa/src/a.txt"], destination: "qa/src/" }),
    /Source and destination are the same/,
  );

  const result = await ops.moveTargets({
    bucket: "b1",
    sources: ["qa/src/"],
    destination: "qa/dst/",
  });

  assert.equal(result.moved, 2);
  assert.equal(result.copied, 2);
  const types = client.types();
  const firstCopy = types.indexOf("CopyObjectCommand");
  const deleteIndex = types.indexOf("DeleteObjectsCommand");
  assert.ok(firstCopy < deleteIndex);
  assert.deepEqual(client.calls[deleteIndex].input.Delete.Objects, [
    { Key: "qa/src/a.txt" },
    { Key: "qa/src/b.txt" },
  ]);
});

test("move planning cancels before deleting the sources", async () => {
  let copies = 0;
  const client = new FakeClient({
    ListObjectsV2Command: listHandler({ "qa/src/": ["qa/src/a.txt"] }),
    CopyObjectCommand: () => { copies += 1; },
  });

  await assert.rejects(
    () => new AwsS3Ops(client).moveTargets({
      bucket: "b1",
      sources: ["qa/src/"],
      destination: "qa/dst/",
      shouldCancel: () => copies >= 1,
    }),
    (error) => error.name === "OperationCancelledError",
  );
  assert.equal(client.types().includes("DeleteObjectsCommand"), false, "the source survives a cancelled move");
});

test("move planning enforces the safety limit and marks empty folders", async () => {
  const hugeKeys = Array.from({ length: 50001 }, (_, index) => `qa/huge/${index}.txt`);
  const hugeClient = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/huge/": hugeKeys }) });

  await assert.rejects(
    () => new AwsS3Ops(hugeClient).moveTargets({
      bucket: "b1",
      sources: ["qa/huge/"],
      destination: "out/",
    }),
    /safety limit of 50000 objects/,
  );
  assert.equal(hugeClient.types().includes("DeleteObjectsCommand"), false);

  const markerClient = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/empty/": [] }) });
  const markerResult = await new AwsS3Ops(markerClient).moveTargets({
    bucket: "b1",
    sources: ["qa/empty/"],
    destination: "out/",
  });

  assert.equal(markerResult.copied, 1);
  assert.equal(markerResult.moved, 0);
  const marker = markerClient.calls.find((call) => call.type === "PutObjectCommand");
  assert.equal(marker.input.Key, "out/empty/");
  assert.equal(markerClient.types().includes("DeleteObjectsCommand"), false);
});

test("move planning treats a dropped folder onto itself as a no-op", async () => {
  const client = new FakeClient();
  const result = await new AwsS3Ops(client).moveTargets({
    bucket: "b1",
    sources: ["qa/self/"],
    destination: "qa/self/",
  });

  assert.equal(result.noop, true);
  assert.equal(result.moved, 0);
  assert.equal(client.calls.length, 0);
});

test("delete planning expands folders, chunks large sets and reports totals", async () => {
  const keys = Array.from({ length: 2500 }, (_, index) => `qa/bulk/${index}.txt`);
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/bulk/": keys }) });

  const progress = [];
  const result = await new AwsS3Ops(client).deleteTargets({
    bucket: "b1",
    targets: ["qa/bulk/", "qa/single.txt"],
    onProgress: (update) => progress.push(update),
  });

  assert.equal(result.deleted, 2501);
  const deletes = client.calls.filter((call) => call.type === "DeleteObjectsCommand");
  assert.deepEqual(deletes.map((call) => call.input.Delete.Objects.length), [1000, 1000, 501]);
  assert.equal(progress[0].total, 2501);
  assert.equal(progress[progress.length - 1].completed, 2501);
});

test("delete planning reports an empty folder without issuing a delete", async () => {
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/empty/": [] }) });

  const result = await new AwsS3Ops(client).deleteTargets({ bucket: "b1", targets: ["qa/empty/"] });

  assert.equal(result.deleted, 0);
  assert.equal(client.types().includes("DeleteObjectsCommand"), false);
});

test("delete planning observes cancellation before removing anything", async () => {
  const client = new FakeClient();
  await assert.rejects(
    () => new AwsS3Ops(client).deleteTargets({
      bucket: "b1",
      targets: ["qa/a.txt"],
      shouldCancel: () => true,
    }),
    (error) => error.name === "OperationCancelledError",
  );
  assert.equal(client.calls.length, 0);
});

test("rename planning rejects invalid names and self-renames", async () => {
  const ops = new AwsS3Ops(new FakeClient());

  for (const newName of ["", null, 42]) {
    await assert.rejects(
      () => ops.renameTarget({ bucket: "b1", source: "qa/a.txt", newName }),
      /Invalid newName/,
    );
  }

  await assert.rejects(
    () => ops.renameTarget({ bucket: "b1", source: "qa/a.txt", newName: "a.txt" }),
    /Source and destination are the same/,
  );

  await assert.rejects(
    () => ops.renameTarget({ bucket: "b1", source: "qa/f/", newName: "f/sub" }),
    /Cannot rename a folder into itself/,
  );
});

test("renaming a file copies to the sibling name and deletes the original", async () => {
  const client = new FakeClient();
  const result = await new AwsS3Ops(client).renameTarget({
    bucket: "b1",
    source: "qa/dir/old.txt",
    newName: "new.txt",
  });

  assert.equal(result.destination, "qa/dir/new.txt");
  assert.equal(result.renamed, 1);
  const copy = client.calls.find((call) => call.type === "CopyObjectCommand");
  assert.equal(copy.input.Key, "qa/dir/new.txt");
  assert.deepEqual(client.calls[1].input.Delete.Objects, [{ Key: "qa/dir/old.txt" }]);
});

test("renaming a folder rewrites every child and drops the old prefix", async () => {
  const client = new FakeClient({
    ListObjectsV2Command: listHandler({ "qa/old/": ["qa/old/a.txt", "qa/old/deep/b.txt"] }),
  });

  const result = await new AwsS3Ops(client).renameTarget({
    bucket: "b1",
    source: "qa/old/",
    newName: "new",
  });

  assert.equal(result.destination, "qa/new/");
  assert.equal(result.renamed, 2);
  const copied = client.calls
    .filter((call) => call.type === "CopyObjectCommand")
    .map((call) => call.input.Key)
    .sort();
  assert.deepEqual(copied, ["qa/new/a.txt", "qa/new/deep/b.txt"]);
});

test("renaming an empty folder writes a marker instead of deleting objects", async () => {
  const client = new FakeClient({ ListObjectsV2Command: listHandler({ "qa/old/": [] }) });

  const result = await new AwsS3Ops(client).renameTarget({
    bucket: "b1",
    source: "qa/old/",
    newName: "new",
  });

  assert.equal(result.renamed, 0);
  assert.equal(client.types().includes("DeleteObjectsCommand"), false);
  const put = client.calls.find((call) => call.type === "PutObjectCommand");
  assert.equal(put.input.Key, "qa/new/");
});
