import { afterEach, describe, expect, it, vi } from "vitest";
import { sseResponse } from "@/app/api/_lib/sse";
import { apiError } from "@/app/api/_lib/http";
import { RateLimitedError } from "@/application/errors";
import { detachOnReturn } from "@/shared/detachOnReturn";
import { readSse } from "@/app/_lib/sse";

async function collectSse(response: Response, options?: { requireDone?: boolean }): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of readSse(response, options)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe("readSse", () => {
  it("decodes frames split across transport chunks", async () => {
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"delta":'));
          controller.enqueue(encoder.encode('"one"}\n\ndata: [DONE]\n\n'));
          controller.close();
        },
      }),
    );

    await expect(collectSse(response)).resolves.toEqual([{ delta: "one" }]);
  });

  it("rejects malformed JSON instead of dropping a data frame", async () => {
    await expect(collectSse(new Response("data: {bad}\n\n"))).rejects.toThrow(
      "Malformed SSE data frame",
    );
  });

  it("rejects a trailing incomplete frame", async () => {
    await expect(collectSse(new Response('data: {"delta":"lost"}'))).rejects.toThrow(
      "SSE stream ended with an incomplete frame",
    );
  });

  it("rejects a cut connection even at a complete frame boundary", async () => {
    await expect(collectSse(new Response('data: {"delta":"partial"}\n\n'))).rejects.toThrow(
      "SSE stream ended without [DONE]",
    );
  });

  it.each(["done", "malformed", "return", "throw"])("releases the response on %s", async (exit) => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          exit === "done" ? "data: [DONE]\n\n" : exit === "malformed" ? "data: {bad}\n\n" : 'data: {"delta":"one"}\n\n',
        ));
      },
      cancel,
    });
    const stream = readSse(new Response(body));
    if (exit === "malformed") {
      await expect(stream.next()).rejects.toThrow("Malformed SSE data frame");
    } else if (exit === "done") {
      await expect(stream.next()).resolves.toMatchObject({ done: true });
    } else {
      await stream.next();
      if (exit === "throw") {
        const error = new Error("consumer failed");
        await expect(stream.throw(error)).rejects.toBe(error);
      } else {
        await stream.return(undefined);
      }
    }
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

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

  /**
   * The keepalive cannot start until the response exists, so a generator whose
   * *first* chunk is far away would spend the whole 60s idle budget in
   * silence and be cut mid-run. Two runs do exactly that: an image, whose bytes
   * arrive in one chunk at the end, and a reasoning model on a configuration that is
   * not recording its thinking — that stream's first chunk is the end-of-turn
   * usage.
   */
  it("builds the response and starts the keepalive while the first chunk is still coming", async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* silentStart(): AsyncGenerator<unknown> {
      await gate;
      yield { delta: "at last" };
    }

    const pending = sseResponse(silentStart());
    await vi.advanceTimersByTimeAsync(25_000);
    const response = await pending;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const read = async () => decoder.decode((await reader.read()).value);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(await read()).toBe(": keepalive\n\n");

    release();
    // Held, not dropped: the chunk the grace period outran is still emitted first.
    expect(await read()).toBe('data: {"delta":"at last"}\n\n');
    expect(await read()).toBe("data: [DONE]\n\n");
  });

  it("reports a refusal that lands after the grace period on the stream", async () => {
    vi.useFakeTimers();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slowRefusal(): AsyncGenerator<unknown> {
      await gate;
      throw new Error("refused late");
    }

    // No throw out of `sseResponse`: the status was already sent, so the error
    // becomes a frame rather than being lost.
    const pending = sseResponse(slowRefusal());
    await vi.advanceTimersByTimeAsync(25_000);
    const response = await pending;
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    release();
    expect(decoder.decode((await reader.read()).value)).toBe('data: {"error":"refused late"}\n\n');
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

  /**
   * The chat routes pass no controller and wrap their stream in
   * `detachOnReturn`, so a disconnect must neither abort the run nor block on
   * closing it — `cancel()` has to settle while the source is still working.
   */
  it("settles a cancel promptly and leaves a detached source running", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finalized = false;
    async function* source(): AsyncGenerator<unknown> {
      try {
        yield { delta: "first" };
        await gate;
        yield { delta: "second" };
      } finally {
        finalized = true;
      }
    }

    const { stream, drained } = detachOnReturn(source());
    const response = await sseResponse(stream);
    const reader = response.body!.getReader();
    await expect(reader.read()).resolves.toMatchObject({ done: false });
    await reader.cancel("client disconnected");

    expect(finalized).toBe(false);
    release();
    await drained;
    expect(finalized).toBe(true);
  });
});
