import type { SlackEventBody } from "@/application/slack/types";
import { slackInputText, slackMessageText } from "@/domain/slack/messageText";
import { slackTimestampValue } from "@/domain/slack/runControl";

/**
 * Which delivered Slack events cause a run — the single owner of that decision.
 *
 * The bot is subscribed to `message.channels` and `message.groups`, so it now
 * receives every message in every channel it was invited to, not just the ones
 * that name it. Most of those are none of its business, and deciding that has
 * to be **cheap and early**: the route classifies before it claims the event id,
 * so a message nobody asked about costs a signature check and nothing else — no
 * database write, no run, and no reply message that would have to be taken back.
 *
 * That ordering is also what answers "a run that decides not to answer". A
 * channel run opens its reply as a progress note the moment it starts, so a
 * decision made *inside* the run could only ever retract something already on
 * screen. Made here it is not a run at all, and there is nothing to retract.
 *
 * The funnel, in order:
 *
 * 1. the bot's own message — first, because everything below can start a run
 *    and a run that answers its own reply never stops;
 * 2. an `app_mention` — always answered, whatever else is configured;
 * 3. a DM — every message in one is addressed to the bot;
 * 4. a thread the bot already answered in, inside {@link isEngaged}'s window;
 * 5. a keyword the project asked to be woken by;
 * 6. otherwise nothing.
 *
 * Only step 4 needs storage, and only a *threaded* message reaches it — ordinary
 * channel chatter carries no `thread_ts` and is dropped by 6 without a read.
 *
 * **Another app's message is a message.** An alerting app posting `[FIRING:1]`
 * into a channel is the very thing a keyword is registered for, and a workflow
 * that @-mentions the bot is asking it something. So an app's message passes
 * steps 2 and 5 like a person's — but not 3 or 4: a follow-up an app posts into
 * a thread this bot is engaged in is not answered, because two bots engaged in
 * one thread would otherwise answer each other without end, and the thread
 * history already reads such messages as context rather than as turns to
 * respond to. Only the bot's *own* messages are refused outright, told apart by
 * the app's user id rather than by `bot_id`, which every app's message carries.
 */

/**
 * Message subtypes still worth handling. Subtyped messages are mostly channel
 * bookkeeping (joins, edits, …), but a user's file upload arrives as
 * `file_share` and dropping it would leave the mention unanswered — and a
 * message an app posts without a bot user (an incoming webhook, an alerting
 * app's contact point) arrives as `bot_message`, which is what a keyword is
 * most often registered to catch.
 */
const ALLOWED_SUBTYPES = new Set(["file_share", "bot_message"]);

/** What the project asked to be woken by, beyond a mention. */
export interface EngagementPolicy {
  /**
   * Words that make an un-mentioned channel message a question for this bot.
   * Empty means only mentions and follow-ups in threads it already answered.
   */
  keywords?: readonly string[];
}

export type SlackEventDisposition =
  /** Answer it. `trigger` is why, and is what the logs and tests read. */
  | { kind: "run"; trigger: "mention" | "dm" | "thread" | "keyword" }
  /** Greet rather than answer: someone opened the agent. */
  | { kind: "threadStart" }
  | { kind: "stop" }
  /**
   * A channel thread's follow-up, if the bot is still engaged in that thread.
   * The only branch that needs a lookup, so it is returned rather than decided
   * — this function stays free of I/O and the route spends the read.
   */
  | { kind: "engagedThread"; channel: string; threadTs: string }
  /** Nothing to do. `because` is for tests and diagnosis, not for a reply. */
  | { kind: "ignore"; because: string };

const ignore = (because: string): SlackEventDisposition => ({ kind: "ignore", because });

