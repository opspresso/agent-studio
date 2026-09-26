import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { listModels, replaceModelRegistry, type ModelConfig } from "@/domain/llm/models";
import { DEFAULT_CALL_ROUTING, type CallRoutingEvent, type CallRoutingSettings, type CallRoutingState, type RoutedModelTask } from "@/domain/llm/callRouting";
import { createCallModelRouter, routingPromptSummary, type CallRoutingDeps } from "@/application/llm/callModelRouter";
import { agentParametersSchema } from "@/app/api/agents/_lib/schemas";
import { assertCallRoutingPolicy } from "@/application/llm/callRoutingPolicy";
import { modelRoutingPolicySchema } from "@/app/api/models/routing/schema";

const original = listModels();
function model(id: string, patch: Partial<ModelConfig> = {}): ModelConfig {
  return { id, provider: "local", providerKind: "selfhosted", displayName: id, family: id, maker: "test",
    contextWindow: 32_000, maxTokens: 4_000, pricing: { inputPer1M: 0.1, outputPer1M: 0.2 },
    capabilities: { tools: true, reasoning: true, imageInput: true, structuredOutput: true }, ...patch };
}
const task: RoutedModelTask = { purpose: "summary", prompt: "Summarize this document", imageCount: 0, maxOutputTokens: 1_000 };
const settings: CallRoutingSettings = { ...DEFAULT_CALL_ROUTING, enabled: true, tiers: { fast: "fast", general: "general", reasoning: "strong" } };
const result = { text: "A useful answer", usage: { inputTokens: 10, outputTokens: 3, costUsd: 0.00001 } };
function setup(config: CallRoutingSettings = settings, depsPatch: Partial<CallRoutingDeps> = {}, saved?: CallRoutingState) {
  const choose = vi.fn<CallRoutingDeps["decision"]["choose"]>().mockResolvedValue({ choice: "fast", confidence: 1, probabilities: { fast: 1, general: 0, reasoning: 0 } });
  const events: CallRoutingEvent[] = [];
  const state = saved ?? { calls: 0, spentUsd: 0, failures: {} };
  const deps: CallRoutingDeps = { decision: { choose }, selectedDecisionModel: async () => "jev", canUseModel: async () => true, ...depsPatch };
  const execute = createCallModelRouter(deps, config, "base", state, (event) => events.push(event)).execute;
  return { execute, choose, events, state };
}
beforeEach(() => replaceModelRegistry([
  model("base"), model("fast"), model("general"), model("strong"),
  model("jev", { pricing: { inputPer1M: 0.042, outputPer1M: 0 }, capabilities: { decision: true, tools: false, reasoning: false, imageInput: false, structuredOutput: false } }),
]));
afterEach(() => replaceModelRegistry(original));

