import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { config } from "@/lib/config";

let s3Client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({ region: config.awsRegion });
  }
  return s3Client;
}

function requireBucket(): string {
  const bucket = config.objectBucketName;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME not configured");
  }
  return bucket;
}

export function isObjectStoreConfigured(): boolean {
  return config.objectBucketName !== undefined;
}

/**
 * The bytes behind an artifact row.
 *
 * `private` on the cache header rather than `public`: the bytes are immutable —
 * the key is derived from a UUID and nothing rewrites it — but the response
 * belongs to the one caller whose signature fetched it, and a shared cache has
 * no business holding it for the next one.
 */
export const artifactObjectStore: ArtifactObjectStore = {
  async put(input) {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: requireBucket(),
        Key: input.key,
        Body: Buffer.from(input.bytes),
        ContentType: input.mimeType,
        CacheControl: "private, max-age=31536000, immutable",
      }),
    );
  },

  /**
   * A pre-signed GET URL. The lifetime is the caller's, because the readers need
   * different ones: a chat view is read by a person with the page already open,
   * while a replay hands the URL to a model provider that fetches it at some
   * point inside a run which may last `MAX_RUN_DURATION_MS`.
   */
  async sign(key, expiresInSeconds, options) {
    const downloadAs = options?.downloadAs;
    return getSignedUrl(
      // The presigner is typed against its own copy of the smithy client
      // interface; the two declare the same private field separately, so
      // structural assignment fails on identity rather than on shape. The cast
      // is at the SDK seam only.
      getS3Client() as unknown as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({
        Bucket: requireBucket(),
        Key: key,
        // RFC 5987, so a Korean filename survives the trip. Signed into the
        // request rather than set on the object: the same bytes are rendered
        // inline in one place and downloaded in another.
        ...(downloadAs
          ? {
              ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(
                downloadAs,
              )}`,
            }
          : {}),
      }),
      { expiresIn: expiresInSeconds },
    );
  },

  /**
   * S3 answers 204 for a key that is not there, which is what makes deletion
   * idempotent: the artifact row is removed only after this resolves, so a
   * delete interrupted between the two converges when it is retried.
   */
  async delete(key) {
    await getS3Client().send(
      new DeleteObjectCommand({ Bucket: requireBucket(), Key: key }),
    );
  },
};

/**
 * Upload a chat image and return its **object key**, under the pre-artifact
 * layout.
 *
 * Still here because the chat surface has not moved to artifact rows yet. New
 * bytes should go through `storeArtifact`, which derives its key from the row's
 * id so an object and its row can find each other; a key minted here references
 * nothing.
 */
export async function storeImage(image: { b64: string; mimeType: string }): Promise<string> {
  const extension = LEGACY_EXTENSIONS[image.mimeType] ?? "png";
  const key = `images/${randomUUID()}.${extension}`;
  await artifactObjectStore.put({
    key,
    bytes: Buffer.from(image.b64, "base64"),
    mimeType: image.mimeType,
  });
  return key;
}

const LEGACY_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
