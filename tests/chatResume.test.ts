import { describe, expect, it, vi } from "vitest";
import type { ActiveChatRun, Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";
import type { ProjectRepository } from "@/domain/project/repository";
import type { ChatDeps } from "@/application/chat/deps";
import { openRunLogReplay } from "@/application/chat/replayRunLog";
import { getChat } from "@/application/chat/getChat";
import { ChatNotFoundError } from "@/application/chat/errors";

const NOW = Date.parse("2026-08-05T00:00:00.000Z");
const LIVE_LEASE = Math.floor(NOW / 1000) + 600;
const DEAD_LEASE = Math.floor(NOW / 1000) - 1;

const CHAT: Chat = {
  chatId: "c1",
  title: "t",
  ownerEmail: "owner@x.com",
  projectName: "p1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function frame(seq: number, content: string): RunLogEntry {
  return { seq, payload: JSON.stringify([{ delta: { content } }]) };
}

function makeDeps(options: {
  entries?: RunLogEntry[];
  active?: ActiveChatRun | null;
  messages?: ChatMessage[];
}): { deps: ChatDeps; entries: RunLogEntry[]; activeReads: () => number } {
  const entries = options.entries ?? [];
  let activeReads = 0;
  const runLog: ChatRunLogRepository = {
    async append(_chatId, _runId, appended) {
      entries.push(...appended);
    },
    async read(_chatId, _runId, fromSeq, limit = 100) {
      return entries.filter((entry) => entry.seq >= fromSeq).slice(0, limit);
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
    async update() {},
    async delete() {},
    async listMessages() {
      return options.messages ?? [];
    },
    async claimRun() {
      return true;
    },
    async releaseRun() {},
    async getActiveRun() {
      activeReads += 1;
      return options.active === undefined ? null : options.active;
    },
    async requestCancel() {
      return true;
    },
    async reserveMessageSeq() {
      return 0;
    },
    async appendMessage() {},
  } satisfies ChatRepository;

  return {
    entries,
    activeReads: () => activeReads,
    deps: {
      chats,
      runLog,
      projects: {} as ProjectRepository,
      runAgent: () => (async function* () {})(),
      documents: { extract: async () => ({ text: "" }) },
    },
  };
}

async function collect(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  for await (const value of stream) {
    seen.push(value);
  }
  return seen;
}

describe("openRunLogReplay", () => {
  it("refuses a chat the reader does not own", async () => {
    const { deps } = makeDeps({});
    await expect(
      openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "someone@x.com" }),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it("replays the whole run from the start and stops at the terminal entry", async () => {
    const { deps } = makeDeps({
      entries: [
        frame(0, "hello"),
        frame(1, " world"),
        { seq: 2, payload: "[]", terminal: true },
      ],
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen).toEqual([{ delta: { content: "hello" } }, { delta: { content: " world" } }]);
  });

  it("drains a replay larger than one repository page", async () => {
    const entries = Array.from({ length: 205 }, (_, seq) => frame(seq, String(seq)));
    entries.push({ seq: entries.length, payload: "[]", terminal: true });
    const { deps, activeReads } = makeDeps({
      entries,
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });

    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );

    expect(seen).toHaveLength(205);
    expect(seen[0]).toEqual({ delta: { content: "0" } });
    expect(seen.at(-1)).toEqual({ delta: { content: "204" } });
    expect(activeReads()).toBe(0);
  });

  it("surfaces what ended a run that failed", async () => {
    const { deps } = makeDeps({
      entries: [frame(0, "partial"), { seq: 1, payload: "[]", terminal: true, error: "boom" }],
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen.at(-1)).toEqual({ error: "boom" });
  });

  /**
   * The ordinary case for a second window: the run finished while a reader was
   * still attached, so it never wrote itself down. Nothing was lost — the answer
   * is in the conversation the client fetches next — so this ends quietly.
   */
  it("ends without complaint when the claim is gone and nothing was logged", async () => {
    const { deps } = makeDeps({ active: null });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen).toEqual([]);
  });

  it("ends when the claim has moved on to another run", async () => {
    const { deps } = makeDeps({
      active: { runId: "run-2", expiresAtSeconds: LIVE_LEASE },
    });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen).toEqual([]);
  });

  it("reports a run whose instance died rather than waiting on it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const { deps } = makeDeps({
        entries: [frame(0, "half an ans")],
        active: { runId: "run-1", expiresAtSeconds: DEAD_LEASE },
      });
      const seen: unknown[] = [];
      const reading = (async () => {
        for await (const value of await openRunLogReplay(deps, {
          chatId: "c1",
          runId: "run-1",
          userEmail: "owner@x.com",
        })) {
          seen.push(value);
        }
      })();
      // The claim is only looked at once the log goes quiet — one poll after
      // the logged half-answer is delivered.
      await vi.advanceTimersByTimeAsync(500);
      await reading;
      expect(seen).toEqual([
        { delta: { content: "half an ans" } },
        { error: expect.stringContaining("claim expired") },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says the beginning is gone when the log no longer starts at zero", async () => {
    const { deps } = makeDeps({
      entries: [frame(4, "…the rest"), { seq: 5, payload: "[]", terminal: true }],
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen[0]).toEqual({
      warning: expect.stringContaining("beginning of this reply is no longer available"),
    });
  });

  /**
   * A flush that fails has already spent its sequence numbers, so the hole it
   * leaves is in the *middle*. Checked once and remembered, the gap check walked
   * straight past it and the reader got an answer with a piece missing and
   * nothing saying so — the loss this repository reports rather than hides.
   */
  it("says so when a gap opens part-way through, not only at the start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const { deps, entries } = makeDeps({
        entries: [frame(0, "first")],
        active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
      });
      const seen: unknown[] = [];
      const reading = (async () => {
        for await (const value of await openRunLogReplay(deps, {
          chatId: "c1",
          runId: "run-1",
          userEmail: "owner@x.com",
        })) {
          seen.push(value);
        }
      })();
      await vi.advanceTimersByTimeAsync(500);

      // Seq 1 was written by a flush that threw; the run carried on at 2.
      entries.push(frame(2, "third"), { seq: 3, payload: "[]", terminal: true });
      await vi.advanceTimersByTimeAsync(500);
      await reading;

      expect(seen).toEqual([
        { delta: { content: "first" } },
        { warning: expect.stringContaining("could not be read back") },
        { delta: { content: "third" } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same failed flush, seen in one read: a reader connecting after the run
   * ended gets the whole log as a single batch, and the hole sits between two
   * entries *of that batch* rather than between two reads. Checked per entry —
   * a check on the batch's first row walks straight past this one, and the
   * reply plays back with its middle missing and nothing saying so.
   */
  it("reports a gap inside a single read's batch", async () => {
    const { deps } = makeDeps({
      entries: [frame(0, "first"), frame(2, "third"), { seq: 3, payload: "[]", terminal: true }],
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });
    const seen = await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(seen).toEqual([
      { delta: { content: "first" } },
      { warning: expect.stringContaining("could not be read back") },
      { delta: { content: "third" } },
    ]);
  });

  /**
   * Liveness is asked only when the log is quiet. A batch just delivered means
   * the run was alive to write it, and the claim is a strongly-consistent read
   * per poll — paid beside every batch, it doubled the cost of exactly the
   * iterations that were going well.
   */
  it("does not read the claim while the log is delivering", async () => {
    const { deps, activeReads } = makeDeps({
      entries: [frame(0, "hello"), { seq: 1, payload: "[]", terminal: true }],
      active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
    });
    await collect(
      await openRunLogReplay(deps, { chatId: "c1", runId: "run-1", userEmail: "owner@x.com" }),
    );
    expect(activeReads()).toBe(0);
  });

  it("follows the log as it grows, and says why it is empty for long", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const { deps, entries } = makeDeps({
        active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE },
      });
      const seen: unknown[] = [];
      const reading = (async () => {
        for await (const value of await openRunLogReplay(deps, {
          chatId: "c1",
          runId: "run-1",
          userEmail: "owner@x.com",
        })) {
          seen.push(value);
        }
      })();

      // A run writes nothing while another window holds the connection. Say so
      // rather than showing a blank that reads as a stalled reply.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(seen).toEqual([{ warning: expect.stringContaining("another window") }]);

      entries.push(frame(0, "late"), { seq: 1, payload: "[]", terminal: true });
      await vi.advanceTimersByTimeAsync(500);
      await reading;
      expect(seen.at(-1)).toEqual({ delta: { content: "late" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getChat activeRun", () => {
  it("names a run in flight and ignores a claim that has expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const live = makeDeps({ active: { runId: "run-1", expiresAtSeconds: LIVE_LEASE } });
      await expect(getChat(live.deps, "c1", "owner@x.com")).resolves.toMatchObject({
        activeRun: { runId: "run-1" },
      });

      // An instance that died mid-run leaves its claim behind. It says nothing
      // about a run still running, so it must not advertise one.
      const stale = makeDeps({ active: { runId: "run-1", expiresAtSeconds: DEAD_LEASE } });
      expect(await getChat(stale.deps, "c1", "owner@x.com")).not.toHaveProperty("activeRun");
    } finally {
      vi.useRealTimers();
    }
  });
});
