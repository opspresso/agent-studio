import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSlackEvent } from "@/application/slack/handleSlackEvent";
import { DocumentExtractionError } from "@/domain/llm/documentExtractor";
import type {
  SlackClientPort,
  SlackEventBody,
  SlackEventDeps,
} from "@/application/slack/types";
import type { SlackMessage } from "@/infrastructure/slack/client";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
import type { RunCaller } from "@/domain/execution/actor";
import type { ProjectRepository, VersionRepository } from "@/domain/project/repository";

const NOW = 1_750_000_000_000;

function projectFixture(): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@x.com",
    publishedVersion: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function versionFixture(): Version {
  return {
    projectName: "painter",
    versionName: "1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * `streaming: false` makes `chat.startStream` fail, which is how a workspace
 * that cannot stream behaves — the handler is expected to fall back to posting
 * and editing one message.
 */
function makeSlackFake(options: { streaming?: boolean } = {}) {
  const streaming = options.streaming ?? true;
  const posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const streamStarts: Array<{
    channel: string;
    thread_ts: string;
    recipient_user_id?: string;
    recipient_team_id?: string;
  }> = [];
  /** Every delta Slack accepted, in order — the streamed message's contents. */
  const appended: string[] = [];
  const statuses: string[] = [];
  const titles: Array<{ channel_id: string; thread_ts: string; title: string }> = [];
  const calls: string[] = [];
  const replies: SlackMessage[] = [];
  const downloads: string[] = [];
  const profileLookups: string[] = [];
  const profiles = new Map<string, RunCaller>();
  const slack: SlackClientPort = {
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
    async uploadImage() {},
    async threadReplies() {
      calls.push("threadReplies");
      // Slack returns everything already in the thread — including whatever
      // this handler posted itself.
      return [
        ...replies,
        ...posted.map((message, index) => ({
          ts: `100.${index + 1}`,
          bot_id: "B0",
          text: message.text,
        })),
      ];
    },
    async startStream(_token, args) {
      calls.push("startStream");
      if (!streaming) {
        throw new Error("streaming is not available on this plan");
      }
      streamStarts.push(args);
      return { ts: "200.1", channel: args.channel };
    },
    async appendStream(_token, args) {
      calls.push("appendStream");
      appended.push(args.markdown_text);
    },
    async stopStream(_token, args) {
      calls.push("stopStream");
      if (args.markdown_text) {
        appended.push(args.markdown_text);
      }
    },
    async setStatus(_token, args) {
      calls.push("setStatus");
      statuses.push(args.status);
    },
    async setSuggestedPrompts() {},
    async setTitle(_token, args) {
      calls.push("setTitle");
      titles.push(args);
    },
    async userProfile(_token, userId) {
      calls.push("userProfile");
      profileLookups.push(userId);
      return profiles.get(userId) ?? null;
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
    appended,
    streamStarts,
    statuses,
    titles,
    calls,
    replies,
    downloads,
    profiles,
    profileLookups,
    finalText,
  };
}

function makeDeps(chunks: EngineChunk[], slack: SlackClientPort): SlackEventDeps {
  return {
    runAgent: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    // The real extractor has its own tests; here it only has to be the thing
    // that turns bytes into text, so a document's route through the handler is
    // what is under test.
    documents: {
      extract: async ({ bytes, name, maxChars }) => {
        const text = Buffer.from(bytes).toString("utf-8");
        return text.length <= maxChars
          ? { text }
          : { text: text.slice(0, maxChars), note: `the first ${maxChars} characters of ${name}` };
      },
    },
    projects: { get: async () => projectFixture() } as unknown as ProjectRepository,
    versions: {
      // The pointer is read off the project, so the fake answers its concrete name.
      get: async (_project: string, name: string) =>
        name === projectFixture().publishedVersion ? versionFixture() : null,
      list: async () => [],
    } as unknown as VersionRepository,
    slack,
  };
}

const EVENT: SlackEventBody = {
  event_id: "Ev1",
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

afterEach(() => {
  vi.restoreAllMocks();
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
        return projectFixture();
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
    const { slack, posted, finalText } = makeSlackFake();
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
    expect(posted).toEqual([]);
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
      { ts: "0.95", bot_id: "B0", text: "earlier answer" },
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

    expect(calls).toEqual(["threadReplies", "postMessage"]);
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

  it("still ignores bot messages and bookkeeping subtypes", async () => {
    const { slack, posted } = makeSlackFake();
    const deps = makeDeps([], slack);

    await handleSlackEvent(deps, { ...EVENT, event: { ...EVENT.event, bot_id: "B9" } }, BINDING);
    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, subtype: "message_changed" } },
      BINDING,
    );

    expect(posted).toEqual([]);
  });

  it("ignores its own file share, which carries no bot_id", async () => {
    // A file the bot uploads through the external flow is attributed to the bot
    // *user* and arrives as an allowed `file_share` subtype, so `bot_id` alone
    // would let the bot answer its own picture and loop.
    const { slack, posted } = makeSlackFake();
    const deps = makeDeps([], slack);

    await handleSlackEvent(
      deps,
      {
        ...EVENT,
        authorizations: [{ user_id: "UBOT", is_bot: true }],
        event: { ...EVENT.event, subtype: "file_share", user: "UBOT" },
      },
      BINDING,
    );

    expect(posted).toEqual([]);
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
      { ts: "0.95", bot_id: "B0", text: "nice picture" },
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
      bot_id: "B0",
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
 * message being rewritten.
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

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(calls.filter((call) => call === "startStream")).toHaveLength(1);
    expect(calls).toContain("stopStream");
    expect(calls).not.toContain("updateMessage");
    // Each write carries only what is new; the reader sees them concatenated.
    expect(appended).toEqual(["Once ", "upon ", "a time."]);
    expect(finalText()).toBe("Once upon a time.");
  });

  it("names the recipient when the thread is a channel", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, streamStarts } = makeSlackFake();
    const deps = makeDeps([{ delta: { content: "hi" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...EVENT, team_id: "T9", event: { ...EVENT.event, user: "U7" } },
      BINDING,
    );

    // Slack requires both to stream anywhere other than a DM.
    expect(streamStarts[0]).toMatchObject({ recipient_user_id: "U7", recipient_team_id: "T9" });
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
 * Who the run is answering. Opt-in per version, because a real person's name in
 * the prompt is not something PII filtering masks.
 */
describe("telling the run who is asking", () => {
  function withCallerContext(deps: SlackEventDeps, on: boolean) {
    deps.versions = {
      get: async () => ({
        ...versionFixture(),
        parameters: { piiFiltering: false, callerContext: on },
      }),
      list: async () => [],
    } as unknown as VersionRepository;
  }

  it("looks up nobody when the version did not ask", async () => {
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

  it("labels speakers once a second human joins the thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profiles, replies } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce" });
    profiles.set("U2", { displayName: "Dana" });
    replies.push(
      { ts: "0.9", user: "U1", text: "what does this cost?" },
      { ts: "0.92", bot_id: "B0", text: "about ten dollars" },
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

  it("labels nothing when only one human is in the thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, profiles, replies } = makeSlackFake();
    profiles.set("U1", { displayName: "Bruce" });
    replies.push(
      { ts: "0.9", user: "U1", text: "what does this cost?" },
      { ts: "0.92", bot_id: "B0", text: "about ten dollars" },
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
        { delta: { toolCalls: [{ function: { name: "search" } }] } },
        { delta: { toolCalls: [{ function: { name: "fetch" } }] } },
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
            toolCalls: [{ function: { name: "search" } }, { function: { name: "fetch" } }],
          },
        },
        { done: true },
      ] as EngineChunk[],
      slack,
    );

    await handleSlackEvent(deps, DM_EVENT, BINDING);

    expect(statuses).toContain("is using search, fetch…");
  });

  it("does not drop a tool that follows hard on the previous one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // Same millisecond throughout: a paced status would drop the second name
    // and then leave the first one on screen for the rest of the run.
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, statuses } = makeSlackFake();
    const deps = makeDeps(
      [
        { delta: { toolCalls: [{ function: { name: "search" } }] } },
        { delta: { toolCalls: [{ function: { name: "fetch" } }] } },
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

  it("does not name a channel thread", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, titles } = makeSlackFake();

    await handleSlackEvent(makeDeps([{ done: true }], slack), EVENT, BINDING);

    expect(titles).toEqual([]);
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

    await handleSlackEvent(makeDeps(chunks, slack), EVENT, BINDING);

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
    deps.documents = {
      extract: async () => {
        throw new DocumentExtractionError("it has 3 page(s) but no extractable text layer");
      },
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
    deps.documents = {
      extract: async () => {
        throw new DocumentExtractionError("it has 3 page(s) but no extractable text layer");
      },
    };
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
