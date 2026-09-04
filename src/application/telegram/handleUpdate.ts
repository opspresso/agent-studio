import { resolveAgentProject, runRememberedTurn } from "@/application/messaging/rememberedTurn";
import { createTelegramReplyChannel } from "@/application/telegram/replyChannel";
import { botIdFromToken, type TelegramUpdateDisposition } from "@/application/telegram/engagement";
import type {
  TelegramEventDeps,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUser,
} from "@/application/telegram/types";
import { callerFrom, type RunCaller } from "@/domain/execution/actor";
import { MAX_IMAGE_BYTES } from "@/domain/llm/imageLimits";
import type { InboundAttachment } from "@/domain/messaging/inbound";
import { telegramConversation } from "@/domain/telegram/conversation";
import type { TelegramDestination } from "@/domain/telegram/destination";
import { log } from "@/shared/logger";
import { RUN_LEASE_SECONDS } from "@/shared/runDeadline";

/**
 * How long a caption-less member of an album waits before claiming it, so the
 * captioned member — the one carrying the question — wins the claim when there
 * is one. Album members arrive within milliseconds of each other; a second is
 * generous, and it is spent in the background after the ack.
 */
const ALBUM_GRACE_MS = 1000;

/** Credentials and project binding for a project-dedicated bot. */
export interface TelegramBotBinding {
  projectName: string;
  botToken: string;
  /** Learned from `getMe` when the token was saved; absent until then. */
  botUsername?: string;
}

const HELP = [
  "I answer every message you send me here.",
  "In a group, mention me or reply to one of my messages.",
  "",
  "/help — this note",
  "/start — who I am",
].join("\n");

/**
 * A person's name as Telegram carries it: first and last name, or the
 * `@username` when the account shows no name. `callerFrom` bounds and flattens
 * it — a Telegram name is set by its owner, like a Slack one.
 */
function callerOf(user: TelegramUser | undefined): RunCaller | undefined {
  if (!user) {
    return undefined;
  }
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return callerFrom({ displayName: name || (user.username ? `@${user.username}` : "") }) ?? undefined;
}

function destinationOf(message: TelegramMessage, threadId: number | undefined): TelegramDestination {
  const person = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ").trim();
  const title =
    message.chat.type === "private"
      ? person ||
        (message.from?.username ? `@${message.from.username}` : `private ${message.chat.id}`)
      : message.chat.title?.trim() || `${message.chat.type} ${message.chat.id}`;
  return {
    chatId: message.chat.id,
    chatType: message.chat.type,
    title,
    ...(threadId !== undefined ? { threadId } : {}),
    lastSeenAt: new Date(message.date * 1000).toISOString(),
  };
}

/**
 * The picture at the largest size the turn can carry.
 *
 * Telegram sends one photo as several sizes, smallest first, each with its own
 * file. The largest one under the image cap is what a model should look at;
 * when even the smallest is over it, the smallest is offered so the size check
 * downstream reports it rather than a silent drop.
 */
function pickPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  const fitting = sizes.filter((size) => (size.file_size ?? 0) <= MAX_IMAGE_BYTES);
  return fitting.at(-1) ?? sizes[0];
}

/**
 * The message's attachments as the shared pipeline reads them.
 *
 * Every kind Telegram can attach is named, not only the two a run can read: a
 * voice note or a video reaches the pipeline as an attachment with its own
 * media type, and the pipeline reports it as one it could not read — which is
 * what Slack does with an unreadable file, and the difference between a bot
 * that says "I cannot listen to voice notes" and one that answers as if
 * nothing was sent.
 */
function attachmentsOf(
  deps: TelegramEventDeps,
  token: string,
  message: TelegramMessage,
): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  const download = (fileId: string) => (maxBytes: number) =>
    deps.telegram.downloadFile(token, fileId, maxBytes);
  const photo = message.photo && message.photo.length > 0 ? pickPhoto(message.photo) : undefined;
  if (photo) {
    attachments.push({
      name: `photo-${photo.file_unique_id}.jpg`,
      // Telegram re-encodes every photo it delivers as JPEG.
      mimeType: "image/jpeg",
      ...(photo.file_size !== undefined ? { size: photo.file_size } : {}),
      download: download(photo.file_id),
    });
  }
  const files: Array<[string, TelegramMessage["document"], string]> = [
    ["document", message.document, ""],
    ["voice", message.voice, "audio/ogg"],
    ["audio", message.audio, "audio/mpeg"],
    ["video", message.video, "video/mp4"],
    ["animation", message.animation, "video/mp4"],
    ["video_note", message.video_note, "video/mp4"],
  ];
  for (const [kind, file, defaultMime] of files) {
    if (!file) {
      continue;
    }
    attachments.push({
      name: file.file_name ?? `${kind}-${file.file_unique_id}`,
      mimeType: file.mime_type ?? defaultMime,
      ...(file.file_size !== undefined ? { size: file.file_size } : {}),
      download: download(file.file_id),
    });
  }
  const sticker = message.sticker;
  if (sticker) {
    attachments.push({
      name: `sticker-${sticker.file_unique_id}${sticker.is_animated ? ".tgs" : sticker.is_video ? ".webm" : ".webp"}`,
      // A static sticker is a picture the model can look at; the other two are not.
      mimeType: sticker.is_animated
        ? "application/x-tgsticker"
        : sticker.is_video
          ? "video/webm"
          : "image/webp",
      ...(sticker.file_size !== undefined ? { size: sticker.file_size } : {}),
      download: download(sticker.file_id),
    });
  }
  return attachments;
}

