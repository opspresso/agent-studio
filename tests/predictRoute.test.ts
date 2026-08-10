import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";

// Route-handler test: the container repos and the execution facade are mocked
// so the assertion is purely "which execution path did this project type take".
const { projectRepo, versionRepo, calls } = vi.hoisted(() => ({
  projectRepo: { get: vi.fn() },
  versionRepo: { get: vi.fn() },
  calls: [] as string[],
}));

vi.mock("@/lib/container", async () => ({
  executionDeps: {},
  imageDeps: {},
  // `executionAuth` is loaded for real through `importOriginal` below, and it
  // imports this. Only `authenticateExecution` is overridden, so narrowing that
  // override would otherwise fail on an undefined binding rather than say what
  // is missing.
  apiTokenUseCases: (
    await import("@/application/project/apiTokenUseCases")
  ).createApiTokenUseCases({ getApiToken: async () => null } as never, {} as never),
  projectUseCases: (
    await import("@/application/project/projectUseCases")
  ).createProjectUseCases(projectRepo as never),
  // Only `get` is reached here; the reference lookups and the cipher belong to
  // the write path, which this route does not take.
  versionUseCases: (
    await import("@/application/project/versionUseCases")
  ).createVersionUseCases({
    versions: versionRepo as never,
    projects: projectRepo as never,
    refs: {} as never,
    cipher: {} as never,
  }),
}));

vi.mock("@/app/api/projects/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/projects/_lib/executionAuth")>()),
  authenticateExecution: async () => ({ email: "owner@example.com", viaToken: false }),
}));

vi.mock("@/application/execution/runProject", async (importOriginal) => ({
  // The image branch still asks the real strategy; the completion dispatch
  // itself lives in executeProject and is exercised in runProject.test.ts —
  // here the assertion is that the route hands the run to the facade and only
  // serialises its answer.
  runStrategyFor: (
    await importOriginal<typeof import("@/application/execution/runProject")>()
  ).runStrategyFor,
  executeProject: async () => {
    calls.push("executeProject");
    return {
      content: "collected answer",
      model: "openai/gpt-5-mini",
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
      images: [],
      warnings: [],
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
  it("hands an agent project to the non-streaming facade", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      projectType: "agent",
    });

    const res = await POST(req({ messages: [{ role: "user", content: "hi" }] }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "collected answer" });
    expect(calls).toEqual(["executeProject"]);
  });

  it("hands a prompt project to the same facade", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      projectType: "llm",
    });

    const res = await POST(req({ variables: { topic: "otters" } }), ctx);

    expect(await res.json()).toMatchObject({ result: "collected answer" });
    expect(calls).toEqual(["executeProject"]);
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
