import { withConfigurations } from "./projectConfigurations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSlackEvent, handleSlackStop } from "@/application/slack/handleSlackEvent";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import type {
  SlackChunk,
  SlackClientPort,
  SlackEventBody,
  SlackEventDeps,
} from "@/application/slack/types";
import type { SlackMessage } from "@/infrastructure/slack/client";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { Project, AgentConfiguration } from "@/domain/project/types";
import type { RunCaller } from "@/domain/execution/actor";
import type { ProjectRepository } from "@/domain/project/repository";
import { MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS } from "@/domain/slack/reader";

const NOW = 1_750_000_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    ownerEmail: "owner@x.com",

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(): AgentConfiguration {
  return {
    projectName: "painter",

    systemPrompt: "",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

/**
 * `streaming: false` makes `chat.startStream` fail, which is how a workspace
 * that cannot stream behaves — the handler is expected to fall back to posting
 * and editing one message.
 */
/**
 * The two rules Slack enforces on one stream, which the fakes enforce because
 * not enforcing them is exactly how both shipped:
 *
 * - `markdown_text` and `chunks` on the same request is
 *   `cannot_provide_both_markdown_text_and_chunks`;
 * - the mode a stream opens in is the mode it stays in — the other one later is
 *   `streaming_mode_mismatch`. A channel's progress rows are chunks and they
 *   open the message, so on a channel the answer must travel as a
 *   `markdown_text` *chunk*.
 *
 * Passing tests accepted calls Slack rejects, twice, and `push` swallows a
 * failed append — so every channel run silently dropped its whole answer.
 */
function streamModeGuard() {
  let mode: "text" | "chunks" | undefined;
  return (
    method: string,
    args: { markdown_text?: string; text?: string; chunks?: unknown[] },
  ): void => {
    const hasText = (args.markdown_text ?? args.text) !== undefined;
    const hasChunks = args.chunks !== undefined;
    if (hasText && hasChunks) {
      throw new Error(`Slack ${method} failed: cannot_provide_both_markdown_text_and_chunks`);
    }
    const used = hasChunks ? "chunks" : hasText ? "text" : undefined;
    if (!used) {
      return;
    }
    if (mode === undefined) {
      mode = used;
      return;
    }
    if (mode !== used) {
      throw new Error(`Slack ${method} failed: streaming_mode_mismatch`);
    }
  };
}

function makeSlackFake(options: { streaming?: boolean } = {}) {
  const guard = streamModeGuard();
  const streaming = options.streaming ?? true;
  const posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  /** Messages taken back — a channel progress note the answer never replaced. */
  const deleted: string[] = [];
  const streamStarts: Array<{
    channel: string;
    thread_ts: string;
    recipient_user_id?: string;
    recipient_team_id?: string;
  }> = [];
  /** Every delta Slack accepted, in order — the streamed message's contents. */
  const appended: string[] = [];
  /** The other stream axis: what the run reported it was doing, in order. */
  const tasks: Array<{ id: string; title: string; status: string }> = [];
  function recordTasks(chunks: SlackChunk[] | undefined): void {
    for (const chunk of chunks ?? []) {
      if (chunk.type === "task_update") {
        tasks.push({ id: chunk.id, title: chunk.title, status: chunk.status });
      }
      // On a channel the answer travels as a chunk too, because the progress
      // rows opened the stream in chunks mode.
      if (chunk.type === "markdown_text") {
        appended.push(chunk.text);
      }
    }
  }
  const statuses: string[] = [];
  /** Pictures that actually reached the thread. */
  const uploads: Array<{ title?: string; filename: string }> = [];
  /** What the bot put on the message it picked up, and where. */
  const reactions: Array<{ channel: string; ts: string; name: string }> = [];
  const titles: Array<{ channel_id: string; thread_ts: string; title: string }> = [];
  const calls: string[] = [];
  const replies: SlackMessage[] = [];
  const downloads: string[] = [];
  const profileLookups: string[] = [];
  const profiles = new Map<string, RunCaller>();
  /** Slack id → address, for the artifact owner the run files its output under. */
  const emails = new Map<string, string>();
  const slack: SlackClientPort = {
    async setSessionStatus(_token, args) {
      calls.push(`session:${args.status}`);
      if (args.title) titles.push({ channel_id: args.channel_id, thread_ts: args.thread_ts, title: args.title });
    },
    async downloadFile(_token, url) {
      downloads.push(url);
      return Buffer.from("png-bytes");
    },
    async postMessage(_token, args) {
      calls.push("postMessage");
      posted.push(args);
      return { ts: "100.1", channel: args.channel };
    },
    async updateMessage(_token, args) {
      calls.push("updateMessage");
      updates.push(args);
      return { ts: args.ts };
    },
    async deleteMessage(_token, args) {
      calls.push("deleteMessage");
      deleted.push(args.ts);
    },
    async uploadImage(_token, args) {
      calls.push("uploadImage");
      uploads.push({ title: args.title, filename: args.filename });
    },
    async addReaction(_token, args) {
      calls.push("addReaction");
      reactions.push(args);
    },
    // The workspace read tools have their own tests; the handler never calls
    // these, and a fake that omitted them would only be hiding that.
    async channelHistory() {
      calls.push("channelHistory");
      return [];
    },
    async listChannels() {
      calls.push("listChannels");
      return [];
    },
    async threadReplies() {
      calls.push("threadReplies");
      // Slack returns everything already in the thread — including whatever
      // this handler posted itself.
      return [
        ...replies,
        ...posted.map((message, index) => ({
          ts: `100.${index + 1}`,
          bot_id: "B0", user: "U0",
          text: message.text,
        })),
      ];
    },
    async startStream(_token, args) {
      calls.push("startStream");
      if (!streaming) {
        throw new Error("streaming is not available on this plan");
      }
      guard("chat.startStream", args as never);
      streamStarts.push(args);
      // The opening chunk counts too: on a channel the first task is what
      // opens the message, so a fake that ignored it would hide the whole
      // point of the axis.
      recordTasks(args.chunks);
      return { ts: "200.1", channel: args.channel };
    },
    async appendStream(_token, args) {
      calls.push("appendStream");
      guard("chat.appendStream", args);
      if (args.markdown_text) {
        appended.push(args.markdown_text);
      }
      recordTasks(args.chunks);
    },
    async stopStream(_token, args) {
      calls.push("stopStream");
      guard("chat.stopStream", args);
      if (args.markdown_text) {
        appended.push(args.markdown_text);
      }
      recordTasks(args.chunks);
    },
    async setStatus(_token, args) {
      calls.push("setStatus");
      statuses.push(args.status);
    },
    async setSuggestedPrompts() {},
    async userProfile(_token, userId) {
      calls.push("userProfile");
      profileLookups.push(userId);
      return profiles.get(userId) ?? null;
    },
    // The workspace read tools have their own tests; the handler never calls
    // these, and a fake that omitted them would only be hiding that.
    async userEmail(_token, userId) {
      calls.push("userEmail");
      return emails.get(userId) ?? null;
    },
    async userDetail() {
      calls.push("userDetail");
      return null;
    },
    async findUsers() {
      calls.push("findUsers");
      return { users: [], truncated: false };
    },
    async messageReactions() {
      calls.push("messageReactions");
      return [];
    },
  };
  /**
   * What the reader ends up seeing, whichever transport delivered it — so a
   * test about the answer does not have to know how it travelled.
   */
  const finalText = () =>
    appended.length > 0 ? appended.join("") : (updates.at(-1)?.text ?? posted.at(-1)?.text ?? "");
  return {
    slack,
    posted,
    updates,
    deleted,
    appended,
    uploads,
    reactions,
    tasks,
    streamStarts,
    statuses,
    titles,
    calls,
    replies,
    downloads,
    profiles,
    emails,
    profileLookups,
    finalText,
  };
}

/**
 * Threads the handler recorded the bot as engaged in. Module-level so a test
 * can read it without threading a recorder through `makeDeps`; cleared between
 * tests below.
 */
const engagements: Array<{ project: string; channel: string; threadTs: string }> = [];
/** Mute changes the handler recorded, in order. */
const mutes: Array<{ threadTs: string; muted: boolean }> = [];

function makeDeps(chunks: EngineChunk[], slack: SlackClientPort): SlackEventDeps {
  let held = false;
  return {
    stops: {
      acquire: async () => { if (held) return null; held = true; return "lease"; },
      renew: async () => held,
      release: async () => { held = false; },
      requestStop: async () => {}, stoppedAfter: async () => false,
    },
    threads: {
      markEngaged: async (project, channel, threadTs) => {
        engagements.push({ project, channel, threadTs });
      },
      isEngaged: async () => false,
      setMuted: async (_project, _channel, threadTs, muted) => {
        mutes.push({ threadTs, muted });
      },
    },
    runAgent: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    // The real extractor has its own tests; here it only has to be the thing
    // that turns bytes into text, so a document's route through the handler is
    // what is under test.
    documents: { extract: async ({ bytes, name, maxChars }) => {
        const text = Buffer.from(bytes).toString("utf-8");
        return text.length <= maxChars
          ? { text }
          : { text: text.slice(0, maxChars), note: `the first ${maxChars} characters of ${name}` };
      } },
    projects: withConfigurations({ get: async () => projectFixture() } as unknown as ProjectRepository, async () => configurationFixture()),

    slack,
  };
}

const EVENT: SlackEventBody = {
  event_id: "Ev1",
  authorizations: [{ user_id: "U0", is_bot: true }],
  event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@U0> hello" },
};

/** The agent container / DM surface, where Slack offers a status line and a title. */
const DM_EVENT: SlackEventBody = {
  event_id: "Ev2",
  team_id: "T1",
  event: { type: "message", channel_type: "im", channel: "D1", ts: "1.0", text: "hello" },
};

const BINDING = { projectName: "painter", botToken: "tok" };

/** A run that yields nothing but `done`. */
const deps0 = (slack: SlackClientPort) => makeDeps([{ done: true }], slack);

describe("stopping Slack runs", () => {
  it("checks a stop recorded just before model completion without waiting for a poll tick", async () => {
    const { slack, uploads, finalText } = makeSlackFake();
    const deps = deps0(slack);
    let requested = false;
    deps.stops.stoppedAfter = async () => requested;
    deps.runAgent = async function* () {
      requested = true;
      yield { image: { b64: "aW1hZ2U=", mimeType: "image/png" } };
    };
    await handleSlackEvent(deps, DM_EVENT, BINDING);
    expect(uploads).toEqual([]);
    expect(finalText()).toContain("Stopped by user");
  });

  it("does not let overlapping runs in one thread clear each other's session status", async () => {
    const { slack, calls, posted } = makeSlackFake();
    const deps = deps0(slack);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let runs = 0;
    deps.runAgent = async function* () {
      runs += 1;
      if (runs === 1) { started(); await held; }
      yield { delta: { content: "done" } };
    };
    const first = handleSlackEvent(deps, DM_EVENT, BINDING);
    await ready;
    try {
      await handleSlackEvent(deps, { ...DM_EVENT, event_id: "EvNext", event: {
        ...DM_EVENT.event, ts: "2.0", thread_ts: "1.0",
      } }, BINDING);
      expect(runs).toBe(1);
      expect(calls).not.toContain("session:active");
      expect(posted.at(-1)?.text).toContain("already working");
    } finally {
      release();
      await first;
    }
  });
  const stopEvent: SlackEventBody = { type: "event_callback", event: {
    type: "agent_session_stopped", channel: "D1", thread_ts: "1.0", event_ts: "2.0", user: "U1",
  } };

  it("records a native stop without a model call", async () => {
    const { slack } = makeSlackFake();
    const deps = deps0(slack);
    const requestStop = vi.spyOn(deps.stops, "requestStop");
    const run = vi.spyOn(deps, "runAgent");
    await handleSlackStop(deps, stopEvent, BINDING);
    expect(requestStop).toHaveBeenCalledWith({ projectName: "painter", channel: "D1", threadTs: "1.0" }, "2.0");
    expect(run).not.toHaveBeenCalled();
  });

  it("applies the private-project access gate before recording native and command stops", async () => {
    const { slack, emails } = makeSlackFake();
    emails.set("U1", "outsider@example.com");
    const deps = deps0(slack);
    deps.projects.get = async () => ({ ...projectFixture(), visibility: "private" });
    const requestStop = vi.spyOn(deps.stops, "requestStop");
    await handleSlackStop(deps, stopEvent, BINDING);
    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "1.0", ts: "2.0", user: "U1", text: "!stop" } }, BINDING);
    expect(requestStop).not.toHaveBeenCalled();
  });

  it("handles !stop in a DM thread without running a model", async () => {
    const { slack, posted } = makeSlackFake();
    const deps = deps0(slack);
    const requestStop = vi.spyOn(deps.stops, "requestStop");
    const run = vi.spyOn(deps, "runAgent");
    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U1", thread_ts: "1.0", ts: "2.0", text: "!stop" } }, BINDING);
    expect(requestStop).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
    expect(posted.at(-1)?.text).toContain("Stop requested");
  });

  it("does not dispatch delayed stopped work or reset a newer session's status", async () => {
    const { slack, calls, posted } = makeSlackFake();
    const deps = deps0(slack);
    deps.stops.stoppedAfter = async () => true;
    const run = vi.spyOn(deps, "runAgent");
    await handleSlackEvent(deps, DM_EVENT, BINDING);
    expect(run).not.toHaveBeenCalled();
    expect(calls).not.toContain("session:active");
    expect(calls).not.toContain("session:processing");
    expect(posted.at(-1)?.text).toContain("Stopped by user");
    expect(vi.getTimerCount()).toBe(0);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  engagements.length = 0;
  mutes.length = 0;
});

describe("handleSlackEvent", () => {
  it("always runs the project bound to the endpoint", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    const deps = makeDeps([], slack);
    let requestedProject: string | undefined;
    let userMessage: string | undefined;
    deps.projects = {
      get: async (name: string) => {
        requestedProject = name;
        return { ...projectFixture(), configuration: configurationFixture() };
      },
    } as unknown as ProjectRepository;
    deps.runAgent = async function* (input) {
      const last = input.messages.at(-1);
      userMessage = last ? messageText(last) : undefined;
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: { ...EVENT.event, text: "<@U0> project:other hello" },
      },
      BINDING,
    );

    expect(requestedProject).toBe("painter");
    expect(userMessage).toBe("project:other hello");
  });

  it("names the thread as the run's conversation, root message and DM alike", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: string[] = [];
    const capture = (): SlackEventDeps => {
      const { slack } = makeSlackFake();
      const deps = deps0(slack);
      deps.runAgent = async function* (input) {
        seen.push(input.conversation ? `${input.conversation.surface}:${input.conversation.id}` : "none");
        yield { done: true };
      };
      return deps;
    };

    // A reply inside a thread: the thread's root, not the reply's own ts.
    await handleSlackEvent(
      capture(),
      { ...EVENT, event: { ...EVENT.event, ts: "5.0", thread_ts: "1.0" } },
      BINDING,
    );
    // A top-level mention opens its own thread, so its ts is the address.
    await handleSlackEvent(capture(), EVENT, BINDING);
    // A DM is a thread of its own too.
    await handleSlackEvent(capture(), DM_EVENT, BINDING);

    expect(seen).toEqual(["slack:C1:1.0", "slack:C1:1.0", "slack:D1:1.0"]);
  });

  it("delivers the top-level answer only", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, appended, finalText } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { content: "Hello " } },
        { author: "child", delta: { content: "nested subagent text" } },
        { delta: { content: "there." } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toBe("Hello there.");
    expect(appended.some((chunk) => chunk.includes("nested"))).toBe(false);
  });

  it("surfaces an engine error chunk in the final message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps([{ error: "boom" }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    // Nothing was ever streamed, so there is no message to finish — the warning
    // is posted on its own rather than left unsaid.
    expect(finalText()).toBe(":warning: boom");
  });

  it("keeps the streamed answer and appends the warning on a late failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.uploadImage = async () => {
      throw new Error("upload boom");
    };
    const deps = makeDeps(
      [
        { delta: { content: "Here is your answer." } },
        { image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toContain("Here is your answer.");
    expect(finalText()).toContain(":warning:");
  });

  it("does not caption a picture-only answer as having said nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, posted, updates, deleted, calls, finalText } = makeSlackFake();
    const uploads: string[] = [];
    slack.uploadImage = async (_token, args) => {
      uploads.push(args.filename);
    };
    const deps = makeDeps(
      [{ image: { b64: "aGk=", mimeType: "image/png", prompt: "a cat" } }, { done: true }],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(uploads).toHaveLength(1);
    // The run answered — with a picture. The reply transport cannot see that,
    // so it must not be the thing deciding there was no answer.
    expect(finalText()).not.toContain("no response");
    // The channel thread got a progress task, which is the one thing standing
    // where an answer would go. Nothing came to replace it, so the message it
    // opened is taken back rather than left captioning the picture as an
    // unfinished run — and the stream is closed first, since deleting one Slack
    // still considers open leaves it mid-write.
    expect(posted).toEqual([]);
    expect(updates).toEqual([]);
    expect(calls.indexOf("stopStream")).toBeLessThan(calls.indexOf("deleteMessage"));
    expect(deleted).toEqual(["200.1"]);
  });

  /**
   * A document a tool rendered. Its bytes were stripped at the bracket the
   * moment it was stored, so a thread cannot be handed the file the way it is
   * handed a picture — it gets a link. Before this, Slack read `chunk.image`
   * beside `chunk.file` and dropped the second: the bot answered "here is the
   * report" into a thread with no report in it.
   */
  const rendered: EngineChunk = {
    file: {
      name: "report.docx",
      mimeType: "application/msword",
      source: "mcp: render_document",
      byteSize: 2048,
      key: "objects/report.docx",
    },
  };

  it("links a file the run produced, under the name it should be saved as", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "Here is your report." } }, rendered, { done: true }], slack);
    deps.signFile = async (key, _ttl, opts) => `https://signed/${key}?as=${opts?.downloadAs ?? ""}`;

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toContain("Here is your report.");
    expect(finalText()).toContain(
      "<https://signed/objects/report.docx?as=report.docx|report.docx>",
    );
  });

  it("does not let a tool-supplied filename break the link it sits in", async () => {
    // `safeFileName` takes out control characters and path separators; every
    // character Slack reads as mrkdwn survives it. A name with a pipe would
    // truncate the visible label at the pipe — the reader was shown a name that
    // was not the file's.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps(
      [
        {
          file: {
            name: "Q3 <draft>|v2.docx",
            mimeType: "application/msword",
            source: "mcp: render",
            key: "objects/q3.docx",
          },
        },
        { done: true },
      ],
      slack,
    );
    deps.signFile = async (key) => `https://signed/${key}`;

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toContain("Q3 &lt;draft&gt;∣v2.docx");
    expect(finalText()).not.toContain("<draft>");
  });

  it("says a file was not kept when this deployment stores nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, finalText } = makeSlackFake();
    // No signer wired — the reader is told the download does not exist rather
    // than being left to wonder where it went.
    const deps = makeDeps([rendered, { done: true }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toContain(":warning:");
    expect(finalText()).toContain("were not kept");
    // And the run is not captioned as having produced nothing: it produced this.
    expect(finalText()).not.toContain("without producing an answer");
  });

  it("says so when the run really produced nothing at all", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, finalText } = makeSlackFake();

    await handleSlackEvent(deps0(slack), EVENT, BINDING);

    expect(finalText()).toContain("without producing an answer");
  });

  it("replies with guidance when the project is not a runnable agent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, posted } = makeSlackFake();
    const deps = makeDeps([], slack);
    deps.projects = { get: async () => null } as unknown as ProjectRepository;

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(posted[0]?.text).toContain("Agent project not available");
  });

  it("reads the thread before writing anything of its own", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, calls, replies } = makeSlackFake();
    replies.push(
      { ts: "0.9", user: "U1", text: "<@U0> earlier question" },
      { ts: "0.95", bot_id: "B0", user: "U0", text: "earlier answer" },
    );
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.9" } },
      BINDING,
    );

    // The channel's progress opens the stream and the answer closes it — the
    // read still comes before either. The pickup reaction sits between them and
    // is harmless there: it writes no message, so nothing it does can end up in
    // the history this run was assembled from.
    // One close, carrying the unfinished rows and the last of the answer
    // together — both are chunks on a channel, so they fit in one call.
    expect(calls).toEqual(["session:processing", "threadReplies", "addReaction", "startStream", "stopStream", "session:active"]);
    expect(seen.map((m) => m.content)).toEqual([
      "earlier question",
      "earlier answer",
      "hello",
    ]);
  });

  it("keeps the newest turns of a long thread", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, replies } = makeSlackFake();
    for (let turn = 1; turn <= 60; turn += 1) {
      replies.push({ ts: `0.${turn}`, user: "U1", text: `turn ${turn}` });
    }
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.1" } },
      BINDING,
    );

    // 50 most recent turns plus the current message — the oldest are dropped,
    // never the newest.
    expect(seen).toHaveLength(51);
    expect(seen[0]?.content).toBe("turn 11");
    expect(seen.at(-2)?.content).toBe("turn 60");
    expect(seen.at(-1)?.content).toBe("hello");
  });

  it("answers a file_share message instead of dropping it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    const deps = makeDeps([], slack);
    let ran = false;
    deps.runAgent = async function* () {
      ran = true;
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          type: "message",
          channel_type: "im",
          subtype: "file_share",
          channel: "C1",
          ts: "1.0",
          text: "look at this",
        },
      },
      BINDING,
    );

    expect(ran).toBe(true);
  });

  it("runs an alerting app's keyword message on everything it said, signed with the app's name", async () => {
    // What reached the route was already classified as a keyword run; what the
    // handler owes it is the alert itself — title and body live in the
    // attachment, `text` is empty — and who said it, so the model does not
    // read an alert as words a person typed.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, calls } = makeSlackFake();
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        authorizations: [{ user_id: "UBOT", is_bot: true }],
        event: {
          type: "message",
          subtype: "bot_message",
          channel_type: "channel",
          channel: "C1",
          ts: "1.0",
          bot_id: "B_GRAFANA",
          username: "Grafana",
          text: "",
          attachments: [
            {
              title: "[FIRING:1] Container OOMKilled (sample-node OOMKilled warning)",
              text: "container sample-node was OOMKilled",
              fallback: "[FIRING:1] Container OOMKilled (sample-node OOMKilled warning)",
            },
          ],
        },
      },
      BINDING,
    );

    expect(seen.map((m) => m.content)).toEqual([
      "Grafana: [FIRING:1] Container OOMKilled (sample-node OOMKilled warning)\ncontainer sample-node was OOMKilled",
    ]);
    // Picked up and answered like any channel message: the reaction lands on
    // the alert, and the reply streams into a thread under it.
    expect(calls).toEqual(["session:processing", "addReaction", "startStream", "stopStream", "session:active"]);
  });

  it("answers without history when the thread read fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.threadReplies = async () => {
      throw new Error("replies boom");
    };
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.9" } },
      BINDING,
    );

    expect(finalText()).toContain("answer");
    expect(finalText()).toContain(":warning:");
  });

  it("sends an attached image to the agent as a content part", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, downloads } = makeSlackFake();
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          text: "<@U0> what is this?",
          files: [
            {
              id: "F1",
              name: "shot.png",
              mimetype: "image/png",
              size: 9,
              url_private_download: "https://files.slack.com/f/F1",
            },
          ],
        },
      },
      BINDING,
    );

    expect(downloads).toEqual(["https://files.slack.com/f/F1"]);
    expect(seen.at(-1)?.content).toEqual([
      { type: "text", text: "what is this?" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` },
      },
    ]);
  });

  it("runs an image-only message without an empty text part", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          text: "",
          files: [{ mimetype: "image/jpeg", url_private: "https://files.slack.com/f/F2" }],
        },
      },
      BINDING,
    );

    expect(seen.at(-1)?.content).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${Buffer.from("png-bytes").toString("base64")}` },
      },
    ]);
  });

  it("reports oversized, unsupported and non-image attachments instead of dropping them", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText, downloads } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          files: [
            {
              name: "huge.png",
              mimetype: "image/png",
              size: 6 * 1024 * 1024,
              url_private_download: "https://files.slack.com/f/huge",
            },
            {
              name: "art.svg",
              mimetype: "image/svg+xml",
              url_private_download: "https://files.slack.com/f/svg",
            },
            { name: "notes.pdf", mimetype: "application/pdf" },
            { name: "archive.zip", mimetype: "application/zip" },
          ],
        },
      },
      BINDING,
    );

    expect(downloads).toEqual([]);
    expect(finalText()).toContain("answer");
    expect(finalText()).toContain("larger than 5MB");
    expect(finalText()).toContain("Unsupported image type image/svg+xml");
    // The PDF is a document now, so it is attempted and reported on its own
    // terms — Slack gave this one no download url. Calling it "ignored" would
    // describe a decision this no longer makes.
    expect(finalText()).toContain("Attachment has no download url (notes.pdf)");
    // The zip is the only thing left that nothing here can read.
    expect(finalText()).toContain("Ignored 1 attachment(s)");
  });

  it("keeps answering when an attachment download fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.downloadFile = async () => {
      throw new Error("unexpected host: evil.example.com");
    };
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { delta: { content: "answer" } };
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          files: [{ mimetype: "image/png", url_private_download: "https://evil.example.com/x" }],
        },
      },
      BINDING,
    );

    expect(seen.at(-1)?.content).toBe("hello");
    expect(finalText()).toContain("Could not read attachment");
  });

  it("carries an image from an earlier thread turn into the run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, replies, downloads } = makeSlackFake();
    replies.push(
      {
        ts: "0.9",
        user: "U1",
        text: "<@U0> here is the picture",
        files: [{ id: "F1", mimetype: "image/png", url_private_download: "https://files.slack.com/f/F1" }],
      },
      { ts: "0.95", bot_id: "B0", user: "U0", text: "nice picture" },
    );
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.9", text: "<@U0> make it blue" } },
      BINDING,
    );

    expect(downloads).toEqual(["https://files.slack.com/f/F1"]);
    const dataUrl = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
    // The picture stays on the turn that sent it, ahead of the new instruction.
    expect(seen).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "here is the picture" },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
      { role: "assistant", content: "nice picture" },
      { role: "user", content: "make it blue" },
    ]);
  });

  it("never attaches the bot's own uploaded image to its assistant turn", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, replies, downloads } = makeSlackFake();
    // The bot answered an earlier mention by uploading a picture. Slack reports
    // that share as a thread message with files, and an assistant message can
    // only carry text — image parts on it are rejected by the provider.
    replies.push({
      ts: "0.95",
      bot_id: "B0", user: "U0",
      text: "",
      files: [{ id: "OWN", mimetype: "image/png", url_private_download: "https://files.slack.com/f/OWN" }],
    });
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.9", text: "<@U0> make it blue" } },
      BINDING,
    );

    // Not downloaded at all: the budget belongs to the user's pictures.
    expect(downloads).toEqual([]);
    expect(seen).toEqual([
      { role: "assistant", content: "" },
      { role: "user", content: "make it blue" },
    ]);
  });

  it("keeps answering after a subagent error chunk", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    // An authored error is a refused transfer reported to the parent as a tool
    // error; the parent goes on to answer and that answer must be delivered.
    const deps = makeDeps(
      [
        { author: "simple-image", error: "images cannot be transferred to it" },
        { delta: { content: "I drew it myself instead." } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toContain("I drew it myself instead.");
    expect(finalText()).toContain(":warning: images cannot be transferred to it");
  });

  it("spends the image budget on the current message before the thread", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, replies, downloads } = makeSlackFake();
    const file = (id: string) => ({
      id,
      mimetype: "image/png",
      url_private_download: `https://files.slack.com/f/${id}`,
    });
    replies.push({ ts: "0.9", user: "U1", text: "older", files: [file("OLD")] });
    const deps = makeDeps([], slack);
    deps.runAgent = async function* () {
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          thread_ts: "0.9",
          subtype: "file_share",
          files: [file("N1"), file("N2"), file("N3"), file("N4")],
        },
      },
      BINDING,
    );

    // Four images on this message exhaust the budget, so the older one is not fetched.
    expect(downloads).toEqual([
      "https://files.slack.com/f/N1",
      "https://files.slack.com/f/N2",
      "https://files.slack.com/f/N3",
      "https://files.slack.com/f/N4",
    ]);
  });

  it("passes a live deadline signal into the run", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    const deps = makeDeps([], slack);
    let seen: AbortSignal | undefined;
    deps.runAgent = async function* (input) {
      seen = input.signal;
      yield { done: true };
    };

    await handleSlackEvent(deps, EVENT, BINDING);

    // A wall-clock signal, not a chunk-arrival poll: a run that stops producing
    // chunks entirely still gets aborted.
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });
});

