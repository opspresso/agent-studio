import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The messaging endpoint decides which activities reach the handler at all,
 * and what a refusal costs: a token that does not verify is a 401 and no work,
 * an activity nobody addressed to the bot is a 200 and no claim.
 */
const { handled, claim, settle, verdict } = vi.hoisted(() => ({
  handled: [] as Array<{ kind: string; text?: string }>,
  claim: vi.fn(async () => true),
  settle: vi.fn(async () => {}),
  verdict: { value: { ok: true } as { ok: true } | { ok: false; reason: string } },
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@/lib/container", () => ({
  executionDeps: {},
  projectRepository: {},
  versionRepository: {},
  signArtifactUrl: undefined,
}));
vi.mock("@/infrastructure/teams/client", () => ({
  teamsClient: { verifyRequest: async () => verdict.value },
}));
vi.mock("@/infrastructure/llm/documentExtractor", () => ({ documentExtractor: {} }));
vi.mock("@/application/execution/runProject", () => ({ executeAgent: () => {} }));
vi.mock("@/infrastructure/db/repositories/teamsActivityRepository", () => ({
  teamsActivityRepository: { forBot: () => ({ claim, settle }) },
}));
vi.mock("@/infrastructure/db/repositories/transcriptRepository", () => ({ transcriptRepository: {} }));
vi.mock("@/application/teams/handleActivity", () => ({
  handleTeamsActivity: async (_deps: unknown, disposition: { kind: string; text?: string }) => {
    handled.push({ kind: disposition.kind, ...(disposition.text !== undefined ? { text: disposition.text } : {}) });
  },
}));

const { handleTeamsActivityRequest } = await import("@/app/api/teams/messages/_lib/handleActivityRequest");

const BINDING = { projectName: "painter", credentials: { appId: "app-id", appPassword: "secret" } };

function request(payload: unknown, authorization: string | null = "Bearer tok"): Request {
  return new Request("https://studio.example.com/api/teams/messages/painter", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization === null ? {} : { Authorization: authorization }),
    },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

const personal = (text: string, over: Record<string, unknown> = {}) => ({
  type: "message",
  id: "act-9",
  serviceUrl: "https://smba.trafficmanager.net/emea/",
  from: { id: "29:u", name: "Bruce" },
  recipient: { id: "28:bot" },
  conversation: { id: "a:1", conversationType: "personal" },
  text,
  ...over,
});

beforeEach(() => {
  handled.length = 0;
  claim.mockClear();
  settle.mockClear();
  claim.mockResolvedValue(true);
  verdict.value = { ok: true };
});

describe("the Teams messaging endpoint", () => {
  it("refuses a delivery whose token does not verify, without touching the store", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    verdict.value = { ok: false, reason: "audience is another app" };
    const res = await handleTeamsActivityRequest(request(personal("hi")), BINDING);
    expect(res.status).toBe(401);
    expect(claim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("refuses a body that is not JSON", async () => {
    const res = await handleTeamsActivityRequest(request("{not json"), BINDING);
    expect(res.status).toBe(400);
  });

  it("claims and handles a personal message, keyed by conversation and activity id, and acks with 202", async () => {
    const res = await handleTeamsActivityRequest(request(personal("hi")), BINDING);
    expect(res.status).toBe(202);
    // An activity id is unique only within its conversation.
    expect(claim).toHaveBeenCalledWith("a:1#act-9", expect.any(Number), expect.any(Number));
    expect(handled).toEqual([{ kind: "run", text: "hi" }]);
    expect(settle).toHaveBeenCalledWith("a:1#act-9", "done");
  });

  it("acks a duplicate delivery without handling it again", async () => {
    claim.mockResolvedValueOnce(false);
    const res = await handleTeamsActivityRequest(request(personal("hi")), BINDING);
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });

  it("acks an activity nobody addressed to the bot without claiming it", async () => {
    const res = await handleTeamsActivityRequest(
      request(personal("lunch?", { conversation: { id: "19:g", conversationType: "groupChat" } })),
      BINDING,
    );
    expect(res.status).toBe(200);
    expect(claim).not.toHaveBeenCalled();
    expect(handled).toEqual([]);
  });

  it("acks what is not a message", async () => {
    const res = await handleTeamsActivityRequest(request(personal("", { type: "conversationUpdate" })), BINDING);
    expect(res.status).toBe(200);
    expect(handled).toEqual([]);
  });
});
