import { describe, expect, it } from "vitest";
import { createSlackWorkspaceReader, type SlackReaderPort } from "@/application/slack/workspaceRead";
import {
  buildAgentTools,
  runAgent,
  SLACK_TOOL_NAMES,
  type AgentDeps,
  type RunAgentInput,
} from "@/application/llm/engine";
import type { EngineChunk } from "@/domain/llm/types";
import { contentChunk, FakeChannel, toolCallChunk, usageChunk } from "./fakeChannel";
import type { RunCaller } from "@/domain/execution/actor";
import type { SlackChannelInfo, SlackMessage } from "@/domain/slack/types";

/**
 * The four workspace reads a run may be offered.
 *
 * Two things are load-bearing beyond "it returns the messages": what the tools
 * are *not* allowed to hand back (an email, which the bot's scopes would
 * happily supply), and that a transcript is readable at all — a page of
 * `<@U04B7QK9E>` is not something a model can reason about.
 */

const TOKEN = "xoxb-test";

const PEOPLE: Record<string, RunCaller> = {
  U0ADA123: { displayName: "Ada", timezone: "Asia/Seoul" },
  U0LIN456: { displayName: "Lin" },
};

function makeSlackFake(
  over: {
    history?: SlackMessage[];
    thread?: SlackMessage[];
    channels?: SlackChannelInfo[];
  } = {},
) {
  const calls: Array<{ method: string; args: unknown }> = [];
  const slack: SlackReaderPort = {
    async channelHistory(_token, args) {
      calls.push({ method: "channelHistory", args });
      return over.history ?? [];
    },
    async threadReplies(_token, args) {
      calls.push({ method: "threadReplies", args });
      return over.thread ?? [];
    },
    async listChannels(_token, args) {
      calls.push({ method: "listChannels", args });
      return over.channels ?? [];
    },
    async userProfile(_token, userId) {
      return PEOPLE[userId] ?? null;
    },
  };
  return { slack, calls, read: createSlackWorkspaceReader(slack, TOKEN) };
}

/**
 * Fixed instants, ten minutes apart. Ids are shaped like Slack's real ones —
 * uppercase alphanumeric, no punctuation — because the mention pattern that
 * resolves them in message text depends on exactly that.
 */
const TS_A = "1750000000.000100";
const TS_B = "1750000600.000200";

describe("reading a channel", () => {
  it("renders a transcript oldest first, with speakers named", async () => {
    // Slack returns a channel newest-first. A model handed that reversed reports
    // the conclusion as the question.
    const { read } = makeSlackFake({
      history: [
        { ts: TS_B, user: "U0LIN456", text: "rolled back" },
        { ts: TS_A, user: "U0ADA123", text: "deploy looks stuck" },
      ],
    });

    const result = await read("SlackHistory", { channel: "C1" });

    expect(result.split("\n")).toEqual([
      "[2025-06-15 15:06Z] Ada: deploy looks stuck",
      "[2025-06-15 15:16Z] Lin: rolled back",
    ]);
  });

  it("resolves the user ids inside message text", async () => {
    const { read } = makeSlackFake({
      history: [{ ts: TS_A, user: "U0ADA123", text: "<@U0LIN456> can you look?" }],
    });

    expect(await read("SlackHistory", { channel: "C1" })).toContain("Ada: @Lin can you look?");
  });

  it("leaves an id alone when the lookup finds nobody", async () => {
    const { read } = makeSlackFake({ history: [{ ts: TS_A, user: "U0GHOST9", text: "hi" }] });

    // Better an unresolved id than a failed tool call: the transcript is still
    // usable and the model can say who it could not identify.
    expect(await read("SlackHistory", { channel: "C1" })).toContain("U0GHOST9: hi");
  });

  it("names an attachment a message carried", async () => {
    const { read } = makeSlackFake({
      history: [{ ts: TS_A, user: "U0ADA123", text: "", files: [{ name: "postmortem.pdf" }] }],
    });

    expect(await read("SlackHistory", { channel: "C1" })).toContain("[attached: postmortem.pdf]");
  });

  it("bounds the page and defaults it", async () => {
    const { read, calls } = makeSlackFake();

    await read("SlackHistory", { channel: "C1" });
    await read("SlackHistory", { channel: "C1", limit: 500 });
    await read("SlackHistory", { channel: "C1", limit: -3 });

    expect(calls.map((call) => (call.args as { limit: number }).limit)).toEqual([20, 100, 20]);
  });

  it("says so rather than guessing when the call names no channel", async () => {
    const { read, calls } = makeSlackFake();

    expect(await read("SlackHistory", {})).toMatch(/requires a channel id/);
    expect(calls).toEqual([]);
  });

  it("reports an empty channel as empty", async () => {
    const { read } = makeSlackFake({ history: [] });

    expect(await read("SlackHistory", { channel: "C1" })).toBe("No messages.");
  });
});

