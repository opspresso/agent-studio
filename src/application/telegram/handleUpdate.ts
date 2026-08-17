import { handleTurn } from "@/application/messaging/handleTurn";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { createTelegramReplyChannel } from "@/application/telegram/replyChannel";
import type { TelegramUpdateDisposition } from "@/application/telegram/engagement";
import type {
  TelegramDocument,
  TelegramEventDeps,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUser,
} from "@/application/telegram/types";
import { callerFrom, conversationKey, type RunCaller } from "@/domain/execution/actor";
import { MAX_ATTACHMENT_BYTES } from "@/domain/llm/imageLimits";
import type { HistoryTurn, InboundAttachment } from "@/domain/messaging/inbound";
import type { TranscriptTurn } from "@/domain/messaging/transcript";
import { telegramConversation } from "@/domain/telegram/conversation";
import type { Project } from "@/domain/project/types";
import { log } from "@/shared/logger";

/** Most recent turns of a conversation carried as context; older turns are dropped. */
const MAX_HISTORY_TURNS = 50;
/**
 * How much of one turn is written down. A turn is kept for the *next*
 * question's context, and past this a single answer would be most of that
 * context on its own — and a row is one DynamoDB item, which a very long answer
 * would otherwise be the first thing to overflow. Cut on a character count,
 * marked, so the model reads a turn that says it was cut rather than one that
 * ends mid-sentence.
 */
const MAX_TRANSCRIPT_TURN_CHARS = 20_000;

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

/**
 * The picture at the largest size the turn can carry.
 *
 * Telegram sends one photo as several sizes, smallest first, each with its own
 * file. The largest one under the image cap is what a model should look at;
 * when even the smallest is over it, the smallest is offered so the size check
 * downstream reports it rather than a silent drop.
 */
function pickPhoto(sizes: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  const fitting = sizes.filter((size) => (size.file_size ?? 0) <= MAX_ATTACHMENT_BYTES);
  return fitting.at(-1) ?? sizes[0];
}

/** The message's attachments as the shared pipeline reads them. */
function attachmentsOf(
  deps: TelegramEventDeps,
  token: string,
  message: TelegramMessage,
): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  const photo = message.photo && message.photo.length > 0 ? pickPhoto(message.photo) : undefined;
  if (photo) {
    attachments.push({
      name: `photo-${photo.file_unique_id}.jpg`,
      // Telegram re-encodes every photo it delivers as JPEG.
      mimeType: "image/jpeg",
      ...(photo.file_size !== undefined ? { size: photo.file_size } : {}),
      download: (maxBytes) => deps.telegram.downloadFile(token, photo.file_id, maxBytes),
    });
  }
  const document: TelegramDocument | undefined = message.document;
  if (document) {
    attachments.push({
      name: document.file_name ?? `document-${document.file_unique_id}`,
      mimeType: document.mime_type ?? "",
      ...(document.file_size !== undefined ? { size: document.file_size } : {}),
      download: (maxBytes) => deps.telegram.downloadFile(token, document.file_id, maxBytes),
    });
  }
  return attachments;
}

/**
 * The turns this surface remembers of the conversation, oldest first — or
 * none, when there is nothing to remember with or the read failed. A failed
 * read is a warning: the answer will be given without its context, and that is
 * worth a line.
 */
async function loadHistory(
  deps: TelegramEventDeps,
  project: Project,
  key: string,
  warnings: string[],
): Promise<TranscriptTurn[]> {
  if (!deps.transcripts) {
    return [];
  }
  try {
    return await deps.transcripts.recent(project.name, key, MAX_HISTORY_TURNS);
  } catch (error) {
    log.error("telegram", "conversation history failed", error);
    warnings.push("Conversation history unavailable; answered without prior context.");
    return [];
  }
}

/**
 * Write a turn down for the next question. Best effort: a transcript that
 * could not be written costs the next follow-up its context, and that is not
 * worth failing a run that already answered.
 */
