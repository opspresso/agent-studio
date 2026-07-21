import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { EngineChunk } from "@/domain/llm/types";
import type { ChatDeps } from "@/application/chat/deps";
import { titleFromMessage } from "@/application/chat/title";
import { toEngineMessages } from "@/application/chat/messageMapping";
import { getChat } from "@/application/chat/getChat";
import { deleteChat } from "@/application/chat/deleteChat";
import { sendMessage } from "@/application/chat/sendMessage";
import { ChatForbiddenError, ChatNotFoundError } from "@/application/chat/errors";

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

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "seq" | "role">): ChatMessage {
  return { chatId: "c1", content: "", createdAt: "2026-01-01T00:00:00.000Z", ...partial };
}

function makeChatRepo(initial: Chat | null, messages: ChatMessage[] = []) {
  const state = { deleted: false };
  let current = initial;
  let msgs = messages;
  const repo: ChatRepository = {
    async get(chatId) {
      return current && current.chatId === chatId ? current : null;
    },
    async listByOwner(ownerEmail) {
      return current && current.ownerEmail === ownerEmail ? [current] : [];
    },
    async put(chat) {
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
  async delete() {},
};

const emptyVersions: VersionRepository = {
  async get() {
    return null;
  },
  async list() {
    return [];
  },
  async put() {},
  async delete() {},
};

async function* emptyAgent(): AsyncGenerator<EngineChunk> {}

function makeDeps(repo: ChatRepository): ChatDeps {
  return {
    chats: repo,
    projects: emptyProjects,
    versions: emptyVersions,
    runAgent: () => emptyAgent(),
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
