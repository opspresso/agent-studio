import { randomUUID } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

/**
 * Upload a generated image and return its **object key**.
 *
 * The key rather than a URL: the bucket no longer has to be public-read, and a
 * chat transcript or a Slack message no longer carries a link that keeps working
 * forever for anyone who ever sees it. Addresses are minted at read time by
 * {@link signImageUrl}, with a lifetime the reader chooses.
 *
 * `private` on the cache header rather than `public`: the bytes are immutable —
 * the key is a UUID and nothing rewrites it — but the response now belongs to
 * the one caller whose signature fetched it, and a shared cache has no business
 * holding it for the next one.
 */
export async function storeImage(image: { b64: string; mimeType: string }): Promise<string> {
  const bucket = config.imageBucketName;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME not configured");
  }
  const extension = EXTENSIONS[image.mimeType] ?? "png";
  const key = `images/${randomUUID()}.${extension}`;
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: Buffer.from(image.b64, "base64"),
      ContentType: image.mimeType,
      CacheControl: "private, max-age=31536000, immutable",
    }),
  );
  return key;
}

/**
 * A pre-signed GET URL for a stored object.
 *
 * The lifetime is the caller's, because the two readers need different ones: a
 * chat view is read by a person with the page already open, while a replay hands
 * the URL to a model provider that fetches it at some point inside a run which
 * may last `MAX_RUN_DURATION_MS`.
 */
export async function signImageUrl(key: string, expiresInSeconds: number): Promise<string> {
  const bucket = config.imageBucketName;
  if (!bucket) {
    throw new Error("S3_BUCKET_NAME not configured");
  }
  // The presigner is typed against its own copy of the smithy client interface;
  // the two declare the same private field separately, so structural assignment
  // fails on identity rather than on shape. The cast is at the SDK seam only.
  return getSignedUrl(
    getS3Client() as unknown as Parameters<typeof getSignedUrl>[0],
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: expiresInSeconds },
  );
}
