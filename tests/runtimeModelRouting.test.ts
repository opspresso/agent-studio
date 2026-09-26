import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "@/application/runtime";
import type { AgentDeps } from "@/application/runtime/types";
import { createToolSchemaValidator } from "@/infrastructure/llm/toolSchema";
import { listModels, replaceModelRegistry, type ModelConfig } from "@/domain/llm/models";
import { DEFAULT_CALL_ROUTING_POLICY, type CallRoutingPolicy } from "@/domain/llm/callRouting";
import type { TraceSpan } from "@/domain/trace/types";
import { FakeChannel, contentChunk, toolCallChunk, usageChunk } from "./fakeChannel";
import { runtimeSessionFixture } from "./runtimeSessionFixture";
import { pendingRuntimeApproval } from "@/application/runtime/session";

const original = listModels();
const config: CallRoutingPolicy = { ...DEFAULT_CALL_ROUTING_POLICY, tiers: { fast: "local/fast" }, policies: { summary: "fast" as const } };
const taskArgs = JSON.stringify({ purpose: "summary", prompt: "Summarize the supplied document", model: null, image_ids: [] });
function model(id: string): ModelConfig {
  return { id, provider: "local", providerKind: "selfhosted", family: "test", maker: "test", displayName: id,
    pricing: { inputPer1M: 0, outputPer1M: 0 }, contextWindow: 32_000, maxTokens: 4_000,
    capabilities: { tools: true, structuredOutput: true, imageInput: true, reasoning: true } };
}
function deps(channel: FakeChannel, spans: TraceSpan[] = [], policy: CallRoutingPolicy = config): AgentDeps {
  return { channel, createToolSchemaValidator, modelRoutingPolicy: policy, onSdkSpan: (span) => spans.push(span),
    callRouting: { decision: { choose: vi.fn() }, selectedDecisionModel: async () => undefined, canUseModel: async () => true } };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-26T00:00:00Z"));
  replaceModelRegistry([model("local/base"), model("local/fast"), model("google/gemini-2.5-flash")]);
});
afterEach(() => { vi.useRealTimers(); replaceModelRegistry(original); });