/**
 * Slack's agent surface expects a streamed reply: the message is opened once
 * and grown with deltas, which it renders as text arriving rather than as a
 * message being rewritten. That is the DM transport — a channel thread opens
 * with a progress note instead, which only an edit can replace.
 */
describe("streaming a Slack reply", () => {
  it("opens the stream once and sends deltas, not the whole answer", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Far apart enough that every push clears the pacing interval.
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, appended, calls, finalText } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { content: "Once " } },
        { delta: { content: "upon " } },
        { delta: { content: "a time." } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    expect(calls.filter((call) => call === "startStream")).toHaveLength(1);
    expect(calls).toContain("stopStream");
    expect(calls).not.toContain("updateMessage");
    // Each write carries only what is new; the reader sees them concatenated.
    expect(appended).toEqual(["Once ", "upon ", "a time."]);
    expect(finalText()).toBe("Once upon a time.");
  });

  it("names the recipient when a channel reply falls through to streaming", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, streamStarts } = makeSlackFake();
    // With the progress note unpostable the sink stays unopened, so the answer
    // opens it — the one path left that streams into a channel.
    slack.postMessage = async () => {
      throw new Error("nope");
    };
    const deps = makeDeps([{ delta: { content: "hi" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...EVENT, team_id: "T9", event: { ...EVENT.event, user: "U7" } },
      BINDING,
    );

    // Slack requires both to stream anywhere other than a DM.
    expect(streamStarts[0]).toMatchObject({ recipient_user_id: "U7", recipient_team_id: "T9" });
  });

  it("reports a channel run's progress on the stream's task axis", async () => {
    // The two axes are the whole point. Progress goes on the task timeline,
    // which Slack renders and animates; the answer streams into the same
    // message's text. Before this, progress *was* the text — which forced the
    // message open as a plain post and cost the run its stream.
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, posted, tasks, appended, streamStarts, calls } = makeSlackFake();
    const deps = makeDeps(
      [
        // A tool-only stretch: what would leave the thread with nothing at
        // all until the answer arrived.
        { delta: { toolCalls: [{ id: "c_search", function: { name: "search" } }] } },
        // The result is the completion boundary, and it names what the call
        // acted on — which the call itself never does.
        { toolResult: { toolCallId: "c_search", name: "web: search", content: "3 hits" } },
        { delta: { content: "found it" } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    // One message, and it is a stream rather than a posted note.
    expect(posted).toHaveLength(0);
    expect(streamStarts).toHaveLength(1);
    expect(streamStarts[0]).toMatchObject({ task_display_mode: "timeline" });
    // A checklist: the ambient row while the run is deciding, then a row per
    // step, each opened when the call is announced and ticked off when its
    // result arrives. The ambient row closes as soon as there is something
    // specific to list, so nothing spins above a list that is visibly moving.
    expect(tasks).toEqual([
      { id: "run-progress", title: "is thinking…", status: "in_progress" },
      { id: "run-progress", title: "is thinking…", status: "complete" },
      // Keyed by the tool, not the call: reaching for the same one twice is one
      // row saying twice.
      { id: "search", title: "search", status: "in_progress" },
      { id: "search", title: "web: search", status: "complete" },
    ]);
    // The answer never mentions the progress: it is the other axis.
    expect(appended.join("")).toBe("found it");
    // A channel thread has no status line, so nothing is spent trying to set one.
    expect(calls).not.toContain("setStatus");
  });

  it("reacts to the message it picked up, before anything else", async () => {
    // The only acknowledgement that lands on the message the person wrote. It
    // matters most where nothing was addressed to the bot explicitly — a
    // thread follow-up, a keyword — and there is no reason to assume it heard.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, reactions, calls } = makeSlackFake();

    await handleSlackEvent(deps0(slack), EVENT, BINDING);

    expect(reactions).toEqual([{ channel: "C1", ts: "1.0", name: "eyes" }]);
    // Ahead of the run's own output: it is the cheaper of the two signals and
    // lands where the person is already looking.
    expect(calls.indexOf("addReaction")).toBeLessThan(calls.indexOf("startStream"));
  });

  it("does not react in a DM, which says it another way", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, reactions, statuses } = makeSlackFake();

    await handleSlackEvent(deps0(slack), DM_EVENT, BINDING);

    // Every message in a DM is for the bot, and the thread has a status line.
    expect(reactions).toEqual([]);
    expect(statuses[0]).toBe("is thinking…");
  });

  it("still answers when the reaction is refused", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.addReaction = async () => {
      throw new Error("missing_scope");
    };
    const deps = makeDeps([{ delta: { content: "here you go" } }, { done: true }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    // The run answering is a louder acknowledgement than the one that failed,
    // so it is not even reported as a warning in the reply.
    expect(finalText()).toBe("here you go");
  });

  it("keeps a subagent's tools off the channel checklist", async () => {
    // The parent's own transfer row stands for the whole hand-off. Listing the
    // child's calls as well is the same thing said again, once per call — which
    // is what made a tool-heavy run unreadable.
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, tasks } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { toolCalls: [{ id: "c_t", function: { name: "transfer_to_agent" } }] } },
        {
          author: "researcher",
          delta: { toolCalls: [{ id: "c_1", function: { name: "SlackHistory" } }] },
        },
        {
          author: "researcher",
          toolResult: { toolCallId: "c_1", name: "SlackHistory", content: "..." },
        },
        {
          toolResult: { toolCallId: "c_t", name: "transfer_to_agent: researcher", content: "..." },
        },
        { delta: { content: "here it is" } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    const steps = tasks.filter((task) => task.id !== "run-progress");
    expect(steps).toEqual([
      { id: "transfer_to_agent", title: "transfer_to_agent", status: "in_progress" },
      {
        id: "transfer_to_agent",
        title: "transfer_to_agent: researcher",
        status: "complete",
      },
    ]);
  });

  it("still moves a DM's status line while a subagent works", async () => {
    // One line cannot accumulate, and during a long hand-off the child's tools
    // are the only thing still moving. A status that stops moving is how a
    // working run comes to look like a stuck one.
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps(
      [
        {
          author: "researcher",
          delta: { toolCalls: [{ id: "c_1", function: { name: "SlackHistory" } }] },
        },
        { delta: { content: "here it is" } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    expect(statuses).toContain("is using researcher: SlackHistory…");
  });

  it("falls back to a text note where the workspace cannot stream", async () => {
    // The task axis lives on the stream, so a workspace without one keeps the
    // note it always had rather than losing progress entirely.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, posted, updates, tasks } = makeSlackFake({ streaming: false });
    const deps = makeDeps(
      [
        { delta: { toolCalls: [{ id: "c_search", function: { name: "search" } }] } },
        { delta: { content: "found it" } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(tasks).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.text).toContain("is thinking…");
    // Every later write lands on that same message, and the answer replaces it.
    expect(updates.every((update) => update.ts === "100.1")).toBe(true);
    expect(updates.map((update) => update.text)).toContainEqual(
      expect.stringContaining("is using search…"),
    );
    expect(updates.at(-1)?.text).toBe("found it");
  });

  it("omits the recipient in a DM", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, streamStarts } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "hi" } }, { done: true }], slack);

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    expect(streamStarts[0]?.recipient_user_id).toBeUndefined();
  });

  it("re-sends a delta Slack rejected instead of losing it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, finalText } = makeSlackFake();
    const original = slack.appendStream.bind(slack);
    let attempt = 0;
    slack.appendStream = async (token, args) => {
      attempt += 1;
      // The second write fails. A stream sends each delta once, so without
      // re-sending it that fragment would never reach the reader.
      if (attempt === 2) {
        throw new Error("append boom");
      }
      return original(token, args);
    };
    const deps = makeDeps(
      [
        { delta: { content: "alpha " } },
        { delta: { content: "beta " } },
        { delta: { content: "gamma" } },
        { done: true },
      ],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toBe("alpha beta gamma");
  });
});

