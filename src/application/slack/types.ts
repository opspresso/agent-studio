import type { ExecuteAgentInput } from "@/application/execution/runProject";
import type { RunCaller } from "@/domain/execution/actor";
import type { EngineChunk } from "@/domain/llm/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { SlackMessage, SlackSuggestedPrompt } from "@/domain/slack/types";

/**
 * The slice of the Slack Web API the event handlers use; faked in tests.
 *
 * One definition for every Slack-facing module — the reply transport, the event
 * handler and the thread-start handler all take this same port rather than each
 * declaring the subset it happens to call.
 */
export interface SlackClientPort {
  postMessage(
    token: string,
    args: { channel: string; text: string; thread_ts?: string },
  ): Promise<{ ts: string; channel: string }>;
  updateMessage(
    token: string,
    args: { channel: string; ts: string; text: string },
  ): Promise<{ ts: string }>;
  uploadImage(
    token: string,
    args: { channel: string; threadTs?: string; filename: string; data: Buffer; title?: string },
  ): Promise<void>;
  threadReplies(
    token: string,
    args: { channel: string; ts: string; limit?: number },
  ): Promise<SlackMessage[]>;
  /** Fetch a file shared with the bot (host-checked, bot-token authenticated). */
  downloadFile(token: string, url: string): Promise<Buffer>;
  startStream(
    token: string,
    args: {
      channel: string;
      thread_ts: string;
      recipient_user_id?: string;
      recipient_team_id?: string;
    },
  ): Promise<{ ts: string; channel: string }>;
  /** Takes a delta, not the accumulated answer. */
  appendStream(
    token: string,
    args: { channel: string; ts: string; markdown_text: string },
  ): Promise<void>;
  stopStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string },
  ): Promise<void>;
  setStatus(
    token: string,
    args: {
      channel_id: string;
      thread_ts: string;
      status: string;
      loading_messages?: string[];
    },
  ): Promise<void>;
  setSuggestedPrompts(
    token: string,
    args: {
      channel_id: string;
      thread_ts?: string;
      title?: string;
      prompts: SlackSuggestedPrompt[];
    },
  ): Promise<void>;
  setTitle(
    token: string,
    args: { channel_id: string; thread_ts: string; title: string },
  ): Promise<void>;
  /** Who a Slack user id is. Resolves to `null` rather than throwing. */
  userProfile(token: string, userId: string): Promise<RunCaller | null>;
}

/** Injected dependencies; wired by the route from the composition root. */
export interface SlackEventDeps {
  /** Bound wrapper over `executeAgent(executionDeps, params)` (mirrors ChatDeps.runAgent). */
  runAgent: (params: ExecuteAgentInput) => AsyncGenerator<EngineChunk>;
  projects: ProjectRepository;
  versions: VersionRepository;
  slack: SlackClientPort;
  /**
   * What marks a reply as still being written, on the edit-in-place path only —
   * a streamed reply is marked as unfinished by Slack itself. Injected rather
   * than read here: application code takes its configuration, it does not reach
   * for it. Unset means {@link DEFAULT_LOADING_INDICATOR}.
   */
  loadingIndicator?: string;
}

/** An attachment on an inbound message event. */
export interface SlackEventFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export interface SlackEventBody {
  event_id?: string;
  /** The workspace the event came from; required to stream into a channel. */
  team_id?: string;
  /**
   * Who the event was delivered for — our own app's user id in this workspace.
   * Comparing it to `event.user` identifies the bot's own messages without an
   * extra `auth.test` round trip.
   */
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    user?: string;
    channel?: string;
    channel_type?: string;
    text?: string;
    ts?: string;
    thread_ts?: string;
    files?: SlackEventFile[];
    /** `app_home_opened` only: which App Home tab was opened. */
    tab?: string;
    /** `assistant_thread_started` only (the legacy assistant view). */
    assistant_thread?: { channel_id?: string; thread_ts?: string; user_id?: string };
  };
}
