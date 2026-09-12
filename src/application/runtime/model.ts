import { getCurrentSpan, type AgentOutputItem, type Model, type ModelRequest, type ModelResponse, type ResponseStreamEvent } from "@openai/agents";
import { applyModelConstraints, calculateCost, describeImageInputReject } from "@/domain/llm/models";
import type { UsageInfo } from "@/domain/llm/types";
import { createRunContextBudget, type RunContextBudget } from "@/application/llm/contextBudget";
import { createToolResultBudget, MAX_TOOL_RESULT_CHARS_PER_TURN, type ToolResultBudget } from "@/application/llm/toolResultBudget";
import { PiiFilter } from "@/application/llm/pii";
import { log } from "@/shared/logger";
import { maskValues } from "./messages";
import { conversationMessages } from "./messages";
import type { ChatMessageInput } from "@/domain/llm/types";
import { boundToolArgsPair, boundArgumentText } from "./arguments";
import type { EngineDeps, RunAgentInput } from "./types";
import type { RuntimeEmitter } from "./output";

export interface RuntimeTurn {
  conversation?: ChatMessageInput[];
  resources?: { urls: number; files: number; imageTurn: number; imagesUsed: number };
  number: number;
  maxTurns: number;
  finalTurn: boolean;
  outputCut: boolean;
  answered?: boolean;
  model: string;
  contextBudget?: RunContextBudget;
  results: ToolResultBudget;
  clientTools: Set<string>;
  handoffTools?: Set<string>;
  toolOrder?: Map<string, { previous: Promise<void>; finished: Promise<void>; complete: () => void }>;
}

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
  const traceReasoning = input.parameters?.reasoningTrace === true;

  function prepare(request: ModelRequest, model: string): ModelRequest {
    const configured = input.parameters;
    const toolNames = [...request.tools.map((definition) => definition.name), ...request.handoffs.map((definition) => definition.toolName)];
    const params = applyModelConstraints({
      model, messages: [],
      ...(toolNames.length ? { tools: toolNames.map((name) => ({ type: "function" as const, function: { name } })) } : {}),
      temperature: configured?.temperature,
      presencePenalty: configured?.presencePenalty,
      maxTokens: configured?.maxTokens,
      reasoningEffort: configured?.reasoningEffort,
    });
    if (traceReasoning && params.reasoningEffort === "none" && !reportedForcedReasoning) {
      reportedForcedReasoning = true;
      emit({ warning: "This model does not reason while it can call tools, so reasoning is disabled for this run." });
    }
    return {
      ...request,
      ...(filter ? {
        input: maskValues(filter, request.input) as ModelRequest["input"],
        systemInstructions: request.systemInstructions ? filter.mask(request.systemInstructions) : undefined,
      } : {}),
      ...(turn.finalTurn ? { tools: [], handoffs: [], systemInstructions: `${filter?.mask(request.systemInstructions ?? "") ?? request.systemInstructions ?? ""}\n\nThis is the final turn. Answer from the information already available; no further tools can run.` } : {}),
      modelSettings: {
        ...request.modelSettings,
        temperature: params.temperature,
        presencePenalty: params.presencePenalty,
        maxTokens: params.maxTokens,
        reasoning: params.reasoningEffort !== undefined ? { effort: params.reasoningEffort } : undefined,
      },
    };
  }

  function begin(request: ModelRequest) {
    if (Array.isArray(request.input)) turn.conversation = conversationMessages(request.input);
    turn.number += 1;
    turn.finalTurn = (request.tools.length > 0 || request.handoffs.length > 0) && turn.number >= turn.maxTurns;
    turn.outputCut = false;
    turn.answered = false;
    const budget = createRunContextBudget(input.model, fallbackFor(request), input.parameters?.maxTokens);
    budget?.chargeText(request.systemInstructions);
    budget?.chargeText(JSON.stringify(request.tools));
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

  async function record(model: string, response: {
    usage: { inputTokens: number; outputTokens: number; inputTokensDetails?: Record<string, number> | Record<string, number>[]; outputTokensDetails?: Record<string, number> | Record<string, number>[] };
    rawUsage?: Record<string, unknown>;
  }) {
    const { inputTokens, outputTokens } = response.usage;
    const sum = (details: Record<string, number> | Record<string, number>[] | undefined, key: string) =>
      Array.isArray(details) ? details.reduce((total, entry) => total + (entry[key] ?? 0), 0) : details?.[key] ?? 0;
    const cachedTokens = sum(response.usage.inputTokensDetails, "cached_tokens");
    const reasoningTokens = sum(response.usage.outputTokensDetails, "reasoning_tokens");
    const billed = response.rawUsage?.cost ?? response.rawUsage?.cost_usd;
    const usage: UsageInfo = {
      model, inputTokens, outputTokens,
      costUsd: typeof billed === "number" && Number.isFinite(billed)
        ? billed : calculateCost(model, { inputTokens, outputTokens, cachedTokens }),
      ...(cachedTokens > 0 ? { cachedTokens } : {}),
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    };
    const span = getCurrentSpan();
    if (span?.spanData.type === "generation") {
      span.spanData.model = model;
      span.spanData.usage = { input_tokens: inputTokens, output_tokens: outputTokens, cached_tokens: cachedTokens, reasoning_tokens: reasoningTokens, cost_usd: usage.costUsd };
    }
    if (input.projectName && deps.recordUsage) {
      try { await deps.recordUsage({ projectName: input.projectName, model, inputTokens, outputTokens, costUsd: usage.costUsd, ...(usage.cachedTokens ? { cachedTokens: usage.cachedTokens } : {}) }); }
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
      if (!turn.clientTools.has(item.name)) {
        try {
          const bounded = boundToolArgsPair(JSON.parse(args) as Record<string, unknown>, JSON.parse(display) as Record<string, unknown>);
          shown = JSON.stringify(bounded.display);
          recorded = JSON.stringify(bounded.wire);
        } catch { shown = boundArgumentText(display); recorded = boundArgumentText(args); }
      }
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
      begin(request);
      let model = input.model;
      let response: ModelResponse;
      try { response = await (await deps.channel.getModel(model)).getResponse(prepare(request, model)); }
      catch (error) {
        request.signal?.throwIfAborted();
        const fallback = fallbackFor(request);
        if (!fallback || !isRetryable(error)) throw error;
        model = fallback;
        response = await (await deps.channel.getModel(model)).getResponse(prepare(request, model));
      }
      turn.model = model;
      turn.outputCut = response.providerData?.choices?.[0]?.finish_reason === "length";
      await record(model, response);
      return { ...response, output: output(response.output) };
    },
    async *getStreamedResponse(request): AsyncIterable<ResponseStreamEvent> {
      begin(request);
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
        for await (const event of source.getStreamedResponse(prepare(request, model))) {
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
            flush();
            await record(model, event.response);
            if (turn.outputCut && !reportedCut) {
              reportedCut = true;
              emit({ warning: "The model's response was cut at its output limit." });
            }
            if ((turn.finalTurn || !event.response.output.some((item) => item.type === "function_call")) && !saidContent && saidReasoning) {
              emit({ warning: traceReasoning
                ? "This model answered inside its reasoning, so the reply is empty and the answer is in the recorded reasoning."
                : "This model answered inside its reasoning, which this version does not record, so the reply is empty. Recording the reasoning is what keeps it." });
            }
            yield { ...event, response: { ...event.response, output: output(event.response.output) } };
          } else yield event;
          await emit.ready?.();
        }
      };
      try {
        try { yield* consume(input.model); }
        catch (error) {
          request.signal?.throwIfAborted();
          const fallback = fallbackFor(request);
          if (started || !fallback || !isRetryable(error)) throw error;
          yield* consume(fallback);
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
