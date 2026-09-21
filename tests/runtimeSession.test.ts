import { brotliCompressSync } from "node:zlib";
import { runtimeSessionContext } from "@/domain/security/secretContext";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { runtimeSessionFixture as fixture } from "./runtimeSessionFixture";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openRuntimeSession, pendingRuntimeApproval, readRuntimeSession, discardRuntimeCheckpoint } from "@/application/runtime/session";
import { runAgent } from "@/application/runtime";
import type { AgentDeps } from "@/application/runtime/types";
import { FakeChannel, contentChunk, toolCallChunk, usageChunk } from "./fakeChannel";

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-12T00:00:00Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("durable native SDK Session", () => {
  const imageResult = (text: string) => ({ b64: Buffer.from(text).toString("base64"), mimeType: "image/png", model: "openai/gpt-image-2", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });

  it("keeps retained image IDs after eviction and allocates distinct IDs to new attachments and edits", async () => {
    const f = fixture();
    const generateImage = vi.fn(async (prompt: string) => imageResult(prompt));
    const editImage = vi.fn(async (_input: { prompt: string }) => imageResult("edited"));
    await f.run(new FakeChannel([
      ...Array.from({ length: 5 }, (_, index) => [toolCallChunk(0, `generate-${index}`, "GenerateImage", JSON.stringify({ prompt: `image-${index + 1}` }))]),
      [contentChunk("drawn")],
    ]), "draw five", undefined, { generateImage, editImage }, { maxTurn: 7 });
    const next = new FakeChannel([
      [toolCallChunk(0, "old", "EditImage", '{"image_id":"img_2","prompt":"edit retained"}')],
      [toolCallChunk(0, "new", "EditImage", '{"image_id":"img_6","prompt":"edit attachment"}')],
      [toolCallChunk(0, "gone", "EditImage", '{"image_id":"img_1","prompt":"edit evicted"}')],
      [contentChunk("done")],
    ]);
    const chunks = await f.run(next, "", undefined, { editImage }, { messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageResult("attachment").b64}` } },
    ] }] });
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(editImage).toHaveBeenCalledTimes(2);
    expect(editImage.mock.calls[0]?.[0]).toMatchObject({ images: [{ b64: imageResult("image-2").b64 }] });
    expect(editImage.mock.calls[1]?.[0]).toMatchObject({ images: [{ b64: imageResult("attachment").b64 }] });
    const prompt = String(next.seenParams[0]?.messages.find((message) => message.role === "system")?.content);
    expect(prompt).toContain("img_2");
    expect(prompt).toContain("img_5");
    expect(prompt).toContain("img_6");
    expect(prompt).not.toContain("img_1");
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_7"))).toBe(true);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_8"))).toBe(true);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("no image with id 'img_1'"))).toBe(true);
  });

  it("builds the resumed image prompt from the checkpoint and keeps allocating after its IDs", async () => {
    const f = fixture({ approvalTools: ["EditImage"] });
    const editImage = vi.fn(async (_input: { prompt: string }) => imageResult("edited"));
    const deps = { generateImage: async (prompt: string) => imageResult(prompt), editImage };
    await f.run(new FakeChannel([
      [toolCallChunk(0, "generate", "GenerateImage", '{"prompt":"original"}')],
      [toolCallChunk(0, "edit", "EditImage", '{"image_id":"img_1","prompt":"blue"}')],
    ]), "draw and edit", undefined, deps);
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const next = new FakeChannel([
      [toolCallChunk(0, "another", "GenerateImage", '{"prompt":"another"}')],
      [contentChunk("done")],
    ]);
    const chunks = await f.run(next, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] }, deps);
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(editImage).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ b64: imageResult("original").b64 })] }));
    expect(String(next.seenParams[0]?.messages.find((message) => message.role === "system")?.content)).toContain("img_1");
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_2"))).toBe(true);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_3"))).toBe(true);
  });

  it("does not resurrect evicted handles from older inline history when image tools are disabled", async () => {
    const f = fixture();
    const generateImage = async (prompt: string) => imageResult(prompt);
    await f.run(new FakeChannel([
      ...Array.from({ length: 5 }, (_, index) => [toolCallChunk(0, `generate-${index}`, "GenerateImage", JSON.stringify({ prompt: `generated-${index}` }))]),
      [contentChunk("drawn")],
    ]), "", undefined, { generateImage }, { maxTurn: 7, messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: `data:image/png;base64,${imageResult("attachment").b64}` } },
    ] }] });
    const retainedIds = async () => (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document.images!.map((image) => image.id);
    expect(await retainedIds()).toEqual(["img_3", "img_4", "img_5", "img_6"]);
    await f.run(new FakeChannel([[contentChunk("remembered")]]), "remember");
    expect(await retainedIds()).toEqual(["img_3", "img_4", "img_5", "img_6"]);
    const chunks = await f.run(new FakeChannel([[toolCallChunk(0, "next", "GenerateImage", '{"prompt":"new"}')], [contentChunk("done")]]), "draw another", undefined, { generateImage });
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_7"))).toBe(true);
  });

  it("restores pre-approval handles on discard without reusing the abandoned run's IDs", async () => {
    const f = fixture({ approvalTools: ["EditImage"] });
    const deps = { generateImage: async (prompt: string) => imageResult(prompt), editImage: vi.fn(async (_input: { prompt: string }) => imageResult("edited")) };
    await f.run(new FakeChannel([[toolCallChunk(0, "prior", "GenerateImage", '{"prompt":"prior"}')], [contentChunk("done")]]), "draw prior", undefined, deps);
    await f.run(new FakeChannel([
      [toolCallChunk(0, "abandoned", "GenerateImage", '{"prompt":"abandoned"}')],
      [toolCallChunk(0, "pending", "EditImage", '{"image_id":"img_2","prompt":"edit abandoned"}')],
    ]), "draw and edit", undefined, deps);
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    await discardRuntimeCheckpoint(f.services, "chat-1", f.scope.ownerEmail, pending.revision);
    const saved = (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document;
    expect(saved.images).toEqual([expect.objectContaining({ id: "img_1", b64: imageResult("prior").b64 })]);
    const channel = new FakeChannel([[toolCallChunk(0, "new", "GenerateImage", '{"prompt":"new"}')], [contentChunk("done")]]);
    const chunks = await f.run(channel, "new drawing", undefined, deps);
    const prompt = String(channel.seenParams[0]?.messages.find((message) => message.role === "system")?.content);
    expect(prompt).toContain("img_1");
    expect(prompt).not.toContain("img_2");
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_3"))).toBe(true);
    expect(deps.editImage).not.toHaveBeenCalled();
  });

  it.each(["delegate", "handoff"] as const)("keeps %s image IDs unique while exposing only selected handles to the child", async (mode) => {
    const f = fixture();
    const childChannel = new FakeChannel([
      [toolCallChunk(0, "edit", "EditImage", '{"image_id":"img_2","prompt":"child edit"}')],
      [contentChunk("child done")],
    ]);
    const editImage = vi.fn(async (_input: { prompt: string }) => imageResult("child image"));
    const loadAgent: NonNullable<AgentDeps["loadAgent"]> = async (name, task) => ({
      kind: "agent", warnings: [], close: async () => {}, deps: { createToolSchemaValidator, channel: childChannel, editImage },
      input: { projectName: name, model: f.configuration.model, messages: [{ role: "user", content: [
        { type: "text", text: task.message }, ...task.images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${image.b64}` } })),
      ] }] },
    });
    const channel = new FakeChannel([
      [toolCallChunk(0, "first", "GenerateImage", '{"prompt":"first"}')],
      [toolCallChunk(0, "second", "GenerateImage", '{"prompt":"second"}')],
      [toolCallChunk(0, "transfer", `${mode}_child`, '{"input":"edit selected","image_ids":["img_2"]}')],
      [contentChunk("parent done")],
    ]);
    const chunks = await f.run(channel, "draw and transfer", undefined, { generateImage: async (prompt: string) => imageResult(prompt), loadAgent }, {
      maxTurn: 8, canDispatch: true, subagents: [{ name: "child", type: "local", description: "child" }],
    });
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(editImage).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ b64: imageResult("second").b64 })] }));
    const prompt = String(childChannel.seenParams[0]?.messages.find((message) => message.role === "system")?.content);
    expect(prompt).toContain("img_2");
    expect(prompt).not.toContain("img_1");
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("image id: img_3"))).toBe(true);
    const saved = (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document.images!;
    expect(saved.map((image) => image.id)).toEqual(["img_1", "img_2", "img_3"]);
    const nextEdit = vi.fn(async (_input: { prompt: string }) => imageResult("next edit"));
    const next = await f.run(new FakeChannel([[toolCallChunk(0, "next", "EditImage", '{"image_id":"img_3","prompt":"edit child output"}')], [contentChunk("done")]]), "edit child output", undefined, { editImage: nextEdit });
    expect(nextEdit).toHaveBeenCalledWith(expect.objectContaining({ images: [expect.objectContaining({ b64: imageResult("child image").b64 })] }));
    expect(next.some((chunk) => chunk.toolResult?.content.includes("image id: img_4"))).toBe(true);
  });

  it("keeps concurrent delegated image outputs distinct across a shared approval checkpoint", async () => {
    const f = fixture();
    let resuming = false;
    const edits = vi.fn(async (input: { prompt: string }) => imageResult(input.prompt));
    const childChannels: FakeChannel[] = [];
    const loadAgent: NonNullable<AgentDeps["loadAgent"]> = async (name, task) => {
      const channel = new FakeChannel(resuming ? [[contentChunk("child done")]] : [
        [toolCallChunk(0, "generate", "GenerateImage", JSON.stringify({ prompt: task.message }))],
        [toolCallChunk(0, "edit", "EditImage", JSON.stringify({ image_id: task.message === "first" ? "img_1" : "img_2", prompt: `edited ${task.message}` }))],
      ]);
      childChannels.push(channel);
      return { kind: "agent", warnings: [], close: async () => {}, deps: { createToolSchemaValidator, channel, generateImage: async (prompt: string) => imageResult(prompt), editImage: edits },
        input: { projectName: name, model: f.configuration.model, parameters: { policy: { approvalTools: ["EditImage"] } }, messages: [{ role: "user", content: task.message }] } };
    };
    const input = { canDispatch: true, subagents: [{ name: "child", type: "local" as const, description: "child" }] };
    const initial = await f.run(new FakeChannel([[
      toolCallChunk(0, "first", "delegate_child", '{"input":"first","image_ids":[]}'),
      toolCallChunk(1, "second", "delegate_child", '{"input":"second","image_ids":[]}'),
    ]]), "draw two", undefined, { loadAgent }, input);
    expect(initial.filter((chunk) => chunk.error)).toEqual([]);
    expect(initial.filter((chunk) => chunk.toolResult?.name === "GenerateImage").map((chunk) => chunk.toolResult!.content).join(" ")).toContain("img_2");
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    expect(pending.approvals).toHaveLength(2);
    expect(edits).not.toHaveBeenCalled();
    resuming = true;
    const chunks = await f.run(new FakeChannel([[contentChunk("parent done")]]), "", { revision: pending.revision, decisions: pending.approvals.map((approval) => ({ id: approval.id, approve: true })) }, { loadAgent }, input);
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(edits).toHaveBeenCalledWith(expect.objectContaining({ prompt: "edited first", images: [expect.objectContaining({ b64: imageResult("first").b64 })] }));
    expect(edits).toHaveBeenCalledWith(expect.objectContaining({ prompt: "edited second", images: [expect.objectContaining({ b64: imageResult("second").b64 })] }));
    const resumedPrompts = childChannels.slice(2).map((channel) => String(channel.seenParams[0]?.messages.find((message) => message.role === "system")?.content));
    expect(resumedPrompts[0]).toContain("img_1");
    expect(resumedPrompts[0]).not.toContain("img_2");
    expect(resumedPrompts[1]).toContain("img_2");
    expect(resumedPrompts[1]).not.toContain("img_1");
    const saved = (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document.images!;
    expect(saved.map((image) => image.id)).toEqual(["img_1", "img_2", "img_3", "img_4"]);
    expect(saved.map((image) => image.b64)).toEqual(expect.arrayContaining([imageResult("first").b64, imageResult("second").b64, imageResult("edited first").b64, imageResult("edited second").b64]));
  });

  it("keeps a preceding user image editable after a version enables image tools", async () => {
    const f = fixture();
    const image = { b64: "aGVsbG8=", mimeType: "image/png" };
    await f.run(new FakeChannel([[contentChunk("seen")]]), "", undefined, {}, { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${image.b64}` } }] }] });
    const editImage = vi.fn(async () => ({ b64: "Ymx1ZQ==", mimeType: "image/png", model: "openai/gpt-image-2", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
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
    const loadAgent = vi.fn<NonNullable<AgentDeps["loadAgent"]>>(async (name, task) => ({ kind: "agent", deps: { createToolSchemaValidator, channel }, warnings: [], close: async () => {}, input: { projectName: name, model: f.configuration.model, messages: [{ role: "user", content: task.message }] } }));
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
    for await (const chunk of runAgent({ createToolSchemaValidator, channel, callMcpTool: effect }, { projectName: "project", model: f.configuration.model, parameters: f.configuration.parameters, messages: [{ role: "user", content: "private@example.com" }], mcpTools: tools, runtime: initial })) expect(chunk.error).toBeUndefined();
    const pending = await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail);
    expect(pending?.approvals[0]?.arguments).toContain("private@example.com");
    const next = new FakeChannel([[contentChunk("done")]]);
    await f.run(next, "", { revision: pending!.revision, decisions: [{ id: pending!.approvals[0]!.id, approve: true }] }, { callMcpTool: effect }, { mcpTools: tools });
    expect(effect).toHaveBeenCalledExactlyOnceWith("lookup", { query: "private@example.com" });
    expect(JSON.stringify(next.seenParams)).not.toContain("private@example.com");
  });

  it("refuses a stale approval and changed configuration before model execution", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    await f.run(new FakeChannel([[toolCallChunk(0, "call", "lookup", "{}")]]), "lookup", undefined, { callMcpTool: async () => ({ text: "done" }) }, { mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] });
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const decisions = [{ id: pending.approvals[0]!.id, approve: true }];
    await expect(openRuntimeSession(f.services, f.scope, { revision: pending.revision - 1, decisions })).rejects.toThrow("no longer pending");
    await expect(openRuntimeSession(f.services, { ...f.scope, configuration: { ...f.configuration, systemPrompt: "changed" } }, { revision: pending.revision, decisions })).rejects.toThrow("configuration changed");
    expect(await pendingRuntimeApproval(f.services, "chat-1", "someone@example.com")).toBeNull();
    await discardRuntimeCheckpoint(f.services, "chat-1", f.scope.ownerEmail, pending.revision);
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
  });

  it("refuses retired Version checkpoints without replay and permits owner-scoped discard", async () => {
    const f = fixture({ approvalTools: ["lookup"] });
    const effect = vi.fn(async () => ({ text: "done" }));
    await f.run(new FakeChannel([[contentChunk("earlier answer")]]), "earlier turn");
    const before = (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document.items;
    await f.run(new FakeChannel([[toolCallChunk(0, "call", "lookup", "{}")]]), "lookup", undefined,
      { callMcpTool: effect }, { mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] });
    const saved = (await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!;
    const { configuration, ...checkpoint } = saved.document.checkpoint!;
    const legacy = { ...saved.document, checkpoint: { ...checkpoint, version: { ...configuration, versionName: "1" } } };
    const payload = f.services.cipher.encrypt(brotliCompressSync(Buffer.from(JSON.stringify(legacy))).toString("base64"),
      runtimeSessionContext("chat-1", f.scope.ownerEmail));
    f.rows.set("chat-1", { ...saved.row, payload });
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    const channel = new FakeChannel([]);
    await expect(f.run(channel, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] },
      { callMcpTool: effect })).rejects.toThrow("retired Version settings");
    expect(channel.calls).toBe(0);
    expect(effect).not.toHaveBeenCalled();
    await expect(discardRuntimeCheckpoint(f.services, "chat-1", "other@example.com", pending.revision)).rejects.toThrow();
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).not.toBeNull();
    await discardRuntimeCheckpoint(f.services, "chat-1", f.scope.ownerEmail, pending.revision);
    expect(await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail)).toBeNull();
    expect((await readRuntimeSession(f.services, "chat-1", f.scope.ownerEmail))!.document.items).toEqual(before);
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
    const edit = vi.fn(async () => ({ b64: "Ymx1ZQ==", mimeType: "image/png", model: "openai/gpt-image-2", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }));
    const deps = { generateImage: async () => ({ b64: "aGVsbG8=", mimeType: "image/png", model: "openai/gpt-image-2", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }), editImage: edit };
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
    const loadAgent: AgentDeps["loadAgent"] = async (name) => ({ kind: "agent", deps: { createToolSchemaValidator, channel: model, callMcpTool: effect }, warnings: [], close: async () => {}, input: {
      projectName: name, model: f.configuration.model, parameters: { piiFiltering: true, policy: { approvalTools: ["lookup"] } }, messages: [{ role: "user", content: "lookup" }], maxTurn: 4,
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
    f.configuration.parameters.piiFiltering = false;
    const effect = vi.fn(async (_name: string, args: Record<string, unknown>) => ({ text: `found ${args.query}` }));
    let channel = new FakeChannel([
      [toolCallChunk(0, "delegate", "delegate_child", '{"input":"private lookup","image_ids":[]}')],
      [toolCallChunk(0, "handoff", "handoff_specialist", '{"input":"private@example.com","image_ids":[]}')],
      [toolCallChunk(0, "lookup", "lookup", '{"query":"private@example.com"}')],
    ]);
    const loadAgent: NonNullable<AgentDeps["loadAgent"]> = async (name, task) => ({
      kind: "agent", deps: { createToolSchemaValidator, channel, loadAgent, callMcpTool: effect }, warnings: [], close: async () => {},
      input: { projectName: name, model: f.configuration.model, messages: [{ role: "user", content: task.message }], maxTurn: 4,
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
    const loadAgent: AgentDeps["loadAgent"] = async (name, task) => ({ kind: "agent", deps: { createToolSchemaValidator, channel: child }, warnings: [], close: async () => {}, input: { projectName: name, model: f.configuration.model, messages: [{ role: "user", content: task.message }], parameters: { policy: { maxInputChars: 2 } } } });
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
      deps: { createToolSchemaValidator, channel: new FakeChannel(resuming ? [] : [[toolCallChunk(0, "handoff", "handoff_specialist", JSON.stringify({ input: task.message, image_ids: [] }))]]),
        loadAgent: async (target, handoffTask) => ({ kind: "agent", warnings: [], close: async () => {},
          deps: { createToolSchemaValidator, channel: new FakeChannel(resuming ? [[contentChunk("specialist done")]] : [[toolCallChunk(0, "lookup", "lookup", JSON.stringify({ value: handoffTask.message }))]]), callMcpTool: effect },
          input: { projectName: target, model: f.configuration.model, messages: [{ role: "user", content: handoffTask.message }], parameters: { policy: { approvalTools: ["lookup"] } }, mcpTools: [{ type: "function", function: { name: "lookup", parameters: {} } }] },
        }),
      },
      input: { projectName: name, model: f.configuration.model, messages: [{ role: "user", content: task.message }], subagents: [{ name: "specialist", type: "local", description: "specialist" }] },
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
