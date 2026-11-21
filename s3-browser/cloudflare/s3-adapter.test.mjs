import test from "node:test";
import assert from "node:assert/strict";

import {
  AwsS3WorkerAdapter,
  BudgetExhaustedError,
  SubrequestBudget,
  DELETE_BATCH_SIZE,
} from "./s3-adapter.mjs";

function makeClient(handler) {
  const calls = [];
  return {
    calls,
    async send(command) {
      calls.push(command);
      return handler(command, calls.length);
    },
  };
}

const env = { S3_BROWSER_BUCKET: "test-bucket", AWS_ACCESS_KEY_ID: "key", AWS_SECRET_ACCESS_KEY: "secret" };

test("listBuckets only advertises allowed buckets", async () => {
  const client = makeClient(() => ({
    Buckets: [{ Name: "allowed-bucket", CreationDate: new Date(0) }, { Name: "other-bucket" }],
  }));
  const adapter = new AwsS3WorkerAdapter({ ...env, S3_BROWSER_BUCKET: "allowed-bucket", ALLOWED_BUCKETS: "allowed-bucket" }, { client });

  const buckets = await adapter.listBuckets();

  assert.deepEqual(buckets.map((bucket) => bucket.name), ["allowed-bucket"]);
});

test("listAllKeys returns one page plus a continuation token", async () => {
  const client = makeClient(() => ({
    Contents: [{ Key: "qa/a.txt" }, { Key: "qa/b.txt" }],
    IsTruncated: true,
    NextContinuationToken: "next-1",
  }));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const page = await adapter.listAllKeys({ bucket: "test-bucket", prefix: "qa/" });

  assert.deepEqual(page.keys, ["qa/a.txt", "qa/b.txt"]);
  assert.equal(page.nextToken, "next-1");
  assert.equal(client.calls.length, 1);
});

test("budget exhaustion throws before the S3 request is issued", async () => {
  const client = makeClient(() => ({ Contents: [] }));
  const adapter = new AwsS3WorkerAdapter(env, { client }).withBudget(new SubrequestBudget(1));

  await adapter.listAllKeys({ bucket: "test-bucket", prefix: "qa/" });
  await assert.rejects(() => adapter.listAllKeys({ bucket: "test-bucket", prefix: "qa/" }), BudgetExhaustedError);
  assert.equal(client.calls.length, 1);
});

test("deleteKeysBatch splits large key sets and surfaces per-key errors", async () => {
  const keys = Array.from({ length: DELETE_BATCH_SIZE + 2 }, (_, index) => `qa/f-${index}.txt`);
  const client = makeClient((_command, callIndex) => {
    const batch = _command.input.Delete.Objects;
    return {
      Deleted: batch.filter((item) => item.Key !== "qa/f-1.txt").map((item) => ({ Key: item.Key })),
      Errors: callIndex === 1 ? [{ Key: "qa/f-1.txt", Message: "denied" }] : [],
    };
  });
  const adapter = new AwsS3WorkerAdapter(env, { client });

  const result = await adapter.deleteKeysBatch("test-bucket", keys);

  assert.equal(client.calls.length, 2);
  assert.equal(result.deleted.length, keys.length - 1);
  assert.deepEqual(result.errors, [{ key: "qa/f-1.txt", message: "denied" }]);
});

test("copyKey validates keys before signing a request", async () => {
  const client = makeClient(() => ({}));
  const adapter = new AwsS3WorkerAdapter(env, { client });

  await assert.rejects(() => adapter.copyKey("test-bucket", "qa/../secret", "qa/out.txt"), /Invalid key/);
  assert.equal(client.calls.length, 0);
});
