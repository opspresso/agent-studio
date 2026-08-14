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

/** A Slack message as the Web API returns it, narrowed to what a run reads. */
export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
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
