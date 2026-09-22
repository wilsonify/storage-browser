import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getRawAsset, isSea } from "node:sea";
import { AwsS3Ops } from "./s3-ops.mjs";
import { OperationStore } from "./operations-store.mjs";
import { OperationsWorker } from "./operations-worker.mjs";

const PORT = 3737;
const appDir = isSea() ? process.cwd() : dirname(process.argv[1] || process.cwd());

function resolveStateFilePath() {
  const baseDir = process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), ".s3-browser");
  return join(baseDir, "s3-browser", "operations.json");
}

async function loadIndexHtml() {
  if (isSea()) {
    const bytes = getRawAsset("index.html");
    return Buffer.from(bytes).toString("utf-8");
  }

  return readFile(join(appDir, "index.html"), "utf-8");
}

async function loadAssetBytes(name) {
  if (isSea()) {
    return Buffer.from(getRawAsset(name));
  }

  return readFile(join(appDir, "assets", name));
}

function openBrowser(url) {
  if (process.env.S3_BROWSER_NO_OPEN === "1") return;

  const options = { detached: true, stdio: "ignore" };
  if (process.platform === "win32") {
    const child = spawn("cmd", ["/c", "start", "", url], options);
    child.unref();
    return;
  }

  if (process.platform === "darwin") {
    const child = spawn("open", [url], options);
    child.unref();
    return;
  }

  const child = spawn("xdg-open", [url], options);
  child.unref();
}

