import type { FileRetention } from "@/domain/artifact/retention";
import type { RunActor } from "@/domain/execution/actor";
import type { Version } from "@/domain/project/types";
import type { SourceRefresh } from "@/domain/artifact/sourceReference";

export type AudioJobStage = "importing" | "transcribing" | "postprocessing" | "storing" | "cleaning";
export type AudioJobStatus = "queued" | "running" | "waiting" | "completed" | "blocked" | "failed" | "cancelled";
export const AUDIO_JOB_TASKS = ["import", "transcribe", "postprocess", "process"] as const;
export type AudioJobTask = (typeof AUDIO_JOB_TASKS)[number];
export type AudioSource = { kind: "file"; fileId: string; projectName?: string } | { kind: "source"; sourceRef: string };

/** Stored input may belong to another Agent owned by the same requesting user. */
export function audioSourceProject(job: Pick<AudioJobInput, "source" | "projectName">): string {
  return job.source.kind === "file" ? job.source.projectName ?? job.projectName : job.projectName;
}

/** Stable input: retries never choose a different model, identity, or destination. */
export interface AudioJobInput {
  task?: AudioJobTask;
  projectName: string;
  userEmail: string;
  actor?: RunActor;
  source: AudioSource;
  /** Hash of source identity, item identity and the explicit processing revision. */
  sourceKey: string;
  sourceIdentity?: { namespace: string; itemId: string };
  sourceRefresh?: SourceRefresh;
  model: string;
  configRevision?: number;
  language?: string;
  retention: FileRetention;
  postprocess?: { projectName: string; versionName: string; version?: Version };
  destination?: { serverName: string; documents: boolean; memories: boolean; version?: Version };
}

export interface AudioJob extends AudioJobInput {
  id: string;
  revision: number;
  status: AudioJobStatus;
  stage: AudioJobStage;
  createdAt: string;
  updatedAt: string;
  dueAt: string;
  /** Worker fencing token; replaced on every new claim, independent of the job revision. */
  lease?: { token: string; until: string };
  attempt: number;
  /** Consecutive failures of the current stage, reset after a successful stage. */
  failures: number;
  fileId?: string;
  fileInfo?: { filename: string; byteSize?: number; expiresAt: string };
  transcriptionProgress?: { processedSeconds: number; totalSeconds: number; completedSegments: number };
  movedTo?: { serverName: string; transcriptId: string; resultId?: string };
  transcriptRef?: string;
  draftRef?: string;
  summaryRef?: string;
  dialogueRef?: string;
  /** Per-output receipts, separate from model-generated content. */
  receipts: Record<string, string>;
  errorCode?: string;
}

export const MAX_ACTIVE_AUDIO_JOBS = 100;

export function isAudioJobTerminal(status: AudioJobStatus): boolean {
  return status === "completed" || status === "blocked" || status === "failed" || status === "cancelled";
}

export type AudioJobCheckpoint = Pick<AudioJob, "status" | "stage" | "dueAt"> &
  Partial<Pick<AudioJob, "fileId" | "fileInfo" | "transcriptionProgress" | "movedTo" | "transcriptRef" | "draftRef" | "summaryRef" | "dialogueRef" | "receipts" | "errorCode" | "failures">>;

export interface AudioJobRepository {
  submit(input: AudioJobInput, admission: {
    id: string; now: string; occurrence: string; maxActive: number; maxPerOccurrence: number;
  }): Promise<{ status: "accepted" | "duplicate"; job: AudioJob } | { status: "busy" }>;
  get(projectName: string, id: string): Promise<AudioJob | null>;
  list(projectName: string, limit: number, after?: string, userEmail?: string): Promise<AudioJob[]>;
  due(now: string, limit: number): Promise<AudioJob[]>;
  claim(projectName: string, id: string, now: string, token: string, until: string): Promise<AudioJob | null>;
  heartbeat(job: AudioJob, now: string, until: string): Promise<boolean>;
  checkpoint(job: AudioJob, patch: AudioJobCheckpoint, now: string): Promise<AudioJob | null>;
  /** Administrative cancellation also fences a worker already holding the job. */
  cancel(projectName: string, id: string, revision: number, now: string): Promise<boolean>;
  retry(projectName: string, id: string, revision: number, now: string, maxActive: number): Promise<AudioJob | null>;
}
