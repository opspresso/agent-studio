import type { AudioJob } from "@/domain/audio/job";
import { audioSourceProject } from "@/domain/audio/job";
import type { AudioPostprocessOutput } from "@/domain/audio/output";
import type { createSourceFileUseCases } from "@/application/artifact/sourceFiles";
import { AudioJobStepError, type AudioJobStepContext } from "./processJob";
import { MAX_TRANSCRIPT_BYTES, type AudioTranscript } from "./transcribeFile";
import { parseAudioPostprocessOutput } from "./postprocess";

export interface AudioDeliveryDeps {
  files: ReturnType<typeof createSourceFileUseCases>;
  open(job: AudioJob, signal: AbortSignal): Promise<{
    call(tool: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
  }>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudioJobStepError("delivery_response_invalid", false);
  return value as Record<string, unknown>;
}
function document(value: unknown) {
  const doc = record(record(value).document);
  if (typeof doc.id !== "string" || !doc.id || doc.id.length > 256 || !["pending", "processing", "ready", "failed"].includes(String(doc.status)) ||
    typeof doc.processingAttempts !== "number" || !Number.isSafeInteger(doc.processingAttempts) || doc.processingAttempts < 0) {
    throw new AudioJobStepError("delivery_response_invalid", false);
  }
  return { id: doc.id, status: String(doc.status), attempts: doc.processingAttempts };
}

export function createAudioDeliveryStep(deps: AudioDeliveryDeps) {
  return async (job: AudioJob, context: AudioJobStepContext) => {
    if (!job.destination || !job.transcriptRef) throw new AudioJobStepError("delivery_configuration_missing", false);
    const source = await deps.files.read(job.projectName, job.transcriptRef, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
    const transcript = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(source.bytes)) as AudioTranscript;
    if (typeof transcript.text !== "string") throw new AudioJobStepError("transcript_invalid", false);
    let output: AudioPostprocessOutput | undefined;
    if (job.draftRef) {
      const draft = await deps.files.read(job.projectName, job.draftRef, job.userEmail, MAX_TRANSCRIPT_BYTES, context.signal);
      output = parseAudioPostprocessOutput(new TextDecoder("utf-8", { fatal: true }).decode(draft.bytes), transcript.text, MAX_TRANSCRIPT_BYTES);
    }
    const receipts = { ...job.receipts };
    const save = async (key: string, value: string) => {
      receipts[key] = value;
      await context.record({ receipts });
    };
    const sourceUri = `urn:agent-studio:audio-job:${job.id}`;
    const filename = job.fileId ? (await deps.files.metadata(audioSourceProject(job), job.fileId, job.userEmail)).filename : job.id;
    const metadata = { jobId: job.id, sourceFileId: job.fileId, model: transcript.model,
      sourceChecksum: transcript.sourceChecksum, coverage: transcript.coverage, sourceIdentity: job.sourceIdentity,
      ...(job.postprocess ? { postprocess: { projectName: job.postprocess.projectName,
        versionName: job.postprocess.versionName, model: job.postprocess.version?.model } } : {}) };
    const client = await deps.open(job, context.signal);
    try {
      let ready = true;
      if (job.destination.documents) {
        const documents = [{ key: "transcript", title: `${filename} — Transcript`, content: transcript.text },
          ...(output ? [{ key: "result", title: `${filename} — Processed audio`, content: output.text }] : [])];
        for (const item of documents) {
          context.signal.throwIfAborted();
          const key = `document:${item.key}`;
          let doc;
          if (!receipts[key]) {
            doc = document(await client.call("document_ingest", { idempotencyKey: `${job.id}:${key}`,
              title: item.title, content: item.content, mimeType: "text/markdown", sourceUri, metadata, scope: { kind: "user" } }));
            await save(key, doc.id);
          } else doc = document(await client.call("document_ingest_status", { documentId: receipts[key] }));
          if (doc.id !== receipts[key]) throw new AudioJobStepError("delivery_response_invalid", false);
          if (doc.status !== "ready") ready = false;
          if (doc.status === "failed" && receipts[`retried-at:${item.key}`] !== String(doc.attempts)) {
            const retries = Number(receipts[`retry-count:${item.key}`] ?? 0);
            if (retries >= 4 || doc.attempts >= 5) throw new AudioJobStepError("document_processing_failed", false);
            await client.call("document_ingest_retry", { documentId: doc.id, expectedAttempts: doc.attempts,
              idempotencyKey: `${job.id}:${key}:retry-attempt:${doc.attempts}` });
            receipts[`retry-count:${item.key}`] = String(retries + 1);
            receipts[`retried-at:${item.key}`] = String(doc.attempts);
            await context.record({ receipts });
          }
        }
      }
      if (!ready) return { ready: false, receipts };
      if (job.destination.memories) {
        if (!output) throw new AudioJobStepError("memory_candidates_missing", false);
        for (const [index, candidate] of output.memories.entries()) {
          const key = `memory:${index}`;
          if (receipts[key]) continue;
          context.signal.throwIfAborted();
          const response = record(await client.call("remember", { idempotencyKey: `${job.id}:${key}`,
            kind: candidate.kind, title: candidate.title, content: candidate.content, scope: { kind: "user" },
            source: { type: "agent", uri: sourceUri, metadata: { ...metadata, evidence: candidate.evidence,
              ...(receipts["document:result"] ? { documentId: receipts["document:result"] } : {}) } } }));
          const memory = record(response.memory);
          if (typeof memory.id !== "string" || !memory.id || memory.id.length > 256) throw new AudioJobStepError("delivery_response_invalid", false);
          await save(key, memory.id);
        }
      }
      return { ready: true, receipts };
    } finally { await client.close(); }
  };
}
