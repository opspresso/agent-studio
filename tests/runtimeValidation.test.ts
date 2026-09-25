import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeChannel, contentChunk, toolCallChunk } from "./fakeChannel";
import { runtimeSessionFixture } from "./runtimeSessionFixture";
import { runAgent } from "@/application/runtime";
import { pendingRuntimeApproval } from "@/application/runtime/session";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("SDK runtime validation boundaries", () => {
  it("fails closed when tool schema validation was not wired", async () => {
    const channel = new FakeChannel([]);
    const chunks = [];
    for await (const chunk of runAgent({ channel }, {
      agentName: "agent", model: "openai/gpt-5-mini", messages: [{ role: "user", content: "lookup" }],
      mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    })) chunks.push(chunk);
    expect(channel.calls).toBe(0);
    expect(chunks).toEqual([{ error: "Tool schema validation is not configured" }]);
  });

  it("applies the input limit before PII masking", async () => {
    const message = "person@example.com";
    const channel = new FakeChannel([[contentChunk("done")]]);
    const chunks = [];
    for await (const chunk of runAgent({ channel }, { agentName: "p", model: "openai/gpt-5-mini",
      messages: [{ role: "user", content: message }], parameters: { piiFiltering: true, policy: { maxInputChars: message.length } } })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ done: true });
    expect(JSON.stringify(channel.seenParams)).not.toContain(message);
  });

  it("checks a handoff target's input policy before its first model request", async () => {
    const f = runtimeSessionFixture();
    const root = new FakeChannel([[toolCallChunk(0, "transfer", "handoff_child", '{"input":"too long","image_ids":[]}')]]);
    const child = new FakeChannel([[contentChunk("must not run")]]);
    const close = vi.fn(async () => {});
    const chunks = await f.run(root, "help", undefined, {
      loadAgent: async (name, task) => ({
        deps: { channel: child }, warnings: [], close,
        input: { agentName: name, model: f.configuration.model, messages: [{ role: "user", content: task.message }], parameters: { policy: { maxInputChars: 2 } } },
      }),
    }, { subagents: [{ name: "child", description: "child" }] });
    expect(child.calls).toBe(0);
    expect(chunks.some((chunk) => chunk.error?.includes("input-size"))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it.each([
    '{"operation":"delete","count":1}',
    '{"operation":"read","count":"1"}',
    '{"operation":"read"}',
    '{"operation":"read","count":1,"unexpected":true}',
  ])("rejects schema-invalid MCP input before dispatch: %s", async (args) => {
    const f = runtimeSessionFixture();
    const effect = vi.fn(async () => ({ text: "executed" }));
    const channel = new FakeChannel([
      [toolCallChunk(0, "invalid", "lookup", args), toolCallChunk(1, "valid", "lookup", '{"operation":"read","count":1}')],
      [contentChunk("recovered")],
    ]);
    const chunks = await f.run(channel, "lookup", undefined, { callMcpTool: effect }, {
      mcpTools: [{ type: "function", function: { name: "lookup", parameters: {
        type: "object", properties: { operation: { type: "string", enum: ["read"] }, count: { type: "integer", minimum: 1 } },
        required: ["operation", "count"], additionalProperties: false,
      } } }],
    });
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { operation: "read", count: 1 });
    expect(chunks.filter((chunk) => chunk.toolResult?.toolCallId === "invalid")).toHaveLength(1);
    expect(chunks.find((chunk) => chunk.toolResult?.toolCallId === "invalid")?.toolResult?.content).toContain("Error:");
    expect(chunks.at(-1)).toMatchObject({ done: true });
  });

  it("validates restored PII formats and refuses invalid arguments before approval", async () => {
    const f = runtimeSessionFixture({ approvalTools: ["lookup"] });
    const effect = vi.fn(async () => ({ text: "done" }));
    const input = { mcpTools: [{ type: "function" as const, function: { name: "lookup", parameters: {
      type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"],
    } } }] };
    for (const email of ["person@example.com", "not-an-email"]) {
      const first = new FakeChannel([[toolCallChunk(0, "lookup", "lookup", JSON.stringify({ email }))], [contentChunk("invalid request")]]);
      const initial = await f.run(first, email, undefined, { callMcpTool: effect }, input);
      const pending = await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail);
      if (email === "not-an-email") {
        expect(pending).toBeNull();
        expect(initial.find((chunk) => chunk.toolResult)?.toolResult?.content).toContain("format");
        continue;
      }
      if (!pending) throw new Error("Expected a valid approval request");
      expect(pending.approvals).toHaveLength(1);
      const next = new FakeChannel([[contentChunk("done")]]);
      const chunks = await f.run(next, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] }, { callMcpTool: effect }, input);
      expect(chunks.at(-1)).toMatchObject({ done: true });
      expect(JSON.stringify(next.seenParams)).not.toContain("person@example.com");
    }
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { email: "person@example.com" });
  });

  it("rejects an invalid delegation before returning an approval", async () => {
    const name = "delegate_child";
    const f = runtimeSessionFixture({ approvalTools: [name] });
    const channel = new FakeChannel([[toolCallChunk(0, "invalid", name, '{"input":42,"image_ids":[]}')], [contentChunk("recovered")]]);
    const loadAgent = vi.fn();
    const chunks = await f.run(channel, "help", undefined, { loadAgent },
      { canDispatch: true, subagents: [{ name: "child", description: "child" }] });
    expect(loadAgent).not.toHaveBeenCalled();
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
    expect(chunks.filter((chunk) => chunk.toolResult?.toolCallId === "invalid")).toHaveLength(1);
    expect(chunks.at(-1)).toMatchObject({ done: true });
  });
});