/**
 * A DM is an agent thread: Slack renders a status line under it and lets the
 * thread be named. A channel mention has neither.
 */
/**
 * Who the run is answering. Opt-in per Agent, because a real person's name in
 * the prompt is not something PII filtering masks.
 */
describe("telling the run who is asking", () => {
  function withCallerContext(deps: SlackEventDeps, on: boolean) {
    deps.projects = withConfigurations(deps.projects, async () => ({
        ...configurationFixture(),
        parameters: { piiFiltering: false, callerContext: on },
      }));
  }

  it("looks up nobody when the Agent did not ask", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profileLookups } = makeSlackFake();
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, false);
    let seenCaller: unknown;
    deps.runAgent = async function* (input) {
      seenCaller = input.caller;
      yield { done: true };
    };

    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U1" } }, BINDING);

    // The opt-in gates the lookup, not just the prompt — a project that did not
    // ask should not be sending anyone's id to Slack's profile API either.
    expect(profileLookups).toEqual([]);
    expect(seenCaller).toBeUndefined();
  });

  it("passes the resolved caller into the run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profiles } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce", timezone: "Asia/Seoul" });
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);
    let seenCaller: RunCaller | undefined;
    deps.runAgent = async function* (input) {
      seenCaller = input.caller;
      yield { done: true };
    };

    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U1" } }, BINDING);

    expect(seenCaller).toEqual({ displayName: "Bruce", timezone: "Asia/Seoul" });
  });

  it("answers anyway when the profile cannot be resolved", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);
    withCallerContext(deps, true);

    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U9" } }, BINDING);

    // A name is a nicety; losing it must not lose the reply.
    expect(finalText()).toBe("answer");
  });

  it("answers anyway when the profile lookup fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.userProfile = async () => {
      throw new Error("users.info unavailable");
    };
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);
    withCallerContext(deps, true);

    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U9" } }, BINDING);

    expect(finalText()).toBe("answer");
  });

  it("labels speakers once a second human joins the thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profiles, replies } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce" });
    profiles.set("U2", { displayName: "Dana" });
    replies.push(
      { ts: "0.9", user: "U1", text: "what does this cost?" },
      { ts: "0.92", bot_id: "B0", user: "U0", text: "about ten dollars" },
      { ts: "0.94", user: "U2", text: "per day or per month?" },
    );
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "0.9", user: "U1" } },
      BINDING,
    );

    // Every turn is `role: "user"` whoever typed it, so without a label a
    // three-way conversation reaches the model as one person's monologue — and
    // the newest turn is labelled on the same terms, or the model is invited to
    // attribute the question to whoever spoke last.
    expect(seen.map((message) => message.content)).toEqual([
      "Bruce: what does this cost?",
      "about ten dollars",
      "Dana: per day or per month?",
      "Bruce: hello",
    ]);
  });

  it("acknowledges the message before it starts resolving anybody", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, calls, profiles } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce" });
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);

    await handleSlackEvent(deps, { ...DM_EVENT, event: { ...DM_EVENT.event, user: "U1" } }, BINDING);

    // A cold profile cache is several round trips, and making the user wait for
    // them before anything acknowledges the message is exactly what the status
    // line exists to prevent.
    expect(calls.indexOf("setStatus")).toBeLessThan(calls.indexOf("userProfile"));
  });

  it("resolves only the speakers that survived the history slice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, replies, profileLookups } = makeSlackFake();
    // Older than the 50 turns the run carries, so their names would never be
    // used — and a lookup for them is a Slack round trip bought for nothing.
    for (let index = 0; index < 60; index += 1) {
      replies.push({ ts: `0.${index}`, user: `U-old-${index}`, text: `turn ${index}` });
    }
    replies.push({ ts: "0.99", user: "U2", text: "still here" });
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "0.0", user: "U1" } },
      BINDING,
    );

    expect(profileLookups).not.toContain("U-old-0");
    expect(profileLookups).toContain("U2");
    expect(profileLookups.length).toBeLessThanOrEqual(51);
  });

  it("bounds concurrent profile lookups for a multi-speaker thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, replies } = makeSlackFake();
    let active = 0;
    let maxActive = 0;
    slack.userProfile = async (_token, userId) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      return { displayName: userId };
    };
    for (let index = 0; index < MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS + 2; index += 1) {
      replies.push({ ts: `0.${index}`, user: `U${index}`, text: `turn ${index}` });
    }
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "0.0", user: "current" } },
      BINDING,
    );

    expect(maxActive).toBe(MAX_CONCURRENT_SLACK_PROFILE_LOOKUPS);
  });

  it("labels nothing when only one human is in the thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profiles, replies } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce" });
    replies.push(
      { ts: "0.9", user: "U1", text: "what does this cost?" },
      { ts: "0.92", bot_id: "B0", user: "U0", text: "about ten dollars" },
    );
    const deps = makeDeps([{ done: true }], slack);
    withCallerContext(deps, true);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "0.9", user: "U1" } },
      BINDING,
    );

    // A two-party conversation needs no labels; repeating one name on every
    // line would only spend context.
    expect(seen.map((message) => message.content)).toEqual([
      "what does this cost?",
      "about ten dollars",
      "hello",
    ]);
  });
});

