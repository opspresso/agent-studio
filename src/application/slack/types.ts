import type { ExecuteAgentInput } from "@/application/execution/runProject";
import type { SignObjectUrl } from "@/domain/artifact/objectStore";
import type { RunCaller } from "@/domain/execution/actor";
import type { DocumentExtractor } from "@/domain/llm/documentExtractor";
import type { EngineChunk } from "@/domain/llm/types";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";
import type { SlackThreadRepository } from "@/domain/slack/repository";
import type { SlackReaderPort } from "@/domain/slack/reader";
import type {
  SlackChunk,
  SlackMessage,
  SlackSuggestedPrompt,
  SlackTaskDisplayMode,
} from "@/domain/slack/types";
export type { SlackChunk, SlackTaskDisplayMode };

/**
 * The slice of the Slack Web API the event handlers use; faked in tests.
 *
 * One definition for every Slack-facing module — the reply transport, the event
 * handler and the thread-start handler all take this same port rather than each
 * declaring the subset it happens to call.
 */
export interface SlackClientPort extends SlackReaderPort {
  postMessage(
    token: string,
    args: { channel: string; text: string; thread_ts?: string },
  ): Promise<{ ts: string; channel: string }>;
  updateMessage(
    token: string,
    args: { channel: string; ts: string; text: string },
  ): Promise<{ ts: string }>;
  /**
   * Take back a message the bot posted. Used for a channel thread's progress
   * note when the run turns out to have no text to replace it with — a picture
   * is the whole answer often enough that leaving "is thinking…" behind would
   * caption it as having said nothing.
   */
  deleteMessage(token: string, args: { channel: string; ts: string }): Promise<void>;
  uploadImage(
    token: string,
    args: { channel: string; threadTs?: string; filename: string; data: Buffer; title?: string },
  ): Promise<void>;
  /**
   * Mark a message as picked up, on the message itself.
   *
   * The only acknowledgement that lands on the thing the person wrote rather
   * than underneath it, which is what a channel needs: several people are
   * talking, and the reply appears in a thread nobody is necessarily looking at
   * yet. It also arrives a round trip sooner than anything the run produces.
   */
  addReaction(token: string, args: { channel: string; ts: string; name: string }): Promise<void>;
  // `threadReplies`, `channelHistory`, `listChannels` and `userProfile` come
  // from `SlackReaderPort` above: they are what a *run's* tools read, and the
  // execution slice has to be able to name them without importing this file.
  /**
   * Fetch a file shared with the bot (host-checked, bot-token authenticated).
   *
   * `maxBytes` is part of the call because the caller is the one that knows what
   * it is fetching — an image's ceiling is not a document's — and because the
   * bound has to be in force *while* the body is read. The pre-check at the call
   * site reads Slack's declared `size`, which Slack is free to omit.
   */
  downloadFile(token: string, url: string, maxBytes: number): Promise<Buffer>;
  startStream(
    token: string,
    args: {
      channel: string;
      thread_ts: string;
      recipient_user_id?: string;
      recipient_team_id?: string;
      /**
       * How Slack lays out the tasks this stream reports. Set at open time
       * because it describes the message, not a chunk — a stream that later
       * sends tasks without it has nowhere to put them.
       */
      task_display_mode?: SlackTaskDisplayMode;
      /** What the message opens with. Slack requires text or chunks, not neither. */
      chunks?: SlackChunk[];
    },
  ): Promise<{ ts: string; channel: string }>;
  /** Takes a delta, not the accumulated answer. */
  appendStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string; chunks?: SlackChunk[] },
  ): Promise<void>;
  stopStream(
    token: string,
    args: { channel: string; ts: string; markdown_text?: string; chunks?: SlackChunk[] },
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
}

/** Injected dependencies; wired by the route from the composition root. */
export interface SlackEventDeps {
  /** Bound wrapper over `executeAgent(executionDeps, params)` (mirrors ChatDeps.runAgent). */
  runAgent: (params: ExecuteAgentInput) => AsyncGenerator<EngineChunk>;
  projects: ProjectRepository;
  versions: VersionRepository;
  slack: SlackClientPort;
  /**
   * Where the bot has spoken, so a channel follow-up needs no mention. Written
   * after every channel reply; the event gate is what reads it back.
   */
  threads: SlackThreadRepository;
  /**
   * Reads an attached document into the text a turn carries. Required rather
   * than optional: a deployment that forgot to wire it would drop every attached
   * file with the same warning the old image-only path used, which is exactly
   * the silence this replaced.
   */
  documents: DocumentExtractor;
  /**
   * Signs an address for a file this run produced.
   *
   * A thread cannot be handed the bytes — the run bracket stored the document
   * and stripped the payload before any of this saw it — so a link is what a
   * reader gets. Optional because a deployment may have no object storage, and
   * then the reply says so rather than silently answering with prose about a
   * report nobody can open.
   */
  signFile?: SignObjectUrl;
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
  /**
   * The envelope kind — `event_callback` for a delivered event, and
   * `url_verification` for the one-off challenge a Request URL is set up with.
   * Read by the event gate, which refuses anything that is not the former.
   */
  type?: string;
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
