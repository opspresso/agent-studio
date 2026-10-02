import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput } from "@/application/execution/deps";
import type { ExecutionPrincipal } from "@/app/api/agents/_lib/executionAuth";
import type { EngineChunk } from "@/domain/llm/types";

const { agentGet, calls, inputs, state } = vi.hoisted(() => ({
  agentGet: vi.fn(),
  calls: [] as string[],
  inputs: [] as AgentRunInput[],
  state: { principal: { userId: "caller-id", email: "caller@example.test", viaToken: false } as ExecutionPrincipal },
}));

vi.mock("@/lib/session", () => ({ getSessionUser: vi.fn(), isSameOriginMutation: vi.fn(), crossOriginForbidden: vi.fn() }));

vi.mock("@/lib/container", () => ({
  executionDeps: {},
  agentUseCases: { get: agentGet },
  signArtifactUrl: undefined,
}));

vi.mock("@/app/api/agents/_lib/executionAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/agents/_lib/executionAuth")>()),
  authenticateExecution: async () => state.principal,
}));

vi.mock("@/application/execution/runAgent", () => ({
  collectAgentRun: async (_deps: unknown, input: AgentRunInput) => {
    inputs.push(input);
    calls.push("collectAgentRun");
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
  streamAgentExecution: (_deps: unknown, input: AgentRunInput) => {
    inputs.push(input);
    calls.push("streamAgentExecution");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "streamed answer" } };
      yield { done: true };
    })();
  },
  executeAgent: (_deps: unknown, input: AgentRunInput) => {
    inputs.push(input);
    calls.push("executeAgent");
    return (async function* (): AsyncGenerator<EngineChunk> {
      yield { delta: { content: "agent answer" } };
      yield { done: true };
    })();
  },
}));

const { POST: chatCompletions } = await import(
  "@/app/api/agents/[name]/chat/completions/route"
);
const { POST: predict } = await import("@/app/api/agents/[name]/predict/route");
const { POST: agent } = await import(
  "@/app/api/agents/[name]/agent/route"
);

const context = { params: Promise.resolve({ name: "proj" }) };
const request = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0; inputs.length = 0;
  state.principal = { userId: "caller-id", email: "caller@example.test", viaToken: false, caller: { displayName: "Caller" } };
  agentGet.mockResolvedValue({
    name: "proj",
    ownerEmail: "owner@example.com",
    configuration: {
    agentName: "proj",
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
      request("/api/agents/proj/chat/completions", {
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
    expect(calls).toEqual(["collectAgentRun"]);
  });

  it("streams OpenAI chunks and the terminal marker", async () => {
    const response = await chatCompletions(
      request("/api/agents/proj/chat/completions", {
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
    expect(calls).toEqual(["streamAgentExecution"]);
  });
});

describe("POST /agent", () => {
  it("streams the agent facade without reshaping its chunks", async () => {
    const response = await agent(
      request("/api/agents/proj/agent", {
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
      request("/api/agents/proj/agent", { messages: [] }),
      context,
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
  });
});


describe.each([["predict", predict], ["agent", agent], ["chat/completions", chatCompletions]] as const)("%s verified caller forwarding", (path, post) => {
  it("forwards the token's stable user and exact credential independently of payload fields", async () => {
    state.principal = { userId: "token-user", email: "token@example.test", viaToken: true, credentialId: "verified-token-id" };
    let response = await post(request(`/api/agents/proj/${path}`, {
      messages: [{ role: "user", content: "hello" }], user: { userId: "owner-id", email: "owner@example.com" },
      executionGrant: { credentialId: "untrusted" }, ownerEmail: "owner@example.com",
    }), context);
    if (path === "predict") {
      expect(response.status).toBe(400);
      expect(inputs).toEqual([]);
      response = await post(request(`/api/agents/proj/${path}`, { messages: [{ role: "user", content: "hello" }] }), context);
    }
    expect(response.status).toBe(200); await response.text();
    expect(inputs[0]).toMatchObject({
      user: { userId: "token-user", email: "token@example.test" }, ownerEmail: "token@example.test",
      actor: { kind: "agent-token", id: "token@example.test" },
      executionGrant: { kind: "agent-token", agentName: "proj", userId: "token-user", email: "token@example.test", credentialId: "verified-token-id" },
    });
  });
});
