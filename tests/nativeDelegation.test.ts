import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentModelProvider } from "@/infrastructure/llm/agentModels";
import { runAgent } from "@/application/runtime";
import type { AgentDeps, RunAgentInput } from "@/application/runtime/types";
import type { EngineChunk } from "@/domain/llm/types";

const ROOT = "openai/gpt-5-mini";
const CHILD = "google/gemini-2.5-flash";
let testId = 0;

beforeEach(() => {
  testId += 1;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function answer(content: string) {
  return [{ index: 0, delta: { content }, finish_reason: "stop" }];
}
function calls(...entries: Array<{ name: string; input?: string }>) {
  return [{ index: 0, delta: { tool_calls: entries.map((entry, index) => ({
    index, id: `call_${index}`, type: "function", function: { name: entry.name, arguments: entry.input === undefined ? "{}" : JSON.stringify({ input: entry.input, image_ids: [] }) },
  })) }, finish_reason: "tool_calls" }];
}

function fixture(reply: (body: Record<string, unknown>, index: number) => unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    const data = JSON.stringify({ id: `response_${requests.length}`, choices: reply(body, requests.length - 1), usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
    return new Response(`data: ${data}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  }));
  const models = createAgentModelProvider(async (model) => ({ providerName: null, baseUrl: `http://delegation-${testId}.test/v1`, apiKey: "test", auth: "bearer", model }));
  const closed = vi.fn(async () => {});
  const loadAgent = vi.fn<NonNullable<AgentDeps["loadAgent"]>>(async (name, task) => ({
    deps: { createToolSchemaValidator, channel: models }, close: closed, warnings: [],
    input: { projectName: name, model: CHILD, maxTurn: 4, messages: [{ role: "user", content: task.message }], signal: task.signal },
  }));
  const deps: AgentDeps = { createToolSchemaValidator, channel: models, canDelegate: true, loadAgent };
  const input: RunAgentInput = { projectName: "root", model: ROOT, maxTurn: 8, canDispatch: true, messages: [{ role: "user", content: "help me" }], subagents: [{ name: "child", description: "Specialist" }] };
  return { deps, input, requests, closed, loadAgent, models };
}

async function collect(source: AsyncGenerator<EngineChunk>) {
  const output: EngineChunk[] = [];
  for await (const chunk of source) output.push(chunk);
  return output;
}

describe("native SDK delegation", () => {
  it("hands the same Runner to the child, which supplies the top-level answer", async () => {
    const f = fixture((_body, index) => index === 0 ? calls({ name: "handoff_child", input: "take over" }) : answer("specialist answer"));
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(f.requests.map((body) => body.model)).toEqual([ROOT, CHILD]);
    expect(chunks.filter((chunk) => !chunk.author).map((chunk) => chunk.delta?.content ?? "").join("")).toBe("specialist answer");
    expect(chunks.some((chunk) => chunk.toolResult?.name === "handoff_child: child")).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ done: true });
    expect(f.closed).toHaveBeenCalledTimes(1);
  });

  it("uses Agent.asTool, then returns the child answer as a tool result to the parent", async () => {
    const f = fixture((body, index) => index === 0 ? calls({ name: "delegate_child", input: "research" }) : body.model === CHILD ? answer("research result") : answer("parent synthesis"));
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(f.requests.map((body) => body.model)).toEqual([ROOT, CHILD, ROOT]);
    expect(chunks.filter((chunk) => chunk.author === "child").map((chunk) => chunk.delta?.content ?? "").join("")).toBe("research result");
    expect(chunks.filter((chunk) => !chunk.author).map((chunk) => chunk.delta?.content ?? "").join("")).toBe("parent synthesis");
    expect(f.requests[2]?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", content: "research result" })]));
    expect(chunks.some((chunk) => chunk.author === "child" && chunk.authorDone)).toBe(true);
    expect(f.closed).toHaveBeenCalledTimes(1);
  });

  it("prepares independent native invocations when the same agent is requested twice", async () => {
    const f = fixture((body, index) => index === 0 ? calls({ name: "delegate_child", input: "first" }, { name: "delegate_child", input: "second" }) : body.model === CHILD ? answer(`result ${index}`) : answer("both done"));
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(f.loadAgent).toHaveBeenCalledTimes(2);
    expect(f.closed).toHaveBeenCalledTimes(2);
    expect(chunks.filter((chunk) => chunk.authorDone).map((chunk) => chunk.transferId)).toEqual(expect.arrayContaining(["call_0", "call_1"]));
    expect(chunks.at(-1)).toMatchObject({ done: true });
    expect(f.requests.filter((body) => body.model === CHILD)).toHaveLength(2);
  });

  it("preserves a hyphenated local Agent tool name", async () => {
    const f = fixture((body, index) => index === 0
      ? calls({ name: "delegate_image-agent", input: "draw" })
      : body.model === CHILD ? answer("image delivered") : answer("delivered"));
    f.input.subagents = [{ name: "image-agent", description: "Draw images" }];
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(f.loadAgent).toHaveBeenCalledTimes(1);
    expect(f.requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "delegate_image-agent" }) })]));
    expect(chunks.some((chunk) => chunk.delta?.content === "image delivered" && chunk.author === "image-agent")).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ done: true });
  });

  it("reports a child admission refusal as a tool result and lets the parent answer", async () => {
    const f = fixture((_body, index) => index === 0 ? calls({ name: "delegate_child", input: "research" }) : answer("The specialist is unavailable"));
    f.loadAgent.mockRejectedValue(new Error("Child project spending limit reached"));
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(f.requests.map((body) => body.model)).toEqual([ROOT, ROOT]);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("spending limit"))).toBe(true);
    expect(chunks.some((chunk) => chunk.warning?.includes("child"))).toBe(true);
    expect(chunks.at(-1)).toMatchObject({ done: true });
  });

  it("masks the delegated context and restores the child's streamed text", async () => {
    const f = fixture((body, index) => {
      if (index === 0) {
        const supplied = String((body.messages as Array<{ content: string }>).at(-1)?.content);
        return calls({ name: "delegate_child", input: supplied });
      }
      if (body.model === CHILD) return answer(String((body.messages as Array<{ content: string }>).at(-1)?.content));
      return answer("done");
    });
    f.input.messages = [{ role: "user", content: "email@example.com" }];
    f.input.parameters = { piiFiltering: true };
    const chunks = await collect(runAgent(f.deps, f.input));
    expect(JSON.stringify(f.requests)).not.toContain("email@example.com");
    expect(f.loadAgent.mock.calls[0]?.[1].message).toContain("[[PII:");
    expect(chunks.filter((chunk) => chunk.author === "child").map((chunk) => chunk.delta?.content ?? "").join("")).toContain("email@example.com");
  });


});
