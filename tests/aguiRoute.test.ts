import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";
import { RateLimitedError } from "@/application/errors";
import { readSse } from "@/app/_lib/sse";

// Route-handler test: repositories and the execution facade are mocked, so the
// assertions are about what the route decides — who may call, what it refuses,
// and that the run's chunks leave as AG-UI frames.
const { projectRepo, versionRepo, runs } = vi.hoisted(() => ({
  projectRepo: { get: vi.fn() },
  versionRepo: { get: vi.fn(), list: vi.fn(async () => []) },
  runs: [] as unknown[],
}));

// The conversation key is an HMAC under the deployment's secret; only that
// value is pinned, the rest of the config module stays real.
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    config: new Proxy(actual.config, {
      get: (target, key) => (key === "aesEncryptionKey" ? "test-key" : Reflect.get(target, key)),
    }),
  };
});

vi.mock("@/lib/container", async () => ({
  aguiDeps: { projects: projectRepo, versions: versionRepo, execution: {} },
  apiTokenUseCases: (
    await import("@/application/project/apiTokenUseCases")
  ).createApiTokenUseCases({ getApiToken: async () => null } as never, {} as never),
  projectUseCases: (
    await import("@/application/project/projectUseCases")
  ).createProjectUseCases(projectRepo as never),
}));

vi.mock("@/app/api/projects/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/projects/_lib/executionAuth")>()),
  authenticateExecution: async () => ({ email: "owner@example.com", viaToken: true }),
}));

let script: () => AsyncGenerator<EngineChunk>;
vi.mock("@/application/execution/runProject", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/application/execution/runProject")>()),
  streamProjectRun: (_deps: unknown, input: unknown) => {
    runs.push(input);
    return script();
  },
}));

const { POST } = await import("@/app/api/agui/[name]/route");

const ctx = { params: Promise.resolve({ name: "proj" }) };
const req = (body: unknown) =>
  new Request("http://localhost/api/agui/proj", { method: "POST", body: JSON.stringify(body) });

const input = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [{ id: "m1", role: "user", content: "hi" }],
  tools: [],
  context: [],
};

async function frames(response: Response): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of readSse(response)) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  runs.length = 0;
  projectRepo.get.mockResolvedValue({
    name: "proj",
    displayName: "Proj",
    description: "",
    projectType: "agent",
    ownerEmail: "owner@example.com",
    publishedVersion: "1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
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
  script = async function* () {
    yield { delta: { content: "hello" } };
    yield { done: true };
  };
});

describe("POST /api/agui/[name]", () => {
  it("streams the run as AG-UI events without an OpenAI terminator", async () => {
    const response = await POST(req(input), ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = await frames(response);
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
  });

  it("runs the published version as the token's owner, in the thread's conversation", async () => {
    await frames(await POST(req(input), ctx));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      project: { name: "proj" },
      version: { versionName: "1" },
      messages: [{ role: "user", content: "hi" }],
      actor: { kind: "project-token", id: "owner@example.com" },
      conversation: { surface: "agui" },
    });
    const conversation = (runs[0] as { conversation: { id: string } }).conversation.id;
    // The caller's namespace is a digest, never the email; the thread id is kept as sent.
    expect(conversation).toMatch(/^[0-9a-f]{16}:thread-1$/);
    expect(conversation).not.toContain("owner@example.com");
  });

  it("refuses a body that is not a RunAgentInput", async () => {
    const response = await POST(req({ threadId: "t", runId: "r", messages: [] }), ctx);
    expect(response.status).toBe(400);
    expect(runs).toHaveLength(0);
  });

  it("refuses a content part it cannot hand to the model", async () => {
    const response = await POST(
      req({
        ...input,
        messages: [
          {
            id: "m1",
            role: "user",
            content: [{ type: "audio", source: { type: "url", value: "https://x/a.mp3" } }],
          },
        ],
      }),
      ctx,
    );
    expect(response.status).toBe(400);
  });

  it("answers 404 for a project with nothing published", async () => {
    projectRepo.get.mockResolvedValue({
      name: "proj",
      projectType: "agent",
      ownerEmail: "owner@example.com",
      publishedVersion: undefined,
    });
    const response = await POST(req(input), ctx);
    expect(response.status).toBe(404);
    expect(runs).toHaveLength(0);
  });

  it("turns a refusal on the first chunk into a 429 rather than a frame", async () => {
    script = async function* () {
      throw new RateLimitedError("over the daily cost limit", 42);
      // eslint-disable-next-line no-unreachable
      yield { done: true };
    };
    const response = await POST(req(input), ctx);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
  });
});
