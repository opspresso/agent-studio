import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { CreateBucketCommand, DeleteBucketCommand, ListMultipartUploadsCommand } from "@aws-sdk/client-s3";

/** Isolated, disposable bucket against the local Compose MinIO, never an operator bucket. */
async function main() {
  const endpoint = new URL(process.env.STORAGE_TEST_ENDPOINT ?? "http://127.0.0.1:9000");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "Storage checks require a local endpoint");
  process.env.S3_ENDPOINT = endpoint.href;
  process.env.S3_ACCESS_KEY_ID = process.env.STORAGE_TEST_ACCESS_KEY ?? "agent_studio";
  process.env.S3_SECRET_ACCESS_KEY = process.env.STORAGE_TEST_SECRET_KEY ?? "agent_studio_secret";
  const { createSourceObjectStore } = await import("@/infrastructure/storage/sourceObjectStore");
  const { getS3Client } = await import("@/infrastructure/storage/s3ObjectStore");
  const client = getS3Client();
  const bucket = `source-storage-${randomUUID()}-test`;
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  const objects = createSourceObjectStore(bucket);
  try {
    const bytes = new Uint8Array(5 * 1024 * 1024 + 42).fill(17);
    const body = async function* () { yield bytes.subarray(0, 123); yield bytes.subarray(123); };
    const receipt = await objects.write({ key: "source", body: body(), mimeType: "audio/mpeg", maxBytes: bytes.length });
    assert.equal(receipt.byteSize, bytes.length);
    assert.equal(receipt.checksum, createHash("sha256").update(bytes).digest("hex"));
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
    await assert.rejects(objects.read("source", bytes.length), { name: "ObjectNotFoundError" });
    console.log("PASS source storage: multipart integrity, conditional write, abort cleanup, private read and deletion");
  } finally {
    await objects.delete("source");
    await objects.delete("oversize");
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Source storage check failed");
  process.exitCode = 1;
});
