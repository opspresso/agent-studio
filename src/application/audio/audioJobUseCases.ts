import { createHash } from "node:crypto";
import type { AudioJob, AudioJobRepository, AudioJobTask, AudioSource } from "@/domain/audio/job";
import { AUDIO_JOB_TASKS, audioSourceAgent } from "@/domain/audio/job";
import type { FileRetention } from "@/domain/artifact/retention";
import type { SourceFile, SourceFileRepository } from "@/domain/artifact/sourceFile";
import { sourceFileAvailability, type SourceFileAvailability } from "@/domain/artifact/sourceFile";
import { artifactPath } from "@/domain/artifact/paths";
import type { RunActor } from "@/domain/execution/actor";
import type { AudioJobConfigRepository } from "@/domain/audio/config";
import { getModelConfig } from "@/domain/llm/models";
import { ConflictError, NotFoundError, ValidationError } from "@/application/errors";
import { fileExpiresAt } from "@/application/artifact/fileRetention";

export interface SubmitAudioJobInput {
  task?: AudioJobTask;
  source: AudioSource | { kind: "artifact"; artifactId: string };
  model?: string;
  language?: string;
  retention?: FileRetention;
  configRevision?: number;
  /** An explicit new revision opts into reprocessing the same source. */
  processingRevision?: string;
  postprocess?: AudioJob["postprocess"];
  destination?: AudioJob["destination"];
}

export interface AudioJobUseCaseDeps {
  jobs: AudioJobRepository;
  configs?: Pick<AudioJobConfigRepository, "get">;
  files: Pick<SourceFileRepository, "get">;
  resolveArtifact?(id: string, email: string): Promise<SourceFile>;
  sourceIdentity(agent: string, id: string, email: string): Promise<{ namespace: string; itemId: string; refresh?: AudioJob["sourceRefresh"] }>;
  authorize(agent: string, email: string): Promise<void>;
  validateModel(model: string): Promise<void>;
  validateOutputs(input: SubmitAudioJobInput, agent: string, email: string): Promise<Pick<AudioJob, "postprocess" | "destination">>;
  limits(agent: string): Promise<{ maxActive: number; maxPerOccurrence: number }>;
  now(): Date;
  id(): string;
}

/** Public view: source credentials, ownership data and internal receipt paths stay server-side. */
export type AudioJobView = Pick<AudioJob, "id" | "task" | "sourceIdentity" | "status" | "stage" | "model" | "createdAt" | "updatedAt" |
  "dueAt" | "attempt" | "failures" | "fileId" | "fileInfo" | "transcriptionProgress" | "postprocessProgress" | "movedTo" | "transcriptRef" | "draftRef" | "receipts" | "errorCode" | "revision" | "configRevision"> & {
    artifacts: { source?: string; transcript?: string; processed?: string; structured?: string; dialogue?: string };
    artifactLinks: Partial<Record<AudioArtifactKind, string>>;
    unavailableArtifacts?: Partial<Record<AudioArtifactKind, Exclude<SourceFileAvailability, "ready">>>;
    transcriptAgentName: string;
  };

type AudioArtifactKind = keyof AudioJobView["artifacts"];

// Each view can read up to five files. Bound page enrichment independently of
// the page size so one list cannot send hundreds of reads to the item store.
const MAX_CONCURRENT_AUDIO_JOB_VIEWS = 4;

