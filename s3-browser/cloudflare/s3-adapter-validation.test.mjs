import test from "node:test";
import assert from "node:assert/strict";

import {
  AwsS3WorkerAdapter,
  BudgetExhaustedError,
  DELETE_BATCH_SIZE,
  MAX_SUBREQUESTS_PER_INVOCATION,
  SubrequestBudget,
  getDefaultBucket,
  getS3Client,
  normalizeKey,
  parseAllowedBuckets,
  sanitizePrefix,
  validateBucketName,
  validateObjectKey,
} from "./s3-adapter.mjs";

const env = {
  S3_BROWSER_BUCKET: "test-bucket",
  AWS_ACCESS_KEY_ID: "key-id",
  AWS_SECRET_ACCESS_KEY: "secret",
};

function makeClient(handler = () => ({})) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push({ type: command.constructor.name, input: command.input });
      return handler(command, calls.length - 1);
    },
  };
}

test("bucket validation accepts exactly the S3-safe shapes", () => {
  assert.equal(validateBucketName("a"), "a");
  assert.equal(validateBucketName("abc"), "abc");
  assert.equal(validateBucketName("a.b-c9"), "a.b-c9");
  assert.equal(validateBucketName("a23456789012345678901234567890123456789012345678901234567890123"), "a23456789012345678901234567890123456789012345678901234567890123");

  for (const invalid of [null, undefined, 7, "", "ab", " ab", "ab ", "a/b", "a\\b", "A1-b", "a".repeat(64), "a%b"]) {
    assert.throws(() => validateBucketName(invalid), /Invalid bucket/, `${String(invalid)} must be rejected`);
  }
});

test("prefix sanitising normalises separators without allowing traversal", () => {
  assert.equal(sanitizePrefix(null), "");
  assert.equal(sanitizePrefix(""), "");
  assert.equal(sanitizePrefix("///"), "");
  assert.equal(sanitizePrefix("dir"), "dir");
  assert.equal(sanitizePrefix("dir///"), "dir/");
  assert.equal(sanitizePrefix("/music/album/"), "music/album/");
  assert.equal(sanitizePrefix("music\\album\\"), "music/album/");
  assert.equal(sanitizePrefix("."), "");
  assert.throws(() => sanitizePrefix("a/../b"), /Invalid key/);
  assert.throws(() => sanitizePrefix(".."), /Invalid key/);
});

test("key normalising rejects traversal, NUL bytes and empty keys", () => {
  assert.equal(normalizeKey("/artists/track.mp3"), "artists/track.mp3");
  assert.equal(normalizeKey("///a//b"), "a//b");
  assert.equal(normalizeKey("folder\\file.txt"), "folder/file.txt");

  for (const invalid of [null, undefined, "", "///", "a/../b", "a\0b"]) {
    assert.throws(() => normalizeKey(invalid), /Invalid key/, `${String(invalid)} must be rejected`);
  }
});

test("object keys reject duplicate separators that would alias a virtual folder", () => {
  assert.equal(validateObjectKey("folder/file.txt"), "folder/file.txt");
  assert.equal(validateObjectKey("folder/subfolder/"), "folder/subfolder/");
  assert.throws(() => validateObjectKey("folder//file.txt"), /Invalid key/);
  assert.throws(() => validateObjectKey("folder/../file.txt"), /Invalid key/);
});

test("allowlist parsing trims entries, drops blanks and validates each name", () => {
  assert.equal(parseAllowedBuckets(undefined), null);
  assert.equal(parseAllowedBuckets(""), null);
  assert.deepEqual(parseAllowedBuckets(" a , b "), ["a", "b"]);
  assert.deepEqual(parseAllowedBuckets("a,,b"), ["a", "b"]);
  assert.throws(() => parseAllowedBuckets("a,bad/name"), /Invalid bucket/);
});

test("default bucket prefers S3_BROWSER_BUCKET and validates the fallback", () => {
  assert.equal(getDefaultBucket({ S3_BROWSER_BUCKET: "primary" }), "primary");
  assert.equal(getDefaultBucket({ DEFAULT_BUCKET: "fallback" }), "fallback");
  assert.equal(getDefaultBucket({ S3_BROWSER_BUCKET: "primary", DEFAULT_BUCKET: "fallback" }), "primary");
  assert.equal(getDefaultBucket({}), null);
  assert.throws(() => getDefaultBucket({ DEFAULT_BUCKET: "Bad/Name" }), /Invalid bucket/);
});

test("the S3 client requires explicit Worker secrets", () => {
  assert.throws(() => getS3Client({}), /Missing AWS credentials/);
  assert.throws(() => getS3Client({ AWS_ACCESS_KEY_ID: "id" }), /Missing AWS credentials/);
  assert.throws(() => getS3Client({ AWS_SECRET_ACCESS_KEY: "secret" }), /Missing AWS credentials/);

  const client = getS3Client({ ...env, AWS_REGION: "eu-central-1" });
  assert.equal(client.constructor.name, "S3Client");
});

