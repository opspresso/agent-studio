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
      ]),
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
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("keeps a tool message paired with its assistant tool_calls", () => {
    expect(
      toEngineMessages([
        message({ seq: 0, role: "user", content: "hi" }),
        message({ seq: 1, role: "assistant", content: "", toolCalls: [{ id: "call_1" }] }),
        message({ seq: 2, role: "tool", content: "42", toolCallId: "call_1" }),
      ]),
    ).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "call_1" }] },
      { role: "tool", content: "42", tool_call_id: "call_1" },
    ]);
  });
});

describe("runAndPersist -> toEngineMessages round-trip", () => {
  it("persists tool results for display but does not replay them into engine context", async () => {
    const { repo } = makeChatRepo(chatFixture("owner@x.com"), [
      message({ seq: 0, role: "user", content: "hi" }),
    ]);
    async function* source(): AsyncGenerator<EngineChunk> {
      yield { toolResult: { toolCallId: "call_1", name: "lookup", content: "42" } };
      yield { delta: { content: "The answer is 42." } };
    }
    for await (const _ of runAndPersist(makeDeps(repo), chatFixture("owner@x.com"), source())) {
      // drain the stream
    }

    const stored = await repo.listMessages("c1");
    // The tool result IS persisted (for UI), alongside the final assistant text.
    expect(
      stored.some((m) => m.role === "tool" && m.content === "42" && m.toolName === "lookup"),
    ).toBe(true);
    expect(stored.some((m) => m.role === "assistant" && m.content === "The answer is 42.")).toBe(
      true,
    );

    // On reload the engine sees only the conversation text — the orphan tool row
    // is dropped because the stored assistant message carries no tool_calls.
    expect(toEngineMessages(stored)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "The answer is 42." },
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