const s3 = new S3Client({
  region: "us-east-1",
  credentials: fromIni({ profile: "personal" }),
});
const s3ops = new AwsS3Ops(s3);
const operationStore = new OperationStore(resolveStateFilePath());
const operationWorker = new OperationsWorker({ store: operationStore, s3ops });
const activeSockets = new Set();

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function handleBuckets(_req, res) {
  try {
    const buckets = await s3ops.listBuckets();
    json(res, buckets);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleListObjects(req, res, bucket, url) {
  const prefix = url.searchParams.get("prefix") || "";
  const continuationToken = url.searchParams.get("continuationToken") || undefined;
  const delimiter = url.searchParams.get("delimiter") || "/";

  try {
    const data = await s3ops.listObjects({
      bucket,
      prefix,
      continuationToken,
      delimiter,
      maxKeys: 1000,
    });
    json(res, data);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleDownload(_req, res, bucket, url) {
  const key = url.searchParams.get("key");
  if (!key) return json(res, { error: "Missing key" }, 400);

  try {
    const { head, body } = await s3ops.getDownloadStream(bucket, key);
    const ext = key.split(".").pop().toLowerCase();
    const contentTypes = {
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
    const contentType = head.ContentType || contentTypes[ext] || "application/octet-stream";
    const fileName = key.split("/").pop();

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": head.ContentLength,
      "Content-Disposition": `inline; filename="${fileName}"`,
    });
    body.pipe(res);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleEnqueueOperation(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, { error: "Invalid JSON body" }, 400);
  }

  const { type, payload } = body || {};
  if (!["move", "copy", "delete", "rename"].includes(type)) {
    return json(res, { error: "Invalid operation type" }, 400);
  }
  if (!payload || typeof payload !== "object") {
    return json(res, { error: "Missing operation payload" }, 400);
  }

  const bucket = payload.bucket;
  if (!bucket || typeof bucket !== "string") {
    return json(res, { error: "Missing bucket in operation payload" }, 400);
  }

  function isNonEmptyStringArray(value) {
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
  }

  if ((type === "move" || type === "copy") && !isNonEmptyStringArray(payload.sources)) {
    return json(res, { error: "Missing or invalid sources" }, 400);
  }

  if ((type === "move" || type === "copy") && (typeof payload.destination !== "string" || !payload.destination)) {
    return json(res, { error: "Missing or invalid destination" }, 400);
  }

  if (type === "delete" && !isNonEmptyStringArray(payload.targets)) {
    return json(res, { error: "Missing or invalid targets" }, 400);
  }

  if (type === "rename") {
    if (typeof payload.source !== "string" || !payload.source) {
      return json(res, { error: "Missing or invalid source" }, 400);
    }
    if (typeof payload.newName !== "string" || !payload.newName) {
      return json(res, { error: "Missing or invalid newName" }, 400);
    }
  }

  try {
    const operation = await operationStore.enqueue(type, payload);
    operationWorker.wake();
    json(res, operation, 202);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleLegacyMove(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, { error: "Invalid JSON body" }, 400);
  }

  const { bucket, source, destination } = body || {};
  if (!bucket || typeof source !== "string" || !source || typeof destination !== "string" || !destination) {
    return json(res, { error: "Missing bucket, source, or destination" }, 400);
  }

  try {
    const operation = await operationStore.enqueue("move", {
      bucket,
      sources: [source],
      destination,
    });
    operationWorker.wake();
    json(res, { operationId: operation.id, status: operation.status }, 202);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleListOperations(_req, res) {
  json(res, { operations: operationStore.list() });
}

async function handleGetOperation(_req, res, id) {
  const operation = operationStore.getById(id);
  if (!operation) return json(res, { error: "Operation not found" }, 404);
  json(res, operation);
}

async function handleRetryOperation(_req, res, id) {
  const operation = operationStore.getById(id);
  if (!operation) return json(res, { error: "Operation not found" }, 404);
  if (operation.status !== "failed") return json(res, { error: "Only failed operations can be retried" }, 400);

  const retried = await operationStore.retry(id);
  operationWorker.wake();
  json(res, retried);
}

async function handleCancelOperation(_req, res, id) {
  const operation = operationStore.getById(id);
  if (!operation) return json(res, { error: "Operation not found" }, 404);

  const result = await operationStore.cancel(id);
  if (!result.changed) {
    return json(res, { error: result.reason }, 400);
  }

  json(res, result.op);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (path === "/assets/s3_browser_icon.svg") {
    try {
      const bytes = await loadAssetBytes("s3_browser_icon.svg");
      res.writeHead(200, {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  if (path === "/assets/s3_browser_icon.ico") {
    try {
      const bytes = await loadAssetBytes("s3_browser_icon.ico");
      res.writeHead(200, {
        "Content-Type": "image/x-icon",
        "Cache-Control": "public, max-age=86400",
      });
      res.end(bytes);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  // Serve index.html
  if (path === "/" || path === "/index.html") {
    try {
      const html = await loadIndexHtml();
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(500);
      res.end("index.html not found");
    }
    return;
  }

  // API: list buckets
  if (path === "/api/buckets" && req.method === "GET") {
    return handleBuckets(req, res);
  }

  // API: list objects in bucket
  const bucketMatch = path.match(/^\/api\/buckets\/([^/]+)\/objects$/);
  if (bucketMatch && req.method === "GET") {
    return handleListObjects(req, res, decodeURIComponent(bucketMatch[1]), url);
  }

  // API: download object
  if (path === "/api/download" && req.method === "GET") {
    const bucket = url.searchParams.get("bucket");
    if (!bucket) return json(res, { error: "Missing bucket" }, 400);
    return handleDownload(req, res, bucket, url);
  }

  // API: operation queue
  if (path === "/api/operations" && req.method === "GET") {
    return handleListOperations(req, res);
  }

  if (path === "/api/operations" && req.method === "POST") {
    return handleEnqueueOperation(req, res);
  }

  const operationMatch = path.match(/^\/api\/operations\/([^/]+)$/);
  if (operationMatch && req.method === "GET") {
    return handleGetOperation(req, res, operationMatch[1]);
  }

  const retryMatch = path.match(/^\/api\/operations\/([^/]+)\/retry$/);
  if (retryMatch && req.method === "POST") {
    return handleRetryOperation(req, res, retryMatch[1]);
  }

  const cancelMatch = path.match(/^\/api\/operations\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    return handleCancelOperation(req, res, cancelMatch[1]);
  }

  // API: legacy synchronous move now enqueues async move operation
  if (path === "/api/move" && req.method === "POST") {
    return handleLegacyMove(req, res);
  }

  res.writeHead(404);
  res.end("Not found");
});

let shutdownStarted = false;
function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`Shutting down (${signal})...`);
  operationWorker.stop();

  // Ensure keep-alive sockets do not block server close.
  for (const socket of activeSockets) {
    socket.destroy();
  }

  server.close(() => {
    console.log("S3 Browser stopped.");
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(0);
  }, 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function start() {
  await operationStore.init();
  operationWorker.start();

  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.on("close", () => {
      activeSockets.delete(socket);
    });
  });

  server.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`S3 Browser running at ${url}`);
    openBrowser(url);
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
