import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTeamsActivity } from "@/application/teams/engagement";
import { handleTeamsActivity } from "@/application/teams/handleActivity";
import type { TeamsActivity, TeamsEventDeps } from "@/application/teams/types";
import type { TeamsClientPort, TeamsOutboundActivity } from "@/domain/teams/client";
import type { TranscriptTurn } from "@/domain/messaging/transcript";
import { messageText } from "@/domain/llm/types";
import type { ChatMessageInput, EngineChunk } from "@/domain/llm/types";
import type { ExecuteAgentInput } from "@/application/execution/deps";
import type { Agent, AgentConfiguration } from "@/domain/agent/types";
import type { AgentRepository } from "@/domain/agent/repository";

const NOW = 1_750_000_000_000;

function agentFixture(): Agent {
  return {
    name: "painter",
    displayName: "Painter",
    description: "a bot that paints",
    ownerEmail: "owner@x.com",

    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function configurationFixture(callerContext = false): AgentConfiguration {
  return {
    agentName: "painter",

    systemPrompt: "",

    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false, ...(callerContext ? { callerContext: true } : {}) },
    mcpList: [],
    skillList: [],
    subagentList: [],
  };
}

function makeTeamsFake() {
  const sent: Array<TeamsOutboundActivity & { id: string; conversationId: string; serviceUrl: string }> = [];
  const updated: Array<{ id: string; text?: string }> = [];
  const downloads: Array<{ url: string; serviceUrl: string }> = [];
  let next = 1;
  const teams: TeamsClientPort = {
    async verifyRequest() {
      return { ok: true };
    },
    async authenticate() {
      return { expiresInSeconds: 3600 };
    },
    async sendActivity(_c, serviceUrl, conversationId, activity) {
      const id = String(next++);
      sent.push({ ...activity, id, conversationId, serviceUrl });
      return { id };
    },
    async updateActivity(_c, _s, _conv, activityId, activity) {
      updated.push({ id: activityId, ...(activity.text !== undefined ? { text: activity.text } : {}) });
    },
    async downloadAttachment(_c, serviceUrl, url) {
      downloads.push({ url, serviceUrl });
      return Buffer.from("png-bytes");
    },
  };
  const finalText = () => updated.at(-1)?.text ?? sent.filter((s) => s.type === "message").at(-1)?.text ?? "";
  return { teams, sent, updated, downloads, finalText };
}

function makeDeps(chunks: EngineChunk[], teams: TeamsClientPort, options: { callerContext?: boolean } = {}) {
  const runs: ExecuteAgentInput[] = [];
  const remembered: Array<{ key: string; turn: TranscriptTurn }> = [];
  const stored: TranscriptTurn[] = [];
  const deps: TeamsEventDeps = {
    runAgent: async function* (input) {
      runs.push(input);
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    agents: { get: async () => ({ ...agentFixture(), configuration: configurationFixture(options.callerContext) }) } as unknown as AgentRepository,
    documents: { extract: async ({ bytes }) => ({ text: Buffer.from(bytes).toString("utf-8") }) },
    teams,
    transcripts: {
      recent: async () => stored,
      append: async (_agent, key, turn) => {
        remembered.push({ key, turn });
      },
    },
    sleep: async () => {},
  };
  return { deps, runs, remembered, stored };
}

function activity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "act-1",
    serviceUrl: "https://smba.trafficmanager.net/emea/",
    channelId: "msteams",
    from: { id: "29:user", name: "Bruce Lee", aadObjectId: "aad-1" },
    conversation: { id: "a:1", conversationType: "personal" },
    recipient: { id: "28:bot", name: "Painter" },
    text: "hello",
    ...overrides,
  };
}

const BINDING = { agentName: "painter", credentials: { appId: "app", appPassword: "secret" } };