async function view(job: AudioJob, deps: Pick<AudioJobUseCaseDeps, "files" | "now">): Promise<AudioJobView> {
  const transcriptAgentName = job.task === "postprocess" ? audioSourceAgent(job) : job.agentName;
  const references: AudioJobView["artifacts"] = {
    source: job.fileId, transcript: job.transcriptRef, processed: job.summaryRef ?? job.draftRef,
    structured: job.draftRef, dialogue: job.dialogueRef,
  };
  const artifacts: AudioJobView["artifacts"] = {};
  const artifactLinks: AudioJobView["artifactLinks"] = {};
  const unavailableArtifacts: NonNullable<AudioJobView["unavailableArtifacts"]> = {};
  const now = deps.now().toISOString();
  const reads = new Map<string, Promise<SourceFile | null>>();
  // At most five output reads per job; shared draft/summary refs read once.
  await Promise.all((Object.entries(references) as [AudioArtifactKind, string | undefined][]).map(async ([kind, id]) => {
    if (!id) return;
    const agentName = kind === "source" ? audioSourceAgent(job)
      : kind === "transcript" ? transcriptAgentName : job.agentName;
    const key = `${agentName}:${id}`;
    let read = reads.get(key);
    if (!read) { read = deps.files.get(agentName, id); reads.set(key, read); }
    const availability = sourceFileAvailability(await read, job.userEmail, now);
    if (availability === "ready") {
      artifacts[kind] = id;
      artifactLinks[kind] = artifactPath(id, kind === "source" ? "download" : "view");
    } else {
      unavailableArtifacts[kind] = availability;
    }
  }));
  return { id: job.id, task: job.task ?? "process", sourceIdentity: job.sourceIdentity, status: job.status, stage: job.stage,
    model: job.task === "postprocess" ? job.postprocess?.configuration?.model ?? "" : job.model, createdAt: job.createdAt,
    transcriptAgentName, artifacts, artifactLinks,
    ...(Object.keys(unavailableArtifacts).length ? { unavailableArtifacts } : {}),
    updatedAt: job.updatedAt, dueAt: job.dueAt, attempt: job.attempt, failures: job.failures,
    fileId: job.fileId, transcriptRef: job.transcriptRef, draftRef: job.draftRef,
    fileInfo: job.fileInfo, transcriptionProgress: job.transcriptionProgress, postprocessProgress: job.postprocessProgress, movedTo: job.movedTo,
    receipts: job.receipts, errorCode: job.errorCode, revision: job.revision, configRevision: job.configRevision };
}

