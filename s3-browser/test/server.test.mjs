import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { createAppServer, resolveS3ClientConfig, resolveStateFilePath } from "../server.mjs";
import { OperationStore } from "../operations-store.mjs";

process.env.S3_BROWSER_NO_OPEN = "1";

function makeS3Ops(overrides = {}) {
  const calls = { listBuckets: 0, listObjects: [], download: [] };
  const s3ops = {
    calls,
    buckets: [{ name: "b1", created: "2020-01-01T00:00:00.000Z" }],
    bucketError: null,
    objects: { folders: [], files: [], isTruncated: false },
    objectsError: null,
    download: null,
    downloadError: null,

    async listBuckets() {
      calls.listBuckets += 1;
      if (this.bucketError) throw this.bucketError;
      return this.buckets;
    },

    async listObjects(args) {
      calls.listObjects.push(args);
      if (this.objectsError) throw this.objectsError;
      return this.objects;
    },

    async getDownloadStream(bucket, key) {
      calls.download.push({ bucket, key });
      if (this.downloadError) throw this.downloadError;
      return this.download;
    },

    ...overrides,
  };
  return s3ops;
}

async function startApp({ s3ops = makeS3Ops(), loadIndex, loadAsset } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-server-"));
  const store = new OperationStore(join(dir, "operations.json"));
  const worker = {
    kicks: 0,
    started: 0,
    stopped: 0,
    kick() { this.kicks += 1; },
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
  };

  const app = createAppServer({
    s3ops,
    operationStore: store,
    operationWorker: worker,
    loadIndex: loadIndex || (async () => "<html>index sentinel</html>"),
    loadAsset: loadAsset || (async (name) => Buffer.from(`asset:${name}`)),
    host: "127.0.0.1",
    port: 0,
    exit: () => {},
  });

  const baseUrl = await app.start();
  const close = () => new Promise((resolve) => app.server.close(resolve));
  return { app, baseUrl, store, worker, s3ops, close };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("serves index and static assets and 404s unmatched routes", async (t) => {
  const { baseUrl, close } = await startApp();
  t.after(close);

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("content-type"), "text/html");
  assert.equal(await index.text(), "<html>index sentinel</html>");

  const repeated = await fetch(`${baseUrl}/index.html`);
  assert.equal(await repeated.text(), "<html>index sentinel</html>");

  const svg = await fetch(`${baseUrl}/assets/s3_browser_icon.svg`);
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(svg.headers.get("cache-control"), "public, max-age=86400");
  assert.equal(await svg.text(), "asset:s3_browser_icon.svg");

  const ico = await fetch(`${baseUrl}/assets/s3_browser_icon.ico`);
  assert.equal(ico.status, 200);
  assert.equal(ico.headers.get("content-type"), "image/x-icon");
  assert.equal(await ico.text(), "asset:s3_browser_icon.ico");

  const missing = await fetch(`${baseUrl}/does-not-exist`);
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), "Not found");

  // A known API path with the wrong method must not be treated as a match.
  const wrongMethod = await fetch(`${baseUrl}/api/buckets`, { method: "POST" });
  assert.equal(wrongMethod.status, 404);
  assert.equal(await wrongMethod.text(), "Not found");
});

test("asset and index read failures are reported without a stack trace", async (t) => {
  const { baseUrl, close } = await startApp({
    loadAsset: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    loadIndex: async () => { throw new Error("missing"); },
  });
  t.after(close);

  const asset = await fetch(`${baseUrl}/assets/s3_browser_icon.svg`);
  assert.equal(asset.status, 404);
  assert.equal(await asset.text(), "Not found");

  const index = await fetch(`${baseUrl}/`);
  assert.equal(index.status, 500);
  assert.equal(await index.text(), "index.html not found");
});

test("bucket listing returns adapter data and maps failures to 500", async (t) => {
  const s3ops = makeS3Ops();
  const { baseUrl, close } = await startApp({ s3ops });
  t.after(close);

  const ok = await fetch(`${baseUrl}/api/buckets`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), [{ name: "b1", created: "2020-01-01T00:00:00.000Z" }]);
  assert.equal(s3ops.calls.listBuckets, 1);

  s3ops.bucketError = new Error("AccessDenied");
  const failed = await fetch(`${baseUrl}/api/buckets`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "AccessDenied" });
});

