import { AwsS3WorkerAdapter, validateBucketName, validateObjectKey } from "./s3-adapter.mjs";

const operationMap = new Map();
const queuedOperations = [];
let queueProcessorRunning = false;

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

function allowedOrigin(origin, env) {
  const configured = (env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!origin) return true;
  if (!configured.length) return true;
  return configured.includes(origin);
}

function withCors(request, response, env) {
  const origin = request.headers.get("Origin");
  const headers = new Headers(response.headers);

  if (origin && allowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, x-requested-with");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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

function enqueueOperation(type, payload) {
  const operation = {
    id: crypto.randomUUID(),
    type,
    payload,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: { total: 0, completed: 0, message: "Queued" },
    cancelRequested: false,
  };

  operationMap.set(operation.id, operation);
  queuedOperations.push(operation.id);
  return operation;
}

function getOperation(id) {
  return operationMap.get(id) || null;
}

function listOperations() {
  return [...operationMap.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function processOperationQueue(env) {
  if (queueProcessorRunning) return;
  queueProcessorRunning = true;

  try {
    while (queuedOperations.length > 0) {
      const id = queuedOperations.shift();
      const op = operationMap.get(id);
      if (!op || op.status === "cancelled") continue;

      op.status = "running";
      op.updatedAt = new Date().toISOString();
      op.progress = { total: 0, completed: 0, message: "Starting" };

      const adapter = new AwsS3WorkerAdapter(env);
      const onProgress = (progress) => {
        op.progress = {
          ...op.progress,
          ...progress,
        };
        op.updatedAt = new Date().toISOString();
      };

      const shouldCancel = () => op.cancelRequested === true;

      try {
        let result;
        if (op.type === "move") {
          result = await adapter.moveTargets({
            bucket: op.payload.bucket,
            sources: op.payload.sources,
            destination: op.payload.destination,
            onProgress,
            shouldCancel,
          });
        } else if (op.type === "copy") {
          result = await adapter.copyTargets({
            bucket: op.payload.bucket,
            sources: op.payload.sources,
            destination: op.payload.destination,
            onProgress,
            shouldCancel,
          });
        } else if (op.type === "delete") {
          result = await adapter.deleteTargets({
            bucket: op.payload.bucket,
            targets: op.payload.targets,
            onProgress,
            shouldCancel,
          });
        } else if (op.type === "rename") {
          result = await adapter.renameTarget({
            bucket: op.payload.bucket,
            source: op.payload.source,
            newName: op.payload.newName,
            onProgress,
            shouldCancel,
          });
        } else {
          throw new Error(`Unsupported operation type: ${op.type}`);
        }

        op.status = "completed";
        op.result = result;
        op.progress = {
          total: 1,
          completed: 1,
          message: op.type === "delete" ? "Finished" : "Complete",
        };
      } catch (error) {
        op.status = error?.name === "OperationCancelledError" ? "cancelled" : "failed";
        op.error = error instanceof Error ? error.message : String(error);
        op.progress = {
          total: 1,
          completed: 0,
          message: op.status === "cancelled" ? "Cancelled" : "Failed",
        };
      }

      op.updatedAt = new Date().toISOString();
    }
  } finally {
    queueProcessorRunning = false;
  }
}

function emitProgress(operation, progress) {
  operation.progress = { ...operation.progress, ...progress };
  operation.updatedAt = new Date().toISOString();
}

async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-requested-with",
      },
    });
  }

  const adapter = new AwsS3WorkerAdapter(env);

  if (path === "/api/health") {
    return json({ ok: true, region: adapter.region, timestamp: new Date().toISOString() });
  }

  if (path === "/api/buckets" && request.method === "GET") {
    const buckets = await adapter.listBuckets();
    return json(buckets);
  }

  const bucketObjectsMatch = path.match(/^\/api\/buckets\/([^/]+)\/objects$/);
  if (bucketObjectsMatch && request.method === "GET") {
    const bucket = decodeURIComponent(bucketObjectsMatch[1]);
    const prefix = url.searchParams.get("prefix") || "";
    const continuationToken = url.searchParams.get("continuationToken") || undefined;
    const delimiter = url.searchParams.get("delimiter") || "/";
    const data = await adapter.listObjects({
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

    const { head, body, key: safeKey } = await adapter.getDownloadStream(bucket, key);
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

    const response = new Response(body, {
      headers: {
        "Content-Type": head.ContentType || contentTypeMap[ext] || "application/octet-stream",
        "Content-Length": String(head.ContentLength || 0),
        "Content-Disposition": `inline; filename="${fileName}"`,
      },
    });

    return response;
  }

  if (path === "/api/upload" && request.method === "POST") {
    const formData = await request.formData();
    const bucket = formData.get("bucket");
    const key = formData.get("key") || formData.get("path") || formData.get("fileName");
    const file = formData.get("file") || formData.get("upload") || formData.get("blob");

    if (!bucket || !key || !(file instanceof File)) {
      return json({ error: "Missing bucket, key, or file upload" }, 400);
    }

    const reply = await adapter.uploadObject({
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

    const operation = enqueueOperation(type, opPayload);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(processOperationQueue(env));
    }
    return json(operation, 202);
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

    const operation = enqueueOperation("move", {
      bucket: body.bucket,
      sources: body.sources,
      destination: body.destination,
    });
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(processOperationQueue(env));
    }
    return json(operation, 202);
  }

  const operationPathMatch = path.match(/^\/api\/operations\/([^/]+)$/);
  if (operationPathMatch && request.method === "GET") {
    const op = getOperation(decodeURIComponent(operationPathMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    return json(op);
  }

  const retryOperationMatch = path.match(/^\/api\/operations\/([^/]+)\/retry$/);
  if (retryOperationMatch && request.method === "POST") {
    const op = getOperation(decodeURIComponent(retryOperationMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    if (op.status !== "failed") {
      return json({ error: "Only failed operations may be retried" }, 400);
    }

    op.status = "queued";
    op.error = undefined;
    op.updatedAt = new Date().toISOString();
    queuedOperations.push(op.id);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(processOperationQueue(env));
    }
    return json(op, 202);
  }

  const cancelOperationMatch = path.match(/^\/api\/operations\/([^/]+)\/cancel$/);
  if (cancelOperationMatch && request.method === "POST") {
    const op = getOperation(decodeURIComponent(cancelOperationMatch[1]));
    if (!op) return json({ error: "Operation not found" }, 404);
    op.cancelRequested = true;
    if (op.status === "queued") {
      op.status = "cancelled";
      op.updatedAt = new Date().toISOString();
      op.error = "Cancelled";
    }
    return json(op);
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const response = await handleApi(request, env, ctx);
    return withCors(request, response, env);
  },
};
