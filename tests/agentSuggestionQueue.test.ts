import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSuggestionQueue } from "@/app/_lib/agentSuggestionQueue";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Agent suggestion scheduling", () => {
  it("starts a paused draft after 200ms", async () => {
    const recommend = vi.fn().mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("Fix this code");
    await vi.advanceTimersByTimeAsync(199);
    expect(recommend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(recommend).toHaveBeenCalledWith("Fix this code", expect.any(AbortSignal));
  });

  it("evaluates every second while edits continue without a pause", async () => {
    const sent: Array<{ text: string; at: number }> = [];
    const queue = createAgentSuggestionQueue(async text => { sent.push({ text, at: Date.now() }); }, () => Date.now());
    for (let index = 0; index < 30; index++) {
      queue.update(`draft ${index}`);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sent).toEqual([
      { text: "draft 9", at: 1_000 },
      { text: "draft 19", at: 2_000 },
      { text: "draft 29", at: 3_000 },
    ]);
  });

  it("keeps one inference active and follows it with only the latest edited draft", async () => {
    let complete!: () => void;
    const recommend = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }))
      .mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    const signal = recommend.mock.calls[0]![1] as AbortSignal;
    queue.update("second");
    await vi.advanceTimersByTimeAsync(500);
    queue.update("latest");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recommend).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(false);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(recommend).toHaveBeenCalledTimes(2);
    expect(recommend.mock.calls[1]![0]).toBe("latest");
  });

  it("spaces quick responses and never polls an unchanged input", async () => {
    const recommend = vi.fn().mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    queue.update("second");
    await vi.advanceTimersByTimeAsync(999);
    expect(recommend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recommend).toHaveBeenCalledTimes(2);
    queue.update("second");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(recommend).toHaveBeenCalledTimes(2);
  });

  it("drops a queued edit if the draft returns to the active request", async () => {
    const recommend = vi.fn().mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    queue.update("second");
    queue.update("first");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(recommend).toHaveBeenCalledTimes(1);
  });

  it("honors Retry-After for later edits without retrying an unchanged failed request", async () => {
    const recommend = vi.fn().mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    queue.cooldown(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    queue.update("latest");
    await vi.advanceTimersByTimeAsync(3_999);
    expect(recommend).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(recommend).toHaveBeenCalledTimes(2);
    expect(recommend.mock.calls[1]![0]).toBe("latest");
    queue.cooldown(2_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(recommend).toHaveBeenCalledTimes(2);
  });

  it("cancels cleared drafts but evaluates the same text when it is entered again", async () => {
    let complete!: () => void;
    const recommend = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }))
      .mockResolvedValue(undefined);
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    const signal = recommend.mock.calls[0]![1] as AbortSignal;
    queue.update("");
    expect(signal.aborted).toBe(true);
    queue.update("first");
    complete();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recommend).toHaveBeenCalledTimes(2);
  });

  it("cancels inference and queued work when a surface is closed", async () => {
    let complete!: () => void;
    const recommend = vi.fn().mockImplementation(() => new Promise<void>(resolve => { complete = resolve; }));
    const queue = createAgentSuggestionQueue(recommend, () => Date.now());
    queue.update("first");
    await vi.advanceTimersByTimeAsync(200);
    const signal = recommend.mock.calls[0]![1] as AbortSignal;
    queue.update("next");
    queue.stop();
    expect(signal.aborted).toBe(true);
    complete();
    queue.update("ignored");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(recommend).toHaveBeenCalledTimes(1);
  });
});
