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
