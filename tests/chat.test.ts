import { describe, expect, it, vi } from "vitest";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatRunLogRepository, RunLogEntry } from "@/domain/chat/runLog";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { AgentRunner, ChatDeps } from "@/application/chat/deps";
import { titleFromMessage } from "@/application/chat/title";
import { toEngineMessages } from "@/application/chat/messageMapping";
import { runAndPersist, userTurnContent, withLeadingWarnings } from "@/application/chat/run";
import { getChat } from "@/application/chat/getChat";
import {
  REPLAY_URL_TTL_SECONDS,
  VIEW_URL_TTL_SECONDS,
} from "@/application/artifact/urlTtl";
import { deleteChat } from "@/application/chat/deleteChat";
import { sendMessage } from "@/application/chat/sendMessage";
import { ChatConflictError, ChatForbiddenError, ChatNotFoundError } from "@/application/chat/errors";
import { RateLimitedError } from "@/application/errors";
import { claimChatRun } from "@/application/chat/runLease";
import { cancelChatRun, watchChatCancel } from "@/application/chat/cancelRun";
import { teeToRunLog } from "@/application/chat/runLog";
import { createChatSchema, sendMessageSchema } from "@/app/api/chats/_lib/schemas";
import { withReplayFrames, withRunFrames } from "@/app/api/chats/_lib/frames";

// --- fixtures ---------------------------------------------------------------

