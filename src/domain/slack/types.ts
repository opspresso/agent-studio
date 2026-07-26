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