function dispositionOf(a: TeamsActivity) {
  const d = classifyTeamsActivity(a);
  if (d.kind === "ignore") {
    throw new Error(`test activity was ignored: ${d.because}`);
  }
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleTeamsActivity", () => {
  it("runs the bound agent with the Entra object id as the actor and the Teams conversation as the conversation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams, finalText, sent } = makeTeamsFake();
    const { deps, runs } = makeDeps([{ delta: { content: "hi there" } }, { done: true }], teams);

    await handleTeamsActivity(deps, dispositionOf(activity()), BINDING);

    expect(runs[0]?.actor).toEqual({ kind: "teams", id: "aad-1" });
    expect(runs[0]?.conversation).toEqual({ surface: "teams", id: "a:1" });
    expect(runs[0]?.caller).toBeUndefined();
    expect(finalText()).toBe("hi there");
    expect(sent.find((s) => s.type === "message")?.replyToId).toBe("act-1");
    expect(sent[0]?.serviceUrl).toBe("https://smba.trafficmanager.net/emea/");
  });

  it("uses the conversation sender id when the Entra id is empty", async () => {
    const { teams } = makeTeamsFake();
    const { deps, runs } = makeDeps([{ done: true }], teams);

    await handleTeamsActivity(deps, dispositionOf(activity({ from: { id: "29:user", aadObjectId: "" } })), BINDING);

    expect(runs[0]?.actor).toEqual({ kind: "teams", id: "29:user" });
  });

  it("keeps a channel thread as its own conversation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams } = makeTeamsFake();
    const { deps, runs } = makeDeps([{ done: true }], teams);

    await handleTeamsActivity(
      deps,
      dispositionOf(
        activity({
          conversation: { id: "19:chan@thread.tacv2;messageid=42", conversationType: "channel" },
          text: "<at>Painter</at> hi",
          entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>Painter</at>" }],
        }),
      ),
      BINDING,
    );

    expect(runs[0]?.conversation).toEqual({ surface: "teams", id: "19:chan@thread.tacv2;messageid=42" });
    const last = runs[0]?.messages.at(-1);
    expect(last && messageText(last)).toBe("hi");
  });

  it("replies with guidance when the agent is not a runnable agent", async () => {
    const { teams, sent } = makeTeamsFake();
    const { deps } = makeDeps([], teams);
    deps.agents = { get: async () => null } as unknown as AgentRepository;

    await handleTeamsActivity(deps, dispositionOf(activity()), BINDING);

    expect(sent[0]?.text).toContain("Agent not available");
  });

  it("carries the remembered conversation and writes both turns down after, names gated on the opt-in", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams } = makeTeamsFake();
    const { deps, runs, remembered, stored } = makeDeps([{ delta: { content: "blue" } }, { done: true }], teams, {
      callerContext: true,
    });
    stored.push({ role: "user", content: "what colour?", userId: "aad-2", speaker: "Ann", createdAt: "2026-01-01T00:00:00.000Z" });

    await handleTeamsActivity(
      deps,
      dispositionOf(
        activity({
          conversation: { id: "19:g@thread.v2", conversationType: "groupChat" },
          text: "<at>Painter</at> the sky",
          entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>Painter</at>" }],
        }),
      ),
      BINDING,
    );

    expect(runs[0]?.caller).toEqual({ displayName: "Bruce Lee" });
    expect(runs[0]?.messages.map((turn: ChatMessageInput) => messageText(turn))).toEqual(["Ann: what colour?", "Bruce Lee: the sky"]);
    expect(remembered.map((entry) => [entry.turn.role, entry.turn.content, entry.turn.speaker])).toEqual([
      ["user", "the sky", "Bruce Lee"],
      ["assistant", "blue", undefined],
    ]);
  });

  it("reads a pasted picture Teams only calls image/* by its bytes", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams } = makeTeamsFake();
    // A PNG signature, which is what the sniff reads.
    teams.downloadAttachment = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    const { deps, runs } = makeDeps([{ done: true }], teams);

    await handleTeamsActivity(
      deps,
      dispositionOf(
        activity({
          text: "what is this?",
          attachments: [{ contentType: "image/*", contentUrl: "https://smba.trafficmanager.net/emea/v3/attachments/1/views/original" }],
        }),
      ),
      BINDING,
    );

    const last = runs[0]?.messages.at(-1)?.content;
    const image = Array.isArray(last) ? last.find((part) => part.type === "image_url") : undefined;
    expect(image && "image_url" in image && image.image_url.url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("remembers the question at the moment it arrived, and an answer that was only a file or nothing at all", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams } = makeTeamsFake();
    const { deps, remembered } = makeDeps([{ done: true }], teams);

    await handleTeamsActivity(
      deps,
      dispositionOf(activity({ text: "hello", timestamp: "2026-08-17T01:02:03.000Z" })),
      BINDING,
    );

    expect(remembered.map((entry) => [entry.turn.role, entry.turn.content, entry.turn.createdAt])).toEqual([
      ["user", "hello", "2026-08-17T01:02:03.000Z"],
      ["assistant", "[no answer]", "2026-08-17T01:02:03.001Z"],
    ]);
  });

  it("does not dispatch a bare name when a labelled message carried no text", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { teams } = makeTeamsFake();
    const { deps, runs, stored } = makeDeps([{ done: true }], teams, { callerContext: true });
    stored.push({ role: "user", content: "earlier", userId: "aad-2", speaker: "Ann", createdAt: "2026-01-01T00:00:00.000Z" });

    await handleTeamsActivity(
      deps,
      dispositionOf(
        activity({
          conversation: { id: "19:g@thread.v2", conversationType: "groupChat" },
          text: "<at>Painter</at>",
          entities: [{ type: "mention", mentioned: { id: "28:bot" }, text: "<at>Painter</at>" }],
          attachments: [{ contentType: "video/mp4", contentUrl: "https://smba.trafficmanager.net/emea/v3/attachments/9" }],
        }),
      ),
      BINDING,
    );

    expect(runs).toEqual([]);
  });

  it("downloads a pasted picture through the conversation's service, and names a shared file by its type", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { teams, downloads } = makeTeamsFake();
    const { deps, runs } = makeDeps([{ done: true }], teams);

    await handleTeamsActivity(
      deps,
      dispositionOf(
        activity({
          text: "what is this?",
          attachments: [
            { contentType: "text/html", content: {} },
            { contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/emea/v3/attachments/1/views/original", name: "shot.png" },
            {
              contentType: "application/vnd.microsoft.teams.file.download.info",
              name: "notes.txt",
              content: { downloadUrl: "https://contoso.sharepoint.com/dl/notes.txt", fileType: "txt" },
            },
          ],
        }),
      ),
      BINDING,
    );

    expect(downloads.map((d) => d.url)).toEqual([
      "https://smba.trafficmanager.net/emea/v3/attachments/1/views/original",
      "https://contoso.sharepoint.com/dl/notes.txt",
    ]);
    const last = runs[0]?.messages.at(-1)?.content;
    expect(Array.isArray(last) && last.some((part) => part.type === "image_url")).toBe(true);
    expect(last && messageText({ content: last })).toContain("png-bytes");
  });
});
