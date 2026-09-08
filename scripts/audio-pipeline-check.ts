import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { assertLocalDatabase } from "./local-database";

async function main() {
  process.env.STAGE = "local";
  process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio_test";
  assertLocalDatabase(process.env.DATABASE_URL, true);
  const endpoint = new URL(process.env.STORAGE_TEST_ENDPOINT ?? "http://127.0.0.1:9000");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
  process.env.S3_ENDPOINT = endpoint.href;
  process.env.S3_ACCESS_KEY_ID = process.env.STORAGE_TEST_ACCESS_KEY ?? "agent_studio";
  process.env.S3_SECRET_ACCESS_KEY = process.env.STORAGE_TEST_SECRET_KEY ?? "agent_studio_secret";
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const bucket = `audio-pipeline-${randomUUID()}-test`;
  process.env.SOURCE_FILES_BUCKET_NAME = bucket;
  let calls = 0;
  const mock = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const body = Buffer.concat(buffers);
    assert.ok(request.headers["content-type"]?.startsWith("multipart/form-data"));
    assert.ok(body.includes(Buffer.from("whisper-1")));
    assert.ok(body.includes(Buffer.from("RIFF")));
    calls += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ text: "Sample transcript", usage: { type: "duration", seconds: 1.5 } }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); assert.ok(address && typeof address !== "string");
  process.env.TRANSCRIPTION_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.TRANSCRIPTION_API_KEY = "test";
  process.env.TRANSCRIPTION_RESPONSE_FORMAT = "json";
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { getAudioRuntime } = await import("@/lib/container");
  const { getS3Client, deleteStoredObject } = await import("@/infrastructure/storage/s3ObjectStore");
  const { projectRepository } = await import("@/infrastructure/db/repositories/projectRepository");
  const { withTransaction, closePool } = await import("@/infrastructure/db/client");
  const { deleteItem } = await import("@/infrastructure/db/store");
  const { keys } = await import("@/infrastructure/db/keys");
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const client = getS3Client();
  const id = randomUUID(); const email = `${id}@example.test`; const projectName = `audio-${id}`;
  const now = new Date().toISOString(); const directory = await mkdtemp(join(tmpdir(), "audio-pipeline-"));
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  try {
    await withTransaction(async (db) => { await db.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "tier", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, 'member', $4, $4)`,
      [id, "Audio Pipeline Test", email, now]); });
    await projectRepository.create({ name: projectName, ownerEmail: email, displayName: "Audio Pipeline Test",
      description: "", projectType: "agent", visibility: "private", createdAt: now, updatedAt: now });
    const path = join(directory, "source.mp3");
    await promisify(execFile)(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-ar", "16000", "-ac", "1", path]);
    const bytes = await readFile(path);
    const runtime = getAudioRuntime();
    const retention = { unit: "months" as const, value: 3, timezone: "Asia/Seoul" };
    const file = await runtime.files.import({ id: randomUUID(), projectName, userEmail: email,
      filename: "source.mp3", mimeType: "audio/mpeg", retention }, async () => (async function* () { yield bytes; })());
    const input = { task: "transcribe" as const, source: { kind: "file" as const, fileId: file.id }, model: "openai/whisper-1", retention };
    const submitted = await runtime.jobs.submit(projectName, email, input, { occurrence: "test" });
    assert.ok("job" in submitted); assert.equal(submitted.status, "accepted");
    const completed = await runtime.process(projectName, submitted.job.id);
    assert.equal(completed?.status, "completed", JSON.stringify(completed));
    assert.ok(completed.transcriptRef);
    const result = await runtime.files.read(projectName, completed.transcriptRef, email);
    const transcript = JSON.parse(new TextDecoder().decode(result.bytes));
    assert.equal(transcript.text, "Sample transcript");
    assert.equal(transcript.totalSeconds, 1.5);
    assert.equal(calls, 1);
    assert.equal((await runtime.jobs.submit(projectName, email, input, { occurrence: "test-again" })).status, "duplicate");
    assert.equal(await runtime.process(projectName, completed.id), null);
    assert.equal(calls, 1);
    const usage = await usageRepository.getDay(projectName, new Date().toISOString().slice(0, 10));
    assert.equal(usage?.calls["openai/whisper-1"], 1);
    await assert.rejects(runtime.jobs.get(projectName, completed.id, "other@example.test"));
    console.log("PASS audio pipeline: PostgreSQL admission → MinIO source → ffmpeg → multipart ASR → durable transcript → usage and replay");
  } finally {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    for (const object of objects.Contents ?? []) {
      if (!object.Key) continue;
      await deleteStoredObject(bucket, object.Key);
      if (object.Key.startsWith("source-files/")) await deleteItem(keys.sourceFile(decodeURIComponent(object.Key.slice("source-files/".length))));
    }
    await projectRepository.delete(projectName);
    await deleteItem(keys.usageMember(email, now.slice(0, 10), projectName));
    await deleteItem(keys.usageMember(email, new Date().toISOString().slice(0, 10), projectName));
    await withTransaction(async (db) => { await db.query(`DELETE FROM "user" WHERE "id" = $1`, [id]); });
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy(); await closePool();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Audio pipeline check failed"); process.exitCode = 1; });
