import { describe, expect, it } from "vitest";
import { mergeGenerators } from "@/shared/mergeGenerators";

/** A promise this test resolves by hand, so ordering is chosen rather than raced. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * A hand-written source whose `next()` never settles, so a race is decided by
 * whatever else is running, and which records that the merge closed it.
 *
 * Asserting on the `return()` call is deterministic. A real generator's `finally`
 * runs whenever the runtime gets to it, and closing is deliberately not awaited
 * — a source parked at an `await` could never be resumed by `return()` anyway.
 */
function idleSource(label: string) {
  const state = { returned: false };
  const source = {
    next: () => new Promise<IteratorResult<string, string>>(() => {}),
    return: async () => {
      state.returned = true;
      return { done: true as const, value: `${label}-returned` };
    },
    throw: async (error: unknown) => {
      throw error;
    },
    [Symbol.asyncIterator]() {
      return source;
    },
  } as unknown as AsyncGenerator<string, string>;
  return { source, state };
}

async function* labelled(
  opened: Promise<void>,
  label: string,
  onStart?: () => void,
): AsyncGenerator<string, string> {
  onStart?.();
  await opened;
  yield `${label}-1`;
  yield `${label}-2`;
  return `${label}-done`;
}

describe("mergeGenerators", () => {
  it("returns an empty result set for no sources", async () => {
    const merged = mergeGenerators<string, string>([]);
    expect(await merged.next()).toEqual({ done: true, value: [] });
  });

  it("starts every source at once instead of draining one at a time", async () => {
    let started = 0;
    const a = gate();
    const b = gate();
    const merged = mergeGenerators([
      labelled(a.opened, "a", () => (started += 1)),
      labelled(b.opened, "b", () => (started += 1)),
    ]);

    // Generators are lazy: bodies run on the first `next()`. One call has to
    // start both, or the merge is a sequential drain wearing a different name.
    const first = merged.next();
    await Promise.resolve();
    expect(started).toBe(2);

    b.open();
    expect((await first).value).toBe("b-1");
    a.open();
  });

  it("yields in arrival order but returns values in input order", async () => {
    const a = gate();
    const b = gate();
    const merged = mergeGenerators([labelled(a.opened, "a"), labelled(b.opened, "b")]);
    const seen: string[] = [];

    // Second source first, so arrival order and input order disagree.
    const pump = (async () => {
      for (;;) {
        const step = await merged.next();
        if (step.done) {
          return step.value;
        }
        seen.push(step.value);
        if (seen.length === 2) {
          a.open();
        }
      }
    })();
    b.open();

    const returned = await pump;
    expect(seen).toEqual(["b-1", "b-2", "a-1", "a-2"]);
    expect(returned).toEqual(["a-done", "b-done"]);
  });

  it("closes the other sources when one throws", async () => {
    async function* failing(): AsyncGenerator<string, string> {
      throw new Error("boom");
    }
    const idle = idleSource("idle");

    const merged = mergeGenerators([failing(), idle.source]);

    await expect(merged.next()).rejects.toThrow("boom");
    expect(idle.state.returned).toBe(true);
  });

  it("closes every source when the consumer stops early", async () => {
    const idle = idleSource("idle");
    const merged = mergeGenerators([labelled(Promise.resolve(), "a"), idle.source]);

    for await (const _value of merged) {
      break;
    }

    expect(idle.state.returned).toBe(true);
  });
});
