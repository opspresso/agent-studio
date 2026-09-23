import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";

// Route-handler test: the container repos and the execution facade are mocked
// so the assertion is purely "which execution path did this project type take".
const { projectRepo, calls } = vi.hoisted(() => ({
  projectRepo: { get: vi.fn() },
  calls: [] as string[],
}));

vi.mock("@/lib/container", async () => ({
  executionDeps: {},
  // No object storage in this deployment, which is what makes the file branch
  // below say "not kept" rather than mint an address.
  signArtifactUrl: undefined,
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

}));

vi.mock("@/app/api/projects/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/projects/_lib/executionAuth")>()),
  authenticateExecution: async () => ({ email: "owner@example.com", viaToken: false }),
}));

vi.mock("@/application/execution/runProject", () => ({
  executeProject: async () => {
    calls.push("executeProject");
    return {
      content: "collected answer",
      model: "openai/gpt-5-mini",
      usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.1 },
      images: [],
      files: [],
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

const { POST } = await import("@/app/api/projects/[name]/predict/route");

const ctx = { params: Promise.resolve({ name: "proj" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/projects/proj/predict", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;

});

describe("POST /predict dispatches on project type", () => {
  it("hands an agent project to the non-streaming facade", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      configuration: { projectName: "proj", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] },
    });

    const res = await POST(req({ messages: [{ role: "user", content: "hi" }] }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ result: "collected answer" });
    expect(calls).toEqual(["executeProject"]);
  });

  it("rejects retired template inputs before starting execution", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      configuration: { projectName: "proj", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] },
    });

    const res = await POST(req({ variables: { topic: "otters" } }), ctx);

    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("streams through the shared type dispatch", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      ownerEmail: "owner@example.com",
      configuration: { projectName: "proj", systemPrompt: "", model: "openai/gpt-5-mini", parameters: { piiFiltering: false }, mcpList: [], skillList: [], subagentList: [] },
    });

    const res = await POST(req({ messages: [{ role: "user", content: "hi" }], stream: true }), ctx);

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(calls).toEqual(["executeProjectStream"]);
  });
});
