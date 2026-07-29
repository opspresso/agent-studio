import { describe, expect, it } from "vitest";
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
