import { getModelConfig, modelType } from "@/domain/llm/models";
import type { DecisionModel } from "@/domain/llm/decision";
import {
  MODEL_TIERS, type ModelTier, type CallRoutingSettings, type RoutedModelTask,
  type CallRoutingEvent, type CallRoutingState,
} from "@/domain/llm/callRouting";
import { createRunContextBudget, estimateContextTokens, IMAGE_PART_TOKENS, PROTOCOL_HEADROOM_TOKENS } from "./contextBudget";
import type { UsageInfo } from "@/domain/llm/types";

export interface RoutedModelResult {
  text: string;
  usage: UsageInfo;
  truncated?: boolean;
}

export interface CallRoutingDeps {
  decision: DecisionModel;
  selectedDecisionModel(): Promise<string | undefined>;
  /** Check deployment enrollment and configured connections, without returning credentials. */
  canUseModel(model: string, localOnly: boolean): Promise<boolean>;
}

const MAX_ATTEMPTS = 4;
const FAILURES_BEFORE_PROMOTION = 2;

/** A fixed-vocabulary synopsis: no input substring, identifier, URL or model name leaves via Jev. */
export function routingPromptSummary(task: RoutedModelTask): string {
  const concepts = [
    ["code", /\b(code|function|typescript|python|debug|sql)\b|코드|함수|오류/i],
    ["multiple steps", /\b(plan|steps|workflow)\b|계획|단계/i],
    ["comparison", /\b(compare|versus|tradeoff)\b|비교/i],
    ["long document", /\b(document|transcript|report)\b|문서|녹취|보고서/i],
    ["mathematics", /\b(math|proof|equation)\b|수학|증명/i],
  ].filter(([, pattern]) => (pattern as RegExp).test(task.prompt)).map(([name]) => name);
  return `${task.purpose}; ${task.prompt.length} characters; ${task.imageCount} images; concepts: ${concepts.join(", ") || "general text"}`;
}

