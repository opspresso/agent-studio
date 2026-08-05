import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunStore, type PendingUser, type RunStore } from "@/app/chats/_lib/runStore";

const PENDING: PendingUser = { content: "hi", attachments: [], documents: [] };

/** An SSE response carrying `frames`, ending with `[DONE]`. */
function sse(frames: unknown[], options: { close?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
        // `close: true` is a body that simply stops — indistinguishable from a
        // completed stream to `readSse`, which is why runs announce their end.
        if (!options.close) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        }
        controller.close();
      },
    }),
  );
}

/** An SSE response that delivers `frames` and then stays open, still running. */
function sseOpen(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      },
    }),
  );
}

/**
 * An SSE response whose connection is cut mid-stream. This rejects out of
 * `readSse` rather than ending it, which is what the ALB's idle timeout does —
 * and is a different code path from a body that closes.
 */
function sseCut(frames: unknown[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      // Delivered a frame per read, then cut: `error()` discards whatever is
      // still queued, so enqueuing everything up front would model a connection
      // that failed before saying anything.
      pull(controller) {
        const frame = frames[index++];
        if (frame === undefined) {
          controller.error(new TypeError("network error"));
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      },
    }),
  );
}

/** Answer each request in order, recording the URLs asked for. */
function stubFetch(responses: Array<() => Response>): { urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    urls.push(String(url));
    const next = responses[index++];
    if (!next) {
      throw new Error(`unexpected fetch: ${String(url)}`);
    }
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    return Promise.resolve(next());
  });
  return { urls };
}

