/** Minimal Slack Web API client over fetch — no SDK dependency. */

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

/** Per-page size for paginated reads; Slack's recommended maximum. */
const PAGE_SIZE = 200;
/**
 * Hosts a file download may target. The URL comes from an event payload, so it
 * is untrusted input: only Slack's own file hosts are fetched with the bot token.
 */
const FILE_HOSTS = new Set(["files.slack.com", "slack.com", "www.slack.com"]);
/** Page cap so a pathological thread cannot loop unbounded. */
const MAX_THREAD_PAGES = 10;

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
  /**
   * Upload an image via the external upload flow:
   * files.getUploadURLExternal (form) → POST bytes → files.completeUploadExternal.
   */
  async uploadImage(
    token: string,
    args: { channel: string; threadTs?: string; filename: string; data: Buffer; title?: string },
  ): Promise<void> {
    const params = new URLSearchParams({
      filename: args.filename,
      length: String(args.data.byteLength),
    });
    const urlRes = await fetch(`https://slack.com/api/files.getUploadURLExternal?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const urlData = (await urlRes.json()) as {
      ok: boolean;
      error?: string;
      upload_url?: string;
      file_id?: string;
    };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(`Slack getUploadURLExternal failed: ${urlData.error ?? urlRes.status}`);
    }
    const putRes = await fetch(urlData.upload_url, { method: "POST", body: args.data as never });
    if (!putRes.ok) {
      throw new Error(`Slack file upload failed: ${putRes.status}`);
    }
    await slackApi(token, "files.completeUploadExternal", {
      files: [{ id: urlData.file_id, title: args.title ?? args.filename }],
      channel_id: args.channel,
      ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
    });
  },
  /**
   * Download a file shared with the bot. Slack's `url_private*` links require the
   * bot token, so the host is verified before the token is attached — never send
   * credentials to a host named by an inbound payload.
   */
  async downloadFile(token: string, url: string): Promise<Buffer> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error(`Slack file url is not a URL: ${url}`);
    }
    if (!FILE_HOSTS.has(host)) {
      throw new Error(`Slack file url has an unexpected host: ${host}`);
    }
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Slack file download failed: ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  },
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
  /**
   * Every reply in a thread, oldest first. Slack paginates this endpoint and
   * returns pages oldest-first, so reading a single page drops the *newest*
   * messages — page through to the end instead (bounded by MAX_THREAD_PAGES).
   */
  async threadReplies(
    token: string,
    args: { channel: string; ts: string; limit?: number },
  ): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
      // Read-family Web API methods reject JSON bodies; use GET with query params.
      const params = new URLSearchParams({
        channel: args.channel,
        ts: args.ts,
        limit: String(args.limit ?? PAGE_SIZE),
      });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const res = await fetch(`https://slack.com/api/conversations.replies?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      };
      if (!data.ok) {
        throw new Error(`Slack conversations.replies failed: ${data.error ?? res.status}`);
      }
      messages.push(...(data.messages ?? []));
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!cursor) {
        return messages;
      }
    }
    console.warn(
      `[slack] thread ${args.ts} exceeds ${MAX_THREAD_PAGES} pages; newest replies were not read`,
    );
    return messages;
  },
};
