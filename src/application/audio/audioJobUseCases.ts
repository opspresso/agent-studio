import { createHash } from "node:crypto";
import type { AudioJob, AudioJobRepository, AudioSource } from "@/domain/audio/job";
import type { FileRetention } from "@/domain/artifact/retention";
import type { SourceFileRepository } from "@/domain/artifact/sourceFile";
import type { RunActor } from "@/domain/execution/actor";
import { getModelConfig } from "@/domain/llm/models";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "@/application/artifact/fileRetention";

export interface SubmitAudioJobInput {
  task?: "import" | "transcribe" | "process";
  source: AudioSource;
  model?: string;
  language?: string;
  retention: FileRetention;
  /** An explicit new revision opts into reprocessing the same source. */
  processingRevision?: string;
  postprocess?: AudioJob["postprocess"];
  destination?: AudioJob["destination"];
}

export interface AudioJobUseCaseDeps {
  jobs: AudioJobRepository;
  files: Pick<SourceFileRepository, "get">;
  sourceIdentity(project: string, id: string, email: string): Promise<{ namespace: string; itemId: string }>;
  authorize(project: string, email: string): Promise<void>;
  validateModel(model: string): Promise<void>;
  validateOutputs(input: SubmitAudioJobInput, project: string, email: string): Promise<void>;
  limits(project: string): Promise<{ maxActive: number; maxPerOccurrence: number }>;
  now(): Date;
  id(): string;
}

/** Public view: source credentials, ownership data and internal receipt paths stay server-side. */
export type AudioJobView = Pick<AudioJob, "id" | "status" | "stage" | "model" | "createdAt" | "updatedAt" |
  "dueAt" | "attempt" | "failures" | "fileId" | "transcriptRef" | "draftRef" | "receipts" | "errorCode" | "revision">;

function view(job: AudioJob): AudioJobView {
  return { id: job.id, status: job.status, stage: job.stage, model: job.model, createdAt: job.createdAt,
    updatedAt: job.updatedAt, dueAt: job.dueAt, attempt: job.attempt, failures: job.failures,
    fileId: job.fileId, transcriptRef: job.transcriptRef, draftRef: job.draftRef,
    receipts: job.receipts, errorCode: job.errorCode, revision: job.revision };
}

export function createAudioJobUseCases(deps: AudioJobUseCaseDeps) {
  const owned = async (project: string, id: string, email: string) => {
    await deps.authorize(project, email);
    const job = await deps.jobs.get(project, id);
    if (!job || job.userEmail !== email) throw new NotFoundError("Audio job not found");
    return job;
  };
  return {
    async submit(projectName: string, userEmail: string, input: SubmitAudioJobInput,
      origin: { occurrence: string; actor?: RunActor }) {
      await deps.authorize(projectName, userEmail);
      const now = deps.now().toISOString();
      const task = input.task ?? "process";
      if (!["import", "transcribe", "process"].includes(task) ||
        (input.language !== undefined && !/^[a-z]{2,3}$/i.test(input.language)) ||
        !origin.occurrence || origin.occurrence.length > 256 ||
        (input.processingRevision !== undefined && (!input.processingRevision || input.processingRevision.length > 128))) {
        throw new ValidationError("Invalid audio job options");
      }
      try { fileExpiresAt(now, input.retention); } catch { throw new ValidationError("Invalid file retention"); }
      if (task !== "import") {
        if (!input.model || !getModelConfig(input.model)?.capabilities.transcription) throw new ValidationError("A transcription model is required");
        await deps.validateModel(input.model);
      }
      if (task !== "process" && (input.postprocess || input.destination)) throw new ValidationError("Only process tasks accept output options");
      await deps.validateOutputs(input, projectName, userEmail);
      let identity: { namespace: string; itemId: string };
      if (input.source.kind === "file") {
        const file = await deps.files.get(projectName, input.source.fileId);
        if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
        if (file.status !== "ready" || file.retireAt <= now) throw new ConflictError("Source file is unavailable or expired");
        identity = { namespace: "stored-file", itemId: file.id };
      } else if (input.source.kind === "source") {
        identity = await deps.sourceIdentity(projectName, input.source.sourceRef, userEmail);
      } else throw new ValidationError("Invalid audio source");
      const sourceKey = createHash("sha256").update(JSON.stringify([
        userEmail, identity.namespace, identity.itemId, task, input.processingRevision ?? "1",
      ])).digest("hex");
      const limits = await deps.limits(projectName);
      const result = await deps.jobs.submit({ projectName, userEmail, actor: origin.actor,
        source: input.source, sourceKey, model: input.model ?? "", task, language: input.language,
        retention: input.retention, postprocess: input.postprocess, destination: input.destination },
      { id: deps.id(), now, occurrence: origin.occurrence, ...limits });
      return result.status === "busy" ? result : { status: result.status, job: view(result.job) };
    },
    async get(project: string, id: string, email: string) { return view(await owned(project, id, email)); },
    async list(project: string, email: string, limit: number, after?: string) {
      await deps.authorize(project, email);
      return (await deps.jobs.list(project, limit, after, email)).map(view);
    },
    async cancel(project: string, id: string, email: string, revision: number) {
      await owned(project, id, email);
      if (!await deps.jobs.cancel(project, id, revision, deps.now().toISOString())) throw new ConflictError("Audio job changed or is already terminal");
      const job = await deps.jobs.get(project, id);
      if (!job) throw new NotFoundError("Audio job not found");
      return view(job);
    },
    async retry(project: string, id: string, email: string, revision: number) {
      await owned(project, id, email);
      const limits = await deps.limits(project);
      const job = await deps.jobs.retry(project, id, revision, deps.now().toISOString(), limits.maxActive);
      if (!job) throw new ConflictError("Audio job changed or cannot be retried");
      return view(job);
    },
  };
}
