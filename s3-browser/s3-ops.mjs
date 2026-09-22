import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

function ensureFolderPrefix(value) {
  return value.endsWith("/") ? value : `${value}/`;
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

  async copyTargets({ bucket, sources, destination, onProgress }) {
    const destinationPrefix = ensureFolderPrefix(destination);
    const copyPlan = [];

    for (const source of sources) {
      if (source.endsWith("/")) {
        const folderName = baseName(source);
        const sourceKeys = await this.listAllKeysForPrefix(bucket, source);

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
    };
  }

  async moveTargets({ bucket, sources, destination, onProgress }) {
    const destinationPrefix = ensureFolderPrefix(destination);

    for (const source of sources) {
      if (source.endsWith("/") && destinationPrefix.startsWith(source)) {
        throw new Error("Cannot move a folder into itself");
      }
    }

    const expanded = [];
    const copyPlan = [];

    for (const source of sources) {
      if (source.endsWith("/")) {
        const folderName = baseName(source);
        const sourceKeys = await this.listAllKeysForPrefix(bucket, source);

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
      if (step.markerOnly) {
        await this.putEmptyFolderMarker(bucket, step.destinationKey);
      } else {
        await this.copyObject(bucket, step.sourceKey, step.destinationKey);
      }
      completed += 1;
      onProgress?.({ total: copyPlan.length + expanded.length, completed, message: "Copying" });
    }

    if (expanded.length > 0) {
      await this.deleteKeys(bucket, expanded);
      completed += expanded.length;
      onProgress?.({ total: copyPlan.length + expanded.length, completed, message: "Deleting source" });
    }

    return {
      moved: expanded.length,
      copied: copyPlan.length,
    };
  }

  async deleteTargets({ bucket, targets, onProgress }) {
    const keys = [];

    for (const target of targets) {
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
      const chunk = keys.slice(i, i + 1000);
      await this.deleteKeys(bucket, chunk);
      deleted += chunk.length;
      onProgress?.({ total: keys.length, completed: deleted, message: "Deleting" });
    }

    return { deleted: keys.length };
  }

  async renameTarget({ bucket, source, newName, onProgress }) {
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
      if (step.markerOnly) {
        await this.putEmptyFolderMarker(bucket, step.destinationKey);
      } else {
        await this.copyObject(bucket, step.sourceKey, step.destinationKey);
      }
      completed += 1;
      onProgress?.({ total: copyPlan.length + deleteKeys.length, completed, message: "Copying" });
    }

    if (deleteKeys.length > 0) {
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
