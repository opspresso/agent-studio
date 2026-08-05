import { describe, expect, it, vi } from "vitest";
import { detachOnReturn } from "@/shared/detachOnReturn";

/** A source that parks mid-stream until the test lets it go. */
function gatedSource(): {
  source: AsyncGenerator<number>;
  release: () => void;
  ended: () => boolean;
} {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ended = false;
  async function* source(): AsyncGenerator<number> {
    yield 1;
    await gate;
    yield 2;
    ended = true;
  }
  return { source: source(), release: () => release(), ended: () => ended };
}

/** Let queued microtasks run without advancing any clock. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

describe("detachOnReturn", () => {
  /**
   * The regression this whole module exists for: written as an `async function*`
   * the wrapper cannot answer `return()` until the in-flight `next()` settles,
   * so an SSE `cancel()` would hang for the rest of the run.
   */
  it("answers return() while the source is parked on an await", async () => {
    const { source, release } = gatedSource();
    const { stream } = detachOnReturn(source);

    await stream.next();
    const inFlight = stream.next();

    let returned = false;
    void stream.return(undefined).then(() => {
      returned = true;
    });
    await flush();

    expect(returned).toBe(true);
    release();
    await inFlight;
  });

  it("keeps pulling the source to completion after the consumer leaves", async () => {
    const { source, release, ended } = gatedSource();
    const onDetach = vi.fn();
    const { stream, drained } = detachOnReturn(source, onDetach);

    await stream.next();
    await stream.return(undefined);
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(ended()).toBe(false);

    release();
    await drained;
    expect(ended()).toBe(true);
  });

  it("reports done to a consumer that keeps reading after it left", async () => {
    const { source, release } = gatedSource();
    const { stream, drained } = detachOnReturn(source);

    await stream.next();
    await stream.return(undefined);
    await expect(stream.next()).resolves.toMatchObject({ done: true });

    release();
    await drained;
  });

  it("settles drained on a normal end of stream, without detaching", async () => {
    async function* source(): AsyncGenerator<number> {
      yield 1;
    }
    const onDetach = vi.fn();
    const { stream, drained } = detachOnReturn(source(), onDetach);

    const seen: number[] = [];
    for await (const value of stream) {
      seen.push(value);
    }

    expect(seen).toEqual([1]);
    expect(onDetach).not.toHaveBeenCalled();
    await expect(drained).resolves.toBeUndefined();
  });

  /**
   * A run refused over its cost limit throws on the very first `next()`, before
   * a response exists — so nothing ever detaches. `drained` still has to settle,
   * or the route's `after()` waits on it forever.
   */
  it("settles drained when the first next() throws, and rethrows", async () => {
    async function* refused(): AsyncGenerator<number> {
      throw new Error("over the daily cost limit");
    }
    const { stream, drained } = detachOnReturn(refused());

    await expect(stream.next()).rejects.toThrow("over the daily cost limit");
    await expect(drained).resolves.toBeUndefined();
  });

  it("resolves rather than rejects when the detached source throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source(): AsyncGenerator<number> {
      yield 1;
      await gate;
      throw new Error("provider hung up");
    }
    const { stream, drained } = detachOnReturn(source());

    await stream.next();
    await stream.return(undefined);
    release();

    await expect(drained).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