export function createAudioJobUseCases(deps: AudioJobUseCaseDeps) {
  const owned = async (agent: string, id: string, email: string) => {
    await deps.authorize(agent, email);
    const job = await deps.jobs.get(agent, id);
    if (!job || job.userEmail !== email) throw new NotFoundError("Audio job not found");
    return job;
  };
  return {
    async configuration(agent: string, email: string) {
      await deps.authorize(agent, email);
      const config = await deps.configs?.get(agent);
      if (!config) return null;
      if (config.userEmail !== email) throw new ConflictError("Audio configuration requires owner confirmation");
      if (config.enabled) await deps.validateModel(config.model);
      const { userEmail: _email, agentName: _agent, ...view } = config;
      return view;
    },
    async submit(agentName: string, userEmail: string, input: SubmitAudioJobInput,
      origin: { occurrence: string; actor?: RunActor; producedBy?: string }) {
      await deps.authorize(agentName, userEmail);
      if (input.source.kind === "artifact") {
        if (!deps.resolveArtifact) throw new ValidationError("Artifact inputs are unavailable");
        const file = await deps.resolveArtifact(input.source.artifactId, userEmail);
        input = { ...input, source: { kind: "file", fileId: file.id, agentName: file.agentName } };
      }
      const config = await deps.configs?.get(agentName);
      if (config && (!config.enabled || config.userEmail !== userEmail)) throw new ConflictError("Audio configuration is disabled or requires owner confirmation");
      if (input.configRevision !== undefined) {
        if (!config || config.revision !== input.configRevision) throw new ConflictError("Audio configuration changed");
        if ([input.model, input.language, input.retention, input.postprocess, input.destination].some((value) => value !== undefined) ||
          (input.task !== undefined && input.task !== "process")) throw new ValidationError("Configuration references cannot override processing options");
        input = { ...input, model: config.model, language: config.language, retention: config.retention,
          postprocess: config.postprocess, destination: config.destination };
      }
      const now = deps.now().toISOString();
      const task = input.task ?? "process";
      if (!AUDIO_JOB_TASKS.includes(task) ||
        (input.language !== undefined && !/^[a-z]{2,3}$/i.test(input.language)) ||
        !origin.occurrence || origin.occurrence.length > 256 ||
        (input.processingRevision !== undefined && (!input.processingRevision || input.processingRevision.length > 128))) {
        throw new ValidationError("Invalid audio job options");
      }
      if (!input.retention) throw new ValidationError("File retention is required");
      try { fileExpiresAt(now, input.retention); } catch { throw new ValidationError("Invalid file retention"); }
      if (task === "postprocess" && (!input.postprocess || input.destination || input.model || input.language || input.source.kind !== "file")) {
        throw new ValidationError("Postprocessing requires a stored transcript and Agent, without ASR or delivery options");
      }
      if (task === "transcribe" || task === "process") {
        if (!input.model || !getModelConfig(input.model)?.capabilities.transcription) throw new ValidationError("A transcription model is required");
        await deps.validateModel(input.model);
      }
      if (task !== "process" && task !== "postprocess" && (input.postprocess || input.destination)) throw new ValidationError("Only process or postprocess tasks accept output options");
      const outputs = await deps.validateOutputs(input, agentName, userEmail);
      let identity: { namespace: string; itemId: string; refresh?: AudioJob["sourceRefresh"] };
      if (input.source.kind === "file") {
        const sourceAgent = input.source.agentName ?? agentName;
        await deps.authorize(sourceAgent, userEmail);
        const file = await deps.files.get(sourceAgent, input.source.fileId);
        if (!file || file.userEmail !== userEmail) throw new NotFoundError("Source file not found");
        if (sourceFileAvailability(file, userEmail, now) !== "ready") throw new ConflictError("Source file is unavailable or expired");
        if ((task === "transcribe" || task === "process") && file.derived?.kind === "transcript") {
          throw new ValidationError("This Artifact is already a transcript, not audio. To summarize it, use an AudioJob postprocess request with artifact_id, postprocess and retention; omit config_revision, model, language and destination.");
        }
        if (task === "postprocess" && (file.mimeType !== "application/json" || file.derived?.kind !== "transcript")) {
          throw new ValidationError("Postprocessing input must be a transcription Artifact");
        }
        identity = { namespace: "stored-file", itemId: file.id };
      } else if (input.source.kind === "source") {
        identity = await deps.sourceIdentity(agentName, input.source.sourceRef, userEmail);
      } else throw new ValidationError("Invalid audio source");
      const sourceKey = createHash("sha256").update(JSON.stringify([
        userEmail, identity.namespace, identity.itemId, task, input.processingRevision ?? "1",
      ])).digest("hex");
      const limits = config ? { maxActive: config.maxActive, maxPerOccurrence: config.maxPerOccurrence } : await deps.limits(agentName);
      const result = await deps.jobs.submit({ agentName, userEmail, actor: origin.actor,
        ...(origin.producedBy ? { producedBy: origin.producedBy } : {}),
        source: input.source, sourceKey, sourceIdentity: { namespace: identity.namespace, itemId: identity.itemId }, sourceRefresh: identity.refresh,
        model: input.model ?? "", task, language: input.language,
        retention: input.retention, configRevision: input.configRevision, ...outputs },
      { id: deps.id(), now, occurrence: origin.occurrence, ...limits });
      return result.status === "busy" ? result : { status: result.status, job: await view(result.job, deps) };
    },
    async get(agent: string, id: string, email: string) { return view(await owned(agent, id, email), deps); },
    async list(agent: string, email: string, limit: number, after?: string) {
      await deps.authorize(agent, email);
      const jobs = await deps.jobs.list(agent, limit, after, email);
      const result: AudioJobView[] = [];
      for (let start = 0; start < jobs.length; start += MAX_CONCURRENT_AUDIO_JOB_VIEWS) {
        result.push(...await Promise.all(jobs.slice(start, start + MAX_CONCURRENT_AUDIO_JOB_VIEWS)
          .map((job) => view(job, deps))));
      }
      return result;
    },
    async cancel(agent: string, id: string, email: string, revision: number) {
      await owned(agent, id, email);
      if (!await deps.jobs.cancel(agent, id, revision, deps.now().toISOString())) throw new ConflictError("Audio job changed or is already terminal");
      const job = await deps.jobs.get(agent, id);
      if (!job) throw new NotFoundError("Audio job not found");
      return view(job, deps);
    },
    async delete(agent: string, id: string, email: string, revision: number) {
      await owned(agent, id, email);
      if (!await deps.jobs.delete(agent, id, revision)) throw new ConflictError("Audio job changed or is still active; cancel it before deleting");
      return { deleted: true };
    },
    async retry(agent: string, id: string, email: string, revision: number) {
      await owned(agent, id, email);
      const config = await deps.configs?.get(agent);
      if (config && (!config.enabled || config.userEmail !== email)) throw new ConflictError("Audio configuration is disabled or requires owner confirmation");
      const limits = config ? { maxActive: config.maxActive } : await deps.limits(agent);
      const job = await deps.jobs.retry(agent, id, revision, deps.now().toISOString(), limits.maxActive);
      if (!job) throw new ConflictError("Audio job changed or cannot be retried");
      return view(job, deps);
    },
  };
}
