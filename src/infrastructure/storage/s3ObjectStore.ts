import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { assertNotPrivateFileKey, ObjectNotFoundError, type ArtifactObjectStore } from "@/domain/artifact/objectStore";
import { config } from "@/lib/config";
import { getArtifactAccessMode, getS3PublicBaseUrl } from "@/lib/runtime-settings";
import { sniffImageType } from "@/domain/llm/imageSniff";
import { BodyTooLargeError, readBodyBytes } from "@/shared/httpBody";

let s3Client: S3Client | undefined;

/**
 * Any S3-compatible store. `S3_ENDPOINT` names one other than AWS — a MinIO,
 * a Garage, a Ceph gateway inside the network — addressed path-style,
 * because a self-hosted endpoint rarely resolves bucket subdomains. Unset,
 * the SDK's own region/credential resolution applies, exactly as before.
 */
export function getS3Client(): S3Client {
  if (!s3Client) {
    const endpoint = config.s3Endpoint;
    const credentials = config.s3Credentials;
    s3Client = new S3Client({
      region: config.awsRegion,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      ...(credentials ? { credentials } : {}),
    });
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
 * Where a reader fetches a public object from. `S3_PUBLIC_BASE_URL` when the
 * store is reached through a different address than the app uploads to (a
 * reverse proxy in front of MinIO); otherwise the endpoint, path-style; and
 * for AWS itself the virtual-host form.
 */
export async function artifactPublicUrl(key: string): Promise<string> {
  assertNotPrivateFileKey(key);
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const bucket = requireBucket();
  const base = (await getS3PublicBaseUrl())?.replace(/\/+$/, "");
  if (base) {
    return `${base}/${encodedKey}`;
  }
  const endpoint = config.s3Endpoint?.replace(/\/+$/, "");
  if (endpoint) {
    return `${endpoint}/${bucket}/${encodedKey}`;
  }
  return `https://${bucket}.s3.${config.awsRegion}.amazonaws.com/${encodedKey}`;
}

export async function readStoredObject(bucket: string, key: string, maxBytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const object = await getS3Client()
    .send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })
    .catch((error: unknown) => {
      // The port's name for it. `NoSuchKey` is what S3 and every compatible
      // store answer a GET on a missing key with.
      if ((error as { name?: string }).name === "NoSuchKey") {
        throw new ObjectNotFoundError(key);
      }
      throw error;
    });
  const body = object.Body;
  if (!body) {
    throw new Error("stored object has no body");
  }
  let bytes: Uint8Array;
  try {
    const headers = new Headers();
    if (object.ContentLength !== undefined) {
      headers.set("content-length", String(object.ContentLength));
    }
    const stream = body instanceof Readable
      // Node and DOM typings differ on BYOB readers; this boundary uses the
      // same Uint8Array default reader in both environments.
      ? ReadableStream.from<Uint8Array>(body) as unknown as NonNullable<Response["body"]>
      : body.transformToWebStream();
    bytes = await readBodyBytes({ body: stream, headers }, maxBytes, signal);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      throw new Error(`stored object exceeds the ${maxBytes}-byte read limit`);
    }
    throw error;
  } finally {
    // Also release an unread Node body when its declared size was refused.
    if (body instanceof Readable) {
      body.destroy();
    }
  }
  // The header is the only place the type lives, and a filesystem hop loses
  // it: a migration's `aws s3 sync` → `mc mirror`, a backup restored the
  // same way, both re-guess from the extension — which an `images/<uuid>`
  // key has none of. A picture says what it is in its first bytes; for one,
  // that answer wins over a header that says nothing.
  const declared = object.ContentType;
  const generic = declared === undefined || declared === "application/octet-stream";
  const mimeType = (generic ? sniffImageType(bytes) : undefined) ?? declared ?? "application/octet-stream";
  return { bytes, mimeType };
}

/**
 * The bytes behind an artifact row.
 *
 * The bytes are immutable, but stay out of shared caches in both access modes.
 * That keeps switching from public back to authenticated meaningful.
 */
export const artifactObjectStore: ArtifactObjectStore = {
  async put(input) {
    assertNotPrivateFileKey(input.key);
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

  async read(key, maxBytes) { assertNotPrivateFileKey(key); return readStoredObject(requireBucket(), key, maxBytes); },

  /**
   * A direct URL in public mode, otherwise a pre-signed GET URL. The signed
   * lifetime is the caller's because readers need different ones.
   *
   * **A filename can only travel inside a signature.** S3 refuses the
   * `response-*` overrides on an anonymous GET outright — `InvalidRequest:
   * Request specific response headers cannot be used for anonymous GET
   * requests` — so appending the disposition to the direct URL is not a
   * cheaper version of this, it is a 400. Public mode therefore keeps the
   * permanent direct URL for everything that is *shown* and signs the ones
   * that are *taken away*; without this a public deployment saved every
   * document under its object key, which is a UUID.
   */
  async sign(key, expiresInSeconds, options) {
    assertNotPrivateFileKey(key);
    const downloadAs = options?.downloadAs;
    if (!downloadAs && (await getArtifactAccessMode()) === "public") {
      return artifactPublicUrl(key);
    }
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
    assertNotPrivateFileKey(key);
    await deleteStoredObject(requireBucket(), key);
  },
};

/** Shared object deletion; callers own their inventory and retention policy. */
export async function deleteStoredObject(bucket: string, key: string): Promise<void> {
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