test("object listing forwards the query and caps the page size", async (t) => {
  const s3ops = makeS3Ops();
  const { baseUrl, close } = await startApp({ s3ops });
  t.after(close);

  const response = await fetch(
    `${baseUrl}/api/buckets/${encodeURIComponent("music bucket")}/objects?prefix=albums%2F&continuationToken=abc&delimiter=%7C`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(s3ops.calls.listObjects, [{
    bucket: "music bucket",
    prefix: "albums/",
    continuationToken: "abc",
    delimiter: "|",
    maxKeys: 1000,
  }]);

  await fetch(`${baseUrl}/api/buckets/b1/objects`);
  assert.deepEqual(s3ops.calls.listObjects[1], {
    bucket: "b1",
    prefix: "",
    continuationToken: undefined,
    delimiter: "/",
    maxKeys: 1000,
  });

  s3ops.objectsError = new Error("NoSuchBucket");
  const failed = await fetch(`${baseUrl}/api/buckets/b1/objects`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "NoSuchBucket" });
});

test("enqueue rejects every invalid shape before touching the queue", async (t) => {
  const { baseUrl, store, worker, close } = await startApp();
  t.after(close);

  const cases = [
    ["not json", "{"],
    ["unknown type", { type: "bogus", payload: { bucket: "b1" } }],
    ["missing payload", { type: "move" }],
    ["payload not an object", { type: "move", payload: "nope" }],
    ["missing bucket", { type: "delete", payload: { targets: ["a"] } }],
    ["bucket not a string", { type: "delete", payload: { bucket: 7, targets: ["a"] } }],
    ["move without sources", { type: "move", payload: { bucket: "b1", destination: "d/" } }],
    ["move with empty source", { type: "move", payload: { bucket: "b1", sources: [""], destination: "d/" } }],
    ["move with non-string source", { type: "move", payload: { bucket: "b1", sources: [1], destination: "d/" } }],
    ["copy without destination", { type: "copy", payload: { bucket: "b1", sources: ["a"] } }],
    ["copy with empty destination", { type: "copy", payload: { bucket: "b1", sources: ["a"], destination: "" } }],
    ["delete without targets", { type: "delete", payload: { bucket: "b1", targets: [] } }],
    ["rename without source", { type: "rename", payload: { bucket: "b1", newName: "b" } }],
    ["rename with empty newName", { type: "rename", payload: { bucket: "b1", source: "a", newName: "" } }],
    ["sync without sources", { type: "syncLocalToS3", payload: { bucket: "b1", destination: "d/" } }],
    ["sync with bad destination", { type: "syncLocalToS3", payload: { bucket: "b1", sources: ["a"], destination: 5 } }],
  ];

  for (const [label, body] of cases) {
    const response = await postJson(baseUrl, "/api/operations", body);
    assert.equal(response.status, 400, `${label} must be rejected`);
    assert.equal(typeof response.body.error, "string", `${label} must explain the rejection`);
  }

  assert.deepEqual(store.list(), [], "no invalid request may reach the store");
  assert.equal(worker.kicks, 0, "no invalid request may wake the worker");
});

test("valid enqueue persists a queued operation and wakes the worker", async (t) => {
  const { baseUrl, store, worker, close } = await startApp();
  t.after(close);

  const created = await postJson(baseUrl, "/api/operations", {
    type: "move",
    payload: { bucket: "b1", sources: ["a.txt", "b.txt"], destination: "out/" },
  });

  assert.equal(created.status, 202);
  assert.match(created.body.id, /^op_/);
  assert.equal(created.body.status, "queued");

  const persisted = store.getById(created.body.id);
  assert.ok(persisted);
  assert.equal(persisted.type, "move");
  assert.deepEqual(persisted.payload.sources, ["a.txt", "b.txt"]);
  assert.equal(persisted.status, "queued");
  assert.equal(worker.kicks, 1);
});

test("a store failure is surfaced as 500 and does not wake the worker", async (t) => {
  const { baseUrl, store, worker, close } = await startApp();
  t.after(close);

  store.enqueue = async () => { throw new Error("disk full"); };

  const response = await postJson(baseUrl, "/api/operations", {
    type: "delete",
    payload: { bucket: "b1", targets: ["a.txt"] },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: "disk full" });
  assert.equal(worker.kicks, 0);
});

