import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, normalize, resolve } from "node:path";

const MAX_EXPANDED_OBJECTS = 50000;

function ensureFolderPrefix(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeDestinationPrefix(value) {
  if (!value || value === "/") return "";
  const trimmed = value.startsWith("/") ? value.slice(1) : value;
  return ensureFolderPrefix(trimmed);
}

function parentPrefix(keyOrPrefix) {
  const trimmed = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  const idx = trimmed.lastIndexOf("/");
  if (idx === -1) return "";
  return `${trimmed.slice(0, idx + 1)}`;
}

function baseName(keyOrPrefix) {
  const trimmed = keyOrPrefix.endsWith("/") ? keyOrPrefix.slice(0, -1) : keyOrPrefix;
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function throwIfCancelled(shouldCancel) {
  if (typeof shouldCancel === "function" && shouldCancel()) {
    const err = new Error("Operation cancelled");
    err.name = "OperationCancelledError";
    throw err;
  }
}

function isFolderPath(path) {
  return typeof path === "string" && path.endsWith("/");
}

function uniqueSources(sources) {
  const seen = new Set();
  const out = [];
  for (const raw of sources || []) {
    if (typeof raw !== "string" || !raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

function normalizeLocalPath(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  return normalize(resolve(source.trim()));
}

function uniqueLocalSources(sources) {
  const seen = new Set();
  const out = [];
  for (const source of sources || []) {
    const normalized = normalizeLocalPath(source);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function toS3KeyPart(value) {
  return value.replaceAll("\\", "/");
}

function sourceContainsPath(source, path) {
  if (!isFolderPath(source)) return source === path;
  return path.startsWith(source);
}

function classifySourcesForDestination(sources, destinationPrefix) {
  const normalized = uniqueSources(sources);
  const skipped = {
    destinationSelf: [],
    recursive: [],
    redundantNested: [],
  };

  // 1) Remove exact destination self entries (safe no-op on self-drop)
  const withoutDestination = [];
  for (const source of normalized) {
    if (source === destinationPrefix) {
      skipped.destinationSelf.push(source);
      continue;
    }
    withoutDestination.push(source);
  }

  // 2) Remove sources that would recursively contain destination
  const withoutRecursive = [];
  for (const source of withoutDestination) {
    if (isFolderPath(source) && destinationPrefix.startsWith(source)) {
      skipped.recursive.push(source);
      continue;
    }
    withoutRecursive.push(source);
  }

  // 3) Remove redundant nested selections (parent folder selection already covers descendant)
  const effective = [];
  for (const source of withoutRecursive) {
    const covered = withoutRecursive.some((other) => {
      if (other === source) return false;
      return isFolderPath(other) && sourceContainsPath(other, source);
    });

    if (covered) {
      skipped.redundantNested.push(source);
      continue;
    }
    effective.push(source);
  }

  return { effectiveSources: effective, skipped };
}

export class AwsS3Ops {
  constructor(client) {
    this.client = client;
  }

  async listBuckets() {
    const resp = await this.client.send(new ListBucketsCommand({}));
    return (resp.Buckets || []).map((b) => ({
      name: b.Name,
      created: b.CreationDate?.toISOString(),
    }));
  }

  async listObjects({ bucket, prefix, continuationToken, delimiter = "/", maxKeys = 1000 }) {
    const resp = await this.client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      Delimiter: delimiter,
      ContinuationToken: continuationToken,
      MaxKeys: maxKeys,
    }));

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

    return {
      folders,
      files,
      isTruncated: !!resp.IsTruncated,
      nextContinuationToken: resp.NextContinuationToken || null,
      prefix,
      bucket,
    };
  }

  async getDownloadStream(bucket, key) {
    const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const bodyResp = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { head, body: bodyResp.Body };
  }

  async listAllKeysForPrefix(bucket, prefix) {
    const keys = [];
    let token;

    do {
      const resp = await this.client.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }));
      keys.push(...(resp.Contents || []).map((o) => o.Key));
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);

    return keys;
  }

  async copyObject(bucket, sourceKey, destinationKey) {
    return this.client.send(new CopyObjectCommand({
      Bucket: bucket,
      CopySource: `${bucket}/${encodeURIComponent(sourceKey)}`,
      Key: destinationKey,
    }));
  }

  async deleteKeys(bucket, keys) {
    for (let i = 0; i < keys.length; i += 1000) {
      await this.client.send(new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.slice(i, i + 1000).map((key) => ({ Key: key })),
          Quiet: true,
        },
      }));
    }
  }

  async putEmptyFolderMarker(bucket, prefix) {
    return this.client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: ensureFolderPrefix(prefix),
      Body: "",
    }));
  }

  async getObjectSize(bucket, key) {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        exists: true,
        size: Number.isFinite(head?.ContentLength) ? Number(head.ContentLength) : null,
      };
    } catch (err) {
      if (
        err?.name === "NotFound"
        || err?.$metadata?.httpStatusCode === 404
        || err?.Code === "NotFound"
      ) {
        return { exists: false, size: null };
      }
      throw err;
    }
  }

  async collectLocalUploadPlan(sourcePath, shouldCancel) {
    const sourceStat = await stat(sourcePath);

    if (sourceStat.isFile()) {
      return {
        rootName: null,
        files: [{ absPath: sourcePath, relPath: basename(sourcePath), size: sourceStat.size }],
        emptyFolders: [],
        skippedSymlinks: [],
        skippedOutsideRoot: [],
      };
    }

    if (!sourceStat.isDirectory()) {
      throw new Error(`Unsupported source type: ${sourcePath}`);
    }

    const rootName = basename(sourcePath);
    const rootRealPath = await realpath(sourcePath);
    const rootRealPrefix = rootRealPath.endsWith("\\") || rootRealPath.endsWith("/")
      ? rootRealPath
      : `${rootRealPath}\\`;
    const files = [];
    const emptyFolders = [];
    const skippedSymlinks = [];
    const skippedOutsideRoot = [];
    const visitedDirs = new Set();

    const walk = async (dirPath, relDir) => {
      throwIfCancelled(shouldCancel);

      const realDirPath = await realpath(dirPath);
      if (!(realDirPath === rootRealPath || realDirPath.startsWith(rootRealPrefix))) {
        if (relDir) skippedOutsideRoot.push(toS3KeyPart(relDir));
        return;
      }

      if (visitedDirs.has(realDirPath)) return;
      visitedDirs.add(realDirPath);

      const entries = await readdir(dirPath, { withFileTypes: true });
      if (entries.length === 0 && relDir) {
        emptyFolders.push(relDir);
        return;
      }

      for (const entry of entries) {
        throwIfCancelled(shouldCancel);
        const absPath = join(dirPath, entry.name);
        const relPath = relDir ? join(relDir, entry.name) : entry.name;
        const entryStat = await lstat(absPath);

        if (entryStat.isSymbolicLink()) {
          skippedSymlinks.push(toS3KeyPart(relPath));
          continue;
        }

        if (entryStat.isDirectory() || entry.isDirectory()) {
          await walk(absPath, relPath);
        } else if (entryStat.isFile() || entry.isFile()) {
          files.push({ absPath, relPath, size: entryStat.size });
        }
      }
    };

    await walk(sourcePath, "");
    return { rootName, files, emptyFolders, skippedSymlinks, skippedOutsideRoot };
  }

  async syncLocalSourcesToS3({ bucket, sources, destination, overwrite = false, onProgress, shouldCancel }) {
    const destinationPrefix = normalizeDestinationPrefix(destination);
    const normalizedSources = uniqueLocalSources(sources);

    if (normalizedSources.length === 0) {
      onProgress?.({ total: 0, completed: 0, message: "No-op" });
      return {
        uploaded: 0,
        skippedExisting: 0,
        folderMarkers: 0,
        noop: true,
      };
    }

    const uploadPlan = [];
    let totalSourceFiles = 0;
    let skippedSymlinkCount = 0;
    let skippedOutsideRootCount = 0;

    for (const sourcePath of normalizedSources) {
      throwIfCancelled(shouldCancel);
      const plan = await this.collectLocalUploadPlan(sourcePath, shouldCancel);

      const folderBasePrefix = plan.rootName
        ? `${destinationPrefix}${toS3KeyPart(plan.rootName)}/`
        : destinationPrefix;

      for (const file of plan.files) {
        const relPart = toS3KeyPart(file.relPath);
        uploadPlan.push({
          type: "file",
          absPath: file.absPath,
          key: `${folderBasePrefix}${relPart}`,
          size: file.size,
        });
      }

      if (plan.rootName) {
        for (const emptyRelDir of plan.emptyFolders) {
          const relPart = toS3KeyPart(emptyRelDir);
          uploadPlan.push({
            type: "marker",
            key: `${folderBasePrefix}${relPart}/`,
          });
        }
      }

      totalSourceFiles += plan.files.length;
      skippedSymlinkCount += plan.skippedSymlinks.length;
      skippedOutsideRootCount += plan.skippedOutsideRoot.length;
    }

    onProgress?.({ total: uploadPlan.length, completed: 0, message: "Uploading" });

    let completed = 0;
    let uploaded = 0;
    let skippedExisting = 0;
    let uploadedUpdated = 0;
    let uploadedNew = 0;
    let folderMarkers = 0;

    for (const step of uploadPlan) {
      throwIfCancelled(shouldCancel);

      let existingMeta = { exists: false, size: null };

      if (!overwrite) {
        existingMeta = await this.getObjectSize(bucket, step.key);
        if (existingMeta.exists) {
          if (step.type === "marker") {
            skippedExisting += 1;
            completed += 1;
            onProgress?.({ total: uploadPlan.length, completed, message: "Uploading" });
            continue;
          }

          if (existingMeta.size === step.size) {
            skippedExisting += 1;
            completed += 1;
            onProgress?.({ total: uploadPlan.length, completed, message: "Uploading" });
            continue;
          }
        }
      }

      if (step.type === "marker") {
        await this.putEmptyFolderMarker(bucket, step.key);
        folderMarkers += 1;
      } else {
        await this.client.send(new PutObjectCommand({
          Bucket: bucket,
          Key: step.key,
          Body: createReadStream(step.absPath),
        }));
        uploaded += 1;
        if (existingMeta.exists) uploadedUpdated += 1;
        else uploadedNew += 1;
      }

      completed += 1;
      onProgress?.({ total: uploadPlan.length, completed, message: "Uploading" });
    }

    return {
      uploaded,
      uploadedNew,
      uploadedUpdated,
      skippedExisting,
      skippedUnchanged: skippedExisting,
      folderMarkers,
      sourceFiles: totalSourceFiles,
      skippedSymlinkCount,
      skippedOutsideRootCount,
      destination: destinationPrefix,
    };
  }

  async copyTargets({ bucket, sources, destination, onProgress, shouldCancel }) {
    const destinationPrefix = ensureFolderPrefix(destination);
    const { effectiveSources, skipped } = classifySourcesForDestination(sources, destinationPrefix);

    if (effectiveSources.length === 0) {
      onProgress?.({ total: 0, completed: 0, message: "No-op" });
      return {
        copied: 0,
        copiedKeys: [],
        skipped,
        noop: true,
      };
    }

    const copyPlan = [];
    let expandedObjects = 0;

    for (const source of effectiveSources) {
      throwIfCancelled(shouldCancel);
      if (source.endsWith("/")) {
        const folderName = baseName(source);
        const sourceKeys = await this.listAllKeysForPrefix(bucket, source);

        expandedObjects += sourceKeys.length;
        if (expandedObjects > MAX_EXPANDED_OBJECTS) {
          throw new Error(`Operation exceeds safety limit of ${MAX_EXPANDED_OBJECTS} objects`);
        }

        if (sourceKeys.length === 0) {
          copyPlan.push({ markerOnly: true, destinationKey: `${destinationPrefix}${folderName}/` });
          continue;
        }

        const destPrefix = `${destinationPrefix}${folderName}/`;
        for (const sourceKey of sourceKeys) {
          copyPlan.push({ sourceKey, destinationKey: `${destPrefix}${sourceKey.slice(source.length)}` });
        }
      } else {
        const fileName = baseName(source);
        copyPlan.push({ sourceKey: source, destinationKey: `${destinationPrefix}${fileName}` });
      }
    }

    onProgress?.({ total: copyPlan.length, completed: 0, message: "Copying" });

    let completed = 0;
    for (const step of copyPlan) {
      throwIfCancelled(shouldCancel);
      if (step.markerOnly) {
        await this.putEmptyFolderMarker(bucket, step.destinationKey);
      } else {
        await this.copyObject(bucket, step.sourceKey, step.destinationKey);
      }
      completed += 1;
      onProgress?.({ total: copyPlan.length, completed, message: "Copying" });
    }

    return {
      copied: copyPlan.length,
      copiedKeys: copyPlan.filter((step) => step.sourceKey).map((step) => step.destinationKey),
      skipped,
    };
  }

  async moveTargets({ bucket, sources, destination, onProgress, shouldCancel }) {
    const destinationPrefix = ensureFolderPrefix(destination);
    const { effectiveSources, skipped } = classifySourcesForDestination(sources, destinationPrefix);

    if (effectiveSources.length === 0) {
      onProgress?.({ total: 0, completed: 0, message: "No-op" });
      return {
        moved: 0,
        copied: 0,
        skipped,
        noop: true,
      };
    }

    for (const source of effectiveSources) {
      throwIfCancelled(shouldCancel);
      if (destinationPrefix === parentPrefix(source)) {
        throw new Error("Source and destination are the same");
      }
    }

    const expanded = [];
    const copyPlan = [];
    let expandedObjects = 0;

    for (const source of effectiveSources) {
      throwIfCancelled(shouldCancel);
      if (source.endsWith("/")) {
        const folderName = baseName(source);
        const sourceKeys = await this.listAllKeysForPrefix(bucket, source);

        expandedObjects += sourceKeys.length;
        if (expandedObjects > MAX_EXPANDED_OBJECTS) {
          throw new Error(`Operation exceeds safety limit of ${MAX_EXPANDED_OBJECTS} objects`);
        }

        if (sourceKeys.length === 0) {
          copyPlan.push({ markerOnly: true, destinationKey: `${destinationPrefix}${folderName}/` });
          continue;
        }

        const destPrefix = `${destinationPrefix}${folderName}/`;
        for (const sourceKey of sourceKeys) {
          expanded.push(sourceKey);
          copyPlan.push({ sourceKey, destinationKey: `${destPrefix}${sourceKey.slice(source.length)}` });
        }
      } else {
        expanded.push(source);
        const fileName = baseName(source);
        copyPlan.push({ sourceKey: source, destinationKey: `${destinationPrefix}${fileName}` });
      }
    }

    onProgress?.({ total: copyPlan.length + expanded.length, completed: 0, message: "Copying" });

    let completed = 0;
    for (const step of copyPlan) {
      throwIfCancelled(shouldCancel);
      if (step.markerOnly) {
        await this.putEmptyFolderMarker(bucket, step.destinationKey);
      } else {
        await this.copyObject(bucket, step.sourceKey, step.destinationKey);
      }
      completed += 1;
      onProgress?.({ total: copyPlan.length + expanded.length, completed, message: "Copying" });
    }

    if (expanded.length > 0) {
      throwIfCancelled(shouldCancel);
      await this.deleteKeys(bucket, expanded);
      completed += expanded.length;
      onProgress?.({ total: copyPlan.length + expanded.length, completed, message: "Deleting source" });
    }

    return {
      moved: expanded.length,
      copied: copyPlan.length,
      skipped,
    };
  }

  async deleteTargets({ bucket, targets, onProgress, shouldCancel }) {
    const keys = [];

    for (const target of targets) {
      throwIfCancelled(shouldCancel);
      if (target.endsWith("/")) {
        const folderKeys = await this.listAllKeysForPrefix(bucket, target);
        keys.push(...folderKeys);
      } else {
        keys.push(target);
      }
    }

    onProgress?.({ total: keys.length, completed: 0, message: "Deleting" });

    if (keys.length === 0) {
      return { deleted: 0 };
    }

    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      throwIfCancelled(shouldCancel);
      const chunk = keys.slice(i, i + 1000);
      await this.deleteKeys(bucket, chunk);
      deleted += chunk.length;
      onProgress?.({ total: keys.length, completed: deleted, message: "Deleting" });
    }

    return { deleted: keys.length };
  }

  async renameTarget({ bucket, source, newName, onProgress, shouldCancel }) {
    if (!newName || typeof newName !== "string") {
      throw new Error("Invalid newName");
    }

    const parent = parentPrefix(source);
    const destination = source.endsWith("/")
      ? `${parent}${newName}/`
      : `${parent}${newName}`;

    if (destination === source) {
      throw new Error("Source and destination are the same");
    }

    if (source.endsWith("/") && destination.startsWith(source)) {
      throw new Error("Cannot rename a folder into itself");
    }

    const copyPlan = [];
    const deleteKeys = [];

    throwIfCancelled(shouldCancel);
    if (source.endsWith("/")) {
      const sourceKeys = await this.listAllKeysForPrefix(bucket, source);
      if (sourceKeys.length === 0) {
        copyPlan.push({ markerOnly: true, destinationKey: destination });
      } else {
        for (const key of sourceKeys) {
          deleteKeys.push(key);
          copyPlan.push({ sourceKey: key, destinationKey: `${destination}${key.slice(source.length)}` });
        }
      }
    } else {
      deleteKeys.push(source);
      copyPlan.push({ sourceKey: source, destinationKey: destination });
    }

    onProgress?.({ total: copyPlan.length + deleteKeys.length, completed: 0, message: "Copying" });

    let completed = 0;
    for (const step of copyPlan) {
      throwIfCancelled(shouldCancel);
      if (step.markerOnly) {
        await this.putEmptyFolderMarker(bucket, step.destinationKey);
      } else {
        await this.copyObject(bucket, step.sourceKey, step.destinationKey);
      }
      completed += 1;
      onProgress?.({ total: copyPlan.length + deleteKeys.length, completed, message: "Copying" });
    }

    if (deleteKeys.length > 0) {
      throwIfCancelled(shouldCancel);
      await this.deleteKeys(bucket, deleteKeys);
      completed += deleteKeys.length;
      onProgress?.({ total: copyPlan.length + deleteKeys.length, completed, message: "Deleting source" });
    }

    return {
      source,
      destination,
      renamed: deleteKeys.length,
    };
  }
}