function chatFixture(ownerEmail: string): Chat {
  return {
    chatId: "c1",
    title: "t",
    ownerEmail,
    projectName: "p1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function message(partial: {
  seq: number;
  role: ChatMessage["role"];
  content?: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: import("@/domain/llm/types").ChannelToolCall[];
  images?: import("@/domain/chat/types").ChatMessageImage[];
}): ChatMessage {
  return {
    chatId: "c1",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as ChatMessage;
}

function makeChatRepo(initial: Chat | null, messages: ChatMessage[] = []) {
  const state: { deleted: boolean; activeRunId?: string; cancelRequestedAt?: string } = {
    deleted: false,
  };
  let current = initial;
  let msgs = messages;
  const repo: ChatRepository = {
    async get(chatId) {
      return current && current.chatId === chatId ? current : null;
    },
    async listByOwner(ownerEmail) {
      return current && current.ownerEmail === ownerEmail ? [current] : [];
    },
    async create(chat) {
      current = chat;
    },
    async update(chat) {
      current = chat;
    },
    async delete() {
      state.deleted = true;
      current = null;
      msgs = [];
    },
    async listMessages() {
      return msgs;
    },
    async claimRun(_chatId, runId) {
      if (state.activeRunId) {
        return false;
      }
      state.activeRunId = runId;
      return true;
    },
    async releaseRun(_chatId, runId) {
      if (state.activeRunId === runId) {
        state.activeRunId = undefined;
        state.cancelRequestedAt = undefined;
      }
    },
    async getActiveRun() {
      return state.activeRunId
        ? {
            runId: state.activeRunId,
            expiresAtSeconds: 4_102_444_800,
            ...(state.cancelRequestedAt ? { cancelRequestedAt: state.cancelRequestedAt } : {}),
          }
        : null;
    },
    async requestCancel(_chatId, runId) {
      if (state.activeRunId !== runId) {
        return false;
      }
      state.cancelRequestedAt = "2026-01-01T00:00:00.000Z";
      return true;
    },
    async reserveMessageSeq() {
      return msgs.reduce((max, message) => Math.max(max, message.seq), -1) + 1;
    },
    async appendMessage(m) {
      msgs = [...msgs, m];
    },
  };
  return { repo, state };
}

const emptyProjects: ProjectRepository = {
  async get() {
    return null;
  },
  async list() {
    return [];
  },
  async create() {},
  async update() {},
  async publish() {},
  async delete() {},
  async getApiToken() {
    return null;
  },
  async setApiToken() {},
  async deleteApiToken() {},
};

const emptyVersions: VersionRepository = {
  async get() {
    return null;
  },
  async list() {
    return [];
  },
  async create() {},
  async put() {},
  async delete() {},
};

async function* emptyAgent(): AsyncGenerator<EngineChunk> {}

/** Records what a run wrote down for a reader that left, in order. */
function makeRunLog() {
  const entries: Array<{ runId: string; entry: RunLogEntry }> = [];
  const repo: ChatRunLogRepository = {
    async append(_chatId, runId, appended) {
      for (const entry of appended) {
        entries.push({ runId, entry });
      }
    },
    async read(_chatId, runId, fromSeq) {
      return entries
        .filter((row) => row.runId === runId && row.entry.seq >= fromSeq)
        .map((row) => row.entry);
    },
  };
  /** Every frame the log holds, flattened back out of its batches. */
  const frames = (): unknown[] =>
    entries.flatMap((row) => JSON.parse(row.entry.payload) as unknown[]);
  return { repo, entries, frames };
}

/**
 * Somewhere for a chat's images to go.
 *
 * One bundle rather than the store-and-signer pair it replaces: those had to be
 * wired together — a stored key with no signer is an image nothing can display —
 * and only a comment said so.
 */
function fakeArtifacts(over: { putFails?: boolean } = {}) {
  const puts: Array<{ key: string; mimeType: string; bytes: Uint8Array }> = [];
  const storage = {
    objects: {
      async put(input: { key: string; mimeType: string; bytes: Uint8Array }) {
        if (over.putFails) {
          throw new Error("upload failed");
        }
        puts.push(input);
      },
      async sign(key: string, ttl: number) {
        return `https://signed.example/${key}?ttl=${ttl}`;
      },
      async delete() {},
    },
    rows: {
      async put() {},
      async get() {
        return null;
      },
      async listByProject() {
        return [];
      },
      async listByOwner() {
        return [];
      },
      async delete() {},
    },
  } as unknown as NonNullable<ChatDeps["artifacts"]>;
  return { storage, puts };
}

/** Artifact storage whose signer is the test's own, for the read-time cases. */
function signingArtifacts(
  sign: (key: string, ttl: number) => Promise<string>,
): NonNullable<ChatDeps["artifacts"]> {
  const { storage } = fakeArtifacts();
  return { ...storage, objects: { ...storage.objects, sign } };
}

function makeDeps(repo: ChatRepository, overrides: Partial<ChatDeps> = {}): ChatDeps {
  return {
    chats: repo,
    runLog: makeRunLog().repo,
    projects: emptyProjects,
    versions: emptyVersions,
    runAgent: () => emptyAgent(),
    // Extraction has its own tests; here it only has to turn bytes into text so
    // a document's route through persistence and replay is what is exercised.
    documents: {
      extract: async ({ bytes, maxChars }) => {
        const text = Buffer.from(bytes).toString("utf-8");
        return text.length <= maxChars ? { text } : { text: text.slice(0, maxChars), note: "cut" };
      },
    },
    ...overrides,
  };
}

// --- tests ------------------------------------------------------------------

describe("titleFromMessage", () => {
  it("collapses whitespace and keeps short messages", () => {
    expect(titleFromMessage("  hello   world  ")).toBe("hello world");
  });

  it("truncates to 50 chars with an ellipsis", () => {
    const title = titleFromMessage("a".repeat(80));
    expect(title).toHaveLength(50);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to a default for empty input", () => {
    expect(titleFromMessage("   ")).toBe("New chat");
  });
});

describe("toEngineMessages", () => {
  it("maps user and assistant messages to OpenAI shapes", () => {
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "hi" }),
        message({ seq: 1, role: "assistant", content: "hello" }),
      ]).messages,
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("drops orphaned tool messages with no matching assistant tool_calls", () => {
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "hi" }),
        message({ seq: 1, role: "tool", content: "result", toolCallId: "call_1" }),
        message({ seq: 2, role: "assistant", content: "answer" }),
      ]).messages,
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("pairs a tool row with its assistant even though storage writes it first", () => {
    // A turn is stored as `tool… → assistant`, the reverse of what the wire
    // format accepts, so the row is emitted after the call that declared it.
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "hi" }),
        message({ seq: 1, role: "tool", content: "42", toolCallId: "call_1" }),
        message({ seq: 2, role: "assistant", content: "", toolCalls: [{ id: "call_1" }] }),
      ]).messages,
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
      { role: "tool", content: "42", tool_call_id: "call_1" },
    ]);
  });

  it("marks an image-only turn whose images can no longer be addressed", () => {
    // Left as-is it replays as an empty user message — a shape some providers
    // refuse outright and none can make anything of. The marker also puts the
    // loss where the model reads it, so a follow-up about the picture gets an
    // answer that knows the picture is gone.
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "", images: [{ key: "images/gone.png" }] }),
      ]).messages,
    ).toEqual([{ role: "user", content: "[The image(s) attached to this turn are no longer available.]" }]);
  });

  it("leaves a turn that never carried an image alone", () => {
    // The marker reports a loss; inventing one for a turn stored empty would
    // put a sentence about a missing picture into a conversation that had none.
    expect(
      toEngineMessages([message({ seq: 0, role: "user", content: "" })]).messages,
    ).toEqual([{ role: "user", content: "" }]);
  });

  it("drops a declared call whose result was never stored, rather than orphaning it", () => {
    // A transfer's call has no persisted result; declaring it would make the
    // whole payload invalid.
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "hi" }),
        message({
          seq: 1,
          role: "assistant",
          content: "done",
          toolCalls: [{ id: "call_1" }, { id: "call_missing" }],
        }),
        message({ seq: 2, role: "tool", content: "42", toolCallId: "call_1" }),
      ]).messages,
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done", tool_calls: [{ id: "call_1" }] },
      { role: "tool", content: "42", tool_call_id: "call_1" },
    ]);
  });

  it("replays only the most recent turns' tools", () => {
    const history = [0, 1, 2, 3].flatMap((turn) => [
      message({ seq: turn * 3, role: "user", content: `q${turn}` }),
      message({ seq: turn * 3 + 1, role: "tool", content: `r${turn}`, toolCallId: `call_${turn}` }),
      message({
        seq: turn * 3 + 2,
        role: "assistant",
        content: `a${turn}`,
        toolCalls: [{ id: `call_${turn}` }],
      }),
    ]);

    const mapped = toEngineMessages(history, { toolReplayTurns: 2 }).messages;

    // Every turn's text survives; only the last two carry their tool traffic.
    expect(mapped.filter((m) => m.role === "assistant")).toHaveLength(4);
    expect(mapped.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["r2", "r3"]);
    expect(mapped.filter((m) => m.role === "assistant" && m.tool_calls)).toHaveLength(2);
  });

  it("replays nothing when the option is zero", () => {
    const mapped = toEngineMessages(
      [
        message({ seq: 0, role: "user", content: "hi" }),
        message({ seq: 1, role: "tool", content: "42", toolCallId: "call_1" }),
        message({ seq: 2, role: "assistant", content: "done", toolCalls: [{ id: "call_1" }] }),
      ],
      { toolReplayTurns: 0 },
    ).messages;

    expect(mapped).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
    ]);
  });

  it("truncates replayed tool output rather than letting it fill the context", () => {
    const huge = "x".repeat(30_000);
    const mapped = toEngineMessages([
      message({ seq: 0, role: "user", content: "hi" }),
      message({ seq: 1, role: "tool", content: huge, toolCallId: "call_1" }),
      message({ seq: 2, role: "assistant", content: "done", toolCalls: [{ id: "call_1" }] }),
    ]).messages;

    const replayed = mapped.find((m) => m.role === "tool");
    expect(String(replayed?.content).length).toBeLessThan(huge.length);
    expect(String(replayed?.content)).toContain("[truncated]");
  });
});

