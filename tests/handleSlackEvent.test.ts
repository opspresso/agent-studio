import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleSlackEvent,
  type SlackClientPort,
  type SlackEventBody,
  type SlackEventDeps,
} from "@/application/slack/handleSlackEvent";
import type { EngineChunk } from "@/domain/llm/types";
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
  const slack: SlackClientPort = {
    async postMessage(_token, args) {
      posted.push(args);
      return { ts: "100.1", channel: args.channel };
    },
    async updateMessage(_token, args) {
      updates.push(args);
      return { ts: args.ts };
    },
    async uploadImage() {},
    async threadReplies() {
      return [];
    },
  };
  return { slack, posted, updates };
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
      userMessage = input.messages.at(-1)?.content ?? undefined;
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

  it("replies with guidance when the project is not a runnable agent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { slack, posted } = makeSlackFake();
    const deps = makeDeps([], slack);
    deps.projects = { get: async () => null } as unknown as ProjectRepository;

    await handleSlackEvent(deps, EVENT, BINDING);

    expect(posted[0]?.text).toContain("Agent project not available");
  });
});
