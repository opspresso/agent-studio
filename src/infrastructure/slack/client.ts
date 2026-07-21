/** Minimal Slack Web API client over fetch — no SDK dependency. */

export interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
}

async function slackApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
  }
  return data;
}

export const slackClient = {
  postMessage(
    token: string,
    args: { channel: string; text: string; thread_ts?: string },
  ): Promise<{ ts: string; channel: string }> {
    return slackApi(token, "chat.postMessage", args);
  },
  updateMessage(
    token: string,
    args: { channel: string; ts: string; text: string },
  ): Promise<{ ts: string }> {
    return slackApi(token, "chat.update", args);
  },
  async threadReplies(
    token: string,
    args: { channel: string; ts: string; limit?: number },
  ): Promise<SlackMessage[]> {
    const data = await slackApi<{ messages?: SlackMessage[] }>(token, "conversations.replies", {
      channel: args.channel,
      ts: args.ts,
      limit: args.limit ?? 30,
    });
    return data.messages ?? [];
  },
};
