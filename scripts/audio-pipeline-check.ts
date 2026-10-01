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
import { withCheckLifecycle, type RegisterCheckCleanup } from "./check-lifecycle";
import { sourceFileObjectKey } from "@/domain/artifact/sourceFile";
import type { ArtifactUseCases } from "@/application/artifact/artifactUseCases";

async function main() {
  await withCheckLifecycle(runChecks);
  console.log("PASS audio pipeline: PostgreSQL → MinIO → ffmpeg → ASR → grounded Agent output → usage and replay");
}

async function runChecks(cleanup: RegisterCheckCleanup) {
  const diarized = process.argv.includes("--diarization");
  const asrWireId = diarized ? "gpt-4o-transcribe" : "whisper-1";
  const expectedAsrCalls = diarized ? 3 : 1;
  process.env.STAGE = "local";
  process.env.PUBLISHED_MODELS_REFRESH = "off";
  process.env.DATABASE_URL ??= "postgres://agent_studio:agent_studio@localhost:5432/agent_studio_test";
  assertLocalDatabase(process.env.DATABASE_URL, true);
  const { withTransaction, closePool } = await import("@/infrastructure/db/client");
  cleanup(closePool);
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
  process.env.S3_BUCKET_NAME = bucket;
  let calls = 0;
  let postprocessCalls = 0;
  let diarizationCalls = 0;
  let mockFailure: unknown;
  const assertMockSucceeded = () => { if (mockFailure !== undefined) throw mockFailure; };
  const mock = createServer((request, response) => {
    const respond = async () => {
      const buffers: Buffer[] = [];
      for await (const chunk of request) buffers.push(Buffer.from(chunk));
      const body = Buffer.concat(buffers);
      if (request.url === "/diarize") {
        assert.equal(request.headers.authorization, "Bearer synthetic-diarization-token");
        assert.equal(request.headers["content-type"], "audio/mpeg");
        assert.ok(body.length > 0);
        diarizationCalls++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ duration: 1.5, revision: "fixture-v1", warnings: [], turns: [
          { start: 0, end: 0.5, speaker: "SPEAKER_00" },
          { start: 0.5, end: 1, speaker: "SPEAKER_01" },
          { start: 1, end: 1.5, speaker: "SPEAKER_00" },
        ] }));
        return;
      }
      if (request.url === "/v1/chat/completions") {
        const input = JSON.parse(body.toString("utf-8"));
        if (diarized) {
          const source = JSON.parse(JSON.parse(input.messages.at(-1).content).source);
          assert.deepEqual(source.filter((entry: { kind: string }) => entry.kind === "segment")
            .map((entry: { speaker: string }) => entry.speaker), ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"]);
        }
        assert.ok((input.tools ?? []).every((tool: { function: { name: string } }) => tool.function.name === "Skill"), "postprocessing must not receive effectful tools");
        postprocessCalls += 1;
        const content = input.response_format?.type === "json_schema" ? JSON.stringify({ text: "Summary of sample", memories: [
          { kind: "fact", title: "Sample", content: "Sample transcript", evidence: ["Sample transcript"] },
        ], warnings: [] }) : "Summary of sample";
        response.setHeader("content-type", "text/event-stream");
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n` +
          "data: [DONE]\n\n");
        return;
      }
      assert.ok(request.headers["content-type"]?.startsWith("multipart/form-data"));
      assert.ok(body.includes(Buffer.from(asrWireId)));
      assert.ok(body.includes(Buffer.from("RIFF")));
      calls += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ text: "Sample transcript", usage: { type: "tokens", seconds: diarized ? 0.5 : 1.5,
        input_tokens: 10, output_tokens: 5 } }));
    };
    void respond().catch((error: unknown) => {
      if (mockFailure === undefined) mockFailure = error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  cleanup(async () => {
    if (mock.listening) await new Promise<void>((resolve, reject) => mock.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    mock.once("error", onError);
    mock.listen(0, "127.0.0.1", () => { mock.off("error", onError); resolve(); });
  });
  const address = mock.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  process.env.TRANSCRIPTION_RESPONSE_FORMAT = "json";
  process.env.TRANSCRIPTION_CHUNKING_STRATEGY = "";
  process.env.TRANSCRIPTION_SEGMENT_SECONDS = "300";
  process.env.DIARIZATION_BASE_URL = diarized ? `http://127.0.0.1:${address.port}` : "";
  process.env.DIARIZATION_TOKEN = "synthetic-diarization-token";
  process.env.DIARIZATION_REVISION = "fixture-v1";
  const { migrate } = await import("@/infrastructure/db/migrations");
  await migrate();
  const { settingsRepository } = await import("@/infrastructure/db/repositories/settingsRepository");
  const previousSettings = await settingsRepository.get();
  cleanup(async () => {
    if (previousSettings) await settingsRepository.update(() => previousSettings);
    else {
      const { deleteItem } = await import("@/infrastructure/db/store");
      const { keys } = await import("@/infrastructure/db/keys");
      await deleteItem(keys.settings());
    }
  });
  const { encryptSecret } = await import("@/infrastructure/crypto/secretEncryption");
  const { llmProviderApiKeyContext } = await import("@/domain/security/secretContext");
  await settingsRepository.update(current => ({ ...current,
    llmProviders: [{ name: "openai", baseUrl, apiKey: encryptSecret("test", llmProviderApiKeyContext("openai", baseUrl)) }],
    registeredModels: ["gpt-5-mini", asrWireId].map(wireId => ({
      id: `openai/${wireId}`, provider: "openai", wireId, displayName: wireId,
      type: wireId === asrWireId ? "transcription" as const : "text" as const,
      contextWindow: 128000, maxTokens: wireId === asrWireId ? 0 : 4000,
      capabilities: { tools: wireId !== asrWireId, structuredOutput: true, imageInput: false, reasoning: false },
      pricing: { inputPer1M: diarized ? 2.5 : 0, outputPer1M: diarized ? 10 : 0, ...(wireId === "whisper-1" ? { perAudioMinute: 0 } : {}) },
    })), updatedAt: new Date().toISOString(),
  }));

  const { getAudioRuntime, mcpUseCases, artifactUseCases } = await import("@/lib/container");
  const { artifactRepository } = await import("@/infrastructure/db/repositories/artifactRepository");
  const { getS3Client, deleteStoredObject } = await import("@/infrastructure/storage/s3ObjectStore");
  const { agentRepository } = await import("@/infrastructure/db/repositories/agentRepository");
  const { getLlmProviderConfigs } = await import("@/lib/runtime-settings");
  const { resolveProviderTarget } = await import("@/infrastructure/llm/providers");
  assert.equal(resolveProviderTarget("openai/gpt-5-mini", await getLlmProviderConfigs()).baseUrl,
    baseUrl, "pipeline checks must use the local mock channel");
  const { deleteItem } = await import("@/infrastructure/db/store");
  const { keys } = await import("@/infrastructure/db/keys");
  const { usageRepository } = await import("@/infrastructure/db/repositories/usageRepository");
  const client = getS3Client();
  cleanup(() => client.destroy());
  const id = randomUUID(); const email = memoryUrl ? process.env.AUDIO_TEST_MEMORY_EMAIL! : `${id}@example.test`; const agentName = `audio-${id}`;
  const memoryName = `memory-${id}`;
  let memoryRegistered = false;
  const now = new Date().toISOString();
  const directory = await mkdtemp(join(tmpdir(), "audio-pipeline-"));
  cleanup(() => rm(directory, { recursive: true, force: true }));
  const sourceFileIds = new Set<string>();
  cleanup(async () => {
    try { await client.send(new DeleteBucketCommand({ Bucket: bucket })); }
    catch (error) { if (!(error instanceof Error) || error.name !== "NoSuchBucket") throw error; }
  });
  cleanup(async () => {
    await withCheckLifecycle(async remove => {
      const knownKeys = new Set([...sourceFileIds].map(sourceFileObjectKey));
      for (const key of knownKeys) remove(() => deleteStoredObject(bucket, key));
      let objects;
      try { objects = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 })); }
      catch (error) {
        if (error instanceof Error && error.name === "NoSuchBucket") return;
        throw error;
      }
      assert.equal(objects.IsTruncated, false, "fixture object cleanup must cover the whole bucket");
      for (const object of objects.Contents ?? []) {
        if (object.Key && !knownKeys.has(object.Key)) {
          const key = object.Key;
          remove(() => deleteStoredObject(bucket, key));
        }
      }
    });
  });
  // Inventory survives byte retirement; track every import before its first write.
  const runtime = getAudioRuntime();
  const importFile = runtime.files.import;
  runtime.files.import = async (...args) => { sourceFileIds.add(args[0].id); return importFile(...args); };
  cleanup(() => { runtime.files.import = importFile; });
  cleanup(async () => {
    await withCheckLifecycle(async remove => {
      for (const fileId of sourceFileIds) {
        remove(() => artifactRepository.delete(fileId));
        remove(() => deleteItem(keys.sourceFile(fileId)));
      }
    });
  });
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  await withTransaction(async (db) => { await db.query(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "tier", "createdAt", "updatedAt") VALUES ($1, $2, $3, true, 'member', $4, $4)`,
    [id, "Audio Pipeline Test", email, now]); });
  cleanup(() => withTransaction(async db => { await db.query(`DELETE FROM "user" WHERE "id" = $1`, [id]); }));
  cleanup(async () => { if (memoryRegistered) await mcpUseCases.remove(memoryName, email); });
  await agentRepository.create({ name: agentName, ownerEmail: email, displayName: "Audio Pipeline Test",
    description: "", visibility: "private", createdAt: now, updatedAt: now,
    configuration: { agentName, model: "openai/gpt-5-mini",
    systemPrompt: "Summarize the source.", parameters: { piiFiltering: false, audioProcessing: true,
      dynamicCapabilities: true, memoryRecall: true, urlFetch: true, imageGeneration: true, slackWorkspace: true },
    skillList: [], mcpList: [{ name: "must-not-resolve" }], subagentList: [{ name: "must-not-run" }] } });
  cleanup(() => agentRepository.delete(agentName));
  cleanup(() => deleteItem(keys.usageMember(email, now.slice(0, 10), agentName)));
  cleanup(() => deleteItem(keys.usageMember(email, new Date().toISOString().slice(0, 10), agentName)));
  if (memoryUrl) {
    await mcpUseCases.create({ name: memoryName, url: memoryUrl.href, headers: { Authorization: `Bearer ${memoryToken}` } });
    memoryRegistered = true;
    const agent = await agentRepository.get(agentName); assert.ok(agent?.configuration);
    await agentRepository.update({ ...agent, configuration: { ...agent.configuration, mcpList: [{ name: memoryName }] } }, agent.updatedAt);
  }
  const path = join(directory, "source.mp3");
  await promisify(execFile)(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5", "-c:a", "libopus", "-f", "ogg", path]);
  const bytes = await readFile(path);
  const retention = { unit: "months" as const, value: 3, timezone: "Asia/Seoul" };
  const file = await runtime.files.import({ id: randomUUID(), agentName, userEmail: email,
    filename: "source.mp3", mimeType: "audio/mpeg", retention }, async () => (async function* () { yield bytes; })());
  const input = { task: "process" as const, source: { kind: "file" as const, fileId: file.id }, model: `openai/${asrWireId}`, retention,
    postprocess: { agentName },
    ...(memoryUrl ? { destination: { serverName: memoryName, documents: true, memories: true } } : {}) };
  let configuration = await runtime.configuration.save(agentName, email, { enabled: true, model: input.model, retention,
    postprocess: input.postprocess, destination: input.destination, maxActive: 1, maxPerOccurrence: 1 }, 0);
  const edits = await Promise.allSettled([
    runtime.configuration.save(agentName, email, configuration, configuration.revision),
    runtime.configuration.save(agentName, email, configuration, configuration.revision),
  ]);
  const winners = edits.filter((edit) => edit.status === "fulfilled");
  assert.equal(winners.length, 1, "only one concurrent configuration edit may win");
  configuration = winners[0]!.value;
  const submitInput = { source: input.source, configRevision: configuration.revision };
  const submitted = await runtime.jobs.submit(agentName, email, submitInput, { occurrence: "test" });
  assert.ok("job" in submitted); assert.equal(submitted.status, "accepted");
  let completed = await runtime.process(agentName, submitted.job.id);
  assertMockSucceeded();
  const deadline = Date.now() + 90_000;
  while (completed?.status === "waiting" && Date.now() < deadline) {
    await delay(Math.max(1, Math.min(1000, Date.parse(completed.dueAt) - Date.now())));
    completed = await runtime.process(agentName, submitted.job.id) ?? completed;
    assertMockSucceeded();
  }
  assert.equal(completed?.status, "completed", JSON.stringify(completed));
  assert.equal(completed.configRevision, configuration.revision);
  const publicJob = await runtime.jobs.get(agentName, completed.id, email);
  assert.deepEqual(publicJob.fileInfo, { filename: file.filename, byteSize: file.byteSize, expiresAt: file.retireAt });
  assert.deepEqual(publicJob.transcriptionProgress, { processedSeconds: 1.5, totalSeconds: 1.5, completedSegments: expectedAsrCalls });
  assert.ok(completed.transcriptRef);
  {
    const result = await runtime.files.read(agentName, completed.transcriptRef, email);
    assert.equal(result.file.retireAt, file.retireAt);
    assert.equal(result.file.retainUntil, file.retireAt);
    const transcript = JSON.parse(new TextDecoder().decode(result.bytes));
    assert.equal(transcript.text, Array(expectedAsrCalls).fill("Sample transcript").join("\n"));
    if (diarized) assert.deepEqual(transcript.segments, [
      { text: "Sample transcript", start: 0, end: 0.5, speaker: "SPEAKER_00" },
      { text: "Sample transcript", start: 0.5, end: 1, speaker: "SPEAKER_01" },
      { text: "Sample transcript", start: 1, end: 1.5, speaker: "SPEAKER_00" },
    ]);
    assert.equal(transcript.totalSeconds, 1.5);
    assert.ok(completed.draftRef);
    const draft = await runtime.files.read(agentName, completed.draftRef, email);
    assert.equal(draft.file.retireAt, file.retireAt);
    assert.equal(draft.file.retainUntil, file.retireAt);
    assert.equal(JSON.parse(new TextDecoder().decode(draft.bytes)).text, "Summary of sample");
  }
  assert.ok(completed.summaryRef); assert.ok(completed.dialogueRef); assert.ok(completed.draftRef);
  const finalIds = [file.id, completed.transcriptRef, completed.draftRef, completed.summaryRef, completed.dialogueRef];
  assert.ok(artifactUseCases);
  const artifacts = await artifactUseCases.listMine(email, { limit: 100 });
  assert.deepEqual(artifacts.filter((a) => a.agentName === agentName).map((a) => a.artifactId).sort(), [...finalIds].sort());
  for (const id of finalIds) {
    const result: Awaited<ReturnType<ArtifactUseCases["readPrivateFile"]>> = await artifactUseCases.readPrivateFile(id, email);
    assert.equal(result.artifact.retireAt, file.retireAt);
    assert.ok(result.bytes.length);
    await assert.rejects(artifactUseCases.readPrivateFile(id, "other@example.test"));
  }
  const anonymous = await fetch(new URL(`${bucket}/${sourceFileObjectKey(file.id)}`, endpoint));
  await anonymous.body?.cancel();
  assert.equal(anonymous.status, 403, "private artifacts in the shared bucket reject anonymous reads");
  const remaining = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
  assert.equal(remaining.IsTruncated, false);
  assert.deepEqual((remaining.Contents ?? []).filter((object) => object.Size !== 0).map((object) => object.Key).sort(), finalIds.map(sourceFileObjectKey).sort());
  assert.equal(calls, expectedAsrCalls);
  assert.equal(diarizationCalls, diarized ? 1 : 0);
  assert.equal(postprocessCalls, 1);
  assert.equal((await runtime.jobs.submit(agentName, email, submitInput, { occurrence: "test-again" })).status, "duplicate");
  assert.equal(await runtime.process(agentName, completed.id), null);
  assert.equal(calls, expectedAsrCalls);
  const usage = await usageRepository.getDay(agentName, new Date().toISOString().slice(0, 10));
  assert.equal(usage?.calls[`openai/${asrWireId}`], expectedAsrCalls);
  await assert.rejects(runtime.jobs.get(agentName, completed.id, "other@example.test"));
  if (memoryUrl) {
    assert.ok(completed.receipts["document:transcript"]);
    assert.ok(completed.receipts["document:result"]);
    assert.ok(completed.receipts["memory:0"]);
    console.log(`PASS Memory delivery: ${JSON.stringify({ jobId: completed.id, receipts: completed.receipts })}`);
  }
  const previousMode = process.env.ARTIFACT_ACCESS_MODE;
  let opened = false;
  try {
    process.env.ARTIFACT_ACCESS_MODE = "public";
    await assert.rejects(runtime.files.import({ id: `${id}-refused`, agentName, userEmail: email,
      filename: "refused.mp3", mimeType: "audio/mpeg", retention: file.retention }, async () => {
      opened = true; return (async function* () { yield bytes; })();
    }), /Private Artifacts require/);
    assert.equal(opened, false, "storage policy is checked before opening source bytes");
  } finally {
    if (previousMode === undefined) delete process.env.ARTIFACT_ACCESS_MODE;
    else process.env.ARTIFACT_ACCESS_MODE = previousMode;
  }
}
main().catch((error: unknown) => { console.error("AUDIO PIPELINE FAILURE:", error); process.exitCode = 1; });
