import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ImageStore } from "@/domain/chat/imageStore";
import { config } from "@/lib/config";

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: config.awsRegion });
  }
  return s3Client;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function isImageStoreConfigured(): boolean {
  return config.imageBucketName !== undefined;
}

function requireBucket(): string {
  const bucket = config.imageBucketName;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME not configured");
  }
  return bucket;
}

/**
 * Chat images in S3.
 *
 * Objects are written with no ACL and read through presigned GETs, so holding a
 * transcript is no longer the same as holding the pictures in it. Nothing here
 * deletes: the row naming an object expires by DynamoDB TTL with no code path
 * running, so an app-side delete could never cover the case that matters. The
 * bucket's own lifecycle rule is the only mechanism that can, which is why
 * docs/OPERATIONS.md makes it a deployment requirement rather than an option.
 */
export const s3ImageStore: ImageStore = {
  async put(image) {
    const bucket = requireBucket();
    const extension = EXTENSIONS[image.mimeType] ?? "png";
    const key = `images/${randomUUID()}.${extension}`;
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: Buffer.from(image.b64, "base64"),
        ContentType: image.mimeType,
        // `private`, because the URL that reaches a reader is signed and
        // specific to that read: a shared cache holding the response would hand
        // the object to whoever asked next, which is the property being
        // removed here. Still immutable and long-lived — a key is a fresh UUID
        // per object, so the bytes behind one never change.
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
    return key;
  },

  async signUrl(key, expiresInSeconds) {
    return getSignedUrl(
      getS3Client(),
      new GetObjectCommand({ Bucket: requireBucket(), Key: key }),
      { expiresIn: expiresInSeconds },
    );
  },

  /**
   * Both address forms this bucket has ever been reachable by: virtual-hosted
   * (`{bucket}.s3[.{region}].amazonaws.com/{key}`) and path-style
   * (`s3[.{region}].amazonaws.com/{bucket}/{key}`).
   *
   * The bucket name must match **exactly**. An address under someone else's
   * bucket is not ours to re-sign, and signing a key we do not have produces a
   * URL that 404s instead of an honest "this could not be loaded" — replacing
   * an address that worked with one that does not. A prefix test is not that
   * comparison: bucket names may contain dots, so `ours.archive.s3…` starts
   * with `ours.` while belonging to a different bucket entirely.
   */
  keyFromUrl(url) {
    const bucket = config.imageBucketName;
    if (!bucket) {
      return null;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!/(^|\.)s3[.-][a-z0-9-]*\.?amazonaws\.com$/.test(parsed.hostname)) {
      return null;
    }
    const path = decodeURIComponent(parsed.pathname).replace(/^\//, "");
    // Everything left of the first `.s3` label is the bucket, whatever it
    // contains; the regex above already established the rest is S3's.
    const hosted = /^(.+?)\.s3[.-]/.exec(parsed.hostname)?.[1];
    if (hosted !== undefined) {
      return hosted === bucket ? path || null : null;
    }
    const prefix = `${bucket}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) || null : null;
  },
};
