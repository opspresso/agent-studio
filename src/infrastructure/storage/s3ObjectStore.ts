import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { config } from "@/lib/config";
import { getArtifactAccessMode } from "@/lib/runtime-settings";

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

export function artifactPublicUrl(key: string): string {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return `https://${requireBucket()}.s3.${config.awsRegion}.amazonaws.com/${encodedKey}`;
}

/**
 * The bytes behind an artifact row.
 *
 * The bytes are immutable, but stay out of shared caches in both access modes.
 * That keeps switching from public back to authenticated meaningful.
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
   * A direct URL in public mode, otherwise a pre-signed GET URL. The signed
   * lifetime is the caller's because readers need different ones.
   */
  async sign(key, expiresInSeconds, options) {
    if (await getArtifactAccessMode() === "public") {
      return artifactPublicUrl(key);
    }
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

// `storeImage` used to live here: an upload that minted `images/<uuid>` and
// returned the key, kept while the chat surface still uploaded for itself. It
// moved to `storeArtifact` — which derives the key from the row's id, so an
// object and its row can find each other — and the last caller went with it.
// Deleted rather than left for "when it is needed again": what it produced is
// exactly the un-inventoried object the artifact row exists to stop, and an
// exported function is an invitation to produce one.