describe("call model routing", () => {
  it("excludes main-model aliases when a different registered model is required",async()=>{
    const {execute,choose,events}=setup({...settings,tiers:{fast:"base",general:"base",reasoning:"strong"}});
    const invoke=vi.fn().mockResolvedValue(result);
    await execute({...task,requireDifferentModel:true},invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("strong");
    expect(choose).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({reason:"same-primary-model"}));
    expect(events.find(event=>event.outcome==="selected")).toMatchObject({requiresDifferentModel:true});
  });
  it("refuses an explicit main model for an independent-model task",async()=>{
    const {execute}=setup();const invoke=vi.fn();
    await expect(execute({...task,model:"base",requireDifferentModel:true},invoke)).rejects.toThrow("same-primary-model");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not fall back to the main model after every distinct candidate fails quality",async()=>{
    const {execute}=setup({...settings,tiers:{fast:"fast",reasoning:"strong"},policies:{summary:"fast"}});
    const invoke=vi.fn().mockResolvedValue({...result,text:""});
    await expect(execute({...task,requireDifferentModel:true},invoke)).rejects.toThrow("No different ModelTask model");
    expect(invoke.mock.calls.map(([model])=>model)).toEqual(["fast","strong"]);
  });
  it("does not grant a different model when routing is disabled",async()=>{
    const {execute,choose}=setup({...settings,enabled:false});const invoke=vi.fn();
    await expect(execute({...task,requireDifferentModel:true},invoke)).rejects.toThrow("No different ModelTask model");
    expect(invoke).not.toHaveBeenCalled();expect(choose).not.toHaveBeenCalled();
  });
  it("uses only the base model when disabled, even with an explicit override", async () => {
    const { execute, choose, events } = setup({ ...settings, enabled: false });
    const invoke = vi.fn().mockResolvedValue(result);
    await execute({ ...task, model: "unauthorized" }, invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("base");
    expect(choose).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ model: "base", source: "default", outcome: "completed" });
  });
  it("gives explicit models precedence over task policy and Jev", async () => {
    const { execute, choose, events } = setup({ ...settings, policies: { summary: "fast" } });
    const invoke = vi.fn().mockResolvedValue(result);
    await execute({ ...task, model: "general" }, invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("general");
    expect(choose).not.toHaveBeenCalled();
    expect(events.at(-1)?.source).toBe("explicit");
  });
  it("uses a purpose policy before contacting Jev", async () => {
    const { execute, choose, events } = setup({ ...settings, policies: { summary: "general" } });
    const invoke = vi.fn().mockResolvedValue(result);
    await execute(task, invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("general");
    expect(choose).not.toHaveBeenCalled();
    expect(events.at(-1)?.source).toBe("policy");
  });
  it("sends only a fixed-vocabulary summary, purpose, capabilities, budget and available tiers to Jev", async () => {
    const { execute, choose } = setup();
    const prompt = "Debug typesafe/secret-model credentials at https://private.test with alice@example.test and token SECRET";
    const invoke = vi.fn().mockResolvedValue(result);
    await execute({ ...task, prompt }, invoke);
    const sent = choose.mock.calls[0]![0];
    const state = JSON.parse(sent.state);
    expect(Object.keys(state).sort()).toEqual(["availableTiers", "budget", "promptSummary", "purpose", "requiredFeatures", "tierFacts"]);
    expect(sent.state + JSON.stringify(sent.criteria)).not.toMatch(/secret-model|private\.test|alice|SECRET/);
    expect(state.availableTiers).toEqual(["general", "fast", "reasoning"]);
    expect(Object.keys(sent.criteria)).toEqual(state.availableTiers);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("fast");
    expect(routingPromptSummary({ ...task, prompt })).toContain("code");
  });
  it("provides anonymous admission costs and collapses aliases of the main model", async () => {
    replaceModelRegistry([model("base", { pricing: { inputPer1M: 2, outputPer1M: 10 } }), model("fast"), model("strong"), model("jev", {
      pricing: { inputPer1M: 0.042, outputPer1M: 0 }, capabilities: { decision: true, tools: false, reasoning: false, imageInput: false, structuredOutput: false },
    })]);
    const { execute, choose, events } = setup({ ...settings, tiers: { fast: "fast", general: "base", coding: "base", vision: "base", reasoning: "strong" } });
    await execute(task, vi.fn().mockResolvedValue(result));
    const state = JSON.parse(choose.mock.calls[0]![0].state);
    expect(state.availableTiers).toEqual(["general", "fast", "reasoning"]);
    expect(state.tierFacts.general.usesPrimaryModel).toBe(true);
    expect(state.tierFacts.fast.usesPrimaryModel).toBe(false);
    expect(state.tierFacts.general.estimatedCostUsd).toBeGreaterThan(state.tierFacts.fast.estimatedCostUsd);
    expect(state.tierFacts.fast.estimatedCostUsd).toBe(events.find(event => event.outcome === "selected")?.estimatedCostUsd);
    expect(events.find(event => event.outcome === "selected")).toMatchObject({ decisionConfidence: 1, decisionProbabilities: {fast: 1, general: 0, reasoning: 0} });
  });
  it.each([ ["coding", 0, "coding"], ["vision", 1, "vision"] ] as const)("uses the %s alias for duplicate models", async (purpose, imageCount, choice) => {
    const choose = vi.fn<CallRoutingDeps["decision"]["choose"]>().mockImplementation(async ({criteria}) => ({choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key=>[key,key===choice ? 1 : 0]))}));
    const { execute } = setup({ ...settings, tiers: {fast: "fast", general: "general", coding: "general", vision: "general"} }, {decision: {choose}});
    await execute({...task,purpose,imageCount},vi.fn().mockResolvedValue(result));
    expect(Object.keys(choose.mock.calls[0]![0].criteria)).toEqual([choice,"fast"]);
  });
  it("skips paid decision transport when every tier resolves to one model", async () => {
    const selectedDecisionModel = vi.fn(async()=>"jev");
    const { execute, choose, events } = setup({...settings,tiers:{general:"general",coding:"general",vision:"general"}}, {selectedDecisionModel});
    const invoke = vi.fn().mockResolvedValue(result);
    await execute(task,invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("general");
    expect(choose).not.toHaveBeenCalled();
    expect(selectedDecisionModel).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({source:"sole-candidate",outcome:"completed"});
  });
  it.each([
    {confidence:0,probabilities:{fast:1,general:0,reasoning:0}},
    {confidence:0.1,probabilities:{fast:0.5,general:0.5,reasoning:0}},
    {confidence:0.8,probabilities:{fast:0.2,general:0.8,reasoning:0}},
  ])("does not execute a decision with no unique preferred choice: %j", async (details) => {
    const choose = vi.fn().mockResolvedValue({choice:"fast",...details});
    const {execute,events}=setup(settings,{decision:{choose}});
    const invoke=vi.fn().mockResolvedValue(result);
    await execute(task,invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("base");
    expect(events).toContainEqual(expect.objectContaining({reason:"ambiguous-decision",decisionConfidence:details.confidence,decisionProbabilities:details.probabilities}));
  });
  it("retains uncertain unique choices for evaluation without inventing a confidence cutoff or leaking extra keys", async () => {
    const {execute,events}=setup(settings,{decision:{choose:vi.fn().mockResolvedValue({choice:"fast",confidence:0.01,
      probabilities:{fast:0.34,general:0.33,reasoning:0.33,SECRET:1}})}});
    await execute(task,vi.fn().mockResolvedValue(result));
    expect(events.find(event=>event.outcome==="selected")).toMatchObject({source:"jev",decisionConfidence:0.01});
    expect(JSON.stringify(events)).not.toContain("SECRET");
  });
  it("refuses arbitrary explicit models rather than widening the Agent's allow list", async () => {
    const { execute, choose } = setup();
    const invoke = vi.fn();
    await expect(execute({ ...task, model: "foreign" }, invoke)).rejects.toThrow("permission");
    expect(invoke).not.toHaveBeenCalled(); expect(choose).not.toHaveBeenCalled();
  });
  it("falls back to the base model when Jev is unreachable or returns a model name", async () => {
    for (const decision of [vi.fn().mockRejectedValue(new Error("offline")), vi.fn().mockResolvedValue({ choice: "fast-model", confidence: 1, probabilities: {} })]) {
      const { execute, events } = setup(settings, { decision: { choose: decision } });
      const invoke = vi.fn().mockResolvedValue(result);
      await execute(task, invoke);
      expect(invoke).toHaveBeenCalledExactlyOnceWith("base");
      expect(events).toContainEqual(expect.objectContaining({ source: "jev", outcome: expect.stringMatching(/failed|rejected/) }));
    }
  });
  it("promotes after two failures and reserves the final attempt for the base model", async () => {
    const { execute, events } = setup();
    const invoke = vi.fn().mockRejectedValueOnce(new Error("HTTP 503")).mockRejectedValueOnce(new Error("HTTP 503"))
      .mockResolvedValueOnce({ ...result, text: "" }).mockResolvedValueOnce(result);
    expect(await execute(task, invoke)).toEqual(result);
    expect(invoke.mock.calls.map(([id]) => id)).toEqual(["fast", "fast", "general", "base"]);
    expect(events).toContainEqual(expect.objectContaining({ model: "general", source: "promotion" }));
  });
  it("promotes invalid classification output immediately and records paid rejected answers", async () => {
    const { execute, state, events } = setup();
    const invoke = vi.fn().mockResolvedValueOnce({ ...result, text: "not JSON" })
      .mockResolvedValueOnce({ ...result, text: '{"label":"support"}' });
    await execute({ ...task, purpose: "classification" }, invoke);
    expect(invoke.mock.calls.map(([id]) => id)).toEqual(["fast", "general"]);
    expect(state.spentUsd).toBeGreaterThanOrEqual(result.usage.costUsd * 2);
    expect(events).toContainEqual(expect.objectContaining({ outcome: "quality-rejected", model: "fast" }));
  });
  it.each(["{}","[]"])("promotes empty classification output %s", async (text) => {
    const {execute}=setup();
    const invoke=vi.fn().mockResolvedValueOnce({...result,text}).mockResolvedValueOnce({...result,text:'{"label":"support"}'});
    await execute({...task,purpose:"classification"},invoke);
    expect(invoke.mock.calls.map(([model])=>model)).toEqual(["fast","general"]);
  });
  it("promotes a failed tier selection even when that tier uses the Agent's main model", async () => {
    const { execute, events } = setup({ ...settings, tiers: { general: "base", reasoning: "strong" }, policies: { summary: "general" } });
    const invoke = vi.fn().mockResolvedValueOnce({ ...result, text: "" }).mockResolvedValueOnce(result);
    await execute(task, invoke);
    expect(invoke.mock.calls.map(([model]) => model)).toEqual(["base", "strong"]);
    expect(events.at(-1)).toMatchObject({ source: "promotion", model: "strong", outcome: "completed" });
  });
  it("filters capability, context, price, security and unavailable candidates before decision", async () => {
    const variants = [
      [model("fast", { capabilities: { tools: true, imageInput: false, reasoning: false, structuredOutput: false } }), { ...task, purpose: "vision" as const, imageCount: 1 }, "capability"],
      [model("fast", { contextWindow: 2_000, maxTokens: 1_000 }), task, "context"],
      [model("fast", { pricingKnown: false }), task, "budget"],
      [model("fast", { providerKind: "openrouter" }), task, "security"],
    ] as const;
    for (const [candidate, request, reason] of variants) {
      replaceModelRegistry([model("base"), candidate]);
      const { execute, events, choose } = setup({ ...settings, tiers: { fast: "fast" }, localOnly: true });
      await execute(request, vi.fn().mockResolvedValue(result));
      expect(events).toContainEqual(expect.objectContaining({ model: "fast", outcome: "rejected", reason }));
      expect(choose).not.toHaveBeenCalled();
    }
  });
  it("does not call an unavailable default or exceed the persisted count/budget", async () => {
    const invoke = vi.fn().mockResolvedValue(result);
    const unavailable = setup({ ...settings, enabled: false }, { canUseModel: async () => false });
    await expect(unavailable.execute(task, invoke)).rejects.toThrow("unavailable");
    const counted = setup(settings, {}, { calls: settings.maxCalls, spentUsd: 0, failures: {} });
    await expect(counted.execute(task, invoke)).rejects.toThrow("call limit");
    const budget = setup({ ...settings, maxRunCostUsd: 0.0000001, maxCallCostUsd: 0.0000001 });
    await expect(budget.execute(task, invoke)).rejects.toThrow("budget");
    expect(invoke).not.toHaveBeenCalled(); expect(budget.choose).not.toHaveBeenCalled();
  });
  it("includes decision output pricing in admission and avoids an unbounded paid decision", async () => {
    replaceModelRegistry([model("base"), model("fast"), model("general"), model("jev", {
      pricing: { inputPer1M: 0, outputPer1M: 1_000 },
      capabilities: { decision: true, tools: false, reasoning: false, imageInput: false, structuredOutput: false },
    })]);
    const { execute, choose, events } = setup({ ...settings, tiers: { fast: "fast", general:"general" } });
    const invoke = vi.fn().mockResolvedValue(result);
    await execute(task, invoke);
    expect(choose).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("base");
    expect(events).toContainEqual(expect.objectContaining({ source: "jev", outcome: "failed", reason: "decision-failed" }));
  });
  it("propagates cancellation without promotion or fallback", async () => {
    const controller = new AbortController();
    const { execute } = setup({ ...settings, policies: { summary: "fast" } });
    const invoke = vi.fn().mockImplementation(async () => { controller.abort(new Error("cancelled")); throw new Error("transport"); });
    await expect(execute(task, invoke, controller.signal)).rejects.toThrow("cancelled");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("fast");
  });
});

describe("routing settings admission", () => {
  const { enabled: _, ...policy } = settings;
  it("keeps only an Agent opt-in and rejects Agent-owned policy objects", () => {
    expect(agentParametersSchema.parse({ modelRouting: true }).modelRouting).toBe(true);
    expect(agentParametersSchema.safeParse({ modelRouting: settings }).success).toBe(false);
  });
  it("rejects unknown tiers, invalid budgets and excessive calls in the shared policy", () => {
    expect(modelRoutingPolicySchema.parse({ policy }).policy).toEqual(policy);
    for (const patch of [{ maxCalls: 31 }, { maxCallCostUsd: 2 }, { tiers: { invented: "fast" } }]) {
      expect(modelRoutingPolicySchema.safeParse({ policy: { ...policy, ...patch } }).success).toBe(false);
    }
  });
  it("validates registered models and configured task policies when enabling", () => {
    expect(() => assertCallRoutingPolicy(policy, listModels())).not.toThrow();
    expect(() => assertCallRoutingPolicy({ ...policy, tiers: { fast: "missing" } }, listModels())).toThrow("registered text model");
    expect(() => assertCallRoutingPolicy({ ...policy, policies: { vision: "vision" } }, listModels())).toThrow("no model");
  });
});