test("bucket resolution enforces the default and the allowlist", () => {
  const client = makeClient();
  assert.throws(() => new AwsS3WorkerAdapter({}, { client }).resolveBucket(""), /Missing bucket/);

  const noAllowlist = new AwsS3WorkerAdapter(env, { client });
  assert.equal(noAllowlist.resolveBucket(""), "test-bucket");
  assert.equal(noAllowlist.resolveBucket("explicit-bucket"), "explicit-bucket");

  const allowlisted = new AwsS3WorkerAdapter({ ...env, ALLOWED_BUCKETS: "test-bucket" }, { client });
  assert.equal(allowlisted.resolveBucket(undefined), "test-bucket");
  assert.throws(() => allowlisted.resolveBucket("other-bucket"), /not allowed for this deployment/);
  assert.throws(() => allowlisted.resolveBucket("Bad/Name"), /Invalid bucket/);
});

test("the subrequest budget refuses work it cannot afford and can be cleared", async () => {
  assert.equal(MAX_SUBREQUESTS_PER_INVOCATION, 30);
  assert.equal(DELETE_BATCH_SIZE, 100);

  const client = makeClient(() => ({}));
  const adapter = new AwsS3WorkerAdapter(env, { client });
  const budget = new SubrequestBudget(2);

  assert.equal(budget.remaining, 2);
  assert.equal(adapter.withBudget(budget), adapter);
  await adapter.send({ constructor: { name: "One" } });
  assert.equal(budget.used, 1);
  assert.equal(budget.remaining, 1);
  assert.equal(budget.take(2), false, "a batch larger than the remainder is refused");
  assert.equal(budget.used, 1);
  await adapter.send({ constructor: { name: "Two" } });
  assert.equal(client.calls.length, 2);
  await assert.rejects(() => adapter.send({ constructor: { name: "Three" } }), BudgetExhaustedError);
  assert.equal(client.calls.length, 2, "no request is issued once the budget is empty");

  assert.equal(adapter.clearBudget(), adapter);
  await adapter.send({ constructor: { name: "Four" } });
  assert.equal(client.calls.length, 3);
});

test("listing maps folders, files and pagination without leaking the prefix marker", async () => {
  const client = makeClient(() => ({
    CommonPrefixes: [{ Prefix: "music/albums/" }],
    Contents: [
      { Key: "music/a.mp3", Size: 5, LastModified: new Date(0) },
      { Key: "music/", Size: 0 },
      { Key: "music/b.mp3" },
    ],
    IsTruncated: true,
    NextContinuationToken: "next-page",
  }));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const page = await adapter.listObjects({
    bucket: "test-bucket",
    prefix: "music/",
    continuationToken: "token-1",
    delimiter: "|",
    maxKeys: 42,
  });

  assert.deepEqual(page.folders, [{ name: "albums", type: "folder", path: "music/albums/" }]);
  assert.deepEqual(page.files, [
    { name: "a.mp3", type: "file", key: "music/a.mp3", size: 5, modified: new Date(0).toISOString() },
    { name: "b.mp3", type: "file", key: "music/b.mp3", size: 0, modified: null },
  ]);
  assert.equal(page.isTruncated, true);
  assert.equal(page.nextContinuationToken, "next-page");
  assert.equal(page.prefix, "music/");
  assert.equal(page.bucket, "test-bucket");

  const input = client.calls[0].input;
  assert.equal(input.Delimiter, "|");
  assert.equal(input.MaxKeys, 42);
  assert.equal(input.ContinuationToken, "token-1");
});

test("key enumeration reports one page at a time", async () => {
  const client = makeClient(() => ({ Contents: [{ Key: "a" }, { Key: undefined }, { Key: "b" }] }));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const page = await adapter.listAllKeys({ bucket: "test-bucket", prefix: "/qa/" });

  assert.deepEqual(page.keys, ["a", "b"]);
  assert.equal(page.nextToken, null);
  assert.equal(client.calls[0].input.Prefix, "qa/", "the prefix is sanitised before the request");
  assert.equal(client.calls[0].input.ContinuationToken, undefined);
});

test("downloads validate the key before issuing either request", async () => {
  const client = makeClient((command) => (
    command.constructor.name === "HeadObjectCommand"
      ? { ContentLength: 3, ContentType: "text/plain" }
      : { Body: "stream" }
  ));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const result = await adapter.getDownloadStream("test-bucket", "/qa/file.txt");
  assert.equal(result.key, "qa/file.txt");
  assert.equal(result.body, "stream");
  assert.deepEqual(client.calls.map((call) => call.type), ["HeadObjectCommand", "GetObjectCommand"]);

  await assert.rejects(() => adapter.getDownloadStream("test-bucket", "qa/../secret"), /Invalid key/);
  assert.equal(client.calls.length, 2);
});

