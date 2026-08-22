import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "@/domain/chat/types";
import type { ChatRepository } from "@/domain/chat/repository";
import type { ChatDeps } from "@/application/chat/deps";
import { getChat } from "@/application/chat/getChat";
import { DEFAULT_CHAT_PAGE, listChats } from "@/application/chat/listChats";
import { highestSeq, mergeMessages } from "@/app/chats/_lib/mergeMessages";
import { isSubmitEnter } from "@/app/_lib/modEnter";
import { keys } from "@/infrastructure/db/keys";

function message(seq: number, content: string): ChatMessage {
  return {
    chatId: "c1",
    seq,
    role: seq % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function chat(): Chat {
  return {
    chatId: "c1",
    title: "t",
    ownerEmail: "owner@x.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A repository that records what the use case asked it for. */
function recordingRepo(messages: ChatMessage[]) {
  const asked: { sinceSeq?: number; limit?: number }[] = [];
  const repo = {
    async get() {
      return chat();
    },
    async listByOwner(_ownerEmail: string, options: { limit?: number } = {}) {
      asked.push({ ...(options.limit === undefined ? {} : { limit: options.limit }) });
      return options.limit === undefined ? [chat()] : [chat()].slice(0, options.limit);
    },
    async listMessages(_chatId: string, options: { sinceSeq?: number } = {}) {
      asked.push({ ...(options.sinceSeq === undefined ? {} : { sinceSeq: options.sinceSeq }) });
      return options.sinceSeq === undefined
        ? messages
        : messages.filter((m) => m.seq > (options.sinceSeq as number));
    },
    async getActiveRun() {
      return null;
    },
  } as unknown as ChatRepository;
  return { repo, asked };
}

describe("mergeMessages", () => {
  it("appends a tail to what the thread already holds", () => {
    const held = [message(0, "a"), message(1, "b")];
    expect(mergeMessages(held, [message(2, "c")]).map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("lets the fetched copy win, because its signed URLs are the fresh ones", () => {
    const merged = mergeMessages([message(1, "stale")], [message(1, "fresh")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("fresh");
  });

  it("orders by sequence rather than by arrival", () => {
    const merged = mergeMessages([message(3, "d")], [message(1, "b"), message(2, "c")]);
    expect(merged.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it("returns what it was given when the tail is empty", () => {
    const held = [message(0, "a")];
    expect(mergeMessages(held, [])).toBe(held);
  });
});

describe("highestSeq", () => {
  it("is undefined for a thread holding nothing, so the first read is a full one", () => {
    expect(highestSeq([])).toBeUndefined();
  });

  it("is zero for a chat holding only its opening turn — not a falsy 'no bound'", () => {
    expect(highestSeq([message(0, "a")])).toBe(0);
  });

  it("does not assume the list is sorted", () => {
    expect(highestSeq([message(4, "e"), message(2, "c")])).toBe(4);
  });
});

describe("getChat", () => {
  const deps = (messages: ChatMessage[]) => {
    const { repo, asked } = recordingRepo(messages);
    return { deps: { chats: repo } as unknown as ChatDeps, asked };
  };

  it("reads the whole transcript when no bound is named", async () => {
    const { deps: d, asked } = deps([message(0, "a"), message(1, "b")]);
    const result = await getChat(d, "c1", "owner@x.com");
    expect(result.messages.map((m) => m.seq)).toEqual([0, 1]);
    expect(asked).toEqual([{}]);
  });

  it("reads only what was written after sinceSeq", async () => {
    const { deps: d, asked } = deps([message(0, "a"), message(1, "b"), message(2, "c")]);
    const result = await getChat(d, "c1", "owner@x.com", { sinceSeq: 1 });
    expect(result.messages.map((m) => m.seq)).toEqual([2]);
    expect(asked).toEqual([{ sinceSeq: 1 }]);
  });

  it("treats sinceSeq 0 as a bound, not as its absence", async () => {
    const { deps: d, asked } = deps([message(0, "a"), message(1, "b")]);
    const result = await getChat(d, "c1", "owner@x.com", { sinceSeq: 0 });
    expect(result.messages.map((m) => m.seq)).toEqual([1]);
    expect(asked).toEqual([{ sinceSeq: 0 }]);
  });
});

describe("listChats", () => {
  it("bounds the read even when the caller names no page size", async () => {
    const { repo, asked } = recordingRepo([]);
    await listChats({ chats: repo } as unknown as ChatDeps, "owner@x.com");
    expect(asked).toEqual([{ limit: DEFAULT_CHAT_PAGE }]);
  });

  it("passes the caller's page size through", async () => {
    const { repo, asked } = recordingRepo([]);
    await listChats({ chats: repo } as unknown as ChatDeps, "owner@x.com", 7);
    expect(asked).toEqual([{ limit: 7 }]);
  });
});

describe("chatMessageRange", () => {
  it("starts at the padded sequence, so 10 sorts after 9", () => {
    expect(keys.chatMessageRange(10).from).toBe("MSG#000010");
    expect(keys.chatMessageRange(10).from > keys.chatMessage("c1", 9).SK).toBe(true);
  });

  it("stops before the run log, which sorts after the messages in the same partition", () => {
    const { to } = keys.chatMessageRange(0);
    expect(to).toBe("MSG#999999");
    expect(keys.chatRunLog("c1", "r1", 0).SK > to).toBe(true);
  });
});

describe("isSubmitEnter", () => {
  const event = (init: { key: string; isComposing?: boolean; keyCode?: number }) =>
    ({
      key: init.key,
      nativeEvent: {
        isComposing: init.isComposing ?? false,
        keyCode: init.keyCode ?? 13,
      },
    }) as unknown as React.KeyboardEvent;

  it("is the reader asking on a plain Enter", () => {
    expect(isSubmitEnter(event({ key: "Enter" }))).toBe(true);
  });

  it("is not an Enter that commits an IME composition", () => {
    expect(isSubmitEnter(event({ key: "Enter", isComposing: true }))).toBe(false);
  });

  it("is not an Enter a browser reports as composing on the key alone", () => {
    expect(isSubmitEnter(event({ key: "Enter", keyCode: 229 }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isSubmitEnter(event({ key: "a" }))).toBe(false);
  });
});