/** One instance per Agent invocation, shared by its bounded auxiliary model calls. */
export function createCallModelRouter(
  deps: CallRoutingDeps, settings: CallRoutingSettings, baseModel: string,
  state: CallRoutingState, observe: (event: CallRoutingEvent) => void,
  recordDecisionUsage: (usage: UsageInfo) => Promise<void> = async () => {},
) {
  async function rejection(model: string, task: RoutedModelTask): Promise<CallRoutingEvent["reason"] | undefined> {
    if (task.requireDifferentModel && model === baseModel) return "same-primary-model";
    if (model !== baseModel && !Object.values(settings.tiers).includes(model)) return "permission";
    if (!await deps.canUseModel(model, settings.localOnly)) return "unavailable";
    const facts = getModelConfig(model);
    if (!facts || facts.hidden || modelType(facts) !== "text") return "unavailable";
    if (settings.localOnly && facts.providerKind !== "selfhosted") return "security";
    if (task.imageCount && !facts.capabilities.imageInput) return "capability";
    if (task.purpose === "reasoning" && !facts.capabilities.reasoning) return "capability";
    if (task.purpose === "classification" && !facts.capabilities.structuredOutput) return "capability";
    const context = createRunContextBudget(model, undefined, task.maxOutputTokens);
    const inputTokens = estimateContextTokens(task.prompt) + task.imageCount * IMAGE_PART_TOKENS;
    if (!context || inputTokens > context.remaining() || !facts.maxTokens || task.maxOutputTokens > facts.maxTokens) return "context";
    if (facts.pricingKnown === false || !Number.isFinite(estimate(model, task))) return "budget";
    const cost = estimate(model, task);
    if (cost > settings.maxCallCostUsd || cost + state.spentUsd > settings.maxRunCostUsd) return "budget";
    return undefined;
  }

  function estimate(model: string, task: RoutedModelTask): number {
    const facts = getModelConfig(model);
    if (!facts) return Infinity;
    const tokens = estimateContextTokens(task.prompt) + task.imageCount * IMAGE_PART_TOKENS + PROTOCOL_HEADROOM_TOKENS;
    return (tokens * facts.pricing.inputPer1M + task.maxOutputTokens * facts.pricing.outputPer1M) / 1_000_000;
  }

  return {
    async execute(task: RoutedModelTask, invoke: (model: string) => Promise<RoutedModelResult>, signal?: AbortSignal): Promise<RoutedModelResult> {
      signal?.throwIfAborted();
      if (state.calls >= settings.maxCalls) throw new Error("ModelTask call limit reached");
      state.calls += 1;
      const valid = new Map<ModelTier, string>();
      let source: CallRoutingEvent["source"] = "default";
      let selected = baseModel;
      let tier: ModelTier | undefined;
      let decisionDetails: Pick<CallRoutingEvent, "decisionConfidence" | "decisionProbabilities"> | undefined;
      if (settings.enabled) {
        for (const candidate of MODEL_TIERS) {
          const model = settings.tiers[candidate];
          if (!model) continue;
          const reason = await rejection(model, task) ?? ((state.failures[model] ?? 0) >= FAILURES_BEFORE_PROMOTION ? "unavailable" : undefined);
          if (!reason) valid.set(candidate, model);
          else observe({ purpose: task.purpose, model, tier: candidate, source: "policy", outcome: "rejected", attempt: 0, reason });
        }
        if (task.model) {
          const reason = await rejection(task.model, task);
          if (reason) {
            observe({ purpose: task.purpose, model: task.model, source: "explicit", outcome: "rejected", attempt: 0, reason });
            throw new Error(`Explicit ModelTask model rejected: ${reason}`);
          }
          selected = task.model; source = "explicit";
          tier = [...valid].find(([, model]) => model === selected)?.[0];
        } else if (settings.policies[task.purpose] && valid.has(settings.policies[task.purpose]!)) {
          tier = settings.policies[task.purpose]!; selected = valid.get(tier)!; source = "policy";
        } else if (valid.size) {
          // Aliases of the same registered model are one execution choice.
          // Preserve the task-specific alias without changing explicit policies or promotion.
          const preferred = task.imageCount ? "vision" : task.purpose === "coding" ? "coding" : task.purpose === "reasoning" ? "reasoning" : "general";
          const options = new Map<ModelTier, string>();
          const models = new Set<string>();
          for (const candidate of [preferred, ...MODEL_TIERS] as ModelTier[]) {
            const model = valid.get(candidate);
            if (model && !models.has(model)) { options.set(candidate, model); models.add(model); }
          }
          if (options.size === 1) {
            [tier, selected] = options.entries().next().value!;
            source = "sole-candidate";
          } else {
            try {
              const decisionModel = await deps.selectedDecisionModel();
              if (decisionModel) {
                const stateText = JSON.stringify({ purpose: task.purpose, promptSummary: routingPromptSummary(task),
                  requiredFeatures: { imageInput: task.imageCount > 0, reasoning: task.purpose === "reasoning", structuredOutput: task.purpose === "classification", differentModel: task.requireDifferentModel === true },
                  budget: { maxCallCostUsd: settings.maxCallCostUsd, remainingRunCostUsd: Math.max(0, settings.maxRunCostUsd - state.spentUsd) },
                  availableTiers: [...options.keys()],
                  tierFacts: Object.fromEntries([...options].map(([key, model]) => [key, {
                    estimatedCostUsd: estimate(model, task), usesPrimaryModel: model === baseModel,
                  }])) });
                const criteria = Object.fromEntries([...options.keys()].map((key) => [key, {
                  fast: "Short summaries and straightforward classification", general: "General language tasks",
                  coding: "Code generation and debugging", reasoning: "Complex analysis and multi-step reasoning", vision: "Image understanding",
                }[key]]));
                const available = await deps.canUseModel(decisionModel, settings.localOnly);
                const facts = getModelConfig(decisionModel);
                const decisionTokens = estimateContextTokens(stateText + JSON.stringify(criteria)) + PROTOCOL_HEADROOM_TOKENS;
                const outputPriceable = facts && (facts.pricing.outputPer1M === 0 || facts.maxTokens > 0);
                const decisionCost = facts && facts.pricingKnown !== false && outputPriceable
                  ? (decisionTokens * facts.pricing.inputPer1M + facts.maxTokens * facts.pricing.outputPer1M) / 1_000_000 : Infinity;
                const decisionContext = createRunContextBudget(decisionModel, undefined, facts?.maxTokens ?? 0);
                if (!available || !facts?.capabilities.decision || !decisionContext ||
                    decisionTokens - PROTOCOL_HEADROOM_TOKENS > decisionContext.remaining() ||
                    !Number.isFinite(decisionCost) || decisionCost > settings.maxCallCostUsd ||
                    state.spentUsd + decisionCost > settings.maxRunCostUsd) {
                  throw new Error("Decision model is outside routing policy");
                }
                state.spentUsd += decisionCost;
                const decision = await deps.decision.choose({ model: decisionModel, state: stateText,
                  instructions: "Choose the least expensive available tier that can satisfy the purpose, promptSummary and requiredFeatures. Compare tierFacts.estimatedCostUsd among suitable tiers. A usesPrimaryModel tier adds an isolated call, not a new model capability. Higher cost alone does not prove suitability. Return only one available tier.", criteria, signal });
                if (decision.usage) {
                  state.spentUsd += decision.usage.costUsd - decisionCost;
                  await recordDecisionUsage(decision.usage);
                }
                if (options.has(decision.choice as ModelTier)) {
                  const probabilities = Object.fromEntries([...options.keys()].map(key => [key, decision.probabilities[key]]));
                  decisionDetails = { decisionConfidence: decision.confidence, decisionProbabilities: probabilities };
                  const probability = decision.probabilities[decision.choice];
                  if (decision.confidence <= 0 || !Number.isFinite(probability) || [...options.keys()].some(key => key !== decision.choice && decision.probabilities[key]! >= probability!)) {
                    observe({ purpose: task.purpose, source: "jev", outcome: "rejected", attempt: 0, reason: "ambiguous-decision", ...decisionDetails });
                    decisionDetails = undefined;
                  } else {
                    tier = decision.choice as ModelTier; selected = options.get(tier)!; source = "jev";
                  }
                } else observe({ purpose: task.purpose, source: "jev", outcome: "rejected", attempt: 0, reason: "invalid-decision" });
              }
            } catch {
              signal?.throwIfAborted();
              observe({ purpose: task.purpose, source: "jev", outcome: "failed", attempt: 0, reason: "decision-failed" });
            }
          }
        }
      }
      const attempted = new Set<string>();
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        signal?.throwIfAborted();
        const reason = await rejection(selected, task);
        if (reason) {
          observe({ purpose: task.purpose, model: selected, ...(tier ? { tier } : {}), source, outcome: "rejected", attempt, reason });
          if (selected === baseModel) throw new Error(reason === "same-primary-model"
            ? "No different ModelTask model is available within routing policy" : `Default ModelTask model rejected: ${reason}`);
          selected = baseModel; tier = undefined; source = "default"; continue;
        }
        const estimatedCostUsd = estimate(selected, task);
        observe({ purpose: task.purpose, model: selected, ...(tier ? { tier } : {}), source, outcome: "selected", attempt, estimatedCostUsd,
          ...(task.requireDifferentModel ? {requiresDifferentModel:true} : {}),
          ...(source === "jev" ? decisionDetails : {}) });
        // Reserve before awaiting so parallel callers cannot spend the same remaining budget.
        state.spentUsd += estimatedCostUsd;
        attempted.add(selected);
        let qualityFailed = false;
        try {
          const result = await invoke(selected);
          state.spentUsd += Math.max(0, result.usage.costUsd) - estimatedCostUsd;
          signal?.throwIfAborted();
          qualityFailed = result.truncated === true || result.text.trim().length < settings.minOutputChars;
          if (task.purpose === "classification") {
            try { const parsed: unknown = JSON.parse(result.text); qualityFailed ||= parsed === null || typeof parsed !== "object" || Object.keys(parsed).length === 0; }
            catch { qualityFailed = true; }
          }
          if (!qualityFailed) {
            state.failures[selected] = 0;
            observe({ purpose: task.purpose, model: selected, ...(tier ? { tier } : {}), source, outcome: "completed", attempt });
            return result;
          }
          lastError = new Error("ModelTask output did not meet its quality criteria");
        } catch (error) { signal?.throwIfAborted(); lastError = error; }
        observe({ purpose: task.purpose, model: selected, ...(tier ? { tier } : {}), source, outcome: qualityFailed ? "quality-rejected" : "failed", attempt });
        state.failures[selected] = (state.failures[selected] ?? 0) + 1;
        if (source === "default") throw lastError;
        if (settings.enabled && (qualityFailed || state.failures[selected]! >= FAILURES_BEFORE_PROMOTION)) {
          const promotionOrder: ModelTier[] = task.imageCount ? ["vision", "reasoning"] : ["fast", "general", "coding", "reasoning"];
          const higher = promotionOrder.slice(Math.max(0, tier ? promotionOrder.indexOf(tier) + 1 : 0))
            .find((key) => valid.has(key) && !attempted.has(valid.get(key)!));
          if (higher && attempt < MAX_ATTEMPTS - 1) { tier = higher; selected = valid.get(higher)!; source = "promotion"; continue; }
          selected = baseModel; tier = undefined; source = "default";
        }
      }
      throw lastError ?? new Error("ModelTask could not complete");
    },
  };
}
