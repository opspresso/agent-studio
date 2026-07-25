import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "@/application/chat/deps";
import { titleFromMessage } from "@/application/chat/title";
import { toEngineMessages } from "@/application/chat/messageMapping";
import { runAndPersist } from "@/application/chat/run";
import { getChat } from "@/application/chat/getChat";
import { deleteChat } from "@/application/chat/deleteChat";
import { sendMessage } from "@/application/chat/sendMessage";
import { ChatConflictError, ChatForbiddenError, ChatNotFoundError } from "@/application/chat/errors";
import { claimChatRun } from "@/application/chat/runLease";
import { createChatSchema, sendMessageSchema } from "@/app/api/chats/_lib/schemas";

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
}): ChatMessage {
  return {
    chatId: "c1",
    content: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  } as ChatMessage;
}

function makeChatRepo(initial: Chat | null, messages: ChatMessage[] = []) {
  const state: { deleted: boolean; activeRunId?: string } = { deleted: false };
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
      }
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

function makeDeps(repo: ChatRepository, overrides: Partial<ChatDeps> = {}): ChatDeps {
  return {
    chats: repo,
    projects: emptyProjects,
    versions: emptyVersions,
    runAgent: () => emptyAgent(),
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

  it("does not store a subagent's tool results either", async () => {
    // The call is already excluded, so a stored row could never be paired — it
    // is a write per subagent tool call that only ever gets dropped again, and
    // an id it happens to share with a top-level call would cross the two over.
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
    expect(stored.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["parent"]);
    expect(toEngineMessages(stored).messages).toContainEqual({
      role: "tool",
      content: "parent",
      tool_call_id: "call_1",
    });
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
  async function* imageSource(): AsyncGenerator<EngineChunk> {
    yield { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } };
    yield { delta: { content: "Here is your cat." } };
  }

  it("uploads images via storeImage and persists their URLs on the assistant message", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const uploaded: string[] = [];
    const deps = makeDeps(repo, {
      storeImage: async (image) => {
        uploaded.push(image.mimeType);
        return "https://bucket.s3.example.com/images/x.png";
      },
    });
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), imageSource())) {
      // drain the stream
    }

    expect(uploaded).toEqual(["image/png"]);
    const stored = await repo.listMessages("c1");
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant?.images).toEqual([
      { url: "https://bucket.s3.example.com/images/x.png", prompt: "a cat" },
    ]);
  });

  it("drops the image but keeps the message when the upload fails", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const deps = makeDeps(repo, {
      storeImage: async () => {
        throw new Error("upload failed");
      },
    });
    for await (const _ of runAndPersist(deps, chatFixture("owner@x.com"), imageSource())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    const assistant = stored.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("Here is your cat.");
    expect(assistant?.images).toBeUndefined();
  });

  it("persists no images when storeImage is not wired", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    for await (const _ of runAndPersist(
      makeDeps(repo),
      chatFixture("owner@x.com"),
      imageSource(),
    )) {
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

  it("sends the attachment bytes to the engine and persists the uploaded url", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"));
    const seenMessages: unknown[] = [];
    const deps = makeDeps(repo, {
      projects: agentProjects,
      versions: publishedVersions,
      storeImage: async () => "https://bucket.s3.example.com/images/a.png",
      runAgent: (params) => {
        seenMessages.push(...params.messages);
        return emptyAgent();
      },
    });

    const stream = await sendMessage(deps, {
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
    const user = (await repo.listMessages("c1")).find((m) => m.role === "user");
    expect(user?.role === "user" && user.images).toEqual([
      { url: "https://bucket.s3.example.com/images/a.png" },
    ]);
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

    const stream = await sendMessage(deps, {
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

  it("releases the lease when stream persistence is cancelled", async () => {
    const { repo, state } = makeChatRepo(chatFixture("owner@x.com"));
    const runId = await claimChatRun(repo, "c1");
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "partial" } };
      yield { delta: { content: "unread" } };
    }
    const stream = runAndPersist(
      makeDeps(repo),
      chatFixture("owner@x.com"),
      source(),
      runId,
    );

    await stream.next();
    await stream.return(undefined);

    expect(state.activeRunId).toBeUndefined();
  });
});
