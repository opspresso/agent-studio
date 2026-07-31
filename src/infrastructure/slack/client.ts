/** Minimal Slack Web API client over fetch — no SDK dependency. */

import { callerFrom, type RunCaller } from "@/domain/execution/actor";
import type { SlackMessage } from "@/domain/slack/types";
import { log } from "@/shared/logger";
import { getCachedProfile, rememberProfile } from "./profileCache";
export type { SlackMessage };

/** The slice of `users.info`'s user object a caller is built from. */
interface SlackUserInfo {
  name?: string;
  real_name?: string;
  tz?: string;
  profile?: { display_name?: string; real_name?: string; image_512?: string };
}

/**
 * The first value that is actually there. Slack's own reference warns a field
 * "may not be present at all, may be null or may contain the empty string", and
 * `??` only handles the first two of those three.
 */
function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    if (value && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
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
  /**
   * Who a Slack user id is, cached per workspace.
   *
   * Slack documents every one of these fields as possibly absent, null *or the
   * empty string*, so each is read through `firstNonEmpty` rather than `??` —
   * an empty `display_name` is extremely common and `??` would keep it.
   *
   * Never throws: a name is a nicety and a missing one must not be the reason a
   * mention goes unanswered. A failure is cached briefly so a revoked scope does
   * not cost a round trip per message.
   */
  async userProfile(token: string, userId: string): Promise<RunCaller | null> {
    const cached = getCachedProfile(token, userId);
    if (cached) {
      return cached.value;
    }
    let resolved: RunCaller | null = null;
    try {
      // A read-family method: GET with query params, like conversations.replies.
      const params = new URLSearchParams({ user: userId });
      const res = await fetch(`https://slack.com/api/users.info?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as {
        ok: boolean;
        error?: string;
        user?: SlackUserInfo;
      };
      if (!data.ok || !data.user) {
        throw new Error(`Slack users.info failed: ${data.error ?? res.status}`);
      }
      const user = data.user;
      // `callerFrom` owns what is safe to hand a prompt; this only decides which
      // of Slack's several name fields is the one to offer it.
      resolved = callerFrom({
        displayName: firstNonEmpty(
          user.profile?.display_name,
          user.profile?.real_name,
          user.real_name,
          user.name,
        ),
        timezone: firstNonEmpty(user.tz),
        avatarUrl: firstNonEmpty(user.profile?.image_512),
      });
    } catch (error) {
      log.warn(
        "slack",
        `profile lookup failed for ${userId}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
      );
    }
    rememberProfile(token, userId, resolved);
    return resolved;
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
   * Open a streamed reply. Slack renders it as text arriving live rather than a
   * message being rewritten, and `chat.appendStream` costs a tenth of what a
   * `chat.update` loop does against the rate limit.
   *
   * `thread_ts` is required: a stream is always a reply to the request that
   * caused it. Streaming into a *channel* additionally needs the recipient, so
   * a channel mention passes `recipient_user_id`/`recipient_team_id`.
   */
  startStream(
    token: string,
    args: {
      channel: string;
      thread_ts: string;
      recipient_user_id?: string;
      recipient_team_id?: string;
    },
  ): Promise<{ ts: string; channel: string }> {
    return slackApi(token, "chat.startStream", args);
  },
  /**
   * Append to an open stream. `markdown_text` is a *delta*, not the accumulated
   * answer — sending the whole text each time would repeat it on screen.
   */
  appendStream(
    token: string,
    args: { channel: string; ts: string; markdown_text: string },
  ): Promise<void> {
    return slackApi(token, "chat.appendStream", args).then(() => undefined);
  },
  /** Close an open stream, optionally with one last delta. */
  stopStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string },
  ): Promise<void> {
    return slackApi(token, "chat.stopStream", args).then(() => undefined);
  },
  /**
   * The native "<App> is thinking…" line under an agent thread. It is not a
   * message: it costs no thread real estate, clears itself when a message is
   * sent, and an empty string clears it explicitly. Slack also expires it after
   * two minutes, so a long run has to send it again.
   *
   * `loading_messages` (at most ten) are rotated underneath it as an animated
   * indicator, which is what tells a reader the agent is still working rather
   * than stuck on one line.
   */
  setStatus(
    token: string,
    args: {
      channel_id: string;
      thread_ts: string;
      status: string;
      loading_messages?: string[];
    },
  ): Promise<void> {
    return slackApi(token, "assistant.threads.setStatus", args).then(() => undefined);
  },
  /**
   * The chips a user sees when they open the agent. In the agent messaging
   * experience they pin to the top of the Messages tab and `thread_ts` is not
   * required; the legacy assistant view scopes them to one thread.
   */
  setSuggestedPrompts(
    token: string,
    args: {
      channel_id: string;
      thread_ts?: string;
      title?: string;
      prompts: Array<{ title: string; message: string }>;
    },
  ): Promise<void> {
    return slackApi(token, "assistant.threads.setSuggestedPrompts", args).then(() => undefined);
  },
  /** Name a thread so the agent's history is readable at a glance. */
  setTitle(
    token: string,
    args: { channel_id: string; thread_ts: string; title: string },
  ): Promise<void> {
    return slackApi(token, "assistant.threads.setTitle", args).then(() => undefined);
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
    log.warn(
      "slack",
      `thread ${args.ts} exceeds ${MAX_THREAD_PAGES} pages; newest replies were not read`,
    );
    return messages;
  },
};
