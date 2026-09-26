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
    expect(Object.keys(state).sort()).toEqual(["availableTiers", "budget", "promptSummary", "purpose", "requiredFeatures"]);
    expect(sent.state + JSON.stringify(sent.criteria)).not.toMatch(/secret-model|private\.test|alice|SECRET/);
    expect(state.availableTiers).toEqual(["fast", "general", "reasoning"]);
    expect(Object.keys(sent.criteria)).toEqual(state.availableTiers);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("fast");
    expect(routingPromptSummary({ ...task, prompt })).toContain("code");
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
    replaceModelRegistry([model("base"), model("fast"), model("jev", {
      pricing: { inputPer1M: 0, outputPer1M: 1_000 },
      capabilities: { decision: true, tools: false, reasoning: false, imageInput: false, structuredOutput: false },
    })]);
    const { execute, choose, events } = setup({ ...settings, tiers: { fast: "fast" } });
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
