import type { Project } from "@/domain/project/types";
import type { SlackMessage } from "@/domain/slack/types";
import { slackConversation } from "@/domain/slack/conversation";
import { slackMessageText } from "@/domain/slack/messageText";
import { isProjectPrivate } from "@/domain/project/access";
import { userMayAccessProject } from "@/application/project/projectUseCases";
import { createReplySink, type ReplyTarget } from "@/application/slack/replyStream";
import { parseSlackCommand, selfUserId } from "@/application/slack/engagement";
import { handleSlackCommand } from "@/application/slack/handleCommand";
import { handleTurn } from "@/application/messaging/handleTurn";
import type { SlackEventBody, SlackEventDeps, SlackEventFile } from "@/application/slack/types";
import type { RunCaller } from "@/domain/execution/actor";
import type { HistoryTurn, InboundAttachment } from "@/domain/messaging/inbound";
import type { ReplyChannel } from "@/domain/messaging/reply";
import type { ChatMessageInput } from "@/domain/llm/types";
import { MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS } from "@/domain/slack/reader";
import { log } from "@/shared/logger";
import { mapWithLimit } from "@/shared/mapWithLimit";
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

/** One thread turn: the mapped engine message plus the attachments it carried. */
export interface ThreadTurn {
  message: ChatMessageInput;
  files: SlackEventFile[];
  /** The human who wrote it, when one did. Absent on the bot's own turns. */
  userId?: string;
  /**
   * The app that wrote it, when another app did — its display name, as the
   * message was signed. Absent on a person's turn and on the bot's own.
   */
  appName?: string;
}

