import type { AudioJob } from "@/domain/audio/job";
import { log } from "@/shared/logger";

export interface AudioWorkerDeps {
  due(limit: number): Promise<AudioJob[]>;
  process(projectName: string, id: string, signal: AbortSignal): Promise<unknown>;
  sweep(): Promise<{ deleted: number; failed: number }>;
  refresh(): Promise<unknown>;
}

/** Long jobs run beside polling; one slow source never blocks all other projects. */
export async function runAudioWorker(deps: AudioWorkerDeps, signal: AbortSignal): Promise<void> {
  const pending = new Map<string, Promise<unknown>>();
  let nextRefresh = 0;
  let nextSweep = 0;
  while (!signal.aborted) {
    try {
      if (Date.now() >= nextRefresh) { await deps.refresh(); nextRefresh = Date.now() + 3_600_000; }
      const room = 2 - pending.size;
      if (room > 0) {
        for (const job of await deps.due(room)) {
          if (signal.aborted || pending.has(job.id)) continue;
          const task = deps.process(job.projectName, job.id, signal)
            .catch(() => { log.error("audio-worker", "Audio job execution failed", { jobId: job.id }); })
            .finally(() => pending.delete(job.id));
          pending.set(job.id, task);
        }
      }
      if (Date.now() >= nextSweep) {
        const result = await deps.sweep();
        if (result.failed) log.warn("audio-worker", "Source file deletion requires retry", result);
        nextSweep = Date.now() + 60_000;
      }
    } catch { log.error("audio-worker", "Worker poll failed; retrying on the next poll"); }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
      const timer = setTimeout(finish, 10_000);
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted) finish();
    });
  }
  await Promise.allSettled(pending.values());
}