describe("runAndPersist -> toEngineMessages round-trip", () => {
  it("replays a turn's tool traffic on the next turn", async () => {
    // Without this the follow-up question reaches a model that cannot see what
    // the tool returned, so it calls the same tool again to answer.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { toolCalls: [{ id: "call_1", function: { name: "lookup" } }] } };
      yield { toolResult: { toolCallId: "call_1", name: "lookup", content: "42" } };
      yield { delta: { content: "The answer is 42." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(
      stored.some((m) => m.role === "tool" && m.content === "42" && m.toolName === "lookup"),
    ).toBe(true);
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({ content: "The answer is 42." });

    expect(toEngineMessages(stored).messages).toEqual([
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "The answer is 42.",
        tool_calls: [{ id: "call_1", function: { name: "lookup" } }],
      },
      { role: "tool", content: "42", tool_call_id: "call_1" },
    ]);
  });

  it("does not claim a subagent's tool calls as its own", async () => {
    // An authored call belongs to the child's conversation; hanging it off this
    // assistant message would declare a result this turn never produced.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { author: "child", delta: { toolCalls: [{ id: "child_call", function: { name: "x" } }] } };
      yield { delta: { content: "Done." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(stored.find((m) => m.role === "assistant")).not.toHaveProperty("toolCalls");
    expect(toEngineMessages(stored).messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("persists the top-level answer of a subagent-wired run, dropping authored chunks", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "Top " } };
      yield { author: "child", delta: { content: "nested subagent text" } };
      yield { delta: { content: "answer." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(stored.some((m) => m.role === "assistant" && m.content === "Top answer.")).toBe(true);
    expect(stored.some((m) => m.content.includes("nested"))).toBe(false);
  });

  it("keeps a subagent's tool results for the reader but never replays them", async () => {
    // Reading a finished chat has to show which agent, skill and tool produced
    // the answer. Replaying those rows is the other error: the matching calls
    // belong to the child's conversation, and an id shared with a top-level
    // call would hand the parent the child's result.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { author: "child", toolResult: { toolCallId: "call_1", name: "x", content: "child" } };
      yield { delta: { toolCalls: [{ id: "call_1", function: { name: "lookup" } }] } };
      yield { toolResult: { toolCallId: "call_1", name: "lookup", content: "parent" } };
      yield { delta: { content: "Done." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    const rows = stored.filter((m) => m.role === "tool");
    expect(rows.map((m) => m.content)).toEqual(["child", "parent"]);
    // The child's row names who ran it and is fenced off from replay.
    expect(rows[0]).toMatchObject({ author: "child", displayOnly: true });
    expect(rows[1]).not.toHaveProperty("displayOnly");

    const replayed = toEngineMessages(stored).messages.filter((m) => m.role === "tool");
    expect(replayed).toEqual([{ role: "tool", content: "parent", tool_call_id: "call_1" }]);
  });

  it("records a successful transfer without replaying it as the answer", async () => {
    // A transfer used to leave no trace at all — only its failures produced a
    // result — so a finished chat could not say which agent had answered.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { toolCalls: [{ id: "call_1", function: { name: "transfer_to_agent" } }] } };
      yield {
        toolResult: {
          toolCallId: "call_1",
          name: "transfer_to_agent: painter",
          content: "Transferred to 'painter'; its answer follows.",
          displayOnly: true,
        },
      };
      yield { delta: { content: "Done." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(stored.find((m) => m.role === "tool")).toMatchObject({
      toolName: "transfer_to_agent: painter",
      displayOnly: true,
    });
    // The child's answer is not persisted, so replaying this marker in its place
    // would tell the model the delegation came back empty.
    expect(toEngineMessages(stored).messages.filter((m) => m.role === "tool")).toEqual([]);
  });

  it("keeps each run's results with its own calls when ids repeat across runs", async () => {
    // Ids are only unique within the run that made them — a gateway that omits
    // them has `call_1` synthesized every run. Matching chat-wide would let the
    // newest result answer the oldest call.
    const stored = [
      message({ seq: 0, role: "user", content: "first" }),
      message({ seq: 1, role: "tool", content: "old result", toolCallId: "call_1" }),
      message({ seq: 2, role: "assistant", content: "a1", toolCalls: [{ id: "call_1" }] }),
      message({ seq: 3, role: "user", content: "second" }),
      message({ seq: 4, role: "tool", content: "new result", toolCallId: "call_1" }),
      message({ seq: 5, role: "assistant", content: "a2", toolCalls: [{ id: "call_1" }] }),
    ];

    const mapped = toEngineMessages(stored).messages;

    expect(mapped.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([
      "old result",
      "new result",
    ]);
  });

  it("says why a generated image is missing instead of dropping it in silence", async () => {
    // An image that was never stored looks exactly like one that was never made,
    // and the run reads as though it ignored the request. The capture reports the
    // failure on the warning channel; this surface's job is to keep that on the
    // message, so a reload still explains where the picture went.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "draw a cat" }),
    ]);
    const deps = makeDeps(repo, { artifacts: fakeArtifacts().storage });
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { author: "painter", image: { b64: "aW1n", mimeType: "image/png" } };
      yield { delta: { content: "Here it is." } };
      yield { warning: "One file this run produced could not be stored: AccessDenied" };
    }
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const assistant = await repo.listMessages("c1").then((m) => m.find((x) => x.role === "assistant"));
    expect(assistant).not.toHaveProperty("images");
    expect((assistant as { warnings?: string[] }).warnings?.[0]).toContain("AccessDenied");
  });

  it("does not repeat the capture's warning when storage is configured", async () => {
    // Two sentences about one lost picture is the noise, not the signal.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "draw a cat" }),
    ]);
    const deps = makeDeps(repo, { artifacts: fakeArtifacts().storage });
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { image: { b64: "aW1n", mimeType: "image/png" } };
      yield { delta: { content: "Here it is." } };
    }
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const assistant = await repo.listMessages("c1").then((m) => m.find((x) => x.role === "assistant"));
    expect((assistant as { warnings?: string[] }).warnings).toBeUndefined();
  });

  it("says when images are shown for this turn only", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "draw a cat" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { image: { b64: "aW1n", mimeType: "image/png" } };
      yield { delta: { content: "Here it is." } };
    }
    // No artifact storage configured at all — nothing upstream warned, so this
    // is the one case the chat surface still speaks for itself.
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const assistant = await repo.listMessages("c1").then((m) => m.find((x) => x.role === "assistant"));
    expect((assistant as { warnings?: string[] }).warnings?.[0]).toContain("not configured");
  });

  it("persists a run's warnings so a reloaded chat still explains itself", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { warning: "MCP server 'crm' is unreachable." };
      yield { warning: "MCP server 'crm' is unreachable." }; // deduplicated
      yield { delta: { content: "Answered without it." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(stored.find((m) => m.role === "assistant")).toMatchObject({
      warnings: ["MCP server 'crm' is unreachable."],
    });
  });
});

describe("history bounds", () => {
  /** `turns` complete runs, each carrying `chars` of assistant text. */
  function history(turns: number, chars: number) {
    return Array.from({ length: turns }, (_, turn) => [
      message({ seq: turn * 2, role: "user", content: `q${turn}` }),
      message({ seq: turn * 2 + 1, role: "assistant", content: "x".repeat(chars) }),
    ]).flat();
  }

  it("replays a whole ordinary chat untouched", () => {
    const { messages, warnings } = toEngineMessages(history(20, 500));

    expect(messages).toHaveLength(40);
    expect(warnings).toEqual([]);
  });

  it("drops the oldest runs once the chat outgrows one request, and says so", () => {
    // Unbounded replay first costs a resend of the whole chat every turn, then
    // fails outright once the provider's context limit is passed.
    const { messages, warnings } = toEngineMessages(history(40, 20_000));

    expect(messages.length).toBeLessThan(80);
    // Whole runs only: never an assistant without the question it answered.
    expect(messages.filter((m) => m.role === "user")).toHaveLength(
      messages.filter((m) => m.role === "assistant").length,
    );
    // The newest turn always survives, and the drop is reported.
    expect(messages.at(-2)).toMatchObject({ role: "user", content: "q39" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("left out");
  });

  it("keeps the newest run even when it alone exceeds the budget", () => {
    const { messages } = toEngineMessages(history(1, 500_000));

    expect(messages).toHaveLength(2);
  });
});

describe("runAndPersist image persistence", () => {
  /**
   * A run whose images were already kept, which is the shape that reaches this
   * surface now: the run bracket stores what a run produces and stamps the key
   * onto the chunk, so persistence here is mapping rather than uploading.
   */
  async function* imageSource(): AsyncGenerator<EngineChunk> {
    yield {
      image: {
        b64: "aGk=",
        mimeType: "image/png",
        prompt: "a cat",
        artifactId: "art-1",
        key: "artifacts/image/art-1.png",
      },
    };
    yield { delta: { content: "Here is your cat." } };
  }

  it("persists the object key the run already stored, never an address", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo, { artifacts: fakeArtifacts().storage });
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), imageSource())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    const assistant = stored.find((m) => m.role === "assistant");
    // The key, not an address: a transcript must not carry a link that keeps
    // working for anyone who ever sees it. The row keeps its own copy rather
    // than pointing at the artifact row, so rendering needs no second read.
    expect(assistant?.images).toEqual([{ key: "artifacts/image/art-1.png", prompt: "a cat" }]);
  });

  it("drops the image but keeps the message when the run could not store it", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo, { artifacts: fakeArtifacts().storage });
    async function* unstored(): AsyncGenerator<EngineChunk> {
      // No key: the capture tried and failed, and said so on its own channel.
      yield { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } };
      yield { delta: { content: "Here is your cat." } };
    }
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), unstored())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Here is your cat.");
    expect(assistant?.images).toBeUndefined();
  });

  it("persists no images when artifact storage is not wired", async () => {
    // Unwired storage means the chunks never carry a key in the first place, so
    // there is nothing for the message to point at.
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    async function* unstored(): AsyncGenerator<EngineChunk> {
      yield { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } };
      yield { delta: { content: "Here is your cat." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), unstored())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    expect(stored.find((m) => m.role === "assistant")?.images).toBeUndefined();
  });
});