describe("reading a thread", () => {
  it("keeps Slack's order, which is already oldest first", async () => {
    const { read } = makeSlackFake({
      thread: [
        { ts: TS_A, user: "U0ADA123", text: "first" },
        { ts: TS_B, user: "U0LIN456", text: "second" },
      ],
    });

    const result = await read("SlackThread", { channel: "C1", thread_ts: TS_A });

    expect(result.indexOf("first")).toBeLessThan(result.indexOf("second"));
  });

  it("needs both the channel and the thread", async () => {
    const { read, calls } = makeSlackFake();

    expect(await read("SlackThread", { channel: "C1" })).toMatch(/requires a channel id and a/);
    expect(calls).toEqual([]);
  });
});

describe("looking up a user", () => {
  it("answers with a name and a timezone", async () => {
    const { read } = makeSlackFake();

    expect(await read("SlackUser", { user: "U0ADA123" })).toBe("U0ADA123: Ada\ntimezone: Asia/Seoul");
  });

  it("never returns an email", async () => {
    // `users:read.email` is granted to the bot, so this is a decision rather
    // than a limitation — the same one `callerFrom` already makes for the
    // caller block. A profile shape that grew an email would fail here.
    const { read } = makeSlackFake();

    const result = await read("SlackUser", { user: "U0ADA123" });

    expect(result).not.toMatch(/@[\w.-]+\.\w+/);
  });

  it("says who it could not find rather than failing", async () => {
    const { read } = makeSlackFake();

    expect(await read("SlackUser", { user: "U0GONE77" })).toMatch(/No profile for U0GONE77/);
  });
});

describe("listing channels", () => {
  const CHANNELS: SlackChannelInfo[] = [
    { id: "C1", name: "deploy", isMember: true, topic: "releases" },
    { id: "C2", name: "deploy-alerts", isMember: false, isPrivate: true },
    { id: "C3", name: "random", isMember: true },
  ];

  it("gives the id a name has to become, and says whether the bot is in it", async () => {
    const { read } = makeSlackFake({ channels: CHANNELS });

    const result = await read("SlackChannels", { query: "deploy" });

    expect(result).toContain("#deploy (C1; public, bot is a member) — releases");
    // Membership is what decides whether the history is readable at all, so a
    // model that reads this can explain a refusal instead of retrying it.
    expect(result).toContain("#deploy-alerts (C2; private, bot is NOT a member)");
    expect(result).not.toContain("#random");
  });

  it("tolerates the # a person would type", async () => {
    const { read } = makeSlackFake({ channels: CHANNELS });

    expect(await read("SlackChannels", { query: "#random" })).toContain("#random");
  });

  it("lists everything when no query is given", async () => {
    const { read } = makeSlackFake({ channels: CHANNELS });

    expect((await read("SlackChannels", {})).split("\n")).toHaveLength(3);
  });

  it("says nothing matched rather than returning an empty string", async () => {
    const { read } = makeSlackFake({ channels: CHANNELS });

    expect(await read("SlackChannels", { query: "billing" })).toMatch(/No channel matching/);
  });
});

