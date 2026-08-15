import type { SlackMessage } from "@/domain/slack/types";
import { resolveRunnableVersion } from "@/application/project/resolveRunnableVersion";
import { createReplySink } from "@/application/slack/replyStream";
import { parseSlackCommand, selfUserId } from "@/application/slack/engagement";
import { handleSlackCommand } from "@/application/slack/handleCommand";
import {
  fileRefOf,
  resolveProducedFiles,
  type ProducedFileRef,
} from "@/application/artifact/producedFiles";
import { RECORD_URL_TTL_SECONDS } from "@/application/artifact/urlTtl";
import type { SlackEventBody, SlackEventDeps, SlackEventFile } from "@/application/slack/types";
import type { RunCaller } from "@/domain/execution/actor";
import { collectedWarning, imageDataUrl, isTopLevelChunk } from "@/domain/llm/types";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  SUPPORTED_IMAGE_TYPES,
} from "@/domain/llm/imageLimits";
import type { ChatMessageInput, ContentPart } from "@/domain/llm/types";
import { documentKind, MAX_DOCUMENT_BYTES } from "@/domain/llm/documentLimits";
import {
  readDocuments as readDocumentsFor,
  turnContent,
  withinDocumentCount,
  type AttachedDocument,
  type ReadDocument,
} from "@/application/llm/documentParts";
import { log } from "@/shared/logger";
import { INTERACTIVE_RUN_TIMEOUT_MS } from "@/shared/runDeadline";
/** How much of the opening question names the thread in the agent's history. */
const MAX_THREAD_TITLE_LENGTH = 60;
/**
 * Rotated by Slack underneath the status line while the run has nothing more
 * specific to report. Slack prefixes each with the app's name, so they read as
 * "<App> is thinking…". A moving indicator is what separates "still working"
 * from "stuck", which one static line cannot say.
 */
const THINKING_MESSAGES = ["is thinking…", "is working through it…", "is still on it…"];
/**
 * Put on the message the run was started by, the moment it is picked up.
 *
 * A channel's reply lives in a thread, which is somewhere nobody is
 * necessarily looking yet, and several people may be talking at once — so the
 * only acknowledgement that says *this message, and I have it* is one on the
 * message itself. It matters most where nothing was addressed to the bot
 * explicitly: a follow-up in a thread it is engaged in, or a keyword it woke
 * on, where the person has no reason to assume it heard.
 *
 * Built-in rather than configurable, and built-in rather than a custom name: a
 * workspace that has not defined a custom emoji renders the reaction as an
 * error, and there is no evidence yet about what a project would want instead.
 */
const PICKED_UP_REACTION = "eyes";
/** Most recent thread turns carried as context; older turns are dropped. */
const MAX_THREAD_HISTORY_MESSAGES = 50;
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

/**
 * There was nothing to ask. Thrown rather than returned so the one `finally`
 * that stops the status heartbeat still runs, and caught without a warning of
 * its own: the reason every attachment failed is already in `warnings`, and
 * "agent run failed" on top of it would blame the run for not starting.
 */
class EmptyTurnError extends Error {}

/** One thread turn: the mapped engine message plus the attachments it carried. */
export interface ThreadTurn {
  message: ChatMessageInput;
  files: SlackEventFile[];
  /** The human who wrote it, when one did. Absent on the bot's own turns. */
  userId?: string;
}

/**
 * Text safe to put inside Slack mrkdwn, for a string this side did not choose.
 *
 * A produced file's name comes from an MCP server, and `safeFileName` only takes
 * out control characters and path separators — every character mrkdwn reads as
 * syntax survives it. `<`, `>` and `|` are the three that matter here: a file
 * called `Q3 <draft>.docx` breaks the link span it is placed in, and
 * `report|v2.docx` truncates the label at the pipe, so the reader is shown a
 * name that is not the file's.
 */
export function mrkdwnText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\|/g, "∣");
}

/**
 * Convert thread replies to engine turns: this bot's own turns → assistant,
 * humans → user, **any other app's messages dropped**. A message with no text is
 * kept when it carried files — an image posted on its own is still part of the
 * conversation.
 *
 * Dropping other bots is the correction, not a filter for noise. `bot_id` alone
 * says "an app wrote this", not "we wrote this", so a thread the bot shares with
 * a CI notifier or an alerting app had that app's messages arriving as *our*
 * assistant turns — the model was shown a deploy bot's output as words it had
 * said itself, and answered follow-ups as though it had. A channel is exactly
 * where several apps post into one thread, which is why this surfaced with
 * `message.channels` rather than before it.
 *
 * `selfUserId` is our app's user id in this workspace (from the event
 * envelope's `authorizations`). Without one there is no way to tell our
 * messages from another app's, so the old rule stands rather than the whole
 * history being thrown away: a thread where the bot's own replies vanished
 * would be worse than one carrying a stranger's.
 *
 * Speakers are *not* named here. Labelling needs profile lookups, and doing them
 * from inside this mapping meant resolving everyone in the thread Slack returned
 * — up to ten pages of it — when only the last {@link MAX_THREAD_HISTORY_MESSAGES}
 * turns survive. So this records who wrote each turn and
 * {@link withSpeakerLabels} labels whatever is left after the slice.
 */
