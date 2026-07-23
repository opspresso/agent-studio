import type { SlackMessage } from "@/infrastructure/slack/client";
import type { ExecuteAgentInput } from "@/application/execution/runProject";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import { isTopLevelChunk } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";

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
}

/** Injected dependencies; wired by the route from the composition root. */
export interface SlackEventDeps {
  /** Bound wrapper over `executeAgent(executionDeps, params)` (mirrors ChatDeps.runAgent). */
  runAgent: (params: ExecuteAgentInput) => AsyncGenerator<EngineChunk>;
  projects: ProjectRepository;
  versions: VersionRepository;
  slack: SlackClientPort;
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
  };
}

const UPDATE_INTERVAL_MS = 1000;
/** Hard deadline for one agent run; on expiry the message reports a timeout
 * instead of showing the placeholder forever. */
const RUN_TIMEOUT_MS = 3 * 60 * 1000;

/** Convert thread replies to engine messages: bot turns → assistant, human turns → user. */
export function threadToMessages(replies: SlackMessage[], currentTs: string): ChatMessageInput[] {
  return replies
    .filter((m) => m.ts !== currentTs && (m.text ?? "").trim() !== "")
    .map((m) => ({
      role: m.bot_id ? ("assistant" as const) : ("user" as const),
      content: (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim(),
    }));
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
  if (event.bot_id || event.subtype) {
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
  const placeholder = await deps.slack.postMessage(token, {
    channel: event.channel,
    thread_ts: threadTs,
    text: "_thinking…_",
  });

  let text = "";
  let lastUpdate = 0;
  let failed: string | null = null;
  const images: Array<{ b64: string; mimeType: string; prompt?: string }> = [];
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  try {
    const history =
      event.thread_ts !== undefined
        ? threadToMessages(
            await deps.slack.threadReplies(token, { channel: event.channel, ts: event.thread_ts }),
            event.ts,
          )
        : [];
    const messages: ChatMessageInput[] = [...history, { role: "user", content: message }];
    for await (const chunk of deps.runAgent({ project, version, messages })) {
      if (Date.now() > deadline) {
        failed = "Agent run timed out";
        break;
      }
      if (chunk.error) {
        failed = chunk.error;
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
            text: `:hammer_and_wrench: _${toolCall.function.name} 사용 중…_`,
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
    failed = error instanceof Error ? error.message : "agent run failed";
  }

  console.log(
    `[slack] run done project=${projectName} chars=${text.length} images=${images.length} failed=${failed ?? "no"}`,
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
      failed = failed ?? `Image upload failed: ${error instanceof Error ? error.message : "unknown"}`;
    }
  }
  try {
    await deps.slack.updateMessage(token, {
      channel: placeholder.channel,
      ts: placeholder.ts,
      text: failed ? `:warning: ${failed}` : text || "(no response)",
    });
  } catch (error) {
    console.error("[slack] final update failed", error);
  }
}
