import { runtimeSessionFixture as fixture } from "./runtimeSessionFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRuntimeSession, pendingRuntimeApproval, readRuntimeSession, discardRuntimeCheckpoint } from "@/application/runtime/session";
import { runAgent } from "@/application/runtime";
import type { AgentDeps } from "@/application/runtime/types";
import { FakeChannel, contentChunk, toolCallChunk, usageChunk } from "./fakeChannel";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });


describe("durable native SDK Session", () => {
  it("keeps a preceding user image editable after a version enables image tools", async () => {
    const f = fixture();
    const image = { b64: "aGVsbG8=", mimeType: "image/png" };
    await f.run(new FakeChannel([[contentChunk("seen")]]), "", undefined, {}, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image.b64}` } }] }] });
    const editImage = vi.fn(async () => ({ b64: "Ymx1ZQ==", mimeType: "image/png", model: "openai/gpt-image-2" }));
    const next = new FakeChannel([[toolCallChunk(0, "edit", "EditImage", '{"image_id":"img_1","prompt":"blue"}')], [contentChunk("edited")]]);
    const chunks = await f.run(next, "edit the prior image", undefined, { editImage });
    expect(chunks.some((chunk) => chunk.error)).toBe(false);
    expect(editImage).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining(image)] }));
    expect(JSON.stringify(next.seenParams[0]?.messages)).toContain(image.b64);
  });

  it("keeps the newest Session images and marks omitted image-only turns", async () => {
    const f = fixture();
    for (let index = 0; index < 5; index += 1) {
      const url = `data:image/png;base64,${Buffer.from(`image-${index}`).toString("base64")}`;
      await f.run(new FakeChannel([[contentChunk(`seen ${index}`)]]), "", undefined, {}, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] });
    }
    const next = new FakeChannel([[contentChunk("done")]]);
    const chunks = await f.run(next, "compare");
    expect(chunks.some((chunk) => chunk.warning?.includes("1 earlier image(s)"))).toBe(true);
    const messages = JSON.stringify(next.seenParams[0]?.messages);
    expect(messages).toContain("earlier image is no longer available");
    expect(messages).not.toContain(Buffer.from("image-0").toString("base64"));
    expect(messages).toContain(Buffer.from("image-4").toString("base64"));
  });

  it("delegates with previous SDK Session turns when the caller sends only its new question", async () => {
    const f = fixture();
    await f.run(new FakeChannel([[contentChunk("an orange cat")]]), "draw a cat");
    const channel = new FakeChannel([[toolCallChunk(0, "delegate", "delegate_child", '{"input":"make it bigger","image_ids":[]}')], [contentChunk("larger cat")], [contentChunk("done")]]);
    const loadAgent = vi.fn<NonNullable<AgentDeps["loadAgent"]>>(async (name, task) => ({ kind: "agent", deps: { channel }, warnings: [], close: async () => {}, input: { projectName: name, model: f.version.model, messages: [{ role: "user", content: task.message }] } }));
    await f.run(channel, "make it bigger", undefined, { loadAgent }, { canDispatch: true, subagents: [{ name: "child", type: "local", description: "child" }] });
    expect(loadAgent.mock.calls[0]?.[1].transcript).toContain("User: draw a cat");
    expect(loadAgent.mock.calls[0]?.[1].transcript).toContain("project: an orange cat");
    expect(loadAgent.mock.calls[0]?.[1].transcript).not.toContain("make it bigger");
  });

  it("does not hold a sibling result behind a tool waiting for approval", async () => {
    const f = fixture({ approvalTools: ["approval"] });
    const callMcpTool = vi.fn(async () => ({ text: "read" }));
    const tools = ["approval", "read"].map((name) => ({ type: "function" as const, function: { name, parameters: {} } }));
    const channel = new FakeChannel([[toolCallChunk(0, "pending", "approval", "{}"), toolCallChunk(1, "allowed", "read", "{}")]]);
    const chunks = await f.run(channel, "read and act", undefined, { callMcpTool }, { mcpTools: tools });
    expect(callMcpTool).toHaveBeenCalledExactlyOnceWith("read", {});
    expect(chunks.some((chunk) => chunk.toolResult?.toolCallId === "allowed")).toBe(true);
    expect((await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))?.approvals).toHaveLength(1);
  });

  it("preserves exact SDK turns across fresh Session objects without replaying the new user turn twice", async () => {
    const f = fixture();
    const first = new FakeChannel([[contentChunk("first answer"), usageChunk(2, 1)]]);
    expect((await f.run(first, "first question")).some((chunk) => chunk.error)).toBe(false);
    const second = new FakeChannel([[contentChunk("second answer"), usageChunk(3, 1)]]);
    expect((await f.run(second, "second question")).some((chunk) => chunk.error)).toBe(false);
    expect(second.seenParams[0]?.messages.filter((message) => message.role !== "system")).toEqual([
      { role: "user", content: "first question" },
      expect.objectContaining({ role: "assistant", content: [expect.objectContaining({ type: "text", text: "first answer" })] }),
      { role: "user", content: "second question" },
    ]);
    const saved = await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail);
    expect(saved?.document.items).toHaveLength(4);
    expect(f.rows.get("chat-1")?.payload).not.toContain("first question");
  });

  it("saves an approval before any effect and resumes once after reconstructing the SDK state", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    const effect = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ text: `result for ${args.query}` }));
    const tool = { type: "function" as const, function: { name: "lookup", parameters: { type: "object", properties: { query: { type: "string" } } } } };
    const first = new FakeChannel([[toolCallChunk(0, "call", "lookup", '{"query":"hello"}'), usageChunk(2, 1)]]);
    const chunks = await f.run(first, "lookup", undefined, { callMcpTool: effect }, { mcpTools: [tool] });
    expect(chunks.some((chunk) => chunk.approval)).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    const pending = await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail);
    expect(pending?.status).toBe("pending");
    const decision = { revision: pending!.revision, decisions: [{ id: pending!.approvals[0]!.id, approve: true }] };
    const second = new FakeChannel([[contentChunk("done"), usageChunk(3, 1)]]);
    const resumed = await f.run(second, "", decision, { callMcpTool: effect }, { mcpTools: [tool] });
    expect(resumed.some((chunk) => chunk.error)).toBe(false);
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { query: "hello" });
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
    await expect(f.run(new FakeChannel([]), "", decision, { callMcpTool: effect })).rejects.toThrow("no longer pending");
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("restores PII mappings for approved arguments while model requests remain masked", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    const initial = await openRuntimeSession(f.services, f.scope);
    const token = initial.filter!.mask("private@example.com");
    const channel = new FakeChannel([[toolCallChunk(0, "call", "lookup", JSON.stringify({ query: token }))]]);
    const effect = vi.fn(async () => ({ text: "found" }));
    const tools = [{ type: "function" as const, function: { name: "lookup", parameters: { type: "object", properties: {} } } }];
    for await (const chunk of runAgent({ channel, callMcpTool: effect }, { projectName: "project", model: f.version.model, parameters: f.version.parameters, messages: [{ role: "user", content: "private@example.com" }], mcpTools: tools, runtime: initial })) expect(chunk.error).toBeUndefined();
    const pending = await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail);
    expect(pending?.approvals[0]?.arguments).toContain("private@example.com");
    const next = new FakeChannel([[contentChunk("done")]]);
    await f.run(next, "", { revision: pending!.revision, decisions: [{ id: pending!.approvals[0]!.id, approve: true }] }, { callMcpTool: effect }, { mcpTools: tools });
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { query: "private@example.com" });
    expect(JSON.stringify(next.seenParams)).not.toContain("private@example.com");
  });

  it("refuses a stale approval and changed version before model execution", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    await f.run(new FakeChannel([[toolCallChunk(0, "call", "lookup", "{}")]]), "lookup", undefined, { callMcpTool: async () => ({ text: "done" }) }, { mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] });
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const decisions = [{ id: pending.approvals[0]!.id, approve: true }];
    await expect(openRuntimeSession(f.services, f.scope, { revision: pending.revision - 1, decisions })).rejects.toThrow("no longer pending");
    await expect(openRuntimeSession(f.services, { ...f.scope, version: { ...f.version, systemPrompt: "changed" } }, { revision: pending.revision, decisions })).rejects.toThrow("version changed");
    expect(await pendingRuntimeApproval(f.services, "chat-1", "someone@example.com")).toBeNull();
    await discardRuntimeCheckpoint(f.services, "chat-1", f.scope.ownerEmail, pending.revision);
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
  });

  it("runs the SDK input guardrail before a model call", async () => {
    const f = fixture({ maxInputChars: 3 });
    const channel = new FakeChannel([]);
    const chunks = await f.run(channel, "too long");
    expect(channel.calls).toBe(0);
    expect(chunks.some((chunk) => chunk.error)).toBe(true);
  });

  it("claims an approval atomically before either competing worker may execute it", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    await f.run(new FakeChannel([[toolCallChunk(0, "call", "lookup", "{}")]]), "lookup", undefined, { callMcpTool: async () => ({ text: "done" }) }, { mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] });
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const decision = { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] };
    const claims = await Promise.allSettled([openRuntimeSession(f.services, f.scope, decision), openRuntimeSession(f.services, f.scope, decision)]);
    expect(claims.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    expect((await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))?.status).toBe("running");
    await expect(openRuntimeSession(f.services, f.scope, decision)).rejects.toThrow("no longer pending");
  });

  it("restores generated image handles before resuming an approved edit", async () => {
    const f = fixture({ approvalTools: ["EditImage"] });
    const edit = vi.fn(async () => ({ b64: "Ymx1ZQ==", mimeType: "image/png", model: "openai/gpt-image-2" }));
    const deps = { generateImage: async () => ({ b64: "aGVsbG8=", mimeType: "image/png", model: "openai/gpt-image-2" }), editImage: edit };
    const initial = new FakeChannel([
      [toolCallChunk(0, "generate", "GenerateImage", '{"prompt":"fox"}')],
      [toolCallChunk(0, "edit", "EditImage", '{"image_id":"img_1","prompt":"blue"}')],
    ]);
    await f.run(initial, "draw and edit", undefined, deps);
    expect(edit).not.toHaveBeenCalled();
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const resumed = await f.run(new FakeChannel([[contentChunk("done")]]), "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] }, deps);
    expect(resumed.some((chunk) => chunk.error)).toBe(false);
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "blue", images: [expect.objectContaining({ b64: "aGVsbG8=" })] }));
  });

  it("keeps per-run file limits across successive approval checkpoints", async () => {
    const f = fixture({ approvalTools: ["SaveFile"] });
    const saveFile = vi.fn(async () => ({ text: "saved" }));
    const call = (index: number) => toolCallChunk(index, `save-${index}`, "SaveFile", JSON.stringify({ name: `${index}.txt`, mime_type: "text/plain", content: "data" }));
    await f.run(new FakeChannel([Array.from({ length: 10 }, (_, index) => call(index))]), "save files", undefined, { saveFile });
    const first = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    await f.run(new FakeChannel([[call(10)]]), "", { revision: first.revision, decisions: first.approvals.map((item) => ({ id: item.id, approve: true })) }, { saveFile });
    expect(saveFile).toHaveBeenCalledTimes(10);
    const next = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const chunks = await f.run(new FakeChannel([[contentChunk("finished")]]), "", { revision: next.revision, decisions: next.approvals.map((item) => ({ id: item.id, approve: true })) }, { saveFile });
    expect(saveFile).toHaveBeenCalledTimes(10);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("already written 10 files"))).toBe(true);
  });

  it("reconstructs a handed-off agent before the SDK restores its pending tool", async () => {
    const f = fixture();
    const effect = vi.fn(async () => ({ text: "looked up" }));
    let model = new FakeChannel([
      [toolCallChunk(0, "handoff", "handoff_child", '{"input":"lookup","image_ids":[]}')],
      [toolCallChunk(0, "lookup", "lookup", "{}")],
    ]);
    const loadAgent: AgentDeps["loadAgent"] = async (name) => ({ kind: "agent", deps: { channel: model, callMcpTool: effect }, warnings: [], close: async () => {}, input: {
      projectName: name, model: f.version.model, parameters: { piiFiltering: true, policy: { approvalTools: ["lookup"] } }, messages: [{ role: "user", content: "lookup" }], maxTurn: 4,
      mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }],
    } });
    const input = { subagents: [{ name: "child", type: "local" as const, description: "child" }] };
    await f.run(model, "handoff", undefined, { loadAgent }, input);
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    expect(pending.approvals[0]?.agent).toBe("child");
    model = new FakeChannel([[contentChunk("child answer")]]);
    const chunks = await f.run(model, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] }, { loadAgent }, input);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(chunks.some((chunk) => chunk.error)).toBe(false);
    expect(chunks.map((chunk) => chunk.delta?.content ?? "").join("")).toBe("child answer");
  });

  it("resumes a delegated agent's handoff approval with the child's private PII mapping", async () => {
    const f = fixture();
    f.version.parameters.piiFiltering = false;
    const effect = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ text: `found ${args.query}` }));
    let channel = new FakeChannel([
      [toolCallChunk(0, "delegate", "delegate_child", '{"input":"private lookup","image_ids":[]}')],
      [toolCallChunk(0, "handoff", "handoff_specialist", '{"input":"private@example.com","image_ids":[]}')],
      [toolCallChunk(0, "lookup", "lookup", '{"query":"private@example.com"}')],
    ]);
    const loadAgent: NonNullable<AgentDeps["loadAgent"]> = async (name, task) => ({
      kind: "agent", deps: { channel, loadAgent, callMcpTool: effect }, warnings: [], close: async () => {},
      input: { projectName: name, model: f.version.model, messages: [{ role: "user", content: task.message }], maxTurn: 4,
        parameters: { piiFiltering: true, ...(name === "specialist" ? { policy: { approvalTools: ["lookup"] } } : {}) },
        ...(name === "child" ? { subagents: [{ name: "specialist", type: "local" as const, description: "specialist" }] } : { mcpTools: [{ type: "function" as const, function: { name: "lookup", parameters: {} } }] }),
      },
    });
    const input = { canDispatch: true, subagents: [{ name: "child", type: "local" as const, description: "child" }] };
    const initial = await f.run(channel, "delegate", undefined, { loadAgent }, input);
    expect(initial.filter((chunk) => chunk.error)).toEqual([]);
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    expect(pending.approvals[0]?.agent).toBe("specialist");
    expect(pending.approvals[0]?.arguments).toContain("private@example.com");
    expect(effect).not.toHaveBeenCalled();
    channel = new FakeChannel([[contentChunk("specialist done")], [contentChunk("parent done")]]);
    const chunks = await f.run(channel, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] }, { loadAgent }, input);
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { query: "private@example.com" });
    expect(JSON.stringify(channel.seenParams[0])).not.toContain("private@example.com");
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
  });

  it("applies a delegated version's SDK input guardrail before its model runs", async () => {
    const f = fixture();
    const channel = new FakeChannel([[toolCallChunk(0, "delegate", "delegate_child", '{"input":"too long","image_ids":[]}')], [contentChunk("parent recovered")]]);
    const child = new FakeChannel([]);
    const loadAgent: AgentDeps["loadAgent"] = async (name, task) => ({ kind: "agent", deps: { channel: child }, warnings: [], close: async () => {}, input: { projectName: name, model: f.version.model, messages: [{ role: "user", content: task.message }], parameters: { policy: { maxInputChars: 2 } } } });
    const chunks = await f.run(channel, "delegate", undefined, { loadAgent }, { canDispatch: true, subagents: [{ name: "child", type: "local", description: "child" }] });
    expect(child.calls).toBe(0);
    expect(chunks.some((chunk) => chunk.warning?.includes("guardrail"))).toBe(true);
  });

  it("keeps concurrent handoff approvals distinct after a fresh graph reconstruction", async () => {
    const f = fixture();
    let resuming = false;
    const effect = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ text: String(args.value) }));
    const loadAgent: NonNullable<AgentDeps["loadAgent"]> = async (name, task) => ({
      kind: "agent", warnings: [], close: async () => {},
      deps: { channel: new FakeChannel(resuming ? [] : [[toolCallChunk(0, "handoff", "handoff_specialist", JSON.stringify({ input: task.message, image_ids: [] }))]]),
        loadAgent: async (target, handoffTask) => ({ kind: "agent", warnings: [], close: async () => {},
          deps: { channel: new FakeChannel(resuming ? [[contentChunk("specialist done")]] : [[toolCallChunk(0, "lookup", "lookup", JSON.stringify({ value: handoffTask.message }))]]), callMcpTool: effect },
          input: { projectName: target, model: f.version.model, messages: [{ role: "user", content: handoffTask.message }], parameters: { policy: { approvalTools: ["lookup"] } }, mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] },
        }),
      },
      input: { projectName: name, model: f.version.model, messages: [{ role: "user", content: task.message }], subagents: [{ name: "specialist", type: "local", description: "specialist" }] },
    });
    const input = { canDispatch: true, subagents: [{ name: "child", type: "local" as const, description: "child" }] };
    await f.run(new FakeChannel([[toolCallChunk(0, "first", "delegate_child", '{"input":"first","image_ids":[]}'), toolCallChunk(1, "second", "delegate_child", '{"input":"second","image_ids":[]}')]]), "delegate", undefined, { loadAgent }, input);
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    expect(pending.approvals).toHaveLength(2);
    const chosen = pending.approvals.find((item) => item.arguments.includes("first"))!;
    resuming = true;
    const chunks = await f.run(new FakeChannel([[contentChunk("parent done")]]), "", { revision: pending.revision, decisions: pending.approvals.map((item) => ({ id: item.id, approve: item.id === chosen.id })) }, { loadAgent }, input);
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { value: "first" });
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
  });
});