test("headObject distinguishes missing objects from real failures", async () => {
  const found = makeClient(() => ({ ContentLength: 12, ContentType: "text/plain" }));
  assert.deepEqual(
    await new AwsS3WorkerAdapter(env, { client: found }).headObject("test-bucket", "a.txt"),
    { exists: true, size: 12, contentType: "text/plain" },
  );

  const withoutMetadata = makeClient(() => ({}));
  assert.deepEqual(
    await new AwsS3WorkerAdapter(env, { client: withoutMetadata }).headObject("test-bucket", "a.txt"),
    { exists: true, size: null, contentType: null },
  );

  for (const missing of [
    Object.assign(new Error("gone"), { $metadata: { httpStatusCode: 404 } }),
    Object.assign(new Error("gone"), { name: "NotFound" }),
    Object.assign(new Error("gone"), { name: "NoSuchKey" }),
  ]) {
    const client = makeClient(() => { throw missing; });
    assert.deepEqual(
      await new AwsS3WorkerAdapter(env, { client }).headObject("test-bucket", "a.txt"),
      { exists: false, size: null, contentType: null },
    );
  }

  const denied = Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } });
  const deniedClient = makeClient(() => { throw denied; });
  await assert.rejects(
    () => new AwsS3WorkerAdapter(env, { client: deniedClient }).headObject("test-bucket", "a.txt"),
    /denied/,
  );
});

test("copy, delete and upload commands use the validated, encoded shapes", async () => {
  const client = makeClient(() => ({ Deleted: [], Errors: [] }));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  await adapter.copyKey("test-bucket", "/qa/a b.txt", "/qa/out.txt");
  assert.equal(client.calls[0].type, "CopyObjectCommand");
  assert.equal(client.calls[0].input.CopySource, "test-bucket/qa%2Fa%20b.txt");
  assert.equal(client.calls[0].input.Key, "qa/out.txt");

  await assert.rejects(() => adapter.copyKey("test-bucket", "qa/a.txt", "qa/../b"), /Invalid key/);
  assert.equal(client.calls.length, 1);

  assert.deepEqual(await adapter.deleteKeysBatch("test-bucket", []), { deleted: [], errors: [] });
  assert.deepEqual(await adapter.deleteKeysBatch("test-bucket", [null, ""]), { deleted: [], errors: [] });
  assert.equal(client.calls.length, 1, "an empty batch issues no request");

  const uploadClient = makeClient(() => ({}));
  const uploader = new AwsS3WorkerAdapter(env, { client: uploadClient });
  await uploader.uploadObject({ bucket: "test-bucket", key: "qa/a.bin", body: "bytes" });
  assert.equal(uploadClient.calls[0].input.ContentType, "application/octet-stream");
  await uploader.uploadObject({ bucket: "test-bucket", key: "qa/b.txt", body: "bytes", contentType: "text/plain" });
  assert.equal(uploadClient.calls[1].input.ContentType, "text/plain");
  await assert.rejects(
    () => uploader.uploadObject({ bucket: "test-bucket", key: "qa/../b", body: "x" }),
    /Invalid key/,
  );
});

test("delete batches de-duplicate keys and keep per-key errors", async () => {
  const client = makeClient((command) => ({
    Deleted: command.input.Delete.Objects.filter((item) => item.Key !== "b").map((item) => item),
    Errors: command.input.Delete.Objects
      .filter((item) => item.Key === "b")
      .map(() => ({ Key: "b", Code: "AccessDenied" })),
  }));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const result = await adapter.deleteKeysBatch("test-bucket", ["a", "a", "b", null]);

  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].input.Delete.Objects, [{ Key: "a" }, { Key: "b" }]);
  assert.deepEqual(result.deleted, ["a"]);
  assert.deepEqual(result.errors, [{ key: "b", message: "AccessDenied" }]);
});

test("bucket listing filters the allowlist and tolerates missing dates", async () => {
  const client = makeClient(() => ({
    Buckets: [{ Name: "allowed" }, { Name: "other", CreationDate: new Date(0) }],
  }));

  const unfiltered = await new AwsS3WorkerAdapter(env, { client }).listBuckets();
  assert.deepEqual(unfiltered, [
    { name: "allowed", created: null },
    { name: "other", created: new Date(0).toISOString() },
  ]);

  const filtered = await new AwsS3WorkerAdapter({ ...env, ALLOWED_BUCKETS: "allowed" }, { client }).listBuckets();
  assert.deepEqual(filtered, [{ name: "allowed", created: null }]);
});

test("an empty listing response is reported as an empty page", async () => {
  const client = makeClient(() => ({}));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const page = await adapter.listObjects({ bucket: "test-bucket" });
  assert.deepEqual(page.folders, []);
  assert.deepEqual(page.files, []);
  assert.equal(page.isTruncated, false);
  assert.equal(page.nextContinuationToken, null);
});
