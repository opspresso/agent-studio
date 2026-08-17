/**
 * One chip offered when a user opens the agent. `title` is the label on the
 * chip; `message` is what gets sent as the user's turn when it is clicked.
 */
export interface SlackSuggestedPrompt {
  title: string;
  message: string;
}

/** Slack accepts at most four suggested prompts; a fifth is rejected. */
export const MAX_SUGGESTED_PROMPTS = 4;
/** Per-field cap. Slack does not document one; these keep a chip readable. */
export const MAX_PROMPT_TITLE_LENGTH = 80;
export const MAX_PROMPT_MESSAGE_LENGTH = 500;
/** Slack's cap on the agent overview shown above the Messages tab. */
export const MAX_AGENT_DESCRIPTION_LENGTH = 300;

/**
 * Caps on the words a project may be woken by in a channel.
 *
 * Ours rather than Slack's, and low on purpose: every keyword is matched
 * against every message in every channel the bot belongs to, and a list long
 * enough to need scrolling is one nobody can predict the behaviour of. A
 * keyword short enough to appear inside ordinary words wakes the bot constantly,
 * which is why there is a floor as well as a ceiling.
 */
export const MAX_CHANNEL_KEYWORDS = 20;
export const MIN_KEYWORD_LENGTH = 2;
export const MAX_KEYWORD_LENGTH = 50;

/**
 * What a Slack message *says*, as both the Events API and the Web API spell it
 * — the fields {@link slackMessageText} reads. An app's message often carries
 * its content in `attachments` or `blocks` with only a fallback (or nothing)
 * in `text`: an alert's title and body, a CI result's fields.
 */
export interface SlackMessageContent {
  text?: string;
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

/** A legacy attachment, narrowed to its readable parts. */
export interface SlackAttachment {
  pretext?: string;
  title?: string;
  text?: string;
  fallback?: string;
  fields?: Array<{ title?: string; value?: string }>;
}

/**
 * A Block Kit block, narrowed to the kinds that carry prose. Anything else
 * (images, dividers, actions, rich text — which Slack mirrors into `text`) is
 * skipped by type.
 */
export interface SlackBlock {
  type?: string;
  text?: { text?: string };
  fields?: Array<{ text?: string }>;
  elements?: Array<{ type?: string; text?: string }>;
}

/** A Slack message as the Web API returns it, narrowed to what a run reads. */
export interface SlackMessage extends SlackMessageContent {
  ts: string;
  user?: string;
  bot_id?: string;
  /** How an app's message is signed — the app's display name, when it set one. */
  username?: string;
  bot_profile?: { name?: string };
  /** Attachments on a thread message; present when the bot has files:read. */
  files?: Array<{
    id?: string;
    name?: string;
    mimetype?: string;
    size?: number;
    url_private_download?: string;
    url_private?: string;
  }>;
}

/**
 * A conversation as `conversations.list` returns it, narrowed to what a run
 * reads. `id` is what every other Slack call takes; the name is only ever how a
 * person refers to it.
 */
export interface SlackChannelInfo {
  id: string;
  name: string;
  topic?: string;
  purpose?: string;
  isPrivate?: boolean;
  /** Whether this bot is in it — which decides whether its history is readable. */
  isMember?: boolean;
}

/**
 * A person, as `users.info` describes them — narrowed to what a run may see.
 *
 * **No email**, though `users:read.email` is granted. That is the rule
 * `callerFrom` already applies to the caller block, for the same reason: an
 * email identifies someone outside Slack, and no answer needs one to be written
 * well. Everything here is visible to anyone in the workspace who clicks a
 * profile.
 *
 * Every field but `id` and `displayName` is optional because Slack fills almost
 * none of them reliably — its own reference warns a field "may not be present at
 * all, may be null or may contain the empty string".
 */
export interface SlackUserDetail {
  id: string;
  displayName: string;
  realName?: string;
  /** What they do, as they wrote it — "Staff Engineer, Platform". */
  title?: string;
  timezone?: string;
  /** Their status line, which is where "OOO until Friday" lives. */
  statusText?: string;
  statusEmoji?: string;
  avatarUrl?: string;
  isBot?: boolean;
  /** Deactivated. Worth saying out loud: an unanswered mention often is this. */
  deactivated?: boolean;
}

/** One emoji on one message, and who put it there. */
export interface SlackReaction {
  name: string;
  count: number;
  /** Slack user ids. `full: true` on the request keeps a long list from being cut. */
  users: string[];
}

/**
 * How Slack lays out the tasks a streaming message reports: `timeline` shows
 * them one after another with their text, `plan` shows them together.
 */
export type SlackTaskDisplayMode = "timeline" | "plan";

/**
 * A piece of a streaming message.
 *
 * The reason this exists rather than `markdown_text` alone: a stream carries
 * **two independent axes**, and the answer is only one of them. `task_update`
 * is what a channel has instead of the agent container's status line — a step
 * with a lifecycle, rendered by Slack rather than written into the reply's own
 * text. Keeping them apart is what lets a run report progress *and* stream its
 * answer into the same message; a progress note written as text could only ever
 * be one or the other.
 *
 * Here rather than beside `SlackClientPort`, which is the layer rule rather
 * than a preference: the adapter names these on the wire, and infrastructure
 * may not reach into `application`. Spelled out rather than imported from
 * `@slack/types` for the mirror-image reason on the other side.
 */
export type SlackChunk =
  | { type: "markdown_text"; text: string }
  | {
      type: "task_update";
      /** Stable per step: sending the same id again updates that task in place. */
      id: string;
      title: string;
      status: "pending" | "in_progress" | "complete" | "error";
      details?: string;
      output?: string;
    }
  | { type: "plan_update"; title: string };