describe("the native agent affordances", () => {
  it("reports thinking, then each tool, and clears the status at the end", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { toolCalls: [{ id: "c_search", function: { name: "search" } }] } },
        { delta: { toolCalls: [{ id: "c_fetch", function: { name: "fetch" } }] } },
        { delta: { content: "done" } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    // Every tool is named, not just the first: the status line costs no room in
    // the answer, unlike overwriting the message body.
    expect(statuses).toEqual(["is thinking…", "is using search…", "is using fetch…", ""]);
  });

  it("names every tool a single chunk announced", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps(
      [
        // A model fanning calls out in one response puts them side by side here.
        {
          delta: {
            toolCalls: [
              { id: "c_search", function: { name: "search" } },
              { id: "c_fetch", function: { name: "fetch" } },
            ],
          },
        },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    // Both, as two steps rather than one joined line: a model that fans out
    // calls in one response puts them side by side in this array, and reading
    // index 0 alone reported one of them and hid the rest. They are separate
    // units of work, so they finish separately too.
    expect(statuses).toContain("is using search…");
    expect(statuses).toContain("is using fetch…");
  });

  it("does not drop a tool that follows hard on the previous one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Same millisecond throughout: a paced status would drop the second name
    // and then leave the first one on screen for the rest of the run.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { toolCalls: [{ id: "c_search", function: { name: "search" } }] } },
        { delta: { toolCalls: [{ id: "c_fetch", function: { name: "fetch" } }] } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    expect(statuses).toEqual([
      "is thinking…",
      "is using search…",
      "is using fetch…",
      "",
    ]);
  });

  it("leaves the status alone in a channel, which has none", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "hi" } }, { done: true }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(statuses).toEqual([]);
  });

  it("names a new DM thread after the question that opened it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, titles } = makeSlackFake();
    const deps = makeDeps([{ done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, text: "how do I rotate the key?" } },
      BINDING,
    );

    expect(titles).toEqual([
      { channel_id: "D1", thread_ts: "1.0", title: "how do I rotate the key?" },
    ]);
  });

  it("does not rename a thread that already has turns", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, titles, replies } = makeSlackFake();
    replies.push({ ts: "0.9", user: "U1", text: "the first question" });
    const deps = makeDeps([{ done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "0.9" } },
      BINDING,
    );

    expect(titles).toEqual([]);
  });

  it("names new channel sessions as well as DMs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, titles } = makeSlackFake();

    await handleSlackEvent(makeDeps([{ done: true }], slack), EVENT, BINDING);

    expect(titles).toEqual([{ channel_id: "C1", thread_ts: "1.0", title: "hello" }]);
  });
});

