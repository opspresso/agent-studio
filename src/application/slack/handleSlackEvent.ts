import type { SlackMessage } from "@/domain/slack/types";
import type { ExecuteAgentInput } from "@/application/execution/runProject";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import { imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import type { ChatMessageInput, ContentPart, EngineChunk } from "@/domain/llm/types";
import { log } from "@/shared/logger";

/** The slice of the Slack Web API the event handler uses; faked in tests. */
export interface SlackClientPort {
  postMessage(
    token: string,
    args: { channel: string; text: string; thread_ts?: string },
  ): Promise<{ ts: string; channel: string }>;
  updateMessage(
    token: string,
    args: { channel: string; ts: string; text: string },
  ): Promise<{ ts: string }>;
  uploadImage(
    token: string,
    args: { channel: string; threadTs?: string; filename: string; data: Buffer; title?: string },
  ): Promise<void>;
  threadReplies(
    token: string,
    args: { channel: string; ts: string; limit?: number },
  ): Promise<SlackMessage[]>;
  /** Fetch a file shared with the bot (host-checked, bot-token authenticated). */
  downloadFile(token: string, url: string): Promise<Buffer>;
}

/** Injected dependencies; wired by the route from the composition root. */
export interface SlackEventDeps {
  /** Bound wrapper over `executeAgent(executionDeps, params)` (mirrors ChatDeps.runAgent). */
  runAgent: (params: ExecuteAgentInput) => AsyncGenerator<EngineChunk>;
  projects: ProjectRepository;
  versions: VersionRepository;
  slack: SlackClientPort;
  /**
   * What marks a reply as still being written. Injected rather than read here:
   * application code takes its configuration, it does not reach for it. Unset
   * means {@link DEFAULT_LOADING_INDICATOR}.
   */
  loadingIndicator?: string;
}

/** An attachment on an inbound message event. */
export interface SlackEventFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackEventBody {
  event_id?: string;
  /**
   * Who the event was delivered for — our own app's user id in this workspace.
   * Comparing it to `event.user` identifies the bot's own messages without an
   * extra `auth.test` round trip.
   */
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: SlackEventFile[];
  };
}

const UPDATE_INTERVAL_MS = 1000;
/**
 * Appended to a reply that is still being written, when the deployment names
 * nothing else.
 *
 * An interim update is indistinguishable from a finished answer otherwise — the
 * message is edited in place, so a reader who arrives mid-run sees what looks
 * like a complete reply that stops mid-sentence. This marks it as still going,
 * and the final edit drops it.
 *
 * A built-in emoji as the default, because it is the only kind that renders
 * everywhere: a custom name a workspace has not defined shows up as its own
 * literal text, which is noise exactly where the reply should read as
 * unfinished-but-fine. A workspace that *has* one says so through
 * `SLACK_LOADING_INDICATOR`.
 */
const DEFAULT_LOADING_INDICATOR = ":hourglass_flowing_sand:";
/** Hard deadline for one agent run, enforced by an abort signal so a run that
 * stops producing chunks entirely (hung provider or tool) still ends and
 * reports a timeout instead of leaving the placeholder up. */
const RUN_TIMEOUT_MS = 3 * 60 * 1000;
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
 */
export function threadToTurns(replies: SlackMessage[], currentTs: string): ThreadTurn[] {
  return replies
    .filter(
      (m) => m.ts !== currentTs && ((m.text ?? "").trim() !== "" || (m.files ?? []).length > 0),
    )
    .map((m) => ({
      message: {
        role: m.bot_id ? ("assistant" as const) : ("user" as const),
        content: (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim(),
      },
      files: m.files ?? [],
    }));
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
  // Read the thread *before* posting the placeholder — otherwise our own
  // placeholder comes back as an assistant turn in this run's own context.
  let turns: ThreadTurn[] = [];
  if (event.thread_ts !== undefined) {
    try {
      const replies = await deps.slack.threadReplies(token, {
        channel: event.channel,
        ts: event.thread_ts,
      });
      turns = threadToTurns(replies, event.ts).slice(-MAX_HISTORY_MESSAGES);
    } catch (error) {
      log.error("slack", "thread history failed", error);
      warnings.push("Thread history unavailable; answered without prior context.");
    }
  }

  const placeholder = await deps.slack.postMessage(token, {
    channel: event.channel,
    thread_ts: threadTs,
    text: "_thinking…_",
  });

  let text = "";
  let lastUpdate = 0;
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
  try {
    const messages: ChatMessageInput[] = [...history, { role: "user", content: userContent }];
    for await (const chunk of deps.runAgent({
      project,
      version,
      messages,
      // The Slack user id, not an email: Slack does not hand one over, and
      // guessing at a mapping would attribute spend to the wrong person.
      ...(event.user ? { actor: { kind: "slack" as const, id: event.user } } : {}),
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
      // Stream tool activity so the first (tool-heavy) turn shows progress.
      const toolCall = chunk.delta?.toolCalls?.[0] as
        | { function?: { name?: string } }
        | undefined;
      if (toolCall?.function?.name && text === "") {
        await deps.slack
          .updateMessage(token, {
            channel: placeholder.channel,
            ts: placeholder.ts,
            text: `:hammer_and_wrench: _Using ${toolCall.function.name}…_`,
          })
          .catch(() => {});
      }
      if (chunk.image) {
        images.push(chunk.image);
      }
      const content = chunk.delta?.content;
      if (content && isTopLevelChunk(chunk)) {
        text += content;
        const now = Date.now();
        if (now - lastUpdate > UPDATE_INTERVAL_MS) {
          lastUpdate = now;
          await deps.slack
            .updateMessage(token, {
              channel: placeholder.channel,
              ts: placeholder.ts,
              text: `${text} ${deps.loadingIndicator || DEFAULT_LOADING_INDICATOR}`,
            })
            .catch(() => {});
        }
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
  const suffix = warnings.map((warning) => `:warning: ${warning}`).join("\n");
  try {
    await deps.slack.updateMessage(token, {
      channel: placeholder.channel,
      ts: placeholder.ts,
      // Append the warnings rather than replacing a good answer: a late failure
      // (image upload, timeout, mid-stream error) must not discard text that
      // was already streamed to the user.
      text: text ? (suffix ? `${text}\n\n${suffix}` : text) : suffix || "(no response)",
    });
  } catch (error) {
    log.error("slack", "final update failed", error);
  }
}
