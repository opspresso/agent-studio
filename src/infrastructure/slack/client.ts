/** Minimal Slack Web API client over fetch — no SDK dependency. */

import { callerFrom, type RunCaller } from "@/domain/execution/actor";
import type {
  SlackChannelInfo,
  SlackChunk,
  SlackMessage,
  SlackReaction,
  SlackTaskDisplayMode,
  SlackUserDetail,
} from "@/domain/slack/types";
import { log } from "@/shared/logger";
import { readBodyBytes } from "@/shared/httpBody";
import { getCachedProfile, rememberProfile, type CachedSlackProfile } from "./profileCache";
export type { SlackMessage };

/** The slice of `users.info`'s user object a profile is built from. */
interface SlackUserInfo {
  name?: string;
  real_name?: string;
  tz?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    title?: string;
    status_text?: string;
    status_emoji?: string;
    image_512?: string;
    /**
     * Read for attribution and nothing else — `toUserDetail` does not copy it,
     * so no tool result and no prompt can carry it.
     */
    email?: string;
  };
}

/**
 * One user object to the shape a run may see.
 *
 * Slack documents every one of these fields as possibly absent, null *or the
 * empty string*, so each goes through `firstNonEmpty` rather than `??` — an
 * empty `display_name` is extremely common and `??` would keep it. The name is
 * the first of four Slack may have filled; falling back to the id keeps a person
 * addressable when it has filled none.
 *
 * `profile.email` is deliberately not read even where the scope allows it — see
 * `SlackUserDetail`.
 */
