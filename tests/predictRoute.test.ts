import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";

// Route-handler test: the container repos and the execution facade are mocked
// so the assertion is purely "which execution path did this project type take".
const { projectRepo, versionRepo, calls } = vi.hoisted(() => ({
  projectRepo: { get: vi.fn() },
  versionRepo: { get: vi.fn() },
  calls: [] as string[],
}));

vi.mock("@/lib/container", () => ({
  executionDeps: {},
  imageDeps: {},
  projectRepository: projectRepo,
  versionRepository: versionRepo,
}));

vi.mock("@/app/api/projects/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/projects/_lib/executionAuth")>()),
  authenticateExecution: async () => ({ email: "owner@example.com", viaToken: false }),
}));

vi.mock("@/application/execution/runProject", async (importOriginal) => ({
  // The dispatch decision itself is real — that is what this test exercises.
  runStrategyFor: (
    await importOriginal<typeof import("@/application/execution/runProject")>()
  ).runStrategyFor,
  executeAgent: () => {
    calls.push("executeAgent");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "answer from the tool loop" } };
      yield { usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 } };
      yield { done: true };
    })();
  },
  executeVersion: async () => {
    calls.push("executeVersion");
    return {
      content: "single-shot answer",
      model: "openai/gpt-5-mini",
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 },
    };
  },
  executeProjectStream: () => {
    calls.push("executeProjectStream");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { done: true };
    })();
  },
}));

const { POST } = await import("@/app/api/projects/[name]/versions/[version]/predict/route");

const ctx = { params: Promise.resolve({ name: "proj", version: "1" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/projects/proj/versions/1/predict", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  versionRepo.get.mockResolvedValue({
    projectName: "proj",
    versionName: "1",
    systemPrompt: "",
    userPromptTemplate: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("POST /predict dispatches on project type", () => {
  it("runs an agent project through the tool loop", async () => {
    // Sending an agent project down the single-shot path silently drops every
    // skill, MCP server and subagent the version declares.
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      projectType: "agent",
    });

    const res = await POST(req({ messages: [{ role: "user", content: "hi" }] }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "answer from the tool loop" });
    expect(calls).toEqual(["executeAgent"]);
  });

  it("keeps the single-shot path for a prompt project", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      projectType: "llm",
    });

    const res = await POST(req({ variables: { topic: "otters" } }), ctx);

    expect(await res.json()).toMatchObject({ result: "single-shot answer" });
    expect(calls).toEqual(["executeVersion"]);
  });

  it("streams through the shared type dispatch", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      projectType: "agent",
    });

    const res = await POST(req({ messages: [{ role: "user", content: "hi" }], stream: true }), ctx);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(calls).toEqual(["executeProjectStream"]);
  });
});
