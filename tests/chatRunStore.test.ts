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

/** Let the store's pump run to a standstill, reconnects and all. */
async function settle(): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
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
   * The stopwatch a reader watches counts from the head frame, so a turn this
   * tab sent has to carry the instant the server named its run — and the
   * instant the stream ended, which is what keeps the number on screen while
   * the stored message is being fetched.
   */
  it("stamps the run from its head frame, and stamps the end", async () => {
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    stubFetch([() => sse([{ runId: "run-1" }, { ended: true }])]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")?.startedAtMs).toBe(Date.parse("2026-08-21T00:00:00.000Z"));
    expect(store.get("c1")?.endedAtMs).toBe(Date.parse("2026-08-21T00:00:00.000Z"));
  });

  /**
   * The press is not the start and neither is the head frame's arrival: between
   * the server's stamp on the user row and that frame sits the turn's setup —
   * the attachment upload, a document being extracted — which the stored
   * duration counts. Subtracting the age the server reports is what makes the
   * stopwatch and that badge one measurement, using only this tab's clock.
   */
  it("winds the clock back by the age the head frame reports", async () => {
    vi.setSystemTime(new Date("2026-08-21T00:00:30.000Z"));
    stubFetch([() => sse([{ runId: "run-1", elapsedMs: 12_000 }, { ended: true }])]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")?.startedAtMs).toBe(Date.parse("2026-08-21T00:00:18.000Z"));
  });

  it("does not start the clock until the server names the run", async () => {
    stubFetch([() => sse([{ delta: { content: "hi" } }, { ended: true }])]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")?.status).toBe("finished");
    expect(store.get("c1")?.startedAtMs).toBeUndefined();
  });

  /**
   * A stream that stopped without the run saying so tells this tab nothing
   * about when the run ended — the probe that finds it over answers after the
   * connection sat dead for however long the proxy allowed. Stamping there
   * would report that wait as part of the answer.
   */
  it("does not stamp an end it only inferred", async () => {
    stubFetch([
      () => sseCut([{ runId: "run-1" }, { delta: { content: "hi" } }]),
      () => new Response(JSON.stringify({ active: false }), { status: 200 }),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();

    expect(store.get("c1")?.status).toBe("finished");
    expect(store.get("c1")?.endedAtMs).toBeUndefined();
  });

  /**
   * The long, interrupted run is the one whose length is worth saying: its
   * stream was cut, its reconnects ran out, and the thread re-attaches to the
   * same run. Minting a fresh entry there drops the stopwatch mid-run and
   * suppresses the badge at the end.
   */
  it("keeps the clock when it re-attaches to the run it was already reading", async () => {
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    stubFetch([
      () => sse([{ runId: "run-1", elapsedMs: 5_000 }], { close: true }),
      () => new Response(JSON.stringify({ active: true }), { status: 200 }),
      () => sse([{ runId: "run-1" }], { close: true }),
      () => new Response(JSON.stringify({ active: true }), { status: 200 }),
      () => sse([{ runId: "run-1" }], { close: true }),
      () => new Response(JSON.stringify({ active: true }), { status: 200 }),
      () => sseOpen([{ runId: "run-1" }]),
    ]);
    const store = fresh();
    store.startTurn("c1", PENDING);
    await settle();
    const started = store.get("c1")?.startedAtMs;
    expect(started).toBe(Date.parse("2026-08-20T23:59:55.000Z"));

    store.attach("c1", "run-1");
    await settle();

    expect(store.get("c1")?.startedAtMs).toBe(started);
  });

  /**
   * A run picked up after a reload has been going for however long it has, and
   * nothing on the wire says how long. Stamping the moment this tab arrived
   * would report a reply that had been running a minute as seconds old, so the
   * field stays absent and the view shows the status without a number.
   */
  it("leaves a run it only attached to unstamped", async () => {
    stubFetch([() => sseOpen([{ runId: "run-1" }])]);
    const store = fresh();
    store.attach("c1", "run-1");
    await settle();

    expect(store.get("c1")?.status).toBe("streaming");
    expect(store.get("c1")?.startedAtMs).toBeUndefined();
  });

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

  /**
   * A frame is roughly a token; a notification is a render of the whole thread,
   * markdown re-parse and all. One render per frame is what made a long reply
   * judder, so frames are collected — while the entry itself stays current,
   * because a reader that asks must never get a frame behind what arrived.
   */
  it("collects a burst of frames into one notification, without holding the turn back", async () => {
    vi.useFakeTimers();
    stubFetch([
      () => sseOpen(["a", "b", "c", "d", "e"].map((content) => ({ delta: { content } }))),
    ]);
    const store = fresh();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.startTurn("c1", PENDING);
    await settle();

    // Every frame is folded in already…
    expect(store.get("c1")?.live.text).toBe("abcde");
    // …but they did not cost a render each. The one is the turn starting.
    expect(notifications).toBe(1);

    await vi.advanceTimersByTimeAsync(250);
    expect(notifications).toBe(2);
  });

  it("tells everyone at once when the run ends, rather than on the next window", async () => {
    vi.useFakeTimers();
    stubFetch([() => sse([{ delta: { content: "done" } }, { ended: true }])]);
    const store = fresh();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.startTurn("c1", PENDING);
    await settle();

    // No timer advanced: ending flushed the frame that was still being collected.
    expect(store.get("c1")).toMatchObject({ status: "finished", live: { text: "done" } });
    expect(notifications).toBe(2);
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
    expect(store.runningKeys()).toBe(store.runningKeys());

    store.startTurn("c1", PENDING);
    const whileRunning = store.runningKeys();
    expect(whileRunning).toEqual(["c1"]);
    expect(store.runningKeys()).toBe(whileRunning);

    await settle();
    expect(store.runningKeys()).toEqual([]);
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
    expect(store.runningKeys()).toEqual([]);
  });

  /**
   * A create refused before it learned its own id — over the daily cost limit,
   * out of slots — never streams under a chat id at all. Counted by chat id
   * alone the running set never moves, and the sidebar that reloads on it never
   * hears about the chat and the user turn the server has already written.
   */
  it("counts a chat still being created, so a refused create still moves the set", async () => {
    stubFetch([() => Response.json({ error: "over the daily cost limit" }, { status: 429 })]);
    const store = fresh();
    const key = store.startNewChat("agent", PENDING);
    expect(store.runningKeys()).toEqual([key]);

    await settle();
    expect(store.get(key)).toMatchObject({ status: "failed" });
    expect(store.runningKeys()).toEqual([]);
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
      () => Response.json({ active: true }),
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
      // The probe is the small one: `GET /api/chats/c1` would ship the whole
      // thread and sign every image in it to answer the same yes or no.
      "/api/chats/c1/runs/run-1",
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
      () => Response.json({ active: true }),
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
      // The probe is the small one: `GET /api/chats/c1` would ship the whole
      // thread and sign every image in it to answer the same yes or no.
      "/api/chats/c1/runs/run-1",
      "/api/chats/c1/runs/run-1/stream",
    ]);
  });

  /**
   * The budget counts *consecutive* failures. Counted over the turn's lifetime
   * instead, a ten-minute reply that survived three cuts — a proxy recycling, a
   * laptop waking, wifi changing hands — was reported as lost on the third with
   * every reconnect before it having worked and delivered.
   */
  it("keeps reconnecting for as long as each reconnect delivers something", async () => {
    const cut = () => sseCut([{ runId: "run-1" }, { delta: { content: "half" } }]);
    stubFetch([
      cut,
      () => Response.json({ active: true }),
      cut,
      () => Response.json({ active: true }),
      cut,
      () => Response.json({ active: true }),
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

    expect(store.get("c1")).toMatchObject({
      status: "finished",
      live: { text: "half and half" },
    });
  });

  it("reports the cut once the attempts run out, with what went wrong", async () => {
    stubFetch([
      () => sseCut([{ runId: "run-1" }]),
      () => Response.json({ active: true }),
      () => sseCut([]),
      () => Response.json({ active: true }),
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
      () => Response.json({ active: false }),
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

  /**
   * The refusal is reported, not swallowed: the composer has the typed message
   * in hand and clears it only on an accepted send — a silent no here is how a
   * draft used to vanish when a run got in between the render and the press.
   */
  it("refuses a second turn while one is still streaming, and says so", async () => {
    stubFetch([() => sse([{ delta: { content: "first" } }], { close: true })]);
    const store = fresh();
    expect(store.startTurn("c1", PENDING)).toBe("c1");
    expect(store.startTurn("c1", { ...PENDING, content: "impatient" })).toBeNull();
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
