import {
  OpenAIChatCompletionsModel,
  type Model,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ResponseStreamEvent,
  type AgentInputItem,
  type AgentOutputItem,
} from "@openai/agents";
import { isInlineImageDataUrl } from "@/domain/llm/imageLimits";
import { getOpenAIClient } from "./openaiClient";
import type OpenAI from "openai";
import type { ResolvedTarget, TargetResolver } from "./providers";

/** Studio owns routing and credentials; the Agents SDK owns the model protocol. */
export function createAgentModelProvider(
  resolveTarget: TargetResolver,
  clientForTarget: (target: ResolvedTarget) => OpenAI = (target) => getOpenAIClient(target, 0),
): ModelProvider {
  return {
    getModel(name) {
      if (!name) throw new Error("An explicit Studio model is required");
      return new StudioChatModel(name, resolveTarget, clientForTarget);
    },
  };
}

class StudioChatModel implements Model {
  constructor(
    private readonly name: string,
    private readonly resolveTarget: TargetResolver,
    private readonly clientForTarget: (target: ResolvedTarget) => OpenAI,
  ) {}

  private async resolve(): Promise<OpenAIChatCompletionsModel> {
    const target = await this.resolveTarget(this.name);
    // Retry policy belongs to the run. Hidden HTTP retries can repeat paid work.
    return new OpenAIChatCompletionsModel(this.clientForTarget(target), target.model, {
      strictFeatureValidation: true,
    });
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const prepared = prepareRequest(request);
    try {
      const model = await this.resolve();
      const result = await model.getResponse(prepared);
      request.signal?.throwIfAborted();
      const choice = result.providerData?.choices?.[0];
      const reasoning = choice?.message?.reasoning_content;
      return typeof reasoning === "string"
        ? { ...result, output: withReasoning(result.output, reasoning) }
        : result;
    } catch (error) {
      request.signal?.throwIfAborted();
      throw error;
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<ResponseStreamEvent> {
    const prepared = prepareRequest(request);
    try {
      const model = await this.resolve();
      let reasoningContent = "";
      for await (const event of model.getStreamedResponse(prepared)) {
        if (event.type === "model") {
          const data = event.event as { choices?: Array<{ delta?: { reasoning_content?: unknown } }> };
          const delta = data.choices?.[0]?.delta?.reasoning_content;
          if (typeof delta === "string") reasoningContent += delta;
        }
        yield event.type === "response_done" && reasoningContent
          ? { ...event, response: { ...event.response, output: withReasoning(event.response.output, reasoningContent) } }
          : event;
      }
      // The underlying OpenAI stream may end normally when its signal aborts.
      request.signal?.throwIfAborted();
    } catch (error) {
      request.signal?.throwIfAborted();
      throw error;
    }
  }
}

function prepareRequest(request: ModelRequest): ModelRequest {
  request.signal?.throwIfAborted();
  const input = Array.isArray(request.input) ? expandToolImages(restoreReasoningDialect(request.input)) : request.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if ((item.type !== undefined && item.type !== "message") || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part.type === "input_image" &&
            (typeof part.image !== "string" || !isInlineImageDataUrl(part.image))) {
          throw new Error("LLM image inputs must contain bounded inline image bytes");
        }
      }
    }
  }
  const { maxTokens, providerData, ...settings } = request.modelSettings;
  return {
    ...request,
    input,
    modelSettings: {
      ...settings,
      store: false,
      preserveRawUsage: true,
      providerData: {
        ...providerData,
        ...(maxTokens !== undefined ? { max_completion_tokens: maxTokens } : {}),
      },
    },
  };
}

/** Chat Completions carries tool images in a user message after the tool-result group. */
function expandToolImages(input: AgentInputItem[]): AgentInputItem[] {
  const result: AgentInputItem[] = [];
  let images: Array<{ type: "input_image"; image: string; detail: "auto" }> = [];
  const flush = () => {
    if (images.length) result.push({ type: "message", role: "user", content: images });
    images = [];
  };
  for (const item of input) {
    if (item.type !== "function_call_result") { flush(); result.push(item); continue; }
    if (!Array.isArray(item.output)) { result.push(item); continue; }
    for (const part of item.output) {
      if (part.type !== "input_image") continue;
      if (typeof part.image !== "string" || !isInlineImageDataUrl(part.image)) throw new Error("LLM image inputs must contain bounded inline image bytes");
      images.push({ type: "input_image", image: part.image, detail: "auto" });
    }
    result.push({ ...item, output: item.output.filter((part) => part.type === "input_text") });
  }
  flush();
  return result;
}

/** vLLM/DeepSeek use reasoning_content; the SDK's built-in dialect uses reasoning. */
function withReasoning<T extends AgentOutputItem>(
  output: T[], text: string,
): Array<T | Extract<AgentOutputItem, { type: "reasoning" }>> {
  return [{
    type: "reasoning",
    content: [],
    rawContent: [{ type: "reasoning_text", text }],
    providerData: { studioReasoningField: "reasoning_content" },
  }, ...output.filter((item) => item.type !== "reasoning")];
}

function restoreReasoningDialect(input: AgentInputItem[]): AgentInputItem[] {
  const result: AgentInputItem[] = [];
  let reasoning: string | undefined;
  const flush = () => {
    if (reasoning === undefined) return;
    result.push({ type: "message", role: "assistant", content: [], status: "completed", providerData: { reasoning_content: reasoning } });
    reasoning = undefined;
  };
  for (const item of input) {
    if (item.type === "reasoning" && item.providerData?.studioReasoningField === "reasoning_content") {
      flush();
      reasoning = item.rawContent?.map((part) => part.text).join("") ?? "";
    } else if (reasoning !== undefined && (item.type === "function_call" || ((item.type === "message" || item.type === undefined) && item.role === "assistant"))) {
      result.push({ ...item, providerData: { ...item.providerData, reasoning_content: reasoning } });
      reasoning = undefined;
    } else {
      flush();
      result.push(item);
    }
  }
  flush();
  return result;
}
