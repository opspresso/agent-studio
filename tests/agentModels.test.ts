import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Agent,
  InputGuardrailTripwireTriggered,
  MemorySession,
  NoopTrace,
  RunState,
  tool,
  withTrace,
  type Model,
  type ModelRequest,
  type ResponseStreamEvent,
} from "@openai/agents";
import { createAgentModelProvider } from "@/infrastructure/llm/agentModels";
import { createStudioRunner } from "@/application/runtime/runner";
import { runAgent } from "@/application/runtime";
import { resolveProviderTarget, type ResolvedTarget } from "@/infrastructure/llm/providers";

const target: ResolvedTarget = {
  providerName: "selfhosted",
  baseUrl: "http://vllm.internal/v1",
  apiKey: "test-key",
  auth: "bearer",
  model: "local-model",
};
const request: ModelRequest = {
  input: "hello",
  modelSettings: { maxTokens: 40, presencePenalty: 0.5, reasoning: { effort: "low" } },
  tools: [],
  handoffs: [],
  outputType: "text",
  tracing: false,
};

function completion(content = "hello", calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1,
    model: "local-model",
    choices: [{ index: 0, message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: calls ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.012 },
  };
}

function sse(frames: unknown[]) {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function installTransport(reply: (body: Record<string, unknown>, index: number) => Response) {
  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === "string" ? init.body : await (input as Request).text()) as Record<string, unknown>;
    requests.push({ url: input instanceof Request ? input.url : String(input), headers: new Headers(init?.headers ?? (input as Request).headers), body });
    return reply(body, requests.length - 1);
  }));
  return requests;
}

let transportNumber = 0;
beforeEach(() => {
  target.baseUrl = `http://vllm-${++transportNumber}.internal/v1`;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
});