test("sync-folder-to-s3 normalises overwrite and rejects invalid sources", async (t) => {
  const { baseUrl, store, close } = await startApp();
  t.after(close);

  const minimal = await postJson(baseUrl, "/api/sync-folder-to-s3", { bucket: "b1", sources: ["C:\\music"] });
  assert.equal(minimal.status, 202);
  const minimalOp = store.getById(minimal.body.id);
  assert.equal(minimalOp.type, "syncLocalToS3");
  assert.equal(minimalOp.payload.destination, "");
  assert.equal(minimalOp.payload.overwrite, false);

  const explicit = await postJson(baseUrl, "/api/sync-folder-to-s3", {
    bucket: "b1",
    sources: ["/tmp/music"],
    destination: "music/",
    overwrite: "yes",
  });
  assert.equal(explicit.status, 202);
  const explicitOp = store.getById(explicit.body.id);
  assert.equal(explicitOp.payload.destination, "music/");
  assert.equal(explicitOp.payload.overwrite, false, "only a literal true enables overwrite");

  for (const body of [
    {},
    { bucket: "b1", sources: [] },
    { bucket: "b1", sources: ["   "] },
    { bucket: "b1", sources: ["ok"], destination: 7 },
  ]) {
    const rejected = await postJson(baseUrl, "/api/sync-folder-to-s3", body);
    assert.equal(rejected.status, 400);
  }

  const malformed = await postJson(baseUrl, "/api/sync-folder-to-s3", "{");
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { error: "Invalid JSON body" });
  assert.equal(store.list().length, 2);
});

test("the legacy move route enqueues a move and reports its id", async (t) => {
  const { baseUrl, store, close } = await startApp();
  t.after(close);

  const created = await postJson(baseUrl, "/api/move", { bucket: "b1", source: "a.txt", destination: "out/" });
  assert.equal(created.status, 202);
  assert.equal(created.body.status, "queued");
  assert.match(created.body.operationId, /^op_/);

  const persisted = store.getById(created.body.operationId);
  assert.equal(persisted.type, "move");
  assert.deepEqual(persisted.payload.sources, ["a.txt"]);
  assert.equal(persisted.payload.destination, "out/");

  const invalid = await postJson(baseUrl, "/api/move", { bucket: "b1", source: "a.txt" });
  assert.equal(invalid.status, 400);
  assert.deepEqual(invalid.body, { error: "Missing bucket, source, or destination" });

  const malformed = await postJson(baseUrl, "/api/move", "}");
  assert.equal(malformed.status, 400);
});