describe("what a run is offered", () => {
  const toolNames = (withSlackTools: boolean) =>
    buildAgentTools({
      skills: [],
      subagents: [],
      canLoadSkills: false,
      withImageTool: false,
      withEditTool: false,
      withImageTransfer: false,
      withUrlTool: false,
      withSlackTools,
    }).tools.map((tool) => tool.function.name);

  it("offers all four together or none at all", () => {
    expect(toolNames(true)).toEqual([...SLACK_TOOL_NAMES]);
    expect(toolNames(false)).toEqual([]);
  });

  it("claims the names even when the tools are off", () => {
    // An MCP server that happens to expose a tool called `SlackUser` must be
    // aliased whether or not this run has the builtin, or the alias table would
    // change shape with a version parameter.
    const { builtinNames } = buildAgentTools({
      skills: [],
      subagents: [],
      canLoadSkills: false,
      withImageTool: false,
      withEditTool: false,
      withImageTransfer: false,
      withUrlTool: false,
      withSlackTools: true,
    });

    expect([...builtinNames].sort()).toEqual([...SLACK_TOOL_NAMES].sort());
  });
});

/**
 * The engine's side of it. The four names route to one injected reader, so what
 * is under test here is the routing and the failure rule — the reader's own
 * output is covered above.
 */
describe("dispatching a Slack tool", () => {
  const input = (): RunAgentInput => ({
    projectName: "p",
    model: "google/gemini-2.5-flash",
    systemPrompt: "s",
    messages: [{ role: "user", content: "what happened in #deploy?" }],
  });

  async function collect(gen: AsyncGenerator<EngineChunk>): Promise<EngineChunk[]> {
    const chunks: EngineChunk[] = [];
    for await (const chunk of gen) {
      chunks.push(chunk);
    }
    return chunks;
  }

  it("is not offered when no reader was injected", async () => {
    // Capability comes from the deps, never from the version, so the Playground
    // preview and the run cannot disagree about what this run can reach.
    const channel = new FakeChannel([[contentChunk("hi"), usageChunk(1, 1)]]);

    await collect(runAgent({ channel, recordUsage: async () => {} }, input()));

    const offered = (channel.seenParams[0]?.tools ?? []).map((tool) => tool.function.name);
    expect(offered).not.toContain("SlackHistory");
  });

  it("routes the call to the reader and hands back what it returned", async () => {
    const channel = new FakeChannel([
      [
        toolCallChunk(0, "c1", "SlackHistory", '{"channel":"C1","limit":5}'),
        usageChunk(10, 5),
      ],
      [contentChunk("they rolled back"), usageChunk(8, 4)],
    ]);
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      readSlack: async (tool, args) => {
        seen.push({ tool, args });
        return "[2025-06-15 15:06Z] Ada: rolled back";
      },
    };

    const chunks = await collect(runAgent(deps, input()));

    expect(seen).toEqual([{ tool: "SlackHistory", args: { channel: "C1", limit: 5 } }]);
    expect(chunks.find((chunk) => chunk.toolResult)?.toolResult?.content).toContain("Ada: rolled back");
  });

  it("answers with the failure rather than tearing the run down", async () => {
    // Slack refusing — a channel the bot is not in, a scope that was revoked —
    // is something the model can act on. An MCP dispatcher throwing is a
    // transport fault and does end the run; this is not that.
    const channel = new FakeChannel([
      [toolCallChunk(0, "c1", "SlackChannels", "{}"), usageChunk(10, 5)],
      [contentChunk("I could not look"), usageChunk(8, 4)],
    ]);
    const deps: AgentDeps = {
      channel,
      recordUsage: async () => {},
      readSlack: async () => {
        throw new Error("missing_scope");
      },
    };

    const chunks = await collect(runAgent(deps, input()));

    expect(chunks.find((chunk) => chunk.toolResult)?.toolResult?.content).toContain("missing_scope");
    expect(chunks.some((chunk) => chunk.error)).toBe(false);
  });
});
