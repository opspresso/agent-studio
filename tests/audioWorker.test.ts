import { afterEach, describe, expect, it, vi } from "vitest";
import { runAudioWorker } from "@/application/audio/worker";
import type { AudioJob } from "@/domain/audio/job";

afterEach(() => { vi.useRealTimers(); });

describe("audio worker lifecycle", () => {
  it("keeps admitting jobs during a slow retention sweep without overlapping sweeps", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-09T00:00:00Z");
    const controller = new AbortController();
    const due = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([{ id: "1", projectName: "a" }] as AudioJob[]);
    const process = vi.fn(async (_project: string, _id: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const sweep = vi.fn(async (signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { deleted: 0, failed: 0 };
    });
    const worker = runAudioWorker({ due, process, sweep, refresh: async () => {} }, controller.signal);
    try {
      await vi.advanceTimersByTimeAsync(70_000);
      expect(process).toHaveBeenCalledTimes(1);
      expect(sweep).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); await worker; }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("runs bounded concurrent jobs, keeps polling and drains on shutdown", async () => {
    vi.useFakeTimers(); vi.setSystemTime("2026-09-09T00:00:00Z");
    const controller = new AbortController();
    const due = vi.fn(async () => [{ id: "1", projectName: "a" }, { id: "2", projectName: "b" }] as AudioJob[]);
    const process = vi.fn(async (_project: string, _id: string, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const sweep = vi.fn(async () => ({ deleted: 0, failed: 0 }));
    const refresh = vi.fn(async () => {});
    const worker = runAudioWorker({ due, process, sweep, refresh }, controller.signal);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(process).toHaveBeenCalledTimes(2);
    expect(due).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.abort(); await worker;
    expect(vi.getTimerCount()).toBe(0);
  });
});
