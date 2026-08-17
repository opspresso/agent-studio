import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramReplyChannel, MAX_MESSAGE_CHARS } from "@/application/telegram/replyChannel";
import type { TelegramClientPort } from "@/domain/telegram/client";

const NOW = 1_750_000_000_000;

function makeTelegramFake(options: { refuseHtml?: boolean; failEdits?: boolean } = {}) {
  const sent: Array<{ text: string; parseMode?: string; replyTo?: number; threadId?: number; id: number }> = [];
  const edits: Array<{ id: number; text: string; parseMode?: string }> = [];
  const actions: string[] = [];
  const photos: Array<{ filename: string; caption?: string }> = [];
  let nextId = 1;
  const telegram: TelegramClientPort = {
    async getMe() {
      return { id: 42, username: "painter_bot" };
    },
    async setWebhook() {},
    async deleteWebhook() {},
    async sendMessage(_token, args) {
      if (options.refuseHtml && args.parseMode === "HTML") {
        throw new Error("Telegram sendMessage failed: Bad Request: can't parse entities");
      }
      const id = nextId++;
      sent.push({
        text: args.text,
        id,
        ...(args.parseMode ? { parseMode: args.parseMode } : {}),
        ...(args.replyToMessageId !== undefined ? { replyTo: args.replyToMessageId } : {}),
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
      });
      return { messageId: id };
    },
    async editMessageText(_token, args) {
      if (options.failEdits) {
        throw new Error("Telegram editMessageText failed: HTTP 500");
      }
      if (options.refuseHtml && args.parseMode === "HTML") {
        throw new Error("Telegram editMessageText failed: Bad Request: can't parse entities");
      }
      const last = [...sent, ...edits.map((edit) => ({ id: edit.id, text: edit.text }))]
        .filter((entry) => entry.id === args.messageId)
        .at(-1);
      if (last?.text === args.text) {
        throw new Error("Telegram editMessageText failed: Bad Request: message is not modified");
      }
      edits.push({ id: args.messageId, text: args.text, ...(args.parseMode ? { parseMode: args.parseMode } : {}) });
    },
    async sendChatAction(_token, args) {
      actions.push(args.action);
    },
    async sendPhoto(_token, args) {
      photos.push({ filename: args.filename, ...(args.caption ? { caption: args.caption } : {}) });
    },
    async downloadFile() {
      return Buffer.from("");
    },
  };
  /** What each message on screen reads, by id. */
  const screen = () => {
    const byId = new Map<number, string>();
    for (const message of sent) {
      byId.set(message.id, message.text);
    }
    for (const edit of edits) {
      byId.set(edit.id, edit.text);
    }
    return [...byId.entries()].sort(([a], [b]) => a - b).map(([, text]) => text);
  };
  return { telegram, sent, edits, actions, photos, screen };
}

const TARGET = { chatId: 100, replyToMessageId: 7 };

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("a Telegram reply", () => {
  it("opens on the first push, edits in place at a pace, and renders once at the end", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { telegram, sent, edits, screen } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.push("Hel");
    await sink.push("Hello **wo");
    now += 2500;
    await sink.push("Hello **world**");
    await sink.finish("Hello **world**", "");

    // The first write is unpaced and quotes the question; the second push was
    // inside the edit interval and skipped; the third landed.
    expect(sent).toEqual([{ id: 1, text: "Hel ▌", replyTo: 7 }]);
    expect(edits.map((edit) => edit.text)).toEqual(["Hello **world** ▌", "Hello <b>world</b>"]);
    expect(edits.at(-1)?.parseMode).toBe("HTML");
    expect(screen()).toEqual(["Hello <b>world</b>"]);
  });

  it("sends the plain text when Telegram refuses the rendered one", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { telegram, screen, edits } = makeTelegramFake({ refuseHtml: true });
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.push("some *text*");
    await sink.finish("some *text*", "");

    expect(screen()).toEqual(["some *text*"]);
    expect(edits.at(-1)?.parseMode).toBeUndefined();
  });

  it("carries a long answer over several messages, cut at a line break", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { telegram, sent, screen } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);
    const paragraph = "x".repeat(3500);
    const text = `${paragraph}\n${paragraph}\n${paragraph}`;

    await sink.push(text.slice(0, 100));
    now += 3000;
    await sink.push(text);
    await sink.finish(text, "");

    expect(sent).toHaveLength(3);
    // Only the first message quotes the question.
    expect(sent.map((message) => message.replyTo)).toEqual([7, undefined, undefined]);
    const messages = screen();
    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
    expect(messages.join("")).toBe(text);
    expect(messages[0]).toBe(`${paragraph}\n`);
  });

  it("never lets an open message reach the cap with its cursor on", async () => {
    let now = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { telegram, sent, edits } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);
    const text = "y".repeat(MAX_MESSAGE_CHARS);

    await sink.push("y");
    now += 3000;
    await sink.push(text);

    for (const written of [...sent.map((m) => m.text), ...edits.map((e) => e.text)]) {
      expect(written.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    }
  });

  it("says nothing when nothing was opened and there is nothing to say", async () => {
    const { telegram, sent } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.finish("", "");

    expect(sent).toEqual([]);
  });

  it("posts a tail on its own when the run said nothing else", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { telegram, screen } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.finish("", "⚠️ The run finished without producing an answer.");

    expect(screen()).toEqual(["⚠️ The run finished without producing an answer."]);
  });

  it("appends the tail under the answer, and links a file in it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { telegram, screen } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.push("done");
    await sink.finish("done", [sink.fileLink({ url: "https://s/k", name: "report [v2].docx" }), sink.warningLine("a warning")].join("\n"));

    expect(screen()).toEqual(['done\n\n📎 <a href="https://s/k">report v2.docx</a>\n⚠️ a warning']);
  });

  it("posts what Telegram never took when the final write fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { telegram, sent } = makeTelegramFake({ failEdits: true });
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.push("the answer");
    await sink.finish("the answer, whole", "");

    expect(sent.map((message) => message.text)).toEqual(["the answer ▌", "the answer, whole"]);
  });

  it("keeps the typing indicator alive on its own clock, and stops when told", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { telegram, actions } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", { chatId: 100, threadId: 5 });

    await sink.status("is thinking…");
    await sink.step("c1", "search");
    const stop = sink.keepStatusAlive();
    await vi.advanceTimersByTimeAsync(9000);
    stop();
    await vi.advanceTimersByTimeAsync(9000);

    // One for the status (the step inside the refresh window is folded into
    // it), then one per tick while alive, none after.
    expect(actions).toEqual(["typing", "typing", "typing"]);
  });

  it("uploads a picture with its prompt as the caption", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { telegram, photos } = makeTelegramFake();
    const sink = createTelegramReplyChannel(telegram, "tok", TARGET);

    await sink.sendImage({ b64: "AA==", mimeType: "image/png", prompt: "a cat" }, 0);

    expect(photos).toEqual([{ filename: `generated-${NOW}-1.png`, caption: "a cat" }]);
  });
});
