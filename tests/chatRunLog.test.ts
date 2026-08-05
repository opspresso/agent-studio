import { describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "@/application/chat/deps";
import { runAndPersist } from "@/application/chat/run";
import { teeToRunLog } from "@/application/chat/runLog";

const CHAT: Chat = {
  chatId: "c1",
  title: "t",
  ownerEmail: "owner@x.com",
  projectName: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Every write the run made, in the order it made them. */
function recordingDeps(overrides: Partial<ChatDeps> = {}) {
  const appended: RunLogEntry[] = [];
  const calls: string[] = [];
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
    },
  } satisfies ChatRepository;

  const deps: ChatDeps = {
    chats,
    runLog,
    projects: {} as ProjectRepository,
    versions: {} as VersionRepository,
    runAgent: () => (async function* () {})(),
    documents: { extract: async () => ({ text: "" }) },
    ...overrides,
  };
  return { deps, appended, calls, frames: () => appended.flatMap((e) => JSON.parse(e.payload)) };
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
   * DynamoDB writes at all, because the reader saw every frame as it happened.
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
    const withStorage = recordingDeps({ storeImage: async () => "key" });
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