/** Let the store's pump run to a standstill. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve();
  }
}

function fresh(): RunStore {
  return createRunStore();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("runStore", () => {
  /**
   * The feature itself, without a component in sight: the turn accumulates
   * whether or not anything is watching, which is what a route change no longer
   * interrupts.
   */
  it("accumulates a turn nobody is observing", async () => {
    stubFetch([
      () =>
        sse([
          { runId: "run-1", userSeq: 3 },
          { delta: { content: "he" } },
          { delta: { content: "llo" } },
          { ended: true },
        ]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({
      status: "finished",
      runId: "run-1",
      userSeq: 3,
      live: { text: "hello" },
    });
  });

  it("returns the same snapshot object until something changes", async () => {
    stubFetch([() => sse([{ delta: { content: "a" } }, { ended: true }])]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    const before = store.get("c1");
    expect(store.get("c1")).toBe(before);
    await settle();
    expect(store.get("c1")).not.toBe(before);
  });

  it("returns the same running-chats array until membership changes", async () => {
    stubFetch([() => sse([{ delta: { content: "a" } }, { ended: true }])]);
    const store = fresh();
    expect(store.runningChatIds()).toBe(store.runningChatIds());

    store.startTurn("c1", PENDING);
    const whileRunning = store.runningChatIds();
    expect(whileRunning).toEqual(["c1"]);
    expect(store.runningChatIds()).toBe(whileRunning);

    await settle();
    expect(store.runningChatIds()).toEqual([]);
  });

  it("re-keys a new chat from its placeholder to the id it learns", async () => {
    stubFetch([
      () =>
        sse([
          { chat: { chatId: "c9", title: "t", ownerEmail: "o", createdAt: "", updatedAt: "" }, runId: "run-1" },
          { delta: { content: "hi" } },
          { ended: true },
        ]),
    ]);
    const store = fresh();
    const key = store.startNewChat("agent", PENDING);
    await settle();

    expect(store.get("c9")).toBe(store.get(key));
    expect(store.get("c9")).toMatchObject({ chatId: "c9", live: { text: "hi" } });
    // Never the placeholder: the sidebar keys its indicator by chat id.
    expect(store.runningChatIds()).toEqual([]);
  });

  it("reports a refused request as the failure it is", async () => {
    stubFetch([() => Response.json({ error: "chat already has a response in progress" }, { status: 409 })]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({
      status: "failed",
      error: "chat already has a response in progress",
    });
  });

  /**
   * An authored error is a subagent failing something the parent usually answers
   * past; a page-level banner would report a finished conversation as broken.
   */
  it("raises a top-level error but not a subagent's", async () => {
    stubFetch([
      () => sse([{ error: "child blew up", author: "helper" }, { ended: true }]),
      () => sse([{ error: "the run blew up" }, { ended: true }]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();
    expect(store.get("c1")?.error).toBeUndefined();

    store.startTurn("c2", PENDING);
    await settle();
    expect(store.get("c2")?.error).toBe("the run blew up");
  });

  /**
   * A replay always starts from the beginning, so the rebuilt turn must *be* the
   * replay — not the first read with the replay appended to it.
   */
  it("rebuilds the turn from a replay rather than doubling it", async () => {
    const { urls } = stubFetch([
      () => sse([{ runId: "run-1" }, { delta: { content: "half" } }], { close: true }),
      () => Response.json({ activeRun: { runId: "run-1" } }),
      () =>
        sse([
          { runId: "run-1" },
          { delta: { content: "half" } },
          { delta: { content: " and half" } },
          { ended: true },
        ]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({ status: "finished", live: { text: "half and half" } });
    expect(urls).toEqual([
      "/api/chats/c1/messages",
      "/api/chats/c1",
      "/api/chats/c1/runs/run-1/stream",
    ]);
  });

  /**
   * The cut this deployment actually sees. It rejects out of `readSse` instead
   * of ending it, and a version of this that let the rejection reach the outer
   * catch reported a run still producing as a network failure and never tried
   * to pick it back up.
   */
  it("reconnects after a connection cut, not just a clean close", async () => {
    const { urls } = stubFetch([
      () => sseCut([{ runId: "run-1" }, { delta: { content: "half" } }]),
      () => Response.json({ activeRun: { runId: "run-1" } }),
      () =>
        sse([
          { runId: "run-1" },
          { delta: { content: "half" } },
          { delta: { content: " and half" } },
          { ended: true },
        ]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({ status: "finished", live: { text: "half and half" } });
    expect(urls).toEqual([
      "/api/chats/c1/messages",
      "/api/chats/c1",
      "/api/chats/c1/runs/run-1/stream",
    ]);
  });

  it("reports the cut once the attempts run out, with what went wrong", async () => {
    stubFetch([
      () => sseCut([{ runId: "run-1" }]),
      () => Response.json({ activeRun: { runId: "run-1" } }),
      () => sseCut([]),
      () => Response.json({ activeRun: { runId: "run-1" } }),
      () => sseCut([]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({ status: "failed", error: "network error" });
  });

  it("does not reconnect to a run that has already finished", async () => {
    const { urls } = stubFetch([
      () => sse([{ runId: "run-1" }, { delta: { content: "all of it" } }], { close: true }),
      () => Response.json({}),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")).toMatchObject({ status: "finished", live: { text: "all of it" } });
    expect(urls).toHaveLength(2);
  });

  it("attaches to a run it did not start, with no pending turn of its own", async () => {
    const { urls } = stubFetch([
      () => sse([{ runId: "run-7" }, { delta: { content: "resumed" } }, { ended: true }]),
    ]);
    const store = fresh();
    store.attach("c1", "run-7");
    await settle();

    expect(urls).toEqual(["/api/chats/c1/runs/run-7/stream"]);
    // The turn that started the run is already a stored message; drawing it
    // again from here would show it twice.
    expect(store.get("c1")?.pendingUser).toBeUndefined();
    expect(store.get("c1")?.live.text).toBe("resumed");
  });

  it("evicts a finished turn nobody claimed, and never a running one", async () => {
    vi.useFakeTimers();
    stubFetch([
      () => sse([{ delta: { content: "done" } }, { ended: true }]),
      () => sseOpen([{ delta: { content: "still going" } }]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get("c1")?.status).toBe("finished");

    // A turn still producing is never evicted; that is what a route change is
    // supposed to survive.
    store.startTurn("c2", PENDING);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store.get("c1")).toBeUndefined();
    expect(store.get("c2")?.status).toBe("streaming");
  });

  /**
   * The eviction armed for a finished turn must not outlive the turn itself. It
   * did: attaching to a run inside the sixty-second window left the old timer
   * running, and it deleted the new streaming entry when it fired — the reply
   * simply stopped painting, with no error to explain it.
   */
  it("does not let a retired turn's eviction take the one that replaced it", async () => {
    vi.useFakeTimers();
    stubFetch([
      () => sse([{ delta: { content: "first" } }, { ended: true }]),
      () => sseOpen([{ runId: "run-7" }, { delta: { content: "resumed" } }]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get("c1")?.status).toBe("finished");

    store.attach("c1", "run-7");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store.get("c1")).toMatchObject({ status: "streaming", live: { text: "resumed" } });
  });

  it("frees a claimed turn at once, and ignores a claim on a turn since replaced", async () => {
    stubFetch([
      () => sse([{ delta: { content: "one" } }, { ended: true }]),
      () => sse([{ delta: { content: "two" } }, { ended: true }]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();
    const first = store.get("c1")!;

    store.startTurn("c1", PENDING);
    await settle();
    // The id is what makes this safe: effects run twice in development, and the
    // second pass must not evict the turn that started since.
    store.release("c1", first.id);
    expect(store.get("c1")?.live.text).toBe("two");

    store.release("c1", store.get("c1")!.id);
    expect(store.get("c1")).toBeUndefined();
  });

  it("refuses a second turn while one is still streaming", async () => {
    stubFetch([() => sse([{ delta: { content: "first" } }], { close: true })]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    store.startTurn("c1", { ...PENDING, content: "impatient" });
    expect(store.get("c1")?.pendingUser?.content).toBe("hi");
  });

  it("abort stops reading without reporting a failure", async () => {
    stubFetch([() => sse([{ delta: { content: "first" } }], { close: true })]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    store.abort("c1");
    await settle();
    expect(store.get("c1")).toBeUndefined();
  });

  it("asks the server to stop the run behind an entry", async () => {
    const { urls } = stubFetch([
      () => sse([{ runId: "run-1" }, { delta: { content: "…" } }], { close: true }),
      () => Response.json({ cancelled: true }),
      () => Response.json({}),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();
    store.cancelRun("c1");
    await settle();
    expect(urls).toContain("/api/chats/c1/runs/run-1");
  });
});