/** Validate the native control event before either admitting it or changing run state. */
export function slackStopEvent(body: SlackEventBody) {
  const event = body.event;
  if (event?.type !== "agent_session_stopped" || event.bot_id ||
      typeof event.channel !== "string" || !event.channel ||
      typeof event.user !== "string" || !event.user ||
      typeof event.thread_ts !== "string" || slackTimestampValue(event.thread_ts) === null ||
      typeof event.event_ts !== "string" || slackTimestampValue(event.event_ts) === null) {
    return null;
  }
  return { channel: event.channel, userId: event.user, threadTs: event.thread_ts, eventTs: event.event_ts };
}

/**
 * Whether this event is the bot talking to itself.
 *
 * The app's own user id is what decides it, not `bot_id`: every app's message
 * carries a `bot_id` — an alerting app's, a CI notifier's — and reading it as
 * "ours" is how the bot stayed silent on the very messages a keyword was
 * registered for. Everything this bot posts is attributed to its bot user,
 * including a file shared through the external upload flow (which arrives as an
 * allowed `file_share` subtype), so the user id covers every shape of its own
 * message. With `message.channels` subscribed this is the loop guard: the bot's
 * own reply lands in a thread the bot is engaged in, which is the one shape that
 * would otherwise answer itself forever.
 *
 * `authorizations` is part of every modern `event_callback` envelope. A payload
 * without one falls back to `bot_id` alone — the rule from before the field
 * existed — because with no way to tell its own messages from another app's,
 * staying silent on an app is the cheaper mistake.
 */
function isOwnMessage(body: SlackEventBody): boolean {
  const event = body.event;
  const self = selfUserId(body);
  if (self) {
    return event?.user === self;
  }
  return Boolean(event?.bot_id);
}

/**
 * Our app's own user id in this workspace, as the event envelope reports it.
 *
 * Exported because the answer is needed twice for two different questions —
 * "did we write this event" (above) and "which of a thread's messages are
 * ours" (`threadToTurns`) — and the *extraction* is the same one either way.
 * A second reader spelling it out again is how one of them would end up
 * reading a field the other had moved on from.
 *
 * Undefined when the envelope carries no authorization, which each caller
 * degrades from differently: the loop guard falls back to `bot_id`, the thread
 * mapping keeps its old rule rather than discarding the history.
 */
export function selfUserId(body: SlackEventBody): string | undefined {
  return body.authorizations?.find((auth) => auth.user_id)?.user_id;
}

/**
 * Whether the message names this bot.
 *
 * Slack delivers a channel mention **twice** — once as `app_mention` and once
 * as the `message.channels` the same text produces — and the two carry
 * different event ids, so the dedup claim does not see them as one. Without
 * this every mention in an engaged thread would be answered twice.
 *
 * `app_mention` is the canonical delivery, so it is the `message` copy that is
 * dropped.
 */
function mentionsSelf(body: SlackEventBody): boolean {
  const self = selfUserId(body);
  return Boolean(self && (body.event?.text ?? "").includes(`<@${self}>`));
}

/**
 * Case-insensitive substring match.
 *
 * Substring rather than a word boundary because the console is used in Korean,
 * which glues particles onto nouns — a `배포` keyword has to match `배포는`, and
 * a word-boundary rule would never fire. The cost is over-matching in English
 * (`ci` matches `specific`), which is visible immediately and is the operator's
 * to fix: they chose the word.
 */
function matchesKeyword(text: string, keywords: readonly string[] | undefined): boolean {
  if (!keywords || keywords.length === 0 || !text) {
    return false;
  }
  const haystack = text.toLowerCase();
  return keywords.some((keyword) => keyword !== "" && haystack.includes(keyword.toLowerCase()));
}

/**
 * A fixed action, rather than a question for the agent.
 *
 * Bang-prefixed and standing alone: `@bot !mute` is the command, `@bot !mute
 * this thread please` is an ordinary request that happens to contain the word.
 * The rule is strict on purpose — a command changes whether the bot speaks
 * again, and guessing at that from a sentence is how it stops answering
 * somebody who never asked it to.
 */
