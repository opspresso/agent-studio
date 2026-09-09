import type { AudioJob, AudioJobCheckpoint, AudioJobRepository } from "@/domain/audio/job";
import { TranscriptionError } from "@/domain/llm/transcription";
import { unrefTimer } from "@/shared/unrefTimer";
import { AppError } from "@/application/errors";

export const AUDIO_JOB_LEASE_MS = 120_000;
export const AUDIO_JOB_HEARTBEAT_MS = 30_000;
export const AUDIO_JOB_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const AUDIO_JOB_RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000] as const;
const DOCUMENT_POLL_MS = 30_000;

export class AudioJobStepError extends AppError {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code, retryable ? 502 : 409);
    this.name = "AudioJobStepError";
  }
}

type Progress = Partial<Pick<AudioJob, "fileId" | "fileInfo" | "transcriptionProgress" | "movedTo" | "transcriptRef" | "draftRef" | "receipts">>;

export interface AudioJobStepContext {
  signal: AbortSignal;
  /** Persist intermediate receipts without advancing the stage. */
  record(progress: Progress): Promise<void>;
}

export interface AudioJobProcessorDeps {
  jobs: AudioJobRepository;
  now(): Date;
  token(): string;
  /** Recheck the current project and user before every external stage. */
  authorize(job: AudioJob): Promise<void>;
  importFile(job: AudioJob, context: AudioJobStepContext): Promise<{ fileId: string; fileInfo?: AudioJob["fileInfo"] }>;
  transcribe(job: AudioJob, context: AudioJobStepContext): Promise<{ transcriptRef: string }>;
  postprocess(job: AudioJob, context: AudioJobStepContext): Promise<{ draftRef: string }>;
  store(job: AudioJob, context: AudioJobStepContext): Promise<{ ready: boolean; receipts: Record<string, string> }>;
  clean(job: AudioJob, context: AudioJobStepContext): Promise<void>;
}

function failureOf(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof AudioJobStepError) return { code: error.code, retryable: error.retryable };
  if (error instanceof TranscriptionError) return { code: error.code, retryable: error.code === "unavailable" };
  if (error instanceof AppError) return { code: `http_${error.status}`, retryable: error.status >= 500 || error.status === 429 };
  // Unknown errors may carry private source data. Never persist their message.
  return { code: "step_failed", retryable: true };
}

function requireReference(reference: string): void {
  if (typeof reference !== "string" || !reference.trim()) throw new AudioJobStepError("missing_result", false);
}

