import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("local folder sync preserves folder structure without duplicate root level", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-local-sync-"));
  const albumDir = join(dir, "Album");
  const discDir = join(albumDir, "Disc 1");

  await mkdir(discDir, { recursive: true });
  await writeFile(join(albumDir, "cover art.jpg"), "img");
  await writeFile(join(discDir, "01 - Cafe del Mar.mp3"), "audio");

  const client = new FakeClient({
    HeadObjectCommand() {
      const err = new Error("Not found");
      err.name = "NotFound";
      throw err;
    },
  });

  const ops = new AwsS3Ops(client);
  const result = await ops.syncLocalSourcesToS3({
    bucket: "songs-bucket",
    sources: [albumDir],
    destination: "songs/",
  });

  assert.equal(result.uploaded, 2);

  const putKeys = client.calls
    .filter((call) => call.type === "PutObjectCommand")
    .map((call) => call.input.Key)
    .sort();

  assert.deepEqual(putKeys, [
    "songs/Album/Disc 1/01 - Cafe del Mar.mp3",
    "songs/Album/cover art.jpg",
  ]);
});

test("local sync supports spaces and unicode names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-local-unicode-"));
  const sourceDir = join(dir, "Música 2026");

  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "été résumé.txt"), "hello");

  const client = new FakeClient({
    HeadObjectCommand() {
      const err = new Error("Not found");
      err.name = "NotFound";
      throw err;
    },
  });

  const ops = new AwsS3Ops(client);
  await ops.syncLocalSourcesToS3({
    bucket: "demo",
    sources: [sourceDir],
    destination: "uploads/",
  });

  const putCall = client.calls.find((call) => call.type === "PutObjectCommand");
  assert.ok(putCall);
  assert.equal(putCall.input.Key, "uploads/Música 2026/été résumé.txt");
});

test("local sync safely skips existing destination objects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-local-existing-"));
  const sourceDir = join(dir, "Album");

  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "existing.txt"), "hello");
  await writeFile(join(sourceDir, "new.txt"), "world");

  const existing = new Set(["songs/Album/existing.txt"]);
  const client = new FakeClient({
    HeadObjectCommand(input) {
      if (existing.has(input.Key)) return { ContentLength: 5 };
      const err = new Error("Not found");
      err.name = "NotFound";
      throw err;
    },
  });

  const ops = new AwsS3Ops(client);
  const result = await ops.syncLocalSourcesToS3({
    bucket: "demo",
    sources: [sourceDir],
    destination: "songs/",
    overwrite: false,
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.skippedExisting, 1);

  const putKeys = client.calls
    .filter((call) => call.type === "PutObjectCommand")
    .map((call) => call.input.Key);

  assert.deepEqual(putKeys, ["songs/Album/new.txt"]);
});