describe("runAndPersist size guard and disconnect", () => {
  it("persists the streamed answer when the client disconnects mid-stream", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "partial answer" } };
      yield { delta: { content: " never read" } };
    }
    const stream = runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source());
    await stream.next(); // consume only the first chunk
    await stream.return(undefined); // client disconnect

    const stored = await repo.listMessages("c1");
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("partial answer");
  });

  it("truncates an oversized tool result instead of failing the whole turn", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const huge = "x".repeat(400_000);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { toolResult: { toolCallId: "call_1", name: "big", content: huge } };
      yield { delta: { content: "done" } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    const tool = stored.find((m) => m.role === "tool");
    expect(tool).toBeDefined();
    expect(Buffer.byteLength(tool?.content ?? "", "utf8")).toBeLessThanOrEqual(350_000);
    expect(tool?.content.endsWith("…[truncated]")).toBe(true);
    // The turn still completes: the assistant answer is persisted alongside.
    expect(stored.some((m) => m.role === "assistant" && m.content === "done")).toBe(true);
  });
});

describe("stored images are signed at read time", () => {
  const sign = async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`;

  it("getChat returns a signed URL for a stored key, with the view's lifetime", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      {
        ...message({ seq: 0, role: "assistant", content: "here" }),
        images: [{ key: "images/x.png", prompt: "a cat" }],
      } as ChatMessage,
    ]);
    const result = await getChat(makeDeps(repo, { artifacts: signingArtifacts(sign) }), "c1", "owner@x.com");
    const assistant = result.messages[0];
    expect(assistant?.role === "assistant" && assistant.images).toEqual([
      { url: `https://signed.example/images/x.png?ttl=${VIEW_URL_TTL_SECONDS}`, prompt: "a cat" },
    ]);
  });

  it("getChat still reads a row written before keys existed", async () => {
    const legacy = "https://bucket.s3.ap-northeast-2.amazonaws.com/images/old.png";
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      {
        ...message({ seq: 0, role: "assistant", content: "here" }),
        images: [{ url: legacy }],
      } as ChatMessage,
    ]);
    const result = await getChat(makeDeps(repo, { artifacts: signingArtifacts(sign) }), "c1", "owner@x.com");
    const assistant = result.messages[0];
    expect(assistant?.role === "assistant" && assistant.images).toEqual([{ url: legacy }]);
  });
});