/**
 * Not every workspace can stream. There the reply is one message edited in
 * place, so an interim state looks exactly like a finished one — a reader
 * arriving mid-run sees a complete-looking answer that stops mid-sentence. The
 * marker is what tells them it is still going, and it must not survive into the
 * final edit. A streamed reply needs none: Slack marks it itself.
 */
describe("falling back when a workspace cannot stream", () => {
  const chunks = [
    { delta: { content: "생각" } },
    { delta: { content: " 중" } },
    { done: true },
  ] as EngineChunk[];

  function advancingClock() {
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 5000));
  }

  it("posts and edits one message, marking every state but the last", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    advancingClock();
    const { slack, posted, updates } = makeSlackFake({ streaming: false });

    await handleSlackEvent(makeDeps(chunks, slack), EVENT, BINDING);

    expect(posted[0]?.text).toContain(":hourglass_flowing_sand:");
    expect(updates[0]?.text).toContain(":hourglass_flowing_sand:");
    expect(updates.at(-1)?.text).toBe("생각 중");
  });

  it("uses whatever the deployment configured instead", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    advancingClock();
    const { slack, posted } = makeSlackFake({ streaming: false });
    const deps = makeDeps(chunks, slack);
    deps.loadingIndicator = ":loading:";

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(posted[0]?.text).toContain(":loading:");
    expect(posted[0]?.text).not.toContain(":hourglass_flowing_sand:");
  });

  it("carries no marker when the reply did stream", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    advancingClock();
    const { slack, appended } = makeSlackFake();

    await handleSlackEvent(makeDeps(chunks, slack), DM_EVENT, BINDING);

    expect(appended.join("")).toBe("생각 중");
  });
});

