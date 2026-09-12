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
import type { TargetResolver } from "./providers";

/** Studio owns routing and credentials; the Agents SDK owns the model protocol. */
export function createAgentModelProvider(resolveTarget: TargetResolver): ModelProvider {
  return {
    getModel(name) {
      if (!name) throw new Error("An explicit Studio model is required");
      return new StudioChatModel(name, resolveTarget);
    },
  };
}

class StudioChatModel implements Model {
  constructor(private readonly name: string, private readonly resolveTarget: TargetResolver) {}

  private async resolve(): Promise<OpenAIChatCompletionsModel> {
    const target = await this.resolveTarget(this.name);
    // Retry policy belongs to the run. Hidden HTTP retries can repeat paid work.
    return new OpenAIChatCompletionsModel(getOpenAIClient(target, 0), target.model, {
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
  if (Array.isArray(request.input)) {
    for (const item of request.input) {
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
    input: Array.isArray(request.input) ? restoreReasoningDialect(request.input) : request.input,
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
