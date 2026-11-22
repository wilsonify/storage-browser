import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeKey,
  validateBucketName,
  validateObjectKey,
  sanitizePrefix,
} from "./s3-adapter.mjs";

test("validateBucketName rejects invalid bucket names", () => {
  assert.throws(() => validateBucketName("../evil"), /Invalid bucket/);
  assert.throws(() => validateBucketName("bucket/with/path"), /Invalid bucket/);
  assert.equal(validateBucketName("064592191516-audio"), "064592191516-audio");
});

test("normalizeKey blocks traversal and leading slashes", () => {
  assert.throws(() => normalizeKey("../../etc/passwd"), /Invalid key/);
  assert.throws(() => normalizeKey("../folder/file.txt"), /Invalid key/);
  assert.equal(normalizeKey("/artists/track.mp3"), "artists/track.mp3");
  assert.equal(sanitizePrefix("/music/album/"), "music/album/");
  assert.equal(sanitizePrefix("dir"), "dir", "a prefix without a trailing slash keeps its shape");
  assert.equal(sanitizePrefix("//"), "", "slash-only input collapses to the root");
  assert.equal(sanitizePrefix("dir///"), "dir/", "a trailing slash run collapses to one");
});

test("validateObjectKey accepts safe S3 keys", () => {
  assert.equal(validateObjectKey("folder/file.txt"), "folder/file.txt");
  assert.equal(validateObjectKey("folder/subfolder/"), "folder/subfolder/");
});