test("operation reads, retry and cancel act on real store state", async (t) => {
  const { baseUrl, store, worker, close } = await startApp();
  t.after(close);

  const first = await postJson(baseUrl, "/api/operations", {
    type: "delete",
    payload: { bucket: "b1", targets: ["a.txt"] },
  });

  const list = await fetch(`${baseUrl}/api/operations`);
  assert.equal(list.status, 200);
  const listed = await list.json();
  assert.equal(listed.operations.length, 1);
  assert.equal(listed.operations[0].id, first.body.id);

  const found = await fetch(`${baseUrl}/api/operations/${first.body.id}`);
  assert.equal(found.status, 200);
  assert.equal((await found.json()).status, "queued");

  const missing = await fetch(`${baseUrl}/api/operations/op_missing`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Operation not found" });

  // Retry is only allowed for failed operations.
  const notFailed = await postJson(baseUrl, `/api/operations/${first.body.id}/retry`, {});
  assert.equal(notFailed.status, 400);
  assert.equal(store.getById(first.body.id).status, "queued");

  await store.markFailed(first.body.id, new Error("boom"));
  const retried = await postJson(baseUrl, `/api/operations/${first.body.id}/retry`, {});
  assert.equal(retried.status, 200);
  assert.equal(retried.body.status, "queued");
  assert.equal(retried.body.error, null, "retry must clear the stored error");
  assert.equal(worker.kicks >= 1, true);

  const cancelled = await postJson(baseUrl, `/api/operations/${first.body.id}/cancel`, {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(store.getById(first.body.id).status, "cancelled");

  const again = await postJson(baseUrl, `/api/operations/${first.body.id}/cancel`, {});
  assert.equal(again.status, 400);
  assert.deepEqual(again.body, { error: "Operation already finished" });

  const cancelMissing = await postJson(baseUrl, "/api/operations/op_missing/cancel", {});
  assert.equal(cancelMissing.status, 404);
  const retryMissing = await postJson(baseUrl, "/api/operations/op_missing/retry", {});
  assert.equal(retryMissing.status, 404);
});

test("download streams bytes with declared, inferred and fallback types", async (t) => {
  const s3ops = makeS3Ops();
  const { baseUrl, close } = await startApp({ s3ops });
  t.after(close);

  s3ops.download = { head: { ContentLength: 5 }, body: Readable.from([Buffer.from("hello")]) };
  const inferred = await fetch(`${baseUrl}/api/download?bucket=b1&key=${encodeURIComponent("qa/note.txt")}`);
  assert.equal(inferred.status, 200);
  assert.equal(inferred.headers.get("content-type"), "text/plain");
  assert.equal(inferred.headers.get("content-length"), "5");
  assert.equal(inferred.headers.get("content-disposition"), "inline; filename=\"note.txt\"");
  assert.equal(await inferred.text(), "hello");
  assert.deepEqual(s3ops.calls.download, [{ bucket: "b1", key: "qa/note.txt" }]);

  s3ops.download = {
    head: { ContentLength: 3, ContentType: "application/x-custom" },
    body: Readable.from([Buffer.from("abc")]),
  };
  const declared = await fetch(`${baseUrl}/api/download?bucket=b1&key=blob.bin`);
  assert.equal(declared.headers.get("content-type"), "application/x-custom");
  assert.equal(await declared.text(), "abc");

  s3ops.download = { head: { ContentLength: 2 }, body: Readable.from([Buffer.from("zz")]) };
  const fallback = await fetch(`${baseUrl}/api/download?bucket=b1&key=archive.unknownext`);
  assert.equal(fallback.headers.get("content-type"), "application/octet-stream");
  assert.equal(await fallback.text(), "zz");

  const noBucket = await fetch(`${baseUrl}/api/download?key=a.txt`);
  assert.equal(noBucket.status, 400);
  assert.deepEqual(await noBucket.json(), { error: "Missing bucket" });

  const noKey = await fetch(`${baseUrl}/api/download?bucket=b1`);
  assert.equal(noKey.status, 400);
  assert.deepEqual(await noKey.json(), { error: "Missing key" });

  s3ops.downloadError = Object.assign(new Error("NotFound"), { name: "NotFound" });
  const failed = await fetch(`${baseUrl}/api/download?bucket=b1&key=missing.txt`);
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: "NotFound" });
});

test("start binds an ephemeral port and shutdown stops the worker once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "s3-browser-shutdown-"));
  const store = new OperationStore(join(dir, "operations.json"));
  const worker = {
    kicks: 0,
    started: 0,
    stopped: 0,
    kick() { this.kicks += 1; },
    start() { this.started += 1; },
    stop() { this.stopped += 1; },
  };

  const app = createAppServer({
    s3ops: makeS3Ops(),
    operationStore: store,
    operationWorker: worker,
    loadIndex: async () => "<html></html>",
    loadAsset: async () => Buffer.from(""),
    host: "127.0.0.1",
    port: 0,
    exit: () => {},
  });

  assert.equal(typeof app.handler, "function");
  const url = await app.start();
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(worker.started, 1);
  assert.equal(store.operations.length, 0, "start initialised an empty store");

  app.shutdown("SIGINT");
  app.shutdown("SIGINT");
  assert.equal(worker.stopped, 1, "shutdown is idempotent");
});

test("the queue file location falls back from LOCALAPPDATA to APPDATA to home", () => {
  const original = { local: process.env.LOCALAPPDATA, app: process.env.APPDATA };
  try {
    process.env.LOCALAPPDATA = join("C:", "local");
    delete process.env.APPDATA;
    assert.equal(resolveStateFilePath(), join("C:", "local", "s3-browser", "operations.json"));

    delete process.env.LOCALAPPDATA;
    process.env.APPDATA = join("C:", "roaming");
    assert.equal(resolveStateFilePath(), join("C:", "roaming", "s3-browser", "operations.json"));

    delete process.env.APPDATA;
    assert.equal(resolveStateFilePath(), join(homedir(), ".s3-browser", "s3-browser", "operations.json"));
  } finally {
    if (original.local === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = original.local;
    if (original.app === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = original.app;
  }
});

test("resolveS3ClientConfig keeps local, profile and Kubernetes credential behaviour", () => {
  const endpoint = resolveS3ClientConfig({ S3_ENDPOINT: "http://localhost:9000", AWS_REGION: "eu-west-1" });
  assert.equal(endpoint.region, "eu-west-1");
  assert.equal(endpoint.endpoint, "http://localhost:9000");
  assert.equal(endpoint.forcePathStyle, true);

  const profile = resolveS3ClientConfig({ AWS_PROFILE: "work" });
  assert.equal(profile.region, "us-east-1");
  assert.equal(typeof profile.credentials, "function");

  const inCluster = resolveS3ClientConfig({ KUBERNETES_SERVICE_HOST: "10.0.0.1" });
  assert.equal(inCluster.credentials, undefined);

  const explicitKeys = resolveS3ClientConfig({ AWS_ACCESS_KEY_ID: "key-id" });
  assert.equal(explicitKeys.credentials, undefined);

  const fallback = resolveS3ClientConfig({});
  assert.equal(typeof fallback.credentials, "function");
});