/**
 * Documents attached in Slack. Before this they were dropped with a warning that
 * said the file was "ignored" — a Slack file lives behind `url_private` and needs
 * this bot's token, so no URL-fetching tool could stand in for reading it either.
 */
describe("a document attached to a Slack message", () => {
  it("reaches the run as text, ahead of the question it is about", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    slack.downloadFile = async () => Buffer.from("Q3 revenue rose 12%", "utf-8");
    const deps = makeDeps([], slack);
    let seen: ChatMessageInput[] = [];
    deps.runAgent = async function* (input) {
      seen = [...input.messages];
      yield { delta: { content: "answer" } };
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          files: [
            {
              name: "q3.pdf",
              mimetype: "application/pdf",
              url_private_download: "https://files.slack.com/f/q3",
            },
          ],
        },
      },
      BINDING,
    );

    const content = seen.at(-1)?.content;
    // A turn with no image stays a plain string: only images make a content-parts
    // array necessary, and only images are gated on the model accepting one.
    expect(typeof content).toBe("string");
    const text = content as string;
    expect(text).toContain('[Attached file "q3.pdf"');
    expect(text).toContain("Q3 revenue rose 12%");
    // The long context leads and the ask follows it.
    expect(text.indexOf("Q3 revenue rose 12%")).toBeLessThan(text.indexOf("hello"));
    expect(text.endsWith("hello")).toBe(true);
  });

  it("keeps answering, and says why, when the document cannot be read", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.downloadFile = async () => Buffer.from("scanned", "utf-8");
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);
    deps.documents = { extract: async () => {
        throw new DocumentExtractionError("it has 3 page(s) but no extractable text layer");
      } };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          files: [
            {
              name: "scan.pdf",
              mimetype: "application/pdf",
              url_private_download: "https://files.slack.com/f/scan",
            },
          ],
        },
      },
      BINDING,
    );

    expect(finalText()).toContain("answer");
    expect(finalText()).toContain("Could not read scan.pdf");
    expect(finalText()).toContain("no extractable text layer");
  });

  it("does not dispatch an empty turn when a file-only message yields nothing", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.downloadFile = async () => Buffer.from("scanned", "utf-8");
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);
    deps.documents = { extract: async () => {
        throw new DocumentExtractionError("it has 3 page(s) but no extractable text layer");
      } };
    let dispatched = 0;
    const run = deps.runAgent;
    deps.runAgent = (input) => {
      dispatched += 1;
      return run(input);
    };

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          // No words at all — the file was the whole message.
          text: "<@U0>",
          subtype: "file_share",
          files: [
            {
              name: "scan.pdf",
              mimetype: "application/pdf",
              url_private_download: "https://files.slack.com/f/scan",
            },
          ],
        },
      },
      BINDING,
    );

    // An empty user turn is rejected by providers or answered from nothing.
    expect(dispatched).toBe(0);
    // The reason is the whole answer, and it still reaches the thread.
    expect(finalText()).toContain("no extractable text layer");
    expect(finalText()).not.toContain("agent run failed");
  });

  it("refuses a document past the size cap without downloading it", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, downloads, finalText } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        event: {
          ...EVENT.event,
          subtype: "file_share",
          files: [
            {
              name: "huge.pdf",
              mimetype: "application/pdf",
              size: 11 * 1024 * 1024,
              url_private_download: "https://files.slack.com/f/huge",
            },
          ],
        },
      },
      BINDING,
    );

    expect(downloads).toEqual([]);
    expect(finalText()).toContain("larger than 10MB");
  });
});

