import { describe, expect, it } from "vitest";
import {
  botIdFromToken,
  classifyTelegramUpdate,
  parseTelegramCommand,
  stripBotMention,
} from "@/application/telegram/engagement";
import type { TelegramMessage, TelegramUpdate } from "@/application/telegram/types";

const BOT = { botId: 42, botUsername: "painter_bot" };

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 7,
    date: 0,
    from: { id: 1, first_name: "Bruce" },
    chat: { id: 100, type: "private" },
    text: "hello",
    ...overrides,
  };
}

function update(overrides: Partial<TelegramUpdate> = {}): TelegramUpdate {
  return { update_id: 1, message: message(), ...overrides };
}

const runOf = (disposition: ReturnType<typeof classifyTelegramUpdate>) =>
  disposition.kind === "run" ? { trigger: disposition.trigger, text: disposition.text } : disposition;

describe("botIdFromToken", () => {
  it("reads the number in front of the colon", () => {
    expect(botIdFromToken("42:AAHfoo")).toBe(42);
  });
  it("answers nothing for a token that does not carry one", () => {
    expect(botIdFromToken("not-a-token")).toBeUndefined();
  });
});

describe("classifyTelegramUpdate", () => {
  it("answers every message in a private chat", () => {
    expect(runOf(classifyTelegramUpdate(update(), BOT))).toEqual({ trigger: "private", text: "hello" });
  });

  it("ignores what is not a new message", () => {
    expect(classifyTelegramUpdate({ update_id: 1, edited_message: message() }, BOT)).toMatchObject({
      kind: "ignore",
      because: "an edit is not a new question",
    });
    expect(classifyTelegramUpdate({ update_id: 1 }, BOT)).toMatchObject({ kind: "ignore" });
  });

  it("ignores a bot's message, its own included", () => {
    const own = update({ message: message({ from: { id: 42, is_bot: true, first_name: "Painter" } }) });
    expect(classifyTelegramUpdate(own, BOT)).toMatchObject({ kind: "ignore", because: "from a bot" });
  });

  it("answers a group message that mentions the bot, with the mention taken out", () => {
    const text = "hey @Painter_Bot what's up";
    const group = update({
      message: message({
        chat: { id: -1, type: "supergroup" },
        text,
        entities: [{ type: "mention", offset: 4, length: 12 }],
      }),
    });
    expect(runOf(classifyTelegramUpdate(group, BOT))).toEqual({ trigger: "mention", text: "hey what's up" });
  });

  it("answers a group reply to one of the bot's messages", () => {
    const group = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "and then?",
        reply_to_message: message({ from: { id: 42, is_bot: true }, text: "earlier" }),
      }),
    });
    expect(runOf(classifyTelegramUpdate(group, BOT))).toEqual({ trigger: "reply", text: "and then?" });
  });

  it("ignores a group message addressed to nobody, or to another bot", () => {
    const plain = update({ message: message({ chat: { id: -1, type: "group" }, text: "lunch?" }) });
    expect(classifyTelegramUpdate(plain, BOT)).toMatchObject({ kind: "ignore", because: "not addressed to the bot" });
    const other = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "@other_bot hi",
        entities: [{ type: "mention", offset: 0, length: 10 }],
      }),
    });
    expect(classifyTelegramUpdate(other, BOT)).toMatchObject({ kind: "ignore" });
    const replyToHuman = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "yes",
        reply_to_message: message({ from: { id: 2, first_name: "Someone" } }),
      }),
    });
    expect(classifyTelegramUpdate(replyToHuman, BOT)).toMatchObject({ kind: "ignore" });
  });

  it("recognises a command, addressed to this bot or to nobody", () => {
    const bare = update({
      message: message({ text: "/help", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
    });
    expect(classifyTelegramUpdate(bare, BOT)).toMatchObject({ kind: "command", command: "help" });
    const addressed = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "/start@painter_bot",
        entities: [{ type: "bot_command", offset: 0, length: 18 }],
      }),
    });
    expect(classifyTelegramUpdate(addressed, BOT)).toMatchObject({ kind: "command", command: "start" });
    const someoneElses = update({
      message: message({
        text: "/start@other_bot",
        entities: [{ type: "bot_command", offset: 0, length: 16 }],
      }),
    });
    expect(classifyTelegramUpdate(someoneElses, BOT)).toMatchObject({ kind: "ignore", because: "a command for another bot" });
  });

  it("answers an unknown command addressed to it by name in a group", () => {
    const addressed = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "/ask@painter_bot what is X",
        entities: [{ type: "bot_command", offset: 0, length: 16 }],
      }),
    });
    expect(runOf(classifyTelegramUpdate(addressed, BOT))).toEqual({
      trigger: "mention",
      text: "/ask@painter_bot what is X",
    });
    const bare = update({
      message: message({
        chat: { id: -1, type: "group" },
        text: "/ask what is X",
        entities: [{ type: "bot_command", offset: 0, length: 4 }],
      }),
    });
    expect(classifyTelegramUpdate(bare, BOT)).toMatchObject({ kind: "ignore" });
  });

  it("answers a caption-less voice note or sticker in a private chat, so the run can say it cannot read it", () => {
    const voice = update({
      message: message({ text: undefined, voice: { file_id: "v", file_unique_id: "u", mime_type: "audio/ogg" } }),
    });
    expect(runOf(classifyTelegramUpdate(voice, BOT))).toEqual({ trigger: "private", text: "" });
  });

  it("treats a command it does not know as an ordinary question", () => {
    const unknown = update({
      message: message({ text: "/weather Seoul", entities: [{ type: "bot_command", offset: 0, length: 8 }] }),
    });
    expect(runOf(classifyTelegramUpdate(unknown, BOT))).toEqual({ trigger: "private", text: "/weather Seoul" });
  });

  it("answers a photo with no caption, and ignores a message with nothing to read", () => {
    const photo = update({
      message: message({ text: undefined, photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] }),
    });
    expect(runOf(classifyTelegramUpdate(photo, BOT))).toEqual({ trigger: "private", text: "" });
    const empty = update({ message: message({ text: "   " }) });
    expect(classifyTelegramUpdate(empty, BOT)).toMatchObject({ kind: "ignore", because: "nothing to read" });
  });

  it("does not answer channel posts", () => {
    const channel = update({ message: message({ chat: { id: -2, type: "channel" } }) });
    expect(classifyTelegramUpdate(channel, BOT)).toMatchObject({ kind: "ignore" });
  });
});

describe("parseTelegramCommand / stripBotMention", () => {
  it("reads the command name off the entity, not the whole text", () => {
    const parsed = parseTelegramCommand(
      message({ text: "/help me please", entities: [{ type: "bot_command", offset: 0, length: 5 }] }),
      "painter_bot",
    );
    expect(parsed).toEqual({ command: "help", forThisBot: true, addressed: false });
  });

  it("keeps the message's line breaks and indentation when it strips a mention", () => {
    const text = "@painter_bot fix this:\n\n```py\ndef f():\n    return 1\n```";
    const stripped = stripBotMention(
      message({ text, entities: [{ type: "mention", offset: 0, length: 12 }] }),
      "painter_bot",
    );
    expect(stripped).toBe("fix this:\n\n```py\ndef f():\n    return 1\n```");
  });

  it("strips only the entity Telegram marked, case-insensitively", () => {
    const text = "@painter_bot ping @Painter_Bot pong";
    const stripped = stripBotMention(
      message({
        text,
        entities: [
          { type: "mention", offset: 0, length: 12 },
          { type: "mention", offset: 18, length: 12 },
        ],
      }),
      "painter_bot",
    );
    expect(stripped).toBe("ping pong");
  });
});
