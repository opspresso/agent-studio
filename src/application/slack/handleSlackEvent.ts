import type { SlackMessage } from "@/domain/slack/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { createReplySink } from "@/application/slack/replyStream";
import type { SlackEventBody, SlackEventDeps, SlackEventFile } from "@/application/slack/types";
import type { RunCaller } from "@/domain/execution/actor";
import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import type { ChatMessageInput, ContentPart } from "@/domain/llm/types";
import { log } from "@/shared/logger";

/** Hard deadline for one agent run, enforced by an abort signal so a run that
 * stops producing chunks entirely (hung provider or tool) still ends and
 * reports a timeout instead of leaving the status up forever. */
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
/** How much of the opening question names the thread in the agent's history. */
const MAX_THREAD_TITLE_LENGTH = 60;
/**
 * Rotated by Slack underneath the status line while the run has nothing more
 * specific to report. Slack prefixes each with the app's name, so they read as
 * "<App> is thinking…". A moving indicator is what separates "still working"
 * from "stuck", which one static line cannot say.
 */
const THINKING_MESSAGES = ["is thinking…", "is working through it…", "is still on it…"];
/** Most recent thread turns carried as context; older turns are dropped. */
const MAX_HISTORY_MESSAGES = 50;
/**
 * Message subtypes still worth handling. Subtyped messages are mostly channel
 * bookkeeping (joins, edits, …), but a user's file upload arrives as
 * `file_share` and dropping it would leave the mention unanswered.
 */
const ALLOWED_SUBTYPES = new Set(["file_share"]);
/**
 * Attachment limits — the same ones every other surface enforces. Anything
 * dropped is reported, never silently skipped.
 */
const MAX_IMAGE_ATTACHMENTS = MAX_ATTACHMENTS;
const MAX_IMAGE_BYTES = MAX_ATTACHMENT_BYTES;
const SUPPORTED_TYPES = new Set<string>(SUPPORTED_IMAGE_TYPES);
/**
 * How many recent turns are searched for images. A thread can be long and its
 * pictures are re-downloaded and re-encoded on every mention, so only the
 * recent context is worth that cost.
 */
const HISTORY_IMAGE_LOOKBACK = 10;

/** One thread turn: the mapped engine message plus the attachments it carried. */
export interface ThreadTurn {
  message: ChatMessageInput;
  files: SlackEventFile[];
}

/**
 * Convert thread replies to engine turns: bot turns → assistant, human turns →
 * user. A message with no text is kept when it carried files — an image posted
 * on its own is still part of the conversation.
 *
 * `nameByUser` labels each human turn with its speaker. Callers pass it only
 * when the thread has more than one human: every turn is `role: "user"`
 * regardless of who typed it, so without a label a three-way conversation
 * reaches the model as one person's monologue — and *with* one on a two-party
 * thread it is just noise on every line.
 *
 * The label goes in the text rather than in `ChatMessageInput.name`: OpenAI
 * constrains that field's character set, so a display name with a space or any
 * non-Latin script cannot go there, and providers disagree about the rest.
 */