/**
 * A picture the run only *read* — one `FetchUrl` brought back. Each Slack upload
 * is its own message and its own notification, so posting the source material
 * beside the drawing made from it turns one answer into two pictures.
 */
describe("uploading what the run read", () => {
  it("posts only the drawing when the run made one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, uploads } = makeSlackFake();
    const deps = makeDeps(
      [
        { image: { b64: "c3Jj", mimeType: "image/png", fetched: true, prompt: "Returned by FetchUrl" } },
        { image: { b64: "ZHJhdw==", mimeType: "image/png", prompt: "a crude doodle" } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(uploads.map((upload) => upload.title)).toEqual(["a crude doodle"]);
  });

  it("posts it when it is all the run has to show", async () => {
    // "Show me the image at this address" is answered by exactly this.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, uploads } = makeSlackFake();
    const deps = makeDeps(
      [
        { image: { b64: "c3Jj", mimeType: "image/png", fetched: true, prompt: "Returned by FetchUrl" } },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(uploads).toHaveLength(1);
  });
});

/**
 * Whose gallery a run's output lands in.
 *
 * A Slack actor is a workspace id, and the artifact owner index is keyed by
 * email — so a picture somebody asked the bot to draw was reachable only through
 * its project, never from their own gallery. The surface can resolve the
 * address, so it does.
 */
describe("filing a Slack run's output under its author", () => {
  it("carries the asker's address to the run", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, emails } = makeSlackFake();
    emails.set("U1", "me@nalbam.com");
    const deps = deps0(slack);
    let seen: { ownerEmail?: string; actor?: { kind: string; id: string } } = {};
    deps.runAgent = async function* (input) {
      seen = input;
      yield { done: true };
    };

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, user: "U1" } },
      BINDING,
    );

    expect(seen.ownerEmail).toBe("me@nalbam.com");
    // The actor is untouched: it groups usage by surface and decides which
    // tier's spend cap applies, which is a different question.
    expect(seen.actor).toEqual({ kind: "slack", id: "U1" });
  });

  it("files by project alone when the workspace shares no address", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack } = makeSlackFake();
    const deps = deps0(slack);
    let seen: { ownerEmail?: string } = {};
    deps.runAgent = async function* (input) {
      seen = input;
      yield { done: true };
    };

    await handleSlackEvent(deps, { ...EVENT, event: { ...EVENT.event, user: "U1" } }, BINDING);

    expect(seen.ownerEmail).toBeUndefined();
  });

  it("still answers when the address lookup fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    slack.userEmail = async () => {
      throw new Error("missing_scope");
    };
    const deps = makeDeps([{ delta: { content: "here you go" } }, { done: true }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(finalText()).toBe("here you go");
  });

  it("does not gate the lookup on callerContext, which decides a different thing", async () => {
    // `callerContext` decides what the *model* is told. This address reaches no
    // prompt and no tool result — a person's own pictures going missing from
    // their own gallery is not something a version parameter should cause.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, emails } = makeSlackFake();
    emails.set("U1", "me@nalbam.com");
    const deps = deps0(slack);
    deps.projects = withConfigurations(deps.projects, async () => ({ ...configurationFixture(), parameters: { piiFiltering: false } }));
    let seen: { ownerEmail?: string; caller?: unknown } = {};
    deps.runAgent = async function* (input) {
      seen = input;
      yield { done: true };
    };

    await handleSlackEvent(deps, { ...EVENT, event: { ...EVENT.event, user: "U1" } }, BINDING);

    expect(seen.caller).toBeUndefined();
    expect(seen.ownerEmail).toBe("me@nalbam.com");
  });
});

/**
 * A channel does not tell the bot which of its messages are for it, so the bot
 * writes down where it spoke. The event gate reads this back to let a follow-up
 * skip the mention; without the write, every turn in a channel needs one.
 */
describe("what the bot remembers about a channel thread", () => {
  it("records the thread it answered in", async () => {
    const { slack } = makeSlackFake();

    await handleSlackEvent(deps0(slack), EVENT, BINDING);

    // The mention opened a new thread rooted at its own ts, which is where the
    // reply went and therefore what a follow-up will carry as `thread_ts`.
    expect(engagements).toEqual([{ project: "painter", channel: "C1", threadTs: "1.0" }]);
  });

  it("records the existing thread when the mention was a reply", async () => {
    const { slack } = makeSlackFake();

    await handleSlackEvent(
      deps0(slack),
      { ...EVENT, event: { ...EVENT.event, ts: "2.0", thread_ts: "1.0" } },
      BINDING,
    );

    expect(engagements).toEqual([{ project: "painter", channel: "C1", threadTs: "1.0" }]);
  });

  it("records nothing for a DM, where every message is already for the bot", async () => {
    const { slack } = makeSlackFake();

    await handleSlackEvent(deps0(slack), DM_EVENT, BINDING);

    expect(engagements).toEqual([]);
  });

  it("records a reply that was only warnings", async () => {
    const { slack } = makeSlackFake();
    // The run failed and said so. That is still the bot holding the floor, and
    // "try without the attachment" is exactly the turn someone answers without
    // stopping to re-address it.
    const deps = makeDeps([{ error: "provider is unavailable" }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(engagements).toHaveLength(1);
  });

  it("still answers when the record cannot be written", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "here you go" } }, { done: true }], slack);
    deps.threads = {
      markEngaged: async () => {
        throw new Error("dynamo is down");
      },
      isEngaged: async () => false,
      setMuted: async () => {},
    };

    await handleSlackEvent(deps, EVENT, BINDING);

    // A lost record costs the next follow-up its mention-free reply. It must
    // not cost this run the answer it already produced.
    expect(finalText()).toContain("here you go");
  });
});

/**
 * A command is answered here rather than by a run: the answer is a constant, and
 * two of the three change *whether the bot speaks again* — which no amount of
 * prompting makes reliable. A person silencing a thread has to be obeyed.
 */