/**
 * Whether this update should answer for the album it belongs to.
 *
 * Telegram delivers an album as one update per picture, sharing a
 * `media_group_id`, with the caption on at most one of them. Answering each is
 * three billed runs and three replies for one question, so the album is
 * claimed once: the captioned member claims at once and wins; a caption-less
 * member waits a moment first, so it wins only when no member carried the
 * question. The one that runs reads its own picture and says so — the others
 * are not fetched, and pretending to have seen them would be worse than saying
 * one was.
 */
async function claimsAlbum(
  deps: TelegramEventDeps,
  binding: TelegramBotBinding,
  message: TelegramMessage,
  text: string,
): Promise<boolean> {
  if (!message.media_group_id || !deps.albums) {
    return true;
  }
  if (!text) {
    await (deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(ALBUM_GRACE_MS);
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  const claims = deps.albums(binding.projectName, botIdFromToken(binding.botToken) ?? "unknown");
  try {
    const won = await claims.claim(message.media_group_id, nowSeconds, nowSeconds + RUN_LEASE_SECONDS);
    if (won) {
      // Never reclaimed: an album answered once is answered.
      await claims.settle(message.media_group_id, "done");
    }
    return won;
  } catch (error) {
    // The store failing must not silence the bot; the cost is a duplicate reply.
    log.error("telegram", "album claim failed; answering anyway", error);
    return true;
  }
}

/**
 * Run the agent project for one update and stream the reply.
 *
 * Whether this update was for the bot at all is already decided:
 * `classifyTelegramUpdate` is the single owner of that, and it runs in the
 * route ahead of the dedup claim. Nothing here re-checks it.
 */
export async function handleTelegramUpdate(
  deps: TelegramEventDeps,
  disposition: Exclude<TelegramUpdateDisposition, { kind: "ignore" }>,
  binding: TelegramBotBinding,
): Promise<void> {
  const { message } = disposition;
  const token = binding.botToken;
  // A thread id names a forum topic only when Telegram says so; in an ordinary
  // group it is the root of a reply chain, which is not a conversation of its
  // own — a reply to the bot there is a follow-up in the group's conversation.
  const threadId =
    message.is_topic_message && message.chat.is_forum ? message.message_thread_id : undefined;
  if (deps.destinations) {
    const botId = botIdFromToken(binding.botToken) ?? "unknown";
    await deps.destinations
      .put(binding.projectName, botId, destinationOf(message, threadId))
      .catch((error) => log.warn("telegram", "could not remember the message destination", error));
  }
  const reply = createTelegramReplyChannel(
    deps.telegram,
    token,
    {
      chatId: message.chat.id,
      ...(threadId !== undefined ? { threadId } : {}),
      replyToMessageId: message.message_id,
    },
    { ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );

  // A command is answered whether or not the project has a runnable version:
  // `/start` on a bot that is currently failing should still say what it is.
  if (disposition.kind === "command") {
    const project = await deps.projects.get(binding.projectName);
    const intro = project?.description?.trim() || `the ${binding.projectName} project`;
    await reply.say(
      disposition.command === "start" ? `Hello — I am ${project?.displayName ?? binding.projectName}, ${intro}.\n\n${HELP}` : HELP,
    );
    return;
  }

  const runnable = await resolveAgentProject(deps, binding.projectName, reply);
  if (!runnable) {
    return;
  }
  const { project, version } = runnable;

  if (!(await claimsAlbum(deps, binding, message, disposition.text))) {
    log.info("telegram", `album member skipped project=${project.name} chat=${message.chat.id}`);
    return;
  }

  log.info(
    "telegram",
    `run start project=${project.name} chat=${message.chat.id} message=${message.message_id}`,
  );

  const warnings: string[] = [];
  if (message.media_group_id) {
    warnings.push("This message was part of an album; only the picture it arrived with was read.");
  }
  const userId = message.from ? String(message.from.id) : undefined;
  await runRememberedTurn(deps, {
    project,
    version,
    reply,
    conversation: telegramConversation(message.chat.id, threadId),
    text: disposition.text,
    attachments: attachmentsOf(deps, token, message),
    // The Telegram user id, not an email: Telegram has none to hand over.
    ...(userId ? { actor: { kind: "telegram" as const, id: userId }, userId } : {}),
    callerOf: () => callerOf(message.from),
    // Telegram stamps the message with when it was sent, to the second.
    arrivedAt: new Date(message.date * 1000),
    warnings,
    scope: "telegram",
  });
}
