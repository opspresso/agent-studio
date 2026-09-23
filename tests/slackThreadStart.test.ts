import { describe, expect, it, vi } from "vitest";
import { handleThreadStart, type ThreadStartDeps } from "@/application/slack/handleThreadStart";
import type { SlackClientPort, SlackEventBody } from "@/application/slack/types";
import type { Project } from "@/domain/project/types";
import type { ProjectRepository } from "@/domain/project/repository";
import type { SlackSuggestedPrompt } from "@/domain/slack/types";

const BINDING = { projectName: "painter", botToken: "tok" };

const PROMPTS: SlackSuggestedPrompt[] = [
  { title: "Draw", message: "Draw me a cat" },
  { title: "Explain", message: "Explain what you can do" },
];

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    name: "painter",
    displayName: "Painter",
    description: "Draws things on request.",
    ownerEmail: "owner@x.com",

    slack: { botToken: "enc", signingSecret: "enc", enabled: true, suggestedPrompts: PROMPTS },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(project: Project | null) {
  const posted: Array<{ channel: string; text: string; thread_ts?: string }> = [];
  const prompts: Array<{ channel_id: string; thread_ts?: string; prompts: SlackSuggestedPrompt[] }> =
    [];
  const slack = {
    async postMessage(_token: string, args: { channel: string; text: string; thread_ts?: string }) {
      posted.push(args);
      return { ts: "1.0", channel: args.channel };
    },
    async setSuggestedPrompts(
      _token: string,
      args: { channel_id: string; thread_ts?: string; prompts: SlackSuggestedPrompt[] },
    ) {
      prompts.push(args);
    },
  } as unknown as SlackClientPort;
  const deps: ThreadStartDeps = {
    projects: { get: async () => project } as unknown as ProjectRepository,
    slack,
  };
  return { deps, posted, prompts };
}

const HOME_OPENED: SlackEventBody = {
  event_id: "Ev1",
  event: { type: "app_home_opened", tab: "messages", channel: "D1", user: "U1" },
};

const LEGACY_THREAD_STARTED: SlackEventBody = {
  event_id: "Ev2",
  event: {
    type: "assistant_thread_started",
    assistant_thread: { channel_id: "D1", thread_ts: "1.0", user_id: "U1" },
  },
};

describe("handleThreadStart", () => {
  it("pins the prompts when the agent container is opened", async () => {
    const { deps, posted, prompts } = makeDeps(projectFixture());

    await handleThreadStart(deps, HOME_OPENED, BINDING);

    // The agent messaging experience pins prompts to the top of the Messages
    // tab, so no thread is named.
    expect(prompts).toEqual([{ channel_id: "D1", prompts: PROMPTS }]);
    // `app_home_opened` fires on every visit, so a greeting here would repeat
    // itself every time the panel is opened.
    expect(posted).toEqual([]);
  });

  it("ignores the Home tab, which is a different surface", async () => {
    const { deps, prompts } = makeDeps(projectFixture());

    await handleThreadStart(
      deps,
      { ...HOME_OPENED, event: { ...HOME_OPENED.event, tab: "home" } },
      BINDING,
    );

    expect(prompts).toEqual([]);
  });

  it("introduces the project on a new legacy assistant thread", async () => {
    const { deps, posted, prompts } = makeDeps(projectFixture());

    await handleThreadStart(deps, LEGACY_THREAD_STARTED, BINDING);

    expect(posted[0]?.thread_ts).toBe("1.0");
    expect(posted[0]?.text).toContain("Painter");
    expect(posted[0]?.text).toContain("Draws things on request.");
    // The legacy view scopes prompts to the thread they belong to.
    expect(prompts).toEqual([{ channel_id: "D1", thread_ts: "1.0", prompts: PROMPTS }]);
  });

  it("still introduces a project that has no description", async () => {
    const { deps, posted } = makeDeps(projectFixture({ description: "   " }));

    await handleThreadStart(deps, LEGACY_THREAD_STARTED, BINDING);

    expect(posted[0]?.text).toContain("Painter");
  });

  it("calls nothing when the project configured no prompts", async () => {
    const { deps, prompts } = makeDeps(
      projectFixture({ slack: { botToken: "enc", signingSecret: "enc", enabled: true } }),
    );

    await handleThreadStart(deps, HOME_OPENED, BINDING);

    expect(prompts).toEqual([]);
  });

  it("stays silent for a missing project", async () => {
    const missing = makeDeps(null);
    await handleThreadStart(missing.deps, LEGACY_THREAD_STARTED, BINDING);

    // Nobody asked a question, so an error message would be an unprompted
    // complaint in a thread the user just opened.
    expect(missing.posted).toEqual([]);
  });

  it("keeps going when the greeting fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { deps, prompts } = makeDeps(projectFixture());
    deps.slack.postMessage = async () => {
      throw new Error("channel_not_found");
    };

    await handleThreadStart(deps, LEGACY_THREAD_STARTED, BINDING);

    expect(prompts).toHaveLength(1);
    vi.restoreAllMocks();
  });
});