describe("ownership checks", () => {
  it("getChat returns chat and messages for the owner", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    const result = await getChat(makeDeps(repo), "c1", "owner@x.com");
    expect(result.chat.chatId).toBe("c1");
    expect(result.messages).toHaveLength(1);
  });

  it("getChat treats a non-owner as 404", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    await expect(getChat(makeDeps(repo), "c1", "intruder@x.com")).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });

  it("getChat treats a missing chat as 404", async () => {
    const { repo } = makeChatRepo(null);
    await expect(getChat(makeDeps(repo), "c1", "owner@x.com")).rejects.toBeInstanceOf(
      ChatNotFoundError,
    );
  });

  it("deleteChat rejects a non-owner with 403 and does not delete", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    await expect(deleteChat(makeDeps(repo), "c1", "intruder@x.com")).rejects.toBeInstanceOf(
      ChatForbiddenError,
    );
    expect(state.deleted).toBe(false);
  });

  it("deleteChat deletes for the owner", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    await deleteChat(makeDeps(repo), "c1", "owner@x.com");
    expect(state.deleted).toBe(true);
  });

  it("sendMessage rejects a non-owner with 403 before touching the project", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    await expect(
      sendMessage(makeDeps(repo), { chatId: "c1", content: "hey", userEmail: "intruder@x.com" }),
    ).rejects.toBeInstanceOf(ChatForbiddenError);
  });

  it("error statuses map to HTTP codes", () => {
    expect(new ChatNotFoundError().status).toBe(404);
    expect(new ChatForbiddenError().status).toBe(403);
  });
});

