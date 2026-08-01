import { afterEach, describe, expect, it, vi } from "vitest";
import { sseResponse } from "@/app/api/_lib/sse";
import { apiError } from "@/app/api/_lib/http";
import { RateLimitedError } from "@/application/errors";

describe("sseResponse", () => {
  /**
   * A run is refused on its first `next()` — before it has produced anything —
   * so a response constructed ahead of that would answer 200 text/event-stream
   * and deliver the refusal as a data frame, losing the status and Retry-After.
   */
  it("lets a refusal on the first chunk reach the caller as a thrown error", async () => {
    async function* refused(): AsyncGenerator<unknown> {
      throw new RateLimitedError("over the daily cost limit", 42);
      // eslint-disable-next-line no-unreachable
      yield { delta: "never" };
    }
    const thrown = await sseResponse(refused()).then(
      () => null,
      (error: unknown) => error as RateLimitedError,
    );
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(apiError(thrown).status).toBe(429);
    expect(apiError(thrown).headers.get("Retry-After")).toBe("42");
  });

  it("emits the first chunk it pulled, so the stream is unchanged", async () => {
    async function* source(): AsyncGenerator<unknown> {
      yield { delta: "one" };
      yield { delta: "two" };
    }
    const response = await sseResponse(source());
    const body = await response.text();
    expect(body).toBe(
      'data: {"delta":"one"}\n\ndata: {"delta":"two"}\n\ndata: [DONE]\n\n',
    );
  });
});

describe("sseResponse keepalive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The ALB in front of the deployed app kills any connection silent for 60s,
   * which is shorter than one image generation. Comments keep bytes flowing
   * while the generator is silent, and readSse discards them.
   */
  it("emits comment frames while the generator is silent, none after it ends", async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* source(): AsyncGenerator<unknown> {
      yield { delta: "first" };
      await gate;
      yield { delta: "second" };
    }

    const response = await sseResponse(source());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);

    expect(await read()).toBe('data: {"delta":"first"}\n\n');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await read()).toBe(": keepalive\n\n");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await read()).toBe(": keepalive\n\n");

    release();
    expect(await read()).toBe('data: {"delta":"second"}\n\n');
    expect(await read()).toBe("data: [DONE]\n\n");
    await expect(reader.read()).resolves.toMatchObject({ done: true });
  });
});

describe("sseResponse cancellation", () => {
  it("aborts in-flight work and closes the source generator", async () => {
    const abortController = new AbortController();
    let finalized = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        yield { delta: "first" };
        await new Promise<void>((_resolve, reject) => {
          abortController.signal.addEventListener(
            "abort",
            () => reject(abortController.signal.reason),
            { once: true },
          );
        });
      } finally {
        finalized = true;
      }
    }

    const response = await sseResponse(source(), abortController);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("client disconnected");

    expect(abortController.signal.aborted).toBe(true);
    expect(finalized).toBe(true);
  });
});
