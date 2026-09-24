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
  const stripped = raw.replace(/^\/+/, "").replace(/\/+$/g, "/");
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
  constructor(env) {
    this.client = getS3Client(env);
    this.region = env.AWS_REGION || "us-east-1";
    this.defaultBucket = getDefaultBucket(env);
    this.allowedBuckets = parseAllowedBuckets(env.ALLOWED_BUCKETS || env.ALLOWED_BUCKETS_LIST || env.S3_ALLOWED_BUCKETS);
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
    const resp = await this.client.send(new ListBucketsCommand({}));
    return (resp.Buckets || []).map((bucket) => ({
      name: bucket.Name,
      created: bucket.CreationDate ? bucket.CreationDate.toISOString() : null,
    }));
  }

  async listObjects({ bucket, prefix = "", continuationToken, delimiter = "/", maxKeys = 1000 }) {
    const safeBucket = this.resolveBucket(bucket);
    const safePrefix = sanitizePrefix(prefix || "");

    const resp = await this.client.send(new ListObjectsV2Command({
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

  async getDownloadStream(bucket, key) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKey = validateObjectKey(key);

    const head = await this.client.send(new HeadObjectCommand({ Bucket: safeBucket, Key: safeKey }));
    const bodyResponse = await this.client.send(new GetObjectCommand({ Bucket: safeBucket, Key: safeKey }));

    return {
      bucket: safeBucket,
      key: safeKey,
      head,
      body: bodyResponse.Body,
    };
  }

  async copyObject(bucket, sourceKey, destinationKey) {
    const safeBucket = this.resolveBucket(bucket);
    const safeSourceKey = validateObjectKey(sourceKey);
    const safeDestinationKey = validateObjectKey(destinationKey);

    return this.client.send(new CopyObjectCommand({
      Bucket: safeBucket,
      CopySource: `${safeBucket}/${encodeURIComponent(safeSourceKey)}`,
      Key: safeDestinationKey,
    }));
  }

  async deleteKeys(bucket, keys) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKeys = Array.from(new Set(keys.filter(Boolean).map((key) => validateObjectKey(key))));

    if (!safeKeys.length) return { deleted: 0 };

    const batches = [];
    for (let index = 0; index < safeKeys.length; index += 1000) {
      batches.push(safeKeys.slice(index, index + 1000));
    }

    let deleted = 0;
    for (const batch of batches) {
      const resp = await this.client.send(new DeleteObjectsCommand({
        Bucket: safeBucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }));
      deleted += (resp.Deleted || []).length;
    }

    return { deleted };
  }

  async renameTarget({ bucket, source, newName }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeSource = validateObjectKey(source);
    const safeNewName = validateObjectKey(newName);

    const parent = safeSource.includes("/") ? safeSource.slice(0, safeSource.lastIndexOf("/") + 1) : "";
    const destinationKey = `${parent}${safeNewName.split("/").pop()}`;

    await this.copyObject(safeBucket, safeSource, destinationKey);
    await this.deleteKeys(safeBucket, [safeSource]);

    return { renamed: 1, source: safeSource, destination: destinationKey };
  }

  async moveTargets({ bucket, sources, destination, onProgress, shouldCancel }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeSources = [...new Set((sources || []).map((source) => validateObjectKey(source)))];
    const safeDestination = sanitizePrefix(destination || "");

    let completed = 0;
    for (const source of safeSources) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw Object.assign(new Error("Operation cancelled"), { name: "OperationCancelledError" });
      }

      const fileName = source.split("/").pop() || "";
      const destKey = safeDestination ? `${safeDestination}${fileName}` : fileName;

      await this.copyObject(safeBucket, source, destKey);
      await this.deleteKeys(safeBucket, [source]);
      completed += 1;
      if (typeof onProgress === "function") {
        onProgress({ total: safeSources.length, completed, message: `Moving ${fileName}` });
      }
    }

    return { moved: completed };
  }

  async copyTargets({ bucket, sources, destination, onProgress, shouldCancel }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeSources = [...new Set((sources || []).map((source) => validateObjectKey(source)))];
    const safeDestination = sanitizePrefix(destination || "");

    let completed = 0;
    for (const source of safeSources) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw Object.assign(new Error("Operation cancelled"), { name: "OperationCancelledError" });
      }

      const fileName = source.split("/").pop() || "";
      const destKey = safeDestination ? `${safeDestination}${fileName}` : fileName;
      await this.copyObject(safeBucket, source, destKey);
      completed += 1;
      if (typeof onProgress === "function") {
        onProgress({ total: safeSources.length, completed, message: `Copying ${fileName}` });
      }
    }

    return { copied: completed };
  }

  async deleteTargets({ bucket, targets, onProgress, shouldCancel }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeTargets = [...new Set((targets || []).map((target) => validateObjectKey(target)))];

    let completed = 0;
    for (const target of safeTargets) {
      if (typeof shouldCancel === "function" && shouldCancel()) {
        throw Object.assign(new Error("Operation cancelled"), { name: "OperationCancelledError" });
      }

      await this.deleteKeys(safeBucket, [target]);
      completed += 1;
      if (typeof onProgress === "function") {
        onProgress({ total: safeTargets.length, completed, message: `Deleting ${target}` });
      }
    }

    return { deleted: completed };
  }

  async uploadObject({ bucket, key, body, contentType }) {
    const safeBucket = this.resolveBucket(bucket);
    const safeKey = validateObjectKey(key);

    await this.client.send(new PutObjectCommand({
      Bucket: safeBucket,
      Key: safeKey,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    }));

    return { bucket: safeBucket, key: safeKey, uploaded: true };
  }
}
