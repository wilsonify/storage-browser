import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectsCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 3737;
const __dirname = dirname(fileURLToPath(import.meta.url));

const s3 = new S3Client({
  region: "us-east-1",
  credentials: fromIni({ profile: "personal" }),
});

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
    const cmd = new ListBucketsCommand({});
    const resp = await s3.send(cmd);
    const buckets = (resp.Buckets || []).map((b) => ({
      name: b.Name,
      created: b.CreationDate?.toISOString(),
    }));
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
    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: delimiter,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    });
    const resp = await s3.send(cmd);

    const folders = (resp.CommonPrefixes || []).map((p) => ({
      name: p.Prefix.replace(prefix, "").replace(/\/$/, ""),
      type: "folder",
      path: p.Prefix,
    }));

    const files = (resp.Contents || [])
      .filter((o) => o.Key !== prefix)
      .map((o) => ({
        name: o.Key.split("/").pop(),
        type: "file",
        key: o.Key,
        size: o.Size,
        modified: o.LastModified?.toISOString(),
      }));

    json(res, {
      folders,
      files,
      isTruncated: resp.IsTruncated,
      nextContinuationToken: resp.NextContinuationToken,
      prefix,
      bucket,
    });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleDownload(_req, res, bucket, url) {
  const key = url.searchParams.get("key");
  if (!key) return json(res, { error: "Missing key" }, 400);

  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
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

    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const resp = await s3.send(cmd);

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": head.ContentLength,
      "Content-Disposition": `inline; filename="${fileName}"`,
    });
    resp.Body.pipe(res);
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

async function handleMove(req, res) {
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
  if (source === destination) {
    return json(res, { error: "Source and destination are the same" }, 400);
  }

  const isFolder = source.endsWith("/");

  // A folder cannot be moved into itself or one of its subfolders
  if (isFolder && destination.startsWith(source)) {
    return json(res, { error: "Cannot move a folder into itself" }, 400);
  }

  try {
    let sourceKeys;
    let newKeys;

    if (isFolder) {
      // Gather every object under the folder prefix
      sourceKeys = [];
      let token;
      do {
        const cmd = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: source,
          ContinuationToken: token,
        });
        const resp = await s3.send(cmd);
        sourceKeys.push(...(resp.Contents || []).map((o) => o.Key));
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);

      const folderName = source.split("/").filter(Boolean).pop();

      if (sourceKeys.length === 0) {
        // Empty folder (no marker object): materialize it at the destination
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: destination + folderName + "/",
          Body: "",
        }));
        return json(res, { moved: 0, created: true });
      }

      // Keep the folder name: album/Heavy Weather/<relative path>
      const newPrefix = destination + folderName + "/";
      newKeys = sourceKeys.map((key) => newPrefix + key.slice(source.length));
    } else {
      const fileName = source.split("/").pop();
      const targetKey = destination + fileName;
      if (targetKey === source) {
        return json(res, { error: "Source and destination are the same" }, 400);
      }
      sourceKeys = [source];
      newKeys = [targetKey];
    }

    // Copy everything first, then delete originals (safe on partial failure)
    for (let i = 0; i < sourceKeys.length; i++) {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(sourceKeys[i])}`,
        Key: newKeys[i],
      }));
    }

    for (let i = 0; i < sourceKeys.length; i += 1000) {
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: sourceKeys.slice(i, i + 1000).map((key) => ({ Key: key })),
          Quiet: true,
        },
      }));
    }

    json(res, { moved: sourceKeys.length });
  } catch (err) {
    json(res, { error: err.message }, 500);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // Serve index.html
  if (path === "/" || path === "/index.html") {
    try {
      const html = await readFile(join(__dirname, "index.html"), "utf-8");
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

  // API: move object or folder (copy + delete)
  if (path === "/api/move" && req.method === "POST") {
    return handleMove(req, res);
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`S3 Browser running at http://localhost:${PORT}`);
});