async function remember(
  deps: TelegramEventDeps,
  project: Project,
  key: string,
  turn: TranscriptTurn,
): Promise<void> {
  if (!deps.transcripts || !turn.content) {
    return;
  }
  const content =
    turn.content.length > MAX_TRANSCRIPT_TURN_CHARS
      ? `${turn.content.slice(0, MAX_TRANSCRIPT_TURN_CHARS)}\n…[truncated]`
      : turn.content;
  await deps.transcripts
    .append(project.name, key, { ...turn, content })
    .catch((error) => log.error("telegram", "conversation turn could not be recorded", error));
}

/**
 * Prefix each human turn with who wrote it, when more than one human is in
 * the conversation. A private chat needs no labels; a group with three people
 * reaches the model as one person's monologue without them.
 */
function withSpeakerLabels(
  turns: TranscriptTurn[],
  currentUserId: string | undefined,
): { history: HistoryTurn[]; label: boolean } {
  const humans = new Set(turns.filter((turn) => turn.userId).map((turn) => turn.userId));
  if (currentUserId) {
    humans.add(currentUserId);
  }
  const label = humans.size > 1;
  return {
    label,
    history: turns.map((turn) => ({
      message: {
        role: turn.role,
        content:
          label && turn.role === "user" && turn.speaker ? `${turn.speaker}: ${turn.content}` : turn.content,
      },
      attachments: [],
      ...(turn.userId ? { userId: turn.userId } : {}),
    })),
  };
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
  const target = {
    chatId: message.chat.id,
    ...(message.message_thread_id !== undefined ? { threadId: message.message_thread_id } : {}),
    replyToMessageId: message.message_id,
  };
  const reply = createTelegramReplyChannel(deps.telegram, token, target);

  const project = await deps.projects.get(binding.projectName);
  // A command is answered whether or not the project has a runnable version:
  // `/start` on a bot that is currently failing should still say what it is.
  if (disposition.kind === "command") {
    const intro = project?.description?.trim() || `the ${binding.projectName} project`;
    await reply.say(
      disposition.command === "start" ? `Hello — I am ${project?.displayName ?? binding.projectName}, ${intro}.\n\n${HELP}` : HELP,
    );
    return;
  }

  // External surface: published-only, drafts never leak (resolveRunnableVersion policy).
  const version = project ? await resolveRunnableVersion(deps.versions, project) : null;
  if (!project || project.projectType !== "agent" || !version) {
    await reply.say(
      `Agent project not available: ${binding.projectName} (must exist, be an agent project, and have a published version)`,
    );
    return;
  }

  log.info(
    "telegram",
    `run start project=${project.name} chat=${message.chat.id} message=${message.message_id}`,
  );

  const conversation = telegramConversation(message.chat.id, message.message_thread_id);
  const key = conversationKey(conversation);
  const warnings: string[] = [];
  // Read before anything is written, like the Slack thread: the reply must
  // not come back as an assistant turn in this run's own context.
  const remembered = await loadHistory(deps, project, key, warnings);
  await reply.status("is thinking…");

  const userId = message.from ? String(message.from.id) : undefined;
  // The version's opt-in gates whether a name reaches the model, and so
  // whether one is written down beside the turn at all.
  const named = version.parameters.callerContext ? callerOf(message.from) : undefined;
  const { history, label } = withSpeakerLabels(remembered, userId);
  const askText = label && named ? `${named.displayName}: ${disposition.text}` : disposition.text;

  const outcome = await handleTurn(
    deps,
    {
      project,
      version,
      text: askText,
      attachments: attachmentsOf(deps, token, message),
      history,
      // The Telegram user id, not an email: Telegram has none to hand over.
      ...(userId ? { actor: { kind: "telegram" as const, id: userId } } : {}),
      ...(named ? { caller: named } : {}),
      conversation,
      warnings,
    },
    reply,
  );

  // Written after the reply, because that is what makes it true — and the
  // question first, so the two land in the order they were said.
  const now = new Date().toISOString();
  await remember(deps, project, key, {
    role: "user",
    content: disposition.text,
    ...(userId ? { userId } : {}),
    ...(named ? { speaker: named.displayName } : {}),
    createdAt: now,
  });
  await remember(deps, project, key, {
    role: "assistant",
    content: outcome.text,
    createdAt: new Date(Date.parse(now) + 1).toISOString(),
  });
}