describe("chat image attachments", () => {
  const PNG = { b64: "YXR0YWNoZWQ=", mimeType: "image/png" };

  const agentProjects: ProjectRepository = {
    ...emptyProjects,
    async get() {
      return {
        name: "p1",
        displayName: "P1",
        description: "",
        projectType: "agent",
        ownerEmail: "owner@x.com",
        publishedVersion: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
  const publishedVersions: VersionRepository = {
    ...emptyVersions,
    async get() {
      return {
        projectName: "p1",
        versionName: "1",
        systemPrompt: "",
        userPromptTemplate: "",
        model: "google/gemini-2.5-flash",
        parameters: { piiFiltering: false },
        mcpList: [],
        skillList: [],
        subagentList: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };

  it("replays a stored attachment as an image content part", () => {
    const stored = message({ seq: 0, role: "user", content: "look" });
    (stored as { images?: Array<{ url: string }> }).images = [
      { url: "https://bucket.s3.example.com/images/a.png" },
    ];

    expect(toEngineMessages([stored]).messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "https://bucket.s3.example.com/images/a.png" },
          },
        ],
      },
    ]);
  });

  it("omits the text part when the stored turn was image-only", () => {
    const stored = message({ seq: 0, role: "user", content: "" });
    (stored as { images?: Array<{ url: string }> }).images = [{ url: "https://x/y.png" }];

    expect(toEngineMessages([stored]).messages).toEqual([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }],
      },
    ]);
  });

  /**
   * The lease is claimed before the turn is written, so a write that throws
   * between the two leaves it held. Nothing released it in a test until now, and
   * the failure is directly visible: the chat reads as "running" for the whole
   * lease window, refuses new messages, and cannot be freed by the stop button
   * because there is no run to stop.
   */
  it("releases the run lease when setup fails after claiming it", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    repo.reserveMessageSeq = async () => {
      throw new Error("dynamo down");
    };

    await expect(
      sendMessage(makeDeps(repo, { projects: agentProjects, versions: publishedVersions }), {
        chatId: "c1",
        content: "hey",
        userEmail: "owner@x.com",
      }),
    ).rejects.toThrow("dynamo down");

    expect(state.activeRunId).toBeUndefined();
  });

  it("leaves no lease behind when the turn cannot be appended either", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    repo.appendMessage = async () => {
      throw new Error("item too large");
    };

    await expect(
      sendMessage(makeDeps(repo, { projects: agentProjects, versions: publishedVersions }), {
        chatId: "c1",
        content: "hey",
        userEmail: "owner@x.com",
      }),
    ).rejects.toThrow("item too large");

    expect(state.activeRunId).toBeUndefined();
  });

  it("replays a stored image to the provider with the run-length lifetime", async () => {
    // The provider fetches this, not the browser, and it may do so at the very
    // end of a run allowed to last MAX_RUN_DURATION_MS.
    const sign = async (key: string, ttl: number) => `https://signed.example/${key}?ttl=${ttl}`;
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      {
        ...message({ seq: 0, role: "user", content: "look" }),
        images: [{ key: "images/x.png" }],
      } as ChatMessage,
    ]);
    const seenMessages: unknown[] = [];
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      artifacts: signingArtifacts(sign),
      runAgent: (params) => {
        seenMessages.push(...params.messages);
        return emptyAgent();
      },
    });
    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "and now?",
      userEmail: "owner@x.com",
    });
    for await (const _ of stream) {
      // drain
    }
    expect(JSON.stringify(seenMessages)).toContain(
      `https://signed.example/images/x.png?ttl=${REPLAY_URL_TTL_SECONDS}`,
    );
  });

  it("names the chat as the run's conversation, on the first message and every later one", async () => {
    const seen: string[] = [];
    const runAgent = (params: Parameters<AgentRunner>[0]) => {
      seen.push(`${params.conversation.surface}:${params.conversation.id}`);
      return emptyAgent();
    };
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo, { projects: agentProjects, versions: publishedVersions, runAgent });
    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "and now?",
      userEmail: "owner@x.com",
    });
    for await (const _ of stream) {
      // drain
    }
    expect(seen).toEqual(["chat:c1"]);
  });

  it("sends the attachment bytes to the engine and persists the uploaded key", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const seenMessages: unknown[] = [];
    const attachmentStore = fakeArtifacts();
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      artifacts: attachmentStore.storage,
      runAgent: (params) => {
        seenMessages.push(...params.messages);
        return emptyAgent();
      },
    });

    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "what is this?",
      images: [PNG],
      userEmail: "owner@x.com",
    });
    for await (const _ of stream) {
      // drain so the run completes and persistence happens
    }

    // The engine gets real bytes — that is what makes the attachment editable.
    expect(seenMessages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,YXR0YWNoZWQ=" } },
        ],
      },
    ]);
    // Stored under the artifact layout, so this attachment now has a row that
    // can list and delete it — the pre-artifact `images/<uuid>` keys had none.
    const user = (await repo.listMessages("c1")).find((m) => m.role === "user");
    const key = user?.role === "user" ? user.images?.[0]?.key : undefined;
    expect(key).toMatch(/^artifacts\/image\/[0-9a-f-]+\.png$/);
    expect(attachmentStore.puts[0]?.key).toBe(key);
  });

  it("still runs the turn when image persistence is unconfigured", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const seenMessages: unknown[] = [];
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      runAgent: (params) => {
        seenMessages.push(...params.messages);
        return emptyAgent();
      },
    });

    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "",
      images: [PNG],
      userEmail: "owner@x.com",
    });
    for await (const _ of stream) {
      // drain
    }

    expect(seenMessages).toEqual([
      {
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:image/png;base64,YXR0YWNoZWQ=" } }],
      },
    ]);
    const user = (await repo.listMessages("c1")).find((m) => m.role === "user");
    expect(user?.role === "user" && user.images).toBeUndefined();
  });
});

describe("chat request schemas", () => {
  const image = { b64: "aGk=", mimeType: "image/png" };

  it("accepts an image-only turn but not an empty one", () => {
    expect(sendMessageSchema.safeParse({ content: "", images: [image] }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ content: "hi" }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(sendMessageSchema.safeParse({}).success).toBe(false);
  });

  it("rejects unsupported types, oversized payloads and too many images", () => {
    expect(
      sendMessageSchema.safeParse({ content: "x", images: [{ ...image, mimeType: "image/svg+xml" }] })
        .success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({ content: "x", images: [{ ...image, b64: "A".repeat(7_500_000) }] })
        .success,
    ).toBe(false);
    expect(
      sendMessageSchema.safeParse({ content: "x", images: Array(5).fill(image) }).success,
    ).toBe(false);
  });

  it("requires a project and something to say when creating a chat", () => {
    expect(createChatSchema.safeParse({ projectName: "p1", images: [image] }).success).toBe(true);
    expect(createChatSchema.safeParse({ projectName: "p1", firstMessage: "hi" }).success).toBe(true);
    expect(createChatSchema.safeParse({ projectName: "p1" }).success).toBe(false);
    expect(createChatSchema.safeParse({ firstMessage: "hi" }).success).toBe(false);
  });
});

describe("chat run lease", () => {
  it("rejects a second concurrent run and allows a run after release", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const firstRunId = await claimChatRun(repo, "c1");

    await expect(claimChatRun(repo, "c1")).rejects.toBeInstanceOf(ChatConflictError);

    await repo.releaseRun("c1", firstRunId);
    await expect(claimChatRun(repo, "c1")).resolves.toEqual(expect.any(String));
  });

  it("releases the lease when a run is cut short", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo);
    const runId = await claimChatRun(repo, "c1");
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "partial" } };
      yield { delta: { content: "unread" } };
    }
    const { stream } = teeToRunLog(
      deps,
      "c1",
      runId,
      runAndPersist(deps, chatFixture("owner@x.com"), source()),
    );

    await stream.next();
    await stream.return(undefined);

    expect(state.activeRunId).toBeUndefined();
  });
});

