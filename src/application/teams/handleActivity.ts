import { resolveAgentProject, runRememberedTurn } from "@/application/messaging/rememberedTurn";
import { createTeamsReplyChannel } from "@/application/teams/replyChannel";
import type { TeamsActivityDisposition } from "@/application/teams/engagement";
import type {
  TeamsActivity,
  TeamsAttachment,
  TeamsCredentials,
  TeamsEventDeps,
} from "@/application/teams/types";
import { callerFrom, type RunCaller } from "@/domain/execution/actor";
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
 * attachment — Teams says no more than that about its kind, and the pipeline
 * reads the bytes to find out — whose `contentUrl` sits on the conversation's
 * service host and needs the bot's token; a file shared in a personal chat is
 * a `file.download.info` envelope with a pre-authenticated `downloadUrl` and
 * the file's own name and type. The message's `text/html` twin is not an
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
  const kind = attachment.contentType.startsWith("image/") ? attachment.contentType.slice("image/".length) : "";
  return `attachment-${index + 1}${kind && kind !== "*" ? `.${kind}` : ""}`;
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
  // Own keys only: the extension comes off a filename Teams was given, and a
  // plain lookup answers `constructor` with a function where a mime type goes.
  return (Object.hasOwn(known, ext) ? known[ext] : undefined) ?? "";
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

  const runnable = await resolveAgentProject(deps, binding.projectName, reply);
  if (!runnable) {
    return;
  }
  const { project, version } = runnable;

  log.info(
    "teams",
    `run start project=${project.name} conversation=${conversationId} activity=${activity.id ?? "?"}`,
  );

  // The Entra object id where Teams gives one — it is the person across every
  // chat they are in — else the conversation-scoped id.
  const userId = activity.from?.aadObjectId ?? activity.from?.id;
  const arrivedAt = activity.timestamp ? new Date(activity.timestamp) : new Date();
  await runRememberedTurn(deps, {
    project,
    version,
    reply,
    conversation: teamsConversation(conversationId),
    text: disposition.text,
    attachments: attachmentsOf(deps, binding, activity),
    // The Entra object id, not an email: Teams hands a bot no address.
    ...(userId ? { actor: { kind: "teams" as const, id: userId }, userId } : {}),
    callerOf: () => callerOf(activity),
    arrivedAt: Number.isNaN(arrivedAt.getTime()) ? new Date() : arrivedAt,
    warnings: [],
    scope: "teams",
  });
}
