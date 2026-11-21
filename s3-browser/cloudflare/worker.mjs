import { AwsS3WorkerAdapter } from "./s3-adapter.mjs";
import { authenticate } from "./auth.mjs";

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
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  if (/^Missing AWS credentials/.test(message)) {
    return json({ error: "Object storage is not configured" }, 503);
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

async function processOperationQueue(env, createAdapter) {
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

      const adapter = createAdapter(env);
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

    return new Response(stream, {
      headers: {
        "Content-Type": head.ContentType || contentTypeMap[ext] || "application/octet-stream",
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      },
    });
  }

  if (path === "/api/upload" && request.method === "POST") {
    const formData = await request.formData();
    const bucket = formData.get("bucket");
    const key = formData.get("key") || formData.get("path") || formData.get("fileName");
    const file = formData.get("file") || formData.get("upload") || formData.get("blob");

    if (!bucket || !key || !(file instanceof File)) {
      return json({ error: "Missing bucket, key, or file upload" }, 400);
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

    const operation = enqueueOperation(type, opPayload);
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(processOperationQueue(env, createAdapter));
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
      ctx.waitUntil(processOperationQueue(env, createAdapter));
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
      ctx.waitUntil(processOperationQueue(env, createAdapter));
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
 * requests never reach the S3 adapter.
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
