import type { TeamsActivity } from "@/application/teams/types";

/**
 * Which delivered Bot Framework activities cause a run — the single owner of
 * that decision, run in the route ahead of the dedup claim like Slack's and
 * Telegram's: an activity nobody addressed to the bot costs a token check and
 * nothing else.
 *
 * Teams does most of the deciding itself. A bot in a channel or a group chat
 * receives only the messages that @mention it (short of resource-specific
 * consent this platform does not ask for), and a personal chat sends it
 * everything. So the funnel is short:
 *
 * 1. **not a message** — a member joined, a reaction, an install — nothing;
 * 2. **the bot's own message** — nothing, because a run that answers itself
 *    never stops;
 * 3. **no sender id** — there is no actor to attribute the run to;
 * 4. **a personal chat** — every message in one is for the bot;
 * 5. **a channel or group message that mentions the bot** — answered, with
 *    the `<at>…</at>` span taken out of the text;
 * 6. otherwise nothing.
 */

export type TeamsActivityDisposition =
  /** Answer it. `text` is the message with the bot's own mention taken out. */
  | { kind: "run"; trigger: "personal" | "mention"; activity: TeamsActivity; text: string }
  /** Nothing to do. `because` is for tests and diagnosis, not for a reply. */
  | { kind: "ignore"; because: string };

/** Prefer the person-wide Entra id, falling back to the conversation sender id. */
export function teamsSenderId(activity: TeamsActivity): string | undefined {
  const aad = activity.from?.aadObjectId;
  if (typeof aad === "string" && aad.trim()) return aad.trim();
  const id = activity.from?.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

/** The mention spans naming this bot, as Teams marks them. */
function botMentions(activity: TeamsActivity): string[] {
  const botId = activity.recipient?.id;
  if (!botId) {
    return [];
  }
  return (activity.entities ?? [])
    .filter((entity) => entity.type === "mention" && entity.mentioned?.id === botId && entity.text)
    .map((entity) => entity.text as string);
}

/**
 * The text with this bot's own mention removed, wherever it sits, and nothing
 * else touched: a pasted code block keeps its line breaks. Teams marks the
 * mention as `<at>Name</at>` in the text and names the same span on the
 * entity, so the entity's spelling is what is removed — not any `<at>` the
 * person typed.
 */
export function stripBotMention(activity: TeamsActivity): string {
  let text = activity.text ?? "";
  for (const span of botMentions(activity)) {
    let at = text.indexOf(span);
    while (at !== -1) {
      let end = at + span.length;
      if (at > 0 && text[at - 1] === " " && text[end] === " ") {
        end += 1;
      }
      text = text.slice(0, at) + text.slice(end);
      at = text.indexOf(span);
    }
  }
  return text.trim();
}

/** Whether the message carries anything a run could read or, failing that, report. */
export function hasAttachment(activity: TeamsActivity): boolean {
  // Teams sends the message's own HTML rendering as a `text/html` attachment;
  // that is the text again, not something attached to it.
  return (activity.attachments ?? []).some((attachment) => attachment.contentType !== "text/html");
}

export function classifyTeamsActivity(activity: TeamsActivity): TeamsActivityDisposition {
  if (activity.type !== "message") {
    return { kind: "ignore", because: `a ${activity.type ?? "typeless"} activity is not a message` };
  }
  if (activity.from?.id && activity.recipient?.id && activity.from.id === activity.recipient.id) {
    return { kind: "ignore", because: "from the bot itself" };
  }
  if (!teamsSenderId(activity)) {
    return { kind: "ignore", because: "no sender to attribute the run to" };
  }
  if (!activity.conversation?.id || !activity.serviceUrl) {
    return { kind: "ignore", because: "no conversation to answer in" };
  }
  const text = stripBotMention(activity);
  if (!text && !hasAttachment(activity)) {
    return { kind: "ignore", because: "nothing to read" };
  }
  if ((activity.conversation.conversationType ?? "personal") === "personal") {
    return { kind: "run", trigger: "personal", activity, text };
  }
  if (botMentions(activity).length > 0) {
    return { kind: "run", trigger: "mention", activity, text };
  }
  return { kind: "ignore", because: "not addressed to the bot" };
}