export function threadToTurns(
  replies: SlackMessage[],
  currentTs: string,
  nameByUser?: ReadonlyMap<string, string>,
): ThreadTurn[] {
  return replies
    .filter(
      (m) => m.ts !== currentTs && ((m.text ?? "").trim() !== "" || (m.files ?? []).length > 0),
    )
    .map((m) => {
      const text = (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const speaker = m.bot_id ? undefined : (m.user && nameByUser?.get(m.user)) || undefined;
      return {
        message: {
          role: m.bot_id ? ("assistant" as const) : ("user" as const),
          content: speaker && text ? `${speaker}: ${text}` : text,
        },
        files: m.files ?? [],
      };
    });
}

/**
 * Download image attachments as content parts, up to `budget` images. Callers
 * spend the budget on the current message first, then on the newest history.
 */
async function collectImageParts(
  deps: SlackEventDeps,
  token: string,
  files: SlackEventFile[],
  warnings: string[],
  budget = MAX_IMAGE_ATTACHMENTS,
): Promise<ContentPart[]> {
  if (budget <= 0) {
    return [];
  }
  const images = files.filter((file) => (file.mimetype ?? "").startsWith("image/"));
  const others = files.length - images.length;
  if (others > 0) {
    warnings.push(`Ignored ${others} non-image attachment(s).`);
  }
  if (images.length > budget) {
    warnings.push(`Read only ${budget} of ${images.length} attached images.`);
  }

  const parts: ContentPart[] = [];
  for (const file of images.slice(0, budget)) {
    const label = file.name ?? file.id ?? "attachment";
    const mimeType = file.mimetype ?? "";
    if (!SUPPORTED_TYPES.has(mimeType)) {
      warnings.push(`Unsupported image type ${mimeType} (${label}).`);
      continue;
    }
    if ((file.size ?? 0) > MAX_IMAGE_BYTES) {
      warnings.push(`Image is larger than 5MB (${label}).`);
      continue;
    }
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      warnings.push(`Attachment has no download url (${label}).`);
      continue;
    }
    try {
      const data = await deps.slack.downloadFile(token, url);
      // Slack's declared size can be absent; the real byte count is authoritative.
      if (data.byteLength > MAX_IMAGE_BYTES) {
        warnings.push(`Image is larger than 5MB (${label}).`);
        continue;
      }
      parts.push({
        type: "image_url",
        image_url: { url: imageDataUrl({ b64: data.toString("base64"), mimeType }) },
      });
    } catch (error) {
      log.error("slack", "attachment download failed", error);
      warnings.push(
        `Could not read attachment ${label}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return parts;
}

/**
 * Attach the images of earlier thread turns to their own messages, newest turn
 * first until the budget runs out. Without this an "edit the picture I sent
 * earlier" request in a thread would reach the model as text alone.
 */
async function withHistoryImages(
  deps: SlackEventDeps,
  token: string,
  turns: ThreadTurn[],
  budget: number,
  warnings: string[],
): Promise<ChatMessageInput[]> {
  const partsByIndex = new Map<number, ContentPart[]>();
  let remaining = budget;
  const oldest = Math.max(0, turns.length - HISTORY_IMAGE_LOOKBACK);
  for (let index = turns.length - 1; index >= oldest && remaining > 0; index -= 1) {
    const turn = turns[index];
    // Only a human turn's images are input. The bot's own uploads would come back
    // as `image_url` parts on an *assistant* message — a shape OpenAI-compatible
    // providers reject — and would spend the budget on pictures this run drew.
    if (turn?.message.role !== "user") {
      continue;
    }
    // Only image attachments are relevant here, and an older turn's unrelated
    // files are not worth reporting on — the user is asking about this turn.
    const imageFiles = (turn?.files ?? []).filter((file) =>
      (file.mimetype ?? "").startsWith("image/"),
    );
    if (imageFiles.length === 0) {
      continue;
    }
    const parts = await collectImageParts(deps, token, imageFiles, warnings, remaining);
    if (parts.length > 0) {
      partsByIndex.set(index, parts);
      remaining -= parts.length;
    }
  }

  return turns.map((turn, index) => {
    const parts = partsByIndex.get(index);
    if (!parts) {
      return turn.message;
    }
    const text = typeof turn.message.content === "string" ? turn.message.content : "";
    return {
      ...turn.message,
      content: [...(text ? [{ type: "text" as const, text }] : []), ...parts],
    };
  });
}

/**
 * Who is asking, and who else is in the thread.
 *
 * Two separate needs, one pass over the same profiles: the asker names the
 * caller block, and the rest only matter when there is more than one human in
 * the thread — a two-party conversation needs no labels, and putting them on
 * every line would spend context on saying the same name over and over.
 *
 * Every lookup is best-effort. A run that could not learn a name still answers;
 * losing the label is not worth losing the reply.
 */
async function resolveSpeakers(
  deps: SlackEventDeps,
  token: string,
  replies: SlackMessage[],
  currentUser: string | undefined,
): Promise<{ caller?: RunCaller; nameByUser?: Map<string, string> }> {
  const humans = new Set<string>();
  for (const reply of replies) {
    if (!reply.bot_id && reply.user) {
      humans.add(reply.user);
    }
  }
  if (currentUser) {
    humans.add(currentUser);
  }
  // Only the asker's profile is needed to name the caller; the others are
  // fetched solely to tell speakers apart, so a single-speaker thread skips them.
  const wanted = humans.size > 1 ? [...humans] : currentUser ? [currentUser] : [];
  const resolved = await Promise.all(
    wanted.map(async (userId) => [userId, await deps.slack.userProfile(token, userId)] as const),
  );

  const nameByUser = new Map<string, string>();
  let caller: RunCaller | undefined;
  for (const [userId, profile] of resolved) {
    if (!profile) {
      continue;
    }
    nameByUser.set(userId, profile.displayName);
    if (userId === currentUser) {
      caller = profile;
    }
  }
  return {
    ...(caller ? { caller } : {}),
    ...(humans.size > 1 && nameByUser.size > 0 ? { nameByUser } : {}),
  };
}

/** Credentials and project binding for a project-dedicated bot. */
export interface SlackBotBinding {
  projectName: string;
  botToken: string;
}

/** Process one app_mention / DM event: run the agent project and stream the reply. */
export async function handleSlackEvent(
  deps: SlackEventDeps,
  body: SlackEventBody,
  binding: SlackBotBinding,
): Promise<void> {
  const event = body.event;
  const token = binding.botToken;
  if (!event?.channel || !event.ts) {
    return;
  }
  // Ignore our own (and any other bot's) messages to prevent loops. `bot_id` is
  // not enough on its own: a file the bot shares through the external upload flow
  // is attributed to the bot *user*, and `file_share` is an allowed subtype — so
  // the app's own user id is checked too.
  const selfUserId = body.authorizations?.find((auth) => auth.user_id)?.user_id;
  if (event.bot_id || (selfUserId && event.user === selfUserId)) {
    return;
  }
  if (event.subtype && !ALLOWED_SUBTYPES.has(event.subtype)) {
    return;
  }

  const message = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const projectName = binding.projectName;
  const threadTs = event.thread_ts ?? event.ts;

  const project = await deps.projects.get(projectName);
  // External surface: published-only, drafts never leak (resolveRunnableVersion policy).
  const version = project ? await resolveRunnableVersion(deps.versions, project) : null;
  if (!project || project.projectType !== "agent" || !version) {
    await deps.slack.postMessage(token, {
      channel: event.channel,
      thread_ts: threadTs,
      text: `Agent project not available: ${projectName} (must exist, be an agent project, and have a published version)`,
    });
    return;
  }

  log.info("slack", `run start project=${projectName} channel=${event.channel} ts=${event.ts}`);

  const warnings: string[] = [];
  // Read the thread *before* the run writes anything of its own — otherwise the
  // reply comes back as an assistant turn in this run's own context.
  let replies: SlackMessage[] = [];
  if (event.thread_ts !== undefined) {
    try {
      replies = await deps.slack.threadReplies(token, {
        channel: event.channel,
        ts: event.thread_ts,
      });
    } catch (error) {
      log.error("slack", "thread history failed", error);
      warnings.push("Thread history unavailable; answered without prior context.");
    }
  }

  // The version's opt-in gates the *lookup*, not just the prompt: a project that
  // did not ask to know who is asking should not be sending anyone's id to
  // Slack's profile API either.
  const named = version.parameters.callerContext
    ? await resolveSpeakers(deps, token, replies, event.user)
    : { caller: undefined, nameByUser: undefined };
  const turns = threadToTurns(replies, event.ts, named.nameByUser).slice(-MAX_HISTORY_MESSAGES);

  // A DM is an agent thread: it has a native status line and a title. A channel
  // mention has neither, and streaming into one needs the recipient named.
  const isAssistantThread = event.channel_type === "im";
  const sink = createReplySink(
    deps.slack,
    token,
    {
      channel: event.channel,
      threadTs,
      assistantThread: isAssistantThread,
      ...(!isAssistantThread && event.user && body.team_id
        ? { recipient: { userId: event.user, teamId: body.team_id } }
        : {}),
    },
    deps.loadingIndicator,
  );
  await sink.status(THINKING_MESSAGES[0] ?? "is thinking…", THINKING_MESSAGES);
  // Name the thread from the question that opened it, so the agent's history
  // reads as a list of topics rather than of timestamps. Only the opening turn:
  // a later message would rename the thread out from under the user.
  if (isAssistantThread && turns.length === 0 && message) {
    await deps.slack
      .setTitle(token, {
        channel_id: event.channel,
        thread_ts: threadTs,
        title: message.slice(0, MAX_THREAD_TITLE_LENGTH),
      })
      .catch(() => {});
  }

  let text = "";
  const images: Array<{ b64: string; mimeType: string; prompt?: string }> = [];
  const deadline = AbortSignal.timeout(RUN_TIMEOUT_MS);
  const imageParts =
    event.files && event.files.length > 0
      ? await collectImageParts(deps, token, event.files, warnings)
      : [];
  // An image-only message must not become an empty user turn.
  const userContent: string | ContentPart[] =
    imageParts.length > 0
      ? [...(message ? [{ type: "text" as const, text: message }] : []), ...imageParts]
      : message;
  // Whatever budget the current message left goes to the newest thread images,
  // so "make the picture I sent blue" still has the picture.
  const history = await withHistoryImages(
    deps,
    token,
    turns,
    MAX_IMAGE_ATTACHMENTS - imageParts.length,
    warnings,
  );
  // A run can go minutes between chunks — a slow provider, a long tool — and
  // Slack drops a status two minutes after it is set. Refreshing on chunk
  // arrival alone would go quiet exactly when the run is slowest, so this runs
  // on its own clock.
  const stopStatusHeartbeat = sink.keepStatusAlive();
  try {
    const messages: ChatMessageInput[] = [...history, { role: "user", content: userContent }];
    for await (const chunk of deps.runAgent({
      project,
      version,
      messages,
      // The Slack user id, not an email: Slack does not hand one over, and
      // guessing at a mapping would attribute spend to the wrong person.
      ...(event.user ? { actor: { kind: "slack" as const, id: event.user } } : {}),
      ...(named.caller ? { caller: named.caller } : {}),
      signal: deadline,
    })) {
      if (chunk.error) {
        warnings.push(chunk.error);
        // A subagent's failure reaches the parent as a tool error and the parent
        // often answers anyway (a refused transfer, an unusable child model), so
        // only a top-level failure ends the run.
        if (isTopLevelChunk(chunk)) {
          break;
        }
        continue;
      }
      if (chunk.warning) {
        // A binding the run could not use. It rides out with the answer rather
        // than replacing it — the run still produced one.
        warnings.push(chunk.warning);
      }
      // Report tool activity through the status line rather than the answer:
      // a tool-heavy first turn shows progress without spending the message
      // body on it, so every tool can be named, not just the first.
      const toolCall = chunk.delta?.toolCalls?.[0] as
        | { function?: { name?: string } }
        | undefined;
      if (toolCall?.function?.name) {
        await sink.status(`is using ${toolCall.function.name}…`);
      }
      if (chunk.image) {
        images.push(chunk.image);
      }
      const content = chunk.delta?.content;
      if (content && isTopLevelChunk(chunk)) {
        text += content;
        await sink.push(text);
      }
    }
  } catch (error) {
    warnings.push(
      deadline.aborted
        ? "Agent run timed out"
        : error instanceof Error
          ? error.message
          : "agent run failed",
    );
  } finally {
    stopStatusHeartbeat();
  }

  log.info(
    "slack",
    `run done project=${projectName} chars=${text.length} images=${images.length} warnings=${warnings.length}`,
  );
  for (const [index, image] of images.entries()) {
    try {
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await deps.slack.uploadImage(token, {
        channel: event.channel,
        threadTs: threadTs,
        filename: `generated-${Date.now()}-${index + 1}.${ext}`,
        data: Buffer.from(image.b64, "base64"),
        title: image.prompt?.slice(0, 80) ?? "Generated image",
      });
    } catch (error) {
      log.error("slack", "image upload failed", error);
      warnings.push(`Image upload failed: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  await sink.finish(text, warnings.map((warning) => `:warning: ${warning}`).join("\n"));
}