/** How an app signed a message, when it did: `username` first, then its bot profile. */
function appNameOf(message: Pick<SlackMessage, "username" | "bot_profile">): string | undefined {
  for (const name of [message.username, message.bot_profile?.name]) {
    const trimmed = name?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
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
 * everyone else — humans and **other apps alike** — → user. A message with no
 * text is kept when it carried files — an image posted on its own is still part
 * of the conversation.
 *
 * Another app's message is context, not ours. `bot_id` alone says "an app wrote
 * this", not "we wrote this", so a thread the bot shares with a CI notifier or
 * an alerting app once had that app's messages arriving as *our* assistant
 * turns — the model was shown a deploy bot's output as words it had said itself,
 * and answered follow-ups as though it had. Told apart by our own user id, such
 * a message is what a person is asking about (the alert the thread hangs under,
 * the build result being discussed) and reads as a user turn signed with the
 * app's name — never as something this bot said, and never dropped, since a
 * follow-up under an alert is a question about the alert.
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
    .map((m) => ({ m, text: slackMessageText(m).replace(/<@[A-Z0-9]+>/g, "").trim() }))
    .filter(({ m, text }) => m.ts !== currentTs && (text !== "" || (m.files ?? []).length > 0))
    .map(({ m, text }) => {
      const ours = isOurs(m);
      const appName = !ours && m.bot_id ? appNameOf(m) : undefined;
      return {
        message: { role: ours ? ("assistant" as const) : ("user" as const), content: text },
        files: m.files ?? [],
        ...(m.bot_id || !m.user ? {} : { userId: m.user }),
        ...(appName ? { appName } : {}),
      };
    });
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
  return turns.map((turn) => {
    // An app's turn is always signed: its name came with the message, and
    // without it an alert reads as something the person asking had typed.
    const speaker = turn.appName ?? (turn.userId ? nameByUser?.get(turn.userId) : undefined);
    const text = typeof turn.message.content === "string" ? turn.message.content : "";
    if (!speaker || !text) {
      return turn;
    }
    return { ...turn, message: { ...turn.message, content: `${speaker}: ${text}` } };
  });
}

/**
 * A Slack file as the shared pipeline reads one: its name for the warnings,
 * its declared type and size, and a download bound to this bot's token — or
 * none, when Slack handed no address, which the pipeline reports as such.
 */
function toAttachment(deps: SlackEventDeps, token: string, file: SlackEventFile): InboundAttachment {
  const url = file.url_private_download ?? file.url_private;
  return {
    name: file.name ?? file.id ?? "attachment",
    mimeType: file.mimetype ?? "",
    ...(file.size !== undefined ? { size: file.size } : {}),
    ...(url ? { download: (maxBytes: number) => deps.slack.downloadFile(token, url, maxBytes) } : {}),
  };
}

/** A thread turn as the shared pipeline reads one, its files wrapped for download. */
function toHistoryTurn(deps: SlackEventDeps, token: string, turn: ThreadTurn): HistoryTurn {
  return {
    message: turn.message,
    attachments: turn.files.map((file) => toAttachment(deps, token, file)),
    ...(turn.userId ? { userId: turn.userId } : {}),
  };
}

/**
 * The reply as the shared pipeline delivers one: the streamed sink, plus what
 * a Slack thread does with the rest — a standalone post, an upload per picture,
 * and the mrkdwn a file link and a warning line are spelled in.
 */
function slackReplyChannel(
  deps: SlackEventDeps,
  token: string,
  target: ReplyTarget,
): ReplyChannel {
  return {
    ...createReplySink(deps.slack, token, target, deps.loadingIndicator),
    async say(text) {
      await deps.slack.postMessage(token, {
        channel: target.channel,
        thread_ts: target.threadTs,
        text,
      });
    },
    async sendImage(image, index) {
      const ext = image.mimeType === "image/png" ? "png" : "jpg";
      await deps.slack.uploadImage(token, {
        channel: target.channel,
        threadTs: target.threadTs,
        filename: `generated-${Date.now()}-${index + 1}.${ext}`,
        data: Buffer.from(image.b64, "base64"),
        title: image.prompt?.slice(0, 80) ?? "Generated image",
      });
    },
    fileLink: (file) => `:paperclip: <${file.url}|${mrkdwnText(file.name)}>`,
    warningLine: (warning) => `:warning: ${warning}`,
  };
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
  const resolved = await mapWithLimit(
    wanted,
    MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS,
    async (userId) => [userId, await deps.slack.userProfile(token, userId)] as const,
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

/** The one refusal a private project's bot gives, on every path that refuses. */
export const privateProjectRefusal = (projectName: string): string =>
  `Sorry — project "${projectName}" is private. Ask its owner to invite you.`;

/**
 * May the sender of this Slack event act on the project? The gate for every
 * path a Slack event can take — the run, the `!mute` commands, the
 * thread-start greeting — so no path answers someone another path refuses.
 *
 * A Slack id maps to a member by email, the one identity both sides share, so
 * a workspace that shares no address is refused the same way an uninvited
 * member is: an unidentifiable person is not an invited one. An app's message
 * (`botId`, no user) passes instead — the keyword that woke the bot is the
 * owner's own configuration, so an alert's message is owner-wired automation
 * like a trigger, and there is no person to identify; refusing it would post
 * a refusal into the alert thread on every firing while the run the owner
 * configured never executes. The lookup is the cached `users.info` read the
 * gallery attribution shares, and the address never reaches a prompt.
 */
export async function slackSenderMayAccess(
  deps: Pick<SlackEventDeps, "slack">,
  token: string,
  project: Project,
  sender: { user?: string; botId?: string },
): Promise<boolean> {
  if (!isProjectPrivate(project)) {
    return true;
  }
  if (!sender.user) {
    return Boolean(sender.botId);
  }
  const email = await deps.slack.userEmail(token, sender.user).catch((error) => {
    log.warn("slack", "sender email lookup failed for a private project", error);
    return null;
  });
  return email !== null && (await userMayAccessProject(project, email));
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

  // Everything the message says: an app's alert keeps its body in an
  // attachment, and `text` alone would hand the run the headline.
  const message = slackMessageText(event).replace(/<@[A-Z0-9]+>/g, "").trim();
  const projectName = binding.projectName;
  const threadTs = event.thread_ts ?? event.ts;
  // A DM is an agent thread: it has a native status line and a title. A channel
  // mention has neither, and streaming into one needs the recipient named.
  const isAssistantThread = event.channel_type === "im";

  // Ahead of the current-settings lookup, because a command is answered whether or
  // not this project has current Agent settings — `!mute` in particular has to
  // work on a bot that is currently failing, which is exactly when someone
  // reaches for it. Not ahead of the visibility gate: a command writes the
  // project's engagement state, so an uninvited user muting a private
  // project's thread would be exactly the acted-on message the gate exists to
  // prevent. A project repository failure must not erase that gate: only a
  // successful lookup may distinguish a public or missing project.
  const command = parseSlackCommand(message);
  if (command) {
    const commandProject = await deps.projects.get(projectName);
    if (
      commandProject &&
      !(await slackSenderMayAccess(deps, token, commandProject, {
        ...(event.user ? { user: event.user } : {}),
        ...(event.bot_id ? { botId: event.bot_id } : {}),
      }))
    ) {
      await deps.slack.postMessage(token, {
        channel: event.channel,
        thread_ts: threadTs,
        text: privateProjectRefusal(projectName),
      });
      return;
    }
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
  // Pin current settings alongside the Project for this messaging turn.
  const configuration = project ? project.configuration : null;
  const target: ReplyTarget = {
    channel: event.channel,
    threadTs,
    assistantThread: isAssistantThread,
    ...(!isAssistantThread && event.user && body.team_id
      ? { recipient: { userId: event.user, teamId: body.team_id } }
      : {}),
  };
  const reply = slackReplyChannel(deps, token, target);
  if (!project || !configuration) {
    await reply.say(
      `Agent project not available: ${projectName} (must exist and have current Agent settings)`,
    );
    return;
  }

  // The visibility gate, ahead of any acknowledgement — no reaction, no status
  // line, no thread read happens for someone the project keeps out. What
  // passes and why is {@link slackSenderMayAccess}'s.
  if (
    !(await slackSenderMayAccess(deps, token, project, {
      ...(event.user ? { user: event.user } : {}),
      ...(event.bot_id ? { botId: event.bot_id } : {}),
    }))
  ) {
    await reply.say(privateProjectRefusal(projectName));
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
  await reply.status(THINKING_MESSAGES[0] ?? "is thinking…", THINKING_MESSAGES);

  // The Agent's opt-in gates the *lookup*, not just the prompt: a project that
  // did not ask to know who is asking should not be sending anyone's id to
  // Slack's profile API either.
  const named = configuration.parameters.callerContext
    ? await resolveSpeakers(deps, token, rawTurns, event.user)
    : { caller: undefined, nameByUser: undefined };
  // Whose gallery this run's output belongs in. Not gated on `callerContext`,
  // which decides what the *model* is told: this address reaches no prompt and
  // no tool result, and a person's own pictures going missing from their own
  // gallery is not something an Agent parameter should be able to cause.
  //
  // Best effort in both directions — a workspace that does not share addresses,
  // or a bot without the scope, files by project exactly as before.
  const ownerEmail = event.user
    ? await deps.slack
        .userEmail(token, event.user)
        .catch((error) => {
          log.warn("slack", "owner lookup failed; filing by project alone", error);
          return null;
        })
    : null;
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

  // Labelled on the same terms as the history: leaving the newest turn bare
  // while every older one is named invites the model to attribute the question
  // to whoever spoke last.
  // An app that woke the bot — a keyword in an alert, a workflow's mention — is
  // named the way its thread turns are, so the model knows an alerting app
  // said this and not a person.
  const currentSpeaker = event.user
    ? named.nameByUser?.get(event.user)
    : event.bot_id
      ? appNameOf(event)
      : undefined;
  const askText = currentSpeaker && message ? `${currentSpeaker}: ${message}` : message;

  // From here the turn is the same as any other chat bot's: attachments,
  // the run, and what the reply carries beside the answer are the shared
  // pipeline's, and only the thread's own bookkeeping below is Slack's.
  await handleTurn(
    deps,
    {
      project,
      configuration,
      text: askText,
      attachments: (event.files ?? []).map((file) => toAttachment(deps, token, file)),
      history: turns.map((turn) => toHistoryTurn(deps, token, turn)),
      // The Slack user id, not an email: Slack does not hand one over, and
      // guessing at a mapping would attribute spend to the wrong person.
      ...(event.user ? { actor: { kind: "slack" as const, id: event.user } } : {}),
      ...(named.caller ? { caller: named.caller } : {}),
      // The thread is the conversation — the same address the engagement row and
      // the reply itself use, so a follow-up here is one for every consumer.
      conversation: slackConversation(event.channel, threadTs),
      ...(ownerEmail ? { ownerEmail } : {}),
      warnings,
    },
    reply,
  );

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