function getResponse(model: Model, input: ModelRequest = request) {
  return withTrace(new NoopTrace(), () => model.getResponse(input));
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Agents SDK model provider", () => {
  it.each([undefined, 0, 1.5])("preserves presence penalty %s in streaming and completion calls", async (presencePenalty) => {
    const requests = installTransport((body) => body.stream ? sse([{ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }]) : Response.json(completion()));
    const model = await createAgentModelProvider(async () => target).getModel("selfhosted/local-model");
    const input = { ...request, modelSettings: { ...request.modelSettings, presencePenalty } };
    await getResponse(model, input);
    await withTrace(new NoopTrace(), async () => { for await (const event of model.getStreamedResponse(input)) void event; });
    expect(requests).toHaveLength(2);
    for (const { body } of requests) {
      if (presencePenalty === undefined) expect(body).not.toHaveProperty("presence_penalty");
      else expect(body.presence_penalty).toBe(presencePenalty);
    }
  });

  it("uses the configured compatible endpoint and preserves billing metadata", async () => {
    const requests = installTransport(() => Response.json(completion()));
    const model = await createAgentModelProvider(async () => target).getModel("selfhosted/local-model");
    const result = await getResponse(model);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${target.baseUrl}/chat/completions`);
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer test-key");
    expect(requests[0]?.body).toMatchObject({ model: "local-model", max_completion_tokens: 40, presence_penalty: 0.5, reasoning_effort: "low", store: false });
    expect(requests[0]?.body).not.toHaveProperty("max_tokens");
    expect(result.rawUsage).toMatchObject({ cost: 0.012, prompt_tokens_details: { cached_tokens: 4 } });
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  it("resolves credential and endpoint rotation on every model call", async () => {
    const requests = installTransport(() => Response.json(completion()));
    let current = target;
    const model = await createAgentModelProvider(async () => current).getModel("selfhosted/local-model");
    await getResponse(model);
    current = { ...target, baseUrl: "http://vllm-new.internal/v1", apiKey: "rotated-key" };
    await getResponse(model);
    expect(requests[1]?.url).toBe("http://vllm-new.internal/v1/chat/completions");
    expect(requests[1]?.headers.get("Authorization")).toBe("Bearer rotated-key");
  });

  it("uses the same routing rules for OpenAI and the deployment's default gateway", async () => {
    const requests = installTransport(() => Response.json(completion()));
    const provider = createAgentModelProvider(async (id) => resolveProviderTarget(id, [{
      name: "openai", baseUrl: "https://openai.example/v1", apiKey: "openai-test", auth: "bearer", keepModelPrefix: false,
    }], { baseUrl: "http://gateway.internal/v1", apiKey: "gateway-test" }));
    await getResponse(await provider.getModel("openai/gpt-test"));
    await getResponse(await provider.getModel("other/model"));
    expect(requests.map(({ url, body }) => [url, body.model])).toEqual([
      ["https://openai.example/v1/chat/completions", "gpt-test"],
      ["http://gateway.internal/v1/chat/completions", "other/model"],
    ]);
  });

  it("requires an explicit model and rejects provider-managed conversation state", async () => {
    const requests = installTransport(() => Response.json(completion()));
    const provider = createAgentModelProvider(async () => target);
    expect(() => provider.getModel()).toThrow("explicit Studio model");
    const model = await provider.getModel("selfhosted/local-model");
    await expect(model.getResponse({ ...request, conversationId: "remote-conversation" })).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it("rejects remote image addresses before resolving credentials or contacting the model", async () => {
    const resolve = vi.fn(async () => target);
    const model = await createAgentModelProvider(resolve).getModel("selfhosted/local-model");
    await expect(model.getResponse({ ...request, input: [{ type: "message", role: "user", content: [{ type: "input_image", image: "http://private.internal/image.png", detail: "auto" }] }] }))
      .rejects.toThrow("bounded inline image bytes");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not hide extra HTTP retries behind the Runner", async () => {
    const requests = installTransport(() => Response.json({ error: { message: "overloaded" } }, { status: 503 }));
    const model = await createAgentModelProvider(async () => target).getModel("selfhosted/local-model");
    await expect(getResponse(model)).rejects.toThrow("overloaded");
    expect(requests).toHaveLength(1);
  });

  it("preserves cancellation before a request and after a streamed delta", async () => {
    const resolve = vi.fn(async () => target);
    const model = await createAgentModelProvider(resolve).getModel("selfhosted/local-model");
    const cancelled = new AbortController();
    cancelled.abort("chat-run-stopped");
    await expect(model.getResponse({ ...request, signal: cancelled.signal })).rejects.toBe("chat-run-stopped");
    expect(resolve).not.toHaveBeenCalled();

    installTransport(() => sse([{ id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }]));
    const controller = new AbortController();
    const stream = model.getStreamedResponse({ ...request, signal: controller.signal })[Symbol.asyncIterator]();
    while (!(await stream.next()).done) {
      controller.abort("chat-run-stopped");
      break;
    }
    await expect(async () => { while (!(await stream.next()).done) { /* drain SDK events */ } }).rejects.toBe("chat-run-stopped");
  });
});

describe("native Agents SDK execution over Studio routing", () => {
  function runner() {
    return createStudioRunner(createAgentModelProvider(async () => target));
  }

  it("runs Studio's production entry with SDK tools, keeps files out of context and replays tool images", async () => {
    const requests = installTransport((_body, index) => Response.json(index === 0
      ? completion("", [{ id: "capture_1", type: "function", function: { name: "capture", arguments: "{}" } }])
      : completion("captured")));
    // Studio's streaming entry asks for streamed provider responses.
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
      return sse(requests.length === 1 ? [
        { id: "capture-turn", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "capture_1", type: "function", function: { name: "capture", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      ] : [{ id: "answer-turn", choices: [{ index: 0, delta: { content: "captured" }, finish_reason: "stop" }] }]);
    }));
    const chunks = [];
    for await (const chunk of runAgent({
      channel: createAgentModelProvider(async () => target),
      callMcpTool: async () => ({ text: "captured", images: [{ b64: "aGVsbG8=", mimeType: "image/png" }], files: [{ name: "report.txt", mimeType: "text/plain", b64: "c2VjcmV0LWZpbGU=" }] }),
    }, {
      projectName: "studio", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "capture" }], maxTurn: 4,
      mcpTools: [{ type: "function", function: { name: "capture", parameters: { type: "object", properties: {} } } }],
    })) chunks.push(chunk);
    expect(chunks.some((chunk) => chunk.file?.name === "report.txt")).toBe(true);
    expect(chunks.some((chunk) => chunk.image?.b64 === "aGVsbG8=")).toBe(true);
    expect(chunks.map((chunk) => chunk.delta?.content ?? "").join("")).toBe("captured");
    expect(chunks.at(-1)).toMatchObject({ done: true });
    expect(JSON.stringify(requests[1]?.body)).toContain("data:image/png;base64,aGVsbG8=");
    expect(JSON.stringify(requests)).not.toContain("c2VjcmV0LWZpbGU=");
  });

  it("lets Runner execute tools and retain exact tool traffic in a Session", async () => {
    const requests = installTransport((_body, index) => Response.json(index === 0
      ? completion("", [{ id: "call_search", type: "function", function: { name: "search", arguments: '{"query":"local"}' } }])
      : completion("local answer")));
    const execute = vi.fn(async (args: unknown) => `found ${(args as { query: string }).query}`);
    const agent = new Agent({ name: "studio", model: "selfhosted/local-model", tools: [tool({
      name: "search", description: "Search local documents",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false }, execute,
    })] });
    const session = new MemorySession({ sessionId: "test-session" });
    const result = await runner().run(agent, "find local", { session });
    expect(result.finalOutput).toBe("local answer");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests[1]?.body.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call_search" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_search", content: "found local" }),
    ]));
    expect(await session.getItems()).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function_call", callId: "call_search" }),
      expect.objectContaining({ type: "function_call_result", callId: "call_search" }),
    ]));
    expect(requests.every(({ url }) => url.startsWith(target.baseUrl))).toBe(true);
  });

  it("streams text through SDK events and retains the raw usage-only frame", async () => {
    installTransport(() => sse([
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "local " }, finish_reason: null }] },
      { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] },
      { id: "chatcmpl-test", choices: [], usage: completion().usage },
    ]));
    const result = await runner().run(new Agent({ name: "studio", model: "selfhosted/local-model" }), "hello", { stream: true });
    const events: ResponseStreamEvent[] = [];
    for await (const event of result) if (event.type === "raw_model_stream_event") events.push(event.data);
    await result.completed;
    expect(result.finalOutput).toBe("local answer");
    expect(events.filter((event) => event.type === "output_text_delta").map((event) => event.delta).join("")).toBe("local answer");
    expect(result.rawResponses[0]?.rawUsage).toMatchObject({ cost: 0.012 });
  });

  it.each([false, true])("keeps reasoning_content on its own tool turn (stream=%s)", async (stream) => {
    const requests = installTransport((_body, index) => {
      if (stream) return sse(index === 0 ? [
        { id: "chatcmpl-reason", choices: [{ index: 0, delta: { reasoning_content: "private thought" }, finish_reason: null }] },
        { id: "chatcmpl-reason", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      ] : [{ id: "chatcmpl-answer", choices: [{ index: 0, delta: { content: "answer" }, finish_reason: "stop" }] }]);
      const response = index === 0
        ? completion("", [{ id: "call_read", type: "function", function: { name: "read", arguments: "{}" } }])
        : completion("answer");
      if (index === 0) Object.assign(response.choices[0]!.message, { reasoning_content: "private thought" });
      return Response.json(response);
    });
    const agent = new Agent({ name: "studio", model: "selfhosted/local-model", tools: [tool({
      name: "read", description: "Read", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: async () => "read result",
    })] });
    const runtime = runner();
    if (stream) {
      const result = await runtime.run(agent, "read", { stream: true });
      for await (const event of result) void event;
      await result.completed;
      expect(result.finalOutput).toBe("answer");
    } else expect((await runtime.run(agent, "read")).finalOutput).toBe("answer");
    const messages = requests[1]?.body.messages as Array<Record<string, unknown>>;
    expect(messages.find((message) => message.tool_calls)).toMatchObject({ reasoning_content: "private thought" });
    expect(messages.filter((message) => "reasoning_content" in message)).toHaveLength(1);
    expect(messages.some((message) => "reasoning" in message)).toBe(false);
  });

  it("pauses for approval, serializes RunState and executes only after approval", async () => {
    const requests = installTransport((_body, index) => Response.json(index === 0
      ? completion("", [{ id: "call_write", type: "function", function: { name: "write", arguments: "{}" } }])
      : completion("saved")));
    const execute = vi.fn(async () => "saved");
    const agent = new Agent({ name: "studio", model: "selfhosted/local-model", tools: [tool({
      name: "write", description: "Write a record", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, needsApproval: true, execute,
    })] });
    const runtime = runner();
    const paused = await runtime.run(agent, "save this");
    expect(paused.interruptions).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    const state = await RunState.fromString(agent, paused.state.toString());
    state.approve(paused.interruptions[0]!);
    const resumed = await runtime.run(agent, state);
    expect(resumed.finalOutput).toBe("saved");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
  });

  it("runs blocking input guardrails before any model call", async () => {
    const requests = installTransport(() => Response.json(completion()));
    const agent = new Agent({ name: "studio", model: "selfhosted/local-model", inputGuardrails: [{
      name: "policy", runInParallel: false,
      execute: async () => ({ tripwireTriggered: true, outputInfo: { reason: "denied" } }),
    }] });
    await expect(runner().run(agent, "blocked")).rejects.toBeInstanceOf(InputGuardrailTripwireTriggered);
    expect(requests).toEqual([]);
  });
});
