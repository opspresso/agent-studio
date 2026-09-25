import { describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";
import type { AgentRepository } from "@/domain/agent/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "@/application/chat/deps";
import { runAndPersist } from "@/application/chat/run";
import { teeToRunLog } from "@/application/chat/runLog";
import {
  STOP_REASON,
  STOPPED_NOTICE,
  SUPERSEDED_NOTICE,
  SUPERSEDED_REASON,
} from "@/application/chat/cancelRun";

const CHAT: Chat = {
  chatId: "c1",
  title: "t",
  ownerEmail: "owner@x.com",
  agentName: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Every write the run made, in the order it made them. */
function recordingDeps(overrides: Partial<ChatDeps> = {}) {
  const appended: RunLogEntry[] = [];
  const calls: string[] = [];
  const messages: ChatMessage[] = [];
  let seq = 0;
  const runLog: ChatRunLogRepository = {
    async append(_chatId, _runId, entries) {
      for (const entry of entries) {
        calls.push(entry.terminal ? "runLog.terminal" : "runLog.append");
        appended.push(entry);
      }
    },
    async read() {
      return appended;
    },
  };
  const chats = {
    async get() {
      return CHAT;
    },
    async listByOwner() {
      return [CHAT];
    },
    async create() {},
    async update() {
      calls.push("chats.update");
    },
    async delete() {},
    async listMessages() {
      return [] as ChatMessage[];
    },
    async claimRun() {
      return true;
    },
    async releaseRun() {
      calls.push("chats.releaseRun");
    },
    async getActiveRun() {
      return null;
    },
    async requestCancel() {
      return true;
    },
    async reserveMessageSeq() {
      return seq++;
    },
    async appendMessage(message: ChatMessage) {
      calls.push(`chats.appendMessage:${message.role}`);
      messages.push(message);
    },
  } satisfies ChatRepository;

  const deps: ChatDeps = {
    chats,
    runLog,
    agents: {} as AgentRepository,
    runAgent: () => (async function* () {})(),
    documents: { extract: async () => ({ text: "" }) },
    ...overrides,
  };
  return {
    deps,
    appended,
    calls,
    messages,
    frames: () => appended.flatMap((e) => JSON.parse(e.payload)),
  };
}

/** Drive a run to completion through the tee, optionally leaving part-way. */
async function run(
  deps: ChatDeps,
  chunks: EngineChunk[],
  options: { leaveAfter?: number } = {},
): Promise<void> {
  async function* source(): AsyncGenerator<EngineChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const tee = teeToRunLog(deps, "c1", "run-1", runAndPersist(deps, CHAT, source()));
  let read = 0;
  for await (const _chunk of tee.stream) {
    read += 1;
    if (options.leaveAfter !== undefined && read === options.leaveAfter) {
      tee.onClientGone();
    }
  }
}

describe("teeToRunLog", () => {
  /**
   * The whole cost argument for this design: a run nobody abandoned pays no
   * persistent DB writes at all, because the reader saw every frame as it happened.
   */
  it("writes nothing while a reader is still there", async () => {
    const { deps, appended } = recordingDeps();
    await run(deps, [{ delta: { content: "hello" } }, { delta: { content: " world" } }]);
    expect(appended).toEqual([]);
  });

  it("flushes the whole run so far the moment the reader leaves", async () => {
    const { deps, frames } = recordingDeps();
    await run(
      deps,
      [
        { delta: { content: "one" } },
        { delta: { content: "two" } },
        { delta: { content: "three" } },
      ],
      { leaveAfter: 1 },
    );
    // Including the frame that had already been delivered: a replay starts from
    // the beginning, so the log has to hold the beginning.
    expect(frames()).toEqual([
      { delta: { content: "one" } },
      { delta: { content: "two" } },
      { delta: { content: "three" } },
    ]);
  });

  /**
   * The ordering a reader depends on. Seeing the terminal entry has to mean the
   * assistant message is already there; seeing the lease gone has to mean the
   * terminal entry is already there.
   */
  it("persists, then marks the log terminal, then releases the lease", async () => {
    const { deps, calls } = recordingDeps();
    await run(deps, [{ delta: { content: "answer" } }], { leaveAfter: 1 });
    // The content flush comes when the reader leaves, mid-run; what matters is
    // where the *terminal* entry falls relative to the other two.
    expect(calls).toEqual([
      "runLog.append",
      "chats.appendMessage:assistant",
      "chats.update",
      "runLog.terminal",
      "chats.releaseRun",
    ]);
  });

  it("releases the lease even for a run nobody left, which logs nothing", async () => {
    const { deps, calls } = recordingDeps();
    await run(deps, [{ delta: { content: "answer" } }]);
    expect(calls).toEqual([
      "chats.appendMessage:assistant",
      "chats.update",
      "chats.releaseRun",
    ]);
  });

  it("records what ended a run that threw", async () => {
    const { deps, appended } = recordingDeps();
    async function* failing(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "partial" } };
      throw new Error("provider hung up");
    }
    const tee = teeToRunLog(deps, "c1", "run-1", runAndPersist(deps, CHAT, failing()));
    await expect(
      (async () => {
        for await (const _chunk of tee.stream) {
          tee.onClientGone();
        }
      })(),
    ).rejects.toThrow("provider hung up");
    expect(appended.at(-1)).toMatchObject({ terminal: true, error: "provider hung up" });
  });

  /**
   * Bytes an item cannot hold, and — without object storage — a picture the
   * original connection was the only place to see. Either way the reader is told
   * rather than shown a gap.
   */
  it("keeps a note in place of an image, never its bytes", async () => {
    const withStorage = recordingDeps({
      artifacts: {} as NonNullable<Parameters<typeof recordingDeps>[0]>["artifacts"],
    });
    await run(withStorage.deps, [{ image: { b64: "A".repeat(5_000), mimeType: "image/png" } }], {
      leaveAfter: 1,
    });
    expect(JSON.stringify(withStorage.frames())).not.toContain("AAAA");
    expect(withStorage.frames()).toEqual([
      { warning: expect.stringContaining("once this run finishes") },
    ]);

    const withoutStorage = recordingDeps();
    await run(withoutStorage.deps, [{ image: { b64: "AAAA", mimeType: "image/png" } }], {
      leaveAfter: 1,
    });
    expect(withoutStorage.frames()).toEqual([
      { warning: expect.stringContaining("only visible on the connection") },
    ]);
  });

  /**
   * Reasoning streams a token at a time. Kept verbatim, a deep-thinking run
   * fills the buffer with tens of thousands of tiny frames and evicts the front
   * of the answer — which the saved message holds in full. So the buffer is
   * spent on the answer and the thinking arrives with the message.
   */
  it("keeps one note in place of the whole run's reasoning", async () => {
    const { deps, frames } = recordingDeps();
    await run(
      deps,
      [
        { delta: { reasoningContent: "first " } },
        { delta: { reasoningContent: "second " } },
        { delta: { reasoningContent: "third" } },
        { delta: { content: "answer" } },
      ],
      { leaveAfter: 1 },
    );
    expect(frames()).toEqual([
      { warning: expect.stringContaining("appears on the saved message") },
      { delta: { content: "answer" } },
    ]);
  });

  it("drops a subagent's thinking without spending the note on it", async () => {
    // `runAndPersist` keeps top-level reasoning only, so a note said over a
    // child's would send the reader to a field that will never exist — and burn
    // the one note the parent's own thinking needs.
    const { deps, frames } = recordingDeps();
    await run(
      deps,
      [
        { author: "child", authorPath: ["child"], delta: { reasoningContent: "the child's" } },
        { delta: { reasoningContent: "the parent's" } },
        { delta: { content: "answer" } },
      ],
      { leaveAfter: 1 },
    );
    expect(frames()).toEqual([
      { warning: expect.stringContaining("appears on the saved message") },
      { delta: { content: "answer" } },
    ]);
  });

  it("keeps a chunk that carries the answer beside the thinking", async () => {
    // The substitution is "carries nothing else", so a producer that ever merges
    // the two axes does not have the answer dropped along with the thinking.
    const { deps, frames } = recordingDeps();
    await run(deps, [{ delta: { reasoningContent: "thought", content: "said" } }], {
      leaveAfter: 1,
    });
    expect(frames()).toEqual([{ delta: { reasoningContent: "thought", content: "said" } }]);
  });

  it("replaces a frame too large for a row with a note about it", async () => {
    const { deps, frames } = recordingDeps();
    await run(
      deps,
      [
        {
          toolResult: {
            toolCallId: "call_1",
            name: "fetch",
            content: "x".repeat(150_000),
          },
        },
      ],
      { leaveAfter: 1 },
    );
    expect(frames()).toEqual([{ warning: expect.stringContaining("too large to keep for replay") }]);
  });

  it("says how much of a long run fell out of the buffer", async () => {
    const { deps, frames } = recordingDeps();
    // Well past the buffer's ceiling, so the oldest frames go.
    const chunks = Array.from({ length: 60 }, (_, index) => ({
      delta: { content: `${index}:${"y".repeat(9_000)}` },
    }));
    await run(deps, chunks, { leaveAfter: chunks.length });

    const kept = frames();
    expect(kept.length).toBeLessThan(chunks.length);
    expect(kept[0]).toEqual({
      warning: expect.stringContaining("no longer available to replay"),
    });
    // The tail is what survives — a reader catching up sees the newest of it.
    expect(kept.at(-1)).toEqual(chunks.at(-1));
  });

  it("keeps writing on an interval once detached", async () => {
    vi.useFakeTimers();
    try {
      const { deps, appended } = recordingDeps();
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* source(): AsyncGenerator<EngineChunk> {
        yield { delta: { content: "before" } };
        await gate;
        yield { delta: { content: "after" } };
      }
      const tee = teeToRunLog(deps, "c1", "run-1", runAndPersist(deps, CHAT, source()));
      const drained = (async () => {
        for await (const _chunk of tee.stream) {
          // read
        }
      })();

      // Leave while the run is parked; the first flush is immediate.
      await vi.advanceTimersByTimeAsync(0);
      tee.onClientGone();
      await vi.advanceTimersByTimeAsync(0);
      expect(appended).toHaveLength(1);

      release();
      await vi.advanceTimersByTimeAsync(600);
      await drained;
      expect(appended.filter((entry) => !entry.terminal)).toHaveLength(2);
      expect(appended.at(-1)?.terminal).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])("flushes the final frames after an in-flight append (failure=%s)", async (failFirstWrite) => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { deps, appended, frames, calls, messages } = recordingDeps();
      const gate = Promise.withResolvers<void>();
      const append = deps.runLog.append;
      let first = true;
      deps.runLog.append = async (chatId, runId, entries) => {
        if (first) {
          first = false;
          await gate.promise;
          if (failFirstWrite) throw new Error("first append failed");
        }
        await append(chatId, runId, entries);
      };
      const chunks: EngineChunk[] = [
        { delta: { content: "before" } },
        { delta: { content: " after" } },
        { done: true },
      ];
      const draining = run(deps, chunks, { leaveAfter: 1 });
      await vi.advanceTimersByTimeAsync(0);
      expect(messages.at(-1)?.content).toBe("before after");
      expect(calls).not.toContain("chats.releaseRun");

      gate.resolve();
      await draining;
      expect(frames()).toEqual(failFirstWrite ? chunks.slice(1) : chunks);
      expect(appended.map((entry) => entry.seq)).toEqual(failFirstWrite ? [1, 2] : [0, 1, 2]);
      expect(calls.slice(-2)).toEqual(["runLog.terminal", "chats.releaseRun"]);
      expect(appended.at(-1)?.terminal).toBe(true);
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  /**
   * The replay-row budget counts bytes; `String.length` counts UTF-16 units, and
   * `JSON.stringify` leaves non-ASCII alone. Measured the wrong way a Korean run
   * builds a row three times the size it reports — past the stored-row budget,
   * where the append fails, the sequence has already moved on, and the reader
   * gets a hole no gap check can see.
   */
  it("sizes rows by bytes, so a multi-byte run does not build one past the limit", async () => {
    const { deps, appended } = recordingDeps();
    // 40,000 characters of Korean is 120,000 bytes; ten of them are 1.2MB, which
    // is one row if length is what counts and five if bytes are.
    const chunks = Array.from({ length: 10 }, () => ({
      delta: { content: "가".repeat(40_000) },
    }));
    await run(deps, chunks, { leaveAfter: chunks.length });

    expect(appended.length).toBeGreaterThan(1);
    for (const entry of appended) {
      expect(Buffer.byteLength(entry.payload, "utf8")).toBeLessThanOrEqual(400_000);
    }
  });

  /**
   * A stop is something the reader asked for, and the engine cannot say so — it
   * rethrows the abort like any other. Reported as an error it reaches them as a
   * red banner over the answer they were given, and is kept in the log as a
   * failure a resume replays.
   */
  it("ends cleanly with a note when the reader stopped the run", async () => {
    const { deps, appended, frames, messages } = recordingDeps();
    const controller = new AbortController();
    async function* stopped(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "as far as I got" } };
      controller.abort(STOP_REASON);
      controller.signal.throwIfAborted();
    }
    const tee = teeToRunLog(
      deps,
      "c1",
      "run-1",
      runAndPersist(deps, CHAT, stopped(), controller.signal),
    );
    const seen: EngineChunk[] = [];
    // Resolves rather than rejects: the run is over the way a finished one is.
    for await (const chunk of tee.stream) {
      seen.push(chunk);
      tee.onClientGone();
    }

    expect(seen.at(-1)).toEqual({ warning: STOPPED_NOTICE });
    expect(appended.at(-1)).toMatchObject({ terminal: true });
    expect(appended.at(-1)?.error).toBeUndefined();
    expect(frames().at(-1)).toEqual({ warning: STOPPED_NOTICE });
    // And on the message, not only on the wire: a reader coming back to this
    // chat finds a reply that stops mid-sentence, and nothing else says why.
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "as far as I got",
      warnings: [STOPPED_NOTICE],
    });
  });

  /**
   * A lease that has moved on ends the run too, but nobody pressed anything —
   * reporting it as a stop blames the reader for something they did not do.
   */
  it("says a run ended for it differently from one the reader stopped", async () => {
    const { deps, messages } = recordingDeps();
    const controller = new AbortController();
    async function* superseded(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "as far as I got" } };
      controller.abort(SUPERSEDED_REASON);
      controller.signal.throwIfAborted();
    }
    const tee = teeToRunLog(
      deps,
      "c1",
      "run-1",
      runAndPersist(deps, CHAT, superseded(), controller.signal),
    );
    for await (const _chunk of tee.stream) {
      // read to the end
    }
    expect(messages.at(-1)).toMatchObject({ warnings: [SUPERSEDED_NOTICE] });
  });

  it("still reports a genuine failure as one", async () => {
    const { deps, appended } = recordingDeps();
    const controller = new AbortController();
    async function* failing(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "partial" } };
      throw new Error("provider hung up");
    }
    const tee = teeToRunLog(
      deps,
      "c1",
      "run-1",
      runAndPersist(deps, CHAT, failing(), controller.signal),
    );
    await expect(
      (async () => {
        for await (const _chunk of tee.stream) {
          tee.onClientGone();
        }
      })(),
    ).rejects.toThrow("provider hung up");
    expect(appended.at(-1)).toMatchObject({ terminal: true, error: "provider hung up" });
  });

  /**
   * Last statement of a `finally`: a throw there replaces whatever the run
   * actually did, so a delivered answer arrives followed by an error about
   * bookkeeping. The claim expires on its own.
   */
  it("does not let a failed lease release become the run's outcome", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = recordingDeps();
    deps.chats.releaseRun = async () => {
      throw new Error("dynamo is down");
    };
    // The answer streamed and persisted; the run has to end that way.
    await expect(run(deps, [{ delta: { content: "the answer" } }])).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  /**
   * `detachOnReturn` has not marked itself finished until the tee's `finally`
   * returns, so a disconnect can land while the lease release is in flight. A
   * second pump started there writes the whole buffer and another terminal entry
   * *after* the lease is gone, inverting the one ordering a resume depends on.
   */
  it("ignores a disconnect that lands after the run already ended", async () => {
    const { deps, appended, calls } = recordingDeps();
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "done" } };
    }
    const tee = teeToRunLog(deps, "c1", "run-1", runAndPersist(deps, CHAT, source()));
    for await (const _chunk of tee.stream) {
      // read to the end without leaving
    }
    tee.onClientGone();
    // The wrongly-started pump this guards against reaches its first append
    // synchronously and its terminal entry a few promise hops later; turning
    // the microtask queue over a bounded number of times lets both land
    // without depending on a real timer.
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }

    expect(appended).toEqual([]);
    expect(calls.filter((call) => call.startsWith("runLog"))).toEqual([]);
    expect(calls.at(-1)).toBe("chats.releaseRun");
  });

  it("keeps the run going when the log cannot be written", async () => {
    const { deps } = recordingDeps({
      runLog: {
        async append() {
          throw new Error("dynamo is down");
        },
        async read() {
          return [];
        },
      },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const seen: EngineChunk[] = [];
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "one" } };
      yield { delta: { content: "two" } };
    }
    const tee = teeToRunLog(deps, "c1", "run-1", runAndPersist(deps, CHAT, source()));
    for await (const chunk of tee.stream) {
      seen.push(chunk);
      tee.onClientGone();
    }
    expect(seen).toHaveLength(2);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
