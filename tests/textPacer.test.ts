import { describe, expect, it, vi, afterEach } from "vitest";
import { createTextPacer } from "@/app/_lib/textPacer";

/**
 * The Playground and Compare hold a streamed axis in component state, so a
 * commit per token re-renders the whole page over a string that only grows —
 * quadratic over a long think, with two sides doing it at once on Compare.
 */
describe("createTextPacer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits a batch per interval rather than once per push", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const pacer = createTextPacer((batch) => batches.push(batch));

    for (const token of ["a", "b", "c"]) {
      pacer.push(token);
    }
    expect(batches).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(batches).toEqual(["abc"]);
  });

  it("collects for longer as the committed text grows", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const pacer = createTextPacer((batch) => batches.push(batch));

    // 25,600 characters is past the ceiling on its own (128 chars per extra ms).
    pacer.push("x".repeat(25_600));
    vi.advanceTimersByTime(50);
    expect(batches).toHaveLength(1);

    pacer.push("y");
    vi.advanceTimersByTime(199);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches).toEqual(["x".repeat(25_600), "y"]);
  });

  it("gives up what it holds on flush, and stays quiet after", () => {
    vi.useFakeTimers();
    const batches: string[] = [];
    const pacer = createTextPacer((batch) => batches.push(batch));

    pacer.push("last thought");
    pacer.flush();
    expect(batches).toEqual(["last thought"]);

    // The pending timer is cleared, so nothing is committed twice.
    vi.advanceTimersByTime(1_000);
    pacer.flush();
    expect(batches).toEqual(["last thought"]);
  });
});