export type SlackCommand = "help" | "mute" | "unmute" | "stop";

const COMMANDS = new Set<SlackCommand>(["help", "mute", "unmute", "stop"]);

/**
 * The command a message *is*, or null for one that merely mentions a word.
 * `text` is the message with its mentions already stripped.
 */
export function parseSlackCommand(text: string): SlackCommand | null {
  const word = text.trim();
  if (!word.startsWith("!")) {
    return null;
  }
  const name = word.slice(1).toLowerCase();
  return COMMANDS.has(name as SlackCommand) ? (name as SlackCommand) : null;
}

/**
 * What one delivered event should cause. Pure — the route spends any I/O the
 * answer calls for.
 */
export function classifySlackEvent(
  body: SlackEventBody,
  policy: EngagementPolicy = {},
): SlackEventDisposition {
  if (body.type !== "event_callback") {
    return ignore("not an event callback");
  }
  const event = body.event;
  if (!event?.type) {
    return ignore("no event type");
  }
  if (event.type === "agent_session_stopped") {
    return slackStopEvent(body) ? { kind: "stop" } : ignore("invalid stop event");
  }

  // A user opening the agent. The agent messaging experience announces it with
  // `app_home_opened` on the Messages tab (the Home tab is a different surface
  // and is not ours); the legacy assistant view uses `assistant_thread_started`.
  // Both are answered with prompts rather than a run, and neither is a message,
  // so they are decided before the message gates below.
  if (
    (event.type === "app_home_opened" && event.tab === "messages") ||
    event.type === "assistant_thread_started"
  ) {
    return { kind: "threadStart" };
  }

  if (event.type !== "app_mention" && event.type !== "message") {
    return ignore(`unhandled event type ${event.type}`);
  }

  // Ahead of every branch that can start a run.
  if (isOwnMessage(body)) {
    return ignore("the bot's own message");
  }
  if (event.subtype && !ALLOWED_SUBTYPES.has(event.subtype)) {
    return ignore(`unhandled subtype ${event.subtype}`);
  }

  if (event.type === "app_mention") {
    return { kind: "run", trigger: "mention" };
  }

  // Not ours (decided above), so another app's. It may name the bot or carry a
  // keyword like anyone else; it is not a DM correspondent, and its thread
  // replies are not followed up (see the funnel note above).
  const fromAnotherApp = Boolean(event.bot_id);

  // Every message in a DM is addressed to the bot, mention or not.
  if (event.channel_type === "im") {
    return fromAnotherApp ? ignore("another app's message in a DM") : { kind: "run", trigger: "dm" };
  }

  // A channel mention arrived as `app_mention` too; that copy is the one that
  // runs. Deliberately not applied to a DM: whether `app_mention` also fires
  // there is not something this depends on, and a DM's behaviour is unchanged.
  if (mentionsSelf(body)) {
    return ignore("already delivered as app_mention");
  }
  if (!event.channel || !event.ts) {
    return ignore("no channel or timestamp");
  }
  // A follow-up in a thread the bot may still be part of. Only a *reply* can be
  // one, so ordinary channel traffic never reaches the lookup.
  if (event.thread_ts) {
    // A first run has not written engagement yet, but the user must still be able to stop it.
    if (!fromAnotherApp && event.user && parseSlackCommand(slackInputText(event, selfUserId(body))) === "stop") {
      return { kind: "run", trigger: "thread" };
    }
    return fromAnotherApp
      ? ignore("another app's thread reply")
      : { kind: "engagedThread", channel: event.channel, threadTs: event.thread_ts };
  }
  // Everything the message says, not `text` alone: an alerting app keeps the
  // title and body in an attachment, and `[FIRING:1]` is registered to be found
  // there.
  if (matchesKeyword(slackMessageText(event), policy.keywords)) {
    return { kind: "run", trigger: "keyword" };
  }
  return ignore("not addressed to the bot");
}