describe("commands", () => {
  /** `@bot !mute` sent as a reply inside an existing thread. */
  const inThread = (text: string): SlackEventBody => ({
    ...EVENT,
    event: { ...EVENT.event, ts: "2.0", thread_ts: "1.0", text: `<@U0> ${text}` },
  });

  it("mutes the thread it was sent in, and says so", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted, calls } = makeSlackFake();

    await handleSlackEvent(deps0(slack), inThread("!mute"), BINDING);

    expect(mutes).toEqual([{ threadTs: "1.0", muted: true }]);
    expect(posted[0]?.text).toContain("Muted");
    // No run at all: no stream, no reaction, no engagement record. A muted
    // thread that recorded engagement would unmute itself on the way out.
    expect(calls).toEqual(["postMessage"]);
    expect(engagements).toEqual([]);
  });

  it("unmutes the same way", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted } = makeSlackFake();

    await handleSlackEvent(deps0(slack), inThread("!unmute"), BINDING);

    expect(mutes).toEqual([{ threadTs: "1.0", muted: false }]);
    expect(posted[0]?.text).toContain("Unmuted");
  });

  it("points a top-level !mute at a thread rather than silently doing nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted } = makeSlackFake();

    // EVENT is a top-level mention: its reply opens a thread rooted at itself,
    // so muting here would silence a conversation before it existed.
    await handleSlackEvent(
      deps0(slack),
      { ...EVENT, event: { ...EVENT.event, text: "<@U0> !mute" } },
      BINDING,
    );

    expect(mutes).toEqual([]);
    expect(posted[0]?.text).toContain("Muting works per thread");
  });

  it("says muting means nothing in a DM rather than confirming it", async () => {
    // The gate answers every DM without consulting engagement at all, so a mute
    // recorded here would be a flag nothing reads and a confirmation that was
    // never true.
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted } = makeSlackFake();

    await handleSlackEvent(
      deps0(slack),
      { ...DM_EVENT, event: { ...DM_EVENT.event, thread_ts: "1.0", text: "!mute" } },
      BINDING,
    );

    expect(mutes).toEqual([]);
    expect(posted[0]?.text).toContain("channel threads");
  });

  it("lists the commands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted } = makeSlackFake();

    await handleSlackEvent(deps0(slack), inThread("!help"), BINDING);

    expect(posted[0]?.text).toContain("`!mute`");
    expect(mutes).toEqual([]);
  });

  it("treats a message that merely contains the word as an ordinary request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, finalText } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "sure" } }, { done: true }], slack);

    await handleSlackEvent(deps, inThread("!mute this thread please"), BINDING);

    expect(mutes).toEqual([]);
    expect(finalText()).toBe("sure");
  });

  it("says a mute it could not save was not saved", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, posted } = makeSlackFake();
    const deps = deps0(slack);
    deps.threads = {
      markEngaged: async () => {},
      isEngaged: async () => false,
      setMuted: async () => {
        throw new Error("dynamo is down");
      },
    };

    await handleSlackEvent(deps, inThread("!mute"), BINDING);

    // A person not told it failed will read the next reply as being ignored.
    expect(posted[0]?.text).toContain("could not save");
  });
});

describe("private project visibility gate", () => {
  const privateProject = (): Project => ({
    ...projectFixture(),
    configuration: configurationFixture(),
    visibility: "private",
    memberEmails: ["invited@x.com"],
  });
  const withUser = (user: string): SlackEventBody => ({
    event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
    event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@U0> hello", user },
  });
  const privateDeps = (slack: SlackClientPort) => {
    const deps = deps0(slack);
    deps.projects = { get: async () => privateProject() } as unknown as ProjectRepository;
    return deps;
  };

  it("refuses a workspace user the project does not invite, before any acknowledgement", async () => {
    const { slack, posted, reactions, emails } = makeSlackFake();
    emails.set("U2", "stranger@x.com");

    await handleSlackEvent(privateDeps(slack), withUser("U2"), BINDING);

    expect(posted.at(-1)?.text).toContain("private");
    // Refused before the pickup reaction and before the thread was engaged.
    expect(reactions).toHaveLength(0);
    expect(engagements).toHaveLength(0);
  });

  it("refuses when the workspace shares no email for the asker", async () => {
    const { slack, posted } = makeSlackFake();

    await handleSlackEvent(privateDeps(slack), withUser("U2"), BINDING);

    expect(posted.at(-1)?.text).toContain("private");
  });

  it("runs an app-authored message — owner-wired automation, not a person to refuse", async () => {
    const { slack, posted, reactions } = makeSlackFake();
    const event: SlackEventBody = {
      event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
      event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@U0> hello", bot_id: "B9" },
    };

    await handleSlackEvent(privateDeps(slack), event, BINDING);

    expect(reactions).toHaveLength(1);
    expect(posted.every((message) => !message.text.includes("private"))).toBe(true);
  });

  it("refuses a userless message that no app signed either", async () => {
    const { slack, posted } = makeSlackFake();
    const event: SlackEventBody = {
      event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
      event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@U0> hello" },
    };

    await handleSlackEvent(privateDeps(slack), event, BINDING);

    expect(posted.at(-1)?.text).toContain("private");
  });

  it("refuses an uninvited user's !mute before it writes engagement state", async () => {
    const { slack, posted, emails } = makeSlackFake();
    emails.set("U2", "stranger@x.com");
    const event: SlackEventBody = {
      event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "2.0",
        thread_ts: "1.0",
        text: "<@U0> !mute",
        user: "U2",
      },
    };

    await handleSlackEvent(privateDeps(slack), event, BINDING);

    expect(posted.at(-1)?.text).toContain("private");
    expect(mutes).toHaveLength(0);
  });

  it("still answers an invited member's !mute", async () => {
    const { slack, emails } = makeSlackFake();
    emails.set("U2", "invited@x.com");
    const event: SlackEventBody = {
      event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "2.0",
        thread_ts: "1.0",
        text: "<@U0> !mute",
        user: "U2",
      },
    };

    await handleSlackEvent(privateDeps(slack), event, BINDING);

    expect(mutes).toEqual([{ threadTs: "1.0", muted: true }]);
  });

  it("does not run a command when the project visibility cannot be read", async () => {
    const { slack, posted } = makeSlackFake();
    const deps = privateDeps(slack);
    deps.projects = {
      get: async () => {
        throw new Error("project store unavailable");
      },
    } as unknown as ProjectRepository;
    const event: SlackEventBody = {
      event_id: "Ev9",
      authorizations: [{ user_id: "U0", is_bot: true }],
      event: {
        type: "app_mention",
        channel: "C1",
        ts: "2.0",
        thread_ts: "1.0",
        text: "<@U0> !mute",
        user: "U2",
      },
    };

    await expect(handleSlackEvent(deps, event, BINDING)).rejects.toThrow(
      "project store unavailable",
    );

    expect(mutes).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it("answers an invited member, matching email case-insensitively", async () => {
    const { slack, posted, reactions, emails } = makeSlackFake();
    emails.set("U2", "Invited@X.com");

    await handleSlackEvent(privateDeps(slack), withUser("U2"), BINDING);

    // The gate let the turn through: the message was acknowledged and no
    // refusal was posted.
    expect(reactions).toHaveLength(1);
    expect(posted.every((message) => !message.text.includes("private"))).toBe(true);
  });

  it("answers the owner", async () => {
    const { slack, posted, reactions, emails } = makeSlackFake();
    emails.set("U2", "owner@x.com");

    await handleSlackEvent(privateDeps(slack), withUser("U2"), BINDING);

    expect(reactions).toHaveLength(1);
    expect(posted.every((message) => !message.text.includes("private"))).toBe(true);
  });

  it("leaves a public project's turns alone — no email lookup at the gate", async () => {
    const { slack, reactions } = makeSlackFake();

    await handleSlackEvent(deps0(slack), withUser("U2"), BINDING);

    expect(reactions).toHaveLength(1);
  });
});
