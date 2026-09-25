import type { FileRetention } from "@/domain/artifact/retention";
import type { RunActor } from "@/domain/execution/actor";
import type { AgentConfiguration } from "@/domain/agent/types";
import type { SourceRefresh } from "@/domain/artifact/sourceReference";

export type AudioJobStage = "importing" | "transcribing" | "postprocessing" | "storing" | "cleaning";
export type AudioJobStatus = "queued" | "running" | "waiting" | "completed" | "blocked" | "failed" | "cancelled";
export const AUDIO_JOB_TASKS = ["import", "transcribe", "postprocess", "process"] as const;
export type AudioJobTask = (typeof AUDIO_JOB_TASKS)[number];
export type AudioSource = { kind: "file"; fileId: string; agentName?: string } | { kind: "source"; sourceRef: string };

/** Stored input may belong to another Agent owned by the same requesting user. */
export function audioSourceAgent(job: Pick<AudioJobInput, "source" | "agentName">): string {
  return job.source.kind === "file" ? job.source.agentName ?? job.agentName : job.agentName;
}

/** Stable input: retries never choose a different model, identity, or destination. */
export interface AudioJobInput {
  task?: AudioJobTask;
  agentName: string;
  userEmail: string;
  actor?: RunActor;
  /** Server-bound Agent that submitted the work; storage remains in agentName. */
  producedBy?: string;
  source: AudioSource;
  /** Hash of source identity, item identity and the explicit processing revision. */
  sourceKey: string;
  sourceIdentity?: { namespace: string; itemId: string };
  sourceRefresh?: SourceRefresh;
  model: string;
  configRevision?: number;
  language?: string;
  retention: FileRetention;
  postprocess?: { agentName: string; configuration?: AgentConfiguration };
  destination?: { serverName: string; documents: boolean; memories: boolean; configuration?: AgentConfiguration };
}

export interface AudioJob extends AudioJobInput {
  id: string;
  revision: number;
  status: AudioJobStatus;
  stage: AudioJobStage;
  createdAt: string;
  /** First worker claim of this execution window; queue waiting does not spend its deadline. */
  startedAt?: string;
  /** Explicit manual retry starts a new execution window, not a new retention period. */
  retryStartedAt?: string;
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
  /** Counts refer to the current extraction/reduction round, not the whole job. */
  postprocessProgress?: { phase: "extract" | "reduce" | "saving"; round: number; completed: number; total: number };
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
  Partial<Pick<AudioJob, "fileId" | "fileInfo" | "transcriptionProgress" | "postprocessProgress" | "movedTo" | "transcriptRef" | "draftRef" | "summaryRef" | "dialogueRef" | "receipts" | "errorCode" | "failures">>;

export interface AudioJobRepository {
  submit(input: AudioJobInput, admission: {
    id: string; now: string; occurrence: string; maxActive: number; maxPerOccurrence: number;
  }): Promise<{ status: "accepted" | "duplicate"; job: AudioJob } | { status: "busy"; reason: "active_limit" | "occurrence_limit" | "conflict" }>;
  get(agentName: string, id: string): Promise<AudioJob | null>;
  list(agentName: string, limit: number, after?: string, userEmail?: string): Promise<AudioJob[]>;
  due(now: string, limit: number): Promise<AudioJob[]>;
  claim(agentName: string, id: string, now: string, token: string, until: string): Promise<AudioJob | null>;
  heartbeat(job: AudioJob, now: string, until: string): Promise<boolean>;
  checkpoint(job: AudioJob, patch: AudioJobCheckpoint, now: string): Promise<AudioJob | null>;
  /** Administrative cancellation also fences a worker already holding the job. */
  cancel(agentName: string, id: string, revision: number, now: string): Promise<boolean>;
  /** Remove terminal job history and release its source identity for a new submission. Files retain their own lifetime. */
  delete(agentName: string, id: string, revision: number): Promise<boolean>;
  retry(agentName: string, id: string, revision: number, now: string, maxActive: number): Promise<AudioJob | null>;
}