/**
 * Closing the tab used to be the stop button. Now that a run outlives its
 * reader, stopping one is a deliberate act — and a persisted one, because the
 * instance answering the press is not necessarily the one running the answer.
 */
describe("stopping a run", () => {
  it("records the stop, and treats one aimed at a finished run as nothing to do", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo);
    const runId = await claimChatRun(repo, "c1");

    await expect(
      cancelChatRun(deps, { chatId: "c1", runId: "some-other-run", userEmail: "owner@x.com" }),
    ).resolves.toEqual({ cancelled: false });

    await expect(
      cancelChatRun(deps, { chatId: "c1", runId, userEmail: "owner@x.com" }),
    ).resolves.toEqual({ cancelled: true });
    expect(state.cancelRequestedAt).toEqual(expect.any(String));
  });

  it("refuses a stop from anyone but the owner", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo);
    const runId = await claimChatRun(repo, "c1");

    await expect(
      cancelChatRun(deps, { chatId: "c1", runId, userEmail: "someone@x.com" }),
    ).rejects.toBeInstanceOf(ChatForbiddenError);
    await expect(
      cancelChatRun(deps, { chatId: "missing", runId, userEmail: "owner@x.com" }),
    ).rejects.toBeInstanceOf(ChatNotFoundError);
  });

  it("aborts the run once a stop lands, and once the lease names someone else", async () => {
    vi.useFakeTimers();
    try {
      const { repo } = makeChatRepo(chatFixture("owner@x.com"));
      const runId = await claimChatRun(repo, "c1");
      const controller = new AbortController();
      const stop = watchChatCancel(repo, "c1", runId, controller);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(controller.signal.aborted).toBe(false);

      await repo.requestCancel("c1", runId);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(controller.signal.aborted).toBe(true);
      stop();

      // A lease that has moved on means this run is finishing into nothing.
      const orphaned = new AbortController();
      const stopOrphan = watchChatCancel(repo, "c1", "a-run-that-lost-its-claim", orphaned);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(orphaned.signal.aborted).toBe(true);
      stopOrphan();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("run stream frames", () => {
  /**
   * A closed body says nothing about *why* it closed. The trailing frame is how
   * a client tells a finished run from a cut-off one — and it is absent when the
   * run throws, because the SSE layer answers that with an `{error}` frame.
   */
  it("wraps the run in a head frame and an explicit end", async () => {
    async function* source(): AsyncGenerator<unknown> {
      yield { delta: { content: "hi" } };
    }
    const seen: unknown[] = [];
    for await (const frame of withRunFrames({ runId: "r1", userSeq: 3 }, source())) {
      seen.push(frame);
    }
    expect(seen).toEqual([
      { runId: "r1", userSeq: 3 },
      { delta: { content: "hi" } },
      { ended: true },
    ]);
  });

  /**
   * The response bytes wait on this generator's first value: `sseResponse`
   * builds the `Response` around it, and the keepalive starts with it. A run
   * whose first token is a minute out must not hold the headers — and the chat
   * id the client needs to reattach — off the wire while the ALB counts down
   * its idle timeout.
   */
  it("answers with the head frame before pulling the run", async () => {
    let pulled = false;
    async function* slow(): AsyncGenerator<unknown> {
      pulled = true;
      yield { delta: { content: "hi" } };
    }
    const stream = withRunFrames({ runId: "r1" }, slow());
    expect(await stream.next()).toEqual({ done: false, value: { runId: "r1" } });
    expect(pulled).toBe(false);
  });

  /**
   * The other side of that ordering: a run refused over its cost limit throws
   * on its first `next()`, which is now after the head frame — the SSE layer
   * answers it with an `{error}` frame on the committed stream, no longer with
   * a 429.
   */
  it("delivers a refusal after the head frame, as the stream's failure", async () => {
    async function* refused(): AsyncGenerator<unknown> {
      throw new RateLimitedError("over the daily cost limit", 42);
    }
    const stream = withRunFrames({ runId: "r1" }, refused());
    expect(await stream.next()).toEqual({ done: false, value: { runId: "r1" } });
    await expect(stream.next()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("emits no end frame when the run throws", async () => {
    async function* failing(): AsyncGenerator<unknown> {
      yield { delta: { content: "partial" } };
      throw new Error("provider hung up");
    }
    const seen: unknown[] = [];
    await expect(
      (async () => {
        for await (const frame of withRunFrames({ runId: "r1" }, failing())) {
          seen.push(frame);
        }
      })(),
    ).rejects.toThrow("provider hung up");
    expect(seen).toEqual([{ runId: "r1" }, { delta: { content: "partial" } }]);
  });

  /**
   * The refusal has to survive a turn that carries leading warnings — a
   * truncated history, an attachment that could not be stored. The warnings
   * pull the engine before speaking for it, so a refused run fails on the frame
   * after the head rather than emitting warnings about a run that never
   * started.
   */
  it("refuses right after the head frame when the turn carries leading warnings", async () => {
    async function* refused(): AsyncGenerator<EngineChunk> {
      throw new RateLimitedError("over the daily cost limit", 42);
    }
    const stream = withRunFrames(
      { runId: "r1" },
      withLeadingWarnings(["3 earlier runs were left out"], refused()),
    );
    expect(await stream.next()).toEqual({ done: false, value: { runId: "r1" } });
    await expect(stream.next()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("keeps the leading warnings ahead of the answer they are about", async () => {
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "hi" } };
    }
    const seen: unknown[] = [];
    for await (const frame of withRunFrames(
      { runId: "r1" },
      withLeadingWarnings(["a", "b"], source()),
    )) {
      seen.push(frame);
    }
    expect(seen).toEqual([
      { runId: "r1" },
      { warning: "a" },
      { warning: "b" },
      { delta: { content: "hi" } },
      { ended: true },
    ]);
  });

  /**
   * A replay has nothing to refuse — the ownership check is awaited before the
   * generator exists — and the log of a run another window is holding is empty
   * by design, so its first frame is a notice five seconds out. Pulling for that
   * before answering leaves the browser with no headers for five seconds, which
   * a proxy reads as a dead backend rather than a slow one.
   */
  it("answers a replay with its head frame before pulling anything", async () => {
    let pulled = false;
    async function* slow(): AsyncGenerator<unknown> {
      pulled = true;
      yield { warning: "still going" };
    }
    const stream = withReplayFrames({ runId: "r1" }, slow());
    expect(await stream.next()).toEqual({ done: false, value: { runId: "r1" } });
    expect(pulled).toBe(false);
  });
});

/**
 * Documents in a chat. The file is never stored — only the text read out of it —
 * and storing that text is what lets the *next* question still have the
 * document. A turn that only sent it to the engine would answer "summarise this"
 * and then fail "what does section 3 say?".
 */
describe("attached documents", () => {
  const agentProjects: ProjectRepository = {
    ...emptyProjects,
    async get() {
      return {
        name: "agent",
        displayName: "Agent",
        description: "",
        projectType: "agent",
        ownerEmail: "owner@x.com",
        publishedVersion: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };
  const publishedVersions: VersionRepository = {
    ...emptyVersions,
    async get() {
      return {
        projectName: "agent",
        versionName: "1",
        systemPrompt: "",
        userPromptTemplate: "",
        model: "google/gemini-2.5-flash",
        parameters: { piiFiltering: false },
        mcpList: [],
        skillList: [],
        subagentList: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      };
    },
  };

  it("sends the extracted text to the engine and keeps it on the stored turn", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const seenMessages: unknown[] = [];
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      runAgent: (params) => {
        seenMessages.push(...params.messages);
        return emptyAgent();
      },
    });

    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "summarise this",
      documents: [
        {
          b64: Buffer.from("Q3 revenue rose 12%", "utf-8").toString("base64"),
          mimeType: "text/plain",
          name: "q3.txt",
        },
      ],
      userEmail: "owner@x.com",
    });
    for await (const _ of stream) {
      // drain so the run completes and persistence happens
    }

    const sent = seenMessages[0] as { content: string };
    // No image, so the turn stays the string every text-only turn has always
    // been; a documents-only turn must not put a new shape on the wire.
    expect(typeof sent.content).toBe("string");
    expect(sent.content).toContain('[Attached file "q3.txt"');
    expect(sent.content).toContain("Q3 revenue rose 12%");
    expect(sent.content.endsWith("summarise this")).toBe(true);

    const stored = await repo.listMessages("c1");
    const user = stored.find((message) => message.role === "user");
    // The text, not the bytes: a 10MB file does not fit in a DynamoDB item, and
    // the text is what the turn actually carried.
    expect((user as { documents?: unknown }).documents).toEqual([
      { name: "q3.txt", text: "Q3 revenue rose 12%" },
    ]);
  });

  it("replays a stored document exactly as the turn that sent it", () => {
    const first = message({ seq: 0, role: "user", content: "summarise this" });
    (first as { documents?: unknown }).documents = [{ name: "q3.txt", text: "revenue rose" }];

    const replayed = toEngineMessages([first]).messages[0] as { content: string };

    // Same wrapper, same order, same shape — otherwise a follow-up turn would
    // put the model in a different conversation than the one the chat recorded.
    expect(replayed.content).toBe(
      userTurnContent("summarise this", [], [{ name: "q3.txt", text: "revenue rose" }]),
    );
    expect(replayed.content).toContain('[Attached file "q3.txt"');
  });

  it("answers, and says why, when the document could not be read", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      documents: {
        extract: async () => {
          throw new DocumentExtractionError("it is password-protected");
        },
      },
    });

    const chunks: unknown[] = [];
    const { stream } = await sendMessage(deps, {
      chatId: "c1",
      content: "summarise this",
      documents: [{ b64: "AAAA", mimeType: "application/pdf", name: "locked.pdf" }],
      userEmail: "owner@x.com",
    });
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // Ahead of the answer, on the same channel an unusable binding uses.
    expect(JSON.stringify(chunks)).toContain("Could not read locked.pdf");
    expect(JSON.stringify(chunks)).toContain("password-protected");
    // Nothing to store: the turn carried no document.
    const stored = await repo.listMessages("c1");
    expect(stored.find((message) => message.role === "user")).not.toHaveProperty("documents");
  });
});
