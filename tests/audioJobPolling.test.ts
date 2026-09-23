import { afterEach, describe, expect, it, vi } from "vitest";
import type { AudioJobView } from "@/application/audio/audioJobUseCases";
import { loadActiveAudioJobs, MAX_CONCURRENT_AUDIO_JOB_READS, mergeAudioJobUpdates } from "@/app/agents/[name]/audio/jobPolling";

const job = (id: string, status: AudioJobView["status"] = "running", revision = 1) =>
  ({ id, status, revision, updatedAt: "2026-09-09T00:00:00Z" }) as AudioJobView;
afterEach(() => vi.unstubAllGlobals());

describe("audio job polling", () => {
  it("updates active jobs beyond the first page and preserves all loaded rows", async () => {
    const jobs = Array.from({ length: 40 }, (_, index) => job(String(index), index === 30 ? "running" : "completed"));
    const completed = job("30", "completed", 2);
    const fetch = vi.fn(async () => Response.json(completed));
    vi.stubGlobal("fetch", fetch);
    const updates = await loadActiveAudioJobs("/api/projects/audio", jobs, new AbortController().signal);
    const merged = mergeAudioJobUpdates(jobs, updates);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/projects/audio/audio-jobs/30", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(merged).toHaveLength(40);
    expect(merged[30]).toEqual(completed);
    expect(merged[0]).toBe(jobs[0]);
    expect(merged.map((item) => item.id)).toEqual(jobs.map((item) => item.id));
  });

  it("bounds concurrent reads and includes queued and waiting jobs", async () => {
    let active = 0; let maximum = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      active += 1; maximum = Math.max(maximum, active);
      await Promise.resolve(); active -= 1;
      return Response.json(job("result"));
    }));
    const jobs = Array.from({ length: 10 }, (_, index) => job(String(index), index % 2 ? "queued" : "waiting"));
    expect(await loadActiveAudioJobs("/api/projects/audio", jobs, new AbortController().signal)).toHaveLength(10);
    expect(maximum).toBe(MAX_CONCURRENT_AUDIO_JOB_READS);
  });

  it("does not restore cancelled rows or reinsert rows removed by a list refresh", () => {
    const cancelled = job("1", "cancelled", 5);
    const newerPage = job("3", "queued");
    const merged = mergeAudioJobUpdates([cancelled, newerPage], [job("1", "running", 4), job("2")]);
    expect(merged).toEqual([cancelled, newerPage]);
    expect(merged[0]).toBe(cancelled);
  });

  it("keeps the latest heartbeat when revisions are equal", () => {
    const newer = { ...job("1"), updatedAt: "2026-09-09T00:00:30Z" };
    expect(mergeAudioJobUpdates([newer], [job("1")])[0]).toBe(newer);
    expect(mergeAudioJobUpdates([job("1")], [newer])[0]).toBe(newer);
  });

  it("does not start requests after the polling effect is cancelled", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); controller.abort();
    await expect(loadActiveAudioJobs("/api/projects/audio", [job("1")], controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces failed status reads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Unavailable" }, { status: 503 })));
    await expect(loadActiveAudioJobs("/api/projects/audio", [job("1")], new AbortController().signal)).rejects.toThrow("Unavailable");
  });

  it("cancels sibling reads after a failed batch so the next poll cannot accumulate requests", async () => {
    let siblingSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      if (fetch.mock.calls.length === 1) return Response.json({ error: "Unavailable" }, { status: 503 });
      siblingSignal = init.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        siblingSignal!.addEventListener("abort", () => reject(siblingSignal!.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);
    await expect(loadActiveAudioJobs("/api/projects/audio", [job("1"), job("2")], new AbortController().signal)).rejects.toThrow("Unavailable");
    expect(siblingSignal?.aborted).toBe(true);
  });
});
