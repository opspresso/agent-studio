import { getCurrentSpan, ModelBehaviorError, type AgentOutputItem, type Model, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from "@openai/agents";
import { routePrimaryModel, primaryRoutingInstructions, primaryReasoningEffort } from "./modelRouting";
import { applyModelConstraints, describeImageInputReject } from "@/domain/llm/models";
import { modelResponseUsage, modelResponseIsTruncated, modelResponseHasOutput, type ResponseUsage } from "./modelUsage";
import { createRunContextBudget } from "@/application/llm/contextBudget";
import { createToolResultBudget, MAX_TOOL_RESULT_CHARS_PER_TURN } from "@/application/llm/toolResultBudget";
import { PiiFilter } from "@/application/llm/pii";
import { log } from "@/shared/logger";
import { maskValues } from "./messages";
import { conversationMessages } from "./messages";
import { boundToolArgsPair, boundArgumentText } from "./arguments";
import type { EngineDeps, RunAgentInput, RuntimeTurn } from "./types";
import type { RuntimeEmitter } from "./output";

export interface RuntimeCallIds {
  prefix?: string;
  used: Set<string>;
}

export function createRunModel(
  deps: EngineDeps,
  input: RunAgentInput,
  turn: RuntimeTurn,
  emit: RuntimeEmitter,
  filter?: PiiFilter,
  identifiers: RuntimeCallIds = { used: new Set() },
): Model {
  let saidContent = false;
  let saidReasoning = false;
  let callNumber = 0;
  const callIds = identifiers.used;
  let reportedCut = false;
  let reportedForcedReasoning = false;
  let reportedWithheldReasoning = false;
  let reportedIneligibleFallback = false;
  let routed: Awaited<ReturnType<typeof routePrimaryModel>>;
  const traceReasoning = input.parameters?.reasoningTrace === true;

  function prepare(request: ModelRequest, model: string): ModelRequest {
    const configured = input.parameters;
    const toolNames = [...request.tools.map((definition) => definition.name), ...request.handoffs.map((definition) => definition.toolName)];
    const params = applyModelConstraints({
      model, messages: [],
      ...(toolNames.length ? { tools: toolNames.map((name) => ({ type: "function" as const, function: { name } })) } : {}),
      temperature: configured?.temperature,
      presencePenalty: configured?.presencePenalty,
      maxTokens: configured?.maxTokens ?? routed?.maxOutputTokens,
      reasoningEffort: configured?.reasoningEffort ?? (routed ? primaryReasoningEffort(routed.purpose, routed.tier) : undefined),
    });
    if (traceReasoning && params.reasoningEffort === "none" && !reportedForcedReasoning) {
      reportedForcedReasoning = true;
      emit({ warning: "This model does not reason while it can call tools, so reasoning is disabled for this run." });
    }
    const systemInstructions = request.systemInstructions ? filter?.mask(request.systemInstructions) ?? request.systemInstructions : undefined;
    const routingHint = routed ? primaryRoutingInstructions(routed.purpose) : "";
    return {
      ...request,
      systemInstructions: `${systemInstructions ?? ""}${routingHint}` || undefined,
      ...(filter ? {
        input: maskValues(filter, request.input) as ModelRequest["input"],
      } : {}),
      ...(turn.finalTurn ? { tools: [], handoffs: [], systemInstructions: `${systemInstructions ?? ""}${routingHint}\n\nThis is the final turn. Answer from the information already available; no further tools can run.` } : {}),
      modelSettings: {
        ...request.modelSettings,
        temperature: params.temperature,
        presencePenalty: params.presencePenalty,
        maxTokens: params.maxTokens,
        reasoning: params.reasoningEffort !== undefined ? { effort: params.reasoningEffort } : undefined,
      },
    };
  }

  function begin(request: ModelRequest, model: string) {
    if (Array.isArray(request.input)) turn.conversation = conversationMessages(request.input);
    turn.number += 1;
    turn.finalTurn = (request.tools.length > 0 || request.handoffs.length > 0) && turn.number >= turn.maxTurns;
    turn.outputCut = false;
    turn.answered = false;
    const budget = createRunContextBudget(model, input.parameters?.modelRouting === true ? undefined : fallbackFor(request), input.parameters?.maxTokens ?? routed?.maxOutputTokens);
    budget?.chargeText(request.systemInstructions);
    if (routed) budget?.chargeText(primaryRoutingInstructions(routed.purpose));
    budget?.chargeText(JSON.stringify(request.tools));
    budget?.chargeText(JSON.stringify(request.handoffs));
    budget?.chargeText(JSON.stringify(request.outputType));
    if (Array.isArray(request.input)) {
      for (const item of request.input) {
        budget?.chargeText(JSON.stringify(item, (_key, value: unknown) => {
          if (value && typeof value === "object" && "type" in value && (value.type === "input_image" || value.type === "image")) {
            budget.chargeMessage({ role: "user", content: [{ type: "image_url", image_url: { url: "" } }] });
            return { type: value.type };
          }
          return value;
        }));
      }
    } else budget?.chargeText(request.input);
    if (budget && budget.remaining() === 0 && turn.number === 1) emit({ warning: "This run's input and tools already fill the model's context window, so nothing was left to bound: the model's own limit is what answers for it." });
    turn.contextBudget = budget?.remaining() ? budget : undefined;
    turn.results = createToolResultBudget(MAX_TOOL_RESULT_CHARS_PER_TURN, turn.contextBudget);
  }

  function beginFallbackBudget(request: ModelRequest, model: string) {
    if (input.parameters?.modelRouting !== true) return;
    turn.number -= 1;
    begin(request, model);
  }

  async function record(model: string, response: ResponseUsage) {
    const usage = modelResponseUsage(model, response);
    routed?.settle(usage);
    const { inputTokens, outputTokens, cachedTokens = 0, reasoningTokens = 0 } = usage;
    const span = getCurrentSpan();
    if (span?.spanData.type === "generation") {
      span.spanData.model = model;
      span.spanData.usage = { input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, reasoning_tokens: reasoningTokens, cost_usd: usage.costUsd };
    }
    if (input.agentName && deps.recordUsage) {
      try { await deps.recordUsage({ agentName: input.agentName, model, inputTokens, outputTokens, costUsd: usage.costUsd, ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}) }); }
      catch (error) { log.error("engine", "usage recording failed", String(error)); }
    }
    emit({ usage });
    if (traceReasoning && reasoningTokens > 0 && !saidReasoning && !reportedWithheldReasoning) {
      reportedWithheldReasoning = true;
      emit({ warning: "This model reports how many tokens it spent thinking but does not return the thinking itself, so there is nothing to record." });
    }
  }

  function output<T extends AgentOutputItem>(items: T[]): T[] {
    turn.toolOrder = new Map();
    const normalized = items.map((item) => {
      if (item.type !== "function_call") {
        turn.contextBudget?.chargeText(JSON.stringify(item));
        return item;
      }
      let callId = item.callId;
      if (identifiers.prefix || !callId || callIds.has(callId)) {
        do { callId = `call_${identifiers.prefix ? `${identifiers.prefix}_` : ""}${++callNumber}`; } while (callIds.has(callId));
      }
      callIds.add(callId);
      const args = filter?.mask(item.arguments) ?? item.arguments;
      const display = filter?.restore(args) ?? args;
      let shown = display;
      let recorded = args;
      try {
        const bounded = boundToolArgsPair(JSON.parse(args) as Record<string, unknown>, JSON.parse(display) as Record<string, unknown>);
        shown = JSON.stringify(bounded.display);
        recorded = JSON.stringify(bounded.wire);
      } catch { shown = boundArgumentText(display); recorded = boundArgumentText(args); }
      turn.contextBudget?.chargeText(JSON.stringify({ ...item, callId, arguments: recorded }));
      if (!turn.finalTurn) emit({ delta: { toolCalls: [{ id: callId, type: "function", function: { name: item.name, arguments: shown } }] } });
      return { ...item, callId, arguments: args };
    });
    return turn.finalTurn ? normalized.filter((item) => item.type !== "function_call") : normalized;
  }

  function fallbackFor(request: ModelRequest): string | undefined {
    const fallback = input.fallbackModel;
    if (!fallback) return undefined;
    const hasImages = Array.isArray(request.input) && request.input.some((item) => {
      const content = item.type === "function_call_result" ? item.output
        : (item.type === "message" || item.type === undefined) ? item.content : undefined;
      return Array.isArray(content) ? content.some((part) => part.type === "input_image" || part.type === "image")
        : content !== null && typeof content === "object" && "type" in content && content.type === "image";
    });
    const refusal = hasImages ? describeImageInputReject(fallback) : undefined;
    if (refusal) {
      if (!reportedIneligibleFallback) { log.warn("engine", `fallback skipped for an image request: ${refusal}`); reportedIneligibleFallback = true; }
      return undefined;
    }
    return fallback;
  }

  return {
    async getResponse(request) {
      routed = await routePrimaryModel(deps, input, turn, request, emit);
      let model = routed?.model ?? input.model;
      begin(request, model);
      let response: ModelResponse;
      let prepared = prepare(request, model);
      try { response = await (await deps.channel.getModel(model)).getResponse(prepared); }
      catch (error) {
        request.signal?.throwIfAborted();
        const fallback = fallbackFor(request);
        if (!fallback || fallback === model || !isRetryable(error)) throw error;
        routed = await routePrimaryModel(deps, input, turn, request, emit, fallback);
        model = routed?.model ?? fallback;
        beginFallbackBudget(request, model);
        prepared = prepare(request, model);
        response = await (await deps.channel.getModel(model)).getResponse(prepared);
      }
      turn.model = model;
      turn.outputCut = modelResponseIsTruncated(response, prepared.modelSettings.maxTokens);
      await record(model, response);
      if (turn.outputCut && !modelResponseHasOutput(response)) throw new ModelBehaviorError("The model exhausted its output limit without a final answer");
      return { ...response, output: output(response.output) };
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      routed = await routePrimaryModel(deps, input, turn, request, emit);
      const primaryModel = routed?.model ?? input.model;
      begin(request, primaryModel);
      const contentRestorer = filter?.createStreamRestorer();
      const reasoningRestorer = filter?.createStreamRestorer();
      let contentThisTurn = false;
      let reasoningThisTurn = false;
      let started = false;
      const flush = () => {
        const content = contentRestorer?.flush();
        if (content) emit({ delta: { content } });
        const reasoningContent = reasoningRestorer?.flush();
        if (traceReasoning && reasoningContent) emit({ delta: { reasoningContent } });
      };
      const consume = async function* (model: string): AsyncIterable<ResponseStreamEvent> {
        turn.model = model;
        const source = await deps.channel.getModel(model);
        const prepared = prepare(request, model);
        for await (const event of source.getStreamedResponse(prepared)) {
          started = true;
          if (event.type === "output_text_delta" && event.delta) {
            turn.answered = turn.answered || event.delta.trim().length > 0;
            if (!contentThisTurn && saidContent) emit({ delta: { content: "\n\n" } });
            contentThisTurn = true;
            saidContent = true;
            const content = contentRestorer?.push(event.delta) ?? event.delta;
            if (content) emit({ delta: { content } });
          } else if (event.type === "model") {
            const raw = event.event as { choices?: Array<{ finish_reason?: string; delta?: { reasoning_content?: string; reasoning?: string } }> };
            const choice = raw.choices?.[0];
            if (choice?.finish_reason === "length") turn.outputCut = true;
            const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            if (reasoning) {
              if (traceReasoning && !reasoningThisTurn && saidReasoning) emit({ delta: { reasoningContent: "\n\n" } });
              reasoningThisTurn = true;
              saidReasoning = true;
              const text = reasoningRestorer?.push(reasoning) ?? reasoning;
              if (traceReasoning && text) emit({ delta: { reasoningContent: text } });
            }
          }
          if (event.type === "response_done") {
            turn.outputCut ||= modelResponseIsTruncated(event.response, prepared.modelSettings.maxTokens);
            flush();
            await record(model, event.response);
            if (turn.outputCut && !reportedCut) {
              reportedCut = true;
              emit({ warning: "The model's response was cut at its output limit." });
            }
            if (turn.outputCut && !modelResponseHasOutput(event.response)) throw new ModelBehaviorError("The model exhausted its output limit without a final answer");
            if ((turn.finalTurn || !event.response.output.some((item) => item.type === "function_call")) && !saidContent && saidReasoning) {
              emit({ warning: traceReasoning
                ? "This model answered inside its reasoning, so the reply is empty and the answer is in the recorded reasoning."
                : "This model answered inside its reasoning, which this Agent does not record, so the reply is empty. Recording the reasoning is what keeps it." });
            }
            yield { ...event, response: { ...event.response, output: output(event.response.output) } };
          } else yield event;
          await emit.ready?.();
        }
      };
      try {
        try { yield* consume(primaryModel); }
        catch (error) {
          request.signal?.throwIfAborted();
          const fallback = fallbackFor(request);
          if (started || !fallback || fallback === primaryModel || !isRetryable(error)) throw error;
          routed = await routePrimaryModel(deps, input, turn, request, emit, fallback);
          const model = routed?.model ?? fallback;
          beginFallbackBudget(request, model);
          yield* consume(model);
        }
      } finally { flush(); }
    },
  };
}

function isRetryable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const data = error as { status?: number; statusCode?: number; code?: number };
  const status = data.status ?? data.statusCode ?? data.code;
  return status === 429 || (typeof status === "number" && status >= 500 && status < 600);
}