export function threadToTurns(
  replies: SlackMessage[],
  currentTs: string,
  selfUserId?: string,
): ThreadTurn[] {
  const isOurs = (m: SlackMessage): boolean =>
    selfUserId ? m.user === selfUserId : Boolean(m.bot_id);
  return replies
    .filter(
      (m) =>
        m.ts !== currentTs &&
        ((m.text ?? "").trim() !== "" || (m.files ?? []).length > 0) &&
        // Another app's message: not ours to claim, and not a person's turn either.
        (isOurs(m) || !m.bot_id),
    )
    .map((m) => ({
      message: {
        role: isOurs(m) ? ("assistant" as const) : ("user" as const),
        content: (m.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim(),
      },
      files: m.files ?? [],
      ...(m.bot_id || !m.user ? {} : { userId: m.user }),
    }));
}

/**
 * Prefix each human turn with who wrote it.
 *
 * Every turn is `role: "user"` regardless of who typed it, so without this a
 * three-way conversation reaches the model as one person's monologue. Callers
 * pass names only when the thread holds more than one human — on a two-party
 * thread the same name on every line is pure noise.
 *
 * The label goes in the text rather than in `ChatMessageInput.name`: OpenAI
 * constrains that field's character set, so a display name with a space or any
 * non-Latin script cannot go there, and providers disagree about the rest.
 */
export function withSpeakerLabels(
  turns: ThreadTurn[],
  nameByUser: ReadonlyMap<string, string> | undefined,
): ThreadTurn[] {
  if (!nameByUser || nameByUser.size === 0) {
    return turns;
  }
  return turns.map((turn) => {
    const speaker = turn.userId ? nameByUser.get(turn.userId) : undefined;
    const text = typeof turn.message.content === "string" ? turn.message.content : "";
    if (!speaker || !text) {
      return turn;
    }
    return { ...turn, message: { ...turn.message, content: `${speaker}: ${text}` } };
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
  // Only files nothing here can read. Documents are counted out because they
  // have their own path now; calling them "ignored" while they were being read
  // would report a loss that did not happen.
  const unreadable = files.filter(
    (file) =>
      !(file.mimetype ?? "").startsWith("image/") &&
      documentKind(file.mimetype ?? "", file.name ?? "") === null,
  );
  if (unreadable.length > 0) {
    warnings.push(
      `Ignored ${unreadable.length} attachment(s): neither an image nor a readable document.`,
    );
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
      const data = await deps.slack.downloadFile(token, url, MAX_IMAGE_BYTES);
      // Slack's declared size can be absent, so the download is bounded too; this
      // is the same limit restated where the bytes are finally in hand.
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
 * Download the message's document attachments and read them into text parts.
 *
 * Only the current message. An older turn's attachments are left alone: a
 * document is expensive to fetch and parse where an image is not, and unlike
 * "edit the picture I sent earlier" there is no request shape that needs the
 * bytes of a file from three turns ago — the text it contributed is already in
 * the thread.
 *
 * A Slack file lives behind `url_private` and needs this bot's token, which is
 * why no URL-fetching MCP tool can stand in for this.
 */
async function collectDocuments(
  deps: SlackEventDeps,
  token: string,
  files: SlackEventFile[],
  warnings: string[],
): Promise<ReadDocument[]> {
  const candidates = files.filter(
    (file) => documentKind(file.mimetype ?? "", file.name ?? "") !== null,
  );
  if (candidates.length === 0) {
    return [];
  }
  const downloaded: AttachedDocument[] = [];
  // Capped before anything is fetched: past the cap these are bytes nobody will
  // read, and each one may be 10MB through the bot token.
  for (const file of withinDocumentCount(candidates, warnings)) {
    const label = file.name ?? file.id ?? "attachment";
    if ((file.size ?? 0) > MAX_DOCUMENT_BYTES) {
      warnings.push(`Document is larger than 10MB (${label}).`);
      continue;
    }
    const url = file.url_private_download ?? file.url_private;
    if (!url) {
      warnings.push(`Attachment has no download url (${label}).`);
      continue;
    }
    try {
      const data = await deps.slack.downloadFile(token, url, MAX_DOCUMENT_BYTES);
      // Slack's declared size can be absent, so the download is bounded too; this
      // is the same limit restated where the bytes are finally in hand.
      if (data.byteLength > MAX_DOCUMENT_BYTES) {
        warnings.push(`Document is larger than 10MB (${label}).`);
        continue;
      }
      downloaded.push({ bytes: data, mimeType: file.mimetype ?? "", name: label });
    } catch (error) {
      log.error("slack", "document download failed", error);
      warnings.push(
        `Could not read attachment ${label}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  }
  return readDocumentsFor(deps.documents, downloaded, warnings);
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
  turns: ThreadTurn[],
  currentUser: string | undefined,
): Promise<{ caller?: RunCaller; nameByUser?: Map<string, string> }> {
  // The turns that survived the history slice, not every message in the thread:
  // resolving someone whose turn was already dropped buys a Slack round trip and
  // nothing else.
  const humans = new Set<string>();
  for (const turn of turns) {
    if (turn.userId) {
      humans.add(turn.userId);
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

/**
 * Run the agent project for one message and stream the reply.
 *
 * Whether this message was for the bot at all is already decided:
 * `classifySlackEvent` is the single owner of that, and it runs in the route
 * ahead of the dedup claim. Nothing here re-checks it — a second copy of the
 * loop guard is exactly the kind of drift the split is meant to prevent.
 */
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

  const message = (event.text ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
  const projectName = binding.projectName;
  const threadTs = event.thread_ts ?? event.ts;
  // A DM is an agent thread: it has a native status line and a title. A channel
  // mention has neither, and streaming into one needs the recipient named.
  const isAssistantThread = event.channel_type === "im";

  // Ahead of the project lookup, because a command is answered whether or not
  // this project has a runnable version — `!mute` in particular has to work on
  // a bot that is currently failing, which is exactly when someone reaches for
  // it.
  const command = parseSlackCommand(message);
  if (command) {
    await handleSlackCommand(deps, command, {
      projectName,
      botToken: token,
      channel: event.channel,
      threadTs,
      inThread: event.thread_ts !== undefined,
      assistantThread: isAssistantThread,
    });
    return;
  }

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

  // The newest turns, not the oldest: a long thread's most recent exchange is
  // what a follow-up is about, and dropping the head costs less than dropping
  // the question being answered.
  const rawTurns = threadToTurns(replies, event.ts, selfUserId(body)).slice(
    -MAX_THREAD_HISTORY_MESSAGES,
  );

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
  // Ahead of every lookup below. Profile resolution is several round trips on a
  // cold cache, and making the user wait for them before anything acknowledges
  // the message is the one thing the status line exists to prevent.
  //
  // The reaction goes first because it is the cheaper of the two and it lands
  // where the person is already looking. A DM gets none: every message there is
  // for the bot, and the thread's own status line says it was picked up.
  if (!isAssistantThread) {
    await deps.slack
      .addReaction(token, { channel: event.channel, ts: event.ts, name: PICKED_UP_REACTION })
      // Never fatal, and not even a warning in the reply: the run is about to
      // answer, which is a louder acknowledgement than the one that failed.
      .catch((error) => log.error("slack", "pickup reaction failed", error));
  }
  await sink.status(THINKING_MESSAGES[0] ?? "is thinking…", THINKING_MESSAGES);

  // The version's opt-in gates the *lookup*, not just the prompt: a project that
  // did not ask to know who is asking should not be sending anyone's id to
  // Slack's profile API either.
  const named = version.parameters.callerContext
    ? await resolveSpeakers(deps, token, rawTurns, event.user)
    : { caller: undefined, nameByUser: undefined };
  const turns = withSpeakerLabels(rawTurns, named.nameByUser);
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
  // Documents a tool rendered. Not uploaded like the images below them: their
  // bytes were stripped at the bracket the moment they were stored, so a thread
  // gets a link. Without this the run answered "here is the report" into a
  // thread with no report in it.
  //
  // References while the run goes, addresses after it: a link signed as the
  // chunk passed would start expiring minutes before the reply carrying it was
  // posted, and a run is allowed to last ten of them.
  const producedRefs: ProducedFileRef[] = [];
  // Enforced by an abort signal so a run that stops producing chunks entirely
  // (hung provider or tool) still ends and reports a timeout instead of
  // leaving the status up forever.
  const deadline = AbortSignal.timeout(INTERACTIVE_RUN_TIMEOUT_MS);
  const attached = event.files ?? [];
  const imageParts = attached.length > 0 ? await collectImageParts(deps, token, attached, warnings) : [];
  const readDocuments =
    attached.length > 0 ? await collectDocuments(deps, token, attached, warnings) : [];
  // Labelled on the same terms as the history: leaving the newest turn bare
  // while every older one is named invites the model to attribute the question
  // to whoever spoke last.
  const currentSpeaker = event.user ? named.nameByUser?.get(event.user) : undefined;
  const askText = currentSpeaker && message ? `${currentSpeaker}: ${message}` : message;
  // Assembled by the one function that owns a turn's body, so Slack and a chat
  // put the same message in front of the model.
  const userContent: string | ContentPart[] = turnContent(readDocuments, askText, imageParts);
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
    // Nothing survived to ask about. A file-only message whose every attachment
    // failed — a scanned PDF is the ordinary case — would otherwise dispatch a
    // user turn with empty content, which providers reject or answer with
    // whatever an empty prompt evokes. The warnings already say what happened
    // and they are the whole answer, so the reply is those alone.
    if (typeof userContent === "string" && userContent === "") {
      throw new EmptyTurnError();
    }
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
      // A binding the run could not use. It rides out with the answer rather
      // than replacing it — the run still produced one. `collectedWarning`
      // owns which ones count.
      const warning = collectedWarning(chunk, warnings);
      if (warning) {
        warnings.push(warning);
      }
      // Tool activity is reported as steps rather than in the answer: a
      // tool-heavy first turn shows what is happening without spending the
      // message body on it, and where the surface renders a checklist the steps
      // accumulate into one.
      //
      // Every tool the chunk announced, not just the first: a model that fans
      // out calls in one response puts them side by side in this array, and
      // reading index 0 alone reported one of them and hid the rest.
      //
      // A subagent's calls are listed too, named by the agent that made them —
      // the checklist is what the run is doing, and a hand-off's work is still
      // the run's work.
      for (const call of chunk.delta?.toolCalls ?? []) {
        const name = call.function?.name;
        // Arguments stream in after the name, so a later delta for the same
        // call carries neither and is not a step of its own.
        if (call.id && name) {
          await sink.step(call.id, chunk.author ? `${chunk.author}: ${name}` : name, {
            nested: !isTopLevelChunk(chunk),
          });
        }
      }
      // The one real completion boundary a run has. Nothing else may tick a
      // step off: a status changing means the run stopped saying something, not
      // that it finished it.
      if (chunk.toolResult) {
        await sink.stepDone(
          chunk.toolResult.toolCallId,
          // The result names what the call acted on — the skill it loaded, the
          // server an MCP tool came from — which the call's own name never does.
          chunk.author ? `${chunk.author}: ${chunk.toolResult.name}` : chunk.toolResult.name,
        );
      }
      if (chunk.image) {
        images.push(chunk.image);
      }
      if (chunk.file) {
        producedRefs.push(fileRefOf(chunk.file));
      }
      const content = chunk.delta?.content;
      if (content && isTopLevelChunk(chunk)) {
        text += content;
        await sink.push(text);
      }
    }
  } catch (error) {
    if (!(error instanceof EmptyTurnError)) {
      warnings.push(
        deadline.aborted
          ? "Agent run timed out"
          : error instanceof Error
            ? error.message
            : "agent run failed",
      );
    }
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
  // Signed here, one step before the message goes out, and for a window that
  // suits a record rather than an open page: a thread is read minutes later by
  // the person who asked and days later by whoever searches the channel.
  const produced = await resolveProducedFiles(
    producedRefs,
    deps.signFile,
    RECORD_URL_TTL_SECONDS,
  );
  for (const warning of produced.warnings) {
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }
  // Only this scope knows whether *anything* reached the thread — the sink sees
  // the text and not the uploaded images, which is how a run that answered
  // purely with a picture used to be captioned "(no response)". A produced file
  // counts for the same reason: it is the deliverable, and the link below is the
  // only place the thread carries it.
  if (!text && images.length === 0 && producedRefs.length === 0 && warnings.length === 0) {
    warnings.push("The run finished without producing an answer.");
  }
  // Links first, warnings after: one is what the run made and the other is what
  // it lost, and a reader scanning the end of a reply should meet them in that
  // order.
  const suffix = [
    ...produced.files.map((file) => `:paperclip: <${file.url}|${mrkdwnText(file.name)}>`),
    ...warnings.map((warning) => `:warning: ${warning}`),
  ].join("\n");
  await sink.finish(text, suffix);

  // The bot has now spoken here, so the next message in this thread is a
  // follow-up rather than channel noise — recorded after the reply, because
  // that is what makes it true. A DM needs no record: every message in one is
  // addressed to the bot already.
  //
  // Recorded even when the reply was only warnings. That is still the bot
  // holding the floor, and "it failed — try without the attachment" is exactly
  // the turn someone answers without stopping to re-address it.
  if (!isAssistantThread) {
    await deps.threads
      .markEngaged(projectName, event.channel, threadTs)
      // A lost record costs the next follow-up its mention-free reply. Not
      // worth failing a run that already answered.
      .catch((error) => log.error("slack", "thread engagement could not be recorded", error));
  }
}
