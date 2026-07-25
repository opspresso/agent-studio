import type { SlackMessage } from "@/infrastructure/slack/client";
import type { ExecuteAgentInput } from "@/application/execution/runProject";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { ChatMessageInput, ContentPart, EngineChunk } from "@/domain/llm/types";

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
/** Attachment limits. Anything dropped is reported, never silently skipped. */
const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Convert thread replies to engine messages: bot turns → assistant, human turns → user. */
export function threadToMessages(replies: SlackMessage[], currentTs: string): ChatMessageInput[] {
  return replies
    .filter((m) => m.ts !== currentTs && (m.text ?? "").trim() !== "")
    .map((m) => ({
      role: m.bot_id ? ("assistant" as const) : ("user" as const),
      content: (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim(),
    }));
}

/**
 * Download the event's image attachments as content parts. Only the current
 * event's files are read — pulling every image out of a long thread would cost
 * far more in tokens and latency than the added context is worth.
 */
async function collectImageParts(
  deps: SlackEventDeps,
  token: string,
  files: SlackEventFile[],
  warnings: string[],
): Promise<ContentPart[]> {
  const images = files.filter((file) => (file.mimetype ?? "").startsWith("image/"));
  const others = files.length - images.length;
  if (others > 0) {
    warnings.push(`Ignored ${others} non-image attachment(s).`);
  }
  if (images.length > MAX_IMAGE_ATTACHMENTS) {
    warnings.push(
      `Read only the first ${MAX_IMAGE_ATTACHMENTS} of ${images.length} attached images.`,
    );
  }

  const parts: ContentPart[] = [];
  for (const file of images.slice(0, MAX_IMAGE_ATTACHMENTS)) {
    const label = file.name ?? file.id ?? "attachment";
    const mimeType = file.mimetype ?? "";
    if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
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
        image_url: { url: `data:${mimeType};base64,${data.toString("base64")}` },
      });
    } catch (error) {
      console.error("[slack] attachment download failed", error);
      warnings.push(
        `Could not read attachment ${label}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return parts;
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
  // Ignore our own (and any other bot's) messages to prevent loops.
  if (event.bot_id || (event.subtype && !ALLOWED_SUBTYPES.has(event.subtype))) {
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

  console.log(`[slack] run start project=${projectName} channel=${event.channel} ts=${event.ts}`);

  const warnings: string[] = [];
  // Read the thread *before* posting the placeholder — otherwise our own
  // placeholder comes back as an assistant turn in this run's own context.
  let history: ChatMessageInput[] = [];
  if (event.thread_ts !== undefined) {
    try {
      const replies = await deps.slack.threadReplies(token, {
        channel: event.channel,
        ts: event.thread_ts,
      });
      history = threadToMessages(replies, event.ts).slice(-MAX_HISTORY_MESSAGES);
    } catch (error) {
      console.error("[slack] thread history failed", error);
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
  try {
    const messages: ChatMessageInput[] = [...history, { role: "user", content: userContent }];
    for await (const chunk of deps.runAgent({ project, version, messages, signal: deadline })) {
      if (chunk.error) {
        warnings.push(chunk.error);
        break;
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
              text: `${text} …`,
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

  console.log(
    `[slack] run done project=${projectName} chars=${text.length} images=${images.length} warnings=${warnings.length}`,
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
      console.error("[slack] image upload failed", error);
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
    console.error("[slack] final update failed", error);
  }
}