/** Runs a claimed job independently of the initiating Agent connection. */
export async function processAudioJob(
  deps: AudioJobProcessorDeps,
  projectName: string,
  id: string,
  signal?: AbortSignal,
): Promise<AudioJob | null> {
  signal?.throwIfAborted();
  const start = deps.now();
  let current = await deps.jobs.claim(projectName, id, start.toISOString(), deps.token(),
    new Date(start.getTime() + AUDIO_JOB_LEASE_MS).toISOString());
  if (!current) return null;

  const leaseAbort = new AbortController();
  const deadlineAbort = new AbortController();
  const operationSignal = AbortSignal.any([
    leaseAbort.signal, deadlineAbort.signal, ...(signal ? [signal] : []),
  ]);
  const remaining = Date.parse(current.createdAt) + AUDIO_JOB_DEADLINE_MS - start.getTime();
  const deadline = setTimeout(() => deadlineAbort.abort(), Math.max(0, remaining));
  unrefTimer(deadline);
  if (remaining <= 0) deadlineAbort.abort();

  // Heartbeats and checkpoints share one queue. A delayed renewal must not overwrite
  // a newer stage or mistake that stage's revision change for a lost lease.
  let pending: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = pending.then(fn);
    pending = next.catch(() => {});
    return next;
  };
  const save = (patch: AudioJobCheckpoint): Promise<void> => serial(async () => {
    if (!current || leaseAbort.signal.aborted || signal?.aborted) throw new AudioJobStepError("lease_lost", false);
    const updated = await deps.jobs.checkpoint(current, patch, deps.now().toISOString());
    if (!updated) {
      leaseAbort.abort();
      throw new AudioJobStepError("lease_lost", false);
    }
    current = updated;
  });
  const heartbeat = setInterval(() => {
    void serial(async () => {
      if (!current || current.status !== "running" || operationSignal.aborted) return;
      const now = deps.now();
      if (!await deps.jobs.heartbeat(current, now.toISOString(), new Date(now.getTime() + AUDIO_JOB_LEASE_MS).toISOString())) {
        leaseAbort.abort();
      }
    }).catch(() => leaseAbort.abort());
  }, AUDIO_JOB_HEARTBEAT_MS);
  unrefTimer(heartbeat);

  const context: AudioJobStepContext = {
    signal: operationSignal,
    record: async (progress) => {
      operationSignal.throwIfAborted();
      await save({ ...progress, status: "running", stage: current!.stage, dueAt: current!.dueAt });
    },
  };
  const advance = async (progress: Progress, stage?: AudioJob["stage"]): Promise<void> => {
    operationSignal.throwIfAborted();
    await save({ ...progress, stage: stage ?? current!.stage, status: stage ? "running" : "completed",
      dueAt: current!.dueAt, failures: 0, errorCode: undefined });
  };

  try {
    while (current.status === "running") {
      operationSignal.throwIfAborted();
      await deps.authorize(current);
      operationSignal.throwIfAborted();
      switch (current.stage) {
        case "importing": {
          const result = await deps.importFile(current, context);
          requireReference(result.fileId);
          await advance(result, current.task === "import" ? undefined : "transcribing");
          break;
        }
        case "transcribing": {
          if (!current.fileId) throw new AudioJobStepError("missing_file", false);
          const result = await deps.transcribe(current, context);
          requireReference(result.transcriptRef);
          await advance(result, current.task === "transcribe" ? "cleaning"
            : current.postprocess ? "postprocessing" : current.destination ? "storing" : "cleaning");
          break;
        }
        case "postprocessing": {
          if (!current.transcriptRef) throw new AudioJobStepError("missing_transcript", false);
          const result = await deps.postprocess(current, context);
          requireReference(result.draftRef);
          await advance(result, current.destination ? "storing" : "cleaning");
          break;
        }
        case "storing": {
          if (!current.transcriptRef) throw new AudioJobStepError("missing_transcript", false);
          const result = await deps.store(current, context);
          if (result.ready) {
            let movedTo: AudioJob["movedTo"];
            if (current.destination?.documents) {
              const transcriptId = result.receipts["document:transcript"];
              const resultId = current.draftRef ? result.receipts["document:result"] : undefined;
              if (!transcriptId || (current.draftRef && !resultId)) throw new AudioJobStepError("missing_delivery_receipt", false);
              movedTo = { serverName: current.destination.serverName, transcriptId, ...(resultId ? { resultId } : {}) };
            }
            await advance({ receipts: result.receipts, ...(movedTo ? { movedTo } : {}) }, "cleaning");
          }
          else {
            operationSignal.throwIfAborted();
            await save({ receipts: result.receipts, status: "waiting", stage: "storing", failures: 0, errorCode: undefined,
              dueAt: new Date(deps.now().getTime() + DOCUMENT_POLL_MS).toISOString() });
          }
          break;
        }
        case "cleaning": {
          await deps.clean(current, context);
          await advance({});
          break;
        }
      }
    }
  } catch (error) {
    // Shutdown or loss of ownership leaves the checkpoint for the next lease holder.
    if (!signal?.aborted && !leaseAbort.signal.aborted) {
      const failure = deadlineAbort.signal.aborted ? { code: "job_deadline", retryable: false } : failureOf(error);
      const failures = current.failures + 1;
      const delay = failure.retryable ? AUDIO_JOB_RETRY_DELAYS_MS[failures - 1] : undefined;
      await save({ status: delay !== undefined ? "waiting" : failure.retryable ? "failed" : "blocked",
        stage: current.stage, failures, errorCode: failure.code,
        dueAt: new Date(deps.now().getTime() + (delay ?? 0)).toISOString() });
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
    await pending;
  }
  return current;
}
