import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { DocumentProcessingError, MAX_DOCUMENT_ASSET_BYTES } from "@/domain/document/processor";
import { MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";
import { MAX_MARKDOWN_CHARS } from "./engine/limits";
import type { DocumentJob, DocumentOperation, DocumentReply, DocumentRequests, DocumentResults } from "./workerProtocol";

export const MAX_DOCUMENT_WORKERS = 2;
export const MAX_QUEUED_DOCUMENT_JOBS = 8;
export const DOCUMENT_JOB_TIMEOUT_MS = 30_000;
export const DOCUMENT_WORKER_HEAP_MB = 256;

interface Task {
  job: DocumentJob;
  resolve(value: unknown): void;
  reject(error: unknown): void;
  settled: boolean;
  child?: ChildProcess;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

function spawnWorker(): ChildProcess {
  return spawn(process.execPath, [`--max-old-space-size=${DOCUMENT_WORKER_HEAP_MB}`, join(process.cwd(), "build/document-worker.cjs")], {
    serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { NODE_ENV: "production" },
  });
}

function checkBytes(job: DocumentJob): void {
  const bytes = job.operation === "extract" ? job.input.bytes : job.operation === "create" ? undefined : job.input.file.bytes;
  if (bytes && bytes.byteLength > MAX_DOCUMENT_BYTES) throw new DocumentProcessingError("Document input exceeds the byte limit");
  if (job.operation === "edit" && JSON.stringify(job.input.operations).length > MAX_MARKDOWN_CHARS) throw new DocumentProcessingError("Document edits exceed the text budget");
  if (job.operation === "create") {
    if ((job.input.content?.length ?? 0) > MAX_MARKDOWN_CHARS) throw new DocumentProcessingError("Document content exceeds the text budget");
    if (job.input.sheets !== undefined && JSON.stringify(job.input.sheets).length > MAX_DOCUMENT_BYTES) throw new DocumentProcessingError("Workbook input exceeds the byte budget");
    const total = Object.values(job.input.assets ?? {}).reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
    if (total > MAX_DOCUMENT_ASSET_BYTES) throw new DocumentProcessingError("Document image assets exceed the byte limit");
  }
}

/** Queue and timeout are process-wide. Slots are released only after a child actually exits. */
export class DocumentWorkerPool {
  private readonly queue: Task[] = [];
  private active = 0;

  constructor(private readonly spawn: () => ChildProcess = spawnWorker) {}

  execute<K extends DocumentOperation>(operation: K, input: DocumentRequests[K], signal?: AbortSignal): Promise<DocumentResults[K]> {
    const job = { operation, input } as DocumentJob;
    try {
      signal?.throwIfAborted();
      checkBytes(job);
    } catch (error) { return Promise.reject(error); }
    if (this.active >= MAX_DOCUMENT_WORKERS && this.queue.length >= MAX_QUEUED_DOCUMENT_JOBS) {
      return Promise.reject(new DocumentProcessingError("Document workers are busy; try again after current jobs finish"));
    }
    return new Promise((resolve, reject) => {
      const task: Task = { job, resolve: (value) => resolve(value as DocumentResults[K]), reject, signal, settled: false };
      task.abort = () => this.finish(task, signal?.reason ?? new DocumentProcessingError("Document processing cancelled"));
      task.timer = setTimeout(() => this.finish(task, new DocumentProcessingError("Document processing exceeded its 30-second deadline")), DOCUMENT_JOB_TIMEOUT_MS);
      signal?.addEventListener("abort", task.abort, { once: true });
      this.queue.push(task);
      this.drain();
    });
  }

  private finish(task: Task, error?: unknown, result?: unknown): void {
    if (task.settled) return;
    task.settled = true;
    clearTimeout(task.timer);
    if (task.abort) task.signal?.removeEventListener("abort", task.abort);
    const index = this.queue.indexOf(task);
    if (index >= 0) this.queue.splice(index, 1);
    if (error !== undefined) task.reject(error);
    else task.resolve(result);
    // A synchronous parser cannot handle an IPC cancellation message; terminate its process.
    task.child?.kill("SIGKILL");
  }

  private drain(): void {
    while (this.active < MAX_DOCUMENT_WORKERS && this.queue.length > 0) {
      const task = this.queue.shift()!;
      if (task.settled) continue;
      let child: ChildProcess;
      try { child = this.spawn(); } catch {
        this.finish(task, new DocumentProcessingError("Could not start the document worker"));
        continue;
      }
      task.child = child;
      this.active += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      };
      child.once("exit", () => {
        this.finish(task, new DocumentProcessingError("Document worker exited before returning a result"));
        release();
      });
      child.once("error", () => {
        this.finish(task, new DocumentProcessingError("Document worker failed"));
        // A failed spawn has no process that could emit exit.
        if (!child.pid) release();
      });
      child.once("message", (reply: DocumentReply) => {
        if (reply && reply.ok === true) this.finish(task, undefined, reply.result);
        else this.finish(task, new DocumentProcessingError(reply && reply.ok === false && typeof reply.error === "string" ? reply.error : "Invalid document worker response"));
      });
      try {
        child.send(task.job, (error) => {
          if (error) this.finish(task, new DocumentProcessingError("Could not send the document to its worker"));
        });
      } catch { this.finish(task, new DocumentProcessingError("Could not send the document to its worker")); }
    }
  }
}
