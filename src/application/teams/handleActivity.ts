import { handleTurn } from "@/application/messaging/handleTurn";
import {
  attachmentNote,
  imagesNote,
  loadTranscriptHistory,
  rememberTurn,
  withSpeakerLabels,
} from "@/application/messaging/transcriptHistory";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { createTeamsReplyChannel } from "@/application/teams/replyChannel";
import type { TeamsActivityDisposition } from "@/application/teams/engagement";
import type {
  TeamsActivity,
  TeamsAttachment,
  TeamsCredentials,
  TeamsEventDeps,
} from "@/application/teams/types";
import { callerFrom, conversationKey, type RunCaller } from "@/domain/execution/actor";
import type { InboundAttachment } from "@/domain/messaging/inbound";
import { teamsConversation } from "@/domain/teams/conversation";
import { log } from "@/shared/logger";

/** Credentials and project binding for a project-dedicated bot. */
export interface TeamsBotBinding {
  projectName: string;
  credentials: TeamsCredentials;
}

/** Teams' own envelope for a file someone shared in a personal chat. */
const FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info";

/**
 * A person's name as Teams carries it on the activity. `callerFrom` bounds and
 * flattens it — a display name is set by its owner or their directory, and it
 * lands in a system prompt.
 */
function callerOf(activity: TeamsActivity): RunCaller | undefined {
  return callerFrom({ displayName: activity.from?.name ?? "" }) ?? undefined;
}

/**
 * The message's attachments as the shared pipeline reads them.
 *
 * Two shapes carry bytes. A picture pasted into the message is an `image/*`
 * attachment whose `contentUrl` sits on the conversation's service host and
 * needs the bot's token; a file shared in a personal chat is a
 * `file.download.info` envelope with a pre-authenticated `downloadUrl` and the
 * file's own name and type. The message's `text/html` twin is not an
 * attachment at all. Anything else is named so the pipeline can say it could
 * not read it.
 */
function attachmentsOf(
  deps: TeamsEventDeps,
  binding: TeamsBotBinding,
  activity: TeamsActivity,
): InboundAttachment[] {
  const attachments: InboundAttachment[] = [];
  const serviceUrl = activity.serviceUrl ?? "";
  for (const [index, attachment] of (activity.attachments ?? []).entries()) {
    if (attachment.contentType === "text/html") {
      continue;
    }
    if (attachment.contentType === FILE_DOWNLOAD_INFO) {
      const content = attachment.content as { downloadUrl?: string; fileType?: string } | undefined;
      const url = content?.downloadUrl;
      attachments.push({
        name: attachment.name ?? `file-${index + 1}`,
        mimeType: mimeOfFileType(content?.fileType, attachment.name),
        ...(url ? { download: download(deps, binding, serviceUrl, url) } : {}),
      });
      continue;
    }
    attachments.push({
      name: attachment.name ?? nameFor(attachment, index),
      mimeType: attachment.contentType,
      ...(attachment.contentUrl ? { download: download(deps, binding, serviceUrl, attachment.contentUrl) } : {}),
    });
  }
  return attachments;
}

function download(deps: TeamsEventDeps, binding: TeamsBotBinding, serviceUrl: string, url: string) {
  return (maxBytes: number) => deps.teams.downloadAttachment(binding.credentials, serviceUrl, url, maxBytes);
}

function nameFor(attachment: TeamsAttachment, index: number): string {
  const ext = attachment.contentType.startsWith("image/") ? `.${attachment.contentType.slice("image/".length)}` : "";
  return `attachment-${index + 1}${ext}`;
}

/** Teams names a shared file's type by extension (`pdf`, `docx`); the pipeline reads a media type or a name. */
function mimeOfFileType(fileType: string | undefined, name: string | undefined): string {
  const ext = (fileType ?? name?.split(".").pop() ?? "").toLowerCase();
  const known: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return known[ext] ?? "";
}

/**
 * Run the agent project for one activity and stream the reply.
 *
 * Whether this activity was for the bot at all is already decided:
 * `classifyTeamsActivity` is the single owner of that, and it runs in the
 * route ahead of the dedup claim. Nothing here re-checks it.
 */
export async function handleTeamsActivity(
  deps: TeamsEventDeps,
  disposition: Exclude<TeamsActivityDisposition, { kind: "ignore" }>,
  binding: TeamsBotBinding,
): Promise<void> {
  const { activity } = disposition;
  const serviceUrl = activity.serviceUrl ?? "";
  const conversationId = activity.conversation?.id ?? "";
  const reply = createTeamsReplyChannel(
    deps.teams,
    binding.credentials,
    {
      serviceUrl,
      conversationId,
      ...(activity.id ? { replyToId: activity.id } : {}),
    },
    { ...(deps.sleep ? { sleep: deps.sleep } : {}) },
  );

  const project = await deps.projects.get(binding.projectName);
  // External surface: published-only, drafts never leak (resolveRunnableVersion policy).
  const version = project ? await resolveRunnableVersion(deps.versions, project) : null;
  if (!project || project.projectType !== "agent" || !version) {
    await reply.say(
      `Agent project not available: ${binding.projectName} (must exist, be an agent project, and have a published version)`,
    );
    return;
  }

  log.info(
    "teams",
    `run start project=${project.name} conversation=${conversationId} activity=${activity.id ?? "?"}`,
  );

  const conversation = teamsConversation(conversationId);
  const key = conversationKey(conversation);
  const warnings: string[] = [];
  // Read before anything is written, like the Slack thread: the reply must
  // not come back as an assistant turn in this run's own context.
  const remembered = await loadTranscriptHistory(deps.transcripts, project.name, key, warnings, "teams");
  await reply.status("is thinking…");

  // The Entra object id where Teams gives one — it is the person across every
  // chat they are in — else the conversation-scoped id.
  const userId = activity.from?.aadObjectId ?? activity.from?.id;
  const namesAllowed = version.parameters.callerContext === true;
  const named = namesAllowed ? callerOf(activity) : undefined;
  const { history, label } = withSpeakerLabels(remembered, userId, namesAllowed);
  const askText = label && named ? `${named.displayName}: ${disposition.text}` : disposition.text;
  const attachments = attachmentsOf(deps, binding, activity);

  const outcome = await handleTurn(
    deps,
    {
      project,
      version,
      text: askText,
      attachments,
      history,
      // The Entra object id, not an email: Teams hands a bot no address.
      ...(userId ? { actor: { kind: "teams" as const, id: userId } } : {}),
      ...(named ? { caller: named } : {}),
      conversation,
      warnings,
    },
    reply,
  );

  // Written after the reply, because that is what makes it true — and the
  // question first, so the two land in the order they were said.
  const now = new Date().toISOString();
  await rememberTurn(
    deps.transcripts,
    project.name,
    key,
    {
      role: "user",
      content: disposition.text || attachmentNote(attachments.map((attachment) => attachment.name)),
      ...(userId ? { userId } : {}),
      ...(named ? { speaker: named.displayName } : {}),
      createdAt: now,
    },
    "teams",
  );
  await rememberTurn(
    deps.transcripts,
    project.name,
    key,
    {
      role: "assistant",
      content: outcome.text || imagesNote(outcome.imagesDelivered),
      createdAt: new Date(Date.parse(now) + 1).toISOString(),
    },
    "teams",
  );
}
