import type { TelegramMessage, TelegramUpdate } from "@/application/telegram/types";

/**
 * Which delivered Telegram updates cause a run — the single owner of that
 * decision, and it runs in the route ahead of the dedup claim, like Slack's:
 * an update nobody addressed to the bot costs a secret check and nothing else.
 *
 * Telegram does part of the deciding itself. A bot in a group receives, by
 * default (BotFather's *privacy mode*), only the messages that name it — a
 * command, a mention, a reply to one of its messages — so most of what reaches
 * here is for the bot already. Privacy mode can be switched off, and then the
 * bot receives everything the group says; the funnel below is what keeps it
 * from answering all of it.
 *
 * The funnel, in order:
 *
 * 1. not a new message — an edit, a channel post, a service update — nothing;
 * 2. a bot's message, this bot's own included — nothing, because everything
 *    below can start a run and a run that answers itself never stops;
 * 3. a **command** this bot understands — answered without a run;
 * 4. a private chat — every message in one is for the bot;
 * 5. a group message that mentions the bot or replies to it — answered;
 * 6. otherwise nothing.
 *
 * Nothing here costs a read: a group has no engagement row, because a follow-up
 * there is a reply, and Telegram already tells the bot what a message replies
 * to.
 */

/** What this bot is, for telling a mention of it from a mention of anyone else. */
export interface TelegramBotIdentity {
  /** The bot's user id — the number before the colon in its token. */
  botId?: number;
  /** The bot's `@username`, without the `@`; learned from `getMe`. */
  botUsername?: string;
}

/** The fixed actions a message can be, instead of a question for the agent. */
export type TelegramCommand = "start" | "help";

export type TelegramUpdateDisposition =
  /** Answer it. `text` is the message with the bot's own mention taken out. */
  | { kind: "run"; trigger: "private" | "mention" | "reply"; message: TelegramMessage; text: string }
  /** Answer with a constant rather than a run. */
  | { kind: "command"; command: TelegramCommand; message: TelegramMessage }
  /** Nothing to do. `because` is for tests and diagnosis, not for a reply. */
  | { kind: "ignore"; because: string };

/**
 * The bot's user id, which Telegram puts in front of the colon of every bot
 * token (`123456789:AA…`). Read from the token so a reply to the bot can be
 * recognised without a `getMe` round trip per update.
 */
export function botIdFromToken(token: string): number | undefined {
  const head = token.split(":")[0] ?? "";
  return /^\d+$/.test(head) ? Number(head) : undefined;
}

/** The message's text, or its caption when it is a photo or a document. */
export function messageTextOf(message: TelegramMessage): string {
  return message.text ?? message.caption ?? "";
}

/**
 * The command a message is, when it is one this bot answers.
 *
 * Telegram marks a leading `/word` as a `bot_command` entity, and in a group a
 * command may be addressed — `/help@painter_bot` — which is how several bots in
 * one group tell whose command it is. One addressed to another bot is nobody's
 * business here. A bare command is answered in a group too, which is
 * Telegram's own convention: every bot in the group is asked.
 */
export function parseTelegramCommand(
  message: TelegramMessage,
  botUsername: string | undefined,
): { command: TelegramCommand | "other"; forThisBot: boolean } | null {
  const text = messageTextOf(message);
  const entities = message.entities ?? message.caption_entities ?? [];
  const leading = entities.find((entity) => entity.type === "bot_command" && entity.offset === 0);
  if (!leading || !text.startsWith("/")) {
    return null;
  }
  const raw = text.slice(1, leading.length);
  const [name = "", addressee] = raw.split("@");
  const forThisBot =
    addressee === undefined ||
    (botUsername !== undefined && addressee.toLowerCase() === botUsername.toLowerCase());
  const command = name.toLowerCase();
  return {
    command: command === "start" || command === "help" ? command : "other",
    forThisBot,
  };
}

/**
 * The text with this bot's own `@mention` removed, wherever it sits.
 *
 * Case-insensitive, because Telegram usernames are, and by the entity Telegram
 * marked rather than by string search: a `@name` inside a code span is not a
 * mention and Telegram does not mark it as one.
 */
export function stripBotMention(message: TelegramMessage, botUsername: string | undefined): string {
  const text = messageTextOf(message);
  if (!botUsername) {
    return text.trim();
  }
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = `@${botUsername}`.toLowerCase();
  // Right to left, so earlier offsets stay valid as later spans are removed.
  const mentions = entities
    .filter(
      (entity) =>
        entity.type === "mention" &&
        text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle,
    )
    .sort((a, b) => b.offset - a.offset);
  let out = text;
  for (const mention of mentions) {
    out = out.slice(0, mention.offset) + out.slice(mention.offset + mention.length);
  }
  return out.replace(/\s+/g, " ").trim();
}

function mentionsBot(message: TelegramMessage, identity: TelegramBotIdentity): boolean {
  const text = messageTextOf(message);
  const entities = message.entities ?? message.caption_entities ?? [];
  const handle = identity.botUsername ? `@${identity.botUsername}`.toLowerCase() : undefined;
  return entities.some((entity) => {
    if (entity.type === "text_mention") {
      return identity.botId !== undefined && entity.user?.id === identity.botId;
    }
    return (
      entity.type === "mention" &&
      handle !== undefined &&
      text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === handle
    );
  });
}

export function classifyTelegramUpdate(
  update: TelegramUpdate,
  identity: TelegramBotIdentity,
): TelegramUpdateDisposition {
  const message = update.message;
  if (!message) {
    return {
      kind: "ignore",
      because: update.edited_message
        ? "an edit is not a new question"
        : update.channel_post
          ? "channel posts are not answered"
          : "not a message",
    };
  }
  if (message.from?.is_bot) {
    return { kind: "ignore", because: "from a bot" };
  }
  if (message.chat.type === "channel") {
    return { kind: "ignore", because: "channel posts are not answered" };
  }
  const command = parseTelegramCommand(message, identity.botUsername);
  if (command && !command.forThisBot) {
    return { kind: "ignore", because: "a command for another bot" };
  }
  if (command && command.command !== "other") {
    return { kind: "command", command: command.command, message };
  }
  const text = stripBotMention(message, identity.botUsername);
  const hasAttachment = (message.photo?.length ?? 0) > 0 || message.document !== undefined;
  if (!text && !hasAttachment) {
    return { kind: "ignore", because: "nothing to read" };
  }
  if (message.chat.type === "private") {
    return { kind: "run", trigger: "private", message, text };
  }
  if (mentionsBot(message, identity)) {
    return { kind: "run", trigger: "mention", message, text };
  }
  if (
    identity.botId !== undefined &&
    message.reply_to_message?.from?.is_bot &&
    message.reply_to_message.from.id === identity.botId
  ) {
    return { kind: "run", trigger: "reply", message, text };
  }
  return { kind: "ignore", because: "not addressed to the bot" };
}
