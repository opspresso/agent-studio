import { withCustomSpan, withGenerationSpan, type ModelRequest } from "@openai/agents";
import type { CallPurpose, ModelTier, CallRoutingEvent, RoutedModelTask } from "@/domain/llm/callRouting";
import type { UsageInfo } from "@/domain/llm/types";
import { createCallModelRouter } from "@/application/llm/callModelRouter";
import { estimateContextTokens, IMAGE_PART_TOKENS } from "@/application/llm/contextBudget";
import type { EngineDeps, RunAgentInput } from "./types";
import type { RuntimeTurn } from "./types";
import type { RuntimeEmitter } from "./output";
import { conversationMessages } from "./messages";

/** Default for automatically routed primary turns; explicit Agent maxTokens takes precedence. */
const PRIMARY_OUTPUT_TOKENS = 8_192;

export function createRuntimeRouter(
  deps: EngineDeps, input: RunAgentInput, turn: RuntimeTurn,
  observe: (event: CallRoutingEvent) => void, record: (usage: UsageInfo) => Promise<void>,
  baseModel = input.model,
) {
  if (!deps.callRouting || !deps.modelRoutingPolicy) throw new Error("Automatic model routing is not configured");
  return createCallModelRouter({ ...deps.callRouting, decision: {
    choose: request => withGenerationSpan(async generation => {
      generation.spanData.model = request.model;
      const decision = await deps.callRouting!.decision.choose(request);
      if (decision.usage) generation.spanData.usage = {
        input_tokens: decision.usage.inputTokens, output_tokens: decision.usage.outputTokens, cost_usd: decision.usage.costUsd,
      };
      return decision;
    }),
  } }, { ...deps.modelRoutingPolicy, enabled: input.parameters?.modelRouting === true }, baseModel,
    turn.routing ??= { calls: 0, spentUsd: 0, failures: {} }, observe, record);
}

/** Intent hints only; Jev receives fixed vocabulary, never these user text substrings. */
export function primaryCallPurpose(prompt: string, imageCount: number): CallPurpose {
  if (/\b(classify|classification|categorize|label)\b|분류|라벨/i.test(prompt)) return "classification";
  if (/\b(code|function|typescript|javascript|python|debug|sql)\b|코드|함수|디버그/i.test(prompt)) return "coding";
  if (/\b(proof|prove|equation|schedule|optimal|optimize|dependencies|minimum|maximum)\b|증명|추론|최적|최소|최대|의존|선행|작업자/i.test(prompt)) return "reasoning";
  if (/\b(summarize|summary)\b|요약/i.test(prompt)) return "summary";
  return imageCount ? "vision" : "general";
}

export function primaryReasoningEffort(purpose: CallPurpose, tier?: ModelTier): "low" | "medium" {
  return tier === "fast" || ["summary", "classification", "vision"].includes(purpose) ? "low" : "medium";
}

export function primaryRoutingInstructions(purpose: CallPurpose): string {
  return `\n\nThe server has already selected your response model for this ${purpose} request. Answer directly when you can complete it. ModelTask adds another paid call and does not improve capability if it selects the same model. Use it only when independent verification is requested or a different model has a clear benefit. Do not call it just because the task requires reasoning.`;
}

export function primaryRoutingTask(request: ModelRequest, input: RunAgentInput): RoutedModelTask {
  const prompt = typeof request.input === "string" ? request.input
    : String(conversationMessages(request.input).findLast(message => message.role === "user")?.content ?? "");
  let imageCount = 0;
  const nativeInput = JSON.stringify(request.input, (_key, value: unknown) => {
    if (value && typeof value === "object" && "type" in value && (value.type === "input_image" || value.type === "image")) {
      imageCount += 1;
      return { type: value.type };
    }
    return value;
  });
  const text = nativeInput + JSON.stringify({ system: request.systemInstructions, tools: request.tools,
    handoffs: request.handoffs, outputType: request.outputType });
  const purpose = primaryCallPurpose(prompt, imageCount);
  return { purpose, prompt, imageCount,
    inputTokens: estimateContextTokens(text) + estimateContextTokens(primaryRoutingInstructions(purpose)) + imageCount * IMAGE_PART_TOKENS,
    requiresTools: request.tools.length > 0 || request.handoffs.length > 0,
    requiresReasoning: input.parameters?.reasoningEffort !== undefined,
    requiresStructuredOutput: request.outputType !== "text",
    maxOutputTokens: input.parameters?.maxTokens ?? PRIMARY_OUTPUT_TOKENS,
    budgetOutputTokens: input.parameters?.maxTokens === undefined,
    callKind: "primary",
  };
}

export async function routePrimaryModel(
  deps: EngineDeps, input: RunAgentInput, turn: RuntimeTurn, request: ModelRequest, emit: RuntimeEmitter,
  forcedModel?: string,
) {
  if (input.parameters?.modelRouting !== true) return undefined;
  const task = primaryRoutingTask(request, input);
  // Keep one model through this request's tool turns and approval restarts. A new user run chooses afresh.
  task.model = forcedModel;
  return withCustomSpan(async span => {
    const events: CallRoutingEvent[] = [];
    span.spanData.data = { routing: events };
    const router = createRuntimeRouter(deps, input, turn, event => events.push({ ...event, callKind: "primary" }), async usage => {
      emit({ usage });
      await deps.recordUsage?.({ ...usage, agentName: input.agentName, model: usage.model! });
    }, forcedModel ?? input.model);
    return { ...await router.select(task, request.signal, forcedModel ? undefined : turn.number > 0 ? turn.model : undefined), purpose: task.purpose };
  }, { data: { name: "model-routing" } });
}
