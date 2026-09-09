import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, ListMultipartUploadsCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from "@aws-sdk/client-s3";

/** Isolated, disposable bucket against the local Compose MinIO, never an operator bucket. */
async function main() {
  const endpoint = new URL(process.env.STORAGE_TEST_ENDPOINT ?? "http://127.0.0.1:9000");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "Storage checks require a local endpoint");
  process.env.S3_ENDPOINT = endpoint.href;
  process.env.S3_ACCESS_KEY_ID = process.env.STORAGE_TEST_ACCESS_KEY ?? "agent_studio";
  process.env.S3_SECRET_ACCESS_KEY = process.env.STORAGE_TEST_SECRET_KEY ?? "agent_studio_secret";
  const { createSourceObjectStore } = await import("@/infrastructure/storage/sourceObjectStore");
  const { getS3Client, deleteStoredObject } = await import("@/infrastructure/storage/s3ObjectStore");
  const client = getS3Client();
  const bucket = `source-storage-${randomUUID()}-test`;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  const objects = createSourceObjectStore(bucket);
  let lateUploadId: string | undefined;
  try {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 42).fill(17);
    const body = async function* () { yield bytes.subarray(0, 123); yield bytes.subarray(123); };
    const receipt = await objects.write({ key: "source", body: body(), mimeType: "audio/mpeg", maxBytes: bytes.length });
    assert.equal(receipt.byteSize, bytes.length);
    assert.equal(receipt.checksum, createHash("sha256").update(bytes).digest("hex"));
    const metadata = await objects.stat("source");
    assert.equal(metadata?.byteSize, bytes.length);
    assert.equal(metadata?.mimeType, "audio/mpeg");
    assert.ok(metadata?.storedAt);
    const read = await objects.read("source", bytes.length);
    assert.equal(read.mimeType, "audio/mpeg");
    assert.deepEqual(read.bytes, Buffer.from(bytes));
    await assert.rejects(objects.write({ key: "source", body: body(), mimeType: "audio/mpeg", maxBytes: bytes.length }),
      { name: "SourceObjectExistsError" });
    await assert.rejects(objects.write({ key: "oversize", body: body(), mimeType: "audio/mpeg", maxBytes: 10 }));
    const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: bucket }));
    assert.equal(uploads.Uploads?.length ?? 0, 0, "failed writes leave no multipart uploads");
    const anonymous = await fetch(new URL(`${bucket}/source`, endpoint.href.endsWith("/") ? endpoint : `${endpoint}/`));
    await anonymous.body?.cancel();
    assert.equal(anonymous.status, 403, "source bucket must not allow anonymous reads");
    await objects.delete("source");
    await objects.delete("source");
    assert.equal(await objects.stat("source"), null);
    await assert.rejects(objects.read("source", bytes.length), { name: "ObjectNotFoundError" });
    const late = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: "late", ContentType: "audio/mpeg" }));
    lateUploadId = late.UploadId;
    assert.ok(lateUploadId);
    const part = await client.send(new UploadPartCommand({ Bucket: bucket, Key: "late", UploadId: lateUploadId,
      PartNumber: 1, Body: new Uint8Array([1]), ContentLength: 1 }));
    await objects.delete("late");
    await assert.rejects(client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: "late", UploadId: lateUploadId,
      IfNoneMatch: "*", MultipartUpload: { Parts: [{ PartNumber: 1, ETag: part.ETag }] } })),
    (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412);
    assert.equal(await objects.stat("late"), null, "a delayed upload must not resurrect deleted audio");
    console.log("PASS source storage: multipart integrity, conditional write, abort cleanup, private read and deletion");
  } finally {
    if (lateUploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: "late", UploadId: lateUploadId })).catch(() => {});
    for (const key of ["source", "oversize", "late"]) await deleteStoredObject(bucket, key);
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Source storage check failed");
  process.exitCode = 1;
});