describe("native runtime call routing", () => {
  it("forwards the independent-model requirement and reports unavailable alternatives without a primary-model subcall",async()=>{
    const args=JSON.stringify({purpose:"summary",prompt:"Check independently",model:null,image_ids:[],require_different_model:true});
    const channel=new FakeChannel([[toolCallChunk(0,"independent","ModelTask",args)],[contentChunk("No alternative is available")]]);
    const policy:CallRoutingPolicy={...config,tiers:{general:"local/base"},policies:{summary:"general"}};
    const chunks=[];
    for await(const chunk of runAgent(deps(channel,[],policy),{agentName:"test",model:"local/base",messages:[{role:"user",content:"Use another model"}],parameters:{modelRouting:true}})) chunks.push(chunk);
    expect(channel.seenParams).toHaveLength(2);
    expect(chunks.some(chunk=>chunk.toolResult?.content.includes("No different ModelTask model"))).toBe(true);
  });
  it.each([undefined,"medium","low","high"] as const)("honors the configured reasoning effort for a focused task: %s",async (effort)=>{
    const args=JSON.stringify({purpose:"reasoning",prompt:"Solve the scheduling problem",model:null,image_ids:[]});
    const channel=new FakeChannel([[toolCallChunk(0,"reasoning","ModelTask",args)],[contentChunk("A proof")],[contentChunk("Done")]]);
    const policy:CallRoutingPolicy={...config,tiers:{reasoning:"local/fast"},policies:{reasoning:"reasoning"}};
    for await(const chunk of runAgent(deps(channel,[],policy),{agentName:"test",model:"local/base",messages:[{role:"user",content:"Solve"}],parameters:{modelRouting:true,reasoningEffort:effort}})) expect(chunk.error).toBeUndefined();
    expect(channel.seenParams[1]?.reasoningEffort).toBe(effort??"medium");
  });
  it("keeps PII masked on auxiliary requests and subsequent main-model context", async () => {
    const email = "routing-person@example.test";
    const args = JSON.stringify({purpose:"summary",prompt:`Summarize ${email}`,model:null,image_ids:[]});
    const channel = new FakeChannel([
      [toolCallChunk(0,"pii-task","ModelTask",args)],
      [contentChunk(`Summary for ${email}`)],
      [contentChunk("Done")],
    ]);
    const chunks=[];
    for await(const chunk of runAgent(deps(channel),{agentName:"test",model:"local/base",messages:[{role:"user",content:email}],parameters:{modelRouting:true,piiFiltering:true}})) chunks.push(chunk);
    expect(channel.seenParams).toHaveLength(3);
    for(const request of channel.seenParams) expect(JSON.stringify(request.messages)).not.toContain(email);
    expect(chunks.some(chunk=>chunk.toolResult?.content.includes(email))).toBe(true);
  });
  it.each([true, false])("keeps the main model before and after a task when enabled=%s", async (enabled) => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "task", "ModelTask", taskArgs), usageChunk(10, 5, undefined, 0.01)],
      [contentChunk("A concise summary"), usageChunk(11, 6, undefined, 0.02)],
      [contentChunk("Final answer using the summary"), usageChunk(12, 7, undefined, 0.03)],
    ]);
    const spans: TraceSpan[] = [];
    const chunks = [];
    for await (const chunk of runAgent(deps(channel, spans), {
      agentName: "test", model: "local/base", messages: [{ role: "user", content: "Summarize" }],
      parameters: { modelRouting: enabled },
    })) chunks.push(chunk);
    expect(chunks.filter((chunk) => chunk.error)).toEqual([]);
    expect(channel.seenParams.map((params) => params.model)).toEqual(["local/base", enabled ? "local/fast" : "local/base", "local/base"]);
    expect(channel.seenParams[1]?.tools ?? []).toHaveLength(0);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("A concise summary"))).toBe(true);
    expect(chunks.filter((chunk) => chunk.usage).map((chunk) => chunk.usage?.costUsd)).toEqual([0.01, 0.02, 0.03]);
    expect(spans.filter(span => span.kind === "model").map(span => span.name)).toEqual(["local/base", enabled ? "local/fast" : "local/base", "local/base"]);
    const routing = spans.find((span) => span.name === "model-routing");
    expect(routing?.output?.routing).toEqual(expect.arrayContaining([expect.objectContaining({ source: enabled ? "policy" : "default", outcome: "completed" })]));
    expect(JSON.stringify(spans)).not.toContain("supplied document");
  });

  it("does not offer auxiliary calls on an Agent that never configured routing", async () => {
    const channel = new FakeChannel([[contentChunk("ordinary answer")]]);
    for await (const chunk of runAgent({ channel, createToolSchemaValidator }, { agentName: "test", model: "local/base", messages: [{ role: "user", content: "Hello" }] })) expect(chunk.error).toBeUndefined();
    expect(channel.seenParams[0]?.tools?.some((tool) => tool.function.name === "ModelTask")).not.toBe(true);
  });
  it("sends only the referenced Run image to the vision call and returns to the main model", async () => {
    const image = "data:image/png;base64,aW1hZ2U=";
    const channel = new FakeChannel([
      [toolCallChunk(0, "vision", "ModelTask", JSON.stringify({ purpose: "vision", prompt: "Describe the image", model: null, image_ids: ["img_1"] }))],
      [contentChunk("An image description")], [contentChunk("Final description")],
    ]);
    for await (const chunk of runAgent(deps(channel, [], { ...config, tiers: { vision: "local/fast" }, policies: { vision: "vision" } }), { agentName: "test", model: "local/base",
      messages: [{ role: "user", content: [{ type: "text", text: "Describe" }, { type: "image_url", image_url: { url: image } }] }],
      parameters: { modelRouting: true },
    })) expect(chunk.error).toBeUndefined();
    expect(channel.seenParams.map((params) => params.model)).toEqual(["local/base", "local/fast", "local/base"]);
    expect(JSON.stringify(channel.seenParams[1]?.messages)).toContain(image);
    expect(JSON.stringify(channel.seenParams[0]?.messages)).toContain("Pass ids in image_ids to `ModelTask`");
  });

  it("blocks invalid arguments, absent image handles and calls beyond the quota without contacting another model", async () => {
    const channel = new FakeChannel([
      [toolCallChunk(0, "invalid", "ModelTask", JSON.stringify({ purpose: "invented", prompt: "hi", model: null, image_ids: [] }))],
      [toolCallChunk(0, "image", "ModelTask", JSON.stringify({ purpose: "vision", prompt: "Describe", model: null, image_ids: ["img_99"] }))],
      [toolCallChunk(0, "valid", "ModelTask", taskArgs)], [contentChunk("summary")],
      [toolCallChunk(0, "over", "ModelTask", taskArgs)], [contentChunk("Final answer")],
    ]);
    const chunks = [];
    for await (const chunk of runAgent(deps(channel, [], { ...config, maxCalls: 1 }), { agentName: "test", model: "local/base",
      messages: [{ role: "user", content: "Hello" }], parameters: { modelRouting: true }, maxTurn: 6 })) chunks.push(chunk);
    expect(channel.seenParams.filter((params) => params.model === "local/fast")).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("not available"))).toBe(true);
    expect(chunks.some((chunk) => chunk.toolResult?.content.includes("call limit"))).toBe(true);
  });

  it("persists routing counters across an approval restart and applies the saved limit after resumption", async () => {
    const f = runtimeSessionFixture({ approvalTools: ["Skill"] });
    f.configuration.parameters.modelRouting = true;
    const callDeps = deps(new FakeChannel([]));
    const overrides = { callRouting: callDeps.callRouting, modelRoutingPolicy: { ...config, maxCalls: 1 }, loadSkillContent: async () => "Instructions" };
    await f.run(new FakeChannel([
      [toolCallChunk(0, "task", "ModelTask", taskArgs)], [contentChunk("summary")],
      [toolCallChunk(0, "approve", "Skill", '{"skill_name":"guide"}')],
    ]), "summarize and load guide", undefined, overrides, { skills: [{ name: "guide", description: "Guidance" }] });
    const pending = (await pendingRuntimeApproval(f.services, "chat-1", f.scope.ownerEmail))!;
    expect(pending).not.toBeNull();
    const next = new FakeChannel([[toolCallChunk(0, "second", "ModelTask", taskArgs)], [contentChunk("done")]]);
    const resumed = await f.run(next, "", { revision: pending.revision, decisions: [{ id: pending.approvals[0]!.id, approve: true }] },
      overrides, { skills: [{ name: "guide", description: "Guidance" }] });
    expect(next.seenParams.every((params) => params.model === f.configuration.model)).toBe(true);
    expect(resumed.some((chunk) => chunk.toolResult?.content.includes("call limit"))).toBe(true);
  });
});
