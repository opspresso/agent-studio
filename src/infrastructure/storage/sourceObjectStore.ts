import { createHash } from "node:crypto";
import {
  AbortMultipartUploadCommand, CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand, UploadPartCommand, HeadObjectCommand, PutObjectCommand,
} from "@aws-sdk/client-s3";
import { SourceObjectExistsError, type SourceObjectStore } from "@/domain/artifact/sourceObjectStore";
import { ObjectNotFoundError } from "@/domain/artifact/objectStore";
import { BodyTooLargeError } from "@/shared/httpBody";
import { getS3Client, readStoredObject } from "./s3ObjectStore";

/** S3 requires every non-final multipart part to be at least five MiB. */
const PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;
const CLEANUP_REQUEST_MS = 30_000;
export const SOURCE_OBJECT_REQUEST_MS = 600_000;

function operationSignal(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(SOURCE_OBJECT_REQUEST_MS), ...(signal ? [signal] : [])]);
}

export function createSourceObjectStore(bucket: string): SourceObjectStore {
  if (!bucket.trim()) throw new Error("Source file bucket is required");
  return {
    async write(input, signal) {
      signal = operationSignal(signal);
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || input.maxBytes > PART_BYTES * MAX_PARTS) {
        throw new Error("Source upload byte limit is invalid");
      }
      const client = getS3Client();
      const created = await client.send(new CreateMultipartUploadCommand({
        Bucket: bucket, Key: input.key, ContentType: input.mimeType, CacheControl: "private, no-store",
      }), { abortSignal: signal });
      const uploadId = created.UploadId;
      if (!uploadId) throw new Error("Object store did not return an upload ID");
      const parts: Array<{ PartNumber: number; ETag: string }> = [];
      const checksum = createHash("sha256");
      let byteSize = 0;
      let buffer = Buffer.allocUnsafe(PART_BYTES);
      let used = 0;
      const flush = async () => {
        const body = buffer.subarray(0, used);
        const part = await client.send(new UploadPartCommand({
          Bucket: bucket, Key: input.key, UploadId: uploadId, PartNumber: parts.length + 1,
          Body: body, ContentLength: used, ContentMD5: createHash("md5").update(body).digest("base64"),
        }), { abortSignal: signal });
        if (!part.ETag) throw new Error("Object store did not return a part ETag");
        parts.push({ PartNumber: parts.length + 1, ETag: part.ETag });
        buffer = Buffer.allocUnsafe(PART_BYTES);
        used = 0;
      };
      try {
        for await (const chunk of input.body) {
          signal?.throwIfAborted();
          byteSize += chunk.byteLength;
          if (byteSize > input.maxBytes) throw new BodyTooLargeError(input.maxBytes);
          checksum.update(chunk);
          for (let offset = 0; offset < chunk.byteLength;) {
            const take = Math.min(PART_BYTES - used, chunk.byteLength - offset);
            buffer.set(chunk.subarray(offset, offset + take), used);
            used += take;
            offset += take;
            if (used === PART_BYTES) await flush();
          }
        }
        signal?.throwIfAborted();
        if (byteSize === 0) throw new Error("Source file is empty");
        if (used) await flush();
        await client.send(new CompleteMultipartUploadCommand({
          Bucket: bucket, Key: input.key, UploadId: uploadId, MultipartUpload: { Parts: parts },
          IfNoneMatch: "*",
        }), { abortSignal: signal });
        return { byteSize, checksum: checksum.digest("hex") };
      } catch (error) {
        // Cancellation of the caller must not cancel cleanup of the partial upload.
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: input.key, UploadId: uploadId }),
          { abortSignal: AbortSignal.timeout(CLEANUP_REQUEST_MS) }).catch(() => {});
        if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412) {
          throw new SourceObjectExistsError();
        }
        throw error;
      }
    },
    async read(key, maxBytes, signal) {
      const result = await readStoredObject(bucket, key, maxBytes, operationSignal(signal));
      // Source writes reject empty bodies. A zero-byte object is a retirement barrier.
      if (result.bytes.byteLength === 0) throw new ObjectNotFoundError(key);
      return result;
    },
    async stat(key, signal) {
      signal = operationSignal(signal);
      signal.throwIfAborted();
      try {
        const head = await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
        if (head.ContentLength === 0 && head.Metadata?.["source-deleted"] === "true") return null;
        if (head.ContentLength === undefined || !head.LastModified) throw new Error("Source object metadata is incomplete");
        return { byteSize: head.ContentLength, mimeType: head.ContentType ?? "application/octet-stream",
          storedAt: head.LastModified.toISOString() };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async delete(key) {
      // Keep the key occupied so an in-flight create-only multipart completion cannot
      // resurrect its bytes after deletion, even if that writer crashes before cleanup.
      await getS3Client().send(new PutObjectCommand({ Bucket: bucket, Key: key,
        Body: new Uint8Array(0), ContentLength: 0, ContentType: "application/octet-stream",
        CacheControl: "private, no-store", Metadata: { "source-deleted": "true" },
      }), { abortSignal: AbortSignal.timeout(CLEANUP_REQUEST_MS) });
    },
  };
}
