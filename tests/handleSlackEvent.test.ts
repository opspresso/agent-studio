import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackEvent,
  type SlackClientPort,
  type SlackEventBody,
  type SlackEventDeps,
} from "@/application/slack/handleSlackEvent";
import type { SlackMessage } from "@/infrastructure/slack/client";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { Project, Version } from "@/domain/project/types";
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

function makeSlackFake() {
  const posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const updates: Array<{ ts: string; text: string }> = [];
  const calls: string[] = [];
  const replies: SlackMessage[] = [];
  const downloads: string[] = [];
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
  };
  return { slack, posted, updates, calls, replies, downloads };
}

function makeDeps(chunks: EngineChunk[], slack: SlackClientPort): SlackEventDeps {
  return {
    runAgent: async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    projects: { get: async () => projectFixture() } as unknown as ProjectRepository,
    versions: {
      get: async (_project: string, name: string) => (name === "published" ? versionFixture() : null),
      list: async () => [],
    } as unknown as VersionRepository,
    slack,
  };
}

const EVENT: SlackEventBody = {
  event_id: "Ev1",
  event: { type: "app_mention", channel: "C1", ts: "1.0", text: "<@U0> hello" },
};

const BINDING = { projectName: "painter", botToken: "tok" };

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

  it("posts a placeholder and finalizes it with the top-level answer only", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, posted, updates } = makeSlackFake();
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

    expect(posted[0]?.text).toBe("_thinking…_");
    const finalText = updates.at(-1)?.text;
    expect(finalText).toBe("Hello there.");
    expect(updates.some((u) => u.text.includes("nested"))).toBe(false);
  });

  it("surfaces an engine error chunk in the final message", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { slack, updates } = makeSlackFake();
    const deps = makeDeps([{ error: "boom" }], slack);

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(updates.at(-1)?.text).toBe(":warning: boom");
  });

  it("keeps the streamed answer and appends the warning on a late failure", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, updates } = makeSlackFake();
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

    const finalText = updates.at(-1)?.text ?? "";
    expect(finalText).toContain("Here is your answer.");
    expect(finalText).toContain(":warning:");
  });

  it("replies with guidance when the project is not a runnable agent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, posted } = makeSlackFake();
    const deps = makeDeps([], slack);
    deps.projects = { get: async () => null } as unknown as ProjectRepository;

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(posted[0]?.text).toContain("Agent project not available");
  });

  it("reads the thread before posting its own placeholder", async () => {
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

  it("answers without history when the thread read fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, updates } = makeSlackFake();
    slack.threadReplies = async () => {
      throw new Error("replies boom");
    };
    const deps = makeDeps([{ delta: { content: "answer" } }, { done: true }], slack);

    await handleSlackEvent(
      deps,
      { ...EVENT, event: { ...EVENT.event, thread_ts: "0.9" } },
      BINDING,
    );

    const finalText = updates.at(-1)?.text ?? "";
    expect(finalText).toContain("answer");
    expect(finalText).toContain(":warning:");
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
    const { slack, updates, downloads } = makeSlackFake();
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
          ],
        },
      },
      BINDING,
    );

    expect(downloads).toEqual([]);
    const finalText = updates.at(-1)?.text ?? "";
    expect(finalText).toContain("answer");
    expect(finalText).toContain("larger than 5MB");
    expect(finalText).toContain("Unsupported image type image/svg+xml");
    expect(finalText).toContain("Ignored 1 non-image attachment");
  });

  it("keeps answering when an attachment download fails", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { slack, updates } = makeSlackFake();
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
    expect(updates.at(-1)?.text).toContain("Could not read attachment");
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
