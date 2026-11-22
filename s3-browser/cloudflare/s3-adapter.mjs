import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

// Workers Free allows 50 subrequests per invocation. Operations keep a lower
// ceiling so pagination and retries never push a request over the platform limit.
export const MAX_SUBREQUESTS_PER_INVOCATION = 30;
export const DELETE_BATCH_SIZE = 100;

export class BudgetExhaustedError extends Error {
  constructor() {
    super("Subrequest budget exhausted");
    this.name = "BudgetExhaustedError";
  }
}

export class SubrequestBudget {
  constructor(limit = MAX_SUBREQUESTS_PER_INVOCATION) {
    this.limit = limit;
    this.used = 0;
  }

  get remaining() {
    return Math.max(0, this.limit - this.used);
  }

  take(count = 1) {
    if (this.used + count > this.limit) return false;
    this.used += count;
    return true;
  }
}

export function validateBucketName(value) {
  if (typeof value !== "string") {
    throw new Error("Invalid bucket: bucket must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed !== value || trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid bucket: ${value}`);
  }

  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(trimmed) && !/^[a-z0-9]$/.test(trimmed)) {
    throw new Error(`Invalid bucket: ${value}`);
  }

  return trimmed;
}

export function sanitizePrefix(value) {
  if (value == null || value === "") return "";
  const raw = String(value).replace(/\\/g, "/");

  let start = 0;
  while (start < raw.length && raw.charCodeAt(start) === 47) start += 1;

  let end = raw.length;
  while (end > start && raw.charCodeAt(end - 1) === 47) end -= 1;

  const hadTrailingSlash = end < raw.length;
  const trimmed = raw.slice(start, end);
  const stripped = hadTrailingSlash && trimmed ? `${trimmed}/` : trimmed;
  if (stripped.includes("..")) {
    throw new Error(`Invalid key: ${value}`);
  }
  if (stripped === ".") return "";
  return stripped;
}

export function normalizeKey(value) {
  if (value == null) {
    throw new Error("Invalid key: missing value");
  }

  const normalized = String(value).replace(/\\/g, "/");
  if (normalized.includes("..")) {
    throw new Error(`Invalid key: ${value}`);
  }

  const withoutLeadingSlash = normalized.replace(/^\/+/, "");
  if (!withoutLeadingSlash || withoutLeadingSlash.includes("\0")) {
    throw new Error(`Invalid key: ${value}`);
  }

  return withoutLeadingSlash;
}

export function validateObjectKey(value) {
  const key = normalizeKey(value);
  if (key.startsWith("/") || key.includes("//")) {
    throw new Error(`Invalid key: ${value}`);
  }
  return key;
}

export function parseAllowedBuckets(envValue) {
  if (!envValue) return null;
  return envValue
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => validateBucketName(name));
}

export function getDefaultBucket(env) {
  if (env.S3_BROWSER_BUCKET) return validateBucketName(env.S3_BROWSER_BUCKET);
  if (env.DEFAULT_BUCKET) return validateBucketName(env.DEFAULT_BUCKET);
  return null;
}

export function getS3Client(env) {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  const region = env.AWS_REGION || "us-east-1";

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Missing AWS credentials. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY as Worker secrets.");
  }

  return new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

export class AwsS3WorkerAdapter {
  constructor(env, options = {}) {
    this.client = options.client || getS3Client(env);
    this.region = env.AWS_REGION || "us-east-1";
    this.defaultBucket = getDefaultBucket(env);
    this.allowedBuckets = parseAllowedBuckets(env.ALLOWED_BUCKETS || env.ALLOWED_BUCKETS_LIST || env.S3_ALLOWED_BUCKETS);
    this.budget = null;
  }

  // Each invocation installs a fresh budget; every S3 call spends from it and
  // throws BudgetExhaustedError before issuing a request it cannot afford.
  withBudget(budget) {
    this.budget = budget;
    return this;
  }

  clearBudget() {
    this.budget = null;
    return this;
  }

  async send(command, cost = 1) {
    if (this.budget && !this.budget.take(cost)) {
      throw new BudgetExhaustedError();
    }
    return this.client.send(command);
  }

  resolveBucket(bucket) {
    const requested = bucket || this.defaultBucket;
    if (!requested) {
      throw new Error("Missing bucket. Set S3_BROWSER_BUCKET or pass ?bucket=...");
    }

    const safeBucket = validateBucketName(requested);
    if (this.allowedBuckets && !this.allowedBuckets.includes(safeBucket)) {
      throw new Error(`Bucket ${safeBucket} is not allowed for this deployment.`);
    }

    return safeBucket;
  }

