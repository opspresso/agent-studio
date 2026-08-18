import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTelegramUpdate } from "@/application/telegram/engagement";
import { handleTelegramUpdate } from "@/application/telegram/handleUpdate";
import type { TelegramEventDeps, TelegramMessage, TelegramUpdate } from "@/application/telegram/types";
import type { TelegramClientPort } from "@/domain/telegram/client";
import type { TranscriptTurn } from "@/domain/messaging/transcript";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { ExecuteAgentInput } from "@/application/execution/deps";
import type { Project, Version } from "@/domain/project/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";

const NOW = 1_750_000_000_000;

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "a bot that paints",
    projectType: "agent",
    ownerEmail: "owner@x.com",
    publishedVersion: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(callerContext = false): Version {
  return {
    projectName: "painter",
    versionName: "1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false, ...(callerContext ? { callerContext: true } : {}) },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeTelegramFake() {
  const sent: Array<{ chatId: number; text: string; replyTo?: number; threadId?: number }> = [];
  const edits: Array<{ messageId: number; text: string }> = [];
  const actions: string[] = [];
  const downloads: string[] = [];
  const photos: string[] = [];
  let nextId = 1;
  const telegram: TelegramClientPort = {
    async getMe() {
      return { id: 42, username: "painter_bot" };
    },
    async setWebhook() {},
    async deleteWebhook() {},
    async sendMessage(_token, args) {
      const id = nextId++;
      sent.push({
        chatId: args.chatId,
        text: args.text,
        ...(args.replyToMessageId !== undefined ? { replyTo: args.replyToMessageId } : {}),
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
      });
      return { messageId: id };
    },
    async editMessageText(_token, args) {
      edits.push({ messageId: args.messageId, text: args.text });
    },
    async sendChatAction(_token, args) {
      actions.push(args.action);
    },
    async sendPhoto(_token, args) {
      photos.push(args.filename);
    },
    async downloadFile(_token, fileId) {
      downloads.push(fileId);
      return Buffer.from("png-bytes");
    },
  };
  const finalText = () => edits.at(-1)?.text ?? sent.at(-1)?.text ?? "";
  return { telegram, sent, edits, actions, downloads, photos, finalText };
}

function makeDeps(chunks: EngineChunk[], telegram: TelegramClientPort, options: { callerContext?: boolean } = {}) {
  const runs: ExecuteAgentInput[] = [];
  const remembered: Array<{ key: string; turn: TranscriptTurn }> = [];
  const stored: TranscriptTurn[] = [];
  const deps: TelegramEventDeps = {
    runAgent: async function* (input) {
      runs.push(input);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    projects: { get: async () => projectFixture() } as unknown as ProjectRepository,
    versions: {
      get: async (_project: string, name: string) =>
        name === projectFixture().publishedVersion ? versionFixture(options.callerContext) : null,
      list: async () => [],
    } as unknown as VersionRepository,
    documents: {
      extract: async ({ bytes }) => ({ text: Buffer.from(bytes).toString("utf-8") }),
    },
    telegram,
    transcripts: {
      recent: async () => stored,
      append: async (_project, key, turn) => {
        remembered.push({ key, turn });
      },
    },
    sleep: async () => {},
  };
  return { deps, runs, remembered, stored };
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 7,
    date: 0,
    from: { id: 1, first_name: "Bruce", last_name: "Lee" },
    chat: { id: 100, type: "private" },
    text: "hello",
    ...overrides,
  };
}

const BOT = { botId: 42, botUsername: "painter_bot" };
const BINDING = { projectName: "painter", botToken: "42:tok", botUsername: "painter_bot" };

function dispositionOf(update: TelegramUpdate) {
  const disposition = classifyTelegramUpdate(update, BOT);
  if (disposition.kind === "ignore") {
    throw new Error(`test update was ignored: ${disposition.because}`);
  }
  return disposition;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTelegramUpdate", () => {
  it("remembers an admitted chat and forum topic for later destination selection", async () => {
    const { telegram } = makeTelegramFake();
    const { deps } = makeDeps([{ done: true }], telegram);
    const puts = vi.fn(async () => {});
    deps.destinations = { put: puts, list: async () => [] };

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          date: 1_700_000_000,
          chat: { id: -5, type: "supergroup", title: "Ops", is_forum: true },
          message_thread_id: 9,
          is_topic_message: true,
          text: "@painter_bot hi",
          entities: [{ type: "mention", offset: 0, length: 12 }],
        }),
      }),
      BINDING,
    );

    expect(puts).toHaveBeenCalledWith("painter", 42, {
      chatId: -5,
      chatType: "supergroup",
      title: "Ops",
      threadId: 9,
      lastSeenAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("still answers when remembering a destination fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { telegram, finalText } = makeTelegramFake();
    const { deps } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);
    deps.destinations = {
      put: async () => {
        throw new Error("store unavailable");
      },
      list: async () => [],
    };

    await handleTelegramUpdate(
      deps,
      dispositionOf({ update_id: 1, message: message() }),
      BINDING,
    );

    expect(finalText()).toBe("ok");
  });

  it("runs the bound project with the Telegram user as the actor and the chat as the conversation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, finalText, sent } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ delta: { content: "hi there" } }, { done: true }], telegram);

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message() }), BINDING);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.actor).toEqual({ kind: "telegram", id: "1" });
    expect(runs[0]?.conversation).toEqual({ surface: "telegram", id: "100" });
    expect(runs[0]?.caller).toBeUndefined();
    const last = runs[0]?.messages.at(-1);
    expect(last && messageText(last)).toBe("hello");
    expect(finalText()).toBe("hi there");
    expect(sent[0]?.replyTo).toBe(7);
  });

  it("names a forum topic in the conversation and answers in it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, sent } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          chat: { id: -5, type: "supergroup", is_forum: true },
          message_thread_id: 9,
          is_topic_message: true,
          text: "@painter_bot hi",
          entities: [{ type: "mention", offset: 0, length: 12 }],
        }),
      }),
      BINDING,
    );

    expect(runs[0]?.conversation).toEqual({ surface: "telegram", id: "-5:9" });
    expect(sent[0]?.threadId).toBe(9);
    const last = runs[0]?.messages.at(-1);
    expect(last && messageText(last)).toBe("hi");
  });

  it("keeps a reply chain in an ordinary group inside the group's conversation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, sent } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          chat: { id: -7, type: "supergroup" },
          // Telegram stamps a reply chain's root here in a non-forum group.
          message_thread_id: 100,
          text: "and then?",
          reply_to_message: message({ from: { id: 42, is_bot: true }, text: "earlier" }),
        }),
      }),
      BINDING,
    );

    expect(runs[0]?.conversation).toEqual({ surface: "telegram", id: "-7" });
    expect(sent[0]?.threadId).toBeUndefined();
  });

  it("stamps the turns with when the message arrived, so concurrent runs are remembered in the order asked", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const { deps, remembered } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message({ date: 1_700_000_000 }) }), BINDING);

    expect(remembered.map((entry) => entry.turn.createdAt)).toEqual([
      new Date(1_700_000_000_000).toISOString(),
      new Date(1_700_000_000_001).toISOString(),
    ]);
  });

  it("writes down what a text-less turn carried, on both sides", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const { deps, remembered } = makeDeps(
      [{ image: { b64: "AA==", mimeType: "image/png", prompt: "a cat" } }, { done: true }],
      telegram,
    );

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          text: undefined,
          photo: [{ file_id: "p", file_unique_id: "u1", width: 1, height: 1, file_size: 10 }],
        }),
      }),
      BINDING,
    );

    expect(remembered.map((entry) => [entry.turn.role, entry.turn.content])).toEqual([
      ["user", "[sent photo-u1.jpg]"],
      ["assistant", "[sent 1 image]"],
    ]);
  });

  it("does not read names an earlier version wrote down once the opt-in is off", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const { deps, runs, stored } = makeDeps([{ done: true }], telegram);
    stored.push(
      { role: "user", content: "earlier", userId: "2", speaker: "Ann", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "user", content: "and me", userId: "3", speaker: "Bob", createdAt: "2026-01-01T00:00:01.000Z" },
    );

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          chat: { id: -1, type: "group" },
          text: "@painter_bot now",
          entities: [{ type: "mention", offset: 0, length: 12 }],
        }),
      }),
      BINDING,
    );

    expect(runs[0]?.messages.map((turn: ChatMessageInput) => messageText(turn))).toEqual(["earlier", "and me", "now"]);
  });

  it("carries the newest turns that fit the character budget, and says what it left out", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, finalText } = makeTelegramFake();
    const { deps, runs, stored } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);
    for (let i = 0; i < 12; i += 1) {
      stored.push({ role: i % 2 ? "assistant" : "user", content: `${i}:${"x".repeat(19_990)}`, createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` });
    }

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message() }), BINDING);

    const carried = runs[0]?.messages.length ?? 0;
    // Five 20,000-char turns fit 100,000; the sixth would not, plus the new question.
    expect(carried).toBe(6);
    expect(runs[0]?.messages[0] && messageText(runs[0].messages[0]).startsWith("7:")).toBe(true);
    expect(finalText()).toContain("Older conversation turns were left out");
  });

  it("names a voice note as an attachment the run could not read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, finalText } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ delta: { content: "hm" } }, { done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          text: undefined,
          caption: "what do you hear?",
          voice: { file_id: "v", file_unique_id: "u", mime_type: "audio/ogg", file_size: 100 },
        }),
      }),
      BINDING,
    );

    expect(runs).toHaveLength(1);
    expect(finalText()).toContain("Ignored 1 attachment(s)");
  });

  it("answers an album once: the captioned member wins the claim, the others say nothing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, finalText, sent } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ delta: { content: "two cats" } }, { done: true }], telegram);
    const claimed = new Set<string>();
    deps.albums = () => ({
      claim: async (id) => (claimed.has(id) ? false : (claimed.add(id), true)),
      settle: async () => {},
    });
    const photo = (id: string) => [{ file_id: id, file_unique_id: id, width: 1, height: 1, file_size: 10 }];

    await handleTelegramUpdate(
      deps,
      dispositionOf({ update_id: 1, message: message({ message_id: 1, text: undefined, caption: "compare", media_group_id: "g1", photo: photo("a") }) }),
      BINDING,
    );
    await handleTelegramUpdate(
      deps,
      dispositionOf({ update_id: 2, message: message({ message_id: 2, text: undefined, media_group_id: "g1", photo: photo("b") }) }),
      BINDING,
    );

    expect(runs).toHaveLength(1);
    expect(sent.filter((m) => m.text.includes("two cats"))).toHaveLength(1);
    expect(finalText()).toContain("part of an album");
  });

  it("answers /start and /help without a run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, sent } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({ text: "/start", entities: [{ type: "bot_command", offset: 0, length: 6 }] }),
      }),
      BINDING,
    );

    expect(runs).toEqual([]);
    expect(sent[0]?.text).toContain("I am Painter");
    expect(sent[0]?.text).toContain("/help");
  });

  it("replies with guidance when the project is not a runnable agent", async () => {
    const { telegram, sent } = makeTelegramFake();
    const { deps } = makeDeps([], telegram);
    deps.projects = { get: async () => null } as unknown as ProjectRepository;

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message() }), BINDING);

    expect(sent[0]?.text).toContain("Agent project not available");
  });

  it("carries the remembered conversation as history and writes both new turns down after", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const { deps, runs, remembered, stored } = makeDeps([{ delta: { content: "blue" } }, { done: true }], telegram);
    stored.push(
      { role: "user", content: "what colour?", userId: "1", createdAt: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "which thing?", createdAt: "2026-01-01T00:00:01.000Z" },
    );

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message({ text: "the sky" }) }), BINDING);

    expect(runs[0]?.messages.map((turn: ChatMessageInput) => messageText(turn))).toEqual([
      "what colour?",
      "which thing?",
      "the sky",
    ]);
    expect(remembered.map((entry) => [entry.key, entry.turn.role, entry.turn.content])).toEqual([
      ["telegram:100", "user", "the sky"],
      ["telegram:100", "assistant", "blue"],
    ]);
    // Names are not written down when the version never asked to know them.
    expect(remembered[0]?.turn.speaker).toBeUndefined();
  });

  it("writes down a bounded copy of a very long answer, and says it was cut", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const long = "x".repeat(25_000);
    const { deps, remembered } = makeDeps([{ delta: { content: long } }, { done: true }], telegram);

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message() }), BINDING);

    const answer = remembered.find((entry) => entry.turn.role === "assistant")?.turn.content ?? "";
    expect(answer.length).toBeLessThan(21_000);
    expect(answer.endsWith("…[truncated]")).toBe(true);
  });

  it("still answers, and says so, when the history cannot be read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { telegram, finalText } = makeTelegramFake();
    const { deps } = makeDeps([{ delta: { content: "ok" } }, { done: true }], telegram);
    deps.transcripts = {
      recent: async () => {
        throw new Error("table gone");
      },
      append: async () => {},
    };

    await handleTelegramUpdate(deps, dispositionOf({ update_id: 1, message: message() }), BINDING);

    expect(finalText()).toContain("ok");
    expect(finalText()).toContain("Conversation history unavailable");
  });

  it("names the caller and labels speakers only when the version asked, and only past one human", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram } = makeTelegramFake();
    const { deps, runs, remembered, stored } = makeDeps([{ done: true }], telegram, { callerContext: true });
    stored.push({ role: "user", content: "earlier", userId: "2", speaker: "Ann", createdAt: "2026-01-01T00:00:00.000Z" });

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          chat: { id: -1, type: "group" },
          text: "@painter_bot now",
          entities: [{ type: "mention", offset: 0, length: 12 }],
        }),
      }),
      BINDING,
    );

    expect(runs[0]?.caller).toEqual({ displayName: "Bruce Lee" });
    expect(runs[0]?.messages.map((turn: ChatMessageInput) => messageText(turn))).toEqual(["Ann: earlier", "Bruce Lee: now"]);
    // The turn is written down unlabelled — the label is applied when read —
    // and with its speaker, since the version asked to know.
    expect(remembered[0]?.turn).toMatchObject({ content: "now", speaker: "Bruce Lee", userId: "1" });
  });

  it("downloads the largest photo that fits and hands it to the run as an image", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, downloads } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          text: undefined,
          caption: "what is this?",
          photo: [
            { file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 1000 },
            { file_id: "big", file_unique_id: "b", width: 800, height: 800, file_size: 90_000 },
            { file_id: "huge", file_unique_id: "h", width: 4000, height: 4000, file_size: 9_000_000 },
          ],
        }),
      }),
      BINDING,
    );

    expect(downloads).toEqual(["big"]);
    const last = runs[0]?.messages.at(-1)?.content;
    expect(Array.isArray(last) && last.some((part) => part.type === "image_url")).toBe(true);
    expect(last && messageText({ content: last })).toContain("what is this?");
  });

  it("reads an attached document into the turn as text", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { telegram, downloads } = makeTelegramFake();
    const { deps, runs } = makeDeps([{ done: true }], telegram);

    await handleTelegramUpdate(
      deps,
      dispositionOf({
        update_id: 1,
        message: message({
          text: undefined,
          caption: "summarise",
          document: { file_id: "doc", file_unique_id: "d", file_name: "notes.txt", mime_type: "text/plain", file_size: 9 },
        }),
      }),
      BINDING,
    );

    expect(downloads).toEqual(["doc"]);
    const last = runs[0]?.messages.at(-1);
    expect(last && messageText(last)).toContain("png-bytes");
    expect(last && messageText(last)).toContain("summarise");
  });
});
