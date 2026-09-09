import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { assertLocalDatabase } from "./local-database";
import { sourceFileObjectKey } from "@/domain/artifact/sourceFile";

async function main() {
  process.env.STAGE = "local";
  process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio_test";
  assertLocalDatabase(process.env.DATABASE_URL, true);
  const memoryUrl = process.env.AUDIO_TEST_MEMORY_URL ? new URL(process.env.AUDIO_TEST_MEMORY_URL) : undefined;
  let memoryToken: string | undefined;
  if (memoryUrl) {
    assert.equal(memoryUrl.hostname, "localhost", "Memory checks require a disposable localhost server; IP literals do not qualify for the MCP host policy");
    assert.ok(process.env.AUDIO_TEST_MEMORY_TOKEN_FILE, "Provide the test MCP credential file");
    const credential = JSON.parse(await readFile(process.env.AUDIO_TEST_MEMORY_TOKEN_FILE, "utf8"));
    assert.equal(typeof credential.token, "string");
    memoryToken = credential.token;
    assert.ok(process.env.AUDIO_TEST_MEMORY_EMAIL?.endsWith("@example.test"), "Use a synthetic Memory fixture email");
    process.env.MCP_INTERNAL_HOST_SUFFIXES = memoryUrl.hostname;
  }
  const endpoint = new URL(process.env.STORAGE_TEST_ENDPOINT ?? "http://127.0.0.1:9000");
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
  process.env.S3_ENDPOINT = endpoint.href;
  process.env.S3_ACCESS_KEY_ID = process.env.STORAGE_TEST_ACCESS_KEY ?? "agent_studio";
  process.env.S3_SECRET_ACCESS_KEY = process.env.STORAGE_TEST_SECRET_KEY ?? "agent_studio_secret";
  process.env.AES_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  const bucket = `audio-pipeline-${randomUUID()}-test`;
  process.env.SOURCE_FILES_BUCKET_NAME = bucket;
  let calls = 0;
  let postprocessCalls = 0;
  const mock = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    const body = Buffer.concat(buffers);
    if (request.url === "/v1/chat/completions") {
      const input = JSON.parse(body.toString("utf-8"));
      assert.ok((input.tools ?? []).every((tool: { function: { name: string } }) => tool.function.name === "Skill"), "postprocessing must not receive effectful tools");
      postprocessCalls += 1;
      const content = JSON.stringify({ text: "Summary of sample", memories: [
        { kind: "fact", title: "Sample", content: "Sample transcript", evidence: ["Sample transcript"] },
      ], warnings: [] });
      response.setHeader("content-type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n` +
        "data: [DONE]\n\n");
      return;
    }
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
  process.env.LLM_BASE_URL = process.env.TRANSCRIPTION_BASE_URL;
  process.env.LLM_API_KEY = "test";
  process.env.LLM_PROVIDER_OPENAI_BASE_URL = process.env.TRANSCRIPTION_BASE_URL;
  process.env.LLM_PROVIDER_OPENAI_API_KEY = "test";
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { getAudioRuntime, mcpUseCases } = await import("@/lib/container");
  const { getS3Client, deleteStoredObject } = await import("@/infrastructure/storage/s3ObjectStore");
  const { projectRepository } = await import("@/infrastructure/db/repositories/projectRepository");
  const { versionRepository } = await import("@/infrastructure/db/repositories/versionRepository");
  const { getLlmChannelConfig, getLlmProviderConfigs } = await import("@/lib/runtime-settings");
  const { resolveProviderTarget } = await import("@/infrastructure/llm/providers");
  assert.equal(resolveProviderTarget("openai/gpt-5-mini", await getLlmProviderConfigs(), await getLlmChannelConfig()).baseUrl,
    process.env.TRANSCRIPTION_BASE_URL, "pipeline checks must use the local mock channel");
  const { withTransaction, closePool } = await import("@/infrastructure/db/client");
  const { deleteItem } = await import("@/infrastructure/db/store");
  const { keys } = await import("@/infrastructure/db/keys");
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const client = getS3Client();
  const id = randomUUID(); const email = memoryUrl ? process.env.AUDIO_TEST_MEMORY_EMAIL! : `${id}@example.test`; const projectName = `audio-${id}`;
  const memoryName = `memory-${id}`;
  let memoryRegistered = false;
  let userCreated = false;
  let projectCreated = false;
  const now = new Date().toISOString(); const directory = await mkdtemp(join(tmpdir(), "audio-pipeline-"));
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  try {
    await withTransaction(async (db) => { await db.query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "tier", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, 'member', $4, $4)`,
      [id, "Audio Pipeline Test", email, now]); });
    userCreated = true;
    await projectRepository.create({ name: projectName, ownerEmail: email, displayName: "Audio Pipeline Test",
      description: "", projectType: "agent", visibility: "private", createdAt: now, updatedAt: now });
    projectCreated = true;
    await versionRepository.create({ projectName, versionName: "writer", model: "openai/gpt-5-mini",
      systemPrompt: "Summarize the source.", userPromptTemplate: "", parameters: { piiFiltering: false, audioProcessing: true,
        dynamicCapabilities: true, memoryRecall: true, urlFetch: true, imageGeneration: true, slackWorkspace: true },
      skillList: [], mcpList: [{ name: "must-not-resolve" }], subagentList: [{ name: "must-not-run", type: "remote" }], createdAt: now });
    if (memoryUrl) {
      await mcpUseCases.create({ name: memoryName, url: memoryUrl.href, headers: { Authorization: `Bearer ${memoryToken}` } });
      memoryRegistered = true;
      const writer = await versionRepository.get(projectName, "writer"); assert.ok(writer);
      await versionRepository.create({ ...writer, versionName: "collector", mcpList: [{ name: memoryName }] });
      const project = await projectRepository.get(projectName); assert.ok(project);
      await projectRepository.publish({ ...project, publishedVersion: "collector" }, "collector", project.updatedAt);
    }
    const path = join(directory, "source.mp3");
    await promisify(execFile)(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-ar", "16000", "-ac", "1", path]);
    const bytes = await readFile(path);
    const runtime = getAudioRuntime();
    const retention = { unit: "months" as const, value: 3, timezone: "Asia/Seoul" };
    const file = await runtime.files.import({ id: randomUUID(), projectName, userEmail: email,
      filename: "source.mp3", mimeType: "audio/mpeg", retention }, async () => (async function* () { yield bytes; })());
    const input = { task: "process" as const, source: { kind: "file" as const, fileId: file.id }, model: "openai/whisper-1", retention,
      postprocess: { projectName, versionName: "writer" },
      ...(memoryUrl ? { destination: { serverName: memoryName, documents: true, memories: true } } : {}) };
    let configuration = await runtime.configuration.save(projectName, email, { enabled: true, model: input.model, retention,
      postprocess: input.postprocess, destination: input.destination, maxActive: 1, maxPerOccurrence: 1 }, 0);
    const edits = await Promise.allSettled([
      runtime.configuration.save(projectName, email, configuration, configuration.revision),
      runtime.configuration.save(projectName, email, configuration, configuration.revision),
    ]);
    const winners = edits.filter((edit) => edit.status === "fulfilled");
    assert.equal(winners.length, 1, "only one concurrent configuration edit may win");
    configuration = winners[0]!.value;
    const submitInput = { source: input.source, configRevision: configuration.revision };
    const submitted = await runtime.jobs.submit(projectName, email, submitInput, { occurrence: "test" });
    assert.ok("job" in submitted); assert.equal(submitted.status, "accepted");
    let completed = await runtime.process(projectName, submitted.job.id);
    const deadline = Date.now() + 90_000;
    while (completed?.status === "waiting" && Date.now() < deadline) {
      await delay(Math.max(1, Math.min(1000, Date.parse(completed.dueAt) - Date.now())));
      completed = await runtime.process(projectName, submitted.job.id) ?? completed;
    }
    assert.equal(completed?.status, "completed", JSON.stringify(completed));
    assert.equal(completed.configRevision, configuration.revision);
    const publicJob = await runtime.jobs.get(projectName, completed.id, email);
    assert.deepEqual(publicJob.fileInfo, { filename: file.filename, byteSize: file.byteSize, expiresAt: file.retireAt });
    assert.deepEqual(publicJob.transcriptionProgress, { processedSeconds: 1.5, totalSeconds: 1.5, completedSegments: 1 });
    assert.ok(completed.transcriptRef);
    if (!memoryUrl) {
      const result = await runtime.files.read(projectName, completed.transcriptRef, email);
      assert.equal(result.file.retireAt, file.retireAt);
      assert.equal(result.file.retainUntil, file.retireAt);
      const transcript = JSON.parse(new TextDecoder().decode(result.bytes));
      assert.equal(transcript.text, "Sample transcript");
      assert.equal(transcript.totalSeconds, 1.5);
      assert.ok(completed.draftRef);
      const draft = await runtime.files.read(projectName, completed.draftRef, email);
      assert.equal(draft.file.retireAt, file.retireAt);
      assert.equal(draft.file.retainUntil, file.retireAt);
      assert.equal(JSON.parse(new TextDecoder().decode(draft.bytes)).text, "Summary of sample");
    } else {
      assert.ok(completed.draftRef);
      assert.ok(completed.movedTo);
      await assert.rejects(runtime.files.read(projectName, completed.transcriptRef, email));
      await assert.rejects(runtime.files.read(projectName, completed.draftRef, email));
    }
    const remaining = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    assert.equal(remaining.IsTruncated, false);
    assert.deepEqual((remaining.Contents ?? []).filter((object) => object.Size !== 0).map((object) => object.Key).sort(), [sourceFileObjectKey(file.id),
      ...(!memoryUrl ? [sourceFileObjectKey(completed.transcriptRef), sourceFileObjectKey(completed.draftRef!)] : [])].sort());
    assert.equal(postprocessCalls, 1);
    assert.equal(calls, 1);
    assert.equal(postprocessCalls, 1);
    assert.equal((await runtime.jobs.submit(projectName, email, submitInput, { occurrence: "test-again" })).status, "duplicate");
    assert.equal(await runtime.process(projectName, completed.id), null);
    assert.equal(calls, 1);
    const usage = await usageRepository.getDay(projectName, new Date().toISOString().slice(0, 10));
    assert.equal(usage?.calls["openai/whisper-1"], 1);
    await assert.rejects(runtime.jobs.get(projectName, completed.id, "other@example.test"));
    if (memoryUrl) {
      assert.ok(completed.receipts["document:transcript"]);
      assert.ok(completed.receipts["document:result"]);
      assert.ok(completed.receipts["memory:0"]);
      console.log(`PASS Memory delivery: ${JSON.stringify({ jobId: completed.id, receipts: completed.receipts })}`);
    }
    console.log("PASS audio pipeline: PostgreSQL → MinIO → ffmpeg → ASR → grounded Agent output → usage and replay");
  } finally {
    const objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
    for (const object of objects.Contents ?? []) {
      if (!object.Key) continue;
      await deleteStoredObject(bucket, object.Key);
      if (object.Key.startsWith("source-files/")) await deleteItem(keys.sourceFile(decodeURIComponent(object.Key.slice("source-files/".length))));
    }
    if (projectCreated) await projectRepository.delete(projectName);
    if (memoryRegistered) await mcpUseCases.remove(memoryName, email);
    await deleteItem(keys.usageMember(email, now.slice(0, 10), projectName));
    await deleteItem(keys.usageMember(email, new Date().toISOString().slice(0, 10), projectName));
    if (userCreated) await withTransaction(async (db) => { await db.query(`DELETE FROM "user" WHERE "id" = $1`, [id]); });
    await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    client.destroy(); await closePool();
    await new Promise<void>((resolve) => mock.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Audio pipeline check failed"); process.exitCode = 1; });