  async listBuckets() {
    const resp = await this.send(new ListBucketsCommand({}));
    const buckets = (resp.Buckets || []).map((bucket) => ({
      name: bucket.Name,
      created: bucket.CreationDate ? bucket.CreationDate.toISOString() : null,
    }));

    // Never advertise buckets this deployment would refuse to open.
    if (this.allowedBuckets) {
      return buckets.filter((bucket) => this.allowedBuckets.includes(bucket.name));
    }
    return buckets;
  }

  async listObjects({ bucket, prefix = "", continuationToken, delimiter = "/", maxKeys = 1000 }) {
    const safeBucket = this.resolveBucket(bucket);
    const safePrefix = sanitizePrefix(prefix || "");

    const resp = await this.send(new ListObjectsV2Command({
      Bucket: safeBucket,
      Prefix: safePrefix,
      Delimiter: delimiter,
      ContinuationToken: continuationToken || undefined,
      MaxKeys: maxKeys,
    }));

    return {
      folders: (resp.CommonPrefixes || []).map((item) => ({
        name: item.Prefix.replace(safePrefix, "").replace(/\/$/, ""),
        type: "folder",
        path: item.Prefix,
      })),
      files: (resp.Contents || [])
        .filter((obj) => obj.Key !== safePrefix)
        .map((obj) => ({
          name: obj.Key.split("/").pop(),
          type: "file",
          key: obj.Key,
          size: obj.Size ?? 0,
          modified: obj.LastModified ? obj.LastModified.toISOString() : null,
        })),
      isTruncated: !!resp.IsTruncated,
      nextContinuationToken: resp.NextContinuationToken || null,
      prefix: safePrefix,
      bucket: safeBucket,
    };
  }

  // One page per call so a folder of any size can be enumerated across batches.
  async listAllKeys({ bucket, prefix = "", continuationToken }) {
    const safeBucket = this.resolveBucket(bucket);
    const safePrefix = sanitizePrefix(prefix || "");

    const resp = await this.send(new ListObjectsV2Command({
      Bucket: safeBucket,
      Prefix: safePrefix,
      ContinuationToken: continuationToken || undefined,
      MaxKeys: 1000,
    }));

    return {
      keys: (resp.Contents || []).map((obj) => obj.Key).filter(Boolean),
      nextToken: resp.IsTruncated ? resp.NextContinuationToken || null : null,
    };
  }

  async getDownloadStream(bucket, key) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKey = validateObjectKey(key);

    const head = await this.send(new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }));
    const bodyResponse = await this.send(new GetObjectCommand({ Bucket: safeBucket, Key: safeKey }));

    return {
      bucket: safeBucket,
      key: safeKey,
      head,
      body: bodyResponse.Body,
    };
  }

  async headObject(bucket, key) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKey = validateObjectKey(key);

    try {
      const head = await this.send(new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }));
      return { exists: true, size: head.ContentLength ?? null, contentType: head.ContentType || null };
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      if (status === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") {
        return { exists: false, size: null, contentType: null };
      }
      throw error;
    }
  }

  async copyKey(bucket, sourceKey, destinationKey) {
    const safeBucket = this.resolveBucket(bucket);
    const safeSourceKey = validateObjectKey(sourceKey);
    const safeDestinationKey = validateObjectKey(destinationKey);

    return this.send(new CopyObjectCommand({
      Bucket: safeBucket,
      CopySource: `${safeBucket}/${encodeURIComponent(safeSourceKey)}`,
      Key: safeDestinationKey,
    }));
  }

  // DeleteObjects accepts up to 1000 keys per request; batches keep the
  // per-invocation subrequest cost proportional to pages, not objects.
  async deleteKeysBatch(bucket, keys) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKeys = Array.from(new Set((keys || []).filter(Boolean).map((key) => validateObjectKey(key))));

    if (!safeKeys.length) return { deleted: [], errors: [] };

    const deleted = [];
    const errors = [];

    for (let index = 0; index < safeKeys.length; index += DELETE_BATCH_SIZE) {
      const batch = safeKeys.slice(index, index + DELETE_BATCH_SIZE);
      const resp = await this.send(new DeleteObjectsCommand({
        Bucket: safeBucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
      }));

      for (const item of resp.Deleted || []) {
        if (item.Key) deleted.push(item.Key);
      }
      for (const item of resp.Errors || []) {
        errors.push({ key: item.Key, message: item.Message || item.Code || "Delete failed" });
      }
    }

    return { deleted, errors };
  }

  async uploadObject({ bucket, key, body, contentType }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKey = validateObjectKey(key);

    await this.send(new PutObjectCommand({
      Bucket: safeBucket,
      Key: safeKey,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    }));

    return { bucket: safeBucket, key: safeKey, uploaded: true };
  }
}