function toUserDetail(user: SlackUserInfo, id: string): SlackUserDetail {
  const displayName =
    firstNonEmpty(user.profile?.display_name, user.profile?.real_name, user.real_name, user.name) ??
    id;
  const realName = firstNonEmpty(user.profile?.real_name, user.real_name);
  return {
    id,
    displayName,
    ...(realName && realName !== displayName ? { realName } : {}),
    ...(firstNonEmpty(user.profile?.title) ? { title: user.profile?.title?.trim() } : {}),
    ...(firstNonEmpty(user.tz) ? { timezone: user.tz?.trim() } : {}),
    ...(firstNonEmpty(user.profile?.status_text)
      ? { statusText: user.profile?.status_text?.trim() }
      : {}),
    ...(firstNonEmpty(user.profile?.status_emoji)
      ? { statusEmoji: user.profile?.status_emoji?.trim() }
      : {}),
    ...(firstNonEmpty(user.profile?.image_512)
      ? { avatarUrl: user.profile?.image_512?.trim() }
      : {}),
    ...(user.is_bot === undefined ? {} : { isBot: user.is_bot }),
    ...(user.deleted === undefined ? {} : { deactivated: user.deleted }),
  };
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

/**
 * How long any one Slack call may take.
 *
 * Every other outbound adapter here bounds its requests — the URL reader, the
 * remote-agent dispatcher, the MCP session, the OAuth client — and this one did
 * not, which mattered more than it looks: a Slack run's work happens in
 * `after()`, past the response, so a hung call has nothing above it to give up.
 * The run's own deadline covers the model and the tools, not the reply.
 */
const SLACK_TIMEOUT_MS = 30_000;
/** Bytes move here, so the same ceiling would cut a large upload short. */
const SLACK_TRANSFER_TIMEOUT_MS = 120_000;

function slackFetch(url: string, init: RequestInit = {}, timeoutMs = SLACK_TIMEOUT_MS) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Read one Slack response, failing with something an operator can act on.
 *
 * Slack answers a rate limit with **429 and a non-JSON body**, so parsing the
 * body first turned "slow down" into `Unexpected end of JSON input` — a message
 * that names neither the method nor the cause. The transport status is checked
 * before the payload for that reason, and the `Retry-After` Slack sends is
 * quoted rather than dropped: it is the whole content of the answer.
 */
async function slackResult<T>(res: Response, method: string): Promise<T> {
  if (!res.ok) {
    throw new Error(
      res.status === 429
        ? `Slack ${method} rate limited; Slack asked for ${res.headers.get("retry-after") ?? "?"}s`
        : `Slack ${method} failed: HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!data.ok) {
    throw new Error(`Slack ${method} failed: ${data.error ?? res.status}`);
  }
  return data;
}

/** A read-family method: GET with query params, which is what Slack requires. */
async function slackGet<T>(
  token: string,
  method: string,
  params: URLSearchParams,
): Promise<T> {
  const res = await slackFetch(`https://slack.com/api/${method}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return slackResult<T>(res, method);
}

async function slackApi<T>(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const res = await slackFetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });
  return slackResult<T>(res, method);
}

/**
 * One `users.info`, cached per workspace, feeding three views: what a tool may
 * show, what the caller block may say, and the address attribution needs.
 *
 * Never throws: a name is a nicety and a missing one must not be the reason a
 * mention goes unanswered. A failure is cached briefly so a revoked scope does
 * not cost a round trip per message.
 */
async function fetchProfile(token: string, userId: string): Promise<CachedSlackProfile | null> {
  const cached = getCachedProfile(token, userId);
  if (cached) {
    return cached.value;
  }
  let resolved: CachedSlackProfile | null = null;
  try {
    const data = await slackGet<{ user?: SlackUserInfo }>(
      token,
      "users.info",
      new URLSearchParams({ user: userId }),
    );
    if (!data.user) {
      throw new Error("Slack users.info returned no user");
    }
    const email = firstNonEmpty(data.user.profile?.email);
    resolved = { detail: toUserDetail(data.user, userId), ...(email ? { email } : {}) };
  } catch (error) {
    log.warn(
      "slack",
      `profile lookup failed for ${userId}: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  rememberProfile(token, userId, resolved);
  return resolved;
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
    const urlData = await slackGet<{ upload_url?: string; file_id?: string }>(
      token,
      "files.getUploadURLExternal",
      params,
    );
    if (!urlData.upload_url || !urlData.file_id) {
      throw new Error("Slack files.getUploadURLExternal returned no upload target");
    }
    const putRes = await slackFetch(
      urlData.upload_url,
      { method: "POST", body: args.data as never },
      SLACK_TRANSFER_TIMEOUT_MS,
    );
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
  async downloadFile(token: string, url: string, maxBytes: number): Promise<Buffer> {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      throw new Error(`Slack file url is not a URL: ${url}`);
    }
    if (!FILE_HOSTS.has(host)) {
      throw new Error(`Slack file url has an unexpected host: ${host}`);
    }
    const res = await slackFetch(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      SLACK_TRANSFER_TIMEOUT_MS,
    );
    if (!res.ok) {
      throw new Error(`Slack file download failed: ${res.status}`);
    }
    // Bounded here, not by the caller. It used to answer `res.arrayBuffer()` and
    // let the caller compare the size afterwards, which is a check that runs
    // once the memory is already spent — and the caller's own pre-check reads
    // `file.size`, which Slack may omit entirely (the call site says so).
    return Buffer.from(await readBodyBytes(res, maxBytes));
  },
  authTest(token: string): Promise<{ team?: string; user?: string; bot_id?: string }> {
    return slackApi(token, "auth.test", {});
  },
  /**
   * Who a Slack user id is, cached per workspace.
   *
   * Never throws: a name is a nicety and a missing one must not be the reason a
   * mention goes unanswered. A failure is cached briefly so a revoked scope does
   * not cost a round trip per message.
   */
  async userDetail(token: string, userId: string): Promise<SlackUserDetail | null> {
    return (await fetchProfile(token, userId))?.detail ?? null;
  },

  /**
   * The address behind a Slack id, for attribution only.
   *
   * Never reaches a prompt or a tool result — it decides whose gallery a run's
   * output is filed under, which a Slack workspace id cannot answer. The lookup
   * is the same one every other view here shares.
   */
  async userEmail(token: string, userId: string): Promise<string | null> {
    return (await fetchProfile(token, userId))?.email ?? null;
  },

  /**
   * The caller-block view of the same lookup.
   *
   * Derived rather than fetched separately: one `users.info` answers both, and
   * `callerFrom` owns what is safe to splice into a system prompt.
   */
  async userProfile(token: string, userId: string): Promise<RunCaller | null> {
    const detail = await slackClient.userDetail(token, userId);
    return detail
      ? callerFrom({
          displayName: detail.displayName,
          ...(detail.timezone ? { timezone: detail.timezone } : {}),
          ...(detail.avatarUrl ? { avatarUrl: detail.avatarUrl } : {}),
        })
      : null;
  },

  /**
   * People whose name or handle contains `query`, case-insensitively.
   *
   * Slack offers a bot no name search, so this walks `users.list` and filters.
   * The page bound is what keeps a large workspace from turning one tool call
   * into dozens of requests — and it reports when it stopped, because a search
   * that quietly missed someone is worse than one that says it did.
   *
   * Deactivated accounts and Slackbot are dropped: a run asking who someone is
   * means a colleague it can reach.
   */
  async findUsers(
    token: string,
    query: string,
    maxPages: number,
  ): Promise<{ users: SlackUserDetail[]; truncated: boolean }> {
    const needle = query.trim().toLowerCase();
    const users: SlackUserDetail[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) {
        params.set("cursor", cursor);
      }
      const data = await slackGet<{
        members?: Array<SlackUserInfo & { id?: string; is_bot?: boolean; deleted?: boolean }>;
        response_metadata?: { next_cursor?: string };
      }>(token, "users.list", params);
      for (const member of data.members ?? []) {
        if (!member.id || member.deleted || member.id === "USLACKBOT") {
          continue;
        }
        const detail = toUserDetail(member, member.id);
        const haystack = [detail.displayName, detail.realName, member.name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!needle || haystack.includes(needle)) {
          users.push(detail);
        }
      }
      cursor = data.response_metadata?.next_cursor || undefined;
      if (!cursor) {
        return { users, truncated: false };
      }
    }
    return { users, truncated: true };
  },

  /** What people put on one message. */
  async messageReactions(
    token: string,
    args: { channel: string; ts: string },
  ): Promise<SlackReaction[]> {
    const params = new URLSearchParams({
      channel: args.channel,
      timestamp: args.ts,
      // Without it Slack cuts the user list at 25 and the counts stop agreeing
      // with the names.
      full: "true",
    });
    const data = await slackGet<{
      message?: { reactions?: Array<{ name?: string; count?: number; users?: string[] }> };
    }>(token, "reactions.get", params);
    return (data.message?.reactions ?? [])
      .filter((reaction): reaction is { name: string } & typeof reaction => Boolean(reaction.name))
      .map((reaction) => ({
        name: reaction.name,
        count: reaction.count ?? (reaction.users?.length ?? 0),
        users: reaction.users ?? [],
      }));
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
  async deleteMessage(token: string, args: { channel: string; ts: string }): Promise<void> {
    await slackApi(token, "chat.delete", args);
  },
  /**
   * React to a message, to say it has been picked up.
   *
   * `already_reacted` is success, not failure: Slack redelivers events, and a
   * redelivery that the dedup claim let through — a reclaimed lease after an
   * instance died — would otherwise turn an acknowledgement into a logged
   * error. Nothing else about a reaction is worth failing a run over either,
   * which is why the caller treats every other error the same way.
   */
  async addReaction(
    token: string,
    args: { channel: string; ts: string; name: string },
  ): Promise<void> {
    try {
      await slackApi(token, "reactions.add", {
        channel: args.channel,
        timestamp: args.ts,
        name: args.name,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already_reacted")) {
        return;
      }
      throw error;
    }
  },
  /**
   * Open a streamed reply. Slack renders it as text arriving live rather than a
   * message being rewritten, and `chat.appendStream` costs a tenth of what a
   * `chat.update` loop does against the rate limit.
   *
   * `thread_ts` is required: a stream is always a reply to the request that
   * caused it. Streaming into a *channel* additionally needs the recipient, so
   * a channel mention passes `recipient_user_id`/`recipient_team_id`.
   *
   * `task_display_mode` belongs on the open rather than on a chunk: it says how
   * this message lays out tasks, so a stream that omits it has nowhere to put
   * the ones it later sends.
   */
  startStream(
    token: string,
    args: {
      channel: string;
      thread_ts: string;
      recipient_user_id?: string;
      recipient_team_id?: string;
      task_display_mode?: SlackTaskDisplayMode;
      chunks?: SlackChunk[];
    },
  ): Promise<{ ts: string; channel: string }> {
    return slackApi(token, "chat.startStream", args);
  },
  /**
   * Append to an open stream. `markdown_text` is a *delta*, not the accumulated
   * answer — sending the whole text each time would repeat it on screen.
   *
   * `chunks` is the other axis: a `task_update` there reports what the run is
   * doing without touching the answer's text. Slack requires one of the two.
   */
  appendStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string; chunks?: SlackChunk[] },
  ): Promise<void> {
    return slackApi(token, "chat.appendStream", args).then(() => undefined);
  },
  /** Close an open stream, optionally with one last delta and a final chunk. */
  stopStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string; chunks?: SlackChunk[] },
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
      const data = await slackGet<{
        messages?: SlackMessage[];
        response_metadata?: { next_cursor?: string };
      }>(token, "conversations.replies", params);
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

  /**
   * One page of a channel's recent messages, newest first.
   *
   * Deliberately unpaginated, unlike `threadReplies`: a thread is a unit and
   * reading half of one is reading the wrong thing, while a channel has no end
   * and "what was said lately" is exactly its tail. The caller's `limit` is what
   * bounds it.
   */
  async channelHistory(
    token: string,
    args: { channel: string; limit?: number },
  ): Promise<SlackMessage[]> {
    // Read-family Web API methods reject JSON bodies; use GET with query params.
    const params = new URLSearchParams({
      channel: args.channel,
      limit: String(args.limit ?? PAGE_SIZE),
    });
    const data = await slackGet<{ messages?: SlackMessage[] }>(
      token,
      "conversations.history",
      params,
    );
    return data.messages ?? [];
  },

  /**
   * The conversations this bot can see, so a channel *name* can become the id
   * every other call takes.
   *
   * Archived channels are excluded — a run asking about `#deploy` means the one
   * people are using. Both public and private types are requested; which of
   * them Slack actually returns depends on the granted scopes, and a workspace
   * that granted only one gets that one rather than an error.
   */
  async listChannels(token: string, args?: { limit?: number }): Promise<SlackChannelInfo[]> {
    const params = new URLSearchParams({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: String(args?.limit ?? PAGE_SIZE),
    });
    const data = await slackGet<{
      channels?: Array<{
        id?: string;
        name?: string;
        is_private?: boolean;
        is_member?: boolean;
        topic?: { value?: string };
        purpose?: { value?: string };
      }>;
    }>(token, "conversations.list", params);
    return (data.channels ?? [])
      .filter((channel): channel is { id: string; name: string } & typeof channel =>
        Boolean(channel.id && channel.name),
      )
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        ...(firstNonEmpty(channel.topic?.value) ? { topic: channel.topic?.value?.trim() } : {}),
        ...(firstNonEmpty(channel.purpose?.value)
          ? { purpose: channel.purpose?.value?.trim() }
          : {}),
        ...(channel.is_private === undefined ? {} : { isPrivate: channel.is_private }),
        ...(channel.is_member === undefined ? {} : { isMember: channel.is_member }),
      }));
  },
};
