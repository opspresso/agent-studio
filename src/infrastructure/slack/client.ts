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
  authTest(token: string): Promise<{ team?: string; user?: string; bot_id?: string }> {
    return slackApi(token, "auth.test", {});
  },
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
    // Read-family Web API methods reject JSON bodies; use GET with query params.
    const params = new URLSearchParams({
      channel: args.channel,
      ts: args.ts,
      limit: String(args.limit ?? 30),
    });
    const res = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; error?: string; messages?: SlackMessage[] };
    if (!data.ok) {
      throw new Error(`Slack conversations.replies failed: ${data.error ?? res.status}`);
    }
    return data.messages ?? [];
  },
};
