import {
  AwsS3WorkerAdapter,
  BudgetExhaustedError,
  MAX_SUBREQUESTS_PER_INVOCATION,
  SubrequestBudget,
} from "./s3-adapter.mjs";
import { authenticate } from "./auth.mjs";

const operationMap = new Map();
const TERMINAL_STATUSES = new Set(["completed", "completed_with_errors", "failed", "cancelled"]);

// Hard ceiling for one operation. The real limit is the per-invocation
// subrequest budget; this only stops a single prefix from growing unbounded.
const MAX_PLAN_KEYS = 5000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_RETAINED_OPERATIONS = 50;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function configuredOrigins(env) {
  return (env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// An unset or empty ALLOWED_ORIGINS denies cross-origin use. CORS is not
// authentication; it only decides which browser origins may read responses.
function resolveAllowedOrigin(origin, env) {
  if (!origin) return null;
  const allowed = configuredOrigins(env);
  if (!allowed.length) return null;
  return allowed.includes(origin) ? origin : null;
}

function withCors(request, env, response) {
  const headers = new Headers(response.headers);
  headers.append("Vary", "Origin");

  const allowedOrigin = resolveAllowedOrigin(request.headers.get("Origin"), env);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(request, env) {
  const headers = new Headers({
    Vary: "Origin",
    "Cache-Control": "no-store",
  });

  const allowedOrigin = resolveAllowedOrigin(request.headers.get("Origin"), env);
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", "600");
  }

  return new Response(null, { status: 204, headers });
}

function describeFailure(error) {
  const clip = (value) => (typeof value === "string" ? value.slice(0, 1000) : undefined);

  if (!(error instanceof Error)) {
    return { name: "unknown error", message: clip(String(error)) || "unknown error" };
  }

  const details = {
    name: clip(error.name) || "Error",
    message: clip(error.message) || "(empty message)",
  };

  // AWS SDK errors carry $metadata; plain errors and unexpected shapes must not throw here.
  const metadata = error.$metadata && typeof error.$metadata === "object" ? error.$metadata : null;
  if (Number.isInteger(metadata?.httpStatusCode)) {
    details.httpStatusCode = metadata.httpStatusCode;
  }

  // S3 service errors commonly put the code in `name` (e.g. NoSuchKey) and sometimes `Code`.
  const code = clip(error.Code) || clip(error.code);
  if (code) details.code = code;
  if (error.$fault === "client" || error.$fault === "server") details.fault = error.$fault;
  const requestId = clip(metadata?.requestId);
  if (requestId) details.requestId = requestId;

  return details;
}

function errorResponse(error) {
  const message = error instanceof Error ? error.message : "";

  if (/^(Invalid bucket|Invalid key|Missing bucket|Missing bucket,)/.test(message)) {
    return json({ error: message }, 400);
  }
  if (/^Bucket .* is not allowed/.test(message)) {
    return json({ error: message }, 400);
  }
  if (/^Invalid operation|^Operation exceeds|^Destination /.test(message)) {
    return json({ error: message }, 400);
  }
  if (/^Missing AWS credentials/.test(message)) {
    return json({ error: "Object storage is not configured" }, 503);
  }
  if (error?.name === "PayloadTooLargeError") {
    return json({ error: message }, 413);
  }

  // Unknown failures keep an opaque client body, but the logs must identify them:
  // record the message plus the SDK's HTTP status and service error code when present.
  console.error("s3-browser request failed:", JSON.stringify(describeFailure(error)));
  return json({ error: "Request failed" }, 500);
}

async function readJsonBody(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function isFolderKey(key) {
  return typeof key === "string" && key.endsWith("/");
}

function ensureFolderPrefix(value) {
  const raw = String(value || "").replace(/\\/g, "/");
  if (!raw) return "";
  const withoutLeading = raw.replace(/^\/+/, "");
  return withoutLeading.endsWith("/") ? withoutLeading : `${withoutLeading}/`;
}

function objectNameFromKey(key) {
  return key.split("/").pop();
}

/* ------------------------------------------------------------------ *
 * Operation planning
 *
 * A plan is a flat list of tasks. Building it may page through folder
 * prefixes; executing it spends at most one subrequest budget per advance()
 * call. Both phases resume from stored state, so no invocation is asked to
 * finish an arbitrarily large operation.
 * ------------------------------------------------------------------ */

function pushTask(op, task) {
  op.plan.push(task);
  if (op.plan.length > MAX_PLAN_KEYS) {
    throw new Error(`Operation exceeds ${MAX_PLAN_KEYS} objects; split it into smaller operations.`);
  }
}

function taskForKey(kind, key, { sourcePrefix, destinationPrefix, newName } = {}) {
  if (kind === "delete") return { kind: "delete", key };

  if (kind === "rename") {
    const parent = key.includes("/") ? key.slice(0, key.lastIndexOf("/") + 1) : "";
    const target = isFolderKey(key) ? `${parent}${newName}/` : `${parent}${newName}`;
    return { kind: "move", sourceKey: key, destKey: target, copied: false };
  }

  // Children keep their path relative to the source prefix, so a copied or moved
  // tree is reproduced instead of flattened into the destination.
  const relative = sourcePrefix && key.startsWith(sourcePrefix) ? key.slice(sourcePrefix.length) : objectNameFromKey(key);
  return {
    kind: kind === "move" ? "move" : "copy",
    sourceKey: key,
    destKey: `${destinationPrefix}${relative}`,
    copied: false,
  };
}

async function buildPlan(op, adapter) {
  while (true) {
    if (!op.listing) {
      const next = op.expandQueue.shift();
      if (!next) {
        op.planComplete = true;
        return;
      }
      if (next.kind === "key") {
        pushTask(op, next.task);
        continue;
      }
      op.listing = { prefix: next.prefix, token: null, descriptor: next.descriptor };
    }

    const previousToken = op.listing.token;
    const page = await adapter.listAllKeys({
      bucket: op.bucket,
      prefix: op.listing.prefix,
      continuationToken: op.listing.token,
    });

    const descriptor = op.listing.descriptor;
    for (const key of page.keys) {
      if (descriptor.skipKey && descriptor.skipKey(key)) continue;
      pushTask(op, taskForKey(descriptor.kind, key, descriptor));
    }

    op.listing.token = page.nextToken;
    if (op.listing.token && op.listing.token === previousToken) {
      throw new Error("Storage listing did not advance; retry the operation.");
    }
    if (!op.listing.token) op.listing = null;
  }
}

function collectDeleteGroup(op) {
  const group = [];
  let index = op.cursor;
  while (index < op.plan.length && op.plan[index].kind === "delete" && group.length < 100) {
    group.push(op.plan[index]);
    index += 1;
  }
  return group;
}

async function runBatch(op, adapter) {
  await buildPlan(op, adapter);

  while (op.cursor < op.plan.length) {
    if (op.cancelRequested) return;

    const task = op.plan[op.cursor];

    if (task.kind === "delete") {
      const group = collectDeleteGroup(op);
      const response = await adapter.deleteKeysBatch(op.bucket, group.map((item) => item.key));
      const errors = new Map((response.errors || []).map((item) => [item.key, item.message]));

      for (const item of group) {
        if (errors.has(item.key)) {
          op.failed.push({ key: item.key, message: errors.get(item.key), stage: "delete", task: { kind: "delete", key: item.key } });
        } else {
          op.deleted += 1;
          op.completed += 1;
        }
      }
      op.cursor += group.length;
      continue;
    }

    if (task.kind === "copy") {
      await adapter.copyKey(op.bucket, task.sourceKey, task.destKey);
      op.copied += 1;
      op.completed += 1;
      op.cursor += 1;
      continue;
    }

    // move: copy and delete are accounted separately so a failed delete can
    // never be reported as a clean move.
    if (!task.copied) {
      await adapter.copyKey(op.bucket, task.sourceKey, task.destKey);
      task.copied = true;
      op.copied += 1;
    }

    const response = await adapter.deleteKeysBatch(op.bucket, [task.sourceKey]);
    const deleteError = (response.errors || []).find((item) => item.key === task.sourceKey);
    if (deleteError) {
      op.failed.push({
        key: task.sourceKey,
        message: deleteError.message,
        stage: "delete",
        copiedTo: task.destKey,
        task: { kind: "delete", key: task.sourceKey },
      });
    } else {
      op.deleted += 1;
      op.completed += 1;
    }
    op.cursor += 1;
  }
}

function remainingKeys(op) {
  return op.plan.slice(op.cursor).map((task) => task.sourceKey || task.key).slice(0, 200);
}

function hasRemaining(op) {
  return op.cursor < op.plan.length || !op.planComplete;
}

function refreshResult(op) {
  op.updatedAt = new Date().toISOString();
  const total = op.planComplete ? op.plan.length : null;
  op.progress = {
    total,
    completed: op.completed,
    failed: op.failed.length,
    message: op.status === "cancelling" ? "Cancelling" : op.paused ? "Paused (continues on next poll)" : "Working",
  };
  op.result = {
    status: op.status,
    total,
    completed: op.completed,
    copied: op.copied,
    deleted: op.deleted,
    failed: op.failed,
    skipped: op.skipped,
    // The key list is capped for response size; the count stays exact so a
    // paused or cancelled run cannot look finished.
    remaining: remainingKeys(op),
    remainingCount: op.planComplete ? Math.max(0, op.plan.length - op.cursor) : null,
    deleteFailed: op.failed.filter((item) => item.stage === "delete").map((item) => item.key),
    cancellationRequested: op.cancelRequested,
  };
}

function finalize(op) {
  if (op.cancelRequested) {
    op.status = "cancelled";
  } else if (op.failed.length && op.completed > 0) {
    op.status = "completed_with_errors";
  } else if (op.failed.length) {
    op.status = "failed";
  } else {
    op.status = "completed";
  }
  op.finishedAt = new Date().toISOString();
  op.paused = false;
  refreshResult(op);
}

async function advanceOperation(op, adapter) {
  if (op.batchInFlight) return { advanced: false, reason: "batch-in-flight" };
  if (TERMINAL_STATUSES.has(op.status)) return { advanced: false, reason: "finished" };

  if (op.cancelRequested) {
    finalize(op);
    return { advanced: false, reason: "cancelled" };
  }

  op.batchInFlight = true;
  op.paused = false;
  op.status = "running";
  op.startedAt = op.startedAt || new Date().toISOString();

  const budget = new SubrequestBudget(MAX_SUBREQUESTS_PER_INVOCATION);
  adapter.withBudget(budget);

  try {
    await runBatch(op, adapter);
  } catch (error) {
    if (error instanceof BudgetExhaustedError) {
      op.paused = true;
    } else {
      op.failure = describeFailure(error);
      console.error("s3-browser operation failed:", JSON.stringify(op.failure));
      // Client-facing text stays short and never carries signature scopes.
      op.error = error instanceof Error
        ? `${error.name}: ${String(error.message).slice(0, 200)}`.replace(/Credential=[^,\s]+/g, "Credential=<redacted>")
        : "Operation failed";
      op.status = "failed";
      op.finishedAt = new Date().toISOString();
      op.paused = false;
      adapter.clearBudget();
      op.batchInFlight = false;
      refreshResult(op);
      return { advanced: false, reason: "error", error: op.failure };
    }
  } finally {
    adapter.clearBudget();
    op.batchInFlight = false;
  }

  if (op.cancelRequested) {
    finalize(op);
  } else if (!hasRemaining(op)) {
    finalize(op);
  } else {
    op.status = "running";
    op.paused = true;
    refreshResult(op);
  }

  return { advanced: true, status: op.status };
}

/* ------------------------------------------------------------------ *
 * Operation records
 * ------------------------------------------------------------------ */

function trimOperations() {
  if (operationMap.size <= MAX_RETAINED_OPERATIONS) return;
  const finished = [...operationMap.values()]
    .filter((op) => TERMINAL_STATUSES.has(op.status))
    .sort((a, b) => new Date(a.updatedAt) - new Date(b.updatedAt));
  while (operationMap.size > MAX_RETAINED_OPERATIONS && finished.length) {
    operationMap.delete(finished.shift().id);
  }
}

function createOperation({ type, payload, bucket, expandQueue, plan = [], planComplete = false, retryOf = null }) {
  const op = {
    id: crypto.randomUUID(),
    type,
    payload,
    bucket,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    expandQueue,
    listing: null,
    plan,
    planComplete,
    cursor: 0,
    copied: 0,
    deleted: 0,
    completed: 0,
    failed: [],
    skipped: [],
    cancelRequested: false,
    batchInFlight: false,
    paused: false,
    retryOf,
    progress: { total: planComplete ? plan.length : null, completed: 0, failed: 0, message: "Queued" },
    result: null,
  };
  operationMap.set(op.id, op);
  trimOperations();
  return op;
}

function summarizeOperation(op) {
  return {
    id: op.id,
    type: op.type,
    status: op.status,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    startedAt: op.startedAt,
    finishedAt: op.finishedAt,
    progress: op.progress,
    result: op.result,
    error: op.error,
    failure: op.failure,
    retryOf: op.retryOf,
    payload: op.payload,
  };
}

function listOperations() {
  return [...operationMap.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, MAX_RETAINED_OPERATIONS)
    .map(summarizeOperation);
}

/* ------------------------------------------------------------------ *
 * Request validation
 * ------------------------------------------------------------------ */

function assertNotInsideSource(sourcePrefix, destinationPrefix) {
  if (destinationPrefix.startsWith(sourcePrefix)) {
    throw new Error("Destination is inside the source folder.");
  }
}

function buildExpandQueue(type, payload) {
  const bucket = validateBucketForOp(payload.bucket);
  const normalizeName = (name) => {
    const raw = String(name || "").trim();
    if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
      throw new Error(`Invalid operation: invalid name "${name}"`);
    }
    return raw;
  };

  if (type === "delete") {
    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    if (!targets.length) throw new Error("Invalid operation: missing targets");
    return {
      bucket,
      queue: targets.map((target) =>
        isFolderKey(target)
          ? { kind: "prefix", prefix: target, descriptor: { kind: "delete" } }
          : { kind: "key", task: { kind: "delete", key: target } },
      ),
    };
  }

  if (type === "rename") {
    if (!payload.source || !payload.newName) throw new Error("Invalid operation: missing source or new name");
    const newName = normalizeName(payload.newName);
    const source = payload.source;
    if (isFolderKey(source)) {
      const parent = source.slice(0, source.lastIndexOf("/", source.length - 2) + 1);
      const destinationPrefix = `${parent}${newName}/`;
      assertNotInsideSource(source, destinationPrefix);
      // Renaming a folder is a prefix rewrite: copy each child, then delete the source.
      return {
        bucket,
        queue: [{
          kind: "prefix",
          prefix: source,
          descriptor: {
            kind: "move",
            sourcePrefix: source,
            destinationPrefix,
            skipKey: (key) => key === source,
          },
        }],
      };
    }
    return {
      bucket,
      queue: [{ kind: "key", task: taskForKey("rename", source, { newName }) }],
    };
  }

  // copy / move
  const sources = Array.isArray(payload.sources) ? payload.sources : [];
  const destination = ensureFolderPrefix(payload.destination || "");
  if (!sources.length) throw new Error("Invalid operation: missing sources");

  const queue = sources.map((source) => {
    if (isFolderKey(source)) {
      // A folder keeps its own name under the destination, like any file manager.
      const folderName = source.slice(source.lastIndexOf("/", source.length - 2) + 1, source.length - 1);
      const destinationPrefix = `${destination}${folderName}/`;
      assertNotInsideSource(source, destinationPrefix);
      return {
        kind: "prefix",
        prefix: source,
        descriptor: {
          kind: type === "move" ? "move" : "copy",
          sourcePrefix: source,
          destinationPrefix,
          skipKey: (key) => key === source,
        },
      };
    }
    return {
      kind: "key",
      task: {
        kind: type === "move" ? "move" : "copy",
        sourceKey: source,
        destKey: `${destination}${objectNameFromKey(source)}`,
        copied: false,
      },
    };
  });

  return { bucket, queue };
}

function validateBucketForOp(bucket) {
  if (!bucket || typeof bucket !== "string") {
    throw new Error("Missing bucket.");
  }
  return bucket;
}

/* ------------------------------------------------------------------ *
 * HTTP handlers
 * ------------------------------------------------------------------ */

async function handleApi(request, env, ctx, path, url, createAdapter) {
  let adapter = null;
  const getAdapter = () => {
    if (!adapter) adapter = createAdapter(env);
    return adapter;
  };

  if (path === "/api/buckets" && request.method === "GET") {
    const buckets = await getAdapter().listBuckets();
    return json(buckets);
  }

  const bucketObjectsMatch = path.match(/^\/api\/buckets\/([^/]+)\/objects$/);
  if (bucketObjectsMatch && request.method === "GET") {
    const bucket = decodeURIComponent(bucketObjectsMatch[1]);
    const prefix = url.searchParams.get("prefix") || "";
    const continuationToken = url.searchParams.get("continuationToken") || undefined;
    const delimiter = url.searchParams.get("delimiter") || "/";
    const data = await getAdapter().listObjects({
      bucket,
      prefix,
      continuationToken,
      delimiter,
      maxKeys: 1000,
    });
    return json(data);
  }

  if (path === "/api/download" && request.method === "GET") {
    const bucket = url.searchParams.get("bucket");
    const key = url.searchParams.get("key");
    if (!bucket || !key) {
      return json({ error: "Missing bucket or key" }, 400);
    }

    const { head, body, key: safeKey } = await getAdapter().getDownloadStream(bucket, key);
    const fileName = safeKey.split("/").pop() || "download";
    const ext = fileName.split(".").pop()?.toLowerCase() || "";
    const contentTypeMap = {
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      json: "application/json",
      csv: "text/csv",
      txt: "text/plain",
      zip: "application/zip",
      gz: "application/gzip",
    };

    // The AWS SDK returns a Node-style stream under nodejs_compat. Workers needs
    // a web ReadableStream, and the runtime sets the length itself.
    const stream = typeof body?.transformToWebStream === "function" ? body.transformToWebStream() : body;

    // Header values must be byte strings, so non-ASCII names go in the RFC 5987
    // parameter and the plain filename gets an ASCII fallback.
    const asciiFileName = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encodedFileName = encodeURIComponent(fileName).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

    return new Response(stream, {
      headers: {
        "Content-Type": head.ContentType || contentTypeMap[ext] || "application/octet-stream",
        "Content-Disposition": `inline; filename="${asciiFileName}"; filename*=UTF-8''${encodedFileName}`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  // Lets the UI verify the real outcome of an aborted upload instead of
  // claiming a cancel that may have raced a completed write.
  if (path === "/api/object" && request.method === "GET") {
    const bucket = url.searchParams.get("bucket");
    const key = url.searchParams.get("key");
    if (!bucket || !key) {
      return json({ error: "Missing bucket or key" }, 400);
    }
    return json(await getAdapter().headObject(bucket, key));
  }

  if (path === "/api/upload" && request.method === "PUT") {
    const bucket = url.searchParams.get("bucket");
    const key = url.searchParams.get("key");
    if (!bucket || !key) {
      return json({ error: "Missing bucket or key" }, 400);
    }

    const declaredLength = Number(request.headers.get("Content-Length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      return json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit` }, 413);
    }

    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_UPLOAD_BYTES) {
      return json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit` }, 413);
    }

    const contentType = url.searchParams.get("contentType") || request.headers.get("Content-Type") || "application/octet-stream";
    const reply = await getAdapter().uploadObject({
      bucket,
      key: decodeURIComponent(key),
      body,
      contentType,
    });

    return json(reply, 200);
  }

  if (path === "/api/upload" && request.method === "POST") {
    const formData = await request.formData();
    const bucket = formData.get("bucket");
    const key = formData.get("key") || formData.get("path") || formData.get("fileName");
    const file = formData.get("file") || formData.get("upload") || formData.get("blob");

    if (!bucket || !key || !(file instanceof File)) {
      return json({ error: "Missing bucket, key, or file upload" }, 400);
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return json({ error: `File is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB upload limit` }, 413);
    }

    const reply = await getAdapter().uploadObject({
      bucket: String(bucket),
      key: String(key),
      body: await file.arrayBuffer(),
      contentType: file.type || "application/octet-stream",
    });

    return json(reply, 200);
  }

  if (path === "/api/operations" && request.method === "GET") {
    return json({ operations: listOperations() });
  }

  if (path === "/api/operations" && request.method === "POST") {
    let payload;
    try {
      payload = await readJsonBody(request);
    } catch (error) {
      return json({ error: error.message }, 400);
    }

    const { type, payload: opPayload } = payload || {};
    if (!type || !opPayload || typeof opPayload !== "object") {
      return json({ error: "Invalid operation payload" }, 400);
    }

    const validTypes = new Set(["move", "copy", "delete", "rename"]);
    if (!validTypes.has(type)) {
      return json({ error: `Invalid operation type: ${type}` }, 400);
    }

    let spec;
    try {
      spec = buildExpandQueue(type, opPayload);
    } catch (error) {
      return json({ error: error.message }, 400);
    }

    const operation = createOperation({
      type,
      payload: opPayload,
      bucket: spec.bucket,
      expandQueue: spec.queue,
    });

    await advanceOperation(operation, getAdapter());
    return json(summarizeOperation(operation), 202);
  }

  const operationPathMatch = path.match(/^\/api\/operations\/([^/]+)$/);
  if (operationPathMatch && request.method === "GET") {
    const op = operationMap.get(decodeURIComponent(operationPathMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    return json(summarizeOperation(op));
  }

  const advanceOperationMatch = path.match(/^\/api\/operations\/([^/]+)\/advance$/);
  if (advanceOperationMatch && request.method === "POST") {
    const op = operationMap.get(decodeURIComponent(advanceOperationMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    if (op.batchInFlight) {
      return json({ error: "A batch is already running for this operation", operation: summarizeOperation(op) }, 409);
    }

    await advanceOperation(op, getAdapter());
    return json(summarizeOperation(op));
  }

  if (path === "/api/move" && request.method === "POST") {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      return json({ error: error.message }, 400);
    }

    if (!body.bucket || !Array.isArray(body.sources) || !body.destination) {
      return json({ error: "Missing bucket, sources, or destination" }, 400);
    }

    let spec;
    try {
      spec = buildExpandQueue("move", body);
    } catch (error) {
      return json({ error: error.message }, 400);
    }

    const operation = createOperation({
      type: "move",
      payload: body,
      bucket: spec.bucket,
      expandQueue: spec.queue,
    });

    await advanceOperation(operation, getAdapter());
    return json(summarizeOperation(operation), 202);
  }

  const retryOperationMatch = path.match(/^\/api\/operations\/([^/]+)\/retry$/);
  if (retryOperationMatch && request.method === "POST") {
    const op = operationMap.get(decodeURIComponent(retryOperationMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    if (!TERMINAL_STATUSES.has(op.status)) {
      return json({ error: "Only finished operations may be retried" }, 400);
    }
    if (!op.failed.length) {
      return json({ error: "Operation has no failed items to retry" }, 400);
    }

    // Retry only the failed keys, so already completed work is never repeated.
    const plan = op.failed
      .map((item) => item.task || { kind: "delete", key: item.key })
      .map((task) => ({ ...task, copied: false }));

    const retried = createOperation({
      type: op.type,
      payload: op.payload,
      bucket: op.bucket,
      expandQueue: [],
      plan,
      planComplete: true,
      retryOf: op.id,
    });

    await advanceOperation(retried, getAdapter());
    return json(summarizeOperation(retried), 202);
  }

  const cancelOperationMatch = path.match(/^\/api\/operations\/([^/]+)\/cancel$/);
  if (cancelOperationMatch && request.method === "POST") {
    const op = operationMap.get(decodeURIComponent(cancelOperationMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);

    op.cancelRequested = true;
    op.updatedAt = new Date().toISOString();
    if (TERMINAL_STATUSES.has(op.status)) {
      // Already finished: report the real outcome rather than claiming a cancel.
      return json(summarizeOperation(op));
    }
    if (!op.batchInFlight) {
      finalize(op);
    } else {
      op.status = "cancelling";
      refreshResult(op);
    }
    return json(summarizeOperation(op));
  }

  return json({ error: "Not found" }, 404);
}

async function authorize(request, env, authenticateCaller) {
  let result;
  try {
    result = await authenticateCaller({
      token: request.headers.get("Cf-Access-Jwt-Assertion"),
      env,
      request,
    });
  } catch {
    return { ok: false, response: json({ error: "Authentication is not available" }, 503) };
  }

  if (result?.ok) return { ok: true, claims: result.claims };

  if (result?.status === 503) {
    return { ok: false, response: json({ error: "Authentication is not available" }, 503) };
  }

  return {
    ok: false,
    response: json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": "Bearer" }),
  };
}

/**
 * Builds the Worker handler.
 *
 * `createAdapter` and `authenticate` exist so tests can prove that unauthenticated
 * requests never reach the S3 adapter, and that operation batching behaves.
 */
export function createHandler({
  createAdapter = (env) => new AwsS3WorkerAdapter(env),
  authenticate: authenticateCaller = authenticate,
} = {}) {
  async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Preflight is the only unauthenticated non-GET path. It carries no
    // credentials and never grants authorization.
    if (request.method === "OPTIONS") return preflight(request, env);

    if (path === "/api/health") return json({ ok: true });

    if (path === "/api/capabilities") {
      return json({ uploads: true, batchOperations: true, folderOperations: true });
    }

    if (!path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    const auth = await authorize(request, env, authenticateCaller);
    if (!auth.ok) return auth.response;

    return handleApi(request, env, ctx, path, url, createAdapter);
  }

  return {
    async fetch(request, env, ctx) {
      let response;
      try {
        response = await handleRequest(request, env, ctx);
      } catch (error) {
        response = errorResponse(error);
      }
      return withCors(request, env, response);
    },
  };
}

export default createHandler();
