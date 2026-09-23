import type { AudioJobView } from "@/application/audio/audioJobUseCases";
import { isAudioJobTerminal } from "@/domain/audio/job";
import { readJson } from "@/app/_lib/httpClient";
import { mapWithLimit } from "@/shared/mapWithLimit";

export const MAX_CONCURRENT_AUDIO_JOB_READS = 4;

/** Refresh active rows across every loaded page without resetting its cursor. */
export async function loadActiveAudioJobs(base: string, jobs: readonly AudioJobView[], signal: AbortSignal) {
  const batch = new AbortController();
  const operationSignal = AbortSignal.any([signal, batch.signal]);
  try {
    return await mapWithLimit(jobs.filter((job) => !isAudioJobTerminal(job.status)), MAX_CONCURRENT_AUDIO_JOB_READS, async (job) => {
      operationSignal.throwIfAborted();
      return fetch(`${base}/audio-jobs/${encodeURIComponent(job.id)}`, { signal: operationSignal }).then(readJson<AudioJobView>);
    });
  } finally { batch.abort(); }
}

export function mergeAudioJobUpdates(jobs: AudioJobView[], updates: readonly AudioJobView[]): AudioJobView[] {
  const byId = new Map(updates.map((job) => [job.id, job]));
  return jobs.map((job) => {
    const update = byId.get(job.id);
    // A manual action or a newer list read may have overtaken the poll.
    return update && (update.revision > job.revision ||
      (update.revision === job.revision && update.updatedAt >= job.updatedAt)) ? update : job;
  });
}
