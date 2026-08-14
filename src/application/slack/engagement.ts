import type { SlackEventBody } from "@/application/slack/types";

/**
 * Which delivered Slack events cause a run — the single owner of that decision.
 *
 * The bot is subscribed to `message.channels` and `message.groups`, so it now
 * receives every message in every channel it was invited to, not just the ones
 * that name it. Most of those are none of its business, and deciding that has
 * to be **cheap and early**: the route classifies before it claims the event id,
 * so a message nobody asked about costs a signature check and nothing else — no
 * DynamoDB write, no run, and no reply message that would have to be taken back.
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
 */

/**
 * Message subtypes still worth handling. Subtyped messages are mostly channel
 * bookkeeping (joins, edits, …), but a user's file upload arrives as
 * `file_share` and dropping it would leave the mention unanswered.
 */
const ALLOWED_SUBTYPES = new Set(["file_share"]);

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
  /**
   * A channel thread's follow-up, if the bot is still engaged in that thread.
   * The only branch that needs a lookup, so it is returned rather than decided
   * — this function stays free of I/O and the route spends the read.
   */
  | { kind: "engagedThread"; channel: string; threadTs: string }
  /** Nothing to do. `because` is for tests and diagnosis, not for a reply. */
  | { kind: "ignore"; because: string };

const ignore = (because: string): SlackEventDisposition => ({ kind: "ignore", because });

/**
 * Whether this event is the bot talking to itself.
 *
 * `bot_id` is not enough on its own: a file the bot shares through the external
 * upload flow is attributed to the bot *user*, and `file_share` is an allowed
 * subtype — so the app's own user id is checked too. With `message.channels`
 * subscribed this is no longer a tidy-up but the loop guard: the bot's own
 * reply lands in a thread the bot is engaged in, which is the one shape that
 * would otherwise answer itself forever.
 *
 * `authorizations` is part of every modern `event_callback` envelope. A payload
 * without one falls back to `bot_id` alone, which is what this check was before
 * the field existed.
 */
function isOwnMessage(body: SlackEventBody): boolean {
  const event = body.event;
  if (event?.bot_id) {
    return true;
  }
  const self = selfUserId(body);
  return Boolean(self && event?.user === self);
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

  // Every message in a DM is addressed to the bot, mention or not.
  if (event.channel_type === "im") {
    return { kind: "run", trigger: "dm" };
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
    return { kind: "engagedThread", channel: event.channel, threadTs: event.thread_ts };
  }
  if (matchesKeyword(event.text ?? "", policy.keywords)) {
    return { kind: "run", trigger: "keyword" };
  }
  return ignore("not addressed to the bot");
}
