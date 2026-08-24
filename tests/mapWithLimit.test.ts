/**
 * The bounded-concurrency primitive the engine's tool dispatch and the Slack
 * transcript reader both run on. What is under test is that it returns one
 * result per item whatever the inputs are: the engine pairs results back to
 * calls by index and skips an empty slot, so a short return is not an error
 * there — it is a tool call answered with silence.
 */
import { describe, expect, it } from "vitest";
import { mapWithLimit } from "@/shared/mapWithLimit";

describe("mapWithLimit", () => {
  it("keeps input order regardless of completion order", async () => {
    // Gated rather than timed: the order is made to invert on purpose, and a
    // unit test here runs off no clock.
    const gates = [0, 1, 2, 3].map(() => {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    const running = mapWithLimit([0, 1, 2, 3], 4, async (index) => {
      await gates[index]!.promise;
      return index;
    });
    for (const gate of [...gates].reverse()) {
      gate.release();
    }
    expect(await running).toEqual([0, 1, 2, 3]);
  });

  it("runs at most `limit` at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return value;
    });
    expect(peak).toBe(3);
  });

  it("runs every item when one of them is undefined", async () => {
    // The guard that read an `undefined` element as the end of the work retired
    // the worker that met it — at `limit: 1` that is every item after it, gone
    // with no error to say so.
    const items = ["a", undefined, "c"];
    const seen: Array<string | undefined> = [];
    const results = await mapWithLimit(items, 1, async (item) => {
      seen.push(item);
      return item ?? "(none)";
    });
    expect(seen).toEqual(items);
    expect(results).toEqual(["a", "(none)", "c"]);
  });

  it("still runs everything when the limit is zero or negative", async () => {
    expect(await mapWithLimit([1, 2, 3], 0, async (v) => v * 2)).toEqual([2, 4, 6]);
    expect(await mapWithLimit([1, 2, 3], -5, async (v) => v * 2)).toEqual([2, 4, 6]);
  });

  it("still runs everything when the limit is not a number", async () => {
    // NaN survives Math.max and Math.min alike, and `Array.from({ length: NaN })`
    // is the empty array — zero workers, by a route a clamp does not close.
    expect(await mapWithLimit([1, 2, 3], Number.NaN, async (v) => v * 2)).toEqual([2, 4, 6]);
  });

  it("answers an empty input with an empty array", async () => {
    expect(await mapWithLimit([], 4, async (v) => v)).toEqual([]);
  });

  it("rejects the whole call when one item rejects", async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (value) => {
        if (value === 2) {
          throw new Error("boom");
        }
        return value;
      }),
    ).rejects.toThrow("boom");
  });
});
