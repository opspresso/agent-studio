import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineChunk } from "@/domain/llm/types";

const { projectGet, calls } = vi.hoisted(() => ({
  projectGet: vi.fn(),
  calls: [] as string[],
}));

vi.mock("@/lib/container", () => ({
  executionDeps: {},
  projectUseCases: { get: projectGet },
  signArtifactUrl: undefined,
}));

vi.mock("@/app/api/projects/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/projects/_lib/executionAuth")>()),
  authenticateExecution: async () => ({
    email: "owner@example.com",
    viaToken: false,
    caller: { displayName: "Owner" },
  }),
}));

vi.mock("@/application/execution/runProject", () => ({
  executeProject: async () => {
    calls.push("executeProject");
    return {
      content: "collected answer",
      model: "openai/gpt-5-mini",
      usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01 },
      images: [],
      files: [],
      warnings: [],
      termination: "completed",
    };
  },
  executeProjectStream: () => {
    calls.push("executeProjectStream");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "streamed answer" } };
      yield { done: true };
    })();
  },
  executeAgent: () => {
    calls.push("executeAgent");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "agent answer" } };
      yield { done: true };
    })();
  },
}));

const { POST: chatCompletions } = await import(
  "@/app/api/projects/[name]/chat/completions/route"
);
const { POST: agent } = await import(
  "@/app/api/projects/[name]/agent/route"
);

const context = { params: Promise.resolve({ name: "proj" }) };
const request = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  projectGet.mockResolvedValue({
    name: "proj",
    ownerEmail: "owner@example.com",
    projectType: "agent",
    configuration: {
    projectName: "proj",
    systemPrompt: "",
    model: "openai/gpt-5-mini",
    parameters: { piiFiltering: false },
    mcpList: [],
    skillList: [],
    subagentList: [],
    },
  });
});

describe("POST /chat/completions", () => {
  it("wraps a collected run in the OpenAI response shape", async () => {
    const response = await chatCompletions(
      request("/api/projects/proj/chat/completions", {
        model: "a-client-side-alias",
        messages: [{ role: "user", content: "hello" }],
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "chat.completion",
      model: "openai/gpt-5-mini",
      choices: [
        {
          message: { role: "assistant", content: "collected answer" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
    expect(calls).toEqual(["executeProject"]);
  });

  it("streams OpenAI chunks and the terminal marker", async () => {
    const response = await chatCompletions(
      request("/api/projects/proj/chat/completions", {
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
      context,
    );
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"content":"streamed answer"');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain("data: [DONE]");
    expect(calls).toEqual(["executeProjectStream"]);
  });
});

describe("POST /agent", () => {
  it("streams the agent facade without reshaping its chunks", async () => {
    const response = await agent(
      request("/api/projects/proj/agent", {
        messages: [{ role: "user", content: "hello" }],
      }),
      context,
    );
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain('"delta":{"content":"agent answer"}');
    expect(body).toContain('"done":true');
    expect(body).toContain("data: [DONE]");
    expect(calls).toEqual(["executeAgent"]);
  });

  it("rejects an empty transcript before starting a run", async () => {
    const response = await agent(
      request("/api/projects/proj/agent", { messages: [] }),
      context,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});
